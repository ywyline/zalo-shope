import { createHash, createHmac, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

import { Prisma, type PrismaClient } from '@prisma/client';
import type {
  AfterSaleReturnFactRequest,
  AfterSaleReturnShipmentRequest,
} from '@zalo-shop/contracts';
import type { AfterSaleStatus, StoreContext } from '@zalo-shop/domain';

import {
  AfterSaleCommandDatabaseError,
  canonicalAfterSaleCommandRequestHash,
  type AfterSaleCommandErrorCode,
} from './after-sale-command-primitives';
import { withStoreTransaction } from './index';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IDEMPOTENCY_PATTERN = /^[!-~]{16,128}$/u;
const SERIALIZATION_RETRY_LIMIT = 3;

type ReturnCommandFunctionRow = {
  after_sale_id: string;
  operation_id: string;
  public_case_number: string;
  replayed: boolean;
  return_shipment_status: 'SUBMITTED' | 'IN_TRANSIT' | 'DELIVERED';
  return_shipment_version: number;
  status: AfterSaleStatus;
  version: number;
};

export type AfterSaleReturnCommandResult = Readonly<{
  afterSaleId: string;
  operationId: string;
  publicCaseNumber: string;
  replayed: boolean;
  returnShipmentStatus: 'SUBMITTED' | 'IN_TRANSIT' | 'DELIVERED';
  returnShipmentVersion: number;
  status: AfterSaleStatus;
  version: number;
}>;

export type SubmitMemberAfterSaleReturnInput = Readonly<{
  afterSaleId: string;
  body: AfterSaleReturnShipmentRequest;
  idempotencyKey: string;
  sourceIp?: string;
  trackingHashKey: string;
}>;

export type RecordAfterSaleReturnFactInput = Readonly<{
  afterSaleId: string;
  body: AfterSaleReturnFactRequest;
  idempotencyKey: string;
  sourceIp?: string;
}>;

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeText(value: string, minimum: number, maximum: number): string {
  const normalized = value.normalize('NFKC').trim();
  const hasControlCharacter = [...normalized].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
  if (normalized.length < minimum || normalized.length > maximum || hasControlCharacter) {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_INPUT_INVALID');
  }
  return normalized;
}

function trackingDigest(value: string, key: string): string {
  if (key.length < 32) {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_INPUT_INVALID');
  }
  return createHmac('sha256', key).update(value, 'utf8').digest('hex');
}

export function maskAfterSaleTrackingNumber(value: string): string {
  const characters = [...value];
  if (characters.length <= 4) return '*'.repeat(characters.length);
  return `${characters.slice(0, 2).join('')}${'*'.repeat(Math.min(8, characters.length - 4))}${characters.slice(-2).join('')}`;
}

function assertContext(context: StoreContext, actorType: 'admin' | 'member'): void {
  const tokenExpiresAt = Date.parse(context.accessTokenExpiresAt ?? '');
  if (
    context.actor.type !== actorType ||
    !UUID_PATTERN.test(context.actor.id) ||
    !UUID_PATTERN.test(context.storeId) ||
    !UUID_PATTERN.test(context.accessSessionId ?? '') ||
    !Number.isFinite(tokenExpiresAt) ||
    tokenExpiresAt <= Date.now() ||
    context.correlationId.trim().length === 0 ||
    context.correlationId.length > 128 ||
    (actorType === 'admin' && context.adminAuthorizationScope !== 'STORE')
  ) {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_AUTHORIZATION_DENIED');
  }
}

function assertCommonInput(input: {
  afterSaleId: string;
  expectedVersion: number;
  idempotencyKey: string;
  sourceIp?: string;
}): void {
  if (
    !UUID_PATTERN.test(input.afterSaleId) ||
    !IDEMPOTENCY_PATTERN.test(input.idempotencyKey) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1 ||
    (input.sourceIp !== undefined && isIP(input.sourceIp) === 0)
  ) {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_INPUT_INVALID');
  }
}

function commandResult(row: ReturnCommandFunctionRow | undefined): AfterSaleReturnCommandResult {
  if (
    !row ||
    !UUID_PATTERN.test(row.after_sale_id) ||
    !UUID_PATTERN.test(row.operation_id) ||
    !Number.isSafeInteger(row.version) ||
    row.version < 1 ||
    !Number.isSafeInteger(row.return_shipment_version) ||
    row.return_shipment_version < 1
  ) {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_STATE_CONFLICT');
  }
  return {
    afterSaleId: row.after_sale_id,
    operationId: row.operation_id,
    publicCaseNumber: row.public_case_number,
    replayed: row.replayed,
    returnShipmentStatus: row.return_shipment_status,
    returnShipmentVersion: row.return_shipment_version,
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
  } else if (value.sqlState === 'P6301') {
    code = 'AFTER_SALE_RETURN_WINDOW_CLOSED';
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

export async function submitMemberAfterSaleReturn(
  client: PrismaClient,
  context: StoreContext,
  input: SubmitMemberAfterSaleReturnInput,
): Promise<AfterSaleReturnCommandResult> {
  assertContext(context, 'member');
  assertCommonInput({
    afterSaleId: input.afterSaleId,
    expectedVersion: input.body.expected_version,
    idempotencyKey: input.idempotencyKey,
    ...(input.sourceIp === undefined ? {} : { sourceIp: input.sourceIp }),
  });
  const carrierName = normalizeText(input.body.carrier_name, 2, 160);
  const trackingNumber = normalizeText(input.body.tracking_number, 2, 160);
  const idempotencyKeyHash = digest(input.idempotencyKey);
  const trackingNumberDigest = trackingDigest(trackingNumber, input.trackingHashKey);
  const trackingNumberMasked = maskAfterSaleTrackingNumber(trackingNumber);
  const requestHash = canonicalAfterSaleCommandRequestHash({
    actor_id: context.actor.id,
    actor_type: context.actor.type,
    after_sale_id: input.afterSaleId,
    carrier_name: carrierName,
    expected_version: input.body.expected_version,
    idempotency_key_hash: idempotencyKeyHash,
    operation: 'MEMBER_SUBMIT_RETURN',
    path: `/v1/after-sales/${input.afterSaleId}/return-shipment`,
    store_id: context.storeId,
    tracking_number_digest: trackingNumberDigest,
  });
  try {
    return await retrySerializable(() =>
      withStoreTransaction(
        client,
        context,
        async (transaction) => {
          const rows = await transaction.$queryRaw<ReturnCommandFunctionRow[]>(Prisma.sql`
            SELECT * FROM app_security.submit_m63_b5_member_return(
              ${input.afterSaleId}::uuid,
              ${randomUUID()}::uuid,
              ${idempotencyKeyHash},
              ${requestHash},
              ${input.body.expected_version}::integer,
              ${carrierName},
              ${trackingNumberDigest},
              ${trackingNumberMasked},
              ${input.sourceIp ?? null}::inet
            )
          `);
          return commandResult(rows[0]);
        },
        { isolationLevel: 'Serializable', timeout: 15_000 },
      ),
    );
  } catch (error) {
    return mapError(error);
  }
}

export async function recordAfterSaleReturnFact(
  client: PrismaClient,
  context: StoreContext,
  input: RecordAfterSaleReturnFactInput,
): Promise<AfterSaleReturnCommandResult> {
  assertContext(context, 'admin');
  assertCommonInput({
    afterSaleId: input.afterSaleId,
    expectedVersion: input.body.expected_version,
    idempotencyKey: input.idempotencyKey,
    ...(input.sourceIp === undefined ? {} : { sourceIp: input.sourceIp }),
  });
  if (
    !Number.isSafeInteger(input.body.expected_return_shipment_version) ||
    input.body.expected_return_shipment_version < 1
  ) {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_INPUT_INVALID');
  }
  const reason = normalizeText(input.body.reason, 10, 500);
  const idempotencyKeyHash = digest(input.idempotencyKey);
  const requestHash = canonicalAfterSaleCommandRequestHash({
    actor_id: context.actor.id,
    actor_type: context.actor.type,
    after_sale_id: input.afterSaleId,
    expected_return_shipment_version: input.body.expected_return_shipment_version,
    expected_version: input.body.expected_version,
    idempotency_key_hash: idempotencyKeyHash,
    operation: 'ADMIN_RECORD_RETURN_FACT',
    path: `/v1/admin/after-sales/${input.afterSaleId}/return-shipment/fact`,
    reason_digest: digest(reason),
    status: input.body.status,
    store_id: context.storeId,
  });
  try {
    return await retrySerializable(() =>
      withStoreTransaction(
        client,
        context,
        async (transaction) => {
          const rows = await transaction.$queryRaw<ReturnCommandFunctionRow[]>(Prisma.sql`
            SELECT * FROM app_security.record_m63_b5_return_fact(
              ${input.afterSaleId}::uuid,
              ${randomUUID()}::uuid,
              ${idempotencyKeyHash},
              ${requestHash},
              ${input.body.expected_version}::integer,
              ${input.body.expected_return_shipment_version}::integer,
              ${input.body.status},
              ${reason},
              ${input.sourceIp ?? null}::inet
            )
          `);
          return commandResult(rows[0]);
        },
        { isolationLevel: 'Serializable', timeout: 15_000 },
      ),
    );
  } catch (error) {
    return mapError(error);
  }
}
