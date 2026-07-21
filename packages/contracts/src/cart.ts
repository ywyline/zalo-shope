import { MAX_CART_LINE_QUANTITY } from '@zalo-shop/domain';
import { z } from 'zod';

import { catalogCodeSchema, publicCatalogLocaleQuerySchema } from './catalog';

export const cartLocaleQuerySchema = publicCatalogLocaleQuerySchema;

export const setCartItemSchema = z
  .object({
    quantity: z.number().int().min(1).max(MAX_CART_LINE_QUANTITY),
    selected: z.boolean().default(true),
  })
  .strict();

export const updateCartItemSchema = z
  .object({
    expected_version: z.number().int().positive(),
    quantity: z.number().int().min(1).max(MAX_CART_LINE_QUANTITY).optional(),
    replacement_sku_code: catalogCodeSchema.optional(),
    selected: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.quantity !== undefined ||
      value.replacement_sku_code !== undefined ||
      value.selected !== undefined,
    'At least one cart item field must change',
  );

export const deleteCartItemQuerySchema = publicCatalogLocaleQuerySchema
  .extend({
    expected_version: z.coerce.number().int().positive(),
  })
  .strict();

export const cartItemIdParamsSchema = z.object({ itemId: z.string().uuid() }).strict();
export const cartSkuCodeParamsSchema = z.object({ skuCode: catalogCodeSchema }).strict();

const cartIssueSchema = z
  .object({
    blocking: z.boolean(),
    code: z.enum([
      'OUT_OF_STOCK',
      'PRICE_CHANGED',
      'PRODUCT_UNAVAILABLE',
      'PROMOTION_CHANGED',
      'SKU_UNAVAILABLE',
      'STOCK_INSUFFICIENT',
    ]),
  })
  .strict();

const cartDisplaySkuSchema = z
  .object({
    code: catalogCodeSchema,
    option_values: z
      .array(
        z
          .object({
            option_label: z.string().max(160),
          })
          .passthrough(),
      )
      .max(20),
  })
  .passthrough();

const cartMediaSchema = z
  .object({
    alt_text: z.string().max(500),
    expires_at: z.string().datetime({ offset: true }),
    height: z.number().int().positive().nullable(),
    url: z.string().url(),
    width: z.number().int().positive().nullable(),
  })
  .strict();

const cartDisplayProductSchema = z
  .object({
    available_skus: z.array(cartDisplaySkuSchema).max(100).optional(),
    code: catalogCodeSchema,
    name: z.string().min(1).max(240),
    primary_media: cartMediaSchema.nullable(),
    requested_locale: z.enum(['en', 'vi', 'zh']),
    resolved_locale: z.enum(['en', 'vi', 'zh']),
  })
  .passthrough();

export const cartItemSchema = z
  .object({
    added_unit_price_vnd: z.number().int().safe().nonnegative(),
    available_quantity: z.number().int().nonnegative(),
    current_subtotal_vnd: z.number().int().safe().nonnegative(),
    current_unit_price_vnd: z.number().int().safe().nonnegative(),
    id: z.string().uuid(),
    issues: z.array(cartIssueSchema).max(10),
    product: cartDisplayProductSchema.optional(),
    quantity: z.number().int().min(1).max(MAX_CART_LINE_QUANTITY),
    selected: z.boolean(),
    sku_code: catalogCodeSchema,
    sku: z
      .object({
        code: catalogCodeSchema,
        media: cartMediaSchema.nullable(),
        option_values: z.array(z.unknown()).max(20),
      })
      .passthrough()
      .optional(),
    version: z.number().int().positive(),
  })
  .strict();

export const cartSchema = z
  .object({
    blocking: z.boolean(),
    id: z.string().uuid(),
    items: z.array(cartItemSchema).max(100),
    quote: z
      .object({
        applied_rules: z.array(z.unknown()),
        base_subtotal_vnd: z.number().int().safe().nonnegative(),
        currency: z.literal('VND'),
        discount_vnd: z.number().int().safe().nonnegative(),
        lines: z.array(z.unknown()).min(1).max(100),
        merchandise_payable_vnd: z.number().int().safe().nonnegative(),
        order_payable_vnd: z.null(),
        quote_hash: z.string().regex(/^[a-f0-9]{64}$/),
        quoted_at: z.string().datetime({ offset: true }),
        rejected_rules: z.array(z.unknown()),
        shipping_qualification: z.unknown(),
      })
      .passthrough()
      .nullable(),
    version: z.number().int().positive(),
  })
  .strict();

export type SetCartItemInput = z.infer<typeof setCartItemSchema>;
export type UpdateCartItemInput = z.infer<typeof updateCartItemSchema>;
export type Cart = z.infer<typeof cartSchema>;
export type CartItem = z.infer<typeof cartItemSchema>;
