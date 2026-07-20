import { MAX_CART_LINE_QUANTITY } from '@zalo-shop/domain';
import { z } from 'zod';

import { catalogCodeSchema } from './catalog';

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

export const deleteCartItemQuerySchema = z
  .object({
    expected_version: z.coerce.number().int().positive(),
  })
  .strict();

export const cartItemIdParamsSchema = z.object({ itemId: z.string().uuid() }).strict();
export const cartSkuCodeParamsSchema = z.object({ skuCode: catalogCodeSchema }).strict();

export type SetCartItemInput = z.infer<typeof setCartItemSchema>;
export type UpdateCartItemInput = z.infer<typeof updateCartItemSchema>;
