import { MAX_SEARCH_QUERY_LENGTH } from '@zalo-shop/domain';
import { z } from 'zod';

import { catalogCodeSchema } from './catalog';

const searchCodeListSchema = z
  .array(catalogCodeSchema)
  .max(20)
  .default([])
  .superRefine((values, ctx) => {
    if (new Set(values).size !== values.length) {
      ctx.addIssue({ code: 'custom', message: 'Search filter values must be unique' });
    }
  });

const optionalVndQuerySchema = z.coerce.number().int().safe().nonnegative().optional();

const attributeFilterListSchema = z
  .array(
    z
      .string()
      .trim()
      .min(3)
      .max(130)
      .regex(/^[a-z][a-z0-9-]*:[a-z0-9-]+$/),
  )
  .max(20)
  .default([])
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', message: 'Attribute filters must be unique' });
    }
  });

export const productSearchQuerySchema = z
  .object({
    attribute_filters: attributeFilterListSchema,
    brand_codes: searchCodeListSchema,
    category_codes: searchCodeListSchema,
    cursor: z.string().trim().min(1).max(1_000).optional(),
    in_stock: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    locale: z.enum(['vi', 'zh', 'en']).default('vi'),
    max_price_vnd: optionalVndQuerySchema,
    min_price_vnd: optionalVndQuerySchema,
    on_promotion: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
    q: z.string().trim().min(1).max(MAX_SEARCH_QUERY_LENGTH).optional(),
    sort: z.enum(['relevance', 'newest', 'price_asc', 'price_desc']).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.min_price_vnd === undefined ||
      value.max_price_vnd === undefined ||
      value.min_price_vnd <= value.max_price_vnd,
    { message: 'Minimum price must not exceed maximum price', path: ['max_price_vnd'] },
  );

export const searchSuggestionQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(20).default(10),
    locale: z.enum(['vi', 'zh', 'en']).default('vi'),
    q: z.string().trim().min(1).max(MAX_SEARCH_QUERY_LENGTH),
  })
  .strict();

export const searchFacetQuerySchema = z
  .object({
    locale: z.enum(['vi', 'zh', 'en']).default('vi'),
  })
  .strict();

export const searchHistoryQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

export type ProductSearchQuery = z.infer<typeof productSearchQuerySchema>;
export type SearchFacetQuery = z.infer<typeof searchFacetQuerySchema>;
export type SearchSuggestionQuery = z.infer<typeof searchSuggestionQuerySchema>;
