import { randomUUID } from 'node:crypto';

import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { RuntimeConfig } from '@zalo-shop/config';
import type { PublicBrandListQuery, PublicProductListQuery } from '@zalo-shop/contracts';
import { Prisma, type Locale, type MediaAsset, type PrismaClient } from '@zalo-shop/database';
import { withStoreTransaction, type StoreTransaction } from '@zalo-shop/database';
import { createStoreContext } from '@zalo-shop/domain';
import type { MediaStorageProvider } from '@zalo-shop/integrations';

import { DATABASE_CLIENT, MEDIA_STORAGE_PROVIDER } from '../auth/auth.tokens';
import { RUNTIME_CONFIG } from '../health.controller';

type ResolvedStore = {
  code: string;
  default_locale: Locale;
  id: string;
};

type BrandCursor = { id: string; sort_order: number };
type ProductCursor =
  | { id: string; published_at: string; sort: 'newest' }
  | { id: string; price_vnd: string; sort: 'price_asc' | 'price_desc' };
type ProductRow = { id: string; minimum_price_vnd: bigint; published_at: Date };

const brandInclude = {
  brand_localizations: true,
  brand_media: {
    include: { media_assets: true },
    orderBy: [{ sortOrder: 'asc' as const }, { mediaId: 'asc' as const }],
  },
} satisfies Prisma.BrandInclude;

const categoryInclude = {
  category_localizations: true,
  category_media: {
    include: { media_assets: true },
    orderBy: [{ sortOrder: 'asc' as const }, { mediaId: 'asc' as const }],
  },
} satisfies Prisma.CategoryInclude;

const productInclude = {
  brands: { include: brandInclude },
  categories: { include: categoryInclude },
  product_attribute_values: {
    include: { attribute_definitions: true, attribute_options: true },
    orderBy: { id: 'asc' as const },
  },
  product_localizations: true,
  product_media: {
    include: { media_assets: true },
    orderBy: [{ sortOrder: 'asc' as const }, { mediaId: 'asc' as const }],
  },
  skus: {
    include: {
      sku_media: {
        include: { media_assets: true },
        orderBy: [{ sortOrder: 'asc' as const }, { mediaId: 'asc' as const }],
      },
      sku_option_values: {
        include: { attribute_definitions: true, attribute_options: true },
      },
    },
    orderBy: { code: 'asc' as const },
    where: { status: 'ACTIVE' as const },
  },
} satisfies Prisma.ProductInclude;

type LoadedBrand = Prisma.BrandGetPayload<{ include: typeof brandInclude }>;
type LoadedCategory = Prisma.CategoryGetPayload<{ include: typeof categoryInclude }>;
type LoadedProduct = Prisma.ProductGetPayload<{ include: typeof productInclude }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function decodeCursor(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new BadRequestException('Cursor is invalid');
  }
}

function encodeCursor(value: BrandCursor | ProductCursor): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function brandCursor(value: string | undefined): BrandCursor | undefined {
  if (!value) return undefined;
  const decoded = decodeCursor(value);
  if (
    !isRecord(decoded) ||
    !isUuid(decoded.id) ||
    !Number.isSafeInteger(decoded.sort_order) ||
    Number(decoded.sort_order) < 0
  ) {
    throw new BadRequestException('Cursor is invalid');
  }
  return { id: decoded.id, sort_order: Number(decoded.sort_order) };
}

function productCursor(
  value: string | undefined,
  sort: PublicProductListQuery['sort'],
): ProductCursor | undefined {
  if (!value) return undefined;
  const decoded = decodeCursor(value);
  if (!isRecord(decoded) || !isUuid(decoded.id) || decoded.sort !== sort) {
    throw new BadRequestException('Cursor is invalid');
  }
  if (sort === 'newest') {
    if (
      typeof decoded.published_at !== 'string' ||
      Number.isNaN(Date.parse(decoded.published_at))
    ) {
      throw new BadRequestException('Cursor is invalid');
    }
    return { id: decoded.id, published_at: decoded.published_at, sort };
  }
  if (typeof decoded.price_vnd !== 'string' || !/^\d+$/.test(decoded.price_vnd)) {
    throw new BadRequestException('Cursor is invalid');
  }
  return { id: decoded.id, price_vnd: decoded.price_vnd, sort };
}

function resolveLocalization<T extends { locale: Locale }>(
  localizations: T[],
  requested: Locale,
): { localization: T; resolved: Locale } {
  const direct = localizations.find(({ locale }) => locale === requested);
  const vietnamese = localizations.find(({ locale }) => locale === 'vi');
  const localization = direct ?? vietnamese;
  if (!localization) throw new NotFoundException('Resource not found');
  return { localization, resolved: localization.locale };
}

function label(
  source: { labelEn: string | null; labelVi: string; labelZh: string | null },
  locale: Locale,
): string {
  return (
    (locale === 'en' ? source.labelEn : locale === 'zh' ? source.labelZh : source.labelVi) ??
    source.labelVi
  );
}

function safeVnd(value: bigint): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new TypeError('Stored VND amount is outside the supported safe integer range');
  }
  return amount;
}

function itemIds(config: unknown): string[] {
  if (!isRecord(config) || !Array.isArray(config.item_ids)) return [];
  return config.item_ids.filter(isUuid).slice(0, 24);
}

function sanitizeContentConfig(config: unknown): Record<string, unknown> {
  if (!isRecord(config)) return {};
  return {
    ...(typeof config.eyebrow === 'string' ? { eyebrow: config.eyebrow } : {}),
    ...(config.layout === 'CAROUSEL' || config.layout === 'GRID' || config.layout === 'STACK'
      ? { layout: config.layout }
      : {}),
  };
}

@Injectable()
export class CatalogService {
  public constructor(
    @Inject(DATABASE_CLIENT) private readonly database: PrismaClient,
    @Inject(MEDIA_STORAGE_PROVIDER) private readonly mediaStorage: MediaStorageProvider,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
  ) {}

  public async listBrands(storeCode: string, query: PublicBrandListQuery) {
    const { context, store } = await this.resolveContext(storeCode, query.locale);
    const cursor = brandCursor(query.cursor);
    return withStoreTransaction(this.database, context, async (transaction) => {
      const brands = await transaction.brand.findMany({
        include: brandInclude,
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        take: query.limit + 1,
        where: {
          deletedAt: null,
          ...(cursor
            ? {
                OR: [
                  { sortOrder: { gt: cursor.sort_order } },
                  { id: { gt: cursor.id }, sortOrder: cursor.sort_order },
                ],
              }
            : {}),
          ...(query.recommended === undefined ? {} : { recommended: query.recommended }),
          brand_localizations: { some: { locale: 'vi' } },
          status: 'ACTIVE',
          storeId: store.id,
        },
      });
      const visible = brands.slice(0, query.limit);
      const last = visible.at(-1);
      return {
        items: await Promise.all(visible.map((brand) => this.viewBrand(brand, query.locale))),
        next_cursor:
          brands.length > query.limit && last
            ? encodeCursor({ id: last.id, sort_order: last.sortOrder })
            : null,
      };
    });
  }

  public async getBrand(storeCode: string, code: string, locale: Locale) {
    const { context, store } = await this.resolveContext(storeCode, locale);
    return withStoreTransaction(this.database, context, async (transaction) => {
      const brand = await transaction.brand.findFirst({
        include: brandInclude,
        where: {
          brand_localizations: { some: { locale: 'vi' } },
          code,
          deletedAt: null,
          status: 'ACTIVE',
          storeId: store.id,
        },
      });
      if (!brand) throw new NotFoundException('Resource not found');
      return this.viewBrand(brand, locale);
    });
  }

  public async categories(storeCode: string, locale: Locale) {
    const { context, store } = await this.resolveContext(storeCode, locale);
    return withStoreTransaction(this.database, context, async (transaction) => {
      const categories = await transaction.category.findMany({
        include: categoryInclude,
        orderBy: [{ depth: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
        where: {
          category_localizations: { some: { locale: 'vi' } },
          deletedAt: null,
          status: 'ACTIVE',
          storeId: store.id,
        },
      });
      const children = new Map<string, LoadedCategory[]>();
      for (const category of categories) {
        if (!category.parentId) continue;
        children.set(category.parentId, [...(children.get(category.parentId) ?? []), category]);
      }
      return Promise.all(
        categories
          .filter(({ depth, parentId }) => depth === 1 && parentId === null)
          .map((category) => this.viewCategory(category, locale, children.get(category.id) ?? [])),
      );
    });
  }

  public async listProducts(storeCode: string, query: PublicProductListQuery) {
    const { context, store } = await this.resolveContext(storeCode, query.locale);
    const cursor = productCursor(query.cursor, query.sort);
    return withStoreTransaction(this.database, context, async (transaction) => {
      const rows = await this.productRows(transaction, store.id, query, cursor);
      const visibleRows = rows.slice(0, query.limit);
      const products = await transaction.product.findMany({
        include: productInclude,
        where: { id: { in: visibleRows.map(({ id }) => id) }, storeId: store.id },
      });
      const byId = new Map(products.map((product) => [product.id, product]));
      const items = await Promise.all(
        visibleRows.map(({ id }) => this.viewProductSummary(byId.get(id)!, query.locale)),
      );
      const last = visibleRows.at(-1);
      const nextCursor =
        rows.length > query.limit && last
          ? query.sort === 'newest'
            ? encodeCursor({
                id: last.id,
                published_at: last.published_at.toISOString(),
                sort: 'newest',
              })
            : encodeCursor({
                id: last.id,
                price_vnd: last.minimum_price_vnd.toString(),
                sort: query.sort,
              })
          : null;
      return { items, next_cursor: nextCursor };
    });
  }

  public async getProduct(storeCode: string, code: string, locale: Locale) {
    const { context, store } = await this.resolveContext(storeCode, locale);
    return withStoreTransaction(this.database, context, async (transaction) => {
      const product = await transaction.product.findFirst({
        include: productInclude,
        where: {
          brands: {
            brand_localizations: { some: { locale: 'vi' } },
            deletedAt: null,
            status: 'ACTIVE',
          },
          categories: {
            category_localizations: { some: { locale: 'vi' } },
            deletedAt: null,
            status: 'ACTIVE',
          },
          code,
          deletedAt: null,
          enabled: true,
          product_localizations: { some: { locale: 'vi' } },
          skus: { some: { status: 'ACTIVE' } },
          status: 'PUBLISHED',
          storeId: store.id,
        },
      });
      if (!product) throw new NotFoundException('Resource not found');
      return this.viewProductDetail(product, locale);
    });
  }

  public async home(storeCode: string, locale: Locale) {
    const { context, store } = await this.resolveContext(storeCode, locale);
    return withStoreTransaction(this.database, context, async (transaction) => {
      const [storefront, page] = await Promise.all([
        transaction.store.findUnique({
          include: { localizations: true, theme: true },
          where: { id: store.id },
        }),
        transaction.page.findFirst({
          include: {
            page_versions_pages_store_id_current_published_version_idTopage_versions: {
              include: {
                page_modules: {
                  include: {
                    page_module_localizations: true,
                    page_module_media: {
                      include: { media_assets: true },
                      orderBy: [{ sortOrder: 'asc' }, { mediaId: 'asc' }],
                    },
                  },
                  orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
                },
              },
            },
          },
          where: {
            code: 'home',
            currentPublishedVersionId: { not: null },
            status: 'PUBLISHED',
            storeId: store.id,
          },
        }),
      ]);
      const published =
        page?.page_versions_pages_store_id_current_published_version_idTopage_versions;
      if (!storefront || !page || !published || published.publicationStatus !== 'PUBLISHED') {
        throw new NotFoundException('Resource not found');
      }
      const now = new Date();
      const modules = published.page_modules.filter(
        (module) =>
          module.status === 'ACTIVE' &&
          (!module.visibleFrom || module.visibleFrom <= now) &&
          (!module.visibleTo || module.visibleTo > now),
      );
      const ids = {
        brands: new Set<string>(),
        categories: new Set<string>(),
        pages: new Set<string>(),
        products: new Set<string>(),
      };
      for (const module of modules) {
        const moduleIds = itemIds(
          resolveLocalization(module.page_module_localizations, locale).localization.contentConfig,
        );
        const targetSet =
          module.moduleType === 'PRODUCT_GRID'
            ? ids.products
            : module.moduleType === 'BRAND_GRID'
              ? ids.brands
              : module.moduleType === 'CATEGORY_GRID'
                ? ids.categories
                : undefined;
        moduleIds.forEach((id) => targetSet?.add(id));
        if (module.targetId && module.targetType === 'PRODUCT') ids.products.add(module.targetId);
        if (module.targetId && module.targetType === 'BRAND') ids.brands.add(module.targetId);
        if (module.targetId && module.targetType === 'CATEGORY')
          ids.categories.add(module.targetId);
        if (module.targetId && module.targetType === 'PAGE') ids.pages.add(module.targetId);
      }
      const [products, brands, categories, pages] = await Promise.all([
        transaction.product.findMany({
          include: productInclude,
          where: {
            brands: {
              brand_localizations: { some: { locale: 'vi' } },
              deletedAt: null,
              status: 'ACTIVE',
            },
            categories: {
              category_localizations: { some: { locale: 'vi' } },
              deletedAt: null,
              status: 'ACTIVE',
            },
            deletedAt: null,
            enabled: true,
            id: { in: [...ids.products] },
            product_localizations: { some: { locale: 'vi' } },
            skus: { some: { status: 'ACTIVE' } },
            status: 'PUBLISHED',
            storeId: store.id,
          },
        }),
        transaction.brand.findMany({
          include: brandInclude,
          where: {
            brand_localizations: { some: { locale: 'vi' } },
            deletedAt: null,
            id: { in: [...ids.brands] },
            status: 'ACTIVE',
            storeId: store.id,
          },
        }),
        transaction.category.findMany({
          include: categoryInclude,
          where: {
            category_localizations: { some: { locale: 'vi' } },
            deletedAt: null,
            id: { in: [...ids.categories] },
            status: 'ACTIVE',
            storeId: store.id,
          },
        }),
        transaction.page.findMany({
          select: { code: true, id: true },
          where: { id: { in: [...ids.pages] }, status: 'PUBLISHED', storeId: store.id },
        }),
      ]);
      const productMap = new Map(products.map((item) => [item.id, item]));
      const brandMap = new Map(brands.map((item) => [item.id, item]));
      const categoryMap = new Map(categories.map((item) => [item.id, item]));
      const pageMap = new Map(pages.map((item) => [item.id, item]));
      const storeLocalization = resolveLocalization(storefront.localizations, locale);
      return {
        modules: await Promise.all(
          modules.map(async (module) => {
            const localized = resolveLocalization(module.page_module_localizations, locale);
            const configuredIds = itemIds(localized.localization.contentConfig);
            const items =
              module.moduleType === 'PRODUCT_GRID'
                ? await Promise.all(
                    configuredIds
                      .map((id) => productMap.get(id))
                      .filter((item): item is LoadedProduct => Boolean(item))
                      .map((item) => this.viewProductSummary(item, locale)),
                  )
                : module.moduleType === 'BRAND_GRID'
                  ? await Promise.all(
                      configuredIds
                        .map((id) => brandMap.get(id))
                        .filter((item): item is LoadedBrand => Boolean(item))
                        .map((item) => this.viewBrand(item, locale)),
                    )
                  : module.moduleType === 'CATEGORY_GRID'
                    ? await Promise.all(
                        configuredIds
                          .map((id) => categoryMap.get(id))
                          .filter((item): item is LoadedCategory => Boolean(item))
                          .map((item) => this.viewCategory(item, locale, [])),
                      )
                    : [];
            return {
              background_config: module.backgroundConfig,
              button_label: localized.localization.buttonLabel,
              content_config: sanitizeContentConfig(localized.localization.contentConfig),
              id: module.id,
              items,
              media: await Promise.all(
                module.page_module_media
                  .filter(({ media_assets: media }) => media.status === 'READY')
                  .map(({ media_assets: media }) =>
                    this.viewMedia(media, locale, localized.localization.title ?? storefront.code),
                  ),
              ),
              module_type: module.moduleType,
              requested_locale: locale,
              resolved_locale: localized.resolved,
              summary: localized.localization.summary,
              target: this.homeTarget(module, productMap, brandMap, categoryMap, pageMap),
              title: localized.localization.title,
            };
          }),
        ),
        requested_locale: locale,
        resolved_locale: storeLocalization.resolved,
        store: {
          code: storefront.code,
          industry: storefront.industry,
          name: storeLocalization.localization.displayName,
          short_description: storeLocalization.localization.shortDescription,
          theme: storefront.theme
            ? {
                color_tokens: storefront.theme.colorTokens,
                radius_tokens: storefront.theme.radiusTokens,
                typography_tokens: storefront.theme.typographyTokens,
                version: storefront.theme.version,
              }
            : null,
        },
        version: published.version,
      };
    });
  }

  private async resolveContext(storeCode: string, locale: Locale) {
    const stores = await this.database.$queryRaw<ResolvedStore[]>`
      SELECT * FROM app_security.resolve_active_store(${storeCode})
    `;
    const store = stores[0];
    if (!store) throw new NotFoundException('Resource not found');
    return {
      context: createStoreContext({
        actor: { id: randomUUID(), type: 'member' },
        correlationId: randomUUID(),
        locale,
        storeCode: store.code,
        storeId: store.id,
      }),
      store,
    };
  }

  private async viewMedia(media: MediaAsset, locale: Locale, fallbackAlt: string) {
    const signed = await this.mediaStorage.createReadUrl(media.objectKey);
    return {
      alt_text:
        (locale === 'en' ? media.altTextEn : locale === 'zh' ? media.altTextZh : media.altTextVi) ??
        media.altTextVi ??
        fallbackAlt,
      expires_at: signed.expiresAt.toISOString(),
      height: media.height,
      url: signed.url,
      width: media.width,
    };
  }

  private async viewBrand(brand: LoadedBrand, locale: Locale) {
    const localized = resolveLocalization(brand.brand_localizations, locale);
    const logo = brand.brand_media.find(
      (item) => item.purpose === 'LOGO' && item.media_assets.status === 'READY',
    );
    return {
      code: brand.code,
      introduction: localized.localization.introduction,
      logo: logo
        ? await this.viewMedia(logo.media_assets, locale, localized.localization.name)
        : null,
      name: localized.localization.name,
      recommended: brand.recommended,
      requested_locale: locale,
      resolved_locale: localized.resolved,
    };
  }

  private async viewCategory(
    category: LoadedCategory,
    locale: Locale,
    children: LoadedCategory[],
  ): Promise<Record<string, unknown>> {
    const localized = resolveLocalization(category.category_localizations, locale);
    const media = category.category_media.find(
      ({ media_assets: asset }) => asset.status === 'READY',
    );
    return {
      children: await Promise.all(children.map((child) => this.viewCategory(child, locale, []))),
      code: category.code,
      depth: category.depth,
      description: localized.localization.description,
      media: media
        ? await this.viewMedia(media.media_assets, locale, localized.localization.name)
        : null,
      name: localized.localization.name,
      requested_locale: locale,
      resolved_locale: localized.resolved,
    };
  }

  private async viewProductSummary(product: LoadedProduct, locale: Locale) {
    const localized = resolveLocalization(product.product_localizations, locale);
    const prices = product.skus.map(({ salePriceVnd }) => safeVnd(salePriceVnd));
    const marketPrices = product.skus
      .map(({ marketPriceVnd }) => marketPriceVnd)
      .filter((value): value is bigint => value !== null)
      .map(safeVnd);
    const primary = product.product_media.find(
      (item) => item.purpose === 'PRIMARY' && item.media_assets.status === 'READY',
    );
    return {
      brand: await this.viewBrand(product.brands, locale),
      code: product.code,
      main_category: await this.viewCategory(product.categories, locale, []),
      market_price_range_vnd:
        marketPrices.length > 0
          ? { maximum: Math.max(...marketPrices), minimum: Math.min(...marketPrices) }
          : null,
      name: localized.localization.name,
      price_range_vnd: { maximum: Math.max(...prices), minimum: Math.min(...prices) },
      primary_media: primary
        ? await this.viewMedia(primary.media_assets, locale, localized.localization.name)
        : null,
      requested_locale: locale,
      resolved_locale: localized.resolved,
      selling_points: localized.localization.sellingPoints,
      subtitle: localized.localization.subtitle,
    };
  }

  private async viewProductDetail(product: LoadedProduct, locale: Locale) {
    const summary = await this.viewProductSummary(product, locale);
    const localized = resolveLocalization(product.product_localizations, locale);
    return {
      ...summary,
      attributes: product.product_attribute_values.map((item) => ({
        code: item.attribute_definitions.code,
        label: label(item.attribute_definitions, locale),
        purpose: item.attribute_definitions.purpose,
        unit: item.attribute_definitions.unit,
        value: item.attribute_options
          ? label(item.attribute_options, locale)
          : (item.textValue ??
            (item.integerValue === null ? null : item.integerValue.toString()) ??
            item.decimalValue?.toString() ??
            item.booleanValue ??
            item.dateValue?.toISOString().slice(0, 10) ??
            null),
      })),
      description_document: localized.localization.descriptionDocument,
      gallery: await Promise.all(
        product.product_media
          .filter(({ media_assets: media }) => media.status === 'READY')
          .map(({ media_assets: media }) =>
            this.viewMedia(media, locale, localized.localization.name),
          ),
      ),
      skus: await Promise.all(
        product.skus.map(async (sku) => {
          const media = sku.sku_media.find(({ media_assets: asset }) => asset.status === 'READY');
          return {
            code: sku.code,
            market_price_vnd: sku.marketPriceVnd === null ? null : safeVnd(sku.marketPriceVnd),
            media: media
              ? await this.viewMedia(media.media_assets, locale, localized.localization.name)
              : null,
            option_values: sku.sku_option_values
              .sort(
                (left, right) =>
                  left.attribute_definitions.sortOrder - right.attribute_definitions.sortOrder,
              )
              .map((item) => ({
                attribute_code: item.attribute_definitions.code,
                attribute_label: label(item.attribute_definitions, locale),
                option_code: item.attribute_options.code,
                option_label: label(item.attribute_options, locale),
              })),
            sale_price_vnd: safeVnd(sku.salePriceVnd),
          };
        }),
      ),
      usage_instructions: localized.localization.usageInstructions,
    };
  }

  private homeTarget(
    module: {
      targetId: string | null;
      targetType: 'BRAND' | 'CATEGORY' | 'EXTERNAL' | 'PAGE' | 'PRODUCT' | null;
      targetUrl: string | null;
    },
    products: Map<string, LoadedProduct>,
    brands: Map<string, LoadedBrand>,
    categories: Map<string, LoadedCategory>,
    pages: Map<string, { code: string; id: string }>,
  ) {
    if (module.targetType === 'EXTERNAL' && module.targetUrl) {
      try {
        const target = new URL(module.targetUrl);
        if (
          target.protocol === 'https:' &&
          this.config.CONTENT_EXTERNAL_TARGET_HOSTS.includes(target.hostname.toLowerCase())
        ) {
          return { type: 'EXTERNAL', url: target.toString() };
        }
      } catch {
        return null;
      }
      return null;
    }
    if (!module.targetId || !module.targetType) return null;
    const resource =
      module.targetType === 'PRODUCT'
        ? products.get(module.targetId)
        : module.targetType === 'BRAND'
          ? brands.get(module.targetId)
          : module.targetType === 'CATEGORY'
            ? categories.get(module.targetId)
            : pages.get(module.targetId);
    return resource ? { code: resource.code, type: module.targetType } : null;
  }

  private productRows(
    transaction: StoreTransaction,
    storeId: string,
    query: PublicProductListQuery,
    cursor: ProductCursor | undefined,
  ) {
    const brandFilter = query.brand_code
      ? Prisma.sql`AND b.code = ${query.brand_code}`
      : Prisma.empty;
    const categoryFilter = query.category_code
      ? Prisma.sql`
          AND (
            mc.code = ${query.category_code}
            OR EXISTS (
              SELECT 1 FROM categories parent
              WHERE parent.store_id = p.store_id
                AND parent.id = mc.parent_id
                AND parent.code = ${query.category_code}
                AND parent.status = 'ACTIVE'
                AND parent.deleted_at IS NULL
            )
            OR EXISTS (
              SELECT 1
              FROM product_secondary_categories psc
              JOIN categories secondary
                ON secondary.store_id = psc.store_id AND secondary.id = psc.category_id
              LEFT JOIN categories secondary_parent
                ON secondary_parent.store_id = secondary.store_id
                AND secondary_parent.id = secondary.parent_id
              WHERE psc.store_id = p.store_id
                AND psc.product_id = p.id
                AND secondary.status = 'ACTIVE'
                AND secondary.deleted_at IS NULL
                AND (secondary.code = ${query.category_code} OR secondary_parent.code = ${query.category_code})
            )
          )`
      : Prisma.empty;
    const whereCursor =
      cursor?.sort === 'newest'
        ? Prisma.sql`AND (p.published_at < ${new Date(cursor.published_at)} OR (p.published_at = ${new Date(cursor.published_at)} AND p.id > ${cursor.id}::uuid))`
        : Prisma.empty;
    const havingCursor =
      cursor?.sort === 'price_asc'
        ? Prisma.sql`HAVING MIN(s.sale_price_vnd) > ${BigInt(cursor.price_vnd)} OR (MIN(s.sale_price_vnd) = ${BigInt(cursor.price_vnd)} AND p.id > ${cursor.id}::uuid)`
        : cursor?.sort === 'price_desc'
          ? Prisma.sql`HAVING MIN(s.sale_price_vnd) < ${BigInt(cursor.price_vnd)} OR (MIN(s.sale_price_vnd) = ${BigInt(cursor.price_vnd)} AND p.id > ${cursor.id}::uuid)`
          : Prisma.empty;
    const order =
      query.sort === 'price_asc'
        ? Prisma.sql`MIN(s.sale_price_vnd) ASC, p.id ASC`
        : query.sort === 'price_desc'
          ? Prisma.sql`MIN(s.sale_price_vnd) DESC, p.id ASC`
          : Prisma.sql`p.published_at DESC, p.id ASC`;
    return transaction.$queryRaw<ProductRow[]>(Prisma.sql`
      SELECT p.id, p.published_at, MIN(s.sale_price_vnd) AS minimum_price_vnd
      FROM products p
      JOIN brands b ON b.store_id = p.store_id AND b.id = p.brand_id
      JOIN categories mc ON mc.store_id = p.store_id AND mc.id = p.main_category_id
      JOIN skus s ON s.store_id = p.store_id AND s.product_id = p.id
      WHERE p.store_id = ${storeId}::uuid
        AND p.status = 'PUBLISHED'
        AND p.enabled = true
        AND p.deleted_at IS NULL
        AND p.published_at IS NOT NULL
        AND b.status = 'ACTIVE'
        AND b.deleted_at IS NULL
        AND mc.status = 'ACTIVE'
        AND mc.deleted_at IS NULL
        AND s.status = 'ACTIVE'
        AND EXISTS (
          SELECT 1 FROM product_localizations pl
          WHERE pl.store_id = p.store_id AND pl.product_id = p.id AND pl.locale = 'vi'
        )
        AND EXISTS (
          SELECT 1 FROM brand_localizations bl
          WHERE bl.store_id = b.store_id AND bl.brand_id = b.id AND bl.locale = 'vi'
        )
        AND EXISTS (
          SELECT 1 FROM category_localizations cl
          WHERE cl.store_id = mc.store_id AND cl.category_id = mc.id AND cl.locale = 'vi'
        )
        ${brandFilter}
        ${categoryFilter}
        ${whereCursor}
      GROUP BY p.id, p.published_at
      ${havingCursor}
      ORDER BY ${order}
      LIMIT ${query.limit + 1}
    `);
  }
}
