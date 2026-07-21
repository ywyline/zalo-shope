import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import {
  catalogCodeSchema,
  couponDraftUpdateSchema,
  couponInputSchema,
  couponListQuerySchema,
  couponStatusCommandSchema,
  promotionListQuerySchema,
  promotionOperationKeySchema,
  promotionStateCommandSchema,
  promotionTargetLookupQuerySchema,
  promotionVersionInputSchema,
  publishPromotionSchema,
  uuidSchema,
} from '@zalo-shop/contracts';
import { z } from 'zod';

import { PromotionsAdminService } from './promotions-admin.service';

const createPromotionSchema = z.object({ code: catalogCodeSchema }).strict();

function bearer(value: string | undefined): string {
  if (!value?.startsWith('Bearer ')) throw new UnauthorizedException('Bearer token is required');
  return value.slice(7);
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException('Input is invalid');
  return result.data;
}

function context(
  authorization: string | undefined,
  storeCode: string | undefined,
  accessReason: string | undefined,
  storeId: string | undefined,
) {
  if (!storeCode || !storeId) throw new UnauthorizedException('Store context is required');
  return {
    headers: {
      ...(accessReason === undefined ? {} : { accessReason }),
      accessToken: bearer(authorization),
      storeCode,
    },
    storeId,
  };
}

function setReplayHeader(
  response: { setHeader(name: string, value: string): void },
  value: boolean,
) {
  response.setHeader('Idempotency-Replayed', String(value));
}

@Controller('v1/admin')
export class PromotionsAdminController {
  public constructor(
    @Inject(PromotionsAdminService) private readonly promotions: PromotionsAdminService,
  ) {}

  @Get('promotions')
  public listPromotions(
    @Query('store_id') storeId: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('status') status: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
  ) {
    return this.promotions.listPromotions(
      context(authorization, storeCode, accessReason, storeId),
      parse(promotionListQuerySchema, {
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit }),
        ...(status === undefined ? {} : { status }),
      }),
    );
  }

  @Post('promotions')
  public createPromotion(
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Body() body: unknown,
  ) {
    return this.promotions.createPromotion(
      context(authorization, storeCode, accessReason, storeId),
      parse(createPromotionSchema, body).code,
    );
  }

  @Get('promotions/targets')
  public listPromotionTargets(
    @Query('target_type') targetType: string | undefined,
    @Query('q') search: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
  ) {
    return this.promotions.listTargetLookup(
      context(authorization, storeCode, accessReason, storeId),
      parse(promotionTargetLookupQuerySchema, {
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit }),
        ...(search === undefined ? {} : { q: search }),
        ...(targetType === undefined ? {} : { target_type: targetType }),
      }),
    );
  }

  @Get('promotions/:promotionId/versions')
  public listPromotionVersions(
    @Param('promotionId') promotionId: string,
    @Query('store_id') storeId: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
  ) {
    return this.promotions.listPromotionVersions(
      context(authorization, storeCode, accessReason, storeId),
      parse(uuidSchema, promotionId),
      parse(promotionListQuerySchema, {
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit }),
      }),
    );
  }

  @Post('promotions/:promotionId/versions')
  public createPromotionVersion(
    @Param('promotionId') promotionId: string,
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Body() body: unknown,
  ) {
    return this.promotions.createPromotionVersion(
      context(authorization, storeCode, accessReason, storeId),
      parse(uuidSchema, promotionId),
      parse(promotionVersionInputSchema, body),
    );
  }

  @Post('promotions/:promotionId/publish')
  @HttpCode(HttpStatus.OK)
  public async publishPromotion(
    @Param('promotionId') promotionId: string,
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') operationKey: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: { setHeader(name: string, value: string): void },
  ) {
    const execution = await this.promotions.publishPromotion(
      context(authorization, storeCode, accessReason, storeId),
      parse(uuidSchema, promotionId),
      parse(promotionOperationKeySchema, operationKey),
      parse(publishPromotionSchema, body),
    );
    setReplayHeader(response, execution.replayed);
    return execution.body;
  }

  @Post('promotions/:promotionId/pause')
  @HttpCode(HttpStatus.OK)
  public async pausePromotion(
    @Param('promotionId') promotionId: string,
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') operationKey: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: { setHeader(name: string, value: string): void },
  ) {
    const input = parse(promotionStateCommandSchema, body);
    if (input.confirmation_code !== 'PAUSE') throw new BadRequestException('Input is invalid');
    const execution = await this.promotions.pausePromotion(
      context(authorization, storeCode, accessReason, storeId),
      parse(uuidSchema, promotionId),
      parse(promotionOperationKeySchema, operationKey),
      input,
    );
    setReplayHeader(response, execution.replayed);
    return execution.body;
  }

  @Post('promotions/:promotionId/end')
  @HttpCode(HttpStatus.OK)
  public async endPromotion(
    @Param('promotionId') promotionId: string,
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') operationKey: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: { setHeader(name: string, value: string): void },
  ) {
    const input = parse(promotionStateCommandSchema, body);
    if (input.confirmation_code !== 'END') throw new BadRequestException('Input is invalid');
    const execution = await this.promotions.endPromotion(
      context(authorization, storeCode, accessReason, storeId),
      parse(uuidSchema, promotionId),
      parse(promotionOperationKeySchema, operationKey),
      input,
    );
    setReplayHeader(response, execution.replayed);
    return execution.body;
  }

  @Get('coupons')
  public listCoupons(
    @Query('store_id') storeId: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
  ) {
    return this.promotions.listCoupons(
      context(authorization, storeCode, accessReason, storeId),
      parse(couponListQuerySchema, {
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit }),
      }),
    );
  }

  @Post('coupons')
  public createCoupon(
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Body() body: unknown,
  ) {
    return this.promotions.createCoupon(
      context(authorization, storeCode, accessReason, storeId),
      parse(couponInputSchema, body),
    );
  }

  @Patch('coupons/:couponId')
  public updateCoupon(
    @Param('couponId') couponId: string,
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Body() body: unknown,
  ) {
    return this.promotions.updateCoupon(
      context(authorization, storeCode, accessReason, storeId),
      parse(uuidSchema, couponId),
      parse(couponDraftUpdateSchema, body),
    );
  }

  @Post('coupons/:couponId/status')
  @HttpCode(HttpStatus.OK)
  public async setCouponStatus(
    @Param('couponId') couponId: string,
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') operationKey: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: { setHeader(name: string, value: string): void },
  ) {
    const execution = await this.promotions.setCouponStatus(
      context(authorization, storeCode, accessReason, storeId),
      parse(uuidSchema, couponId),
      parse(promotionOperationKeySchema, operationKey),
      parse(couponStatusCommandSchema, body),
    );
    setReplayHeader(response, execution.replayed);
    return execution.body;
  }
}
