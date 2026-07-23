import { BadRequestException, Body, Controller, Headers, Inject, Post } from '@nestjs/common';
import { checkoutOrderRequestSchema, checkoutQuoteRequestSchema } from '@zalo-shop/contracts';

import { CheckoutService } from './checkout.service';

function storeCode(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 64)
    throw new BadRequestException('Store context is required');
  return normalized;
}

function parse<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException('Input is invalid');
  return result.data;
}

function idempotencyKey(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized || !/^[!-~]{16,128}$/.test(normalized))
    throw new BadRequestException('Idempotency-Key is required');
  return normalized;
}

@Controller('v1/checkout')
export class CheckoutController {
  public constructor(@Inject(CheckoutService) private readonly checkout: CheckoutService) {}

  @Post('quote')
  public quote(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Body() body: unknown,
  ) {
    return this.checkout.quote({
      authorization,
      request: parse(checkoutQuoteRequestSchema, body),
      storeCode: storeCode(headerStoreCode),
    });
  }

  @Post('orders')
  public createOrder(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Headers('idempotency-key') headerIdempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.checkout.createOrder({
      authorization,
      idempotencyKey: idempotencyKey(headerIdempotencyKey),
      request: parse(checkoutOrderRequestSchema, body),
      storeCode: storeCode(headerStoreCode),
    });
  }
}
