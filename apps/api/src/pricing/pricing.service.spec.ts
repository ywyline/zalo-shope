import type { PrismaClient } from '@zalo-shop/database';
import { describe, expect, it, vi } from 'vitest';

import type { AdminService } from '../admin/admin.service';
import type { AuthService } from '../auth/auth.service';
import type { SearchRateLimiter } from '../search/search-rate-limiter';
import { allocateDiscount, PricingService } from './pricing.service';

describe('PricingService transaction consistency', () => {
  it('never assigns a largest-remainder unit to a zero-value line', () => {
    expect(
      allocateDiscount(
        [
          { key: '00000000-0000-4000-8000-000000000000', value: 0 },
          { key: 'ffffffff-ffff-4fff-8fff-ffffffffffff', value: 100 },
        ],
        1,
      ),
    ).toEqual(
      new Map([
        ['00000000-0000-4000-8000-000000000000', 0],
        ['ffffffff-ffff-4fff-8fff-ffffffffffff', 1],
      ]),
    );
  });

  it('quotes all trusted facts from one repeatable-read snapshot', async () => {
    const transaction = { $executeRaw: vi.fn(() => 1) };
    const database = {
      $queryRaw: vi.fn(() => [
        {
          code: 'beauty-local',
          default_locale: 'vi',
          id: '10000000-0000-4000-8000-000000000001',
        },
      ]),
      $transaction: vi.fn((callback: (value: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
      ),
    };
    const rateLimiter = { assertAllowed: vi.fn(() => undefined) };
    const service = new PricingService(
      database as unknown as PrismaClient,
      {} as AuthService,
      {} as AdminService,
      rateLimiter as unknown as SearchRateLimiter,
    );
    vi.spyOn(service, 'quoteMerchandise').mockResolvedValue({} as never);

    await service.quote({
      address: '127.0.0.1',
      authorization: undefined,
      request: {
        coupon_code: null,
        items: [{ quantity: 1, sku_code: 'serum-01' }],
        locale: 'vi',
      },
      storeCode: 'beauty-local',
    });

    expect(database.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'RepeatableRead',
    });
  });
});
