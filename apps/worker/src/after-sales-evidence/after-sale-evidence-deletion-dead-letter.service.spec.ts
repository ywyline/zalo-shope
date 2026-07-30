import { vi } from 'vitest';

const databaseMocks = vi.hoisted(() => ({
  list: vi.fn(),
  reconcile: vi.fn(),
}));
const loggerMocks = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }));

vi.mock('@zalo-shop/database', async () => {
  const actual: Record<string, unknown> = await vi.importActual('@zalo-shop/database');
  return {
    ...actual,
    listAfterSaleEvidenceLifecycleDeadLetterCandidates: databaseMocks.list,
    reconcileAfterSaleEvidenceLifecycleDeadLetter: databaseMocks.reconcile,
  };
});
vi.mock('@zalo-shop/logger', () => ({ createLogger: () => loggerMocks }));

import type { RuntimeConfig } from '@zalo-shop/config';
import { beforeEach, describe, expect, it } from 'vitest';

import { AfterSaleEvidenceDeletionDeadLetterService } from './after-sale-evidence-deletion-dead-letter.service';

const STORE_ID = '10000000-0000-4000-8000-000000000001';

function config(enabled: boolean): RuntimeConfig {
  return {
    AFTER_SALE_EVIDENCE_DELETION_WORKER_ENABLED: enabled,
    AFTER_SALE_EVIDENCE_DELETE_MAX_ATTEMPTS: 8,
    AFTER_SALE_EVIDENCE_DELETE_RETRY_BASE_DELAY_MS: 60_000,
    AFTER_SALE_EVIDENCE_DELETE_RETRY_MAX_DELAY_MS: 21_600_000,
    AFTER_SALE_EVIDENCE_LIFECYCLE_DEAD_LETTER_BATCH_SIZE: 25,
    AFTER_SALE_EVIDENCE_LIFECYCLE_DEAD_LETTER_INTERVAL_MS: 5_000,
    LOG_LEVEL: 'silent',
  } as unknown as RuntimeConfig;
}

function database() {
  return { $queryRaw: vi.fn().mockResolvedValue([{ id: STORE_ID }]) };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('AfterSaleEvidenceDeletionDeadLetterService', () => {
  beforeEach(() => {
    databaseMocks.list
      .mockReset()
      .mockResolvedValue([{ messageId: '50000000-0000-4000-8000-000000000001' }]);
    databaseMocks.reconcile.mockReset().mockResolvedValue({ outcome: 'DELETE_RETRY_SCHEDULED' });
    loggerMocks.error.mockReset();
    loggerMocks.info.mockReset();
    loggerMocks.warn.mockReset();
  });

  it('does nothing while deletion is disabled', async () => {
    const client = database();
    const service = new AfterSaleEvidenceDeletionDeadLetterService(client as never, config(false));
    await service.runOnce();
    expect(client.$queryRaw).not.toHaveBeenCalled();
    expect(databaseMocks.list).not.toHaveBeenCalled();
  });

  it('reconciles a bounded batch with the fixed evidence SYSTEM scope', async () => {
    const service = new AfterSaleEvidenceDeletionDeadLetterService(
      database() as never,
      config(true),
    );
    await service.runOnce();
    expect(databaseMocks.list).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actor: { id: '00000000-0000-4000-8000-000000000006', type: 'system' },
        storeId: STORE_ID,
        systemScope: 'after-sale-evidence-lifecycle',
      }),
      { batchSize: 25 },
    );
    expect(databaseMocks.reconcile).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ storeId: STORE_ID }),
      {
        deletionBaseDelayMs: 60_000,
        deletionMaxAttempts: 8,
        deletionMaxDelayMs: 21_600_000,
        messageId: '50000000-0000-4000-8000-000000000001',
      },
    );
  });

  it('continues after a single candidate failure without exposing the error', async () => {
    const sensitive = new Error('object-key provider-response checksum');
    databaseMocks.list.mockResolvedValue([
      { messageId: '50000000-0000-4000-8000-000000000001' },
      { messageId: '50000000-0000-4000-8000-000000000002' },
    ]);
    databaseMocks.reconcile.mockRejectedValueOnce(sensitive).mockResolvedValueOnce({
      outcome: 'DELETE_RETRY_SCHEDULED',
    });
    const service = new AfterSaleEvidenceDeletionDeadLetterService(
      database() as never,
      config(true),
    );
    await service.runOnce();
    expect(databaseMocks.reconcile).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(loggerMocks.warn.mock.calls)).not.toContain(sensitive.message);
  });

  it('stops polling and drains an active run during module destruction', async () => {
    const stores = deferred<readonly []>();
    const client = { $queryRaw: vi.fn().mockReturnValue(stores.promise) };
    const service = new AfterSaleEvidenceDeletionDeadLetterService(client as never, config(true));
    const running = service.runOnce();
    let drained = false;
    const draining = service.onModuleDestroy().then(() => {
      drained = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);
    stores.resolve([]);
    await Promise.all([running, draining]);
    await service.runOnce();
    expect(client.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
