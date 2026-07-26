import { PAYMENT_ATTEMPT_STATUSES, REFUND_STATUSES } from '@zalo-shop/domain';
import { z } from 'zod';

const uuidSchema = z.string().uuid();
const vndAmountSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const paymentAttemptStatusSchema = z.enum(PAYMENT_ATTEMPT_STATUSES);
export const refundStatusSchema = z.enum(REFUND_STATUSES);

export const paymentAttemptCreateRequestSchema = z.object({}).strict();

export const paymentProviderOrderBindRequestSchema = z
  .object({
    launch_token: z.string().min(32).max(4_096),
    provider_order_id: z.string().trim().min(1).max(160),
  })
  .strict();

export const paymentIdParamsSchema = z.object({ paymentId: uuidSchema }).strict();
export const paymentAdminStoreQuerySchema = z.object({ store_id: uuidSchema }).strict();
export const paymentProviderOrderParamsSchema = z
  .object({ orderId: uuidSchema, paymentId: uuidSchema })
  .strict();
export const refundIdParamsSchema = z.object({ refundId: uuidSchema }).strict();
export const integrationJobIdParamsSchema = z.object({ jobId: uuidSchema }).strict();

export const paymentListQuerySchema = z
  .object({
    cursor: uuidSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    order_id: uuidSchema.optional(),
    status: paymentAttemptStatusSchema.optional(),
  })
  .strict();

export const refundListQuerySchema = z
  .object({
    cursor: uuidSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    order_id: uuidSchema.optional(),
    payment_id: uuidSchema.optional(),
    status: refundStatusSchema.optional(),
  })
  .strict();

export const refundCreateRequestSchema = z
  .object({
    amount_vnd: vndAmountSchema,
    confirmation_code: z.literal('CREATE_REFUND'),
    expected_payment_version: z.number().int().positive(),
    reason: z.string().trim().min(10).max(500),
  })
  .strict();

export const providerQueryRequestSchema = z
  .object({
    expected_version: z.number().int().positive(),
    reason: z.string().trim().min(10).max(500),
  })
  .strict();

export const integrationJobRetryRequestSchema = z
  .object({
    confirmation_code: z.literal('RETRY_DEAD_LETTER'),
    expected_version: z.number().int().positive(),
    reason: z.string().trim().min(10).max(500),
  })
  .strict();

export const integrationJobListQuerySchema = z
  .object({
    cursor: uuidSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    status: z.enum(['PENDING', 'PROCESSING', 'SUCCEEDED', 'RETRY_WAIT', 'DEAD_LETTER']).optional(),
  })
  .strict();

export type RefundCreateRequest = z.infer<typeof refundCreateRequestSchema>;
