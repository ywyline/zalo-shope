import type { RuntimeConfig } from '@zalo-shop/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AfterSaleRateLimitException, AfterSalesRateLimiter } from './after-sales-rate-limiter';

const config = {
  NODE_ENV: 'test',
  PII_HASH_KEY: 'test-after-sale-rate-limit-hash-key'.repeat(2),
  REDIS_URL: 'redis://localhost:6379/15',
} as RuntimeConfig;

function createLimiter(result: unknown) {
  const limiter = new AfterSalesRateLimiter(config);
  const evalMock =
    result instanceof Error ? vi.fn().mockRejectedValue(result) : vi.fn().mockResolvedValue(result);
  const disconnect = vi.fn();
  Object.assign(limiter as unknown as { redis: unknown }, {
    redis: { disconnect, eval: evalMock },
  });
  return { disconnect, evalMock, limiter };
}

describe('AfterSalesRateLimiter', () => {
  afterEach(() => vi.useRealTimers());

  it('uses a tenant-scoped HMAC identity key without exposing the actor ID', async () => {
    vi.setSystemTime(new Date('2026-07-28T08:00:30.000Z'));
    const test = createLimiter(60);
    await expect(
      test.limiter.consume({
        actorId: '20000000-0000-4000-8000-000000000001',
        actorType: 'MEMBER',
        storeId: '10000000-0000-4000-8000-000000000001',
      }),
    ).resolves.toBeUndefined();
    const key = test.evalMock.mock.calls[0]?.[2] as string;
    expect(key).toContain('10000000-0000-4000-8000-000000000001');
    expect(key).toContain('after-sale-read:member');
    expect(key).not.toContain('20000000-0000-4000-8000-000000000001');
  });

  it('enforces distinct member/admin read tiers and reports the fixed-window retry time', async () => {
    vi.setSystemTime(new Date('2026-07-28T08:00:30.000Z'));
    const member = createLimiter(61);
    await expect(
      member.limiter.consume({ actorId: 'member', actorType: 'MEMBER', storeId: 'store' }),
    ).rejects.toMatchObject({ retryAfterSeconds: 30, status: 429 });

    const adminAllowed = createLimiter(120);
    await expect(
      adminAllowed.limiter.consume({ actorId: 'admin', actorType: 'ADMIN', storeId: 'store' }),
    ).resolves.toBeUndefined();
    const adminLimited = createLimiter(121);
    await expect(
      adminLimited.limiter.consume({ actorId: 'admin', actorType: 'ADMIN', storeId: 'store' }),
    ).rejects.toBeInstanceOf(AfterSaleRateLimitException);
  });

  it('fails closed when Redis is unavailable and disconnects on shutdown', async () => {
    const test = createLimiter(new Error('private redis connection details'));
    await expect(
      test.limiter.consume({ actorId: 'member', actorType: 'MEMBER', storeId: 'store' }),
    ).rejects.toMatchObject({ status: 503 });
    test.limiter.onApplicationShutdown();
    expect(test.disconnect).toHaveBeenCalledWith(false);
  });
});
