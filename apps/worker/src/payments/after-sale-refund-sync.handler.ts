import type { PrismaClient } from '@zalo-shop/database';
import {
  AFTER_SALE_REFUND_SYNC_EVENT_TYPE,
  AFTER_SALE_REFUND_SYNC_EVENT_VERSION,
  syncAfterSaleRefund,
  type OutboxMessageRecord,
} from '@zalo-shop/database';
import { createStoreContext } from '@zalo-shop/domain';

import {
  OutboxHandlerError,
  type OutboxMessageHandler,
} from '../reliable-messaging/outbox-message-handler';

const AFTER_SALE_REFUND_SYNC_ACTOR_ID = '00000000-0000-4000-8000-000000000009';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function payload(message: OutboxMessageRecord): { refundId: string; refundVersion: number } {
  const value = message.payload;
  if (
    message.aggregateType !== 'REFUND' ||
    !UUID_PATTERN.test(message.aggregateId) ||
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    value.store_id !== message.storeId ||
    value.refund_id !== message.aggregateId ||
    !Number.isSafeInteger(value.refund_version) ||
    (value.refund_version as number) < 1 ||
    Object.keys(value).some(
      (key) => key !== 'store_id' && key !== 'refund_id' && key !== 'refund_version',
    )
  ) {
    throw new OutboxHandlerError('AFTER_SALE_REFUND_SYNC_PAYLOAD_INVALID', 'PERMANENT');
  }
  return { refundId: message.aggregateId, refundVersion: value.refund_version as number };
}

function refundCommandErrorCode(error: unknown): string | null {
  if (
    error instanceof Error &&
    error.name === 'AfterSaleRefundCommandError' &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  return null;
}

export class AfterSaleRefundSyncHandler implements OutboxMessageHandler {
  public readonly eventType = AFTER_SALE_REFUND_SYNC_EVENT_TYPE;
  public readonly eventVersions = new Set([AFTER_SALE_REFUND_SYNC_EVENT_VERSION]);

  public constructor(private readonly database: PrismaClient) {}

  public async handle(message: OutboxMessageRecord): Promise<void> {
    const input = payload(message);
    const context = createStoreContext({
      actor: { id: AFTER_SALE_REFUND_SYNC_ACTOR_ID, type: 'admin' },
      correlationId: `after-sale-refund-sync:${message.id}`,
      locale: 'vi',
      storeCode: 'after-sale-refund-worker',
      storeId: message.storeId,
    });
    try {
      await syncAfterSaleRefund(this.database, context, input);
    } catch (error) {
      if (error instanceof OutboxHandlerError) throw error;
      const commandErrorCode = refundCommandErrorCode(error);
      if (commandErrorCode) {
        throw new OutboxHandlerError(commandErrorCode, 'REVIEW_REQUIRED');
      }
      throw new OutboxHandlerError('AFTER_SALE_REFUND_SYNC_UNEXPECTED', 'RETRYABLE');
    }
  }
}
