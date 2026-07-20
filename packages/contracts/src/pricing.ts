import { z } from 'zod';

import { catalogCodeSchema } from './catalog';

const vndAmountSchema = z.number().int().safe().nonnegative();
const pricingBucketSchema = z.enum(['ITEM', 'ORDER', 'COUPON', 'SHIPPING']);

const quoteItemSchema = z
  .object({
    quantity: z.number().int().min(1).max(99),
    sku_code: catalogCodeSchema,
  })
  .strict();

export const pricingQuoteRequestSchema = z
  .object({
    coupon_code: catalogCodeSchema.nullable().default(null),
    items: z.array(quoteItemSchema).min(1).max(100),
    locale: z.enum(['vi', 'zh', 'en']).default('vi'),
  })
  .strict()
  .superRefine((value, context) => {
    const skuCodes = new Set<string>();
    value.items.forEach((item, index) => {
      if (skuCodes.has(item.sku_code)) {
        context.addIssue({
          code: 'custom',
          message: 'Duplicate SKU; combine quantities into one item',
          path: ['items', index, 'sku_code'],
        });
      }
      skuCodes.add(item.sku_code);
    });
  });

const promotionTargetSchema = z.discriminatedUnion('target_type', [
  z.object({ target_id: z.string().uuid(), target_type: z.literal('PRODUCT') }).strict(),
  z.object({ target_id: z.string().uuid(), target_type: z.literal('SKU') }).strict(),
  z.object({ target_id: z.string().uuid(), target_type: z.literal('BRAND') }).strict(),
  z.object({ target_id: z.string().uuid(), target_type: z.literal('CATEGORY') }).strict(),
  z.object({ target_id: z.null(), target_type: z.literal('STORE') }).strict(),
]);

export const promotionVersionInputSchema = z
  .object({
    benefit: z.discriminatedUnion('method', [
      z
        .object({
          maximum_discount_vnd: vndAmountSchema.positive().nullable().default(null),
          method: z.literal('PERCENTAGE_BPS'),
          value: z.number().int().min(1).max(10_000),
        })
        .strict(),
      z
        .object({
          method: z.literal('FIXED_VND'),
          value: vndAmountSchema.positive(),
        })
        .strict(),
      z.object({ method: z.literal('FREE_SHIPPING_QUALIFICATION') }).strict(),
    ]),
    bucket: pricingBucketSchema,
    ends_at: z.coerce.date().nullable().default(null),
    expected_promotion_version: z.number().int().positive(),
    localizations: z
      .array(
        z
          .object({
            description: z.string().trim().min(1).max(2_000).nullable().default(null),
            locale: z.enum(['vi', 'zh', 'en']),
            name: z.string().trim().min(1).max(240),
          })
          .strict(),
      )
      .min(1)
      .max(3),
    minimum_quantity: z.number().int().min(1).max(99).nullable().default(null),
    minimum_spend_vnd: vndAmountSchema.nullable().default(null),
    priority: z.number().int().nonnegative().max(1_000_000),
    stackable_with: z.array(pricingBucketSchema).max(3).default([]),
    starts_at: z.coerce.date(),
    targets: z.array(promotionTargetSchema).min(1).max(500),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.ends_at !== null && value.ends_at <= value.starts_at) {
      context.addIssue({ code: 'custom', message: 'End time must be after start time' });
    }
    if (value.stackable_with.includes(value.bucket)) {
      context.addIssue({ code: 'custom', message: 'A rule cannot stack with its own bucket' });
    }
    if (new Set(value.stackable_with).size !== value.stackable_with.length) {
      context.addIssue({ code: 'custom', message: 'Stacking buckets must be unique' });
    }
    if (value.bucket === 'SHIPPING' && value.benefit.method !== 'FREE_SHIPPING_QUALIFICATION') {
      context.addIssue({
        code: 'custom',
        message: 'Shipping rules only express qualification in M3',
      });
    }
    if (value.bucket !== 'SHIPPING' && value.benefit.method === 'FREE_SHIPPING_QUALIFICATION') {
      context.addIssue({
        code: 'custom',
        message: 'Free shipping qualification requires SHIPPING',
      });
    }
    const locales = value.localizations.map(({ locale }) => locale);
    if (!locales.includes('vi') || new Set(locales).size !== locales.length) {
      context.addIssue({ code: 'custom', message: 'Unique Vietnamese localization is required' });
    }
    const targetKeys = value.targets.map(
      ({ target_id, target_type }) => `${target_type}:${target_id}`,
    );
    if (new Set(targetKeys).size !== targetKeys.length) {
      context.addIssue({ code: 'custom', message: 'Promotion targets must be unique' });
    }
  });

export const publishPromotionSchema = z
  .object({
    confirmation_code: z.literal('PUBLISH'),
    expected_promotion_version: z.number().int().positive(),
    version_id: z.string().uuid(),
  })
  .strict();

export const promotionStateCommandSchema = z.discriminatedUnion('confirmation_code', [
  z
    .object({
      confirmation_code: z.literal('PAUSE'),
      expected_promotion_version: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      confirmation_code: z.literal('END'),
      expected_promotion_version: z.number().int().positive(),
    })
    .strict(),
]);

export const couponInputSchema = z
  .object({
    code: catalogCodeSchema,
    promotion_version_id: z.string().uuid(),
    total_claim_limit: z.number().int().positive().nullable().default(null),
    per_member_claim_limit: z.literal(1).default(1),
  })
  .strict();

export const couponDraftUpdateSchema = z
  .object({
    expected_version: z.number().int().positive(),
    per_member_claim_limit: z.literal(1).optional(),
    promotion_version_id: z.string().uuid().optional(),
    total_claim_limit: z.number().int().positive().nullable().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.per_member_claim_limit !== undefined ||
      value.promotion_version_id !== undefined ||
      value.total_claim_limit !== undefined,
    'At least one coupon draft field must change',
  );

export const couponStatusCommandSchema = z.discriminatedUnion('status', [
  z
    .object({
      confirmation_code: z.literal('ACTIVATE'),
      expected_version: z.number().int().positive(),
      status: z.literal('ACTIVE'),
    })
    .strict(),
  z
    .object({
      confirmation_code: z.literal('PAUSE'),
      expected_version: z.number().int().positive(),
      status: z.literal('PAUSED'),
    })
    .strict(),
  z
    .object({
      confirmation_code: z.literal('END'),
      expected_version: z.number().int().positive(),
      status: z.literal('ENDED'),
    })
    .strict(),
]);

export const memberCouponListQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).max(1_000).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    status: z.enum(['CLAIMED', 'EXPIRED', 'DISABLED']).optional(),
  })
  .strict();

export const memberCouponCodeParamsSchema = z.object({ couponCode: catalogCodeSchema }).strict();

export type PricingQuoteRequest = z.infer<typeof pricingQuoteRequestSchema>;
export type PromotionVersionInput = z.infer<typeof promotionVersionInputSchema>;
