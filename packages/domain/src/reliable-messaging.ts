export const OUTBOX_FAILURE_DISPOSITIONS = ['RETRYABLE', 'PERMANENT', 'REVIEW_REQUIRED'] as const;

export type OutboxFailureDisposition = (typeof OUTBOX_FAILURE_DISPOSITIONS)[number];

export type ExponentialBackoffInput = Readonly<{
  attemptCount: number;
  baseDelayMs?: number;
  jitterRatio?: number;
  maxDelayMs?: number;
  randomValue?: number;
}>;

export class ReliableMessagingRuleError extends Error {
  public constructor(
    public readonly code:
      'BACKOFF_ATTEMPT_INVALID' | 'BACKOFF_CONFIG_INVALID' | 'BACKOFF_RANDOM_INVALID',
  ) {
    super(code);
    this.name = 'ReliableMessagingRuleError';
  }
}

export function calculateExponentialBackoffMs(input: ExponentialBackoffInput): number {
  const baseDelayMs = input.baseDelayMs ?? 1_000;
  const jitterRatio = input.jitterRatio ?? 0.2;
  const maxDelayMs = input.maxDelayMs ?? 300_000;
  const randomValue = input.randomValue ?? Math.random();

  if (!Number.isSafeInteger(input.attemptCount) || input.attemptCount < 1) {
    throw new ReliableMessagingRuleError('BACKOFF_ATTEMPT_INVALID');
  }
  if (
    !Number.isSafeInteger(baseDelayMs) ||
    baseDelayMs < 1 ||
    !Number.isSafeInteger(maxDelayMs) ||
    maxDelayMs < baseDelayMs ||
    !Number.isFinite(jitterRatio) ||
    jitterRatio < 0 ||
    jitterRatio > 0.5
  ) {
    throw new ReliableMessagingRuleError('BACKOFF_CONFIG_INVALID');
  }
  if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue > 1) {
    throw new ReliableMessagingRuleError('BACKOFF_RANDOM_INVALID');
  }

  const exponent = Math.min(input.attemptCount - 1, 30);
  const uncappedDelay = baseDelayMs * 2 ** exponent;
  const cappedDelay = Math.min(uncappedDelay, maxDelayMs);
  const jitterMultiplier = 1 - jitterRatio + randomValue * jitterRatio * 2;
  return Math.min(maxDelayMs, Math.max(1, Math.round(cappedDelay * jitterMultiplier)));
}
