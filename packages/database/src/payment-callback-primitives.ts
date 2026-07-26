import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import type { StoreContext } from '@zalo-shop/domain';

import { recordInboxMessageInTransaction } from './reliable-messaging';
import { withStoreTransaction } from './index';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const EVENT_KEY_PATTERN = /^zc:[0-9a-f]{64}$/u;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/u;
// A callback handler may be terminated after claiming the inbox row. Reclaim
// only leases that have been processing long enough to be considered dead;
// fresh PROCESSING rows remain protected from concurrent delivery.
const CALLBACK_PROCESSING_LEASE_MS = 5 * 60_000;

export type PaymentCallbackChannel = Readonly<{
  channelId: string;
  checkoutAppId: string;
  defaultLocale: 'en' | 'vi' | 'zh';
  keyVersion: string;
  methodCode: string;
  privateKeySecretRef: string;
  providerCode: 'ZALO_CHECKOUT_ZALOPAY';
  providerEnvironment: 'SANDBOX' | 'PRODUCTION';
  storeCode: string;
  storeId: string;
  version: number;
}>;

type CallbackChannelRow = {
  channel_id: string;
  channel_version: number;
  checkout_app_id: string;
  default_locale: PaymentCallbackChannel['defaultLocale'];
  key_version: string;
  method_code: string;
  private_key_secret_ref: string;
  provider_code: PaymentCallbackChannel['providerCode'];
  provider_environment: PaymentCallbackChannel['providerEnvironment'];
  store_code: string;
  store_id: string;
};

type CallbackRow = {
  id: string;
  processing_status:
    'DEAD_LETTER' | 'PROCESSED' | 'PROCESSING' | 'RECEIVED' | 'REJECTED' | 'RETRY_PENDING';
  version: number;
};

function callbackLeaseExpired(processingStartedAt: Date | null): boolean {
  return (
    processingStartedAt !== null &&
    processingStartedAt.getTime() <= Date.now() - CALLBACK_PROCESSING_LEASE_MS
  );
}

export class PaymentCallbackError extends Error {
  public constructor(
    public readonly code:
      | 'PAYMENT_CALLBACK_CHANNEL_INVALID'
      | 'PAYMENT_CALLBACK_INPUT_INVALID'
      | 'PAYMENT_CALLBACK_STATE_CONFLICT',
  ) {
    super(code);
    this.name = 'PaymentCallbackError';
  }
}

export async function resolvePaymentCallbackChannel(
  client: PrismaClient,
  input: Readonly<{ appId: string; methodCode: 'ZALOPAY' | 'ZALOPAY_SANDBOX' }>,
): Promise<PaymentCallbackChannel> {
  if (!input.appId || input.appId.length > 128) {
    throw new PaymentCallbackError('PAYMENT_CALLBACK_INPUT_INVALID');
  }
  const rows = await client.$queryRaw<CallbackChannelRow[]>`
    SELECT * FROM app_security.resolve_payment_callback_channel(${input.appId}, ${input.methodCode})
  `;
  const row = rows[0];
  if (!row || rows.length !== 1) {
    throw new PaymentCallbackError('PAYMENT_CALLBACK_CHANNEL_INVALID');
  }
  return {
    channelId: row.channel_id,
    checkoutAppId: row.checkout_app_id,
    defaultLocale: row.default_locale,
    keyVersion: row.key_version,
    methodCode: row.method_code,
    privateKeySecretRef: row.private_key_secret_ref,
    providerCode: row.provider_code,
    providerEnvironment: row.provider_environment,
    storeCode: row.store_code,
    storeId: row.store_id,
    version: row.channel_version,
  };
}

export type PaymentCallbackClaim = Readonly<{
  callbackId: string;
  callbackVersion: number;
  claimed: boolean;
  duplicate: boolean;
  inFlight: boolean;
  inboxId: string;
  inboxVersion: number;
}>;

export function claimVerifiedPaymentCallback(
  client: PrismaClient,
  context: StoreContext,
  input: Readonly<{
    channelId: string;
    environment: 'SANDBOX' | 'PRODUCTION';
    eventDigest: string;
    externalEventId: string;
    payloadDigest: string;
  }>,
): Promise<PaymentCallbackClaim> {
  if (
    !DIGEST_PATTERN.test(input.eventDigest) ||
    !DIGEST_PATTERN.test(input.payloadDigest) ||
    !EVENT_KEY_PATTERN.test(input.externalEventId)
  ) {
    throw new PaymentCallbackError('PAYMENT_CALLBACK_INPUT_INVALID');
  }
  return withStoreTransaction(client, context, async (transaction) => {
    const inbox = await recordInboxMessageInTransaction(transaction, context, {
      channelId: input.channelId,
      environment: input.environment,
      externalMessageKey: input.externalEventId,
      payloadDigest: input.payloadDigest,
      source: 'ZALO_CHECKOUT_ZALOPAY',
    });
    const callbackId = randomUUID();
    const inserted = await transaction.$queryRaw<CallbackRow[]>`
      INSERT INTO provider_callbacks (
        id, store_id, channel_kind, channel_id, provider_code, environment,
        external_event_id, event_digest, signature_status, trust, processing_status,
        payload_digest
      ) VALUES (
        ${callbackId}::uuid, ${context.storeId}::uuid, 'PAYMENT'::integration_channel_kind,
        ${input.channelId}::uuid, 'ZALO_CHECKOUT_ZALOPAY',
        ${input.environment}::integration_environment, ${input.externalEventId},
        ${input.eventDigest}, 'VERIFIED'::callback_signature_status,
        'AUTHENTICATED_FACT'::provider_callback_trust,
        'RECEIVED'::provider_callback_processing_status, ${input.payloadDigest}
      )
      ON CONFLICT DO NOTHING
      RETURNING id, processing_status, version
    `;
    let callback = inserted[0];
    if (!callback) {
      const existing = await transaction.$queryRaw<CallbackRow[]>`
        SELECT id, processing_status, version
        FROM provider_callbacks
        WHERE channel_kind = 'PAYMENT'::integration_channel_kind
          AND channel_id = ${input.channelId}::uuid
          AND environment = ${input.environment}::integration_environment
          AND external_event_id = ${input.externalEventId}
          AND event_digest = ${input.eventDigest}
          AND payload_digest = ${input.payloadDigest}
        LIMIT 1
      `;
      callback = existing[0];
    }
    if (!callback) throw new PaymentCallbackError('PAYMENT_CALLBACK_STATE_CONFLICT');
    let inboxVersion = inbox.message.version;
    let callbackVersion = callback.version;
    let inboxStatus = inbox.message.status;
    if (inboxStatus === 'PROCESSING') {
      if (!callbackLeaseExpired(inbox.message.processingStartedAt)) {
        return {
          callbackId: callback.id,
          callbackVersion,
          claimed: false,
          duplicate: true,
          inFlight: true,
          inboxId: inbox.message.id,
          inboxVersion,
        };
      }
      const reclaimedInbox = await transaction.$executeRaw`
        UPDATE inbox_messages
        SET status = 'RETRY_PENDING'::inbox_status,
            completed_at = NULL,
            error_code = 'PAYMENT_CALLBACK_PROCESSING_TIMEOUT',
            version = version + 1
        WHERE store_id = ${context.storeId}::uuid
          AND id = ${inbox.message.id}::uuid
          AND version = ${inboxVersion}
          AND status = 'PROCESSING'::inbox_status
      `;
      const reclaimedCallback = await transaction.$executeRaw`
        UPDATE provider_callbacks
        SET processing_status = 'RETRY_PENDING'::provider_callback_processing_status,
            next_attempt_at = now(),
            last_error_code = 'PAYMENT_CALLBACK_PROCESSING_TIMEOUT',
            completed_at = NULL,
            version = version + 1
        WHERE store_id = ${context.storeId}::uuid
          AND id = ${callback.id}::uuid
          AND version = ${callbackVersion}
          AND processing_status = 'PROCESSING'::provider_callback_processing_status
      `;
      if (reclaimedInbox !== 1 || reclaimedCallback !== 1) {
        throw new PaymentCallbackError('PAYMENT_CALLBACK_STATE_CONFLICT');
      }
      inboxVersion += 1;
      callbackVersion += 1;
      inboxStatus = 'RETRY_PENDING';
    }
    if (inboxStatus !== 'RECEIVED' && inboxStatus !== 'RETRY_PENDING') {
      return {
        callbackId: callback.id,
        callbackVersion,
        claimed: false,
        duplicate: true,
        inFlight: false,
        inboxId: inbox.message.id,
        inboxVersion,
      };
    }
    const inboxRows = await transaction.$queryRaw<Array<{ id: string; version: number }>>`
      UPDATE inbox_messages
      SET status = 'PROCESSING'::inbox_status,
          processing_started_at = now(),
          completed_at = NULL,
          error_code = NULL,
          version = version + 1
      WHERE store_id = ${context.storeId}::uuid
        AND id = ${inbox.message.id}::uuid
        AND version = ${inboxVersion}
        AND status IN ('RECEIVED'::inbox_status, 'RETRY_PENDING'::inbox_status)
      RETURNING id, version
    `;
    const callbackRows = await transaction.$queryRaw<Array<{ id: string; version: number }>>`
      UPDATE provider_callbacks
      SET processing_status = 'PROCESSING'::provider_callback_processing_status,
          attempt_count = attempt_count + 1,
          next_attempt_at = NULL,
          last_error_code = NULL,
          completed_at = NULL,
          version = version + 1
      WHERE store_id = ${context.storeId}::uuid
        AND id = ${callback.id}::uuid
        AND version = ${callbackVersion}
        AND processing_status IN (
          'RECEIVED'::provider_callback_processing_status,
          'RETRY_PENDING'::provider_callback_processing_status
        )
      RETURNING id, version
    `;
    if (!inboxRows[0] || !callbackRows[0]) {
      throw new PaymentCallbackError('PAYMENT_CALLBACK_STATE_CONFLICT');
    }
    return {
      callbackId: callbackRows[0].id,
      callbackVersion: callbackRows[0].version,
      claimed: true,
      duplicate: inbox.replayed,
      inFlight: false,
      inboxId: inboxRows[0].id,
      inboxVersion: inboxRows[0].version,
    };
  });
}

export function settlePaymentCallback(
  client: PrismaClient,
  context: StoreContext,
  input: Readonly<{
    callbackId: string;
    callbackVersion: number;
    disposition?: 'DEAD_LETTER' | 'REJECTED' | 'RETRY_PENDING';
    errorCode?: string;
    inboxId: string;
    inboxVersion: number;
  }>,
): Promise<void> {
  if (
    (input.disposition === undefined) !== (input.errorCode === undefined) ||
    (input.errorCode !== undefined && !ERROR_CODE_PATTERN.test(input.errorCode))
  ) {
    throw new PaymentCallbackError('PAYMENT_CALLBACK_INPUT_INVALID');
  }
  const callbackStatus = input.disposition ?? 'PROCESSED';
  const inboxStatus =
    callbackStatus === 'PROCESSED'
      ? 'COMPLETED'
      : callbackStatus === 'DEAD_LETTER'
        ? 'DEAD_LETTER'
        : callbackStatus;
  return withStoreTransaction(client, context, async (transaction) => {
    const completedAt = callbackStatus === 'RETRY_PENDING' ? null : new Date();
    const callback = await transaction.$executeRaw`
      UPDATE provider_callbacks
      SET processing_status = ${callbackStatus}::provider_callback_processing_status,
          next_attempt_at = ${callbackStatus === 'RETRY_PENDING' ? new Date() : null},
          last_error_code = ${input.errorCode ?? null},
          completed_at = ${completedAt},
          version = version + 1
      WHERE store_id = ${context.storeId}::uuid
        AND id = ${input.callbackId}::uuid
        AND version = ${input.callbackVersion}
        AND processing_status = 'PROCESSING'::provider_callback_processing_status
    `;
    const inbox = await transaction.$executeRaw`
      UPDATE inbox_messages
      SET status = ${inboxStatus}::inbox_status,
          completed_at = ${completedAt},
          error_code = ${input.errorCode ?? null},
          version = version + 1
      WHERE store_id = ${context.storeId}::uuid
        AND id = ${input.inboxId}::uuid
        AND version = ${input.inboxVersion}
        AND status = 'PROCESSING'::inbox_status
    `;
    if (callback !== 1 || inbox !== 1) {
      const current = await transaction.$queryRaw<
        Array<{ callback_status: CallbackRow['processing_status']; inbox_status: string }>
      >`
        SELECT
          provider.processing_status AS callback_status,
          inbox.status::text AS inbox_status
        FROM provider_callbacks AS provider
        JOIN inbox_messages AS inbox
          ON inbox.store_id = provider.store_id
         AND inbox.channel_id = provider.channel_id
         AND inbox.environment = provider.environment
         AND inbox.external_message_key = provider.external_event_id
        WHERE provider.store_id = ${context.storeId}::uuid
          AND provider.id = ${input.callbackId}::uuid
          AND inbox.id = ${input.inboxId}::uuid
        LIMIT 1
      `;
      const settled = current[0];
      if (settled?.callback_status === callbackStatus && settled.inbox_status === inboxStatus) {
        return;
      }
      throw new PaymentCallbackError('PAYMENT_CALLBACK_STATE_CONFLICT');
    }
  });
}
