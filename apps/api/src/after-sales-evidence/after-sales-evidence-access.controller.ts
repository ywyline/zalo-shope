import { isIP } from 'node:net';

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
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  afterSaleEvidenceAdminReadQuerySchema,
  afterSaleEvidenceIdParamsSchema,
  afterSaleEvidenceMemberQuerySchema,
  afterSaleEvidenceProtectedReadAccessReasonSchema,
  afterSaleStoreCodeHeaderSchema,
} from '@zalo-shop/contracts';
import { resolveCorrelationId } from '@zalo-shop/logger';
import type { z } from 'zod';

import type { AdminHeaders } from '../admin/admin.service';
import { AfterSalesEvidenceService } from './after-sales-evidence.service';

type HttpRequest = { id?: unknown; ip?: unknown };
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

function protectedReadAccessReason(value: string | undefined): string | undefined {
  return value === undefined
    ? undefined
    : parse(afterSaleEvidenceProtectedReadAccessReasonSchema, value);
}

function adminHeaders(input: {
  accessReason?: string;
  authorization?: string;
  correlationId: string;
  sourceIp: string;
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
    sourceIp: input.sourceIp,
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

function setHeaders(response: HttpResponse, correlationId: string): void {
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Correlation-Id', correlationId);
}

@Controller('v1/after-sales')
export class AfterSalesEvidenceAccessController {
  public constructor(
    @Inject(AfterSalesEvidenceService)
    private readonly evidence: AfterSalesEvidenceService,
  ) {}

  @Get(':afterSaleId/evidence/:evidenceId')
  public memberRead(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Param() params: unknown,
    @Query() query: unknown,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ) {
    const correlationId = resolveCorrelationId();
    request.id = correlationId;
    setHeaders(response, correlationId);
    parse(afterSaleEvidenceMemberQuerySchema, query);
    const identifiers = parse(afterSaleEvidenceIdParamsSchema, params);
    return this.evidence.memberProtectedRead({
      afterSaleId: identifiers.afterSaleId,
      evidenceId: identifiers.evidenceId,
      headers: {
        authorization,
        correlationId,
        storeCode: memberStoreCode(storeCode),
      },
    });
  }
}

@Controller('v1/admin/after-sales')
export class AfterSalesEvidenceAdminAccessController {
  public constructor(
    @Inject(AfterSalesEvidenceService)
    private readonly evidence: AfterSalesEvidenceService,
  ) {}

  @Get(':afterSaleId/evidence/:evidenceId')
  public adminRead(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Param() params: unknown,
    @Query() query: unknown,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ) {
    const correlationId = resolveCorrelationId();
    request.id = correlationId;
    setHeaders(response, correlationId);
    const identifiers = parse(afterSaleEvidenceIdParamsSchema, params);
    const parsedQuery = parse(afterSaleEvidenceAdminReadQuerySchema, query);
    return this.evidence.adminProtectedRead({
      afterSaleId: identifiers.afterSaleId,
      evidenceId: identifiers.evidenceId,
      headers: adminHeaders({
        accessReason: protectedReadAccessReason(accessReason),
        authorization,
        correlationId,
        sourceIp: sourceIp(request.ip),
        storeCode,
      }),
      storeId: parsedQuery.store_id,
    });
  }
}
