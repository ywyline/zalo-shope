import { createHash, randomUUID } from 'node:crypto';

import { Prisma, type PrismaClient } from '@prisma/client';
import type { StoreContext } from '@zalo-shop/domain';

import {
  assertReconcileAuthorization,
  FinancialReconciliationCommandError,
  isFinancialReconciliationSerializationConflict,
} from './financial-reconciliation-primitives';
import { type StoreTransaction, withStoreTransaction } from './index';

const IDEMPOTENCY_PATTERN = /^[!-~]{16,128}$/;
const REASON_MIN_LENGTH = 10;
const REASON_MAX_LENGTH = 500;
const BATCH_VERSION = 1;
const SERIALIZATION_RETRY_LIMIT = 3;

export type CloseFinancialReconciliationInput = Readonly<{
  batchId: string;
  confirmation: 'CLOSE_FINANCIAL_RECONCILIATION';
  decision: 'CLOSED_ACCEPTED' | 'CLOSED_ESCALATED';
  expectedBatchVersion: number;
  idempotencyKey: string;
  reason: string;
}>;

export type FinancialReconciliationExceptionSummary = Readonly<{
  differenceVnd: number;
  feeDifferenceVnd: number;
  grossAmountVnd: number;
  lineCount: number;
  netAmountVnd: number;
  status: string;
}>;

export type FinancialReconciliationReviewResult = Readonly<{
  batch: Readonly<{
    differenceVnd: number;
    exceptionCount: number;
    feeDifferenceVnd: number;
    id: string;
    status: 'MATCHED' | 'REVIEW_REQUIRED';
    version: number;
  }>;
  createdAt: Date;
  decision: 'CLOSED_ACCEPTED' | 'CLOSED_ESCALATED';
  exceptionSummary: readonly FinancialReconciliationExceptionSummary[];
  expectedBatchVersion: number;
  id: string;
  reason: string;
  replayed: boolean;
}>;

type PersistedReview = Prisma.FinancialReconciliationReviewGetPayload<{
  include: { batch: { include: { lines: true } } };
}>;

function digest(value: unknown): string {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : stableJson(value), 'utf8')
    .digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`;
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
    throw new FinancialReconciliationCommandError('FINANCIAL_RECONCILIATION_FACT_INVALID');
  }
  return result;
}

function normalizeInput(context: StoreContext, input: CloseFinancialReconciliationInput) {
  const reason = input.reason.trim();
  if (
    context.actor.type !== 'admin' ||
    input.confirmation !== 'CLOSE_FINANCIAL_RECONCILIATION' ||
    !['CLOSED_ACCEPTED', 'CLOSED_ESCALATED'].includes(input.decision) ||
    !Number.isSafeInteger(input.expectedBatchVersion) ||
    input.expectedBatchVersion !== BATCH_VERSION ||
    !IDEMPOTENCY_PATTERN.test(input.idempotencyKey) ||
    reason.length < REASON_MIN_LENGTH ||
    reason.length > REASON_MAX_LENGTH
  ) {
    throw new FinancialReconciliationCommandError('FINANCIAL_RECONCILIATION_INPUT_INVALID');
  }
  return {
    decision: input.decision,
    expectedBatchVersion: input.expectedBatchVersion,
    idempotencyKeyHash: digest(
      `${context.storeId}\u0000FINANCIAL_RECONCILIATION_REVIEW\u0000${input.idempotencyKey}`,
    ),
    requestHash: digest({
      batch_id: input.batchId,
      decision: input.decision,
      expected_batch_version: input.expectedBatchVersion,
      reason,
    }),
    reason,
  } as const;
}

function exceptionSummary(
  lines: PersistedReview['batch']['lines'],
): readonly FinancialReconciliationExceptionSummary[] {
  const summaries = new Map<
    string,
    {
      differenceVnd: number;
      feeDifferenceVnd: number;
      grossAmountVnd: number;
      lineCount: number;
      netAmountVnd: number;
      status: string;
    }
  >();
  for (const line of lines) {
    if (line.status === 'MATCHED') continue;
    const current = summaries.get(line.status) ?? {
      differenceVnd: 0,
      feeDifferenceVnd: 0,
      grossAmountVnd: 0,
      lineCount: 0,
      netAmountVnd: 0,
      status: line.status,
    };
    current.differenceVnd = checkedAdd(
      current.differenceVnd,
      line.differenceVnd === null ? 0 : safeInteger(line.differenceVnd),
    );
    current.feeDifferenceVnd = checkedAdd(
      current.feeDifferenceVnd,
      line.feeDifferenceVnd === null ? 0 : safeInteger(line.feeDifferenceVnd),
    );
    current.grossAmountVnd = checkedAdd(current.grossAmountVnd, safeInteger(line.grossAmountVnd));
    current.lineCount += 1;
    current.netAmountVnd = checkedAdd(current.netAmountVnd, safeInteger(line.netAmountVnd));
    summaries.set(line.status, current);
  }
  return [...summaries.values()].sort((left, right) => left.status.localeCompare(right.status));
}

function result(review: PersistedReview, replayed: boolean): FinancialReconciliationReviewResult {
  if (
    review.batch.status !== 'REVIEW_REQUIRED' ||
    review.batch.exceptionCount < 1 ||
    review.expectedBatchVersion !== review.batch.version
  ) {
    throw new FinancialReconciliationCommandError('FINANCIAL_RECONCILIATION_FACT_INVALID');
  }
  return {
    batch: {
      differenceVnd: safeInteger(review.batch.differenceVnd),
      exceptionCount: review.batch.exceptionCount,
      feeDifferenceVnd: safeInteger(review.batch.feeDifferenceVnd),
      id: review.batch.id,
      status: review.batch.status,
      version: review.batch.version,
    },
    createdAt: review.createdAt,
    decision: review.decision,
    exceptionSummary: exceptionSummary(review.batch.lines),
    expectedBatchVersion: review.expectedBatchVersion,
    id: review.id,
    reason: review.reason,
    replayed,
  };
}

async function closeInTransaction(
  transaction: StoreTransaction,
  context: StoreContext,
  input: CloseFinancialReconciliationInput,
): Promise<FinancialReconciliationReviewResult> {
  const normalized = normalizeInput(context, input);
  await transaction.$executeRaw`
    SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      ${`financial-reconciliation-review:${context.storeId}:${input.batchId}`}, 0
    ))
  `;
  await assertReconcileAuthorization(transaction, context);
  const existingByKey = await transaction.financialReconciliationReview.findUnique({
    include: { batch: { include: { lines: true } } },
    where: {
      storeId_idempotencyKeyHash: {
        idempotencyKeyHash: normalized.idempotencyKeyHash,
        storeId: context.storeId,
      },
    },
  });
  if (existingByKey) {
    if (existingByKey.requestHash !== normalized.requestHash) {
      throw new FinancialReconciliationCommandError(
        'FINANCIAL_RECONCILIATION_IDEMPOTENCY_CONFLICT',
      );
    }
    return result(existingByKey, true);
  }
  const batch = await transaction.financialReconciliationBatch.findUnique({
    include: { lines: true, review: true },
    where: { storeId_id: { id: input.batchId, storeId: context.storeId } },
  });
  if (!batch) {
    throw new FinancialReconciliationCommandError('FINANCIAL_RECONCILIATION_BATCH_NOT_FOUND');
  }
  if (batch.review) {
    throw new FinancialReconciliationCommandError('FINANCIAL_RECONCILIATION_REVIEW_CONFLICT');
  }
  if (batch.createdBy === context.actor.id) {
    throw new FinancialReconciliationCommandError(
      'FINANCIAL_RECONCILIATION_MAKER_CHECKER_CONFLICT',
    );
  }
  if (
    batch.status !== 'REVIEW_REQUIRED' ||
    batch.exceptionCount < 1 ||
    batch.version !== normalized.expectedBatchVersion
  ) {
    throw new FinancialReconciliationCommandError('FINANCIAL_RECONCILIATION_BATCH_NOT_REVIEWABLE');
  }
  const review = await transaction.financialReconciliationReview.create({
    data: {
      batchId: batch.id,
      correlationId: context.correlationId,
      decision: normalized.decision,
      expectedBatchVersion: normalized.expectedBatchVersion,
      id: randomUUID(),
      idempotencyKeyHash: normalized.idempotencyKeyHash,
      reason: normalized.reason,
      requestHash: normalized.requestHash,
      reviewedBy: context.actor.id,
      storeId: context.storeId,
    },
  });
  const persisted = {
    ...review,
    batch: { ...batch, review },
  } as PersistedReview;
  await transaction.auditLog.create({
    data: {
      action: 'financial-reconciliation.batch.reviewed',
      actorId: context.actor.id,
      actorType: 'ADMIN',
      afterData: {
        batch_id: batch.id,
        decision: normalized.decision,
        exception_count: batch.exceptionCount,
        exception_summary: exceptionSummary(batch.lines),
        fee_difference_vnd: safeInteger(batch.feeDifferenceVnd),
        difference_vnd: safeInteger(batch.differenceVnd),
        expected_batch_version: normalized.expectedBatchVersion,
        review_id: review.id,
      },
      correlationId: context.correlationId,
      reason: normalized.reason,
      storeId: context.storeId,
      targetId: review.id,
      targetType: 'financial_reconciliation_review',
    },
  });
  return result(persisted, false);
}

export async function closeFinancialReconciliation(
  client: PrismaClient,
  context: StoreContext,
  input: CloseFinancialReconciliationInput,
): Promise<FinancialReconciliationReviewResult> {
  let attempts = 0;
  try {
    for (;;) {
      try {
        return await withStoreTransaction(
          client,
          context,
          (transaction) => closeInTransaction(transaction, context, input),
          { isolationLevel: 'Serializable', timeout: 20_000 },
        );
      } catch (error) {
        if (
          !isFinancialReconciliationSerializationConflict(error) ||
          ++attempts >= SERIALIZATION_RETRY_LIMIT
        )
          throw error;
      }
    }
  } catch (error) {
    if (error instanceof FinancialReconciliationCommandError) throw error;
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new FinancialReconciliationCommandError('FINANCIAL_RECONCILIATION_REVIEW_CONFLICT');
    }
    const meta =
      error instanceof Prisma.PrismaClientKnownRequestError
        ? (error.meta as { code?: unknown } | undefined)
        : undefined;
    if (meta?.code === '42501') {
      throw new FinancialReconciliationCommandError(
        'FINANCIAL_RECONCILIATION_MAKER_CHECKER_CONFLICT',
      );
    }
    throw error;
  }
}
