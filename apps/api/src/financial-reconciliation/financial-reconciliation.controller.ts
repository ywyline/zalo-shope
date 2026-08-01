import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import {
  financialReconciliationBatchListQuerySchema,
  financialReconciliationBatchParamsSchema,
  codReceivableListQuerySchema,
  codRemittanceBatchImportSchema,
  closeFinancialReconciliationSchema,
  financialReconciliationStoreQuerySchema,
  paymentSettlementBatchImportSchema,
} from '@zalo-shop/contracts';
import type { z } from 'zod';

import type { AdminHeaders } from '../admin/admin.service';
import { FinancialReconciliationService } from './financial-reconciliation.service';

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException('Input is invalid');
  return result.data;
}

function bearer(value: string | undefined): string {
  if (!value?.startsWith('Bearer ') || value.length <= 7) {
    throw new UnauthorizedException('Bearer token is required');
  }
  return value.slice(7);
}

function adminHeaders(
  authorization: string | undefined,
  storeCode: string | undefined,
  accessReason: string | undefined,
): AdminHeaders {
  if (!storeCode?.trim()) throw new UnauthorizedException('Store context is required');
  return {
    ...(accessReason === undefined ? {} : { accessReason }),
    accessToken: bearer(authorization),
    storeCode: storeCode.trim(),
  };
}

function idempotencyKey(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized || !/^[!-~]{16,128}$/u.test(normalized)) {
    throw new BadRequestException('Idempotency-Key is required');
  }
  return normalized;
}

@Controller('v1/admin/financial-reconciliation')
export class FinancialReconciliationController {
  public constructor(
    @Inject(FinancialReconciliationService)
    private readonly reconciliation: FinancialReconciliationService,
  ) {}

  @Post('payment-batches')
  public importPaymentBatch(
    @Query() query: unknown,
    @Body() body: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return this.reconciliation.importPaymentBatch(
      adminHeaders(authorization, storeCode, accessReason),
      parse(financialReconciliationStoreQuerySchema, query).store_id,
      idempotencyKey(key),
      parse(paymentSettlementBatchImportSchema, body),
    );
  }

  @Get('batches')
  public listBatches(
    @Query() query: Record<string, unknown>,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
  ) {
    return this.reconciliation.listBatches(
      adminHeaders(authorization, storeCode, accessReason),
      parse(financialReconciliationStoreQuerySchema, { store_id: query.store_id }).store_id,
      parse(financialReconciliationBatchListQuerySchema, {
        ...(query.business_date_from === undefined
          ? {}
          : { business_date_from: query.business_date_from }),
        ...(query.business_date_to === undefined
          ? {}
          : { business_date_to: query.business_date_to }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.review_status === undefined ? {} : { review_status: query.review_status }),
        ...(query.source === undefined ? {} : { source: query.source }),
        ...(query.status === undefined ? {} : { status: query.status }),
      }),
    );
  }

  @Post('cod-batches')
  public importCodBatch(
    @Query() query: unknown,
    @Body() body: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return this.reconciliation.importCodBatch(
      adminHeaders(authorization, storeCode, accessReason),
      parse(financialReconciliationStoreQuerySchema, query).store_id,
      idempotencyKey(key),
      parse(codRemittanceBatchImportSchema, body),
    );
  }

  @Get('cod-receivables')
  public listCodReceivables(
    @Query() query: Record<string, unknown>,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
  ) {
    return this.reconciliation.listCodReceivables(
      adminHeaders(authorization, storeCode, accessReason),
      parse(financialReconciliationStoreQuerySchema, { store_id: query.store_id }).store_id,
      parse(codReceivableListQuerySchema, {
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.status === undefined ? {} : { status: query.status }),
      }),
    );
  }

  @Get('batches/:batchId')
  public getBatch(
    @Query() query: unknown,
    @Param() params: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
  ) {
    return this.reconciliation.getBatch(
      adminHeaders(authorization, storeCode, accessReason),
      parse(financialReconciliationStoreQuerySchema, query).store_id,
      parse(financialReconciliationBatchParamsSchema, params).batchId,
    );
  }

  @Post('batches/:batchId/review')
  public reviewBatch(
    @Query() query: unknown,
    @Param() params: unknown,
    @Body() body: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return this.reconciliation.reviewBatch(
      adminHeaders(authorization, storeCode, accessReason),
      parse(financialReconciliationStoreQuerySchema, query).store_id,
      parse(financialReconciliationBatchParamsSchema, params).batchId,
      idempotencyKey(key),
      parse(closeFinancialReconciliationSchema, body),
    );
  }
}
