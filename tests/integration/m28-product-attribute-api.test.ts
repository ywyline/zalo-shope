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

describe('M2.8.1 product attribute editing API', () => {
  loadEnvironment({ path: '.env.test.example', quiet: true, override: true });
  const config = parseRuntimeConfig();
  const owner = new PrismaClient({ datasourceUrl: config.DATABASE_URL });
  const fixture = {
    brandId: randomUUID(),
    categoryId: randomUUID(),
    managerId: randomUUID(),
    readerId: randomUUID(),
    readerRoleId: randomUUID(),
    rootCategoryId: randomUUID(),
    templateId: randomUUID(),
    templateVersionId: randomUUID(),
  };
  let app: INestApplication;
  let managerToken: string;
  let productId: string | undefined;
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
      [fixture.managerId, 'manager'],
      [fixture.readerId, 'reader'],
    ] as const) {
      const email = `m28-${label}-${randomUUID()}@example.test`;
      await owner.adminUser.create({
        data: {
          displayName: `M2.8.1 ${label}`,
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
        code: `m28-reader-${randomUUID().slice(0, 8)}`,
        id: fixture.readerRoleId,
        name: 'M2.8.1 catalog reader',
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
    await owner.brand.create({
      data: {
        code: `m28-brand-${randomUUID().slice(0, 8)}`,
        id: fixture.brandId,
        status: 'ACTIVE',
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.brandLocalization.create({
      data: {
        brandId: fixture.brandId,
        locale: 'vi',
        name: 'Thương hiệu M2.8.1',
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.category.createMany({
      data: [
        {
          code: `m28-root-${randomUUID().slice(0, 8)}`,
          depth: 1,
          id: fixture.rootCategoryId,
          status: 'ACTIVE',
          storeId: BEAUTY_STORE_ID,
        },
        {
          code: `m28-leaf-${randomUUID().slice(0, 8)}`,
          depth: 2,
          id: fixture.categoryId,
          parentId: fixture.rootCategoryId,
          status: 'ACTIVE',
          storeId: BEAUTY_STORE_ID,
        },
      ],
    });
    await owner.attributeTemplate.create({
      data: {
        code: `m28-template-${randomUUID().slice(0, 8)}`,
        currentVersion: 1,
        id: fixture.templateId,
        industry: 'BEAUTY',
        status: 'ACTIVE',
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.attributeTemplateVersion.create({
      data: {
        activatedAt: new Date(),
        id: fixture.templateVersionId,
        name: 'M2.8.1 complete attribute template',
        status: 'ACTIVE',
        storeId: BEAUTY_STORE_ID,
        templateId: fixture.templateId,
        version: 1,
      },
    });
    const definitions = await Promise.all(
      [
        ['shade', 'OPTION', 'SPECIFICATION', true, false],
        ['benefit', 'TEXT', 'DETAIL', true, false],
        ['spf', 'INTEGER', 'FILTER', false, false],
        ['volume', 'DECIMAL', 'DETAIL', false, false],
        ['vegan', 'BOOLEAN', 'FILTER', false, false],
        ['available-on', 'DATE', 'DETAIL', false, false],
        ['finish', 'OPTION', 'FILTER', false, false],
        ['tags', 'TEXT', 'DETAIL', false, true],
      ].map(async ([code, dataType, purpose, required, multiple], sortOrder) =>
        owner.attributeDefinition.create({
          data: {
            code: code as string,
            dataType: dataType as 'BOOLEAN' | 'DATE' | 'DECIMAL' | 'INTEGER' | 'OPTION' | 'TEXT',
            labelEn: code as string,
            labelVi: code as string,
            labelZh: code as string,
            multiple: multiple as boolean,
            purpose: purpose as 'DETAIL' | 'FILTER' | 'SPECIFICATION',
            required: required as boolean,
            sortOrder,
            storeId: BEAUTY_STORE_ID,
            templateVersionId: fixture.templateVersionId,
          },
        }),
      ),
    );
    const definitionByCode = new Map(
      definitions.map((definition) => [definition.code, definition]),
    );
    await owner.attributeOption.createMany({
      data: [
        {
          attributeDefinitionId: definitionByCode.get('shade')!.id,
          code: 'default',
          labelVi: 'Mặc định',
          storeId: BEAUTY_STORE_ID,
        },
        {
          attributeDefinitionId: definitionByCode.get('finish')!.id,
          code: 'matte',
          labelVi: 'Lì',
          storeId: BEAUTY_STORE_ID,
        },
        {
          attributeDefinitionId: definitionByCode.get('finish')!.id,
          code: 'retired',
          labelVi: 'Ngừng dùng',
          status: 'DISABLED',
          storeId: BEAUTY_STORE_ID,
        },
      ],
    });
    await owner.categoryAttributeTemplate.create({
      data: {
        categoryId: fixture.categoryId,
        isPrimary: true,
        storeId: BEAUTY_STORE_ID,
        templateVersionId: fixture.templateVersionId,
      },
    });

    managerToken = await createAccessToken(fixture.managerId);
    readerToken = await createAccessToken(fixture.readerId);
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
      await transaction.auditLog.deleteMany({
        where: {
          OR: [
            { actorId: { in: [fixture.managerId, fixture.readerId] } },
            ...(productId ? [{ targetId: productId }] : []),
          ],
        },
      });
      if (productId) {
        await transaction.productAttributeValue.deleteMany({ where: { productId } });
        await transaction.productLocalization.deleteMany({ where: { productId } });
        await transaction.productSecondaryCategory.deleteMany({ where: { productId } });
        await transaction.product.deleteMany({ where: { id: productId } });
      }
      await transaction.categoryAttributeTemplate.deleteMany({
        where: { templateVersionId: fixture.templateVersionId },
      });
      const definitionIds = (
        await transaction.attributeDefinition.findMany({
          select: { id: true },
          where: { templateVersionId: fixture.templateVersionId },
        })
      ).map(({ id }) => id);
      await transaction.attributeOption.deleteMany({
        where: { attributeDefinitionId: { in: definitionIds } },
      });
      await transaction.attributeDefinition.deleteMany({
        where: { templateVersionId: fixture.templateVersionId },
      });
      await transaction.attributeTemplateVersion.deleteMany({
        where: { id: fixture.templateVersionId },
      });
      await transaction.attributeTemplate.deleteMany({ where: { id: fixture.templateId } });
      await transaction.categoryLocalization.deleteMany({
        where: { categoryId: { in: [fixture.categoryId, fixture.rootCategoryId] } },
      });
      await transaction.category.deleteMany({ where: { id: fixture.categoryId } });
      await transaction.category.deleteMany({ where: { id: fixture.rootCategoryId } });
      await transaction.brandLocalization.deleteMany({ where: { brandId: fixture.brandId } });
      await transaction.brand.deleteMany({ where: { id: fixture.brandId } });
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

  it('returns a scoped editor projection and separates read from manage permission', async () => {
    const product = await request(app.getHttpServer() as Server)
      .post(`/v1/admin/catalog/products?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(managerToken))
      .send({
        brand_id: fixture.brandId,
        code: `m28-product-${randomUUID().slice(0, 8)}`,
        localizations: [
          {
            description: 'Mô tả đầy đủ',
            locale: 'vi',
            name: 'Sản phẩm thuộc tính',
            selling_points: 'Dịu nhẹ',
          },
        ],
        main_category_id: fixture.categoryId,
      })
      .expect(201);
    productId = product.body.id as string;

    await request(app.getHttpServer() as Server)
      .get(`/v1/admin/catalog/products/${productId}/attributes?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(readerToken))
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          editable: true,
          product_id: productId,
          product_status: 'DRAFT',
          product_version: 1,
          template_version: { id: fixture.templateVersionId, version: 1 },
          values: [],
        });
        expect(body.definitions).toHaveLength(7);
        expect(
          body.definitions.map((definition: { code: string }) => definition.code),
        ).not.toContain('shade');
        expect(
          body.definitions.find((definition: { code: string }) => definition.code === 'finish')
            .options,
        ).toHaveLength(1);
      });

    await request(app.getHttpServer() as Server)
      .put(`/v1/admin/catalog/products/${productId}/attributes?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(readerToken))
      .send({ expected_version: 1, values: [] })
      .expect(403);

    await request(app.getHttpServer() as Server)
      .get(`/v1/admin/catalog/products/${productId}/attributes?store_id=${FASHION_STORE_ID}`)
      .set(headers(managerToken, 'fashion-local'))
      .expect(404);
  });

  it('rejects specification, type, option-state and single-value violations atomically', async () => {
    if (!productId) throw new Error('Product fixture missing');
    const endpoint = `/v1/admin/catalog/products/${productId}/attributes?store_id=${BEAUTY_STORE_ID}`;
    for (const values of [
      [{ attribute_code: 'shade', data_type: 'OPTION', option_code: 'default' }],
      [{ attribute_code: 'spf', data_type: 'TEXT', locale: 'vi', value: '50' }],
      [{ attribute_code: 'finish', data_type: 'OPTION', option_code: 'retired' }],
      [
        { attribute_code: 'benefit', data_type: 'TEXT', locale: 'vi', value: 'Một' },
        { attribute_code: 'benefit', data_type: 'TEXT', locale: 'vi', value: 'Hai' },
      ],
    ]) {
      await request(app.getHttpServer() as Server)
        .put(endpoint)
        .set(headers(managerToken))
        .send({ expected_version: 1, values })
        .expect(409);
    }
    await expect(owner.productAttributeValue.count({ where: { productId } })).resolves.toBe(0);
    await expect(
      owner.product.findUniqueOrThrow({ where: { id: productId } }),
    ).resolves.toMatchObject({ version: 1 });
  });

  it('replaces every supported value type, enforces versioning and writes an audit snapshot', async () => {
    if (!productId) throw new Error('Product fixture missing');
    const endpoint = `/v1/admin/catalog/products/${productId}/attributes?store_id=${BEAUTY_STORE_ID}`;
    const values = [
      { attribute_code: 'benefit', data_type: 'TEXT', locale: 'en', value: 'Gentle' },
      { attribute_code: 'spf', data_type: 'INTEGER', value: 50 },
      { attribute_code: 'volume', data_type: 'DECIMAL', value: '30.50000000' },
      { attribute_code: 'vegan', data_type: 'BOOLEAN', value: false },
      { attribute_code: 'available-on', data_type: 'DATE', value: '2026-07-19' },
      { attribute_code: 'finish', data_type: 'OPTION', option_code: 'matte' },
      { attribute_code: 'tags', data_type: 'TEXT', locale: 'vi', value: 'Nhẹ' },
      { attribute_code: 'tags', data_type: 'TEXT', locale: 'vi', value: 'Êm' },
    ];
    const replaced = await request(app.getHttpServer() as Server)
      .put(endpoint)
      .set(headers(managerToken))
      .send({ expected_version: 1, values })
      .expect(200);
    expect(replaced.body).toMatchObject({ product_id: productId, product_version: 2 });
    expect(replaced.body.values).toHaveLength(values.length);
    expect(replaced.body.values).toEqual(
      expect.arrayContaining([
        { attribute_code: 'spf', data_type: 'INTEGER', value: 50 },
        { attribute_code: 'volume', data_type: 'DECIMAL', value: '30.5' },
        { attribute_code: 'vegan', data_type: 'BOOLEAN', value: false },
        { attribute_code: 'available-on', data_type: 'DATE', value: '2026-07-19' },
        { attribute_code: 'finish', data_type: 'OPTION', option_code: 'matte' },
      ]),
    );

    await request(app.getHttpServer() as Server)
      .put(endpoint)
      .set(headers(managerToken))
      .send({ expected_version: 1, values: [] })
      .expect(409);
    await expect(owner.productAttributeValue.count({ where: { productId } })).resolves.toBe(
      values.length,
    );
    await expect(
      owner.auditLog.count({
        where: {
          action: 'catalog.product.attributes_replaced',
          storeId: BEAUTY_STORE_ID,
          targetId: productId,
        },
      }),
    ).resolves.toBe(1);
  });

  it('requires a Vietnamese value for required text attributes and blocks non-editable products', async () => {
    if (!productId) throw new Error('Product fixture missing');
    const endpoint = `/v1/admin/catalog/products/${productId}/attributes?store_id=${BEAUTY_STORE_ID}`;
    const firstDecision = await request(app.getHttpServer() as Server)
      .post(`/v1/admin/catalog/products/${productId}/submit?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(managerToken))
      .send({ expected_version: 2 })
      .expect(201);
    expect(firstDecision.body.issues).toContainEqual({
      code: 'ATTRIBUTE_REQUIRED',
      reference: 'benefit',
    });

    const currentValues = (
      await request(app.getHttpServer() as Server)
        .get(endpoint)
        .set(headers(managerToken))
        .expect(200)
    ).body.values;
    await request(app.getHttpServer() as Server)
      .put(endpoint)
      .set(headers(managerToken))
      .send({
        expected_version: 2,
        values: [
          ...currentValues,
          { attribute_code: 'benefit', data_type: 'TEXT', locale: 'vi', value: 'Dịu nhẹ' },
        ],
      })
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ product_version: 3 }));

    const secondDecision = await request(app.getHttpServer() as Server)
      .post(`/v1/admin/catalog/products/${productId}/submit?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(managerToken))
      .send({ expected_version: 3 })
      .expect(201);
    expect(secondDecision.body.issues).not.toContainEqual({
      code: 'ATTRIBUTE_REQUIRED',
      reference: 'benefit',
    });

    await owner.product.update({ where: { id: productId }, data: { status: 'PUBLISHED' } });
    await request(app.getHttpServer() as Server)
      .get(endpoint)
      .set(headers(readerToken))
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ editable: false }));
    await request(app.getHttpServer() as Server)
      .put(endpoint)
      .set(headers(managerToken))
      .send({ expected_version: 3, values: currentValues })
      .expect(409);
  });
});
