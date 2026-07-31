import type { RuntimeConfig } from '@zalo-shop/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const databaseMocks = vi.hoisted(() => ({
  expire: vi.fn(),
}));

vi.mock('@zalo-shop/database', async () => {
  const actual: Record<string, unknown> = await vi.importActual('@zalo-shop/database');
  return { ...actual, expireDueAfterSales: databaseMocks.expire };
});

vi.mock('@zalo-shop/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import { AfterSaleReturnExpirationService } from './after-sale-return-expiration.service';

const BEAUTY_STORE_ID = '10000000-0000-4000-8000-000000000001';
const FASHION_STORE_ID = '10000000-0000-4000-8000-000000000002';

function config(enabled: boolean): RuntimeConfig {
  return {
    AFTER_SALE_RETURN_EXPIRATION_BATCH_SIZE: 25,
    AFTER_SALE_RETURN_EXPIRATION_INTERVAL_MS: 60_000,
    AFTER_SALE_RETURN_EXPIRATION_WORKER_ENABLED: enabled,
    LOG_LEVEL: 'silent',
  } as RuntimeConfig;
}

function database(stores = [{ id: BEAUTY_STORE_ID }, { id: FASHION_STORE_ID }]) {
  return {
    $connect: vi.fn().mockResolvedValue(undefined),
    $disconnect: vi.fn().mockResolvedValue(undefined),
    $queryRaw: vi.fn().mockResolvedValue(stores),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('AfterSaleReturnExpirationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseMocks.expire.mockResolvedValue({ expired: 0, scanned: 0, skipped: 0 });
  });

  it('performs no database lifecycle or scan work while independently disabled', async () => {
    const client = database();
    const service = new AfterSaleReturnExpirationService(client as never, config(false));
    await service.onModuleInit();
    await service.runOnce();
    await service.onModuleDestroy();
    await service.onApplicationShutdown();
    expect(client.$connect).not.toHaveBeenCalled();
    expect(client.$queryRaw).not.toHaveBeenCalled();
    expect(client.$disconnect).not.toHaveBeenCalled();
    expect(databaseMocks.expire).not.toHaveBeenCalled();
  });

  it('isolates every active store and continues after one store fails', async () => {
    const client = database();
    databaseMocks.expire
      .mockRejectedValueOnce(new Error('beauty scan failed'))
      .mockResolvedValueOnce({ expired: 1, scanned: 1, skipped: 0 });
    const service = new AfterSaleReturnExpirationService(client as never, config(true));
    await service.runOnce();
    expect(databaseMocks.expire).toHaveBeenCalledTimes(2);
    expect(databaseMocks.expire.mock.calls[0]?.[1]).toMatchObject({
      actor: { id: '00000000-0000-4000-8000-000000000007', type: 'system' },
      storeId: BEAUTY_STORE_ID,
      systemScope: 'after-sale-transition',
    });
    expect(databaseMocks.expire.mock.calls[1]?.[1]).toMatchObject({ storeId: FASHION_STORE_ID });
    expect(databaseMocks.expire.mock.calls[1]?.[2]).toBe(25);
  });

  it('drains an active batch before shutdown and disconnects the shared client afterward', async () => {
    const client = database([{ id: BEAUTY_STORE_ID }]);
    const expiration = deferred<{ expired: number; scanned: number; skipped: number }>();
    databaseMocks.expire.mockReturnValue(expiration.promise);
    const service = new AfterSaleReturnExpirationService(client as never, config(true));
    const running = service.runOnce();
    await vi.waitFor(() => expect(databaseMocks.expire).toHaveBeenCalledOnce());

    let drained = false;
    const draining = service.onModuleDestroy().then(() => {
      drained = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);
    expect(client.$disconnect).not.toHaveBeenCalled();

    expiration.resolve({ expired: 1, scanned: 1, skipped: 0 });
    await Promise.all([running, draining]);
    await service.onApplicationShutdown();
    expect(client.$disconnect).toHaveBeenCalledOnce();
    await service.runOnce();
    expect(client.$queryRaw).toHaveBeenCalledOnce();
  });
});
