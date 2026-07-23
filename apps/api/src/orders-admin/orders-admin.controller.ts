import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import {
  adminOrderActionSchema,
  adminOrderNoteSchema,
  orderIdParamsSchema,
  orderListQuerySchema,
} from '@zalo-shop/contracts';

import type { AdminHeaders } from '../admin/admin.service';
import { OrdersService } from '../orders/orders.service';

const parse = <T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException('Input is invalid');
  return result.data;
};
const headers = (
  authorization: string | undefined,
  storeCode: string | undefined,
  reason: string | undefined,
): AdminHeaders => {
  if (!authorization?.startsWith('Bearer ') || !storeCode)
    throw new UnauthorizedException('Admin authentication is required');
  return { accessReason: reason, accessToken: authorization.slice(7), storeCode };
};

@Controller('v1/admin/orders')
export class OrdersAdminController {
  public constructor(@Inject(OrdersService) private readonly orders: OrdersService) {}

  @Get()
  public list(
    @Query('store_id') storeId: string,
    @Query() query: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') reason: string | undefined,
  ) {
    return this.orders.adminList({
      headers: headers(authorization, storeCode, reason),
      query: parse(orderListQuerySchema, query),
      storeId,
    });
  }

  @Get(':orderId')
  public detail(
    @Query('store_id') storeId: string,
    @Param() params: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') reason: string | undefined,
  ) {
    return this.orders.adminDetail({
      headers: headers(authorization, storeCode, reason),
      orderId: parse(orderIdParamsSchema, params).orderId,
      storeId,
    });
  }

  @Post(':orderId/confirm-cod')
  public confirm(
    @Query('store_id') storeId: string,
    @Param() params: unknown,
    @Body() body: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') reason: string | undefined,
  ) {
    return this.orders.adminConfirmCod({
      headers: headers(authorization, storeCode, reason),
      orderId: parse(orderIdParamsSchema, params).orderId,
      reason: parse(adminOrderActionSchema, body).reason,
      storeId,
    });
  }

  @Post(':orderId/cancel')
  public cancel(
    @Query('store_id') storeId: string,
    @Param() params: unknown,
    @Body() body: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') reason: string | undefined,
  ) {
    return this.orders.adminCancel({
      headers: headers(authorization, storeCode, reason),
      orderId: parse(orderIdParamsSchema, params).orderId,
      reason: parse(adminOrderActionSchema, body).reason ?? 'Cancelled by operator',
      storeId,
    });
  }

  @Post(':orderId/close')
  public close(
    @Query('store_id') storeId: string,
    @Param() params: unknown,
    @Body() body: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') reason: string | undefined,
  ) {
    return this.orders.adminClose({
      headers: headers(authorization, storeCode, reason),
      orderId: parse(orderIdParamsSchema, params).orderId,
      reason: parse(adminOrderActionSchema, body).reason ?? 'Closed by operator',
      storeId,
    });
  }

  @Patch(':orderId/notes')
  public note(
    @Query('store_id') storeId: string,
    @Param() params: unknown,
    @Body() body: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') reason: string | undefined,
  ) {
    const input = parse(adminOrderNoteSchema, body);
    return this.orders.adminUpdateNote({
      headers: headers(authorization, storeCode, reason),
      note: input.note,
      orderId: parse(orderIdParamsSchema, params).orderId,
      storeId,
      ...(input.tags ? { tags: input.tags } : {}),
    });
  }
}
