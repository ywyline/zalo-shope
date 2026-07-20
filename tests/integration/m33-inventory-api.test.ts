import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { config as loadEnvironment } from 'dotenv';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseRuntimeConfig } from '@zalo-shop/config';
import {
  consumeReservation,
  createRuntimePrismaClient,
  PrismaClient,
  releaseReservation,
  reserveInventory,
} from '@zalo-shop/database';
import type { InventoryPrimitiveError } from '@zalo-shop/database';
import { createStoreContext } from '@zalo-shop/domain';
import { hashSensitive, signJwt } from '@zalo-shop/security';

import { InventoryExpirationService } from '../../apps/worker/src/inventory/inventory-expiration.service';

const BEAUTY_STORE_ID = '10000000-0000-4000-8000-000000000001';
const FASHION_STORE_ID = '10000000-0000-4000-8000-000000000002';
const BEAUTY_CATEGORY_ID = '12000000-0000-4000-8000-000000000001';
const BEAUTY_TEMPLATE_VERSION_ID = '14000000-0000-4000-8000-000000000001';
const BEAUTY_WAREHOUSE_ID = '17000000-0000-4000-8000-000000000001';

describe('M3.3 warehouse, inventory and reservation services', () => {
  loadEnvironment({ path: '.env.test.example', quiet: true, override: true });
  const config = parseRuntimeConfig();
  const owner = new PrismaClient({ datasourceUrl: config.DATABASE_URL });
  const runtime = createRuntimePrismaClient(config.DATABASE_RUNTIME_URL);
  const fixture = {
    adminId: randomUUID(),
    balanceId: randomUUID(),
    brandId: randomUUID(),
    createdWarehouseId: '' as string,
    productId: randomUUID(),
    roleId: randomUUID(),
    skuId: randomUUID(),
    skuImportId: randomUUID(),
  };
  const suffix = randomUUID().slice(0, 8);
  const skuCode = `m33-stock-${suffix}`;
  const importSkuCode = `m33-import-${suffix}`;
  let accessToken: string;
  let app: INestApplication;

  const headers = (storeCode = 'beauty-local') => ({
    Authorization: `Bearer ${accessToken}`,
    'X-Store-Code': storeCode,
  });

  const context = () =>
    createStoreContext({
      actor: { id: fixture.adminId, type: 'admin' },
      correlationId: randomUUID(),
      locale: 'vi',
      storeCode: 'beauty-local',
      storeId: BEAUTY_STORE_ID,
    });

  beforeAll(async () => {
    await Promise.all([owner.$connect(), runtime.$connect()]);
    const email = `m33-${suffix}@example.test`;
    await owner.adminUser.create({
      data: {
        displayName: 'M3.3 inventory administrator',
        email,
        emailNormalized: email,
        id: fixture.adminId,
        passwordHash: 'test-fixture-not-used',
      },
    });
    await owner.storeRole.create({
      data: {
        code: `m33-inventory-${suffix}`,
        id: fixture.roleId,
        name: 'M3.3 inventory operator',
        permissions: {
          create: [
            { permissionCode: 'store.inventory.read' },
            { permissionCode: 'store.inventory.manage' },
            { permissionCode: 'store.inventory.adjust' },
            { permissionCode: 'store.catalog.manage' },
          ],
        },
        storeId: BEAUTY_STORE_ID,
      },
    });
    const fashionRole = await owner.storeRole.findUniqueOrThrow({
      where: { storeId_code: { code: 'store-admin', storeId: FASHION_STORE_ID } },
    });
    await owner.adminStoreRole.createMany({
      data: [
        {
          adminUserId: fixture.adminId,
          grantedBy: fixture.adminId,
          roleId: fixture.roleId,
          storeId: BEAUTY_STORE_ID,
        },
        {
          adminUserId: fixture.adminId,
          grantedBy: fixture.adminId,
          roleId: fashionRole.id,
          storeId: FASHION_STORE_ID,
        },
      ],
    });
    await owner.brand.create({
      data: {
        code: `m33-brand-${suffix}`,
        id: fixture.brandId,
        status: 'ACTIVE',
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.product.create({
      data: {
        brandId: fixture.brandId,
        code: `m33-product-${suffix}`,
        id: fixture.productId,
        mainCategoryId: BEAUTY_CATEGORY_ID,
        attributeTemplateVersionId: BEAUTY_TEMPLATE_VERSION_ID,
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.sku.createMany({
      data: [
        {
          code: skuCode,
          id: fixture.skuId,
          optionCombinationHash: '1'.repeat(64),
          optionCombinationKey: `m33=${suffix}-stock`,
          productId: fixture.productId,
          salePriceVnd: 125000,
          storeId: BEAUTY_STORE_ID,
        },
        {
          code: importSkuCode,
          id: fixture.skuImportId,
          optionCombinationHash: '2'.repeat(64),
          optionCombinationKey: `m33=${suffix}-import`,
          productId: fixture.productId,
          salePriceVnd: 145000,
          storeId: BEAUTY_STORE_ID,
        },
      ],
    });
    await owner.inventoryBalance.create({
      data: {
        id: fixture.balanceId,
        skuId: fixture.skuId,
        storeId: BEAUTY_STORE_ID,
        warehouseId: BEAUTY_WAREHOUSE_ID,
      },
    });
    const session = await owner.adminSession.create({
      data: {
        adminUserId: fixture.adminId,
        expiresAt: new Date(Date.now() + 3_600_000),
        mfaVerifiedAt: new Date(),
        refreshTokenHash: hashSensitive(randomUUID(), config.PII_HASH_KEY),
        tokenFamilyId: randomUUID(),
      },
    });
    const now = Math.floor(Date.now() / 1_000);
    accessToken = signJwt(
      {
        actor_type: 'admin',
        aud: config.AUTH_JWT_AUDIENCE,
        exp: now + 900,
        iat: now,
        iss: config.AUTH_JWT_ISSUER,
        jti: randomUUID(),
        session_id: session.id,
        sub: fixture.adminId,
      },
      config.AUTH_JWT_SECRET,
    );
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
    await runtime.$disconnect();
    await owner.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      const operationIds = (
        await transaction.inventoryMovement.findMany({
          select: { operationId: true },
          where: {
            balance: { skuId: { in: [fixture.skuId, fixture.skuImportId] } },
            storeId: BEAUTY_STORE_ID,
          },
        })
      ).map((item) => item.operationId);
      await transaction.inventoryMovement.deleteMany({
        where: {
          balance: { skuId: { in: [fixture.skuId, fixture.skuImportId] } },
          storeId: BEAUTY_STORE_ID,
        },
      });
      await transaction.inventoryReservationItem.deleteMany({
        where: { storeId: BEAUTY_STORE_ID, skuId: { in: [fixture.skuId, fixture.skuImportId] } },
      });
      await transaction.inventoryReservation.deleteMany({
        where: { sourceId: fixture.productId, storeId: BEAUTY_STORE_ID },
      });
      await transaction.inventoryOperation.deleteMany({
        where: {
          OR: [{ adminId: fixture.adminId }, { id: { in: operationIds } }],
          storeId: BEAUTY_STORE_ID,
        },
      });
      await transaction.inventoryBalance.deleteMany({
        where: { skuId: { in: [fixture.skuId, fixture.skuImportId] }, storeId: BEAUTY_STORE_ID },
      });
      await transaction.auditLog.deleteMany({ where: { actorId: fixture.adminId } });
      if (fixture.createdWarehouseId) {
        await transaction.warehouseLocalization.deleteMany({
          where: { warehouseId: fixture.createdWarehouseId },
        });
        await transaction.warehouse.deleteMany({ where: { id: fixture.createdWarehouseId } });
      }
      await transaction.sku.deleteMany({
        where: { id: { in: [fixture.skuId, fixture.skuImportId] } },
      });
      await transaction.product.deleteMany({ where: { id: fixture.productId } });
      await transaction.brand.deleteMany({ where: { id: fixture.brandId } });
      await transaction.adminStoreRole.deleteMany({ where: { adminUserId: fixture.adminId } });
      await transaction.storeRolePermission.deleteMany({ where: { roleId: fixture.roleId } });
      await transaction.storeRole.deleteMany({ where: { id: fixture.roleId } });
      await transaction.adminSession.deleteMany({ where: { adminUserId: fixture.adminId } });
      await transaction.adminUser.deleteMany({ where: { id: fixture.adminId } });
    });
    await owner.$disconnect();
  });

  it('manages localized warehouses with optimistic locking and audit records', async () => {
    await request(app.getHttpServer() as Server)
      .get(`/v1/admin/inventory/warehouses?store_id=${BEAUTY_STORE_ID}`)
      .expect(401);

    const created = await request(app.getHttpServer() as Server)
      .post(`/v1/admin/inventory/warehouses?store_id=${BEAUTY_STORE_ID}`)
      .set(headers())
      .send({
        code: `m33-${suffix}`,
        enabled: true,
        is_default_fulfillment: false,
        localizations: [
          { locale: 'vi', name: 'Kho kiểm thử' },
          { locale: 'zh', name: '测试仓库' },
          { locale: 'en', name: 'Test warehouse' },
        ],
      })
      .expect(201);
    fixture.createdWarehouseId = created.body.id;
    expect(created.body.localizations).toHaveLength(3);

    await request(app.getHttpServer() as Server)
      .patch(
        `/v1/admin/inventory/warehouses/${fixture.createdWarehouseId}?store_id=${BEAUTY_STORE_ID}`,
      )
      .set(headers())
      .send({ enabled: false, expected_version: 1 })
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ enabled: false, version: 2 }));

    await request(app.getHttpServer() as Server)
      .patch(
        `/v1/admin/inventory/warehouses/${fixture.createdWarehouseId}?store_id=${BEAUTY_STORE_ID}`,
      )
      .set(headers())
      .send({ enabled: true, expected_version: 1 })
      .expect(409);

    expect(
      await owner.auditLog.count({
        where: { actorId: fixture.adminId, targetId: fixture.createdWarehouseId },
      }),
    ).toBe(2);
  });

  it('adjusts stock once, reports replay, rejects key reuse and filters by store', async () => {
    const operationKey = `adjust:${randomUUID()}`;
    const body = {
      confirmation_code: 'ADJUST',
      delta: 5,
      expected_version: 1,
      note: 'Cycle count approved',
      reason_code: 'CYCLE_COUNT',
      sku_id: fixture.skuId,
      warehouse_id: BEAUTY_WAREHOUSE_ID,
    };
    const first = await request(app.getHttpServer() as Server)
      .post(`/v1/admin/inventory/adjustments?store_id=${BEAUTY_STORE_ID}`)
      .set({ ...headers(), 'Idempotency-Key': operationKey })
      .send(body)
      .expect(200);
    expect(first.headers['idempotency-replayed']).toBe('false');
    expect(first.body.balance).toMatchObject({ available: 5, on_hand: 5, reserved: 0, version: 2 });

    const replay = await request(app.getHttpServer() as Server)
      .post(`/v1/admin/inventory/adjustments?store_id=${BEAUTY_STORE_ID}`)
      .set({ ...headers(), 'Idempotency-Key': operationKey })
      .send(body)
      .expect(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.body.operation_id).toBe(first.body.operation_id);

    await request(app.getHttpServer() as Server)
      .post(`/v1/admin/inventory/adjustments?store_id=${BEAUTY_STORE_ID}`)
      .set({ ...headers(), 'Idempotency-Key': operationKey })
      .send({ ...body, delta: 6 })
      .expect(409);
    await request(app.getHttpServer() as Server)
      .post(`/v1/admin/inventory/adjustments?store_id=${BEAUTY_STORE_ID}`)
      .set({ ...headers(), 'Idempotency-Key': `sensitive:${randomUUID()}` })
      .send({ ...body, expected_version: 2, note: 'access_token=must-not-be-stored' })
      .expect(400);

    await request(app.getHttpServer() as Server)
      .get(`/v1/admin/inventory/balances?store_id=${BEAUTY_STORE_ID}&q=${skuCode}&in_stock=true`)
      .set(headers())
      .expect(200)
      .expect(({ body }) =>
        expect(body.items).toContainEqual(expect.objectContaining({ sku_code: skuCode })),
      );
    await request(app.getHttpServer() as Server)
      .get(`/v1/admin/inventory/balances?store_id=${BEAUTY_STORE_ID}&cursor=not-a-uuid`)
      .set(headers())
      .expect(400);
    await request(app.getHttpServer() as Server)
      .get(`/v1/admin/inventory/balances?store_id=${FASHION_STORE_ID}&q=${skuCode}`)
      .set(headers('fashion-local'))
      .expect(200)
      .expect(({ body }) => expect(body.items).toEqual([]));

    expect(
      await owner.inventoryMovement.count({
        where: { balanceId: fixture.balanceId, movementType: 'ADJUSTMENT_IN' },
      }),
    ).toBe(1);
  });

  it('protects SKUs referenced by inventory history from physical replacement', async () => {
    await request(app.getHttpServer() as Server)
      .put(`/v1/admin/catalog/products/${fixture.productId}/skus?store_id=${BEAUTY_STORE_ID}`)
      .set(headers())
      .send({
        expected_version: 1,
        skus: [
          {
            code: `m33-replacement-${suffix}`,
            enabled: true,
            option_values: [{ attribute_code: 'shade', option_code: 'default' }],
            sale_price_vnd: 155000,
          },
        ],
      })
      .expect(409);
    expect(
      await owner.sku.count({
        where: { id: { in: [fixture.skuId, fixture.skuImportId] }, storeId: BEAUTY_STORE_ID },
      }),
    ).toBe(2);
  });

  it('validates and atomically applies an idempotent initial CSV import', async () => {
    const operationKey = `import:${randomUUID()}`;
    const file = Buffer.from(
      `warehouse_code,sku_code,quantity,note\nlocal-default,${importSkuCode},7,Initial approved load\n`,
    );
    const invalidBatch = Buffer.from(
      `warehouse_code,sku_code,quantity,note\nlocal-default,${importSkuCode},7,Valid row\nlocal-default,missing-${suffix},3,Invalid row\n`,
    );
    await request(app.getHttpServer() as Server)
      .post(`/v1/admin/inventory/imports?store_id=${BEAUTY_STORE_ID}&dry_run=false`)
      .set({ ...headers(), 'Idempotency-Key': `invalid:${randomUUID()}` })
      .field('confirmation_code', 'IMPORT')
      .attach('file', invalidBatch, { contentType: 'text/csv', filename: 'inventory.csv' })
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ error_count: 1, success_count: 1 }));
    expect(
      await owner.inventoryBalance.count({
        where: { skuId: fixture.skuImportId, storeId: BEAUTY_STORE_ID },
      }),
    ).toBe(0);

    await request(app.getHttpServer() as Server)
      .post(`/v1/admin/inventory/imports?store_id=${BEAUTY_STORE_ID}&dry_run=true`)
      .set({ ...headers(), 'Idempotency-Key': operationKey })
      .attach('file', file, { contentType: 'text/csv', filename: 'inventory.csv' })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({ dry_run: true, error_count: 0, success_count: 1 });
        expect(body.rows).toEqual([{ code: null, row: 2, status: 'VALID' }]);
      });

    const applied = await request(app.getHttpServer() as Server)
      .post(`/v1/admin/inventory/imports?store_id=${BEAUTY_STORE_ID}&dry_run=false`)
      .set({ ...headers(), 'Idempotency-Key': operationKey })
      .field('confirmation_code', 'IMPORT')
      .attach('file', file, { contentType: 'text/csv', filename: 'inventory.csv' })
      .expect(200);
    expect(applied.headers['idempotency-replayed']).toBe('false');
    expect(applied.body).toMatchObject({ dry_run: false, error_count: 0, success_count: 1 });

    const replay = await request(app.getHttpServer() as Server)
      .post(`/v1/admin/inventory/imports?store_id=${BEAUTY_STORE_ID}&dry_run=false`)
      .set({ ...headers(), 'Idempotency-Key': operationKey })
      .field('confirmation_code', 'IMPORT')
      .attach('file', file, { contentType: 'text/csv', filename: 'inventory.csv' })
      .expect(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.body.operation_id).toBe(applied.body.operation_id);
    expect(
      await owner.inventoryBalance.findUniqueOrThrow({
        where: {
          storeId_warehouseId_skuId: {
            skuId: fixture.skuImportId,
            storeId: BEAUTY_STORE_ID,
            warehouseId: BEAUTY_WAREHOUSE_ID,
          },
        },
      }),
    ).toMatchObject({ available: 7, onHand: 7, reserved: 0, version: 2 });
  });

  it('prevents concurrent oversell and makes terminal reservation operations idempotent', async () => {
    const attempts = await Promise.allSettled(
      [randomUUID(), randomUUID()].map((key) =>
        reserveInventory(runtime, context(), {
          expiresAt: new Date(Date.now() + 60_000),
          items: [{ quantity: 4, skuId: fixture.skuId, warehouseId: BEAUTY_WAREHOUSE_ID }],
          operationKey: `reserve:${key}`,
          sourceId: fixture.productId,
          sourceType: 'M3_TEST',
        }),
      ),
    );
    const fulfilled = attempts.filter((item) => item.status === 'fulfilled');
    const rejected = attempts.filter((item) => item.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toEqual(
      expect.objectContaining({ code: 'AVAILABLE_INSUFFICIENT' }),
    );
    const successful = (
      fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof reserveInventory>>>
    ).value;
    expect(
      await owner.inventoryBalance.findUniqueOrThrow({ where: { id: fixture.balanceId } }),
    ).toMatchObject({ available: 1, onHand: 5, reserved: 4 });

    const releaseKey = `release:${randomUUID()}`;
    const released = await releaseReservation(
      runtime,
      context(),
      successful.result.reservation_id,
      releaseKey,
    );
    const replayed = await releaseReservation(
      runtime,
      context(),
      successful.result.reservation_id,
      releaseKey,
    );
    expect(released).toMatchObject({ replayed: false, result: { status: 'RELEASED' } });
    expect(replayed).toMatchObject({ replayed: true, result: { status: 'RELEASED' } });
    await expect(
      consumeReservation(
        runtime,
        context(),
        successful.result.reservation_id,
        `consume:${randomUUID()}`,
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<InventoryPrimitiveError>>({
        code: 'RESERVATION_TRANSITION_INVALID',
      }),
    );
  });

  it('expires due reservations from database facts without duplicating release movements', async () => {
    const reserved = await reserveInventory(runtime, context(), {
      expiresAt: new Date(Date.now() + 80),
      items: [{ quantity: 2, skuId: fixture.skuId, warehouseId: BEAUTY_WAREHOUSE_ID }],
      operationKey: `reserve:${randomUUID()}`,
      sourceId: fixture.productId,
      sourceType: 'M3_TEST',
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const worker = new InventoryExpirationService(runtime, config);
    await worker.runOnce();
    await worker.runOnce();
    expect(
      await owner.inventoryReservation.findUniqueOrThrow({
        where: { id: reserved.result.reservation_id },
      }),
    ).toMatchObject({ status: 'EXPIRED' });
    expect(
      await owner.inventoryMovement.count({
        where: {
          movementType: 'RELEASE',
          reservationItem: { reservationId: reserved.result.reservation_id },
        },
      }),
    ).toBe(1);
  });

  it('enforces the inventory adjustment permission', async () => {
    await owner.storeRolePermission.deleteMany({
      where: { permissionCode: 'store.inventory.adjust', roleId: fixture.roleId },
    });
    try {
      await request(app.getHttpServer() as Server)
        .post(`/v1/admin/inventory/adjustments?store_id=${BEAUTY_STORE_ID}`)
        .set({ ...headers(), 'Idempotency-Key': `denied:${randomUUID()}` })
        .send({
          confirmation_code: 'ADJUST',
          delta: 1,
          expected_version: 4,
          reason_code: 'CYCLE_COUNT',
          sku_id: fixture.skuId,
          warehouse_id: BEAUTY_WAREHOUSE_ID,
        })
        .expect(403);
    } finally {
      await owner.storeRole.update({
        data: { permissions: { create: { permissionCode: 'store.inventory.adjust' } } },
        where: { id: fixture.roleId },
      });
    }
  });
});
