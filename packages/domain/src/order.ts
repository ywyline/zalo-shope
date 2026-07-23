export type OrderStatus =
  | 'PENDING_PAYMENT'
  | 'PENDING_CONFIRMATION'
  | 'CONFIRMED'
  | 'PENDING_FULFILLMENT'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'CLOSED';

export type OrderEvent =
  | 'SUBMIT_COD'
  | 'CONFIRM_COD'
  | 'FULFILLMENT_READY'
  | 'CANCEL'
  | 'CLOSE'
  | 'SHIP'
  | 'DELIVER'
  | 'COMPLETE';

export class OrderStateError extends Error {
  public constructor(public readonly code: 'ORDER_STATE_CONFLICT') {
    super(code);
    this.name = 'OrderStateError';
  }
}

const transitions: Readonly<Record<OrderStatus, Partial<Record<OrderEvent, OrderStatus>>>> = {
  PENDING_PAYMENT: { CANCEL: 'CANCELLED', CLOSE: 'CLOSED' },
  PENDING_CONFIRMATION: { CONFIRM_COD: 'CONFIRMED', CANCEL: 'CANCELLED', CLOSE: 'CLOSED' },
  CONFIRMED: {
    FULFILLMENT_READY: 'PENDING_FULFILLMENT',
    CANCEL: 'CANCELLED',
    SHIP: 'SHIPPED',
  },
  PENDING_FULFILLMENT: { CANCEL: 'CANCELLED', SHIP: 'SHIPPED' },
  SHIPPED: { DELIVER: 'DELIVERED' },
  DELIVERED: { COMPLETE: 'COMPLETED' },
  COMPLETED: {},
  CANCELLED: {},
  CLOSED: {},
};

export function transitionOrderStatus(current: OrderStatus, event: OrderEvent): OrderStatus {
  const target = transitions[current][event];
  if (!target) throw new OrderStateError('ORDER_STATE_CONFLICT');
  return target;
}

export type DeliveryPolicy = Readonly<{
  flatShippingFeeVnd: number;
  freeShippingThresholdVnd: number | null;
  remoteSurchargeVnd: number;
  isRemote: boolean;
  shippingPromotionDiscountVnd?: number;
}>;

export function calculateDeliveryFees(input: {
  merchandisePayableVnd: number;
  policy: DeliveryPolicy;
}): {
  shippingFeeVnd: number;
  remoteSurchargeVnd: number;
  shippingDiscountVnd: number;
} {
  const { merchandisePayableVnd, policy } = input;
  if (!Number.isSafeInteger(merchandisePayableVnd) || merchandisePayableVnd < 0) {
    throw new RangeError('MERCHANDISE_AMOUNT_INVALID');
  }
  const shippingEligible =
    policy.freeShippingThresholdVnd !== null &&
    merchandisePayableVnd >= policy.freeShippingThresholdVnd;
  const grossShipping = shippingEligible ? 0 : policy.flatShippingFeeVnd;
  const discount = Math.min(grossShipping, Math.max(0, policy.shippingPromotionDiscountVnd ?? 0));
  return {
    remoteSurchargeVnd: policy.isRemote ? policy.remoteSurchargeVnd : 0,
    shippingDiscountVnd: discount,
    shippingFeeVnd: grossShipping,
  };
}

export function calculateOrderPayable(input: {
  baseSubtotalVnd: number;
  itemDiscountVnd: number;
  couponDiscountVnd: number;
  orderDiscountVnd: number;
  shippingFeeVnd: number;
  remoteSurchargeVnd: number;
  shippingDiscountVnd: number;
}): number {
  const values = Object.values(input);
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError('ORDER_AMOUNT_INVALID');
  }
  const payable =
    input.baseSubtotalVnd -
    input.itemDiscountVnd -
    input.couponDiscountVnd -
    input.orderDiscountVnd +
    input.shippingFeeVnd +
    input.remoteSurchargeVnd -
    input.shippingDiscountVnd;
  if (payable < 0 || !Number.isSafeInteger(payable)) throw new RangeError('ORDER_AMOUNT_INVALID');
  return payable;
}

export function isCodAmountAllowed(input: {
  enabled: boolean;
  maxAmountVnd: number | null;
  payableVnd: number;
}): boolean {
  return (
    input.enabled &&
    input.payableVnd > 0 &&
    Number.isSafeInteger(input.payableVnd) &&
    (input.maxAmountVnd === null || input.payableVnd <= input.maxAmountVnd)
  );
}
