import { SUPPORTED_LOCALES } from '@zalo-shop/domain';
import { z } from 'zod';

export const catalogCodeSchema = z
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

export const catalogLocalizationSchema = z
  .object({
    description: z.string().trim().max(20_000).nullable(),
    locale: z.enum(SUPPORTED_LOCALES),
    name: z.string().trim().min(1).max(240),
    selling_points: z.string().trim().max(2_000).nullable(),
  })
  .strict();

export const catalogLocalizationsSchema = z
  .array(catalogLocalizationSchema)
  .min(1)
  .max(SUPPORTED_LOCALES.length)
  .superRefine((localizations, context) => {
    const localeCounts = new Map<string, number>();
    localizations.forEach((localization) => {
      localeCounts.set(localization.locale, (localeCounts.get(localization.locale) ?? 0) + 1);
    });
    for (const [locale, count] of localeCounts) {
      if (count > 1) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate localization: ${locale}`,
        });
      }
    }
    if ((localeCounts.get('vi') ?? 0) !== 1) {
      context.addIssue({
        code: 'custom',
        message: 'Exactly one Vietnamese localization is required',
      });
    }
  });

const localizedNameSchema = z
  .object({
    description: z.string().trim().max(20_000).nullable().optional(),
    locale: z.enum(SUPPORTED_LOCALES),
    name: z.string().trim().min(1).max(240),
    share_summary: z.string().trim().max(500).nullable().optional(),
    share_title: z.string().trim().max(240).nullable().optional(),
  })
  .strict();

const localizedNamesSchema = z
  .array(localizedNameSchema)
  .min(1)
  .max(SUPPORTED_LOCALES.length)
  .superRefine((localizations, context) => {
    const locales = new Set<string>();
    localizations.forEach((localization, index) => {
      if (locales.has(localization.locale)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate localization: ${localization.locale}`,
          path: [index, 'locale'],
        });
      }
      locales.add(localization.locale);
    });
    if (!locales.has('vi')) {
      context.addIssue({ code: 'custom', message: 'A Vietnamese localization is required' });
    }
  });

export const createBrandSchema = z
  .object({
    code: catalogCodeSchema,
    country_code: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .nullable()
      .optional(),
    localizations: localizedNamesSchema,
    official_website: z.string().url().startsWith('https://').nullable().optional(),
    recommended: z.boolean().default(false),
    sort_order: z.number().int().safe().nonnegative().default(0),
  })
  .strict();

export const updateBrandSchema = z
  .object({
    country_code: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .nullable()
      .optional(),
    expected_version: z.number().int().positive(),
    localizations: localizedNamesSchema.optional(),
    official_website: z.string().url().startsWith('https://').nullable().optional(),
    recommended: z.boolean().optional(),
    sort_order: z.number().int().safe().nonnegative().optional(),
    status: z.enum(['ACTIVE', 'DISABLED']).optional(),
  })
  .strict();

export const createCategorySchema = z
  .object({
    code: catalogCodeSchema,
    localizations: localizedNamesSchema,
    parent_id: z.string().uuid().nullable().default(null),
    sort_order: z.number().int().safe().nonnegative().default(0),
  })
  .strict();

export const updateCategorySchema = z
  .object({
    expected_version: z.number().int().positive(),
    localizations: localizedNamesSchema.optional(),
    parent_id: z.string().uuid().nullable().optional(),
    sort_order: z.number().int().safe().nonnegative().optional(),
    status: z.enum(['ACTIVE', 'DISABLED']).optional(),
  })
  .strict();

export const categoryTemplateBindingSchema = z
  .object({ is_primary: z.boolean().default(false) })
  .strict();

const attributeOptionInputSchema = z
  .object({
    code: catalogCodeSchema,
    label_en: z.string().trim().min(1).max(160).nullable().optional(),
    label_vi: z.string().trim().min(1).max(160),
    label_zh: z.string().trim().min(1).max(160).nullable().optional(),
    sort_order: z.number().int().safe().nonnegative().default(0),
  })
  .strict();

const attributeDefinitionInputSchema = z
  .object({
    code: catalogCodeSchema,
    data_type: z.enum(['TEXT', 'INTEGER', 'DECIMAL', 'BOOLEAN', 'DATE', 'OPTION']),
    filterable: z.boolean().default(false),
    label_en: z.string().trim().min(1).max(160).nullable().optional(),
    label_vi: z.string().trim().min(1).max(160),
    label_zh: z.string().trim().min(1).max(160).nullable().optional(),
    multiple: z.boolean().default(false),
    options: z.array(attributeOptionInputSchema).max(200).default([]),
    purpose: z.enum(['SPECIFICATION', 'FILTER', 'DETAIL', 'COMPLIANCE']),
    required: z.boolean().default(false),
    sort_order: z.number().int().safe().nonnegative().default(0),
    unit: z.string().trim().min(1).max(32).nullable().optional(),
    validation_rules: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .superRefine((definition, context) => {
    if (definition.purpose === 'SPECIFICATION' && definition.data_type !== 'OPTION') {
      context.addIssue({ code: 'custom', message: 'Specification attributes must use options' });
    }
    if (definition.data_type !== 'OPTION' && definition.options.length > 0) {
      context.addIssue({ code: 'custom', message: 'Only option attributes can define options' });
    }
    if (definition.data_type === 'OPTION' && definition.options.length === 0) {
      context.addIssue({ code: 'custom', message: 'Option attributes require options' });
    }
  });

export const attributeTemplateVersionInputSchema = z
  .object({
    definitions: z.array(attributeDefinitionInputSchema).min(1).max(100),
    name: z.string().trim().min(1).max(160),
  })
  .strict();

export const createAttributeTemplateSchema = attributeTemplateVersionInputSchema
  .extend({ code: catalogCodeSchema })
  .strict();

export const updateAttributeTemplateVersionSchema = attributeTemplateVersionInputSchema
  .extend({ expected_template_version: z.number().int().positive() })
  .strict();

export const activateAttributeTemplateVersionSchema = z
  .object({ expected_template_version: z.number().int().positive() })
  .strict();

export const createProductDraftSchema = z
  .object({
    brand_id: z.string().uuid(),
    code: catalogCodeSchema,
    localizations: catalogLocalizationsSchema,
    main_category_id: z.string().uuid(),
    secondary_category_ids: z.array(z.string().uuid()).max(20).default([]),
  })
  .strict();

export const skuOptionValueSchema = z
  .object({
    attribute_code: catalogCodeSchema,
    option_code: catalogCodeSchema,
  })
  .strict();

const vndAmountSchema = z.number().int().safe().nonnegative();

export const skuDraftSchema = z
  .object({
    barcode: z.string().trim().min(4).max(64).nullable().optional(),
    code: catalogCodeSchema,
    cost_price_vnd: vndAmountSchema.nullable().optional(),
    enabled: z.boolean(),
    market_price_vnd: vndAmountSchema.nullable().optional(),
    option_values: z.array(skuOptionValueSchema).min(1).max(20),
    sale_price_vnd: vndAmountSchema,
    weight_grams: z.number().int().safe().positive().nullable().optional(),
  })
  .strict()
  .superRefine((sku, context) => {
    const attributes = new Set<string>();
    sku.option_values.forEach((option, index) => {
      if (attributes.has(option.attribute_code)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate SKU attribute: ${option.attribute_code}`,
          path: ['option_values', index, 'attribute_code'],
        });
      }
      attributes.add(option.attribute_code);
    });
  });

export type CatalogLocalizationInput = z.infer<typeof catalogLocalizationSchema>;
export type AttributeTemplateVersionInput = z.infer<typeof attributeTemplateVersionInputSchema>;
export type CreateAttributeTemplateInput = z.infer<typeof createAttributeTemplateSchema>;
export type CreateBrandInput = z.infer<typeof createBrandSchema>;
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type CreateProductDraftInput = z.infer<typeof createProductDraftSchema>;
export type SkuDraftInput = z.infer<typeof skuDraftSchema>;
export type UpdateBrandInput = z.infer<typeof updateBrandSchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
export type UpdateAttributeTemplateVersionInput = z.infer<
  typeof updateAttributeTemplateVersionSchema
>;
