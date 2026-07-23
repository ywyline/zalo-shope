import { MAX_CART_LINE_QUANTITY } from '@zalo-shop/domain';
import { z } from 'zod';

import { catalogCodeSchema, publicCatalogLocaleQuerySchema } from './catalog';
const uuidSchema = z.string().uuid();

export const checkoutItemSchema = z
  .object({
    sku_code: catalogCodeSchema,
    quantity: z.number().int().min(1).max(MAX_CART_LINE_QUANTITY),
  })
  .strict();

export const checkoutQuoteRequestSchema = publicCatalogLocaleQuerySchema
  .extend({
    address_id: uuidSchema,
    items: z.array(checkoutItemSchema).min(1).max(100),
    coupon_code: catalogCodeSchema.nullable().default(null),
    payment_method: z.enum(['COD', 'ONLINE']).default('COD'),
  })
  .strict()
  .superRefine((value, context) => {
    const codes = value.items.map((item) => item.sku_code);
    if (new Set(codes).size !== codes.length) {
      context.addIssue({ code: 'custom', message: 'SKU lines must be unique', path: ['items'] });
    }
  });

export const checkoutOrderRequestSchema = checkoutQuoteRequestSchema
  .extend({
    quote_hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type CheckoutQuoteRequest = z.infer<typeof checkoutQuoteRequestSchema>;
export type CheckoutOrderRequest = z.infer<typeof checkoutOrderRequestSchema>;
