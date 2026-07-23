import { z } from 'zod';

import { catalogCodeSchema } from './catalog';

const vndSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const deliveryPolicyStoreQuerySchema = z.object({ store_id: z.string().uuid() }).strict();

export const updateDeliveryPolicySchema = z
  .object({
    cod_enabled: z.boolean(),
    cod_max_amount_vnd: vndSchema.positive().nullable(),
    enabled: z.boolean(),
    expected_version: z.number().int().positive(),
    flat_shipping_fee_vnd: vndSchema,
    free_shipping_threshold_vnd: vndSchema.nullable(),
    remote_province_codes: z.array(catalogCodeSchema).max(200),
    remote_surcharge_vnd: vndSchema,
  })
  .strict()
  .refine(
    (value) => new Set(value.remote_province_codes).size === value.remote_province_codes.length,
    { message: 'Remote province codes must be unique', path: ['remote_province_codes'] },
  );

export type UpdateDeliveryPolicyInput = z.infer<typeof updateDeliveryPolicySchema>;
