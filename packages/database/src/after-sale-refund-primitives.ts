import { createHash, randomUUID } from 'node:crypto';

import { Prisma, type PrismaClient } from '@prisma/client';
import {
  AFTER_SALE_EVIDENCE_SYSTEM_ACTOR_ID,
  AfterSaleInvariantError,
  transitionAfterSaleOnlineRefundRequested,
  type AfterSaleStatus,
  type StoreContext,
} from '@zalo-shop/domain';

import {
  createRefundInTransaction,
  lockRefundOrderScope,
  RefundCommandError,
  type RefundCommandResult,
} from './refund-primitives';
import { type StoreTransaction, withStoreTransaction } from './index';
import { appendOutboxMessageInTransaction } from './reliable-messaging';
import {
  AFTER_SALE_REFUND_SYNC_EVENT_TYPE,
  AFTER_SALE_REFUND_SYNC_EVENT_VERSION,
} from './after-sale-refund-events';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_PATTERN = /^[!-~]{16,128}$/;
const SERIALIZATION_RETRY_LIMIT = 3;

export type AfterSaleRefundCommandErrorCode =
  | 'AFTER_SALE_INPUT_INVALID'
  | 'AFTER_SALE_AUTHORIZATION_DENIED'
  | 'AFTER_SALE_NOT_FOUND'
  | 'AFTER_SALE_IDEMPOTENCY_CONFLICT'
  | 'AFTER_SALE_VERSION_CONFLICT'
  | 'AFTER_SALE_STATE_CONFLICT'
  | 'AFTER_SALE_PAYMENT_NOT_PROVEN'
  | 'AFTER_SALE_REFUND_FACT_INVALID';

export class AfterSaleRefundCommandError extends Error {
  public constructor(public readonly code: AfterSaleRefundCommandErrorCode) {
    super(code);
    this.name = 'AfterSaleRefundCommandError';
  }
}

export type AfterSaleRefundCommandResult = Readonly<{
  afterSaleId: string;
  operationId: string;
  publicCaseNumber: string;
  refundId: string;
  replayed: boolean;
  settlementId: string;
  status: AfterSaleStatus;
  version: number;
}>;

type RefundCommandInput = Readonly<{
  afterSaleId: string;
  expectedVersion: number;
  idempotencyKey: string;
  reason: string;
}>;

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function requestHash(
  context: StoreContext,
  input: RefundCommandInput,
  idempotencyKeyHash: string,
): string {
  return digest(
    JSON.stringify({
      actor_id: context.actor.id,
      actor_type: context.actor.type,
      after_sale_id: input.afterSaleId,
      expected_version: input.expectedVersion,
      idempotency_key_hash: idempotencyKeyHash,
      operation: 'ADMIN_ONLINE_REFUND',
      path: `/v1/admin/after-sales/${input.afterSaleId}/refund`,
      reason_hash: digest(input.reason),
      store_id: context.storeId,
    }),
  );
}

function amount(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new AfterSaleRefundCommandError('AFTER_SALE_REFUND_FACT_INVALID');
  }
  return result;
}

function mapCommandError(error: unknown): never {
  if (error instanceof AfterSaleRefundCommandError) throw error;
  if (error instanceof AfterSaleInvariantError) {
    throw new AfterSaleRefundCommandError('AFTER_SALE_STATE_CONFLICT');
  }
  if (error instanceof RefundCommandError) {
    if (error.code === 'PAYMENT_VERSION_CONFLICT') {
      throw new AfterSaleRefundCommandError('AFTER_SALE_VERSION_CONFLICT');
    }
    if (error.code === 'REFUND_IDEMPOTENCY_CONFLICT') {
      throw new AfterSaleRefundCommandError('AFTER_SALE_IDEMPOTENCY_CONFLICT');
    }
    if (
      error.code === 'PAYMENT_NOT_REFUNDABLE' ||
      error.code === 'REFUND_AMOUNT_EXCEEDS_AVAILABLE' ||
      error.code === 'REFUND_AMOUNT_INVALID'
    ) {
      throw new AfterSaleRefundCommandError('AFTER_SALE_PAYMENT_NOT_PROVEN');
    }
    throw new AfterSaleRefundCommandError('AFTER_SALE_REFUND_FACT_INVALID');
  }
  const meta =
    error instanceof Prisma.PrismaClientKnownRequestError
      ? (error.meta as { code?: unknown } | undefined)
      : undefined;
  if (meta?.code === '42501') {
    throw new AfterSaleRefundCommandError('AFTER_SALE_AUTHORIZATION_DENIED');
  }
  throw error;
}

function isSerializationConflict(error: unknown): boolean {
  return (
    (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') ||
    (error instanceof Error && error.message.includes('40001'))
  );
}

function result(
  sale: { id: string; publicCaseNumber: string; status: AfterSaleStatus; version: number },
  settlementId: string,
  refundId: string,
  replayed: boolean,
): AfterSaleRefundCommandResult {
  return {
    afterSaleId: sale.id,
    operationId: settlementId,
    publicCaseNumber: sale.publicCaseNumber,
    refundId,
    replayed,
    settlementId,
    status: sale.status,
    version: sale.version,
  };
}

const REQUIRED_REFUND_PERMISSION_CODES = [
  'store.after-sales.read',
  'store.after-sales.review',
  'store.refunds.create',
  'store.refunds.read',
] as const;

async function assertRefundAuthorization(
  transaction: StoreTransaction,
  context: StoreContext,
): Promise<void> {
  if (
    context.actor.type !== 'admin' ||
    context.adminAuthorizationScope !== 'STORE' ||
    !context.accessSessionId ||
    !context.accessTokenExpiresAt
  ) {
    throw new AfterSaleRefundCommandError('AFTER_SALE_AUTHORIZATION_DENIED');
  }
  const authorization = await transaction.$queryRaw<Array<{ session_expires_at: Date }>>`
    SELECT session.expires_at AS session_expires_at
    FROM stores store
    JOIN admin_users admin ON admin.id = ${context.actor.id}::uuid
    JOIN admin_sessions session
      ON session.id = ${context.accessSessionId}::uuid
      AND session.admin_user_id = admin.id
    WHERE store.id = ${context.storeId}::uuid
      AND store.status = 'ACTIVE'
      AND admin.status = 'ACTIVE'
      AND session.revoked_at IS NULL
      AND session.expires_at > pg_catalog.clock_timestamp()
      AND session.mfa_verified_at >= pg_catalog.clock_timestamp() - INTERVAL '10 minutes'
      AND ${context.accessTokenExpiresAt}::timestamptz > pg_catalog.clock_timestamp()
    FOR SHARE OF store, admin, session
  `;
  if (authorization.length !== 1) {
    throw new AfterSaleRefundCommandError('AFTER_SALE_AUTHORIZATION_DENIED');
  }
  const permissions = await transaction.$queryRaw<Array<{ permission_code: string }>>`
    SELECT role_permission.permission_code
    FROM admin_store_roles assignment
    JOIN store_role_permissions role_permission
      ON role_permission.store_id = assignment.store_id
      AND role_permission.role_id = assignment.role_id
    WHERE assignment.store_id = ${context.storeId}::uuid
      AND assignment.admin_user_id = ${context.actor.id}::uuid
      AND role_permission.permission_code IN (
        'store.after-sales.read',
        'store.after-sales.review',
        'store.refunds.create',
        'store.refunds.read'
      )
    ORDER BY assignment.role_id, role_permission.permission_code
    FOR SHARE OF assignment, role_permission
  `;
  const granted = new Set(permissions.map(({ permission_code }) => permission_code));
  if (REQUIRED_REFUND_PERMISSION_CODES.some((permission) => !granted.has(permission))) {
    throw new AfterSaleRefundCommandError('AFTER_SALE_AUTHORIZATION_DENIED');
  }
  const finalAuthorization = await transaction.$queryRaw<Array<{ id: string }>>`
    SELECT session.id
    FROM admin_sessions session
    WHERE session.id = ${context.accessSessionId}::uuid
      AND session.admin_user_id = ${context.actor.id}::uuid
      AND session.revoked_at IS NULL
      AND session.expires_at > pg_catalog.clock_timestamp()
      AND session.mfa_verified_at >= pg_catalog.clock_timestamp() - INTERVAL '10 minutes'
      AND ${context.accessTokenExpiresAt}::timestamptz > pg_catalog.clock_timestamp()
    FOR SHARE OF session
  `;
  if (finalAuthorization.length !== 1) {
    throw new AfterSaleRefundCommandError('AFTER_SALE_AUTHORIZATION_DENIED');
  }
}

async function requestOnlineRefundInTransaction(
  transaction: StoreTransaction,
  context: StoreContext,
  input: RefundCommandInput,
): Promise<AfterSaleRefundCommandResult> {
  const normalizedReason = input.reason.trim();
  if (
    context.actor.type !== 'admin' ||
    !UUID_PATTERN.test(input.afterSaleId) ||
    !IDEMPOTENCY_PATTERN.test(input.idempotencyKey) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1 ||
    normalizedReason.length < 10 ||
    normalizedReason.length > 500
  ) {
    throw new AfterSaleRefundCommandError('AFTER_SALE_INPUT_INVALID');
  }

  const idempotencyKeyHash = digest(input.idempotencyKey);
  const hash = requestHash(context, { ...input, reason: normalizedReason }, idempotencyKeyHash);
  await transaction.$executeRaw`
    SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      ${`m63-b6:${context.storeId}:${input.afterSaleId}:${idempotencyKeyHash}`}, 0
    ))
  `;
  const identity = await transaction.afterSale.findFirst({
    select: { orderId: true },
    where: { id: input.afterSaleId, storeId: context.storeId },
  });
  if (!identity) throw new AfterSaleRefundCommandError('AFTER_SALE_NOT_FOUND');
  await lockRefundOrderScope(transaction, context.storeId, identity.orderId);
  await transaction.$queryRaw`
    SELECT id FROM orders
    WHERE store_id = ${context.storeId}::uuid AND id = ${identity.orderId}::uuid
    FOR UPDATE
  `;
  await transaction.$queryRaw`
    SELECT id FROM payment_attempts
    WHERE store_id = ${context.storeId}::uuid AND order_id = ${identity.orderId}::uuid
      AND status = 'SUCCEEDED'
    ORDER BY id
    FOR UPDATE
  `;
  await transaction.$queryRaw`
    SELECT id FROM after_sales
    WHERE store_id = ${context.storeId}::uuid AND id = ${input.afterSaleId}::uuid
    FOR UPDATE
  `;
  await assertRefundAuthorization(transaction, context);
  const sale = await transaction.afterSale.findFirst({
    include: { order: true },
    where: { id: input.afterSaleId, storeId: context.storeId },
  });
  if (!sale) throw new AfterSaleRefundCommandError('AFTER_SALE_NOT_FOUND');

  const existing = await transaction.afterSaleSettlement.findUnique({
    include: { refunds: true },
    where: {
      storeId_method_idempotencyKeyHash: {
        idempotencyKeyHash,
        method: 'ONLINE_ORIGINAL',
        storeId: context.storeId,
      },
    },
  });
  if (existing) {
    const link = existing.refunds[0];
    if (
      existing.afterSaleId !== sale.id ||
      existing.amountVnd !== sale.approvedTotalVnd ||
      existing.orderId !== sale.orderId ||
      existing.paymentAttemptId === null ||
      existing.requestHash !== hash ||
      existing.refunds.length !== 1 ||
      !link ||
      link.afterSaleId !== sale.id ||
      link.amountVnd !== existing.amountVnd ||
      link.orderId !== existing.orderId ||
      link.paymentAttemptId !== existing.paymentAttemptId
    ) {
      throw new AfterSaleRefundCommandError('AFTER_SALE_IDEMPOTENCY_CONFLICT');
    }
    const refund = await transaction.refund.findFirst({
      select: { id: true, version: true },
      where: {
        amountVnd: existing.amountVnd,
        id: link.refundId,
        orderId: existing.orderId,
        paymentAttemptId: existing.paymentAttemptId,
        storeId: context.storeId,
      },
    });
    if (!refund) throw new AfterSaleRefundCommandError('AFTER_SALE_REFUND_FACT_INVALID');
    await appendOutboxMessageInTransaction(transaction, context, {
      aggregateId: refund.id,
      aggregateType: 'REFUND',
      eventType: AFTER_SALE_REFUND_SYNC_EVENT_TYPE,
      eventVersion: AFTER_SALE_REFUND_SYNC_EVENT_VERSION,
      idempotencyKey: `${AFTER_SALE_REFUND_SYNC_EVENT_TYPE}:${refund.id}:${refund.version}`,
      payload: {
        refund_id: refund.id,
        refund_version: refund.version,
        store_id: context.storeId,
      },
    });
    return result(sale, existing.id, refund.id, true);
  }

  if (sale.version !== input.expectedVersion) {
    throw new AfterSaleRefundCommandError('AFTER_SALE_VERSION_CONFLICT');
  }
  if (sale.order.paymentMethod !== 'ONLINE' || sale.order.paymentStatus !== 'SUCCEEDED') {
    throw new AfterSaleRefundCommandError('AFTER_SALE_PAYMENT_NOT_PROVEN');
  }

  const payments = await transaction.paymentAttempt.findMany({
    orderBy: [{ succeededAt: 'desc' }, { id: 'asc' }],
    where: { orderId: sale.orderId, status: 'SUCCEEDED', storeId: context.storeId },
  });
  if (payments.length !== 1 || payments[0]!.orderId !== sale.orderId) {
    throw new AfterSaleRefundCommandError('AFTER_SALE_PAYMENT_NOT_PROVEN');
  }
  const payment = payments[0]!;
  const refundAmountVnd = amount(sale.approvedTotalVnd);
  const settlementId = randomUUID();
  const transition = transitionAfterSaleOnlineRefundRequested(sale.type, sale.status);
  let currentStatus = sale.status;
  const appendAfterSaleTransition = async (event: 'QUEUE_REFUND' | 'REFUND_REQUESTED') => {
    const nextStatus: AfterSaleStatus =
      event === 'QUEUE_REFUND' ? 'REFUND_PENDING' : 'REFUND_PROCESSING';
    await transaction.afterSaleTransition.create({
      data: {
        actorId: context.actor.id,
        actorType: 'ADMIN',
        afterSaleId: sale.id,
        correlationId: context.correlationId,
        event,
        fromStatus: currentStatus,
        reason: normalizedReason,
        storeId: context.storeId,
        toStatus: nextStatus,
      },
    });
    currentStatus = nextStatus;
  };
  if (transition.events[0] === 'QUEUE_REFUND') {
    await appendAfterSaleTransition('QUEUE_REFUND');
  }

  const settlement = await transaction.afterSaleSettlement.create({
    data: {
      afterSaleId: sale.id,
      amountVnd: sale.approvedTotalVnd,
      currency: 'VND',
      id: settlementId,
      idempotencyKeyHash,
      method: 'ONLINE_ORIGINAL',
      orderId: sale.orderId,
      paymentAttemptId: payment.id,
      publicSettlementNumber: `AST-${settlementId.replaceAll('-', '').slice(0, 24).toUpperCase()}`,
      requestHash: hash,
      requestedBy: context.actor.id,
      storeId: context.storeId,
      status: 'PENDING',
    },
  });
  if (transition.events.includes('REFUND_REQUESTED')) {
    await appendAfterSaleTransition('REFUND_REQUESTED');
  }

  const refund: RefundCommandResult = await createRefundInTransaction(transaction, context, {
    amountVnd: refundAmountVnd,
    confirmation: 'CREATE_REFUND',
    expectedPaymentVersion: payment.version,
    idempotencyKey: `after-sale:${idempotencyKeyHash}`,
    paymentAttemptId: payment.id,
    reason: normalizedReason,
  });
  const linked = await transaction.afterSaleRefund.findFirst({
    select: { refundId: true },
    where: { refundId: refund.refundId, storeId: context.storeId },
  });
  if (linked) throw new AfterSaleRefundCommandError('AFTER_SALE_REFUND_FACT_INVALID');
  await transaction.afterSaleRefund.create({
    data: {
      afterSaleId: sale.id,
      amountVnd: sale.approvedTotalVnd,
      orderId: sale.orderId,
      paymentAttemptId: payment.id,
      refundId: refund.refundId,
      settlementId: settlement.id,
      storeId: context.storeId,
    },
  });
  await transaction.afterSaleSettlement.update({
    data: { status: 'PROCESSING', version: { increment: 1 } },
    where: { storeId_id: { id: settlement.id, storeId: context.storeId } },
  });
  await appendOutboxMessageInTransaction(transaction, context, {
    aggregateId: refund.refundId,
    aggregateType: 'REFUND',
    eventType: AFTER_SALE_REFUND_SYNC_EVENT_TYPE,
    eventVersion: AFTER_SALE_REFUND_SYNC_EVENT_VERSION,
    idempotencyKey: `${AFTER_SALE_REFUND_SYNC_EVENT_TYPE}:${refund.refundId}:${refund.version}`,
    payload: {
      refund_id: refund.refundId,
      refund_version: refund.version,
      store_id: context.storeId,
    },
  });
  await transaction.auditLog.create({
    data: {
      action: 'after-sale.refund.requested',
      actorId: context.actor.id,
      actorType: 'ADMIN',
      afterData: {
        amount_vnd: refundAmountVnd,
        refund_id: refund.refundId,
        settlement_id: settlement.id,
        status: 'PROCESSING',
      },
      correlationId: context.correlationId,
      reason: normalizedReason,
      storeId: context.storeId,
      targetId: sale.id,
      targetType: 'after_sale',
    },
  });
  const committed = await transaction.afterSale.findFirst({
    select: { id: true, publicCaseNumber: true, status: true, version: true },
    where: { id: sale.id, storeId: context.storeId },
  });
  if (!committed) throw new AfterSaleRefundCommandError('AFTER_SALE_REFUND_FACT_INVALID');
  return result(committed, settlement.id, refund.refundId, false);
}

export async function requestAfterSaleOnlineRefund(
  client: PrismaClient,
  context: StoreContext,
  input: RefundCommandInput,
): Promise<AfterSaleRefundCommandResult> {
  let attempts = 0;
  try {
    for (;;) {
      try {
        return await withStoreTransaction(
          client,
          context,
          (transaction) => requestOnlineRefundInTransaction(transaction, context, input),
          { isolationLevel: 'Serializable', timeout: 20_000 },
        );
      } catch (error) {
        if (!isSerializationConflict(error) || ++attempts >= SERIALIZATION_RETRY_LIMIT) throw error;
      }
    }
  } catch (error) {
    mapCommandError(error);
  }
}

type LinkedRefund = {
  afterSaleId: string;
  amountVnd: bigint;
  id: string;
  settlementId: string;
  settlementStatus:
    'PENDING' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'REVIEW_REQUIRED' | 'CANCELLED';
  refundStatus:
    'REQUESTED' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'REVIEW_REQUIRED';
  refundVersion: number;
};

export async function syncAfterSaleRefund(
  client: PrismaClient,
  context: StoreContext,
  input: Readonly<{ refundId: string; refundVersion: number }>,
): Promise<void> {
  if (
    context.actor.type !== 'admin' ||
    !UUID_PATTERN.test(input.refundId) ||
    !Number.isSafeInteger(input.refundVersion) ||
    input.refundVersion < 1
  ) {
    throw new AfterSaleRefundCommandError('AFTER_SALE_INPUT_INVALID');
  }
  await withStoreTransaction(client, context, async (transaction) => {
    const rows = await transaction.$queryRaw<LinkedRefund[]>(Prisma.sql`
      SELECT refund.id, refund.status AS "refundStatus", refund.version AS "refundVersion",
        linked.after_sale_id AS "afterSaleId", linked.amount_vnd AS "amountVnd",
        linked.settlement_id AS "settlementId", settlement.status AS "settlementStatus"
      FROM refunds refund
      JOIN after_sale_refunds linked
        ON linked.store_id = refund.store_id AND linked.refund_id = refund.id
      JOIN after_sale_settlements settlement
        ON settlement.store_id = linked.store_id AND settlement.id = linked.settlement_id
      WHERE refund.store_id = ${context.storeId}::uuid AND refund.id = ${input.refundId}::uuid
      FOR UPDATE OF refund, settlement
    `);
    const linked = rows[0];
    if (!linked) return;
    if (linked.refundVersion < input.refundVersion) {
      throw new AfterSaleRefundCommandError('AFTER_SALE_REFUND_FACT_INVALID');
    }

    const targetSettlement =
      linked.refundStatus === 'SUCCEEDED'
        ? 'SUCCEEDED'
        : linked.refundStatus === 'FAILED'
          ? 'FAILED'
          : linked.refundStatus === 'CANCELLED'
            ? 'CANCELLED'
            : linked.refundStatus === 'REVIEW_REQUIRED'
              ? 'REVIEW_REQUIRED'
              : 'PROCESSING';
    if (linked.settlementStatus !== targetSettlement) {
      await transaction.afterSaleSettlement.update({
        data: {
          completedAt: targetSettlement === 'SUCCEEDED' ? new Date() : null,
          status: targetSettlement,
          version: { increment: 1 },
        },
        where: { storeId_id: { id: linked.settlementId, storeId: context.storeId } },
      });
    }
    if (targetSettlement === 'PROCESSING') return;

    const sale = await transaction.afterSale.findFirst({
      select: { id: true, status: true, version: true },
      where: { id: linked.afterSaleId, storeId: context.storeId },
    });
    if (!sale) throw new AfterSaleRefundCommandError('AFTER_SALE_NOT_FOUND');
    const event =
      targetSettlement === 'SUCCEEDED'
        ? 'REFUND_SUCCEEDED'
        : targetSettlement === 'REVIEW_REQUIRED'
          ? 'REQUIRE_REVIEW'
          : targetSettlement === 'FAILED'
            ? 'REFUND_FAILED'
            : 'REFUND_CANCELLED';
    const targetStatus =
      event === 'REFUND_SUCCEEDED'
        ? 'REFUNDED'
        : event === 'REQUIRE_REVIEW'
          ? 'REVIEW_REQUIRED'
          : 'REFUND_PENDING';
    if (sale.status === targetStatus) return;
    await transaction.$executeRaw`
      SELECT
        set_config('app.actor_type', 'system', true),
        set_config('app.actor_id', ${AFTER_SALE_EVIDENCE_SYSTEM_ACTOR_ID}, true),
        set_config('app.system_scope', 'after-sale-transition', true)
    `;
    await transaction.$executeRaw`
      INSERT INTO after_sale_transitions (
        store_id, after_sale_id, from_status, to_status, event,
        actor_type, actor_id, correlation_id
      ) VALUES (
        ${context.storeId}::uuid, ${sale.id}::uuid,
        ${sale.status}::after_sale_status, ${targetStatus}::after_sale_status,
        ${event}, 'SYSTEM'::"AuditActorType",
        ${AFTER_SALE_EVIDENCE_SYSTEM_ACTOR_ID}::uuid, ${context.correlationId}
      )
    `;
  });
}

export { AFTER_SALE_REFUND_SYNC_EVENT_TYPE, AFTER_SALE_REFUND_SYNC_EVENT_VERSION };
