import { PRIVACY_REQUEST_STATUSES, PRIVACY_REQUEST_TYPES } from '@zalo-shop/domain';
import { z } from 'zod';

const productCodeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const opaqueCursorSchema = z
  .string()
  .min(23)
  .max(512)
  .regex(/^c1_[A-Za-z0-9_-]{20,509}$/);
const memberPaginationQuery = z
  .object({
    cursor: opaqueCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
const memberResourceListQuery = memberPaginationQuery
  .extend({
    locale: z.enum(['vi', 'zh', 'en']).default('vi'),
  })
  .strict();

export const memberProductCodeParamsSchema = z.object({ productCode: productCodeSchema }).strict();
export const memberFavoriteListQuerySchema = memberResourceListQuery;
export const memberProductHistoryListQuerySchema = memberResourceListQuery;

export const memberProductHistoryUpsertSchema = z.object({}).strict();

export const privacyRequestTypeSchema = z.enum(PRIVACY_REQUEST_TYPES);
export const privacyRequestStatusSchema = z.enum(PRIVACY_REQUEST_STATUSES);

const privacyConfirmationCodes = [
  'SUBMIT_DATA_ACCESS_REQUEST',
  'SUBMIT_DATA_CORRECTION_REQUEST',
  'SUBMIT_DATA_DELETION_REQUEST',
  'SUBMIT_DATA_ANONYMIZATION_REQUEST',
  'SUBMIT_ACCOUNT_CLOSURE_REQUEST',
] as const;
const privacyConfirmationByType = {
  ACCESS: 'SUBMIT_DATA_ACCESS_REQUEST',
  CORRECTION: 'SUBMIT_DATA_CORRECTION_REQUEST',
  DELETION: 'SUBMIT_DATA_DELETION_REQUEST',
  ANONYMIZATION: 'SUBMIT_DATA_ANONYMIZATION_REQUEST',
  ACCOUNT_CLOSURE: 'SUBMIT_ACCOUNT_CLOSURE_REQUEST',
} as const;

export const privacyRequestCreateSchema = z
  .object({
    confirmation_code: z.enum(privacyConfirmationCodes),
    description: z.string().trim().min(10).max(1_000),
    request_type: privacyRequestTypeSchema,
  })
  .strict()
  .refine((input) => input.confirmation_code === privacyConfirmationByType[input.request_type], {
    message: 'Confirmation does not match the privacy request type',
    path: ['confirmation_code'],
  });

export const privacyRequestListQuerySchema = memberPaginationQuery;
export const privacyRequestNumberParamsSchema = z
  .object({ requestNumber: z.string().regex(/^PRV-[A-Z0-9]{16,32}$/) })
  .strict();
export const privacyRequestCancelSchema = z
  .object({
    confirmation_code: z.literal('CANCEL_PRIVACY_REQUEST'),
    expected_version: z.number().int().positive(),
    reason: z.string().trim().min(10).max(500),
  })
  .strict();
