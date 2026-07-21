import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { config as loadEnvironment } from 'dotenv';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseRuntimeConfig } from '@zalo-shop/config';
import { PrismaClient } from '@zalo-shop/database';

const BEAUTY_STORE_ID = '10000000-0000-4000-8000-000000000001';
const FASHION_STORE_ID = '10000000-0000-4000-8000-000000000002';
const BEAUTY_LEAF_CATEGORY_ID = '12000000-0000-4000-8000-000000000001';
const FASHION_LEAF_CATEGORY_ID = '12000000-0000-4000-8000-000000000002';
const BEAUTY_DEFINITION_ID = '15000000-0000-4000-8000-000000000001';
const BEAUTY_DEFAULT_OPTION_ID = '16000000-0000-4000-8000-000000000001';
const FASHION_DEFINITION_ID = '15000000-0000-4000-8000-000000000002';
const FASHION_OPTION_ID = '16000000-0000-4000-8000-000000000002';

describe('M2.6 buyer catalog API', () => {
  loadEnvironment({ path: '.env.test.example', quiet: true, override: true });
  const config = parseRuntimeConfig();
  const owner = new PrismaClient({ datasourceUrl: config.DATABASE_URL });
  const fixture = {
    actorId: randomUUID(),
    beautyBrandId: randomUUID(),
    beautyBrandTwoId: randomUUID(),
    beautyMediaIds: [randomUUID(), randomUUID(), randomUUID(), randomUUID()],
    beautyProductIds: [randomUUID(), randomUUID()],
    beautySkuIds: [randomUUID(), randomUUID(), randomUUID()],
    extraOptionId: randomUUID(),
    fashionBrandId: randomUUID(),
    fashionProductId: randomUUID(),
    fashionSkuId: randomUUID(),
    pageId: randomUUID(),
    pageModuleIds: [randomUUID(), randomUUID(), randomUUID()],
    pageVersionId: randomUUID(),
  };
  const suffix = randomUUID().slice(0, 8);
  const sharedBrandCode = `atelier-${suffix}`;
  const secondBrandCode = `ritual-${suffix}`;
  const featuredProductCode = `serum-${suffix}`;
  const valueProductCode = `cleanser-${suffix}`;
  const fashionProductCode = `shirt-${suffix}`;
  const storage = {
    async createReadUrl(objectKey: string) {
      await Promise.resolve();
      return {
        expiresAt: new Date(Date.now() + 300_000),
        url: `https://media.test/${objectKey}`,
      };
    },
    async createUploadTarget() {
      await Promise.resolve();
      throw new Error('Upload is not used by buyer catalog tests');
    },
    async inspectObject() {
      await Promise.resolve();
      throw new Error('Object inspection is not used by buyer catalog tests');
    },
  };
  let app: INestApplication;

  beforeAll(async () => {
    await owner.$connect();
    const existingHome = await owner.page.findUnique({
      where: { storeId_code: { code: 'home', storeId: BEAUTY_STORE_ID } },
    });
    if (existingHome)
      throw new Error('M2.6 integration fixture requires an unused beauty home page');

    await owner.attributeOption.create({
      data: {
        attributeDefinitionId: BEAUTY_DEFINITION_ID,
        code: `rose-${suffix}`,
        id: fixture.extraOptionId,
        labelEn: 'Rose',
        labelVi: 'Hồng',
        labelZh: '玫瑰色',
        sortOrder: 1,
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.brand.createMany({
      data: [
        {
          code: sharedBrandCode,
          id: fixture.beautyBrandId,
          recommended: true,
          sortOrder: 1,
          storeId: BEAUTY_STORE_ID,
        },
        {
          code: secondBrandCode,
          id: fixture.beautyBrandTwoId,
          recommended: false,
          sortOrder: 2,
          storeId: BEAUTY_STORE_ID,
        },
        {
          code: sharedBrandCode,
          id: fixture.fashionBrandId,
          recommended: true,
          storeId: FASHION_STORE_ID,
        },
      ],
    });
    await owner.brandLocalization.createMany({
      data: [
        {
          brandId: fixture.beautyBrandId,
          introduction: 'Chăm sóc dịu nhẹ mỗi ngày',
          locale: 'vi',
          name: 'Atelier Việt',
          storeId: BEAUTY_STORE_ID,
        },
        {
          brandId: fixture.beautyBrandId,
          introduction: '每日温和护理',
          locale: 'zh',
          name: '越南工坊',
          storeId: BEAUTY_STORE_ID,
        },
        {
          brandId: fixture.beautyBrandTwoId,
          locale: 'vi',
          name: 'Nghi thức đẹp',
          storeId: BEAUTY_STORE_ID,
        },
        {
          brandId: fixture.fashionBrandId,
          locale: 'vi',
          name: 'Atelier Thời trang',
          storeId: FASHION_STORE_ID,
        },
      ],
    });

    await owner.mediaAsset.createMany({
      data: fixture.beautyMediaIds.map((id, index) => ({
        altTextEn: index === 0 ? 'Serum bottle' : null,
        altTextVi: index === 0 ? 'Chai tinh chất' : null,
        byteSize: 256,
        checksumSha256: String(index + 1).repeat(64),
        height: 900,
        id,
        mimeType: 'image/webp',
        objectKey: `test/${BEAUTY_STORE_ID}/${index === 2 ? 'page' : index === 3 ? 'brand' : 'product'}/${id}`,
        originalFilename: `m26-${index}.webp`,
        status: 'READY',
        storeId: BEAUTY_STORE_ID,
        width: 720,
      })),
    });
    await owner.brandMedia.create({
      data: {
        brandId: fixture.beautyBrandId,
        mediaId: fixture.beautyMediaIds[3]!,
        purpose: 'LOGO',
        storeId: BEAUTY_STORE_ID,
      },
    });

    await owner.product.createMany({
      data: [
        {
          attributeTemplateVersionId: '14000000-0000-4000-8000-000000000001',
          brandId: fixture.beautyBrandId,
          code: featuredProductCode,
          id: fixture.beautyProductIds[0],
          mainCategoryId: BEAUTY_LEAF_CATEGORY_ID,
          publishedAt: new Date('2026-07-18T01:00:00.000Z'),
          status: 'PUBLISHED',
          storeId: BEAUTY_STORE_ID,
        },
        {
          attributeTemplateVersionId: '14000000-0000-4000-8000-000000000001',
          brandId: fixture.beautyBrandId,
          code: valueProductCode,
          id: fixture.beautyProductIds[1],
          mainCategoryId: BEAUTY_LEAF_CATEGORY_ID,
          publishedAt: new Date('2026-07-17T01:00:00.000Z'),
          status: 'PUBLISHED',
          storeId: BEAUTY_STORE_ID,
        },
        {
          attributeTemplateVersionId: '14000000-0000-4000-8000-000000000002',
          brandId: fixture.fashionBrandId,
          code: fashionProductCode,
          id: fixture.fashionProductId,
          mainCategoryId: FASHION_LEAF_CATEGORY_ID,
          publishedAt: new Date('2026-07-18T01:00:00.000Z'),
          status: 'PUBLISHED',
          storeId: FASHION_STORE_ID,
        },
      ],
    });
    await owner.productLocalization.createMany({
      data: [
        {
          descriptionDocument: { type: 'doc', value: 'Tinh chất cấp ẩm cho làn da dịu mềm.' },
          locale: 'vi',
          name: 'Tinh chất hoa hồng',
          productId: fixture.beautyProductIds[0]!,
          sellingPoints: 'Dịu nhẹ · Cấp ẩm',
          storeId: BEAUTY_STORE_ID,
          subtitle: 'Nghi thức sáng da mỗi ngày',
          usageInstructions: 'Thoa hai giọt sau bước làm sạch.',
        },
        {
          descriptionDocument: { type: 'doc', value: '温和保湿精华。' },
          locale: 'zh',
          name: '玫瑰精华',
          productId: fixture.beautyProductIds[0]!,
          sellingPoints: '温和 · 保湿',
          storeId: BEAUTY_STORE_ID,
        },
        {
          descriptionDocument: { type: 'doc', value: 'Sữa rửa mặt hằng ngày.' },
          locale: 'vi',
          name: 'Sữa rửa mặt mây',
          productId: fixture.beautyProductIds[1]!,
          sellingPoints: 'Sạch thoáng',
          storeId: BEAUTY_STORE_ID,
        },
        {
          descriptionDocument: { type: 'doc', value: 'Áo sơ mi tối giản.' },
          locale: 'vi',
          name: 'Áo sơ mi linen',
          productId: fixture.fashionProductId,
          sellingPoints: 'Thoáng nhẹ',
          storeId: FASHION_STORE_ID,
        },
      ],
    });
    await owner.sku.createMany({
      data: [
        {
          code: `serum-default-${suffix}`,
          id: fixture.beautySkuIds[0],
          marketPriceVnd: 299_000,
          optionCombinationHash: 'a'.repeat(64),
          optionCombinationKey: 'shade=default',
          productId: fixture.beautyProductIds[0],
          salePriceVnd: 249_000,
          storeId: BEAUTY_STORE_ID,
        },
        {
          code: `serum-rose-${suffix}`,
          id: fixture.beautySkuIds[1],
          marketPriceVnd: 329_000,
          optionCombinationHash: 'b'.repeat(64),
          optionCombinationKey: `shade=rose-${suffix}`,
          productId: fixture.beautyProductIds[0],
          salePriceVnd: 279_000,
          storeId: BEAUTY_STORE_ID,
        },
        {
          code: `cleanser-default-${suffix}`,
          id: fixture.beautySkuIds[2],
          optionCombinationHash: 'c'.repeat(64),
          optionCombinationKey: 'shade=default',
          productId: fixture.beautyProductIds[1],
          salePriceVnd: 99_000,
          storeId: BEAUTY_STORE_ID,
        },
        {
          code: `shirt-m-${suffix}`,
          id: fixture.fashionSkuId,
          optionCombinationHash: 'd'.repeat(64),
          optionCombinationKey: 'size=m',
          productId: fixture.fashionProductId,
          salePriceVnd: 399_000,
          storeId: FASHION_STORE_ID,
        },
      ],
    });
    await owner.skuOptionValue.createMany({
      data: [
        {
          attributeDefinitionId: BEAUTY_DEFINITION_ID,
          optionId: BEAUTY_DEFAULT_OPTION_ID,
          skuId: fixture.beautySkuIds[0],
          storeId: BEAUTY_STORE_ID,
        },
        {
          attributeDefinitionId: BEAUTY_DEFINITION_ID,
          optionId: fixture.extraOptionId,
          skuId: fixture.beautySkuIds[1],
          storeId: BEAUTY_STORE_ID,
        },
        {
          attributeDefinitionId: BEAUTY_DEFINITION_ID,
          optionId: BEAUTY_DEFAULT_OPTION_ID,
          skuId: fixture.beautySkuIds[2],
          storeId: BEAUTY_STORE_ID,
        },
        {
          attributeDefinitionId: FASHION_DEFINITION_ID,
          optionId: FASHION_OPTION_ID,
          skuId: fixture.fashionSkuId,
          storeId: FASHION_STORE_ID,
        },
      ],
    });
    await owner.productMedia.createMany({
      data: [
        {
          mediaId: fixture.beautyMediaIds[0],
          productId: fixture.beautyProductIds[0],
          purpose: 'PRIMARY',
          storeId: BEAUTY_STORE_ID,
        },
        {
          mediaId: fixture.beautyMediaIds[1],
          productId: fixture.beautyProductIds[1],
          purpose: 'PRIMARY',
          storeId: BEAUTY_STORE_ID,
        },
      ],
    });

    await owner.page.create({
      data: {
        code: 'home',
        createdBy: fixture.actorId,
        id: fixture.pageId,
        status: 'DRAFT',
        storeId: BEAUTY_STORE_ID,
        updatedBy: fixture.actorId,
      },
    });
    await owner.pageVersion.create({
      data: {
        createdBy: fixture.actorId,
        id: fixture.pageVersionId,
        pageId: fixture.pageId,
        publicationStatus: 'PUBLISHED',
        publishedAt: new Date(),
        publishedBy: fixture.actorId,
        storeId: BEAUTY_STORE_ID,
        version: 1,
      },
    });
    await owner.pageModule.createMany({
      data: [
        {
          backgroundConfig: { color: '#f6ddd4', overlay: 0.08 },
          id: fixture.pageModuleIds[0],
          moduleType: 'HERO',
          pageVersionId: fixture.pageVersionId,
          sortOrder: 0,
          storeId: BEAUTY_STORE_ID,
          targetId: fixture.beautyProductIds[0],
          targetType: 'PRODUCT',
        },
        {
          id: fixture.pageModuleIds[1],
          moduleType: 'PRODUCT_GRID',
          pageVersionId: fixture.pageVersionId,
          sortOrder: 1,
          storeId: BEAUTY_STORE_ID,
        },
        {
          id: fixture.pageModuleIds[2],
          moduleType: 'BANNER',
          pageVersionId: fixture.pageVersionId,
          sortOrder: 2,
          storeId: BEAUTY_STORE_ID,
          visibleFrom: new Date(Date.now() + 86_400_000),
        },
      ],
    });
    const moduleLocalizations = fixture.pageModuleIds.flatMap((pageModuleId, index) =>
      (['vi', 'zh', 'en'] as const).map((locale) => ({
        buttonLabel: index === 0 ? { vi: 'Khám phá', zh: '立即探索', en: 'Explore' }[locale] : null,
        contentConfig:
          index === 1
            ? { item_ids: fixture.beautyProductIds, layout: 'GRID' }
            : { eyebrow: 'M2.6' },
        locale,
        pageModuleId,
        storeId: BEAUTY_STORE_ID,
        summary:
          index === 0
            ? { vi: 'Nghi thức dịu nhẹ', zh: '温和的每日仪式', en: 'A gentle daily ritual' }[locale]
            : null,
        title:
          index === 0
            ? { vi: 'Vẻ đẹp trong từng giọt', zh: '每一滴都闪耀', en: 'Beauty in every drop' }[
                locale
              ]
            : index === 1
              ? { vi: 'Chọn riêng cho bạn', zh: '为你精选', en: 'Selected for you' }[locale]
              : { vi: 'Chưa đến giờ', zh: '尚未开始', en: 'Not yet visible' }[locale],
      })),
    );
    await owner.pageModuleLocalization.createMany({ data: moduleLocalizations });
    await owner.pageModuleMedia.create({
      data: {
        mediaId: fixture.beautyMediaIds[2]!,
        pageModuleId: fixture.pageModuleIds[0]!,
        purpose: 'COVER',
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.page.update({
      data: { currentPublishedVersionId: fixture.pageVersionId, status: 'PUBLISHED' },
      where: { id: fixture.pageId },
    });

    const [{ AppModule }, { ApiExceptionFilter }, { MEDIA_STORAGE_PROVIDER }] = await Promise.all([
      import('../../apps/api/src/app.module'),
      import('../../apps/api/src/api-exception.filter'),
      import('../../apps/api/src/auth/auth.tokens'),
    ]);
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MEDIA_STORAGE_PROVIDER)
      .useValue(storage)
      .compile();
    app = module.createNestApplication();
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await owner.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.pageModuleMedia.deleteMany({
        where: { pageModuleId: { in: fixture.pageModuleIds } },
      });
      await transaction.pageModuleLocalization.deleteMany({
        where: { pageModuleId: { in: fixture.pageModuleIds } },
      });
      await transaction.pageModule.deleteMany({ where: { id: { in: fixture.pageModuleIds } } });
      await transaction.pageVersion.deleteMany({ where: { id: fixture.pageVersionId } });
      await transaction.page.deleteMany({ where: { id: fixture.pageId } });
      const allSkuIds = [...fixture.beautySkuIds, fixture.fashionSkuId];
      await transaction.inventoryBalance.deleteMany({ where: { skuId: { in: allSkuIds } } });
      await transaction.skuOptionValue.deleteMany({ where: { skuId: { in: allSkuIds } } });
      await transaction.productMedia.deleteMany({
        where: { productId: { in: [...fixture.beautyProductIds, fixture.fashionProductId] } },
      });
      await transaction.sku.deleteMany({ where: { id: { in: allSkuIds } } });
      await transaction.productLocalization.deleteMany({
        where: { productId: { in: [...fixture.beautyProductIds, fixture.fashionProductId] } },
      });
      await transaction.product.deleteMany({
        where: { id: { in: [...fixture.beautyProductIds, fixture.fashionProductId] } },
      });
      await transaction.brandMedia.deleteMany({ where: { brandId: fixture.beautyBrandId } });
      await transaction.mediaAsset.deleteMany({ where: { id: { in: fixture.beautyMediaIds } } });
      await transaction.brandLocalization.deleteMany({
        where: {
          brandId: {
            in: [fixture.beautyBrandId, fixture.beautyBrandTwoId, fixture.fashionBrandId],
          },
        },
      });
      await transaction.brand.deleteMany({
        where: {
          id: { in: [fixture.beautyBrandId, fixture.beautyBrandTwoId, fixture.fashionBrandId] },
        },
      });
      await transaction.attributeOption.deleteMany({ where: { id: fixture.extraOptionId } });
    });
    await owner.$disconnect();
  });

  it('serves the published localized home and excludes inactive time windows', async () => {
    const response = await request(app.getHttpServer() as Server)
      .get('/v1/catalog/home?locale=en')
      .set('X-Store-Code', 'beauty-local')
      .expect(200);

    expect(response.body).toMatchObject({
      requested_locale: 'en',
      resolved_locale: 'en',
      store: {
        code: 'beauty-local',
        industry: 'BEAUTY',
        name: 'Beauty Store',
      },
      version: 1,
    });
    expect(response.body.modules).toHaveLength(2);
    expect(response.body.modules[0]).toMatchObject({
      button_label: 'Explore',
      module_type: 'HERO',
      target: { code: featuredProductCode, type: 'PRODUCT' },
      title: 'Beauty in every drop',
    });
    expect(response.body.modules[0].media[0].url).toContain(BEAUTY_STORE_ID);
    expect(response.body.modules[1].items[0]).toMatchObject({
      code: featuredProductCode,
      name: 'Tinh chất hoa hồng',
      requested_locale: 'en',
      resolved_locale: 'vi',
    });

    await request(app.getHttpServer() as Server)
      .get('/v1/catalog/home')
      .set('X-Store-Code', 'fashion-local')
      .expect(404);
  });

  it('lists localized brands, categories and cursor-paginated products with safe VND prices', async () => {
    const brands = await request(app.getHttpServer() as Server)
      .get('/v1/catalog/brands?locale=en&recommended=true')
      .set('X-Store-Code', 'beauty-local')
      .expect(200);
    expect(brands.body.items).toHaveLength(1);
    expect(brands.body.items[0]).toMatchObject({
      code: sharedBrandCode,
      name: 'Atelier Việt',
      requested_locale: 'en',
      resolved_locale: 'vi',
    });
    expect(brands.body.items[0].logo.url).toContain(BEAUTY_STORE_ID);

    const categories = await request(app.getHttpServer() as Server)
      .get('/v1/catalog/categories?locale=zh')
      .set('X-Store-Code', 'beauty-local')
      .expect(200);
    expect(categories.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          children: expect.arrayContaining([expect.objectContaining({ code: 'beauty-general' })]),
          code: 'beauty',
          name: '美妆',
        }),
      ]),
    );

    const firstPage = await request(app.getHttpServer() as Server)
      .get(
        `/v1/catalog/products?brand_code=${sharedBrandCode}&category_code=beauty&sort=price_asc&limit=1&locale=en`,
      )
      .set('X-Store-Code', 'beauty-local')
      .expect(200);
    expect(firstPage.body.items).toHaveLength(1);
    expect(firstPage.body.items[0]).toMatchObject({
      code: valueProductCode,
      price_range_vnd: { maximum: 99_000, minimum: 99_000 },
      resolved_locale: 'vi',
    });
    expect(firstPage.body.next_cursor).toEqual(expect.any(String));

    const secondPage = await request(app.getHttpServer() as Server)
      .get(
        `/v1/catalog/products?brand_code=${sharedBrandCode}&category_code=beauty&sort=price_asc&limit=1&locale=en&cursor=${encodeURIComponent(firstPage.body.next_cursor as string)}`,
      )
      .set('X-Store-Code', 'beauty-local')
      .expect(200);
    expect(secondPage.body.items[0]).toMatchObject({
      code: featuredProductCode,
      price_range_vnd: { maximum: 279_000, minimum: 249_000 },
    });
    expect(secondPage.body.next_cursor).toBeNull();
  });

  it('returns SKU-ready product details and rejects invalid or cross-store lookups', async () => {
    const detail = await request(app.getHttpServer() as Server)
      .get(`/v1/catalog/products/${featuredProductCode}?locale=en`)
      .set('X-Store-Code', 'beauty-local')
      .expect(200);
    expect(detail.body).toMatchObject({
      available: false,
      available_quantity: 0,
      code: featuredProductCode,
      description_document: { type: 'doc', value: 'Tinh chất cấp ẩm cho làn da dịu mềm.' },
      name: 'Tinh chất hoa hồng',
      requested_locale: 'en',
      resolved_locale: 'vi',
      usage_instructions: 'Thoa hai giọt sau bước làm sạch.',
    });
    expect(detail.body).toHaveProperty('promotion_summary');
    if (detail.body.promotion_summary !== null) {
      expect(detail.body.promotion_summary).toEqual(
        expect.objectContaining({ code: expect.any(String), label: expect.any(String) }),
      );
    }
    expect(detail.body.skus).toHaveLength(2);
    expect(detail.body.skus[0]).toMatchObject({ available: false, available_quantity: 0 });
    expect(detail.body.skus[0]).not.toHaveProperty('cost_price_vnd');
    expect(detail.body.skus[0].option_values[0]).toMatchObject({
      attribute_code: 'shade',
      attribute_label: 'Shade',
    });

    await request(app.getHttpServer() as Server)
      .get(`/v1/catalog/products/${fashionProductCode}`)
      .set('X-Store-Code', 'beauty-local')
      .expect(404);
    await request(app.getHttpServer() as Server)
      .get(`/v1/catalog/products/${fashionProductCode}`)
      .set('X-Store-Code', 'fashion-local')
      .expect(200)
      .expect(({ body }) => expect(body.name).toBe('Áo sơ mi linen'));
    await request(app.getHttpServer() as Server)
      .get('/v1/catalog/products?locale=fr')
      .set('X-Store-Code', 'beauty-local')
      .expect(400);
    await request(app.getHttpServer() as Server)
      .get('/v1/catalog/products?limit=101')
      .set('X-Store-Code', 'beauty-local')
      .expect(400);
    await request(app.getHttpServer() as Server)
      .get('/v1/catalog/products?cursor=not-a-cursor')
      .set('X-Store-Code', 'beauty-local')
      .expect(400);
  });
});
