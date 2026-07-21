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
  syncProductsSearchProjection,
  withStoreTransaction,
} from '@zalo-shop/database';
import { createStoreContext } from '@zalo-shop/domain';

const FASHION_STORE_ID = '10000000-0000-4000-8000-000000000002';
const FASHION_CATEGORY_ID = '12000000-0000-4000-8000-000000000002';
const FASHION_TEMPLATE_ID = '14000000-0000-4000-8000-000000000002';
const FASHION_WAREHOUSE_ID = '17000000-0000-4000-8000-000000000002';

describe('M3.6 public availability and promotion projection', () => {
  loadEnvironment({ path: '.env.test.example', quiet: true, override: true });
  const config = parseRuntimeConfig();
  const owner = new PrismaClient({ datasourceUrl: config.DATABASE_URL });
  const runtime = createRuntimePrismaClient(config.DATABASE_RUNTIME_URL);
  const suffix = randomUUID().slice(0, 8);
  const fixture = {
    adminId: randomUUID(),
    balanceIds: [randomUUID(), randomUUID()],
    brandId: randomUUID(),
    productIds: [randomUUID(), randomUUID()],
    promotionIds: [randomUUID(), randomUUID()],
    promotionVersionIds: [randomUUID(), randomUUID()],
    skuIds: [randomUUID(), randomUUID()],
  };
  const productCodes = [`m36-promo-coat-${suffix}`, `m36-paused-shirt-${suffix}`];
  const productSearchTerms = [`aurora ${suffix}`, `basalt ${suffix}`];
  const skuCodes = [`m36-promo-coat-sku-${suffix}`, `m36-paused-shirt-sku-${suffix}`];
  const promotionCodes = [`m36-active-${suffix}`, `m36-paused-${suffix}`];
  let app: INestApplication;

  const api = () => request(app.getHttpServer() as Server);
  const context = createStoreContext({
    actor: { id: fixture.adminId, type: 'admin' },
    correlationId: randomUUID(),
    locale: 'vi',
    storeCode: 'fashion-local',
    storeId: FASHION_STORE_ID,
  });

  async function createPromotion(index: number, active: boolean): Promise<void> {
    const promotionId = fixture.promotionIds[index]!;
    const versionId = fixture.promotionVersionIds[index]!;
    await owner.promotion.create({
      data: {
        code: promotionCodes[index]!,
        createdByAdminId: fixture.adminId,
        id: promotionId,
        storeId: FASHION_STORE_ID,
        updatedByAdminId: fixture.adminId,
      },
    });
    await owner.promotionVersion.create({
      data: {
        benefitMethod: 'PERCENTAGE_BPS',
        bucket: 'ITEM',
        id: versionId,
        percentageBps: 1_000,
        priority: index,
        promotionId,
        startsAt: new Date(Date.now() - 60_000),
        storeId: FASHION_STORE_ID,
        versionNumber: 1,
      },
    });
    await owner.promotionVersionLocalization.createMany({
      data: [
        {
          locale: 'vi',
          name: `Khuyến mãi ${suffix} ${index}`,
          promotionVersionId: versionId,
          storeId: FASHION_STORE_ID,
        },
        {
          locale: 'en',
          name: `Fashion offer ${suffix} ${index}`,
          promotionVersionId: versionId,
          storeId: FASHION_STORE_ID,
        },
        {
          locale: 'zh',
          name: `M36 服装优惠 ${suffix} ${index}`,
          promotionVersionId: versionId,
          storeId: FASHION_STORE_ID,
        },
      ],
    });
    await owner.promotionTarget.create({
      data: {
        id: randomUUID(),
        promotionVersionId: versionId,
        storeId: FASHION_STORE_ID,
        ...(index === 0
          ? { productId: fixture.productIds[index], targetType: 'PRODUCT' as const }
          : { skuId: fixture.skuIds[index], targetType: 'SKU' as const }),
      },
    });
    await owner.promotionVersion.update({
      data: {
        publishedAt: new Date(),
        publishedByAdminId: fixture.adminId,
        status: 'PUBLISHED',
      },
      where: { id: versionId },
    });
    await owner.promotion.update({
      data: {
        activeVersionId: versionId,
        status: 'ACTIVE',
        version: { increment: 1 },
      },
      where: { id: promotionId },
    });
    if (!active) {
      await owner.promotion.update({
        data: { status: 'PAUSED', version: { increment: 1 } },
        where: { id: promotionId },
      });
    }
  }

  beforeAll(async () => {
    await Promise.all([owner.$connect(), runtime.$connect()]);
    const email = `m36-projection-${suffix}@example.test`;
    await owner.adminUser.create({
      data: {
        displayName: 'M3.6 projection admin',
        email,
        emailNormalized: email,
        id: fixture.adminId,
        passwordHash: 'test-fixture-not-used',
      },
    });
    await owner.brand.create({
      data: { code: `m36-fashion-${suffix}`, id: fixture.brandId, storeId: FASHION_STORE_ID },
    });
    await owner.brandLocalization.createMany({
      data: [
        {
          brandId: fixture.brandId,
          locale: 'vi',
          name: 'Thuong hieu M36',
          storeId: FASHION_STORE_ID,
        },
        { brandId: fixture.brandId, locale: 'en', name: 'M36 Fashion', storeId: FASHION_STORE_ID },
      ],
    });
    for (const [index, productId] of fixture.productIds.entries()) {
      const publishedAt = new Date(Date.now() - index * 1_000);
      await owner.product.create({
        data: {
          attributeTemplateVersionId: FASHION_TEMPLATE_ID,
          brandId: fixture.brandId,
          code: productCodes[index]!,
          id: productId,
          mainCategoryId: FASHION_CATEGORY_ID,
          publishedAt,
          status: 'PUBLISHED',
          storeId: FASHION_STORE_ID,
        },
      });
      await owner.productLocalization.createMany({
        data: [
          {
            locale: 'vi',
            name: `San pham M36 ${index}`,
            productId,
            storeId: FASHION_STORE_ID,
          },
          {
            locale: 'en',
            name: index === 0 ? `M36 Aurora Coat ${suffix}` : `M36 Basalt Shirt ${suffix}`,
            productId,
            storeId: FASHION_STORE_ID,
          },
        ],
      });
      await owner.productVersion.create({
        data: {
          contentHash: createHash('sha256').update(`${productId}:projection`).digest('hex'),
          createdBy: fixture.adminId,
          productId,
          publicationStatus: 'PUBLISHED',
          publishedAt,
          publishedBy: fixture.adminId,
          snapshot: { fixture: 'm3.6-projection' },
          storeId: FASHION_STORE_ID,
          version: 1,
        },
      });
      await owner.sku.create({
        data: {
          code: skuCodes[index]!,
          id: fixture.skuIds[index],
          optionCombinationHash: `${index + 4}`.repeat(64),
          optionCombinationKey: `m36=${index}`,
          productId,
          salePriceVnd: index === 0 ? 320_000 : 180_000,
          storeId: FASHION_STORE_ID,
        },
      });
      await owner.inventoryBalance.create({
        data: {
          id: fixture.balanceIds[index],
          skuId: fixture.skuIds[index],
          storeId: FASHION_STORE_ID,
          warehouseId: FASHION_WAREHOUSE_ID,
        },
      });
    }
    await adjustInventory(runtime, context, {
      items: [
        {
          delta: 7,
          expectedVersion: 1,
          reasonCode: 'M36_PROJECTION_STOCK',
          skuId: fixture.skuIds[0]!,
          warehouseId: FASHION_WAREHOUSE_ID,
        },
      ],
      operationKey: `m36-projection-stock-${suffix}`,
      operationType: 'IMPORT',
    });
    await Promise.all([createPromotion(0, true), createPromotion(1, false)]);
    await withStoreTransaction(runtime, context, (transaction) =>
      syncProductsSearchProjection(transaction, FASHION_STORE_ID, fixture.productIds),
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
      await transaction.productSearchDocument.deleteMany({
        where: { productId: { in: fixture.productIds } },
      });
      await transaction.promotionTarget.deleteMany({
        where: { promotionVersionId: { in: fixture.promotionVersionIds } },
      });
      await transaction.promotionVersionLocalization.deleteMany({
        where: { promotionVersionId: { in: fixture.promotionVersionIds } },
      });
      await transaction.promotionVersion.deleteMany({
        where: { id: { in: fixture.promotionVersionIds } },
      });
      await transaction.promotion.deleteMany({ where: { id: { in: fixture.promotionIds } } });
      await transaction.inventoryMovement.deleteMany({
        where: { balanceId: { in: fixture.balanceIds } },
      });
      await transaction.inventoryOperation.deleteMany({
        where: { operationKey: `m36-projection-stock-${suffix}` },
      });
      await transaction.inventoryBalance.deleteMany({ where: { id: { in: fixture.balanceIds } } });
      await transaction.sku.deleteMany({ where: { id: { in: fixture.skuIds } } });
      await transaction.productVersion.deleteMany({
        where: { productId: { in: fixture.productIds } },
      });
      await transaction.productLocalization.deleteMany({
        where: { productId: { in: fixture.productIds } },
      });
      await transaction.product.deleteMany({ where: { id: { in: fixture.productIds } } });
      await transaction.brandLocalization.deleteMany({ where: { brandId: fixture.brandId } });
      await transaction.brand.deleteMany({ where: { id: fixture.brandId } });
      await transaction.adminUser.deleteMany({ where: { id: fixture.adminId } });
    });
    await Promise.all([runtime.$disconnect(), owner.$disconnect()]);
  });

  it('projects only active published promotion targets into search and filters on promotion', async () => {
    const promoted = await api()
      .get(
        `/v1/search/products?locale=en&q=${encodeURIComponent(productSearchTerms[0]!)}&on_promotion=true`,
      )
      .set('X-Store-Code', 'fashion-local')
      .expect(200);
    expect(promoted.body.items).toEqual([
      expect.objectContaining({
        available: true,
        available_quantity: 7,
        product_code: productCodes[0],
        promotion_summary: {
          code: promotionCodes[0],
          label: `Fashion offer ${suffix} 0`,
        },
      }),
    ]);

    const paused = await api()
      .get(
        `/v1/search/products?locale=en&q=${encodeURIComponent(productSearchTerms[1]!)}&on_promotion=true`,
      )
      .set('X-Store-Code', 'fashion-local')
      .expect(200);
    expect(paused.body.items).toEqual([]);

    const withoutPromotion = await api()
      .get(
        `/v1/search/products?locale=en&q=${encodeURIComponent(productSearchTerms[1]!)}&on_promotion=false`,
      )
      .set('X-Store-Code', 'fashion-local')
      .expect(200);
    expect(withoutPromotion.body.items).toEqual([
      expect.objectContaining({ product_code: productCodes[1], promotion_summary: null }),
    ]);

    await api()
      .get(`/v1/search/products?locale=en&q=${encodeURIComponent(productSearchTerms[0]!)}`)
      .set('X-Store-Code', 'beauty-local')
      .expect(200)
      .expect(({ body }) => expect(body.items).toEqual([]));
  });

  it('adds default-fulfillment availability and localized promotion summaries to catalog views', async () => {
    const detail = await api()
      .get(`/v1/catalog/products/${productCodes[0]}?locale=en`)
      .set('X-Store-Code', 'fashion-local')
      .expect(200);
    expect(detail.body).toMatchObject({
      available: true,
      available_quantity: 7,
      code: productCodes[0],
      promotion_summary: { code: promotionCodes[0], label: `Fashion offer ${suffix} 0` },
    });
    expect(detail.body.skus).toEqual([
      expect.objectContaining({ available: true, available_quantity: 7, code: skuCodes[0] }),
    ]);

    const vietnameseDetail = await api()
      .get(`/v1/catalog/products/${productCodes[0]}?locale=vi`)
      .set('X-Store-Code', 'fashion-local')
      .expect(200);
    expect(vietnameseDetail.body.promotion_summary).toEqual({
      code: promotionCodes[0],
      label: `Khuyến mãi ${suffix} 0`,
    });

    const chineseDetail = await api()
      .get(`/v1/catalog/products/${productCodes[0]}?locale=zh`)
      .set('X-Store-Code', 'fashion-local')
      .expect(200);
    expect(chineseDetail.body.promotion_summary).toEqual({
      code: promotionCodes[0],
      label: `M36 服装优惠 ${suffix} 0`,
    });

    const page = await api()
      .get(`/v1/catalog/products?locale=en&brand_code=m36-fashion-${suffix}`)
      .set('X-Store-Code', 'fashion-local')
      .expect(200);
    expect(page.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          available: true,
          available_quantity: 7,
          code: productCodes[0],
          promotion_summary: expect.objectContaining({ code: promotionCodes[0] }),
        }),
        expect.objectContaining({
          available: false,
          available_quantity: 0,
          code: productCodes[1],
          promotion_summary: null,
        }),
      ]),
    );
  });
});
