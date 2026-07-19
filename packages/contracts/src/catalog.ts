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

const catalogLocaleQuerySchema = z.enum(SUPPORTED_LOCALES).default('vi');
const catalogLimitQuerySchema = z.coerce.number().int().min(1).max(100).default(20);
const catalogCursorQuerySchema = z.string().trim().min(1).max(1_000).optional();

export const publicCatalogLocaleQuerySchema = z
  .object({ locale: catalogLocaleQuerySchema })
  .strict();

export const publicBrandListQuerySchema = z
  .object({
    cursor: catalogCursorQuerySchema,
    limit: catalogLimitQuerySchema,
    locale: catalogLocaleQuerySchema,
    recommended: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
  })
  .strict();

export const publicProductListQuerySchema = z
  .object({
    brand_code: catalogCodeSchema.optional(),
    category_code: catalogCodeSchema.optional(),
    cursor: catalogCursorQuerySchema,
    limit: catalogLimitQuerySchema,
    locale: catalogLocaleQuerySchema,
    sort: z.enum(['newest', 'price_asc', 'price_desc']).default('newest'),
  })
  .strict();

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

export const replaceProductSkusSchema = z
  .object({
    expected_version: z.number().int().positive(),
    skus: z
      .array(z.lazy(() => skuDraftSchema))
      .min(1)
      .max(500),
  })
  .strict();

export const productVersionCommandSchema = z
  .object({ expected_version: z.number().int().positive() })
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

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const mediaUploadInputSchema = z
  .object({
    byte_size: z
      .number()
      .int()
      .safe()
      .min(1)
      .max(20 * 1024 * 1024),
    checksum_sha256: sha256Schema,
    filename: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine(
        (value) =>
          !value.includes('/') &&
          !value.includes('\\') &&
          [...value].every((character) => character.charCodeAt(0) >= 32),
        'Filename is unsafe',
      ),
    mime_type: z.enum(['image/svg+xml', 'image/png', 'image/webp']),
    resource: z.enum(['brand', 'category', 'product', 'sku', 'page', 'compliance']),
  })
  .strict();

export const confirmMediaUploadSchema = z
  .object({
    expected_version: z.number().int().positive(),
    resource: z.enum(['brand', 'category', 'product', 'sku', 'page', 'compliance']).optional(),
  })
  .strict();

export const productMediaInputSchema = z
  .object({
    expected_version: z.number().int().positive(),
    media_id: z.string().uuid(),
    purpose: z.enum(['PRIMARY', 'GALLERY']),
    sort_order: z.number().int().safe().nonnegative().default(0),
  })
  .strict();

export const submitComplianceRecordSchema = z
  .object({
    document_number: z.string().trim().min(1).max(255).nullable().optional(),
    expires_at: z.coerce.date().nullable().optional(),
    issued_at: z.coerce.date().nullable().optional(),
    media_ids: z.array(z.string().uuid()).min(1).max(20),
    product_id: z.string().uuid(),
    requirement_id: z.string().uuid(),
    supersedes_record_id: z.string().uuid().nullable().optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.issued_at && input.expires_at && input.expires_at <= input.issued_at) {
      context.addIssue({ code: 'custom', message: 'Expiry must be after issue date' });
    }
  });

export const reviewComplianceRecordSchema = z
  .object({
    decision: z.enum(['APPROVED', 'REJECTED']),
    review_note: z.string().trim().min(1).max(2_000),
  })
  .strict();

const pageModuleLocalizationSchema = z
  .object({
    button_label: z.string().trim().min(1).max(160).nullable().default(null),
    content_config: z
      .object({
        eyebrow: z.string().trim().min(1).max(120).nullable().optional(),
        item_ids: z.array(z.string().uuid()).max(24).optional(),
        layout: z.enum(['CAROUSEL', 'GRID', 'STACK']).optional(),
      })
      .strict()
      .default({}),
    locale: z.enum(SUPPORTED_LOCALES),
    summary: z.string().trim().min(1).max(500).nullable().default(null),
    title: z.string().trim().min(1).max(240),
  })
  .strict();

const pageModuleLocalizationsSchema = z
  .array(pageModuleLocalizationSchema)
  .length(SUPPORTED_LOCALES.length)
  .superRefine((localizations, context) => {
    const locales = new Set(localizations.map(({ locale }) => locale));
    for (const locale of SUPPORTED_LOCALES) {
      if (!locales.has(locale)) {
        context.addIssue({ code: 'custom', message: `Localization is required: ${locale}` });
      }
    }
  });

const pageModuleMediaSchema = z
  .object({
    media_id: z.string().uuid(),
    purpose: z.enum(['COVER', 'GALLERY']),
    sort_order: z.number().int().safe().nonnegative().default(0),
  })
  .strict();

export const pageModuleInputSchema = z
  .object({
    background_config: z
      .object({
        color: z
          .string()
          .regex(/^#[0-9a-f]{6}$/i)
          .nullable()
          .default(null),
        overlay: z.number().min(0).max(1).nullable().default(null),
      })
      .strict()
      .default({ color: null, overlay: null }),
    localizations: pageModuleLocalizationsSchema,
    media: z.array(pageModuleMediaSchema).max(10).default([]),
    module_type: z.enum([
      'HERO',
      'BANNER',
      'PRODUCT_GRID',
      'BRAND_GRID',
      'CATEGORY_GRID',
      'RICH_TEXT',
    ]),
    sort_order: z.number().int().safe().nonnegative(),
    status: z.enum(['ACTIVE', 'DISABLED']).default('ACTIVE'),
    target_id: z.string().uuid().nullable().default(null),
    target_type: z
      .enum(['PRODUCT', 'BRAND', 'CATEGORY', 'PAGE', 'EXTERNAL'])
      .nullable()
      .default(null),
    target_url: z.string().url().startsWith('https://').max(2_048).nullable().default(null),
    visible_from: z.coerce.date().nullable().default(null),
    visible_to: z.coerce.date().nullable().default(null),
  })
  .strict()
  .superRefine((module, context) => {
    if (module.visible_from && module.visible_to && module.visible_to <= module.visible_from) {
      context.addIssue({ code: 'custom', message: 'Visibility end must be after start' });
    }
    if (module.target_type === 'EXTERNAL') {
      if (!module.target_url || module.target_id) {
        context.addIssue({ code: 'custom', message: 'External targets require only target_url' });
      }
    } else if (module.target_type) {
      if (!module.target_id || module.target_url) {
        context.addIssue({ code: 'custom', message: 'Internal targets require only target_id' });
      }
    } else if (module.target_id || module.target_url) {
      context.addIssue({ code: 'custom', message: 'Target values require target_type' });
    }
  });

export const createPageDraftSchema = z.object({ code: catalogCodeSchema }).strict();

export const replacePageDraftSchema = z
  .object({
    expected_version: z.number().int().positive(),
    modules: z.array(pageModuleInputSchema).max(50),
  })
  .strict()
  .superRefine((input, context) => {
    const positions = new Set(input.modules.map(({ sort_order }) => sort_order));
    if (positions.size !== input.modules.length) {
      context.addIssue({ code: 'custom', message: 'Module sort orders must be unique' });
    }
  });

export const publishPageSchema = z
  .object({
    confirmation_code: catalogCodeSchema,
    expected_version: z.number().int().positive(),
  })
  .strict();

export type CatalogLocalizationInput = z.infer<typeof catalogLocalizationSchema>;
export type AttributeTemplateVersionInput = z.infer<typeof attributeTemplateVersionInputSchema>;
export type CreateAttributeTemplateInput = z.infer<typeof createAttributeTemplateSchema>;
export type CreateBrandInput = z.infer<typeof createBrandSchema>;
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type CreateProductDraftInput = z.infer<typeof createProductDraftSchema>;
export type ConfirmMediaUploadInput = z.infer<typeof confirmMediaUploadSchema>;
export type CreatePageDraftInput = z.infer<typeof createPageDraftSchema>;
export type MediaUploadInput = z.infer<typeof mediaUploadInputSchema>;
export type ProductMediaInput = z.infer<typeof productMediaInputSchema>;
export type PublishPageInput = z.infer<typeof publishPageSchema>;
export type PublicBrandListQuery = z.infer<typeof publicBrandListQuerySchema>;
export type PublicCatalogLocaleQuery = z.infer<typeof publicCatalogLocaleQuerySchema>;
export type PublicProductListQuery = z.infer<typeof publicProductListQuerySchema>;
export type ReplacePageDraftInput = z.infer<typeof replacePageDraftSchema>;
export type ReplaceProductSkusInput = z.infer<typeof replaceProductSkusSchema>;
export type ReviewComplianceRecordInput = z.infer<typeof reviewComplianceRecordSchema>;
export type SkuDraftInput = z.infer<typeof skuDraftSchema>;
export type SubmitComplianceRecordInput = z.infer<typeof submitComplianceRecordSchema>;
export type UpdateBrandInput = z.infer<typeof updateBrandSchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
export type UpdateAttributeTemplateVersionInput = z.infer<
  typeof updateAttributeTemplateVersionSchema
>;
