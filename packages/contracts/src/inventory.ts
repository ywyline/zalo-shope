import { MAX_INVENTORY_QUANTITY } from '@zalo-shop/domain';
import { z } from 'zod';

export const inventoryOperationKeySchema = z
  .string()
  .trim()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const warehouseCodeSchema = z
  .string()
  .trim()
  .transform((value) => value.toLowerCase())
  .pipe(
    z
      .string()
      .min(2)
      .max(64)
      .regex(/^[a-z][a-z0-9-]*$/),
  );

const warehouseLocalizationSchema = z
  .object({
    locale: z.enum(['vi', 'zh', 'en']),
    name: z.string().trim().min(1).max(160),
  })
  .strict();

const warehouseLocalizationsSchema = z
  .array(warehouseLocalizationSchema)
  .min(1)
  .max(3)
  .superRefine((values, context) => {
    const locales = new Set<string>();
    values.forEach((value, index) => {
      if (locales.has(value.locale)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate localization: ${value.locale}`,
          path: [index, 'locale'],
        });
      }
      locales.add(value.locale);
    });
    if (!locales.has('vi')) {
      context.addIssue({ code: 'custom', message: 'A Vietnamese localization is required' });
    }
  });

export const createWarehouseSchema = z
  .object({
    code: warehouseCodeSchema,
    enabled: z.boolean().default(true),
    is_default_fulfillment: z.boolean().default(false),
    localizations: warehouseLocalizationsSchema,
  })
  .strict();

export const warehouseListQuerySchema = z
  .object({
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const updateWarehouseSchema = z
  .object({
    enabled: z.boolean().optional(),
    expected_version: z.number().int().positive(),
    is_default_fulfillment: z.boolean().optional(),
    localizations: warehouseLocalizationsSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.enabled !== undefined ||
      value.is_default_fulfillment !== undefined ||
      value.localizations !== undefined,
    'At least one warehouse field must change',
  );

export const inventoryAdjustmentSchema = z
  .object({
    confirmation_code: z.literal('ADJUST'),
    delta: z
      .number()
      .int()
      .min(-MAX_INVENTORY_QUANTITY)
      .max(MAX_INVENTORY_QUANTITY)
      .refine((value) => value !== 0, 'Adjustment delta must not be zero'),
    expected_version: z.number().int().positive(),
    note: z.string().trim().min(1).max(500).nullable().default(null),
    reason_code: z.enum([
      'INITIAL_LOAD',
      'CYCLE_COUNT',
      'DAMAGED',
      'LOST',
      'RETURN_CORRECTION',
      'OTHER',
    ]),
    sku_id: z.string().uuid(),
    warehouse_id: z.string().uuid(),
  })
  .strict();

export const inventoryBalanceListQuerySchema = z
  .object({
    cursor: z.string().uuid().optional(),
    in_stock: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    q: z.string().trim().min(1).max(100).optional(),
    warehouse_id: z.string().uuid().optional(),
  })
  .strict();

export const inventoryMovementListQuerySchema = z
  .object({
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    movement_type: z
      .enum(['ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'RESERVE', 'RELEASE', 'CONSUME', 'RESTORE'])
      .optional(),
    sku_id: z.string().uuid().optional(),
    warehouse_id: z.string().uuid().optional(),
  })
  .strict();

export const inventoryImportQuerySchema = z
  .object({
    dry_run: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
  })
  .strict();

export type CreateWarehouseInput = z.infer<typeof createWarehouseSchema>;
export type InventoryAdjustmentInput = z.infer<typeof inventoryAdjustmentSchema>;
export type InventoryBalanceListQuery = z.infer<typeof inventoryBalanceListQuerySchema>;
export type InventoryImportQuery = z.infer<typeof inventoryImportQuerySchema>;
export type InventoryMovementListQuery = z.infer<typeof inventoryMovementListQuerySchema>;
export type UpdateWarehouseInput = z.infer<typeof updateWarehouseSchema>;
export type WarehouseListQuery = z.infer<typeof warehouseListQuerySchema>;
