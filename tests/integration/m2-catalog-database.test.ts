import { randomUUID } from 'node:crypto';

import { config as loadEnvironment } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRuntimePrismaClient, withStoreTransaction } from '@zalo-shop/database';
import { createStoreContext } from '@zalo-shop/domain';

const BEAUTY_STORE_ID = '10000000-0000-4000-8000-000000000001';
const FASHION_STORE_ID = '10000000-0000-4000-8000-000000000002';
const ACTOR_ID = '20000000-0000-4000-8000-000000000001';
const M2_TABLES = [
  'attribute_definitions',
  'attribute_options',
  'attribute_template_versions',
  'attribute_templates',
  'brand_localizations',
  'brand_media',
  'brands',
  'categories',
  'category_attribute_templates',
  'category_localizations',
  'category_media',
  'compliance_record_media',
  'compliance_records',
  'compliance_requirements',
  'media_assets',
  'page_module_localizations',
  'page_module_media',
  'page_modules',
  'page_versions',
  'pages',
  'product_attribute_values',
  'product_localizations',
  'product_media',
  'product_secondary_categories',
  'product_versions',
  'products',
  'sku_media',
  'sku_option_values',
  'skus',
] as const;

describe('M2 catalog database isolation and invariants', () => {
  loadEnvironment({ path: '.env.test.example', quiet: true });
  const databaseUrl = process.env.DATABASE_RUNTIME_URL;
  if (!databaseUrl) throw new Error('DATABASE_RUNTIME_URL is required');
  const client = createRuntimePrismaClient(databaseUrl);

  const contextFor = (storeId: string, storeCode: string) =>
    createStoreContext({
      actor: { id: ACTOR_ID, type: 'admin' },
      correlationId: randomUUID(),
      locale: 'vi',
      storeCode,
      storeId,
    });

  beforeAll(async () => client.$connect());
  afterAll(async () => client.$disconnect());

  it('fails closed without StoreContext and allows the same code in different stores', async () => {
    await expect(client.$queryRaw`SELECT id FROM brands`).resolves.toEqual([]);

    const code = `brand-${randomUUID().slice(0, 8)}`;
    const beautyId = randomUUID();
    const fashionId = randomUUID();
    await withStoreTransaction(
      client,
      contextFor(BEAUTY_STORE_ID, 'beauty-local'),
      async (transaction) => {
        await transaction.$executeRaw`INSERT INTO brands (id, store_id, code, updated_at) VALUES (${beautyId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${code}, now())`;
      },
    );
    await withStoreTransaction(
      client,
      contextFor(FASHION_STORE_ID, 'fashion-local'),
      async (transaction) => {
        await transaction.$executeRaw`INSERT INTO brands (id, store_id, code, updated_at) VALUES (${fashionId}::uuid, ${FASHION_STORE_ID}::uuid, ${code}, now())`;
        const visible = await transaction.$queryRaw<
          Array<{ id: string }>
        >`SELECT id FROM brands WHERE code = ${code}`;
        expect(visible).toEqual([{ id: fashionId }]);
      },
    );
  });

  it('seeds identifiable local catalog foundations and M2 store permissions', async () => {
    const result = await withStoreTransaction(
      client,
      contextFor(BEAUTY_STORE_ID, 'beauty-local'),
      async (transaction) => {
        const categories = await transaction.$queryRaw<Array<{ code: string }>>`
          SELECT code FROM categories WHERE code IN ('beauty', 'beauty-general') ORDER BY code
        `;
        const permissions = await transaction.$queryRaw<Array<{ permission_code: string }>>`
          SELECT srp.permission_code
          FROM store_role_permissions srp
          JOIN store_roles sr ON sr.store_id = srp.store_id AND sr.id = srp.role_id
          WHERE sr.code = 'store-admin' AND srp.permission_code LIKE 'store.catalog.%'
          ORDER BY srp.permission_code
        `;
        return { categories, permissions };
      },
    );

    expect(result).toEqual({
      categories: [{ code: 'beauty' }, { code: 'beauty-general' }],
      permissions: [
        { permission_code: 'store.catalog.manage' },
        { permission_code: 'store.catalog.publish' },
        { permission_code: 'store.catalog.read' },
      ],
    });
  });

  it('enables forced RLS and store immutability on every M2 table', async () => {
    const metadata = await client.$queryRawUnsafe<
      Array<{
        relforcerowsecurity: boolean;
        relname: string;
        relrowsecurity: boolean;
        trigger_count: bigint;
      }>
    >(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
        count(t.oid) FILTER (WHERE t.tgname = c.relname || '_store_immutable')::bigint AS trigger_count
      FROM pg_class c
      LEFT JOIN pg_trigger t ON t.tgrelid = c.oid AND NOT t.tgisinternal
      WHERE c.relnamespace = 'public'::regnamespace
        AND c.relname IN (${M2_TABLES.map((table) => `'${table}'`).join(',')})
      GROUP BY c.relname, c.relrowsecurity, c.relforcerowsecurity
      ORDER BY c.relname
    `);

    expect(metadata.map((row) => row.relname)).toEqual([...M2_TABLES].sort());
    expect(metadata.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
    expect(metadata.every((row) => row.trigger_count === 1n)).toBe(true);
  });

  it('derives canonical SKU option keys and hashes inside the database', async () => {
    const brandId = randomUUID();
    const productId = randomUUID();
    const skuId = randomUUID();
    const result = await withStoreTransaction(
      client,
      contextFor(BEAUTY_STORE_ID, 'beauty-local'),
      async (transaction) => {
        await transaction.$executeRaw`INSERT INTO brands (id, store_id, code, updated_at) VALUES (${brandId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${`brand-${brandId.slice(0, 8)}`}, now())`;
        await transaction.$executeRaw`INSERT INTO products (id, store_id, code, brand_id, main_category_id, attribute_template_version_id, updated_at)
          VALUES (${productId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${`product-${productId.slice(0, 8)}`}, ${brandId}::uuid,
            '12000000-0000-4000-8000-000000000001'::uuid, '14000000-0000-4000-8000-000000000001'::uuid, now())`;
        await transaction.$executeRaw`INSERT INTO skus (id, store_id, product_id, code, sale_price_vnd, option_combination_key, option_combination_hash, updated_at)
          VALUES (${skuId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${productId}::uuid, ${`sku-${skuId.slice(0, 8)}`}, 100000, 'pending=placeholder', ${'c'.repeat(64)}, now())`;
        await transaction.$executeRaw`INSERT INTO sku_option_values (store_id, sku_id, attribute_definition_id, option_id)
          VALUES (${BEAUTY_STORE_ID}::uuid, ${skuId}::uuid, '15000000-0000-4000-8000-000000000001'::uuid, '16000000-0000-4000-8000-000000000001'::uuid)`;
        return transaction.$queryRaw<
          Array<{ option_combination_hash: string; option_combination_key: string }>
        >`
          SELECT option_combination_key, option_combination_hash FROM skus WHERE id = ${skuId}::uuid
        `;
      },
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.option_combination_key).toBe('shade=default');
    expect(result[0]?.option_combination_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result[0]?.option_combination_hash).not.toBe('c'.repeat(64));
  });

  it('rejects cross-store category, product and media relationships', async () => {
    const brandId = randomUUID();
    const categoryId = randomUUID();
    const mediaId = randomUUID();
    await withStoreTransaction(
      client,
      contextFor(BEAUTY_STORE_ID, 'beauty-local'),
      async (transaction) => {
        await transaction.$executeRaw`INSERT INTO brands (id, store_id, code, updated_at) VALUES (${brandId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${`brand-${brandId.slice(0, 8)}`}, now())`;
        await transaction.$executeRaw`INSERT INTO categories (id, store_id, code, depth, updated_at) VALUES (${categoryId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${`category-${categoryId.slice(0, 8)}`}, 1, now())`;
        await transaction.$executeRaw`INSERT INTO media_assets (id, store_id, object_key, mime_type, byte_size, checksum_sha256, original_filename, updated_at) VALUES (${mediaId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${`test/${BEAUTY_STORE_ID}/product/${mediaId}`}, 'image/webp', 10, ${'a'.repeat(64)}, 'test.webp', now())`;
      },
    );

    await expect(
      withStoreTransaction(
        client,
        contextFor(FASHION_STORE_ID, 'fashion-local'),
        async (transaction) => {
          const productId = randomUUID();
          await transaction.$executeRaw`INSERT INTO products (id, store_id, code, brand_id, main_category_id, updated_at) VALUES (${productId}::uuid, ${FASHION_STORE_ID}::uuid, ${`product-${productId.slice(0, 8)}`}, ${brandId}::uuid, ${categoryId}::uuid, now())`;
        },
      ),
    ).rejects.toThrow();

    await expect(
      withStoreTransaction(
        client,
        contextFor(FASHION_STORE_ID, 'fashion-local'),
        async (transaction) => {
          await transaction.$executeRaw`INSERT INTO category_media (store_id, category_id, media_id, purpose) VALUES (${FASHION_STORE_ID}::uuid, ${categoryId}::uuid, ${mediaId}::uuid, 'COVER')`;
        },
      ),
    ).rejects.toThrow();
  });

  it('enforces category shape and immutable store ownership', async () => {
    const categoryId = randomUUID();
    await expect(
      withStoreTransaction(
        client,
        contextFor(BEAUTY_STORE_ID, 'beauty-local'),
        async (transaction) => {
          await transaction.$executeRaw`INSERT INTO categories (id, store_id, parent_id, code, depth, updated_at) VALUES (${categoryId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${categoryId}::uuid, ${`category-${categoryId.slice(0, 8)}`}, 2, now())`;
        },
      ),
    ).rejects.toThrow();

    const validCategoryId = randomUUID();
    await withStoreTransaction(
      client,
      contextFor(BEAUTY_STORE_ID, 'beauty-local'),
      async (transaction) => {
        await transaction.$executeRaw`INSERT INTO categories (id, store_id, code, depth, updated_at) VALUES (${validCategoryId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${`category-${validCategoryId.slice(0, 8)}`}, 1, now())`;
      },
    );
    await expect(
      withStoreTransaction(
        client,
        contextFor(BEAUTY_STORE_ID, 'beauty-local'),
        async (transaction) =>
          transaction.$executeRaw`UPDATE categories SET store_id = ${FASHION_STORE_ID}::uuid WHERE id = ${validCategoryId}::uuid`,
      ),
    ).rejects.toThrow();
  });

  it('protects activated templates, reviewed compliance and published versions from mutation', async () => {
    const brandId = randomUUID();
    const categoryId = randomUUID();
    const templateId = randomUUID();
    const templateVersionId = randomUUID();
    const productId = randomUUID();
    const requirementId = randomUUID();
    const complianceId = randomUUID();
    const productVersionId = randomUUID();
    const pageId = randomUUID();
    const pageVersionId = randomUUID();
    await withStoreTransaction(
      client,
      contextFor(BEAUTY_STORE_ID, 'beauty-local'),
      async (transaction) => {
        await transaction.$executeRaw`INSERT INTO brands (id, store_id, code, updated_at) VALUES (${brandId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${`brand-${brandId.slice(0, 8)}`}, now())`;
        await transaction.$executeRaw`INSERT INTO categories (id, store_id, code, depth, updated_at) VALUES (${categoryId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${`category-${categoryId.slice(0, 8)}`}, 1, now())`;
        await transaction.$executeRaw`INSERT INTO attribute_templates (id, store_id, code, industry, status, current_version, updated_at) VALUES (${templateId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${`template-${templateId.slice(0, 8)}`}, 'BEAUTY', 'ACTIVE', 1, now())`;
        await transaction.$executeRaw`INSERT INTO attribute_template_versions (id, store_id, template_id, version, name, status, activated_at) VALUES (${templateVersionId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${templateId}::uuid, 1, 'Immutable', 'ACTIVE', now())`;
        await transaction.$executeRaw`INSERT INTO products (id, store_id, code, brand_id, main_category_id, updated_at) VALUES (${productId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${`product-${productId.slice(0, 8)}`}, ${brandId}::uuid, ${categoryId}::uuid, now())`;
        await transaction.$executeRaw`INSERT INTO compliance_requirements (id, store_id, code, industry, document_type, blocking, version, updated_at) VALUES (${requirementId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${`requirement-${requirementId.slice(0, 8)}`}, 'BEAUTY', 'TEST_DOCUMENT', false, 1, now())`;
        await transaction.$executeRaw`INSERT INTO compliance_records (id, store_id, product_id, requirement_id, status, submitted_by, reviewed_by, reviewed_at) VALUES (${complianceId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${productId}::uuid, ${requirementId}::uuid, 'APPROVED', ${ACTOR_ID}::uuid, ${randomUUID()}::uuid, now())`;
        await transaction.$executeRaw`INSERT INTO product_versions (id, store_id, product_id, version, publication_status, snapshot, content_hash, created_by, published_at) VALUES (${productVersionId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${productId}::uuid, 1, 'PUBLISHED', '{}'::jsonb, ${'b'.repeat(64)}, ${ACTOR_ID}::uuid, now())`;
        await transaction.$executeRaw`INSERT INTO pages (id, store_id, code, updated_at) VALUES (${pageId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${`page-${pageId.slice(0, 8)}`}, now())`;
        await transaction.$executeRaw`INSERT INTO page_versions (id, store_id, page_id, version, publication_status, published_at, created_by) VALUES (${pageVersionId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${pageId}::uuid, 1, 'PUBLISHED', now(), ${ACTOR_ID}::uuid)`;
      },
    );

    const mutations = [
      `UPDATE attribute_template_versions SET name = 'Tampered' WHERE id = '${templateVersionId}'::uuid`,
      `UPDATE compliance_records SET review_note = 'Tampered' WHERE id = '${complianceId}'::uuid`,
      `UPDATE product_versions SET snapshot = '{"tampered":true}'::jsonb WHERE id = '${productVersionId}'::uuid`,
      `UPDATE page_versions SET published_at = now() + interval '1 day' WHERE id = '${pageVersionId}'::uuid`,
    ];
    for (const mutation of mutations) {
      await expect(
        withStoreTransaction(
          client,
          contextFor(BEAUTY_STORE_ID, 'beauty-local'),
          async (transaction) => transaction.$executeRawUnsafe(mutation),
        ),
      ).rejects.toThrow();
    }
  });
});
