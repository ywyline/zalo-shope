import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Ip,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  memberFavoriteListQuerySchema,
  memberProductCodeParamsSchema,
  memberProductHistoryListQuerySchema,
  memberProductHistoryUpsertSchema,
  privacyRequestCancelSchema,
  privacyRequestCreateSchema,
  privacyRequestListQuerySchema,
  privacyRequestNumberParamsSchema,
} from '@zalo-shop/contracts';
import type { z } from 'zod';

import { MemberRuntimeService } from './member-runtime.service';

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
  return parsed.data;
}

function storeCode(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 64)
    throw new BadRequestException('Store-Code is required');
  return normalized;
}

function idempotencyKey(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length < 16 || normalized.length > 128) {
    throw new BadRequestException('Idempotency-Key is required');
  }
  return normalized;
}

@Controller('v1/members/me')
export class MemberRuntimeController {
  public constructor(@Inject(MemberRuntimeService) private readonly member: MemberRuntimeService) {}

  @Get('favorites')
  @Header('Cache-Control', 'private, no-store')
  public listFavorites(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Ip() address: string,
    @Query() query: unknown,
  ) {
    const input = parse(memberFavoriteListQuerySchema, query);
    return this.member.listFavorites({
      address,
      authorization,
      cursor: input.cursor,
      limit: input.limit,
      locale: input.locale,
      storeCode: storeCode(headerStoreCode),
    });
  }

  @Put('favorites/:productCode')
  @HttpCode(204)
  public async putFavorite(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Ip() address: string,
    @Param() params: unknown,
  ): Promise<void> {
    const route = parse(memberProductCodeParamsSchema, params);
    await this.member.putFavorite({
      address,
      authorization,
      productCode: route.productCode,
      storeCode: storeCode(headerStoreCode),
    });
  }

  @Get('favorites/:productCode')
  @Header('Cache-Control', 'private, no-store')
  public favoriteStatus(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Ip() address: string,
    @Param() params: unknown,
  ) {
    const route = parse(memberProductCodeParamsSchema, params);
    return this.member.favoriteStatus({
      address,
      authorization,
      productCode: route.productCode,
      storeCode: storeCode(headerStoreCode),
    });
  }

  @Delete('favorites/:productCode')
  @HttpCode(204)
  public async deleteFavorite(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Ip() address: string,
    @Param() params: unknown,
  ): Promise<void> {
    const route = parse(memberProductCodeParamsSchema, params);
    await this.member.deleteFavorite({
      address,
      authorization,
      productCode: route.productCode,
      storeCode: storeCode(headerStoreCode),
    });
  }

  @Get('product-history')
  @Header('Cache-Control', 'private, no-store')
  public listProductHistory(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Ip() address: string,
    @Query() query: unknown,
  ) {
    const input = parse(memberProductHistoryListQuerySchema, query);
    return this.member.listProductHistory({
      address,
      authorization,
      cursor: input.cursor,
      limit: input.limit,
      locale: input.locale,
      storeCode: storeCode(headerStoreCode),
    });
  }

  @Delete('product-history')
  @HttpCode(204)
  public async clearProductHistory(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Headers('idempotency-key') headerIdempotencyKey: string | undefined,
    @Ip() address: string,
  ): Promise<void> {
    await this.member.clearProductHistory({
      address,
      authorization,
      idempotencyKey: idempotencyKey(headerIdempotencyKey),
      storeCode: storeCode(headerStoreCode),
    });
  }

  @Put('product-history/:productCode')
  @HttpCode(204)
  public async touchProductHistory(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Ip() address: string,
    @Param() params: unknown,
    @Body() body: unknown,
  ): Promise<void> {
    const route = parse(memberProductCodeParamsSchema, params);
    parse(memberProductHistoryUpsertSchema, body);
    await this.member.touchProductHistory({
      address,
      authorization,
      productCode: route.productCode,
      storeCode: storeCode(headerStoreCode),
    });
  }

  @Delete('product-history/:productCode')
  @HttpCode(204)
  public async deleteProductHistoryItem(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Ip() address: string,
    @Param() params: unknown,
  ): Promise<void> {
    const route = parse(memberProductCodeParamsSchema, params);
    await this.member.deleteProductHistoryItem({
      address,
      authorization,
      productCode: route.productCode,
      storeCode: storeCode(headerStoreCode),
    });
  }

  @Get('commerce-summary')
  @Header('Cache-Control', 'private, no-store')
  public summary(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Ip() address: string,
  ) {
    return this.member.summary({
      address,
      authorization,
      storeCode: storeCode(headerStoreCode),
    });
  }

  @Get('consents')
  @Header('Cache-Control', 'private, no-store')
  public currentConsents(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Ip() address: string,
  ) {
    return this.member.currentConsents({
      address,
      authorization,
      storeCode: storeCode(headerStoreCode),
    });
  }

  @Get('privacy-requests')
  @Header('Cache-Control', 'private, no-store')
  public listPrivacyRequests(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Ip() address: string,
    @Query() query: unknown,
  ) {
    const input = parse(privacyRequestListQuerySchema, query);
    return this.member.listPrivacyRequests({
      address,
      authorization,
      cursor: input.cursor,
      limit: input.limit,
      storeCode: storeCode(headerStoreCode),
    });
  }

  @Post('privacy-requests')
  @Header('Cache-Control', 'private, no-store')
  public createPrivacyRequest(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Headers('idempotency-key') headerIdempotencyKey: string | undefined,
    @Ip() address: string,
    @Body() body: unknown,
  ) {
    const request = parse(privacyRequestCreateSchema, body);
    return this.member.createPrivacyRequest({
      address,
      authorization,
      description: request.description,
      idempotencyKey: idempotencyKey(headerIdempotencyKey),
      requestType: request.request_type,
      storeCode: storeCode(headerStoreCode),
    });
  }

  @Get('privacy-requests/:requestNumber')
  @Header('Cache-Control', 'private, no-store')
  public getPrivacyRequest(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Ip() address: string,
    @Param() params: unknown,
  ) {
    const route = parse(privacyRequestNumberParamsSchema, params);
    return this.member.getPrivacyRequest({
      address,
      authorization,
      requestNumber: route.requestNumber,
      storeCode: storeCode(headerStoreCode),
    });
  }

  @Post('privacy-requests/:requestNumber/cancel')
  @Header('Cache-Control', 'private, no-store')
  @HttpCode(200)
  public cancelPrivacyRequest(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Headers('idempotency-key') headerIdempotencyKey: string | undefined,
    @Ip() address: string,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const route = parse(privacyRequestNumberParamsSchema, params);
    const request = parse(privacyRequestCancelSchema, body);
    return this.member.cancelPrivacyRequest({
      address,
      authorization,
      expectedVersion: request.expected_version,
      idempotencyKey: idempotencyKey(headerIdempotencyKey),
      reason: request.reason,
      requestNumber: route.requestNumber,
      storeCode: storeCode(headerStoreCode),
    });
  }
}
