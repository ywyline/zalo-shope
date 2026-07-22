import { randomBytes, randomUUID } from 'node:crypto';

import { parseRuntimeConfig } from '@zalo-shop/config';
import { PrismaClient } from '@zalo-shop/database';
import { encryptSensitive, hashPassword } from '@zalo-shop/security';
import { createZaloTestToken } from '@zalo-shop/integrations';

import {
  setUpM26BrowserFixtures,
  tearDownM26BrowserFixtures,
} from '../fixtures/m26-browser-fixture';

const E2E_ADMIN_ID = '28400000-0000-4000-8000-000000000001';
const E2E_READONLY_ADMIN_ID = '28400000-0000-4000-8000-000000000002';
const E2E_READONLY_ROLE_IDS = {
  beauty: '28410000-0000-4000-8000-000000000001',
  fashion: '28410000-0000-4000-8000-000000000002',
} as const;
const STORE_IDS = [
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
] as const;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const ZALO_TEST_APPS = {
  beauty: {
    code: 'beauty-local',
    miniAppId: 'm37-beauty-mini',
    parentAppId: 'm37-beauty-parent',
    storeId: STORE_IDS[0],
  },
  fashion: {
    code: 'fashion-local',
    miniAppId: 'm37-fashion-mini',
    parentAppId: 'm37-fashion-parent',
    storeId: STORE_IDS[1],
  },
} as const;

type ZaloAppSnapshot = {
  enabled: boolean;
  miniAppId: string | null;
  oaId: string | null;
  parentAppId: string | null;
  storeId: string;
};

function randomTotpSecret(): string {
  return [...randomBytes(32)].map((value) => BASE32_ALPHABET[value & 31]).join('');
}

async function removeAdmin(database: PrismaClient, adminId: string): Promise<void> {
  // Browser inventory actions are test facts, not production data. A previous
  // interrupted run may have removed their movements before failing on the
  // admin FK, so clean the fixed E2E account's operations by owner ID here.
  await database.$transaction(async (transaction) => {
    await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
    const operations = await transaction.inventoryOperation.findMany({
      select: { id: true },
      where: { adminId },
    });
    const operationIds = operations.map(({ id }) => id);
    if (operationIds.length > 0) {
      await transaction.inventoryMovement.deleteMany({
        where: { operationId: { in: operationIds } },
      });
      await transaction.inventoryOperation.deleteMany({ where: { id: { in: operationIds } } });
    }
  });
  // Audit logs are intentionally append-only. They do not reference the admin
  // row via a foreign key, so stale test-account history can remain while the
  // account and its sessions/assignments are recreated for the next run.
  await database.adminStoreRole.deleteMany({ where: { adminUserId: adminId } });
  await database.adminPlatformRole.deleteMany({ where: { adminUserId: adminId } });
  await database.adminSession.deleteMany({ where: { adminUserId: adminId } });
  await database.adminUser.deleteMany({ where: { id: adminId } });
}

async function removeReadonlyRoles(database: PrismaClient): Promise<void> {
  await database.storeRolePermission.deleteMany({
    where: { roleId: { in: Object.values(E2E_READONLY_ROLE_IDS) } },
  });
  await database.storeRole.deleteMany({
    where: { id: { in: Object.values(E2E_READONLY_ROLE_IDS) } },
  });
}

async function restoreZaloApps(
  database: PrismaClient,
  snapshots: readonly ZaloAppSnapshot[],
): Promise<void> {
  await database.$transaction(async (transaction) => {
    for (const snapshot of snapshots) {
      await transaction.storeZaloApp.update({
        data: {
          enabled: snapshot.enabled,
          miniAppId: snapshot.miniAppId,
          oaId: snapshot.oaId,
          parentAppId: snapshot.parentAppId,
        },
        where: { storeId_environment: { environment: 'TEST', storeId: snapshot.storeId } },
      });
    }
  });
}

type CleanupState = { error?: unknown; failed: boolean };

async function attemptCleanup(state: CleanupState, cleanup: () => Promise<void>): Promise<void> {
  try {
    await cleanup();
  } catch (error) {
    if (!state.failed) {
      state.error = error;
      state.failed = true;
    }
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const config = parseRuntimeConfig();
  if (config.NODE_ENV !== 'test') throw new Error('Browser E2E is restricted to NODE_ENV=test');

  const database = new PrismaClient({ datasourceUrl: config.DATABASE_URL });
  const adminCredentials = {
    email: `m37-admin-${randomUUID()}@example.test`,
    password: `E2e!${randomBytes(24).toString('base64url')}`,
    totpSecret: randomTotpSecret(),
  };
  const readonlyCredentials = {
    email: `m37-readonly-${randomUUID()}@example.test`,
    password: `E2e!${randomBytes(24).toString('base64url')}`,
    totpSecret: randomTotpSecret(),
  };
  let originalZaloApps: ZaloAppSnapshot[] = [];

  await database.$connect();
  try {
    await setUpM26BrowserFixtures();
    await removeAdmin(database, E2E_ADMIN_ID);
    await removeAdmin(database, E2E_READONLY_ADMIN_ID);
    await removeReadonlyRoles(database);
    originalZaloApps = await database.storeZaloApp.findMany({
      select: { enabled: true, miniAppId: true, oaId: true, parentAppId: true, storeId: true },
      where: { environment: 'TEST', storeId: { in: [...STORE_IDS] } },
    });
    if (originalZaloApps.length !== STORE_IDS.length) {
      throw new Error('Both seeded TEST Zalo app rows are required for browser E2E');
    }
    for (const app of Object.values(ZALO_TEST_APPS)) {
      await database.storeZaloApp.update({
        data: {
          enabled: true,
          miniAppId: app.miniAppId,
          parentAppId: app.parentAppId,
        },
        where: { storeId_environment: { environment: 'TEST', storeId: app.storeId } },
      });
    }
    const roles = await database.storeRole.findMany({
      where: { code: 'store-admin', storeId: { in: [...STORE_IDS] } },
    });
    if (roles.length !== STORE_IDS.length) {
      throw new Error('Both seeded store-admin roles are required for browser E2E');
    }
    await database.adminUser.create({
      data: {
        displayName: 'M3.7 Browser E2E administrator',
        email: adminCredentials.email,
        emailNormalized: adminCredentials.email,
        id: E2E_ADMIN_ID,
        mfaEnabled: true,
        mfaSecretCiphertext: encryptSensitive(
          adminCredentials.totpSecret,
          config.PII_ENCRYPTION_KEY,
        ),
        passwordHash: await hashPassword(adminCredentials.password),
      },
    });
    await database.adminStoreRole.createMany({
      data: roles.map((role) => ({
        adminUserId: E2E_ADMIN_ID,
        grantedBy: E2E_ADMIN_ID,
        roleId: role.id,
        storeId: role.storeId,
      })),
    });

    await database.adminUser.create({
      data: {
        displayName: 'M3.7 Browser E2E read-only administrator',
        email: readonlyCredentials.email,
        emailNormalized: readonlyCredentials.email,
        id: E2E_READONLY_ADMIN_ID,
        mfaEnabled: true,
        mfaSecretCiphertext: encryptSensitive(
          readonlyCredentials.totpSecret,
          config.PII_ENCRYPTION_KEY,
        ),
        passwordHash: await hashPassword(readonlyCredentials.password),
      },
    });
    for (const [index, storeId] of STORE_IDS.entries()) {
      const roleId = Object.values(E2E_READONLY_ROLE_IDS)[index]!;
      await database.storeRole.create({
        data: {
          code: 'm37-browser-readonly',
          id: roleId,
          name: 'M3.7 browser read-only operator',
          permissions: {
            create: [
              { permissionCode: 'store.config.read' },
              { permissionCode: 'store.inventory.read' },
              { permissionCode: 'store.promotions.read' },
            ],
          },
          storeId,
        },
      });
      await database.adminStoreRole.create({
        data: {
          adminUserId: E2E_READONLY_ADMIN_ID,
          grantedBy: E2E_READONLY_ADMIN_ID,
          roleId,
          storeId,
        },
      });
    }

    const tokenOptions = {
      audience: 'zalo-shop-test-provider',
      issuer: 'zalo-shop-test-provider',
      secret: config.ZALO_TEST_TOKEN_SECRET!,
    };
    const zaloTokens = Object.fromEntries(
      ['mini-android-chromium', 'mini-iphone-webkit'].map((project) => [
        project,
        Object.fromEntries(
          Object.values(ZALO_TEST_APPS).map((app) => [
            app.code,
            createZaloTestToken(
              {
                expiresInSeconds: 7_200,
                kind: 'zalo_access',
                miniAppId: app.miniAppId,
                parentAppId: app.parentAppId,
                subjectId: `m37-browser-${project}-${app.code}`,
              },
              tokenOptions,
            ),
          ]),
        ),
      ]),
    );
    process.env.ZALO_SHOP_E2E_ADMIN = JSON.stringify(adminCredentials);
    process.env.ZALO_SHOP_E2E_READONLY_ADMIN = JSON.stringify(readonlyCredentials);
    process.env.ZALO_SHOP_E2E_ZALO_TOKENS = JSON.stringify(zaloTokens);
  } catch (error) {
    const cleanup = { failed: false } satisfies CleanupState;
    await attemptCleanup(cleanup, tearDownM26BrowserFixtures);
    await attemptCleanup(cleanup, () => removeAdmin(database, E2E_ADMIN_ID));
    await attemptCleanup(cleanup, () => removeAdmin(database, E2E_READONLY_ADMIN_ID));
    await attemptCleanup(cleanup, () => removeReadonlyRoles(database));
    await attemptCleanup(cleanup, () => restoreZaloApps(database, originalZaloApps));
    if (cleanup.failed) {
      throw new AggregateError([error, cleanup.error], 'Browser E2E setup and cleanup both failed');
    }
    throw error;
  } finally {
    await database.$disconnect();
  }

  return async () => {
    const cleanupDatabase = new PrismaClient({ datasourceUrl: config.DATABASE_URL });
    const cleanup = { failed: false } satisfies CleanupState;
    await attemptCleanup(cleanup, () => cleanupDatabase.$connect());
    await attemptCleanup(cleanup, tearDownM26BrowserFixtures);
    await attemptCleanup(cleanup, () => removeAdmin(cleanupDatabase, E2E_ADMIN_ID));
    await attemptCleanup(cleanup, () => removeAdmin(cleanupDatabase, E2E_READONLY_ADMIN_ID));
    await attemptCleanup(cleanup, () => removeReadonlyRoles(cleanupDatabase));
    await attemptCleanup(cleanup, () => restoreZaloApps(cleanupDatabase, originalZaloApps));
    delete process.env.ZALO_SHOP_E2E_ADMIN;
    delete process.env.ZALO_SHOP_E2E_READONLY_ADMIN;
    delete process.env.ZALO_SHOP_E2E_ZALO_TOKENS;
    await attemptCleanup(cleanup, () => cleanupDatabase.$disconnect());
    if (cleanup.failed) throw cleanup.error;
  };
}
