import { z } from 'zod';

const uuidSchema = z.string().uuid();
const referenceSchema = z.string().trim().min(1).max(160);
const positiveVndSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonnegativeVndSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const businessDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'Business date must be a real calendar date');

export const financialReconciliationStoreQuerySchema = z.object({ store_id: uuidSchema }).strict();
export const financialReconciliationBatchParamsSchema = z.object({ batchId: uuidSchema }).strict();

export const paymentSettlementRecordSchema = z
  .object({
    fee_amount_vnd: nonnegativeVndSchema,
    gross_amount_vnd: positiveVndSchema,
    occurred_at: z.coerce.date(),
    provider_reference: referenceSchema,
    record_reference: referenceSchema,
    type: z.enum(['PAYMENT', 'REFUND']),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.type === 'PAYMENT' && input.fee_amount_vnd > input.gross_amount_vnd) {
      context.addIssue({
        code: 'custom',
        message: 'Payment fee cannot exceed its gross amount',
        path: ['fee_amount_vnd'],
      });
    }
  });

export const paymentSettlementBatchImportSchema = z
  .object({
    batch_reference: referenceSchema,
    business_date: businessDateSchema,
    confirmation_code: z.literal('IMPORT_PAYMENT_SETTLEMENT'),
    provider_code: z.literal('ZALO_CHECKOUT_ZALOPAY'),
    provider_environment: z.enum(['SANDBOX', 'PRODUCTION']),
    reason: z.string().trim().min(10).max(500),
    records: z.array(paymentSettlementRecordSchema).min(1).max(500),
  })
  .strict()
  .superRefine((input, context) => {
    const references = new Set<string>();
    input.records.forEach((record, index) => {
      if (references.has(record.record_reference)) {
        context.addIssue({
          code: 'custom',
          message: 'Record references must be unique within a batch',
          path: ['records', index, 'record_reference'],
        });
      }
      references.add(record.record_reference);
    });
  });

const codRemittanceRecordSchema = z
  .object({
    cod_amount_vnd: positiveVndSchema,
    cod_fee_vnd: nonnegativeVndSchema,
    occurred_at: z.coerce.date(),
    provider_reference: referenceSchema,
    record_reference: referenceSchema,
    shipping_fee_vnd: nonnegativeVndSchema,
  })
  .strict()
  .superRefine((input, context) => {
    const fee = input.shipping_fee_vnd + input.cod_fee_vnd;
    if (!Number.isSafeInteger(fee)) {
      context.addIssue({
        code: 'custom',
        message: 'COD remittance fees exceed the safe integer range',
        path: ['shipping_fee_vnd'],
      });
    }
  });

export const codRemittanceBatchImportSchema = z
  .object({
    batch_reference: referenceSchema,
    business_date: businessDateSchema,
    confirmation_code: z.literal('IMPORT_GHN_COD_SETTLEMENT'),
    provider_code: z.literal('GHN'),
    provider_environment: z.enum(['SANDBOX', 'PRODUCTION']),
    reason: z.string().trim().min(10).max(500),
    records: z.array(codRemittanceRecordSchema).min(1).max(500),
  })
  .strict()
  .superRefine((input, context) => {
    const references = new Set<string>();
    input.records.forEach((record, index) => {
      if (references.has(record.record_reference)) {
        context.addIssue({
          code: 'custom',
          message: 'Record references must be unique within a batch',
          path: ['records', index, 'record_reference'],
        });
      }
      references.add(record.record_reference);
    });
  });

export const financialReconciliationBatchListQuerySchema = z
  .object({
    business_date_from: businessDateSchema.optional(),
    business_date_to: businessDateSchema.optional(),
    cursor: uuidSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    source: z.enum(['PAYMENT_PROVIDER', 'SHIPPING_PROVIDER']).optional(),
    status: z.enum(['MATCHED', 'REVIEW_REQUIRED']).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.business_date_from &&
      input.business_date_to &&
      input.business_date_from > input.business_date_to
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Business date range is invalid',
        path: ['business_date_to'],
      });
    }
  });

export const codReceivableListQuerySchema = z
  .object({
    cursor: uuidSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    status: z.enum(['UNREMITTED', 'REMITTED', 'REVIEW_REQUIRED']).optional(),
  })
  .strict();

export type PaymentSettlementBatchImport = z.infer<typeof paymentSettlementBatchImportSchema>;
export type CodRemittanceBatchImport = z.infer<typeof codRemittanceBatchImportSchema>;
export type FinancialReconciliationBatchListQuery = z.infer<
  typeof financialReconciliationBatchListQuerySchema
>;
export type CodReceivableListQuery = z.infer<typeof codReceivableListQuerySchema>;
