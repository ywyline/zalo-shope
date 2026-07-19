import { describe, expect, it } from 'vitest';

import {
  accessReasonSchema,
  batchDisableProductsSchema,
  batchMoveProductsSchema,
  catalogCodeSchema,
  catalogLocalizationsSchema,
  complianceOverviewQuerySchema,
  consentEventSchema,
  createAttributeTemplateSchema,
  createBrandSchema,
  createCategorySchema,
  createProductDraftSchema,
  pageModuleInputSchema,
  productImportQuerySchema,
  publishPageSchema,
  publicBrandListQuerySchema,
  publicProductListQuerySchema,
  replaceProductAttributesSchema,
  replacePageDraftSchema,
  mediaUploadInputSchema,
  memberPreferenceSchema,
  reviewComplianceRecordSchema,
  skuDraftSchema,
  submitComplianceRecordSchema,
} from './index';

describe('M1 API contracts', () => {
  it('accepts only supported locales', () => {
    expect(memberPreferenceSchema.parse({ locale: 'vi' })).toEqual({ locale: 'vi' });
    expect(() => memberPreferenceSchema.parse({ locale: 'fr' })).toThrow();
  });

  it('requires an explicit cross-store access reason', () => {
    expect(accessReasonSchema.parse('Investigate incident INC-123')).toBe(
      'Investigate incident INC-123',
    );
    expect(() => accessReasonSchema.parse('short')).toThrow();
  });

  it('requires an idempotent consent event identifier', () => {
    expect(() =>
      consentEventSchema.parse({
        event_id: 'not-a-uuid',
        policy_version: 'privacy-v1',
        purpose: 'PRIVACY',
        source: 'MANUAL',
        status: 'GRANTED',
      }),
    ).toThrow();
  });
});

describe('M2 catalog API contracts', () => {
  it('bounds and validates the M2.8.2 compliance overview query', () => {
    expect(complianceOverviewQuerySchema.parse({ limit: '25', status: 'PENDING_REVIEW' })).toEqual({
      limit: 25,
      status: 'PENDING_REVIEW',
    });
    expect(() => complianceOverviewQuerySchema.parse({ limit: '0' })).toThrow();
    expect(() => complianceOverviewQuerySchema.parse({ limit: '101' })).toThrow();
    expect(() => complianceOverviewQuerySchema.parse({ product_id: 'foreign' })).toThrow();
    expect(() => complianceOverviewQuerySchema.parse({ include_files: 'true' })).toThrow();
  });

  it('bounds M2.7 batch commands and parses dry-run without Boolean coercion surprises', () => {
    const product = {
      expected_version: 1,
      product_id: '11111111-1111-4111-8111-111111111111',
    };
    expect(productImportQuerySchema.parse({ dry_run: 'false' })).toEqual({ dry_run: false });
    expect(
      batchDisableProductsSchema.parse({ confirmation_code: 'DISABLE', items: [product] }),
    ).toMatchObject({ items: [product] });
    expect(() =>
      batchMoveProductsSchema.parse({
        confirmation_code: 'MOVE',
        items: [product, product],
        main_category_id: '22222222-2222-4222-8222-222222222222',
      }),
    ).toThrow();
    expect(() =>
      batchDisableProductsSchema.parse({ confirmation_code: 'disable', items: [product] }),
    ).toThrow();
  });

  it('normalizes stable business codes and rejects unsafe identifiers', () => {
    expect(catalogCodeSchema.parse('  SERUM-01  ')).toBe('serum-01');
    expect(() => catalogCodeSchema.parse('../other-store')).toThrow();
  });

  it('requires exactly one Vietnamese localization for publishable content inputs', () => {
    expect(
      catalogLocalizationsSchema.parse([
        { description: 'Mô tả', locale: 'vi', name: 'Tinh chất', selling_points: 'Dịu nhẹ' },
        { description: null, locale: 'en', name: 'Serum', selling_points: null },
      ]),
    ).toHaveLength(2);
    expect(() =>
      catalogLocalizationsSchema.parse([
        { description: 'Một', locale: 'vi', name: 'Tên một', selling_points: 'A' },
        { description: 'Hai', locale: 'vi', name: 'Tên hai', selling_points: 'B' },
      ]),
    ).toThrow();
    expect(() =>
      catalogLocalizationsSchema.parse([
        { description: 'Description', locale: 'en', name: 'Serum', selling_points: 'Gentle' },
      ]),
    ).toThrow();
  });

  it('does not accept store ownership from product request bodies', () => {
    const input = {
      brand_id: '11111111-1111-4111-8111-111111111111',
      code: 'serum-01',
      localizations: [
        { description: 'Mô tả', locale: 'vi', name: 'Tinh chất', selling_points: 'Dịu nhẹ' },
      ],
      main_category_id: '22222222-2222-4222-8222-222222222222',
      store_id: '33333333-3333-4333-8333-333333333333',
    };

    expect(() => createProductDraftSchema.parse(input)).toThrow();
  });

  it('rejects store ownership from every M2.3 administrative body', () => {
    const localization = [{ locale: 'vi' as const, name: 'Tên' }];
    expect(() =>
      createBrandSchema.parse({ code: 'brand', localizations: localization, store_id: 'hidden' }),
    ).toThrow();
    expect(() =>
      createCategorySchema.parse({
        code: 'category',
        localizations: localization,
        store_id: 'hidden',
      }),
    ).toThrow();
    expect(() =>
      createAttributeTemplateSchema.parse({
        code: 'template',
        definitions: [
          {
            code: 'size',
            data_type: 'OPTION',
            label_vi: 'Kích cỡ',
            options: [{ code: 'm', label_vi: 'M' }],
            purpose: 'SPECIFICATION',
          },
        ],
        name: 'Template',
        store_id: 'hidden',
      }),
    ).toThrow();
  });

  it('requires integer VND prices and a non-empty option combination for SKU drafts', () => {
    expect(
      skuDraftSchema.parse({
        code: 'serum-coral',
        enabled: true,
        market_price_vnd: 299_000,
        option_values: [
          {
            attribute_code: 'color',
            option_code: 'coral',
          },
        ],
        sale_price_vnd: 249_000,
      }),
    ).toMatchObject({ sale_price_vnd: 249_000 });
    expect(() =>
      skuDraftSchema.parse({
        code: 'serum-coral',
        enabled: true,
        option_values: [],
        sale_price_vnd: 249_000.5,
      }),
    ).toThrow();
  });

  it('validates typed product attribute replacement values without numeric precision loss', () => {
    const parsed = replaceProductAttributesSchema.parse({
      expected_version: 3,
      values: [
        { attribute_code: 'benefit', data_type: 'TEXT', locale: 'vi', value: '  Dịu nhẹ  ' },
        { attribute_code: 'spf', data_type: 'INTEGER', value: 50 },
        { attribute_code: 'volume', data_type: 'DECIMAL', value: '30.50000000' },
        { attribute_code: 'vegan', data_type: 'BOOLEAN', value: false },
        { attribute_code: 'available-on', data_type: 'DATE', value: '2026-07-19' },
        { attribute_code: 'finish', data_type: 'OPTION', option_code: 'matte' },
      ],
    });
    expect(parsed.values).toHaveLength(6);
    expect(parsed.values[0]).toEqual({
      attribute_code: 'benefit',
      data_type: 'TEXT',
      locale: 'vi',
      value: 'Dịu nhẹ',
    });

    expect(() =>
      replaceProductAttributesSchema.parse({
        expected_version: 3,
        values: [{ attribute_code: 'volume', data_type: 'DECIMAL', value: 30.5 }],
      }),
    ).toThrow();
    expect(() =>
      replaceProductAttributesSchema.parse({
        expected_version: 3,
        values: [{ attribute_code: 'available-on', data_type: 'DATE', value: '2026-02-30' }],
      }),
    ).toThrow();
    expect(() =>
      replaceProductAttributesSchema.parse({
        expected_version: 3,
        values: [
          { attribute_code: 'benefit', data_type: 'TEXT', locale: 'vi', value: 'Dịu nhẹ' },
          { attribute_code: 'benefit', data_type: 'TEXT', locale: 'vi', value: 'Dịu nhẹ' },
        ],
      }),
    ).toThrow();
    expect(() =>
      replaceProductAttributesSchema.parse({
        expected_version: 3,
        store_id: '10000000-0000-4000-8000-000000000001',
        values: [],
      }),
    ).toThrow();
  });

  it('rejects unsafe media metadata and store ownership in compliance commands', () => {
    expect(
      mediaUploadInputSchema.parse({
        byte_size: 128,
        checksum_sha256: 'a'.repeat(64),
        filename: 'hero.webp',
        mime_type: 'image/webp',
        resource: 'product',
      }),
    ).toMatchObject({ filename: 'hero.webp' });
    expect(() =>
      mediaUploadInputSchema.parse({
        byte_size: 128,
        checksum_sha256: 'a'.repeat(64),
        filename: '../hero.webp',
        mime_type: 'image/jpeg',
        resource: 'product',
      }),
    ).toThrow();
    expect(() =>
      submitComplianceRecordSchema.parse({
        media_ids: ['11111111-1111-4111-8111-111111111111'],
        product_id: '22222222-2222-4222-8222-222222222222',
        requirement_id: '33333333-3333-4333-8333-333333333333',
        store_id: 'hidden',
      }),
    ).toThrow();
    expect(() =>
      reviewComplianceRecordSchema.parse({ decision: 'APPROVED', review_note: '' }),
    ).toThrow();
  });

  it('validates complete localized page modules and target shapes', () => {
    const localizations = [
      { locale: 'vi' as const, title: 'Bo suu tap moi' },
      { locale: 'zh' as const, title: 'New collection' },
      { locale: 'en' as const, title: 'New collection' },
    ];
    expect(
      pageModuleInputSchema.parse({
        localizations,
        module_type: 'HERO',
        sort_order: 0,
        target_id: '11111111-1111-4111-8111-111111111111',
        target_type: 'CATEGORY',
      }),
    ).toMatchObject({ module_type: 'HERO', status: 'ACTIVE' });
    expect(() =>
      pageModuleInputSchema.parse({
        localizations: localizations.slice(0, 2),
        module_type: 'HERO',
        sort_order: 0,
      }),
    ).toThrow();
    expect(() =>
      pageModuleInputSchema.parse({
        localizations,
        module_type: 'BANNER',
        sort_order: 0,
        target_type: 'EXTERNAL',
        target_url: 'http://unsafe.example',
      }),
    ).toThrow();
  });

  it('rejects ambiguous page ordering and requires explicit publish confirmation', () => {
    const module = {
      localizations: [
        { locale: 'vi' as const, title: 'Trang chu' },
        { locale: 'zh' as const, title: 'Home' },
        { locale: 'en' as const, title: 'Home' },
      ],
      module_type: 'RICH_TEXT' as const,
      sort_order: 0,
    };
    expect(() =>
      replacePageDraftSchema.parse({ expected_version: 1, modules: [module, module] }),
    ).toThrow();
    expect(publishPageSchema.parse({ confirmation_code: 'HOME', expected_version: 2 })).toEqual({
      confirmation_code: 'home',
      expected_version: 2,
    });
  });

  it('validates public catalog filters without coercing false to true', () => {
    expect(publicBrandListQuerySchema.parse({ recommended: 'false' })).toEqual({
      limit: 20,
      locale: 'vi',
      recommended: false,
    });
    expect(
      publicProductListQuerySchema.parse({
        brand_code: ' ATELIER ',
        category_code: 'BEAUTY',
        limit: '12',
        locale: 'en',
        sort: 'price_asc',
      }),
    ).toEqual({
      brand_code: 'atelier',
      category_code: 'beauty',
      limit: 12,
      locale: 'en',
      sort: 'price_asc',
    });
    expect(() => publicProductListQuerySchema.parse({ limit: '101' })).toThrow();
    expect(() => publicProductListQuerySchema.parse({ locale: 'fr' })).toThrow();
  });
});
