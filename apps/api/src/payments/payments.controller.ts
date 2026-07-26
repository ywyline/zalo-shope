import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
} from '@nestjs/common';
import {
  orderIdParamsSchema,
  paymentAttemptCreateRequestSchema,
  paymentIdParamsSchema,
} from '@zalo-shop/contracts';

import { PaymentsService } from './payments.service';

function parse<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException('Input is invalid');
  return result.data;
}

function storeCode(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 64) {
    throw new BadRequestException('Store context is required');
  }
  return normalized;
}

function idempotencyKey(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized || !/^[!-~]{16,128}$/u.test(normalized)) {
    throw new BadRequestException('Idempotency-Key is required');
  }
  return normalized;
}

@Controller('v1')
export class PaymentsController {
  public constructor(@Inject(PaymentsService) private readonly payments: PaymentsService) {}

  @Get('payments/:paymentId')
  public detail(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Param() params: unknown,
  ) {
    return this.payments.detail({
      authorization,
      paymentId: parse(paymentIdParamsSchema, params).paymentId,
      storeCode: storeCode(headerStoreCode),
    });
  }

  @Get('payments/:paymentId/launch')
  public launch(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Param() params: unknown,
  ) {
    return this.payments.launch({
      authorization,
      paymentId: parse(paymentIdParamsSchema, params).paymentId,
      storeCode: storeCode(headerStoreCode),
    });
  }

  @Post('payments/:paymentId/query')
  public query(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Param() params: unknown,
  ) {
    return this.payments.query({
      authorization,
      paymentId: parse(paymentIdParamsSchema, params).paymentId,
      storeCode: storeCode(headerStoreCode),
    });
  }

  @Post('orders/:orderId/payments')
  public retry(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Headers('idempotency-key') headerIdempotencyKey: string | undefined,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    parse(paymentAttemptCreateRequestSchema, body);
    return this.payments.retry({
      authorization,
      idempotencyKey: idempotencyKey(headerIdempotencyKey),
      orderId: parse(orderIdParamsSchema, params).orderId,
      storeCode: storeCode(headerStoreCode),
    });
  }
}
