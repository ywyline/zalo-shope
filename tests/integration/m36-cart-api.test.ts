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
const FASHION_STORE_ID = '10000000-0000-4000-8000-000000000002';
const FASHION_CATEGORY_ID = '12000000-0000-4000-8000-000000000002';
const FASHION_TEMPLATE_ID = '14000000-0000-4000-8000-000000000002';
const FASHION_WAREHOUSE_ID = '17000000-0000-4000-8000-000000000002';

function assertSanitizedError(response: { body: unknown }, secrets: readonly string[]) {
  const serialized = JSON.stringify(response.body);
  for (const secret of secrets) expect(serialized).not.toContain(secret);
  expect(serialized).not.toMatch(/\b(?:select|insert|update|delete|prisma|sqlstate|postgres)\b/i);
}

describe('M3.6 member cart API', () => {
  loadEnvironment({ path: '.env.test.example', quiet: true, override: true });
  const config = parseRuntimeConfig();
  const owner = new PrismaClient({ datasourceUrl: config.DATABASE_URL });
  const runtime = createRuntimePrismaClient(config.DATABASE_RUNTIME_URL);
  const suffix = randomUUID().slice(0, 8);
  const fixture = {
    balanceIds: [randomUUID(), randomUUID()],
    brandId: randomUUID(),
    fashionBalanceId: randomUUID(),
    fashionBrandId: randomUUID(),
    fashionMemberId: randomUUID(),
    fashionProductId: randomUUID(),
    fashionSkuId: randomUUID(),
    memberIds: [randomUUID(), randomUUID()],
    productId: randomUUID(),
    skuIds: [randomUUID(), randomUUID()],
  };
  const skuCodes = [`m36-cart-${suffix}`, `m36-cart-alt-${suffix}`];
  const fashionSkuCode = `m36-fashion-cart-${suffix}`;
  const memberTokens: string[] = [];
  let fashionToken: string;
  let app: INestApplication;

  const api = () => request(app.getHttpServer() as Server);
  const headers = (member = 0, storeCode = 'beauty-local') => ({
    Authorization: `Bearer ${memberTokens[member]}`,
    'X-Store-Code': storeCode,
  });
  const fashionHeaders = () => ({
    Authorization: `Bearer ${fashionToken}`,
    'X-Store-Code': 'fashion-local',
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
    await owner.brand.create({
      data: {
        code: `m36-fashion-brand-${suffix}`,
        id: fixture.fashionBrandId,
        storeId: FASHION_STORE_ID,
      },
    });
    await owner.product.create({
      data: {
        attributeTemplateVersionId: FASHION_TEMPLATE_ID,
        brandId: fixture.fashionBrandId,
        code: `m36-fashion-product-${suffix}`,
        id: fixture.fashionProductId,
        mainCategoryId: FASHION_CATEGORY_ID,
        publishedAt: new Date(),
        status: 'PUBLISHED',
        storeId: FASHION_STORE_ID,
      },
    });
    await owner.productLocalization.createMany({
      data: [
        {
          locale: 'vi',
          name: `San pham thoi trang ${suffix}`,
          productId: fixture.fashionProductId,
          storeId: FASHION_STORE_ID,
        },
        {
          locale: 'en',
          name: `Fashion cart product ${suffix}`,
          productId: fixture.fashionProductId,
          storeId: FASHION_STORE_ID,
        },
        {
          locale: 'zh',
          name: `服装购物车商品 ${suffix}`,
          productId: fixture.fashionProductId,
          storeId: FASHION_STORE_ID,
        },
      ],
    });
    await owner.sku.create({
      data: {
        code: fashionSkuCode,
        id: fixture.fashionSkuId,
        optionCombinationHash: '9'.repeat(64),
        optionCombinationKey: 'm36-fashion=0',
        productId: fixture.fashionProductId,
        salePriceVnd: 210_000,
        storeId: FASHION_STORE_ID,
      },
    });
    await owner.inventoryBalance.create({
      data: {
        id: fixture.fashionBalanceId,
        skuId: fixture.fashionSkuId,
        storeId: FASHION_STORE_ID,
        warehouseId: FASHION_WAREHOUSE_ID,
      },
    });
    await adjustInventory(
      runtime,
      createStoreContext({
        actor: { id: fixture.fashionMemberId, type: 'member' },
        correlationId: randomUUID(),
        locale: 'vi',
        storeCode: 'fashion-local',
        storeId: FASHION_STORE_ID,
      }),
      {
        items: [
          {
            delta: 5,
            expectedVersion: 1,
            reasonCode: 'M36_TEST_INITIAL_STOCK',
            skuId: fixture.fashionSkuId,
            warehouseId: FASHION_WAREHOUSE_ID,
          },
        ],
        operationKey: `m36-fashion-cart-stock-${suffix}`,
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
    await owner.member.create({
      data: { id: fixture.fashionMemberId, storeId: FASHION_STORE_ID },
    });
    const fashionSession = await owner.memberSession.create({
      data: {
        expiresAt: new Date(Date.now() + 3_600_000),
        memberId: fixture.fashionMemberId,
        refreshTokenHash: hashSensitive(randomUUID(), config.PII_HASH_KEY),
        storeId: FASHION_STORE_ID,
        tokenFamilyId: randomUUID(),
      },
    });
    const fashionNow = Math.floor(Date.now() / 1_000);
    fashionToken = signJwt(
      {
        actor_type: 'member',
        aud: config.AUTH_JWT_AUDIENCE,
        exp: fashionNow + 900,
        iat: fashionNow,
        iss: config.AUTH_JWT_ISSUER,
        jti: randomUUID(),
        session_id: fashionSession.id,
        store_id: FASHION_STORE_ID,
        sub: fixture.fashionMemberId,
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
    await owner.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      // Scope cleanup to this test's members.  Deleting every cart in the
      // store can remove another fixture's persistent cart when the
      // integration suite is run repeatedly or in parallel.
      const fixtureCarts = await transaction.cart.findMany({
        select: { id: true },
        where: { memberId: { in: fixture.memberIds }, storeId: BEAUTY_STORE_ID },
      });
      const fashionCarts = await transaction.cart.findMany({
        select: { id: true },
        where: { memberId: fixture.fashionMemberId, storeId: FASHION_STORE_ID },
      });
      const fixtureCartIds = [...fixtureCarts, ...fashionCarts].map(({ id }) => id);
      if (fixtureCartIds.length > 0) {
        await transaction.cartItem.deleteMany({
          where: {
            cartId: { in: fixtureCartIds },
            storeId: { in: [BEAUTY_STORE_ID, FASHION_STORE_ID] },
          },
        });
        await transaction.cart.deleteMany({
          where: {
            id: { in: fixtureCartIds },
            storeId: { in: [BEAUTY_STORE_ID, FASHION_STORE_ID] },
          },
        });
      }
      await transaction.inventoryMovement.deleteMany({
        where: { balanceId: { in: [...fixture.balanceIds, fixture.fashionBalanceId] } },
      });
      await transaction.inventoryOperation.deleteMany({
        where: {
          operationKey: {
            in: [
              `m36-cart-stock-${suffix}`,
              `m36-cart-stock-out-${suffix}`,
              `m36-fashion-cart-stock-${suffix}`,
            ],
          },
          storeId: { in: [BEAUTY_STORE_ID, FASHION_STORE_ID] },
        },
      });
      await transaction.inventoryBalance.deleteMany({
        where: { id: { in: [...fixture.balanceIds, fixture.fashionBalanceId] } },
      });
      await transaction.sku.deleteMany({
        where: { id: { in: [...fixture.skuIds, fixture.fashionSkuId] } },
      });
      await transaction.productLocalization.deleteMany({
        where: { productId: { in: [fixture.productId, fixture.fashionProductId] } },
      });
      await transaction.product.deleteMany({
        where: { id: { in: [fixture.productId, fixture.fashionProductId] } },
      });
      await transaction.brand.deleteMany({
        where: { id: { in: [fixture.brandId, fixture.fashionBrandId] } },
      });
      await transaction.memberSession.deleteMany({
        where: { memberId: { in: [...fixture.memberIds, fixture.fashionMemberId] } },
      });
      await transaction.member.deleteMany({
        where: { id: { in: [...fixture.memberIds, fixture.fashionMemberId] } },
      });
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
    const otherItem = other.body.items[0];
    const concurrentPatch = await Promise.all([
      api()
        .patch(`/v1/cart/items/${otherItem.id}`)
        .set(headers(1))
        .send({ expected_version: otherItem.version, quantity: 3 }),
      api()
        .patch(`/v1/cart/items/${otherItem.id}`)
        .set(headers(1))
        .send({ expected_version: otherItem.version, quantity: 4 }),
    ]);
    expect(concurrentPatch.map(({ status }) => status).sort()).toEqual([200, 409]);
    const patchConflict = concurrentPatch.find(({ status }) => status === 409);
    expect(patchConflict?.body).toMatchObject({
      code: 'CONFLICT',
      details: { reason_code: 'VERSION_CONFLICT' },
    });
    const afterConcurrentPatch = await api().get('/v1/cart').set(headers(1)).expect(200);
    expect(afterConcurrentPatch.body.items[0]).toMatchObject({
      quantity: expect.any(Number),
      version: otherItem.version + 1,
    });
    expect([3, 4]).toContain(afterConcurrentPatch.body.items[0].quantity);
    await api()
      .patch(`/v1/cart/items/${item.id}`)
      .set(headers(1))
      .send({ expected_version: item.version, quantity: 3 })
      .expect(404);
    await api()
      .delete(
        `/v1/cart/items/${otherItem.id}?expected_version=${afterConcurrentPatch.body.items[0].version}`,
      )
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

  it('excludes unselected lines from the server quote', async () => {
    const selected = await api()
      .put(`/v1/cart/items/by-sku/${skuCodes[0]}`)
      .set(headers(1))
      .send({ quantity: 1 })
      .expect(200);
    const unselected = await api()
      .put(`/v1/cart/items/by-sku/${skuCodes[1]}`)
      .set(headers(1))
      .send({ quantity: 2, selected: false })
      .expect(200);
    const cart = await api().get('/v1/cart').set(headers(1)).expect(200);
    expect(cart.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sku_code: skuCodes[0], selected: true }),
        expect.objectContaining({ sku_code: skuCodes[1], selected: false }),
      ]),
    );
    expect(cart.body.quote).toMatchObject({
      base_subtotal_vnd: 100_000,
    });
    expect(cart.body.quote.lines).toHaveLength(1);
    expect(cart.body.quote.lines[0]).toMatchObject({
      base_subtotal_vnd: 100_000,
      quantity: 1,
      sku_code: skuCodes[0],
    });
    expect(cart.body.quote.merchandise_payable_vnd).toBeLessThanOrEqual(100_000);
    expect(cart.body.quote.lines.map((line: { sku_code: string }) => line.sku_code)).toEqual([
      skuCodes[0],
    ]);

    const selectedItem = selected.body.items.find(
      (item: { sku_code: string }) => item.sku_code === skuCodes[0],
    );
    const unselectedItem = unselected.body.items.find(
      (item: { sku_code: string }) => item.sku_code === skuCodes[1],
    );
    await api()
      .delete(`/v1/cart/items/${selectedItem.id}?expected_version=${selectedItem.version}`)
      .set(headers(1))
      .expect(204);
    await api()
      .delete(`/v1/cart/items/${unselectedItem.id}?expected_version=${unselectedItem.version}`)
      .set(headers(1))
      .expect(204);
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

  it('rejects reused and cross-store tokens and hides cart resource existence', async () => {
    const beautyToken = memberTokens[0]!;
    const fashionItemResponse = await api()
      .put(`/v1/cart/items/by-sku/${fashionSkuCode}`)
      .set(fashionHeaders())
      .send({ quantity: 1 })
      .expect(200);
    const fashionItem = fashionItemResponse.body.items.find(
      (item: { sku_code: string }) => item.sku_code === fashionSkuCode,
    );
    expect(fashionItem).toBeDefined();

    const reused = await Promise.all([
      api().get('/v1/cart').set(headers(0)),
      api().get('/v1/cart').set(headers(0)),
    ]);
    expect(reused.map(({ status }) => status)).toEqual([200, 200]);
    for (const response of reused) {
      assertSanitizedError(response, [beautyToken, '+84901234567']);
    }

    const mismatchedStore = await api()
      .get('/v1/cart')
      .set(headers(0, 'fashion-local'))
      .expect(401);
    assertSanitizedError(mismatchedStore, [beautyToken, fashionSkuCode, fashionItem.id]);

    const repeatedMismatchedStore = await api()
      .get('/v1/cart')
      .set(headers(0, 'fashion-local'))
      .expect(401);
    assertSanitizedError(repeatedMismatchedStore, [beautyToken, fashionSkuCode, fashionItem.id]);

    const reverseMismatchedStore = await api()
      .get('/v1/cart')
      .set(fashionHeaders())
      .set('X-Store-Code', 'beauty-local')
      .expect(401);
    assertSanitizedError(reverseMismatchedStore, [fashionToken, beautyToken]);

    const duplicateBearer = await api()
      .get('/v1/cart')
      .set({
        Authorization: `Bearer ${beautyToken} ${beautyToken}`,
        'X-Store-Code': 'beauty-local',
      })
      .expect(401);
    assertSanitizedError(duplicateBearer, [beautyToken, '+84901234567']);

    const crossStoreSku = await api()
      .put(`/v1/cart/items/by-sku/${fashionSkuCode}`)
      .set(headers())
      .send({ quantity: 1 })
      .expect(404);
    assertSanitizedError(crossStoreSku, [beautyToken, fashionSkuCode, '+84901234567']);

    const crossStoreItem = await api()
      .patch(`/v1/cart/items/${fashionItem.id}`)
      .set(headers())
      .send({ expected_version: fashionItem.version, quantity: 2 })
      .expect(404);
    assertSanitizedError(crossStoreItem, [beautyToken, fashionSkuCode, fashionItem.id]);

    const [beautyAfterCrossStore, fashionAfterCrossStore] = await Promise.all([
      api().get('/v1/cart').set(headers()).expect(200),
      api().get('/v1/cart').set(fashionHeaders()).expect(200),
    ]);
    expect(
      beautyAfterCrossStore.body.items.some(
        (item: { sku_code: string }) => item.sku_code === fashionSkuCode,
      ),
    ).toBe(false);
    expect(
      fashionAfterCrossStore.body.items.find((item: { id: string }) => item.id === fashionItem.id),
    ).toMatchObject({ quantity: fashionItem.quantity, version: fashionItem.version });

    const sensitiveInput = await api()
      .put(`/v1/cart/items/by-sku/${skuCodes[0]}`)
      .set(headers())
      .send({ phone: '+84901234567', quantity: 1 })
      .expect(400);
    assertSanitizedError(sensitiveInput, [beautyToken, '+84901234567']);
  });
});
