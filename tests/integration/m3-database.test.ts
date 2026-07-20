import { randomUUID } from 'node:crypto';

import { config as loadEnvironment } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRuntimePrismaClient, withStoreTransaction } from '@zalo-shop/database';
import { createStoreContext } from '@zalo-shop/domain';

const BEAUTY_STORE_ID = '10000000-0000-4000-8000-000000000001';
const FASHION_STORE_ID = '10000000-0000-4000-8000-000000000002';
const BEAUTY_WAREHOUSE_ID = '17000000-0000-4000-8000-000000000001';
const ACTOR_ID = '20000000-0000-4000-8000-000000000001';
const M3_TABLES = [
  'cart_items',
  'carts',
  'coupons',
  'inventory_balances',
  'inventory_movements',
  'inventory_operations',
  'inventory_reservation_items',
  'inventory_reservations',
  'member_coupons',
  'member_search_history',
  'product_search_documents',
  'promotion_targets',
  'promotion_version_localizations',
  'promotion_versions',
  'promotions',
  'search_query_stats',
  'warehouse_localizations',
  'warehouses',
] as const;

describe('M3 commerce database isolation and invariants', () => {
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

  async function createSku(
    storeId: string,
    storeCode: string,
  ): Promise<{ brandId: string; productId: string; skuId: string }> {
    const brandId = randomUUID();
    const productId = randomUUID();
    const skuId = randomUUID();
    const categoryId =
      storeId === BEAUTY_STORE_ID
        ? '12000000-0000-4000-8000-000000000001'
        : '12000000-0000-4000-8000-000000000002';
    await withStoreTransaction(client, contextFor(storeId, storeCode), async (transaction) => {
      await transaction.$executeRaw`INSERT INTO brands (id, store_id, code, updated_at)
        VALUES (${brandId}::uuid, ${storeId}::uuid, ${`brand-${brandId.slice(0, 8)}`}, now())`;
      await transaction.$executeRaw`INSERT INTO products
        (id, store_id, code, brand_id, main_category_id, updated_at)
        VALUES (${productId}::uuid, ${storeId}::uuid, ${`product-${productId.slice(0, 8)}`},
          ${brandId}::uuid, ${categoryId}::uuid, now())`;
      await transaction.$executeRaw`INSERT INTO skus
        (id, store_id, product_id, code, sale_price_vnd, option_combination_key,
          option_combination_hash, updated_at)
        VALUES (${skuId}::uuid, ${storeId}::uuid, ${productId}::uuid,
          ${`sku-${skuId.slice(0, 8)}`}, 125000, 'test=default', ${'a'.repeat(64)}, now())`;
    });
    return { brandId, productId, skuId };
  }

  beforeAll(async () => client.$connect());
  afterAll(async () => client.$disconnect());

  it('installs required search extensions and protects every M3 table with forced RLS', async () => {
    const extensions = await client.$queryRaw<Array<{ extname: string }>>`
      SELECT extname FROM pg_extension WHERE extname IN ('pg_trgm', 'unaccent') ORDER BY extname
    `;
    expect(extensions).toEqual([{ extname: 'pg_trgm' }, { extname: 'unaccent' }]);

    const metadata = await client.$queryRawUnsafe<
      Array<{
        relforcerowsecurity: boolean;
        relname: string;
        relrowsecurity: boolean;
        trigger_count: bigint;
      }>
    >(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
        count(t.oid) FILTER (WHERE t.tgname = c.relname || '_store_immutable')::bigint AS trigger_count
      FROM pg_class c
      LEFT JOIN pg_trigger t ON t.tgrelid = c.oid AND NOT t.tgisinternal
      WHERE c.relnamespace = 'public'::regnamespace
        AND c.relname IN (${M3_TABLES.map((table) => `'${table}'`).join(',')})
      GROUP BY c.relname, c.relrowsecurity, c.relforcerowsecurity
      ORDER BY c.relname
    `);

    expect(metadata.map((row) => row.relname)).toEqual([...M3_TABLES].sort());
    expect(metadata.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
    expect(metadata.every((row) => row.trigger_count === 1n)).toBe(true);
  });

  it('fails closed without context and seeds explicit local/test permissions and warehouses', async () => {
    await expect(client.$queryRaw`SELECT id FROM warehouses`).resolves.toEqual([]);

    const seeded = await withStoreTransaction(
      client,
      contextFor(BEAUTY_STORE_ID, 'beauty-local'),
      async (transaction) => {
        const warehouses = await transaction.$queryRaw<
          Array<{ code: string; is_default_fulfillment: boolean }>
        >`SELECT code, is_default_fulfillment FROM warehouses ORDER BY code`;
        const permissions = await transaction.$queryRaw<Array<{ permission_code: string }>>`
          SELECT srp.permission_code
          FROM store_role_permissions srp
          JOIN store_roles sr ON sr.store_id = srp.store_id AND sr.id = srp.role_id
          WHERE sr.code = 'store-admin'
            AND (srp.permission_code LIKE 'store.inventory.%'
              OR srp.permission_code LIKE 'store.promotions.%')
          ORDER BY srp.permission_code
        `;
        return { permissions, warehouses };
      },
    );

    expect(seeded.warehouses).toContainEqual({
      code: 'local-default',
      is_default_fulfillment: true,
    });
    expect(seeded.permissions).toEqual([
      { permission_code: 'store.inventory.adjust' },
      { permission_code: 'store.inventory.manage' },
      { permission_code: 'store.inventory.read' },
      { permission_code: 'store.promotions.manage' },
      { permission_code: 'store.promotions.publish' },
      { permission_code: 'store.promotions.read' },
    ]);
  });

  it('enforces composite store ownership and immutable store_id', async () => {
    const { skuId } = await createSku(BEAUTY_STORE_ID, 'beauty-local');
    const balanceId = randomUUID();
    await withStoreTransaction(
      client,
      contextFor(BEAUTY_STORE_ID, 'beauty-local'),
      async (transaction) => {
        await transaction.$executeRaw`INSERT INTO inventory_balances
          (id, store_id, warehouse_id, sku_id, updated_at)
          VALUES (${balanceId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${BEAUTY_WAREHOUSE_ID}::uuid, ${skuId}::uuid, now())`;
      },
    );

    await expect(
      withStoreTransaction(
        client,
        contextFor(FASHION_STORE_ID, 'fashion-local'),
        async (transaction) =>
          transaction.$executeRaw`INSERT INTO inventory_balances
            (store_id, warehouse_id, sku_id, updated_at)
            VALUES (${FASHION_STORE_ID}::uuid, ${BEAUTY_WAREHOUSE_ID}::uuid, ${skuId}::uuid, now())`,
      ),
    ).rejects.toThrow();

    await expect(
      withStoreTransaction(
        client,
        contextFor(BEAUTY_STORE_ID, 'beauty-local'),
        async (transaction) =>
          transaction.$executeRaw`UPDATE inventory_balances
            SET store_id = ${FASHION_STORE_ID}::uuid WHERE id = ${balanceId}::uuid`,
      ),
    ).rejects.toThrow();
  });

  it('derives available stock and rejects invalid or mutable inventory facts', async () => {
    const { skuId } = await createSku(BEAUTY_STORE_ID, 'beauty-local');
    const balanceId = randomUUID();
    const operationId = randomUUID();
    const movementId = randomUUID();
    const result = await withStoreTransaction(
      client,
      contextFor(BEAUTY_STORE_ID, 'beauty-local'),
      async (transaction) => {
        await transaction.$executeRaw`INSERT INTO inventory_balances
          (id, store_id, warehouse_id, sku_id, on_hand, reserved, updated_at)
          VALUES (${balanceId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${BEAUTY_WAREHOUSE_ID}::uuid,
            ${skuId}::uuid, 5, 2, now())`;
        await transaction.$executeRaw`INSERT INTO inventory_operations
          (id, store_id, operation_key, request_hash, operation_type, result_snapshot)
          VALUES (${operationId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${`adjust-${operationId}`}, ${'b'.repeat(64)}, 'ADJUST', '{}'::jsonb)`;
        await transaction.$executeRaw`INSERT INTO inventory_movements
          (id, store_id, balance_id, operation_id, movement_type,
            on_hand_before, on_hand_after, on_hand_delta,
            reserved_before, reserved_after, reserved_delta, reason_code)
          VALUES (${movementId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${balanceId}::uuid,
            ${operationId}::uuid, 'ADJUSTMENT_IN', 0, 5, 5, 0, 0, 0, 'TEST_FIXTURE')`;
        return transaction.$queryRaw<Array<{ available: number }>>`
          SELECT available FROM inventory_balances WHERE id = ${balanceId}::uuid
        `;
      },
    );
    expect(result).toEqual([{ available: 3 }]);

    for (const mutation of [
      `UPDATE inventory_operations SET result_snapshot = '{"tampered":true}'::jsonb WHERE id = '${operationId}'::uuid`,
      `DELETE FROM inventory_movements WHERE id = '${movementId}'::uuid`,
      `UPDATE inventory_balances SET reserved = 6 WHERE id = '${balanceId}'::uuid`,
    ]) {
      await expect(
        withStoreTransaction(
          client,
          contextFor(BEAUTY_STORE_ID, 'beauty-local'),
          async (transaction) => transaction.$executeRawUnsafe(mutation),
        ),
      ).rejects.toThrow();
    }
  });

  it('freezes reservation terminal states', async () => {
    const reservationId = randomUUID();
    const operationId = randomUUID();
    await withStoreTransaction(
      client,
      contextFor(BEAUTY_STORE_ID, 'beauty-local'),
      async (transaction) => {
        await transaction.$executeRaw`INSERT INTO inventory_reservations
          (id, store_id, reservation_key, expires_at)
          VALUES (${reservationId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${`reserve-${reservationId}`}, now() + interval '1 hour')`;
        await transaction.$executeRaw`INSERT INTO inventory_operations
          (id, store_id, operation_key, request_hash, operation_type, result_snapshot)
          VALUES (${operationId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${`release-${operationId}`}, ${'c'.repeat(64)}, 'RELEASE', '{}'::jsonb)`;
        await transaction.$executeRaw`UPDATE inventory_reservations
          SET status = 'RELEASED', terminal_operation_id = ${operationId}::uuid, terminal_at = now()
          WHERE id = ${reservationId}::uuid`;
      },
    );

    await expect(
      withStoreTransaction(
        client,
        contextFor(BEAUTY_STORE_ID, 'beauty-local'),
        async (transaction) =>
          transaction.$executeRaw`UPDATE inventory_reservations SET status = 'CONSUMED'
            WHERE id = ${reservationId}::uuid`,
      ),
    ).rejects.toThrow();
  });

  it('validates published promotion versions and freezes their localized targets', async () => {
    const adminId = randomUUID();
    const promotionId = randomUUID();
    const versionId = randomUUID();
    const couponId = randomUUID();
    await client.$executeRaw`INSERT INTO admin_users
      (id, email, email_normalized, display_name, password_hash, updated_at)
      VALUES (${adminId}::uuid, ${`${adminId}@example.invalid`},
        ${`${adminId}@example.invalid`}, 'M3 test admin', 'not-a-real-login-hash', now())`;

    await withStoreTransaction(
      client,
      contextFor(BEAUTY_STORE_ID, 'beauty-local'),
      async (transaction) => {
        await transaction.$executeRaw`INSERT INTO promotions
          (id, store_id, code, created_by_admin_id, updated_by_admin_id, updated_at)
          VALUES (${promotionId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${`promo-${promotionId.slice(0, 8)}`}, ${adminId}::uuid, ${adminId}::uuid, now())`;
        await transaction.$executeRaw`INSERT INTO promotion_versions
          (id, store_id, promotion_id, version_number, bucket, benefit_method,
            fixed_discount_vnd, starts_at)
          VALUES (${versionId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${promotionId}::uuid,
            1, 'COUPON', 'FIXED_VND', 10000, now())`;
        await transaction.$executeRaw`INSERT INTO promotion_version_localizations
          (store_id, promotion_version_id, locale, name, updated_at)
          VALUES (${BEAUTY_STORE_ID}::uuid, ${versionId}::uuid, 'vi', 'Khuyến mãi thử nghiệm', now())`;
        await transaction.$executeRaw`INSERT INTO promotion_targets
          (store_id, promotion_version_id, target_type)
          VALUES (${BEAUTY_STORE_ID}::uuid, ${versionId}::uuid, 'STORE')`;
        await transaction.$executeRaw`UPDATE promotion_versions
          SET status = 'PUBLISHED', published_at = now(), published_by_admin_id = ${adminId}::uuid
          WHERE id = ${versionId}::uuid`;
        await transaction.$executeRaw`UPDATE promotions
          SET status = 'ACTIVE', active_version_id = ${versionId}::uuid,
            version = version + 1, updated_at = now()
          WHERE id = ${promotionId}::uuid`;
        await transaction.$executeRaw`INSERT INTO coupons
          (id, store_id, code, promotion_version_id, updated_at)
          VALUES (${couponId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${`coupon-${couponId.slice(0, 8)}`}, ${versionId}::uuid, now())`;
      },
    );

    for (const mutation of [
      `UPDATE promotion_versions SET priority = 2 WHERE id = '${versionId}'::uuid`,
      `UPDATE promotion_version_localizations SET name = 'Tampered' WHERE promotion_version_id = '${versionId}'::uuid`,
      `INSERT INTO promotion_targets (store_id, promotion_version_id, target_type) VALUES ('${BEAUTY_STORE_ID}'::uuid, '${versionId}'::uuid, 'STORE')`,
    ]) {
      await expect(
        withStoreTransaction(
          client,
          contextFor(BEAUTY_STORE_ID, 'beauty-local'),
          async (transaction) => transaction.$executeRawUnsafe(mutation),
        ),
      ).rejects.toThrow();
    }

    await expect(
      withStoreTransaction(
        client,
        contextFor(BEAUTY_STORE_ID, 'beauty-local'),
        async (transaction) =>
          transaction.$executeRaw`UPDATE promotions SET status = 'ENDED', updated_at = now()
            WHERE id = ${promotionId}::uuid`,
      ),
    ).resolves.toBeDefined();
    await expect(
      withStoreTransaction(
        client,
        contextFor(BEAUTY_STORE_ID, 'beauty-local'),
        async (transaction) =>
          transaction.$executeRaw`UPDATE promotions SET status = 'ACTIVE', updated_at = now()
            WHERE id = ${promotionId}::uuid`,
      ),
    ).rejects.toThrow();
  });

  it('enforces one ACTIVE cart per member and safe line values', async () => {
    const { skuId } = await createSku(BEAUTY_STORE_ID, 'beauty-local');
    const memberId = randomUUID();
    const cartId = randomUUID();
    await withStoreTransaction(
      client,
      contextFor(BEAUTY_STORE_ID, 'beauty-local'),
      async (transaction) => {
        await transaction.member.create({ data: { id: memberId, storeId: BEAUTY_STORE_ID } });
        await transaction.$executeRaw`INSERT INTO carts (id, store_id, member_id, updated_at)
          VALUES (${cartId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${memberId}::uuid, now())`;
        await transaction.$executeRaw`INSERT INTO cart_items
          (store_id, cart_id, sku_id, quantity, added_unit_price_vnd, updated_at)
          VALUES (${BEAUTY_STORE_ID}::uuid, ${cartId}::uuid, ${skuId}::uuid, 1, 125000, now())`;
      },
    );

    await expect(
      withStoreTransaction(
        client,
        contextFor(BEAUTY_STORE_ID, 'beauty-local'),
        async (transaction) =>
          transaction.$executeRaw`INSERT INTO carts (store_id, member_id, updated_at)
            VALUES (${BEAUTY_STORE_ID}::uuid, ${memberId}::uuid, now())`,
      ),
    ).rejects.toThrow();
    await expect(
      withStoreTransaction(
        client,
        contextFor(BEAUTY_STORE_ID, 'beauty-local'),
        async (transaction) =>
          transaction.$executeRaw`UPDATE cart_items SET quantity = 100 WHERE cart_id = ${cartId}::uuid`,
      ),
    ).rejects.toThrow();
  });
});
