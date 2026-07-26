import { createHash } from 'node:crypto';

import type { Prisma, PrismaClient } from '@prisma/client';
import {
  assertPaymentFactMatches,
  PaymentInvariantError,
  transitionOrderStatus,
  transitionPaymentAttempt,
  type PaymentAttemptStatus,
  type StoreContext,
} from '@zalo-shop/domain';

import { consumeReservationInTransaction, InventoryPrimitiveError } from './inventory-primitives';
import { type StoreTransaction, withStoreTransaction } from './index';

export type PaymentProviderStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN';

export type PaymentProviderFact = Readonly<{
  amountVnd: number;
  attemptId: string;
  currency: 'VND';
  occurredAt?: Date;
  orderId: string;
  providerOrderId: string;
  providerStatus: string;
  providerTransactionId?: string;
  status: PaymentProviderStatus;
  storeId: string;
}>;

export type PaymentLaunchAction = Readonly<{
  expiresAt: Date;
  kind: 'ZALO_CHECKOUT_CREATE_ORDER';
  payload: Readonly<{
    amount: number;
    desc: string;
    extradata: string;
    item: readonly Readonly<{ amount: number; id: string }>[];
    mac: string;
    method: string;
  }>;
}>;

export type PaymentTransitionSource =
  'MEMBER' | 'ADMIN' | 'WEBHOOK' | 'QUERY' | 'RECONCILIATION' | 'SYSTEM';

export type PaymentCommandErrorCode =
  | 'PAYMENT_ATTEMPT_NOT_FOUND'
  | 'PAYMENT_ATTEMPT_CONFLICT'
  | 'PAYMENT_FACT_INVALID'
  | 'PAYMENT_LAUNCH_INVALID'
  | 'PAYMENT_PROVIDER_MISMATCH';

export class PaymentCommandError extends Error {
  public constructor(public readonly code: PaymentCommandErrorCode) {
    super(code);
    this.name = 'PaymentCommandError';
  }
}

export type PaymentAttemptResult = Readonly<{
  attemptId: string;
  orderId: string;
  orderStatus: string;
  paymentStatus: string;
  replayed: boolean;
  status: PaymentAttemptStatus;
  version: number;
}>;

export type PaymentCreationRequest = Readonly<{
  amountVnd: number;
  attemptId: string;
  channel: Readonly<{
    id: string;
    providerCode: string;
    providerEnvironment: 'SANDBOX' | 'PRODUCTION';
  }>;
  currency: 'VND';
  description: string;
  expiresAt: Date;
  items: readonly Readonly<{
    amountVnd: number;
    name: string;
    quantity: number;
    skuCode: string;
  }>[];
  orderId: string;
  publicOrderNumber: string;
  status: PaymentAttemptStatus;
  storeId: string;
  version: number;
}>;

type LockedAttempt = Prisma.PaymentAttemptGetPayload<{
  include: { order: true };
}>;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function safeAmount(value: bigint): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new PaymentCommandError('PAYMENT_FACT_INVALID');
  }
  return amount;
}

function actorType(source: PaymentTransitionSource): 'ADMIN' | 'MEMBER' | 'SYSTEM' {
  if (source === 'ADMIN') return 'ADMIN';
  if (source === 'MEMBER') return 'MEMBER';
  return 'SYSTEM';
}

function normalizedLaunchAction(action: PaymentLaunchAction) {
  return {
    expires_at: action.expiresAt.toISOString(),
    kind: action.kind,
    payload: action.payload,
  };
}

export function paymentLaunchPayloadHash(action: PaymentLaunchAction): string {
  return digest(normalizedLaunchAction(action));
}

function launchNonce(action: PaymentLaunchAction): string {
  let extraData: unknown;
  try {
    extraData = JSON.parse(action.payload.extradata);
  } catch {
    throw new PaymentCommandError('PAYMENT_LAUNCH_INVALID');
  }
  if (extraData === null || typeof extraData !== 'object' || Array.isArray(extraData)) {
    throw new PaymentCommandError('PAYMENT_LAUNCH_INVALID');
  }
  const nonce = (extraData as Record<string, unknown>).nonce;
  if (typeof nonce !== 'string' || !/^[0-9a-f]{64}$/u.test(nonce)) {
    throw new PaymentCommandError('PAYMENT_LAUNCH_INVALID');
  }
  return nonce;
}

function assertLaunchMatches(
  request: PaymentCreationRequest,
  action: PaymentLaunchAction,
): Readonly<{ nonceHash: string; payloadHash: string }> {
  if (
    action.kind !== 'ZALO_CHECKOUT_CREATE_ORDER' ||
    action.expiresAt.getTime() !== request.expiresAt.getTime() ||
    action.payload.amount !== request.amountVnd ||
    !action.payload.mac ||
    !action.payload.method
  ) {
    throw new PaymentCommandError('PAYMENT_LAUNCH_INVALID');
  }
  let extraData: unknown;
  try {
    extraData = JSON.parse(action.payload.extradata);
  } catch {
    throw new PaymentCommandError('PAYMENT_LAUNCH_INVALID');
  }
  if (
    extraData === null ||
    typeof extraData !== 'object' ||
    Array.isArray(extraData) ||
    (extraData as Record<string, unknown>).attempt_id !== request.attemptId ||
    (extraData as Record<string, unknown>).order_id !== request.orderId ||
    (extraData as Record<string, unknown>).store_id !== request.storeId
  ) {
    throw new PaymentCommandError('PAYMENT_LAUNCH_INVALID');
  }
  return { nonceHash: digest(launchNonce(action)), payloadHash: paymentLaunchPayloadHash(action) };
}

async function lockAttemptAndOrder(
  transaction: StoreTransaction,
  storeId: string,
  attemptId: string,
): Promise<LockedAttempt> {
  const identity = await transaction.paymentAttempt.findFirst({
    select: { orderId: true },
    where: { id: attemptId, storeId },
  });
  if (!identity) throw new PaymentCommandError('PAYMENT_ATTEMPT_NOT_FOUND');
  const orders = await transaction.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM orders
    WHERE store_id = ${storeId}::uuid AND id = ${identity.orderId}::uuid
    FOR UPDATE
  `;
  if (orders.length !== 1) throw new PaymentCommandError('PAYMENT_ATTEMPT_NOT_FOUND');
  const attempts = await transaction.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM payment_attempts
    WHERE store_id = ${storeId}::uuid AND id = ${attemptId}::uuid
    FOR UPDATE
  `;
  if (attempts.length !== 1) throw new PaymentCommandError('PAYMENT_ATTEMPT_NOT_FOUND');
  const attempt = await transaction.paymentAttempt.findFirst({
    include: { order: true },
    where: { id: attemptId, storeId },
  });
  if (!attempt) throw new PaymentCommandError('PAYMENT_ATTEMPT_NOT_FOUND');
  return attempt;
}

function attemptResult(attempt: LockedAttempt, replayed: boolean): PaymentAttemptResult {
  return {
    attemptId: attempt.id,
    orderId: attempt.orderId,
    orderStatus: attempt.order.status,
    paymentStatus: attempt.order.paymentStatus,
    replayed,
    status: attempt.status,
    version: attempt.version,
  };
}

export function getPaymentCreationRequest(
  client: PrismaClient,
  context: StoreContext,
  attemptId: string,
): Promise<PaymentCreationRequest> {
  return withStoreTransaction(client, context, async (transaction) => {
    const attempt = await transaction.paymentAttempt.findFirst({
      include: {
        channel: true,
        order: { include: { items: { orderBy: { id: 'asc' } } } },
      },
      where: { id: attemptId, storeId: context.storeId },
    });
    if (!attempt) throw new PaymentCommandError('PAYMENT_ATTEMPT_NOT_FOUND');
    return {
      amountVnd: safeAmount(attempt.amountVnd),
      attemptId: attempt.id,
      channel: {
        id: attempt.channel.id,
        providerCode: attempt.channel.providerCode,
        providerEnvironment: attempt.channel.providerEnvironment,
      },
      currency: 'VND',
      description: `Thanh toan ${attempt.order.orderNumber}`,
      expiresAt: attempt.expiresAt,
      items: attempt.order.items.map((item) => ({
        amountVnd: Number(item.unitPriceVnd),
        name: item.productName,
        quantity: item.quantity,
        skuCode: item.skuCode,
      })),
      orderId: attempt.orderId,
      publicOrderNumber: attempt.order.orderNumber,
      status: attempt.status,
      storeId: context.storeId,
      version: attempt.version,
    };
  });
}

export function recordPaymentLaunch(
  client: PrismaClient,
  context: StoreContext,
  input: Readonly<{
    action: PaymentLaunchAction;
    attemptId: string;
    providerOrderId?: string;
    providerStatus?: string;
  }>,
): Promise<PaymentAttemptResult> {
  return withStoreTransaction(client, context, async (transaction) => {
    const attempt = await lockAttemptAndOrder(transaction, context.storeId, input.attemptId);
    const request = await getPaymentCreationRequestFromLocked(transaction, attempt);
    const hashes = assertLaunchMatches(request, input.action);
    if (
      attempt.launchNonceHash === hashes.nonceHash &&
      attempt.launchPayloadHash === hashes.payloadHash &&
      (input.providerOrderId === undefined || attempt.providerOrderId === input.providerOrderId)
    ) {
      return attemptResult(attempt, true);
    }
    if (
      attempt.launchNonceHash !== null ||
      attempt.launchPayloadHash !== null ||
      (attempt.providerOrderId !== null && attempt.providerOrderId !== input.providerOrderId)
    ) {
      throw new PaymentCommandError('PAYMENT_ATTEMPT_CONFLICT');
    }
    const accepted = input.providerOrderId !== undefined && attempt.status === 'CREATED';
    const nextStatus = accepted
      ? transitionPaymentAttempt(attempt.status, 'PROVIDER_ACCEPTED')
      : attempt.status;
    const updated = await transaction.paymentAttempt.update({
      data: {
        launchNonceHash: hashes.nonceHash,
        launchPayloadHash: hashes.payloadHash,
        ...(input.providerOrderId ? { providerOrderId: input.providerOrderId } : {}),
        ...(input.providerStatus ? { providerStatus: input.providerStatus } : {}),
        status: nextStatus,
        version: { increment: 1 },
      },
      include: { order: true },
      where: { storeId_id: { id: attempt.id, storeId: context.storeId } },
    });
    if (accepted) {
      await transaction.paymentTransition.create({
        data: {
          actorId: context.actor.id,
          actorType: 'SYSTEM',
          correlationId: context.correlationId,
          event: 'PROVIDER_ACCEPTED',
          fromStatus: attempt.status,
          paymentAttemptId: attempt.id,
          source: 'SYSTEM',
          storeId: context.storeId,
          toStatus: nextStatus,
        },
      });
      await transaction.order.update({
        data: { paymentStatus: 'PROCESSING', version: { increment: 1 } },
        where: { storeId_id: { id: attempt.orderId, storeId: context.storeId } },
      });
      updated.order.paymentStatus = 'PROCESSING';
      updated.order.version += 1;
    }
    return attemptResult(updated, false);
  });
}

async function getPaymentCreationRequestFromLocked(
  transaction: StoreTransaction,
  attempt: LockedAttempt,
): Promise<PaymentCreationRequest> {
  const complete = await transaction.paymentAttempt.findFirst({
    include: {
      channel: true,
      order: { include: { items: { orderBy: { id: 'asc' } } } },
    },
    where: { id: attempt.id, storeId: attempt.storeId },
  });
  if (!complete) throw new PaymentCommandError('PAYMENT_ATTEMPT_NOT_FOUND');
  return {
    amountVnd: safeAmount(complete.amountVnd),
    attemptId: complete.id,
    channel: {
      id: complete.channel.id,
      providerCode: complete.channel.providerCode,
      providerEnvironment: complete.channel.providerEnvironment,
    },
    currency: 'VND',
    description: `Thanh toan ${complete.order.orderNumber}`,
    expiresAt: complete.expiresAt,
    items: complete.order.items.map((item) => ({
      amountVnd: Number(item.unitPriceVnd),
      name: item.productName,
      quantity: item.quantity,
      skuCode: item.skuCode,
    })),
    orderId: complete.orderId,
    publicOrderNumber: complete.order.orderNumber,
    status: complete.status,
    storeId: complete.storeId,
    version: complete.version,
  };
}

async function transitionAttempt(
  transaction: StoreTransaction,
  context: StoreContext,
  attempt: LockedAttempt,
  input: Readonly<{
    event: string;
    fact: PaymentProviderFact;
    nextStatus: PaymentAttemptStatus;
    providerEventId?: string;
    reason?: string;
    source: PaymentTransitionSource;
  }>,
): Promise<LockedAttempt> {
  const now = input.fact.occurredAt ?? new Date();
  const updated = await transaction.paymentAttempt.update({
    data: {
      ...(input.nextStatus === 'SUCCEEDED' ? { succeededAt: now } : {}),
      ...(input.nextStatus === 'FAILED' ? { failedAt: now } : {}),
      ...(input.nextStatus === 'CANCELLED' ? { cancelledAt: now } : {}),
      ...(input.nextStatus === 'EXPIRED' ? { expiredAt: now } : {}),
      ...(input.nextStatus === 'REVIEW_REQUIRED' ? { reviewRequiredAt: new Date() } : {}),
      providerOccurredAt: input.fact.occurredAt,
      providerOrderId: input.fact.providerOrderId,
      providerStatus: input.fact.providerStatus,
      ...(input.fact.providerTransactionId
        ? { providerTransactionId: input.fact.providerTransactionId }
        : {}),
      status: input.nextStatus,
      version: { increment: 1 },
    },
    include: { order: true },
    where: { storeId_id: { id: attempt.id, storeId: context.storeId } },
  });
  await transaction.paymentTransition.create({
    data: {
      actorId: context.actor.id,
      actorType: actorType(input.source),
      correlationId: context.correlationId,
      event: input.event,
      fromStatus: attempt.status,
      paymentAttemptId: attempt.id,
      ...(input.providerEventId ? { providerEventId: input.providerEventId } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      source: input.source,
      storeId: context.storeId,
      toStatus: input.nextStatus,
    },
  });
  return updated;
}

async function requireReview(
  transaction: StoreTransaction,
  context: StoreContext,
  attempt: LockedAttempt,
  input: Readonly<{
    event: 'LATE_SUCCESS' | 'REQUIRE_REVIEW';
    fact: PaymentProviderFact;
    providerEventId?: string;
    reason: string;
    source: PaymentTransitionSource;
  }>,
): Promise<PaymentAttemptResult> {
  if (attempt.status === 'REVIEW_REQUIRED') return attemptResult(attempt, true);
  if (attempt.status === 'SUCCEEDED') {
    throw new PaymentCommandError('PAYMENT_ATTEMPT_CONFLICT');
  }
  const nextStatus = transitionPaymentAttempt(attempt.status, input.event);
  const updated = await transitionAttempt(transaction, context, attempt, {
    ...input,
    nextStatus,
  });
  return attemptResult(updated, false);
}

function expectedFact(attempt: LockedAttempt) {
  if (!attempt.providerOrderId) throw new PaymentCommandError('PAYMENT_FACT_INVALID');
  return {
    amountVnd: safeAmount(attempt.amountVnd),
    attemptId: attempt.id,
    currency: attempt.currency,
    orderId: attempt.orderId,
    providerOrderId: attempt.providerOrderId,
    storeId: attempt.storeId,
  };
}

function paymentEvent(status: Exclude<PaymentProviderStatus, 'UNKNOWN'>) {
  if (status === 'PENDING') return 'PROVIDER_ACCEPTED' as const;
  if (status === 'SUCCEEDED') return 'PROVIDER_SUCCEEDED' as const;
  if (status === 'FAILED') return 'PROVIDER_FAILED' as const;
  return 'CANCEL' as const;
}

export function applyPaymentProviderFact(
  client: PrismaClient,
  context: StoreContext,
  input: Readonly<{
    attemptId: string;
    fact: PaymentProviderFact;
    providerEventId?: string;
    source: PaymentTransitionSource;
  }>,
): Promise<PaymentAttemptResult> {
  return withStoreTransaction(client, context, async (transaction) => {
    const attempt = await lockAttemptAndOrder(transaction, context.storeId, input.attemptId);
    try {
      assertPaymentFactMatches(expectedFact(attempt), input.fact);
    } catch (error) {
      if (error instanceof PaymentInvariantError && attempt.status !== 'SUCCEEDED') {
        return requireReview(transaction, context, attempt, {
          event: 'REQUIRE_REVIEW',
          fact: {
            ...input.fact,
            providerOrderId: attempt.providerOrderId!,
            providerTransactionId: undefined,
          },
          ...(input.providerEventId ? { providerEventId: input.providerEventId } : {}),
          reason: error.code,
          source: input.source,
        });
      }
      throw new PaymentCommandError('PAYMENT_FACT_INVALID');
    }

    if (attempt.status === 'SUCCEEDED') {
      if (
        input.fact.status === 'SUCCEEDED' &&
        input.fact.providerTransactionId === attempt.providerTransactionId
      ) {
        return attemptResult(attempt, true);
      }
      throw new PaymentCommandError('PAYMENT_ATTEMPT_CONFLICT');
    }
    if (attempt.status === 'REVIEW_REQUIRED') return attemptResult(attempt, true);
    if (
      input.fact.status === 'SUCCEEDED' &&
      (attempt.status === 'FAILED' ||
        attempt.status === 'EXPIRED' ||
        attempt.status === 'CANCELLED')
    ) {
      return requireReview(transaction, context, attempt, {
        event: 'LATE_SUCCESS',
        fact: input.fact,
        ...(input.providerEventId ? { providerEventId: input.providerEventId } : {}),
        reason: 'PAYMENT_LATE_SUCCESS',
        source: input.source,
      });
    }
    if (
      attempt.status === 'FAILED' ||
      attempt.status === 'EXPIRED' ||
      attempt.status === 'CANCELLED'
    ) {
      return attemptResult(attempt, true);
    }
    if (input.fact.status === 'UNKNOWN') {
      return requireReview(transaction, context, attempt, {
        event: 'REQUIRE_REVIEW',
        fact: input.fact,
        ...(input.providerEventId ? { providerEventId: input.providerEventId } : {}),
        reason: 'PAYMENT_PROVIDER_STATUS_UNKNOWN',
        source: input.source,
      });
    }
    if (input.fact.status === 'SUCCEEDED' && !input.fact.providerTransactionId) {
      return requireReview(transaction, context, attempt, {
        event: 'REQUIRE_REVIEW',
        fact: input.fact,
        ...(input.providerEventId ? { providerEventId: input.providerEventId } : {}),
        reason: 'PAYMENT_TRANSACTION_REFERENCE_MISSING',
        source: input.source,
      });
    }

    if (input.fact.status !== 'SUCCEEDED') {
      const event = paymentEvent(input.fact.status);
      if (event === 'PROVIDER_ACCEPTED' && attempt.status === 'PROVIDER_PENDING') {
        return attemptResult(attempt, true);
      }
      const nextStatus = transitionPaymentAttempt(attempt.status, event);
      const updated = await transitionAttempt(transaction, context, attempt, {
        event,
        fact: input.fact,
        nextStatus,
        ...(input.providerEventId ? { providerEventId: input.providerEventId } : {}),
        source: input.source,
      });
      const paymentStatus =
        input.fact.status === 'PENDING'
          ? 'PROCESSING'
          : input.fact.status === 'FAILED'
            ? 'FAILED'
            : 'CANCELLED';
      const order = await transaction.order.update({
        data: { paymentStatus, version: { increment: 1 } },
        where: { storeId_id: { id: attempt.orderId, storeId: context.storeId } },
      });
      updated.order.paymentStatus = order.paymentStatus;
      updated.order.version = order.version;
      return attemptResult(updated, false);
    }

    if (
      attempt.order.paymentMethod !== 'ONLINE' ||
      attempt.order.status !== 'PENDING_PAYMENT' ||
      !attempt.order.reservationId ||
      attempt.expiresAt.getTime() <= Date.now()
    ) {
      return requireReview(transaction, context, attempt, {
        event: 'REQUIRE_REVIEW',
        fact: input.fact,
        ...(input.providerEventId ? { providerEventId: input.providerEventId } : {}),
        reason: 'PAYMENT_ORDER_NOT_PAYABLE',
        source: input.source,
      });
    }
    try {
      await consumeReservationInTransaction(
        transaction,
        context,
        attempt.order.reservationId,
        `m54-payment-consume-${attempt.id}`,
      );
    } catch (error) {
      if (error instanceof InventoryPrimitiveError) {
        return requireReview(transaction, context, attempt, {
          event: 'REQUIRE_REVIEW',
          fact: input.fact,
          ...(input.providerEventId ? { providerEventId: input.providerEventId } : {}),
          reason: error.code,
          source: input.source,
        });
      }
      throw error;
    }
    const succeeded = await transitionAttempt(transaction, context, attempt, {
      event: 'PROVIDER_SUCCEEDED',
      fact: input.fact,
      nextStatus: transitionPaymentAttempt(attempt.status, 'PROVIDER_SUCCEEDED'),
      ...(input.providerEventId ? { providerEventId: input.providerEventId } : {}),
      source: input.source,
    });
    const confirmed = transitionOrderStatus(attempt.order.status, 'PAYMENT_SUCCEEDED');
    const fulfillment = transitionOrderStatus(confirmed, 'FULFILLMENT_READY');
    const now = input.fact.occurredAt ?? new Date();
    const order = await transaction.order.update({
      data: {
        confirmedAt: now,
        paymentStatus: 'SUCCEEDED',
        status: fulfillment,
        version: { increment: 1 },
      },
      where: { storeId_id: { id: attempt.orderId, storeId: context.storeId } },
    });
    const transitionCreatedAt = new Date();
    await transaction.orderTransition.createMany({
      data: [
        {
          actorId: context.actor.id,
          actorType: actorType(input.source),
          correlationId: context.correlationId,
          createdAt: transitionCreatedAt,
          event: 'PAYMENT_SUCCEEDED',
          fromStatus: attempt.order.status,
          orderId: attempt.orderId,
          storeId: context.storeId,
          toStatus: confirmed,
        },
        {
          actorId: context.actor.id,
          actorType: actorType(input.source),
          correlationId: context.correlationId,
          createdAt: new Date(transitionCreatedAt.getTime() + 1),
          event: 'FULFILLMENT_READY',
          fromStatus: confirmed,
          orderId: attempt.orderId,
          storeId: context.storeId,
          toStatus: fulfillment,
        },
      ],
    });
    succeeded.order.status = order.status;
    succeeded.order.paymentStatus = order.paymentStatus;
    succeeded.order.version = order.version;
    return attemptResult(succeeded, false);
  });
}

export async function terminateActivePaymentAttemptsInTransaction(
  transaction: StoreTransaction,
  context: StoreContext,
  input: Readonly<{
    orderId: string;
    reason: string;
    source: PaymentTransitionSource;
    target: 'CANCELLED' | 'EXPIRED';
  }>,
): Promise<number> {
  const rows = await transaction.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM payment_attempts
    WHERE store_id = ${context.storeId}::uuid
      AND order_id = ${input.orderId}::uuid
      AND status IN ('CREATED', 'PROVIDER_PENDING')
    ORDER BY attempt_sequence
    FOR UPDATE
  `;
  const event = input.target === 'EXPIRED' ? 'EXPIRE' : 'CANCEL';
  const now = new Date();
  for (const row of rows) {
    const attempt = await transaction.paymentAttempt.findFirst({
      where: { id: row.id, storeId: context.storeId },
    });
    if (!attempt) continue;
    const nextStatus = transitionPaymentAttempt(attempt.status, event);
    await transaction.paymentAttempt.update({
      data: {
        ...(input.target === 'EXPIRED' ? { expiredAt: now } : { cancelledAt: now }),
        status: nextStatus,
        version: { increment: 1 },
      },
      where: { storeId_id: { id: attempt.id, storeId: context.storeId } },
    });
    await transaction.paymentTransition.create({
      data: {
        actorId: context.actor.id,
        actorType: actorType(input.source),
        correlationId: context.correlationId,
        event,
        fromStatus: attempt.status,
        paymentAttemptId: attempt.id,
        reason: input.reason,
        source: input.source,
        storeId: context.storeId,
        toStatus: nextStatus,
      },
    });
  }
  return rows.length;
}
