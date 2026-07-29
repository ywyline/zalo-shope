import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
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
  afterSaleSettingsEnforcementSchema,
  afterSaleStoreCodeHeaderSchema,
} from '@zalo-shop/contracts';
import { resolveCorrelationId } from '@zalo-shop/logger';
import type { z } from 'zod';

import type { AdminHeaders } from '../admin/admin.service';
import { AfterSalesPolicyService } from './after-sales-policy.service';

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException('Input is invalid');
  return result.data;
}

type HttpRequest = { id?: unknown };
type HttpResponse = { setHeader(name: string, value: string): void };

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

function setHeaders(response: HttpResponse, correlationId: string): void {
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('X-Correlation-Id', correlationId);
}

@Controller('v1/admin/after-sale-settings')
export class AfterSalesPolicyController {
  public constructor(
    @Inject(AfterSalesPolicyService) private readonly policies: AfterSalesPolicyService,
  ) {}

  @Get()
  public getSettings(
    @Query() query: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Headers('x-correlation-id') suppliedCorrelationId: string | undefined,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ) {
    const correlationId = resolveCorrelationId(request.id, suppliedCorrelationId);
    setHeaders(response, correlationId);
    return this.policies.getSettings(
      adminHeaders({ accessReason, authorization, correlationId, storeCode }),
      parse(afterSaleAdminStoreQuerySchema, query).store_id,
    );
  }

  @Put()
  public async setEnforcement(
    @Query() query: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Headers('x-correlation-id') suppliedCorrelationId: string | undefined,
    @Body() body: unknown,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ) {
    const correlationId = resolveCorrelationId(request.id, suppliedCorrelationId);
    setHeaders(response, correlationId);
    const execution = await this.policies.setEnforcement(
      adminHeaders({ accessReason, authorization, correlationId, storeCode }),
      parse(afterSaleAdminStoreQuerySchema, query).store_id,
      parse(afterSaleIdempotencyKeySchema, idempotencyKey),
      parse(afterSaleSettingsEnforcementSchema, body),
    );
    response.setHeader('Idempotency-Replayed', String(execution.replayed));
    return execution.body;
  }
}
