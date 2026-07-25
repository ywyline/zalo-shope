import { SHIPMENT_STATUSES } from '@zalo-shop/domain';
import { z } from 'zod';

const uuidSchema = z.string().uuid();

export const shipmentStatusSchema = z.enum(SHIPMENT_STATUSES);
export const shipmentIdParamsSchema = z.object({ shipmentId: uuidSchema }).strict();

export const shippingQuoteRequestSchema = z
  .object({
    order_id: uuidSchema,
    service_code: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

export const shipmentCreateRequestSchema = z
  .object({
    expected_order_version: z.number().int().positive(),
    inspection_policy: z.enum(['NO_INSPECTION', 'ALLOW_INSPECTION_NO_TRY_ON']),
    reason: z.string().trim().min(10).max(500),
    service_code: z.string().trim().min(1).max(64),
  })
  .strict();

export const shipmentOperationRequestSchema = z
  .object({
    expected_version: z.number().int().positive(),
    reason: z.string().trim().min(10).max(500),
  })
  .strict();

export const shipmentLabelQuerySchema = z
  .object({
    format: z.enum(['A5', 'THERMAL_80X80', 'THERMAL_52X70']).default('A5'),
  })
  .strict();

export const shipmentListQuerySchema = z
  .object({
    cursor: uuidSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    order_id: uuidSchema.optional(),
    status: shipmentStatusSchema.optional(),
  })
  .strict();

export type ShipmentCreateRequest = z.infer<typeof shipmentCreateRequestSchema>;
