export const PAYMENT_ATTEMPT_STATUSES = [
  'CREATED',
  'PROVIDER_PENDING',
  'SUCCEEDED',
  'FAILED',
  'EXPIRED',
  'CANCELLED',
  'REVIEW_REQUIRED',
] as const;

export type PaymentAttemptStatus = (typeof PAYMENT_ATTEMPT_STATUSES)[number];

export type PaymentAttemptEvent =
  | 'PROVIDER_ACCEPTED'
  | 'PROVIDER_SUCCEEDED'
  | 'PROVIDER_FAILED'
  | 'EXPIRE'
  | 'CANCEL'
  | 'LATE_SUCCESS'
  | 'REQUIRE_REVIEW';

export const REFUND_STATUSES = [
  'REQUESTED',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'REVIEW_REQUIRED',
] as const;

export type RefundStatus = (typeof REFUND_STATUSES)[number];

export type RefundEvent =
  'PROVIDER_ACCEPTED' | 'PROVIDER_SUCCEEDED' | 'PROVIDER_FAILED' | 'CANCEL' | 'REQUIRE_REVIEW';

export type PaymentInvariantErrorCode =
  | 'PAYMENT_STATE_CONFLICT'
  | 'REFUND_STATE_CONFLICT'
  | 'PAYMENT_FACT_MISMATCH'
  | 'PAYMENT_AMOUNT_INVALID'
  | 'REFUND_AMOUNT_INVALID'
  | 'REFUND_AMOUNT_EXCEEDS_AVAILABLE';

export class PaymentInvariantError extends Error {
  public constructor(public readonly code: PaymentInvariantErrorCode) {
    super(code);
    this.name = 'PaymentInvariantError';
  }
}

const paymentTransitions: Readonly<
  Record<PaymentAttemptStatus, Partial<Record<PaymentAttemptEvent, PaymentAttemptStatus>>>
> = {
  CREATED: {
    PROVIDER_ACCEPTED: 'PROVIDER_PENDING',
    PROVIDER_SUCCEEDED: 'SUCCEEDED',
    PROVIDER_FAILED: 'FAILED',
    EXPIRE: 'EXPIRED',
    CANCEL: 'CANCELLED',
    REQUIRE_REVIEW: 'REVIEW_REQUIRED',
  },
  PROVIDER_PENDING: {
    PROVIDER_SUCCEEDED: 'SUCCEEDED',
    PROVIDER_FAILED: 'FAILED',
    EXPIRE: 'EXPIRED',
    CANCEL: 'CANCELLED',
    REQUIRE_REVIEW: 'REVIEW_REQUIRED',
  },
  SUCCEEDED: {},
  FAILED: { LATE_SUCCESS: 'REVIEW_REQUIRED', REQUIRE_REVIEW: 'REVIEW_REQUIRED' },
  EXPIRED: { LATE_SUCCESS: 'REVIEW_REQUIRED', REQUIRE_REVIEW: 'REVIEW_REQUIRED' },
  CANCELLED: { LATE_SUCCESS: 'REVIEW_REQUIRED', REQUIRE_REVIEW: 'REVIEW_REQUIRED' },
  REVIEW_REQUIRED: {},
};

const refundTransitions: Readonly<
  Record<RefundStatus, Partial<Record<RefundEvent, RefundStatus>>>
> = {
  REQUESTED: {
    PROVIDER_ACCEPTED: 'PROCESSING',
    PROVIDER_SUCCEEDED: 'SUCCEEDED',
    PROVIDER_FAILED: 'FAILED',
    CANCEL: 'CANCELLED',
    REQUIRE_REVIEW: 'REVIEW_REQUIRED',
  },
  PROCESSING: {
    PROVIDER_SUCCEEDED: 'SUCCEEDED',
    PROVIDER_FAILED: 'FAILED',
    REQUIRE_REVIEW: 'REVIEW_REQUIRED',
  },
  SUCCEEDED: {},
  FAILED: { REQUIRE_REVIEW: 'REVIEW_REQUIRED' },
  CANCELLED: {},
  REVIEW_REQUIRED: {},
};

export function transitionPaymentAttempt(
  current: PaymentAttemptStatus,
  event: PaymentAttemptEvent,
): PaymentAttemptStatus {
  const target = paymentTransitions[current][event];
  if (!target) throw new PaymentInvariantError('PAYMENT_STATE_CONFLICT');
  return target;
}

export function transitionRefund(current: RefundStatus, event: RefundEvent): RefundStatus {
  const target = refundTransitions[current][event];
  if (!target) throw new PaymentInvariantError('REFUND_STATE_CONFLICT');
  return target;
}

function assertVndAmount(
  amountVnd: number,
  allowZero: boolean,
  errorCode: PaymentInvariantErrorCode,
) {
  if (!Number.isSafeInteger(amountVnd) || amountVnd < 0 || (!allowZero && amountVnd === 0)) {
    throw new PaymentInvariantError(errorCode);
  }
}

export type PaymentFactIdentity = Readonly<{
  amountVnd: number;
  attemptId: string;
  currency: string;
  orderId: string;
  providerOrderId: string;
  storeId: string;
}>;

export function assertPaymentFactMatches(
  expected: PaymentFactIdentity,
  received: PaymentFactIdentity,
): void {
  assertVndAmount(expected.amountVnd, false, 'PAYMENT_AMOUNT_INVALID');
  assertVndAmount(received.amountVnd, false, 'PAYMENT_AMOUNT_INVALID');
  if (
    expected.currency !== 'VND' ||
    received.currency !== 'VND' ||
    expected.amountVnd !== received.amountVnd ||
    expected.attemptId !== received.attemptId ||
    expected.orderId !== received.orderId ||
    expected.providerOrderId !== received.providerOrderId ||
    expected.storeId !== received.storeId
  ) {
    throw new PaymentInvariantError('PAYMENT_FACT_MISMATCH');
  }
}

export function calculateRefundableAmount(input: {
  capturedAmountVnd: number;
  inFlightRefundAmountVnd: number;
  succeededRefundAmountVnd: number;
}): number {
  assertVndAmount(input.capturedAmountVnd, false, 'PAYMENT_AMOUNT_INVALID');
  assertVndAmount(input.inFlightRefundAmountVnd, true, 'REFUND_AMOUNT_INVALID');
  assertVndAmount(input.succeededRefundAmountVnd, true, 'REFUND_AMOUNT_INVALID');
  const unavailable = input.inFlightRefundAmountVnd + input.succeededRefundAmountVnd;
  if (!Number.isSafeInteger(unavailable) || unavailable > input.capturedAmountVnd) {
    throw new PaymentInvariantError('REFUND_AMOUNT_INVALID');
  }
  return input.capturedAmountVnd - unavailable;
}

export function assertRefundAmountAllowed(input: {
  capturedAmountVnd: number;
  inFlightRefundAmountVnd: number;
  requestedAmountVnd: number;
  succeededRefundAmountVnd: number;
}): void {
  assertVndAmount(input.requestedAmountVnd, false, 'REFUND_AMOUNT_INVALID');
  const available = calculateRefundableAmount(input);
  if (input.requestedAmountVnd > available) {
    throw new PaymentInvariantError('REFUND_AMOUNT_EXCEEDS_AVAILABLE');
  }
}
