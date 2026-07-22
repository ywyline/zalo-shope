import { createHash, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { config as loadEnvironment } from 'dotenv';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseRuntimeConfig } from '@zalo-shop/config';
import {
  adjustInventory,
  createRuntimePrismaClient,
  PrismaClient,
  rebuildStoreSearchProjection,
  syncProductSearchProjection,
  withStoreTransaction,
} from '@zalo-shop/database';
import { createStoreContext } from '@zalo-shop/domain';
import { hashSensitive, signJwt } from '@zalo-shop/security';

const BEAUTY_STORE_ID = '10000000-0000-4000-8000-000000000001';
const FASHION_STORE_ID = '10000000-0000-4000-8000-000000000002';
const BEAUTY_CATEGORY_ID = '12000000-0000-4000-8000-000000000001';
const FASHION_CATEGORY_ID = '12000000-0000-4000-8000-000000000002';
const FASHION_TEMPLATE_ID = '14000000-0000-4000-8000-000000000002';
const BEAUTY_WAREHOUSE_ID = '17000000-0000-4000-8000-000000000001';
const FASHION_WAREHOUSE_ID = '17000000-0000-4000-8000-000000000002';

describe('M3.4 multilingual search, facets and member history', () => {
  loadEnvironment({ path: '.env.test.example', quiet: true, override: true });
  const config = parseRuntimeConfig();
  const owner = new PrismaClient({ datasourceUrl: config.DATABASE_URL });
  const runtime = createRuntimePrismaClient(config.DATABASE_RUNTIME_URL);
  const suffix = randomUUID().slice(0, 8);
  const fixture = {
    beautyBrandId: randomUUID(),
    beautyProductIds: [randomUUID(), randomUUID()],
    beautySkuIds: [randomUUID(), randomUUID()],
    fashionBrandId: randomUUID(),
    fashionProductId: randomUUID(),
    fashionSkuId: randomUUID(),
    memberId: randomUUID(),
    definitionId: randomUUID(),
    optionId: randomUUID(),
    templateId: randomUUID(),
    templateVersionId: randomUUID(),
  };
  const beautyBrandCode = `m34-beauty-${suffix}`;
  const fashionBrandCode = `m34-fashion-${suffix}`;
  const balmCode = `m34-balm-${suffix}`;
  const cleanserCode = `m34-cleanser-${suffix}`;
  const sentinelCode = `m34-sentinel-${suffix}`;
  let accessToken: string;
  let app: INestApplication;

  const context = (store: 'beauty' | 'fashion' = 'beauty') =>
    createStoreContext({
      actor: { id: fixture.memberId, type: 'member' },
      correlationId: randomUUID(),
      locale: 'vi',
      storeCode: store === 'beauty' ? 'beauty-local' : 'fashion-local',
      storeId: store === 'beauty' ? BEAUTY_STORE_ID : FASHION_STORE_ID,
    });

  beforeAll(async () => {
    await Promise.all([owner.$connect(), runtime.$connect()]);
    await owner.attributeTemplate.create({
      data: {
        code: `m34-search-${suffix}`,
        createdBy: fixture.memberId,
        id: fixture.templateId,
        industry: 'BEAUTY',
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.attributeTemplateVersion.create({
      data: {
        createdBy: fixture.memberId,
        id: fixture.templateVersionId,
        name: `M3.4 search ${suffix}`,
        storeId: BEAUTY_STORE_ID,
        templateId: fixture.templateId,
        version: 1,
      },
    });
    await owner.attributeDefinition.create({
      data: {
        code: 'shade',
        dataType: 'OPTION',
        filterable: true,
        id: fixture.definitionId,
        labelEn: 'Shade',
        labelVi: 'Tông màu',
        labelZh: '色号',
        purpose: 'SPECIFICATION',
        required: true,
        storeId: BEAUTY_STORE_ID,
        templateVersionId: fixture.templateVersionId,
      },
    });
    await owner.attributeOption.create({
      data: {
        attributeDefinitionId: fixture.definitionId,
        code: `rose-${suffix}`,
        id: fixture.optionId,
        labelEn: 'Rose',
        labelVi: 'Hồng',
        labelZh: '玫瑰色',
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.attributeTemplateVersion.update({
      data: { activatedAt: new Date(), activatedBy: fixture.memberId, status: 'ACTIVE' },
      where: { id: fixture.templateVersionId },
    });
    await owner.attributeTemplate.update({
      data: { currentVersion: 1, status: 'ACTIVE', updatedBy: fixture.memberId },
      where: { id: fixture.templateId },
    });
    await owner.brand.createMany({
      data: [
        { code: beautyBrandCode, id: fixture.beautyBrandId, storeId: BEAUTY_STORE_ID },
        { code: fashionBrandCode, id: fixture.fashionBrandId, storeId: FASHION_STORE_ID },
      ],
    });
    await owner.brandLocalization.createMany({
      data: [
        ...(['vi', 'zh', 'en'] as const).map((locale) => ({
          brandId: fixture.beautyBrandId,
          locale,
          name: { en: 'Bloom Lab', vi: 'Phòng lab Đẹp', zh: '美研所' }[locale],
          storeId: BEAUTY_STORE_ID,
        })),
        ...(['vi', 'zh', 'en'] as const).map((locale) => ({
          brandId: fixture.fashionBrandId,
          locale,
          name: { en: 'Sentinel Studio', vi: 'Xưởng Canh Gác', zh: '哨兵工作室' }[locale],
          storeId: FASHION_STORE_ID,
        })),
      ],
    });
    const products = [
      {
        brandId: fixture.beautyBrandId,
        code: balmCode,
        id: fixture.beautyProductIds[0]!,
        mainCategoryId: BEAUTY_CATEGORY_ID,
        storeId: BEAUTY_STORE_ID,
        templateId: fixture.templateVersionId,
      },
      {
        brandId: fixture.beautyBrandId,
        code: cleanserCode,
        id: fixture.beautyProductIds[1]!,
        mainCategoryId: BEAUTY_CATEGORY_ID,
        storeId: BEAUTY_STORE_ID,
        templateId: fixture.templateVersionId,
      },
      {
        brandId: fixture.fashionBrandId,
        code: sentinelCode,
        id: fixture.fashionProductId,
        mainCategoryId: FASHION_CATEGORY_ID,
        storeId: FASHION_STORE_ID,
        templateId: FASHION_TEMPLATE_ID,
      },
    ];
    for (const [index, product] of products.entries()) {
      const publishedAt = new Date(Date.now() - index * 60_000);
      await owner.product.create({
        data: {
          attributeTemplateVersionId: product.templateId,
          brandId: product.brandId,
          code: product.code,
          id: product.id,
          mainCategoryId: product.mainCategoryId,
          publishedAt,
          status: 'PUBLISHED',
          storeId: product.storeId,
        },
      });
      await owner.productVersion.create({
        data: {
          contentHash: createHash('sha256').update(`${product.id}:v1`).digest('hex'),
          createdBy: fixture.memberId,
          productId: product.id,
          publicationStatus: 'PUBLISHED',
          publishedAt,
          publishedBy: fixture.memberId,
          snapshot: { fixture: 'm3.4-search' },
          storeId: product.storeId,
          version: 1,
        },
      });
    }
    const localized = [
      {
        names: { en: 'Beautiful Rose Balm', vi: 'Son dưỡng ĐẸP hoa hồng', zh: '玫瑰润唇膏' },
        points: { en: 'Hydrating care', vi: 'Dưỡng ẩm dịu nhẹ', zh: '温和保湿' },
        productId: fixture.beautyProductIds[0]!,
        storeId: BEAUTY_STORE_ID,
      },
      {
        names: { en: 'Cloud Cleanser', vi: 'Sữa rửa mặt mây', zh: '云朵洁面乳' },
        points: { en: 'Daily cleanse', vi: 'Làm sạch mỗi ngày', zh: '每日清洁' },
        productId: fixture.beautyProductIds[1]!,
        storeId: BEAUTY_STORE_ID,
      },
      {
        names: { en: 'Sentinel Linen Shirt', vi: 'Sơ mi linen canh gác', zh: '哨兵亚麻衬衫' },
        points: { en: 'Cross-store sentinel', vi: 'Dữ liệu cửa hàng khác', zh: '跨商城哨兵' },
        productId: fixture.fashionProductId,
        storeId: FASHION_STORE_ID,
      },
    ];
    await owner.productLocalization.createMany({
      data: localized.flatMap((product) =>
        (['vi', 'zh', 'en'] as const).map((locale) => ({
          locale,
          name: product.names[locale],
          productId: product.productId,
          sellingPoints: product.points[locale],
          storeId: product.storeId,
        })),
      ),
    });
    await owner.sku.createMany({
      data: [
        {
          code: `m34-balm-sku-${suffix}`,
          id: fixture.beautySkuIds[0],
          optionCombinationHash: '1'.repeat(64),
          optionCombinationKey: `shade=rose-${suffix}`,
          productId: fixture.beautyProductIds[0],
          salePriceVnd: 100_000,
          storeId: BEAUTY_STORE_ID,
        },
        {
          code: `m34-cleanser-sku-${suffix}`,
          id: fixture.beautySkuIds[1],
          optionCombinationHash: '2'.repeat(64),
          optionCombinationKey: 'shade=default',
          productId: fixture.beautyProductIds[1],
          salePriceVnd: 200_000,
          storeId: BEAUTY_STORE_ID,
        },
        {
          code: `m34-fashion-sku-${suffix}`,
          id: fixture.fashionSkuId,
          optionCombinationHash: '3'.repeat(64),
          optionCombinationKey: 'size=m',
          productId: fixture.fashionProductId,
          salePriceVnd: 300_000,
          storeId: FASHION_STORE_ID,
        },
      ],
    });
    await owner.skuOptionValue.create({
      data: {
        attributeDefinitionId: fixture.definitionId,
        optionId: fixture.optionId,
        skuId: fixture.beautySkuIds[0],
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.inventoryBalance.createMany({
      data: [
        {
          skuId: fixture.beautySkuIds[0],
          storeId: BEAUTY_STORE_ID,
          warehouseId: BEAUTY_WAREHOUSE_ID,
        },
        {
          skuId: fixture.beautySkuIds[1],
          storeId: BEAUTY_STORE_ID,
          warehouseId: BEAUTY_WAREHOUSE_ID,
        },
        {
          skuId: fixture.fashionSkuId,
          storeId: FASHION_STORE_ID,
          warehouseId: FASHION_WAREHOUSE_ID,
        },
      ],
    });
    await adjustInventory(runtime, context(), {
      items: [
        {
          delta: 9,
          expectedVersion: 1,
          reasonCode: 'M34_TEST_INITIAL_STOCK',
          skuId: fixture.beautySkuIds[0],
          warehouseId: BEAUTY_WAREHOUSE_ID,
        },
      ],
      operationKey: `m34-search-stock-${suffix}`,
      operationType: 'IMPORT',
    });
    await adjustInventory(runtime, context('fashion'), {
      items: [
        {
          delta: 4,
          expectedVersion: 1,
          reasonCode: 'M34_TEST_INITIAL_STOCK',
          skuId: fixture.fashionSkuId,
          warehouseId: FASHION_WAREHOUSE_ID,
        },
      ],
      operationKey: `m34-fashion-stock-${suffix}`,
      operationType: 'IMPORT',
    });
    await withStoreTransaction(runtime, context(), (transaction) =>
      rebuildStoreSearchProjection(transaction, BEAUTY_STORE_ID),
    );
    await withStoreTransaction(runtime, context('fashion'), (transaction) =>
      rebuildStoreSearchProjection(transaction, FASHION_STORE_ID),
    );

    await owner.member.create({
      data: {
        displayName: 'M3.4 search member',
        id: fixture.memberId,
        preferredLocale: 'vi',
        storeId: BEAUTY_STORE_ID,
      },
    });
    const session = await owner.memberSession.create({
      data: {
        expiresAt: new Date(Date.now() + 3_600_000),
        memberId: fixture.memberId,
        refreshTokenHash: hashSensitive(randomUUID(), config.PII_HASH_KEY),
        storeId: BEAUTY_STORE_ID,
        tokenFamilyId: randomUUID(),
      },
    });
    const now = Math.floor(Date.now() / 1_000);
    accessToken = signJwt(
      {
        actor_type: 'member',
        aud: config.AUTH_JWT_AUDIENCE,
        exp: now + 900,
        iat: now,
        iss: config.AUTH_JWT_ISSUER,
        jti: randomUUID(),
        session_id: session.id,
        store_id: BEAUTY_STORE_ID,
        sub: fixture.memberId,
      },
      config.AUTH_JWT_SECRET,
    );

    const [{ AppModule }, { ApiExceptionFilter }] = await Promise.all([
      import('../../apps/api/src/app.module'),
      import('../../apps/api/src/api-exception.filter'),
    ]);
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await owner.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.memberSearchHistory.deleteMany({ where: { memberId: fixture.memberId } });
      await transaction.searchQueryStat.deleteMany({
        where: { storeId: { in: [BEAUTY_STORE_ID, FASHION_STORE_ID] } },
      });
      await transaction.memberSession.deleteMany({ where: { memberId: fixture.memberId } });
      await transaction.member.deleteMany({ where: { id: fixture.memberId } });
      const productIds = [...fixture.beautyProductIds, fixture.fashionProductId];
      const skuIds = [...fixture.beautySkuIds, fixture.fashionSkuId];
      await transaction.productSearchDocument.deleteMany({
        where: { productId: { in: productIds } },
      });
      await transaction.inventoryMovement.deleteMany({
        where: { balance: { skuId: { in: skuIds } } },
      });
      await transaction.inventoryOperation.deleteMany({
        where: {
          operationKey: { in: [`m34-search-stock-${suffix}`, `m34-fashion-stock-${suffix}`] },
        },
      });
      await transaction.inventoryBalance.deleteMany({ where: { skuId: { in: skuIds } } });
      await transaction.skuOptionValue.deleteMany({ where: { skuId: { in: skuIds } } });
      await transaction.sku.deleteMany({ where: { id: { in: skuIds } } });
      await transaction.productVersion.deleteMany({ where: { productId: { in: productIds } } });
      await transaction.productLocalization.deleteMany({
        where: { productId: { in: productIds } },
      });
      await transaction.product.deleteMany({ where: { id: { in: productIds } } });
      await transaction.brandLocalization.deleteMany({
        where: { brandId: { in: [fixture.beautyBrandId, fixture.fashionBrandId] } },
      });
      await transaction.brand.deleteMany({
        where: { id: { in: [fixture.beautyBrandId, fixture.fashionBrandId] } },
      });
      await transaction.attributeOption.deleteMany({ where: { id: fixture.optionId } });
      await transaction.attributeDefinition.deleteMany({ where: { id: fixture.definitionId } });
      await transaction.attributeTemplateVersion.deleteMany({
        where: { id: fixture.templateVersionId },
      });
      await transaction.attributeTemplate.deleteMany({ where: { id: fixture.templateId } });
    });
    await Promise.all([runtime.$disconnect(), owner.$disconnect()]);
  });

  const api = () => request(app.getHttpServer() as Server);

  it('matches Vietnamese with and without accents plus Chinese and English without cross-store leakage', async () => {
    for (const [locale, query, name] of [
      ['vi', 'son duong dep', 'Son dưỡng ĐẸP hoa hồng'],
      ['zh', '玫瑰润唇', '玫瑰润唇膏'],
      ['en', 'beautiful balm', 'Beautiful Rose Balm'],
    ] as const) {
      const response = await api()
        .get(`/v1/search/products?locale=${locale}&q=${encodeURIComponent(query)}`)
        .set('X-Store-Code', 'beauty-local')
        .expect(200);
      expect(response.body.items).toEqual(
        expect.arrayContaining([expect.objectContaining({ name, product_code: balmCode })]),
      );
      expect(response.body.items).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ product_code: sentinelCode })]),
      );
    }

    const fashion = await api()
      .get('/v1/search/products?q=sentinel&locale=en')
      .set('X-Store-Code', 'fashion-local')
      .expect(200);
    expect(fashion.body.items[0]).toMatchObject({ product_code: sentinelCode });
  });

  it('supports facets, root categories, attributes, stock, prices and cursor-bound sorting', async () => {
    const facets = await api()
      .get('/v1/search/facets?locale=vi')
      .set('X-Store-Code', 'beauty-local')
      .expect(200);
    expect(facets.body.brands).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: beautyBrandCode, count: 2 })]),
    );
    expect(facets.body.categories).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'beauty', count: 2 })]),
    );
    expect(facets.body.attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'shade',
          options: expect.arrayContaining([
            expect.objectContaining({ code: `rose-${suffix}`, count: 1 }),
          ]),
        }),
      ]),
    );

    for (const path of [
      `brand_codes=${beautyBrandCode}`,
      'category_codes=beauty',
      `attribute_filters=shade:rose-${suffix}`,
      'in_stock=true',
      'min_price_vnd=90000&max_price_vnd=110000',
    ]) {
      const filtered = await api()
        .get(`/v1/search/products?${path}`)
        .set('X-Store-Code', 'beauty-local')
        .expect(200);
      expect(filtered.body.items).toEqual(
        expect.arrayContaining([expect.objectContaining({ product_code: balmCode })]),
      );
    }

    const first = await api()
      .get('/v1/search/products?sort=price_asc&limit=1')
      .set('X-Store-Code', 'beauty-local')
      .expect(200);
    expect(first.body.items[0]).toMatchObject({ product_code: balmCode });
    expect(first.body.next_cursor).toEqual(expect.any(String));
    const second = await api()
      .get(
        `/v1/search/products?sort=price_asc&limit=1&cursor=${encodeURIComponent(first.body.next_cursor as string)}`,
      )
      .set('X-Store-Code', 'beauty-local')
      .expect(200);
    expect(second.body.items[0]).toMatchObject({ product_code: cleanserCode });
    await api()
      .get(
        `/v1/search/products?sort=price_desc&limit=1&cursor=${encodeURIComponent(first.body.next_cursor as string)}`,
      )
      .set('X-Store-Code', 'beauty-local')
      .expect(400);

    const promotion = await api()
      .get('/v1/search/products?on_promotion=true')
      .set('X-Store-Code', 'beauty-local')
      .expect(200);
    for (const item of promotion.body.items as Array<{ promotion_summary: unknown }>) {
      expect(item.promotion_summary).toEqual(
        expect.objectContaining({ code: expect.any(String), label: expect.any(String) }),
      );
    }
  });

  it('aggregates safe suggestions and keeps authenticated history private and clearable', async () => {
    await api()
      .get('/v1/search/products?q=son%20duong&locale=vi')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('X-Store-Code', 'beauty-local')
      .expect(200);
    await api()
      .get('/v1/search/products?q=son%20duong&locale=vi')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('X-Store-Code', 'beauty-local')
      .expect(200);

    const history = await api()
      .get('/v1/members/me/search-history')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('X-Store-Code', 'beauty-local')
      .expect(200);
    expect(history.body.items).toHaveLength(1);
    expect(history.body.items[0]).toMatchObject({ locale: 'vi', query: 'son duong' });
    await api()
      .get('/v1/members/me/search-history')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('X-Store-Code', 'fashion-local')
      .expect(401);

    const suggestions = await api()
      .get('/v1/search/suggestions?q=son&locale=vi')
      .set('X-Store-Code', 'beauty-local')
      .expect(200);
    expect(suggestions.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'PRODUCT', product_code: balmCode }),
      ]),
    );

    await api()
      .get('/v1/search/products?q=0912345678')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('X-Store-Code', 'beauty-local')
      .expect(200);
    expect(
      await owner.memberSearchHistory.count({
        where: { displayQuery: '0912345678', memberId: fixture.memberId },
      }),
    ).toBe(0);

    await api()
      .delete('/v1/members/me/search-history')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('X-Store-Code', 'beauty-local')
      .expect(204);
    expect(await owner.memberSearchHistory.count({ where: { memberId: fixture.memberId } })).toBe(
      0,
    );
  });

  it('parameterizes hostile text and rejects malformed query collections', async () => {
    const hostile = await api()
      .get(`/v1/search/products?q=${encodeURIComponent("' OR 1=1; DROP TABLE products; --")}`)
      .set('X-Store-Code', 'beauty-local')
      .expect(200);
    expect(hostile.body.items).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ product_code: sentinelCode })]),
    );
    await api()
      .get(`/v1/search/products?brand_codes=${beautyBrandCode}&brand_codes=${beautyBrandCode}`)
      .set('X-Store-Code', 'beauty-local')
      .expect(400);
    await api()
      .get('/v1/search/products?attribute_filters=invalid')
      .set('X-Store-Code', 'beauty-local')
      .expect(400);
    await api()
      .get('/v1/search/products?unknown_filter=true')
      .set('X-Store-Code', 'beauty-local')
      .expect(400);
  });

  it('fails closed after the configured Redis-backed public search limit', async () => {
    const { SearchRateLimiter } = await import('../../apps/api/src/search/search-rate-limiter');
    const limiter = new SearchRateLimiter({
      ...config,
      SEARCH_RATE_LIMIT_MAX_REQUESTS: 10,
      SEARCH_RATE_LIMIT_WINDOW_SECONDS: 10,
    });
    const address = `m34-rate-${randomUUID()}`;
    try {
      for (let requestNumber = 0; requestNumber < 10; requestNumber += 1) {
        await limiter.assertAllowed(address, 'search', BEAUTY_STORE_ID);
      }
      await expect(limiter.assertAllowed(address, 'search', BEAUTY_STORE_ID)).rejects.toMatchObject(
        { status: 429 },
      );
      // The same source may use the other independently isolated storefront.
      await expect(
        limiter.assertAllowed(address, 'search', FASHION_STORE_ID),
      ).resolves.toBeUndefined();

      const memberA = `m34-member-a-${randomUUID()}`;
      const memberB = `m34-member-b-${randomUUID()}`;
      for (let requestNumber = 0; requestNumber < 10; requestNumber += 1) {
        await limiter.assertAllowed(address, 'coupon-claim', BEAUTY_STORE_ID, memberA);
      }
      await expect(
        limiter.assertAllowed(address, 'coupon-claim', BEAUTY_STORE_ID, memberA),
      ).rejects.toMatchObject({ status: 429 });
      await expect(
        limiter.assertAllowed(address, 'coupon-claim', BEAUTY_STORE_ID, memberB),
      ).resolves.toBeUndefined();
      // A member's coupon bucket must not consume its pricing bucket.
      await expect(
        limiter.assertAllowed(address, 'pricing', BEAUTY_STORE_ID, memberA),
      ).resolves.toBeUndefined();
    } finally {
      limiter.onApplicationShutdown();
    }
  });

  it('recovers missing projections and removes disabled products synchronously', async () => {
    await withStoreTransaction(runtime, context(), (transaction) =>
      transaction.productSearchDocument.deleteMany({
        where: { productId: fixture.beautyProductIds[0], storeId: BEAUTY_STORE_ID },
      }),
    );
    const missing = await api()
      .get('/v1/search/products?q=beautiful&locale=en')
      .set('X-Store-Code', 'beauty-local')
      .expect(200);
    expect(missing.body.items).toEqual([]);

    await withStoreTransaction(runtime, context(), (transaction) =>
      rebuildStoreSearchProjection(transaction, BEAUTY_STORE_ID),
    );
    const restored = await api()
      .get('/v1/search/products?q=beautiful&locale=en')
      .set('X-Store-Code', 'beauty-local')
      .expect(200);
    expect(restored.body.items[0]).toMatchObject({ product_code: balmCode });

    await owner.product.update({
      data: { enabled: false, status: 'DISABLED' },
      where: { id: fixture.beautyProductIds[1] },
    });
    const guardedFacets = await api()
      .get('/v1/search/facets?locale=en')
      .set('X-Store-Code', 'beauty-local')
      .expect(200);
    expect(guardedFacets.body.brands).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: beautyBrandCode, count: 1 })]),
    );
    await withStoreTransaction(runtime, context(), (transaction) =>
      syncProductSearchProjection(transaction, BEAUTY_STORE_ID, fixture.beautyProductIds[1]!),
    );
    expect(
      await owner.productSearchDocument.count({
        where: { productId: fixture.beautyProductIds[1] },
      }),
    ).toBe(0);
  });
});
