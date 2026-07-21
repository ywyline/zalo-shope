import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  Inject,
  Ip,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import { memberCouponCodeParamsSchema, memberCouponListQuerySchema } from '@zalo-shop/contracts';

import { MemberCouponService } from './member-coupon.service';

function storeCode(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 64) {
    throw new BadRequestException('Store context is required');
  }
  return normalized;
}

@Controller('v1/members/me/coupons')
export class MemberCouponController {
  public constructor(@Inject(MemberCouponService) private readonly coupons: MemberCouponService) {}

  @Get()
  public list(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Query() query: unknown,
  ) {
    const parsed = memberCouponListQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('Input is invalid');
    return this.coupons.list({
      authorization,
      query: parsed.data,
      storeCode: storeCode(headerStoreCode),
    });
  }

  @Put('by-code/:couponCode')
  public claim(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Param() params: unknown,
    @Ip() address: string,
  ) {
    const parsed = memberCouponCodeParamsSchema.safeParse(params);
    if (!parsed.success) throw new BadRequestException('Input is invalid');
    return this.coupons.claim({
      authorization,
      address,
      couponCode: parsed.data.couponCode,
      storeCode: storeCode(headerStoreCode),
    });
  }
}
