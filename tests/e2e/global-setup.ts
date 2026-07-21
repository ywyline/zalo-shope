import { randomBytes, randomUUID } from 'node:crypto';

import { parseRuntimeConfig } from '@zalo-shop/config';
import { PrismaClient } from '@zalo-shop/database';
import { encryptSensitive, hashPassword } from '@zalo-shop/security';

import {
  setUpM26BrowserFixtures,
  tearDownM26BrowserFixtures,
} from '../fixtures/m26-browser-fixture';

const E2E_ADMIN_ID = '28400000-0000-4000-8000-000000000001';
const STORE_IDS = [
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
] as const;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function randomTotpSecret(): string {
  return [...randomBytes(32)].map((value) => BASE32_ALPHABET[value & 31]).join('');
}

async function removeAdmin(database: PrismaClient): Promise<void> {
  // Audit logs are intentionally append-only. They do not reference the admin
  // row via a foreign key, so stale test-account history can remain while the
  // account and its sessions/assignments are recreated for the next run.
  await database.adminStoreRole.deleteMany({ where: { adminUserId: E2E_ADMIN_ID } });
  await database.adminSession.deleteMany({ where: { adminUserId: E2E_ADMIN_ID } });
  await database.adminUser.deleteMany({ where: { id: E2E_ADMIN_ID } });
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const config = parseRuntimeConfig();
  if (config.NODE_ENV !== 'test') throw new Error('Browser E2E is restricted to NODE_ENV=test');

  const database = new PrismaClient({ datasourceUrl: config.DATABASE_URL });
  const email = `m284-${randomUUID()}@example.test`;
  const password = `E2e!${randomBytes(24).toString('base64url')}`;
  const totpSecret = randomTotpSecret();

  await database.$connect();
  try {
    await removeAdmin(database);
    await setUpM26BrowserFixtures();
    const roles = await database.storeRole.findMany({
      where: { code: 'store-admin', storeId: { in: [...STORE_IDS] } },
    });
    if (roles.length !== STORE_IDS.length) {
      throw new Error('Both seeded store-admin roles are required for browser E2E');
    }
    await database.adminUser.create({
      data: {
        displayName: 'M2.8.4 Browser E2E',
        email,
        emailNormalized: email,
        id: E2E_ADMIN_ID,
        mfaEnabled: true,
        mfaSecretCiphertext: encryptSensitive(totpSecret, config.PII_ENCRYPTION_KEY),
        passwordHash: await hashPassword(password),
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
    process.env.ZALO_SHOP_E2E_ADMIN = JSON.stringify({ email, password, totpSecret });
  } catch (error) {
    await tearDownM26BrowserFixtures().catch(() => undefined);
    await removeAdmin(database).catch(() => undefined);
    throw error;
  } finally {
    await database.$disconnect();
  }

  return async () => {
    const cleanupDatabase = new PrismaClient({ datasourceUrl: config.DATABASE_URL });
    await cleanupDatabase.$connect();
    try {
      await tearDownM26BrowserFixtures();
      await removeAdmin(cleanupDatabase);
    } finally {
      delete process.env.ZALO_SHOP_E2E_ADMIN;
      await cleanupDatabase.$disconnect();
    }
  };
}
