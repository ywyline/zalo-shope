import { vi } from 'vitest';

const databaseMocks = vi.hoisted(() => ({
  apply: vi.fn(),
  getRequest: vi.fn(),
  markReview: vi.fn(),
}));

vi.mock('@zalo-shop/database', async () => {
  const actual: Record<string, unknown> = await vi.importActual('@zalo-shop/database');
  return {
    ...actual,
    applyRefundProviderFact: databaseMocks.apply,
    getRefundProviderRequest: databaseMocks.getRequest,
    markRefundReviewRequired: databaseMocks.markReview,
  };
});

import type { OutboxMessageRecord } from '@zalo-shop/database';
import { ProviderIntegrationError, type PaymentProviderResolver } from '@zalo-shop/integrations';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  RefundCreateRequestedHandler,
  RefundQueryRequestedHandler,
} from './refund-requested.handlers';

const storeId = '10000000-0000-4000-8000-000000000001';
const refundId = '33000000-0000-4000-8000-000000000001';

function message(eventType: string, input: Partial<OutboxMessageRecord> = {}): OutboxMessageRecord {
  return {
    aggregateId: refundId,
    aggregateType: 'REFUND',
    attemptCount: 1,
    availableAt: new Date('2026-07-26T10:00:00.000Z'),
    completedAt: null,
    eventType,
    eventVersion: 1,
    id: '34000000-0000-4000-8000-000000000001',
    idempotencyKey: `${eventType}:${refundId}`,
    lastErrorCode: null,
    leaseExpiresAt: new Date('2026-07-26T10:01:00.000Z'),
    leaseOwner: 'worker-test',
    maxAttempts: 8,
    payload: { refund_id: refundId, store_id: storeId },
    status: 'PROCESSING',
    storeId,
    version: 2,
    ...input,
  };
}

const providerRequest = {
  amountVnd: 40_000,
  channel: {
    checkoutAppId: 'checkout-app-1',
    id: '40000000-0000-4000-8000-000000000001',
    keyVersion: 'v1',
    methodCode: 'ZALOPAY_SANDBOX',
    privateKeySecretRef: 'env:ZALO_PRIVATE_KEY',
    providerCode: 'ZALO_CHECKOUT_ZALOPAY',
    providerEnvironment: 'SANDBOX' as const,
    version: 1,
  },
  description: 'Customer approved partial refund',
  paymentProviderTransactionId: 'zalo-payment-1',
  providerRefundId: null,
  publicRefundNumber: 'RFD-1',
  refundId,
  status: 'REQUESTED' as const,
  storeId,
  version: 1,
};

function setup() {
  const provider = {
    createRefund: vi.fn().mockResolvedValue({
      amountVnd: 40_000,
      providerRefundId: 'zalo-refund-1',
      providerStatus: 'ZALO_CHECKOUT_2',
      status: 'PENDING',
    }),
    queryRefund: vi.fn().mockResolvedValue({
      amountVnd: 40_000,
      providerRefundId: 'zalo-refund-1',
      providerStatus: 'ZALO_CHECKOUT_1',
      status: 'SUCCEEDED',
    }),
  };
  const resolver = {
    resolve: vi.fn().mockReturnValue(provider),
  } as unknown as PaymentProviderResolver;
  return {
    create: new RefundCreateRequestedHandler({} as never, resolver),
    provider,
    query: new RefundQueryRequestedHandler({} as never, resolver),
  };
}

describe('M5.7 refund outbox handlers', () => {
  beforeEach(() => {
    databaseMocks.apply.mockReset().mockResolvedValue({ status: 'PROCESSING' });
    databaseMocks.getRequest.mockReset().mockResolvedValue(providerRequest);
    databaseMocks.markReview.mockReset().mockResolvedValue({ status: 'REVIEW_REQUIRED' });
  });

  it('rejects payloads that are not exactly bound to the refund and store', async () => {
    const { create, provider } = setup();
    await expect(
      create.handle(
        message('refund.create.requested', {
          payload: { refund_id: refundId, store_id: 'other-store' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'REFUND_OUTBOX_PAYLOAD_INVALID', disposition: 'PERMANENT' });
    expect(provider.createRefund).not.toHaveBeenCalled();
  });

  it('creates a provider refund once and applies the normalized fact', async () => {
    const { create, provider } = setup();
    await expect(create.handle(message('refund.create.requested'))).resolves.toBeUndefined();
    expect(provider.createRefund).toHaveBeenCalledWith(providerRequest);
    expect(databaseMocks.apply).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ storeId }),
      expect.objectContaining({ refundId, source: 'SYSTEM' }),
    );
  });

  it('fails an ambiguous create closed to review without automatic retry', async () => {
    const { create, provider } = setup();
    provider.createRefund.mockRejectedValue(
      new ProviderIntegrationError('TIMEOUT', false, 'upstream body must not escape'),
    );
    await expect(create.handle(message('refund.create.requested'))).rejects.toMatchObject({
      code: 'REFUND_PROVIDER_TIMEOUT',
      disposition: 'REVIEW_REQUIRED',
    });
    expect(databaseMocks.markReview).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ storeId }),
      { reason: 'REFUND_PROVIDER_TIMEOUT', refundId },
    );
  });

  it('queries a processing refund and applies success', async () => {
    databaseMocks.getRequest.mockResolvedValue({
      ...providerRequest,
      providerRefundId: 'zalo-refund-1',
      status: 'PROCESSING',
    });
    const { provider, query } = setup();
    await expect(query.handle(message('refund.query.requested'))).resolves.toBeUndefined();
    expect(provider.queryRefund).toHaveBeenCalledWith({
      amountVnd: 40_000,
      providerRefundId: 'zalo-refund-1',
      storeId,
    });
  });

  it('uses bounded retry only for a safe pending query', async () => {
    databaseMocks.getRequest.mockResolvedValue({
      ...providerRequest,
      providerRefundId: 'zalo-refund-1',
      status: 'PROCESSING',
    });
    const { provider, query } = setup();
    provider.queryRefund.mockResolvedValue({
      amountVnd: 40_000,
      providerRefundId: 'zalo-refund-1',
      providerStatus: 'ZALO_CHECKOUT_2',
      status: 'PENDING',
    });
    await expect(query.handle(message('refund.query.requested'))).rejects.toMatchObject({
      code: 'REFUND_QUERY_PENDING',
      disposition: 'RETRYABLE',
      retryDelayMs: 300_000,
    });
  });
});
