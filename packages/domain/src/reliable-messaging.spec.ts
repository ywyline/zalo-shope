import { describe, expect, it } from 'vitest';

import { calculateExponentialBackoffMs, ReliableMessagingRuleError } from './reliable-messaging';

describe('reliable messaging retry rules', () => {
  it('uses bounded exponential backoff with deterministic jitter', () => {
    expect(calculateExponentialBackoffMs({ attemptCount: 1, randomValue: 0 })).toBe(800);
    expect(calculateExponentialBackoffMs({ attemptCount: 2, randomValue: 0.5 })).toBe(2_000);
    expect(calculateExponentialBackoffMs({ attemptCount: 3, randomValue: 1 })).toBe(4_800);
    expect(calculateExponentialBackoffMs({ attemptCount: 30, randomValue: 1 })).toBe(300_000);
  });

  it('rejects invalid attempts, configuration and entropy', () => {
    expect(() => calculateExponentialBackoffMs({ attemptCount: 0 })).toThrow(
      new ReliableMessagingRuleError('BACKOFF_ATTEMPT_INVALID'),
    );
    expect(() =>
      calculateExponentialBackoffMs({ attemptCount: 1, baseDelayMs: 2_000, maxDelayMs: 1_000 }),
    ).toThrow(new ReliableMessagingRuleError('BACKOFF_CONFIG_INVALID'));
    expect(() => calculateExponentialBackoffMs({ attemptCount: 1, randomValue: 2 })).toThrow(
      new ReliableMessagingRuleError('BACKOFF_RANDOM_INVALID'),
    );
  });
});
