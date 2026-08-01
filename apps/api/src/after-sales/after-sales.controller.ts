import { isIP } from 'node:net';

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  adminAfterSaleListQuerySchema,
  afterSaleAdminReadQuerySchema,
  afterSaleAdminStoreQuerySchema,
  afterSaleCancelRequestSchema,
  afterSaleCreateRequestSchema,
  afterSaleIdParamsSchema,
  afterSaleIdempotencyKeySchema,
  afterSaleListQuerySchema,
  afterSaleMemberReadQuerySchema,
  afterSaleReturnFactRequestSchema,
  afterSaleReturnShipmentRequestSchema,
  afterSaleReviewRequestSchema,
  afterSaleReviewResolveRequestSchema,
  afterSaleStoreCodeHeaderSchema,
  merchantAfterSaleCreateRequestSchema,
  orderIdParamsSchema,
} from '@zalo-shop/contracts';
import { resolveCorrelationId } from '@zalo-shop/logger';
import type { z } from 'zod';

import type { AdminHeaders } from '../admin/admin.service';
import { AfterSalesService } from './after-sales.service';

type HttpRequest = { id?: unknown; ip?: unknown };
type HttpResponse = { setHeader(name: string, value: string): void };

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException('Input is invalid');
  return result.data;
}

function correlationId(request: HttpRequest, supplied: string | undefined): string {
  return resolveCorrelationId(request.id, supplied);
}

function memberStoreCode(value: string | undefined): string {
  if (value === undefined) {
    throw new UnauthorizedException('Member authentication and store context are required');
  }
  return parse(afterSaleStoreCodeHeaderSchema, value);
}

function adminHeaders(input: {
  accessReason?: string;
  authorization?: string;
  correlationId: string;
  sourceIp?: string;
  storeCode?: string;
}): AdminHeaders {
  if (
    !input.authorization?.startsWith('Bearer ') ||
    input.authorization.length <= 7 ||
    input.storeCode === undefined
  ) {
    throw new UnauthorizedException('Admin authentication and store context are required');
  }
  return {
    ...(input.accessReason === undefined ? {} : { accessReason: input.accessReason }),
    accessToken: input.authorization.slice(7),
    correlationId: input.correlationId,
    ...(input.sourceIp === undefined ? {} : { sourceIp: input.sourceIp }),
    storeCode: parse(afterSaleStoreCodeHeaderSchema, input.storeCode),
  };
}

function sourceIp(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ServiceUnavailableException('Request network context is unavailable');
  }
  const candidate = value.trim();
  const normalized = candidate.startsWith('::ffff:') ? candidate.slice(7) : candidate;
  if (isIP(normalized) === 0) {
    throw new ServiceUnavailableException('Request network context is unavailable');
  }
  return normalized;
}

function setReadHeaders(response: HttpResponse, value: string): void {
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('X-Correlation-Id', value);
}

@Controller('v1/after-sales')
export class AfterSalesController {
  public constructor(@Inject(AfterSalesService) private readonly afterSales: AfterSalesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  public async create(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Body() body: unknown,
    @Query() query: unknown,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ) {
    const requestCorrelationId = resolveCorrelationId();
    request.id = requestCorrelationId;
    setReadHeaders(response, requestCorrelationId);
    parse(afterSaleMemberReadQuerySchema, query);
    const execution = await this.afterSales.memberCreate({
      authorization,
      body: parse(afterSaleCreateRequestSchema, body),
      correlationId: requestCorrelationId,
      idempotencyKey: parse(afterSaleIdempotencyKeySchema, idempotencyKey),
      sourceIp: sourceIp(request.ip),
      storeCode: memberStoreCode(storeCode),
    });
    response.setHeader('Idempotency-Replayed', String(execution.replayed));
    return execution.body;
  }

  @Get()
  public list(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-correlation-id') suppliedCorrelationId: string | undefined,
    @Query() query: unknown,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ) {
    const requestCorrelationId = correlationId(request, suppliedCorrelationId);
    setReadHeaders(response, requestCorrelationId);
    return this.afterSales.memberList({
      authorization,
      correlationId: requestCorrelationId,
      query: parse(afterSaleListQuerySchema, query),
      storeCode: memberStoreCode(storeCode),
    });
  }

  @Get(':afterSaleId')
  public detail(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-correlation-id') suppliedCorrelationId: string | undefined,
    @Param() params: unknown,
    @Query() query: unknown,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ) {
    const requestCorrelationId = correlationId(request, suppliedCorrelationId);
    setReadHeaders(response, requestCorrelationId);
    parse(afterSaleMemberReadQuerySchema, query);
    return this.afterSales.memberDetail({
      afterSaleId: parse(afterSaleIdParamsSchema, params).afterSaleId,
      authorization,
      correlationId: requestCorrelationId,
      storeCode: memberStoreCode(storeCode),
    });
  }

  @Post(':afterSaleId/cancel')
  @HttpCode(HttpStatus.OK)
  public async cancel(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Param() params: unknown,
    @Body() body: unknown,
    @Query() query: unknown,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ) {
    const requestCorrelationId = resolveCorrelationId();
    request.id = requestCorrelationId;
    setReadHeaders(response, requestCorrelationId);
    parse(afterSaleMemberReadQuerySchema, query);
    const execution = await this.afterSales.memberCancel({
      afterSaleId: parse(afterSaleIdParamsSchema, params).afterSaleId,
      authorization,
      body: parse(afterSaleCancelRequestSchema, body),
      correlationId: requestCorrelationId,
      idempotencyKey: parse(afterSaleIdempotencyKeySchema, idempotencyKey),
      sourceIp: sourceIp(request.ip),
      storeCode: memberStoreCode(storeCode),
    });
    response.setHeader('Idempotency-Replayed', String(execution.replayed));
    return execution.body;
  }

  @Post(':afterSaleId/return-shipment')
  @HttpCode(HttpStatus.OK)
  public async submitReturnShipment(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Param() params: unknown,
    @Body() body: unknown,
    @Query() query: unknown,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ) {
    const requestCorrelationId = resolveCorrelationId();
    request.id = requestCorrelationId;
    setReadHeaders(response, requestCorrelationId);
    parse(afterSaleMemberReadQuerySchema, query);
    const execution = await this.afterSales.memberSubmitReturn({
      afterSaleId: parse(afterSaleIdParamsSchema, params).afterSaleId,
      authorization,
      body: parse(afterSaleReturnShipmentRequestSchema, body),
      correlationId: requestCorrelationId,
      idempotencyKey: parse(afterSaleIdempotencyKeySchema, idempotencyKey),
      sourceIp: sourceIp(request.ip),
      storeCode: memberStoreCode(storeCode),
    });
    response.setHeader('Idempotency-Replayed', String(execution.replayed));
    return execution.body;
  }
}

@Controller('v1/admin/orders')
export class AfterSalesAdminOrderController {
  public constructor(@Inject(AfterSalesService) private readonly afterSales: AfterSalesService) {}

  @Post(':orderId/after-sales')
  @HttpCode(HttpStatus.CREATED)
  public async create(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Param() params: unknown,
    @Body() body: unknown,
    @Query() query: unknown,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ) {
    const requestCorrelationId = resolveCorrelationId();
    request.id = requestCorrelationId;
    setReadHeaders(response, requestCorrelationId);
    const execution = await this.afterSales.adminCreateMerchantRefund({
      body: parse(merchantAfterSaleCreateRequestSchema, body),
      headers: adminHeaders({
        accessReason,
        authorization,
        correlationId: requestCorrelationId,
        sourceIp: sourceIp(request.ip),
        storeCode,
      }),
      idempotencyKey: parse(afterSaleIdempotencyKeySchema, idempotencyKey),
      orderId: parse(orderIdParamsSchema, params).orderId,
      query: parse(afterSaleAdminStoreQuerySchema, query),
    });
    response.setHeader('Idempotency-Replayed', String(execution.replayed));
    return execution.body;
  }
}

@Controller('v1/admin/after-sales')
export class AfterSalesAdminController {
  public constructor(@Inject(AfterSalesService) private readonly afterSales: AfterSalesService) {}

  @Post(':afterSaleId/review')
  @HttpCode(HttpStatus.OK)
  public async review(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Param() params: unknown,
    @Body() body: unknown,
    @Query() query: unknown,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ) {
    const requestCorrelationId = resolveCorrelationId();
    request.id = requestCorrelationId;
    setReadHeaders(response, requestCorrelationId);
    const execution = await this.afterSales.adminReview({
      afterSaleId: parse(afterSaleIdParamsSchema, params).afterSaleId,
      body: parse(afterSaleReviewRequestSchema, body),
      headers: adminHeaders({
        accessReason,
        authorization,
        correlationId: requestCorrelationId,
        sourceIp: sourceIp(request.ip),
        storeCode,
      }),
      idempotencyKey: parse(afterSaleIdempotencyKeySchema, idempotencyKey),
      query: parse(afterSaleAdminStoreQuerySchema, query),
    });
    response.setHeader('Idempotency-Replayed', String(execution.replayed));
    return execution.body;
  }

  @Post(':afterSaleId/resolve-review')
  @HttpCode(HttpStatus.OK)
  public async resolveReview(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Param() params: unknown,
    @Body() body: unknown,
    @Query() query: unknown,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ) {
    const requestCorrelationId = resolveCorrelationId();
    request.id = requestCorrelationId;
    setReadHeaders(response, requestCorrelationId);
    const execution = await this.afterSales.adminResolveReview({
      afterSaleId: parse(afterSaleIdParamsSchema, params).afterSaleId,
      body: parse(afterSaleReviewResolveRequestSchema, body),
      headers: adminHeaders({
        accessReason,
        authorization,
        correlationId: requestCorrelationId,
        sourceIp: sourceIp(request.ip),
        storeCode,
      }),
      idempotencyKey: parse(afterSaleIdempotencyKeySchema, idempotencyKey),
      query: parse(afterSaleAdminStoreQuerySchema, query),
    });
    response.setHeader('Idempotency-Replayed', String(execution.replayed));
    return execution.body;
  }

  @Post(':afterSaleId/return-shipment/fact')
  @HttpCode(HttpStatus.OK)
  public async recordReturnFact(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Param() params: unknown,
    @Body() body: unknown,
    @Query() query: unknown,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ) {
    const requestCorrelationId = resolveCorrelationId();
    request.id = requestCorrelationId;
    setReadHeaders(response, requestCorrelationId);
    const execution = await this.afterSales.adminRecordReturnFact({
      afterSaleId: parse(afterSaleIdParamsSchema, params).afterSaleId,
      body: parse(afterSaleReturnFactRequestSchema, body),
      headers: adminHeaders({
        accessReason,
        authorization,
        correlationId: requestCorrelationId,
        sourceIp: sourceIp(request.ip),
        storeCode,
      }),
      idempotencyKey: parse(afterSaleIdempotencyKeySchema, idempotencyKey),
      query: parse(afterSaleAdminStoreQuerySchema, query),
    });
    response.setHeader('Idempotency-Replayed', String(execution.replayed));
    return execution.body;
  }

  @Get()
  public list(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Headers('x-correlation-id') suppliedCorrelationId: string | undefined,
    @Query() query: unknown,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ) {
    const requestCorrelationId = correlationId(request, suppliedCorrelationId);
    setReadHeaders(response, requestCorrelationId);
    return this.afterSales.adminList({
      headers: adminHeaders({
        accessReason,
        authorization,
        correlationId: requestCorrelationId,
        storeCode,
      }),
      query: parse(adminAfterSaleListQuerySchema, query),
    });
  }

  @Get(':afterSaleId')
  public detail(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Headers('x-correlation-id') suppliedCorrelationId: string | undefined,
    @Param() params: unknown,
    @Query() query: unknown,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ) {
    const requestCorrelationId = correlationId(request, suppliedCorrelationId);
    setReadHeaders(response, requestCorrelationId);
    return this.afterSales.adminDetail({
      afterSaleId: parse(afterSaleIdParamsSchema, params).afterSaleId,
      headers: adminHeaders({
        accessReason,
        authorization,
        correlationId: requestCorrelationId,
        storeCode,
      }),
      query: parse(afterSaleAdminReadQuerySchema, query),
    });
  }
}
