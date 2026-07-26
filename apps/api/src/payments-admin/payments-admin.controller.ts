import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import {
  integrationJobIdParamsSchema,
  integrationJobListQuerySchema,
  integrationJobRetryRequestSchema,
  paymentAdminStoreQuerySchema,
  paymentIdParamsSchema,
  paymentListQuerySchema,
  providerQueryRequestSchema,
  refundCreateRequestSchema,
  refundIdParamsSchema,
  refundListQuerySchema,
} from '@zalo-shop/contracts';
import type { z } from 'zod';

import type { AdminHeaders } from '../admin/admin.service';
import { PaymentsAdminService } from './payments-admin.service';

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

@Controller('v1/admin')
export class PaymentsAdminController {
  public constructor(
    @Inject(PaymentsAdminService) private readonly payments: PaymentsAdminService,
  ) {}

  @Get('payments')
  public listPayments(
    @Query() query: Record<string, unknown>,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
  ) {
    const { store_id } = parse(paymentAdminStoreQuerySchema, { store_id: query.store_id });
    return this.payments.listPayments(
      adminHeaders(authorization, storeCode, accessReason),
      store_id,
      parse(paymentListQuerySchema, {
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.order_id === undefined ? {} : { order_id: query.order_id }),
        ...(query.status === undefined ? {} : { status: query.status }),
      }),
    );
  }

  @Post('payments/:paymentId/query')
  @HttpCode(202)
  public queryPayment(
    @Query() query: unknown,
    @Param() params: unknown,
    @Body() body: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return this.payments.queryPayment(
      adminHeaders(authorization, storeCode, accessReason),
      parse(paymentAdminStoreQuerySchema, query).store_id,
      parse(paymentIdParamsSchema, params).paymentId,
      idempotencyKey(key),
      parse(providerQueryRequestSchema, body),
    );
  }

  @Post('payments/:paymentId/refunds')
  @HttpCode(202)
  public createRefund(
    @Query() query: unknown,
    @Param() params: unknown,
    @Body() body: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return this.payments.createRefund(
      adminHeaders(authorization, storeCode, accessReason),
      parse(paymentAdminStoreQuerySchema, query).store_id,
      parse(paymentIdParamsSchema, params).paymentId,
      idempotencyKey(key),
      parse(refundCreateRequestSchema, body),
    );
  }

  @Get('refunds')
  public listRefunds(
    @Query() query: Record<string, unknown>,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
  ) {
    const { store_id } = parse(paymentAdminStoreQuerySchema, { store_id: query.store_id });
    return this.payments.listRefunds(
      adminHeaders(authorization, storeCode, accessReason),
      store_id,
      parse(refundListQuerySchema, {
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.order_id === undefined ? {} : { order_id: query.order_id }),
        ...(query.payment_id === undefined ? {} : { payment_id: query.payment_id }),
        ...(query.status === undefined ? {} : { status: query.status }),
      }),
    );
  }

  @Post('refunds/:refundId/query')
  @HttpCode(202)
  public queryRefund(
    @Query() query: unknown,
    @Param() params: unknown,
    @Body() body: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return this.payments.queryRefund(
      adminHeaders(authorization, storeCode, accessReason),
      parse(paymentAdminStoreQuerySchema, query).store_id,
      parse(refundIdParamsSchema, params).refundId,
      idempotencyKey(key),
      parse(providerQueryRequestSchema, body),
    );
  }

  @Get('integration-jobs')
  public listJobs(
    @Query() query: Record<string, unknown>,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
  ) {
    const { store_id } = parse(paymentAdminStoreQuerySchema, { store_id: query.store_id });
    return this.payments.listJobs(
      adminHeaders(authorization, storeCode, accessReason),
      store_id,
      parse(integrationJobListQuerySchema, {
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.status === undefined ? {} : { status: query.status }),
      }),
    );
  }

  @Post('integration-jobs/:jobId/retry')
  @HttpCode(202)
  public retryJob(
    @Query() query: unknown,
    @Param() params: unknown,
    @Body() body: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return this.payments.retryJob(
      adminHeaders(authorization, storeCode, accessReason),
      parse(paymentAdminStoreQuerySchema, query).store_id,
      parse(integrationJobIdParamsSchema, params).jobId,
      idempotencyKey(key),
      parse(integrationJobRetryRequestSchema, body),
    );
  }
}
