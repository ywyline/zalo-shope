import type { RuntimeConfig } from '@zalo-shop/config';
import {
  AFTER_SALE_EVIDENCE_AGGREGATE_TYPE,
  AFTER_SALE_EVIDENCE_DELETE_EVENT,
  AFTER_SALE_EVIDENCE_EXPIRE_EVENT,
  applyAfterSaleEvidenceDeletionResultForLease,
  applyAfterSaleEvidenceExpirationForLease,
  loadAfterSaleEvidenceDeletionWorkForLease,
  type OutboxMessageRecord,
  type PrismaClient,
} from '@zalo-shop/database';
import { createAfterSaleEvidenceSystemContext } from '@zalo-shop/domain';
import {
  AfterSaleEvidenceStorageError,
  type AfterSaleEvidenceObjectStorageProvider,
} from '@zalo-shop/integrations';
import { createLogger } from '@zalo-shop/logger';

import {
  OutboxHandlerError,
  type OutboxMessageHandler,
} from '../reliable-messaging/outbox-message-handler';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PAYLOAD_KEYS = ['evidence_id', 'expected_version', 'store_id'] as const;

type LifecycleLease = Readonly<{
  outboxExpectedVersion: number;
  outboxMessageId: string;
  workerId: string;
}>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function lifecycleLease(
  message: OutboxMessageRecord,
  eventType: typeof AFTER_SALE_EVIDENCE_EXPIRE_EVENT | typeof AFTER_SALE_EVIDENCE_DELETE_EVENT,
): LifecycleLease {
  const payload = message.payload;
  const keys = isPlainObject(payload) ? Object.keys(payload).sort() : [];
  const expectedKeys = [...PAYLOAD_KEYS].sort();
  if (
    message.aggregateType !== AFTER_SALE_EVIDENCE_AGGREGATE_TYPE ||
    message.eventType !== eventType ||
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
    throw new OutboxHandlerError('EVIDENCE_LIFECYCLE_PAYLOAD_INVALID', 'PERMANENT');
  }
  return {
    outboxExpectedVersion: message.version,
    outboxMessageId: message.id,
    workerId: message.leaseOwner,
  };
}

function requiredConfig(
  config: Pick<
    RuntimeConfig,
    | 'AFTER_SALE_EVIDENCE_DELETE_MAX_ATTEMPTS'
    | 'AFTER_SALE_EVIDENCE_DELETE_RETRY_BASE_DELAY_MS'
    | 'AFTER_SALE_EVIDENCE_DELETE_RETRY_MAX_DELAY_MS'
  >,
): Readonly<{
  deletionBaseDelayMs: number;
  deletionMaxAttempts: number;
  deletionMaxDelayMs: number;
}> {
  if (
    config.AFTER_SALE_EVIDENCE_DELETE_RETRY_BASE_DELAY_MS === undefined ||
    config.AFTER_SALE_EVIDENCE_DELETE_RETRY_MAX_DELAY_MS === undefined ||
    config.AFTER_SALE_EVIDENCE_DELETE_MAX_ATTEMPTS === undefined
  ) {
    throw new OutboxHandlerError('EVIDENCE_DELETION_CONFIGURATION_INVALID', 'PERMANENT');
  }
  return {
    deletionBaseDelayMs: config.AFTER_SALE_EVIDENCE_DELETE_RETRY_BASE_DELAY_MS,
    deletionMaxAttempts: config.AFTER_SALE_EVIDENCE_DELETE_MAX_ATTEMPTS,
    deletionMaxDelayMs: config.AFTER_SALE_EVIDENCE_DELETE_RETRY_MAX_DELAY_MS,
  };
}

function boundedRetryDelay(nextAttemptAt: Date | null, maximumDelayMs: number): number {
  if (!(nextAttemptAt instanceof Date) || !Number.isFinite(nextAttemptAt.getTime())) return 1_000;
  return Math.max(1_000, Math.min(maximumDelayMs, nextAttemptAt.getTime() - Date.now()));
}

export class AfterSaleEvidenceExpireRequestedHandler implements OutboxMessageHandler {
  public readonly eventType = AFTER_SALE_EVIDENCE_EXPIRE_EVENT;
  public readonly eventVersions = new Set([1]);

  public constructor(
    private readonly database: PrismaClient,
    private readonly config: Pick<
      RuntimeConfig,
      | 'AFTER_SALE_EVIDENCE_DELETE_MAX_ATTEMPTS'
      | 'AFTER_SALE_EVIDENCE_DELETE_RETRY_BASE_DELAY_MS'
      | 'AFTER_SALE_EVIDENCE_DELETE_RETRY_MAX_DELAY_MS'
    >,
  ) {}

  public async handle(message: OutboxMessageRecord): Promise<void> {
    const lease = lifecycleLease(message, AFTER_SALE_EVIDENCE_EXPIRE_EVENT);
    const context = createAfterSaleEvidenceSystemContext({
      correlationId: `evidence-expire:${message.id}`,
      storeId: message.storeId,
    });
    const result = await applyAfterSaleEvidenceExpirationForLease(this.database, context, lease);
    if (result.outcome === 'NOT_DUE') {
      throw new OutboxHandlerError(
        'EVIDENCE_EXPIRE_NOT_DUE',
        'RETRYABLE',
        boundedRetryDelay(result.nextAttemptAt, requiredConfig(this.config).deletionMaxDelayMs),
      );
    }
  }
}

export class AfterSaleEvidenceDeleteRequestedHandler implements OutboxMessageHandler {
  public readonly eventType = AFTER_SALE_EVIDENCE_DELETE_EVENT;
  public readonly eventVersions = new Set([1]);
  private readonly logger;

  public constructor(
    private readonly database: PrismaClient,
    private readonly storage: AfterSaleEvidenceObjectStorageProvider,
    private readonly config: Pick<
      RuntimeConfig,
      | 'AFTER_SALE_EVIDENCE_DELETE_MAX_ATTEMPTS'
      | 'AFTER_SALE_EVIDENCE_DELETE_RETRY_BASE_DELAY_MS'
      | 'AFTER_SALE_EVIDENCE_DELETE_RETRY_MAX_DELAY_MS'
      | 'LOG_LEVEL'
    >,
  ) {
    this.logger = createLogger('evidence-delete-worker', config.LOG_LEVEL);
  }

  public async handle(message: OutboxMessageRecord): Promise<void> {
    const lease = lifecycleLease(message, AFTER_SALE_EVIDENCE_DELETE_EVENT);
    const context = createAfterSaleEvidenceSystemContext({
      correlationId: `evidence-delete:${message.id}`,
      storeId: message.storeId,
    });
    const loaded = await loadAfterSaleEvidenceDeletionWorkForLease(this.database, context, lease);
    if (loaded.outcome === 'SUPERSEDED') return;
    if (loaded.outcome === 'NOT_DUE') {
      throw new OutboxHandlerError(
        'EVIDENCE_DELETE_NOT_DUE',
        'RETRYABLE',
        boundedRetryDelay(loaded.nextAttemptAt, requiredConfig(this.config).deletionMaxDelayMs),
      );
    }
    const config = requiredConfig(this.config);

    const results = await Promise.all(
      loaded.work.objects.map(async (object) => {
        try {
          const outcome = await this.storage.removeObject({
            deploymentEnvironment: object.objectKey.split('/')[0] ?? '',
            evidenceId: loaded.work.evidenceId,
            objectKey: object.objectKey,
            objectRole: object.role,
            storeId: message.storeId,
          });
          return outcome === 'DELETED_OR_NOT_FOUND' ? null : 'EVIDENCE_DELETE_PROVIDER_UNAVAILABLE';
        } catch (error) {
          return this.providerFailure(error);
        }
      }),
    );
    const failure = results.find((result): result is string => result !== null);
    const applied = await applyAfterSaleEvidenceDeletionResultForLease(this.database, context, {
      ...lease,
      ...config,
      evidenceExpectedVersion: loaded.work.evidenceVersion,
      objects: loaded.work.objects.map(({ id, version }) => ({
        expectedVersion: version,
        id,
      })),
      result:
        failure === undefined ? { outcome: 'SUCCESS' } : { errorCode: failure, outcome: 'FAILURE' },
    });
    if (applied.outcome === 'RETRY_SCHEDULED' && applied.evidence.deleteAttemptCount === 5) {
      this.logger.warn(
        { deleteAttempt: 5, errorCode: 'EVIDENCE_DELETE_WARNING', storeId: message.storeId },
        'Evidence deletion warning condition reached',
      );
    }
    if (applied.outcome === 'EXHAUSTED') {
      this.logger.error(
        {
          deleteAttempt: 8,
          errorCode: 'EVIDENCE_DELETE_RETRY_EXHAUSTED',
          storeId: message.storeId,
        },
        'Evidence deletion retries exhausted',
      );
    }
  }

  private providerFailure(error: unknown): string {
    if (error instanceof AfterSaleEvidenceStorageError) {
      return error.code === 'INVALID_IDENTITY'
        ? 'EVIDENCE_DELETE_IDENTITY_INVALID'
        : 'EVIDENCE_DELETE_PROVIDER_UNAVAILABLE';
    }
    return 'EVIDENCE_DELETE_PROVIDER_UNAVAILABLE';
  }
}
