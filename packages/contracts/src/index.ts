import { SUPPORTED_LOCALES } from '@zalo-shop/domain';
import { z } from 'zod';

export const localeSchema = z.enum(SUPPORTED_LOCALES);
export const uuidSchema = z.string().uuid();

export const apiErrorCodeSchema = z.enum([
  'AUTHENTICATION_REQUIRED',
  'AUTHENTICATION_FAILED',
  'AUTHORIZATION_DENIED',
  'INPUT_INVALID',
  'RESOURCE_NOT_FOUND',
  'STORE_CONTEXT_INVALID',
  'CONFLICT',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
]);

export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const apiErrorSchema = z.object({
  code: apiErrorCodeSchema,
  correlation_id: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
  message_key: z.string().min(1),
});

export type ApiError = z.infer<typeof apiErrorSchema>;

export const paginationQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const memberPreferenceSchema = z.object({
  locale: localeSchema,
});

export const consentEventSchema = z.object({
  event_id: uuidSchema,
  policy_version: z.string().min(1).max(64),
  purpose: z.enum(['PROFILE', 'PHONE', 'LOCATION', 'TERMS', 'PRIVACY']),
  source: z.enum(['ZALO', 'MANUAL']),
  status: z.enum(['GRANTED', 'DENIED', 'REVOKED']),
});

export const manualPhoneSchema = z.object({
  consent_event_id: uuidSchema,
  phone: z.string().min(9).max(24),
  policy_version: z.string().min(1).max(64),
});

export const zaloPhoneSchema = z.object({
  consent_event_id: uuidSchema,
  phone_token: z.string().min(16).max(4_096),
  policy_version: z.string().min(1).max(64),
});

export const accessReasonSchema = z.string().trim().min(10).max(500);

export const storeLocalizationInputSchema = z.object({
  display_name: z.string().trim().min(1).max(160),
  locale: localeSchema,
  short_description: z.string().trim().max(500).nullable().optional(),
});

const themeTokenRecordSchema = z.record(
  z.string().min(1).max(64),
  z.union([z.string().max(160), z.number().finite()]),
);

export const updateStoreConfigSchema = z
  .object({
    expected_version: z.number().int().positive(),
    localizations: z.array(storeLocalizationInputSchema).max(3).optional(),
    theme: z
      .object({
        color_tokens: themeTokenRecordSchema,
        radius_tokens: themeTokenRecordSchema,
        typography_tokens: themeTokenRecordSchema,
      })
      .optional(),
  })
  .refine((value) => value.localizations !== undefined || value.theme !== undefined, {
    message: 'At least one configuration section is required',
  });

export const createStoreRoleSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(64)
    .regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().trim().min(2).max(160),
});

export * from './catalog';
export * from './cart';
export * from './inventory';
export * from './pricing';
export * from './search';
