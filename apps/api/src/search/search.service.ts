import { createHash, randomUUID } from 'node:crypto';

import { BadRequestException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type {
  ProductSearchQuery,
  SearchFacetQuery,
  SearchSuggestionQuery,
} from '@zalo-shop/contracts';
import { Prisma, type Locale, type PrismaClient, withStoreTransaction } from '@zalo-shop/database';
import {
  canPersistSearchTelemetry,
  createStoreContext,
  normalizeSearchText,
} from '@zalo-shop/domain';
import type { MediaStorageProvider } from '@zalo-shop/integrations';

import { AuthService } from '../auth/auth.service';
import { DATABASE_CLIENT, MEDIA_STORAGE_PROVIDER } from '../auth/auth.tokens';
import { SearchRateLimiter } from './search-rate-limiter';

type ResolvedStore = { code: string; default_locale: Locale; id: string };
type SearchMember = { id: string; storeId: string };
type SearchSort = 'newest' | 'price_asc' | 'price_desc' | 'relevance';
type SearchCursor =
  | { f: string; id: string; published_at: string; sort: 'newest'; v: 1 }
  | { f: string; id: string; price_vnd: string; sort: 'price_asc' | 'price_desc'; v: 1 }
  | { f: string; id: string; published_at: string; score: number; sort: 'relevance'; v: 1 };

type SearchRow = {
  available_quantity: bigint;
  brand_code: string;
  document_id: string;
  main_category_code: string;
  minimum_sale_price_vnd: bigint;
  object_key: string | null;
  product_code: string;
  product_name: string;
  published_at: Date;
  score: number;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeVnd(value: bigint): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new TypeError('Stored VND amount is outside the supported safe integer range');
  }
  return amount;
}

function decodeCursor(
  value: string | undefined,
  fingerprint: string,
  sort: SearchSort,
): SearchCursor | undefined {
  if (!value) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new BadRequestException('Cursor is invalid');
  }
  if (
    typeof decoded !== 'object' ||
    decoded === null ||
    Array.isArray(decoded) ||
    !('v' in decoded) ||
    decoded.v !== 1 ||
    !('f' in decoded) ||
    decoded.f !== fingerprint ||
    !('sort' in decoded) ||
    decoded.sort !== sort ||
    !('id' in decoded) ||
    typeof decoded.id !== 'string' ||
    !UUID_PATTERN.test(decoded.id)
  ) {
    throw new BadRequestException('Cursor is invalid');
  }
  if (sort === 'newest') {
    if (
      !('published_at' in decoded) ||
      typeof decoded.published_at !== 'string' ||
      Number.isNaN(Date.parse(decoded.published_at))
    ) {
      throw new BadRequestException('Cursor is invalid');
    }
    return decoded as SearchCursor;
  }
  if (sort === 'relevance') {
    if (
      !('published_at' in decoded) ||
      typeof decoded.published_at !== 'string' ||
      Number.isNaN(Date.parse(decoded.published_at)) ||
      !('score' in decoded) ||
      typeof decoded.score !== 'number' ||
      !Number.isFinite(decoded.score)
    ) {
      throw new BadRequestException('Cursor is invalid');
    }
    return decoded as SearchCursor;
  }
  if (
    !('price_vnd' in decoded) ||
    typeof decoded.price_vnd !== 'string' ||
    !/^\d+$/.test(decoded.price_vnd)
  ) {
    throw new BadRequestException('Cursor is invalid');
  }
  return decoded as SearchCursor;
}

function encodeCursor(value: SearchCursor): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function fingerprint(
  storeId: string,
  query: ProductSearchQuery,
  sort: SearchSort,
  folded: string | null,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        attribute_filters: [...query.attribute_filters].sort(),
        brand_codes: [...query.brand_codes].sort(),
        category_codes: [...query.category_codes].sort(),
        folded,
        in_stock: query.in_stock ?? null,
        locale: query.locale,
        max_price_vnd: query.max_price_vnd ?? null,
        min_price_vnd: query.min_price_vnd ?? null,
        on_promotion: query.on_promotion ?? null,
        sort,
        store_id: storeId,
      }),
    )
    .digest('hex');
}

function localizedSql(locale: Locale, alias: string): Prisma.Sql {
  const vi = Prisma.raw(`${alias}_vi`);
  const requested = Prisma.raw(`${alias}_requested`);
  return locale === 'vi'
    ? Prisma.sql`${vi}.name`
    : Prisma.sql`COALESCE(${requested}.name, ${vi}.name)`;
}

@Injectable()
export class SearchService {
  public constructor(
    @Inject(DATABASE_CLIENT) private readonly database: PrismaClient,
    @Inject(MEDIA_STORAGE_PROVIDER) private readonly mediaStorage: MediaStorageProvider,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SearchRateLimiter) private readonly rateLimiter: SearchRateLimiter,
  ) {}

  public async products(input: {
    address: string;
    authorization?: string;
    query: ProductSearchQuery;
    storeCode: string;
  }) {
    await this.rateLimiter.assertAllowed(input.address);
    const member = await this.optionalMember(input.authorization, input.storeCode);
    const store = await this.resolveStore(input.storeCode);
    const normalized = input.query.q ? normalizeSearchText(input.query.q) : null;
    const sort: SearchSort = input.query.sort ?? (normalized ? 'relevance' : 'newest');
    const queryFingerprint = fingerprint(store.id, input.query, sort, normalized?.folded ?? null);
    const cursor = decodeCursor(input.query.cursor, queryFingerprint, sort);
    const context = createStoreContext({
      actor: { id: member?.id ?? randomUUID(), type: 'member' },
      correlationId: randomUUID(),
      locale: input.query.locale,
      storeCode: store.code,
      storeId: store.id,
    });

    const rows = await withStoreTransaction(this.database, context, async (transaction) => {
      const conditions: Prisma.Sql[] = [
        Prisma.sql`d.store_id = ${store.id}::uuid`,
        Prisma.sql`d.locale = ${input.query.locale}::"Locale"`,
        Prisma.sql`p.status = 'PUBLISHED' AND p.enabled AND p.deleted_at IS NULL`,
        Prisma.sql`b.status = 'ACTIVE' AND b.deleted_at IS NULL`,
        Prisma.sql`mc.status = 'ACTIVE' AND mc.deleted_at IS NULL`,
      ];
      if (normalized) {
        conditions.push(Prisma.sql`(
          d.search_vector @@ plainto_tsquery('simple'::regconfig, ${normalized.folded})
          OR position(${normalized.folded} in d.folded_text) > 0
          OR d.folded_text % ${normalized.folded}
        )`);
      }
      if (input.query.brand_codes.length > 0) {
        conditions.push(Prisma.sql`b.code IN (${Prisma.join(input.query.brand_codes)})`);
      }
      if (input.query.category_codes.length > 0) {
        conditions.push(Prisma.sql`EXISTS (
          SELECT 1 FROM categories filter_category
          WHERE filter_category.store_id = d.store_id
            AND filter_category.id = ANY(d.category_ids)
            AND filter_category.code IN (${Prisma.join(input.query.category_codes)})
        )`);
      }
      for (const filter of input.query.attribute_filters) {
        const separator = filter.indexOf(':');
        const code = filter.slice(0, separator);
        const value = filter.slice(separator + 1);
        conditions.push(
          Prisma.sql`d.filter_values @> ${JSON.stringify({ [code]: [value] })}::jsonb`,
        );
      }
      if (input.query.min_price_vnd !== undefined) {
        conditions.push(
          Prisma.sql`d.minimum_sale_price_vnd >= ${BigInt(input.query.min_price_vnd)}`,
        );
      }
      if (input.query.max_price_vnd !== undefined) {
        conditions.push(
          Prisma.sql`d.minimum_sale_price_vnd <= ${BigInt(input.query.max_price_vnd)}`,
        );
      }
      if (input.query.in_stock !== undefined) {
        conditions.push(
          input.query.in_stock
            ? Prisma.sql`stock.available_quantity > 0`
            : Prisma.sql`stock.available_quantity = 0`,
        );
      }
      if (input.query.on_promotion === true) conditions.push(Prisma.sql`FALSE`);

      const score = normalized
        ? Prisma.sql`round((
            CASE
              WHEN d.canonical_text = ${normalized.canonical} THEN 400
              WHEN d.folded_text = ${normalized.folded} THEN 360
              WHEN d.folded_text LIKE ${`${normalized.folded}%`} THEN 300
              WHEN position(${normalized.folded} in d.folded_text) > 0 THEN 220
              ELSE 0
            END
            + ts_rank_cd(d.search_vector, plainto_tsquery('simple'::regconfig, ${normalized.folded})) * 100
            + similarity(d.folded_text, ${normalized.folded}) * 10
          )::numeric, 6)::double precision`
        : Prisma.sql`0::double precision`;
      const cursorCondition = this.cursorCondition(cursor, sort);
      const order =
        sort === 'relevance'
          ? Prisma.sql`score DESC, published_at DESC, document_id ASC`
          : sort === 'newest'
            ? Prisma.sql`published_at DESC, document_id ASC`
            : sort === 'price_asc'
              ? Prisma.sql`minimum_sale_price_vnd ASC, document_id ASC`
              : Prisma.sql`minimum_sale_price_vnd DESC, document_id ASC`;
      const productName = localizedSql(input.query.locale, 'pl');
      const requestedLocalizationJoin =
        input.query.locale === 'vi'
          ? Prisma.empty
          : Prisma.sql`LEFT JOIN product_localizations pl_requested
              ON pl_requested.store_id = p.store_id
             AND pl_requested.product_id = p.id
             AND pl_requested.locale = ${input.query.locale}::"Locale"`;

      const found = await transaction.$queryRaw<SearchRow[]>(Prisma.sql`
        WITH candidates AS (
          SELECT
            d.id AS document_id,
            p.code AS product_code,
            ${productName} AS product_name,
            b.code AS brand_code,
            mc.code AS main_category_code,
            d.minimum_sale_price_vnd,
            LEAST(stock.available_quantity, 2147483647)::bigint AS available_quantity,
            d.published_at,
            media.object_key,
            ${score} AS score
          FROM product_search_documents d
          JOIN products p ON p.store_id = d.store_id AND p.id = d.product_id
          JOIN brands b ON b.store_id = d.store_id AND b.id = d.brand_id
          JOIN categories mc ON mc.store_id = d.store_id AND mc.id = d.main_category_id
          JOIN product_localizations pl_vi
            ON pl_vi.store_id = p.store_id AND pl_vi.product_id = p.id AND pl_vi.locale = 'vi'
          ${requestedLocalizationJoin}
          LEFT JOIN LATERAL (
            SELECT COALESCE(sum(ib.on_hand - ib.reserved), 0)::bigint AS available_quantity
            FROM skus sku
            JOIN warehouses w
              ON w.store_id = sku.store_id AND w.enabled AND w.is_default_fulfillment
            JOIN inventory_balances ib
              ON ib.store_id = sku.store_id AND ib.sku_id = sku.id AND ib.warehouse_id = w.id
            WHERE sku.store_id = p.store_id AND sku.product_id = p.id AND sku.status = 'ACTIVE'
          ) stock ON true
          LEFT JOIN LATERAL (
            SELECT asset.object_key
            FROM product_media pm
            JOIN media_assets asset
              ON asset.store_id = pm.store_id AND asset.id = pm.media_id AND asset.status = 'READY'
            WHERE pm.store_id = p.store_id AND pm.product_id = p.id AND pm.purpose = 'PRIMARY'
            ORDER BY pm.sort_order, pm.media_id
            LIMIT 1
          ) media ON true
          WHERE ${Prisma.join(conditions, ' AND ')}
        )
        SELECT * FROM candidates
        ${cursorCondition}
        ORDER BY ${order}
        LIMIT ${input.query.limit + 1}
      `);

      if (normalized && !input.query.cursor && canPersistSearchTelemetry(normalized.display)) {
        await transaction.searchQueryStat.upsert({
          create: {
            displayQuery: normalized.display,
            foldedQuery: normalized.folded,
            locale: input.query.locale,
            searchCount: 1,
            storeId: store.id,
          },
          update: {
            displayQuery: normalized.display,
            lastSearchedAt: new Date(),
            searchCount: { increment: 1 },
          },
          where: {
            storeId_locale_foldedQuery: {
              foldedQuery: normalized.folded,
              locale: input.query.locale,
              storeId: store.id,
            },
          },
        });
        if (member) {
          await transaction.memberSearchHistory.upsert({
            create: {
              canonicalQuery: normalized.canonical,
              displayQuery: normalized.display,
              foldedQuery: normalized.folded,
              locale: input.query.locale,
              memberId: member.id,
              storeId: store.id,
            },
            update: {
              canonicalQuery: normalized.canonical,
              displayQuery: normalized.display,
              lastSearchedAt: new Date(),
            },
            where: {
              storeId_memberId_locale_foldedQuery: {
                foldedQuery: normalized.folded,
                locale: input.query.locale,
                memberId: member.id,
                storeId: store.id,
              },
            },
          });
          await transaction.$executeRaw`
            DELETE FROM member_search_history
            WHERE store_id = ${store.id}::uuid AND member_id = ${member.id}::uuid
              AND id IN (
                SELECT id FROM member_search_history
                WHERE store_id = ${store.id}::uuid AND member_id = ${member.id}::uuid
                ORDER BY last_searched_at DESC, id DESC
                OFFSET 50
              )
          `;
        }
      }
      return found;
    });

    const visible = rows.slice(0, input.query.limit);
    const last = visible.at(-1);
    return {
      items: await Promise.all(
        visible.map(async (row) => {
          const media = row.object_key
            ? await this.mediaStorage.createReadUrl(row.object_key)
            : undefined;
          const availableQuantity = Number(row.available_quantity);
          return {
            available: availableQuantity > 0,
            available_quantity: availableQuantity,
            brand_code: row.brand_code,
            main_category_code: row.main_category_code,
            minimum_sale_price_vnd: safeVnd(row.minimum_sale_price_vnd),
            name: row.product_name,
            primary_media_url: media?.url ?? null,
            product_code: row.product_code,
            promotion_summary: null,
            published_at: row.published_at.toISOString(),
          };
        }),
      ),
      next_cursor:
        rows.length > input.query.limit && last
          ? this.nextCursor(last, queryFingerprint, sort)
          : null,
      normalized_query: normalized?.folded ?? null,
    };
  }

  public async suggestions(input: {
    address: string;
    query: SearchSuggestionQuery;
    storeCode: string;
  }) {
    await this.rateLimiter.assertAllowed(input.address);
    const store = await this.resolveStore(input.storeCode);
    const normalized = normalizeSearchText(input.query.q);
    const context = createStoreContext({
      actor: { id: randomUUID(), type: 'member' },
      correlationId: randomUUID(),
      locale: input.query.locale,
      storeCode: store.code,
      storeId: store.id,
    });
    return withStoreTransaction(this.database, context, async (transaction) => {
      const name = localizedSql(input.query.locale, 'pl');
      const requestedJoin =
        input.query.locale === 'vi'
          ? Prisma.empty
          : Prisma.sql`LEFT JOIN product_localizations pl_requested
              ON pl_requested.store_id = p.store_id AND pl_requested.product_id = p.id
             AND pl_requested.locale = ${input.query.locale}::"Locale"`;
      const products = await transaction.$queryRaw<Array<{ product_code: string; text: string }>>(
        Prisma.sql`
          SELECT p.code AS product_code, ${name} AS text
          FROM product_search_documents d
          JOIN products p ON p.store_id = d.store_id AND p.id = d.product_id
          JOIN brands b ON b.store_id = d.store_id AND b.id = d.brand_id
          JOIN categories c ON c.store_id = d.store_id AND c.id = d.main_category_id
          JOIN product_localizations pl_vi
            ON pl_vi.store_id = p.store_id AND pl_vi.product_id = p.id AND pl_vi.locale = 'vi'
          ${requestedJoin}
          WHERE d.store_id = ${store.id}::uuid AND d.locale = ${input.query.locale}::"Locale"
            AND p.status = 'PUBLISHED' AND p.enabled AND p.deleted_at IS NULL
            AND b.status = 'ACTIVE' AND b.deleted_at IS NULL
            AND c.status = 'ACTIVE' AND c.deleted_at IS NULL
            AND (position(${normalized.folded} in d.folded_text) > 0 OR d.folded_text % ${normalized.folded})
          ORDER BY
            CASE WHEN d.folded_text LIKE ${`${normalized.folded}%`} THEN 0 ELSE 1 END,
            similarity(d.folded_text, ${normalized.folded}) DESC,
            d.published_at DESC,
            d.id
          LIMIT ${input.query.limit}
        `,
      );
      const remaining = Math.max(0, input.query.limit - products.length);
      const queries =
        remaining === 0
          ? []
          : await transaction.searchQueryStat.findMany({
              orderBy: [
                { searchCount: 'desc' },
                { lastSearchedAt: 'desc' },
                { foldedQuery: 'asc' },
              ],
              select: { displayQuery: true },
              take: remaining,
              where: {
                foldedQuery: { contains: normalized.folded },
                locale: input.query.locale,
                storeId: store.id,
              },
            });
      return {
        items: [
          ...products.map((item) => ({
            kind: 'PRODUCT' as const,
            product_code: item.product_code,
            text: item.text,
          })),
          ...queries.map((item) => ({
            kind: 'QUERY' as const,
            product_code: null,
            text: item.displayQuery,
          })),
        ],
      };
    });
  }

  public async facets(input: { address: string; query: SearchFacetQuery; storeCode: string }) {
    await this.rateLimiter.assertAllowed(input.address);
    const store = await this.resolveStore(input.storeCode);
    const context = createStoreContext({
      actor: { id: randomUUID(), type: 'member' },
      correlationId: randomUUID(),
      locale: input.query.locale,
      storeCode: store.code,
      storeId: store.id,
    });
    return withStoreTransaction(this.database, context, async (transaction) => {
      const brandName = localizedSql(input.query.locale, 'bl');
      const categoryName = localizedSql(input.query.locale, 'cl');
      const optionLabel =
        input.query.locale === 'en'
          ? Prisma.sql`COALESCE(ao.label_en, ao.label_vi)`
          : input.query.locale === 'zh'
            ? Prisma.sql`COALESCE(ao.label_zh, ao.label_vi)`
            : Prisma.sql`ao.label_vi`;
      const definitionLabel =
        input.query.locale === 'en'
          ? Prisma.sql`COALESCE(ad.label_en, ad.label_vi)`
          : input.query.locale === 'zh'
            ? Prisma.sql`COALESCE(ad.label_zh, ad.label_vi)`
            : Prisma.sql`ad.label_vi`;
      const requestedBrandJoin =
        input.query.locale === 'vi'
          ? Prisma.empty
          : Prisma.sql`LEFT JOIN brand_localizations bl_requested
              ON bl_requested.store_id = b.store_id AND bl_requested.brand_id = b.id
             AND bl_requested.locale = ${input.query.locale}::"Locale"`;
      const requestedCategoryJoin =
        input.query.locale === 'vi'
          ? Prisma.empty
          : Prisma.sql`LEFT JOIN category_localizations cl_requested
              ON cl_requested.store_id = c.store_id AND cl_requested.category_id = c.id
             AND cl_requested.locale = ${input.query.locale}::"Locale"`;
      const [brands, categories, attributes, price] = await Promise.all([
        transaction.$queryRaw<Array<{ code: string; count: bigint; name: string }>>(Prisma.sql`
          SELECT b.code, ${brandName} AS name, count(DISTINCT d.product_id)::bigint AS count
          FROM product_search_documents d
          JOIN products p
            ON p.store_id = d.store_id AND p.id = d.product_id
           AND p.status = 'PUBLISHED' AND p.enabled AND p.deleted_at IS NULL
          JOIN brands b ON b.store_id = d.store_id AND b.id = d.brand_id AND b.status = 'ACTIVE' AND b.deleted_at IS NULL
          JOIN categories mc
            ON mc.store_id = d.store_id AND mc.id = d.main_category_id
           AND mc.status = 'ACTIVE' AND mc.deleted_at IS NULL
          JOIN brand_localizations bl_vi ON bl_vi.store_id = b.store_id AND bl_vi.brand_id = b.id AND bl_vi.locale = 'vi'
          ${requestedBrandJoin}
          WHERE d.store_id = ${store.id}::uuid AND d.locale = ${input.query.locale}::"Locale"
          GROUP BY b.code, ${brandName}
          ORDER BY name, b.code
        `),
        transaction.$queryRaw<
          Array<{ code: string; count: bigint; depth: number; name: string }>
        >(Prisma.sql`
          SELECT c.code, c.depth, ${categoryName} AS name, count(DISTINCT d.product_id)::bigint AS count
          FROM product_search_documents d
          JOIN products p
            ON p.store_id = d.store_id AND p.id = d.product_id
           AND p.status = 'PUBLISHED' AND p.enabled AND p.deleted_at IS NULL
          JOIN brands b
            ON b.store_id = d.store_id AND b.id = d.brand_id
           AND b.status = 'ACTIVE' AND b.deleted_at IS NULL
          JOIN categories mc
            ON mc.store_id = d.store_id AND mc.id = d.main_category_id
           AND mc.status = 'ACTIVE' AND mc.deleted_at IS NULL
          JOIN categories c ON c.store_id = d.store_id AND c.id = ANY(d.category_ids) AND c.status = 'ACTIVE' AND c.deleted_at IS NULL
          JOIN category_localizations cl_vi ON cl_vi.store_id = c.store_id AND cl_vi.category_id = c.id AND cl_vi.locale = 'vi'
          ${requestedCategoryJoin}
          WHERE d.store_id = ${store.id}::uuid AND d.locale = ${input.query.locale}::"Locale"
          GROUP BY c.code, c.depth, ${categoryName}
          ORDER BY c.depth, name, c.code
        `),
        transaction.$queryRaw<
          Array<{
            attribute_code: string;
            attribute_label: string;
            count: bigint;
            option_code: string;
            option_label: string;
          }>
        >(Prisma.sql`
          SELECT
            ad.code AS attribute_code,
            ${definitionLabel} AS attribute_label,
            ao.code AS option_code,
            ${optionLabel} AS option_label,
            count(DISTINCT d.product_id)::bigint AS count
          FROM product_search_documents d
          JOIN products p
            ON p.store_id = d.store_id AND p.id = d.product_id
           AND p.status = 'PUBLISHED' AND p.enabled AND p.deleted_at IS NULL
          JOIN brands b
            ON b.store_id = d.store_id AND b.id = d.brand_id
           AND b.status = 'ACTIVE' AND b.deleted_at IS NULL
          JOIN categories mc
            ON mc.store_id = d.store_id AND mc.id = d.main_category_id
           AND mc.status = 'ACTIVE' AND mc.deleted_at IS NULL
          CROSS JOIN LATERAL jsonb_each(d.filter_values) filter_entry
          CROSS JOIN LATERAL jsonb_array_elements_text(filter_entry.value) filter_value
          JOIN attribute_definitions ad
            ON ad.store_id = d.store_id
           AND ad.template_version_id = p.attribute_template_version_id
           AND ad.code = filter_entry.key AND ad.filterable
          JOIN attribute_options ao
            ON ao.store_id = ad.store_id AND ao.attribute_definition_id = ad.id
           AND ao.code = filter_value AND ao.status = 'ACTIVE'
          WHERE d.store_id = ${store.id}::uuid AND d.locale = ${input.query.locale}::"Locale"
          GROUP BY ad.code, ${definitionLabel}, ao.code, ${optionLabel}, ad.sort_order, ao.sort_order
          ORDER BY ad.sort_order, attribute_label, ao.sort_order, option_label
        `),
        transaction.$queryRaw<Array<{ maximum: bigint | null; minimum: bigint | null }>>(
          Prisma.sql`
            SELECT
              max(d.minimum_sale_price_vnd)::bigint AS maximum,
              min(d.minimum_sale_price_vnd)::bigint AS minimum
            FROM product_search_documents d
            JOIN products p
              ON p.store_id = d.store_id AND p.id = d.product_id
             AND p.status = 'PUBLISHED' AND p.enabled AND p.deleted_at IS NULL
            JOIN brands b
              ON b.store_id = d.store_id AND b.id = d.brand_id
             AND b.status = 'ACTIVE' AND b.deleted_at IS NULL
            JOIN categories mc
              ON mc.store_id = d.store_id AND mc.id = d.main_category_id
             AND mc.status = 'ACTIVE' AND mc.deleted_at IS NULL
            WHERE d.store_id = ${store.id}::uuid AND d.locale = ${input.query.locale}::"Locale"
          `,
        ),
      ]);
      const attributeMap = new Map<
        string,
        {
          code: string;
          label: string;
          options: Array<{ code: string; count: number; label: string }>;
        }
      >();
      for (const row of attributes) {
        const attribute = attributeMap.get(row.attribute_code) ?? {
          code: row.attribute_code,
          label: row.attribute_label,
          options: [],
        };
        attribute.options.push({
          code: row.option_code,
          count: Number(row.count),
          label: row.option_label,
        });
        attributeMap.set(row.attribute_code, attribute);
      }
      return {
        attributes: [...attributeMap.values()],
        brands: brands.map((row) => ({ code: row.code, count: Number(row.count), name: row.name })),
        categories: categories.map((row) => ({
          code: row.code,
          count: Number(row.count),
          depth: row.depth,
          name: row.name,
        })),
        price_range_vnd:
          !price[0] || price[0].minimum === null || price[0].maximum === null
            ? null
            : {
                maximum: safeVnd(price[0].maximum),
                minimum: safeVnd(price[0].minimum),
              },
      };
    });
  }

  public async history(input: {
    authorization: string | undefined;
    limit: number;
    storeCode: string;
  }) {
    const member = await this.requiredMember(input.authorization, input.storeCode);
    const store = await this.resolveStore(input.storeCode);
    const context = createStoreContext({
      actor: { id: member.id, type: 'member' },
      correlationId: randomUUID(),
      locale: store.default_locale,
      storeCode: store.code,
      storeId: store.id,
    });
    return withStoreTransaction(this.database, context, async (transaction) => ({
      items: (
        await transaction.memberSearchHistory.findMany({
          orderBy: [{ lastSearchedAt: 'desc' }, { id: 'desc' }],
          take: input.limit,
          where: { memberId: member.id, storeId: store.id },
        })
      ).map((item) => ({
        last_searched_at: item.lastSearchedAt.toISOString(),
        locale: item.locale,
        query: item.displayQuery,
      })),
    }));
  }

  public async clearHistory(input: {
    authorization: string | undefined;
    storeCode: string;
  }): Promise<void> {
    const member = await this.requiredMember(input.authorization, input.storeCode);
    const store = await this.resolveStore(input.storeCode);
    const context = createStoreContext({
      actor: { id: member.id, type: 'member' },
      correlationId: randomUUID(),
      locale: store.default_locale,
      storeCode: store.code,
      storeId: store.id,
    });
    await withStoreTransaction(this.database, context, (transaction) =>
      transaction.memberSearchHistory.deleteMany({
        where: { memberId: member.id, storeId: store.id },
      }),
    );
  }

  private cursorCondition(cursor: SearchCursor | undefined, sort: SearchSort): Prisma.Sql {
    if (!cursor) return Prisma.empty;
    if (sort === 'newest' && cursor.sort === 'newest') {
      return Prisma.sql`WHERE (
        published_at < ${new Date(cursor.published_at)}
        OR (published_at = ${new Date(cursor.published_at)} AND document_id > ${cursor.id}::uuid)
      )`;
    }
    if (sort === 'relevance' && cursor.sort === 'relevance') {
      return Prisma.sql`WHERE (
        score < ${cursor.score}
        OR (score = ${cursor.score} AND published_at < ${new Date(cursor.published_at)})
        OR (score = ${cursor.score} AND published_at = ${new Date(cursor.published_at)} AND document_id > ${cursor.id}::uuid)
      )`;
    }
    if ((sort === 'price_asc' || sort === 'price_desc') && cursor.sort === sort) {
      const price = BigInt(cursor.price_vnd);
      return sort === 'price_asc'
        ? Prisma.sql`WHERE (
            minimum_sale_price_vnd > ${price}
            OR (minimum_sale_price_vnd = ${price} AND document_id > ${cursor.id}::uuid)
          )`
        : Prisma.sql`WHERE (
            minimum_sale_price_vnd < ${price}
            OR (minimum_sale_price_vnd = ${price} AND document_id > ${cursor.id}::uuid)
          )`;
    }
    throw new BadRequestException('Cursor is invalid');
  }

  private nextCursor(row: SearchRow, queryFingerprint: string, sort: SearchSort): string {
    if (sort === 'newest') {
      return encodeCursor({
        f: queryFingerprint,
        id: row.document_id,
        published_at: row.published_at.toISOString(),
        sort,
        v: 1,
      });
    }
    if (sort === 'relevance') {
      return encodeCursor({
        f: queryFingerprint,
        id: row.document_id,
        published_at: row.published_at.toISOString(),
        score: row.score,
        sort,
        v: 1,
      });
    }
    return encodeCursor({
      f: queryFingerprint,
      id: row.document_id,
      price_vnd: row.minimum_sale_price_vnd.toString(),
      sort,
      v: 1,
    });
  }

  private async optionalMember(
    authorization: string | undefined,
    storeCode: string,
  ): Promise<SearchMember | undefined> {
    if (!authorization) return undefined;
    return this.requiredMember(authorization, storeCode);
  }

  private async requiredMember(
    authorization: string | undefined,
    storeCode: string,
  ): Promise<SearchMember> {
    if (!authorization?.startsWith('Bearer ') || authorization.length <= 7) {
      throw new UnauthorizedException('Member authentication is required');
    }
    const claims = await this.auth.authenticateAccessToken(authorization.slice(7), storeCode);
    if (claims.actorType !== 'member' || !claims.storeId) {
      throw new UnauthorizedException('Member authentication is required');
    }
    return { id: claims.subjectId, storeId: claims.storeId };
  }

  private async resolveStore(storeCode: string): Promise<ResolvedStore> {
    const stores = await this.database.$queryRaw<ResolvedStore[]>`
      SELECT * FROM app_security.resolve_active_store(${storeCode.trim()})
    `;
    const store = stores[0];
    if (!store) throw new UnauthorizedException('Store context is invalid');
    return store;
  }
}
