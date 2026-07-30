import { vi } from 'vitest';

const databaseMocks = vi.hoisted(() => ({
  list: vi.fn(),
  reconcile: vi.fn(),
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
    listAfterSaleEvidenceScanDeadLetterCandidates: databaseMocks.list,
    reconcileAfterSaleEvidenceScanDeadLetter: databaseMocks.reconcile,
  };
});

vi.mock('@zalo-shop/logger', () => ({
  createLogger: () => loggerMocks,
}));

import type { RuntimeConfig } from '@zalo-shop/config';
import { beforeEach, describe, expect, it } from 'vitest';

import { AfterSaleEvidenceDeadLetterService } from './after-sale-evidence-dead-letter.service';

const STORE_ID = '10000000-0000-4000-8000-000000000001';
const MESSAGE_A = '50000000-0000-4000-8000-000000000001';
const MESSAGE_B = '50000000-0000-4000-8000-000000000002';

function config(provider: 'clamav' | 'disabled'): RuntimeConfig {
  return {
    AFTER_SALE_EVIDENCE_FAILED_RETENTION_SECONDS: 86_400,
    EVIDENCE_SCANNER_DEAD_LETTER_BATCH_SIZE: 25,
    EVIDENCE_SCANNER_DEAD_LETTER_INTERVAL_MS: 5_000,
    EVIDENCE_SCANNER_PROVIDER: provider,
    LOG_LEVEL: 'silent',
  } as unknown as RuntimeConfig;
}

function database() {
  return {
    $queryRaw: vi.fn().mockResolvedValue([{ id: STORE_ID }]),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('AfterSaleEvidenceDeadLetterService', () => {
  beforeEach(() => {
    databaseMocks.list
      .mockReset()
      .mockResolvedValue([{ messageId: MESSAGE_A }, { messageId: MESSAGE_B }]);
    databaseMocks.reconcile.mockReset().mockResolvedValue({ outcome: 'SCAN_FAILED' });
    loggerMocks.error.mockReset();
    loggerMocks.info.mockReset();
    loggerMocks.warn.mockReset();
  });

  it('does nothing while the evidence scanner is disabled', async () => {
    const client = database();
    const service = new AfterSaleEvidenceDeadLetterService(client as never, config('disabled'));
    await service.runOnce();
    expect(client.$queryRaw).not.toHaveBeenCalled();
    expect(databaseMocks.list).not.toHaveBeenCalled();
  });

  it('lists a bounded per-store batch and reconciles each candidate with SYSTEM scope', async () => {
    const service = new AfterSaleEvidenceDeadLetterService(database() as never, config('clamav'));
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
    expect(databaseMocks.reconcile).toHaveBeenCalledTimes(2);
    expect(databaseMocks.reconcile).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ storeId: STORE_ID }),
      { messageId: MESSAGE_A, scanFailedRetentionSeconds: 86_400 },
    );
    expect(loggerMocks.info).toHaveBeenCalledWith(
      { reconciled: 2, storeId: STORE_ID },
      'Evidence scan dead letters reconciled',
    );
  });

  it('continues a bounded batch after one reconciliation failure without logging it', async () => {
    const sensitive = new Error('object-key checksum provider-body');
    databaseMocks.reconcile
      .mockRejectedValueOnce(sensitive)
      .mockResolvedValueOnce({ outcome: 'SCAN_FAILED' });
    const service = new AfterSaleEvidenceDeadLetterService(database() as never, config('clamav'));
    await service.runOnce();

    expect(databaseMocks.reconcile).toHaveBeenCalledTimes(2);
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      { errorCode: 'EVIDENCE_SCAN_DEAD_LETTER_RECONCILE_FAILED', storeId: STORE_ID },
      'Evidence scan dead-letter reconciliation failed',
    );
    expect(JSON.stringify(loggerMocks.warn.mock.calls)).not.toContain(sensitive.message);
  });

  it('stops polling and waits for an active run during module destruction', async () => {
    const stores = deferred<readonly []>();
    const client = { $queryRaw: vi.fn().mockReturnValue(stores.promise) };
    const service = new AfterSaleEvidenceDeadLetterService(client as never, config('clamav'));

    const running = service.runOnce();
    let drained = false;
    const draining = service.onModuleDestroy().then(() => {
      drained = true;
    });
    await nextTurn();

    expect(drained).toBe(false);
    stores.resolve([]);
    await Promise.all([running, draining]);

    await service.runOnce();
    expect(client.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
