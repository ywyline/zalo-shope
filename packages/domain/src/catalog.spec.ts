import { describe, expect, it } from 'vitest';

import {
  assessCatalogTranslations,
  canonicalSkuCombinationKey,
  CatalogRuleError,
  evaluateProductPublication,
  validateCategoryPlacement,
  type ProductPublicationCandidate,
} from './catalog';

describe('M2 category tree rules', () => {
  it('accepts a root category and a second-level category', () => {
    expect(
      validateCategoryPlacement({ categoryId: 'skin-care', parentChain: [], maxDepth: 2 }),
    ).toEqual({ depth: 1 });
    expect(
      validateCategoryPlacement({
        categoryId: 'cleanser',
        parentChain: ['skin-care'],
        maxDepth: 2,
      }),
    ).toEqual({ depth: 2 });
  });

  it('rejects self references, cycles and trees deeper than the configured limit', () => {
    expect(() =>
      validateCategoryPlacement({
        categoryId: 'skin-care',
        parentChain: ['skin-care'],
        maxDepth: 2,
      }),
    ).toThrowError(new CatalogRuleError('CATEGORY_CYCLE'));
    expect(() =>
      validateCategoryPlacement({
        categoryId: 'cleanser',
        parentChain: ['skin-care', 'skin-care'],
        maxDepth: 3,
      }),
    ).toThrowError(new CatalogRuleError('CATEGORY_CYCLE'));
    expect(() =>
      validateCategoryPlacement({
        categoryId: 'foam-cleanser',
        parentChain: ['cleanser', 'skin-care'],
        maxDepth: 2,
      }),
    ).toThrowError(new CatalogRuleError('CATEGORY_DEPTH_EXCEEDED'));
  });
});

describe('M2 SKU specification combinations', () => {
  it('creates the same canonical key regardless of option order', () => {
    const first = canonicalSkuCombinationKey([
      { attributeCode: 'size', optionCode: 'm' },
      { attributeCode: 'color', optionCode: 'coral' },
    ]);
    const second = canonicalSkuCombinationKey([
      { attributeCode: 'color', optionCode: 'coral' },
      { attributeCode: 'size', optionCode: 'm' },
    ]);

    expect(first).toBe('color=coral&size=m');
    expect(second).toBe(first);
  });

  it('rejects missing options and duplicate specification attributes', () => {
    expect(() => canonicalSkuCombinationKey([])).toThrowError(
      new CatalogRuleError('SKU_OPTIONS_REQUIRED'),
    );
    expect(() =>
      canonicalSkuCombinationKey([
        { attributeCode: 'size', optionCode: 'm' },
        { attributeCode: 'size', optionCode: 'l' },
      ]),
    ).toThrowError(new CatalogRuleError('SKU_ATTRIBUTE_DUPLICATED'));
  });
});

describe('M2 catalog translation completeness', () => {
  const requiredFields = ['name', 'sellingPoints', 'description'] as const;

  it('requires Vietnamese for publication and reports other locale completeness', () => {
    const result = assessCatalogTranslations({
      localizations: {
        en: { description: '', name: 'Serum', sellingPoints: '' },
        vi: {
          description: 'Mô tả sản phẩm',
          name: 'Tinh chất dưỡng da',
          sellingPoints: 'Dịu nhẹ',
        },
        zh: { description: '', name: '', sellingPoints: '' },
      },
      requiredFields,
    });

    expect(result.publishableInVietnamese).toBe(true);
    expect(result.missingByLocale.vi).toEqual([]);
    expect(result.missingByLocale.en).toEqual(['sellingPoints', 'description']);
    expect(result.missingByLocale.zh).toEqual(requiredFields);
    expect(result.completeLocales).toEqual(['vi']);
  });

  it('blocks publication when a required Vietnamese field is blank', () => {
    const result = assessCatalogTranslations({
      localizations: {
        vi: { description: 'Mô tả', name: 'Kem chống nắng', sellingPoints: ' ' },
      },
      requiredFields,
    });

    expect(result.publishableInVietnamese).toBe(false);
    expect(result.missingByLocale.vi).toEqual(['sellingPoints']);
  });
});

describe('M2 product publication gate', () => {
  const now = new Date('2026-07-17T00:00:00.000Z');
  const readyCandidate: ProductPublicationCandidate = {
    brandEnabled: true,
    complianceRecords: [
      {
        expiresAt: new Date('2027-07-17T00:00:00.000Z'),
        requirementCode: 'vn-cosmetic-declaration',
        reviewedBy: 'reviewer-1',
        status: 'APPROVED',
        submittedBy: 'operator-1',
      },
    ],
    enabled: true,
    mainCategoryEnabled: true,
    primaryMediaReady: true,
    productAttributeCodes: ['skin-type', 'inci'],
    requiredAttributeCodes: ['skin-type', 'inci'],
    requiredComplianceCodes: ['vn-cosmetic-declaration'],
    skus: [
      {
        enabled: true,
        optionCombinationKey: 'color=coral',
        salePriceVnd: 249_000,
      },
    ],
    translations: {
      description: 'Mô tả sản phẩm',
      name: 'Tinh chất dưỡng da',
      sellingPoints: 'Dịu nhẹ',
    },
  };

  it('allows a complete product and returns no hidden partial success', () => {
    expect(evaluateProductPublication(readyCandidate, now)).toEqual({
      canPublish: true,
      issues: [],
    });
  });

  it('returns stable, explainable issues for incomplete product content', () => {
    const result = evaluateProductPublication(
      {
        ...readyCandidate,
        brandEnabled: false,
        primaryMediaReady: false,
        productAttributeCodes: ['skin-type'],
        skus: [{ enabled: true, optionCombinationKey: '', salePriceVnd: 249_000.5 }],
        translations: { ...readyCandidate.translations, sellingPoints: '' },
      },
      now,
    );

    expect(result.canPublish).toBe(false);
    expect(result.issues).toEqual([
      { code: 'BRAND_DISABLED' },
      { code: 'VI_TRANSLATION_MISSING', reference: 'sellingPoints' },
      { code: 'PRIMARY_MEDIA_REQUIRED' },
      { code: 'SKU_PRICE_INVALID', reference: '0' },
      { code: 'SKU_OPTIONS_REQUIRED', reference: '0' },
      { code: 'ATTRIBUTE_REQUIRED', reference: 'inci' },
    ]);
  });

  it('rejects expired, unapproved or self-reviewed blocking compliance records', () => {
    const expired = evaluateProductPublication(
      {
        ...readyCandidate,
        complianceRecords: [
          {
            expiresAt: new Date('2026-07-16T23:59:59.000Z'),
            requirementCode: 'vn-cosmetic-declaration',
            reviewedBy: 'operator-1',
            status: 'APPROVED',
            submittedBy: 'operator-1',
          },
        ],
      },
      now,
    );
    expect(expired.issues).toEqual([
      { code: 'COMPLIANCE_EXPIRED', reference: 'vn-cosmetic-declaration' },
      { code: 'COMPLIANCE_REVIEWER_CONFLICT', reference: 'vn-cosmetic-declaration' },
    ]);

    const pending = evaluateProductPublication(
      {
        ...readyCandidate,
        complianceRecords: [
          {
            requirementCode: 'vn-cosmetic-declaration',
            reviewedBy: undefined,
            status: 'PENDING_REVIEW',
            submittedBy: 'operator-1',
          },
        ],
      },
      now,
    );
    expect(pending.issues).toEqual([
      { code: 'COMPLIANCE_NOT_APPROVED', reference: 'vn-cosmetic-declaration' },
    ]);
  });
});
