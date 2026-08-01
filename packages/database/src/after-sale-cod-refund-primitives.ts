import { createHash, createHmac, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

import type { PrismaClient } from '@prisma/client';
import {
  AfterSaleInvariantError,
  transitionAfterSaleCodRefundConfirmed,
  transitionAfterSaleCodRefundQueued,
  type AfterSaleStatus,
  type StoreContext,
} from '@zalo-shop/domain';
import { encryptSensitive } from '@zalo-shop/security';

import {
  AfterSaleRefundCommandError,
  type AfterSaleRefundCommandErrorCode,
} from './after-sale-refund-primitives';
import { type StoreTransaction, withStoreTransaction } from './index';
import { lockRefundOrderScope } from './refund-primitives';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IDEMPOTENCY_PATTERN = /^[!-~]{16,128}$/u;
const SERIALIZATION_RETRY_LIMIT = 3;

type CodRefundPermission =
  'store.after-sales.cod-refunds.request' | 'store.after-sales.cod-refunds.confirm';

export type AfterSaleRefundMethod = 'ONLINE_ORIGINAL' | 'COD_OFFLINE';

export type AfterSaleCodRefundCommandResult = Readonly<{
  afterSaleId: string;
  operationId: string;
  publicCaseNumber: string;
  publicSettlementNumber: string;
  replayed: boolean;
  settlementId: string;
  settlementStatus:
    'PENDING' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'REVIEW_REQUIRED' | 'CANCELLED';
  settlementVersion: number;
  status: AfterSaleStatus;
  version: number;
}>;

export type RequestAfterSaleCodRefundInput = Readonly<{
  afterSaleId: string;
  expectedVersion: number;
  idempotencyKey: string;
  reason: string;
  sourceIp?: string;
}>;

export type RecordAfterSaleCodRefundReceiptInput = Readonly<{
  afterSaleId: string;
  encryptionKey: string;
  evidenceReference: string;
  expectedSettlementVersion: number;
  hashKey: string;
  idempotencyKey: string;
  reason: string;
  settlementNumber: string;
  sourceIp?: string;
  transferredAt: Date;
  transferReference: string;
}>;

export type ConfirmAfterSaleCodRefundInput = Readonly<{
  afterSaleId: string;
  expectedSettlementVersion: number;
  expectedVersion: number;
  idempotencyKey: string;
  reason: string;
  settlementNumber: string;
  sourceIp?: string;
}>;

type SettlementIdentity = Readonly<{
  afterSaleId: string;
  id: string;
  orderId: string;
}>;

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function keyedDigest(value: string, key: string, scope: string, storeId: string): string {
  if (key.length < 32) throw new AfterSaleRefundCommandError('AFTER_SALE_INPUT_INVALID');
  return createHmac('sha256', key)
    .update(`${storeId}\u0000${scope}\u0000${value}`, 'utf8')
    .digest('hex');
}

function normalizeText(value: string, minimum: number, maximum: number): string {
  const normalized = value.normalize('NFKC').trim();
  const hasControlCharacter = [...normalized].some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point <= 0x1f || point === 0x7f);
  });
  if (normalized.length < minimum || normalized.length > maximum || hasControlCharacter) {
    throw new AfterSaleRefundCommandError('AFTER_SALE_INPUT_INVALID');
  }
  return normalized;
}

export function maskAfterSaleCodRefundReference(value: string): string {
  const characters = [...value];
  if (characters.length <= 4) return '*'.repeat(characters.length);
  return `${characters.slice(0, 2).join('')}${'*'.repeat(Math.min(12, characters.length - 4))}${characters.slice(-2).join('')}`;
}

function assertContext(context: StoreContext): void {
  const tokenExpiresAt = Date.parse(context.accessTokenExpiresAt ?? '');
  if (
    context.actor.type !== 'admin' ||
    context.adminAuthorizationScope !== 'STORE' ||
    !UUID_PATTERN.test(context.actor.id) ||
    !UUID_PATTERN.test(context.storeId) ||
    !UUID_PATTERN.test(context.accessSessionId ?? '') ||
    !Number.isFinite(tokenExpiresAt) ||
    tokenExpiresAt <= Date.now() ||
    context.correlationId.trim().length < 1 ||
    context.correlationId.length > 128
  ) {
    throw new AfterSaleRefundCommandError('AFTER_SALE_AUTHORIZATION_DENIED');
  }
}

function assertCommonInput(input: {
  afterSaleId: string;
  idempotencyKey: string;
  reason: string;
  sourceIp?: string;
}): string {
  const reason = normalizeText(input.reason, 10, 500);
  if (
    !UUID_PATTERN.test(input.afterSaleId) ||
    !IDEMPOTENCY_PATTERN.test(input.idempotencyKey) ||
    (input.sourceIp !== undefined && isIP(input.sourceIp) === 0)
  ) {
    throw new AfterSaleRefundCommandError('AFTER_SALE_INPUT_INVALID');
  }
  return reason;
}

function assertVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AfterSaleRefundCommandError('AFTER_SALE_INPUT_INVALID');
  }
}

function isSettlementNumber(value: string): boolean {
  return /^AST-[A-Z0-9]{16,32}$/u.test(value);
}

function amount(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new AfterSaleRefundCommandError('AFTER_SALE_REFUND_FACT_INVALID');
  }
  return result;
}

function errorInfo(error: unknown): { code?: string; message: string; sqlState?: string } {
  if (error === null || typeof error !== 'object') return { message: String(error) };
  const record = error as { code?: unknown; message?: unknown; meta?: unknown };
  const meta =
    record.meta !== null && typeof record.meta === 'object'
      ? (record.meta as { code?: unknown; message?: unknown })
      : undefined;
  return {
    code: typeof record.code === 'string' ? record.code : undefined,
    message: [record.message, meta?.message]
      .filter((value): value is string => typeof value === 'string')
      .join('\n'),
    sqlState: typeof meta?.code === 'string' ? meta.code : undefined,
  };
}

function isSerializationConflict(error: unknown): boolean {
  const info = errorInfo(error);
  return info.code === 'P2034' || info.sqlState === '40001';
}

function isUniqueConflict(error: unknown): boolean {
  const info = errorInfo(error);
  return info.code === 'P2002' || info.sqlState === '23505';
}

function mapError(error: unknown): never {
  if (error instanceof AfterSaleRefundCommandError) throw error;
  if (error instanceof AfterSaleInvariantError) {
    throw new AfterSaleRefundCommandError('AFTER_SALE_STATE_CONFLICT');
  }
  const info = errorInfo(error);
  if (info.sqlState === '42501') {
    throw new AfterSaleRefundCommandError('AFTER_SALE_AUTHORIZATION_DENIED');
  }
  if (info.code === 'P2034' || info.sqlState === '40001') {
    throw new AfterSaleRefundCommandError('AFTER_SALE_VERSION_CONFLICT');
  }
  if (info.code === 'P2002' || info.sqlState === '23505') {
    throw new AfterSaleRefundCommandError('AFTER_SALE_IDEMPOTENCY_CONFLICT');
  }
  if (['P2003', 'P2004'].includes(info.code ?? '') || info.sqlState === '23514') {
    throw new AfterSaleRefundCommandError('AFTER_SALE_REFUND_FACT_INVALID');
  }
  throw error;
}

async function serializable<T>(
  client: PrismaClient,
  context: StoreContext,
  callback: (transaction: StoreTransaction) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await withStoreTransaction(client, context, callback, {
        isolationLevel: 'Serializable',
        timeout: 20_000,
      });
    } catch (error) {
      if (attempt + 1 < SERIALIZATION_RETRY_LIMIT && isSerializationConflict(error)) continue;
      throw error;
    }
  }
}

async function assertCodAuthorization(
  transaction: StoreTransaction,
  context: StoreContext,
  permission: CodRefundPermission,
): Promise<void> {
  assertContext(context);
  const authorization = await transaction.$queryRaw<Array<{ permission_code: string }>>`
    SELECT role_permission.permission_code
    FROM stores store
    JOIN admin_users admin ON admin.id = ${context.actor.id}::uuid
    JOIN admin_sessions session
      ON session.id = ${context.accessSessionId}::uuid
      AND session.admin_user_id = admin.id
    JOIN admin_store_roles assignment
      ON assignment.store_id = store.id AND assignment.admin_user_id = admin.id
    JOIN store_role_permissions role_permission
      ON role_permission.store_id = assignment.store_id
      AND role_permission.role_id = assignment.role_id
    WHERE store.id = ${context.storeId}::uuid
      AND store.status = 'ACTIVE'
      AND admin.status = 'ACTIVE'
      AND session.revoked_at IS NULL
      AND session.expires_at > pg_catalog.clock_timestamp()
      AND session.mfa_verified_at >= pg_catalog.clock_timestamp() - INTERVAL '10 minutes'
      AND ${context.accessTokenExpiresAt}::timestamptz > pg_catalog.clock_timestamp()
      AND role_permission.permission_code IN ('store.after-sales.read', ${permission})
    ORDER BY assignment.role_id, role_permission.permission_code
    FOR SHARE OF store, admin, session, assignment, role_permission
  `;
  const permissions = new Set(authorization.map((row) => row.permission_code));
  if (!permissions.has('store.after-sales.read') || !permissions.has(permission)) {
    throw new AfterSaleRefundCommandError('AFTER_SALE_AUTHORIZATION_DENIED');
  }
}

async function lockOrder(
  transaction: StoreTransaction,
  storeId: string,
  orderId: string,
): Promise<void> {
  const rows = await transaction.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM orders
    WHERE store_id = ${storeId}::uuid AND id = ${orderId}::uuid
    FOR UPDATE
  `;
  if (rows.length !== 1) throw new AfterSaleRefundCommandError('AFTER_SALE_NOT_FOUND');
}

async function lockAfterSale(
  transaction: StoreTransaction,
  storeId: string,
  afterSaleId: string,
): Promise<void> {
  const rows = await transaction.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM after_sales
    WHERE store_id = ${storeId}::uuid AND id = ${afterSaleId}::uuid
    FOR UPDATE
  `;
  if (rows.length !== 1) throw new AfterSaleRefundCommandError('AFTER_SALE_NOT_FOUND');
}

async function assertOriginalCodReceipt(
  transaction: StoreTransaction,
  context: StoreContext,
  order: {
    currency: string;
    id: string;
    payableVnd: bigint;
    paymentMethod: string;
    status: string;
  },
): Promise<void> {
  if (
    order.paymentMethod !== 'COD' ||
    order.currency !== 'VND' ||
    !['DELIVERED', 'COMPLETED'].includes(order.status)
  ) {
    throw new AfterSaleRefundCommandError('AFTER_SALE_PAYMENT_NOT_PROVEN');
  }
  const receipts = await transaction.$queryRaw<Array<{ id: string }>>`
    SELECT line.id
    FROM financial_reconciliation_lines line
    JOIN financial_reconciliation_batches batch
      ON batch.store_id = line.store_id AND batch.id = line.batch_id
    JOIN shipments shipment
      ON shipment.store_id = line.store_id AND shipment.id = line.shipment_id
    WHERE line.store_id = ${context.storeId}::uuid
      AND shipment.order_id = ${order.id}::uuid
      AND shipment.purpose = 'ORDER_OUTBOUND'
      AND shipment.status = 'DELIVERED'
      AND shipment.delivered_at IS NOT NULL
      AND shipment.cod_amount_vnd = ${order.payableVnd}
      AND batch.source = 'SHIPPING_PROVIDER'
      AND batch.shipping_channel_id = shipment.channel_id
      AND line.type = 'COD_REMITTANCE'
      AND line.status = 'MATCHED'
      AND line.gross_amount_vnd = ${order.payableVnd}
      AND line.local_expected_amount_vnd = ${order.payableVnd}
      AND line.difference_vnd = 0
    ORDER BY line.id
  `;
  if (receipts.length !== 1) {
    throw new AfterSaleRefundCommandError('AFTER_SALE_PAYMENT_NOT_PROVEN');
  }
}

function commandResult(
  sale: { id: string; publicCaseNumber: string; status: AfterSaleStatus; version: number },
  settlement: {
    id: string;
    publicSettlementNumber: string;
    status: AfterSaleCodRefundCommandResult['settlementStatus'];
    version: number;
  },
  replayed: boolean,
  operationId = settlement.id,
): AfterSaleCodRefundCommandResult {
  return {
    afterSaleId: sale.id,
    operationId,
    publicCaseNumber: sale.publicCaseNumber,
    publicSettlementNumber: settlement.publicSettlementNumber,
    replayed,
    settlementId: settlement.id,
    settlementStatus: settlement.status,
    settlementVersion: settlement.version,
    status: sale.status,
    version: sale.version,
  };
}

export async function resolveAfterSaleRefundMethod(
  client: PrismaClient,
  context: StoreContext,
  afterSaleId: string,
): Promise<AfterSaleRefundMethod> {
  assertContext(context);
  if (!UUID_PATTERN.test(afterSaleId)) {
    throw new AfterSaleRefundCommandError('AFTER_SALE_INPUT_INVALID');
  }
  try {
    return await withStoreTransaction(
      client,
      context,
      async (transaction) => {
        const sale = await transaction.afterSale.findFirst({
          select: { order: { select: { paymentMethod: true } } },
          where: { id: afterSaleId, storeId: context.storeId },
        });
        if (!sale) throw new AfterSaleRefundCommandError('AFTER_SALE_NOT_FOUND');
        return sale.order.paymentMethod === 'COD' ? 'COD_OFFLINE' : 'ONLINE_ORIGINAL';
      },
      { isolationLevel: 'ReadCommitted', timeout: 10_000 },
    );
  } catch (error) {
    mapError(error);
  }
}

async function requestCodRefundInTransaction(
  transaction: StoreTransaction,
  context: StoreContext,
  input: RequestAfterSaleCodRefundInput,
  idempotencyKeyHash: string,
  requestHash: string,
  reason: string,
): Promise<AfterSaleCodRefundCommandResult> {
  await transaction.$executeRaw`
    SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      ${`m63-b7-request:${context.storeId}:${input.afterSaleId}:${idempotencyKeyHash}`}, 0
    ))
  `;
  const identity = await transaction.afterSale.findFirst({
    select: { orderId: true },
    where: { id: input.afterSaleId, storeId: context.storeId },
  });
  if (!identity) throw new AfterSaleRefundCommandError('AFTER_SALE_NOT_FOUND');
  await lockRefundOrderScope(transaction, context.storeId, identity.orderId);
  await lockOrder(transaction, context.storeId, identity.orderId);
  await lockAfterSale(transaction, context.storeId, input.afterSaleId);
  await assertCodAuthorization(transaction, context, 'store.after-sales.cod-refunds.request');

  const sale = await transaction.afterSale.findFirst({
    include: { order: true },
    where: { id: input.afterSaleId, storeId: context.storeId },
  });
  if (!sale) throw new AfterSaleRefundCommandError('AFTER_SALE_NOT_FOUND');
  const existing = await transaction.afterSaleSettlement.findUnique({
    where: {
      storeId_method_idempotencyKeyHash: {
        idempotencyKeyHash,
        method: 'COD_OFFLINE',
        storeId: context.storeId,
      },
    },
  });
  if (existing) {
    if (
      existing.afterSaleId !== sale.id ||
      existing.orderId !== sale.orderId ||
      existing.amountVnd !== sale.approvedTotalVnd ||
      existing.paymentAttemptId !== null ||
      existing.requestHash !== requestHash
    ) {
      throw new AfterSaleRefundCommandError('AFTER_SALE_IDEMPOTENCY_CONFLICT');
    }
    return commandResult(sale, existing, true);
  }
  if (sale.version !== input.expectedVersion) {
    throw new AfterSaleRefundCommandError('AFTER_SALE_VERSION_CONFLICT');
  }
  if (sale.currency !== 'VND' || sale.approvedTotalVnd <= 0n) {
    throw new AfterSaleRefundCommandError('AFTER_SALE_REFUND_FACT_INVALID');
  }
  await assertOriginalCodReceipt(transaction, context, sale.order);

  const transition = transitionAfterSaleCodRefundQueued(sale.type, sale.status);
  if (transition.events.length === 1) {
    await transaction.afterSaleTransition.create({
      data: {
        actorId: context.actor.id,
        actorType: 'ADMIN',
        afterSaleId: sale.id,
        correlationId: context.correlationId,
        event: transition.events[0]!,
        fromStatus: sale.status,
        reason,
        storeId: context.storeId,
        toStatus: transition.status,
      },
    });
  }
  const settlementId = randomUUID();
  const settlement = await transaction.afterSaleSettlement.create({
    data: {
      afterSaleId: sale.id,
      amountVnd: sale.approvedTotalVnd,
      currency: 'VND',
      id: settlementId,
      idempotencyKeyHash,
      method: 'COD_OFFLINE',
      orderId: sale.orderId,
      publicSettlementNumber: `AST-${settlementId.replaceAll('-', '').slice(0, 24).toUpperCase()}`,
      requestHash,
      requestedBy: context.actor.id,
      status: 'PENDING',
      storeId: context.storeId,
    },
  });
  await transaction.auditLog.create({
    data: {
      action: 'after-sale.cod-refund.requested',
      actorId: context.actor.id,
      actorType: 'ADMIN',
      afterData: {
        amount_vnd: amount(sale.approvedTotalVnd),
        settlement_id: settlement.id,
        status: settlement.status,
      },
      correlationId: context.correlationId,
      reason,
      ...(input.sourceIp === undefined ? {} : { sourceIp: input.sourceIp }),
      storeId: context.storeId,
      targetId: sale.id,
      targetType: 'after_sale',
    },
  });
  const committed = await transaction.afterSale.findFirstOrThrow({
    select: { id: true, publicCaseNumber: true, status: true, version: true },
    where: { id: sale.id, storeId: context.storeId },
  });
  return commandResult(committed, settlement, false);
}

async function replayRequestedCodRefund(
  client: PrismaClient,
  context: StoreContext,
  input: RequestAfterSaleCodRefundInput,
  idempotencyKeyHash: string,
  requestHash: string,
): Promise<AfterSaleCodRefundCommandResult | null> {
  return withStoreTransaction(
    client,
    context,
    async (transaction) => {
      await assertCodAuthorization(transaction, context, 'store.after-sales.cod-refunds.request');
      const settlement = await transaction.afterSaleSettlement.findUnique({
        where: {
          storeId_method_idempotencyKeyHash: {
            idempotencyKeyHash,
            method: 'COD_OFFLINE',
            storeId: context.storeId,
          },
        },
      });
      if (!settlement) return null;
      const sale = await transaction.afterSale.findFirst({
        select: {
          approvedTotalVnd: true,
          id: true,
          orderId: true,
          publicCaseNumber: true,
          status: true,
          version: true,
        },
        where: { id: input.afterSaleId, storeId: context.storeId },
      });
      if (
        !sale ||
        settlement.afterSaleId !== sale.id ||
        settlement.orderId !== sale.orderId ||
        settlement.amountVnd !== sale.approvedTotalVnd ||
        settlement.paymentAttemptId !== null ||
        settlement.requestHash !== requestHash
      ) {
        throw new AfterSaleRefundCommandError('AFTER_SALE_IDEMPOTENCY_CONFLICT');
      }
      return commandResult(sale, settlement, true);
    },
    { isolationLevel: 'ReadCommitted', timeout: 15_000 },
  );
}

export async function requestAfterSaleCodRefund(
  client: PrismaClient,
  context: StoreContext,
  input: RequestAfterSaleCodRefundInput,
): Promise<AfterSaleCodRefundCommandResult> {
  assertContext(context);
  const reason = assertCommonInput(input);
  assertVersion(input.expectedVersion);
  const idempotencyKeyHash = digest(input.idempotencyKey);
  const requestHash = digest(
    JSON.stringify({
      actor_id: context.actor.id,
      after_sale_id: input.afterSaleId,
      expected_version: input.expectedVersion,
      idempotency_key_hash: idempotencyKeyHash,
      operation: 'ADMIN_COD_REFUND_REQUEST',
      path: `/v1/admin/after-sales/${input.afterSaleId}/refund`,
      reason_hash: digest(reason),
      store_id: context.storeId,
    }),
  );
  try {
    return await serializable(client, context, (transaction) =>
      requestCodRefundInTransaction(
        transaction,
        context,
        input,
        idempotencyKeyHash,
        requestHash,
        reason,
      ),
    );
  } catch (error) {
    if (isUniqueConflict(error)) {
      const replay = await replayRequestedCodRefund(
        client,
        context,
        input,
        idempotencyKeyHash,
        requestHash,
      );
      if (replay) return replay;
    }
    mapError(error);
  }
}

async function settlementIdentity(
  transaction: StoreTransaction,
  context: StoreContext,
  afterSaleId: string,
  settlementNumber: string,
): Promise<SettlementIdentity> {
  const settlement = await transaction.afterSaleSettlement.findFirst({
    select: { afterSaleId: true, id: true, orderId: true },
    where: {
      afterSaleId,
      method: 'COD_OFFLINE',
      publicSettlementNumber: settlementNumber,
      storeId: context.storeId,
    },
  });
  if (!settlement) throw new AfterSaleRefundCommandError('AFTER_SALE_NOT_FOUND');
  return settlement;
}

async function recordReceiptInTransaction(
  transaction: StoreTransaction,
  context: StoreContext,
  input: RecordAfterSaleCodRefundReceiptInput,
  normalized: Readonly<{
    evidenceCiphertext: string;
    evidenceDigest: string;
    idempotencyKeyHash: string;
    reason: string;
    requestHash: string;
    transferReferenceDigest: string;
    transferReferenceMasked: string;
  }>,
): Promise<AfterSaleCodRefundCommandResult> {
  await transaction.$executeRaw`
    SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      ${`m63-b7-receipt:${context.storeId}:${input.afterSaleId}:${normalized.idempotencyKeyHash}`}, 0
    ))
  `;
  const identity = await settlementIdentity(
    transaction,
    context,
    input.afterSaleId,
    input.settlementNumber,
  );
  await lockRefundOrderScope(transaction, context.storeId, identity.orderId);
  await lockOrder(transaction, context.storeId, identity.orderId);
  await lockAfterSale(transaction, context.storeId, input.afterSaleId);
  await transaction.$queryRaw`
    SELECT id FROM after_sale_settlements
    WHERE store_id = ${context.storeId}::uuid AND id = ${identity.id}::uuid
    FOR UPDATE
  `;
  await assertCodAuthorization(transaction, context, 'store.after-sales.cod-refunds.request');

  const settlement = await transaction.afterSaleSettlement.findFirst({
    include: { codRefundReceipt: true },
    where: {
      afterSaleId: input.afterSaleId,
      id: identity.id,
      method: 'COD_OFFLINE',
      publicSettlementNumber: input.settlementNumber,
      storeId: context.storeId,
    },
  });
  if (!settlement) throw new AfterSaleRefundCommandError('AFTER_SALE_NOT_FOUND');
  const replay = await transaction.afterSaleCodRefundReceipt.findUnique({
    where: {
      storeId_idempotencyKeyHash: {
        idempotencyKeyHash: normalized.idempotencyKeyHash,
        storeId: context.storeId,
      },
    },
  });
  if (replay) {
    if (
      replay.settlementId !== settlement.id ||
      replay.afterSaleId !== settlement.afterSaleId ||
      replay.orderId !== settlement.orderId ||
      replay.amountVnd !== settlement.amountVnd ||
      replay.requestHash !== normalized.requestHash ||
      replay.transferReferenceDigest !== normalized.transferReferenceDigest ||
      replay.evidenceDigest !== normalized.evidenceDigest
    ) {
      throw new AfterSaleRefundCommandError('AFTER_SALE_IDEMPOTENCY_CONFLICT');
    }
    const sale = await transaction.afterSale.findFirstOrThrow({
      select: { id: true, publicCaseNumber: true, status: true, version: true },
      where: { id: input.afterSaleId, storeId: context.storeId },
    });
    return commandResult(sale, settlement, true, replay.id);
  }
  if (
    settlement.version !== input.expectedSettlementVersion ||
    settlement.status !== 'PENDING' ||
    settlement.requestedBy !== context.actor.id ||
    settlement.codRefundReceipt !== null
  ) {
    throw new AfterSaleRefundCommandError('AFTER_SALE_VERSION_CONFLICT');
  }
  const receipt = await transaction.afterSaleCodRefundReceipt.create({
    data: {
      afterSaleId: settlement.afterSaleId,
      amountVnd: settlement.amountVnd,
      correlationId: context.correlationId,
      currency: 'VND',
      evidenceCiphertext: normalized.evidenceCiphertext,
      evidenceDigest: normalized.evidenceDigest,
      expectedSettlementVersion: input.expectedSettlementVersion,
      idempotencyKeyHash: normalized.idempotencyKeyHash,
      orderId: settlement.orderId,
      recordedBy: context.actor.id,
      requestHash: normalized.requestHash,
      settlementId: settlement.id,
      storeId: context.storeId,
      transferredAt: input.transferredAt,
      transferReferenceDigest: normalized.transferReferenceDigest,
      transferReferenceMasked: normalized.transferReferenceMasked,
    },
  });
  await transaction.auditLog.create({
    data: {
      action: 'after-sale.cod-refund.receipt-recorded',
      actorId: context.actor.id,
      actorType: 'ADMIN',
      afterData: {
        receipt_identity_digest: digest(receipt.id),
        settlement_id: settlement.id,
        transfer_reference_masked: normalized.transferReferenceMasked,
      },
      correlationId: context.correlationId,
      reason: normalized.reason,
      ...(input.sourceIp === undefined ? {} : { sourceIp: input.sourceIp }),
      storeId: context.storeId,
      targetId: settlement.afterSaleId,
      targetType: 'after_sale',
    },
  });
  const sale = await transaction.afterSale.findFirstOrThrow({
    select: { id: true, publicCaseNumber: true, status: true, version: true },
    where: { id: settlement.afterSaleId, storeId: context.storeId },
  });
  return commandResult(sale, settlement, false, receipt.id);
}

async function replayRecordedReceipt(
  client: PrismaClient,
  context: StoreContext,
  input: RecordAfterSaleCodRefundReceiptInput,
  normalized: Readonly<{ idempotencyKeyHash: string; requestHash: string }>,
): Promise<AfterSaleCodRefundCommandResult | null> {
  return withStoreTransaction(
    client,
    context,
    async (transaction) => {
      await assertCodAuthorization(transaction, context, 'store.after-sales.cod-refunds.request');
      const receipt = await transaction.afterSaleCodRefundReceipt.findUnique({
        where: {
          storeId_idempotencyKeyHash: {
            idempotencyKeyHash: normalized.idempotencyKeyHash,
            storeId: context.storeId,
          },
        },
      });
      if (!receipt) return null;
      const settlement = await transaction.afterSaleSettlement.findFirst({
        where: {
          afterSaleId: input.afterSaleId,
          id: receipt.settlementId,
          publicSettlementNumber: input.settlementNumber,
          storeId: context.storeId,
        },
      });
      const sale = await transaction.afterSale.findFirst({
        select: { id: true, publicCaseNumber: true, status: true, version: true },
        where: { id: input.afterSaleId, storeId: context.storeId },
      });
      if (!settlement || !sale || receipt.requestHash !== normalized.requestHash) {
        throw new AfterSaleRefundCommandError('AFTER_SALE_IDEMPOTENCY_CONFLICT');
      }
      return commandResult(sale, settlement, true, receipt.id);
    },
    { isolationLevel: 'ReadCommitted', timeout: 15_000 },
  );
}

export async function recordAfterSaleCodRefundReceipt(
  client: PrismaClient,
  context: StoreContext,
  input: RecordAfterSaleCodRefundReceiptInput,
): Promise<AfterSaleCodRefundCommandResult> {
  assertContext(context);
  const reason = assertCommonInput(input);
  assertVersion(input.expectedSettlementVersion);
  if (
    !isSettlementNumber(input.settlementNumber) ||
    !Number.isFinite(input.transferredAt.getTime())
  ) {
    throw new AfterSaleRefundCommandError('AFTER_SALE_INPUT_INVALID');
  }
  const transferReference = normalizeText(input.transferReference, 2, 160);
  const evidenceReference = normalizeText(input.evidenceReference, 2, 2_000);
  const idempotencyKeyHash = digest(input.idempotencyKey);
  const transferReferenceDigest = keyedDigest(
    transferReference,
    input.hashKey,
    'COD_REFUND_TRANSFER',
    context.storeId,
  );
  const evidenceDigest = keyedDigest(
    evidenceReference,
    input.hashKey,
    'COD_REFUND_EVIDENCE',
    context.storeId,
  );
  const requestHash = digest(
    JSON.stringify({
      actor_id: context.actor.id,
      after_sale_id: input.afterSaleId,
      evidence_digest: evidenceDigest,
      expected_settlement_version: input.expectedSettlementVersion,
      idempotency_key_hash: idempotencyKeyHash,
      operation: 'ADMIN_COD_REFUND_RECEIPT',
      path: `/v1/admin/after-sales/${input.afterSaleId}/cod-refunds/${input.settlementNumber}/receipt`,
      reason_hash: digest(reason),
      settlement_number: input.settlementNumber,
      store_id: context.storeId,
      transfer_reference_digest: transferReferenceDigest,
      transferred_at: input.transferredAt.toISOString(),
    }),
  );
  const normalized = {
    evidenceCiphertext: encryptSensitive(evidenceReference, input.encryptionKey),
    evidenceDigest,
    idempotencyKeyHash,
    reason,
    requestHash,
    transferReferenceDigest,
    transferReferenceMasked: maskAfterSaleCodRefundReference(transferReference),
  } as const;
  try {
    return await serializable(client, context, (transaction) =>
      recordReceiptInTransaction(transaction, context, input, normalized),
    );
  } catch (error) {
    if (isUniqueConflict(error)) {
      const replay = await replayRecordedReceipt(client, context, input, normalized);
      if (replay) return replay;
    }
    mapError(error);
  }
}

async function confirmCodRefundInTransaction(
  transaction: StoreTransaction,
  context: StoreContext,
  input: ConfirmAfterSaleCodRefundInput,
  idempotencyKeyHash: string,
  requestHash: string,
  reason: string,
): Promise<AfterSaleCodRefundCommandResult> {
  await transaction.$executeRaw`
    SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      ${`m63-b7-confirm:${context.storeId}:${input.afterSaleId}:${idempotencyKeyHash}`}, 0
    ))
  `;
  const identity = await settlementIdentity(
    transaction,
    context,
    input.afterSaleId,
    input.settlementNumber,
  );
  await lockRefundOrderScope(transaction, context.storeId, identity.orderId);
  await lockOrder(transaction, context.storeId, identity.orderId);
  await lockAfterSale(transaction, context.storeId, input.afterSaleId);
  await transaction.$queryRaw`
    SELECT id FROM after_sale_settlements
    WHERE store_id = ${context.storeId}::uuid AND id = ${identity.id}::uuid
    FOR UPDATE
  `;
  await transaction.$queryRaw`
    SELECT id FROM after_sale_cod_refund_receipts
    WHERE store_id = ${context.storeId}::uuid AND settlement_id = ${identity.id}::uuid
  `;
  await assertCodAuthorization(transaction, context, 'store.after-sales.cod-refunds.confirm');

  const replay = await transaction.afterSaleCodRefundConfirmation.findUnique({
    where: {
      storeId_idempotencyKeyHash: { idempotencyKeyHash, storeId: context.storeId },
    },
  });
  const settlement = await transaction.afterSaleSettlement.findFirst({
    include: { codRefundReceipt: true },
    where: {
      afterSaleId: input.afterSaleId,
      id: identity.id,
      method: 'COD_OFFLINE',
      publicSettlementNumber: input.settlementNumber,
      storeId: context.storeId,
    },
  });
  const sale = await transaction.afterSale.findFirst({
    where: { id: input.afterSaleId, storeId: context.storeId },
  });
  if (!settlement || !sale) throw new AfterSaleRefundCommandError('AFTER_SALE_NOT_FOUND');
  if (replay) {
    if (
      replay.settlementId !== settlement.id ||
      replay.afterSaleId !== sale.id ||
      replay.orderId !== settlement.orderId ||
      replay.amountVnd !== settlement.amountVnd ||
      replay.requestHash !== requestHash
    ) {
      throw new AfterSaleRefundCommandError('AFTER_SALE_IDEMPOTENCY_CONFLICT');
    }
    return commandResult(sale, settlement, true, replay.id);
  }
  if (
    sale.version !== input.expectedVersion ||
    settlement.version !== input.expectedSettlementVersion
  ) {
    throw new AfterSaleRefundCommandError('AFTER_SALE_VERSION_CONFLICT');
  }
  const receipt = settlement.codRefundReceipt;
  if (
    settlement.status !== 'PENDING' ||
    settlement.requestedBy === context.actor.id ||
    settlement.confirmedBy !== null ||
    !receipt ||
    receipt.recordedBy !== settlement.requestedBy ||
    receipt.expectedSettlementVersion !== settlement.version ||
    receipt.amountVnd !== settlement.amountVnd ||
    receipt.afterSaleId !== settlement.afterSaleId ||
    receipt.orderId !== settlement.orderId
  ) {
    throw new AfterSaleRefundCommandError('AFTER_SALE_REFUND_FACT_INVALID');
  }
  const transition = transitionAfterSaleCodRefundConfirmed(sale.type, sale.status);
  const clock = await transaction.$queryRaw<Array<{ confirmed_at: Date }>>`
    SELECT pg_catalog.clock_timestamp() AS confirmed_at
  `;
  const confirmedAt = clock[0]?.confirmed_at;
  if (!confirmedAt) throw new AfterSaleRefundCommandError('AFTER_SALE_REFUND_FACT_INVALID');
  const updatedSettlement = await transaction.afterSaleSettlement.update({
    data: {
      completedAt: confirmedAt,
      confirmedAt,
      confirmedBy: context.actor.id,
      status: 'SUCCEEDED',
      transferEvidenceCiphertext: receipt.evidenceCiphertext,
      transferReferenceDigest: receipt.transferReferenceDigest,
      version: { increment: 1 },
    },
    where: { storeId_id: { id: settlement.id, storeId: context.storeId } },
  });
  let currentStatus = sale.status;
  for (const [eventIndex, event] of transition.events.entries()) {
    const nextStatus: AfterSaleStatus =
      event === 'REFUND_REQUESTED' ? 'REFUND_PROCESSING' : 'REFUNDED';
    await transaction.afterSaleTransition.create({
      data: {
        actorId: context.actor.id,
        actorType: 'ADMIN',
        afterSaleId: sale.id,
        correlationId: context.correlationId,
        createdAt: new Date(confirmedAt.getTime() + eventIndex),
        event,
        fromStatus: currentStatus,
        reason,
        storeId: context.storeId,
        toStatus: nextStatus,
      },
    });
    currentStatus = nextStatus;
  }
  const confirmation = await transaction.afterSaleCodRefundConfirmation.create({
    data: {
      afterSaleId: sale.id,
      amountVnd: settlement.amountVnd,
      confirmedAt,
      confirmedBy: context.actor.id,
      correlationId: context.correlationId,
      expectedAfterSaleVersion: input.expectedVersion,
      expectedSettlementVersion: input.expectedSettlementVersion,
      idempotencyKeyHash,
      orderId: settlement.orderId,
      requestHash,
      resultAfterSaleVersion: input.expectedVersion + 2,
      resultSettlementVersion: input.expectedSettlementVersion + 1,
      resultStatus: transition.status,
      settlementId: settlement.id,
      storeId: context.storeId,
    },
  });
  await transaction.auditLog.create({
    data: {
      action: 'after-sale.cod-refund.confirmed',
      actorId: context.actor.id,
      actorType: 'ADMIN',
      afterData: {
        confirmation_identity_digest: digest(confirmation.id),
        settlement_id: settlement.id,
        status: updatedSettlement.status,
      },
      correlationId: context.correlationId,
      reason,
      ...(input.sourceIp === undefined ? {} : { sourceIp: input.sourceIp }),
      storeId: context.storeId,
      targetId: sale.id,
      targetType: 'after_sale',
    },
  });
  const committed = await transaction.afterSale.findFirstOrThrow({
    select: { id: true, publicCaseNumber: true, status: true, version: true },
    where: { id: sale.id, storeId: context.storeId },
  });
  return commandResult(committed, updatedSettlement, false, confirmation.id);
}

async function replayConfirmedCodRefund(
  client: PrismaClient,
  context: StoreContext,
  input: ConfirmAfterSaleCodRefundInput,
  idempotencyKeyHash: string,
  requestHash: string,
): Promise<AfterSaleCodRefundCommandResult | null> {
  return withStoreTransaction(
    client,
    context,
    async (transaction) => {
      await assertCodAuthorization(transaction, context, 'store.after-sales.cod-refunds.confirm');
      const confirmation = await transaction.afterSaleCodRefundConfirmation.findUnique({
        where: {
          storeId_idempotencyKeyHash: { idempotencyKeyHash, storeId: context.storeId },
        },
      });
      if (!confirmation) return null;
      const settlement = await transaction.afterSaleSettlement.findFirst({
        where: {
          afterSaleId: input.afterSaleId,
          id: confirmation.settlementId,
          publicSettlementNumber: input.settlementNumber,
          storeId: context.storeId,
        },
      });
      const sale = await transaction.afterSale.findFirst({
        select: { id: true, publicCaseNumber: true, status: true, version: true },
        where: { id: input.afterSaleId, storeId: context.storeId },
      });
      if (!settlement || !sale || confirmation.requestHash !== requestHash) {
        throw new AfterSaleRefundCommandError('AFTER_SALE_IDEMPOTENCY_CONFLICT');
      }
      return commandResult(sale, settlement, true, confirmation.id);
    },
    { isolationLevel: 'ReadCommitted', timeout: 15_000 },
  );
}

export async function confirmAfterSaleCodRefund(
  client: PrismaClient,
  context: StoreContext,
  input: ConfirmAfterSaleCodRefundInput,
): Promise<AfterSaleCodRefundCommandResult> {
  assertContext(context);
  const reason = assertCommonInput(input);
  assertVersion(input.expectedVersion);
  assertVersion(input.expectedSettlementVersion);
  if (!isSettlementNumber(input.settlementNumber)) {
    throw new AfterSaleRefundCommandError('AFTER_SALE_INPUT_INVALID');
  }
  const idempotencyKeyHash = digest(input.idempotencyKey);
  const requestHash = digest(
    JSON.stringify({
      actor_id: context.actor.id,
      after_sale_id: input.afterSaleId,
      expected_settlement_version: input.expectedSettlementVersion,
      expected_version: input.expectedVersion,
      idempotency_key_hash: idempotencyKeyHash,
      operation: 'ADMIN_COD_REFUND_CONFIRM',
      path: `/v1/admin/after-sales/${input.afterSaleId}/cod-refunds/${input.settlementNumber}/confirm`,
      reason_hash: digest(reason),
      settlement_number: input.settlementNumber,
      store_id: context.storeId,
    }),
  );
  try {
    return await serializable(client, context, (transaction) =>
      confirmCodRefundInTransaction(
        transaction,
        context,
        input,
        idempotencyKeyHash,
        requestHash,
        reason,
      ),
    );
  } catch (error) {
    if (isUniqueConflict(error)) {
      const replay = await replayConfirmedCodRefund(
        client,
        context,
        input,
        idempotencyKeyHash,
        requestHash,
      );
      if (replay) return replay;
    }
    mapError(error);
  }
}

export type { AfterSaleRefundCommandErrorCode };
