import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { config as loadEnvironment } from 'dotenv';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseRuntimeConfig } from '@zalo-shop/config';
import { cartSchema } from '@zalo-shop/contracts';
import { adjustInventory, createRuntimePrismaClient, PrismaClient } from '@zalo-shop/database';
import { createStoreContext } from '@zalo-shop/domain';
import { hashSensitive, signJwt } from '@zalo-shop/security';

const BEAUTY_STORE_ID = '10000000-0000-4000-8000-000000000001';
const BEAUTY_CATEGORY_ID = '12000000-0000-4000-8000-000000000001';
const BEAUTY_TEMPLATE_ID = '14000000-0000-4000-8000-000000000001';
const BEAUTY_WAREHOUSE_ID = '17000000-0000-4000-8000-000000000001';

describe('M3.6 member cart API', () => {
  loadEnvironment({ path: '.env.test.example', quiet: true, override: true });
  const config = parseRuntimeConfig();
  const owner = new PrismaClient({ datasourceUrl: config.DATABASE_URL });
  const runtime = createRuntimePrismaClient(config.DATABASE_RUNTIME_URL);
  const suffix = randomUUID().slice(0, 8);
  const fixture = {
    balanceIds: [randomUUID(), randomUUID()],
    brandId: randomUUID(),
    memberIds: [randomUUID(), randomUUID()],
    productId: randomUUID(),
    skuIds: [randomUUID(), randomUUID()],
  };
  const skuCodes = [`m36-cart-${suffix}`, `m36-cart-alt-${suffix}`];
  const memberTokens: string[] = [];
  let app: INestApplication;

  const api = () => request(app.getHttpServer() as Server);
  const headers = (member = 0, storeCode = 'beauty-local') => ({
    Authorization: `Bearer ${memberTokens[member]}`,
    'X-Store-Code': storeCode,
  });

  beforeAll(async () => {
    await Promise.all([owner.$connect(), runtime.$connect()]);
    await owner.brand.create({
      data: { code: `m36-brand-${suffix}`, id: fixture.brandId, storeId: BEAUTY_STORE_ID },
    });
    await owner.product.create({
      data: {
        attributeTemplateVersionId: BEAUTY_TEMPLATE_ID,
        brandId: fixture.brandId,
        code: `m36-product-${suffix}`,
        id: fixture.productId,
        mainCategoryId: BEAUTY_CATEGORY_ID,
        publishedAt: new Date(),
        status: 'PUBLISHED',
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.productLocalization.createMany({
      data: [
        {
          locale: 'vi',
          name: `San pham gio hang ${suffix}`,
          productId: fixture.productId,
          storeId: BEAUTY_STORE_ID,
        },
        {
          locale: 'en',
          name: `Cart product ${suffix}`,
          productId: fixture.productId,
          storeId: BEAUTY_STORE_ID,
        },
        {
          locale: 'zh',
          name: `购物车商品 ${suffix}`,
          productId: fixture.productId,
          storeId: BEAUTY_STORE_ID,
        },
      ],
    });
    await owner.sku.createMany({
      data: skuCodes.map((code, index) => ({
        code,
        id: fixture.skuIds[index]!,
        optionCombinationHash: `${index + 7}`.repeat(64),
        optionCombinationKey: `m36=${index}`,
        productId: fixture.productId,
        salePriceVnd: index === 0 ? 100_000 : 80_000,
        storeId: BEAUTY_STORE_ID,
      })),
    });
    await owner.inventoryBalance.createMany({
      data: fixture.skuIds.map((skuId, index) => ({
        id: fixture.balanceIds[index]!,
        skuId,
        storeId: BEAUTY_STORE_ID,
        warehouseId: BEAUTY_WAREHOUSE_ID,
      })),
    });
    await adjustInventory(
      runtime,
      createStoreContext({
        actor: { id: fixture.memberIds[0]!, type: 'member' },
        correlationId: randomUUID(),
        locale: 'vi',
        storeCode: 'beauty-local',
        storeId: BEAUTY_STORE_ID,
      }),
      {
        items: fixture.skuIds.map((skuId) => ({
          delta: 5,
          expectedVersion: 1,
          reasonCode: 'M36_TEST_INITIAL_STOCK',
          skuId,
          warehouseId: BEAUTY_WAREHOUSE_ID,
        })),
        operationKey: `m36-cart-stock-${suffix}`,
        operationType: 'IMPORT',
      },
    );
    for (const memberId of fixture.memberIds) {
      await owner.member.create({ data: { id: memberId, storeId: BEAUTY_STORE_ID } });
      const session = await owner.memberSession.create({
        data: {
          expiresAt: new Date(Date.now() + 3_600_000),
          memberId,
          refreshTokenHash: hashSensitive(randomUUID(), config.PII_HASH_KEY),
          storeId: BEAUTY_STORE_ID,
          tokenFamilyId: randomUUID(),
        },
      });
      const now = Math.floor(Date.now() / 1_000);
      memberTokens.push(
        signJwt(
          {
            actor_type: 'member',
            aud: config.AUTH_JWT_AUDIENCE,
            exp: now + 900,
            iat: now,
            iss: config.AUTH_JWT_ISSUER,
            jti: randomUUID(),
            session_id: session.id,
            store_id: BEAUTY_STORE_ID,
            sub: memberId,
          },
          config.AUTH_JWT_SECRET,
        ),
      );
    }
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
      // Scope cleanup to this test's members.  Deleting every cart in the
      // store can remove another fixture's persistent cart when the
      // integration suite is run repeatedly or in parallel.
      const fixtureCarts = await transaction.cart.findMany({
        select: { id: true },
        where: { memberId: { in: fixture.memberIds }, storeId: BEAUTY_STORE_ID },
      });
      const fixtureCartIds = fixtureCarts.map(({ id }) => id);
      if (fixtureCartIds.length > 0) {
        await transaction.cartItem.deleteMany({
          where: { cartId: { in: fixtureCartIds }, storeId: BEAUTY_STORE_ID },
        });
        await transaction.cart.deleteMany({
          where: { id: { in: fixtureCartIds }, storeId: BEAUTY_STORE_ID },
        });
      }
      await transaction.inventoryMovement.deleteMany({
        where: { balanceId: { in: fixture.balanceIds } },
      });
      await transaction.inventoryOperation.deleteMany({
        where: {
          operationKey: {
            in: [`m36-cart-stock-${suffix}`, `m36-cart-stock-out-${suffix}`],
          },
          storeId: BEAUTY_STORE_ID,
        },
      });
      await transaction.inventoryBalance.deleteMany({ where: { id: { in: fixture.balanceIds } } });
      await transaction.sku.deleteMany({ where: { id: { in: fixture.skuIds } } });
      await transaction.productLocalization.deleteMany({ where: { productId: fixture.productId } });
      await transaction.product.deleteMany({ where: { id: fixture.productId } });
      await transaction.brand.deleteMany({ where: { id: fixture.brandId } });
      await transaction.memberSession.deleteMany({
        where: { memberId: { in: fixture.memberIds } },
      });
      await transaction.member.deleteMany({ where: { id: { in: fixture.memberIds } } });
    });
    await Promise.all([runtime.$disconnect(), owner.$disconnect()]);
  });

  it('keeps carts isolated and PUT quantity idempotent', async () => {
    const empty = await api().get('/v1/cart').set(headers()).expect(200);
    expect(empty.body).toMatchObject({ blocking: false, items: [], quote: null, version: 1 });
    const first = await api()
      .put(`/v1/cart/items/by-sku/${skuCodes[0]}?locale=en`)
      .set(headers())
      .send({ quantity: 2 })
      .expect(200);
    expect(cartSchema.safeParse(first.body).success).toBe(true);
    const item = first.body.items[0];
    expect(item).toMatchObject({ quantity: 2, selected: true, sku_code: skuCodes[0] });
    expect(item.product).toMatchObject({
      name: `Cart product ${suffix}`,
      requested_locale: 'en',
      resolved_locale: 'en',
    });
    expect(first.body.quote).toMatchObject({ currency: 'VND' });
    const replay = await api()
      .put(`/v1/cart/items/by-sku/${skuCodes[0]}?locale=en`)
      .set(headers())
      .send({ quantity: 2 })
      .expect(200);
    expect(replay.body.id).toBe(first.body.id);
    expect(replay.body.version).toBe(first.body.version);
    expect(replay.body.items).toEqual(first.body.items);
    const chinese = await api().get('/v1/cart?locale=zh').set(headers()).expect(200);
    expect(chinese.body.items[0].product).toMatchObject({
      name: `购物车商品 ${suffix}`,
      requested_locale: 'zh',
      resolved_locale: 'zh',
    });
    const concurrent = await Promise.all([
      api().put(`/v1/cart/items/by-sku/${skuCodes[1]}`).set(headers(1)).send({ quantity: 1 }),
      api().put(`/v1/cart/items/by-sku/${skuCodes[1]}`).set(headers(1)).send({ quantity: 2 }),
    ]);
    expect(concurrent.map(({ status }) => status).sort()).toEqual([200, 200]);
    const other = await api().get('/v1/cart').set(headers(1)).expect(200);
    expect(other.body.items).toHaveLength(1);
    expect([1, 2]).toContain(other.body.items[0].quantity);
    await api()
      .patch(`/v1/cart/items/${item.id}`)
      .set(headers(1))
      .send({ expected_version: item.version, quantity: 3 })
      .expect(404);
    const otherItem = other.body.items[0];
    await api()
      .delete(`/v1/cart/items/${otherItem.id}?expected_version=${otherItem.version}`)
      .set(headers(1))
      .expect(204);
    await api()
      .get('/v1/cart')
      .set(headers(1))
      .expect(200)
      .expect(({ body }) => {
        expect(body.items).toEqual([]);
      });
  });

  it('enforces optimistic versions and reports stock, publication and price changes', async () => {
    const current = await api().get('/v1/cart').set(headers()).expect(200);
    const item = current.body.items[0];
    await api()
      .patch(`/v1/cart/items/${item.id}`)
      .set(headers())
      .send({ expected_version: item.version, quantity: 3 })
      .expect(200);
    await api()
      .patch(`/v1/cart/items/${item.id}`)
      .set(headers())
      .send({ expected_version: item.version, quantity: 4 })
      .expect(409)
      .expect(({ body }) => expect(body.details).toEqual({ reason_code: 'VERSION_CONFLICT' }));

    await adjustInventory(
      runtime,
      createStoreContext({
        actor: { id: fixture.memberIds[0]!, type: 'member' },
        correlationId: randomUUID(),
        locale: 'vi',
        storeCode: 'beauty-local',
        storeId: BEAUTY_STORE_ID,
      }),
      {
        items: [
          {
            delta: -5,
            expectedVersion: 2,
            reasonCode: 'M36_TEST_STOCK_OUT',
            skuId: fixture.skuIds[0]!,
            warehouseId: BEAUTY_WAREHOUSE_ID,
          },
        ],
        operationKey: `m36-cart-stock-out-${suffix}`,
      },
    );
    const out = await api().get('/v1/cart').set(headers()).expect(200);
    expect(out.body).toMatchObject({ blocking: true, quote: null });
    expect(out.body.items[0].issues).toEqual(
      expect.arrayContaining([{ blocking: true, code: 'OUT_OF_STOCK' }]),
    );

    await owner.sku.update({
      data: { salePriceVnd: 125_000 },
      where: { id: fixture.skuIds[0] },
    });
    await owner.product.update({ data: { status: 'DRAFT' }, where: { id: fixture.productId } });
    const unavailable = await api().get('/v1/cart').set(headers()).expect(200);
    expect(unavailable.body.items[0].issues).toEqual(
      expect.arrayContaining([{ blocking: true, code: 'PRODUCT_UNAVAILABLE' }]),
    );
    expect(unavailable.body.items[0].current_unit_price_vnd).toBe(125_000);
    expect(unavailable.body.items[0].issues).toEqual(
      expect.arrayContaining([{ blocking: false, code: 'PRICE_CHANGED' }]),
    );
    await owner.cartItem.update({
      data: { addedPromotionFingerprint: 'f'.repeat(64) },
      where: { id: item.id },
    });
    const promotionChanged = await api().get('/v1/cart').set(headers()).expect(200);
    expect(promotionChanged.body.items[0].issues).toEqual(
      expect.arrayContaining([{ blocking: false, code: 'PROMOTION_CHANGED' }]),
    );
  });

  it('rejects a token used with another store header', async () => {
    await api().get('/v1/cart').set(headers(0, 'fashion-local')).expect(401);
    await api()
      .put(`/v1/cart/items/by-sku/${skuCodes[0]}`)
      .set(headers(0, 'fashion-local'))
      .send({ quantity: 1 })
      .expect(401);
  });
});
