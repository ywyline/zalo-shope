import type { ShipmentPurpose, ShipmentStatus } from './shipment';

export const AFTER_SALE_TYPES = [
  'REFUND_ONLY',
  'RETURN_REFUND',
  'EXCHANGE',
  'MERCHANT_REFUND',
] as const;

export type AfterSaleType = (typeof AFTER_SALE_TYPES)[number];

export const AFTER_SALE_STATUSES = [
  'PENDING_REVIEW',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'RETURN_PENDING',
  'RETURN_IN_TRANSIT',
  'INSPECTION_PENDING',
  'REFUND_PENDING',
  'REFUND_PROCESSING',
  'REFUNDED',
  'EXCHANGE_PENDING',
  'EXCHANGE_IN_TRANSIT',
  'REVIEW_REQUIRED',
  'COMPLETED',
] as const;

export type AfterSaleStatus = (typeof AFTER_SALE_STATUSES)[number];

export type AfterSaleEvent =
  | 'SUBMIT'
  | 'APPROVE'
  | 'REJECT'
  | 'CANCEL'
  | 'START_RETURN'
  | 'RETURN_EXPIRED'
  | 'RETURN_SHIPPED'
  | 'RETURN_RECEIVED'
  | 'ACCEPT_INSPECTION'
  | 'REJECT_INSPECTION'
  | 'QUEUE_REFUND'
  | 'REFUND_REQUESTED'
  | 'REFUND_SUCCEEDED'
  | 'REFUND_FAILED'
  | 'REFUND_CANCELLED'
  | 'CONVERT_EXCHANGE_TO_REFUND'
  | 'EXCHANGE_SHIPPED'
  | 'EXCHANGE_DELIVERED'
  | 'REQUIRE_REVIEW'
  | 'RESUME_REVIEW'
  | 'REJECT_REVIEW'
  | 'LEGACY_APPROVE'
  | 'LEGACY_REJECT'
  | 'COMPLETE';

export const AFTER_SALE_ACTOR_TYPES = ['MEMBER', 'ADMIN', 'SYSTEM'] as const;
export type AfterSaleActorType = (typeof AFTER_SALE_ACTOR_TYPES)[number];

export const AFTER_SALE_SYSTEM_EVENTS = [
  'RETURN_EXPIRED',
  'REFUND_SUCCEEDED',
  'REFUND_FAILED',
  'REFUND_CANCELLED',
  'REQUIRE_REVIEW',
  'COMPLETE',
] as const satisfies readonly AfterSaleEvent[];

const afterSaleSystemEvents = new Set<AfterSaleEvent>(AFTER_SALE_SYSTEM_EVENTS);
const afterSaleMemberEvents = new Set<AfterSaleEvent>(['SUBMIT', 'CANCEL', 'START_RETURN']);

export const AFTER_SALE_SYSTEM_SCOPE = 'after-sale-transition' as const;
export const AFTER_SALE_EVIDENCE_SYSTEM_SCOPE = 'after-sale-evidence-lifecycle' as const;
export const AFTER_SALE_EVIDENCE_SYSTEM_ACTOR_ID = '00000000-0000-4000-8000-000000000006' as const;

export type AfterSaleSystemContext = Readonly<{
  actor: Readonly<{ id: string; type: 'system' }>;
  correlationId: string;
  storeId: string;
  systemScope: typeof AFTER_SALE_SYSTEM_SCOPE;
}>;

export type AfterSaleSystemContextInput = {
  actorId: string;
  correlationId: string;
  storeId: string;
};

export type AfterSaleEvidenceSystemContext = Readonly<{
  actor: Readonly<{
    id: typeof AFTER_SALE_EVIDENCE_SYSTEM_ACTOR_ID;
    type: 'system';
  }>;
  correlationId: string;
  storeId: string;
  systemScope: typeof AFTER_SALE_EVIDENCE_SYSTEM_SCOPE;
}>;

export type AfterSaleEvidenceSystemContextInput = {
  correlationId: string;
  storeId: string;
};

function requireAfterSaleSystemContextValue(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new AfterSaleInvariantError('AFTER_SALE_ACTOR_NOT_ALLOWED');
  }
  return normalized;
}

export function createAfterSaleSystemContext(
  input: AfterSaleSystemContextInput,
): AfterSaleSystemContext {
  return Object.freeze({
    actor: Object.freeze({
      id: requireAfterSaleSystemContextValue(input.actorId),
      type: 'system' as const,
    }),
    correlationId: requireAfterSaleSystemContextValue(input.correlationId),
    storeId: requireAfterSaleSystemContextValue(input.storeId),
    systemScope: AFTER_SALE_SYSTEM_SCOPE,
  });
}

export function createAfterSaleEvidenceSystemContext(
  input: AfterSaleEvidenceSystemContextInput,
): AfterSaleEvidenceSystemContext {
  return Object.freeze({
    actor: Object.freeze({
      id: AFTER_SALE_EVIDENCE_SYSTEM_ACTOR_ID,
      type: 'system' as const,
    }),
    correlationId: requireAfterSaleSystemContextValue(input.correlationId),
    storeId: requireAfterSaleSystemContextValue(input.storeId),
    systemScope: AFTER_SALE_EVIDENCE_SYSTEM_SCOPE,
  });
}

export type AfterSaleInvariantErrorCode =
  | 'AFTER_SALE_STATE_CONFLICT'
  | 'AFTER_SALE_QUANTITY_INVALID'
  | 'AFTER_SALE_QUANTITY_EXCEEDS_AVAILABLE'
  | 'AFTER_SALE_REFUND_AMOUNT_INVALID'
  | 'AFTER_SALE_REFUND_EXCEEDS_APPROVED'
  | 'AFTER_SALE_INVENTORY_RESTORE_NOT_ALLOWED'
  | 'AFTER_SALE_INVENTORY_RESTORE_EXCEEDS_AVAILABLE'
  | 'AFTER_SALE_INSPECTION_INVALID'
  | 'AFTER_SALE_EXCHANGE_NOT_ALLOWED'
  | 'AFTER_SALE_RETURN_WINDOW_INVALID'
  | 'AFTER_SALE_RETURN_WINDOW_CLOSED'
  | 'AFTER_SALE_REQUEST_WINDOW_INVALID'
  | 'AFTER_SALE_REQUEST_WINDOW_CLOSED'
  | 'AFTER_SALE_ACTOR_NOT_ALLOWED'
  | 'AFTER_SALE_POLICY_MISMATCH'
  | 'AFTER_SALE_REASON_NOT_ALLOWED'
  | 'AFTER_SALE_ORDER_NOT_ELIGIBLE'
  | 'AFTER_SALE_PAYMENT_NOT_PROVEN'
  | 'AFTER_SALE_EVIDENCE_REQUIRED'
  | 'AFTER_SALE_EVIDENCE_CAPABILITY_UNAVAILABLE'
  | 'AFTER_SALE_EVIDENCE_ACCESS_DENIED'
  | 'AFTER_SALE_EVIDENCE_RETENTION_ACTIVE';

export class AfterSaleInvariantError extends Error {
  public constructor(public readonly code: AfterSaleInvariantErrorCode) {
    super(code);
    this.name = 'AfterSaleInvariantError';
  }
}

const refundOnlyTransitions: Readonly<
  Partial<Record<AfterSaleStatus, Partial<Record<AfterSaleEvent, AfterSaleStatus>>>>
> = {
  PENDING_REVIEW: { APPROVE: 'APPROVED', CANCEL: 'CANCELLED', REJECT: 'REJECTED' },
  APPROVED: { QUEUE_REFUND: 'REFUND_PENDING', REQUIRE_REVIEW: 'REVIEW_REQUIRED' },
  REFUND_PENDING: {
    REFUND_REQUESTED: 'REFUND_PROCESSING',
    REQUIRE_REVIEW: 'REVIEW_REQUIRED',
  },
  REFUND_PROCESSING: {
    REFUND_SUCCEEDED: 'REFUNDED',
    REFUND_FAILED: 'REFUND_PENDING',
    REFUND_CANCELLED: 'REFUND_PENDING',
    REQUIRE_REVIEW: 'REVIEW_REQUIRED',
  },
  REFUNDED: { COMPLETE: 'COMPLETED' },
};

const returnRefundTransitions: Readonly<
  Partial<Record<AfterSaleStatus, Partial<Record<AfterSaleEvent, AfterSaleStatus>>>>
> = {
  PENDING_REVIEW: { APPROVE: 'APPROVED', CANCEL: 'CANCELLED', REJECT: 'REJECTED' },
  APPROVED: {
    START_RETURN: 'RETURN_PENDING',
    RETURN_EXPIRED: 'REJECTED',
    REQUIRE_REVIEW: 'REVIEW_REQUIRED',
  },
  RETURN_PENDING: { RETURN_SHIPPED: 'RETURN_IN_TRANSIT', REQUIRE_REVIEW: 'REVIEW_REQUIRED' },
  RETURN_IN_TRANSIT: {
    RETURN_RECEIVED: 'INSPECTION_PENDING',
    REQUIRE_REVIEW: 'REVIEW_REQUIRED',
  },
  INSPECTION_PENDING: {
    ACCEPT_INSPECTION: 'REFUND_PENDING',
    REJECT_INSPECTION: 'REJECTED',
    REQUIRE_REVIEW: 'REVIEW_REQUIRED',
  },
  REFUND_PENDING: {
    REFUND_REQUESTED: 'REFUND_PROCESSING',
    REQUIRE_REVIEW: 'REVIEW_REQUIRED',
  },
  REFUND_PROCESSING: {
    REFUND_SUCCEEDED: 'REFUNDED',
    REFUND_FAILED: 'REFUND_PENDING',
    REFUND_CANCELLED: 'REFUND_PENDING',
    REQUIRE_REVIEW: 'REVIEW_REQUIRED',
  },
  REFUNDED: { COMPLETE: 'COMPLETED' },
};

const exchangeTransitions: Readonly<
  Partial<Record<AfterSaleStatus, Partial<Record<AfterSaleEvent, AfterSaleStatus>>>>
> = {
  PENDING_REVIEW: { APPROVE: 'APPROVED', CANCEL: 'CANCELLED', REJECT: 'REJECTED' },
  APPROVED: {
    START_RETURN: 'RETURN_PENDING',
    RETURN_EXPIRED: 'REJECTED',
    REQUIRE_REVIEW: 'REVIEW_REQUIRED',
  },
  RETURN_PENDING: { RETURN_SHIPPED: 'RETURN_IN_TRANSIT', REQUIRE_REVIEW: 'REVIEW_REQUIRED' },
  RETURN_IN_TRANSIT: {
    RETURN_RECEIVED: 'INSPECTION_PENDING',
    REQUIRE_REVIEW: 'REVIEW_REQUIRED',
  },
  INSPECTION_PENDING: {
    ACCEPT_INSPECTION: 'EXCHANGE_PENDING',
    REJECT_INSPECTION: 'REJECTED',
    REQUIRE_REVIEW: 'REVIEW_REQUIRED',
  },
  EXCHANGE_PENDING: {
    CONVERT_EXCHANGE_TO_REFUND: 'REFUND_PENDING',
    EXCHANGE_SHIPPED: 'EXCHANGE_IN_TRANSIT',
    REQUIRE_REVIEW: 'REVIEW_REQUIRED',
  },
  EXCHANGE_IN_TRANSIT: {
    EXCHANGE_DELIVERED: 'COMPLETED',
    REQUIRE_REVIEW: 'REVIEW_REQUIRED',
  },
  REFUND_PENDING: {
    REFUND_REQUESTED: 'REFUND_PROCESSING',
    REQUIRE_REVIEW: 'REVIEW_REQUIRED',
  },
  REFUND_PROCESSING: {
    REFUND_SUCCEEDED: 'REFUNDED',
    REFUND_FAILED: 'REFUND_PENDING',
    REFUND_CANCELLED: 'REFUND_PENDING',
    REQUIRE_REVIEW: 'REVIEW_REQUIRED',
  },
  REFUNDED: { COMPLETE: 'COMPLETED' },
};

function transitionsFor(type: AfterSaleType) {
  switch (type) {
    case 'REFUND_ONLY':
    case 'MERCHANT_REFUND':
      return refundOnlyTransitions;
    case 'RETURN_REFUND':
      return returnRefundTransitions;
    case 'EXCHANGE':
      return exchangeTransitions;
  }
}

export function transitionAfterSale(
  type: AfterSaleType,
  current: AfterSaleStatus,
  event: AfterSaleEvent,
): AfterSaleStatus {
  if (
    event === 'RETURN_RECEIVED' ||
    event === 'ACCEPT_INSPECTION' ||
    event === 'REJECT_INSPECTION'
  ) {
    throw new AfterSaleInvariantError('AFTER_SALE_INSPECTION_INVALID');
  }
  if (event === 'START_RETURN' || event === 'RETURN_EXPIRED') {
    throw new AfterSaleInvariantError('AFTER_SALE_RETURN_WINDOW_INVALID');
  }
  if (event === 'CONVERT_EXCHANGE_TO_REFUND') {
    throw new AfterSaleInvariantError('AFTER_SALE_EXCHANGE_NOT_ALLOWED');
  }
  return transitionAfterSaleUnchecked(type, current, event);
}

function transitionAfterSaleUnchecked(
  type: AfterSaleType,
  current: AfterSaleStatus,
  event: AfterSaleEvent,
): AfterSaleStatus {
  const target = transitionsFor(type)[current]?.[event];
  if (!target) throw new AfterSaleInvariantError('AFTER_SALE_STATE_CONFLICT');
  return target;
}

export type AfterSaleCommandTransition = {
  events: readonly AfterSaleEvent[];
  status: AfterSaleStatus;
};

export type AfterSaleCreationTransition = {
  event: 'SUBMIT';
  fromStatus: null;
  status: 'PENDING_REVIEW' | 'REVIEW_REQUIRED';
};

export function submitAfterSale(
  actorType: Extract<AfterSaleActorType, 'MEMBER' | 'ADMIN'>,
  legacyPolicyReview = false,
): AfterSaleCreationTransition {
  assertAfterSaleEventActorAllowed(actorType, 'SUBMIT');
  return {
    event: 'SUBMIT',
    fromStatus: null,
    status: legacyPolicyReview ? 'REVIEW_REQUIRED' : 'PENDING_REVIEW',
  };
}

export function assertAfterSaleEventActorAllowed(
  actorType: AfterSaleActorType,
  event: AfterSaleEvent,
): void {
  if (actorType === 'ADMIN') return;
  const allowed =
    actorType === 'MEMBER' ? afterSaleMemberEvents.has(event) : afterSaleSystemEvents.has(event);
  if (!allowed) throw new AfterSaleInvariantError('AFTER_SALE_ACTOR_NOT_ALLOWED');
}

export function assertAfterSaleSystemEventAllowed(
  context: AfterSaleSystemContext,
  event: AfterSaleEvent,
): void {
  if (
    context.actor.type !== 'system' ||
    context.systemScope !== AFTER_SALE_SYSTEM_SCOPE ||
    context.actor.id.trim().length === 0 ||
    context.correlationId.trim().length === 0 ||
    context.storeId.trim().length === 0
  ) {
    throw new AfterSaleInvariantError('AFTER_SALE_ACTOR_NOT_ALLOWED');
  }
  assertAfterSaleEventActorAllowed('SYSTEM', event);
}

export function assertAfterSaleReturnSubmissionAllowed(
  type: AfterSaleType,
  current: AfterSaleStatus,
  timing: { nowEpochMs: number; returnDeadlineEpochMs: number },
): void {
  assertAfterSaleReturnWindowOpen(timing);
  if (transitionsFor(type)[current]?.START_RETURN !== 'RETURN_PENDING') {
    throw new AfterSaleInvariantError('AFTER_SALE_STATE_CONFLICT');
  }
}

export function transitionAfterSaleReturnSubmitted(
  type: AfterSaleType,
  current: AfterSaleStatus,
  timing: { nowEpochMs: number; returnDeadlineEpochMs: number },
): AfterSaleCommandTransition {
  assertAfterSaleReturnSubmissionAllowed(type, current, timing);
  assertAfterSaleEventActorAllowed('MEMBER', 'START_RETURN');
  return {
    events: ['START_RETURN'],
    status: transitionAfterSaleUnchecked(type, current, 'START_RETURN'),
  };
}

export function transitionAfterSaleTrustedReturnFact(
  type: AfterSaleType,
  current: AfterSaleStatus,
  fact: 'IN_TRANSIT' | 'DELIVERED',
): AfterSaleCommandTransition {
  if (fact === 'IN_TRANSIT') {
    return {
      events: ['RETURN_SHIPPED'],
      status: transitionAfterSaleUnchecked(type, current, 'RETURN_SHIPPED'),
    };
  }
  if (current === 'RETURN_PENDING') {
    const inTransit = transitionAfterSaleUnchecked(type, current, 'RETURN_SHIPPED');
    return {
      events: ['RETURN_SHIPPED', 'RETURN_RECEIVED'],
      status: transitionAfterSaleUnchecked(type, inTransit, 'RETURN_RECEIVED'),
    };
  }
  return {
    events: ['RETURN_RECEIVED'],
    status: transitionAfterSaleUnchecked(type, current, 'RETURN_RECEIVED'),
  };
}

export function transitionAfterSaleOnlineRefundRequested(
  type: AfterSaleType,
  current: AfterSaleStatus,
): AfterSaleCommandTransition {
  if (current === 'APPROVED') {
    const refundPending = transitionAfterSaleUnchecked(type, current, 'QUEUE_REFUND');
    return {
      events: ['QUEUE_REFUND', 'REFUND_REQUESTED'],
      status: transitionAfterSaleUnchecked(type, refundPending, 'REFUND_REQUESTED'),
    };
  }
  return {
    events: ['REFUND_REQUESTED'],
    status: transitionAfterSaleUnchecked(type, current, 'REFUND_REQUESTED'),
  };
}

export function transitionAfterSaleCodRefundQueued(
  type: AfterSaleType,
  current: AfterSaleStatus,
): AfterSaleCommandTransition {
  if (current === 'REFUND_PENDING') {
    if (transitionsFor(type)[current]?.REFUND_REQUESTED !== 'REFUND_PROCESSING') {
      throw new AfterSaleInvariantError('AFTER_SALE_STATE_CONFLICT');
    }
    return { events: [], status: current };
  }
  return {
    events: ['QUEUE_REFUND'],
    status: transitionAfterSaleUnchecked(type, current, 'QUEUE_REFUND'),
  };
}

export function transitionAfterSaleCodRefundConfirmed(
  type: AfterSaleType,
  current: AfterSaleStatus,
): AfterSaleCommandTransition {
  const processing = transitionAfterSaleUnchecked(type, current, 'REFUND_REQUESTED');
  return {
    events: ['REFUND_REQUESTED', 'REFUND_SUCCEEDED'],
    status: transitionAfterSaleUnchecked(type, processing, 'REFUND_SUCCEEDED'),
  };
}

export function transitionAfterSaleRefundReleased(
  type: AfterSaleType,
  current: AfterSaleStatus,
  outcome: 'FAILED' | 'CANCELLED',
): AfterSaleCommandTransition {
  const event = outcome === 'FAILED' ? 'REFUND_FAILED' : 'REFUND_CANCELLED';
  return { events: [event], status: transitionAfterSaleUnchecked(type, current, event) };
}

export function transitionExchangeToRefund(
  type: AfterSaleType,
  current: AfterSaleStatus,
  hasReplacementReservationOrShipmentSideEffects: boolean,
): AfterSaleCommandTransition {
  if (hasReplacementReservationOrShipmentSideEffects) {
    throw new AfterSaleInvariantError('AFTER_SALE_EXCHANGE_NOT_ALLOWED');
  }
  return {
    events: ['CONVERT_EXCHANGE_TO_REFUND'],
    status: transitionAfterSaleUnchecked(type, current, 'CONVERT_EXCHANGE_TO_REFUND'),
  };
}

export function assertAfterSaleReturnWindowOpen(input: {
  nowEpochMs: number;
  returnDeadlineEpochMs: number;
}): void {
  if (
    !Number.isSafeInteger(input.nowEpochMs) ||
    !Number.isSafeInteger(input.returnDeadlineEpochMs) ||
    input.nowEpochMs < 0 ||
    input.returnDeadlineEpochMs < 0 ||
    input.nowEpochMs >= input.returnDeadlineEpochMs
  ) {
    throw new AfterSaleInvariantError('AFTER_SALE_RETURN_WINDOW_CLOSED');
  }
}

const MILLISECONDS_PER_NATURAL_DAY = 24 * 60 * 60 * 1_000;
const HO_CHI_MINH_UTC_OFFSET_MS = 7 * 60 * 60 * 1_000;

function calculateHoChiMinhNaturalDayDeadlineEpochMs(
  startEpochMs: number,
  windowDays: number,
  maximumWindowDays: number,
  invalidCode: Extract<
    AfterSaleInvariantErrorCode,
    'AFTER_SALE_REQUEST_WINDOW_INVALID' | 'AFTER_SALE_RETURN_WINDOW_INVALID'
  >,
): number {
  if (
    !Number.isSafeInteger(startEpochMs) ||
    startEpochMs < 0 ||
    !Number.isSafeInteger(windowDays) ||
    windowDays < 0 ||
    windowDays > maximumWindowDays
  ) {
    throw new AfterSaleInvariantError(invalidCode);
  }
  const localEpochMs = startEpochMs + HO_CHI_MINH_UTC_OFFSET_MS;
  if (!Number.isSafeInteger(localEpochMs)) {
    throw new AfterSaleInvariantError(invalidCode);
  }
  const localDayStartEpochMs =
    Math.floor(localEpochMs / MILLISECONDS_PER_NATURAL_DAY) * MILLISECONDS_PER_NATURAL_DAY;
  const deadline =
    localDayStartEpochMs +
    (windowDays + 1) * MILLISECONDS_PER_NATURAL_DAY -
    HO_CHI_MINH_UTC_OFFSET_MS;
  if (!Number.isSafeInteger(deadline)) {
    throw new AfterSaleInvariantError(invalidCode);
  }
  return deadline;
}

export function calculateAfterSaleRequestDeadlineEpochMs(input: {
  deliveredAtEpochMs: number;
  requestWindowDays: number;
}): number {
  return calculateHoChiMinhNaturalDayDeadlineEpochMs(
    input.deliveredAtEpochMs,
    input.requestWindowDays,
    365,
    'AFTER_SALE_REQUEST_WINDOW_INVALID',
  );
}

export function assertAfterSaleRequestWindowOpen(input: {
  nowEpochMs: number;
  requestDeadlineEpochMs: number;
}): void {
  if (
    !Number.isSafeInteger(input.nowEpochMs) ||
    !Number.isSafeInteger(input.requestDeadlineEpochMs) ||
    input.nowEpochMs < 0 ||
    input.requestDeadlineEpochMs < 0 ||
    input.nowEpochMs >= input.requestDeadlineEpochMs
  ) {
    throw new AfterSaleInvariantError('AFTER_SALE_REQUEST_WINDOW_CLOSED');
  }
}

export function calculateAfterSaleReturnDeadlineEpochMs(input: {
  approvedAtEpochMs: number;
  returnWindowDays: number;
}): number {
  if (!Number.isSafeInteger(input.returnWindowDays) || input.returnWindowDays <= 0) {
    throw new AfterSaleInvariantError('AFTER_SALE_RETURN_WINDOW_INVALID');
  }
  return calculateHoChiMinhNaturalDayDeadlineEpochMs(
    input.approvedAtEpochMs,
    input.returnWindowDays,
    60,
    'AFTER_SALE_RETURN_WINDOW_INVALID',
  );
}

export function transitionAfterSaleReturnExpired(
  type: AfterSaleType,
  current: AfterSaleStatus,
  input: {
    hasIrreversibleOrUncertainSideEffects: boolean;
    nowEpochMs: number;
    returnDeadlineEpochMs: number;
  },
): AfterSaleCommandTransition {
  if (
    !Number.isSafeInteger(input.nowEpochMs) ||
    !Number.isSafeInteger(input.returnDeadlineEpochMs) ||
    input.nowEpochMs < 0 ||
    input.returnDeadlineEpochMs < 0 ||
    input.nowEpochMs < input.returnDeadlineEpochMs ||
    input.hasIrreversibleOrUncertainSideEffects
  ) {
    throw new AfterSaleInvariantError('AFTER_SALE_RETURN_WINDOW_INVALID');
  }
  return {
    events: ['RETURN_EXPIRED'],
    status: transitionAfterSaleUnchecked(type, current, 'RETURN_EXPIRED'),
  };
}

const reviewResumeStatuses: Readonly<Record<AfterSaleType, ReadonlySet<AfterSaleStatus>>> = {
  REFUND_ONLY: new Set(['APPROVED', 'REFUND_PENDING', 'REFUND_PROCESSING']),
  MERCHANT_REFUND: new Set(['APPROVED', 'REFUND_PENDING', 'REFUND_PROCESSING']),
  RETURN_REFUND: new Set([
    'APPROVED',
    'RETURN_PENDING',
    'RETURN_IN_TRANSIT',
    'INSPECTION_PENDING',
    'REFUND_PENDING',
    'REFUND_PROCESSING',
  ]),
  EXCHANGE: new Set([
    'APPROVED',
    'RETURN_PENDING',
    'RETURN_IN_TRANSIT',
    'INSPECTION_PENDING',
    'EXCHANGE_PENDING',
    'EXCHANGE_IN_TRANSIT',
    'REFUND_PENDING',
    'REFUND_PROCESSING',
  ]),
};
const reviewRejectableResumeStatuses = new Set<AfterSaleStatus>(['APPROVED', 'RETURN_PENDING']);

export function resolveAfterSaleReview(input: {
  current: AfterSaleStatus;
  hasIrreversibleOrUncertainSideEffects: boolean;
  legacyPolicyReview: boolean;
  recordedResumeStatus: AfterSaleStatus;
  target: AfterSaleStatus;
  type: AfterSaleType;
}): { event: 'RESUME_REVIEW' | 'REJECT_REVIEW'; status: AfterSaleStatus } {
  const rejects = input.target === 'REJECTED';
  if (
    input.current !== 'REVIEW_REQUIRED' ||
    input.legacyPolicyReview ||
    !reviewResumeStatuses[input.type].has(input.recordedResumeStatus) ||
    (!rejects && input.target !== input.recordedResumeStatus) ||
    (rejects &&
      (!reviewRejectableResumeStatuses.has(input.recordedResumeStatus) ||
        input.hasIrreversibleOrUncertainSideEffects))
  ) {
    throw new AfterSaleInvariantError('AFTER_SALE_STATE_CONFLICT');
  }
  return {
    event: rejects ? 'REJECT_REVIEW' : 'RESUME_REVIEW',
    status: input.target,
  };
}

export function resolveLegacyAfterSaleReview(input: {
  current: AfterSaleStatus;
  hasIrreversibleOrUncertainSideEffects: boolean;
  legacyDecisionRecorded: boolean;
  legacyPolicyReview: boolean;
  returnShippingPayer: 'BUYER' | 'MERCHANT' | 'CONDITIONAL' | null;
  returnWindowDays: number | null;
  target: 'APPROVED' | 'REJECTED';
  type: AfterSaleType;
}): { event: 'LEGACY_APPROVE' | 'LEGACY_REJECT'; status: 'APPROVED' | 'REJECTED' } {
  const requiresReturnTerms = input.type === 'RETURN_REFUND' || input.type === 'EXCHANGE';
  const hasValidReturnTerms =
    input.returnShippingPayer !== null &&
    input.returnWindowDays !== null &&
    Number.isSafeInteger(input.returnWindowDays) &&
    input.returnWindowDays >= 1 &&
    input.returnWindowDays <= 60;
  const hasNoReturnTerms = input.returnShippingPayer === null && input.returnWindowDays === null;
  if (
    input.current !== 'REVIEW_REQUIRED' ||
    !input.legacyPolicyReview ||
    input.legacyDecisionRecorded ||
    input.hasIrreversibleOrUncertainSideEffects ||
    (input.target === 'APPROVED' &&
      ((requiresReturnTerms && !hasValidReturnTerms) ||
        (!requiresReturnTerms && !hasNoReturnTerms))) ||
    (input.target === 'REJECTED' && !hasNoReturnTerms)
  ) {
    throw new AfterSaleInvariantError('AFTER_SALE_STATE_CONFLICT');
  }
  return {
    event: input.target === 'APPROVED' ? 'LEGACY_APPROVE' : 'LEGACY_REJECT',
    status: input.target,
  };
}

const alwaysOccupyingStatuses = new Set<AfterSaleStatus>([
  'PENDING_REVIEW',
  'APPROVED',
  'RETURN_PENDING',
  'RETURN_IN_TRANSIT',
  'INSPECTION_PENDING',
  'REFUND_PENDING',
  'REFUND_PROCESSING',
  'REFUNDED',
  'EXCHANGE_PENDING',
  'EXCHANGE_IN_TRANSIT',
  'REVIEW_REQUIRED',
  'COMPLETED',
]);

export function doesAfterSaleQuantityOccupyCapacity(input: {
  hasIrreversibleOrUncertainSideEffects: boolean;
  status: AfterSaleStatus;
}): boolean {
  if (alwaysOccupyingStatuses.has(input.status)) return true;
  return input.hasIrreversibleOrUncertainSideEffects;
}

function assertSafeCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AfterSaleInvariantError('AFTER_SALE_QUANTITY_INVALID');
  }
}

function assertSafeVnd(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AfterSaleInvariantError('AFTER_SALE_REFUND_AMOUNT_INVALID');
  }
}

export function assertAfterSaleApprovalQuantities(input: {
  approvedItems: readonly { approvedQuantity: number; orderItemId: string }[];
  requestedItems: readonly { orderItemId: string; requestedQuantity: number }[];
}): void {
  if (
    input.requestedItems.length === 0 ||
    input.approvedItems.length !== input.requestedItems.length
  ) {
    throw new AfterSaleInvariantError('AFTER_SALE_QUANTITY_INVALID');
  }

  const requested = new Map<string, number>();
  for (const item of input.requestedItems) {
    assertSafeCount(item.requestedQuantity);
    if (
      item.orderItemId.trim().length === 0 ||
      item.requestedQuantity === 0 ||
      requested.has(item.orderItemId)
    ) {
      throw new AfterSaleInvariantError('AFTER_SALE_QUANTITY_INVALID');
    }
    requested.set(item.orderItemId, item.requestedQuantity);
  }

  const approvedIds = new Set<string>();
  let approvedTotal = 0;
  for (const item of input.approvedItems) {
    assertSafeCount(item.approvedQuantity);
    const requestedQuantity = requested.get(item.orderItemId);
    if (requestedQuantity === undefined || approvedIds.has(item.orderItemId)) {
      throw new AfterSaleInvariantError('AFTER_SALE_QUANTITY_INVALID');
    }
    if (item.approvedQuantity > requestedQuantity) {
      throw new AfterSaleInvariantError('AFTER_SALE_QUANTITY_EXCEEDS_AVAILABLE');
    }
    approvedIds.add(item.orderItemId);
    approvedTotal += item.approvedQuantity;
    if (!Number.isSafeInteger(approvedTotal)) {
      throw new AfterSaleInvariantError('AFTER_SALE_QUANTITY_INVALID');
    }
  }
  if (approvedIds.size !== requested.size || approvedTotal === 0) {
    throw new AfterSaleInvariantError('AFTER_SALE_QUANTITY_INVALID');
  }
}

export function assertAfterSaleQuantityAvailable(input: {
  occupiedQuantity: number;
  orderedQuantity: number;
  requestedQuantity: number;
}): void {
  assertSafeCount(input.occupiedQuantity);
  assertSafeCount(input.orderedQuantity);
  assertSafeCount(input.requestedQuantity);
  if (
    input.requestedQuantity === 0 ||
    input.occupiedQuantity > input.orderedQuantity ||
    input.requestedQuantity > input.orderedQuantity - input.occupiedQuantity
  ) {
    throw new AfterSaleInvariantError('AFTER_SALE_QUANTITY_EXCEEDS_AVAILABLE');
  }
}

export function calculateRemainingAfterSaleRefundVnd(input: {
  approvedAmountVnd: number;
  inFlightAmountVnd: number;
  succeededAmountVnd: number;
}): number {
  assertSafeVnd(input.approvedAmountVnd);
  assertSafeVnd(input.inFlightAmountVnd);
  assertSafeVnd(input.succeededAmountVnd);
  const unavailable = input.inFlightAmountVnd + input.succeededAmountVnd;
  if (!Number.isSafeInteger(unavailable) || unavailable > input.approvedAmountVnd) {
    throw new AfterSaleInvariantError('AFTER_SALE_REFUND_AMOUNT_INVALID');
  }
  return input.approvedAmountVnd - unavailable;
}

export function assertAfterSaleRefundAmountAllowed(input: {
  approvedAmountVnd: number;
  inFlightAmountVnd: number;
  requestedAmountVnd: number;
  succeededAmountVnd: number;
}): void {
  assertSafeVnd(input.requestedAmountVnd);
  if (
    input.requestedAmountVnd === 0 ||
    input.requestedAmountVnd > calculateRemainingAfterSaleRefundVnd(input)
  ) {
    throw new AfterSaleInvariantError('AFTER_SALE_REFUND_EXCEEDS_APPROVED');
  }
}

export function calculateOrderItemRefundAllocationVnd(input: {
  occupiedAllocatedVnd: number;
  occupiedApprovedQuantity: number;
  orderItemPayableVnd: number;
  orderedQuantity: number;
  requestedApprovedQuantity: number;
}): number {
  assertSafeVnd(input.occupiedAllocatedVnd);
  assertSafeVnd(input.orderItemPayableVnd);
  assertSafeCount(input.occupiedApprovedQuantity);
  assertSafeCount(input.orderedQuantity);
  assertSafeCount(input.requestedApprovedQuantity);
  if (
    input.orderedQuantity === 0 ||
    input.requestedApprovedQuantity === 0 ||
    input.occupiedApprovedQuantity > input.orderedQuantity ||
    input.occupiedAllocatedVnd > input.orderItemPayableVnd ||
    input.requestedApprovedQuantity > input.orderedQuantity - input.occupiedApprovedQuantity
  ) {
    throw new AfterSaleInvariantError('AFTER_SALE_REFUND_AMOUNT_INVALID');
  }
  const availableQuantity = input.orderedQuantity - input.occupiedApprovedQuantity;
  const availableVnd = input.orderItemPayableVnd - input.occupiedAllocatedVnd;
  const allocation =
    input.requestedApprovedQuantity === availableQuantity
      ? BigInt(availableVnd)
      : (BigInt(availableVnd) * BigInt(input.requestedApprovedQuantity)) /
        BigInt(availableQuantity);
  if (allocation > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AfterSaleInvariantError('AFTER_SALE_REFUND_AMOUNT_INVALID');
  }
  return Number(allocation);
}

export function assertInventoryRestoreAllowed(input: {
  acceptedReturnQuantity: number;
  consumedQuantity: number;
  requestedRestoreQuantity: number;
  restockableQuantity: number;
  totalRestoredQuantity: number;
  type: AfterSaleType;
}): void {
  for (const value of [
    input.acceptedReturnQuantity,
    input.consumedQuantity,
    input.requestedRestoreQuantity,
    input.restockableQuantity,
    input.totalRestoredQuantity,
  ]) {
    assertSafeCount(value);
  }
  if (input.type === 'REFUND_ONLY' || input.type === 'MERCHANT_REFUND') {
    throw new AfterSaleInvariantError('AFTER_SALE_INVENTORY_RESTORE_NOT_ALLOWED');
  }
  if (
    input.requestedRestoreQuantity === 0 ||
    input.acceptedReturnQuantity > input.consumedQuantity ||
    input.restockableQuantity > input.acceptedReturnQuantity ||
    input.totalRestoredQuantity > input.restockableQuantity ||
    input.requestedRestoreQuantity > input.restockableQuantity - input.totalRestoredQuantity
  ) {
    throw new AfterSaleInvariantError('AFTER_SALE_INVENTORY_RESTORE_EXCEEDS_AVAILABLE');
  }
}

export type AfterSaleInspectionDisposition =
  'RESTOCK_SELLABLE' | 'QUARANTINE' | 'SCRAP' | 'RETURN_TO_MEMBER';

export type CompleteAfterSaleInspectionInput = {
  approvedItems: readonly { approvedQuantity: number; orderItemId: string }[];
  inspectedItems: readonly {
    dispositions: readonly { disposition: AfterSaleInspectionDisposition; quantity: number }[];
    orderItemId: string;
    receivedQuantity: number;
  }[];
};

export type CompleteAfterSaleInspectionSummary = {
  acceptedQuantity: number;
  rejectedQuantity: number;
  restockableQuantity: number;
};

export function summarizeCompleteAfterSaleInspection(
  input: CompleteAfterSaleInspectionInput,
): CompleteAfterSaleInspectionSummary {
  const approved = new Map<string, number>();
  for (const item of input.approvedItems) {
    assertSafeCount(item.approvedQuantity);
    if (
      item.approvedQuantity === 0 ||
      item.orderItemId.length === 0 ||
      approved.has(item.orderItemId)
    ) {
      throw new AfterSaleInvariantError('AFTER_SALE_INSPECTION_INVALID');
    }
    approved.set(item.orderItemId, item.approvedQuantity);
  }
  if (approved.size === 0 || input.inspectedItems.length !== approved.size) {
    throw new AfterSaleInvariantError('AFTER_SALE_INSPECTION_INVALID');
  }

  let acceptedQuantity = 0;
  let rejectedQuantity = 0;
  let restockableQuantity = 0;
  const inspectedIds = new Set<string>();
  for (const item of input.inspectedItems) {
    assertSafeCount(item.receivedQuantity);
    const approvedQuantity = approved.get(item.orderItemId);
    if (
      approvedQuantity === undefined ||
      item.receivedQuantity !== approvedQuantity ||
      inspectedIds.has(item.orderItemId) ||
      item.dispositions.length === 0
    ) {
      throw new AfterSaleInvariantError('AFTER_SALE_INSPECTION_INVALID');
    }
    inspectedIds.add(item.orderItemId);
    const dispositionTypes = new Set<AfterSaleInspectionDisposition>();
    let allocatedQuantity = 0;
    for (const allocation of item.dispositions) {
      assertSafeCount(allocation.quantity);
      if (allocation.quantity === 0 || dispositionTypes.has(allocation.disposition)) {
        throw new AfterSaleInvariantError('AFTER_SALE_INSPECTION_INVALID');
      }
      dispositionTypes.add(allocation.disposition);
      allocatedQuantity += allocation.quantity;
      if (!Number.isSafeInteger(allocatedQuantity)) {
        throw new AfterSaleInvariantError('AFTER_SALE_INSPECTION_INVALID');
      }
      if (allocation.disposition === 'RETURN_TO_MEMBER') rejectedQuantity += allocation.quantity;
      else acceptedQuantity += allocation.quantity;
      if (allocation.disposition === 'RESTOCK_SELLABLE') {
        restockableQuantity += allocation.quantity;
      }
    }
    if (allocatedQuantity !== item.receivedQuantity) {
      throw new AfterSaleInvariantError('AFTER_SALE_INSPECTION_INVALID');
    }
  }
  if (
    !Number.isSafeInteger(acceptedQuantity) ||
    !Number.isSafeInteger(rejectedQuantity) ||
    !Number.isSafeInteger(restockableQuantity)
  ) {
    throw new AfterSaleInvariantError('AFTER_SALE_INSPECTION_INVALID');
  }
  return { acceptedQuantity, rejectedQuantity, restockableQuantity };
}

export function transitionAfterSaleAfterInspection(
  type: AfterSaleType,
  current: AfterSaleStatus,
  input: CompleteAfterSaleInspectionInput,
): {
  events: readonly ['RETURN_RECEIVED', 'ACCEPT_INSPECTION' | 'REJECT_INSPECTION'];
  status: AfterSaleStatus;
} {
  const summary = summarizeCompleteAfterSaleInspection(input);
  const event = summary.acceptedQuantity === 0 ? 'REJECT_INSPECTION' : 'ACCEPT_INSPECTION';
  const inspectionStatus = transitionAfterSaleUnchecked(type, current, 'RETURN_RECEIVED');
  return {
    events: ['RETURN_RECEIVED', event],
    status: transitionAfterSaleUnchecked(type, inspectionStatus, event),
  };
}

export type AfterSalePolicyIdentity = {
  payloadHash: string;
  policyId: string;
  policyVersionId: string;
  policyVersionNumber: number;
};

export type AfterSaleOrderItemShipmentFact = {
  deliveredAtEpochMs: number | null;
  purpose: ShipmentPurpose;
  quantity: number;
  shipmentId: string;
  status: ShipmentStatus;
};

export type AuthoritativeOrderItemDeliveryResolution =
  | { deliveredAtEpochMs: number; proven: true }
  | {
      proven: false;
      reason:
        | 'DELIVERY_TIMESTAMP_UNPROVEN'
        | 'DUPLICATE_OUTBOUND_SHIPMENT'
        | 'NO_OUTBOUND_SHIPMENT_ITEM'
        | 'OUTBOUND_NOT_DELIVERED'
        | 'OUTBOUND_QUANTITY_UNPROVEN';
    };

export function resolveAuthoritativeOrderItemDelivery(input: {
  orderedQuantity: number;
  shipmentItems: readonly AfterSaleOrderItemShipmentFact[];
}): AuthoritativeOrderItemDeliveryResolution {
  if (!Number.isSafeInteger(input.orderedQuantity) || input.orderedQuantity <= 0) {
    return { proven: false, reason: 'OUTBOUND_QUANTITY_UNPROVEN' };
  }
  const outbound = input.shipmentItems.filter((item) => item.purpose === 'ORDER_OUTBOUND');
  if (outbound.length === 0) {
    return { proven: false, reason: 'NO_OUTBOUND_SHIPMENT_ITEM' };
  }

  const shipmentIds = new Set<string>();
  let deliveredAtEpochMs = 0;
  let shippedQuantity = 0;
  for (const item of outbound) {
    const shipmentId = item.shipmentId.trim();
    if (shipmentId.length === 0 || shipmentIds.has(shipmentId)) {
      return { proven: false, reason: 'DUPLICATE_OUTBOUND_SHIPMENT' };
    }
    shipmentIds.add(shipmentId);
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
      return { proven: false, reason: 'OUTBOUND_QUANTITY_UNPROVEN' };
    }
    shippedQuantity += item.quantity;
    if (!Number.isSafeInteger(shippedQuantity)) {
      return { proven: false, reason: 'OUTBOUND_QUANTITY_UNPROVEN' };
    }
    if (item.status !== 'DELIVERED') {
      return { proven: false, reason: 'OUTBOUND_NOT_DELIVERED' };
    }
    if (
      item.deliveredAtEpochMs === null ||
      !Number.isSafeInteger(item.deliveredAtEpochMs) ||
      item.deliveredAtEpochMs < 0
    ) {
      return { proven: false, reason: 'DELIVERY_TIMESTAMP_UNPROVEN' };
    }
    deliveredAtEpochMs = Math.max(deliveredAtEpochMs, item.deliveredAtEpochMs);
  }
  if (shippedQuantity !== input.orderedQuantity) {
    return { proven: false, reason: 'OUTBOUND_QUANTITY_UNPROVEN' };
  }
  return { deliveredAtEpochMs, proven: true };
}

export type AfterSaleCasePolicyResolution =
  | { legacyPolicyReview: true; policy: null }
  | { legacyPolicyReview: false; policy: AfterSalePolicyIdentity };

function isValidAfterSalePolicyIdentity(
  policy: AfterSalePolicyIdentity,
): policy is AfterSalePolicyIdentity {
  return (
    policy.policyId.trim().length > 0 &&
    policy.policyVersionId.trim().length > 0 &&
    Number.isSafeInteger(policy.policyVersionNumber) &&
    policy.policyVersionNumber > 0 &&
    /^[a-f0-9]{64}$/.test(policy.payloadHash)
  );
}

export function resolveAfterSaleCasePolicy(
  itemPolicies: readonly (AfterSalePolicyIdentity | null)[],
): AfterSaleCasePolicyResolution {
  if (itemPolicies.length === 0) {
    throw new AfterSaleInvariantError('AFTER_SALE_POLICY_MISMATCH');
  }
  if (itemPolicies.every((policy) => policy === null)) {
    return { legacyPolicyReview: true, policy: null };
  }
  const [first, ...remaining] = itemPolicies;
  if (first === undefined || first === null || !isValidAfterSalePolicyIdentity(first)) {
    throw new AfterSaleInvariantError('AFTER_SALE_POLICY_MISMATCH');
  }
  for (const policy of remaining) {
    if (
      policy === null ||
      !isValidAfterSalePolicyIdentity(policy) ||
      policy.policyId !== first.policyId ||
      policy.policyVersionId !== first.policyVersionId ||
      policy.policyVersionNumber !== first.policyVersionNumber ||
      policy.payloadHash !== first.payloadHash
    ) {
      throw new AfterSaleInvariantError('AFTER_SALE_POLICY_MISMATCH');
    }
  }
  return { legacyPolicyReview: false, policy: first };
}

export function assertAfterSaleReasonAllowed(input: {
  allowedReasonCodes: readonly string[];
  reasonCode: string;
}): void {
  const allowedReasons = new Set<string>();
  for (const reasonCode of input.allowedReasonCodes) {
    const normalized = reasonCode.trim();
    if (normalized.length === 0 || normalized !== reasonCode || allowedReasons.has(normalized)) {
      throw new AfterSaleInvariantError('AFTER_SALE_POLICY_MISMATCH');
    }
    allowedReasons.add(normalized);
  }
  if (allowedReasons.size === 0) {
    throw new AfterSaleInvariantError('AFTER_SALE_POLICY_MISMATCH');
  }
  if (!allowedReasons.has(input.reasonCode)) {
    throw new AfterSaleInvariantError('AFTER_SALE_REASON_NOT_ALLOWED');
  }
}

export type AfterSaleOrderAdmissionPaymentStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'PARTIALLY_REFUNDED'
  | 'FULLY_REFUNDED';

export function assertAfterSaleOrderPaymentAdmissionAllowed(input: {
  confirmedReceiptFact: boolean;
  orderStatus: string;
  paymentMethod: 'COD' | 'ONLINE';
  paymentStatus: AfterSaleOrderAdmissionPaymentStatus;
}): void {
  if (input.orderStatus !== 'DELIVERED' && input.orderStatus !== 'COMPLETED') {
    throw new AfterSaleInvariantError('AFTER_SALE_ORDER_NOT_ELIGIBLE');
  }
  if (!input.confirmedReceiptFact) {
    throw new AfterSaleInvariantError('AFTER_SALE_PAYMENT_NOT_PROVEN');
  }
  if (
    input.paymentMethod === 'ONLINE' &&
    input.paymentStatus !== 'SUCCEEDED' &&
    input.paymentStatus !== 'PARTIALLY_REFUNDED'
  ) {
    throw new AfterSaleInvariantError('AFTER_SALE_PAYMENT_NOT_PROVEN');
  }
}

export type AfterSaleEvidenceCapabilities = {
  claimAvailable: boolean;
  deletionCompensationAvailable: boolean;
  malwareScanningAvailable: boolean;
  protectedReadAvailable: boolean;
  uploadValidationAvailable: boolean;
};

export function assertAfterSaleEvidenceCreationAllowed(input: {
  capabilities: AfterSaleEvidenceCapabilities;
  evidenceRequired: boolean;
  readyEvidenceCount: number;
}): void {
  if (!Number.isSafeInteger(input.readyEvidenceCount) || input.readyEvidenceCount < 0) {
    throw new AfterSaleInvariantError('AFTER_SALE_EVIDENCE_REQUIRED');
  }
  const evidenceProvided = input.readyEvidenceCount > 0;
  if (
    (input.evidenceRequired || evidenceProvided) &&
    (input.capabilities.claimAvailable !== true ||
      input.capabilities.deletionCompensationAvailable !== true ||
      input.capabilities.malwareScanningAvailable !== true ||
      input.capabilities.protectedReadAvailable !== true ||
      input.capabilities.uploadValidationAvailable !== true)
  ) {
    throw new AfterSaleInvariantError('AFTER_SALE_EVIDENCE_CAPABILITY_UNAVAILABLE');
  }
  if (input.evidenceRequired && !evidenceProvided) {
    throw new AfterSaleInvariantError('AFTER_SALE_EVIDENCE_REQUIRED');
  }
}

export const AFTER_SALE_EVIDENCE_STATUSES = [
  'PENDING',
  'READY_UNCLAIMED',
  'READY',
  'FAILED',
  'QUARANTINED',
  'DELETION_PENDING',
  'DELETED',
  'DELETE_FAILED',
] as const;

export type AfterSaleEvidenceStatus = (typeof AFTER_SALE_EVIDENCE_STATUSES)[number];
export type AfterSaleEvidenceEvent =
  | 'SCAN_PASSED'
  | 'SCAN_FAILED'
  | 'QUARANTINE'
  | 'CLAIM'
  | 'EXPIRE'
  | 'DELETE_SUCCEEDED'
  | 'DELETE_FAILED'
  | 'RETRY_DELETE';

const evidenceTransitions: Readonly<
  Partial<
    Record<
      AfterSaleEvidenceStatus,
      Partial<Record<AfterSaleEvidenceEvent, AfterSaleEvidenceStatus>>
    >
  >
> = {
  PENDING: {
    EXPIRE: 'DELETION_PENDING',
    QUARANTINE: 'QUARANTINED',
    SCAN_FAILED: 'FAILED',
    SCAN_PASSED: 'READY_UNCLAIMED',
  },
  READY_UNCLAIMED: {
    CLAIM: 'READY',
    EXPIRE: 'DELETION_PENDING',
    QUARANTINE: 'QUARANTINED',
  },
  READY: { EXPIRE: 'DELETION_PENDING', QUARANTINE: 'QUARANTINED' },
  FAILED: { EXPIRE: 'DELETION_PENDING' },
  QUARANTINED: { EXPIRE: 'DELETION_PENDING' },
  DELETION_PENDING: { DELETE_FAILED: 'DELETE_FAILED', DELETE_SUCCEEDED: 'DELETED' },
  DELETE_FAILED: { RETRY_DELETE: 'DELETION_PENDING' },
};

export function transitionAfterSaleEvidence(
  current: AfterSaleEvidenceStatus,
  event: AfterSaleEvidenceEvent,
): AfterSaleEvidenceStatus {
  if (event === 'EXPIRE' || event === 'RETRY_DELETE' || event === 'DELETE_SUCCEEDED') {
    throw new AfterSaleInvariantError('AFTER_SALE_EVIDENCE_RETENTION_ACTIVE');
  }
  const target = evidenceTransitions[current]?.[event];
  if (!target) throw new AfterSaleInvariantError('AFTER_SALE_STATE_CONFLICT');
  return target;
}

export function assertAfterSaleEvidenceDeletionDue(input: {
  deletionDeadlineEpochMs: number;
  legalHoldActive: boolean;
  nowEpochMs: number;
}): void {
  if (
    !Number.isSafeInteger(input.deletionDeadlineEpochMs) ||
    !Number.isSafeInteger(input.nowEpochMs) ||
    input.deletionDeadlineEpochMs < 0 ||
    input.nowEpochMs < 0 ||
    input.legalHoldActive ||
    input.nowEpochMs < input.deletionDeadlineEpochMs
  ) {
    throw new AfterSaleInvariantError('AFTER_SALE_EVIDENCE_RETENTION_ACTIVE');
  }
}

export function transitionAfterSaleEvidenceDeletionDue(
  current: AfterSaleEvidenceStatus,
  input: {
    deletionDeadlineEpochMs: number;
    legalHoldActive: boolean;
    nowEpochMs: number;
  },
): AfterSaleEvidenceStatus {
  assertAfterSaleEvidenceDeletionDue(input);
  const target = evidenceTransitions[current]?.EXPIRE;
  if (!target) throw new AfterSaleInvariantError('AFTER_SALE_STATE_CONFLICT');
  return target;
}

export function transitionAfterSaleEvidenceDeletionAttempt(
  current: AfterSaleEvidenceStatus,
  event: 'RETRY_DELETE' | 'DELETE_SUCCEEDED',
  input: {
    deletionDeadlineEpochMs: number;
    legalHoldActive: boolean;
    nowEpochMs: number;
  },
): AfterSaleEvidenceStatus {
  assertAfterSaleEvidenceDeletionDue(input);
  const target = evidenceTransitions[current]?.[event];
  if (!target) throw new AfterSaleInvariantError('AFTER_SALE_STATE_CONFLICT');
  return target;
}

export function assertAfterSaleEvidenceAccessAllowed(input: {
  accessDeadlineEpochMs: number;
  legalHoldActive: boolean;
  nowEpochMs: number;
  status: AfterSaleEvidenceStatus;
}): void {
  if (
    !Number.isSafeInteger(input.accessDeadlineEpochMs) ||
    !Number.isSafeInteger(input.nowEpochMs) ||
    input.accessDeadlineEpochMs < 0 ||
    input.nowEpochMs < 0 ||
    input.status !== 'READY' ||
    input.nowEpochMs >= input.accessDeadlineEpochMs
  ) {
    throw new AfterSaleInvariantError('AFTER_SALE_EVIDENCE_ACCESS_DENIED');
  }
}

export function assertEquivalentExchange(input: {
  allowedAttributeCode: string;
  originalProductId: string;
  originalSkuId: string;
  originalStoreId: string;
  originalUnitPriceVnd: number;
  originalOptions: Readonly<Record<string, string>>;
  replacementActive: boolean;
  replacementProductId: string;
  replacementSkuId: string;
  replacementStoreId: string;
  replacementUnitPriceVnd: number;
  replacementOptions: Readonly<Record<string, string>>;
  replacementQuantity: number;
  requestedQuantity: number;
}): void {
  assertSafeCount(input.requestedQuantity);
  assertSafeCount(input.replacementQuantity);
  assertSafeVnd(input.originalUnitPriceVnd);
  assertSafeVnd(input.replacementUnitPriceVnd);
  const allowedAttributeCode = input.allowedAttributeCode.trim();
  const originalOptionKeys = Object.keys(input.originalOptions).sort();
  const replacementOptionKeys = Object.keys(input.replacementOptions).sort();
  if (
    input.requestedQuantity === 0 ||
    input.replacementQuantity !== input.requestedQuantity ||
    !input.replacementActive ||
    input.originalStoreId.length === 0 ||
    input.originalStoreId !== input.replacementStoreId ||
    input.originalProductId !== input.replacementProductId ||
    input.originalSkuId === input.replacementSkuId ||
    input.originalUnitPriceVnd !== input.replacementUnitPriceVnd ||
    input.originalProductId.length === 0 ||
    input.originalSkuId.length === 0 ||
    input.replacementSkuId.length === 0 ||
    allowedAttributeCode.length === 0 ||
    originalOptionKeys.length !== replacementOptionKeys.length ||
    originalOptionKeys.some((key, index) => key !== replacementOptionKeys[index]) ||
    !originalOptionKeys.includes(allowedAttributeCode) ||
    originalOptionKeys.some(
      (key) =>
        key.length === 0 ||
        input.originalOptions[key]?.trim().length === 0 ||
        input.replacementOptions[key]?.trim().length === 0,
    ) ||
    input.originalOptions[allowedAttributeCode] ===
      input.replacementOptions[allowedAttributeCode] ||
    originalOptionKeys.some(
      (key) =>
        key !== allowedAttributeCode &&
        input.originalOptions[key] !== input.replacementOptions[key],
    )
  ) {
    throw new AfterSaleInvariantError('AFTER_SALE_EXCHANGE_NOT_ALLOWED');
  }
}
