import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CodReceivableListQuery,
  CodRemittanceBatchImport,
  CloseFinancialReconciliation,
  FinancialReconciliationBatchListQuery,
  PaymentSettlementBatchImport,
} from '@zalo-shop/contracts';
import {
  FinancialReconciliationCommandError,
  closeFinancialReconciliation,
  importCodRemittanceBatch,
  listCodReceivables,
  importPaymentSettlementBatch,
  type FinancialReconciliationBatchResult,
  type PrismaClient,
  withStoreTransaction,
} from '@zalo-shop/database';

import { AdminService, type AdminHeaders } from '../admin/admin.service';
import { DATABASE_CLIENT } from '../auth/auth.tokens';

function safeInteger(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new ConflictException('AMOUNT_INVALID');
  return result;
}

function safeAmount(value: bigint | number): number {
  if (typeof value === 'bigint') return safeInteger(value);
  if (!Number.isSafeInteger(value)) throw new ConflictException('AMOUNT_INVALID');
  return value;
}

function checkedAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new ConflictException('AMOUNT_INVALID');
  return result;
}

@Injectable()
export class FinancialReconciliationService {
  public constructor(
    @Inject(DATABASE_CLIENT) private readonly database: PrismaClient,
    @Inject(AdminService) private readonly admin: AdminService,
  ) {}

  public async importPaymentBatch(
    headers: AdminHeaders,
    storeId: string,
    idempotencyKey: string,
    input: PaymentSettlementBatchImport,
  ) {
    const context = await this.admin.authorizeSensitive(
      headers,
      storeId,
      'store.finance.reconcile',
    );
    try {
      return this.batchResultView(
        await importPaymentSettlementBatch(this.database, context, {
          batchReference: input.batch_reference,
          businessDate: input.business_date,
          confirmation: input.confirmation_code,
          idempotencyKey,
          providerCode: input.provider_code,
          providerEnvironment: input.provider_environment,
          reason: input.reason,
          records: input.records.map((record) => ({
            feeAmountVnd: record.fee_amount_vnd,
            grossAmountVnd: record.gross_amount_vnd,
            occurredAt: record.occurred_at,
            providerReference: record.provider_reference,
            recordReference: record.record_reference,
            type: record.type,
          })),
        }),
      );
    } catch (error) {
      this.mapCommandError(error);
    }
  }

  public async listBatches(
    headers: AdminHeaders,
    storeId: string,
    query: FinancialReconciliationBatchListQuery,
  ) {
    const context = await this.admin.authorize(headers, storeId, 'store.finance.read');
    return withStoreTransaction(this.database, context, async (transaction) => {
      const reviewFilter =
        query.review_status === 'OPEN'
          ? { review: null }
          : query.review_status
            ? { review: { is: { decision: query.review_status } } }
            : {};
      const cursor = query.cursor
        ? await transaction.financialReconciliationBatch.findFirst({
            select: { createdAt: true, id: true },
            where: { id: query.cursor, storeId, ...reviewFilter },
          })
        : null;
      if (query.cursor && !cursor) {
        throw new NotFoundException('Financial reconciliation cursor not found');
      }
      const rows = await transaction.financialReconciliationBatch.findMany({
        include: { review: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        where: {
          storeId,
          ...reviewFilter,
          ...(query.source ? { source: query.source } : {}),
          ...(query.status ? { status: query.status } : {}),
          ...(query.business_date_from || query.business_date_to
            ? {
                businessDate: {
                  ...(query.business_date_from
                    ? { gte: new Date(`${query.business_date_from}T00:00:00.000Z`) }
                    : {}),
                  ...(query.business_date_to
                    ? { lte: new Date(`${query.business_date_to}T00:00:00.000Z`) }
                    : {}),
                },
              }
            : {}),
          ...(cursor
            ? {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              }
            : {}),
        },
      });
      const hasNextPage = rows.length > query.limit;
      const page = hasNextPage ? rows.slice(0, query.limit) : rows;
      return {
        items: page.map((row) => this.batchSummaryView(row)),
        next_cursor: hasNextPage ? page.at(-1)!.id : null,
      };
    });
  }

  public async importCodBatch(
    headers: AdminHeaders,
    storeId: string,
    idempotencyKey: string,
    input: CodRemittanceBatchImport,
  ) {
    const context = await this.admin.authorizeSensitive(
      headers,
      storeId,
      'store.finance.reconcile',
    );
    try {
      return this.codBatchResultView(
        await importCodRemittanceBatch(this.database, context, {
          batchReference: input.batch_reference,
          businessDate: input.business_date,
          confirmation: input.confirmation_code,
          idempotencyKey,
          providerCode: input.provider_code,
          providerEnvironment: input.provider_environment,
          reason: input.reason,
          records: input.records.map((record) => ({
            codAmountVnd: record.cod_amount_vnd,
            codFeeVnd: record.cod_fee_vnd,
            occurredAt: record.occurred_at,
            providerReference: record.provider_reference,
            recordReference: record.record_reference,
            shippingFeeVnd: record.shipping_fee_vnd,
          })),
        }),
      );
    } catch (error) {
      this.mapCommandError(error);
    }
  }

  public async listCodReceivables(
    headers: AdminHeaders,
    storeId: string,
    query: CodReceivableListQuery,
  ) {
    const context = await this.admin.authorize(headers, storeId, 'store.finance.read');
    try {
      const result = await listCodReceivables(this.database, context, {
        ...(query.cursor ? { cursor: query.cursor } : {}),
        limit: query.limit,
        ...(query.status ? { status: query.status } : {}),
      });
      return {
        items: result.items.map((item) => ({
          delivered_at: item.deliveredAt?.toISOString() ?? null,
          expected_cod_amount_vnd: item.expectedCodAmountVnd,
          expected_fee_amount_vnd: item.expectedFeeAmountVnd,
          expected_net_amount_vnd: item.expectedNetAmountVnd,
          id: item.id,
          last_batch_id: item.lastBatchId,
          order_number: item.orderNumber,
          provider_reference_masked: item.providerReferenceMasked,
          public_shipment_number: item.publicShipmentNumber,
          status: item.status,
        })),
        next_cursor: result.nextCursor,
      };
    } catch (error) {
      this.mapCommandError(error);
    }
  }

  public async getBatch(headers: AdminHeaders, storeId: string, batchId: string) {
    const context = await this.admin.authorize(headers, storeId, 'store.finance.read');
    return withStoreTransaction(this.database, context, async (transaction) => {
      const batch = await transaction.financialReconciliationBatch.findFirst({
        include: { lines: { orderBy: { lineNumber: 'asc' } }, review: true },
        where: { id: batchId, storeId },
      });
      if (!batch) throw new NotFoundException('Financial reconciliation batch not found');
      return {
        ...this.batchSummaryView(batch),
        exception_summary: this.exceptionSummaryView(batch.lines),
        review: batch.review
          ? {
              decision: batch.review.decision,
              id: batch.review.id,
              reason: batch.review.reason,
              reviewed_at: batch.review.createdAt.toISOString(),
            }
          : null,
        lines: batch.lines.map((line) => ({
          difference_vnd: line.differenceVnd === null ? null : safeInteger(line.differenceVnd),
          fee_amount_vnd: safeInteger(line.feeAmountVnd),
          fee_difference_vnd:
            line.feeDifferenceVnd === null ? null : safeInteger(line.feeDifferenceVnd),
          gross_amount_vnd: safeInteger(line.grossAmountVnd),
          id: line.id,
          line_number: line.lineNumber,
          local_expected_amount_vnd:
            line.localExpectedAmountVnd === null ? null : safeInteger(line.localExpectedAmountVnd),
          local_expected_fee_amount_vnd:
            line.localExpectedFeeAmountVnd === null
              ? null
              : safeInteger(line.localExpectedFeeAmountVnd),
          net_amount_vnd: safeInteger(line.netAmountVnd),
          occurred_at: line.occurredAt.toISOString(),
          provider_reference_masked: line.providerReferenceMasked,
          record_reference_masked: line.recordReferenceMasked,
          status: line.status,
          type: line.type,
        })),
      };
    });
  }

  private batchSummaryView(batch: {
    batchReferenceMasked: string;
    businessDate: Date;
    createdAt: Date;
    differenceVnd: bigint;
    exceptionCount: number;
    feeAmountVnd: bigint;
    feeDifferenceVnd: bigint;
    grossAmountVnd: bigint;
    id: string;
    localExpectedAmountVnd: bigint;
    localExpectedFeeAmountVnd: bigint;
    matchedCount: number;
    netAmountVnd: bigint;
    recordCount: number;
    source: string;
    status: string;
    version: number;
    review?: { decision: string } | null;
  }) {
    return {
      batch_reference_masked: batch.batchReferenceMasked,
      business_date: batch.businessDate.toISOString().slice(0, 10),
      created_at: batch.createdAt.toISOString(),
      currency: 'VND' as const,
      difference_vnd: safeInteger(batch.differenceVnd),
      exception_count: batch.exceptionCount,
      fee_amount_vnd: safeInteger(batch.feeAmountVnd),
      fee_difference_vnd: safeInteger(batch.feeDifferenceVnd),
      gross_amount_vnd: safeInteger(batch.grossAmountVnd),
      id: batch.id,
      local_expected_amount_vnd: safeInteger(batch.localExpectedAmountVnd),
      local_expected_fee_amount_vnd: safeInteger(batch.localExpectedFeeAmountVnd),
      matched_count: batch.matchedCount,
      net_amount_vnd: safeInteger(batch.netAmountVnd),
      record_count: batch.recordCount,
      review_status: batch.review?.decision ?? 'OPEN',
      source: batch.source,
      status: batch.status,
      version: batch.version,
    };
  }

  private exceptionSummaryView(
    lines: readonly {
      differenceVnd: bigint | number | null;
      feeDifferenceVnd: bigint | number | null;
      grossAmountVnd: bigint | number;
      netAmountVnd: bigint | number;
      status: string;
    }[],
  ) {
    const summaries = new Map<
      string,
      {
        difference_vnd: number;
        fee_difference_vnd: number;
        gross_amount_vnd: number;
        line_count: number;
        net_amount_vnd: number;
        status: string;
      }
    >();
    for (const line of lines) {
      if (line.status === 'MATCHED') continue;
      const current = summaries.get(line.status) ?? {
        difference_vnd: 0,
        fee_difference_vnd: 0,
        gross_amount_vnd: 0,
        line_count: 0,
        net_amount_vnd: 0,
        status: line.status,
      };
      current.difference_vnd = checkedAdd(
        current.difference_vnd,
        line.differenceVnd === null ? 0 : safeAmount(line.differenceVnd),
      );
      current.fee_difference_vnd = checkedAdd(
        current.fee_difference_vnd,
        line.feeDifferenceVnd === null ? 0 : safeAmount(line.feeDifferenceVnd),
      );
      current.gross_amount_vnd = checkedAdd(
        current.gross_amount_vnd,
        safeAmount(line.grossAmountVnd),
      );
      current.line_count += 1;
      current.net_amount_vnd = checkedAdd(current.net_amount_vnd, safeAmount(line.netAmountVnd));
      summaries.set(line.status, current);
    }
    return [...summaries.values()].sort((left, right) => left.status.localeCompare(right.status));
  }

  public async reviewBatch(
    headers: AdminHeaders,
    storeId: string,
    batchId: string,
    idempotencyKey: string,
    input: CloseFinancialReconciliation,
  ) {
    const context = await this.admin.authorizeSensitive(
      headers,
      storeId,
      'store.finance.reconcile',
    );
    try {
      const result = await closeFinancialReconciliation(this.database, context, {
        batchId,
        confirmation: input.confirmation_code,
        decision: input.decision,
        expectedBatchVersion: input.expected_batch_version,
        idempotencyKey,
        reason: input.reason,
      });
      return {
        batch: {
          difference_vnd: result.batch.differenceVnd,
          exception_count: result.batch.exceptionCount,
          fee_difference_vnd: result.batch.feeDifferenceVnd,
          id: result.batch.id,
          status: result.batch.status,
          version: result.batch.version,
        },
        created_at: result.createdAt.toISOString(),
        decision: result.decision,
        exception_summary: result.exceptionSummary.map((summary) => ({
          difference_vnd: summary.differenceVnd,
          fee_difference_vnd: summary.feeDifferenceVnd,
          gross_amount_vnd: summary.grossAmountVnd,
          line_count: summary.lineCount,
          net_amount_vnd: summary.netAmountVnd,
          status: summary.status,
        })),
        expected_batch_version: result.expectedBatchVersion,
        id: result.id,
        reason: result.reason,
        replayed: result.replayed,
      };
    } catch (error) {
      this.mapCommandError(error);
    }
  }

  private batchResultView(batch: FinancialReconciliationBatchResult) {
    return {
      batch_reference_masked: batch.batchReferenceMasked,
      business_date: batch.businessDate,
      created_at: batch.createdAt.toISOString(),
      currency: 'VND' as const,
      difference_vnd: batch.differenceVnd,
      exception_count: batch.exceptionCount,
      fee_amount_vnd: batch.feeAmountVnd,
      gross_amount_vnd: batch.grossAmountVnd,
      id: batch.id,
      exception_summary: this.exceptionSummaryView(batch.lines),
      lines: batch.lines.map((line) => ({
        difference_vnd: line.differenceVnd,
        fee_amount_vnd: line.feeAmountVnd,
        fee_difference_vnd: line.feeDifferenceVnd,
        gross_amount_vnd: line.grossAmountVnd,
        id: line.id,
        line_number: line.lineNumber,
        local_expected_amount_vnd: line.localExpectedAmountVnd,
        local_expected_fee_amount_vnd: line.localExpectedFeeAmountVnd,
        net_amount_vnd: line.netAmountVnd,
        occurred_at: line.occurredAt.toISOString(),
        provider_reference_masked: line.providerReferenceMasked,
        record_reference_masked: line.recordReferenceMasked,
        status: line.status,
        type: line.type,
      })),
      local_expected_amount_vnd: batch.localExpectedAmountVnd,
      local_expected_fee_amount_vnd: batch.localExpectedFeeAmountVnd,
      fee_difference_vnd: batch.feeDifferenceVnd,
      matched_count: batch.matchedCount,
      net_amount_vnd: batch.netAmountVnd,
      record_count: batch.recordCount,
      replayed: batch.replayed,
      review: null,
      review_status: 'OPEN' as const,
      source: batch.source,
      status: batch.status,
      version: batch.version,
    };
  }

  private codBatchResultView(batch: {
    batchReferenceMasked: string;
    businessDate: string;
    createdAt: Date;
    differenceVnd: number;
    exceptionCount: number;
    feeAmountVnd: number;
    feeDifferenceVnd: number;
    grossAmountVnd: number;
    id: string;
    lines: readonly {
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
      status: string;
      type: 'COD_REMITTANCE';
    }[];
    localExpectedAmountVnd: number;
    localExpectedFeeAmountVnd: number;
    matchedCount: number;
    netAmountVnd: number;
    recordCount: number;
    replayed: boolean;
    source: string;
    status: string;
    version: number;
  }) {
    return {
      batch_reference_masked: batch.batchReferenceMasked,
      business_date: batch.businessDate,
      created_at: batch.createdAt.toISOString(),
      currency: 'VND' as const,
      difference_vnd: batch.differenceVnd,
      exception_count: batch.exceptionCount,
      fee_amount_vnd: batch.feeAmountVnd,
      fee_difference_vnd: batch.feeDifferenceVnd,
      gross_amount_vnd: batch.grossAmountVnd,
      id: batch.id,
      exception_summary: this.exceptionSummaryView(batch.lines),
      lines: batch.lines.map((line) => ({
        difference_vnd: line.differenceVnd,
        fee_amount_vnd: line.feeAmountVnd,
        fee_difference_vnd: line.feeDifferenceVnd,
        gross_amount_vnd: line.grossAmountVnd,
        id: line.id,
        line_number: line.lineNumber,
        local_expected_amount_vnd: line.localExpectedAmountVnd,
        local_expected_fee_amount_vnd: line.localExpectedFeeAmountVnd,
        net_amount_vnd: line.netAmountVnd,
        occurred_at: line.occurredAt.toISOString(),
        provider_reference_masked: line.providerReferenceMasked,
        record_reference_masked: line.recordReferenceMasked,
        status: line.status,
        type: line.type,
      })),
      local_expected_amount_vnd: batch.localExpectedAmountVnd,
      local_expected_fee_amount_vnd: batch.localExpectedFeeAmountVnd,
      matched_count: batch.matchedCount,
      net_amount_vnd: batch.netAmountVnd,
      record_count: batch.recordCount,
      replayed: batch.replayed,
      review: null,
      review_status: 'OPEN' as const,
      source: batch.source,
      status: batch.status,
      version: batch.version,
    };
  }

  private mapCommandError(error: unknown): never {
    if (error instanceof FinancialReconciliationCommandError) {
      if (error.code === 'FINANCIAL_RECONCILIATION_INPUT_INVALID') {
        throw new BadRequestException('Financial reconciliation input is invalid');
      }
      if (error.code === 'FINANCIAL_RECONCILIATION_AUTHORIZATION_DENIED') {
        throw new ForbiddenException('Access denied');
      }
      if (error.code === 'FINANCIAL_RECONCILIATION_CHANNEL_NOT_FOUND') {
        throw new NotFoundException('Provider channel not found');
      }
      if (error.code === 'FINANCIAL_RECONCILIATION_CURSOR_NOT_FOUND') {
        throw new NotFoundException('Financial reconciliation cursor not found');
      }
      if (error.code === 'FINANCIAL_RECONCILIATION_BATCH_NOT_FOUND') {
        throw new NotFoundException('Financial reconciliation batch not found');
      }
      if (error.code === 'FINANCIAL_RECONCILIATION_MAKER_CHECKER_CONFLICT') {
        throw new ForbiddenException('A different finance administrator must review this batch');
      }
      throw new ConflictException(error.code);
    }
    throw error;
  }
}
