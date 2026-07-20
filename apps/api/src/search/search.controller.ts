import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Ip,
  Query,
} from '@nestjs/common';
import {
  productSearchQuerySchema,
  searchFacetQuerySchema,
  searchHistoryQuerySchema,
  searchSuggestionQuerySchema,
} from '@zalo-shop/contracts';
import type { z } from 'zod';

import { SearchService } from './search.service';

function storeCode(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 64)
    throw new BadRequestException('Store context is required');
  return normalized;
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException('Input is invalid');
  return result.data;
}

function repeatedQuery(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const query = { ...(value as Record<string, unknown>) };
  for (const key of ['attribute_filters', 'brand_codes', 'category_codes']) {
    const current = query[key];
    if (typeof current === 'string') query[key] = [current];
  }
  return query;
}

@Controller('v1/search')
export class SearchController {
  public constructor(@Inject(SearchService) private readonly search: SearchService) {}

  @Get('products')
  public products(
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Ip() address: string,
    @Query() query: unknown,
  ) {
    return this.search.products({
      address,
      ...(authorization ? { authorization } : {}),
      query: parse(productSearchQuerySchema, repeatedQuery(query)),
      storeCode: storeCode(headerStoreCode),
    });
  }

  @Get('suggestions')
  public suggestions(
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Ip() address: string,
    @Query() query: unknown,
  ) {
    return this.search.suggestions({
      address,
      query: parse(searchSuggestionQuerySchema, query),
      storeCode: storeCode(headerStoreCode),
    });
  }

  @Get('facets')
  public facets(
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Ip() address: string,
    @Query() query: unknown,
  ) {
    return this.search.facets({
      address,
      query: parse(searchFacetQuerySchema, query),
      storeCode: storeCode(headerStoreCode),
    });
  }
}

@Controller('v1/members/me/search-history')
export class SearchHistoryController {
  public constructor(@Inject(SearchService) private readonly search: SearchService) {}

  @Get()
  public history(
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Query() query: unknown,
  ) {
    return this.search.history({
      authorization,
      limit: parse(searchHistoryQuerySchema, query).limit,
      storeCode: storeCode(headerStoreCode),
    });
  }

  @Delete()
  @HttpCode(204)
  public async clear(
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Headers('authorization') authorization: string | undefined,
  ): Promise<void> {
    await this.search.clearHistory({ authorization, storeCode: storeCode(headerStoreCode) });
  }
}
