import { SHARE_TARGET_TYPES } from '@zalo-shop/domain';
import { z } from 'zod';

const publicCodeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const attributionTokenSchema = z
  .string()
  .min(20)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/);
const interactionTokenSchema = z
  .string()
  .min(20)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/);

export const shareTargetTypeSchema = z.enum(SHARE_TARGET_TYPES);
export const shareShortCodeParamsSchema = z
  .object({
    shortCode: z
      .string()
      .min(20)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();

export const shareCreateRequestSchema = z
  .object({
    attribution_token: attributionTokenSchema.optional(),
    locale: z.enum(['vi', 'zh', 'en']),
    source: z.enum([
      'STORE_HOME',
      'BRAND_PAGE',
      'CATEGORY_PAGE',
      'PRODUCT_DETAIL',
      'PROMOTION_PAGE',
      'COUPON_PAGE',
      'MEMBER_CENTER',
    ]),
    target_code: publicCodeSchema.optional(),
    target_type: shareTargetTypeSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (input.target_type === 'STORE' && input.target_code !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Store target must not include a target code',
        path: ['target_code'],
      });
    }
    if (input.target_type !== 'STORE' && input.target_code === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Target code is required',
        path: ['target_code'],
      });
    }
  });

export const shareResolveQuerySchema = z
  .object({ locale: z.enum(['vi', 'zh', 'en']).default('vi') })
  .strict();

export const shareOutcomeRequestSchema = z
  .object({
    interaction_token: interactionTokenSchema,
    outcome: z.enum(['COMPLETED', 'CANCELLED']),
  })
  .strict();
