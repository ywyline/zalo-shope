import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Put,
  Query,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import {
  afterSaleAdminStoreQuerySchema,
  afterSaleIdempotencyKeySchema,
  afterSaleSettingsEnforcementSchema,
} from '@zalo-shop/contracts';
import type { z } from 'zod';

import type { AdminHeaders } from '../admin/admin.service';
import { AfterSalesPolicyService } from './after-sales-policy.service';

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException('Input is invalid');
  return result.data;
}

function adminHeaders(
  authorization: string | undefined,
  storeCode: string | undefined,
  accessReason: string | undefined,
): AdminHeaders {
  if (!authorization?.startsWith('Bearer ') || !storeCode) {
    throw new UnauthorizedException('Admin authentication and store context are required');
  }
  return {
    ...(accessReason === undefined ? {} : { accessReason }),
    accessToken: authorization.slice(7),
    storeCode,
  };
}

@Controller('v1/admin/after-sale-settings')
export class AfterSalesPolicyController {
  public constructor(
    @Inject(AfterSalesPolicyService) private readonly policies: AfterSalesPolicyService,
  ) {}

  @Get()
  public getSettings(
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
  ) {
    return this.policies.getSettings(
      adminHeaders(authorization, storeCode, accessReason),
      parse(afterSaleAdminStoreQuerySchema, { store_id: storeId }).store_id,
    );
  }

  @Put()
  public async setEnforcement(
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: { setHeader(name: string, value: string): void },
  ) {
    const execution = await this.policies.setEnforcement(
      adminHeaders(authorization, storeCode, accessReason),
      parse(afterSaleAdminStoreQuerySchema, { store_id: storeId }).store_id,
      parse(afterSaleIdempotencyKeySchema, idempotencyKey),
      parse(afterSaleSettingsEnforcementSchema, body),
    );
    response.setHeader('Idempotency-Replayed', String(execution.replayed));
    return execution.body;
  }
}
