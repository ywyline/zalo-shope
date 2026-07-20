import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { config as loadEnvironment } from 'dotenv';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseRuntimeConfig } from '@zalo-shop/config';
import { PrismaClient } from '@zalo-shop/database';
import { hashSensitive, signJwt } from '@zalo-shop/security';

import { PRODUCT_IMPORT_COLUMNS } from '../../apps/api/src/catalog-admin/product-import';

const BEAUTY_STORE_ID = '10000000-0000-4000-8000-000000000001';
const FASHION_STORE_ID = '10000000-0000-4000-8000-000000000002';
const BEAUTY_ROOT_ID = '11000000-0000-4000-8000-000000000001';
const BEAUTY_CATEGORY_ID = '12000000-0000-4000-8000-000000000001';
const BEAUTY_TEMPLATE_VERSION_ID = '14000000-0000-4000-8000-000000000001';

describe('M2.7 product import, versions and batch operations API', () => {
  loadEnvironment({ path: '.env.test.example', quiet: true, override: true });
  const config = parseRuntimeConfig();
  const owner = new PrismaClient({ datasourceUrl: config.DATABASE_URL });
  const fixture = {
    adminId: randomUUID(),
    brandCode: `m27-brand-${randomUUID().slice(0, 8)}`,
    brandId: randomUUID(),
    missingProductCode: `m27-missing-${randomUUID().slice(0, 8)}`,
    productCode: `m27-product-${randomUUID().slice(0, 8)}`,
    targetCategoryCode: `m27-target-${randomUUID().slice(0, 8)}`,
    targetCategoryId: randomUUID(),
  };
  let app: INestApplication;
  let ownerConnected = false;
  let token: string;
  let importedProductId: string | undefined;

  const headers = (storeCode = 'beauty-local') => ({
    Authorization: `Bearer ${token}`,
    'X-Store-Code': storeCode,
  });

  function csvRow(
    productCode: string,
    brandCode: string,
    overrides: Partial<Record<(typeof PRODUCT_IMPORT_COLUMNS)[number], string>> = {},
  ) {
    const values: Record<(typeof PRODUCT_IMPORT_COLUMNS)[number], string> = {
      barcode: `893${Math.floor(Math.random() * 1_000_000_000)}`,
      brand_code: brandCode,
      cost_price_vnd: '90000',
      description_en: 'Imported description',
      description_vi: 'Mô tả nhập khẩu',
      description_zh: '导入说明',
      main_category_code: 'beauty-general',
      market_price_vnd: '150000',
      name_en: 'Imported serum',
      name_vi: 'Tinh chất nhập khẩu',
      name_zh: '导入精华',
      product_code: productCode,
      sale_price_vnd: '120000',
      secondary_category_codes: '',
      selling_points_en: 'Gentle',
      selling_points_vi: 'Dịu nhẹ',
      selling_points_zh: '温和',
      sku_code: `${productCode}-default`,
      sku_options: 'shade=default',
      weight_grams: '120',
      ...overrides,
    };
    return PRODUCT_IMPORT_COLUMNS.map((column) => {
      const value = values[column];
      return value.includes(',') || value.includes('"')
        ? `"${value.replaceAll('"', '""')}"`
        : value;
    }).join(',');
  }

  function csv(...rows: string[]) {
    return Buffer.from(`\uFEFF${PRODUCT_IMPORT_COLUMNS.join(',')}\r\n${rows.join('\r\n')}\r\n`);
  }

  beforeAll(async () => {
    await owner.$connect();
    ownerConnected = true;
    const email = `m27-${randomUUID()}@example.test`;
    await owner.adminUser.create({
      data: {
        displayName: 'M2.7 catalog operator',
        email,
        emailNormalized: email,
        id: fixture.adminId,
        passwordHash: 'test-fixture-not-used',
      },
    });
    const roles = await owner.storeRole.findMany({
      where: { code: 'store-admin', storeId: { in: [BEAUTY_STORE_ID, FASHION_STORE_ID] } },
    });
    await owner.adminStoreRole.createMany({
      data: roles.map((role) => ({
        adminUserId: fixture.adminId,
        grantedBy: fixture.adminId,
        roleId: role.id,
        storeId: role.storeId,
      })),
    });
    await owner.brand.create({
      data: {
        code: fixture.brandCode,
        id: fixture.brandId,
        status: 'ACTIVE',
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.brandLocalization.create({
      data: {
        brandId: fixture.brandId,
        locale: 'vi',
        name: 'Thương hiệu M2.7',
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.category.create({
      data: {
        code: fixture.targetCategoryCode,
        depth: 2,
        id: fixture.targetCategoryId,
        parentId: BEAUTY_ROOT_ID,
        status: 'ACTIVE',
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.categoryAttributeTemplate.create({
      data: {
        categoryId: fixture.targetCategoryId,
        isPrimary: true,
        storeId: BEAUTY_STORE_ID,
        templateVersionId: BEAUTY_TEMPLATE_VERSION_ID,
      },
    });

    const session = await owner.adminSession.create({
      data: {
        adminUserId: fixture.adminId,
        expiresAt: new Date(Date.now() + 3_600_000),
        mfaVerifiedAt: new Date(),
        refreshTokenHash: hashSensitive(randomUUID(), config.PII_HASH_KEY),
        tokenFamilyId: randomUUID(),
      },
    });
    const now = Math.floor(Date.now() / 1_000);
    token = signJwt(
      {
        actor_type: 'admin',
        aud: config.AUTH_JWT_AUDIENCE,
        exp: now + 900,
        iat: now,
        iss: config.AUTH_JWT_ISSUER,
        jti: randomUUID(),
        session_id: session.id,
        sub: fixture.adminId,
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
    if (!ownerConnected) return;
    await owner.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      const products = await transaction.product.findMany({
        select: { id: true },
        where: { createdBy: fixture.adminId },
      });
      const productIds = products.map((product) => product.id);
      const skus = await transaction.sku.findMany({
        select: { id: true },
        where: { productId: { in: productIds } },
      });
      const skuIds = skus.map((sku) => sku.id);
      await transaction.inventoryBalance.deleteMany({ where: { skuId: { in: skuIds } } });
      await transaction.productSearchDocument.deleteMany({
        where: { productId: { in: productIds } },
      });
      await transaction.productVersion.deleteMany({ where: { productId: { in: productIds } } });
      await transaction.skuOptionValue.deleteMany({ where: { skuId: { in: skuIds } } });
      await transaction.sku.deleteMany({ where: { id: { in: skuIds } } });
      await transaction.productLocalization.deleteMany({
        where: { productId: { in: productIds } },
      });
      await transaction.productSecondaryCategory.deleteMany({
        where: { productId: { in: productIds } },
      });
      await transaction.product.deleteMany({ where: { id: { in: productIds } } });
      await transaction.categoryAttributeTemplate.deleteMany({
        where: { categoryId: fixture.targetCategoryId },
      });
      await transaction.category.deleteMany({ where: { id: fixture.targetCategoryId } });
      await transaction.brandLocalization.deleteMany({ where: { brandId: fixture.brandId } });
      await transaction.brand.deleteMany({ where: { id: fixture.brandId } });
      await transaction.auditLog.deleteMany({ where: { actorId: fixture.adminId } });
    });
    await owner.adminStoreRole.deleteMany({ where: { adminUserId: fixture.adminId } });
    await owner.adminSession.deleteMany({ where: { adminUserId: fixture.adminId } });
    await owner.adminUser.deleteMany({ where: { id: fixture.adminId } });
    await owner.$disconnect();
  });

  it('protects the template route and returns the frozen UTF-8 CSV columns', async () => {
    await request(app.getHttpServer() as Server)
      .get(`/v1/admin/catalog/products/imports/template.csv?store_id=${BEAUTY_STORE_ID}`)
      .expect(401);

    const response = await request(app.getHttpServer() as Server)
      .get(`/v1/admin/catalog/products/imports/template.csv?store_id=${BEAUTY_STORE_ID}`)
      .set(headers())
      .expect(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toContain('product-import-template.csv');
    expect(response.text).toContain(PRODUCT_IMPORT_COLUMNS.join(','));
    expect(response.text).not.toContain('inventory');
  });

  it('dry-runs without writes, then imports valid product groups and reports invalid rows', async () => {
    const file = csv(
      csvRow(fixture.productCode, fixture.brandCode),
      csvRow(fixture.missingProductCode, 'missing-brand'),
    );
    const dryRun = await request(app.getHttpServer() as Server)
      .post(`/v1/admin/catalog/products/imports/csv?store_id=${BEAUTY_STORE_ID}&dry_run=true`)
      .set(headers())
      .attach('file', file, { contentType: 'text/csv', filename: 'products.csv' })
      .expect(201);
    expect(dryRun.body).toMatchObject({
      dry_run: true,
      summary: { products_failed: 1, products_validated: 1, rows_failed: 1, rows_validated: 1 },
    });
    expect(
      await owner.product.count({
        where: { code: { in: [fixture.productCode, fixture.missingProductCode] } },
      }),
    ).toBe(0);

    const imported = await request(app.getHttpServer() as Server)
      .post(`/v1/admin/catalog/products/imports/csv?store_id=${BEAUTY_STORE_ID}&dry_run=false`)
      .set(headers())
      .attach('file', file, { contentType: 'text/csv', filename: 'products.csv' })
      .expect(201);
    expect(imported.body).toMatchObject({
      dry_run: false,
      summary: { products_failed: 1, products_imported: 1, rows_failed: 1, rows_imported: 1 },
    });
    expect(imported.body.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ product_code: fixture.productCode, status: 'IMPORTED' }),
        expect.objectContaining({
          errors: [expect.objectContaining({ code: 'REFERENCE_NOT_FOUND' })],
          product_code: fixture.missingProductCode,
          status: 'FAILED',
        }),
      ]),
    );
    importedProductId = imported.body.rows.find(
      (row: { product_code: string }) => row.product_code === fixture.productCode,
    ).product_id as string;
    const product = await owner.product.findUniqueOrThrow({
      include: { skus: true },
      where: { id: importedProductId },
    });
    expect(product).toMatchObject({
      mainCategoryId: BEAUTY_CATEGORY_ID,
      status: 'DRAFT',
      version: 1,
    });
    expect(product.skus).toHaveLength(1);
    expect(product.skus[0]).toMatchObject({ salePriceVnd: 120000n });
  });

  it('reads immutable version history only inside the trusted store context', async () => {
    if (!importedProductId) throw new Error('Imported product fixture missing');
    await owner.productVersion.create({
      data: {
        contentHash: 'c'.repeat(64),
        createdBy: fixture.adminId,
        productId: importedProductId,
        publicationStatus: 'PUBLISHED',
        publishedAt: new Date(),
        publishedBy: fixture.adminId,
        snapshot: {
          name_vi: 'Phiên bản không đổi',
          sale_price_vnd: 120000,
          skus: [{ code: 'private-cost', costPriceVnd: 90000 }],
        },
        storeId: BEAUTY_STORE_ID,
        version: 1,
      },
    });

    await request(app.getHttpServer() as Server)
      .get(`/v1/admin/catalog/products/${importedProductId}/versions?store_id=${BEAUTY_STORE_ID}`)
      .set(headers())
      .expect(200)
      .expect(({ body }) =>
        expect(body.items).toEqual([
          expect.objectContaining({ publicationStatus: 'PUBLISHED', version: 1 }),
        ]),
      );
    await request(app.getHttpServer() as Server)
      .get(`/v1/admin/catalog/products/${importedProductId}/versions/1?store_id=${BEAUTY_STORE_ID}`)
      .set(headers())
      .expect(200)
      .expect(({ body }) => {
        expect(body.snapshot).toMatchObject({
          name_vi: 'Phiên bản không đổi',
          sale_price_vnd: 120000,
          skus: [{ code: 'private-cost' }],
        });
        expect(body.snapshot.skus[0]).not.toHaveProperty('costPriceVnd');
      });
    await request(app.getHttpServer() as Server)
      .get(
        `/v1/admin/catalog/products/${importedProductId}/versions/1?store_id=${FASHION_STORE_ID}`,
      )
      .set(headers('fashion-local'))
      .expect(404);

    await expect(
      owner.productVersion.update({
        data: { snapshot: { tampered: true } },
        where: {
          storeId_productId_version: {
            productId: importedProductId,
            storeId: BEAUTY_STORE_ID,
            version: 1,
          },
        },
      }),
    ).rejects.toThrow();
  });

  it('moves and disables products with per-item transactions, optimistic locks and audit', async () => {
    if (!importedProductId) throw new Error('Imported product fixture missing');
    const missingId = randomUUID();
    const moved = await request(app.getHttpServer() as Server)
      .post(`/v1/admin/catalog/products/batch/move?store_id=${BEAUTY_STORE_ID}`)
      .set(headers())
      .send({
        confirmation_code: 'MOVE',
        items: [
          { expected_version: 1, product_id: importedProductId },
          { expected_version: 1, product_id: missingId },
        ],
        main_category_id: fixture.targetCategoryId,
      })
      .expect(201);
    expect(moved.body).toMatchObject({ summary: { failed: 1, succeeded: 1, total: 2 } });
    expect(
      await owner.product.findUniqueOrThrow({ where: { id: importedProductId } }),
    ).toMatchObject({ mainCategoryId: fixture.targetCategoryId, version: 2 });

    const disabled = await request(app.getHttpServer() as Server)
      .post(`/v1/admin/catalog/products/batch/disable?store_id=${BEAUTY_STORE_ID}`)
      .set(headers())
      .send({
        confirmation_code: 'DISABLE',
        items: [
          { expected_version: 2, product_id: importedProductId },
          { expected_version: 1, product_id: missingId },
        ],
      })
      .expect(201);
    expect(disabled.body).toMatchObject({ summary: { failed: 1, succeeded: 1, total: 2 } });
    expect(
      await owner.product.findUniqueOrThrow({ where: { id: importedProductId } }),
    ).toMatchObject({ enabled: false, status: 'DISABLED', version: 3 });
    expect(
      await owner.auditLog.count({
        where: {
          action: {
            in: [
              'catalog.product.imported',
              'catalog.product.main_category_moved',
              'catalog.product.disabled',
            ],
          },
          actorId: fixture.adminId,
          storeId: BEAUTY_STORE_ID,
        },
      }),
    ).toBe(3);
  });

  it('rejects unsafe upload metadata and duplicate batch targets before mutation', async () => {
    await request(app.getHttpServer() as Server)
      .post(`/v1/admin/catalog/products/imports/csv?store_id=${BEAUTY_STORE_ID}&dry_run=true`)
      .set(headers())
      .attach('file', Buffer.from('not,csv'), {
        contentType: 'application/json',
        filename: 'products.json',
      })
      .expect(400);

    if (!importedProductId) throw new Error('Imported product fixture missing');
    await request(app.getHttpServer() as Server)
      .post(`/v1/admin/catalog/products/batch/disable?store_id=${BEAUTY_STORE_ID}`)
      .set(headers())
      .send({
        confirmation_code: 'DISABLE',
        items: [
          { expected_version: 3, product_id: importedProductId },
          { expected_version: 3, product_id: importedProductId },
        ],
      })
      .expect(400);
    expect(
      await owner.product.findUniqueOrThrow({ where: { id: importedProductId } }),
    ).toMatchObject({ status: 'DISABLED', version: 3 });
  });
});
