import { AFTER_SALE_STATUSES, AFTER_SALE_TYPES } from '@zalo-shop/domain';
import { z } from 'zod';

const uuidSchema = z.string().uuid();
const codeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const afterSaleCursorSchema = z
  .string()
  .min(23)
  .max(512)
  .regex(/^c1_[A-Za-z0-9_-]{20,509}$/);
const paginationSchema = z.object({
  cursor: afterSaleCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const afterSaleCursorScopeSchema = z
  .object({
    expires_at_epoch_seconds: z.number().int().positive(),
    filters_hash: z.string().regex(/^[a-f0-9]{64}$/),
    resource: z.enum([
      'MEMBER_AFTER_SALES',
      'ADMIN_AFTER_SALES',
      'ADMIN_AFTER_SALE_POLICIES',
      'ADMIN_AFTER_SALE_POLICY_VERSIONS',
    ]),
    sort_id: uuidSchema,
    sort_key: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
    store_id: uuidSchema,
    subject_id: uuidSchema,
    subject_type: z.enum(['MEMBER', 'ADMIN']),
    version: z.literal(1),
  })
  .strict()
  .superRefine((input, context) => {
    const memberResource = input.resource === 'MEMBER_AFTER_SALES';
    if (memberResource !== (input.subject_type === 'MEMBER')) {
      context.addIssue({
        code: 'custom',
        message: 'Cursor resource does not match its subject type',
        path: ['subject_type'],
      });
    }
  });

export const afterSalePublicNumberSchema = z.string().regex(/^ASC-[A-Z0-9]{16,32}$/);
export const afterSaleReasonDetailResponseSchema = z.string().min(10).max(2_000).nullable();
export const afterSaleTypeSchema = z.enum(AFTER_SALE_TYPES);
export const afterSaleStatusSchema = z.enum(AFTER_SALE_STATUSES);

export const afterSaleCommandAcknowledgementResponseSchema = z
  .object({
    id: uuidSchema,
    public_number: afterSalePublicNumberSchema,
    status: afterSaleStatusSchema,
    version: z.number().int().positive(),
  })
  .strict();

export const AFTER_SALE_PUBLIC_CONFLICT_CODES = [
  'AFTER_SALE_STATE_CONFLICT',
  'AFTER_SALE_VERSION_CONFLICT',
  'AFTER_SALE_IDEMPOTENCY_CONFLICT',
  'AFTER_SALE_QUANTITY_EXCEEDS_AVAILABLE',
  'AFTER_SALE_POLICY_MISMATCH',
  'AFTER_SALE_RETURN_WINDOW_CLOSED',
  'AFTER_SALE_REQUEST_WINDOW_CLOSED',
  'AFTER_SALE_REFUND_EXCEEDS_APPROVED',
  'AFTER_SALE_ORDER_NOT_ELIGIBLE',
  'AFTER_SALE_PAYMENT_NOT_PROVEN',
  'AFTER_SALE_DELIVERY_NOT_PROVEN',
  'AFTER_SALE_REASON_NOT_ALLOWED',
  'AFTER_SALE_EXCHANGE_NOT_ALLOWED',
  'AFTER_SALE_EVIDENCE_CAPABILITY_UNAVAILABLE',
  'AFTER_SALE_EVIDENCE_REQUIRED',
  'AFTER_SALE_EVIDENCE_STATE_CONFLICT',
] as const;
export const afterSalePublicConflictCodeSchema = z.enum(AFTER_SALE_PUBLIC_CONFLICT_CODES);

export const AFTER_SALE_RATE_LIMIT_POLICY = {
  admin_read: { limit: 120, scope: 'store_id:admin_id', window_seconds: 60 },
  admin_write: { limit: 30, scope: 'store_id:admin_id', window_seconds: 60 },
  member_read: { limit: 60, scope: 'store_id:member_id', window_seconds: 60 },
  member_write: { limit: 10, scope: 'store_id:member_id', window_seconds: 60 },
} as const;

export const afterSalePolicyStatusSchema = z.enum(['DRAFT', 'ACTIVE', 'DISABLED']);
const afterSaleWireDateTimeSchema = z.string().datetime({ offset: true });
const afterSaleMoneyVndSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const afterSaleTimelineEventSchema = z.enum([
  'SUBMIT',
  'APPROVE',
  'REJECT',
  'CANCEL',
  'START_RETURN',
  'RETURN_EXPIRED',
  'RETURN_SHIPPED',
  'RETURN_RECEIVED',
  'ACCEPT_INSPECTION',
  'REJECT_INSPECTION',
  'QUEUE_REFUND',
  'REFUND_REQUESTED',
  'REFUND_SUCCEEDED',
  'REFUND_FAILED',
  'REFUND_CANCELLED',
  'CONVERT_EXCHANGE_TO_REFUND',
  'EXCHANGE_SHIPPED',
  'EXCHANGE_DELIVERED',
  'REQUIRE_REVIEW',
  'RESUME_REVIEW',
  'REJECT_REVIEW',
  'LEGACY_APPROVE',
  'LEGACY_REJECT',
  'COMPLETE',
]);

export const afterSaleItemResponseSchema = z
  .object({
    accepted_quantity: z.number().int().nonnegative(),
    approved_quantity: z.number().int().nonnegative(),
    order_item_id: uuidSchema,
    received_quantity: z.number().int().nonnegative(),
    rejected_quantity: z.number().int().nonnegative(),
    replacement_sku_id: uuidSchema.nullable().optional(),
    requested_quantity: z.number().int().positive(),
    restockable_quantity: z.number().int().nonnegative(),
    restored_quantity: z.number().int().nonnegative(),
  })
  .strict();

export const afterSaleEvidenceResponseSchema = z
  .object({
    access_expires_at: afterSaleWireDateTimeSchema.nullable(),
    evidence_id: uuidSchema,
    status: z.enum(['PENDING', 'READY', 'UNAVAILABLE']),
    version: z.number().int().positive(),
  })
  .strict()
  .superRefine((input, context) => {
    if ((input.status === 'READY') !== (input.access_expires_at !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'Only ready evidence has an access expiry',
        path: ['access_expires_at'],
      });
    }
  });

export const afterSaleEvidenceUploadHeadersSchema = z
  .object({
    'content-type': z.enum(['image/jpeg', 'image/png', 'image/webp', 'video/mp4']),
    'if-none-match': z.literal('*'),
    'x-amz-checksum-sha256': z.string().regex(/^[A-Za-z0-9+/]{43}=$/u),
    'x-amz-server-side-encryption': z.enum(['AES256', 'aws:kms']).optional(),
    'x-amz-server-side-encryption-aws-kms-key-id': z.string().min(1).max(2_048).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      (input['x-amz-server-side-encryption'] === 'aws:kms') !==
      (input['x-amz-server-side-encryption-aws-kms-key-id'] !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'KMS encryption requires its key identifier',
        path: ['x-amz-server-side-encryption-aws-kms-key-id'],
      });
    }
  });

export const afterSaleEvidenceUploadResponseSchema = z
  .object({
    evidence_id: uuidSchema,
    expires_at: afterSaleWireDateTimeSchema,
    upload_headers: afterSaleEvidenceUploadHeadersSchema,
    upload_url: z
      .string()
      .url()
      .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol)),
    version: z.number().int().positive(),
  })
  .strict();

export const afterSaleEvidenceAccessResponseSchema = z
  .object({
    expires_at: afterSaleWireDateTimeSchema,
    url: z
      .string()
      .url()
      .refine((value) => {
        try {
          return ['http:', 'https:'].includes(new URL(value).protocol);
        } catch {
          return false;
        }
      }),
  })
  .strict();

export const afterSaleTimelineResponseSchema = z
  .object({
    created_at: afterSaleWireDateTimeSchema,
    event: afterSaleTimelineEventSchema,
    status: afterSaleStatusSchema,
  })
  .strict();

export const afterSaleSettlementResponseSchema = z
  .object({
    amount_vnd: afterSaleMoneyVndSchema,
    created_at: afterSaleWireDateTimeSchema,
    method: z.enum(['ONLINE_ORIGINAL', 'COD_OFFLINE', 'NO_PAYOUT']),
    public_number: z.string().regex(/^AST-[A-Z0-9]{16,32}$/),
    receipt_recorded: z.boolean(),
    refund_public_number: z.string().max(64).nullable().optional(),
    status: z.enum([
      'PENDING',
      'PROCESSING',
      'SUCCEEDED',
      'FAILED',
      'REVIEW_REQUIRED',
      'CANCELLED',
    ]),
    updated_at: afterSaleWireDateTimeSchema,
  })
  .strict();

export const afterSaleReturnShipmentResponseSchema = z
  .object({
    carrier_name: z.string().min(2).max(160),
    masked_tracking_number: z.string().min(2).max(160),
    status: z.enum(['SUBMITTED', 'IN_TRANSIT', 'DELIVERED', 'REJECTED', 'UNKNOWN']),
    submitted_at: afterSaleWireDateTimeSchema,
  })
  .strict();

export const afterSalePolicySnapshotResponseSchema = z
  .object({
    buyer_instructions: z.string().max(2_000).nullable(),
    legacy_policy_review: z.boolean(),
    name: z.string().max(160).nullable(),
    policy_code: codeSchema.nullable(),
    policy_version_number: z.number().int().positive().nullable(),
    resolved_locale: z.enum(['vi', 'zh', 'en']).nullable(),
    summary: z.string().max(1_000).nullable(),
  })
  .strict()
  .superRefine((input, context) => {
    const fields = [
      input.buyer_instructions,
      input.name,
      input.policy_code,
      input.policy_version_number,
      input.resolved_locale,
      input.summary,
    ];
    const allNull = fields.every((value) => value === null);
    const allPresent = fields.every((value) => value !== null);
    if ((input.legacy_policy_review && !allNull) || (!input.legacy_policy_review && !allPresent)) {
      context.addIssue({
        code: 'custom',
        message: 'Policy snapshot fields must match the legacy flag',
        path: ['legacy_policy_review'],
      });
    }
  });

export const afterSaleResponseSchema = z
  .object({
    approved_refund_vnd: afterSaleMoneyVndSchema,
    created_at: afterSaleWireDateTimeSchema,
    currency: z.literal('VND'),
    evidence: z.array(afterSaleEvidenceResponseSchema).max(6),
    evidence_count: z.number().int().min(0).max(6).optional(),
    id: uuidSchema,
    items: z.array(afterSaleItemResponseSchema),
    order_id: uuidSchema,
    policy_snapshot: afterSalePolicySnapshotResponseSchema,
    public_number: afterSalePublicNumberSchema,
    reason_code: codeSchema,
    reason_detail: afterSaleReasonDetailResponseSchema,
    requested_item_vnd: afterSaleMoneyVndSchema,
    requested_other_vnd: afterSaleMoneyVndSchema,
    requested_shipping_vnd: afterSaleMoneyVndSchema,
    requested_total_vnd: afterSaleMoneyVndSchema,
    return_deadline_at: afterSaleWireDateTimeSchema.nullable(),
    return_shipments: z.array(afterSaleReturnShipmentResponseSchema),
    settlements: z.array(afterSaleSettlementResponseSchema),
    status: afterSaleStatusSchema,
    timeline: z.array(afterSaleTimelineResponseSchema),
    type: afterSaleTypeSchema,
    updated_at: afterSaleWireDateTimeSchema,
    version: z.number().int().positive(),
  })
  .strict()
  .superRefine((input, context) => {
    if (!input.policy_snapshot.legacy_policy_review && input.reason_detail === null) {
      context.addIssue({
        code: 'custom',
        message: 'Only legacy after-sales may omit the reason detail',
        path: ['reason_detail'],
      });
    }
    if (input.evidence_count !== undefined && input.evidence_count !== input.evidence.length) {
      context.addIssue({
        code: 'custom',
        message: 'Evidence count must match the projected evidence',
        path: ['evidence_count'],
      });
    }
    if (
      input.requested_total_vnd !==
      input.requested_item_vnd + input.requested_shipping_vnd + input.requested_other_vnd
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Requested total must equal its item, shipping and other components',
        path: ['requested_total_vnd'],
      });
    }
  });

export const afterSalePageResponseSchema = z
  .object({
    items: z.array(afterSaleResponseSchema),
    next_cursor: afterSaleCursorSchema.nullable(),
  })
  .strict();
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
export const afterSaleAdminReadQuerySchema = z
  .object({ locale: z.enum(['vi', 'zh', 'en']).optional(), store_id: uuidSchema })
  .strict();
export const afterSaleEvidenceAdminReadQuerySchema = z.object({ store_id: uuidSchema }).strict();
export const afterSaleMemberReadQuerySchema = z.object({}).strict();
export const afterSaleEvidenceMemberQuerySchema = z.object({}).strict();
// A D5 cross-store rationale is deliberately an incident reference instead of free text:
// it is written to both cross-store and protected-read audit rows.
export const afterSaleEvidenceProtectedReadAccessReasonSchema = z
  .string()
  .trim()
  .regex(/^Protected evidence incident [A-Z][A-Z0-9]{1,15}-[1-9][0-9]{0,11}$/u);
export const afterSaleStoreCodeHeaderSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/u);
export const afterSaleIdempotencyKeySchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[!-~]+$/);

export const afterSaleListQuerySchema = paginationSchema
  .extend({ status: afterSaleStatusSchema.optional(), type: afterSaleTypeSchema.optional() })
  .strict();

export const adminAfterSaleListQuerySchema = paginationSchema
  .extend({
    locale: z.enum(['vi', 'zh', 'en']).optional(),
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

export const afterSaleReturnFactRequestSchema = z
  .object({
    confirmation_code: z.literal('RECORD_RETURN_LOGISTICS_FACT'),
    expected_return_shipment_version: z.number().int().positive(),
    expected_version: z.number().int().positive(),
    reason: z.string().trim().min(10).max(500),
    status: z.enum(['IN_TRANSIT', 'DELIVERED']),
  })
  .strict();

const afterSaleApprovedItemSchema = z
  .object({
    approved_quantity: z.number().int().min(0).max(1_000),
    order_item_id: uuidSchema,
  })
  .strict();

export const afterSaleReviewRequestSchema = z
  .discriminatedUnion('decision', [
    z
      .object({
        confirmation_code: z.literal('APPROVE_AFTER_SALE'),
        decision: z.literal('APPROVE'),
        expected_version: z.number().int().positive(),
        items: z.array(afterSaleApprovedItemSchema).min(1).max(20),
        reason: z.string().trim().min(10).max(500),
      })
      .strict(),
    z
      .object({
        confirmation_code: z.literal('REJECT_AFTER_SALE'),
        decision: z.literal('REJECT'),
        expected_version: z.number().int().positive(),
        reason: z.string().trim().min(10).max(500),
      })
      .strict(),
  ])
  .superRefine((input, context) => {
    if (input.decision !== 'APPROVE') return;
    const ids = input.items.map((item) => item.order_item_id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: 'custom',
        message: 'Approved items must be unique',
        path: ['items'],
      });
    }
    if (!input.items.some((item) => item.approved_quantity > 0)) {
      context.addIssue({
        code: 'custom',
        message: 'At least one item quantity must be approved',
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

export const afterSaleCodRefundReceiptRequestSchema = z
  .object({
    confirmation_code: z.literal('RECORD_COD_REFUND_RECEIPT'),
    evidence_reference: z.string().trim().min(2).max(2_000),
    expected_settlement_version: z.number().int().positive(),
    reason: z.string().trim().min(10).max(500),
    transfer_reference: z.string().trim().min(2).max(160),
    transferred_at: afterSaleWireDateTimeSchema.transform((value) => new Date(value)),
  })
  .strict();

export const afterSalePolicyListQuerySchema = paginationSchema
  .extend({ status: afterSalePolicyStatusSchema.optional(), store_id: uuidSchema })
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
    allowed_reason_codes: z.array(codeSchema).min(1).max(64),
    evidence_required: z.boolean(),
    evidence_required_reason_codes: z.array(codeSchema).max(64),
    opened_package_exception_reason_codes: z.array(codeSchema).max(64),
  })
  .strict()
  .superRefine((input, context) => {
    for (const field of [
      'allowed_reason_codes',
      'evidence_required_reason_codes',
      'opened_package_exception_reason_codes',
    ] as const) {
      if (new Set(input[field]).size !== input[field].length) {
        context.addIssue({ code: 'custom', message: `${field} must be unique`, path: [field] });
      }
    }
    const allowedReasons = new Set(input.allowed_reason_codes);
    for (const field of [
      'evidence_required_reason_codes',
      'opened_package_exception_reason_codes',
    ] as const) {
      for (const reasonCode of input[field]) {
        if (!allowedReasons.has(reasonCode)) {
          context.addIssue({
            code: 'custom',
            message: `${field} must be a subset of allowed_reason_codes`,
            path: [field],
          });
          break;
        }
      }
    }
  });

const afterSalePolicyContentObjectSchema = z
  .object({
    allowed_types: z.array(afterSaleTypeSchema).min(1).max(4),
    category_id: uuidSchema.nullable(),
    condition_rules: policyConditionRulesSchema,
    damaged_exception: z.boolean(),
    defect_exception: z.boolean(),
    exchange_attribute_code: codeSchema.nullable(),
    exchange_same_product_only: z.literal(true),
    hygiene_restricted: z.boolean(),
    localizations: z.array(policyLocalizationSchema).length(3),
    product_ids: z.array(uuidSchema).max(100),
    request_window_days: z.number().int().min(0).max(365),
    return_shipping_payer: z.enum(['BUYER', 'MERCHANT', 'CONDITIONAL']),
    return_window_days: z.number().int().min(1).max(60),
    unopened_required: z.boolean(),
    wrong_item_exception: z.boolean(),
  })
  .strict();

function validateAfterSalePolicyContent(
  input: z.infer<typeof afterSalePolicyContentObjectSchema>,
  context: z.RefinementCtx,
) {
  if (new Set(input.allowed_types).size !== input.allowed_types.length) {
    context.addIssue({
      code: 'custom',
      message: 'Allowed types must be unique',
      path: ['allowed_types'],
    });
  }
  if (
    new Set(input.product_ids.map((productId) => productId.toLowerCase())).size !==
    input.product_ids.length
  ) {
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
}

export const afterSalePolicyContentSchema = afterSalePolicyContentObjectSchema.superRefine(
  validateAfterSalePolicyContent,
);

export const afterSalePolicyDraftSchema = afterSalePolicyContentObjectSchema
  .extend({ expected_version: z.number().int().min(0) })
  .superRefine(validateAfterSalePolicyContent);

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

export const afterSalePolicyVersionResponseSchema = z
  .object({
    code: codeSchema,
    content: afterSalePolicyContentSchema,
    effective_at: afterSaleWireDateTimeSchema,
    payload_hash: z.string().regex(/^[a-f0-9]{64}$/),
    published_at: afterSaleWireDateTimeSchema,
    version_number: z.number().int().positive(),
  })
  .strict();

export const afterSalePolicySummaryResponseSchema = z
  .object({
    code: codeSchema,
    current_version_number: z.number().int().positive().nullable(),
    status: afterSalePolicyStatusSchema,
    version: z.number().int().positive(),
  })
  .strict()
  .superRefine((input, context) => {
    if ((input.status === 'DRAFT') !== (input.current_version_number === null)) {
      context.addIssue({
        code: 'custom',
        message: 'Policy status must match its current immutable version',
        path: ['current_version_number'],
      });
    }
  });

export const afterSalePolicyDetailResponseSchema = z
  .object({
    code: codeSchema,
    current_version: afterSalePolicyVersionResponseSchema.nullable(),
    current_version_number: z.number().int().positive().nullable(),
    draft: afterSalePolicyContentSchema,
    status: afterSalePolicyStatusSchema,
    version: z.number().int().positive(),
  })
  .strict()
  .superRefine((input, context) => {
    if ((input.status === 'DRAFT') !== (input.current_version === null)) {
      context.addIssue({
        code: 'custom',
        message: 'Policy status must match its current immutable version',
        path: ['current_version'],
      });
    }
    if (input.current_version?.code !== undefined && input.current_version.code !== input.code) {
      context.addIssue({
        code: 'custom',
        message: 'Current version must belong to the policy',
        path: ['current_version', 'code'],
      });
    }
    if ((input.current_version?.version_number ?? null) !== input.current_version_number) {
      context.addIssue({
        code: 'custom',
        message: 'Current version metadata must agree',
        path: ['current_version_number'],
      });
    }
  });

export const afterSalePolicyPageResponseSchema = z
  .object({
    items: z.array(afterSalePolicySummaryResponseSchema),
    next_cursor: afterSaleCursorSchema.nullable(),
  })
  .strict();

export const afterSalePolicyVersionPageResponseSchema = z
  .object({
    items: z.array(afterSalePolicyVersionResponseSchema),
    next_cursor: afterSaleCursorSchema.nullable(),
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
export type MerchantAfterSaleCreateRequest = z.infer<typeof merchantAfterSaleCreateRequestSchema>;
export type AfterSaleCancelRequest = z.infer<typeof afterSaleCancelRequestSchema>;
export type AfterSaleReturnShipmentRequest = z.infer<typeof afterSaleReturnShipmentRequestSchema>;
export type AfterSaleReturnFactRequest = z.infer<typeof afterSaleReturnFactRequestSchema>;
export type AfterSaleRefundRequest = z.infer<typeof afterSaleRefundRequestSchema>;
export type AfterSaleCodRefundConfirmRequest = z.infer<
  typeof afterSaleCodRefundConfirmRequestSchema
>;
export type AfterSaleCodRefundReceiptRequest = z.infer<
  typeof afterSaleCodRefundReceiptRequestSchema
>;
export type AfterSaleReviewRequest = z.infer<typeof afterSaleReviewRequestSchema>;
export type AfterSaleReviewResolveRequest = z.infer<typeof afterSaleReviewResolveRequestSchema>;
export type AfterSaleCommandAcknowledgementResponse = z.infer<
  typeof afterSaleCommandAcknowledgementResponseSchema
>;
export type AfterSaleListQuery = z.infer<typeof afterSaleListQuerySchema>;
export type AdminAfterSaleListQuery = z.infer<typeof adminAfterSaleListQuerySchema>;
export type AfterSaleAdminReadQuery = z.infer<typeof afterSaleAdminReadQuerySchema>;
export type AfterSaleAdminStoreQuery = z.infer<typeof afterSaleAdminStoreQuerySchema>;
export type AfterSaleCursorScope = z.infer<typeof afterSaleCursorScopeSchema>;
export type AfterSaleResponse = z.infer<typeof afterSaleResponseSchema>;
export type AfterSalePageResponse = z.infer<typeof afterSalePageResponseSchema>;
export type AfterSaleEvidenceResponse = z.infer<typeof afterSaleEvidenceResponseSchema>;
export type AfterSaleEvidenceAccessResponse = z.infer<typeof afterSaleEvidenceAccessResponseSchema>;
export type AfterSaleEvidenceUploadRequest = z.infer<typeof afterSaleEvidenceUploadRequestSchema>;
export type AfterSaleEvidenceUploadResponse = z.infer<typeof afterSaleEvidenceUploadResponseSchema>;
export type AfterSalePolicyContent = z.infer<typeof afterSalePolicyContentSchema>;
export type AfterSalePolicyDetailResponse = z.infer<typeof afterSalePolicyDetailResponseSchema>;
export type AfterSalePolicyDraft = z.infer<typeof afterSalePolicyDraftSchema>;
export type AfterSalePolicyDisable = z.infer<typeof afterSalePolicyDisableSchema>;
export type AfterSalePolicyListQuery = z.infer<typeof afterSalePolicyListQuerySchema>;
export type AfterSalePolicyPageResponse = z.infer<typeof afterSalePolicyPageResponseSchema>;
export type AfterSalePolicyPublish = z.infer<typeof afterSalePolicyPublishSchema>;
export type AfterSalePolicySummaryResponse = z.infer<typeof afterSalePolicySummaryResponseSchema>;
export type AfterSalePolicyVersionListQuery = z.infer<typeof afterSalePolicyVersionListQuerySchema>;
export type AfterSalePolicyVersionPageResponse = z.infer<
  typeof afterSalePolicyVersionPageResponseSchema
>;
export type AfterSalePolicyVersionResponse = z.infer<typeof afterSalePolicyVersionResponseSchema>;
