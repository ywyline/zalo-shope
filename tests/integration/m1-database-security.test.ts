import { randomUUID } from 'node:crypto';

import { config as loadEnvironment } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRuntimePrismaClient, withStoreTransaction } from '@zalo-shop/database';
import { createStoreContext } from '@zalo-shop/domain';

const BEAUTY_STORE_ID = '10000000-0000-4000-8000-000000000001';
const FASHION_STORE_ID = '10000000-0000-4000-8000-000000000002';
const ACTOR_ID = '20000000-0000-4000-8000-000000000001';

describe('M1 database tenant security', () => {
  loadEnvironment({ path: '.env.test.example', quiet: true });
  const databaseUrl = process.env.DATABASE_RUNTIME_URL;
  if (!databaseUrl) throw new Error('DATABASE_RUNTIME_URL is required');
  const client = createRuntimePrismaClient(databaseUrl);

  const contextFor = (storeId: string, storeCode: string) =>
    createStoreContext({
      actor: { id: ACTOR_ID, type: 'admin' },
      correlationId: randomUUID(),
      locale: 'vi',
      storeCode,
      storeId,
    });

  beforeAll(async () => {
    await client.$connect();
  });

  afterAll(async () => {
    await client.$disconnect();
  });

  it('fails closed without a transaction-local StoreContext', async () => {
    await expect(client.store.count()).resolves.toBe(0);
    await expect(client.member.count()).resolves.toBe(0);
  });

  it('resolves only routing-safe active store fields before authentication', async () => {
    const result = await client.$queryRaw<
      Array<{ code: string; default_locale: string; id: string }>
    >`SELECT * FROM app_security.resolve_active_store('beauty-local')`;

    expect(result).toEqual([{ code: 'beauty-local', default_locale: 'vi', id: BEAUTY_STORE_ID }]);
  });

  it('shows only the selected store and permits duplicate role codes across stores', async () => {
    const beauty = await withStoreTransaction(
      client,
      contextFor(BEAUTY_STORE_ID, 'beauty-local'),
      async (transaction) => ({
        otherStoreCount: await transaction.store.count({ where: { id: FASHION_STORE_ID } }),
        ownStoreCount: await transaction.store.count(),
        roleCodes: (await transaction.storeRole.findMany()).map((role) => role.code),
      }),
    );
    const fashion = await withStoreTransaction(
      client,
      contextFor(FASHION_STORE_ID, 'fashion-local'),
      async (transaction) => (await transaction.storeRole.findMany()).map((role) => role.code),
    );

    expect(beauty).toMatchObject({
      otherStoreCount: 0,
      ownStoreCount: 1,
    });
    // Other integration files intentionally create temporary roles in parallel. The RLS
    // invariant under test is that each selected store can resolve its own duplicate system
    // role code, not that no other same-store roles exist during the suite.
    expect(beauty.roleCodes).toContain('store-admin');
    expect(fashion).toContain('store-admin');
  });

  it('rejects cross-store composite foreign keys', async () => {
    const memberId = randomUUID();
    await withStoreTransaction(
      client,
      contextFor(BEAUTY_STORE_ID, 'beauty-local'),
      async (transaction) => {
        await transaction.member.create({ data: { id: memberId, storeId: BEAUTY_STORE_ID } });
      },
    );

    await expect(
      withStoreTransaction(
        client,
        contextFor(FASHION_STORE_ID, 'fashion-local'),
        async (transaction) =>
          transaction.memberExternalIdentity.create({
            data: {
              memberId,
              provider: 'ZALO',
              providerAppId: 'test-fashion-app',
              providerSubjectId: randomUUID(),
              storeId: FASHION_STORE_ID,
            },
          }),
      ),
    ).rejects.toThrow();
  });

  it('rejects platform permissions on a store role', async () => {
    await expect(
      withStoreTransaction(
        client,
        contextFor(BEAUTY_STORE_ID, 'beauty-local'),
        async (transaction) => {
          const role = await transaction.storeRole.findFirstOrThrow({
            where: { code: 'store-admin' },
          });
          return transaction.storeRolePermission.create({
            data: {
              permissionCode: 'platform.stores.read',
              roleId: role.id,
              storeId: BEAUTY_STORE_ID,
            },
          });
        },
      ),
    ).rejects.toThrow();
  });

  it('prevents tenant reassignment and audit mutation', async () => {
    const memberId = randomUUID();
    const auditId = randomUUID();
    await withStoreTransaction(
      client,
      contextFor(BEAUTY_STORE_ID, 'beauty-local'),
      async (transaction) => {
        await transaction.member.create({ data: { id: memberId, storeId: BEAUTY_STORE_ID } });
        await transaction.auditLog.create({
          data: {
            action: 'member.created',
            actorId: ACTOR_ID,
            actorType: 'ADMIN',
            correlationId: randomUUID(),
            id: auditId,
            storeId: BEAUTY_STORE_ID,
            targetId: memberId,
            targetType: 'member',
          },
        });

        await expect(
          transaction.member.update({
            data: { storeId: FASHION_STORE_ID },
            where: { id: memberId },
          }),
        ).rejects.toThrow();
        await expect(
          transaction.auditLog.update({
            data: { action: 'tampered' },
            where: { id: auditId },
          }),
        ).rejects.toThrow();
      },
    );
  });
});
