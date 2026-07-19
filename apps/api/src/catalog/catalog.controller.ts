import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Query,
} from '@nestjs/common';
import {
  catalogCodeSchema,
  publicBrandListQuerySchema,
  publicCatalogLocaleQuerySchema,
  publicProductListQuerySchema,
} from '@zalo-shop/contracts';
import type { z } from 'zod';

import { CatalogService } from './catalog.service';

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
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

@Controller('v1/catalog')
export class CatalogController {
  public constructor(@Inject(CatalogService) private readonly catalog: CatalogService) {}

  @Get('home')
  public home(
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Query() query: unknown,
  ): Promise<unknown> {
    return this.catalog.home(
      storeCode(headerStoreCode),
      parse(publicCatalogLocaleQuerySchema, query).locale,
    );
  }

  @Get('brands')
  public brands(
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Query() query: unknown,
  ): Promise<unknown> {
    return this.catalog.listBrands(
      storeCode(headerStoreCode),
      parse(publicBrandListQuerySchema, query),
    );
  }

  @Get('brands/:brandCode')
  public brand(
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Param('brandCode') brandCode: string,
    @Query() query: unknown,
  ): Promise<unknown> {
    return this.catalog.getBrand(
      storeCode(headerStoreCode),
      parse(catalogCodeSchema, brandCode),
      parse(publicCatalogLocaleQuerySchema, query).locale,
    );
  }

  @Get('categories')
  public categories(
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Query() query: unknown,
  ): Promise<unknown> {
    return this.catalog.categories(
      storeCode(headerStoreCode),
      parse(publicCatalogLocaleQuerySchema, query).locale,
    );
  }

  @Get('products')
  public products(
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Query() query: unknown,
  ): Promise<unknown> {
    return this.catalog.listProducts(
      storeCode(headerStoreCode),
      parse(publicProductListQuerySchema, query),
    );
  }

  @Get('products/:productCode')
  public product(
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Param('productCode') productCode: string,
    @Query() query: unknown,
  ): Promise<unknown> {
    return this.catalog.getProduct(
      storeCode(headerStoreCode),
      parse(catalogCodeSchema, productCode),
      parse(publicCatalogLocaleQuerySchema, query).locale,
    );
  }
}
