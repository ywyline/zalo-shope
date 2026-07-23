import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { orderCancelSchema, orderIdParamsSchema, orderListQuerySchema } from '@zalo-shop/contracts';

import { OrdersService } from './orders.service';

const parse = <T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException('Input is invalid');
  return result.data;
};
const store = (value: string | undefined): string => {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 64)
    throw new BadRequestException('Store context is required');
  return normalized;
};

@Controller('v1/orders')
export class OrdersController {
  public constructor(@Inject(OrdersService) private readonly orders: OrdersService) {}

  @Get()
  public list(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Query() query: unknown,
  ) {
    return this.orders.memberList({
      authorization,
      query: parse(orderListQuerySchema, query),
      storeCode: store(storeCode),
    });
  }

  @Get(':orderId')
  public detail(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Param() params: unknown,
  ) {
    return this.orders.memberDetail({
      authorization,
      orderId: parse(orderIdParamsSchema, params).orderId,
      storeCode: store(storeCode),
    });
  }

  @Post(':orderId/cancel')
  public cancel(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    return this.orders.memberCancel({
      authorization,
      orderId: parse(orderIdParamsSchema, params).orderId,
      reason: parse(orderCancelSchema, body).reason,
      storeCode: store(storeCode),
    });
  }
}
