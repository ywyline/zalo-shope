import { Test } from '@nestjs/testing';
import type { RuntimeConfig } from '@zalo-shop/config';
import type { OutboxMessageRecord } from '@zalo-shop/database';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const databaseMocks = vi.hoisted(() => ({
  claim: vi.fn(),
  complete: vi.fn(),
  expireReservations: vi.fn(),
  fail: vi.fn(),
}));

vi.mock('@zalo-shop/database', async () => {
  const actual: Record<string, unknown> = await vi.importActual('@zalo-shop/database');
  return {
    ...actual,
    claimOutboxMessages: databaseMocks.claim,
    completeOutboxMessage: databaseMocks.complete,
    expireDueReservations: databaseMocks.expireReservations,
    failOutboxMessage: databaseMocks.fail,
  };
});

vi.mock('@zalo-shop/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import { AfterSaleEvidenceStorageLifecycleService } from './after-sales-evidence/after-sale-evidence-storage-lifecycle.service';
import { RUNTIME_CONFIG } from './health.controller';
import { InventoryExpirationService } from './inventory/inventory-expiration.service';
import { ReliableOutboxService } from './reliable-messaging/reliable-outbox.service';
import { WORKER_AFTER_SALE_EVIDENCE_STORAGE, WORKER_DATABASE_CLIENT } from './worker.tokens';

const STORE_ID = '10000000-0000-4000-8000-000000000001';

function deferred<T>() {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function config(): RuntimeConfig {
  return {
    LOG_LEVEL: 'silent',
    OUTBOX_WORKER_BATCH_SIZE: 1,
    OUTBOX_WORKER_INTERVAL_MS: 60_000,
    OUTBOX_WORKER_LEASE_MS: 30_000,
    OUTBOX_WORKER_RETRY_BASE_DELAY_MS: 1_000,
    OUTBOX_WORKER_RETRY_MAX_DELAY_MS: 60_000,
  } as RuntimeConfig;
}

function message(): OutboxMessageRecord {
  return {
    aggregateId: '20000000-0000-4000-8000-000000000001',
    aggregateType: 'AFTER_SALE_EVIDENCE',
    attemptCount: 1,
    availableAt: new Date('2026-07-29T00:00:00.000Z'),
    completedAt: null,
    eventType: 'after-sale.evidence.scan.requested',
    eventVersion: 1,
    id: '30000000-0000-4000-8000-000000000001',
    idempotencyKey: 'evidence-scan-shutdown-test',
    lastErrorCode: null,
    leaseExpiresAt: new Date('2026-07-29T00:01:00.000Z'),
    leaseOwner: 'worker-test',
    maxAttempts: 3,
    payload: {
      evidence_id: '20000000-0000-4000-8000-000000000001',
      expected_version: 1,
      store_id: STORE_ID,
    },
    status: 'PROCESSING',
    storeId: STORE_ID,
    version: 2,
  };
}

describe('worker shutdown lifecycle', () => {
  beforeEach(() => {
    databaseMocks.claim.mockReset();
    databaseMocks.complete.mockReset().mockResolvedValue(undefined);
    databaseMocks.expireReservations.mockReset();
    databaseMocks.fail.mockReset();
  });

  it('drains an in-flight outbox scan before destroying evidence storage', async () => {
    const scanFinished = deferred<void>();
    const scanStarted = deferred<void>();
    const dispatch = vi.fn().mockImplementation(() => {
      scanStarted.resolve(undefined);
      return scanFinished.promise;
    });
    const database = {
      $queryRaw: vi
        .fn()
        .mockResolvedValue([{ code: 'beauty', default_locale: 'vi', id: STORE_ID }]),
    };
    const storage = { destroy: vi.fn() };
    databaseMocks.claim.mockResolvedValue([message()]);

    const testingModule = await Test.createTestingModule({
      providers: [
        { provide: RUNTIME_CONFIG, useValue: config() },
        { provide: WORKER_DATABASE_CLIENT, useValue: database },
        { provide: WORKER_AFTER_SALE_EVIDENCE_STORAGE, useValue: storage },
        { provide: 'OUTBOX_DISPATCHER', useValue: { dispatch } },
        {
          inject: ['OUTBOX_DISPATCHER'],
          provide: ReliableOutboxService,
          useFactory: (dispatcher: { dispatch: () => Promise<void> }) =>
            new ReliableOutboxService(database as never, config(), dispatcher as never),
        },
        AfterSaleEvidenceStorageLifecycleService,
      ],
    }).compile();

    await testingModule.init();
    await scanStarted.promise;

    let closed = false;
    const closing = testingModule.close().then(() => {
      closed = true;
    });
    await nextTurn();

    expect(closed).toBe(false);
    expect(storage.destroy).not.toHaveBeenCalled();

    scanFinished.resolve(undefined);
    await closing;

    expect(databaseMocks.complete).toHaveBeenCalledTimes(1);
    expect(storage.destroy).toHaveBeenCalledTimes(1);
  });

  it('drains inventory work before disconnecting the shared database', async () => {
    const stores = deferred<readonly []>();
    const database = {
      $disconnect: vi.fn().mockResolvedValue(undefined),
      $queryRaw: vi.fn().mockReturnValue(stores.promise),
    };
    const service = new InventoryExpirationService(database as never, config(), {
      runStore: vi.fn(),
    } as never);

    const running = service.runOnce();
    let drained = false;
    const draining = service.onModuleDestroy().then(() => {
      drained = true;
    });
    await nextTurn();

    expect(drained).toBe(false);
    expect(database.$disconnect).not.toHaveBeenCalled();

    stores.resolve([]);
    await Promise.all([running, draining]);
    await service.onApplicationShutdown();

    expect(database.$disconnect).toHaveBeenCalledTimes(1);
    await service.runOnce();
    expect(database.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
