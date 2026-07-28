import { AFTER_SALE_STATUSES, AFTER_SALE_TYPES } from '@zalo-shop/domain';
import { z } from 'zod';

const uuidSchema = z.string().uuid();
const codeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const opaqueCursorSchema = z
  .string()
  .min(23)
  .max(512)
  .regex(/^c1_[A-Za-z0-9_-]{20,509}$/);
const paginationSchema = z.object({
  cursor: opaqueCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const afterSaleTypeSchema = z.enum(AFTER_SALE_TYPES);
export const afterSaleStatusSchema = z.enum(AFTER_SALE_STATUSES);
export const afterSaleIdParamsSchema = z.object({ afterSaleId: uuidSchema }).strict();
export const afterSaleEvidenceIdParamsSchema = z
  .object({ afterSaleId: uuidSchema, evidenceId: uuidSchema })
  .strict();
export const afterSaleSettlementNumberParamsSchema = z
  .object({
    afterSaleId: uuidSchema,
    settlementNumber: z.string().regex(/^AST-[A-Z0-9]{16,32}$/),
  })
  .strict();
export const evidenceIdParamsSchema = z.object({ evidenceId: uuidSchema }).strict();
export const afterSalePolicyCodeParamsSchema = z.object({ policyCode: codeSchema }).strict();
export const afterSalePolicyVersionParamsSchema = z
  .object({ policyCode: codeSchema, versionNumber: z.coerce.number().int().positive() })
  .strict();
export const afterSaleAdminStoreQuerySchema = z.object({ store_id: uuidSchema }).strict();

export const afterSaleListQuerySchema = paginationSchema
  .extend({ status: afterSaleStatusSchema.optional(), type: afterSaleTypeSchema.optional() })
  .strict();

export const adminAfterSaleListQuerySchema = paginationSchema
  .extend({
    member_id: uuidSchema.optional(),
    order_id: uuidSchema.optional(),
    status: afterSaleStatusSchema.optional(),
    store_id: uuidSchema,
    type: afterSaleTypeSchema.optional(),
  })
  .strict();

const evidenceIdsSchema = z
  .array(uuidSchema)
  .max(6)
  .refine((items) => new Set(items).size === items.length, 'Evidence IDs must be unique');

const standardItemSchema = z
  .object({ order_item_id: uuidSchema, quantity: z.number().int().positive().max(1_000) })
  .strict();
const exchangeItemSchema = standardItemSchema.extend({ replacement_sku_id: uuidSchema }).strict();

const createBase = {
  description: z.string().trim().min(10).max(2_000),
  evidence_ids: evidenceIdsSchema,
  order_id: uuidSchema,
  reason_code: codeSchema,
};

export const afterSaleCreateRequestSchema = z
  .discriminatedUnion('type', [
    z
      .object({
        ...createBase,
        items: z.array(standardItemSchema).min(1).max(20),
        type: z.literal('REFUND_ONLY'),
      })
      .strict(),
    z
      .object({
        ...createBase,
        items: z.array(standardItemSchema).min(1).max(20),
        type: z.literal('RETURN_REFUND'),
      })
      .strict(),
    z
      .object({
        ...createBase,
        items: z.array(exchangeItemSchema).min(1).max(20),
        type: z.literal('EXCHANGE'),
      })
      .strict(),
  ])
  .superRefine((input, context) => {
    const ids = input.items.map((item) => item.order_item_id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: 'custom', message: 'Order items must be unique', path: ['items'] });
    }
  });

export const merchantAfterSaleCreateRequestSchema = z
  .object({
    description: z.string().trim().min(10).max(2_000),
    items: z.array(standardItemSchema).min(1).max(20),
    reason_code: codeSchema,
    type: z.literal('MERCHANT_REFUND'),
  })
  .strict()
  .superRefine((input, context) => {
    const ids = input.items.map((item) => item.order_item_id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: 'custom',
        message: 'Order items must be unique',
        path: ['items'],
      });
    }
  });

export const afterSaleEvidenceUploadRequestSchema = z
  .object({
    byte_size: z
      .number()
      .int()
      .positive()
      .max(50 * 1024 * 1024),
    checksum_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    filename: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine((value) => !/[\\/]/.test(value), 'Filename must not contain a path'),
    mime_type: z.enum(['image/jpeg', 'image/png', 'image/webp', 'video/mp4']),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.mime_type.startsWith('image/') && input.byte_size > 10 * 1024 * 1024) {
      context.addIssue({ code: 'custom', message: 'Image exceeds 10 MiB', path: ['byte_size'] });
    }
  });

export const afterSaleEvidenceConfirmRequestSchema = z
  .object({ expected_version: z.number().int().positive() })
  .strict();

export const afterSaleCancelRequestSchema = z
  .object({
    expected_version: z.number().int().positive(),
    reason: z.string().trim().min(10).max(500),
  })
  .strict();

export const afterSaleReturnShipmentRequestSchema = z
  .object({
    carrier_name: z.string().trim().min(2).max(160),
    expected_version: z.number().int().positive(),
    tracking_number: z.string().trim().min(2).max(160),
  })
  .strict();

export const afterSaleReviewRequestSchema = z
  .object({
    confirmation_code: z.enum(['APPROVE_AFTER_SALE', 'REJECT_AFTER_SALE']),
    decision: z.enum(['APPROVE', 'REJECT']),
    expected_version: z.number().int().positive(),
    reason: z.string().trim().min(10).max(500),
  })
  .strict()
  .refine(
    (input) =>
      (input.decision === 'APPROVE' && input.confirmation_code === 'APPROVE_AFTER_SALE') ||
      (input.decision === 'REJECT' && input.confirmation_code === 'REJECT_AFTER_SALE'),
    { message: 'Confirmation does not match the decision', path: ['confirmation_code'] },
  );

const inspectionDispositionSchema = z
  .object({
    disposition: z.enum(['RESTOCK_SELLABLE', 'QUARANTINE', 'SCRAP', 'RETURN_TO_MEMBER']),
    quantity: z.number().int().positive().max(1_000),
  })
  .strict();

const inspectionItemSchema = z
  .object({
    dispositions: z.array(inspectionDispositionSchema).min(1).max(4),
    order_item_id: uuidSchema,
    received_quantity: z.number().int().positive().max(1_000),
  })
  .strict()
  .superRefine((item, context) => {
    const dispositions = item.dispositions.map((entry) => entry.disposition);
    if (new Set(dispositions).size !== dispositions.length) {
      context.addIssue({
        code: 'custom',
        message: 'Dispositions must be unique',
        path: ['dispositions'],
      });
    }
    const allocatedQuantity = item.dispositions.reduce((sum, entry) => sum + entry.quantity, 0);
    if (!Number.isSafeInteger(allocatedQuantity) || allocatedQuantity !== item.received_quantity) {
      context.addIssue({
        code: 'custom',
        message: 'Disposition quantities must equal the received quantity',
        path: ['dispositions'],
      });
    }
  });

export const afterSaleInspectionRequestSchema = z
  .object({
    confirmation_code: z.literal('INSPECT_RETURN'),
    expected_version: z.number().int().positive(),
    items: z.array(inspectionItemSchema).min(1).max(20),
    reason: z.string().trim().min(10).max(500),
  })
  .strict()
  .superRefine((input, context) => {
    const ids = input.items.map((item) => item.order_item_id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: 'custom',
        message: 'Inspection items must be unique',
        path: ['items'],
      });
    }
  });

export const afterSaleRefundRequestSchema = z
  .object({
    confirmation_code: z.literal('ISSUE_AFTER_SALE_REFUND'),
    expected_version: z.number().int().positive(),
    reason: z.string().trim().min(10).max(500),
  })
  .strict();

export const afterSaleExchangeRequestSchema = z
  .object({
    confirmation_code: z.literal('CREATE_EXCHANGE'),
    expected_version: z.number().int().positive(),
    reason: z.string().trim().min(10).max(500),
  })
  .strict();

export const afterSaleExchangeToRefundRequestSchema = z
  .object({
    confirmation_code: z.literal('CONVERT_EXCHANGE_TO_REFUND'),
    expected_version: z.number().int().positive(),
    reason: z.string().trim().min(10).max(500),
  })
  .strict();

const reviewResolutionBase = {
  confirmation_code: z.literal('RESOLVE_AFTER_SALE_REVIEW'),
  expected_version: z.number().int().positive(),
  reason: z.string().trim().min(10).max(500),
};
export const afterSaleReviewResolveRequestSchema = z.discriminatedUnion('decision', [
  z.object({ ...reviewResolutionBase, decision: z.literal('RESUME') }).strict(),
  z.object({ ...reviewResolutionBase, decision: z.literal('REJECT') }).strict(),
  z
    .object({
      ...reviewResolutionBase,
      decision: z.literal('LEGACY_APPROVE'),
      policy_basis: z.string().trim().min(10).max(2_000),
      return_shipping_payer: z.enum(['BUYER', 'MERCHANT', 'CONDITIONAL']).nullable(),
      return_window_days: z.number().int().min(1).max(60).nullable(),
    })
    .strict()
    .refine(
      (input) =>
        (input.return_shipping_payer === null && input.return_window_days === null) ||
        (input.return_shipping_payer !== null && input.return_window_days !== null),
      {
        message: 'Return window and shipping payer must both be null or both be provided',
        path: ['return_window_days'],
      },
    ),
  z
    .object({
      ...reviewResolutionBase,
      decision: z.literal('LEGACY_REJECT'),
      policy_basis: z.string().trim().min(10).max(2_000),
    })
    .strict(),
]);

export const afterSaleCodRefundConfirmRequestSchema = z
  .object({
    confirmation_code: z.literal('CONFIRM_COD_REFUND'),
    expected_settlement_version: z.number().int().positive(),
    expected_version: z.number().int().positive(),
    reason: z.string().trim().min(10).max(500),
  })
  .strict();

export const afterSalePolicyListQuerySchema = paginationSchema
  .extend({ status: z.enum(['DRAFT', 'ACTIVE', 'DISABLED']).optional(), store_id: uuidSchema })
  .strict();
export const afterSalePolicyVersionListQuerySchema = paginationSchema
  .extend({ store_id: uuidSchema })
  .strict();

const policyLocalizationSchema = z
  .object({
    buyer_instructions: z.string().trim().min(1).max(2_000),
    locale: z.enum(['vi', 'zh', 'en']),
    name: z.string().trim().min(1).max(160),
    summary: z.string().trim().min(1).max(1_000),
  })
  .strict();

const policyConditionRulesSchema = z
  .object({
    evidence_required: z.boolean(),
    evidence_required_reason_codes: z.array(codeSchema).max(64),
    opened_package_exception_reason_codes: z.array(codeSchema).max(64),
  })
  .strict()
  .superRefine((input, context) => {
    for (const field of [
      'evidence_required_reason_codes',
      'opened_package_exception_reason_codes',
    ] as const) {
      if (new Set(input[field]).size !== input[field].length) {
        context.addIssue({ code: 'custom', message: `${field} must be unique`, path: [field] });
      }
    }
  });

export const afterSalePolicyDraftSchema = z
  .object({
    allowed_types: z.array(afterSaleTypeSchema).min(1).max(4),
    category_id: uuidSchema.nullable(),
    condition_rules: policyConditionRulesSchema,
    damaged_exception: z.boolean(),
    exchange_attribute_code: codeSchema.nullable(),
    exchange_same_product_only: z.literal(true),
    expected_version: z.number().int().min(0),
    hygiene_restricted: z.boolean(),
    localizations: z.array(policyLocalizationSchema).length(3),
    product_ids: z.array(uuidSchema).max(100),
    request_window_days: z.number().int().min(0).max(365),
    return_shipping_payer: z.enum(['BUYER', 'MERCHANT', 'CONDITIONAL']),
    return_window_days: z.number().int().min(1).max(60),
    unopened_required: z.boolean(),
  })
  .strict()
  .superRefine((input, context) => {
    if (new Set(input.allowed_types).size !== input.allowed_types.length) {
      context.addIssue({
        code: 'custom',
        message: 'Allowed types must be unique',
        path: ['allowed_types'],
      });
    }
    if (new Set(input.product_ids).size !== input.product_ids.length) {
      context.addIssue({
        code: 'custom',
        message: 'Product IDs must be unique',
        path: ['product_ids'],
      });
    }
    const locales = input.localizations.map((item) => item.locale);
    if (new Set(locales).size !== 3 || !locales.includes('vi')) {
      context.addIssue({
        code: 'custom',
        message: 'Exactly vi, zh and en are required',
        path: ['localizations'],
      });
    }
    const allowsExchange = input.allowed_types.includes('EXCHANGE');
    if (allowsExchange !== (input.exchange_attribute_code !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'Exchange policies require exactly one allowed attribute code',
        path: ['exchange_attribute_code'],
      });
    }
  });

export const afterSalePolicyPublishSchema = z
  .object({
    confirmation_code: z.literal('PUBLISH_AFTER_SALE_POLICY'),
    expected_version: z.number().int().positive(),
    reason: z.string().trim().min(10).max(500),
  })
  .strict();

export const afterSalePolicyDisableSchema = z
  .object({
    confirmation_code: z.literal('DISABLE_AFTER_SALE_POLICY'),
    expected_version: z.number().int().positive(),
    reason: z.string().trim().min(10).max(500),
  })
  .strict();

export const afterSaleSettingsEnforcementSchema = z
  .object({
    confirmation_code: z.enum([
      'ENABLE_AFTER_SALE_POLICY_ENFORCEMENT',
      'DISABLE_AFTER_SALE_POLICY_ENFORCEMENT',
    ]),
    enabled: z.boolean(),
    expected_version: z.number().int().positive(),
    reason: z.string().trim().min(10).max(500),
  })
  .strict()
  .refine(
    (input) =>
      (input.enabled && input.confirmation_code === 'ENABLE_AFTER_SALE_POLICY_ENFORCEMENT') ||
      (!input.enabled && input.confirmation_code === 'DISABLE_AFTER_SALE_POLICY_ENFORCEMENT'),
    { message: 'Confirmation does not match the enforcement action', path: ['confirmation_code'] },
  );

export type AfterSaleCreateRequest = z.infer<typeof afterSaleCreateRequestSchema>;
