import { randomUUID } from 'node:crypto';

import { config as loadEnvironment } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createRuntimePrismaClient,
  PrismaClient,
  type StoreTransaction,
  withStoreTransaction,
} from '@zalo-shop/database';
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
  'promotion_operations',
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
  const ownerDatabaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_RUNTIME_URL is required');
  if (!ownerDatabaseUrl) throw new Error('DATABASE_URL is required');
  const client = createRuntimePrismaClient(databaseUrl);
  const contender = createRuntimePrismaClient(databaseUrl);
  const owner = new PrismaClient({ datasourceUrl: ownerDatabaseUrl });

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

  async function createReserveDefinition(
    transaction: StoreTransaction,
    input: Readonly<{
      items: readonly Readonly<{ quantity: number; skuId: string; warehouseId: string }>[];
      operationKey: string;
      reservationId: string;
    }>,
  ): Promise<void> {
    const operationId = randomUUID();
    const snapshot = JSON.stringify({
      items: input.items.map((item) => ({
        quantity: item.quantity,
        sku_id: item.skuId,
        warehouse_id: item.warehouseId,
      })),
      operation_id: operationId,
      reservation_id: input.reservationId,
      status: 'ACTIVE',
      terminal_at: null,
    });
    await transaction.$executeRaw`INSERT INTO inventory_operations
      (id, store_id, operation_key, request_hash, operation_type, result_snapshot)
      VALUES (${operationId}::uuid, ${BEAUTY_STORE_ID}::uuid,
        ${input.operationKey}, ${'f'.repeat(64)}, 'RESERVE', ${snapshot}::jsonb)`;
  }

  async function expectSqlState(promise: Promise<unknown>, sqlState: string): Promise<void> {
    try {
      await promise;
      throw new Error(`Expected SQLSTATE ${sqlState}`);
    } catch (error) {
      expect(error).toMatchObject({ code: 'P2010', meta: { code: sqlState } });
    }
  }

  beforeAll(async () => Promise.all([client.$connect(), contender.$connect(), owner.$connect()]));
  afterAll(async () =>
    Promise.all([client.$disconnect(), contender.$disconnect(), owner.$disconnect()]),
  );

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

    const retryIndexes = await owner.$queryRaw<Array<{ definition: string }>>`
      SELECT pg_get_indexdef(indexrelid) AS definition
      FROM pg_index
      WHERE indexrelid = 'inventory_reservations_expiration_retry_idx'::regclass
    `;
    expect(retryIndexes).toHaveLength(1);
    expect(retryIndexes[0]?.definition).toContain('last_expiration_failed_at NULLS FIRST');
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

  it('requires conserved terminal facts and freezes reservation terminal states', async () => {
    const { skuId } = await createSku(BEAUTY_STORE_ID, 'beauty-local');
    const balanceId = randomUUID();
    const reservationId = randomUUID();
    const reservationItemId = randomUUID();
    const operationId = randomUUID();
    const movementId = randomUUID();
    const reservationKey = `reserve-${reservationId}`;
    const storeContext = contextFor(BEAUTY_STORE_ID, 'beauty-local');
    await withStoreTransaction(client, storeContext, async (transaction) => {
      await transaction.$executeRaw`INSERT INTO inventory_balances
          (id, store_id, warehouse_id, sku_id, on_hand, reserved, updated_at)
          VALUES (${balanceId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${BEAUTY_WAREHOUSE_ID}::uuid, ${skuId}::uuid, 2, 1, now())`;
      await createReserveDefinition(transaction, {
        items: [{ quantity: 1, skuId, warehouseId: BEAUTY_WAREHOUSE_ID }],
        operationKey: reservationKey,
        reservationId,
      });
      await transaction.$executeRaw`INSERT INTO inventory_reservations
          (id, store_id, reservation_key, expires_at)
          VALUES (${reservationId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${reservationKey}, now() + interval '1 hour')`;
      await transaction.$executeRaw`INSERT INTO inventory_reservation_items
          (id, store_id, reservation_id, warehouse_id, sku_id, quantity)
          VALUES (${reservationItemId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${reservationId}::uuid, ${BEAUTY_WAREHOUSE_ID}::uuid, ${skuId}::uuid, 1)`;
    });

    for (const mutation of [
      `UPDATE inventory_reservations SET expires_at = now() + interval '2 hours' WHERE id = '${reservationId}'::uuid`,
      `UPDATE inventory_reservations SET source_type = 'ORDER', source_id = '${randomUUID()}'::uuid WHERE id = '${reservationId}'::uuid`,
    ]) {
      await expect(
        withStoreTransaction(client, storeContext, (transaction) =>
          transaction.$executeRawUnsafe(mutation),
        ),
      ).rejects.toThrow();
    }

    const terminalAt = new Date();
    const terminalSnapshot = JSON.stringify({
      operation_id: operationId,
      reservation_id: reservationId,
      status: 'RELEASED',
      terminal_at: terminalAt.toISOString(),
    });
    await expect(
      withStoreTransaction(client, storeContext, async (transaction) => {
        await transaction.$executeRaw`INSERT INTO inventory_operations
          (id, store_id, operation_key, request_hash, operation_type, result_snapshot)
          VALUES (${operationId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${`release-${operationId}`}, ${'c'.repeat(64)}, 'RELEASE',
            ${terminalSnapshot}::jsonb)`;
        await transaction.$executeRaw`UPDATE inventory_reservations
          SET status = 'RELEASED', terminal_operation_id = ${operationId}::uuid,
            terminal_at = ${terminalAt}
          WHERE id = ${reservationId}::uuid`;
      }),
    ).rejects.toThrow();

    await expect(
      withStoreTransaction(client, storeContext, async (transaction) => {
        await transaction.$executeRaw`INSERT INTO inventory_operations
          (id, store_id, operation_key, request_hash, operation_type, result_snapshot)
          VALUES (${operationId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${`release-${operationId}`}, ${'c'.repeat(64)}, 'RELEASE',
            ${terminalSnapshot}::jsonb)`;
        await transaction.$executeRaw`UPDATE inventory_balances
          SET reserved = 0, version = version + 1, updated_at = ${terminalAt}
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${balanceId}::uuid`;
        await transaction.$executeRaw`INSERT INTO inventory_movements
          (id, store_id, balance_id, operation_id, reservation_item_id, movement_type,
            on_hand_before, on_hand_after, on_hand_delta,
            reserved_before, reserved_after, reserved_delta, reason_code, created_at)
          VALUES (${movementId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${balanceId}::uuid,
            ${operationId}::uuid, ${reservationItemId}::uuid, 'RELEASE',
            2, 2, 0, 1, 0, -1, 'RESERVATION_RELEASED', ${terminalAt})`;
        await transaction.$executeRaw`UPDATE inventory_reservations
          SET status = 'RELEASED', terminal_operation_id = ${operationId}::uuid,
            terminal_at = ${terminalAt}
          WHERE id = ${reservationId}::uuid`;
      }),
    ).resolves.toBeUndefined();

    await expectSqlState(
      owner.$executeRaw`INSERT INTO inventory_reservation_items
        (id, store_id, reservation_id, warehouse_id, sku_id, quantity)
        VALUES (${randomUUID()}::uuid, ${BEAUTY_STORE_ID}::uuid, ${reservationId}::uuid,
          ${BEAUTY_WAREHOUSE_ID}::uuid, ${skuId}::uuid, 1)`,
      '42501',
    );
    await expectSqlState(
      owner.$executeRaw`INSERT INTO inventory_movements
        (id, store_id, balance_id, operation_id, reservation_item_id, movement_type,
          on_hand_before, on_hand_after, on_hand_delta,
          reserved_before, reserved_after, reserved_delta, reason_code, created_at)
        VALUES (${randomUUID()}::uuid, ${BEAUTY_STORE_ID}::uuid, ${balanceId}::uuid,
          ${operationId}::uuid, ${reservationItemId}::uuid, 'RELEASE',
          2, 2, 0, 1, 0, -1, 'RESERVATION_RELEASED', ${terminalAt})`,
      '42501',
    );
    const terminalBindingTrigger = await owner.$queryRaw<
      Array<{ tgdeferrable: boolean; tginitdeferred: boolean }>
    >`SELECT tgdeferrable, tginitdeferred
      FROM pg_trigger
      WHERE tgname = 'inventory_movements_terminal_binding_guard'
        AND tgrelid = 'inventory_movements'::regclass`;
    expect(terminalBindingTrigger).toEqual([{ tgdeferrable: true, tginitdeferred: true }]);

    await expect(
      withStoreTransaction(
        client,
        storeContext,
        async (transaction) =>
          transaction.$executeRaw`UPDATE inventory_reservations SET status = 'CONSUMED'
            WHERE id = ${reservationId}::uuid`,
      ),
    ).rejects.toThrow();
  });

  it('rejects foreign terminal movements across transaction snapshots', async () => {
    for (const isolationLevel of ['ReadCommitted', 'RepeatableRead'] as const) {
      const { skuId } = await createSku(BEAUTY_STORE_ID, 'beauty-local');
      const balanceId = randomUUID();
      const reservationId = randomUUID();
      const reservationItemId = randomUUID();
      const foreignReservationId = randomUUID();
      const foreignReservationItemId = randomUUID();
      const operationId = randomUUID();
      const reservationKey = `reserve-${reservationId}`;
      const foreignReservationKey = `reserve-${foreignReservationId}`;
      const terminalAt = new Date();
      const storeContext = contextFor(BEAUTY_STORE_ID, 'beauty-local');
      const terminalSnapshot = JSON.stringify({
        operation_id: operationId,
        reservation_id: reservationId,
        status: 'RELEASED',
        terminal_at: terminalAt.toISOString(),
      });

      await withStoreTransaction(client, storeContext, async (transaction) => {
        await transaction.$executeRaw`INSERT INTO inventory_balances
          (id, store_id, warehouse_id, sku_id, on_hand, reserved, updated_at)
          VALUES (${balanceId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${BEAUTY_WAREHOUSE_ID}::uuid, ${skuId}::uuid, 2, 2, now())`;
        await createReserveDefinition(transaction, {
          items: [{ quantity: 1, skuId, warehouseId: BEAUTY_WAREHOUSE_ID }],
          operationKey: reservationKey,
          reservationId,
        });
        await createReserveDefinition(transaction, {
          items: [{ quantity: 1, skuId, warehouseId: BEAUTY_WAREHOUSE_ID }],
          operationKey: foreignReservationKey,
          reservationId: foreignReservationId,
        });
        await transaction.$executeRaw`INSERT INTO inventory_reservations
          (id, store_id, reservation_key, expires_at)
          VALUES
            (${reservationId}::uuid, ${BEAUTY_STORE_ID}::uuid,
              ${reservationKey}, now() + interval '1 hour'),
            (${foreignReservationId}::uuid, ${BEAUTY_STORE_ID}::uuid,
              ${foreignReservationKey}, now() + interval '1 hour')`;
        await transaction.$executeRaw`INSERT INTO inventory_reservation_items
          (id, store_id, reservation_id, warehouse_id, sku_id, quantity)
          VALUES
            (${reservationItemId}::uuid, ${BEAUTY_STORE_ID}::uuid,
              ${reservationId}::uuid, ${BEAUTY_WAREHOUSE_ID}::uuid, ${skuId}::uuid, 1),
            (${foreignReservationItemId}::uuid, ${BEAUTY_STORE_ID}::uuid,
              ${foreignReservationId}::uuid, ${BEAUTY_WAREHOUSE_ID}::uuid, ${skuId}::uuid, 1)`;
        await transaction.$executeRaw`INSERT INTO inventory_operations
          (id, store_id, operation_key, request_hash, operation_type, result_snapshot)
          VALUES (${operationId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${`release-${operationId}`}, ${'d'.repeat(64)}, 'RELEASE',
            ${terminalSnapshot}::jsonb)`;
      });

      let insertionSucceeded = false;
      let markInsertionAttempted!: () => void;
      const insertionAttempted = new Promise<void>((resolve) => {
        markInsertionAttempted = resolve;
      });
      let allowConstraintCheck!: () => void;
      const terminalCommitted = new Promise<void>((resolve) => {
        allowConstraintCheck = resolve;
      });

      const foreignMovement = withStoreTransaction(
        contender,
        storeContext,
        async (transaction) => {
          try {
            await transaction.$executeRaw`INSERT INTO inventory_movements
              (id, store_id, balance_id, operation_id, reservation_item_id, movement_type,
                on_hand_before, on_hand_after, on_hand_delta,
                reserved_before, reserved_after, reserved_delta, reason_code, created_at)
              VALUES (${randomUUID()}::uuid, ${BEAUTY_STORE_ID}::uuid, ${balanceId}::uuid,
                ${operationId}::uuid, ${foreignReservationItemId}::uuid, 'RELEASE',
                2, 2, 0, 2, 1, -1, 'RESERVATION_RELEASED', ${terminalAt})`;
            insertionSucceeded = true;
          } finally {
            markInsertionAttempted();
          }
          await terminalCommitted;
          await transaction.$executeRawUnsafe(
            'SET CONSTRAINTS "inventory_movements_terminal_binding_guard" IMMEDIATE',
          );
          // Always roll back if the guard incorrectly accepts the foreign fact.
          await transaction.$executeRawUnsafe('SELECT 1 / 0');
        },
        { isolationLevel },
      );

      await insertionAttempted;
      let terminalFailure: unknown;
      try {
        if (insertionSucceeded) {
          await withStoreTransaction(client, storeContext, async (transaction) => {
            await transaction.$executeRaw`UPDATE inventory_balances
              SET reserved = 1, version = version + 1, updated_at = ${terminalAt}
              WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${balanceId}::uuid`;
            await transaction.$executeRaw`INSERT INTO inventory_movements
              (id, store_id, balance_id, operation_id, reservation_item_id, movement_type,
                on_hand_before, on_hand_after, on_hand_delta,
                reserved_before, reserved_after, reserved_delta, reason_code, created_at)
              VALUES (${randomUUID()}::uuid, ${BEAUTY_STORE_ID}::uuid, ${balanceId}::uuid,
                ${operationId}::uuid, ${reservationItemId}::uuid, 'RELEASE',
                2, 2, 0, 2, 1, -1, 'RESERVATION_RELEASED', ${terminalAt})`;
            await transaction.$executeRaw`UPDATE inventory_reservations
              SET status = 'RELEASED', terminal_operation_id = ${operationId}::uuid,
                terminal_at = ${terminalAt}
              WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${reservationId}::uuid`;
          });
        }
      } catch (error) {
        terminalFailure = error;
      } finally {
        allowConstraintCheck();
      }

      await expectSqlState(foreignMovement, '42501');
      if (terminalFailure !== undefined) {
        throw terminalFailure instanceof Error
          ? terminalFailure
          : new Error('Terminal transition failed with a non-error value', {
              cause: terminalFailure,
            });
      }
    }
  });

  it('seals reservation item definitions across transaction snapshots', async () => {
    for (const isolationLevel of ['ReadCommitted', 'RepeatableRead'] as const) {
      const { skuId } = await createSku(BEAUTY_STORE_ID, 'beauty-local');
      const { skuId: appendedSkuId } = await createSku(BEAUTY_STORE_ID, 'beauty-local');
      const storeContext = contextFor(BEAUTY_STORE_ID, 'beauty-local');

      const incompleteReservationId = randomUUID();
      const incompleteReservationKey = `reserve-${incompleteReservationId}`;
      await expectSqlState(
        withStoreTransaction(
          client,
          storeContext,
          async (transaction) => {
            await createReserveDefinition(transaction, {
              items: [
                { quantity: 1, skuId, warehouseId: BEAUTY_WAREHOUSE_ID },
                { quantity: 1, skuId: appendedSkuId, warehouseId: BEAUTY_WAREHOUSE_ID },
              ],
              operationKey: incompleteReservationKey,
              reservationId: incompleteReservationId,
            });
            await transaction.$executeRaw`INSERT INTO inventory_reservations
              (id, store_id, reservation_key, expires_at)
              VALUES (${incompleteReservationId}::uuid, ${BEAUTY_STORE_ID}::uuid,
                ${incompleteReservationKey}, now() + interval '1 hour')`;
            await transaction.$executeRaw`INSERT INTO inventory_reservation_items
              (id, store_id, reservation_id, warehouse_id, sku_id, quantity)
              VALUES (${randomUUID()}::uuid, ${BEAUTY_STORE_ID}::uuid,
                ${incompleteReservationId}::uuid, ${BEAUTY_WAREHOUSE_ID}::uuid,
                ${skuId}::uuid, 1)`;
            await transaction.$executeRawUnsafe(
              'SET CONSTRAINTS "inventory_reservations_terminal_facts_guard" IMMEDIATE',
            );
          },
          { isolationLevel },
        ),
        '23514',
      );

      const reservationId = randomUUID();
      const reservationKey = `reserve-${reservationId}`;
      await withStoreTransaction(client, storeContext, async (transaction) => {
        await createReserveDefinition(transaction, {
          items: [{ quantity: 1, skuId, warehouseId: BEAUTY_WAREHOUSE_ID }],
          operationKey: reservationKey,
          reservationId,
        });
        await transaction.$executeRaw`INSERT INTO inventory_reservations
          (id, store_id, reservation_key, expires_at)
          VALUES (${reservationId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${reservationKey}, now() + interval '1 hour')`;
        await transaction.$executeRaw`INSERT INTO inventory_reservation_items
          (id, store_id, reservation_id, warehouse_id, sku_id, quantity)
          VALUES (${randomUUID()}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${reservationId}::uuid, ${BEAUTY_WAREHOUSE_ID}::uuid, ${skuId}::uuid, 1)`;
      });

      await expectSqlState(
        withStoreTransaction(
          contender,
          storeContext,
          (transaction) =>
            transaction.$executeRaw`INSERT INTO inventory_reservation_items
              (id, store_id, reservation_id, warehouse_id, sku_id, quantity)
              VALUES (${randomUUID()}::uuid, ${BEAUTY_STORE_ID}::uuid,
                ${reservationId}::uuid, ${BEAUTY_WAREHOUSE_ID}::uuid,
                ${appendedSkuId}::uuid, 1)`,
          { isolationLevel },
        ),
        '42501',
      );
    }
  });

  it('makes reservation items append-only for the runtime role', async () => {
    const { skuId } = await createSku(BEAUTY_STORE_ID, 'beauty-local');
    const reservationId = randomUUID();
    const reservationItemId = randomUUID();
    const reservationKey = `reserve-${reservationId}`;
    const context = contextFor(BEAUTY_STORE_ID, 'beauty-local');
    await withStoreTransaction(client, context, async (transaction) => {
      await createReserveDefinition(transaction, {
        items: [{ quantity: 2, skuId, warehouseId: BEAUTY_WAREHOUSE_ID }],
        operationKey: reservationKey,
        reservationId,
      });
      await transaction.$executeRaw`INSERT INTO inventory_reservations
        (id, store_id, reservation_key, expires_at)
        VALUES (${reservationId}::uuid, ${BEAUTY_STORE_ID}::uuid,
          ${reservationKey}, now() + interval '100 years')`;
      await transaction.$executeRaw`INSERT INTO inventory_reservation_items
        (id, store_id, reservation_id, warehouse_id, sku_id, quantity)
        VALUES (${reservationItemId}::uuid, ${BEAUTY_STORE_ID}::uuid,
          ${reservationId}::uuid, ${BEAUTY_WAREHOUSE_ID}::uuid, ${skuId}::uuid, 2)`;
    });

    const privileges = await client.$queryRaw<
      Array<{ can_delete: boolean; can_update: boolean }>
    >`SELECT
        has_table_privilege(current_user, 'inventory_reservation_items', 'DELETE') AS can_delete,
        has_table_privilege(current_user, 'inventory_reservation_items', 'UPDATE') AS can_update`;
    expect(privileges).toEqual([{ can_delete: false, can_update: false }]);

    for (const mutation of [
      `UPDATE inventory_reservation_items SET quantity = 1 WHERE id = '${reservationItemId}'::uuid`,
      `DELETE FROM inventory_reservation_items WHERE id = '${reservationItemId}'::uuid`,
    ]) {
      await expect(
        withStoreTransaction(client, context, async (transaction) =>
          transaction.$executeRawUnsafe(mutation),
        ),
      ).rejects.toThrow();
    }
    for (const mutation of [
      `UPDATE inventory_reservation_items SET quantity = 1 WHERE id = '${reservationItemId}'::uuid`,
      `DELETE FROM inventory_reservation_items WHERE id = '${reservationItemId}'::uuid`,
    ]) {
      await expectSqlState(owner.$executeRawUnsafe(mutation), '42501');
    }
    await expect(
      withStoreTransaction(client, context, (transaction) =>
        transaction.inventoryReservationItem.findUnique({
          where: { storeId_id: { id: reservationItemId, storeId: BEAUTY_STORE_ID } },
        }),
      ),
    ).resolves.toMatchObject({ quantity: 2 });
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

  it('keeps coupon counters and append-only claim facts in the same committed state', async () => {
    const adminId = randomUUID();
    const promotionId = randomUUID();
    const versionId = randomUUID();
    const couponId = randomUUID();
    const memberIds = [randomUUID(), randomUUID()] as const;
    const storeContext = contextFor(BEAUTY_STORE_ID, 'beauty-local');

    await client.$executeRaw`INSERT INTO admin_users
      (id, email, email_normalized, display_name, password_hash, updated_at)
      VALUES (${adminId}::uuid, ${`${adminId}@example.invalid`},
        ${`${adminId}@example.invalid`}, 'M3 coupon integrity admin',
        'not-a-real-login-hash', now())`;
    await withStoreTransaction(client, storeContext, async (transaction) => {
      await transaction.member.createMany({
        data: memberIds.map((id) => ({ id, storeId: BEAUTY_STORE_ID })),
      });
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
        VALUES (${BEAUTY_STORE_ID}::uuid, ${versionId}::uuid, 'vi',
          'Khuyến mãi toàn vẹn', now())`;
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
        (id, store_id, code, promotion_version_id, status, updated_at)
        VALUES (${couponId}::uuid, ${BEAUTY_STORE_ID}::uuid,
          ${`coupon-${couponId.slice(0, 8)}`}, ${versionId}::uuid, 'ACTIVE', now())`;
    });

    await expect(
      withStoreTransaction(client, storeContext, async (transaction) => {
        await transaction.$executeRaw`UPDATE coupons SET claimed_count = claimed_count + 1
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${couponId}::uuid`;
        await transaction.$executeRaw`INSERT INTO member_coupons
          (store_id, coupon_id, member_id, updated_at)
          VALUES (${BEAUTY_STORE_ID}::uuid, ${couponId}::uuid, ${memberIds[0]}::uuid, now())`;
      }),
    ).resolves.toBeUndefined();

    await expect(
      withStoreTransaction(
        client,
        storeContext,
        (transaction) =>
          transaction.$executeRaw`INSERT INTO member_coupons
          (store_id, coupon_id, member_id, updated_at)
          VALUES (${BEAUTY_STORE_ID}::uuid, ${couponId}::uuid, ${memberIds[1]}::uuid, now())`,
      ),
    ).rejects.toThrow();
    await expect(
      withStoreTransaction(
        client,
        storeContext,
        (transaction) =>
          transaction.$executeRaw`UPDATE coupons SET claimed_count = 2
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${couponId}::uuid`,
      ),
    ).rejects.toThrow();
    await expect(
      withStoreTransaction(
        client,
        storeContext,
        (transaction) =>
          transaction.$executeRaw`DELETE FROM member_coupons
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND coupon_id = ${couponId}::uuid`,
      ),
    ).rejects.toThrow();
    await expect(
      withStoreTransaction(
        client,
        storeContext,
        (transaction) =>
          transaction.$executeRaw`DELETE FROM coupons
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${couponId}::uuid`,
      ),
    ).rejects.toThrow();

    await expectSqlState(
      owner.$transaction(async (transaction) => {
        await transaction.$executeRaw`DELETE FROM member_coupons
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND coupon_id = ${couponId}::uuid`;
        await transaction.$executeRaw`UPDATE coupons SET claimed_count = claimed_count - 1
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${couponId}::uuid`;
      }),
      '42501',
    );
    await expectSqlState(
      owner.$executeRaw`DELETE FROM coupons
        WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${couponId}::uuid`,
      '42501',
    );

    const facts = await withStoreTransaction(client, storeContext, async (transaction) => ({
      coupon: await transaction.coupon.findUniqueOrThrow({
        select: { claimedCount: true },
        where: { storeId_id: { id: couponId, storeId: BEAUTY_STORE_ID } },
      }),
      claimCount: await transaction.memberCoupon.count({ where: { couponId } }),
    }));
    expect(facts).toEqual({ claimCount: 1, coupon: { claimedCount: 1 } });
  });

  it('returns SQLSTATE 55000 from both M3.7 rollback guards when facts exist', async () => {
    const helperPrivileges = await owner.$queryRaw<
      Array<{
        can_check_coupon: boolean;
        can_check_definition: boolean;
        can_check_inventory: boolean;
      }>
    >`SELECT
      has_function_privilege(
        'zalo_shop_runtime',
        'app_security.assert_coupon_claim_count_for(uuid,uuid)',
        'EXECUTE'
      ) AS can_check_coupon,
      has_function_privilege(
        'zalo_shop_runtime',
        'app_security.assert_inventory_reservation_definition_for(uuid,uuid)',
        'EXECUTE'
      ) AS can_check_definition,
      has_function_privilege(
        'zalo_shop_runtime',
        'app_security.assert_inventory_reservation_terminal_facts_for(
          uuid,uuid,inventory_reservation_status,uuid,boolean
        )',
        'EXECUTE'
      ) AS can_check_inventory`;
    expect(helperPrivileges).toEqual([
      { can_check_coupon: false, can_check_definition: false, can_check_inventory: false },
    ]);

    for (const guard of [
      'assert_m37_coupon_integrity_rollback_safe',
      'assert_m37_inventory_integrity_rollback_safe',
    ]) {
      await expectSqlState(owner.$queryRawUnsafe(`SELECT app_security.${guard}()`), '55000');
    }
  });

  it('serializes child mutations against publishing and rejects the late mutation', async () => {
    const adminId = randomUUID();
    const promotionId = randomUUID();
    const versionId = randomUUID();
    await client.$executeRaw`INSERT INTO admin_users
      (id, email, email_normalized, display_name, password_hash, updated_at)
      VALUES (${adminId}::uuid, ${`${adminId}@example.invalid`},
        ${`${adminId}@example.invalid`}, 'M3 concurrent publish admin',
        'not-a-real-login-hash', now())`;
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
            1, 'ITEM', 'FIXED_VND', 10000, now())`;
        await transaction.$executeRaw`INSERT INTO promotion_version_localizations
          (store_id, promotion_version_id, locale, name, updated_at)
          VALUES (${BEAUTY_STORE_ID}::uuid, ${versionId}::uuid, 'vi',
            'Khuyến mãi đồng thời', now())`;
        await transaction.$executeRaw`INSERT INTO promotion_targets
          (store_id, promotion_version_id, target_type)
          VALUES (${BEAUTY_STORE_ID}::uuid, ${versionId}::uuid, 'STORE')`;
      },
    );

    let markPublished!: () => void;
    let releasePublisher!: () => void;
    const publishedRowLocked = new Promise<void>((resolve) => (markPublished = resolve));
    const publisherRelease = new Promise<void>((resolve) => (releasePublisher = resolve));
    const publishing = withStoreTransaction(
      client,
      contextFor(BEAUTY_STORE_ID, 'beauty-local'),
      async (transaction) => {
        await transaction.$executeRaw`UPDATE promotion_versions
          SET status = 'PUBLISHED', published_at = now(),
            published_by_admin_id = ${adminId}::uuid
          WHERE id = ${versionId}::uuid`;
        markPublished();
        await publisherRelease;
      },
    );
    await publishedRowLocked;

    let reportPid!: (pid: number) => void;
    const pidReady = new Promise<number>((resolve) => (reportPid = resolve));
    const mutationResult = withStoreTransaction(
      contender,
      contextFor(BEAUTY_STORE_ID, 'beauty-local'),
      async (transaction) => {
        const [{ pid }] = await transaction.$queryRaw<Array<{ pid: number }>>`
          SELECT pg_backend_pid() AS pid
        `;
        if (typeof pid !== 'number') throw new Error('PostgreSQL backend PID is invalid');
        reportPid(pid);
        await transaction.$executeRaw`INSERT INTO promotion_version_localizations
          (store_id, promotion_version_id, locale, name, updated_at)
          VALUES (${BEAUTY_STORE_ID}::uuid, ${versionId}::uuid, 'en',
            'Concurrent mutation', now())`;
      },
    ).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ error, ok: false as const }),
    );
    const contenderPid = await pidReady;
    try {
      await expect
        .poll(
          async () => {
            const rows = await client.$queryRaw<Array<{ wait_event_type: string | null }>>`
              SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${contenderPid}
            `;
            return rows[0]?.wait_event_type ?? null;
          },
          { timeout: 3_000 },
        )
        .toBe('Lock');
    } finally {
      releasePublisher();
    }
    await publishing;
    const result = await mutationResult;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(Error);

    const facts = await withStoreTransaction(
      client,
      contextFor(BEAUTY_STORE_ID, 'beauty-local'),
      async (transaction) => ({
        localizationCount: await transaction.promotionVersionLocalization.count({
          where: { promotionVersionId: versionId },
        }),
        version: await transaction.promotionVersion.findUniqueOrThrow({
          select: { status: true },
          where: { id: versionId },
        }),
      }),
    );
    expect(facts).toEqual({ localizationCount: 1, version: { status: 'PUBLISHED' } });
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
