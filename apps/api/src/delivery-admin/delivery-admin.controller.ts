import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Patch,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { deliveryPolicyStoreQuerySchema, updateDeliveryPolicySchema } from '@zalo-shop/contracts';

import type { AdminHeaders } from '../admin/admin.service';
import { DeliveryAdminService } from './delivery-admin.service';

function parse<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException('Input is invalid');
  return result.data;
}

function adminHeaders(
  authorization: string | undefined,
  storeCode: string | undefined,
  accessReason: string | undefined,
): AdminHeaders {
  if (!authorization?.startsWith('Bearer ') || !storeCode)
    throw new UnauthorizedException('Admin authentication is required');
  return { accessReason, accessToken: authorization.slice(7), storeCode };
}

@Controller('v1/admin/delivery-policy')
export class DeliveryAdminController {
  public constructor(
    @Inject(DeliveryAdminService) private readonly delivery: DeliveryAdminService,
  ) {}

  @Get()
  public get(
    @Query() query: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
  ) {
    const { store_id: storeId } = parse(deliveryPolicyStoreQuerySchema, query);
    return this.delivery.get(adminHeaders(authorization, storeCode, accessReason), storeId);
  }

  @Patch()
  public update(
    @Query() query: unknown,
    @Body() body: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
  ) {
    const { store_id: storeId } = parse(deliveryPolicyStoreQuerySchema, query);
    return this.delivery.update(
      adminHeaders(authorization, storeCode, accessReason),
      storeId,
      parse(updateDeliveryPolicySchema, body),
    );
  }
}
