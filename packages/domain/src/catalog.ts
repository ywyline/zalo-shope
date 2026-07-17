import type { Locale } from './index';

const CATALOG_LOCALES: readonly Locale[] = ['vi', 'zh', 'en'];

export type CatalogRuleErrorCode =
  | 'CATEGORY_CYCLE'
  | 'CATEGORY_DEPTH_EXCEEDED'
  | 'CATEGORY_IDENTIFIER_INVALID'
  | 'SKU_ATTRIBUTE_DUPLICATED'
  | 'SKU_OPTION_IDENTIFIER_INVALID'
  | 'SKU_OPTIONS_REQUIRED';

export class CatalogRuleError extends Error {
  public constructor(public readonly code: CatalogRuleErrorCode) {
    super(code);
    this.name = 'CatalogRuleError';
  }
}

export type CategoryPlacementInput = Readonly<{
  categoryId: string;
  maxDepth: number;
  /** Immediate parent first, followed by each ancestor up to the root. */
  parentChain: readonly string[];
}>;

function normalizeIdentifier(value: string, errorCode: CatalogRuleErrorCode): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(normalized)) {
    throw new CatalogRuleError(errorCode);
  }
  return normalized;
}

export function validateCategoryPlacement(
  input: CategoryPlacementInput,
): Readonly<{ depth: number }> {
  const categoryId = normalizeIdentifier(input.categoryId, 'CATEGORY_IDENTIFIER_INVALID');
  if (!Number.isInteger(input.maxDepth) || input.maxDepth < 1) {
    throw new CatalogRuleError('CATEGORY_DEPTH_EXCEEDED');
  }

  const ancestors = input.parentChain.map((id) =>
    normalizeIdentifier(id, 'CATEGORY_IDENTIFIER_INVALID'),
  );
  const uniqueAncestors = new Set(ancestors);
  if (uniqueAncestors.size !== ancestors.length || uniqueAncestors.has(categoryId)) {
    throw new CatalogRuleError('CATEGORY_CYCLE');
  }

  const depth = ancestors.length + 1;
  if (depth > input.maxDepth) {
    throw new CatalogRuleError('CATEGORY_DEPTH_EXCEEDED');
  }
  return Object.freeze({ depth });
}

export type SkuOptionSelection = Readonly<{
  attributeCode: string;
  optionCode: string;
}>;

export function canonicalSkuCombinationKey(selections: readonly SkuOptionSelection[]): string {
  if (selections.length === 0) {
    throw new CatalogRuleError('SKU_OPTIONS_REQUIRED');
  }

  const normalized = selections.map((selection) => ({
    attributeCode: normalizeIdentifier(selection.attributeCode, 'SKU_OPTION_IDENTIFIER_INVALID'),
    optionCode: normalizeIdentifier(selection.optionCode, 'SKU_OPTION_IDENTIFIER_INVALID'),
  }));
  const attributeCodes = new Set(normalized.map((selection) => selection.attributeCode));
  if (attributeCodes.size !== normalized.length) {
    throw new CatalogRuleError('SKU_ATTRIBUTE_DUPLICATED');
  }

  return normalized
    .sort((left, right) => left.attributeCode.localeCompare(right.attributeCode, 'en'))
    .map((selection) => `${selection.attributeCode}=${selection.optionCode}`)
    .join('&');
}

export type CatalogTranslationField = 'description' | 'name' | 'sellingPoints';
export type CatalogLocalization = Partial<Record<CatalogTranslationField, string>>;

export type CatalogTranslationAssessment = Readonly<{
  completeLocales: readonly Locale[];
  missingByLocale: Readonly<Record<Locale, readonly CatalogTranslationField[]>>;
  publishableInVietnamese: boolean;
}>;

function hasText(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

export function assessCatalogTranslations(input: {
  localizations: Partial<Record<Locale, CatalogLocalization>>;
  requiredFields: readonly CatalogTranslationField[];
}): CatalogTranslationAssessment {
  const missingByLocale = Object.fromEntries(
    CATALOG_LOCALES.map((locale) => {
      const localization = input.localizations[locale];
      const missing = input.requiredFields.filter((field) => !hasText(localization?.[field]));
      return [locale, Object.freeze([...missing])];
    }),
  ) as Record<Locale, readonly CatalogTranslationField[]>;
  const completeLocales = CATALOG_LOCALES.filter((locale) => missingByLocale[locale].length === 0);

  return Object.freeze({
    completeLocales: Object.freeze([...completeLocales]),
    missingByLocale: Object.freeze(missingByLocale),
    publishableInVietnamese: missingByLocale.vi.length === 0,
  });
}

export type ComplianceReviewStatus = 'APPROVED' | 'PENDING_REVIEW' | 'REJECTED';

export type ProductPublicationCandidate = Readonly<{
  brandEnabled: boolean;
  complianceRecords: readonly Readonly<{
    expiresAt?: Date;
    requirementCode: string;
    reviewedBy?: string;
    status: ComplianceReviewStatus;
    submittedBy: string;
  }>[];
  enabled: boolean;
  mainCategoryEnabled: boolean;
  primaryMediaReady: boolean;
  productAttributeCodes: readonly string[];
  requiredAttributeCodes: readonly string[];
  requiredComplianceCodes: readonly string[];
  skus: readonly Readonly<{
    enabled: boolean;
    optionCombinationKey: string;
    salePriceVnd: number;
  }>[];
  translations: CatalogLocalization;
}>;

export type ProductPublicationIssueCode =
  | 'ATTRIBUTE_REQUIRED'
  | 'BRAND_DISABLED'
  | 'COMPLIANCE_EXPIRED'
  | 'COMPLIANCE_MISSING'
  | 'COMPLIANCE_NOT_APPROVED'
  | 'COMPLIANCE_REVIEWER_CONFLICT'
  | 'MAIN_CATEGORY_DISABLED'
  | 'PRIMARY_MEDIA_REQUIRED'
  | 'PRODUCT_DISABLED'
  | 'SKU_OPTIONS_REQUIRED'
  | 'SKU_PRICE_INVALID'
  | 'SKU_REQUIRED'
  | 'VI_TRANSLATION_MISSING';

export type ProductPublicationIssue = Readonly<{
  code: ProductPublicationIssueCode;
  reference?: string;
}>;

export type ProductPublicationDecision = Readonly<{
  canPublish: boolean;
  issues: readonly ProductPublicationIssue[];
}>;

function issue(code: ProductPublicationIssueCode, reference?: string): ProductPublicationIssue {
  return Object.freeze({ code, ...(reference === undefined ? {} : { reference }) });
}

export function evaluateProductPublication(
  candidate: ProductPublicationCandidate,
  now = new Date(),
): ProductPublicationDecision {
  const issues: ProductPublicationIssue[] = [];
  if (!candidate.enabled) issues.push(issue('PRODUCT_DISABLED'));
  if (!candidate.brandEnabled) issues.push(issue('BRAND_DISABLED'));
  if (!candidate.mainCategoryEnabled) issues.push(issue('MAIN_CATEGORY_DISABLED'));

  const requiredTranslationFields: readonly CatalogTranslationField[] = [
    'name',
    'sellingPoints',
    'description',
  ];
  for (const field of requiredTranslationFields) {
    if (!hasText(candidate.translations[field])) {
      issues.push(issue('VI_TRANSLATION_MISSING', field));
    }
  }
  if (!candidate.primaryMediaReady) issues.push(issue('PRIMARY_MEDIA_REQUIRED'));

  const enabledSkus = candidate.skus
    .map((sku, index) => ({ index, sku }))
    .filter(({ sku }) => sku.enabled);
  if (enabledSkus.length === 0) {
    issues.push(issue('SKU_REQUIRED'));
  } else {
    enabledSkus.forEach(({ index, sku }) => {
      if (!Number.isSafeInteger(sku.salePriceVnd) || sku.salePriceVnd < 0) {
        issues.push(issue('SKU_PRICE_INVALID', String(index)));
      }
      if (!hasText(sku.optionCombinationKey)) {
        issues.push(issue('SKU_OPTIONS_REQUIRED', String(index)));
      }
    });
  }

  const assignedAttributes = new Set(candidate.productAttributeCodes);
  for (const attributeCode of candidate.requiredAttributeCodes) {
    if (!assignedAttributes.has(attributeCode)) {
      issues.push(issue('ATTRIBUTE_REQUIRED', attributeCode));
    }
  }

  for (const requirementCode of candidate.requiredComplianceCodes) {
    const record = candidate.complianceRecords.find(
      (candidateRecord) => candidateRecord.requirementCode === requirementCode,
    );
    if (!record) {
      issues.push(issue('COMPLIANCE_MISSING', requirementCode));
      continue;
    }
    if (record.status !== 'APPROVED' || !hasText(record.reviewedBy)) {
      issues.push(issue('COMPLIANCE_NOT_APPROVED', requirementCode));
      continue;
    }
    if (record.expiresAt !== undefined && record.expiresAt.getTime() <= now.getTime()) {
      issues.push(issue('COMPLIANCE_EXPIRED', requirementCode));
    }
    if (record.reviewedBy === record.submittedBy) {
      issues.push(issue('COMPLIANCE_REVIEWER_CONFLICT', requirementCode));
    }
  }

  return Object.freeze({ canPublish: issues.length === 0, issues: Object.freeze(issues) });
}
