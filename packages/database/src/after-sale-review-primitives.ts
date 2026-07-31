import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

import type { AfterSaleReviewRequest, AfterSaleReviewResolveRequest } from '@zalo-shop/contracts';
import type { AfterSaleStatus, AfterSaleSystemContext, StoreContext } from '@zalo-shop/domain';
import { assertAfterSaleSystemEventAllowed } from '@zalo-shop/domain';

import { Prisma, type PrismaClient } from '@prisma/client';
import {
  AfterSaleCommandDatabaseError,
  canonicalAfterSaleCommandRequestHash,
  type AfterSaleCommandErrorCode,
} from './after-sale-command-primitives';
import { withAfterSaleSystemTransaction, withStoreTransaction } from './index';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IDEMPOTENCY_PATTERN = /^[!-~]{16,128}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SERIALIZATION_RETRY_LIMIT = 3;

type ReviewFunctionRow = {
  after_sale_id: string;
  operation_id: string;
  public_case_number: string;
  replayed: boolean;
  status: AfterSaleStatus;
  version: number;
};

export type AfterSaleReviewCommandResult = Readonly<{
  afterSaleId: string;
  operationId: string;
  publicCaseNumber: string;
  replayed: boolean;
  status: AfterSaleStatus;
  version: number;
}>;

export type ReviewAfterSaleCommandInput = Readonly<{
  afterSaleId: string;
  body: AfterSaleReviewRequest;
  idempotencyKey: string;
  sourceIp?: string;
}>;

export type ResolveAfterSaleReviewCommandInput = Readonly<{
  afterSaleId: string;
  body: AfterSaleReviewResolveRequest;
  idempotencyKey: string;
  policyBasisCiphertext?: string;
  policyBasisHash?: string;
  sourceIp?: string;
}>;

export type ExpireDueAfterSalesResult = Readonly<{
  expired: number;
  scanned: number;
  skipped: number;
}>;

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertAdminContext(context: StoreContext): void {
  const tokenExpiresAt = Date.parse(context.accessTokenExpiresAt ?? '');
  if (
    context.actor.type !== 'admin' ||
    !UUID_PATTERN.test(context.actor.id) ||
    !UUID_PATTERN.test(context.storeId) ||
    !UUID_PATTERN.test(context.accessSessionId ?? '') ||
    !Number.isFinite(tokenExpiresAt) ||
    tokenExpiresAt <= Date.now() ||
    context.correlationId.trim().length === 0 ||
    context.correlationId.length > 128 ||
    context.adminAuthorizationScope !== 'STORE'
  ) {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_AUTHORIZATION_DENIED');
  }
}

function assertCommonInput(input: {
  afterSaleId: string;
  expectedVersion: number;
  idempotencyKey: string;
  reason: string;
  sourceIp?: string;
}): void {
  if (
    !UUID_PATTERN.test(input.afterSaleId) ||
    !IDEMPOTENCY_PATTERN.test(input.idempotencyKey) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1 ||
    input.reason.trim().length < 10 ||
    input.reason.trim().length > 500 ||
    (input.sourceIp !== undefined && isIP(input.sourceIp) === 0)
  ) {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_INPUT_INVALID');
  }
}

function result(row: ReviewFunctionRow | undefined): AfterSaleReviewCommandResult {
  if (
    !row ||
    !UUID_PATTERN.test(row.after_sale_id) ||
    !UUID_PATTERN.test(row.operation_id) ||
    !Number.isSafeInteger(row.version) ||
    row.version < 1
  ) {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_STATE_CONFLICT');
  }
  return {
    afterSaleId: row.after_sale_id,
    operationId: row.operation_id,
    publicCaseNumber: row.public_case_number,
    replayed: row.replayed,
    status: row.status,
    version: row.version,
  };
}

function databaseError(error: unknown): { code?: string; message: string; sqlState?: string } {
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

function isRetryable(error: unknown): boolean {
  const value = databaseError(error);
  return (
    !value.message.includes('expected version') &&
    (value.code === 'P2034' || value.sqlState === '40001')
  );
}

function mapError(error: unknown): never {
  if (error instanceof AfterSaleCommandDatabaseError) throw error;
  const value = databaseError(error);
  let code: AfterSaleCommandErrorCode | undefined;
  if (value.code === 'P2002' || value.sqlState === '23505') {
    code = 'AFTER_SALE_IDEMPOTENCY_CONFLICT';
  } else if (value.sqlState === 'P0002') {
    code = 'AFTER_SALE_NOT_FOUND';
  } else if (value.sqlState === '42501') {
    code = 'AFTER_SALE_AUTHORIZATION_DENIED';
  } else if (value.code === 'P2034' || value.sqlState === '40001') {
    code = 'AFTER_SALE_VERSION_CONFLICT';
  } else if (value.code === 'P2003' || value.code === 'P2004' || value.sqlState === '23514') {
    code = 'AFTER_SALE_STATE_CONFLICT';
  }
  if (code) throw new AfterSaleCommandDatabaseError(code);
  throw error;
}

async function retrySerializable<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt + 1 < SERIALIZATION_RETRY_LIMIT && isRetryable(error)) continue;
      throw error;
    }
  }
}

export async function reviewAfterSaleCommand(
  client: PrismaClient,
  context: StoreContext,
  input: ReviewAfterSaleCommandInput,
): Promise<AfterSaleReviewCommandResult> {
  assertAdminContext(context);
  assertCommonInput({
    afterSaleId: input.afterSaleId,
    expectedVersion: input.body.expected_version,
    idempotencyKey: input.idempotencyKey,
    reason: input.body.reason,
    ...(input.sourceIp === undefined ? {} : { sourceIp: input.sourceIp }),
  });
  const idempotencyKeyHash = digest(input.idempotencyKey);
  const normalizedItems =
    input.body.decision === 'APPROVE'
      ? [...input.body.items]
          .map((item) => ({
            approved_quantity: item.approved_quantity,
            order_item_id: item.order_item_id,
          }))
          .sort((left, right) => left.order_item_id.localeCompare(right.order_item_id, 'en'))
      : [];
  const requestHash = canonicalAfterSaleCommandRequestHash({
    actor_id: context.actor.id,
    actor_type: context.actor.type,
    after_sale_id: input.afterSaleId,
    decision: input.body.decision,
    expected_version: input.body.expected_version,
    idempotency_key_hash: idempotencyKeyHash,
    items: normalizedItems,
    operation: 'ADMIN_REVIEW',
    path: `/v1/admin/after-sales/${input.afterSaleId}/review`,
    reason_digest: digest(input.body.reason.trim()),
    store_id: context.storeId,
  });
  try {
    return await retrySerializable(() =>
      withStoreTransaction(
        client,
        context,
        async (transaction) => {
          const rows = await transaction.$queryRaw<ReviewFunctionRow[]>(Prisma.sql`
            SELECT * FROM app_security.review_m63_b4_after_sale(
              ${input.afterSaleId}::uuid,
              ${randomUUID()}::uuid,
              ${idempotencyKeyHash},
              ${requestHash},
              ${input.body.expected_version}::integer,
              ${input.body.decision},
              ${JSON.stringify(normalizedItems)}::jsonb,
              ${input.body.reason.trim()},
              ${input.sourceIp ?? null}::inet
            )
          `);
          return result(rows[0]);
        },
        { isolationLevel: 'Serializable', timeout: 15_000 },
      ),
    );
  } catch (error) {
    return mapError(error);
  }
}

export async function resolveAfterSaleReviewCommand(
  client: PrismaClient,
  context: StoreContext,
  input: ResolveAfterSaleReviewCommandInput,
): Promise<AfterSaleReviewCommandResult> {
  assertAdminContext(context);
  assertCommonInput({
    afterSaleId: input.afterSaleId,
    expectedVersion: input.body.expected_version,
    idempotencyKey: input.idempotencyKey,
    reason: input.body.reason,
    ...(input.sourceIp === undefined ? {} : { sourceIp: input.sourceIp }),
  });
  const legacy =
    input.body.decision === 'LEGACY_APPROVE' || input.body.decision === 'LEGACY_REJECT';
  if (
    legacy !== (input.policyBasisCiphertext !== undefined && input.policyBasisHash !== undefined) ||
    (input.policyBasisHash !== undefined && !SHA256_PATTERN.test(input.policyBasisHash))
  ) {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_INPUT_INVALID');
  }
  const idempotencyKeyHash = digest(input.idempotencyKey);
  const requestHash = canonicalAfterSaleCommandRequestHash({
    actor_id: context.actor.id,
    actor_type: context.actor.type,
    after_sale_id: input.afterSaleId,
    decision: input.body.decision,
    expected_version: input.body.expected_version,
    idempotency_key_hash: idempotencyKeyHash,
    operation: 'ADMIN_RESOLVE_REVIEW',
    path: `/v1/admin/after-sales/${input.afterSaleId}/resolve-review`,
    policy_basis_hash: input.policyBasisHash ?? null,
    reason_digest: digest(input.body.reason.trim()),
    return_shipping_payer:
      input.body.decision === 'LEGACY_APPROVE' ? input.body.return_shipping_payer : null,
    return_window_days:
      input.body.decision === 'LEGACY_APPROVE' ? input.body.return_window_days : null,
    store_id: context.storeId,
  });
  try {
    return await retrySerializable(() =>
      withStoreTransaction(
        client,
        context,
        async (transaction) => {
          const rows = await transaction.$queryRaw<ReviewFunctionRow[]>(Prisma.sql`
            SELECT * FROM app_security.resolve_m63_b4_after_sale_review(
              ${input.afterSaleId}::uuid,
              ${randomUUID()}::uuid,
              ${idempotencyKeyHash},
              ${requestHash},
              ${input.body.expected_version}::integer,
              ${input.body.decision},
              ${input.body.reason.trim()},
              ${input.policyBasisCiphertext ?? null},
              ${input.policyBasisHash ?? null},
              ${input.body.decision === 'LEGACY_APPROVE' ? input.body.return_window_days : null}::integer,
              ${input.body.decision === 'LEGACY_APPROVE' ? input.body.return_shipping_payer : null},
              ${input.sourceIp ?? null}::inet
            )
          `);
          return result(rows[0]);
        },
        { isolationLevel: 'Serializable', timeout: 15_000 },
      ),
    );
  } catch (error) {
    return mapError(error);
  }
}

export async function expireDueAfterSales(
  client: PrismaClient,
  context: AfterSaleSystemContext,
  batchSize: number,
): Promise<ExpireDueAfterSalesResult> {
  assertAfterSaleSystemEventAllowed(context, 'RETURN_EXPIRED');
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_INPUT_INVALID');
  }
  const rows = await withAfterSaleSystemTransaction(
    client,
    context,
    (transaction) =>
      transaction.$queryRaw<Array<{ expired: number; scanned: number; skipped: number }>>`
        SELECT * FROM app_security.expire_m63_b4_due_after_sales(${batchSize}::integer)
      `,
    { isolationLevel: 'ReadCommitted', timeout: 15_000 },
  );
  const row = rows[0];
  if (!row) throw new AfterSaleCommandDatabaseError('AFTER_SALE_STATE_CONFLICT');
  return row;
}
