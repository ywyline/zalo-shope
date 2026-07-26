import type { PrismaClient } from '@zalo-shop/database';
import {
  applyPaymentProviderFact,
  getPaymentReconciliationRequest,
  PAYMENT_RECONCILIATION_EVENT_TYPE,
  PAYMENT_RECONCILIATION_RETRY_DELAY_MS,
  PaymentCommandError,
  type OutboxMessageRecord,
} from '@zalo-shop/database';
import { createStoreContext } from '@zalo-shop/domain';
import { ProviderIntegrationError, type PaymentProviderResolver } from '@zalo-shop/integrations';

import {
  OutboxHandlerError,
  type OutboxMessageHandler,
} from '../reliable-messaging/outbox-message-handler';

const PAYMENT_RECONCILIATION_ACTOR_ID = '00000000-0000-4000-8000-000000000008';

function paymentAttemptId(message: OutboxMessageRecord): string {
  const payload = message.payload;
  if (
    message.aggregateType !== 'PAYMENT_ATTEMPT' ||
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload) ||
    payload.store_id !== message.storeId ||
    payload.payment_attempt_id !== message.aggregateId ||
    Object.keys(payload).some((key) => key !== 'store_id' && key !== 'payment_attempt_id')
  ) {
    throw new OutboxHandlerError('PAYMENT_RECONCILE_PAYLOAD_INVALID', 'PERMANENT');
  }
  return message.aggregateId;
}

function isSettled(status: string): boolean {
  return status === 'SUCCEEDED' || status === 'REVIEW_REQUIRED';
}

export class PaymentReconciliationRequestedHandler implements OutboxMessageHandler {
  public readonly eventType = PAYMENT_RECONCILIATION_EVENT_TYPE;
  public readonly eventVersions = new Set([1]);

  public constructor(
    private readonly database: PrismaClient,
    private readonly providers: PaymentProviderResolver,
  ) {}

  public async handle(message: OutboxMessageRecord): Promise<void> {
    const attemptId = paymentAttemptId(message);
    const context = createStoreContext({
      actor: { id: PAYMENT_RECONCILIATION_ACTOR_ID, type: 'admin' },
      correlationId: `payment-reconcile:${message.id}`,
      locale: 'vi',
      storeCode: 'payment-worker',
      storeId: message.storeId,
    });
    let request;
    try {
      request = await getPaymentReconciliationRequest(this.database, context, attemptId);
      if (isSettled(request.status)) return;
      if (!request.providerOrderId) {
        throw new OutboxHandlerError('PAYMENT_PROVIDER_ORDER_MISSING', 'REVIEW_REQUIRED');
      }
      const provider = this.providers.resolve({ ...request.channel, storeId: request.storeId });
      const fact = await provider.queryPayment({
        providerOrderId: request.providerOrderId,
        storeId: request.storeId,
      });
      await applyPaymentProviderFact(this.database, context, {
        attemptId,
        fact,
        source: 'RECONCILIATION',
      });
      if (fact.status === 'PENDING') {
        throw new OutboxHandlerError(
          'PAYMENT_RECONCILIATION_PENDING',
          'RETRYABLE',
          PAYMENT_RECONCILIATION_RETRY_DELAY_MS,
        );
      }
    } catch (error) {
      if (error instanceof OutboxHandlerError) throw error;
      if (error instanceof PaymentCommandError && error.code === 'PAYMENT_ATTEMPT_CONFLICT') {
        const latest = await getPaymentReconciliationRequest(this.database, context, attemptId);
        if (isSettled(latest.status)) return;
      }
      if (error instanceof ProviderIntegrationError) {
        throw new OutboxHandlerError(
          `PAYMENT_PROVIDER_${error.code}`,
          error.retryable ? 'RETRYABLE' : 'REVIEW_REQUIRED',
        );
      }
      if (error instanceof PaymentCommandError) {
        throw new OutboxHandlerError(
          error.code,
          error.code === 'PAYMENT_ATTEMPT_NOT_FOUND' ? 'PERMANENT' : 'REVIEW_REQUIRED',
        );
      }
      throw error;
    }
  }
}
