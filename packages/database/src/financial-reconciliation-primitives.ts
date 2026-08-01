import { createHash, randomUUID } from 'node:crypto';

import { Prisma, type PrismaClient } from '@prisma/client';
import type { StoreContext } from '@zalo-shop/domain';

import { type StoreTransaction, withStoreTransaction } from './index';

const IDEMPOTENCY_PATTERN = /^[!-~]{16,128}$/;
const BUSINESS_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SERIALIZATION_RETRY_LIMIT = 3;
const MAX_RECORDS = 500;

export type FinancialReconciliationCommandErrorCode =
  | 'FINANCIAL_RECONCILIATION_INPUT_INVALID'
  | 'FINANCIAL_RECONCILIATION_AUTHORIZATION_DENIED'
  | 'FINANCIAL_RECONCILIATION_CHANNEL_NOT_FOUND'
  | 'FINANCIAL_RECONCILIATION_IDEMPOTENCY_CONFLICT'
  | 'FINANCIAL_RECONCILIATION_BATCH_REFERENCE_CONFLICT'
  | 'FINANCIAL_RECONCILIATION_FACT_INVALID';

export class FinancialReconciliationCommandError extends Error {
  public constructor(public readonly code: FinancialReconciliationCommandErrorCode) {
    super(code);
    this.name = 'FinancialReconciliationCommandError';
  }
}

export type PaymentSettlementRecordInput = Readonly<{
  feeAmountVnd: number;
  grossAmountVnd: number;
  occurredAt: Date;
  providerReference: string;
  recordReference: string;
  type: 'PAYMENT' | 'REFUND';
}>;

export type ImportPaymentSettlementBatchInput = Readonly<{
  batchReference: string;
  businessDate: string;
  confirmation: 'IMPORT_PAYMENT_SETTLEMENT';
  idempotencyKey: string;
  providerCode: 'ZALO_CHECKOUT_ZALOPAY';
  providerEnvironment: 'SANDBOX' | 'PRODUCTION';
  reason: string;
  records: readonly PaymentSettlementRecordInput[];
}>;

export type FinancialReconciliationLineResult = Readonly<{
  differenceVnd: number | null;
  feeAmountVnd: number;
  grossAmountVnd: number;
  id: string;
  lineNumber: number;
  localExpectedAmountVnd: number | null;
  netAmountVnd: number;
  occurredAt: Date;
  providerReferenceMasked: string;
  recordReferenceMasked: string;
  status:
    | 'MATCHED'
    | 'AMOUNT_MISMATCH'
    | 'REFERENCE_NOT_FOUND'
    | 'FACT_NOT_FINAL'
    | 'DUPLICATE_REFERENCE';
  type: 'PAYMENT' | 'REFUND';
}>;

export type FinancialReconciliationBatchResult = Readonly<{
  batchReferenceMasked: string;
  businessDate: string;
  createdAt: Date;
  differenceVnd: number;
  exceptionCount: number;
  feeAmountVnd: number;
  grossAmountVnd: number;
  id: string;
  lines: readonly FinancialReconciliationLineResult[];
  localExpectedAmountVnd: number;
  matchedCount: number;
  netAmountVnd: number;
  recordCount: number;
  replayed: boolean;
  source: 'PAYMENT_PROVIDER';
  status: 'MATCHED' | 'REVIEW_REQUIRED';
  version: number;
}>;

type NormalizedRecord = Readonly<{
  feeAmountVnd: number;
  grossAmountVnd: number;
  lineNumber: number;
  occurredAt: Date;
  providerReference: string;
  recordReference: string;
  type: 'PAYMENT' | 'REFUND';
}>;

type MatchedLine = NormalizedRecord &
  Readonly<{
    differenceVnd: number | null;
    localExpectedAmountVnd: number | null;
    netAmountVnd: number;
    paymentAttemptId: string | null;
    refundId: string | null;
    status: FinancialReconciliationLineResult['status'];
  }>;

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

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

function maskReference(value: string): string {
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${value.slice(0, 2)}${'*'.repeat(Math.min(8, value.length - 4))}${value.slice(-2)}`;
}

function safeInteger(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new FinancialReconciliationCommandError('FINANCIAL_RECONCILIATION_FACT_INVALID');
  }
  return result;
}

function checkedAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new FinancialReconciliationCommandError('FINANCIAL_RECONCILIATION_INPUT_INVALID');
  }
  return result;
}

function normalizedReference(value: string): string {
  const result = value.trim();
  if (result.length < 1 || result.length > 160) {
    throw new FinancialReconciliationCommandError('FINANCIAL_RECONCILIATION_INPUT_INVALID');
  }
  return result;
}

function parseBusinessDate(value: string): Date {
  if (!BUSINESS_DATE_PATTERN.test(value)) {
    throw new FinancialReconciliationCommandError('FINANCIAL_RECONCILIATION_INPUT_INVALID');
  }
  const result = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(result.getTime()) || result.toISOString().slice(0, 10) !== value) {
    throw new FinancialReconciliationCommandError('FINANCIAL_RECONCILIATION_INPUT_INVALID');
  }
  return result;
}

function normalizeInput(
  context: StoreContext,
  input: ImportPaymentSettlementBatchInput,
): Readonly<{
  batchReference: string;
  batchReferenceDigest: string;
  businessDate: Date;
  businessDateText: string;
  idempotencyKeyHash: string;
  inputDigest: string;
  reason: string;
  records: readonly NormalizedRecord[];
}> {
  const reason = input.reason.trim();
  if (
    context.actor.type !== 'admin' ||
    input.confirmation !== 'IMPORT_PAYMENT_SETTLEMENT' ||
    input.providerCode !== 'ZALO_CHECKOUT_ZALOPAY' ||
    !['SANDBOX', 'PRODUCTION'].includes(input.providerEnvironment) ||
    !IDEMPOTENCY_PATTERN.test(input.idempotencyKey) ||
    reason.length < 10 ||
    reason.length > 500 ||
    input.records.length < 1 ||
    input.records.length > MAX_RECORDS
  ) {
    throw new FinancialReconciliationCommandError('FINANCIAL_RECONCILIATION_INPUT_INVALID');
  }
  const batchReference = normalizedReference(input.batchReference);
  const records = input.records.map((record, index): NormalizedRecord => {
    const grossAmountVnd = record.grossAmountVnd;
    const feeAmountVnd = record.feeAmountVnd;
    if (
      !['PAYMENT', 'REFUND'].includes(record.type) ||
      !Number.isSafeInteger(grossAmountVnd) ||
      grossAmountVnd <= 0 ||
      !Number.isSafeInteger(feeAmountVnd) ||
      feeAmountVnd < 0 ||
      (record.type === 'PAYMENT' && feeAmountVnd > grossAmountVnd) ||
      !(record.occurredAt instanceof Date) ||
      !Number.isFinite(record.occurredAt.getTime())
    ) {
      throw new FinancialReconciliationCommandError('FINANCIAL_RECONCILIATION_INPUT_INVALID');
    }
    return {
      feeAmountVnd,
      grossAmountVnd,
      lineNumber: index + 1,
      occurredAt: new Date(record.occurredAt),
      providerReference: normalizedReference(record.providerReference),
      recordReference: normalizedReference(record.recordReference),
      type: record.type,
    };
  });
  const recordReferences = new Set(records.map((record) => record.recordReference));
  if (recordReferences.size !== records.length) {
    throw new FinancialReconciliationCommandError('FINANCIAL_RECONCILIATION_INPUT_INVALID');
  }
  const businessDate = parseBusinessDate(input.businessDate);
  const normalizedForDigest = {
    batch_reference: batchReference,
    business_date: input.businessDate,
    provider_code: input.providerCode,
    provider_environment: input.providerEnvironment,
    reason,
    records: records.map((record) => ({
      fee_amount_vnd: record.feeAmountVnd,
      gross_amount_vnd: record.grossAmountVnd,
      occurred_at: record.occurredAt.toISOString(),
      provider_reference: record.providerReference,
      record_reference: record.recordReference,
      type: record.type,
    })),
  };
  return {
    batchReference,
    batchReferenceDigest: digest(
      `${context.storeId}\u0000${input.providerEnvironment}\u0000${input.providerCode}\u0000${batchReference}`,
    ),
    businessDate,
    businessDateText: input.businessDate,
    idempotencyKeyHash: digest(
      `${context.storeId}\u0000PAYMENT_PROVIDER\u0000${input.idempotencyKey}`,
    ),
    inputDigest: digest(stableJson(normalizedForDigest)),
    reason,
    records,
  };
}

async function assertReconcileAuthorization(
  transaction: StoreTransaction,
  context: StoreContext,
): Promise<void> {
  if (
    context.actor.type !== 'admin' ||
    context.adminAuthorizationScope !== 'STORE' ||
    !context.accessSessionId ||
    !context.accessTokenExpiresAt
  ) {
    throw new FinancialReconciliationCommandError('FINANCIAL_RECONCILIATION_AUTHORIZATION_DENIED');
  }
  const authorization = await transaction.$queryRaw<Array<{ session_id: string }>>`
    SELECT session.id AS session_id
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
    throw new FinancialReconciliationCommandError('FINANCIAL_RECONCILIATION_AUTHORIZATION_DENIED');
  }
  const permissions = await transaction.$queryRaw<Array<{ permission_code: string }>>`
    SELECT role_permission.permission_code
    FROM admin_store_roles assignment
    JOIN store_role_permissions role_permission
      ON role_permission.store_id = assignment.store_id
      AND role_permission.role_id = assignment.role_id
    WHERE assignment.store_id = ${context.storeId}::uuid
      AND assignment.admin_user_id = ${context.actor.id}::uuid
      AND role_permission.permission_code = 'store.finance.reconcile'
    ORDER BY assignment.role_id
    FOR SHARE OF assignment, role_permission
  `;
  if (permissions.length < 1) {
    throw new FinancialReconciliationCommandError('FINANCIAL_RECONCILIATION_AUTHORIZATION_DENIED');
  }
}

function lineNetAmount(record: NormalizedRecord): number {
  return record.type === 'PAYMENT'
    ? checkedAdd(record.grossAmountVnd, -record.feeAmountVnd)
    : -checkedAdd(record.grossAmountVnd, record.feeAmountVnd);
}

function matchStatus(
  factStatus: string,
  grossAmountVnd: number,
  localExpectedAmountVnd: number,
): 'MATCHED' | 'AMOUNT_MISMATCH' | 'FACT_NOT_FINAL' {
  if (factStatus !== 'SUCCEEDED') return 'FACT_NOT_FINAL';
  return grossAmountVnd === localExpectedAmountVnd ? 'MATCHED' : 'AMOUNT_MISMATCH';
}

async function matchRecords(
  transaction: StoreTransaction,
  context: StoreContext,
  channelId: string,
  records: readonly NormalizedRecord[],
): Promise<readonly MatchedLine[]> {
  const referenceCounts = new Map<string, number>();
  for (const record of records) {
    const key = `${record.type}\u0000${record.providerReference}`;
    referenceCounts.set(key, (referenceCounts.get(key) ?? 0) + 1);
  }
  const uniquePaymentReferences = records
    .filter(
      (record) =>
        record.type === 'PAYMENT' &&
        referenceCounts.get(`${record.type}\u0000${record.providerReference}`) === 1,
    )
    .map((record) => record.providerReference);
  const uniqueRefundReferences = records
    .filter(
      (record) =>
        record.type === 'REFUND' &&
        referenceCounts.get(`${record.type}\u0000${record.providerReference}`) === 1,
    )
    .map((record) => record.providerReference);
  const payments = uniquePaymentReferences.length
    ? await transaction.paymentAttempt.findMany({
        select: { amountVnd: true, id: true, providerTransactionId: true, status: true },
        where: {
          channelId,
          providerTransactionId: { in: uniquePaymentReferences },
          storeId: context.storeId,
        },
      })
    : [];
  const refunds = uniqueRefundReferences.length
    ? await transaction.refund.findMany({
        select: { amountVnd: true, id: true, providerRefundId: true, status: true },
        where: {
          paymentAttempt: { channelId },
          providerRefundId: { in: uniqueRefundReferences },
          storeId: context.storeId,
        },
      })
    : [];
  const paymentByReference = new Map(
    payments.flatMap((payment) =>
      payment.providerTransactionId ? [[payment.providerTransactionId, payment] as const] : [],
    ),
  );
  const refundByReference = new Map(
    refunds.flatMap((refund) =>
      refund.providerRefundId ? [[refund.providerRefundId, refund] as const] : [],
    ),
  );

  return records.map((record): MatchedLine => {
    const netAmountVnd = lineNetAmount(record);
    if (referenceCounts.get(`${record.type}\u0000${record.providerReference}`)! > 1) {
      return {
        ...record,
        differenceVnd: null,
        localExpectedAmountVnd: null,
        netAmountVnd,
        paymentAttemptId: null,
        refundId: null,
        status: 'DUPLICATE_REFERENCE',
      };
    }
    const fact =
      record.type === 'PAYMENT'
        ? paymentByReference.get(record.providerReference)
        : refundByReference.get(record.providerReference);
    if (!fact) {
      return {
        ...record,
        differenceVnd: null,
        localExpectedAmountVnd: null,
        netAmountVnd,
        paymentAttemptId: null,
        refundId: null,
        status: 'REFERENCE_NOT_FOUND',
      };
    }
    const localExpectedAmountVnd = safeInteger(fact.amountVnd);
    const differenceVnd = checkedAdd(record.grossAmountVnd, -localExpectedAmountVnd);
    return {
      ...record,
      differenceVnd,
      localExpectedAmountVnd,
      netAmountVnd,
      paymentAttemptId: record.type === 'PAYMENT' ? fact.id : null,
      refundId: record.type === 'REFUND' ? fact.id : null,
      status: matchStatus(fact.status, record.grossAmountVnd, localExpectedAmountVnd),
    };
  });
}

type PersistedBatch = Prisma.FinancialReconciliationBatchGetPayload<{
  include: { lines: true };
}>;

function result(batch: PersistedBatch, replayed: boolean): FinancialReconciliationBatchResult {
  return {
    batchReferenceMasked: batch.batchReferenceMasked,
    businessDate: batch.businessDate.toISOString().slice(0, 10),
    createdAt: batch.createdAt,
    differenceVnd: safeInteger(batch.differenceVnd),
    exceptionCount: batch.exceptionCount,
    feeAmountVnd: safeInteger(batch.feeAmountVnd),
    grossAmountVnd: safeInteger(batch.grossAmountVnd),
    id: batch.id,
    lines: [...batch.lines]
      .sort((left, right) => left.lineNumber - right.lineNumber)
      .map((line) => ({
        differenceVnd: line.differenceVnd === null ? null : safeInteger(line.differenceVnd),
        feeAmountVnd: safeInteger(line.feeAmountVnd),
        grossAmountVnd: safeInteger(line.grossAmountVnd),
        id: line.id,
        lineNumber: line.lineNumber,
        localExpectedAmountVnd:
          line.localExpectedAmountVnd === null ? null : safeInteger(line.localExpectedAmountVnd),
        netAmountVnd: safeInteger(line.netAmountVnd),
        occurredAt: line.occurredAt,
        providerReferenceMasked: line.providerReferenceMasked,
        recordReferenceMasked: line.recordReferenceMasked,
        status: line.status,
        type: line.type,
      })),
    localExpectedAmountVnd: safeInteger(batch.localExpectedAmountVnd),
    matchedCount: batch.matchedCount,
    netAmountVnd: safeInteger(batch.netAmountVnd),
    recordCount: batch.recordCount,
    replayed,
    source: batch.source,
    status: batch.status,
    version: batch.version,
  };
}

async function importInTransaction(
  transaction: StoreTransaction,
  context: StoreContext,
  input: ImportPaymentSettlementBatchInput,
): Promise<FinancialReconciliationBatchResult> {
  const normalized = normalizeInput(context, input);
  await transaction.$executeRaw`
    SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      ${`financial-reconciliation:${context.storeId}:${normalized.idempotencyKeyHash}`}, 0
    ))
  `;
  await assertReconcileAuthorization(transaction, context);
  const replay = await transaction.financialReconciliationBatch.findUnique({
    include: { lines: true },
    where: {
      storeId_source_idempotencyKeyHash: {
        idempotencyKeyHash: normalized.idempotencyKeyHash,
        source: 'PAYMENT_PROVIDER',
        storeId: context.storeId,
      },
    },
  });
  if (replay) {
    if (replay.inputDigest !== normalized.inputDigest) {
      throw new FinancialReconciliationCommandError(
        'FINANCIAL_RECONCILIATION_IDEMPOTENCY_CONFLICT',
      );
    }
    return result(replay, true);
  }
  const channel = await transaction.storePaymentChannel.findFirst({
    select: { id: true },
    where: {
      providerCode: input.providerCode,
      providerEnvironment: input.providerEnvironment,
      storeId: context.storeId,
    },
  });
  if (!channel) {
    throw new FinancialReconciliationCommandError('FINANCIAL_RECONCILIATION_CHANNEL_NOT_FOUND');
  }
  const existingReference = await transaction.financialReconciliationBatch.findUnique({
    select: { id: true },
    where: {
      storeId_paymentChannelId_batchReferenceDigest: {
        batchReferenceDigest: normalized.batchReferenceDigest,
        paymentChannelId: channel.id,
        storeId: context.storeId,
      },
    },
  });
  if (existingReference) {
    throw new FinancialReconciliationCommandError(
      'FINANCIAL_RECONCILIATION_BATCH_REFERENCE_CONFLICT',
    );
  }
  const lines = await matchRecords(transaction, context, channel.id, normalized.records);
  const summary = lines.reduce(
    (current, line) => ({
      differenceVnd: checkedAdd(current.differenceVnd, line.differenceVnd ?? 0),
      exceptionCount: current.exceptionCount + (line.status === 'MATCHED' ? 0 : 1),
      feeAmountVnd: checkedAdd(current.feeAmountVnd, line.feeAmountVnd),
      grossAmountVnd: checkedAdd(current.grossAmountVnd, line.grossAmountVnd),
      localExpectedAmountVnd: checkedAdd(
        current.localExpectedAmountVnd,
        line.localExpectedAmountVnd ?? 0,
      ),
      matchedCount: current.matchedCount + (line.status === 'MATCHED' ? 1 : 0),
      netAmountVnd: checkedAdd(current.netAmountVnd, line.netAmountVnd),
    }),
    {
      differenceVnd: 0,
      exceptionCount: 0,
      feeAmountVnd: 0,
      grossAmountVnd: 0,
      localExpectedAmountVnd: 0,
      matchedCount: 0,
      netAmountVnd: 0,
    },
  );
  const batchId = randomUUID();
  await transaction.financialReconciliationBatch.create({
    data: {
      batchReferenceDigest: normalized.batchReferenceDigest,
      batchReferenceMasked: maskReference(normalized.batchReference),
      businessDate: normalized.businessDate,
      correlationId: context.correlationId,
      createdBy: context.actor.id,
      differenceVnd: summary.differenceVnd,
      exceptionCount: summary.exceptionCount,
      feeAmountVnd: summary.feeAmountVnd,
      grossAmountVnd: summary.grossAmountVnd,
      id: batchId,
      idempotencyKeyHash: normalized.idempotencyKeyHash,
      inputDigest: normalized.inputDigest,
      localExpectedAmountVnd: summary.localExpectedAmountVnd,
      matchedCount: summary.matchedCount,
      netAmountVnd: summary.netAmountVnd,
      paymentChannelId: channel.id,
      reason: normalized.reason,
      recordCount: lines.length,
      source: 'PAYMENT_PROVIDER',
      status: summary.exceptionCount === 0 ? 'MATCHED' : 'REVIEW_REQUIRED',
      storeId: context.storeId,
    },
  });
  await transaction.financialReconciliationLine.createMany({
    data: lines.map((line) => ({
      batchId,
      differenceVnd: line.differenceVnd,
      feeAmountVnd: line.feeAmountVnd,
      grossAmountVnd: line.grossAmountVnd,
      lineNumber: line.lineNumber,
      localExpectedAmountVnd: line.localExpectedAmountVnd,
      netAmountVnd: line.netAmountVnd,
      occurredAt: line.occurredAt,
      paymentAttemptId: line.paymentAttemptId,
      providerReferenceDigest: digest(
        `${context.storeId}\u0000${channel.id}\u0000${line.type}\u0000${line.providerReference}`,
      ),
      providerReferenceMasked: maskReference(line.providerReference),
      recordReferenceDigest: digest(
        `${normalized.batchReferenceDigest}\u0000${line.recordReference}`,
      ),
      recordReferenceMasked: maskReference(line.recordReference),
      refundId: line.refundId,
      status: line.status,
      storeId: context.storeId,
      type: line.type,
    })),
  });
  const batch = await transaction.financialReconciliationBatch.findUniqueOrThrow({
    include: { lines: true },
    where: { storeId_id: { id: batchId, storeId: context.storeId } },
  });
  await transaction.auditLog.create({
    data: {
      action: 'financial-reconciliation.payment-batch.imported',
      actorId: context.actor.id,
      actorType: 'ADMIN',
      afterData: {
        batch_id: batch.id,
        business_date: normalized.businessDateText,
        exception_count: summary.exceptionCount,
        fee_amount_vnd: summary.feeAmountVnd,
        gross_amount_vnd: summary.grossAmountVnd,
        matched_count: summary.matchedCount,
        net_amount_vnd: summary.netAmountVnd,
        record_count: lines.length,
        status: batch.status,
      },
      correlationId: context.correlationId,
      reason: normalized.reason,
      storeId: context.storeId,
      targetId: batch.id,
      targetType: 'financial_reconciliation_batch',
    },
  });
  return result(batch, false);
}

function isSerializationConflict(error: unknown): boolean {
  return (
    (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') ||
    (error instanceof Error && error.message.includes('40001'))
  );
}

function mapCommandError(error: unknown): never {
  if (error instanceof FinancialReconciliationCommandError) throw error;
  const meta =
    error instanceof Prisma.PrismaClientKnownRequestError
      ? (error.meta as { code?: unknown } | undefined)
      : undefined;
  if (meta?.code === '42501') {
    throw new FinancialReconciliationCommandError('FINANCIAL_RECONCILIATION_AUTHORIZATION_DENIED');
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw new FinancialReconciliationCommandError(
      'FINANCIAL_RECONCILIATION_BATCH_REFERENCE_CONFLICT',
    );
  }
  throw error;
}

export async function importPaymentSettlementBatch(
  client: PrismaClient,
  context: StoreContext,
  input: ImportPaymentSettlementBatchInput,
): Promise<FinancialReconciliationBatchResult> {
  let attempts = 0;
  try {
    for (;;) {
      try {
        return await withStoreTransaction(
          client,
          context,
          (transaction) => importInTransaction(transaction, context, input),
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
