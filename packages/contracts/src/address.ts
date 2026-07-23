import { catalogCodeSchema } from './catalog';
import { z } from 'zod';

const codeSchema = catalogCodeSchema;
const uuidSchema = z.string().uuid();

export const addressInputSchema = z
  .object({
    recipient_name: z.string().trim().min(1).max(160),
    phone: z.string().trim().min(9).max(24),
    province_code: codeSchema,
    province_name: z.string().trim().min(1).max(160).optional(),
    district_code: codeSchema,
    district_name: z.string().trim().min(1).max(160).optional(),
    ward_code: codeSchema,
    ward_name: z.string().trim().min(1).max(160).optional(),
    detail: z.string().trim().min(3).max(500),
    label: z.string().trim().max(64).optional(),
    is_default: z.boolean().default(false),
  })
  .strict();

export const updateAddressSchema = addressInputSchema
  .partial()
  .extend({ expected_version: z.number().int().positive() })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== 'expected_version'), {
    message: 'At least one address field must change',
  });

export const addressIdParamsSchema = z.object({ addressId: uuidSchema }).strict();
export const addressQuerySchema = z
  .object({ include_disabled: z.coerce.boolean().default(false) })
  .strict();
export const administrativeAreaQuerySchema = z
  .object({
    level: z.enum(['PROVINCE', 'DISTRICT', 'WARD']),
    parent_code: codeSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.level === 'PROVINCE' && value.parent_code !== undefined) {
      context.addIssue({ code: 'custom', message: 'Province cannot have a parent' });
    }
    if (value.level !== 'PROVINCE' && value.parent_code === undefined) {
      context.addIssue({ code: 'custom', message: 'Parent code is required' });
    }
  });

export type AddressInput = z.infer<typeof addressInputSchema>;
export type AdministrativeAreaQuery = z.infer<typeof administrativeAreaQuerySchema>;
export type UpdateAddressInput = z.infer<typeof updateAddressSchema>;
