import { describe, expect, it } from 'vitest';

import { accessReasonSchema, consentEventSchema, memberPreferenceSchema } from './index';

describe('M1 API contracts', () => {
  it('accepts only supported locales', () => {
    expect(memberPreferenceSchema.parse({ locale: 'vi' })).toEqual({ locale: 'vi' });
    expect(() => memberPreferenceSchema.parse({ locale: 'fr' })).toThrow();
  });

  it('requires an explicit cross-store access reason', () => {
    expect(accessReasonSchema.parse('Investigate incident INC-123')).toBe(
      'Investigate incident INC-123',
    );
    expect(() => accessReasonSchema.parse('short')).toThrow();
  });

  it('requires an idempotent consent event identifier', () => {
    expect(() =>
      consentEventSchema.parse({
        event_id: 'not-a-uuid',
        policy_version: 'privacy-v1',
        purpose: 'PRIVACY',
        source: 'MANUAL',
        status: 'GRANTED',
      }),
    ).toThrow();
  });
});
