import { vi } from 'vitest';

const databaseMocks = vi.hoisted(() => ({
  apply: vi.fn(),
  bind: vi.fn(),
  claim: vi.fn(),
  resolveChannel: vi.fn(),
  settle: vi.fn(),
}));

vi.mock('@zalo-shop/database', async () => {
  const actual: Record<string, unknown> = await vi.importActual('@zalo-shop/database');
  return {
    PaymentCallbackError: actual.PaymentCallbackError,
    PaymentCommandError: actual.PaymentCommandError,
    ReliableMessagingError: actual.ReliableMessagingError,
    applyPaymentProviderFact: databaseMocks.apply,
    bindPaymentProviderOrder: databaseMocks.bind,
    claimVerifiedPaymentCallback: databaseMocks.claim,
    resolvePaymentCallbackChannel: databaseMocks.resolveChannel,
    settlePaymentCallback: databaseMocks.settle,
  };
});

import {
  BadRequestException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { RuntimeConfig } from '@zalo-shop/config';
import { PaymentCommandError } from '@zalo-shop/database';
import {
  ProviderIntegrationError,
  type PaymentProvider,
  type PaymentProviderFact,
  type PaymentProviderResolver,
} from '@zalo-shop/integrations';
import { beforeEach, describe, expect, it, vi as vitest } from 'vitest';

import { type PaymentWebhookRateLimiter, PaymentWebhookService } from './payment-webhook.service';

const storeId = '10000000-0000-4000-8000-000000000001';
const orderId = '32000000-0000-4000-8000-000000000001';
const attemptId = '31000000-0000-4000-8000-000000000001';
const channelId = '40000000-0000-4000-8000-000000000001';

const config = {
  ZALO_CHECKOUT_CALLBACK_IP_ALLOWLIST: ['127.0.0.1'],
} as unknown as RuntimeConfig;

const channel = {
  channelId,
  checkoutAppId: 'checkout-app-1',
  defaultLocale: 'vi' as const,
  keyVersion: 'v1',
  methodCode: 'ZALOPAY_SANDBOX',
  privateKeySecretRef: 'env:ZALO_CHECKOUT_BEAUTY_PRIVATE_KEY',
  providerCode: 'ZALO_CHECKOUT_ZALOPAY' as const,
  providerEnvironment: 'SANDBOX' as const,
  storeCode: 'beauty-local',
  storeId,
  version: 1,
};

const fact: PaymentProviderFact = {
  amountVnd: 120_000,
  attemptId,
  currency: 'VND',
  orderId,
  providerOrderId: 'zalo-order-1',
  providerStatus: 'ZALO_CHECKOUT_1',
  providerTransactionId: 'zalo-tx-1',
  status: 'SUCCEEDED',
  storeId,
};

function rawBody(): Buffer {
  return Buffer.from(
    JSON.stringify({ data: { appId: channel.checkoutAppId, method: channel.methodCode } }),
  );
}

function service(provider: PaymentProvider): PaymentWebhookService {
  const resolver: PaymentProviderResolver = { resolve: vitest.fn().mockReturnValue(provider) };
  const limiter = { consume: vitest.fn().mockResolvedValue(undefined) };
  return new PaymentWebhookService(
    {} as never,
    resolver,
    config,
    limiter as unknown as PaymentWebhookRateLimiter,
  );
}

describe('PaymentWebhookService', () => {
  beforeEach(() => {
    databaseMocks.apply.mockReset().mockResolvedValue(undefined);
    databaseMocks.bind.mockReset().mockResolvedValue(undefined);
    databaseMocks.claim.mockReset().mockResolvedValue({
      callbackId: '50000000-0000-4000-8000-000000000001',
      callbackVersion: 2,
      claimed: true,
      duplicate: false,
      inFlight: false,
      inboxId: '60000000-0000-4000-8000-000000000001',
      inboxVersion: 2,
    });
    databaseMocks.resolveChannel.mockReset().mockResolvedValue(channel);
    databaseMocks.settle.mockReset().mockResolvedValue(undefined);
  });

  it('routes an authenticated callback through binding, fact application and settle', async () => {
    const provider: PaymentProvider = {
      code: 'ZALO_CHECKOUT_ZALOPAY',
      environment: 'SANDBOX',
      createPayment: vitest.fn(),
      queryPayment: vitest.fn(),
      parseCallback: vitest.fn().mockResolvedValue({
        externalEventId: `zc:${'a'.repeat(64)}`,
        fact,
        trust: 'AUTHENTICATED_FACT',
      }),
      createRefund: vitest.fn(),
      queryRefund: vitest.fn(),
    };
    await expect(
      service(provider).handle({
        headers: { 'content-type': 'application/json' },
        rawBody: rawBody(),
        remoteAddress: '::ffff:127.0.0.1',
      }),
    ).resolves.toEqual({ accepted: true, returnCode: 1, returnMessage: 'Callback processed' });
    expect(databaseMocks.bind).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ fact, providerEventId: expect.stringMatching(/^zc:/u) }),
    );
    expect(databaseMocks.apply).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ attemptId, fact, source: 'WEBHOOK' }),
    );
    expect(databaseMocks.settle).toHaveBeenCalledTimes(1);
  });

  it('acknowledges a callback already claimed by another request without applying facts twice', async () => {
    databaseMocks.claim.mockResolvedValue({
      callbackId: '50000000-0000-4000-8000-000000000001',
      callbackVersion: 2,
      claimed: false,
      duplicate: true,
      inFlight: false,
      inboxId: '60000000-0000-4000-8000-000000000001',
      inboxVersion: 2,
    });
    const provider: PaymentProvider = {
      code: 'ZALO_CHECKOUT_ZALOPAY',
      environment: 'SANDBOX',
      createPayment: vitest.fn(),
      queryPayment: vitest.fn(),
      parseCallback: vitest.fn().mockResolvedValue({
        externalEventId: `zc:${'b'.repeat(64)}`,
        fact,
        trust: 'AUTHENTICATED_FACT',
      }),
      createRefund: vitest.fn(),
      queryRefund: vitest.fn(),
    };
    const result = await service(provider).handle({
      headers: { 'content-type': 'application/json' },
      rawBody: rawBody(),
      remoteAddress: '127.0.0.1',
    });
    expect(result.returnCode).toBe(2);
    expect(databaseMocks.apply).not.toHaveBeenCalled();
  });

  it('asks the provider to retry while the first callback delivery is still processing', async () => {
    databaseMocks.claim.mockResolvedValue({
      callbackId: '50000000-0000-4000-8000-000000000001',
      callbackVersion: 2,
      claimed: false,
      duplicate: true,
      inFlight: true,
      inboxId: '60000000-0000-4000-8000-000000000001',
      inboxVersion: 2,
    });
    const provider: PaymentProvider = {
      code: 'ZALO_CHECKOUT_ZALOPAY',
      environment: 'SANDBOX',
      createPayment: vitest.fn(),
      queryPayment: vitest.fn(),
      parseCallback: vitest.fn().mockResolvedValue({
        externalEventId: `zc:${'d'.repeat(64)}`,
        fact,
        trust: 'AUTHENTICATED_FACT',
      }),
      createRefund: vitest.fn(),
      queryRefund: vitest.fn(),
    };

    await expect(
      service(provider).handle({
        headers: { 'content-type': 'application/json' },
        rawBody: rawBody(),
        remoteAddress: '127.0.0.1',
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(databaseMocks.apply).not.toHaveBeenCalled();
  });

  it('maps forged or cross-store provider callback facts to authentication failure', async () => {
    const provider: PaymentProvider = {
      code: 'ZALO_CHECKOUT_ZALOPAY',
      environment: 'SANDBOX',
      createPayment: vitest.fn(),
      queryPayment: vitest.fn(),
      parseCallback: vitest
        .fn()
        .mockRejectedValue(new ProviderIntegrationError('REJECTED', false, 'cross-store')),
      createRefund: vitest.fn(),
      queryRefund: vitest.fn(),
    };
    await expect(
      service(provider).handle({
        headers: { 'content-type': 'application/json' },
        rawBody: rawBody(),
        remoteAddress: '127.0.0.1',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('maps malformed callback routing input to a stable bad request', async () => {
    const provider: PaymentProvider = {
      code: 'ZALO_CHECKOUT_ZALOPAY',
      environment: 'SANDBOX',
      createPayment: vitest.fn(),
      queryPayment: vitest.fn(),
      parseCallback: vitest.fn(),
      createRefund: vitest.fn(),
      queryRefund: vitest.fn(),
    };
    await expect(
      service(provider).handle({
        headers: { 'content-type': 'application/json' },
        rawBody: Buffer.from('{'),
        remoteAddress: '127.0.0.1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(databaseMocks.resolveChannel).not.toHaveBeenCalled();
  });

  it('settles a permanent domain rejection and returns a stable bad request', async () => {
    databaseMocks.apply.mockRejectedValue(new PaymentCommandError('PAYMENT_FACT_INVALID'));
    const provider: PaymentProvider = {
      code: 'ZALO_CHECKOUT_ZALOPAY',
      environment: 'SANDBOX',
      createPayment: vitest.fn(),
      queryPayment: vitest.fn(),
      parseCallback: vitest.fn().mockResolvedValue({
        externalEventId: `zc:${'c'.repeat(64)}`,
        fact,
        trust: 'AUTHENTICATED_FACT',
      }),
      createRefund: vitest.fn(),
      queryRefund: vitest.fn(),
    };
    await expect(
      service(provider).handle({
        headers: { 'content-type': 'application/json' },
        rawBody: rawBody(),
        remoteAddress: '127.0.0.1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(databaseMocks.settle).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ disposition: 'REJECTED', errorCode: 'PAYMENT_FACT_INVALID' }),
    );
  });

  it('maps unavailable provider configuration to 503 without revealing details', async () => {
    const provider: PaymentProvider = {
      code: 'ZALO_CHECKOUT_ZALOPAY',
      environment: 'SANDBOX',
      createPayment: vitest.fn(),
      queryPayment: vitest.fn(),
      parseCallback: vitest
        .fn()
        .mockRejectedValue(new ProviderIntegrationError('CONFIGURATION', false)),
      createRefund: vitest.fn(),
      queryRefund: vitest.fn(),
    };
    await expect(
      service(provider).handle({
        headers: { 'content-type': 'application/json' },
        rawBody: rawBody(),
        remoteAddress: '127.0.0.1',
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
