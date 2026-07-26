import { vi } from 'vitest';

const databaseMocks = vi.hoisted(() => ({
  apply: vi.fn(),
  getRequest: vi.fn(),
}));

vi.mock('@zalo-shop/database', async () => {
  const actual: Record<string, unknown> = await vi.importActual('@zalo-shop/database');
  return {
    ...actual,
    applyPaymentProviderFact: databaseMocks.apply,
    getPaymentReconciliationRequest: databaseMocks.getRequest,
  };
});

import type { OutboxMessageRecord } from '@zalo-shop/database';
import { PaymentCommandError } from '@zalo-shop/database';
import {
  ProviderIntegrationError,
  type PaymentProviderFact,
  type PaymentProviderResolver,
} from '@zalo-shop/integrations';
import { beforeEach, describe, expect, it } from 'vitest';

import { PaymentReconciliationRequestedHandler } from './payment-reconciliation-requested.handler';

const storeId = '10000000-0000-4000-8000-000000000001';
const orderId = '30000000-0000-4000-8000-000000000001';
const attemptId = '31000000-0000-4000-8000-000000000001';

function message(input: Partial<OutboxMessageRecord> = {}): OutboxMessageRecord {
  return {
    aggregateId: attemptId,
    aggregateType: 'PAYMENT_ATTEMPT',
    attemptCount: 1,
    availableAt: new Date('2026-07-26T00:20:00.000Z'),
    completedAt: null,
    eventType: 'payment.reconcile.requested',
    eventVersion: 1,
    id: '32000000-0000-4000-8000-000000000001',
    idempotencyKey: `payment.reconcile.requested:${attemptId}`,
    lastErrorCode: null,
    leaseExpiresAt: new Date('2026-07-26T00:21:00.000Z'),
    leaseOwner: 'worker-test',
    maxAttempts: 8,
    payload: { payment_attempt_id: attemptId, store_id: storeId },
    status: 'PROCESSING',
    storeId,
    version: 2,
    ...input,
  };
}

const request = {
  attemptId,
  channel: {
    checkoutAppId: 'checkout-app-1',
    id: '40000000-0000-4000-8000-000000000001',
    keyVersion: 'v1',
    methodCode: 'ZALOPAY_SANDBOX',
    privateKeySecretRef: 'env:ZALO_CHECKOUT_BEAUTY_PRIVATE_KEY',
    providerCode: 'ZALO_CHECKOUT_ZALOPAY',
    providerEnvironment: 'SANDBOX' as const,
    version: 1,
  },
  expiresAt: new Date('2026-07-26T00:15:00.000Z'),
  orderId,
  providerOrderId: 'zalo-order-1',
  status: 'EXPIRED' as const,
  storeId,
};

const fact: PaymentProviderFact = {
  amountVnd: 120_000,
  attemptId,
  currency: 'VND',
  orderId,
  providerOrderId: request.providerOrderId,
  providerStatus: 'ZALO_CHECKOUT_1',
  providerTransactionId: 'zalo-tx-1',
  status: 'SUCCEEDED',
  storeId,
};

function setup(providerFact: PaymentProviderFact = fact) {
  const provider = {
    queryPayment: vi.fn().mockResolvedValue(providerFact),
  };
  const resolver = {
    resolve: vi.fn().mockReturnValue(provider),
  } as unknown as PaymentProviderResolver;
  return { handler: new PaymentReconciliationRequestedHandler({} as never, resolver), provider };
}

describe('PaymentReconciliationRequestedHandler', () => {
  beforeEach(() => {
    databaseMocks.apply.mockReset().mockResolvedValue({ status: 'REVIEW_REQUIRED' });
    databaseMocks.getRequest.mockReset().mockResolvedValue(request);
  });

  it('rejects payloads that are not exactly bound to the outbox aggregate and store', async () => {
    const { handler, provider } = setup();

    await expect(
      handler.handle(message({ payload: { payment_attempt_id: attemptId, store_id: 'other' } })),
    ).rejects.toMatchObject({
      code: 'PAYMENT_RECONCILE_PAYLOAD_INVALID',
      disposition: 'PERMANENT',
    });
    expect(provider.queryPayment).not.toHaveBeenCalled();
  });

  it('queries an expired bound attempt and applies a late success through reconciliation', async () => {
    const { handler, provider } = setup();

    await expect(handler.handle(message())).resolves.toBeUndefined();
    expect(provider.queryPayment).toHaveBeenCalledWith({
      providerOrderId: request.providerOrderId,
      storeId,
    });
    expect(databaseMocks.apply).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ storeId }),
      expect.objectContaining({ attemptId, fact, source: 'RECONCILIATION' }),
    );
  });

  it('defers a still-pending fact with a bounded reconciliation retry delay', async () => {
    const pendingFact = { ...fact, providerTransactionId: undefined, status: 'PENDING' as const };
    databaseMocks.apply.mockResolvedValue({ status: 'EXPIRED' });
    const { handler } = setup(pendingFact);

    await expect(handler.handle(message())).rejects.toMatchObject({
      code: 'PAYMENT_RECONCILIATION_PENDING',
      disposition: 'RETRYABLE',
      retryDelayMs: 300_000,
    });
  });

  it('does not call the provider for already succeeded or review-required attempts', async () => {
    databaseMocks.getRequest.mockResolvedValue({ ...request, status: 'SUCCEEDED' });
    const { handler, provider } = setup();

    await expect(handler.handle(message())).resolves.toBeUndefined();
    expect(provider.queryPayment).not.toHaveBeenCalled();
    expect(databaseMocks.apply).not.toHaveBeenCalled();
  });

  it('classifies transient provider failures for the reliable outbox retry path', async () => {
    const { handler, provider } = setup();
    provider.queryPayment.mockRejectedValue(
      new ProviderIntegrationError('TIMEOUT', true, 'sensitive upstream text'),
    );

    await expect(handler.handle(message())).rejects.toMatchObject({
      code: 'PAYMENT_PROVIDER_TIMEOUT',
      disposition: 'RETRYABLE',
    });
  });

  it('treats a webhook-winning race as complete after re-reading terminal state', async () => {
    databaseMocks.apply.mockRejectedValue(new PaymentCommandError('PAYMENT_ATTEMPT_CONFLICT'));
    databaseMocks.getRequest
      .mockResolvedValueOnce({ ...request, status: 'PROVIDER_PENDING' })
      .mockResolvedValueOnce({ ...request, status: 'SUCCEEDED' });
    const { handler } = setup();

    await expect(handler.handle(message())).resolves.toBeUndefined();
    expect(databaseMocks.getRequest).toHaveBeenCalledTimes(2);
  });
});
