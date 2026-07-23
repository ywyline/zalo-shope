import { z } from 'zod';

const uuidSchema = z.string().uuid();
const paginationQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const orderIdParamsSchema = z.object({ orderId: uuidSchema }).strict();
export const orderListQuerySchema = paginationQuerySchema.extend({
  status: z
    .enum([
      'PENDING_PAYMENT',
      'PENDING_CONFIRMATION',
      'CONFIRMED',
      'PENDING_FULFILLMENT',
      'SHIPPED',
      'DELIVERED',
      'COMPLETED',
      'CANCELLED',
      'CLOSED',
    ])
    .optional(),
});

export const orderCancelSchema = z.object({
  reason: z.string().trim().min(2).max(500),
});

export const adminOrderNoteSchema = z.object({
  note: z.string().trim().max(2_000),
  tags: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
});

export const adminOrderActionSchema = z.object({
  reason: z.string().trim().min(2).max(500).optional(),
});

export type OrderListQuery = z.infer<typeof orderListQuerySchema>;
