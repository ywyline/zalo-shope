import { describe, expect, it } from 'vitest';

import type { OutboxMessageRecord } from '@zalo-shop/database';

import { OutboxMessageDispatcher } from './outbox-message-handler';
import type { OutboxHandlerError } from './outbox-message-handler';
import { TestOnlyOutboxHandler } from './test-only-outbox-handler';

function message(input: Partial<OutboxMessageRecord> = {}): OutboxMessageRecord {
  return {
    aggregateId: '10000000-0000-4000-8000-000000000001',
    aggregateType: 'TEST_PROBE',
    attemptCount: 1,
    availableAt: new Date('2026-07-25T00:00:00.000Z'),
    completedAt: null,
    eventType: 'test.reliable-message.probe',
    eventVersion: 2,
    id: '10000000-0000-4000-8000-000000000002',
    idempotencyKey: 'test-probe-idempotency-key',
    lastErrorCode: null,
    leaseExpiresAt: new Date('2026-07-25T00:01:00.000Z'),
    leaseOwner: 'worker-test',
    maxAttempts: 8,
    payload: { outcome: 'COMPLETE', store_id: '10000000-0000-4000-8000-000000000001' },
    status: 'PROCESSING',
    storeId: '10000000-0000-4000-8000-000000000001',
    version: 2,
    ...input,
  };
}

describe('outbox message dispatch', () => {
  it('hard-fails construction of the test handler outside test', () => {
    expect(() => new TestOnlyOutboxHandler('development')).toThrow('test-only');
    expect(() => new TestOnlyOutboxHandler('production')).toThrow('test-only');
  });

  it('supports current and previous test event versions without external calls', async () => {
    const handler = new TestOnlyOutboxHandler('test');
    const dispatcher = new OutboxMessageDispatcher([handler]);

    await expect(dispatcher.dispatch(message({ eventVersion: 1 }))).resolves.toBeUndefined();
    await expect(dispatcher.dispatch(message({ eventVersion: 2 }))).resolves.toBeUndefined();
  });

  it('classifies retryable, permanent, review and unsupported outcomes', async () => {
    const dispatcher = new OutboxMessageDispatcher([new TestOnlyOutboxHandler('test')]);

    for (const [outcome, disposition] of [
      ['RETRYABLE', 'RETRYABLE'],
      ['PERMANENT', 'PERMANENT'],
      ['REVIEW_REQUIRED', 'REVIEW_REQUIRED'],
    ] as const) {
      await expect(
        dispatcher.dispatch(message({ payload: { outcome, store_id: message().storeId } })),
      ).rejects.toMatchObject({ disposition } satisfies Partial<OutboxHandlerError>);
    }
    await expect(dispatcher.dispatch(message({ eventVersion: 3 }))).rejects.toMatchObject({
      code: 'UNSUPPORTED_EVENT_VERSION',
      disposition: 'PERMANENT',
    });
  });
});
