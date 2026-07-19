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

const BEAUTY_STORE_ID = '10000000-0000-4000-8000-000000000001';
const FASHION_STORE_ID = '10000000-0000-4000-8000-000000000002';
const BEAUTY_CATEGORY_ID = '12000000-0000-4000-8000-000000000001';
const BEAUTY_TEMPLATE_VERSION_ID = '14000000-0000-4000-8000-000000000001';

describe('M2.8.2 catalog workbench read models', () => {
  loadEnvironment({ path: '.env.test.example', quiet: true, override: true });
  const config = parseRuntimeConfig();
  const owner = new PrismaClient({ datasourceUrl: config.DATABASE_URL });
  const fixture = {
    brandId: randomUUID(),
    catalogOnlyId: randomUUID(),
    catalogOnlyRoleId: randomUUID(),
    mediaId: randomUUID(),
    productId: randomUUID(),
    readerId: randomUUID(),
    readerRoleId: randomUUID(),
    recordId: randomUUID(),
    requirementId: randomUUID(),
  };
  let app: INestApplication;
  let catalogOnlyToken: string;
  let readerToken: string;

  const headers = (token: string, storeCode = 'beauty-local') => ({
    Authorization: `Bearer ${token}`,
    'X-Store-Code': storeCode,
  });

  const createAccessToken = async (adminId: string): Promise<string> => {
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

  beforeAll(async () => {
    await owner.$connect();
    for (const [id, label] of [
      [fixture.readerId, 'reader'],
      [fixture.catalogOnlyId, 'catalog-only'],
    ] as const) {
      const email = `m282-${label}-${randomUUID()}@example.test`;
      await owner.adminUser.create({
        data: {
          displayName: `M2.8.2 ${label}`,
          email,
          emailNormalized: email,
          id,
          passwordHash: 'test-fixture-not-used',
        },
      });
    }
    await owner.storeRole.create({
      data: {
        code: `m282-reader-${randomUUID().slice(0, 8)}`,
        id: fixture.readerRoleId,
        name: 'M2.8.2 catalog and compliance reader',
        permissions: {
          create: [
            { permissionCode: 'store.catalog.read' },
            { permissionCode: 'store.compliance.read' },
          ],
        },
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.storeRole.create({
      data: {
        code: `m282-catalog-${randomUUID().slice(0, 8)}`,
        id: fixture.catalogOnlyRoleId,
        name: 'M2.8.2 catalog-only reader',
        permissions: { create: { permissionCode: 'store.catalog.read' } },
        storeId: BEAUTY_STORE_ID,
      },
    });
    const fashionAdminRole = await owner.storeRole.findUniqueOrThrow({
      where: { storeId_code: { code: 'store-admin', storeId: FASHION_STORE_ID } },
    });
    await owner.adminStoreRole.createMany({
      data: [
        {
          adminUserId: fixture.readerId,
          grantedBy: fixture.readerId,
          roleId: fixture.readerRoleId,
          storeId: BEAUTY_STORE_ID,
        },
        {
          adminUserId: fixture.readerId,
          grantedBy: fixture.readerId,
          roleId: fashionAdminRole.id,
          storeId: FASHION_STORE_ID,
        },
        {
          adminUserId: fixture.catalogOnlyId,
          grantedBy: fixture.readerId,
          roleId: fixture.catalogOnlyRoleId,
          storeId: BEAUTY_STORE_ID,
        },
      ],
    });
    await owner.brand.create({
      data: {
        code: `m282-brand-${randomUUID().slice(0, 8)}`,
        id: fixture.brandId,
        status: 'ACTIVE',
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.product.create({
      data: {
        attributeTemplateVersionId: BEAUTY_TEMPLATE_VERSION_ID,
        brandId: fixture.brandId,
        code: `m282-product-${randomUUID().slice(0, 8)}`,
        id: fixture.productId,
        mainCategoryId: BEAUTY_CATEGORY_ID,
        status: 'DRAFT',
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.productLocalization.create({
      data: {
        descriptionDocument: { type: 'text', value: 'Mô tả' },
        locale: 'vi',
        name: 'Sản phẩm hồ sơ',
        productId: fixture.productId,
        sellingPoints: 'Dịu nhẹ',
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.complianceRequirement.create({
      data: {
        blocking: true,
        categoryId: BEAUTY_CATEGORY_ID,
        code: `m282-declaration-${randomUUID().slice(0, 8)}`,
        documentType: 'VN_DECLARATION',
        id: fixture.requirementId,
        industry: 'BEAUTY',
        storeId: BEAUTY_STORE_ID,
        version: 1,
      },
    });
    await owner.mediaAsset.create({
      data: {
        byteSize: 128,
        checksumSha256: 'd'.repeat(64),
        id: fixture.mediaId,
        mimeType: 'image/webp',
        objectKey: `test/${BEAUTY_STORE_ID}/compliance/${fixture.mediaId}`,
        originalFilename: 'm282-secret-document.webp',
        status: 'READY',
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.complianceRecord.create({
      data: {
        documentNumber: 'VN-DECL-12345678',
        id: fixture.recordId,
        productId: fixture.productId,
        requirementId: fixture.requirementId,
        status: 'PENDING_REVIEW',
        storeId: BEAUTY_STORE_ID,
        submittedBy: fixture.catalogOnlyId,
      },
    });
    await owner.complianceRecordMedia.create({
      data: {
        complianceRecordId: fixture.recordId,
        mediaId: fixture.mediaId,
        storeId: BEAUTY_STORE_ID,
      },
    });

    readerToken = await createAccessToken(fixture.readerId);
    catalogOnlyToken = await createAccessToken(fixture.catalogOnlyId);
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
      await transaction.complianceRecordMedia.deleteMany({
        where: { complianceRecordId: fixture.recordId },
      });
      await transaction.complianceRecord.deleteMany({ where: { id: fixture.recordId } });
      await transaction.complianceRequirement.deleteMany({ where: { id: fixture.requirementId } });
      await transaction.mediaAsset.deleteMany({ where: { id: fixture.mediaId } });
      await transaction.productLocalization.deleteMany({ where: { productId: fixture.productId } });
      await transaction.product.deleteMany({ where: { id: fixture.productId } });
      await transaction.brand.deleteMany({ where: { id: fixture.brandId } });
      await transaction.adminStoreRole.deleteMany({
        where: { adminUserId: { in: [fixture.readerId, fixture.catalogOnlyId] } },
      });
      await transaction.storeRolePermission.deleteMany({
        where: { roleId: { in: [fixture.readerRoleId, fixture.catalogOnlyRoleId] } },
      });
      await transaction.storeRole.deleteMany({
        where: { id: { in: [fixture.readerRoleId, fixture.catalogOnlyRoleId] } },
      });
      await transaction.adminSession.deleteMany({
        where: { adminUserId: { in: [fixture.readerId, fixture.catalogOnlyId] } },
      });
      await transaction.adminUser.deleteMany({
        where: { id: { in: [fixture.readerId, fixture.catalogOnlyId] } },
      });
    });
    await owner.$disconnect();
  });

  it('returns bounded masked compliance records without file or actor details', async () => {
    const response = await request(app.getHttpServer() as Server)
      .get(
        `/v1/admin/compliance/overview?store_id=${BEAUTY_STORE_ID}&limit=25&status=PENDING_REVIEW`,
      )
      .set(headers(readerToken))
      .expect(200);
    expect(response.body.requirements).toContainEqual(
      expect.objectContaining({ code: expect.stringMatching(/^m282-declaration-/) }),
    );
    expect(response.body.records).toContainEqual(
      expect.objectContaining({
        document_number_masked: 'VN********78',
        id: fixture.recordId,
        media_count: 1,
        product: expect.objectContaining({ id: fixture.productId, name_vi: 'Sản phẩm hồ sơ' }),
        status: 'PENDING_REVIEW',
      }),
    );
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('VN-DECL-12345678');
    expect(serialized).not.toContain('m282-secret-document.webp');
    expect(serialized).not.toContain(fixture.catalogOnlyId);
    expect(serialized).not.toContain('objectKey');
  });

  it('validates filters and projects active category template bindings', async () => {
    await request(app.getHttpServer() as Server)
      .get(`/v1/admin/compliance/overview?store_id=${BEAUTY_STORE_ID}&limit=0`)
      .set(headers(readerToken))
      .expect(400);
    await request(app.getHttpServer() as Server)
      .get(
        `/v1/admin/compliance/overview?store_id=${BEAUTY_STORE_ID}&status=APPROVED&product_id=${fixture.productId}`,
      )
      .set(headers(readerToken))
      .expect(200)
      .expect(({ body }) => expect(body.records).toEqual([]));

    await request(app.getHttpServer() as Server)
      .get(`/v1/admin/catalog/categories?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(readerToken))
      .expect(200)
      .expect(({ body }) => {
        const leaf = body
          .flatMap((category: { children: unknown[] }) => category.children)
          .find((category: { id: string }) => category.id === BEAUTY_CATEGORY_ID);
        expect(leaf.category_attribute_templates).toContainEqual(
          expect.objectContaining({
            isPrimary: true,
            templateVersionId: BEAUTY_TEMPLATE_VERSION_ID,
          }),
        );
        expect(leaf.category_attribute_templates[0].attribute_template_versions).toMatchObject({
          attribute_templates: { code: 'beauty-base' },
          status: 'ACTIVE',
          version: 1,
        });
      });
  });

  it('enforces compliance read permission and does not leak through a foreign-store filter', async () => {
    await request(app.getHttpServer() as Server)
      .get(`/v1/admin/compliance/overview?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(catalogOnlyToken))
      .expect(403);

    await request(app.getHttpServer() as Server)
      .get(
        `/v1/admin/compliance/overview?store_id=${FASHION_STORE_ID}&product_id=${fixture.productId}`,
      )
      .set(headers(readerToken, 'fashion-local'))
      .expect(200)
      .expect(({ body }) => {
        expect(body.records).toEqual([]);
        expect(JSON.stringify(body.requirements)).not.toContain('m282-declaration-');
      });
  });
});
