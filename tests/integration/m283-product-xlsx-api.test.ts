import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { config as loadEnvironment } from 'dotenv';
import readXlsxFile from 'read-excel-file/node';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import writeXlsxFile, { type SheetData } from 'write-excel-file/node';

import { parseRuntimeConfig } from '@zalo-shop/config';
import { PrismaClient } from '@zalo-shop/database';
import { hashSensitive, signJwt } from '@zalo-shop/security';

import { PRODUCT_IMPORT_COLUMNS } from '../../apps/api/src/catalog-admin/product-import';
import { PRODUCT_EXPORT_COLUMNS } from '../../apps/api/src/catalog-admin/product-xlsx';

const BEAUTY_STORE_ID = '10000000-0000-4000-8000-000000000001';
const FASHION_STORE_ID = '10000000-0000-4000-8000-000000000002';
const BEAUTY_CATEGORY_ID = '12000000-0000-4000-8000-000000000001';
const FASHION_CATEGORY_ID = '12000000-0000-4000-8000-000000000002';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function binaryParser(
  response: request.Response,
  callback: (error: Error | null, body: unknown) => void,
): void {
  const chunks: Buffer[] = [];
  response.on('data', (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  response.on('end', () => callback(null, Buffer.concat(chunks)));
  response.on('error', (error: Error) => callback(error, Buffer.alloc(0)));
}

describe('M2.8.3 restricted product XLSX API', () => {
  loadEnvironment({ path: '.env.test.example', quiet: true, override: true });
  const config = parseRuntimeConfig();
  const owner = new PrismaClient({ datasourceUrl: config.DATABASE_URL });
  const fixture = {
    beautyBrandCode: `m283-beauty-${randomUUID().slice(0, 8)}`,
    beautyBrandId: randomUUID(),
    fashionBrandCode: `m283-fashion-${randomUUID().slice(0, 8)}`,
    fashionBrandId: randomUUID(),
    fashionProductCode: `m283-fashion-product-${randomUUID().slice(0, 8)}`,
    fashionProductId: randomUUID(),
    importProductCode: `m283-import-${randomUUID().slice(0, 8)}`,
    managerId: randomUUID(),
    missingProductCode: `m283-missing-${randomUUID().slice(0, 8)}`,
    readerId: randomUUID(),
    readerRoleId: randomUUID(),
  };
  let app: INestApplication;
  let managerToken: string;
  let readerToken: string;

  const headers = (token: string, storeCode = 'beauty-local') => ({
    Authorization: `Bearer ${token}`,
    'X-Store-Code': storeCode,
  });

  const accessToken = async (adminId: string): Promise<string> => {
    const session = await owner.adminSession.create({
      data: {
        adminUserId: adminId,
        expiresAt: new Date(Date.now() + 3_600_000),
        mfaVerifiedAt: new Date(),
        refreshTokenHash: hashSensitive(randomUUID(), config.PII_HASH_KEY),
        tokenFamilyId: randomUUID(),
      },
    });
    const now = Math.floor(Date.now() / 1_000);
    return signJwt(
      {
        actor_type: 'admin',
        aud: config.AUTH_JWT_AUDIENCE,
        exp: now + 900,
        iat: now,
        iss: config.AUTH_JWT_ISSUER,
        jti: randomUUID(),
        session_id: session.id,
        sub: adminId,
      },
      config.AUTH_JWT_SECRET,
    );
  };

  function productRow(
    productCode: string,
    brandCode: string,
    overrides: Partial<
      Record<(typeof PRODUCT_IMPORT_COLUMNS)[number], string | number | null>
    > = {},
  ) {
    const values: Record<(typeof PRODUCT_IMPORT_COLUMNS)[number], string | number | null> = {
      barcode: `893${Math.floor(Math.random() * 1_000_000_000)}`,
      brand_code: brandCode,
      cost_price_vnd: 777_777,
      description_en: 'Imported description',
      description_vi: 'Mô tả nhập khẩu',
      description_zh: '导入说明',
      main_category_code: 'beauty-general',
      market_price_vnd: 188_000,
      name_en: 'Imported serum',
      name_vi: 'Tinh chất nhập khẩu',
      name_zh: '导入精华',
      product_code: productCode,
      sale_price_vnd: 123_000,
      secondary_category_codes: null,
      selling_points_en: 'Gentle',
      selling_points_vi: 'Dịu nhẹ',
      selling_points_zh: '温和',
      sku_code: `${productCode}-default`,
      sku_options: 'shade=default',
      weight_grams: 120,
      ...overrides,
    };
    return PRODUCT_IMPORT_COLUMNS.map((column) => values[column]);
  }

  async function importWorkbook(...rows: ReturnType<typeof productRow>[]): Promise<Buffer> {
    return writeXlsxFile([[...PRODUCT_IMPORT_COLUMNS], ...rows] as SheetData, {
      sheet: 'products',
    }).toBuffer();
  }

  beforeAll(async () => {
    await owner.$connect();
    for (const [id, label] of [
      [fixture.managerId, 'manager'],
      [fixture.readerId, 'reader'],
    ] as const) {
      const email = `m283-${label}-${randomUUID()}@example.test`;
      await owner.adminUser.create({
        data: {
          displayName: `M2.8.3 ${label}`,
          email,
          emailNormalized: email,
          id,
          passwordHash: 'test-fixture-not-used',
        },
      });
    }
    const managerRoles = await owner.storeRole.findMany({
      where: { code: 'store-admin', storeId: { in: [BEAUTY_STORE_ID, FASHION_STORE_ID] } },
    });
    await owner.storeRole.create({
      data: {
        code: `m283-reader-${randomUUID().slice(0, 8)}`,
        id: fixture.readerRoleId,
        name: 'M2.8.3 catalog reader',
        permissions: { create: { permissionCode: 'store.catalog.read' } },
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.adminStoreRole.createMany({
      data: [
        ...managerRoles.map((role) => ({
          adminUserId: fixture.managerId,
          grantedBy: fixture.managerId,
          roleId: role.id,
          storeId: role.storeId,
        })),
        {
          adminUserId: fixture.readerId,
          grantedBy: fixture.managerId,
          roleId: fixture.readerRoleId,
          storeId: BEAUTY_STORE_ID,
        },
      ],
    });
    for (const [id, code, storeId, label] of [
      [fixture.beautyBrandId, fixture.beautyBrandCode, BEAUTY_STORE_ID, 'Mỹ phẩm M2.8.3'],
      [fixture.fashionBrandId, fixture.fashionBrandCode, FASHION_STORE_ID, 'Thời trang M2.8.3'],
    ] as const) {
      await owner.brand.create({ data: { code, id, status: 'ACTIVE', storeId } });
      await owner.brandLocalization.create({
        data: { brandId: id, locale: 'vi', name: label, storeId },
      });
    }
    await owner.product.create({
      data: {
        brandId: fixture.fashionBrandId,
        code: fixture.fashionProductCode,
        createdBy: fixture.managerId,
        id: fixture.fashionProductId,
        mainCategoryId: FASHION_CATEGORY_ID,
        storeId: FASHION_STORE_ID,
      },
    });
    await owner.productLocalization.create({
      data: {
        descriptionDocument: { type: 'doc', value: 'Không được xuất sang cửa hàng mỹ phẩm' },
        locale: 'vi',
        name: 'Sản phẩm cửa hàng thời trang',
        productId: fixture.fashionProductId,
        storeId: FASHION_STORE_ID,
      },
    });

    managerToken = await accessToken(fixture.managerId);
    readerToken = await accessToken(fixture.readerId);
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
      const products = await transaction.product.findMany({
        select: { id: true },
        where: { createdBy: fixture.managerId },
      });
      const productIds = products.map(({ id }) => id);
      const skus = await transaction.sku.findMany({
        select: { id: true },
        where: { productId: { in: productIds } },
      });
      const skuIds = skus.map(({ id }) => id);
      await transaction.inventoryBalance.deleteMany({ where: { skuId: { in: skuIds } } });
      await transaction.skuOptionValue.deleteMany({ where: { skuId: { in: skuIds } } });
      await transaction.sku.deleteMany({ where: { id: { in: skuIds } } });
      await transaction.productLocalization.deleteMany({
        where: { productId: { in: productIds } },
      });
      await transaction.productSecondaryCategory.deleteMany({
        where: { productId: { in: productIds } },
      });
      await transaction.product.deleteMany({ where: { id: { in: productIds } } });
      await transaction.brandLocalization.deleteMany({
        where: { brandId: { in: [fixture.beautyBrandId, fixture.fashionBrandId] } },
      });
      await transaction.brand.deleteMany({
        where: { id: { in: [fixture.beautyBrandId, fixture.fashionBrandId] } },
      });
      await transaction.auditLog.deleteMany({ where: { actorId: fixture.managerId } });
    });
    await owner.adminStoreRole.deleteMany({
      where: { adminUserId: { in: [fixture.managerId, fixture.readerId] } },
    });
    await owner.storeRolePermission.deleteMany({ where: { roleId: fixture.readerRoleId } });
    await owner.storeRole.deleteMany({ where: { id: fixture.readerRoleId } });
    await owner.adminSession.deleteMany({
      where: { adminUserId: { in: [fixture.managerId, fixture.readerId] } },
    });
    await owner.adminUser.deleteMany({
      where: { id: { in: [fixture.managerId, fixture.readerId] } },
    });
    await owner.$disconnect();
  });

  it('protects and returns the XLSX template with the frozen worksheet contract', async () => {
    await request(app.getHttpServer() as Server)
      .get(`/v1/admin/catalog/products/imports/template.xlsx?store_id=${BEAUTY_STORE_ID}`)
      .expect(401);

    const response = await request(app.getHttpServer() as Server)
      .get(`/v1/admin/catalog/products/imports/template.xlsx?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(readerToken))
      .buffer(true)
      .parse(binaryParser)
      .expect(200);
    expect(response.headers['content-type']).toContain(XLSX_MIME);
    expect(response.headers['content-disposition']).toContain('product-import-template.xlsx');
    expect(Buffer.isBuffer(response.body)).toBe(true);
    const [sheet] = await readXlsxFile(response.body as Buffer);
    expect(sheet).toMatchObject({ sheet: 'products', data: [[...PRODUCT_IMPORT_COLUMNS]] });
  });

  it('enforces read/manage RBAC and rejects untrusted file metadata', async () => {
    const file = await importWorkbook(
      productRow(fixture.importProductCode, fixture.beautyBrandCode),
    );
    await request(app.getHttpServer() as Server)
      .post(`/v1/admin/catalog/products/imports/xlsx?store_id=${BEAUTY_STORE_ID}&dry_run=true`)
      .set(headers(readerToken))
      .attach('file', file, { contentType: XLSX_MIME, filename: 'products.xlsx' })
      .expect(403);
    await request(app.getHttpServer() as Server)
      .post(`/v1/admin/catalog/products/imports/xlsx?store_id=${BEAUTY_STORE_ID}&dry_run=true`)
      .set(headers(managerToken))
      .attach('file', file, { contentType: 'application/vnd.ms-excel', filename: 'products.xls' })
      .expect(400);
    expect(await owner.product.count({ where: { code: fixture.importProductCode } })).toBe(0);
  });

  it('dry-runs without writes and then imports only valid product groups as drafts', async () => {
    const file = await importWorkbook(
      productRow(fixture.importProductCode, fixture.beautyBrandCode),
      productRow(fixture.missingProductCode, 'missing-brand'),
    );
    const dryRun = await request(app.getHttpServer() as Server)
      .post(`/v1/admin/catalog/products/imports/xlsx?store_id=${BEAUTY_STORE_ID}&dry_run=true`)
      .set(headers(managerToken))
      .attach('file', file, { contentType: XLSX_MIME, filename: 'products.xlsx' })
      .expect(201);
    expect(dryRun.body).toMatchObject({
      dry_run: true,
      summary: { products_failed: 1, products_validated: 1, rows_failed: 1, rows_validated: 1 },
    });
    expect(
      await owner.product.count({
        where: { code: { in: [fixture.importProductCode, fixture.missingProductCode] } },
      }),
    ).toBe(0);

    const imported = await request(app.getHttpServer() as Server)
      .post(`/v1/admin/catalog/products/imports/xlsx?store_id=${BEAUTY_STORE_ID}&dry_run=false`)
      .set(headers(managerToken))
      .attach('file', file, { contentType: XLSX_MIME, filename: 'products.xlsx' })
      .expect(201);
    expect(imported.body).toMatchObject({
      dry_run: false,
      summary: { products_failed: 1, products_imported: 1, rows_failed: 1, rows_imported: 1 },
    });
    const product = await owner.product.findUniqueOrThrow({
      include: { skus: true },
      where: {
        storeId_code: { code: fixture.importProductCode, storeId: BEAUTY_STORE_ID },
      },
    });
    expect(product).toMatchObject({ mainCategoryId: BEAUTY_CATEGORY_ID, status: 'DRAFT' });
    expect(product.skus).toEqual([
      expect.objectContaining({ costPriceVnd: 777777n, salePriceVnd: 123000n }),
    ]);
  });

  it('exports only the authorized store and never exposes costs or internal identifiers', async () => {
    const beauty = await request(app.getHttpServer() as Server)
      .get(`/v1/admin/catalog/products/exports/products.xlsx?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(readerToken))
      .buffer(true)
      .parse(binaryParser)
      .expect(200);
    expect(beauty.headers['content-type']).toContain(XLSX_MIME);
    expect(beauty.headers['content-disposition']).toContain('products.xlsx');
    const [beautySheet] = await readXlsxFile(beauty.body as Buffer);
    expect(beautySheet?.data[0]).toEqual([...PRODUCT_EXPORT_COLUMNS]);
    expect(beautySheet?.data[0]).not.toEqual(
      expect.arrayContaining(['cost_price_vnd', 'store_id', 'product_id', 'sku_id']),
    );
    const productCodeIndex = PRODUCT_EXPORT_COLUMNS.indexOf('product_code');
    const salePriceIndex = PRODUCT_EXPORT_COLUMNS.indexOf('sale_price_vnd');
    const beautyRows = beautySheet?.data.slice(1) ?? [];
    expect(beautyRows.some((row) => row[productCodeIndex] === fixture.importProductCode)).toBe(
      true,
    );
    expect(beautyRows.some((row) => row[productCodeIndex] === fixture.fashionProductCode)).toBe(
      false,
    );
    expect(beautyRows.flat()).not.toContain(777_777);
    expect(beautyRows.flat()).not.toContain('777777');
    expect(
      beautyRows.find((row) => row[productCodeIndex] === fixture.importProductCode)?.[
        salePriceIndex
      ],
    ).toBe(123_000);

    await request(app.getHttpServer() as Server)
      .get(`/v1/admin/catalog/products/exports/products.xlsx?store_id=${FASHION_STORE_ID}`)
      .set(headers(managerToken, 'beauty-local'))
      .expect(403);

    const fashion = await request(app.getHttpServer() as Server)
      .get(`/v1/admin/catalog/products/exports/products.xlsx?store_id=${FASHION_STORE_ID}`)
      .set(headers(managerToken, 'fashion-local'))
      .buffer(true)
      .parse(binaryParser)
      .expect(200);
    const [fashionSheet] = await readXlsxFile(fashion.body as Buffer);
    const fashionRows = fashionSheet?.data.slice(1) ?? [];
    const descriptionViIndex = PRODUCT_EXPORT_COLUMNS.indexOf('description_vi');
    expect(fashionRows.some((row) => row[productCodeIndex] === fixture.fashionProductCode)).toBe(
      true,
    );
    expect(fashionRows.some((row) => row[productCodeIndex] === fixture.importProductCode)).toBe(
      false,
    );
    expect(
      fashionRows.find((row) => row[productCodeIndex] === fixture.fashionProductCode)?.[
        descriptionViIndex
      ],
    ).toBe('Không được xuất sang cửa hàng mỹ phẩm');
  });
});
