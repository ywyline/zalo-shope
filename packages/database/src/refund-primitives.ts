import { createHash, randomUUID } from 'node:crypto';

import { Prisma, type PrismaClient, type RefundStatus } from '@prisma/client';
import {
  assertRefundAmountAllowed,
  PaymentInvariantError,
  transitionRefund,
  type StoreContext,
} from '@zalo-shop/domain';

import { appendOutboxMessageInTransaction, type OutboxMessageRecord } from './reliable-messaging';
import { type StoreTransaction, withStoreTransaction } from './index';
import {
  AFTER_SALE_REFUND_SYNC_EVENT_TYPE,
  AFTER_SALE_REFUND_SYNC_EVENT_VERSION,
} from './after-sale-refund-events';

export const REFUND_CREATE_EVENT_TYPE = 'refund.create.requested';
export const REFUND_QUERY_EVENT_TYPE = 'refund.query.requested';
export const REFUND_QUERY_INITIAL_DELAY_MS = 2 * 60_000;
export const REFUND_QUERY_RETRY_DELAY_MS = 5 * 60_000;
export const REFUND_QUERY_MAX_ATTEMPTS = 8;

export type RefundProviderStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';

export type RefundProviderFact = Readonly<{
  amountVnd: number;
  occurredAt?: Date;
  providerRefundId?: string;
  providerStatus: string;
  status: RefundProviderStatus;
}>;

export type RefundCommandErrorCode =
  | 'PAYMENT_NOT_REFUNDABLE'
  | 'PAYMENT_VERSION_CONFLICT'
  | 'REFUND_AMOUNT_EXCEEDS_AVAILABLE'
  | 'REFUND_AMOUNT_INVALID'
  | 'REFUND_FACT_INVALID'
  | 'REFUND_IDEMPOTENCY_CONFLICT'
  | 'REFUND_NOT_FOUND'
  | 'REFUND_PROVIDER_REFERENCE_MISSING'
  | 'REFUND_STATE_CONFLICT';

export class RefundCommandError extends Error {
  public constructor(public readonly code: RefundCommandErrorCode) {
    super(code);
    this.name = 'RefundCommandError';
  }
}

export type RefundCommandResult = Readonly<{
  amountVnd: number;
  orderId: string;
  paymentAttemptId: string;
  publicRefundNumber: string;
  reason: string;
  refundId: string;
  replayed: boolean;
  requestedAt: Date;
  status: RefundStatus;
  updatedAt: Date;
  version: number;
}>;

export type RefundProviderRequest = Readonly<{
  amountVnd: number;
  channel: Readonly<{
    checkoutAppId: string;
    id: string;
    keyVersion: string;
    methodCode: string;
    privateKeySecretRef: string;
    providerCode: string;
    providerEnvironment: 'SANDBOX' | 'PRODUCTION';
    version: number;
  }>;
  description: string;
  paymentProviderTransactionId: string;
  providerRefundId: string | null;
  publicRefundNumber: string;
  refundId: string;
  status: RefundStatus;
  storeId: string;
  version: number;
}>;

type LockedRefund = Prisma.RefundGetPayload<{
  include: { order: true; paymentAttempt: { include: { channel: true } } };
}>;

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function safePositiveAmount(value: bigint | number): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new RefundCommandError('REFUND_AMOUNT_INVALID');
  }
  return amount;
}

function result(refund: LockedRefund, replayed: boolean): RefundCommandResult {
  return {
    amountVnd: safePositiveAmount(refund.amountVnd),
    orderId: refund.orderId,
    paymentAttemptId: refund.paymentAttemptId,
    publicRefundNumber: refund.publicRefundNumber,
    reason: refund.reason,
    refundId: refund.id,
    replayed,
    requestedAt: refund.requestedAt,
    status: refund.status,
    updatedAt: refund.updatedAt,
    version: refund.version,
  };
}

export async function lockRefundOrderScope(
  transaction: StoreTransaction,
  storeId: string,
  orderId: string,
): Promise<void> {
  await transaction.$executeRaw`
    SELECT pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'm62-refund:' || (${storeId}::uuid)::text || ':' || (${orderId}::uuid)::text,
        0
      )
    )
  `;
}

async function lockPaymentAndRefund(
  transaction: StoreTransaction,
  storeId: string,
  refundId: string,
): Promise<LockedRefund> {
  const identity = await transaction.refund.findFirst({
    select: { orderId: true, paymentAttemptId: true },
    where: { id: refundId, storeId },
  });
  if (!identity) throw new RefundCommandError('REFUND_NOT_FOUND');
  await lockRefundOrderScope(transaction, storeId, identity.orderId);
  await transaction.$queryRaw`
    SELECT id FROM orders
    WHERE store_id = ${storeId}::uuid AND id = ${identity.orderId}::uuid
    FOR UPDATE
  `;
  await transaction.$queryRaw`
    SELECT id FROM payment_attempts
    WHERE store_id = ${storeId}::uuid AND id = ${identity.paymentAttemptId}::uuid
    FOR UPDATE
  `;
  await transaction.$queryRaw`
    SELECT id FROM refunds
    WHERE store_id = ${storeId}::uuid AND id = ${refundId}::uuid
    FOR UPDATE
  `;
  const refund = await transaction.refund.findFirst({
    include: { order: true, paymentAttempt: { include: { channel: true } } },
    where: { id: refundId, storeId },
  });
  if (!refund) throw new RefundCommandError('REFUND_NOT_FOUND');
  return refund;
}

async function appendTransition(
  transaction: StoreTransaction,
  context: StoreContext,
  refund: LockedRefund,
  input: {
    event: string;
    fromStatus: RefundStatus;
    providerEventId?: string;
    reason?: string;
    source: 'ADMIN' | 'QUERY' | 'RECONCILIATION' | 'SYSTEM';
    toStatus: RefundStatus;
  },
): Promise<void> {
  await transaction.refundTransition.create({
    data: {
      actorId: context.actor.id,
      actorType: input.source === 'ADMIN' ? 'ADMIN' : 'SYSTEM',
      correlationId: context.correlationId,
      event: input.event,
      fromStatus: input.fromStatus,
      ...(input.providerEventId ? { providerEventId: input.providerEventId } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      refundId: refund.id,
      source: input.source,
      storeId: context.storeId,
      toStatus: input.toStatus,
    },
  });
}

async function ensureQueryMessage(
  transaction: StoreTransaction,
  context: StoreContext,
  refund: LockedRefund,
): Promise<void> {
  await appendOutboxMessageInTransaction(
    transaction,
    { ...context, storeId: refund.storeId },
    {
      aggregateId: refund.id,
      aggregateType: 'REFUND',
      availableAt: new Date(Date.now() + REFUND_QUERY_INITIAL_DELAY_MS),
      eventType: REFUND_QUERY_EVENT_TYPE,
      eventVersion: 1,
      idempotencyKey: `${REFUND_QUERY_EVENT_TYPE}:${refund.id}`,
      maxAttempts: REFUND_QUERY_MAX_ATTEMPTS,
      payload: { refund_id: refund.id, store_id: refund.storeId },
    },
  );
}

async function ensureAfterSaleRefundSyncMessage(
  transaction: StoreTransaction,
  context: StoreContext,
  refund: LockedRefund,
): Promise<void> {
  const link = await transaction.afterSaleRefund.findFirst({
    select: { afterSaleId: true },
    where: { refundId: refund.id, storeId: refund.storeId },
  });
  if (!link) return;
  await appendOutboxMessageInTransaction(
    transaction,
    { ...context, storeId: refund.storeId },
    {
      aggregateId: refund.id,
      aggregateType: 'REFUND',
      eventType: AFTER_SALE_REFUND_SYNC_EVENT_TYPE,
      eventVersion: AFTER_SALE_REFUND_SYNC_EVENT_VERSION,
      idempotencyKey: `${AFTER_SALE_REFUND_SYNC_EVENT_TYPE}:${refund.id}:${refund.version}`,
      maxAttempts: 8,
      payload: {
        refund_id: refund.id,
        refund_version: refund.version,
        store_id: refund.storeId,
      },
    },
  );
}

export async function createRefundInTransaction(
  transaction: StoreTransaction,
  context: StoreContext,
  input: Readonly<{
    amountVnd: number;
    confirmation: string;
    expectedPaymentVersion: number;
    idempotencyKey: string;
    paymentAttemptId: string;
    reason: string;
  }>,
): Promise<RefundCommandResult> {
  if (
    context.actor.type !== 'admin' ||
    input.confirmation !== 'CREATE_REFUND' ||
    !Number.isSafeInteger(input.amountVnd) ||
    input.amountVnd <= 0 ||
    !Number.isSafeInteger(input.expectedPaymentVersion) ||
    input.expectedPaymentVersion < 1 ||
    input.reason.trim().length < 10 ||
    input.reason.trim().length > 500
  ) {
    throw new RefundCommandError('REFUND_AMOUNT_INVALID');
  }
  const identity = await transaction.paymentAttempt.findFirst({
    select: { orderId: true },
    where: { id: input.paymentAttemptId, storeId: context.storeId },
  });
  if (!identity) throw new RefundCommandError('PAYMENT_NOT_REFUNDABLE');
  await lockRefundOrderScope(transaction, context.storeId, identity.orderId);
  await transaction.$queryRaw`
        SELECT id FROM orders
        WHERE store_id = ${context.storeId}::uuid AND id = ${identity.orderId}::uuid
        FOR UPDATE
      `;
  await transaction.$queryRaw`
        SELECT id FROM payment_attempts
        WHERE store_id = ${context.storeId}::uuid AND id = ${input.paymentAttemptId}::uuid
        FOR UPDATE
      `;
  const payment = await transaction.paymentAttempt.findFirst({
    include: { order: true },
    where: { id: input.paymentAttemptId, storeId: context.storeId },
  });
  if (
    !payment ||
    payment.status !== 'SUCCEEDED' ||
    !payment.providerTransactionId ||
    payment.order.paymentMethod !== 'ONLINE'
  ) {
    throw new RefundCommandError('PAYMENT_NOT_REFUNDABLE');
  }
  const keyHash = digest(`${payment.storeId}\u0000${payment.id}\u0000${input.idempotencyKey}`);
  const replay = await transaction.refund.findUnique({
    include: { order: true, paymentAttempt: { include: { channel: true } } },
    where: {
      storeId_paymentAttemptId_idempotencyKeyHash: {
        idempotencyKeyHash: keyHash,
        paymentAttemptId: payment.id,
        storeId: context.storeId,
      },
    },
  });
  if (replay) {
    if (
      safePositiveAmount(replay.amountVnd) !== input.amountVnd ||
      replay.reason !== input.reason
    ) {
      throw new RefundCommandError('REFUND_IDEMPOTENCY_CONFLICT');
    }
    return result(replay, true);
  }
  if (payment.version !== input.expectedPaymentVersion) {
    throw new RefundCommandError('PAYMENT_VERSION_CONFLICT');
  }
  const totals = await transaction.refund.groupBy({
    by: ['status'],
    where: {
      paymentAttemptId: payment.id,
      status: { in: ['REQUESTED', 'PROCESSING', 'SUCCEEDED', 'REVIEW_REQUIRED'] },
      storeId: context.storeId,
    },
    _sum: { amountVnd: true },
  });
  const amountFor = (statuses: readonly RefundStatus[]) =>
    totals
      .filter((item) => statuses.includes(item.status))
      .reduce((sum, item) => sum + Number(item._sum.amountVnd ?? 0n), 0);
  try {
    assertRefundAmountAllowed({
      capturedAmountVnd: safePositiveAmount(payment.amountVnd),
      inFlightRefundAmountVnd: amountFor(['REQUESTED', 'PROCESSING', 'REVIEW_REQUIRED']),
      requestedAmountVnd: input.amountVnd,
      succeededRefundAmountVnd: amountFor(['SUCCEEDED']),
    });
  } catch (error) {
    if (error instanceof PaymentInvariantError) {
      throw new RefundCommandError(
        error.code === 'REFUND_AMOUNT_EXCEEDS_AVAILABLE'
          ? 'REFUND_AMOUNT_EXCEEDS_AVAILABLE'
          : 'REFUND_AMOUNT_INVALID',
      );
    }
    throw error;
  }
  const id = randomUUID();
  const refund = await transaction.refund.create({
    data: {
      amountVnd: input.amountVnd,
      id,
      idempotencyKeyHash: keyHash,
      orderId: payment.orderId,
      paymentAttemptId: payment.id,
      publicRefundNumber: `RFD-${id.replaceAll('-', '').toUpperCase()}`,
      reason: input.reason,
      requestedBy: context.actor.id,
      status: 'REQUESTED',
      storeId: context.storeId,
    },
    include: { order: true, paymentAttempt: { include: { channel: true } } },
  });
  await transaction.refundTransition.create({
    data: {
      actorId: context.actor.id,
      actorType: 'ADMIN',
      correlationId: context.correlationId,
      event: 'CREATE',
      fromStatus: null,
      reason: input.reason,
      refundId: refund.id,
      source: 'ADMIN',
      storeId: context.storeId,
      toStatus: 'REQUESTED',
    },
  });
  await appendOutboxMessageInTransaction(
    transaction,
    { ...context, storeId: refund.storeId },
    {
      aggregateId: refund.id,
      aggregateType: 'REFUND',
      eventType: REFUND_CREATE_EVENT_TYPE,
      eventVersion: 1,
      idempotencyKey: `${REFUND_CREATE_EVENT_TYPE}:${refund.id}`,
      maxAttempts: 1,
      payload: { refund_id: refund.id, store_id: refund.storeId },
    },
  );
  await transaction.auditLog.create({
    data: {
      action: 'payment.refund.requested',
      actorId: context.actor.id,
      actorType: 'ADMIN',
      afterData: {
        amount_vnd: input.amountVnd,
        payment_attempt_id: payment.id,
        public_refund_number: refund.publicRefundNumber,
        status: refund.status,
      },
      correlationId: context.correlationId,
      reason: input.reason,
      storeId: context.storeId,
      targetId: refund.id,
      targetType: 'refund',
    },
  });
  return result(refund, false);
}

export function createRefundCommand(
  client: PrismaClient,
  context: StoreContext,
  input: Readonly<{
    amountVnd: number;
    confirmation: string;
    expectedPaymentVersion: number;
    idempotencyKey: string;
    paymentAttemptId: string;
    reason: string;
  }>,
): Promise<RefundCommandResult> {
  return withStoreTransaction(
    client,
    context,
    (transaction) => createRefundInTransaction(transaction, context, input),
    { isolationLevel: 'Serializable', timeout: 15_000 },
  );
}

export function getRefundProviderRequest(
  client: PrismaClient,
  context: StoreContext,
  refundId: string,
): Promise<RefundProviderRequest> {
  return withStoreTransaction(client, context, async (transaction) => {
    const refund = await transaction.refund.findFirst({
      include: { paymentAttempt: { include: { channel: true } } },
      where: { id: refundId, storeId: context.storeId },
    });
    if (!refund) throw new RefundCommandError('REFUND_NOT_FOUND');
    if (!refund.paymentAttempt.providerTransactionId) {
      throw new RefundCommandError('PAYMENT_NOT_REFUNDABLE');
    }
    const channel = refund.paymentAttempt.channel;
    return {
      amountVnd: safePositiveAmount(refund.amountVnd),
      channel: {
        checkoutAppId: channel.checkoutAppId,
        id: channel.id,
        keyVersion: channel.keyVersion,
        methodCode: channel.methodCode,
        privateKeySecretRef: channel.privateKeySecretRef,
        providerCode: channel.providerCode,
        providerEnvironment: channel.providerEnvironment,
        version: channel.version,
      },
      description: refund.reason,
      paymentProviderTransactionId: refund.paymentAttempt.providerTransactionId,
      providerRefundId: refund.providerRefundId,
      publicRefundNumber: refund.publicRefundNumber,
      refundId: refund.id,
      status: refund.status,
      storeId: context.storeId,
      version: refund.version,
    };
  });
}

export function applyRefundProviderFact(
  client: PrismaClient,
  context: StoreContext,
  input: Readonly<{
    fact: RefundProviderFact;
    refundId: string;
    source: 'QUERY' | 'RECONCILIATION' | 'SYSTEM';
  }>,
): Promise<RefundCommandResult> {
  return withStoreTransaction(client, context, async (transaction) => {
    const refund = await lockPaymentAndRefund(transaction, context.storeId, input.refundId);
    const invalidFact =
      !Number.isSafeInteger(input.fact.amountVnd) ||
      input.fact.amountVnd !== safePositiveAmount(refund.amountVnd) ||
      (input.fact.status !== 'FAILED' && !input.fact.providerRefundId) ||
      (input.fact.providerRefundId !== undefined && input.fact.providerRefundId.length > 160) ||
      !input.fact.providerStatus ||
      input.fact.providerStatus.length > 64;
    const collision = invalidFact
      ? false
      : input.fact.providerRefundId
        ? (await transaction.refund.findFirst({
            select: { id: true },
            where: {
              id: { not: refund.id },
              providerRefundId: input.fact.providerRefundId,
              storeId: context.storeId,
              paymentAttempt: { channelId: refund.paymentAttempt.channelId },
            },
          })) !== null
        : false;
    const mismatchedReference =
      refund.providerRefundId !== null && refund.providerRefundId !== input.fact.providerRefundId;
    if (invalidFact || collision || mismatchedReference || input.fact.status === 'UNKNOWN') {
      if (refund.status === 'REVIEW_REQUIRED') return result(refund, true);
      if (refund.status === 'SUCCEEDED' || refund.status === 'CANCELLED') {
        throw new RefundCommandError('REFUND_FACT_INVALID');
      }
      const nextStatus = transitionRefund(refund.status, 'REQUIRE_REVIEW');
      const updated = await transaction.refund.update({
        data: {
          providerStatus: input.fact.providerStatus.slice(0, 64) || 'INVALID',
          reviewRequiredAt: new Date(),
          status: nextStatus,
          version: { increment: 1 },
        },
        include: { order: true, paymentAttempt: { include: { channel: true } } },
        where: { storeId_id: { id: refund.id, storeId: context.storeId } },
      });
      await appendTransition(transaction, context, refund, {
        event: 'REQUIRE_REVIEW',
        fromStatus: refund.status,
        reason: 'REFUND_FACT_INVALID',
        source: input.source,
        toStatus: nextStatus,
      });
      await ensureAfterSaleRefundSyncMessage(transaction, context, updated);
      return result(updated, false);
    }
    if (refund.status === 'SUCCEEDED') {
      if (input.fact.status === 'SUCCEEDED') return result(refund, true);
      throw new RefundCommandError('REFUND_STATE_CONFLICT');
    }
    if (refund.status === 'FAILED') {
      if (input.fact.status === 'FAILED') return result(refund, true);
      throw new RefundCommandError('REFUND_STATE_CONFLICT');
    }
    if (refund.status === 'CANCELLED' || refund.status === 'REVIEW_REQUIRED') {
      throw new RefundCommandError('REFUND_STATE_CONFLICT');
    }
    if (refund.status === 'PROCESSING' && input.fact.status === 'PENDING') {
      return result(refund, true);
    }
    const event =
      input.fact.status === 'PENDING'
        ? 'PROVIDER_ACCEPTED'
        : input.fact.status === 'SUCCEEDED'
          ? 'PROVIDER_SUCCEEDED'
          : 'PROVIDER_FAILED';
    const nextStatus = transitionRefund(refund.status, event);
    const now = input.fact.occurredAt ?? new Date();
    let updated: LockedRefund;
    try {
      updated = await transaction.refund.update({
        data: {
          ...(nextStatus === 'SUCCEEDED' ? { succeededAt: now } : {}),
          ...(nextStatus === 'FAILED' ? { failedAt: now } : {}),
          ...(input.fact.providerRefundId ? { providerRefundId: input.fact.providerRefundId } : {}),
          providerStatus: input.fact.providerStatus,
          status: nextStatus,
          version: { increment: 1 },
        },
        include: { order: true, paymentAttempt: { include: { channel: true } } },
        where: { storeId_id: { id: refund.id, storeId: context.storeId } },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new RefundCommandError('REFUND_FACT_INVALID');
      }
      throw error;
    }
    await appendTransition(transaction, context, refund, {
      event,
      fromStatus: refund.status,
      source: input.source,
      toStatus: nextStatus,
    });
    await ensureAfterSaleRefundSyncMessage(transaction, context, updated);
    if (nextStatus === 'PROCESSING') await ensureQueryMessage(transaction, context, updated);
    if (nextStatus === 'SUCCEEDED') {
      const aggregate = await transaction.refund.aggregate({
        where: {
          paymentAttemptId: refund.paymentAttemptId,
          status: 'SUCCEEDED',
          storeId: context.storeId,
        },
        _sum: { amountVnd: true },
      });
      const succeeded = Number(aggregate._sum.amountVnd ?? 0n);
      const captured = safePositiveAmount(refund.paymentAttempt.amountVnd);
      if (!Number.isSafeInteger(succeeded) || succeeded <= 0 || succeeded > captured) {
        throw new RefundCommandError('REFUND_AMOUNT_INVALID');
      }
      await transaction.order.update({
        data: {
          paymentStatus: succeeded === captured ? 'FULLY_REFUNDED' : 'PARTIALLY_REFUNDED',
          version: { increment: 1 },
        },
        where: { storeId_id: { id: refund.orderId, storeId: context.storeId } },
      });
    }
    return result(updated, false);
  });
}

export function markRefundReviewRequired(
  client: PrismaClient,
  context: StoreContext,
  input: Readonly<{ reason: string; refundId: string }>,
): Promise<RefundCommandResult> {
  return withStoreTransaction(client, context, async (transaction) => {
    const refund = await lockPaymentAndRefund(transaction, context.storeId, input.refundId);
    if (refund.status === 'REVIEW_REQUIRED') return result(refund, true);
    if (refund.status === 'SUCCEEDED' || refund.status === 'CANCELLED') {
      throw new RefundCommandError('REFUND_STATE_CONFLICT');
    }
    const nextStatus = transitionRefund(refund.status, 'REQUIRE_REVIEW');
    const updated = await transaction.refund.update({
      data: { reviewRequiredAt: new Date(), status: nextStatus, version: { increment: 1 } },
      include: { order: true, paymentAttempt: { include: { channel: true } } },
      where: { storeId_id: { id: refund.id, storeId: context.storeId } },
    });
    await appendTransition(transaction, context, refund, {
      event: 'REQUIRE_REVIEW',
      fromStatus: refund.status,
      reason: input.reason,
      source: 'SYSTEM',
      toStatus: nextStatus,
    });
    await ensureAfterSaleRefundSyncMessage(transaction, context, updated);
    return result(updated, false);
  });
}

export function requestRefundQuery(
  client: PrismaClient,
  context: StoreContext,
  input: Readonly<{
    expectedVersion: number;
    idempotencyKey: string;
    reason: string;
    refundId: string;
  }>,
): Promise<OutboxMessageRecord> {
  return withStoreTransaction(client, context, async (transaction) => {
    const refund = await lockPaymentAndRefund(transaction, context.storeId, input.refundId);
    if (refund.version !== input.expectedVersion) {
      throw new RefundCommandError('REFUND_STATE_CONFLICT');
    }
    if (refund.status !== 'PROCESSING' || !refund.providerRefundId) {
      throw new RefundCommandError('REFUND_PROVIDER_REFERENCE_MISSING');
    }
    const appended = await appendOutboxMessageInTransaction(
      transaction,
      { ...context, storeId: refund.storeId },
      {
        aggregateId: refund.id,
        aggregateType: 'REFUND',
        eventType: REFUND_QUERY_EVENT_TYPE,
        eventVersion: 1,
        idempotencyKey: `${REFUND_QUERY_EVENT_TYPE}:manual:${digest(`${refund.storeId}\u0000${refund.id}\u0000${input.idempotencyKey}`)}`,
        maxAttempts: REFUND_QUERY_MAX_ATTEMPTS,
        payload: { refund_id: refund.id, store_id: refund.storeId },
      },
    );
    if (!appended.replayed) {
      await transaction.auditLog.create({
        data: {
          action: 'payment.refund.query_requested',
          actorId: context.actor.id,
          actorType: 'ADMIN',
          afterData: { refund_id: refund.id, status: refund.status },
          correlationId: context.correlationId,
          reason: input.reason,
          storeId: context.storeId,
          targetId: appended.message.id,
          targetType: 'outbox_message',
        },
      });
    }
    return appended.message;
  });
}
