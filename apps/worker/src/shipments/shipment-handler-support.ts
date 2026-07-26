import type { RuntimeConfig } from '@zalo-shop/config';
import type { PrismaClient } from '@zalo-shop/database';
import { recordShippingOperationError, ShippingCommandError } from '@zalo-shop/database';
import { createStoreContext } from '@zalo-shop/domain';
import { ProviderIntegrationError, type ShippingAddress } from '@zalo-shop/integrations';
import { decryptSensitive } from '@zalo-shop/security';

import { OutboxHandlerError } from '../reliable-messaging/outbox-message-handler';

export const SHIPPING_WORKER_ACTOR_ID = '00000000-0000-4000-8000-000000000009';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function shippingContext(storeId: string, correlationId: string) {
  return createStoreContext({
    actor: { id: SHIPPING_WORKER_ACTOR_ID, type: 'admin' },
    correlationId,
    locale: 'vi',
    storeCode: 'shipping-worker',
    storeId,
  });
}

export function decryptShippingAddress(
  input: {
    addressLineCiphertext: string;
    districtCode: string;
    nameCiphertext: string;
    phoneCiphertext: string;
    provinceCode: string;
    wardCode: string;
  },
  config: Pick<RuntimeConfig, 'PII_ENCRYPTION_KEY'>,
): ShippingAddress {
  try {
    return {
      addressLine: decryptSensitive(input.addressLineCiphertext, config.PII_ENCRYPTION_KEY),
      districtCode: input.districtCode,
      name: decryptSensitive(input.nameCiphertext, config.PII_ENCRYPTION_KEY),
      phoneE164: decryptSensitive(input.phoneCiphertext, config.PII_ENCRYPTION_KEY),
      provinceCode: input.provinceCode,
      wardCode: input.wardCode,
    };
  } catch {
    throw new OutboxHandlerError('SHIPMENT_PII_DECRYPTION_FAILED', 'REVIEW_REQUIRED');
  }
}

export async function mapShippingFailure(
  database: PrismaClient,
  context: ReturnType<typeof shippingContext>,
  operationId: string,
  error: unknown,
): Promise<never> {
  if (error instanceof OutboxHandlerError) {
    await recordShippingOperationError(database, context, {
      errorCode: error.code,
      operationId,
      status: error.disposition === 'RETRYABLE' ? 'PENDING' : 'REVIEW_REQUIRED',
    });
    throw error;
  }
  if (error instanceof ProviderIntegrationError) {
    const disposition = error.retryable
      ? 'RETRYABLE'
      : error.code === 'INVALID_REQUEST' || error.code === 'REJECTED'
        ? 'PERMANENT'
        : 'REVIEW_REQUIRED';
    const code = `SHIPPING_PROVIDER_${error.code}`;
    await recordShippingOperationError(database, context, {
      errorCode: code,
      operationId,
      status:
        disposition === 'RETRYABLE'
          ? 'PENDING'
          : disposition === 'PERMANENT'
            ? 'FAILED'
            : 'REVIEW_REQUIRED',
    });
    throw new OutboxHandlerError(code, disposition);
  }
  if (error instanceof ShippingCommandError) {
    const disposition =
      error.code === 'SHIPMENT_NOT_FOUND' || error.code === 'SHIPMENT_OPERATION_NOT_FOUND'
        ? 'PERMANENT'
        : 'REVIEW_REQUIRED';
    await recordShippingOperationError(database, context, {
      errorCode: error.code,
      operationId,
      status: disposition === 'PERMANENT' ? 'FAILED' : 'REVIEW_REQUIRED',
    });
    throw new OutboxHandlerError(error.code, disposition);
  }
  await recordShippingOperationError(database, context, {
    errorCode: 'UNEXPECTED_SHIPPING_HANDLER_ERROR',
    operationId,
    status: 'PENDING',
  });
  throw error;
}

export function shipmentOperationIdentity(message: {
  aggregateId: string;
  aggregateType: string;
  payload: unknown;
  storeId: string;
}): { operationId: string; shipmentId: string } {
  const payload = message.payload;
  if (
    message.aggregateType !== 'SHIPMENT' ||
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw new OutboxHandlerError('SHIPMENT_OUTBOX_PAYLOAD_INVALID', 'PERMANENT');
  }
  const value = payload as Record<string, unknown>;
  if (
    value.store_id !== message.storeId ||
    value.shipment_id !== message.aggregateId ||
    typeof value.operation_id !== 'string' ||
    !UUID_PATTERN.test(value.operation_id) ||
    Object.keys(value).some(
      (key) => key !== 'store_id' && key !== 'shipment_id' && key !== 'operation_id',
    )
  ) {
    throw new OutboxHandlerError('SHIPMENT_OUTBOX_PAYLOAD_INVALID', 'PERMANENT');
  }
  return { operationId: value.operation_id, shipmentId: message.aggregateId };
}
