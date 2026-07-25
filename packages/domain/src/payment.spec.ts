import { describe, expect, it } from 'vitest';

import {
  assertPaymentFactMatches,
  assertRefundAmountAllowed,
  calculateRefundableAmount,
  transitionPaymentAttempt,
  transitionRefund,
} from './payment';

describe('M5 payment attempt state machine', () => {
  it('accepts immediate and asynchronous provider success', () => {
    expect(transitionPaymentAttempt('CREATED', 'PROVIDER_SUCCEEDED')).toBe('SUCCEEDED');
    expect(transitionPaymentAttempt('CREATED', 'PROVIDER_ACCEPTED')).toBe('PROVIDER_PENDING');
    expect(transitionPaymentAttempt('PROVIDER_PENDING', 'PROVIDER_SUCCEEDED')).toBe('SUCCEEDED');
  });

  it('routes a late success after cancellation or expiry to manual review', () => {
    expect(transitionPaymentAttempt('CANCELLED', 'LATE_SUCCESS')).toBe('REVIEW_REQUIRED');
    expect(transitionPaymentAttempt('EXPIRED', 'LATE_SUCCESS')).toBe('REVIEW_REQUIRED');
    expect(() => transitionPaymentAttempt('CANCELLED', 'PROVIDER_SUCCEEDED')).toThrow(
      'PAYMENT_STATE_CONFLICT',
    );
  });

  it('does not reopen successful or review-required attempts', () => {
    expect(() => transitionPaymentAttempt('SUCCEEDED', 'PROVIDER_FAILED')).toThrow(
      'PAYMENT_STATE_CONFLICT',
    );
    expect(() => transitionPaymentAttempt('REVIEW_REQUIRED', 'PROVIDER_SUCCEEDED')).toThrow(
      'PAYMENT_STATE_CONFLICT',
    );
  });
});

describe('M5 payment fact validation', () => {
  const expected = {
    amountVnd: 500_000,
    currency: 'VND',
    orderId: 'order-1',
    providerOrderId: 'zmp-order-1',
    storeId: 'store-beauty',
  };

  it('requires exact store, order, provider order, currency and integer amount', () => {
    expect(() => assertPaymentFactMatches(expected, expected)).not.toThrow();
    expect(() =>
      assertPaymentFactMatches(expected, { ...expected, storeId: 'store-fashion' }),
    ).toThrow('PAYMENT_FACT_MISMATCH');
    expect(() => assertPaymentFactMatches(expected, { ...expected, amountVnd: 499_999 })).toThrow(
      'PAYMENT_FACT_MISMATCH',
    );
    expect(() => assertPaymentFactMatches(expected, { ...expected, amountVnd: 499_999.5 })).toThrow(
      'PAYMENT_AMOUNT_INVALID',
    );
  });
});

describe('M5 refund invariants', () => {
  it('reserves in-flight refunds when calculating the available amount', () => {
    expect(
      calculateRefundableAmount({
        capturedAmountVnd: 500_000,
        inFlightRefundAmountVnd: 100_000,
        succeededRefundAmountVnd: 150_000,
      }),
    ).toBe(250_000);
    expect(() =>
      assertRefundAmountAllowed({
        capturedAmountVnd: 500_000,
        inFlightRefundAmountVnd: 100_000,
        requestedAmountVnd: 250_001,
        succeededRefundAmountVnd: 150_000,
      }),
    ).toThrow('REFUND_AMOUNT_EXCEEDS_AVAILABLE');
  });

  it('keeps refund transitions explicit and terminal', () => {
    expect(transitionRefund('REQUESTED', 'PROVIDER_ACCEPTED')).toBe('PROCESSING');
    expect(transitionRefund('PROCESSING', 'PROVIDER_SUCCEEDED')).toBe('SUCCEEDED');
    expect(() => transitionRefund('SUCCEEDED', 'PROVIDER_FAILED')).toThrow('REFUND_STATE_CONFLICT');
  });
});
