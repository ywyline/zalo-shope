import { describe, expect, it } from 'vitest';

import {
  calculateDeliveryFees,
  calculateOrderPayable,
  isCodAmountAllowed,
  transitionOrderStatus,
} from './order';

describe('M4 order state machine', () => {
  it('supports COD confirmation and fulfilment handoff', () => {
    const confirmed = transitionOrderStatus('PENDING_CONFIRMATION', 'CONFIRM_COD');
    expect(confirmed).toBe('CONFIRMED');
    expect(transitionOrderStatus(confirmed, 'FULFILLMENT_READY')).toBe('PENDING_FULFILLMENT');
    expect(transitionOrderStatus('CONFIRMED', 'SHIP')).toBe('SHIPPED');
  });

  it('rejects terminal or unsupported transitions', () => {
    expect(() => transitionOrderStatus('COMPLETED', 'CANCEL')).toThrow('ORDER_STATE_CONFLICT');
    expect(() => transitionOrderStatus('PENDING_PAYMENT', 'CONFIRM_COD')).toThrow(
      'ORDER_STATE_CONFLICT',
    );
  });
});

describe('M4 VND delivery calculation', () => {
  it('applies free shipping before remote surcharge and caps discount', () => {
    expect(
      calculateDeliveryFees({
        merchandisePayableVnd: 600_000,
        policy: {
          flatShippingFeeVnd: 30_000,
          freeShippingThresholdVnd: 500_000,
          isRemote: true,
          remoteSurchargeVnd: 20_000,
          shippingPromotionDiscountVnd: 40_000,
        },
      }),
    ).toEqual({ shippingDiscountVnd: 0, shippingFeeVnd: 0, remoteSurchargeVnd: 20_000 });
  });

  it('computes an integer final payable amount', () => {
    expect(
      calculateOrderPayable({
        baseSubtotalVnd: 100_000,
        itemDiscountVnd: 10_000,
        couponDiscountVnd: 5_000,
        orderDiscountVnd: 0,
        shippingFeeVnd: 20_000,
        remoteSurchargeVnd: 0,
        shippingDiscountVnd: 5_000,
      }),
    ).toBe(100_000);
  });
});

describe('M4 COD policy', () => {
  it('enforces enabled and maximum amount', () => {
    expect(
      isCodAmountAllowed({ enabled: true, maxAmountVnd: 2_000_000, payableVnd: 1_000_000 }),
    ).toBe(true);
    expect(
      isCodAmountAllowed({ enabled: true, maxAmountVnd: 500_000, payableVnd: 1_000_000 }),
    ).toBe(false);
  });
});
