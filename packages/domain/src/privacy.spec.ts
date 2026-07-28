import { describe, expect, it } from 'vitest';

import { transitionPrivacyRequest } from './privacy';

describe('M6 privacy request state machine', () => {
  it('keeps intake separate from audited fulfillment', () => {
    expect(transitionPrivacyRequest('SUBMITTED', 'START_REVIEW')).toBe('UNDER_REVIEW');
    expect(transitionPrivacyRequest('UNDER_REVIEW', 'START_FULFILLMENT')).toBe('IN_PROGRESS');
    expect(transitionPrivacyRequest('IN_PROGRESS', 'COMPLETE')).toBe('COMPLETED');
  });

  it('allows member cancellation only before fulfillment and keeps terminals closed', () => {
    expect(transitionPrivacyRequest('SUBMITTED', 'CANCEL')).toBe('CANCELLED');
    expect(transitionPrivacyRequest('ACTION_REQUIRED', 'CANCEL')).toBe('CANCELLED');
    expect(() => transitionPrivacyRequest('IN_PROGRESS', 'CANCEL')).toThrow(
      'PRIVACY_REQUEST_STATE_CONFLICT',
    );
    expect(() => transitionPrivacyRequest('IN_PROGRESS', 'REQUEST_ACTION')).toThrow(
      'PRIVACY_REQUEST_STATE_CONFLICT',
    );
    expect(() => transitionPrivacyRequest('COMPLETED', 'START_REVIEW')).toThrow(
      'PRIVACY_REQUEST_STATE_CONFLICT',
    );
  });
});
