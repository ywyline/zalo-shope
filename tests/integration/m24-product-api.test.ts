import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { config as loadEnvironment } from 'dotenv';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseRuntimeConfig } from '@zalo-shop/config';
import { PrismaClient } from '@zalo-shop/database';
import type { MediaStorageProvider } from '@zalo-shop/integrations';
import { hashSensitive, signJwt } from '@zalo-shop/security';

const BEAUTY_STORE_ID = '10000000-0000-4000-8000-000000000001';
const FASHION_STORE_ID = '10000000-0000-4000-8000-000000000002';
const BEAUTY_CATEGORY_ID = '12000000-0000-4000-8000-000000000001';

describe('M2.4 product, media and compliance API', () => {
  loadEnvironment({ path: '.env.test.example', quiet: true, override: true });
  const config = parseRuntimeConfig();
  const owner = new PrismaClient({ datasourceUrl: config.DATABASE_URL });
  const fixture = {
    brandId: randomUUID(),
    managerId: randomUUID(),
    requirementId: randomUUID(),
    reviewerId: randomUUID(),
    reviewerRoleId: randomUUID(),
  };
  const objects = new Map<
    string,
    { byteSize: number; checksumSha256: string; contentType: string }
  >();
  const storage: MediaStorageProvider = {
    async createUploadTarget(input) {
      await Promise.resolve();
      objects.set(input.objectKey, input);
      return {
        expiresAt: new Date(Date.now() + 300_000),
        headers: {},
        url: `https://upload.test/${input.objectKey}`,
      };
    },
    async inspectObject(objectKey) {
      await Promise.resolve();
      const object = objects.get(objectKey);
      if (!object) throw new Error('Missing test object');
      return object;
    },
  };
  let app: INestApplication;
  let managerToken: string;
  let reviewerToken: string;
  let productId: string | undefined;

  const headers = (token: string) => ({
    Authorization: `Bearer ${token}`,
    'X-Store-Code': 'beauty-local',
  });
  const createAccessToken = async (adminId: string) => {
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
      [fixture.managerId, 'manager'],
      [fixture.reviewerId, 'reviewer'],
    ] as const) {
      const email = `m24-${label}-${randomUUID()}@example.test`;
      await owner.adminUser.create({
        data: {
          displayName: `M2.4 ${label}`,
          email,
          emailNormalized: email,
          id,
          passwordHash: 'test-fixture-not-used',
        },
      });
    }
    const managerRole = await owner.storeRole.findUniqueOrThrow({
      where: { storeId_code: { code: 'store-admin', storeId: BEAUTY_STORE_ID } },
    });
    await owner.storeRole.create({
      data: {
        code: `compliance-reviewer-${randomUUID().slice(0, 8)}`,
        id: fixture.reviewerRoleId,
        name: 'M2.4 compliance reviewer',
        permissions: {
          create: [
            { permissionCode: 'store.catalog.read' },
            { permissionCode: 'store.compliance.review' },
          ],
        },
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.adminStoreRole.createMany({
      data: [
        {
          adminUserId: fixture.managerId,
          grantedBy: fixture.managerId,
          roleId: managerRole.id,
          storeId: BEAUTY_STORE_ID,
        },
        {
          adminUserId: fixture.reviewerId,
          grantedBy: fixture.managerId,
          roleId: fixture.reviewerRoleId,
          storeId: BEAUTY_STORE_ID,
        },
      ],
    });
    await owner.brand.create({
      data: {
        code: `m24-brand-${randomUUID().slice(0, 8)}`,
        id: fixture.brandId,
        status: 'ACTIVE',
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.brandLocalization.create({
      data: {
        brandId: fixture.brandId,
        locale: 'vi',
        name: 'Thương hiệu M2.4',
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.complianceRequirement.create({
      data: {
        blocking: true,
        categoryId: BEAUTY_CATEGORY_ID,
        code: `declaration-${randomUUID().slice(0, 8)}`,
        documentType: 'VN_DECLARATION',
        id: fixture.requirementId,
        industry: 'BEAUTY',
        storeId: BEAUTY_STORE_ID,
        version: 1,
      },
    });
    managerToken = await createAccessToken(fixture.managerId);
    reviewerToken = await createAccessToken(fixture.reviewerId);

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
      if (productId) {
        const skuIds = (
          await transaction.sku.findMany({ select: { id: true }, where: { productId } })
        ).map(({ id }) => id);
        const recordIds = (
          await transaction.complianceRecord.findMany({
            select: { id: true },
            where: { productId },
          })
        ).map(({ id }) => id);
        await transaction.complianceRecordMedia.deleteMany({
          where: { complianceRecordId: { in: recordIds } },
        });
        await transaction.complianceRecord.deleteMany({ where: { id: { in: recordIds } } });
        await transaction.productVersion.deleteMany({ where: { productId } });
        await transaction.productMedia.deleteMany({ where: { productId } });
        await transaction.skuOptionValue.deleteMany({ where: { skuId: { in: skuIds } } });
        await transaction.sku.deleteMany({ where: { id: { in: skuIds } } });
        await transaction.productLocalization.deleteMany({ where: { productId } });
        await transaction.productSecondaryCategory.deleteMany({ where: { productId } });
        await transaction.product.deleteMany({ where: { id: productId } });
      }
      await transaction.mediaAsset.deleteMany({ where: { createdBy: fixture.managerId } });
      await transaction.complianceRequirement.deleteMany({ where: { id: fixture.requirementId } });
      await transaction.brandLocalization.deleteMany({ where: { brandId: fixture.brandId } });
      await transaction.brand.deleteMany({ where: { id: fixture.brandId } });
    });
    await owner.adminStoreRole.deleteMany({
      where: { adminUserId: { in: [fixture.managerId, fixture.reviewerId] } },
    });
    await owner.storeRolePermission.deleteMany({ where: { roleId: fixture.reviewerRoleId } });
    await owner.storeRole.deleteMany({ where: { id: fixture.reviewerRoleId } });
    await owner.adminSession.deleteMany({
      where: { adminUserId: { in: [fixture.managerId, fixture.reviewerId] } },
    });
    await owner.adminUser.deleteMany({
      where: { id: { in: [fixture.managerId, fixture.reviewerId] } },
    });
    await owner.$disconnect();
  });

  const initializeAndConfirmMedia = async (resource: 'compliance' | 'product') => {
    const checksum = resource === 'product' ? 'a'.repeat(64) : 'b'.repeat(64);
    const initialized = await request(app.getHttpServer() as Server)
      .post(`/v1/admin/media/uploads?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(managerToken))
      .send({
        byte_size: 128,
        checksum_sha256: checksum,
        filename: `${resource}.webp`,
        mime_type: 'image/webp',
        resource,
      })
      .expect(201);
    expect(initialized.body.upload.url).toContain(BEAUTY_STORE_ID);
    await request(app.getHttpServer() as Server)
      .post(`/v1/admin/media/${initialized.body.media.id}/confirm?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(managerToken))
      .send({ expected_version: 1 })
      .expect(201)
      .expect(({ body }) => expect(body).toMatchObject({ status: 'READY', version: 2 }));
    return initialized.body.media.id as string;
  };

  it('creates a scoped product, replaces integer-priced SKUs and rejects cross-store media', async () => {
    const product = await request(app.getHttpServer() as Server)
      .post(`/v1/admin/catalog/products?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(managerToken))
      .send({
        brand_id: fixture.brandId,
        code: `serum-${randomUUID().slice(0, 8)}`,
        localizations: [
          {
            description: 'Mô tả đầy đủ',
            locale: 'vi',
            name: 'Tinh chất',
            selling_points: 'Dịu nhẹ',
          },
        ],
        main_category_id: BEAUTY_CATEGORY_ID,
      })
      .expect(201);
    productId = product.body.id as string;
    await request(app.getHttpServer() as Server)
      .put(`/v1/admin/catalog/products/${productId}/skus?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(managerToken))
      .send({
        expected_version: 1,
        skus: [
          {
            code: `sku-${randomUUID().slice(0, 8)}`,
            enabled: true,
            option_values: [{ attribute_code: 'shade', option_code: 'default' }],
            sale_price_vnd: 249000,
          },
        ],
      })
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ version: 2 }));

    const foreignMedia = await owner.mediaAsset.create({
      data: {
        byteSize: 10,
        checksumSha256: 'c'.repeat(64),
        mimeType: 'image/webp',
        objectKey: `test/${FASHION_STORE_ID}/product/${randomUUID()}`,
        originalFilename: 'foreign.webp',
        status: 'READY',
        storeId: FASHION_STORE_ID,
      },
    });
    await request(app.getHttpServer() as Server)
      .post(`/v1/admin/catalog/products/${productId}/media?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(managerToken))
      .send({ expected_version: 2, media_id: foreignMedia.id, purpose: 'PRIMARY' })
      .expect(404);
    await owner.mediaAsset.delete({ where: { id: foreignMedia.id } });
  });

  it('enforces media integrity, compliance separation and immutable publication snapshots', async () => {
    if (!productId) throw new Error('Product fixture missing');
    const productMediaId = await initializeAndConfirmMedia('product');
    await request(app.getHttpServer() as Server)
      .post(`/v1/admin/catalog/products/${productId}/media?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(managerToken))
      .send({ expected_version: 2, media_id: productMediaId, purpose: 'PRIMARY' })
      .expect(201)
      .expect(({ body }) => expect(body).toMatchObject({ version: 3 }));

    const complianceMediaId = await initializeAndConfirmMedia('compliance');
    const submitted = await request(app.getHttpServer() as Server)
      .post(`/v1/admin/compliance/records?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(managerToken))
      .send({
        media_ids: [complianceMediaId],
        product_id: productId,
        requirement_id: fixture.requirementId,
      })
      .expect(201);
    await request(app.getHttpServer() as Server)
      .post(`/v1/admin/compliance/records/${submitted.body.id}/review?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(managerToken))
      .send({ decision: 'APPROVED', review_note: 'self review forbidden' })
      .expect(403);
    await request(app.getHttpServer() as Server)
      .post(`/v1/admin/compliance/records/${submitted.body.id}/review?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(reviewerToken))
      .send({ decision: 'APPROVED', review_note: 'Verified document' })
      .expect(201)
      .expect(({ body }) => expect(body).toMatchObject({ status: 'APPROVED' }));

    await request(app.getHttpServer() as Server)
      .post(`/v1/admin/catalog/products/${productId}/submit?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(managerToken))
      .send({ expected_version: 3 })
      .expect(201)
      .expect(({ body }) => expect(body).toMatchObject({ can_publish: true, issues: [] }));
    await request(app.getHttpServer() as Server)
      .post(`/v1/admin/catalog/products/${productId}/publish?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(managerToken))
      .send({ expected_version: 4 })
      .expect(201)
      .expect(({ body }) =>
        expect(body.product).toMatchObject({ status: 'PUBLISHED', version: 5 }),
      );
    await expect(
      owner.productVersion.count({ where: { productId, publicationStatus: 'PUBLISHED' } }),
    ).resolves.toBe(1);
  });
});
