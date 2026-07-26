import { describe, expect, it, vi } from 'vitest';

import { normalizeCallbackIp, PaymentWebhookRateLimiter } from './payment-webhook.service';

describe('payment webhook controls', () => {
  it('normalizes IPv4-mapped IPv6 addresses before allowlist comparison', () => {
    expect(normalizeCallbackIp('::FFFF:127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeCallbackIp('  ::1  ')).toBe('::1');
  });

  it('uses one distributed limiter identity for equivalent IP spellings', async () => {
    const assertAllowed = vi.fn().mockResolvedValue(undefined);
    const limiter = new PaymentWebhookRateLimiter(
      { ZALO_CHECKOUT_CALLBACK_RATE_LIMIT_PER_MINUTE: 1 } as never,
      { assertAllowed } as never,
    );
    await limiter.consume('127.0.0.1');
    await limiter.consume('::ffff:127.0.0.1');
    expect(assertAllowed).toHaveBeenNthCalledWith(
      1,
      '127.0.0.1',
      'payment-callback',
      'global',
      undefined,
      expect.objectContaining({ maxRequests: 1, windowSeconds: 60 }),
    );
    expect(assertAllowed).toHaveBeenNthCalledWith(
      2,
      '127.0.0.1',
      'payment-callback',
      'global',
      undefined,
      expect.objectContaining({ maxRequests: 1, windowSeconds: 60 }),
    );
  });
});
