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

describe('M1 admin RBAC and audit API', () => {
  loadEnvironment({ path: '.env.test.example', quiet: true, override: true });
  const config = parseRuntimeConfig();
  const owner = new PrismaClient({ datasourceUrl: config.DATABASE_URL });
  const fixtureIds = {
    manager: randomUUID(),
    outsider: randomUUID(),
    platformRole: randomUUID(),
    superAdmin: randomUUID(),
  };
  let app: INestApplication;
  let runtimeClient: PrismaClient;
  let managerToken: string;
  let outsiderToken: string;
  let superToken: string;
  let customRoleId: string | undefined;

  const createAccessToken = async (adminId: string): Promise<string> => {
    const refreshToken = randomUUID();
    const session = await owner.adminSession.create({
      data: {
        adminUserId: adminId,
        expiresAt: new Date(Date.now() + 3_600_000),
        mfaVerifiedAt: new Date(),
        refreshTokenHash: hashSensitive(refreshToken, config.PII_HASH_KEY),
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
    for (const [id, email] of [
      [fixtureIds.manager, `manager-${randomUUID()}@example.test`],
      [fixtureIds.outsider, `outsider-${randomUUID()}@example.test`],
      [fixtureIds.superAdmin, `super-${randomUUID()}@example.test`],
    ] as const) {
      await owner.adminUser.create({
        data: {
          displayName: 'M1 API Fixture',
          email,
          emailNormalized: email,
          id,
          passwordHash: 'test-fixture-not-used',
        },
      });
    }
    const beautyAdminRole = await owner.storeRole.findUniqueOrThrow({
      where: { storeId_code: { code: 'store-admin', storeId: BEAUTY_STORE_ID } },
    });
    await owner.adminStoreRole.create({
      data: {
        adminUserId: fixtureIds.manager,
        grantedBy: fixtureIds.manager,
        roleId: beautyAdminRole.id,
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.platformRole.create({
      data: {
        code: `super-${randomUUID()}`,
        id: fixtureIds.platformRole,
        name: 'M1 test cross-store role',
        permissions: {
          create: [
            { permissionCode: 'platform.stores.cross_access' },
            { permissionCode: 'platform.stores.read' },
          ],
        },
      },
    });
    await owner.adminPlatformRole.create({
      data: {
        adminUserId: fixtureIds.superAdmin,
        grantedBy: fixtureIds.superAdmin,
        platformRoleId: fixtureIds.platformRole,
      },
    });
    managerToken = await createAccessToken(fixtureIds.manager);
    outsiderToken = await createAccessToken(fixtureIds.outsider);
    superToken = await createAccessToken(fixtureIds.superAdmin);

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
    if (customRoleId) {
      await owner.storeRolePermission.deleteMany({ where: { roleId: customRoleId } });
      await owner.adminStoreRole.deleteMany({ where: { roleId: customRoleId } });
      await owner.storeRole.delete({ where: { id: customRoleId } });
    }
    await owner.adminStoreRole.deleteMany({
      where: {
        adminUserId: { in: [fixtureIds.manager, fixtureIds.outsider, fixtureIds.superAdmin] },
      },
    });
    await owner.adminPlatformRole.deleteMany({
      where: { platformRoleId: fixtureIds.platformRole },
    });
    await owner.platformRolePermission.deleteMany({
      where: { platformRoleId: fixtureIds.platformRole },
    });
    await owner.platformRole.delete({ where: { id: fixtureIds.platformRole } });
    await owner.adminSession.deleteMany({
      where: {
        adminUserId: { in: [fixtureIds.manager, fixtureIds.outsider, fixtureIds.superAdmin] },
      },
    });
    await owner.adminUser.deleteMany({
      where: { id: { in: [fixtureIds.manager, fixtureIds.outsider, fixtureIds.superAdmin] } },
    });
    await owner.$disconnect();
  });

  it('lists only explicitly assigned stores for a normal administrator', async () => {
    const response = await request(app.getHttpServer() as Server)
      .get('/v1/admin/stores')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    expect(response.body).toEqual([
      expect.objectContaining({ code: 'beauty-local', id: BEAUTY_STORE_ID }),
    ]);

    await request(app.getHttpServer() as Server)
      .get('/v1/stores/current')
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Store-Code', 'beauty-local')
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'beauty-local', id: BEAUTY_STORE_ID });
      });
  });

  it('denies an unassigned store without leaking its configuration', async () => {
    const response = await request(app.getHttpServer() as Server)
      .get(`/v1/admin/stores/${FASHION_STORE_ID}/config`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Store-Code', 'fashion-local')
      .set('X-Correlation-Id', 'cross-store-denied')
      .expect(403);
    expect(response.body).toEqual({
      code: 'AUTHORIZATION_DENIED',
      correlation_id: 'cross-store-denied',
      message_key: 'error.authorization_denied',
    });
    expect(JSON.stringify(response.body)).not.toContain('Fashion Store');
  });

  it('requires a reason and audits platform cross-store access', async () => {
    await request(app.getHttpServer() as Server)
      .get(`/v1/admin/stores/${FASHION_STORE_ID}/config`)
      .set('Authorization', `Bearer ${superToken}`)
      .set('X-Store-Code', 'fashion-local')
      .expect(403);

    await request(app.getHttpServer() as Server)
      .get(`/v1/admin/stores/${FASHION_STORE_ID}/config`)
      .set('Authorization', `Bearer ${superToken}`)
      .set('X-Store-Code', 'fashion-local')
      .set('X-Access-Reason', 'Investigate incident INC-1001')
      .expect(200);

    await expect(
      owner.auditLog.count({
        where: {
          action: 'platform.cross_store.accessed',
          actorId: fixtureIds.superAdmin,
          reason: 'Investigate incident INC-1001',
          storeId: FASHION_STORE_ID,
        },
      }),
    ).resolves.toBeGreaterThan(0);
  });

  it('creates a store role, blocks platform permissions and records audit', async () => {
    const created = await request(app.getHttpServer() as Server)
      .post(`/v1/admin/rbac/roles?store_id=${BEAUTY_STORE_ID}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Store-Code', 'beauty-local')
      .send({ code: `support-${randomUUID().slice(0, 8)}`, name: 'Customer support' })
      .expect(201);
    customRoleId = created.body.id as string;

    await request(app.getHttpServer() as Server)
      .put(
        `/v1/admin/rbac/admins/${fixtureIds.outsider}/roles/${customRoleId}?store_id=${BEAUTY_STORE_ID}`,
      )
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Store-Code', 'beauty-local')
      .expect(200);
    await expect(
      owner.adminStoreRole.count({
        where: { adminUserId: fixtureIds.outsider, roleId: customRoleId },
      }),
    ).resolves.toBe(1);

    await request(app.getHttpServer() as Server)
      .delete(
        `/v1/admin/rbac/admins/${fixtureIds.outsider}/roles/${customRoleId}?store_id=${BEAUTY_STORE_ID}`,
      )
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Store-Code', 'beauty-local')
      .expect(200);
    await expect(
      owner.adminStoreRole.count({
        where: { adminUserId: fixtureIds.outsider, roleId: customRoleId },
      }),
    ).resolves.toBe(0);

    await request(app.getHttpServer() as Server)
      .put(
        `/v1/admin/rbac/roles/${customRoleId}/permissions/platform.stores.read?store_id=${BEAUTY_STORE_ID}`,
      )
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Store-Code', 'beauty-local')
      .expect(403);

    const audit = await request(app.getHttpServer() as Server)
      .get(`/v1/admin/audit-logs?store_id=${BEAUTY_STORE_ID}&limit=100`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Store-Code', 'beauty-local')
      .expect(200);
    expect(audit.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'store.role.created', actorId: fixtureIds.manager }),
      ]),
    );
  });

  it('denies an authenticated administrator with no role assignment', async () => {
    await request(app.getHttpServer() as Server)
      .get(`/v1/admin/stores/${BEAUTY_STORE_ID}/config`)
      .set('Authorization', `Bearer ${outsiderToken}`)
      .set('X-Store-Code', 'beauty-local')
      .expect(403);
  });
});
