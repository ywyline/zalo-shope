import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Put,
  Query,
} from '@nestjs/common';
import {
  cartItemIdParamsSchema,
  cartLocaleQuerySchema,
  cartSkuCodeParamsSchema,
  deleteCartItemQuerySchema,
  setCartItemSchema,
  updateCartItemSchema,
} from '@zalo-shop/contracts';

import { CartService } from './cart.service';

function storeCode(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 64) {
    throw new BadRequestException('Store context is required');
  }
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

@Controller('v1/cart')
export class CartController {
  public constructor(@Inject(CartService) private readonly cart: CartService) {}

  @Get()
  public get(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Query() query: unknown,
  ) {
    return this.cart.get({
      authorization,
      locale: parse(cartLocaleQuerySchema, query).locale,
      storeCode: storeCode(headerStoreCode),
    });
  }

  @Put('items/by-sku/:skuCode')
  public setItem(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Param() params: unknown,
    @Body() body: unknown,
    @Query() query: unknown,
  ) {
    const parsedParams = parse(cartSkuCodeParamsSchema, params);
    return this.cart.setItem({
      authorization,
      locale: parse(cartLocaleQuerySchema, query).locale,
      request: parse(setCartItemSchema, body),
      skuCode: parsedParams.skuCode,
      storeCode: storeCode(headerStoreCode),
    });
  }

  @Patch('items/:itemId')
  public updateItem(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Param() params: unknown,
    @Body() body: unknown,
    @Query() query: unknown,
  ) {
    const parsedParams = parse(cartItemIdParamsSchema, params);
    return this.cart.updateItem({
      authorization,
      itemId: parsedParams.itemId,
      locale: parse(cartLocaleQuerySchema, query).locale,
      request: parse(updateCartItemSchema, body),
      storeCode: storeCode(headerStoreCode),
    });
  }

  @Delete('items/:itemId')
  @HttpCode(HttpStatus.NO_CONTENT)
  public async deleteItem(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Param() params: unknown,
    @Query() query: unknown,
  ): Promise<void> {
    const parsedParams = parse(cartItemIdParamsSchema, params);
    const parsedQuery = parse(deleteCartItemQuerySchema, query);
    await this.cart.deleteItem({
      authorization,
      expectedVersion: parsedQuery.expected_version,
      itemId: parsedParams.itemId,
      locale: parsedQuery.locale,
      storeCode: storeCode(headerStoreCode),
    });
  }
}
