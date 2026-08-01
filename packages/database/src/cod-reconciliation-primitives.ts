import { createHash, randomUUID } from 'node:crypto';

import { Prisma, type PrismaClient } from '@prisma/client';
import type { StoreContext } from '@zalo-shop/domain';

import { type StoreTransaction, withStoreTransaction } from './index';
import { FinancialReconciliationCommandError } from './financial-reconciliation-primitives';

const IDEMPOTENCY_PATTERN = /^[!-~]{16,128}$/;
const BUSINESS_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RECORDS = 500;
const SERIALIZATION_RETRY_LIMIT = 3;

export type CodRemittanceRecordInput = Readonly<{
  codAmountVnd: number;
  codFeeVnd: number;
  occurredAt: Date;
  providerReference: string;
  recordReference: string;
  shippingFeeVnd: number;
}>;

export type ImportCodRemittanceBatchInput = Readonly<{
  batchReference: string;
  businessDate: string;
  confirmation: string;
  idempotencyKey: string;
  providerCode: 'GHN';
  providerEnvironment: 'SANDBOX' | 'PRODUCTION';
  reason: string;
  records: readonly CodRemittanceRecordInput[];
}>;

export type CodRemittanceBatchResult = Readonly<{
  batchReferenceMasked: string;
  businessDate: string;
  createdAt: Date;
  differenceVnd: number;
  exceptionCount: number;
  feeAmountVnd: number;
  feeDifferenceVnd: number;
  grossAmountVnd: number;
  id: string;
  lines: readonly CodRemittanceLineResult[];
  localExpectedAmountVnd: number;
  localExpectedFeeAmountVnd: number;
  matchedCount: number;
  netAmountVnd: number;
  recordCount: number;
  replayed: boolean;
  source: 'SHIPPING_PROVIDER';
  status: 'MATCHED' | 'REVIEW_REQUIRED';
  version: number;
}>;

export type CodRemittanceLineResult = Readonly<{
  differenceVnd: number | null;
  feeAmountVnd: number;
  feeDifferenceVnd: number | null;
  grossAmountVnd: number;
  id: string;
  lineNumber: number;
  localExpectedAmountVnd: number | null;
  localExpectedFeeAmountVnd: number | null;
  netAmountVnd: number;
  occurredAt: Date;
  providerReferenceMasked: string;
  recordReferenceMasked: string;
  status: CodRemittanceLineStatus;
  type: 'COD_REMITTANCE';
}>;

export type CodRemittanceLineStatus =
  | 'MATCHED'
  | 'AMOUNT_MISMATCH'
  | 'FEE_MISMATCH'
  | 'REFERENCE_NOT_FOUND'
  | 'FACT_NOT_FINAL'
  | 'COD_NOT_RECEIVABLE'
  | 'EXPECTED_FEE_NOT_FOUND'
  | 'DUPLICATE_REFERENCE';

export type CodReceivableStatus = 'UNREMITTED' | 'REMITTED' | 'REVIEW_REQUIRED';
export type CodReceivable = Readonly<{
  deliveredAt: Date | null;
  expectedCodAmountVnd: number;
  expectedFeeAmountVnd: number | null;
  expectedNetAmountVnd: number | null;
  id: string;
  lastBatchId: string | null;
  orderNumber: string;
  providerReferenceMasked: string | null;
  publicShipmentNumber: string;
  status: CodReceivableStatus;
}>;

export type CodReceivablePage = Readonly<{
  items: readonly CodReceivable[];
  nextCursor: string | null;
}>;

type NormalizedRecord = CodRemittanceRecordInput & {
  feeAmountVnd: number;
  grossAmountVnd: number;
  lineNumber: number;
};

function digest(value: unknown): string {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : stableJson(value), 'utf8')
    .digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(',')}}`;
}

function maskReference(value: string): string {
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${'*'.repeat(Math.min(8, value.length - 4))}${value.slice(-4)}`;
}

function providerReferenceDigest(storeId: string, channelId: string, value: string): string {
  return digest(`${storeId}\u0000${channelId}\u0000COD_REMITTANCE\u0000${value}`);
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

function normalizeReference(value: string): string {
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

function normalizeInput(context: StoreContext, input: ImportCodRemittanceBatchInput) {
  const reason = input.reason.trim();
  if (
    context.actor.type !== 'admin' ||
    input.confirmation !== 'IMPORT_GHN_COD_SETTLEMENT' ||
    input.providerCode !== 'GHN' ||
    !['SANDBOX', 'PRODUCTION'].includes(input.providerEnvironment) ||
    !IDEMPOTENCY_PATTERN.test(input.idempotencyKey) ||
    reason.length < 10 ||
    reason.length > 500 ||
    input.records.length < 1 ||
    input.records.length > MAX_RECORDS
  ) {
    throw new FinancialReconciliationCommandError('FINANCIAL_RECONCILIATION_INPUT_INVALID');
  }
  const records = input.records.map((record, index): NormalizedRecord => {
    const feeAmountVnd = checkedAdd(record.shippingFeeVnd, record.codFeeVnd);
    if (
      !Number.isSafeInteger(record.codAmountVnd) ||
      record.codAmountVnd <= 0 ||
      !Number.isSafeInteger(record.shippingFeeVnd) ||
      record.shippingFeeVnd < 0 ||
      !Number.isSafeInteger(record.codFeeVnd) ||
      record.codFeeVnd < 0 ||
      !Number.isSafeInteger(feeAmountVnd) ||
      !(record.occurredAt instanceof Date) ||
      !Number.isFinite(record.occurredAt.getTime())
    ) {
      throw new FinancialReconciliationCommandError('FINANCIAL_RECONCILIATION_INPUT_INVALID');
    }
    return {
      codAmountVnd: record.codAmountVnd,
      codFeeVnd: record.codFeeVnd,
      occurredAt: new Date(record.occurredAt),
      feeAmountVnd,
      grossAmountVnd: record.codAmountVnd,
      lineNumber: index + 1,
      providerReference: normalizeReference(record.providerReference),
      recordReference: normalizeReference(record.recordReference),
      shippingFeeVnd: record.shippingFeeVnd,
    };
  });
  if (new Set(records.map((record) => record.recordReference)).size !== records.length) {
    throw new FinancialReconciliationCommandError('FINANCIAL_RECONCILIATION_INPUT_INVALID');
  }
  const businessDate = parseBusinessDate(input.businessDate);
  const batchReference = normalizeReference(input.batchReference);
  return {
    batchReference,
    batchReferenceDigest: digest(
      `${context.storeId}\u0000${input.providerEnvironment}\u0000GHN\u0000${batchReference}`,
    ),
    businessDate,
    businessDateText: input.businessDate,
    idempotencyKeyHash: digest(
      `${context.storeId}\u0000SHIPPING_PROVIDER\u0000${input.idempotencyKey}`,
    ),
    inputDigest: digest({
      batch_reference: batchReference,
      business_date: input.businessDate,
      provider_code: input.providerCode,
      provider_environment: input.providerEnvironment,
      reason,
      records: records.map((record) => ({
        cod_amount_vnd: record.codAmountVnd,
        cod_fee_vnd: record.codFeeVnd,
        occurred_at: record.occurredAt.toISOString(),
        provider_reference: record.providerReference,
        record_reference: record.recordReference,
        shipping_fee_vnd: record.shippingFeeVnd,
      })),
    }),
    reason,
    records,
  } as const;
}

async function assertAuthorization(
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
  const rows = await transaction.$queryRaw<Array<{ session_id: string }>>`
    SELECT session.id AS session_id
    FROM stores store
    JOIN admin_users admin ON admin.id = ${context.actor.id}::uuid
    JOIN admin_sessions session ON session.id = ${context.accessSessionId}::uuid
      AND session.admin_user_id = admin.id
    WHERE store.id = ${context.storeId}::uuid
      AND store.status = 'ACTIVE' AND admin.status = 'ACTIVE'
      AND session.revoked_at IS NULL AND session.expires_at > pg_catalog.clock_timestamp()
      AND session.mfa_verified_at >= pg_catalog.clock_timestamp() - INTERVAL '10 minutes'
      AND ${context.accessTokenExpiresAt}::timestamptz > pg_catalog.clock_timestamp()
    FOR SHARE OF store, admin, session
  `;
  if (rows.length !== 1) {
    throw new FinancialReconciliationCommandError('FINANCIAL_RECONCILIATION_AUTHORIZATION_DENIED');
  }
  const permissions = await transaction.$queryRaw<Array<{ permission_code: string }>>`
    SELECT role_permission.permission_code
    FROM admin_store_roles assignment
    JOIN store_role_permissions role_permission
      ON role_permission.store_id = assignment.store_id AND role_permission.role_id = assignment.role_id
    WHERE assignment.store_id = ${context.storeId}::uuid
      AND assignment.admin_user_id = ${context.actor.id}::uuid
      AND role_permission.permission_code = 'store.finance.reconcile'
    FOR SHARE OF assignment, role_permission
  `;
  if (permissions.length < 1) {
    throw new FinancialReconciliationCommandError('FINANCIAL_RECONCILIATION_AUTHORIZATION_DENIED');
  }
}

type ShipmentFact = {
  codAmountVnd: bigint;
  createdAt: Date;
  id: string;
  orderId: string;
  providerShipmentId: string | null;
  serviceCode: string;
  status: string;
};

type QuoteFact = { createdAt: Date; orderId: string; serviceCode: string; totalFeeVnd: bigint };

function latestQuote(shipment: ShipmentFact, quotes: readonly QuoteFact[]): QuoteFact | undefined {
  return quotes.find(
    (quote) =>
      quote.orderId === shipment.orderId &&
      quote.serviceCode === shipment.serviceCode &&
      quote.createdAt.getTime() <= shipment.createdAt.getTime(),
  );
}

function lineStatus(
  shipment: ShipmentFact,
  gross: number,
  expectedGross: number,
  fee: number,
  expectedFee: number | null,
) {
  if (shipment.status === 'DELIVERED') {
    if (expectedFee === null) return 'EXPECTED_FEE_NOT_FOUND' as const;
    if (gross !== expectedGross) return 'AMOUNT_MISMATCH' as const;
    if (fee !== expectedFee) return 'FEE_MISMATCH' as const;
    return 'MATCHED' as const;
  }
  if (['REFUSED', 'RETURNING', 'RETURNED', 'CANCELLED'].includes(shipment.status)) {
    return 'COD_NOT_RECEIVABLE' as const;
  }
  return 'FACT_NOT_FINAL' as const;
}

async function matchRecords(
  transaction: StoreTransaction,
  context: StoreContext,
  channelId: string,
  records: readonly NormalizedRecord[],
) {
  const counts = new Map<string, number>();
  records.forEach((record) =>
    counts.set(record.providerReference, (counts.get(record.providerReference) ?? 0) + 1),
  );
  const references = [...new Set(records.map((record) => record.providerReference))];
  const referenceDigests = new Map(
    references.map((reference) => [
      reference,
      providerReferenceDigest(context.storeId, channelId, reference),
    ]),
  );
  const existingReferences = references.length
    ? await transaction.financialReconciliationLine.findMany({
        select: { providerReferenceDigest: true },
        where: {
          providerReferenceDigest: { in: [...referenceDigests.values()] },
          storeId: context.storeId,
          type: 'COD_REMITTANCE',
        },
      })
    : [];
  const existingReferenceDigests = new Set(
    existingReferences.map((line) => line.providerReferenceDigest),
  );
  const shipments = references.length
    ? await transaction.shipment.findMany({
        select: {
          codAmountVnd: true,
          createdAt: true,
          id: true,
          orderId: true,
          providerShipmentId: true,
          serviceCode: true,
          status: true,
        },
        where: {
          channelId,
          order: { paymentMethod: 'COD' },
          providerShipmentId: { in: references },
          purpose: 'ORDER_OUTBOUND',
          storeId: context.storeId,
        },
      })
    : [];
  const orderIds = [...new Set(shipments.map((shipment) => shipment.orderId))];
  const quotes = orderIds.length
    ? await transaction.shippingQuote.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { createdAt: true, orderId: true, serviceCode: true, totalFeeVnd: true },
        where: {
          channelId,
          orderId: { in: orderIds },
          source: 'PROVIDER',
          storeId: context.storeId,
        },
      })
    : [];
  const shipmentByReference = new Map(
    shipments.flatMap((shipment) =>
      shipment.providerShipmentId
        ? [[shipment.providerShipmentId, shipment as ShipmentFact] as const]
        : [],
    ),
  );
  return records.map((record) => {
    const netAmountVnd = checkedAdd(record.grossAmountVnd, -record.feeAmountVnd);
    if (
      (counts.get(record.providerReference) ?? 0) > 1 ||
      existingReferenceDigests.has(referenceDigests.get(record.providerReference)!)
    ) {
      return {
        ...record,
        differenceVnd: null,
        feeDifferenceVnd: null,
        localExpectedAmountVnd: null,
        localExpectedFeeAmountVnd: null,
        netAmountVnd,
        shipmentId: null,
        status: 'DUPLICATE_REFERENCE' as const,
      };
    }
    const shipment = shipmentByReference.get(record.providerReference);
    if (!shipment) {
      return {
        ...record,
        differenceVnd: null,
        feeDifferenceVnd: null,
        localExpectedAmountVnd: null,
        localExpectedFeeAmountVnd: null,
        netAmountVnd,
        shipmentId: null,
        status: 'REFERENCE_NOT_FOUND' as const,
      };
    }
    const expectedGross = safeInteger(shipment.codAmountVnd);
    const quote = latestQuote(shipment, quotes);
    const expectedFee = quote ? safeInteger(quote.totalFeeVnd) : null;
    const status = lineStatus(
      shipment,
      record.grossAmountVnd,
      expectedGross,
      record.feeAmountVnd,
      expectedFee,
    );
    const expectedAmount = status === 'COD_NOT_RECEIVABLE' ? 0 : expectedGross;
    const differenceVnd = checkedAdd(record.grossAmountVnd, -expectedAmount);
    const resolvedExpectedFee = ['MATCHED', 'AMOUNT_MISMATCH', 'FEE_MISMATCH'].includes(status)
      ? expectedFee
      : null;
    const feeDifferenceVnd =
      resolvedExpectedFee === null ? null : checkedAdd(record.feeAmountVnd, -resolvedExpectedFee);
    return {
      ...record,
      differenceVnd,
      feeDifferenceVnd,
      localExpectedAmountVnd: expectedAmount,
      localExpectedFeeAmountVnd: resolvedExpectedFee,
      netAmountVnd,
      shipmentId: shipment.id,
      status,
    };
  });
}

function batchResult(
  batch: Prisma.FinancialReconciliationBatchGetPayload<{ include: { lines: true } }>,
  replayed: boolean,
): CodRemittanceBatchResult {
  if (
    batch.source !== 'SHIPPING_PROVIDER' ||
    batch.lines.some((line) => line.type !== 'COD_REMITTANCE')
  ) {
    throw new FinancialReconciliationCommandError('FINANCIAL_RECONCILIATION_FACT_INVALID');
  }
  return {
    batchReferenceMasked: batch.batchReferenceMasked,
    businessDate: batch.businessDate.toISOString().slice(0, 10),
    createdAt: batch.createdAt,
    differenceVnd: safeInteger(batch.differenceVnd),
    exceptionCount: batch.exceptionCount,
    feeAmountVnd: safeInteger(batch.feeAmountVnd),
    feeDifferenceVnd: safeInteger(batch.feeDifferenceVnd),
    grossAmountVnd: safeInteger(batch.grossAmountVnd),
    id: batch.id,
    lines: [...batch.lines]
      .sort((left, right) => left.lineNumber - right.lineNumber)
      .map((line) => ({
        differenceVnd: line.differenceVnd === null ? null : safeInteger(line.differenceVnd),
        feeAmountVnd: safeInteger(line.feeAmountVnd),
        feeDifferenceVnd:
          line.feeDifferenceVnd === null ? null : safeInteger(line.feeDifferenceVnd),
        grossAmountVnd: safeInteger(line.grossAmountVnd),
        id: line.id,
        lineNumber: line.lineNumber,
        localExpectedAmountVnd:
          line.localExpectedAmountVnd === null ? null : safeInteger(line.localExpectedAmountVnd),
        localExpectedFeeAmountVnd:
          line.localExpectedFeeAmountVnd === null
            ? null
            : safeInteger(line.localExpectedFeeAmountVnd),
        netAmountVnd: safeInteger(line.netAmountVnd),
        occurredAt: line.occurredAt,
        providerReferenceMasked: line.providerReferenceMasked,
        recordReferenceMasked: line.recordReferenceMasked,
        status: line.status,
        type: 'COD_REMITTANCE' as const,
      })),
    localExpectedAmountVnd: safeInteger(batch.localExpectedAmountVnd),
    localExpectedFeeAmountVnd: safeInteger(batch.localExpectedFeeAmountVnd),
    matchedCount: batch.matchedCount,
    netAmountVnd: safeInteger(batch.netAmountVnd),
    recordCount: batch.recordCount,
    replayed,
    source: 'SHIPPING_PROVIDER',
    status: batch.status,
    version: batch.version,
  };
}

async function importInTransaction(
  transaction: StoreTransaction,
  context: StoreContext,
  input: ImportCodRemittanceBatchInput,
) {
  const normalized = normalizeInput(context, input);
  await transaction.$executeRaw`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`financial-reconciliation:${context.storeId}:${normalized.idempotencyKeyHash}`}, 0))`;
  await assertAuthorization(transaction, context);
  const replay = await transaction.financialReconciliationBatch.findUnique({
    include: { lines: true },
    where: {
      storeId_source_idempotencyKeyHash: {
        idempotencyKeyHash: normalized.idempotencyKeyHash,
        source: 'SHIPPING_PROVIDER',
        storeId: context.storeId,
      },
    },
  });
  if (replay) {
    if (replay.inputDigest !== normalized.inputDigest)
      throw new FinancialReconciliationCommandError(
        'FINANCIAL_RECONCILIATION_IDEMPOTENCY_CONFLICT',
      );
    return batchResult(replay, true);
  }
  const channel = await transaction.storeShippingChannel.findFirst({
    select: { id: true },
    where: {
      providerCode: input.providerCode,
      providerEnvironment: input.providerEnvironment,
      storeId: context.storeId,
    },
  });
  if (!channel)
    throw new FinancialReconciliationCommandError('FINANCIAL_RECONCILIATION_CHANNEL_NOT_FOUND');
  const existing = await transaction.financialReconciliationBatch.findUnique({
    select: { id: true },
    where: {
      storeId_shippingChannelId_batchReferenceDigest: {
        batchReferenceDigest: normalized.batchReferenceDigest,
        shippingChannelId: channel.id,
        storeId: context.storeId,
      },
    },
  });
  if (existing)
    throw new FinancialReconciliationCommandError(
      'FINANCIAL_RECONCILIATION_BATCH_REFERENCE_CONFLICT',
    );
  const lines = await matchRecords(transaction, context, channel.id, normalized.records);
  const summary = lines.reduce(
    (current, line) => ({
      differenceVnd: checkedAdd(current.differenceVnd, line.differenceVnd ?? 0),
      exceptionCount: current.exceptionCount + (line.status === 'MATCHED' ? 0 : 1),
      feeAmountVnd: checkedAdd(current.feeAmountVnd, line.feeAmountVnd),
      feeDifferenceVnd: checkedAdd(current.feeDifferenceVnd, line.feeDifferenceVnd ?? 0),
      grossAmountVnd: checkedAdd(current.grossAmountVnd, line.grossAmountVnd),
      localExpectedAmountVnd: checkedAdd(
        current.localExpectedAmountVnd,
        line.localExpectedAmountVnd ?? 0,
      ),
      localExpectedFeeAmountVnd: checkedAdd(
        current.localExpectedFeeAmountVnd,
        line.localExpectedFeeAmountVnd ?? 0,
      ),
      matchedCount: current.matchedCount + (line.status === 'MATCHED' ? 1 : 0),
      netAmountVnd: checkedAdd(current.netAmountVnd, line.netAmountVnd),
    }),
    {
      differenceVnd: 0,
      exceptionCount: 0,
      feeAmountVnd: 0,
      feeDifferenceVnd: 0,
      grossAmountVnd: 0,
      localExpectedAmountVnd: 0,
      localExpectedFeeAmountVnd: 0,
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
      feeDifferenceVnd: summary.feeDifferenceVnd,
      grossAmountVnd: summary.grossAmountVnd,
      id: batchId,
      idempotencyKeyHash: normalized.idempotencyKeyHash,
      inputDigest: normalized.inputDigest,
      localExpectedAmountVnd: summary.localExpectedAmountVnd,
      localExpectedFeeAmountVnd: summary.localExpectedFeeAmountVnd,
      matchedCount: summary.matchedCount,
      netAmountVnd: summary.netAmountVnd,
      reason: normalized.reason,
      recordCount: lines.length,
      shippingChannelId: channel.id,
      source: 'SHIPPING_PROVIDER',
      status: summary.exceptionCount === 0 ? 'MATCHED' : 'REVIEW_REQUIRED',
      storeId: context.storeId,
    },
  });
  await transaction.financialReconciliationLine.createMany({
    data: lines.map((line) => ({
      batchId,
      differenceVnd: line.differenceVnd,
      feeAmountVnd: line.feeAmountVnd,
      feeDifferenceVnd: line.feeDifferenceVnd,
      grossAmountVnd: line.grossAmountVnd,
      lineNumber: line.lineNumber,
      localExpectedAmountVnd: line.localExpectedAmountVnd,
      localExpectedFeeAmountVnd: line.localExpectedFeeAmountVnd,
      netAmountVnd: line.netAmountVnd,
      occurredAt: line.occurredAt,
      providerReferenceDigest: providerReferenceDigest(
        context.storeId,
        channel.id,
        line.providerReference,
      ),
      providerReferenceMasked: maskReference(line.providerReference),
      recordReferenceDigest: digest(
        `${normalized.batchReferenceDigest}\u0000${line.recordReference}`,
      ),
      recordReferenceMasked: maskReference(line.recordReference),
      shipmentId: line.shipmentId,
      status: line.status,
      storeId: context.storeId,
      type: 'COD_REMITTANCE',
    })),
  });
  const batch = await transaction.financialReconciliationBatch.findUniqueOrThrow({
    include: { lines: true },
    where: { storeId_id: { id: batchId, storeId: context.storeId } },
  });
  await transaction.auditLog.create({
    data: {
      action: 'financial-reconciliation.cod-batch.imported',
      actorId: context.actor.id,
      actorType: 'ADMIN',
      afterData: {
        batch_id: batch.id,
        business_date: normalized.businessDateText,
        exception_count: summary.exceptionCount,
        fee_difference_vnd: summary.feeDifferenceVnd,
        gross_amount_vnd: summary.grossAmountVnd,
        matched_count: summary.matchedCount,
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
  return batchResult(batch, false);
}

function isSerializationConflict(error: unknown): boolean {
  return (
    (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') ||
    (error instanceof Error && error.message.includes('40001'))
  );
}

export async function importCodRemittanceBatch(
  client: PrismaClient,
  context: StoreContext,
  input: ImportCodRemittanceBatchInput,
): Promise<CodRemittanceBatchResult> {
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
    if (error instanceof FinancialReconciliationCommandError) throw error;
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new FinancialReconciliationCommandError(
        'FINANCIAL_RECONCILIATION_BATCH_REFERENCE_CONFLICT',
      );
    }
    throw error;
  }
}

type CodReceivableShipment = Prisma.ShipmentGetPayload<{
  include: { order: { select: { orderNumber: true; paymentMethod: true } } };
}>;

async function projectCodReceivables(
  transaction: StoreTransaction,
  context: StoreContext,
  channelIds: readonly string[],
  shipments: readonly CodReceivableShipment[],
): Promise<CodReceivable[]> {
  const shipmentIds = shipments.map((shipment) => shipment.id);
  const lines = shipmentIds.length
    ? await transaction.financialReconciliationLine.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        where: {
          shipmentId: { in: shipmentIds },
          storeId: context.storeId,
          type: 'COD_REMITTANCE',
        },
      })
    : [];
  const lineByShipment = new Map<string, (typeof lines)[number]>();
  for (const line of lines) {
    if (line.shipmentId && !lineByShipment.has(line.shipmentId)) {
      lineByShipment.set(line.shipmentId, line);
    }
  }

  const orderIds = [...new Set(shipments.map((shipment) => shipment.orderId))];
  const quotes = orderIds.length
    ? await transaction.shippingQuote.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          channelId: true,
          createdAt: true,
          orderId: true,
          serviceCode: true,
          totalFeeVnd: true,
        },
        where: {
          channelId: { in: [...channelIds] },
          orderId: { in: orderIds },
          source: 'PROVIDER',
          storeId: context.storeId,
        },
      })
    : [];

  return shipments.map((shipment) => {
    const quote = latestQuote(
      shipment,
      quotes.filter((candidate) => candidate.channelId === shipment.channelId),
    );
    const line = lineByShipment.get(shipment.id);
    const expectedCodAmountVnd = safeInteger(shipment.codAmountVnd);
    const expectedFeeAmountVnd = quote ? safeInteger(quote.totalFeeVnd) : null;
    return {
      deliveredAt: shipment.deliveredAt,
      expectedCodAmountVnd,
      expectedFeeAmountVnd,
      expectedNetAmountVnd:
        expectedFeeAmountVnd === null
          ? null
          : checkedAdd(expectedCodAmountVnd, -expectedFeeAmountVnd),
      id: shipment.id,
      lastBatchId: line?.batchId ?? null,
      orderNumber: shipment.order.orderNumber,
      providerReferenceMasked:
        line?.providerReferenceMasked ??
        (shipment.providerShipmentId ? maskReference(shipment.providerShipmentId) : null),
      publicShipmentNumber: shipment.publicShipmentNumber,
      status: line?.status === 'MATCHED' ? 'REMITTED' : line ? 'REVIEW_REQUIRED' : 'UNREMITTED',
    } satisfies CodReceivable;
  });
}

export async function listCodReceivables(
  client: PrismaClient,
  context: StoreContext,
  input: { cursor?: string; limit: number; status?: CodReceivableStatus },
): Promise<CodReceivablePage> {
  if (
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100 ||
    (input.status && !['UNREMITTED', 'REMITTED', 'REVIEW_REQUIRED'].includes(input.status))
  ) {
    throw new FinancialReconciliationCommandError('FINANCIAL_RECONCILIATION_INPUT_INVALID');
  }

  return withStoreTransaction(client, context, async (transaction) => {
    const channels = await transaction.storeShippingChannel.findMany({
      select: { id: true },
      where: { providerCode: 'GHN', storeId: context.storeId },
    });
    const channelIds = channels.map((channel) => channel.id);
    if (channelIds.length === 0) return { items: [], nextCursor: null };

    const cursorRow = input.cursor
      ? await transaction.shipment.findFirst({
          select: { deliveredAt: true, id: true },
          where: {
            channelId: { in: channelIds },
            codAmountVnd: { gt: 0 },
            deliveredAt: { not: null },
            id: input.cursor,
            order: { paymentMethod: 'COD' },
            purpose: 'ORDER_OUTBOUND',
            status: 'DELIVERED',
            storeId: context.storeId,
          },
        })
      : null;
    if (input.cursor && !cursorRow?.deliveredAt) {
      throw new FinancialReconciliationCommandError('FINANCIAL_RECONCILIATION_CURSOR_NOT_FOUND');
    }

    let scanCursor = cursorRow?.deliveredAt
      ? { deliveredAt: cursorRow.deliveredAt, id: cursorRow.id }
      : null;
    const matchingItems: CodReceivable[] = [];
    const scanSize = Math.max(50, input.limit + 1);

    for (;;) {
      const shipments = await transaction.shipment.findMany({
        include: { order: { select: { orderNumber: true, paymentMethod: true } } },
        orderBy: [{ deliveredAt: 'desc' }, { id: 'desc' }],
        take: scanSize,
        where: {
          channelId: { in: channelIds },
          codAmountVnd: { gt: 0 },
          deliveredAt: { not: null },
          order: { paymentMethod: 'COD' },
          purpose: 'ORDER_OUTBOUND',
          status: 'DELIVERED',
          storeId: context.storeId,
          ...(scanCursor
            ? {
                OR: [
                  { deliveredAt: { lt: scanCursor.deliveredAt } },
                  { deliveredAt: scanCursor.deliveredAt, id: { lt: scanCursor.id } },
                ],
              }
            : {}),
        },
      });
      if (shipments.length === 0) break;

      const projected = await projectCodReceivables(transaction, context, channelIds, shipments);
      for (const item of projected) {
        if (!input.status || item.status === input.status) {
          matchingItems.push(item);
          if (matchingItems.length > input.limit) break;
        }
      }
      if (matchingItems.length > input.limit || shipments.length < scanSize) break;

      const lastShipment = shipments.at(-1)!;
      if (!lastShipment.deliveredAt) {
        throw new FinancialReconciliationCommandError('FINANCIAL_RECONCILIATION_FACT_INVALID');
      }
      scanCursor = { deliveredAt: lastShipment.deliveredAt, id: lastShipment.id };
    }

    const hasNextPage = matchingItems.length > input.limit;
    const page = hasNextPage ? matchingItems.slice(0, input.limit) : matchingItems;
    return {
      items: page,
      nextCursor: hasNextPage ? page.at(-1)!.id : null,
    };
  });
}
