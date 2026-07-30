import { vi } from 'vitest';

const databaseMocks = vi.hoisted(() => ({
  applyDelete: vi.fn(),
  applyExpire: vi.fn(),
  loadDelete: vi.fn(),
}));
const loggerMocks = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@zalo-shop/database', async () => {
  const actual: Record<string, unknown> = await vi.importActual('@zalo-shop/database');
  return {
    ...actual,
    applyAfterSaleEvidenceDeletionResultForLease: databaseMocks.applyDelete,
    applyAfterSaleEvidenceExpirationForLease: databaseMocks.applyExpire,
    loadAfterSaleEvidenceDeletionWorkForLease: databaseMocks.loadDelete,
  };
});

vi.mock('@zalo-shop/logger', () => ({ createLogger: () => loggerMocks }));

import {
  AFTER_SALE_EVIDENCE_DELETE_EVENT,
  AFTER_SALE_EVIDENCE_EXPIRE_EVENT,
} from '@zalo-shop/database';
import { AfterSaleEvidenceStorageError } from '@zalo-shop/integrations';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  AfterSaleEvidenceDeleteRequestedHandler,
  AfterSaleEvidenceExpireRequestedHandler,
} from './after-sale-evidence-deletion.handler';

const STORE_ID = '10000000-0000-4000-8000-000000000001';
const EVIDENCE_ID = '10000000-0000-4000-8000-000000000099';
const MESSAGE_ID = '50000000-0000-4000-8000-000000000001';
const WORKER_ID = 'outbox-test-worker';

function config() {
  return {
    AFTER_SALE_EVIDENCE_DELETE_MAX_ATTEMPTS: 8,
    AFTER_SALE_EVIDENCE_DELETE_RETRY_BASE_DELAY_MS: 60_000,
    AFTER_SALE_EVIDENCE_DELETE_RETRY_MAX_DELAY_MS: 6 * 60 * 60 * 1_000,
    LOG_LEVEL: 'silent',
  } as const;
}

function message(eventType: string) {
  return {
    aggregateId: EVIDENCE_ID,
    aggregateType: 'AFTER_SALE_EVIDENCE',
    attemptCount: 1,
    availableAt: new Date(),
    completedAt: null,
    eventType,
    eventVersion: 1,
    id: MESSAGE_ID,
    idempotencyKey: `${eventType}:${EVIDENCE_ID}:2`,
    lastErrorCode: null,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    leaseOwner: WORKER_ID,
    maxAttempts: 3,
    payload: { evidence_id: EVIDENCE_ID, expected_version: 2, store_id: STORE_ID },
    status: 'PROCESSING' as const,
    storeId: STORE_ID,
    version: 3,
  };
}

describe('AfterSaleEvidenceExpireRequestedHandler', () => {
  beforeEach(() => {
    databaseMocks.applyExpire.mockReset().mockResolvedValue({ outcome: 'DELETE_SCHEDULED' });
    loggerMocks.error.mockReset();
    loggerMocks.info.mockReset();
    loggerMocks.warn.mockReset();
  });

  it('applies a lease-bound expiry and completes held/superseded messages', async () => {
    const handler = new AfterSaleEvidenceExpireRequestedHandler({} as never, config());
    await handler.handle(message(AFTER_SALE_EVIDENCE_EXPIRE_EVENT));
    expect(databaseMocks.applyExpire).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ storeId: STORE_ID, systemScope: 'after-sale-evidence-lifecycle' }),
      { outboxExpectedVersion: 3, outboxMessageId: MESSAGE_ID, workerId: WORKER_ID },
    );

    databaseMocks.applyExpire.mockResolvedValueOnce({ outcome: 'HELD' });
    await handler.handle(message(AFTER_SALE_EVIDENCE_EXPIRE_EVENT));
  });

  it('does not silently complete an early expiry', async () => {
    const now = Date.now();
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now);
    databaseMocks.applyExpire.mockResolvedValue({
      outcome: 'NOT_DUE',
      nextAttemptAt: new Date(now + 120_000),
    });
    const handler = new AfterSaleEvidenceExpireRequestedHandler({} as never, config());
    try {
      await expect(
        handler.handle(message(AFTER_SALE_EVIDENCE_EXPIRE_EVENT) as never),
      ).rejects.toMatchObject({
        code: 'EVIDENCE_EXPIRE_NOT_DUE',
        disposition: 'RETRYABLE',
        retryDelayMs: 120_000,
      });
    } finally {
      dateNow.mockRestore();
    }
  });

  it('rejects malformed payloads before reaching the database', async () => {
    const handler = new AfterSaleEvidenceExpireRequestedHandler({} as never, config());
    await expect(
      handler.handle({ ...message(AFTER_SALE_EVIDENCE_EXPIRE_EVENT), payload: {} }),
    ).rejects.toMatchObject({
      code: 'EVIDENCE_LIFECYCLE_PAYLOAD_INVALID',
      disposition: 'PERMANENT',
    });
    expect(databaseMocks.applyExpire).not.toHaveBeenCalled();
  });
});

describe('AfterSaleEvidenceDeleteRequestedHandler', () => {
  const storage = { removeObject: vi.fn() };

  beforeEach(() => {
    storage.removeObject.mockReset().mockResolvedValue('DELETED_OR_NOT_FOUND');
    databaseMocks.loadDelete.mockReset().mockResolvedValue({
      outcome: 'READY',
      work: {
        evidenceId: EVIDENCE_ID,
        evidenceVersion: 3,
        objects: [
          {
            id: '20000000-0000-4000-8000-000000000001',
            objectKey: `test/${STORE_ID}/staged/${EVIDENCE_ID}/original`,
            role: 'ORIGINAL',
            version: 1,
          },
          {
            id: '20000000-0000-4000-8000-000000000002',
            objectKey: `test/${STORE_ID}/derived/${EVIDENCE_ID}/thumbnail.webp`,
            role: 'DERIVATIVE',
            version: 1,
          },
        ],
      },
    });
    databaseMocks.applyDelete.mockReset().mockResolvedValue({
      evidence: { deleteAttemptCount: 0 },
      outcome: 'DELETED',
    });
    loggerMocks.error.mockReset();
    loggerMocks.info.mockReset();
    loggerMocks.warn.mockReset();
  });

  it('deletes every active ledger object and commits the exact object versions', async () => {
    const handler = new AfterSaleEvidenceDeleteRequestedHandler(
      {} as never,
      storage as never,
      config(),
    );
    await handler.handle(message(AFTER_SALE_EVIDENCE_DELETE_EVENT));

    expect(storage.removeObject).toHaveBeenCalledTimes(2);
    expect(storage.removeObject).toHaveBeenCalledWith(
      expect.objectContaining({
        evidenceId: EVIDENCE_ID,
        objectRole: 'DERIVATIVE',
        storeId: STORE_ID,
      }),
    );
    expect(databaseMocks.applyDelete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ storeId: STORE_ID }),
      expect.objectContaining({
        deletionMaxAttempts: 8,
        objects: [
          { expectedVersion: 1, id: '20000000-0000-4000-8000-000000000001' },
          { expectedVersion: 1, id: '20000000-0000-4000-8000-000000000002' },
        ],
        result: { outcome: 'SUCCESS' },
      }),
    );
  });

  it('projects stable provider failure and records the fifth/eighth facts locally', async () => {
    storage.removeObject.mockRejectedValue(
      new AfterSaleEvidenceStorageError('UPSTREAM_UNAVAILABLE', true),
    );
    databaseMocks.applyDelete.mockResolvedValueOnce({
      evidence: { deleteAttemptCount: 5 },
      outcome: 'RETRY_SCHEDULED',
    });
    const handler = new AfterSaleEvidenceDeleteRequestedHandler(
      {} as never,
      storage as never,
      config(),
    );
    await handler.handle(message(AFTER_SALE_EVIDENCE_DELETE_EVENT));
    expect(databaseMocks.applyDelete).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        result: { errorCode: 'EVIDENCE_DELETE_PROVIDER_UNAVAILABLE', outcome: 'FAILURE' },
      }),
    );
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ deleteAttempt: 5 }),
      'Evidence deletion warning condition reached',
    );

    databaseMocks.applyDelete.mockResolvedValueOnce({
      evidence: { deleteAttemptCount: 8 },
      outcome: 'EXHAUSTED',
    });
    await handler.handle(message(AFTER_SALE_EVIDENCE_DELETE_EVENT));
    expect(loggerMocks.error).toHaveBeenCalledWith(
      expect.objectContaining({ deleteAttempt: 8 }),
      'Evidence deletion retries exhausted',
    );
  });

  it('does not call the provider for a superseded message', async () => {
    databaseMocks.loadDelete.mockResolvedValue({ outcome: 'SUPERSEDED' });
    const handler = new AfterSaleEvidenceDeleteRequestedHandler(
      {} as never,
      storage as never,
      config(),
    );
    await handler.handle(message(AFTER_SALE_EVIDENCE_DELETE_EVENT));
    expect(storage.removeObject).not.toHaveBeenCalled();
    expect(databaseMocks.applyDelete).not.toHaveBeenCalled();
  });

  it('uses the authoritative delete retry deadline without calling the provider early', async () => {
    const now = Date.now();
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now);
    databaseMocks.loadDelete.mockResolvedValue({
      nextAttemptAt: new Date(now + 120_000),
      outcome: 'NOT_DUE',
    });
    const handler = new AfterSaleEvidenceDeleteRequestedHandler(
      {} as never,
      storage as never,
      config(),
    );
    try {
      await expect(
        handler.handle(message(AFTER_SALE_EVIDENCE_DELETE_EVENT) as never),
      ).rejects.toMatchObject({
        code: 'EVIDENCE_DELETE_NOT_DUE',
        disposition: 'RETRYABLE',
        retryDelayMs: 120_000,
      });
    } finally {
      dateNow.mockRestore();
    }
    expect(storage.removeObject).not.toHaveBeenCalled();
    expect(databaseMocks.applyDelete).not.toHaveBeenCalled();
  });
});
