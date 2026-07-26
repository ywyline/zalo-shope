import type { PrismaClient } from '@zalo-shop/database';
import {
  applyRefundProviderFact,
  getRefundProviderRequest,
  markRefundReviewRequired,
  REFUND_CREATE_EVENT_TYPE,
  REFUND_QUERY_EVENT_TYPE,
  REFUND_QUERY_RETRY_DELAY_MS,
  RefundCommandError,
  type OutboxMessageRecord,
} from '@zalo-shop/database';
import { createStoreContext } from '@zalo-shop/domain';
import { ProviderIntegrationError, type PaymentProviderResolver } from '@zalo-shop/integrations';

import {
  OutboxHandlerError,
  type OutboxMessageHandler,
} from '../reliable-messaging/outbox-message-handler';

const REFUND_WORKER_ACTOR_ID = '00000000-0000-4000-8000-00000000000a';

function refundId(message: OutboxMessageRecord): string {
  const payload = message.payload;
  if (
    message.aggregateType !== 'REFUND' ||
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload) ||
    payload.store_id !== message.storeId ||
    payload.refund_id !== message.aggregateId ||
    Object.keys(payload).some((key) => key !== 'store_id' && key !== 'refund_id')
  ) {
    throw new OutboxHandlerError('REFUND_OUTBOX_PAYLOAD_INVALID', 'PERMANENT');
  }
  return message.aggregateId;
}

function context(message: OutboxMessageRecord) {
  return createStoreContext({
    actor: { id: REFUND_WORKER_ACTOR_ID, type: 'admin' },
    correlationId: `refund:${message.id}`,
    locale: 'vi',
    storeCode: 'refund-worker',
    storeId: message.storeId,
  });
}

function mapError(error: unknown, query: boolean): OutboxHandlerError {
  if (error instanceof OutboxHandlerError) return error;
  if (error instanceof ProviderIntegrationError) {
    return new OutboxHandlerError(
      `REFUND_PROVIDER_${error.code}`,
      query && error.retryable ? 'RETRYABLE' : 'REVIEW_REQUIRED',
    );
  }
  if (error instanceof RefundCommandError) {
    return new OutboxHandlerError(
      error.code,
      error.code === 'REFUND_NOT_FOUND' ? 'PERMANENT' : 'REVIEW_REQUIRED',
    );
  }
  return new OutboxHandlerError('UNEXPECTED_REFUND_HANDLER_ERROR', 'RETRYABLE');
}

export class RefundCreateRequestedHandler implements OutboxMessageHandler {
  public readonly eventType = REFUND_CREATE_EVENT_TYPE;
  public readonly eventVersions = new Set([1]);

  public constructor(
    private readonly database: PrismaClient,
    private readonly providers: PaymentProviderResolver,
  ) {}

  public async handle(message: OutboxMessageRecord): Promise<void> {
    const id = refundId(message);
    const storeContext = context(message);
    try {
      const request = await getRefundProviderRequest(this.database, storeContext, id);
      if (request.status !== 'REQUESTED') return;
      const provider = this.providers.resolve({ ...request.channel, storeId: request.storeId });
      const fact = await provider.createRefund(request);
      await applyRefundProviderFact(this.database, storeContext, {
        fact,
        refundId: id,
        source: 'SYSTEM',
      });
    } catch (error) {
      const mapped = mapError(error, false);
      try {
        await markRefundReviewRequired(this.database, storeContext, {
          reason: mapped.code,
          refundId: id,
        });
      } catch {
        // Preserve the original provider/command failure classification.
      }
      throw mapped;
    }
  }
}

export class RefundQueryRequestedHandler implements OutboxMessageHandler {
  public readonly eventType = REFUND_QUERY_EVENT_TYPE;
  public readonly eventVersions = new Set([1]);

  public constructor(
    private readonly database: PrismaClient,
    private readonly providers: PaymentProviderResolver,
  ) {}

  public async handle(message: OutboxMessageRecord): Promise<void> {
    const id = refundId(message);
    const storeContext = context(message);
    try {
      const request = await getRefundProviderRequest(this.database, storeContext, id);
      if (request.status === 'SUCCEEDED' || request.status === 'FAILED') return;
      if (request.status !== 'PROCESSING' || !request.providerRefundId) {
        throw new OutboxHandlerError('REFUND_PROVIDER_REFERENCE_MISSING', 'REVIEW_REQUIRED');
      }
      const provider = this.providers.resolve({ ...request.channel, storeId: request.storeId });
      const fact = await provider.queryRefund({
        amountVnd: request.amountVnd,
        providerRefundId: request.providerRefundId,
        storeId: request.storeId,
      });
      await applyRefundProviderFact(this.database, storeContext, {
        fact,
        refundId: id,
        source: 'QUERY',
      });
      if (fact.status === 'PENDING') {
        throw new OutboxHandlerError(
          'REFUND_QUERY_PENDING',
          'RETRYABLE',
          REFUND_QUERY_RETRY_DELAY_MS,
        );
      }
    } catch (error) {
      throw mapError(error, true);
    }
  }
}
