import type { RuntimeConfig } from '@zalo-shop/config';
import {
  AFTER_SALE_EVIDENCE_AGGREGATE_TYPE,
  AFTER_SALE_EVIDENCE_SCAN_EVENT,
  applyAfterSaleEvidenceScanResultForLease,
  loadAfterSaleEvidenceScanWorkForLease,
  type AfterSaleEvidenceScanResult,
  type OutboxMessageRecord,
  type PrismaClient,
} from '@zalo-shop/database';
import { createAfterSaleEvidenceSystemContext } from '@zalo-shop/domain';
import {
  AfterSaleEvidenceScannerError,
  AfterSaleEvidenceStorageError,
  type AfterSaleEvidenceObjectStorageProvider,
  type AfterSaleEvidenceScanner,
} from '@zalo-shop/integrations';

import {
  OutboxHandlerError,
  type OutboxMessageHandler,
} from '../reliable-messaging/outbox-message-handler';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PAYLOAD_KEYS = ['evidence_id', 'expected_version', 'store_id'] as const;

type ScanLease = Readonly<{
  outboxExpectedVersion: number;
  outboxMessageId: string;
  workerId: string;
}>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function scanLease(message: OutboxMessageRecord): ScanLease {
  const payload = message.payload;
  const keys = isPlainObject(payload) ? Object.keys(payload).sort() : [];
  const expectedKeys = [...PAYLOAD_KEYS].sort();
  if (
    message.aggregateType !== AFTER_SALE_EVIDENCE_AGGREGATE_TYPE ||
    message.eventType !== AFTER_SALE_EVIDENCE_SCAN_EVENT ||
    message.eventVersion !== 1 ||
    message.status !== 'PROCESSING' ||
    !UUID_PATTERN.test(message.id) ||
    !UUID_PATTERN.test(message.storeId) ||
    !UUID_PATTERN.test(message.aggregateId) ||
    !message.leaseOwner?.trim() ||
    !(message.leaseExpiresAt instanceof Date) ||
    !Number.isFinite(message.leaseExpiresAt.getTime()) ||
    !Number.isSafeInteger(message.version) ||
    message.version < 1 ||
    !isPlainObject(payload) ||
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    payload.store_id !== message.storeId ||
    payload.evidence_id !== message.aggregateId ||
    typeof payload.expected_version !== 'number' ||
    !Number.isSafeInteger(payload.expected_version) ||
    payload.expected_version < 1
  ) {
    throw new OutboxHandlerError('EVIDENCE_SCAN_PAYLOAD_INVALID', 'PERMANENT');
  }
  return {
    outboxExpectedVersion: message.version,
    outboxMessageId: message.id,
    workerId: message.leaseOwner,
  };
}

function storageFailureResult(error: AfterSaleEvidenceStorageError): AfterSaleEvidenceScanResult {
  return {
    code:
      error.code === 'UPSTREAM_UNAVAILABLE' ? 'UPSTREAM_UNAVAILABLE' : 'OBJECT_VALIDATION_FAILED',
    verdict: 'INDETERMINATE',
  };
}

export class AfterSaleEvidenceScanRequestedHandler implements OutboxMessageHandler {
  public readonly eventType = AFTER_SALE_EVIDENCE_SCAN_EVENT;
  public readonly eventVersions = new Set([1]);

  public constructor(
    private readonly database: PrismaClient,
    private readonly storage: AfterSaleEvidenceObjectStorageProvider,
    private readonly scanner: AfterSaleEvidenceScanner,
    private readonly config: Pick<
      RuntimeConfig,
      'AFTER_SALE_EVIDENCE_CLAIM_TTL_SECONDS' | 'AFTER_SALE_EVIDENCE_FAILED_RETENTION_SECONDS'
    >,
  ) {}

  public async handle(message: OutboxMessageRecord): Promise<void> {
    const lease = scanLease(message);
    const context = createAfterSaleEvidenceSystemContext({
      correlationId: `evidence-scan:${message.id}`,
      storeId: message.storeId,
    });
    const loaded = await loadAfterSaleEvidenceScanWorkForLease(this.database, context, lease);
    if (loaded.outcome === 'SUPERSEDED') return;

    let result: AfterSaleEvidenceScanResult;
    try {
      const consumed = await this.storage.consumeValidatedObject(
        {
          byteSize: loaded.work.byteSize,
          checksumSha256: loaded.work.checksumSha256,
          deploymentEnvironment: loaded.work.deploymentEnvironment,
          evidenceId: loaded.work.evidenceId,
          mimeType: loaded.work.mimeType,
          objectKey: loaded.work.objectKey,
          storeId: message.storeId,
        },
        (body) =>
          this.scanner.scan({
            body,
            expectedByteSize: loaded.work.byteSize,
          }),
      );
      result = consumed.result;
    } catch (error) {
      result = this.failureResult(error, message);
    }

    await applyAfterSaleEvidenceScanResultForLease(this.database, context, {
      ...lease,
      claimTtlSeconds: this.requiredTtl(this.config.AFTER_SALE_EVIDENCE_CLAIM_TTL_SECONDS),
      failedRetentionSeconds: this.requiredTtl(
        this.config.AFTER_SALE_EVIDENCE_FAILED_RETENTION_SECONDS,
      ),
      result,
      scanGeneration: loaded.work.scanGeneration,
    });
  }

  private failureResult(error: unknown, message: OutboxMessageRecord): AfterSaleEvidenceScanResult {
    const hasRemainingAttempt = message.attemptCount < message.maxAttempts;
    if (error instanceof AfterSaleEvidenceScannerError) {
      if (error.retryable && hasRemainingAttempt) {
        throw new OutboxHandlerError(error.code, 'RETRYABLE');
      }
      return { code: error.code, verdict: 'INDETERMINATE' };
    }
    if (error instanceof AfterSaleEvidenceStorageError) {
      if (error.retryable && hasRemainingAttempt) {
        throw new OutboxHandlerError('EVIDENCE_STORAGE_UNAVAILABLE', 'RETRYABLE');
      }
      return storageFailureResult(error);
    }
    throw error;
  }

  private requiredTtl(value: number | undefined): number {
    if (value === undefined) {
      throw new OutboxHandlerError('EVIDENCE_SCAN_CONFIGURATION_INVALID', 'PERMANENT');
    }
    return value;
  }
}
