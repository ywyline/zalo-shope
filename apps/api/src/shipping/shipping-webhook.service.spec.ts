import { vi } from 'vitest';

const databaseMocks = vi.hoisted(() => ({
  record: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock('@zalo-shop/database', async () => {
  const actual: Record<string, unknown> = await vi.importActual('@zalo-shop/database');
  return {
    ReliableMessagingError: actual.ReliableMessagingError,
    ShippingCallbackError: actual.ShippingCallbackError,
    recordShippingCallbackHint: databaseMocks.record,
    resolveShippingCallbackChannel: databaseMocks.resolve,
  };
});

import { BadRequestException } from '@nestjs/common';
import { ShippingCallbackError } from '@zalo-shop/database';
import { beforeEach, describe, expect, it } from 'vitest';

import { ShippingWebhookRateLimiter, ShippingWebhookService } from './shipping-webhook.service';

const channel = {
  channelId: '40000000-0000-4000-8000-000000000001',
  defaultLocale: 'vi' as const,
  keyVersion: 'v1',
  originAllowlistKey: 'GHN_SANDBOX',
  providerCode: 'GHN' as const,
  providerEnvironment: 'SANDBOX' as const,
  shopId: '123456',
  storeCode: 'beauty-local',
  storeId: '10000000-0000-4000-8000-000000000001',
  tokenSecretRef: 'env:GHN_BEAUTY_TOKEN',
  version: 1,
};

function body(): Buffer {
  return Buffer.from(
    JSON.stringify({
      ClientOrderCode: 'SHP-TEST0001',
      OrderCode: 'GTEST123456',
      ShopID: 123456,
      Status: 'delivered',
    }),
  );
}

function service() {
  return new ShippingWebhookService(
    {} as never,
    { consume: vi.fn().mockResolvedValue(undefined) } as unknown as ShippingWebhookRateLimiter,
  );
}

describe('ShippingWebhookService', () => {
  beforeEach(() => {
    databaseMocks.resolve.mockReset().mockResolvedValue(channel);
    databaseMocks.record.mockReset().mockResolvedValue({
      duplicate: false,
      queryScheduled: true,
      shipmentId: '50000000-0000-4000-8000-000000000001',
    });
  });

  it('records an unsigned callback only as a shop-bound query hint', async () => {
    await expect(
      service().handle({
        headers: { 'content-type': 'application/json' },
        rawBody: body(),
        remoteAddress: '127.0.0.1',
      }),
    ).resolves.toEqual({ accepted: true });
    expect(databaseMocks.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ storeId: channel.storeId }),
      expect.objectContaining({
        channelId: channel.channelId,
        clientOrderCode: 'SHP-TEST0001',
        providerShipmentId: 'GTEST123456',
      }),
    );
    expect(databaseMocks.record.mock.calls[0]?.[2]).not.toHaveProperty('providerStatus');
  });

  it('acknowledges an unknown ShopId without becoming an enumeration oracle', async () => {
    databaseMocks.resolve.mockRejectedValue(
      new ShippingCallbackError('SHIPPING_CALLBACK_CHANNEL_INVALID'),
    );
    await expect(
      service().handle({
        headers: { 'content-type': 'application/json' },
        rawBody: body(),
      }),
    ).resolves.toEqual({ accepted: true });
    expect(databaseMocks.record).not.toHaveBeenCalled();
  });

  it('rejects malformed or non-JSON callback input before database routing', async () => {
    await expect(
      service().handle({ headers: { 'content-type': 'text/plain' }, rawBody: body() }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service().handle({
        headers: { 'content-type': 'application/json' },
        rawBody: Buffer.from('{'),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(databaseMocks.resolve).not.toHaveBeenCalled();
  });
});

describe('ShippingWebhookRateLimiter', () => {
  it('uses a dedicated distributed rate-limit scope', async () => {
    const assertAllowed = vi.fn().mockResolvedValue(undefined);
    const limiter = new ShippingWebhookRateLimiter(
      { GHN_CALLBACK_RATE_LIMIT_PER_MINUTE: 42 } as never,
      { assertAllowed } as never,
    );
    await limiter.consume('::ffff:127.0.0.1');
    expect(assertAllowed).toHaveBeenCalledWith(
      '127.0.0.1',
      'shipping-callback',
      'global',
      undefined,
      expect.objectContaining({ maxRequests: 42, windowSeconds: 60 }),
    );
  });
});
