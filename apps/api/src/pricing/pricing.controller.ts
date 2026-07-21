import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Ip,
  Post,
} from '@nestjs/common';
import { pricingQuoteRequestSchema } from '@zalo-shop/contracts';

import { PricingService } from './pricing.service';

function storeCode(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 64) {
    throw new BadRequestException('Store context is required');
  }
  return normalized;
}

@Controller('v1/pricing')
export class PricingController {
  public constructor(@Inject(PricingService) private readonly pricing: PricingService) {}

  @Post('quotes')
  @HttpCode(HttpStatus.OK)
  public quote(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Ip() address: string,
    @Body() body: unknown,
  ) {
    const request = pricingQuoteRequestSchema.safeParse(body);
    if (!request.success) throw new BadRequestException('Input is invalid');
    return this.pricing.quote({
      authorization,
      ...(accessReason === undefined ? {} : { accessReason }),
      address,
      request: request.data,
      storeCode: storeCode(headerStoreCode),
    });
  }
}
