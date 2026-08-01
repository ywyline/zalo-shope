import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

import { Prisma, type PrismaClient } from '@prisma/client';
import {
  afterSaleInspectionAcknowledgementResponseSchema,
  type AfterSaleInspectionRequest,
} from '@zalo-shop/contracts';
import type { StoreContext } from '@zalo-shop/domain';

import {
  AfterSaleCommandDatabaseError,
  canonicalAfterSaleCommandRequestHash,
} from './after-sale-command-primitives';
import { withStoreTransaction } from './index';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_PATTERN = /^[!-~]{16,128}$/;
const SERIALIZATION_RETRY_LIMIT = 3;

export type AfterSaleInspectionCommandResult = Readonly<{
  afterSaleId: string;
  inspectionVersion: number;
  operationId: string;
  publicCaseNumber: string;
  replayed: boolean;
  restoredItems: readonly Readonly<{ orderItemId: string; quantity: number }>[];
  status: 'REFUND_PENDING' | 'EXCHANGE_PENDING' | 'REJECTED';
  version: number;
}>;

export type InspectAfterSaleReturnInput = Readonly<{
  afterSaleId: string;
  body: AfterSaleInspectionRequest;
  idempotencyKey: string;
  sourceIp?: string;
}>;

type InspectionFunctionRow = {
  after_sale_id: string;
  inspection_version: number;
  operation_id: string;
  public_case_number: string;
  replayed: boolean;
  restored_items: Prisma.JsonValue;
  status: AfterSaleInspectionCommandResult['status'];
  version: number;
};

type InspectionReplayProbeRow = {
  after_sale_id: string;
  operation_id: string;
  operation_status: string;
  request_hash: string;
  result_summary: Prisma.JsonValue | null;
};

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeItems(items: AfterSaleInspectionRequest['items']) {
  return items
    .map((item) => ({
      dispositions: [...item.dispositions].sort((left, right) =>
        left.disposition.localeCompare(right.disposition, 'en'),
      ),
      order_item_id: item.order_item_id,
    }))
    .sort((left, right) => left.order_item_id.localeCompare(right.order_item_id, 'en'));
}

function assertInput(context: StoreContext, input: InspectAfterSaleReturnInput): void {
  const tokenExpiresAt = Date.parse(context.accessTokenExpiresAt ?? '');
  if (
    context.actor.type !== 'admin' ||
    context.adminAuthorizationScope !== 'STORE' ||
    !UUID_PATTERN.test(context.actor.id) ||
    !UUID_PATTERN.test(context.storeId) ||
    !UUID_PATTERN.test(context.accessSessionId ?? '') ||
    !Number.isFinite(tokenExpiresAt) ||
    tokenExpiresAt <= Date.now() ||
    context.correlationId.trim().length === 0 ||
    context.correlationId.length > 128 ||
    !UUID_PATTERN.test(input.afterSaleId) ||
    !IDEMPOTENCY_PATTERN.test(input.idempotencyKey) ||
    (input.sourceIp !== undefined && isIP(input.sourceIp) === 0)
  ) {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_AUTHORIZATION_DENIED');
  }
}

function commandResult(row: InspectionFunctionRow | undefined): AfterSaleInspectionCommandResult {
  if (!row || !UUID_PATTERN.test(row.operation_id)) {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_STATE_CONFLICT');
  }
  const parsed = afterSaleInspectionAcknowledgementResponseSchema.safeParse({
    id: row.after_sale_id,
    inspection_version: row.inspection_version,
    public_number: row.public_case_number,
    restored_items: row.restored_items,
    status: row.status,
    version: row.version,
  });
  if (!parsed.success) {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_STATE_CONFLICT');
  }
  return {
    afterSaleId: parsed.data.id,
    inspectionVersion: parsed.data.inspection_version,
    operationId: row.operation_id,
    publicCaseNumber: parsed.data.public_number,
    replayed: row.replayed,
    restoredItems: parsed.data.restored_items.map((item) => ({
      orderItemId: item.order_item_id,
      quantity: item.quantity,
    })),
    status: parsed.data.status,
    version: parsed.data.version,
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

function isUniqueConflict(error: unknown): boolean {
  const value = databaseError(error);
  return value.code === 'P2002' || value.sqlState === '23505';
}

function mapError(error: unknown): never {
  if (error instanceof AfterSaleCommandDatabaseError) throw error;
  const value = databaseError(error);
  if (value.code === 'P2002' || value.sqlState === '23505') {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_IDEMPOTENCY_CONFLICT');
  }
  if (value.sqlState === 'P0002') {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_NOT_FOUND');
  }
  if (value.sqlState === '42501') {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_AUTHORIZATION_DENIED');
  }
  if (value.code === 'P2034' || value.sqlState === '40001') {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_VERSION_CONFLICT');
  }
  if (value.code === 'P2003' || value.code === 'P2004' || value.sqlState === '23514') {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_STATE_CONFLICT');
  }
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

function assertCommittedReplayProbe(
  probe: InspectionReplayProbeRow,
  input: InspectAfterSaleReturnInput,
  requestHash: string,
): void {
  const summary = probe.result_summary;
  if (summary === null || Array.isArray(summary) || typeof summary !== 'object') {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_IDEMPOTENCY_CONFLICT');
  }
  const record = summary as Record<string, Prisma.JsonValue | undefined>;
  const expectedKeys = [
    'after_sale_id',
    'inspection_version',
    'operation_id',
    'public_case_number',
    'restored_items',
    'status',
    'version',
  ];
  if (
    probe.after_sale_id !== input.afterSaleId ||
    probe.operation_status !== 'COMPLETED' ||
    probe.request_hash !== requestHash ||
    Object.keys(record).sort().join('|') !== expectedKeys.join('|') ||
    record.after_sale_id !== probe.after_sale_id ||
    record.operation_id !== probe.operation_id ||
    !afterSaleInspectionAcknowledgementResponseSchema.safeParse({
      id: record.after_sale_id,
      inspection_version: record.inspection_version,
      public_number: record.public_case_number,
      restored_items: record.restored_items,
      status: record.status,
      version: record.version,
    }).success
  ) {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_IDEMPOTENCY_CONFLICT');
  }
}

async function replayCommittedInspection(
  client: PrismaClient,
  context: StoreContext,
  input: InspectAfterSaleReturnInput,
  items: ReturnType<typeof normalizeItems>,
  reason: string,
  idempotencyKeyHash: string,
  requestHash: string,
): Promise<AfterSaleInspectionCommandResult | null> {
  return withStoreTransaction(
    client,
    context,
    async (transaction) => {
      const probes = await transaction.$queryRaw<InspectionReplayProbeRow[]>(Prisma.sql`
        SELECT operation_row.after_sale_id, operation_row.id AS operation_id,
          operation_row.status AS operation_status, operation_row.request_hash,
          operation_row.result_summary
        FROM public.after_sale_operations operation_row
        WHERE operation_row.store_id = ${context.storeId}::uuid
          AND operation_row.operation = 'ADMIN_INSPECT_RETURN'
          AND operation_row.idempotency_key_hash = ${idempotencyKeyHash}
      `);
      const probe = probes[0];
      if (!probe) return null;
      if (probes.length !== 1) {
        throw new AfterSaleCommandDatabaseError('AFTER_SALE_STATE_CONFLICT');
      }
      assertCommittedReplayProbe(probe, input, requestHash);
      const rows = await transaction.$queryRaw<InspectionFunctionRow[]>(Prisma.sql`
        SELECT * FROM app_security.inspect_p0_m6_008_after_sale_return(
          ${input.afterSaleId}::uuid,
          ${randomUUID()}::uuid,
          ${idempotencyKeyHash},
          ${requestHash},
          ${input.body.expected_version}::integer,
          ${input.body.expected_inspection_version}::integer,
          ${JSON.stringify(items)}::jsonb,
          ${reason},
          ${input.sourceIp ?? null}::inet
        )
      `);
      const replay = commandResult(rows[0]);
      if (!replay.replayed || replay.operationId !== probe.operation_id) {
        throw new AfterSaleCommandDatabaseError('AFTER_SALE_STATE_CONFLICT');
      }
      return replay;
    },
    { isolationLevel: 'ReadCommitted', timeout: 20_000 },
  );
}

export async function inspectAfterSaleReturn(
  client: PrismaClient,
  context: StoreContext,
  input: InspectAfterSaleReturnInput,
): Promise<AfterSaleInspectionCommandResult> {
  assertInput(context, input);
  const items = normalizeItems(input.body.items);
  const reason = input.body.reason.trim();
  const idempotencyKeyHash = digest(input.idempotencyKey);
  const requestHash = canonicalAfterSaleCommandRequestHash({
    actor_id: context.actor.id,
    actor_type: context.actor.type,
    after_sale_id: input.afterSaleId,
    confirmation_code: input.body.confirmation_code,
    expected_inspection_version: input.body.expected_inspection_version,
    expected_version: input.body.expected_version,
    idempotency_key_hash: idempotencyKeyHash,
    items,
    operation: 'ADMIN_INSPECT_RETURN',
    path: `/v1/admin/after-sales/${input.afterSaleId}/inspection`,
    reason_digest: digest(reason),
    store_id: context.storeId,
  });

  try {
    return await retrySerializable(() =>
      withStoreTransaction(
        client,
        context,
        async (transaction) => {
          const rows = await transaction.$queryRaw<InspectionFunctionRow[]>(Prisma.sql`
            SELECT * FROM app_security.inspect_p0_m6_008_after_sale_return(
              ${input.afterSaleId}::uuid,
              ${randomUUID()}::uuid,
              ${idempotencyKeyHash},
              ${requestHash},
              ${input.body.expected_version}::integer,
              ${input.body.expected_inspection_version}::integer,
              ${JSON.stringify(items)}::jsonb,
              ${reason},
              ${input.sourceIp ?? null}::inet
            )
          `);
          return commandResult(rows[0]);
        },
        { isolationLevel: 'Serializable', timeout: 20_000 },
      ),
    );
  } catch (error) {
    if (isUniqueConflict(error)) {
      try {
        const replay = await replayCommittedInspection(
          client,
          context,
          input,
          items,
          reason,
          idempotencyKeyHash,
          requestHash,
        );
        if (replay) return replay;
      } catch (replayError) {
        return mapError(replayError);
      }
    }
    return mapError(error);
  }
}
