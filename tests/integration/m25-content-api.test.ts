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
const BEAUTY_CATEGORY_ID = '12000000-0000-4000-8000-000000000001';
const FASHION_CATEGORY_ID = '12000000-0000-4000-8000-000000000002';

describe('M2.5 content administration API', () => {
  loadEnvironment({ path: '.env.test.example', quiet: true, override: true });
  const config = parseRuntimeConfig();
  const owner = new PrismaClient({ datasourceUrl: config.DATABASE_URL });
  const fixture = {
    managerId: randomUUID(),
    managerRoleId: randomUUID(),
    readerId: randomUUID(),
    readerRoleId: randomUUID(),
  };
  const pageIds: string[] = [];
  const objects = new Map<
    string,
    { byteSize: number; checksumSha256: string; contentType: string }
  >();
  const storage: MediaStorageProvider = {
    async createReadUrl(objectKey) {
      await Promise.resolve();
      return { expiresAt: new Date(Date.now() + 300_000), url: `https://media.test/${objectKey}` };
    },
    async createUploadTarget(input) {
      await Promise.resolve();
      objects.set(input.objectKey, input);
      return { expiresAt: new Date(Date.now() + 60_000), headers: {}, url: 'https://upload.test' };
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
  let readerToken: string;
  let pageId: string;
  let pageVersion = 1;

  const headers = (token: string, storeCode = 'beauty-local') => ({
    Authorization: `Bearer ${token}`,
    'X-Store-Code': storeCode,
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
      [fixture.readerId, 'reader'],
    ] as const) {
      const email = `m25-${label}-${randomUUID()}@example.test`;
      await owner.adminUser.create({
        data: {
          displayName: `M2.5 ${label}`,
          email,
          emailNormalized: email,
          id,
          passwordHash: 'test-fixture-not-used',
        },
      });
    }
    await owner.storeRole.create({
      data: {
        code: `content-manager-${randomUUID().slice(0, 8)}`,
        id: fixture.managerRoleId,
        name: 'M2.5 content manager',
        permissions: {
          create: [
            { permissionCode: 'store.content.read' },
            { permissionCode: 'store.content.manage' },
          ],
        },
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.storeRole.create({
      data: {
        code: `content-reader-${randomUUID().slice(0, 8)}`,
        id: fixture.readerRoleId,
        name: 'M2.5 content reader',
        permissions: { create: [{ permissionCode: 'store.content.read' }] },
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.adminStoreRole.createMany({
      data: [
        {
          adminUserId: fixture.managerId,
          grantedBy: fixture.managerId,
          roleId: fixture.managerRoleId,
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
      const versionIds = (
        await transaction.pageVersion.findMany({
          select: { id: true },
          where: { pageId: { in: pageIds } },
        })
      ).map(({ id }) => id);
      const moduleIds = (
        await transaction.pageModule.findMany({
          select: { id: true },
          where: { pageVersionId: { in: versionIds } },
        })
      ).map(({ id }) => id);
      await transaction.pageModuleMedia.deleteMany({ where: { pageModuleId: { in: moduleIds } } });
      await transaction.pageModuleLocalization.deleteMany({
        where: { pageModuleId: { in: moduleIds } },
      });
      await transaction.pageModule.deleteMany({ where: { id: { in: moduleIds } } });
      await transaction.pageVersion.deleteMany({ where: { id: { in: versionIds } } });
      await transaction.page.deleteMany({ where: { id: { in: pageIds } } });
      await transaction.mediaAsset.deleteMany({ where: { createdBy: fixture.managerId } });
    });
    await owner.adminStoreRole.deleteMany({
      where: { adminUserId: { in: [fixture.managerId, fixture.readerId] } },
    });
    await owner.storeRolePermission.deleteMany({
      where: { roleId: { in: [fixture.managerRoleId, fixture.readerRoleId] } },
    });
    await owner.storeRole.deleteMany({
      where: { id: { in: [fixture.managerRoleId, fixture.readerRoleId] } },
    });
    await owner.adminSession.deleteMany({
      where: { adminUserId: { in: [fixture.managerId, fixture.readerId] } },
    });
    await owner.adminUser.deleteMany({
      where: { id: { in: [fixture.managerId, fixture.readerId] } },
    });
    await owner.$disconnect();
  });

  const moduleInput = (targetId = BEAUTY_CATEGORY_ID) => ({
    background_config: { color: '#f7e9ee', overlay: 0.1 },
    localizations: [
      { button_label: 'Kham pha', locale: 'vi', summary: 'Bo suu tap moi', title: 'Xin chao' },
      { button_label: 'Explore', locale: 'en', summary: 'New collection', title: 'Welcome' },
      { button_label: '查看', locale: 'zh', summary: '新品系列', title: '欢迎' },
    ],
    media: [],
    module_type: 'HERO',
    sort_order: 0,
    status: 'ACTIVE',
    target_id: targetId,
    target_type: 'CATEGORY',
  });

  it('creates an isolated page draft and enforces read-only RBAC', async () => {
    const code = `home-${randomUUID().slice(0, 8)}`;
    const created = await request(app.getHttpServer() as Server)
      .post(`/v1/admin/content/pages?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(managerToken))
      .send({ code })
      .expect(201);
    pageId = created.body.id;
    pageIds.push(pageId);
    expect(created.body).toMatchObject({ code, draft: { modules: [], version: 1 }, version: 1 });

    await request(app.getHttpServer() as Server)
      .get(`/v1/admin/content/pages?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(readerToken))
      .expect(200)
      .expect(({ body }) =>
        expect(body.items.some((item: { id: string }) => item.id === pageId)).toBe(true),
      );
    await request(app.getHttpServer() as Server)
      .post(`/v1/admin/content/pages?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(readerToken))
      .send({ code: `denied-${randomUUID().slice(0, 8)}` })
      .expect(403);
    await request(app.getHttpServer() as Server)
      .get(`/v1/admin/content/pages?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(managerToken, 'fashion-local'))
      .expect(403);
  });

  it('replaces ordered localized modules and rejects stale or cross-store references', async () => {
    const crossStore = await request(app.getHttpServer() as Server)
      .put(`/v1/admin/content/pages/${pageId}/draft?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(managerToken))
      .send({ expected_version: pageVersion, modules: [moduleInput(FASHION_CATEGORY_ID)] })
      .expect(404);
    expect(crossStore.body.code).toBe('RESOURCE_NOT_FOUND');

    const replaced = await request(app.getHttpServer() as Server)
      .put(`/v1/admin/content/pages/${pageId}/draft?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(managerToken))
      .send({
        expected_version: pageVersion,
        modules: [
          moduleInput(),
          {
            ...moduleInput(),
            module_type: 'RICH_TEXT',
            sort_order: 1,
            target_id: null,
            target_type: null,
          },
        ],
      })
      .expect(200);
    pageVersion = replaced.body.version;
    expect(replaced.body.draft.modules).toHaveLength(2);
    expect(replaced.body.draft.modules[1]).toMatchObject({
      module_type: 'RICH_TEXT',
      sort_order: 1,
    });

    await request(app.getHttpServer() as Server)
      .put(`/v1/admin/content/pages/${pageId}/draft?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(managerToken))
      .send({ expected_version: 1, modules: [moduleInput()] })
      .expect(409);
  });

  it('requires explicit confirmation, publishes immutably, then opens a new draft version', async () => {
    await request(app.getHttpServer() as Server)
      .post(`/v1/admin/content/pages/${pageId}/publish?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(managerToken))
      .send({ confirmation_code: 'wrong-page', expected_version: pageVersion })
      .expect(409);

    const current = await owner.page.findUniqueOrThrow({ where: { id: pageId } });
    const published = await request(app.getHttpServer() as Server)
      .post(`/v1/admin/content/pages/${pageId}/publish?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(managerToken))
      .send({ confirmation_code: current.code, expected_version: pageVersion })
      .expect(201);
    pageVersion = published.body.version;
    expect(published.body).toMatchObject({ draft: null, status: 'PUBLISHED' });
    expect(published.body.published.modules).toHaveLength(2);

    const edited = await request(app.getHttpServer() as Server)
      .put(`/v1/admin/content/pages/${pageId}/draft?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(managerToken))
      .send({ expected_version: pageVersion, modules: [moduleInput()] })
      .expect(200);
    pageVersion = edited.body.version;
    expect(edited.body).toMatchObject({ draft: { version: 2 }, published: { version: 1 } });
    expect(edited.body.published.modules).toHaveLength(2);
  });

  it('allows page media initialization with content permission but not catalog media', async () => {
    await request(app.getHttpServer() as Server)
      .post(`/v1/admin/media/uploads?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(managerToken))
      .send({
        byte_size: 128,
        checksum_sha256: 'c'.repeat(64),
        filename: 'page.webp',
        mime_type: 'image/webp',
        resource: 'page',
      })
      .expect(201);
    await request(app.getHttpServer() as Server)
      .post(`/v1/admin/media/uploads?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(managerToken))
      .send({
        byte_size: 128,
        checksum_sha256: 'd'.repeat(64),
        filename: 'product.webp',
        mime_type: 'image/webp',
        resource: 'product',
      })
      .expect(403);
  });

  it('records content create, edit and publish audit events', async () => {
    const actions = await owner.auditLog.findMany({
      select: { action: true, storeId: true },
      where: { actorId: fixture.managerId, targetId: pageId },
    });
    expect(actions).toEqual(
      expect.arrayContaining([
        { action: 'content.page.created', storeId: BEAUTY_STORE_ID },
        { action: 'content.page.draft_replaced', storeId: BEAUTY_STORE_ID },
        { action: 'content.page.published', storeId: BEAUTY_STORE_ID },
      ]),
    );
  });
});
