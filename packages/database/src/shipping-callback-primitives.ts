import { createHash, randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import type { StoreContext } from '@zalo-shop/domain';

import { withStoreTransaction } from './index';
import {
  appendOutboxMessageInTransaction,
  recordInboxMessageInTransaction,
} from './reliable-messaging';
import { SHIPMENT_QUERY_EVENT_TYPE } from './shipping-primitives';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const EVENT_KEY_PATTERN = /^ghn-hint:[0-9a-f]{64}$/u;
const SHOP_ID_PATTERN = /^\d{1,20}$/u;

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export type ShippingCallbackChannel = Readonly<{
  channelId: string;
  defaultLocale: 'en' | 'vi' | 'zh';
  keyVersion: string;
  originAllowlistKey: string;
  providerCode: 'GHN';
  providerEnvironment: 'SANDBOX' | 'PRODUCTION';
  shopId: string;
  storeCode: string;
  storeId: string;
  tokenSecretRef: string;
  version: number;
}>;

type CallbackChannelRow = {
  channel_id: string;
  channel_version: number;
  default_locale: ShippingCallbackChannel['defaultLocale'];
  key_version: string;
  origin_allowlist_key: string;
  provider_code: ShippingCallbackChannel['providerCode'];
  provider_environment: ShippingCallbackChannel['providerEnvironment'];
  shop_id: string;
  store_code: string;
  store_id: string;
  token_secret_ref: string;
};

type CallbackRow = {
  id: string;
  processing_status: 'PROCESSED' | 'RECEIVED' | 'REJECTED';
};

export class ShippingCallbackError extends Error {
  public constructor(
    public readonly code:
      | 'SHIPPING_CALLBACK_CHANNEL_INVALID'
      | 'SHIPPING_CALLBACK_INPUT_INVALID'
      | 'SHIPPING_CALLBACK_STATE_CONFLICT',
  ) {
    super(code);
    this.name = 'ShippingCallbackError';
  }
}

export async function resolveShippingCallbackChannel(
  client: PrismaClient,
  shopId: string,
): Promise<ShippingCallbackChannel> {
  if (!SHOP_ID_PATTERN.test(shopId)) {
    throw new ShippingCallbackError('SHIPPING_CALLBACK_INPUT_INVALID');
  }
  const rows = await client.$queryRaw<CallbackChannelRow[]>`
    SELECT * FROM app_security.resolve_shipping_callback_channel(${shopId})
  `;
  const row = rows[0];
  if (!row || rows.length !== 1) {
    throw new ShippingCallbackError('SHIPPING_CALLBACK_CHANNEL_INVALID');
  }
  return {
    channelId: row.channel_id,
    defaultLocale: row.default_locale,
    keyVersion: row.key_version,
    originAllowlistKey: row.origin_allowlist_key,
    providerCode: row.provider_code,
    providerEnvironment: row.provider_environment,
    shopId: row.shop_id,
    storeCode: row.store_code,
    storeId: row.store_id,
    tokenSecretRef: row.token_secret_ref,
    version: row.channel_version,
  };
}

export type ShippingCallbackHintResult = Readonly<{
  duplicate: boolean;
  queryScheduled: boolean;
  shipmentId?: string;
}>;

export function recordShippingCallbackHint(
  client: PrismaClient,
  context: StoreContext,
  input: Readonly<{
    channelId: string;
    clientOrderCode?: string;
    environment: 'SANDBOX' | 'PRODUCTION';
    eventDigest: string;
    externalEventId: string;
    payloadDigest: string;
    providerShipmentId?: string;
  }>,
): Promise<ShippingCallbackHintResult> {
  if (
    !DIGEST_PATTERN.test(input.eventDigest) ||
    !DIGEST_PATTERN.test(input.payloadDigest) ||
    !EVENT_KEY_PATTERN.test(input.externalEventId) ||
    (!input.clientOrderCode && !input.providerShipmentId) ||
    (input.clientOrderCode !== undefined && input.clientOrderCode.length > 160) ||
    (input.providerShipmentId !== undefined && input.providerShipmentId.length > 160)
  ) {
    throw new ShippingCallbackError('SHIPPING_CALLBACK_INPUT_INVALID');
  }
  return withStoreTransaction(client, context, async (transaction) => {
    const inbox = await recordInboxMessageInTransaction(transaction, context, {
      channelId: input.channelId,
      environment: input.environment,
      externalMessageKey: input.externalEventId,
      payloadDigest: input.payloadDigest,
      source: 'GHN',
    });
    const callbackId = randomUUID();
    const inserted = await transaction.$queryRaw<CallbackRow[]>`
      INSERT INTO provider_callbacks (
        id, store_id, channel_kind, channel_id, provider_code, environment,
        external_event_id, event_digest, signature_status, trust, processing_status,
        payload_digest
      ) VALUES (
        ${callbackId}::uuid, ${context.storeId}::uuid, 'SHIPPING'::integration_channel_kind,
        ${input.channelId}::uuid, 'GHN', ${input.environment}::integration_environment,
        ${input.externalEventId}, ${input.eventDigest},
        'NOT_AVAILABLE'::callback_signature_status,
        'UNVERIFIED_HINT'::provider_callback_trust,
        'RECEIVED'::provider_callback_processing_status, ${input.payloadDigest}
      )
      ON CONFLICT DO NOTHING
      RETURNING id, processing_status
    `;
    let callback = inserted[0];
    if (!callback) {
      const existing = await transaction.$queryRaw<CallbackRow[]>`
        SELECT id, processing_status
        FROM provider_callbacks
        WHERE store_id = ${context.storeId}::uuid
          AND channel_kind = 'SHIPPING'::integration_channel_kind
          AND channel_id = ${input.channelId}::uuid
          AND environment = ${input.environment}::integration_environment
          AND external_event_id = ${input.externalEventId}
          AND event_digest = ${input.eventDigest}
          AND payload_digest = ${input.payloadDigest}
        FOR UPDATE
      `;
      callback = existing[0];
    }
    if (!callback) throw new ShippingCallbackError('SHIPPING_CALLBACK_STATE_CONFLICT');
    if (callback.processing_status === 'PROCESSED' || callback.processing_status === 'REJECTED') {
      return { duplicate: true, queryScheduled: callback.processing_status === 'PROCESSED' };
    }

    const shipment = await transaction.shipment.findFirst({
      select: { channelId: true, id: true, orderId: true, providerShipmentId: true },
      where: {
        channelId: input.channelId,
        ...(input.clientOrderCode ? { clientOrderCode: input.clientOrderCode } : {}),
        providerShipmentId: input.providerShipmentId ?? { not: null },
        storeId: context.storeId,
      },
    });
    if (!shipment?.providerShipmentId) {
      const completedAt = new Date();
      await transaction.$executeRaw`
        UPDATE provider_callbacks
        SET processing_status = 'REJECTED'::provider_callback_processing_status,
            attempt_count = attempt_count + 1,
            last_error_code = 'SHIPPING_CALLBACK_SHIPMENT_NOT_FOUND',
            completed_at = ${completedAt},
            version = version + 1
        WHERE store_id = ${context.storeId}::uuid AND id = ${callback.id}::uuid
      `;
      await transaction.$executeRaw`
        UPDATE inbox_messages
        SET status = 'REJECTED'::inbox_status,
            processing_started_at = COALESCE(processing_started_at, ${completedAt}),
            completed_at = ${completedAt},
            error_code = 'SHIPPING_CALLBACK_SHIPMENT_NOT_FOUND',
            version = version + 1
        WHERE store_id = ${context.storeId}::uuid AND id = ${inbox.message.id}::uuid
      `;
      return { duplicate: inbox.replayed, queryScheduled: false };
    }

    const idempotencyKeyHash = digest(`shipping-callback-query:${callback.id}`);
    const requestHash = digest(`QUERY_TRACKING\u0000${callback.id}\u0000${shipment.id}`);
    let operation = await transaction.shippingOperation.findUnique({
      where: {
        storeId_channelId_operationType_idempotencyKeyHash: {
          channelId: shipment.channelId,
          idempotencyKeyHash,
          operationType: 'QUERY_TRACKING',
          storeId: context.storeId,
        },
      },
    });
    if (!operation) {
      operation = await transaction.shippingOperation.create({
        data: {
          channelId: shipment.channelId,
          correlationId: context.correlationId,
          idempotencyKeyHash,
          operationType: 'QUERY_TRACKING',
          orderId: shipment.orderId,
          requestHash,
          shipmentId: shipment.id,
          storeId: context.storeId,
        },
      });
    } else if (
      operation.requestHash !== requestHash ||
      operation.shipmentId !== shipment.id ||
      operation.orderId !== shipment.orderId
    ) {
      throw new ShippingCallbackError('SHIPPING_CALLBACK_STATE_CONFLICT');
    }
    await appendOutboxMessageInTransaction(transaction, context, {
      aggregateId: shipment.id,
      aggregateType: 'SHIPMENT',
      eventType: SHIPMENT_QUERY_EVENT_TYPE,
      eventVersion: 1,
      idempotencyKey: `${SHIPMENT_QUERY_EVENT_TYPE}:${operation.id}`,
      payload: {
        operation_id: operation.id,
        shipment_id: shipment.id,
        store_id: context.storeId,
      },
    });
    const completedAt = new Date();
    await transaction.$executeRaw`
      UPDATE provider_callbacks
      SET processing_status = 'PROCESSED'::provider_callback_processing_status,
          attempt_count = attempt_count + 1,
          completed_at = ${completedAt},
          version = version + 1
      WHERE store_id = ${context.storeId}::uuid AND id = ${callback.id}::uuid
    `;
    await transaction.$executeRaw`
      UPDATE inbox_messages
      SET status = 'COMPLETED'::inbox_status,
          processing_started_at = COALESCE(processing_started_at, ${completedAt}),
          completed_at = ${completedAt},
          version = version + 1
      WHERE store_id = ${context.storeId}::uuid AND id = ${inbox.message.id}::uuid
    `;
    return {
      duplicate: inbox.replayed,
      queryScheduled: true,
      shipmentId: shipment.id,
    };
  });
}
