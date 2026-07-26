import type { PrismaClient } from '@zalo-shop/database';
import {
  getPaymentCreationRequest,
  PaymentCommandError,
  recordPaymentLaunch,
  type OutboxMessageRecord,
} from '@zalo-shop/database';
import { createStoreContext } from '@zalo-shop/domain';
import { ProviderIntegrationError, type PaymentProvider } from '@zalo-shop/integrations';

import {
  OutboxHandlerError,
  type OutboxMessageHandler,
} from '../reliable-messaging/outbox-message-handler';

const PAYMENT_WORKER_ACTOR_ID = '00000000-0000-4000-8000-000000000006';

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
    throw new OutboxHandlerError('PAYMENT_CREATE_PAYLOAD_INVALID', 'PERMANENT');
  }
  return message.aggregateId;
}

export class PaymentCreateRequestedHandler implements OutboxMessageHandler {
  public readonly eventType = 'payment.create.requested';
  public readonly eventVersions = new Set([1]);

  public constructor(
    private readonly database: PrismaClient,
    private readonly provider: PaymentProvider,
  ) {}

  public async handle(message: OutboxMessageRecord): Promise<void> {
    const attemptId = paymentAttemptId(message);
    const context = createStoreContext({
      actor: { id: PAYMENT_WORKER_ACTOR_ID, type: 'admin' },
      correlationId: `payment-create:${message.id}`,
      locale: 'vi',
      storeCode: 'payment-worker',
      storeId: message.storeId,
    });
    try {
      const request = await getPaymentCreationRequest(this.database, context, attemptId);
      if (request.status !== 'CREATED') return;
      if (
        request.channel.providerCode !== this.provider.code ||
        request.channel.providerEnvironment !== this.provider.environment
      ) {
        throw new OutboxHandlerError('PAYMENT_PROVIDER_CONFIGURATION_MISMATCH', 'REVIEW_REQUIRED');
      }
      const result = await this.provider.createPayment(request);
      await recordPaymentLaunch(this.database, context, {
        action: result.launchAction,
        attemptId,
        ...(result.providerOrderId ? { providerOrderId: result.providerOrderId } : {}),
        ...(result.providerStatus ? { providerStatus: result.providerStatus } : {}),
      });
    } catch (error) {
      if (error instanceof OutboxHandlerError) throw error;
      if (error instanceof ProviderIntegrationError) {
        const disposition = error.retryable
          ? 'RETRYABLE'
          : error.code === 'INVALID_REQUEST' || error.code === 'REJECTED'
            ? 'PERMANENT'
            : 'REVIEW_REQUIRED';
        throw new OutboxHandlerError(`PAYMENT_PROVIDER_${error.code}`, disposition);
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
