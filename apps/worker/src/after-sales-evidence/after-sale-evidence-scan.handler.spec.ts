import { Readable } from 'node:stream';

import { vi } from 'vitest';

const databaseMocks = vi.hoisted(() => ({
  apply: vi.fn(),
  load: vi.fn(),
}));

vi.mock('@zalo-shop/database', async () => {
  const actual: Record<string, unknown> = await vi.importActual('@zalo-shop/database');
  return {
    ...actual,
    applyAfterSaleEvidenceScanResultForLease: databaseMocks.apply,
    loadAfterSaleEvidenceScanWorkForLease: databaseMocks.load,
  };
});

import type { RuntimeConfig } from '@zalo-shop/config';
import type { OutboxMessageRecord } from '@zalo-shop/database';
import {
  AfterSaleEvidenceScannerError,
  AfterSaleEvidenceStorageError,
  type AfterSaleEvidenceObjectStorageProvider,
  type AfterSaleEvidenceScanner,
} from '@zalo-shop/integrations';
import { beforeEach, describe, expect, it } from 'vitest';

import { AfterSaleEvidenceScanRequestedHandler } from './after-sale-evidence-scan.handler';

const STORE_ID = '10000000-0000-4000-8000-000000000001';
const EVIDENCE_ID = '30000000-0000-4000-8000-000000000001';
const MESSAGE_ID = '50000000-0000-4000-8000-000000000001';
const OBJECT_KEY = `test/${STORE_ID}/staged/${EVIDENCE_ID}/original`;
const CHECKSUM = 'a'.repeat(64);

function message(input: Partial<OutboxMessageRecord> = {}): OutboxMessageRecord {
  return {
    aggregateId: EVIDENCE_ID,
    aggregateType: 'AFTER_SALE_EVIDENCE',
    attemptCount: 1,
    availableAt: new Date('2026-07-29T00:00:00.000Z'),
    completedAt: null,
    eventType: 'after-sale.evidence.scan.requested',
    eventVersion: 1,
    id: MESSAGE_ID,
    idempotencyKey: `after-sale.evidence.scan.requested:${EVIDENCE_ID}:2`,
    lastErrorCode: null,
    leaseExpiresAt: new Date('2026-07-29T00:01:00.000Z'),
    leaseOwner: 'evidence-worker-test',
    maxAttempts: 5,
    payload: { evidence_id: EVIDENCE_ID, expected_version: 2, store_id: STORE_ID },
    status: 'PROCESSING',
    storeId: STORE_ID,
    version: 7,
    ...input,
  };
}

const work = {
  byteSize: 4,
  checksumSha256: CHECKSUM,
  deploymentEnvironment: 'test',
  evidenceId: EVIDENCE_ID,
  mimeType: 'image/jpeg' as const,
  objectKey: OBJECT_KEY,
  scanGeneration: 1,
};

function setup() {
  const scanner = {
    scan: vi.fn().mockResolvedValue({
      engine: 'clamav',
      engineVersion: '1.5.3',
      signatureVersion: '27790',
      verdict: 'CLEAN',
    }),
  } satisfies AfterSaleEvidenceScanner;
  const storage = {
    consumeValidatedObject: vi.fn(async (_declaration, consumer) => ({
      object: { byteSize: 4, checksumSha256: CHECKSUM, mimeType: 'image/jpeg' as const },
      result: await consumer(Readable.from([Buffer.from([0xff, 0xd8, 0xff, 0x00])])),
    })),
    createProtectedReadTarget: vi.fn(),
    createUploadTarget: vi.fn(),
    destroy: vi.fn(),
    removeObject: vi.fn(),
    validateUploadedObject: vi.fn(),
  } satisfies AfterSaleEvidenceObjectStorageProvider;
  const config = {
    AFTER_SALE_EVIDENCE_CLAIM_TTL_SECONDS: 86_400,
    AFTER_SALE_EVIDENCE_FAILED_RETENTION_SECONDS: 86_400,
  } as RuntimeConfig;
  return {
    handler: new AfterSaleEvidenceScanRequestedHandler({} as never, storage, scanner, config),
    scanner,
    storage,
  };
}

describe('AfterSaleEvidenceScanRequestedHandler', () => {
  beforeEach(() => {
    databaseMocks.apply.mockReset().mockResolvedValue({ outcome: 'APPLIED' });
    databaseMocks.load.mockReset().mockResolvedValue({ outcome: 'READY', work });
  });

  it.each([
    [
      'extra payload key',
      {
        payload: {
          evidence_id: EVIDENCE_ID,
          expected_version: 2,
          object_key: OBJECT_KEY,
          store_id: STORE_ID,
        },
      },
    ],
    [
      'wrong store payload',
      {
        payload: {
          evidence_id: EVIDENCE_ID,
          expected_version: 2,
          store_id: EVIDENCE_ID,
        },
      },
    ],
    ['wrong aggregate', { aggregateType: 'OTHER' }],
    ['wrong event version', { eventVersion: 2 }],
    ['missing lease owner', { leaseOwner: null }],
    ['non-processing status', { status: 'PENDING' as const }],
  ])('rejects %s before database or external work', async (_label, override) => {
    const { handler, scanner, storage } = setup();
    await expect(handler.handle(message(override))).rejects.toMatchObject({
      code: 'EVIDENCE_SCAN_PAYLOAD_INVALID',
      disposition: 'PERMANENT',
    });
    expect(databaseMocks.load).not.toHaveBeenCalled();
    expect(storage.consumeValidatedObject).not.toHaveBeenCalled();
    expect(scanner.scan).not.toHaveBeenCalled();
  });

  it('scans the database-authoritative declaration and projects through the same lease', async () => {
    const { handler, scanner, storage } = setup();
    await expect(handler.handle(message())).resolves.toBeUndefined();

    expect(databaseMocks.load).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actor: { id: '00000000-0000-4000-8000-000000000006', type: 'system' },
        storeId: STORE_ID,
        systemScope: 'after-sale-evidence-lifecycle',
      }),
      {
        outboxExpectedVersion: 7,
        outboxMessageId: MESSAGE_ID,
        workerId: 'evidence-worker-test',
      },
    );
    expect(storage.consumeValidatedObject).toHaveBeenCalledWith(
      { ...work, scanGeneration: undefined, storeId: STORE_ID },
      expect.any(Function),
    );
    expect(scanner.scan).toHaveBeenCalledWith({
      body: expect.anything(),
      expectedByteSize: 4,
    });
    expect(databaseMocks.apply).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ storeId: STORE_ID }),
      expect.objectContaining({
        claimTtlSeconds: 86_400,
        outboxExpectedVersion: 7,
        outboxMessageId: MESSAGE_ID,
        result: {
          engine: 'clamav',
          engineVersion: '1.5.3',
          signatureVersion: '27790',
          verdict: 'CLEAN',
        },
        scanGeneration: 1,
        workerId: 'evidence-worker-test',
      }),
    );
  });

  it('returns superseded work without touching storage or scanner', async () => {
    databaseMocks.load.mockResolvedValue({ outcome: 'SUPERSEDED' });
    const { handler, scanner, storage } = setup();
    await expect(handler.handle(message())).resolves.toBeUndefined();
    expect(storage.consumeValidatedObject).not.toHaveBeenCalled();
    expect(scanner.scan).not.toHaveBeenCalled();
    expect(databaseMocks.apply).not.toHaveBeenCalled();
  });

  it('retries a transient scanner failure while attempts remain', async () => {
    const { handler, scanner } = setup();
    scanner.scan.mockRejectedValue(new AfterSaleEvidenceScannerError('SCANNER_TIMEOUT'));
    await expect(handler.handle(message())).rejects.toMatchObject({
      code: 'SCANNER_TIMEOUT',
      disposition: 'RETRYABLE',
    });
    expect(databaseMocks.apply).not.toHaveBeenCalled();
  });

  it('fails closed through lease-bound projection on the final transient attempt', async () => {
    const { handler, scanner } = setup();
    scanner.scan.mockRejectedValue(new AfterSaleEvidenceScannerError('SCANNER_UNAVAILABLE'));
    await expect(handler.handle(message({ attemptCount: 5 }))).resolves.toBeUndefined();
    expect(databaseMocks.apply).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        result: { code: 'SCANNER_UNAVAILABLE', verdict: 'INDETERMINATE' },
      }),
    );
  });

  it('maps validated-stream content failures without exposing their source', async () => {
    const { handler, storage } = setup();
    storage.consumeValidatedObject.mockRejectedValue(
      new AfterSaleEvidenceStorageError('CONTENT_MISMATCH', false),
    );
    await expect(handler.handle(message())).resolves.toBeUndefined();
    expect(databaseMocks.apply).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        result: { code: 'OBJECT_VALIDATION_FAILED', verdict: 'INDETERMINATE' },
      }),
    );
  });

  it('preserves unknown failures for generic retry and dead-letter handling', async () => {
    const sentinel = new Error('provider body must not be projected');
    const { handler, scanner } = setup();
    scanner.scan.mockRejectedValue(sentinel);
    await expect(handler.handle(message())).rejects.toBe(sentinel);
    expect(databaseMocks.apply).not.toHaveBeenCalled();
  });
});
