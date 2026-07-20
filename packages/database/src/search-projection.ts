import { normalizeSearchDocumentText, SUPPORTED_LOCALES, type Locale } from '@zalo-shop/domain';

import type { StoreTransaction } from './index';

function localizedLabel(
  source: { labelEn: string | null; labelVi: string; labelZh: string | null },
  locale: Locale,
): string {
  return (
    (locale === 'en' ? source.labelEn : locale === 'zh' ? source.labelZh : source.labelVi) ??
    source.labelVi
  );
}

function scalarValue(value: {
  booleanValue: boolean | null;
  dateValue: Date | null;
  decimalValue: { toString(): string } | null;
  integerValue: bigint | null;
  textValue: string | null;
}): string | undefined {
  if (value.textValue !== null) return value.textValue;
  if (value.integerValue !== null) return value.integerValue.toString();
  if (value.decimalValue !== null) return value.decimalValue.toString();
  if (value.booleanValue !== null) return value.booleanValue ? 'true' : 'false';
  if (value.dateValue !== null) return value.dateValue.toISOString().slice(0, 10);
  return undefined;
}

export async function syncProductSearchProjection(
  transaction: StoreTransaction,
  storeId: string,
  productId: string,
): Promise<number> {
  const product = await transaction.product.findUnique({
    include: {
      brands: { include: { brand_localizations: true } },
      categories: {
        include: {
          categories: { include: { category_localizations: true } },
          category_localizations: true,
        },
      },
      product_attribute_values: {
        include: { attribute_definitions: true, attribute_options: true },
      },
      product_localizations: true,
      product_secondary_categories: {
        include: {
          categories: {
            include: {
              categories: { include: { category_localizations: true } },
              category_localizations: true,
            },
          },
        },
      },
      product_versions: {
        orderBy: { version: 'desc' },
        take: 1,
        where: { publicationStatus: 'PUBLISHED' },
      },
      skus: {
        include: {
          sku_option_values: {
            include: { attribute_definitions: true, attribute_options: true },
          },
        },
        where: { status: 'ACTIVE' },
      },
    },
    where: { storeId_id: { id: productId, storeId } },
  });

  const vietnamese = product?.product_localizations.find(({ locale }) => locale === 'vi');
  const publishedVersion = product?.product_versions[0];
  const visible =
    product?.status === 'PUBLISHED' &&
    product.enabled &&
    product.deletedAt === null &&
    product.brands.status === 'ACTIVE' &&
    product.brands.deletedAt === null &&
    product.categories.status === 'ACTIVE' &&
    product.categories.deletedAt === null &&
    product.skus.length > 0 &&
    vietnamese !== undefined &&
    publishedVersion !== undefined &&
    (product.publishedAt ?? publishedVersion.publishedAt) !== null;

  if (!product || !visible || !vietnamese || !publishedVersion) {
    await transaction.productSearchDocument.deleteMany({ where: { productId, storeId } });
    return 0;
  }

  const publishedAt = product.publishedAt ?? publishedVersion.publishedAt!;
  const minimumSalePriceVnd = product.skus.reduce(
    (minimum, sku) => (sku.salePriceVnd < minimum ? sku.salePriceVnd : minimum),
    product.skus[0]!.salePriceVnd,
  );
  const activeSecondaryCategories = product.product_secondary_categories
    .map(({ categories }) => categories)
    .filter((category) => category.status === 'ACTIVE' && category.deletedAt === null);
  const categoryIds = [
    ...new Set([
      product.mainCategoryId,
      ...(product.categories.parentId ? [product.categories.parentId] : []),
      ...activeSecondaryCategories.map(({ id }) => id),
      ...activeSecondaryCategories.flatMap(({ parentId }) => (parentId ? [parentId] : [])),
    ]),
  ].sort();

  for (const locale of SUPPORTED_LOCALES) {
    const localization =
      product.product_localizations.find((candidate) => candidate.locale === locale) ?? vietnamese;
    const brandLocalization =
      product.brands.brand_localizations.find((candidate) => candidate.locale === locale) ??
      product.brands.brand_localizations.find((candidate) => candidate.locale === 'vi');
    const categoryLocalization =
      product.categories.category_localizations.find((candidate) => candidate.locale === locale) ??
      product.categories.category_localizations.find((candidate) => candidate.locale === 'vi');
    if (!brandLocalization || !categoryLocalization) {
      await transaction.productSearchDocument.deleteMany({
        where: { locale, productId, storeId },
      });
      continue;
    }

    const displayParts = [
      localization.name,
      localization.subtitle,
      localization.sellingPoints,
      brandLocalization.name,
      categoryLocalization.name,
    ];
    const mainParentLocalization =
      product.categories.categories?.category_localizations.find(
        (candidate) => candidate.locale === locale,
      ) ??
      product.categories.categories?.category_localizations.find(
        (candidate) => candidate.locale === 'vi',
      );
    if (mainParentLocalization) displayParts.push(mainParentLocalization.name);
    for (const category of activeSecondaryCategories) {
      const translated =
        category.category_localizations.find((candidate) => candidate.locale === locale) ??
        category.category_localizations.find((candidate) => candidate.locale === 'vi');
      if (translated) displayParts.push(translated.name);
      const parentTranslated =
        category.categories?.category_localizations.find(
          (candidate) => candidate.locale === locale,
        ) ??
        category.categories?.category_localizations.find((candidate) => candidate.locale === 'vi');
      if (parentTranslated) displayParts.push(parentTranslated.name);
    }

    const filterValues = new Map<string, Set<string>>();
    const addFilter = (code: string, value: string, display: string): void => {
      filterValues.set(code, (filterValues.get(code) ?? new Set()).add(value));
      displayParts.push(display);
    };
    for (const value of product.product_attribute_values) {
      const definition = value.attribute_definitions;
      if (!definition.filterable || (value.locale && ![locale, 'vi'].includes(value.locale))) {
        continue;
      }
      if (value.attribute_options?.status === 'ACTIVE') {
        addFilter(
          definition.code,
          value.attribute_options.code,
          localizedLabel(value.attribute_options, locale),
        );
      } else {
        const scalar = scalarValue(value);
        if (scalar) addFilter(definition.code, scalar.toLocaleLowerCase('vi-VN'), scalar);
      }
    }
    for (const sku of product.skus) {
      for (const value of sku.sku_option_values) {
        if (
          !value.attribute_definitions.filterable ||
          value.attribute_options.status !== 'ACTIVE'
        ) {
          continue;
        }
        addFilter(
          value.attribute_definitions.code,
          value.attribute_options.code,
          localizedLabel(value.attribute_options, locale),
        );
      }
    }

    const normalized = normalizeSearchDocumentText(displayParts.filter(Boolean).join(' '));
    const serializedFilters = Object.fromEntries(
      [...filterValues.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([code, values]) => [code, [...values].sort()]),
    );
    await transaction.productSearchDocument.upsert({
      create: {
        brandId: product.brandId,
        canonicalText: normalized.canonical,
        categoryIds,
        displayText: normalized.display,
        filterValues: serializedFilters,
        foldedText: normalized.folded,
        locale,
        mainCategoryId: product.mainCategoryId,
        minimumSalePriceVnd,
        productId,
        publishedAt,
        sourceVersion: publishedVersion.version,
        storeId,
      },
      update: {
        brandId: product.brandId,
        canonicalText: normalized.canonical,
        categoryIds,
        displayText: normalized.display,
        filterValues: serializedFilters,
        foldedText: normalized.folded,
        mainCategoryId: product.mainCategoryId,
        minimumSalePriceVnd,
        publishedAt,
        sourceVersion: publishedVersion.version,
      },
      where: { storeId_productId_locale: { locale, productId, storeId } },
    });
  }
  return SUPPORTED_LOCALES.length;
}

export async function syncProductsSearchProjection(
  transaction: StoreTransaction,
  storeId: string,
  productIds: readonly string[],
): Promise<number> {
  let documentCount = 0;
  for (const productId of [...new Set(productIds)].sort()) {
    documentCount += await syncProductSearchProjection(transaction, storeId, productId);
  }
  return documentCount;
}

export async function rebuildStoreSearchProjection(
  transaction: StoreTransaction,
  storeId: string,
): Promise<{ documentCount: number; productCount: number }> {
  const products = await transaction.product.findMany({
    orderBy: { id: 'asc' },
    select: { id: true },
    where: { storeId },
  });
  await transaction.productSearchDocument.deleteMany({ where: { storeId } });
  const documentCount = await syncProductsSearchProjection(
    transaction,
    storeId,
    products.map(({ id }) => id),
  );
  return { documentCount, productCount: products.length };
}
