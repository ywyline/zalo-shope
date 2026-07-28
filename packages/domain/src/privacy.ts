export const PRIVACY_REQUEST_TYPES = [
  'ACCESS',
  'CORRECTION',
  'DELETION',
  'ANONYMIZATION',
  'ACCOUNT_CLOSURE',
] as const;

export type PrivacyRequestType = (typeof PRIVACY_REQUEST_TYPES)[number];

export const PRIVACY_REQUEST_STATUSES = [
  'SUBMITTED',
  'UNDER_REVIEW',
  'ACTION_REQUIRED',
  'IN_PROGRESS',
  'COMPLETED',
  'REJECTED',
  'CANCELLED',
] as const;

export type PrivacyRequestStatus = (typeof PRIVACY_REQUEST_STATUSES)[number];
export type PrivacyRequestEvent =
  | 'START_REVIEW'
  | 'REQUEST_ACTION'
  | 'PROVIDE_ACTION'
  | 'START_FULFILLMENT'
  | 'COMPLETE'
  | 'REJECT'
  | 'CANCEL';

const privacyRequestTransitions: Readonly<
  Partial<Record<PrivacyRequestStatus, Partial<Record<PrivacyRequestEvent, PrivacyRequestStatus>>>>
> = {
  SUBMITTED: {
    CANCEL: 'CANCELLED',
    REQUEST_ACTION: 'ACTION_REQUIRED',
    START_REVIEW: 'UNDER_REVIEW',
  },
  UNDER_REVIEW: {
    REJECT: 'REJECTED',
    REQUEST_ACTION: 'ACTION_REQUIRED',
    START_FULFILLMENT: 'IN_PROGRESS',
  },
  ACTION_REQUIRED: { CANCEL: 'CANCELLED', PROVIDE_ACTION: 'SUBMITTED' },
  IN_PROGRESS: { COMPLETE: 'COMPLETED', REJECT: 'REJECTED' },
};

export function transitionPrivacyRequest(
  current: PrivacyRequestStatus,
  event: PrivacyRequestEvent,
): PrivacyRequestStatus {
  const target = privacyRequestTransitions[current]?.[event];
  if (!target) throw new Error('PRIVACY_REQUEST_STATE_CONFLICT');
  return target;
}
