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
const FASHION_ROOT_CATEGORY_ID = '12000000-0000-4000-8000-000000000002';
const FASHION_TEMPLATE_ID = '13000000-0000-4000-8000-000000000002';
const BEAUTY_TEMPLATE_VERSION_ID = '14000000-0000-4000-8000-000000000001';
const FASHION_TEMPLATE_VERSION_ID = '14000000-0000-4000-8000-000000000002';

describe('M2.3 catalog administration API', () => {
  loadEnvironment({ path: '.env.test.example', quiet: true, override: true });
  const config = parseRuntimeConfig();
  const owner = new PrismaClient({ datasourceUrl: config.DATABASE_URL });
  const fixture = {
    managerId: randomUUID(),
    readerId: randomUUID(),
    readerRoleId: randomUUID(),
  };
  const created = {
    brandIds: [] as string[],
    categoryIds: [] as string[],
    templateIds: [] as string[],
  };
  let app: INestApplication;
  let runtimeClient: PrismaClient;
  let managerToken: string;
  let readerToken: string;

  const headers = (token: string) => ({
    Authorization: `Bearer ${token}`,
    'X-Store-Code': 'beauty-local',
  });
  const localized = (name: string) => [{ locale: 'vi', name }];
  const definition = (code = 'tone') => ({
    code,
    data_type: 'OPTION',
    label_vi: 'Tông',
    options: [{ code: 'default', label_vi: 'Mặc định' }],
    purpose: 'SPECIFICATION',
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
      [fixture.managerId, 'manager'],
      [fixture.readerId, 'reader'],
    ] as const) {
      const email = `m23-${label}-${randomUUID()}@example.test`;
      await owner.adminUser.create({
        data: {
          displayName: `M2.3 ${label}`,
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
        code: `catalog-reader-${randomUUID().slice(0, 8)}`,
        id: fixture.readerRoleId,
        name: 'M2.3 catalog reader',
        permissions: {
          create: { permissionCode: 'store.catalog.read' },
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
          adminUserId: fixture.readerId,
          grantedBy: fixture.managerId,
          roleId: fixture.readerRoleId,
          storeId: BEAUTY_STORE_ID,
        },
      ],
    });
    managerToken = await createAccessToken(fixture.managerId);
    readerToken = await createAccessToken(fixture.readerId);

    const [{ AppModule }, { ApiExceptionFilter }, { DATABASE_CLIENT }] = await Promise.all([
      import('../../apps/api/src/app.module'),
      import('../../apps/api/src/api-exception.filter'),
      import('../../apps/api/src/auth/auth.tokens'),
    ]);
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    runtimeClient = app.get<PrismaClient>(DATABASE_CLIENT);
  });

  afterAll(async () => {
    await app?.close();
    await runtimeClient?.$disconnect();
    if (created.templateIds.length > 0) {
      await owner.$transaction(async (transaction) => {
        // Owner-only teardown for IDs created by this test. Production/runtime roles cannot
        // disable the immutable-record triggers.
        await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
        const versions = await transaction.attributeTemplateVersion.findMany({
          select: { id: true },
          where: { templateId: { in: created.templateIds } },
        });
        const versionIds = versions.map(({ id }) => id);
        const definitions = await transaction.attributeDefinition.findMany({
          select: { id: true },
          where: { templateVersionId: { in: versionIds } },
        });
        await transaction.attributeOption.deleteMany({
          where: { attributeDefinitionId: { in: definitions.map(({ id }) => id) } },
        });
        await transaction.attributeDefinition.deleteMany({
          where: { templateVersionId: { in: versionIds } },
        });
        await transaction.attributeTemplateVersion.deleteMany({
          where: { id: { in: versionIds } },
        });
        await transaction.attributeTemplate.deleteMany({
          where: { id: { in: created.templateIds } },
        });
      });
    }
    await owner.categoryLocalization.deleteMany({
      where: { categoryId: { in: created.categoryIds } },
    });
    await owner.category.deleteMany({ where: { id: { in: created.categoryIds } } });
    await owner.brandLocalization.deleteMany({ where: { brandId: { in: created.brandIds } } });
    await owner.brand.deleteMany({ where: { id: { in: created.brandIds } } });
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

  it('creates, lists, updates and audits a store-scoped brand', async () => {
    const code = `brand-${randomUUID().slice(0, 8)}`;
    const response = await request(app.getHttpServer() as Server)
      .post(`/v1/admin/catalog/brands?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(managerToken))
      .send({ code, localizations: localized('Thương hiệu'), recommended: true })
      .expect(201);
    created.brandIds.push(response.body.id as string);

    await request(app.getHttpServer() as Server)
      .patch(`/v1/admin/catalog/brands/${response.body.id}?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(managerToken))
      .send({ expected_version: 1, sort_order: 10, status: 'DISABLED' })
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ status: 'DISABLED', version: 2 }));

    await request(app.getHttpServer() as Server)
      .get(`/v1/admin/catalog/brands?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(managerToken))
      .expect(200)
      .expect(({ body }) =>
        expect(body.items).toEqual(expect.arrayContaining([expect.objectContaining({ code })])),
      );
    await expect(
      owner.auditLog.count({
        where: { action: 'catalog.brand.updated', targetId: response.body.id },
      }),
    ).resolves.toBe(1);
  });

  it('rejects body-owned store context and write access for a read-only role', async () => {
    await request(app.getHttpServer() as Server)
      .post(`/v1/admin/catalog/brands?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(managerToken))
      .send({
        code: `invalid-${randomUUID().slice(0, 8)}`,
        localizations: localized('Không hợp lệ'),
        store_id: FASHION_STORE_ID,
      })
      .expect(400);
    await request(app.getHttpServer() as Server)
      .post(`/v1/admin/catalog/brands?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(readerToken))
      .send({ code: `denied-${randomUUID().slice(0, 8)}`, localizations: localized('Từ chối') })
      .expect(403);
    await request(app.getHttpServer() as Server)
      .get(`/v1/admin/catalog/brands?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(readerToken))
      .expect(200);
  });

  it('enforces two-level category placement and rejects cross-store parents', async () => {
    const root = await request(app.getHttpServer() as Server)
      .post(`/v1/admin/catalog/categories?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(managerToken))
      .send({ code: `root-${randomUUID().slice(0, 8)}`, localizations: localized('Gốc') })
      .expect(201);
    created.categoryIds.push(root.body.id as string);
    const child = await request(app.getHttpServer() as Server)
      .post(`/v1/admin/catalog/categories?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(managerToken))
      .send({
        code: `child-${randomUUID().slice(0, 8)}`,
        localizations: localized('Con'),
        parent_id: root.body.id,
      })
      .expect(201);
    created.categoryIds.push(child.body.id as string);

    await request(app.getHttpServer() as Server)
      .post(`/v1/admin/catalog/categories?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(managerToken))
      .send({
        code: `third-${randomUUID().slice(0, 8)}`,
        localizations: localized('Cấp ba'),
        parent_id: child.body.id,
      })
      .expect(409);
    await request(app.getHttpServer() as Server)
      .post(`/v1/admin/catalog/categories?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(managerToken))
      .send({
        code: `foreign-${randomUUID().slice(0, 8)}`,
        localizations: localized('Sai cửa hàng'),
        parent_id: FASHION_ROOT_CATEGORY_ID,
      })
      .expect(404);
    await request(app.getHttpServer() as Server)
      .patch(`/v1/admin/catalog/categories/${root.body.id}?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(managerToken))
      .send({ expected_version: 1, parent_id: root.body.id })
      .expect(409);
    await request(app.getHttpServer() as Server)
      .put(
        `/v1/admin/catalog/categories/${root.body.id}/attribute-templates/${FASHION_TEMPLATE_VERSION_ID}?store_id=${BEAUTY_STORE_ID}`,
      )
      .set(headers(managerToken))
      .send({ is_primary: true })
      .expect(404);
    await request(app.getHttpServer() as Server)
      .put(
        `/v1/admin/catalog/categories/${root.body.id}/attribute-templates/${BEAUTY_TEMPLATE_VERSION_ID}?store_id=${BEAUTY_STORE_ID}`,
      )
      .set(headers(managerToken))
      .send({ is_primary: true })
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ isPrimary: true }));
    await request(app.getHttpServer() as Server)
      .delete(
        `/v1/admin/catalog/categories/${root.body.id}/attribute-templates/${BEAUTY_TEMPLATE_VERSION_ID}?store_id=${BEAUTY_STORE_ID}`,
      )
      .set(headers(managerToken))
      .expect(200);
  });

  it('uses optimistic versions for category moves and returns a sorted tree', async () => {
    const root = await request(app.getHttpServer() as Server)
      .post(`/v1/admin/catalog/categories?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(managerToken))
      .send({ code: `move-${randomUUID().slice(0, 8)}`, localizations: localized('Di chuyển') })
      .expect(201);
    created.categoryIds.push(root.body.id as string);
    await request(app.getHttpServer() as Server)
      .patch(`/v1/admin/catalog/categories/${root.body.id}?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(managerToken))
      .send({ expected_version: 99, sort_order: 4 })
      .expect(409);
    await request(app.getHttpServer() as Server)
      .get(`/v1/admin/catalog/categories?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(managerToken))
      .expect(200)
      .expect(({ body }) =>
        expect(body).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ children: expect.any(Array), id: root.body.id }),
          ]),
        ),
      );
  });

  it('creates and activates an immutable attribute template version', async () => {
    const response = await request(app.getHttpServer() as Server)
      .post(`/v1/admin/catalog/attribute-templates?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(managerToken))
      .send({
        code: `template-${randomUUID().slice(0, 8)}`,
        definitions: [definition()],
        name: 'M2.3 draft',
      })
      .expect(201);
    created.templateIds.push(response.body.id as string);

    await request(app.getHttpServer() as Server)
      .post(
        `/v1/admin/catalog/attribute-templates/${response.body.id}/versions/1/activate?store_id=${BEAUTY_STORE_ID}`,
      )
      .set(headers(managerToken))
      .send({ expected_template_version: 1 })
      .expect(201)
      .expect(({ body }) => expect(body).toMatchObject({ status: 'ACTIVE', version: 1 }));
    await request(app.getHttpServer() as Server)
      .patch(
        `/v1/admin/catalog/attribute-templates/${response.body.id}/versions/1?store_id=${BEAUTY_STORE_ID}`,
      )
      .set(headers(managerToken))
      .send({
        definitions: [definition('shade')],
        expected_template_version: 2,
        name: 'Illegal mutation',
      })
      .expect(409);
    await request(app.getHttpServer() as Server)
      .post(
        `/v1/admin/catalog/attribute-templates/${response.body.id}/versions?store_id=${BEAUTY_STORE_ID}`,
      )
      .set(headers(managerToken))
      .send({ definitions: [definition('shade')], name: 'M2.3 draft v2' })
      .expect(201)
      .expect(({ body }) => expect(body).toMatchObject({ status: 'DRAFT', version: 2 }));
    await request(app.getHttpServer() as Server)
      .patch(
        `/v1/admin/catalog/attribute-templates/${response.body.id}/versions/2?store_id=${BEAUTY_STORE_ID}`,
      )
      .set(headers(managerToken))
      .send({
        definitions: [definition('finish')],
        expected_template_version: 2,
        name: 'M2.3 updated draft v2',
      })
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ name: 'M2.3 updated draft v2' }));
  });

  it('rejects cross-store template identifiers without leaking their content', async () => {
    const response = await request(app.getHttpServer() as Server)
      .post(
        `/v1/admin/catalog/attribute-templates/${FASHION_TEMPLATE_ID}/versions?store_id=${BEAUTY_STORE_ID}`,
      )
      .set(headers(managerToken))
      .set('X-Correlation-Id', 'm23-cross-template')
      .send({ definitions: [definition()], name: 'Foreign draft' })
      .expect(404);
    expect(response.body).toEqual({
      code: 'RESOURCE_NOT_FOUND',
      correlation_id: 'm23-cross-template',
      message_key: 'error.resource_not_found',
    });
    expect(JSON.stringify(response.body)).not.toContain('fashion-base');
  });
});
