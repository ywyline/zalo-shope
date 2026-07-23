import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { config as loadEnvironment } from 'dotenv';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseRuntimeConfig } from '@zalo-shop/config';
import {
  adjustInventory,
  createRuntimePrismaClient,
  expireDueReservations,
  PrismaClient,
  reconcileReservationBackedOrders,
  withStoreTransaction,
} from '@zalo-shop/database';
import { createStoreContext } from '@zalo-shop/domain';
import { hashSensitive, signJwt } from '@zalo-shop/security';

const BEAUTY_STORE_ID = '10000000-0000-4000-8000-000000000001';
const FASHION_STORE_ID = '10000000-0000-4000-8000-000000000002';
const BEAUTY_CATEGORY_ID = '12000000-0000-4000-8000-000000000001';
const BEAUTY_TEMPLATE_ID = '14000000-0000-4000-8000-000000000001';
const BEAUTY_WAREHOUSE_ID = '17000000-0000-4000-8000-000000000001';

describe('M4 address, checkout and COD orders', () => {
  loadEnvironment({ path: '.env.test.example', quiet: true, override: true });
  const config = parseRuntimeConfig();
  const owner = new PrismaClient({ datasourceUrl: config.DATABASE_URL });
  const runtime = createRuntimePrismaClient(config.DATABASE_RUNTIME_URL);
  const suffix = randomUUID().slice(0, 8);
  const fixture = {
    adminId: randomUUID(),
    balanceId: randomUUID(),
    brandId: randomUUID(),
    memberId: randomUUID(),
    secondMemberId: randomUUID(),
    productId: randomUUID(),
    roleId: randomUUID(),
    skuId: randomUUID(),
  };
  const skuCode = `m4-checkout-${suffix}`;
  let memberToken: string;
  let secondMemberToken: string;
  let adminToken: string;
  let app: INestApplication;
  const api = () => request(app.getHttpServer() as Server);
  const memberHeaders = (token = memberToken) => ({
    Authorization: `Bearer ${token}`,
    'X-Store-Code': 'beauty-local',
  });
  const adminHeaders = () => ({
    Authorization: `Bearer ${adminToken}`,
    'X-Store-Code': 'beauty-local',
  });

  async function quoteAndCreateOrder(input: {
    addressId: string;
    idempotencyKey: string;
    quantity?: number;
    token?: string;
  }) {
    const token = input.token ?? memberToken;
    const quantity = input.quantity ?? 1;
    const body = {
      address_id: input.addressId,
      coupon_code: null,
      items: [{ quantity, sku_code: skuCode }],
      locale: 'vi',
      payment_method: 'COD',
    } as const;
    const quote = await api().post('/v1/checkout/quote').set(memberHeaders(token)).send(body);
    expect(quote.status).toBe(201);
    return api()
      .post('/v1/checkout/orders')
      .set({ ...memberHeaders(token), 'Idempotency-Key': input.idempotencyKey })
      .send({ ...body, quote_hash: quote.body.quote_hash });
  }

  async function createClaimedCoupon(input: {
    code: string;
    newCustomerOnly: boolean;
    token?: string;
  }): Promise<{ couponId: string; promotionId: string }> {
    const storeQuery = `store_id=${BEAUTY_STORE_ID}`;
    const promotion = await api()
      .post(`/v1/admin/promotions?${storeQuery}`)
      .set(adminHeaders())
      .send({ code: `${input.code}-rule` });
    expect(promotion.status).toBe(201);
    const version = await api()
      .post(`/v1/admin/promotions/${promotion.body.id}/versions?${storeQuery}`)
      .set(adminHeaders())
      .send({
        benefit: { method: 'FIXED_VND', value: 5_000 },
        bucket: 'COUPON',
        ends_at: null,
        expected_promotion_version: promotion.body.version,
        localizations: [
          { description: 'M4 coupon', locale: 'vi', name: 'Mã giảm giá M4' },
          { description: 'M4 优惠券', locale: 'zh', name: 'M4 优惠券' },
          { description: 'M4 coupon', locale: 'en', name: 'M4 coupon' },
        ],
        minimum_quantity: null,
        minimum_spend_vnd: null,
        priority: 10,
        stackable_with: [],
        starts_at: new Date(Date.now() - 60_000).toISOString(),
        targets: [{ target_id: null, target_type: 'STORE' }],
      });
    expect(version.status).toBe(201);
    const published = await api()
      .post(`/v1/admin/promotions/${promotion.body.id}/publish?${storeQuery}`)
      .set({ ...adminHeaders(), 'Idempotency-Key': `m4-publish-${input.code}` })
      .send({
        confirmation_code: 'PUBLISH',
        expected_promotion_version: promotion.body.version + 1,
        version_id: version.body.id,
      });
    expect(published.status).toBe(200);
    const coupon = await api().post(`/v1/admin/coupons?${storeQuery}`).set(adminHeaders()).send({
      code: input.code,
      new_customer_only: input.newCustomerOnly,
      per_member_claim_limit: 1,
      promotion_version_id: version.body.id,
      total_claim_limit: 10,
    });
    expect(coupon.status).toBe(201);
    const activated = await api()
      .post(`/v1/admin/coupons/${coupon.body.id}/status?${storeQuery}`)
      .set({ ...adminHeaders(), 'Idempotency-Key': `m4-activate-${input.code}` })
      .send({ confirmation_code: 'ACTIVATE', expected_version: 1, status: 'ACTIVE' });
    expect(activated.status).toBe(200);
    const claimed = await api()
      .put(`/v1/members/me/coupons/by-code/${input.code}`)
      .set(memberHeaders(input.token ?? memberToken));
    expect(claimed.status).toBe(200);
    return { couponId: coupon.body.id, promotionId: promotion.body.id };
  }

  beforeAll(async () => {
    await Promise.all([owner.$connect(), runtime.$connect()]);
    await owner.brand.create({
      data: { code: `m4-brand-${suffix}`, id: fixture.brandId, storeId: BEAUTY_STORE_ID },
    });
    await owner.product.create({
      data: {
        attributeTemplateVersionId: BEAUTY_TEMPLATE_ID,
        brandId: fixture.brandId,
        code: `m4-product-${suffix}`,
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
          name: `Sản phẩm M4 ${suffix}`,
          productId: fixture.productId,
          storeId: BEAUTY_STORE_ID,
        },
        {
          locale: 'en',
          name: `M4 product ${suffix}`,
          productId: fixture.productId,
          storeId: BEAUTY_STORE_ID,
        },
        {
          locale: 'zh',
          name: `M4 商品 ${suffix}`,
          productId: fixture.productId,
          storeId: BEAUTY_STORE_ID,
        },
      ],
    });
    await owner.sku.create({
      data: {
        code: skuCode,
        id: fixture.skuId,
        optionCombinationHash: 'a'.repeat(64),
        optionCombinationKey: `m4=${suffix}`,
        productId: fixture.productId,
        salePriceVnd: 120_000,
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.inventoryBalance.create({
      data: {
        id: fixture.balanceId,
        skuId: fixture.skuId,
        storeId: BEAUTY_STORE_ID,
        warehouseId: BEAUTY_WAREHOUSE_ID,
      },
    });
    await adjustInventory(
      runtime,
      createStoreContext({
        actor: { id: fixture.memberId, type: 'member' },
        correlationId: randomUUID(),
        locale: 'vi',
        storeCode: 'beauty-local',
        storeId: BEAUTY_STORE_ID,
      }),
      {
        items: [
          {
            delta: 50,
            expectedVersion: 1,
            reasonCode: 'M4_TEST_INITIAL_STOCK',
            skuId: fixture.skuId,
            warehouseId: BEAUTY_WAREHOUSE_ID,
          },
        ],
        operationKey: `m4-stock-${suffix}`,
        operationType: 'IMPORT',
      },
    );
    await owner.member.createMany({
      data: [
        { id: fixture.memberId, storeId: BEAUTY_STORE_ID },
        { id: fixture.secondMemberId, storeId: BEAUTY_STORE_ID },
      ],
    });
    const [memberSession, secondMemberSession] = await Promise.all([
      owner.memberSession.create({
        data: {
          expiresAt: new Date(Date.now() + 3_600_000),
          memberId: fixture.memberId,
          refreshTokenHash: hashSensitive(randomUUID(), config.PII_HASH_KEY),
          storeId: BEAUTY_STORE_ID,
          tokenFamilyId: randomUUID(),
        },
      }),
      owner.memberSession.create({
        data: {
          expiresAt: new Date(Date.now() + 3_600_000),
          memberId: fixture.secondMemberId,
          refreshTokenHash: hashSensitive(randomUUID(), config.PII_HASH_KEY),
          storeId: BEAUTY_STORE_ID,
          tokenFamilyId: randomUUID(),
        },
      }),
    ]);
    const now = Math.floor(Date.now() / 1_000);
    memberToken = signJwt(
      {
        actor_type: 'member',
        aud: config.AUTH_JWT_AUDIENCE,
        exp: now + 900,
        iat: now,
        iss: config.AUTH_JWT_ISSUER,
        jti: randomUUID(),
        session_id: memberSession.id,
        store_id: BEAUTY_STORE_ID,
        sub: fixture.memberId,
      },
      config.AUTH_JWT_SECRET,
    );
    secondMemberToken = signJwt(
      {
        actor_type: 'member',
        aud: config.AUTH_JWT_AUDIENCE,
        exp: now + 900,
        iat: now,
        iss: config.AUTH_JWT_ISSUER,
        jti: randomUUID(),
        session_id: secondMemberSession.id,
        store_id: BEAUTY_STORE_ID,
        sub: fixture.secondMemberId,
      },
      config.AUTH_JWT_SECRET,
    );

    await owner.adminUser.create({
      data: {
        displayName: 'M4 test admin',
        email: `m4-${suffix}@example.test`,
        emailNormalized: `m4-${suffix}@example.test`,
        id: fixture.adminId,
        passwordHash: 'test-fixture-not-used',
      },
    });
    await owner.storeRole.create({
      data: {
        code: `m4-orders-${suffix}`,
        id: fixture.roleId,
        name: 'M4 order operator',
        permissions: {
          create: [
            { permissionCode: 'store.delivery.manage' },
            { permissionCode: 'store.delivery.read' },
            { permissionCode: 'store.orders.read' },
            { permissionCode: 'store.orders.manage' },
            { permissionCode: 'store.promotions.manage' },
            { permissionCode: 'store.promotions.publish' },
            { permissionCode: 'store.promotions.read' },
          ],
        },
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.adminStoreRole.create({
      data: {
        adminUserId: fixture.adminId,
        grantedBy: fixture.adminId,
        roleId: fixture.roleId,
        storeId: BEAUTY_STORE_ID,
      },
    });
    const adminSession = await owner.adminSession.create({
      data: {
        adminUserId: fixture.adminId,
        expiresAt: new Date(Date.now() + 3_600_000),
        mfaVerifiedAt: new Date(),
        refreshTokenHash: hashSensitive(randomUUID(), config.PII_HASH_KEY),
        tokenFamilyId: randomUUID(),
      },
    });
    adminToken = signJwt(
      {
        actor_type: 'admin',
        aud: config.AUTH_JWT_AUDIENCE,
        exp: now + 900,
        iat: now,
        iss: config.AUTH_JWT_ISSUER,
        jti: randomUUID(),
        session_id: adminSession.id,
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
      const memberIds = [fixture.memberId, fixture.secondMemberId];
      const orders = await transaction.order.findMany({
        select: { id: true, reservationId: true },
        where: { memberId: { in: memberIds }, storeId: BEAUTY_STORE_ID },
      });
      const orderIds = orders.map(({ id }) => id);
      const reservationIds = orders.flatMap(({ reservationId }) =>
        reservationId ? [reservationId] : [],
      );
      const movements = await transaction.inventoryMovement.findMany({
        select: { operationId: true },
        where: { balance: { skuId: fixture.skuId } },
      });
      const operationIds = [...new Set(movements.map(({ operationId }) => operationId))];
      const promotions = await transaction.promotion.findMany({
        select: { id: true },
        where: { code: { endsWith: suffix }, storeId: BEAUTY_STORE_ID },
      });
      const promotionIds = promotions.map(({ id }) => id);
      const versions = await transaction.promotionVersion.findMany({
        select: { id: true },
        where: { promotionId: { in: promotionIds }, storeId: BEAUTY_STORE_ID },
      });
      const versionIds = versions.map(({ id }) => id);
      await transaction.idempotencyRecord.deleteMany({
        where: { storeId: BEAUTY_STORE_ID, memberId: { in: memberIds } },
      });
      await transaction.memberCoupon.deleteMany({
        where: { memberId: { in: memberIds }, storeId: BEAUTY_STORE_ID },
      });
      await transaction.coupon.deleteMany({
        where: { promotionVersionId: { in: versionIds }, storeId: BEAUTY_STORE_ID },
      });
      await transaction.promotionOperation.deleteMany({
        where: { createdByAdminId: fixture.adminId, storeId: BEAUTY_STORE_ID },
      });
      await transaction.promotionTarget.deleteMany({
        where: { promotionVersionId: { in: versionIds }, storeId: BEAUTY_STORE_ID },
      });
      await transaction.promotionVersionLocalization.deleteMany({
        where: { promotionVersionId: { in: versionIds }, storeId: BEAUTY_STORE_ID },
      });
      await transaction.promotionVersion.deleteMany({
        where: { id: { in: versionIds }, storeId: BEAUTY_STORE_ID },
      });
      await transaction.promotion.deleteMany({
        where: { id: { in: promotionIds }, storeId: BEAUTY_STORE_ID },
      });
      await transaction.orderTransition.deleteMany({
        where: { storeId: BEAUTY_STORE_ID, orderId: { in: orderIds } },
      });
      await transaction.orderSnapshot.deleteMany({
        where: { storeId: BEAUTY_STORE_ID, orderId: { in: orderIds } },
      });
      await transaction.orderItem.deleteMany({
        where: { storeId: BEAUTY_STORE_ID, skuId: fixture.skuId },
      });
      await transaction.order.deleteMany({
        where: { storeId: BEAUTY_STORE_ID, memberId: { in: memberIds } },
      });
      await transaction.address.deleteMany({
        where: { storeId: BEAUTY_STORE_ID, memberId: { in: memberIds } },
      });
      await transaction.memberSession.deleteMany({ where: { memberId: { in: memberIds } } });
      await transaction.member.deleteMany({ where: { id: { in: memberIds } } });
      await transaction.adminSession.deleteMany({ where: { adminUserId: fixture.adminId } });
      await transaction.adminStoreRole.deleteMany({ where: { adminUserId: fixture.adminId } });
      await transaction.storeRolePermission.deleteMany({ where: { roleId: fixture.roleId } });
      await transaction.storeRole.delete({ where: { id: fixture.roleId } });
      await transaction.adminUser.delete({ where: { id: fixture.adminId } });
      await transaction.inventoryMovement.deleteMany({
        where: { balance: { skuId: fixture.skuId } },
      });
      await transaction.inventoryReservationItem.deleteMany({
        where: { reservationId: { in: reservationIds } },
      });
      await transaction.inventoryReservation.deleteMany({
        where: { id: { in: reservationIds } },
      });
      await transaction.inventoryOperation.deleteMany({
        where: {
          storeId: BEAUTY_STORE_ID,
          OR: [{ id: { in: operationIds } }, { sourceId: { in: [fixture.memberId, ...orderIds] } }],
        },
      });
      await transaction.inventoryBalance.delete({ where: { id: fixture.balanceId } });
      await transaction.sku.delete({ where: { id: fixture.skuId } });
      await transaction.productLocalization.deleteMany({ where: { productId: fixture.productId } });
      await transaction.product.delete({ where: { id: fixture.productId } });
      await transaction.brand.delete({ where: { id: fixture.brandId } });
    });
    await owner.$disconnect();
  });

  it('stores an encrypted address and returns only a masked phone', async () => {
    const storeContext = createStoreContext({
      actor: { id: fixture.memberId, type: 'member' },
      correlationId: randomUUID(),
      locale: 'vi',
      storeCode: 'beauty-local',
      storeId: BEAUTY_STORE_ID,
    });
    const visibleAreas = await withStoreTransaction(runtime, storeContext, (transaction) =>
      transaction.administrativeArea.findMany({ select: { storeId: true } }),
    );
    expect(visibleAreas.length).toBeGreaterThan(0);
    expect(new Set(visibleAreas.map((area) => area.storeId))).toEqual(new Set([BEAUTY_STORE_ID]));
    expect(
      await withStoreTransaction(runtime, storeContext, (transaction) =>
        transaction.administrativeArea.count({ where: { storeId: FASHION_STORE_ID } }),
      ),
    ).toBe(0);
    await expect(
      withStoreTransaction(runtime, storeContext, (transaction) =>
        transaction.administrativeArea.create({
          data: {
            code: `runtime-write-${suffix}`,
            level: 'PROVINCE',
            name: 'Denied runtime write',
            sourceVersion: 'test',
            storeId: BEAUTY_STORE_ID,
          },
        }),
      ),
    ).rejects.toBeDefined();

    const provinces = await api()
      .get('/v1/member/administrative-areas?level=PROVINCE')
      .set(memberHeaders());
    expect(provinces.status).toBe(200);
    expect(provinces.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'hn', parent_code: null }),
        expect.objectContaining({ code: 'hcm', parent_code: null }),
      ]),
    );
    const districts = await api()
      .get('/v1/member/administrative-areas?level=DISTRICT&parent_code=hn')
      .set(memberHeaders());
    expect(districts.status).toBe(200);
    expect(districts.body.items).toContainEqual(
      expect.objectContaining({ code: 'ba-dinh', parent_code: 'hn' }),
    );

    const response = await api()
      .post('/v1/member/addresses')
      .set({ Authorization: `Bearer ${memberToken}`, 'X-Store-Code': 'beauty-local' })
      .send({
        detail: '12 Nguyen Trai',
        district_code: 'ba-dinh',
        district_name: 'Untrusted district name',
        is_default: true,
        phone: '13812345678',
        province_code: 'hn',
        province_name: 'Untrusted province name',
        recipient_name: 'Nguyen Thi M4',
        ward_code: 'phuc-xa',
        ward_name: 'Untrusted ward name',
      });
    expect(response.status).toBe(201);
    expect(response.body.masked_phone).toBe('+861****78');
    expect(response.body).toMatchObject({
      district_name: 'Quận Ba Đình',
      province_name: 'Hà Nội',
      ward_name: 'Phường Phúc Xá',
    });
    expect(response.body).not.toHaveProperty('phone');
    const stored = await owner.address.findFirstOrThrow({ where: { memberId: fixture.memberId } });
    expect(stored.phoneCiphertext).not.toContain('13812345678');

    const invalidHierarchy = await api().post('/v1/member/addresses').set(memberHeaders()).send({
      detail: '12 Invalid Hierarchy',
      district_code: 'ba-dinh',
      district_name: 'Ba Dinh',
      phone: '+84909999999',
      province_code: 'hcm',
      province_name: 'Ho Chi Minh',
      recipient_name: 'Invalid Region',
      ward_code: 'phuc-xa',
      ward_name: 'Phuc Xa',
    });
    expect(invalidHierarchy.status).toBe(400);
    expect(invalidHierarchy.body.details?.reason_code).toBe('ADDRESS_REGION_INVALID');
  });

  it('isolates addresses and orders by member and rejects a mismatched store context', async () => {
    const primaryAddress = await owner.address.findFirstOrThrow({
      where: { memberId: fixture.memberId },
    });
    const forbiddenUpdate = await api()
      .patch(`/v1/member/addresses/${primaryAddress.id}`)
      .set(memberHeaders(secondMemberToken))
      .send({ expected_version: primaryAddress.version, label: 'unauthorized' });
    expect(forbiddenUpdate.status).toBe(404);

    const secondAddress = await api()
      .post('/v1/member/addresses')
      .set(memberHeaders(secondMemberToken))
      .send({
        detail: '21 Le Loi',
        district_code: 'quan-1',
        district_name: 'Quan 1',
        is_default: true,
        phone: '+84901234567',
        province_code: 'hcm',
        province_name: 'Ho Chi Minh',
        recipient_name: 'Tran M4',
        ward_code: 'ben-nghe',
        ward_name: 'Ben Nghe',
      });
    expect(secondAddress.status).toBe(201);

    const mismatchedStore = await api()
      .get('/v1/member/addresses')
      .set({ Authorization: `Bearer ${memberToken}`, 'X-Store-Code': 'fashion-local' });
    expect(mismatchedStore.status).toBe(401);
    expect(await owner.address.count({ where: { memberId: fixture.secondMemberId } })).toBe(1);
  });

  it('recalculates final VND COD total and is idempotent', async () => {
    const address = await owner.address.findFirstOrThrow({ where: { memberId: fixture.memberId } });
    const headers = { Authorization: `Bearer ${memberToken}`, 'X-Store-Code': 'beauty-local' };
    const quote = await api()
      .post('/v1/checkout/quote')
      .set(headers)
      .send({
        address_id: address.id,
        items: [{ quantity: 1, sku_code: skuCode }],
        locale: 'vi',
        payment_method: 'COD',
        coupon_code: null,
      });
    expect(quote.status).toBe(201);
    expect(quote.body.order_payable_vnd).toBe(150_000);
    const orderRequest = {
      address_id: address.id,
      items: [{ quantity: 1, sku_code: skuCode }],
      locale: 'vi',
      payment_method: 'COD',
      coupon_code: null,
      quote_hash: quote.body.quote_hash,
    };
    const first = await api()
      .post('/v1/checkout/orders')
      .set({ ...headers, 'Idempotency-Key': `m4-idempotency-${suffix}` })
      .send(orderRequest);
    expect(first.status).toBe(201);
    expect(first.body.status).toBe('PENDING_CONFIRMATION');
    const replay = await api()
      .post('/v1/checkout/orders')
      .set({ ...headers, 'Idempotency-Key': `m4-idempotency-${suffix}` })
      .send(orderRequest);
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(first.body.id);
    const reservation = await owner.inventoryReservation.findFirstOrThrow({
      where: { sourceId: first.body.id },
    });
    expect(reservation.status).toBe('ACTIVE');
    const changed = await api()
      .post('/v1/checkout/orders')
      .set({ ...headers, 'Idempotency-Key': `m4-idempotency-${suffix}` })
      .send({ ...orderRequest, items: [{ quantity: 2, sku_code: skuCode }] });
    expect(changed.status).toBe(409);
  });

  it('rejects client amount fields, stale quote facts and ONLINE order creation without side effects', async () => {
    const address = await owner.address.findFirstOrThrow({ where: { memberId: fixture.memberId } });
    const before = await owner.order.count({ where: { memberId: fixture.memberId } });
    const tamperedQuote = await api()
      .post('/v1/checkout/quote')
      .set(memberHeaders())
      .send({
        address_id: address.id,
        coupon_code: null,
        items: [{ quantity: 1, sku_code: skuCode }],
        locale: 'vi',
        order_payable_vnd: 1,
        payment_method: 'COD',
      });
    expect(tamperedQuote.status).toBe(400);

    const validQuote = await api()
      .post('/v1/checkout/quote')
      .set(memberHeaders())
      .send({
        address_id: address.id,
        coupon_code: null,
        items: [{ quantity: 1, sku_code: skuCode }],
        locale: 'vi',
        payment_method: 'COD',
      });
    expect(validQuote.status).toBe(201);
    const stale = await api()
      .post('/v1/checkout/orders')
      .set({ ...memberHeaders(), 'Idempotency-Key': `m4-stale-${suffix}` })
      .send({
        address_id: address.id,
        coupon_code: null,
        items: [{ quantity: 2, sku_code: skuCode }],
        locale: 'vi',
        payment_method: 'COD',
        quote_hash: validQuote.body.quote_hash,
      });
    expect(stale.status).toBe(409);
    expect(stale.body.details?.reason_code).toBe('QUOTE_STALE');

    const onlineQuote = await api()
      .post('/v1/checkout/quote')
      .set(memberHeaders())
      .send({
        address_id: address.id,
        coupon_code: null,
        items: [{ quantity: 1, sku_code: skuCode }],
        locale: 'vi',
        payment_method: 'ONLINE',
      });
    expect(onlineQuote.status).toBe(201);
    const online = await api()
      .post('/v1/checkout/orders')
      .set({ ...memberHeaders(), 'Idempotency-Key': `m4-online-${suffix}` })
      .send({
        address_id: address.id,
        coupon_code: null,
        items: [{ quantity: 1, sku_code: skuCode }],
        locale: 'vi',
        payment_method: 'ONLINE',
        quote_hash: onlineQuote.body.quote_hash,
      });
    expect(online.status).toBe(409);
    expect(online.body.details?.reason_code).toBe('COD_ONLY_IN_M4');
    expect(await owner.order.count({ where: { memberId: fixture.memberId } })).toBe(before);
  });

  it('prevents concurrent orders from overselling the same store inventory', async () => {
    const [primaryAddress, secondAddress] = await Promise.all([
      owner.address.findFirstOrThrow({ where: { memberId: fixture.memberId } }),
      owner.address.findFirstOrThrow({ where: { memberId: fixture.secondMemberId } }),
    ]);
    const requests = [
      { addressId: primaryAddress.id, key: `m4-race-a-${suffix}`, token: memberToken },
      { addressId: secondAddress.id, key: `m4-race-b-${suffix}`, token: secondMemberToken },
    ];
    const quotes = await Promise.all(
      requests.map(({ addressId, token }) =>
        api()
          .post('/v1/checkout/quote')
          .set(memberHeaders(token))
          .send({
            address_id: addressId,
            coupon_code: null,
            items: [{ quantity: 30, sku_code: skuCode }],
            locale: 'vi',
            payment_method: 'COD',
          }),
      ),
    );
    expect(quotes.map(({ status }) => status)).toEqual([201, 201]);
    const results = await Promise.all(
      requests.map(({ addressId, key, token }, index) =>
        api()
          .post('/v1/checkout/orders')
          .set({ ...memberHeaders(token), 'Idempotency-Key': key })
          .send({
            address_id: addressId,
            coupon_code: null,
            items: [{ quantity: 30, sku_code: skuCode }],
            locale: 'vi',
            payment_method: 'COD',
            quote_hash: quotes[index]!.body.quote_hash,
          }),
      ),
    );
    const winnerIndex = results.findIndex(({ status }) => status === 201);
    expect(winnerIndex).toBeGreaterThanOrEqual(0);
    const winner = results[winnerIndex]!;
    const cancellation = await api()
      .post(`/v1/orders/${winner.body.id}/cancel`)
      .set(memberHeaders(requests[winnerIndex]!.token))
      .send({ reason: 'Concurrent stock verification cleanup' });
    expect(cancellation.status).toBe(201);
    const loser = results.find(({ status }) => status !== 201)!;
    expect(loser.status, JSON.stringify(loser.body)).toBe(409);
    const balance = await owner.inventoryBalance.findUniqueOrThrow({
      where: { id: fixture.balanceId },
    });
    expect(balance.onHand).toBe(50);
    expect(balance.reserved).toBe(1);
  });

  it('cancels a pending COD order idempotently and releases its reservation once', async () => {
    const address = await owner.address.findFirstOrThrow({
      where: { memberId: fixture.secondMemberId },
    });
    const created = await quoteAndCreateOrder({
      addressId: address.id,
      idempotencyKey: `m4-member-cancel-${suffix}`,
      token: secondMemberToken,
    });
    expect(created.status).toBe(201);
    const first = await api()
      .post(`/v1/orders/${created.body.id}/cancel`)
      .set(memberHeaders(secondMemberToken))
      .send({ reason: 'Buyer changed their mind' });
    const replay = await api()
      .post(`/v1/orders/${created.body.id}/cancel`)
      .set(memberHeaders(secondMemberToken))
      .send({ reason: 'Buyer changed their mind' });
    expect([first.status, replay.status]).toEqual([201, 201]);
    expect(first.body.status).toBe('CANCELLED');
    expect(replay.body.id).toBe(first.body.id);
    const order = await owner.order.findUniqueOrThrow({ where: { id: created.body.id } });
    const reservation = await owner.inventoryReservation.findUniqueOrThrow({
      where: { id: order.reservationId! },
    });
    expect(reservation.status).toBe('RELEASED');
    expect(
      await owner.inventoryOperation.count({
        where: { operationKey: `m4-order-cancel-${created.body.id}` },
      }),
    ).toBe(1);
  });

  it('replays an admin cancellation of a pending COD order without attempting stock restore', async () => {
    const address = await owner.address.findFirstOrThrow({
      where: { memberId: fixture.secondMemberId },
    });
    const created = await quoteAndCreateOrder({
      addressId: address.id,
      idempotencyKey: `m4-admin-pending-cancel-${suffix}`,
      token: secondMemberToken,
    });
    expect(created.status).toBe(201);
    const path = `/v1/admin/orders/${created.body.id}/cancel?store_id=${BEAUTY_STORE_ID}`;
    const first = await api()
      .post(path)
      .set(adminHeaders())
      .send({ reason: 'Cancelled during confirmation' });
    const replay = await api()
      .post(path)
      .set(adminHeaders())
      .send({ reason: 'Cancelled during confirmation' });
    expect([first.status, replay.status]).toEqual([201, 201]);
    expect(first.body.status).toBe('CANCELLED');
    expect(replay.body.id).toBe(first.body.id);
    const order = await owner.order.findUniqueOrThrow({ where: { id: created.body.id } });
    const reservation = await owner.inventoryReservation.findUniqueOrThrow({
      where: { id: order.reservationId! },
    });
    expect(reservation.status).toBe('RELEASED');
    expect(
      await owner.inventoryOperation.count({
        where: { operationKey: `m4-order-admin-cancel-${created.body.id}` },
      }),
    ).toBe(1);
    expect(
      await owner.inventoryOperation.count({
        where: { operationKey: `m4-order-restore-${created.body.id}` },
      }),
    ).toBe(0);
  });

  it('expires a due order reservation and closes the order through reconciliation', async () => {
    const address = await owner.address.findFirstOrThrow({ where: { memberId: fixture.memberId } });
    const created = await quoteAndCreateOrder({
      addressId: address.id,
      idempotencyKey: `m4-expire-${suffix}`,
    });
    expect(created.status).toBe(201);
    const order = await owner.order.findUniqueOrThrow({ where: { id: created.body.id } });
    await owner.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        UPDATE inventory_reservations
        SET created_at = CURRENT_TIMESTAMP - INTERVAL '2 minutes',
            expires_at = CURRENT_TIMESTAMP - INTERVAL '1 minute'
        WHERE id = ${order.reservationId}::uuid
      `;
    });
    const context = createStoreContext({
      actor: { id: fixture.adminId, type: 'admin' },
      correlationId: randomUUID(),
      locale: 'vi',
      storeCode: 'beauty-local',
      storeId: BEAUTY_STORE_ID,
    });
    const expired = await expireDueReservations(runtime, context, 20);
    expect(expired.expired).toBeGreaterThanOrEqual(1);
    const reconciled = await reconcileReservationBackedOrders(runtime, context, 20);
    expect(reconciled).toMatchObject({ closed: 1 });
    const closed = await owner.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(closed.status).toBe('CLOSED');
    expect(await reconcileReservationBackedOrders(runtime, context, 20)).toMatchObject({
      scanned: 0,
    });
  });

  it('redeems a real member coupon in the order transaction and enforces new-customer eligibility', async () => {
    const address = await owner.address.findFirstOrThrow({
      where: { memberId: fixture.secondMemberId },
    });
    const couponCode = `m4-coupon-${suffix}`;
    const coupon = await createClaimedCoupon({
      code: couponCode,
      newCustomerOnly: true,
      token: secondMemberToken,
    });
    const body = {
      address_id: address.id,
      coupon_code: couponCode,
      items: [{ quantity: 1, sku_code: skuCode }],
      locale: 'vi',
      payment_method: 'COD',
    } as const;
    const quote = await api()
      .post('/v1/checkout/quote')
      .set(memberHeaders(secondMemberToken))
      .send(body);
    expect(quote.status).toBe(201);
    expect(quote.body).toMatchObject({ discount_vnd: 5_000, order_payable_vnd: 145_000 });
    const created = await api()
      .post('/v1/checkout/orders')
      .set({
        ...memberHeaders(secondMemberToken),
        'Idempotency-Key': `m4-coupon-order-${suffix}`,
      })
      .send({ ...body, quote_hash: quote.body.quote_hash });
    expect(created.status).toBe(201);
    expect(
      await owner.memberCoupon.findUniqueOrThrow({
        where: {
          storeId_couponId_memberId: {
            couponId: coupon.couponId,
            memberId: fixture.secondMemberId,
            storeId: BEAUTY_STORE_ID,
          },
        },
      }),
    ).toMatchObject({ status: 'USED', usedOrderId: created.body.id });
    await api()
      .post(`/v1/orders/${created.body.id}/cancel`)
      .set(memberHeaders(secondMemberToken))
      .send({ reason: 'Coupon transaction verification cleanup' })
      .expect(201);

    await owner.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.order.update({
        data: { status: 'COMPLETED' },
        where: { id: created.body.id },
      });
    });
    const restrictedCode = `m4-new-customer-${suffix}`;
    await createClaimedCoupon({
      code: restrictedCode,
      newCustomerOnly: true,
      token: secondMemberToken,
    });
    const ineligible = await api()
      .post('/v1/checkout/quote')
      .set(memberHeaders(secondMemberToken))
      .send({ ...body, coupon_code: restrictedCode });
    expect(ineligible.status).toBe(409);
    expect(ineligible.body.details?.reason_code).toBe('MEMBER_INELIGIBLE');
  });

  it('keeps buyer order reads isolated and serves the immutable address snapshot', async () => {
    const order = await owner.order.findFirstOrThrow({
      where: { memberId: fixture.memberId, status: 'PENDING_CONFIRMATION' },
    });
    const denied = await api().get(`/v1/orders/${order.id}`).set(memberHeaders(secondMemberToken));
    expect(denied.status).toBe(404);
    const detailBefore = await api().get(`/v1/orders/${order.id}`).set(memberHeaders());
    expect(detailBefore.status).toBe(200);
    const address = await owner.address.findFirstOrThrow({ where: { memberId: fixture.memberId } });
    await api()
      .patch(`/v1/member/addresses/${address.id}`)
      .set(memberHeaders())
      .send({ detail: '99 Changed After Checkout', expected_version: address.version })
      .expect(200);
    const detailAfter = await api().get(`/v1/orders/${order.id}`).set(memberHeaders());
    expect(detailAfter.status).toBe(200);
    expect(detailAfter.body.address.detail).toBe(detailBefore.body.address.detail);
    expect(detailAfter.body.address.detail).not.toBe('99 Changed After Checkout');
  });

  it('updates delivery policy with optimistic locking and scoped audit', async () => {
    const current = await api()
      .get(`/v1/admin/delivery-policy?store_id=${BEAUTY_STORE_ID}`)
      .set(adminHeaders());
    expect(current.status).toBe(200);
    const body = {
      cod_enabled: current.body.cod_enabled,
      cod_max_amount_vnd: current.body.cod_max_amount_vnd,
      enabled: current.body.enabled,
      expected_version: current.body.version,
      flat_shipping_fee_vnd: current.body.flat_shipping_fee_vnd,
      free_shipping_threshold_vnd: current.body.free_shipping_threshold_vnd,
      remote_province_codes: current.body.remote_province_codes,
      remote_surcharge_vnd: current.body.remote_surcharge_vnd,
    };
    const invalidRegion = await api()
      .patch(`/v1/admin/delivery-policy?store_id=${BEAUTY_STORE_ID}`)
      .set(adminHeaders())
      .send({ ...body, remote_province_codes: ['client-invented-province'] });
    expect(invalidRegion.status).toBe(400);
    expect(invalidRegion.body.details?.reason_code).toBe('DELIVERY_REGION_INVALID');
    const updated = await api()
      .patch(`/v1/admin/delivery-policy?store_id=${BEAUTY_STORE_ID}`)
      .set(adminHeaders())
      .send(body);
    expect(updated.status).toBe(200);
    expect(updated.body.version).toBe(current.body.version + 1);
    const stale = await api()
      .patch(`/v1/admin/delivery-policy?store_id=${BEAUTY_STORE_ID}`)
      .set(adminHeaders())
      .send(body);
    expect(stale.status).toBe(409);
    expect(stale.body.details?.reason_code).toBe('VERSION_CONFLICT');
    expect(
      await owner.auditLog.count({
        where: {
          action: 'delivery.policy.updated',
          actorId: fixture.adminId,
          storeId: BEAUTY_STORE_ID,
        },
      }),
    ).toBe(1);
  });

  it('confirms COD through scoped admin and consumes the reservation once', async () => {
    const order = await owner.order.findFirstOrThrow({ where: { memberId: fixture.memberId } });
    const response = await api()
      .post(`/v1/admin/orders/${order.id}/confirm-cod?store_id=${BEAUTY_STORE_ID}`)
      .set(adminHeaders())
      .send({ reason: 'Phone confirmation completed' });
    expect(response.status).toBe(201);
    expect(response.body.status).toBe('PENDING_FULFILLMENT');
    const replay = await api()
      .post(`/v1/admin/orders/${order.id}/confirm-cod?store_id=${BEAUTY_STORE_ID}`)
      .set(adminHeaders())
      .send({ reason: 'Phone confirmation completed' });
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(response.body.id);
    const updated = await owner.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(updated.status).toBe('PENDING_FULFILLMENT');
    const reservation = await owner.inventoryReservation.findUniqueOrThrow({
      where: { storeId_id: { id: order.reservationId!, storeId: BEAUTY_STORE_ID } },
    });
    expect(reservation.status).toBe('CONSUMED');
    const balance = await owner.inventoryBalance.findUniqueOrThrow({
      where: { id: fixture.balanceId },
    });
    expect(balance.onHand).toBe(49);
    expect(balance.reserved).toBe(0);
    expect(
      await owner.inventoryOperation.count({
        where: { operationKey: `m4-order-consume-${order.id}` },
      }),
    ).toBe(1);
  });

  it('cancels a confirmed COD order atomically and restores inventory once', async () => {
    const order = await owner.order.findFirstOrThrow({
      where: { memberId: fixture.memberId, status: 'PENDING_FULFILLMENT' },
    });
    const path = `/v1/admin/orders/${order.id}/cancel?store_id=${BEAUTY_STORE_ID}`;
    const first = await api()
      .post(path)
      .set(adminHeaders())
      .send({ reason: 'Cancelled before fulfillment' });
    const replay = await api()
      .post(path)
      .set(adminHeaders())
      .send({ reason: 'Cancelled before fulfillment' });
    expect([first.status, replay.status]).toEqual([201, 201]);
    expect(first.body.status).toBe('CANCELLED');
    expect(replay.body.id).toBe(first.body.id);
    const balance = await owner.inventoryBalance.findUniqueOrThrow({
      where: { id: fixture.balanceId },
    });
    expect(balance).toMatchObject({ onHand: 50, reserved: 0 });
    expect(
      await owner.inventoryOperation.count({
        where: { operationKey: `m4-order-restore-${order.id}`, operationType: 'RESTORE' },
      }),
    ).toBe(1);
  });
});
