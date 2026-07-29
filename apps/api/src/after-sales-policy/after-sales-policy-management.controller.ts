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
  Put,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import {
  accessReasonSchema,
  afterSaleAdminStoreQuerySchema,
  afterSaleIdempotencyKeySchema,
  afterSalePolicyCodeParamsSchema,
  afterSalePolicyDisableSchema,
  afterSalePolicyDraftSchema,
  afterSalePolicyListQuerySchema,
  afterSalePolicyPublishSchema,
  afterSalePolicyVersionListQuerySchema,
  afterSalePolicyVersionParamsSchema,
  afterSaleStoreCodeHeaderSchema,
} from '@zalo-shop/contracts';
import { resolveCorrelationId } from '@zalo-shop/logger';
import type { z } from 'zod';

import type { AdminHeaders } from '../admin/admin.service';
import { AfterSalesPolicyManagementService } from './after-sales-policy-management.service';

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
    ...(input.accessReason === undefined
      ? {}
      : { accessReason: parse(accessReasonSchema, input.accessReason) }),
    accessToken: input.authorization.slice(7),
    correlationId: input.correlationId,
    storeCode: parse(afterSaleStoreCodeHeaderSchema, input.storeCode),
  };
}

function setHeaders(response: HttpResponse, correlation: string): void {
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('X-Correlation-Id', correlation);
}

@Controller('v1/admin/after-sale-policies')
export class AfterSalesPolicyManagementController {
  public constructor(
    @Inject(AfterSalesPolicyManagementService)
    private readonly policies: AfterSalesPolicyManagementService,
  ) {}

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
    setHeaders(response, requestCorrelationId);
    return this.policies.list(
      adminHeaders({
        accessReason,
        authorization,
        correlationId: requestCorrelationId,
        storeCode,
      }),
      parse(afterSalePolicyListQuerySchema, query),
    );
  }

  @Get(':policyCode')
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
    setHeaders(response, requestCorrelationId);
    const storeId = parse(afterSaleAdminStoreQuerySchema, query).store_id;
    const code = parse(afterSalePolicyCodeParamsSchema, params).policyCode;
    return this.policies.detail(
      adminHeaders({
        accessReason,
        authorization,
        correlationId: requestCorrelationId,
        storeCode,
      }),
      storeId,
      code,
    );
  }

  @Put(':policyCode')
  public async putDraft(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Headers('x-correlation-id') suppliedCorrelationId: string | undefined,
    @Param() params: unknown,
    @Query() query: unknown,
    @Body() body: unknown,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ) {
    const requestCorrelationId = correlationId(request, suppliedCorrelationId);
    setHeaders(response, requestCorrelationId);
    const execution = await this.policies.putDraft(
      adminHeaders({
        accessReason,
        authorization,
        correlationId: requestCorrelationId,
        storeCode,
      }),
      parse(afterSaleAdminStoreQuerySchema, query).store_id,
      parse(afterSalePolicyCodeParamsSchema, params).policyCode,
      parse(afterSaleIdempotencyKeySchema, idempotencyKey),
      parse(afterSalePolicyDraftSchema, body),
    );
    response.setHeader('Idempotency-Replayed', String(execution.replayed));
    return execution.body;
  }

  @Get(':policyCode/versions')
  public listVersions(
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
    setHeaders(response, requestCorrelationId);
    return this.policies.listVersions(
      adminHeaders({
        accessReason,
        authorization,
        correlationId: requestCorrelationId,
        storeCode,
      }),
      parse(afterSalePolicyCodeParamsSchema, params).policyCode,
      parse(afterSalePolicyVersionListQuerySchema, query),
    );
  }

  @Get(':policyCode/versions/:versionNumber')
  public versionDetail(
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
    setHeaders(response, requestCorrelationId);
    const parsedParams = parse(afterSalePolicyVersionParamsSchema, params);
    return this.policies.versionDetail(
      adminHeaders({
        accessReason,
        authorization,
        correlationId: requestCorrelationId,
        storeCode,
      }),
      parse(afterSaleAdminStoreQuerySchema, query).store_id,
      parsedParams.policyCode,
      parsedParams.versionNumber,
    );
  }

  @Post(':policyCode/publish')
  @HttpCode(HttpStatus.OK)
  public async publish(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Headers('x-correlation-id') suppliedCorrelationId: string | undefined,
    @Param() params: unknown,
    @Query() query: unknown,
    @Body() body: unknown,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ) {
    const requestCorrelationId = correlationId(request, suppliedCorrelationId);
    setHeaders(response, requestCorrelationId);
    const execution = await this.policies.publish(
      adminHeaders({
        accessReason,
        authorization,
        correlationId: requestCorrelationId,
        storeCode,
      }),
      parse(afterSaleAdminStoreQuerySchema, query).store_id,
      parse(afterSalePolicyCodeParamsSchema, params).policyCode,
      parse(afterSaleIdempotencyKeySchema, idempotencyKey),
      parse(afterSalePolicyPublishSchema, body),
    );
    response.setHeader('Idempotency-Replayed', String(execution.replayed));
    return execution.body;
  }

  @Post(':policyCode/disable')
  @HttpCode(HttpStatus.OK)
  public async disable(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Headers('x-correlation-id') suppliedCorrelationId: string | undefined,
    @Param() params: unknown,
    @Query() query: unknown,
    @Body() body: unknown,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ) {
    const requestCorrelationId = correlationId(request, suppliedCorrelationId);
    setHeaders(response, requestCorrelationId);
    const execution = await this.policies.disable(
      adminHeaders({
        accessReason,
        authorization,
        correlationId: requestCorrelationId,
        storeCode,
      }),
      parse(afterSaleAdminStoreQuerySchema, query).store_id,
      parse(afterSalePolicyCodeParamsSchema, params).policyCode,
      parse(afterSaleIdempotencyKeySchema, idempotencyKey),
      parse(afterSalePolicyDisableSchema, body),
    );
    response.setHeader('Idempotency-Replayed', String(execution.replayed));
    return execution.body;
  }
}
