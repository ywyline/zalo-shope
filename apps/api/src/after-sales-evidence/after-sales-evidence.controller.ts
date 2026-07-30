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
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import {
  afterSaleEvidenceConfirmRequestSchema,
  afterSaleEvidenceMemberQuerySchema,
  afterSaleEvidenceUploadRequestSchema,
  afterSaleIdempotencyKeySchema,
  afterSaleStoreCodeHeaderSchema,
  evidenceIdParamsSchema,
} from '@zalo-shop/contracts';
import { resolveCorrelationId } from '@zalo-shop/logger';
import type { z } from 'zod';

import { AfterSalesEvidenceService } from './after-sales-evidence.service';

type HttpRequest = { id?: unknown };
type HttpResponse = { setHeader(name: string, value: string): void };

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException('Input is invalid');
  return result.data;
}

function memberStoreCode(value: string | undefined): string {
  if (value === undefined) {
    throw new UnauthorizedException('Member authentication and store context are required');
  }
  return parse(afterSaleStoreCodeHeaderSchema, value);
}

function setHeaders(response: HttpResponse, correlationId: string): void {
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Correlation-Id', correlationId);
}

@Controller('v1/after-sales/evidence-uploads')
export class AfterSalesEvidenceController {
  public constructor(
    @Inject(AfterSalesEvidenceService)
    private readonly evidence: AfterSalesEvidenceService,
  ) {}

  @Post()
  public async initialize(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-correlation-id') suppliedCorrelationId: string | undefined,
    @Body() body: unknown,
    @Query() query: unknown,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ) {
    const correlationId = resolveCorrelationId(request.id, suppliedCorrelationId);
    setHeaders(response, correlationId);
    parse(afterSaleEvidenceMemberQuerySchema, query);
    const result = await this.evidence.initialize({
      body: parse(afterSaleEvidenceUploadRequestSchema, body),
      headers: {
        authorization,
        correlationId,
        storeCode: memberStoreCode(storeCode),
      },
      idempotencyKey: parse(afterSaleIdempotencyKeySchema, idempotencyKey),
    });
    response.setHeader('Idempotency-Replayed', String(result.replayed));
    return result.body;
  }

  @Post(':evidenceId/confirm')
  @HttpCode(202)
  public async confirm(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-correlation-id') suppliedCorrelationId: string | undefined,
    @Param() params: unknown,
    @Body() body: unknown,
    @Query() query: unknown,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ) {
    const correlationId = resolveCorrelationId(request.id, suppliedCorrelationId);
    setHeaders(response, correlationId);
    parse(afterSaleEvidenceMemberQuerySchema, query);
    const confirmation = parse(afterSaleEvidenceConfirmRequestSchema, body);
    const result = await this.evidence.confirm({
      evidenceId: parse(evidenceIdParamsSchema, params).evidenceId,
      expectedVersion: confirmation.expected_version,
      headers: {
        authorization,
        correlationId,
        storeCode: memberStoreCode(storeCode),
      },
      idempotencyKey: parse(afterSaleIdempotencyKeySchema, idempotencyKey),
    });
    response.setHeader('Idempotency-Replayed', String(result.replayed));
    return result.body;
  }

  @Get(':evidenceId')
  public status(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-correlation-id') suppliedCorrelationId: string | undefined,
    @Param() params: unknown,
    @Query() query: unknown,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ) {
    const correlationId = resolveCorrelationId(request.id, suppliedCorrelationId);
    setHeaders(response, correlationId);
    parse(afterSaleEvidenceMemberQuerySchema, query);
    return this.evidence.status({
      evidenceId: parse(evidenceIdParamsSchema, params).evidenceId,
      headers: {
        authorization,
        correlationId,
        storeCode: memberStoreCode(storeCode),
      },
    });
  }
}
