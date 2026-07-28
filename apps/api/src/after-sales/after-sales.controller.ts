import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import {
  adminAfterSaleListQuerySchema,
  afterSaleAdminReadQuerySchema,
  afterSaleIdParamsSchema,
  afterSaleListQuerySchema,
  afterSaleMemberReadQuerySchema,
  afterSaleStoreCodeHeaderSchema,
} from '@zalo-shop/contracts';
import { resolveCorrelationId } from '@zalo-shop/logger';
import type { z } from 'zod';

import type { AdminHeaders } from '../admin/admin.service';
import { AfterSalesService } from './after-sales.service';

type HttpRequest = { id?: unknown };
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
    storeCode: parse(afterSaleStoreCodeHeaderSchema, input.storeCode),
  };
}

function setReadHeaders(response: HttpResponse, value: string): void {
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('X-Correlation-Id', value);
}

@Controller('v1/after-sales')
export class AfterSalesController {
  public constructor(@Inject(AfterSalesService) private readonly afterSales: AfterSalesService) {}

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
}

@Controller('v1/admin/after-sales')
export class AfterSalesAdminController {
  public constructor(@Inject(AfterSalesService) private readonly afterSales: AfterSalesService) {}

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
