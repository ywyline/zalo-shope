import type { OutboxMessageRecord } from '@zalo-shop/database';

import { OutboxHandlerError, type OutboxMessageHandler } from './outbox-message-handler';

type TestOutcome = 'COMPLETE' | 'PERMANENT' | 'RETRYABLE' | 'REVIEW_REQUIRED';

function testOutcome(message: OutboxMessageRecord): TestOutcome {
  const payload = message.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new OutboxHandlerError('TEST_PAYLOAD_INVALID', 'PERMANENT');
  }
  const outcome = payload.outcome;
  if (
    outcome !== 'COMPLETE' &&
    outcome !== 'PERMANENT' &&
    outcome !== 'RETRYABLE' &&
    outcome !== 'REVIEW_REQUIRED'
  ) {
    throw new OutboxHandlerError('TEST_PAYLOAD_INVALID', 'PERMANENT');
  }
  return outcome;
}

export class TestOnlyOutboxHandler implements OutboxMessageHandler {
  public readonly eventType = 'test.reliable-message.probe';
  public readonly eventVersions = new Set([1, 2]);

  public constructor(nodeEnvironment: string | undefined = process.env.NODE_ENV) {
    if (nodeEnvironment !== 'test') {
      throw new Error('The reliable-message probe handler is test-only');
    }
  }

  public async handle(message: OutboxMessageRecord): Promise<void> {
    await Promise.resolve();
    const outcome = testOutcome(message);
    if (outcome !== 'COMPLETE') {
      throw new OutboxHandlerError(`TEST_${outcome}`, outcome);
    }
  }
}
