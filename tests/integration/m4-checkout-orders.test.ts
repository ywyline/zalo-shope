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
  canonicalAfterSalePolicyHash,
  createRuntimePrismaClient,
  expireDueReservations,
  PrismaClient,
  reconcileReservationBackedOrders,
  type StoreTransaction,
  withStoreTransaction,
  writeCheckoutAfterSalePolicySnapshotsInTransaction,
} from '@zalo-shop/database';
import { createStoreContext } from '@zalo-shop/domain';
import { hashSensitive, signJwt } from '@zalo-shop/security';

const BEAUTY_STORE_ID = '10000000-0000-4000-8000-000000000001';
const FASHION_STORE_ID = '10000000-0000-4000-8000-000000000002';
const BEAUTY_ROOT_CATEGORY_ID = '11000000-0000-4000-8000-000000000001';
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
    afterSalePolicyId: randomUUID(),
    afterSalePolicyVersionId: randomUUID(),
    afterSalePolicyAssignmentId: randomUUID(),
    afterSaleActiveAssignmentId: randomUUID(),
    categoryAfterSalePolicyId: randomUUID(),
    categoryAfterSalePolicyVersionId: randomUUID(),
    categoryAfterSalePolicyAssignmentId: randomUUID(),
    categoryAfterSaleActiveAssignmentId: randomUUID(),
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
        heightMillimeters: 80,
        id: fixture.skuId,
        lengthMillimeters: 180,
        optionCombinationHash: 'a'.repeat(64),
        optionCombinationKey: `m4=${suffix}`,
        productId: fixture.productId,
        salePriceVnd: 120_000,
        storeId: BEAUTY_STORE_ID,
        weightGrams: 250,
        widthMillimeters: 120,
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
            { permissionCode: 'store.after-sales.policy.read' },
            { permissionCode: 'store.after-sales.policy.enforce' },
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
        where: {
          storeId: BEAUTY_STORE_ID,
          OR: [{ memberId: { in: memberIds } }, { operation: 'after-sale.policy.enforce' }],
        },
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
      await transaction.orderItemAfterSalePolicySnapshot.deleteMany({
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
      await transaction.storeAfterSaleSetting.upsert({
        create: { storeId: BEAUTY_STORE_ID },
        update: {
          currentVersionId: null,
          defaultPolicyId: null,
          enforcePolicySnapshots: false,
          readinessCheckedAt: null,
          readinessCheckedBy: null,
          readinessHash: null,
          readinessReadyAt: null,
          updatedBy: null,
          version: 1,
        },
        where: { storeId: BEAUTY_STORE_ID },
      });
      await transaction.afterSaleActivePolicyAssignment.deleteMany({
        where: {
          id: {
            in: [fixture.afterSaleActiveAssignmentId, fixture.categoryAfterSaleActiveAssignmentId],
          },
          storeId: BEAUTY_STORE_ID,
        },
      });
      await transaction.afterSalePolicyVersionAssignment.deleteMany({
        where: {
          id: {
            in: [fixture.afterSalePolicyAssignmentId, fixture.categoryAfterSalePolicyAssignmentId],
          },
          storeId: BEAUTY_STORE_ID,
        },
      });
      await transaction.afterSalePolicyLocalization.deleteMany({
        where: {
          policyVersionId: {
            in: [fixture.afterSalePolicyVersionId, fixture.categoryAfterSalePolicyVersionId],
          },
          storeId: BEAUTY_STORE_ID,
        },
      });
      await transaction.afterSalePolicyVersion.deleteMany({
        where: {
          id: {
            in: [fixture.afterSalePolicyVersionId, fixture.categoryAfterSalePolicyVersionId],
          },
          storeId: BEAUTY_STORE_ID,
        },
      });
      await transaction.afterSalePolicy.deleteMany({
        where: {
          id: { in: [fixture.afterSalePolicyId, fixture.categoryAfterSalePolicyId] },
          storeId: BEAUTY_STORE_ID,
        },
      });
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

  it('enforces ready policy snapshots with audited controls and fails closed on assignment drift', async () => {
    const adminContext = createStoreContext({
      actor: { id: fixture.adminId, type: 'admin' },
      correlationId: `m63-policy-${suffix}`,
      locale: 'vi',
      storeCode: 'beauty-local',
      storeId: BEAUTY_STORE_ID,
    });
    const defaultPolicyCode = `m63-default-${suffix}`;
    const categoryPolicyCode = `m63-category-${suffix}`;

    async function createPublishedPolicy(
      transaction: StoreTransaction,
      input: {
        activeAssignmentId: string;
        assignmentId: string;
        categoryId: string | null;
        code: string;
        policyId: string;
        policyVersionId: string;
        targetType: 'CATEGORY' | 'STORE_DEFAULT';
      },
    ) {
      const localizations: Array<{
        buyer_instructions: string;
        locale: 'en' | 'vi' | 'zh';
        name: string;
        summary: string;
      }> = [
        {
          buyer_instructions: 'Gửi yêu cầu cùng bằng chứng theo hướng dẫn thử nghiệm.',
          locale: 'vi',
          name: `Chính sách ${input.code}`,
          summary: 'Chính sách local/test không phải kết luận pháp lý.',
        },
        {
          buyer_instructions: '请按测试说明提交申请与凭证。',
          locale: 'zh',
          name: `政策 ${input.code}`,
          summary: '本 local/test 政策不是法律结论。',
        },
        {
          buyer_instructions: 'Submit the request and evidence using the test instructions.',
          locale: 'en',
          name: `Policy ${input.code}`,
          summary: 'This local/test policy is not legal advice.',
        },
      ];
      const payload = {
        allowed_types: ['REFUND_ONLY', 'RETURN_REFUND'],
        category_id: input.categoryId,
        condition_rules: {
          allowed_reason_codes: ['damaged', 'defect', 'wrong-item'],
          evidence_required: true,
          evidence_required_reason_codes: ['damaged', 'defect', 'wrong-item'],
          opened_package_exception_reason_codes: [],
        },
        damaged_exception: true,
        defect_exception: true,
        exchange_attribute_code: null,
        exchange_same_product_only: true,
        hygiene_restricted: false,
        localizations,
        product_ids: [],
        request_window_days: 30,
        return_shipping_payer: 'MERCHANT',
        return_window_days: 7,
        unopened_required: false,
        wrong_item_exception: true,
      };
      const payloadHash = canonicalAfterSalePolicyHash(payload);
      await transaction.afterSalePolicy.create({
        data: {
          categoryId: input.categoryId,
          code: input.code,
          createdBy: fixture.adminId,
          draftHash: payloadHash,
          draftPayload: payload,
          id: input.policyId,
          status: 'DRAFT',
          storeId: BEAUTY_STORE_ID,
          updatedBy: fixture.adminId,
        },
      });
      await transaction.afterSalePolicyVersion.create({
        data: {
          allowedTypes: ['REFUND_ONLY', 'RETURN_REFUND'],
          conditionRules: payload.condition_rules,
          damagedException: true,
          defectException: true,
          effectiveAt: new Date(Date.now() - 60_000),
          exchangeAttributeCode: null,
          exchangeSameProductOnly: true,
          hygieneRestricted: false,
          id: input.policyVersionId,
          payload,
          payloadHash,
          policyId: input.policyId,
          publishedBy: fixture.adminId,
          requestWindowDays: 30,
          returnShippingPayer: 'MERCHANT',
          returnWindowDays: 7,
          storeId: BEAUTY_STORE_ID,
          unopenedRequired: false,
          versionNumber: 1,
          wrongItemException: true,
        },
      });
      await transaction.afterSalePolicyLocalization.createMany({
        data: localizations.map((localization) => ({
          buyerInstructions: localization.buyer_instructions,
          locale: localization.locale,
          name: localization.name,
          policyVersionId: input.policyVersionId,
          storeId: BEAUTY_STORE_ID,
          summary: localization.summary,
        })),
      });
      await transaction.afterSalePolicyVersionAssignment.create({
        data: {
          categoryId: input.categoryId,
          id: input.assignmentId,
          policyId: input.policyId,
          policyVersionId: input.policyVersionId,
          productId: null,
          storeId: BEAUTY_STORE_ID,
          targetType: input.targetType,
        },
      });
      await transaction.afterSalePolicy.update({
        data: {
          currentVersionId: input.policyVersionId,
          status: 'ACTIVE',
          updatedBy: fixture.adminId,
          version: { increment: 1 },
        },
        where: { id: input.policyId },
      });
      await transaction.afterSaleActivePolicyAssignment.create({
        data: {
          assignmentId: input.assignmentId,
          categoryId: input.categoryId,
          id: input.activeAssignmentId,
          policyId: input.policyId,
          policyVersionId: input.policyVersionId,
          productId: null,
          storeId: BEAUTY_STORE_ID,
          targetType: input.targetType,
        },
      });
      return { payload, payloadHash };
    }

    const policyFacts = await withStoreTransaction(runtime, adminContext, async (transaction) => {
      const defaults = await createPublishedPolicy(transaction, {
        activeAssignmentId: fixture.afterSaleActiveAssignmentId,
        assignmentId: fixture.afterSalePolicyAssignmentId,
        categoryId: null,
        code: defaultPolicyCode,
        policyId: fixture.afterSalePolicyId,
        policyVersionId: fixture.afterSalePolicyVersionId,
        targetType: 'STORE_DEFAULT',
      });
      const category = await createPublishedPolicy(transaction, {
        activeAssignmentId: fixture.categoryAfterSaleActiveAssignmentId,
        assignmentId: fixture.categoryAfterSalePolicyAssignmentId,
        categoryId: BEAUTY_ROOT_CATEGORY_ID,
        code: categoryPolicyCode,
        policyId: fixture.categoryAfterSalePolicyId,
        policyVersionId: fixture.categoryAfterSalePolicyVersionId,
        targetType: 'CATEGORY',
      });
      return { category, defaults };
    });

    const settingsPath = `/v1/admin/after-sale-settings?store_id=${BEAUTY_STORE_ID}`;
    const ready = await api().get(settingsPath).set(adminHeaders());
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({
      current_version_number: 1,
      default_policy_code: defaultPolicyCode,
      enforce_policy_snapshots: false,
      readiness_state: 'READY',
      version: 1,
    });

    const address = await owner.address.findFirstOrThrow({
      where: { memberId: fixture.memberId },
    });
    const offOrder = await quoteAndCreateOrder({
      addressId: address.id,
      idempotencyKey: `m63-off-no-snapshot-${suffix}`,
    });
    expect(offOrder.status, JSON.stringify(offOrder.body)).toBe(201);
    expect(
      await owner.orderItemAfterSalePolicySnapshot.count({
        where: { orderId: offOrder.body.id, storeId: BEAUTY_STORE_ID },
      }),
    ).toBe(0);
    await api()
      .post(`/v1/orders/${offOrder.body.id}/cancel`)
      .set(memberHeaders())
      .send({ reason: 'Release the enforcement-OFF compatibility order reservation.' })
      .expect(201);

    await owner.storeRolePermission.delete({
      where: {
        storeId_roleId_permissionCode: {
          permissionCode: 'store.after-sales.policy.enforce',
          roleId: fixture.roleId,
          storeId: BEAUTY_STORE_ID,
        },
      },
    });
    try {
      await api()
        .put(settingsPath)
        .set({ ...adminHeaders(), 'Idempotency-Key': `m63-rbac-${suffix}` })
        .send({
          confirmation_code: 'ENABLE_AFTER_SALE_POLICY_ENFORCEMENT',
          enabled: true,
          expected_version: 1,
          reason: 'This command must require the independent enforcement permission.',
        })
        .expect(403);
    } finally {
      await owner.storeRolePermission.create({
        data: {
          permissionCode: 'store.after-sales.policy.enforce',
          roleId: fixture.roleId,
          storeId: BEAUTY_STORE_ID,
        },
      });
    }

    const adminSession = await owner.adminSession.findFirstOrThrow({
      where: { adminUserId: fixture.adminId },
    });
    await owner.adminSession.update({
      data: { mfaVerifiedAt: new Date(Date.now() - 11 * 60 * 1_000) },
      where: { id: adminSession.id },
    });
    try {
      await api()
        .put(settingsPath)
        .set({ ...adminHeaders(), 'Idempotency-Key': `m63-mfa-${suffix}` })
        .send({
          confirmation_code: 'ENABLE_AFTER_SALE_POLICY_ENFORCEMENT',
          enabled: true,
          expected_version: 1,
          reason: 'This command must require a recent administrator MFA verification.',
        })
        .expect(403);
    } finally {
      await owner.adminSession.update({
        data: { mfaVerifiedAt: new Date() },
        where: { id: adminSession.id },
      });
    }

    const enableKey = `m63-enable-${suffix}`;
    const enableBody = {
      confirmation_code: 'ENABLE_AFTER_SALE_POLICY_ENFORCEMENT',
      enabled: true,
      expected_version: 1,
      reason: 'Enable immutable policy snapshots for the ready local test store.',
    };
    let releaseStaleCheckout!: () => void;
    let reportStaleCheckoutSnapshot!: () => void;
    const staleCheckoutRelease = new Promise<void>((resolve) => {
      releaseStaleCheckout = resolve;
    });
    const staleCheckoutSnapshot = new Promise<void>((resolve) => {
      reportStaleCheckoutSnapshot = resolve;
    });
    const memberPolicyContext = createStoreContext({
      actor: { id: fixture.memberId, type: 'member' },
      correlationId: `m63-policy-switch-${suffix}`,
      locale: 'vi',
      storeCode: 'beauty-local',
      storeId: BEAUTY_STORE_ID,
    });
    const staleCheckout = withStoreTransaction(
      runtime,
      memberPolicyContext,
      async (transaction) => {
        await transaction.$queryRaw`
          SELECT enforce_policy_snapshots
          FROM store_after_sale_settings
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid
        `;
        reportStaleCheckoutSnapshot();
        await staleCheckoutRelease;
        return writeCheckoutAfterSalePolicySnapshotsInTransaction(transaction, {
          lines: [
            {
              categoryId: BEAUTY_CATEGORY_ID,
              orderId: randomUUID(),
              orderItemId: randomUUID(),
              productId: fixture.productId,
            },
          ],
          storeId: BEAUTY_STORE_ID,
        });
      },
      { isolationLevel: 'Serializable', timeout: 15_000 },
    );
    await staleCheckoutSnapshot;
    const enabled = await (async () => {
      try {
        return await api()
          .put(settingsPath)
          .set({ ...adminHeaders(), 'Idempotency-Key': enableKey })
          .send(enableBody);
      } finally {
        releaseStaleCheckout();
      }
    })();
    const staleCheckoutError = await staleCheckout.then(
      () => null,
      (error: unknown) => error,
    );
    const staleCheckoutRecord = staleCheckoutError as {
      code?: unknown;
      meta?: { code?: unknown };
    } | null;
    const staleCheckoutCode =
      staleCheckoutRecord?.code === 'P2010'
        ? staleCheckoutRecord.meta?.code
        : staleCheckoutRecord?.code;
    expect(['40001', 'P2034']).toContain(staleCheckoutCode);
    expect(enabled.status).toBe(200);
    expect(enabled.headers['idempotency-replayed']).toBe('false');
    expect(enabled.body).toMatchObject({
      default_policy_code: defaultPolicyCode,
      enforce_policy_snapshots: true,
      readiness_state: 'ENFORCED',
      version: 2,
    });
    const replay = await api()
      .put(settingsPath)
      .set({ ...adminHeaders(), 'Idempotency-Key': enableKey })
      .send(enableBody);
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.body).toEqual(enabled.body);
    await api()
      .put(settingsPath)
      .set({ ...adminHeaders(), 'Idempotency-Key': enableKey })
      .send({ ...enableBody, reason: 'A changed command must conflict with the original key.' })
      .expect(409);
    await api()
      .put(settingsPath)
      .set({ ...adminHeaders(), 'Idempotency-Key': `m63-stale-version-${suffix}` })
      .send(enableBody)
      .expect(409);

    const sameConcurrentKey = `m63-concurrent-same-${suffix}`;
    const sameConcurrentBody = {
      ...enableBody,
      expected_version: 2,
      reason: 'Concurrent identical readiness refresh must commit exactly once.',
    };
    const sameConcurrent = await Promise.all([
      api()
        .put(settingsPath)
        .set({ ...adminHeaders(), 'Idempotency-Key': sameConcurrentKey })
        .send(sameConcurrentBody),
      api()
        .put(settingsPath)
        .set({ ...adminHeaders(), 'Idempotency-Key': sameConcurrentKey })
        .send(sameConcurrentBody),
    ]);
    expect(sameConcurrent.map(({ status }) => status)).toEqual([200, 200]);
    expect(sameConcurrent[0]?.body).toEqual(sameConcurrent[1]?.body);
    expect(sameConcurrent[0]?.body.version).toBe(3);
    expect(sameConcurrent.map(({ headers }) => headers['idempotency-replayed']).sort()).toEqual([
      'false',
      'true',
    ]);

    const concurrent = await Promise.all([
      api()
        .put(settingsPath)
        .set({ ...adminHeaders(), 'Idempotency-Key': `m63-concurrent-a-${suffix}` })
        .send({ ...enableBody, expected_version: 3, reason: 'Concurrent readiness refresh A.' }),
      api()
        .put(settingsPath)
        .set({ ...adminHeaders(), 'Idempotency-Key': `m63-concurrent-b-${suffix}` })
        .send({ ...enableBody, expected_version: 3, reason: 'Concurrent readiness refresh B.' }),
    ]);
    expect(concurrent.map(({ status }) => status).sort()).toEqual([200, 409]);
    expect(concurrent.find(({ status }) => status === 200)?.body.version).toBe(4);

    await api()
      .get(`/v1/admin/after-sale-settings?store_id=${FASHION_STORE_ID}`)
      .set(adminHeaders())
      .expect(403);
    await api()
      .get(settingsPath)
      .set({ ...adminHeaders(), 'X-Store-Code': 'fashion-local' })
      .expect(403);

    const created = await quoteAndCreateOrder({
      addressId: address.id,
      idempotencyKey: `m63-snapshot-${suffix}`,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const snapshot = await owner.orderItemAfterSalePolicySnapshot.findFirstOrThrow({
      where: { orderId: created.body.id, storeId: BEAUTY_STORE_ID },
    });
    expect(snapshot).toMatchObject({
      payload: policyFacts.category.payload,
      payloadHash: policyFacts.category.payloadHash,
      policyCode: categoryPolicyCode,
      policyId: fixture.categoryAfterSalePolicyId,
      policyVersionId: fixture.categoryAfterSalePolicyVersionId,
      policyVersionNumber: 1,
    });
    await api()
      .post(`/v1/orders/${created.body.id}/cancel`)
      .set(memberHeaders())
      .send({ reason: 'Release the M6.3-A policy snapshot test reservation.' })
      .expect(201);

    const orderCountBeforeDrift = await owner.order.count({
      where: { memberId: fixture.memberId, storeId: BEAUTY_STORE_ID },
    });
    const balanceBeforeDrift = await owner.inventoryBalance.findUniqueOrThrow({
      where: { id: fixture.balanceId },
    });
    await withStoreTransaction(runtime, adminContext, (transaction) =>
      transaction.afterSaleActivePolicyAssignment.delete({
        where: { id: fixture.categoryAfterSaleActiveAssignmentId },
      }),
    );
    const driftKey = `m63-policy-drift-${suffix}`;
    try {
      const driftedSettings = await api().get(settingsPath).set(adminHeaders());
      expect(driftedSettings.status).toBe(200);
      expect(driftedSettings.body).toMatchObject({
        enforce_policy_snapshots: true,
        readiness_state: 'NOT_READY',
        version: 4,
      });
      const body = {
        address_id: address.id,
        coupon_code: null,
        items: [{ quantity: 1, sku_code: skuCode }],
        locale: 'vi',
        payment_method: 'COD',
      } as const;
      const quote = await api().post('/v1/checkout/quote').set(memberHeaders()).send(body);
      expect(quote.status).toBe(201);
      const rejected = await api()
        .post('/v1/checkout/orders')
        .set({ ...memberHeaders(), 'Idempotency-Key': driftKey })
        .send({ ...body, quote_hash: quote.body.quote_hash });
      expect(rejected.status).toBe(409);
      expect(rejected.body.details?.reason_code).toBe('AFTER_SALE_POLICY_NOT_READY');
      expect(
        await owner.order.count({
          where: { memberId: fixture.memberId, storeId: BEAUTY_STORE_ID },
        }),
      ).toBe(orderCountBeforeDrift);
      expect(
        await owner.inventoryBalance.findUniqueOrThrow({ where: { id: fixture.balanceId } }),
      ).toMatchObject({
        onHand: balanceBeforeDrift.onHand,
        reserved: balanceBeforeDrift.reserved,
      });
      expect(
        await owner.idempotencyRecord.count({
          where: { idempotencyKey: driftKey, operation: 'checkout.create-order' },
        }),
      ).toBe(0);
    } finally {
      await withStoreTransaction(runtime, adminContext, (transaction) =>
        transaction.afterSaleActivePolicyAssignment.create({
          data: {
            assignmentId: fixture.categoryAfterSalePolicyAssignmentId,
            categoryId: BEAUTY_ROOT_CATEGORY_ID,
            id: fixture.categoryAfterSaleActiveAssignmentId,
            policyId: fixture.categoryAfterSalePolicyId,
            policyVersionId: fixture.categoryAfterSalePolicyVersionId,
            productId: null,
            storeId: BEAUTY_STORE_ID,
            targetType: 'CATEGORY',
          },
        }),
      );
    }

    const audits = await owner.auditLog.findMany({
      where: {
        action: 'after-sale.policy.enforcement.updated',
        actorId: fixture.adminId,
        storeId: BEAUTY_STORE_ID,
      },
    });
    expect(audits).toHaveLength(3);
    expect(audits.map(({ afterData }) => afterData)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ enforce_policy_snapshots: true, version: 2 }),
        expect.objectContaining({ enforce_policy_snapshots: true, version: 3 }),
        expect.objectContaining({
          current_version_id: fixture.afterSalePolicyVersionId,
          default_policy_id: fixture.afterSalePolicyId,
          enforce_policy_snapshots: true,
          readiness_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          version: 4,
        }),
      ]),
    );
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
    await expect(
      owner.orderItem.findFirstOrThrow({
        select: {
          heightMillimeters: true,
          lengthMillimeters: true,
          weightGrams: true,
          widthMillimeters: true,
        },
        where: { orderId: first.body.id, storeId: BEAUTY_STORE_ID },
      }),
    ).resolves.toEqual({
      heightMillimeters: 80,
      lengthMillimeters: 180,
      weightGrams: 250,
      widthMillimeters: 120,
    });
    const changed = await api()
      .post('/v1/checkout/orders')
      .set({ ...headers, 'Idempotency-Key': `m4-idempotency-${suffix}` })
      .send({ ...orderRequest, items: [{ quantity: 2, sku_code: skuCode }] });
    expect(changed.status).toBe(409);
  });

  it('rejects client amount fields, stale quote facts and unavailable ONLINE checkout without side effects', async () => {
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
    expect(onlineQuote.status).toBe(409);
    expect(onlineQuote.body.details?.reason_code).toBe('ONLINE_PAYMENT_UNAVAILABLE');
    expect(await owner.order.count({ where: { memberId: fixture.memberId } })).toBe(before);
  });

  it('blocks checkout when a SKU lacks a trusted physical profile', async () => {
    const address = await owner.address.findFirstOrThrow({ where: { memberId: fixture.memberId } });
    const before = await owner.order.count({ where: { memberId: fixture.memberId } });
    await owner.sku.update({
      data: { heightMillimeters: null },
      where: { id: fixture.skuId },
    });
    try {
      const response = await api()
        .post('/v1/checkout/quote')
        .set(memberHeaders())
        .send({
          address_id: address.id,
          coupon_code: null,
          items: [{ quantity: 1, sku_code: skuCode }],
          locale: 'vi',
          payment_method: 'COD',
        });
      expect(response.status).toBe(409);
      expect(response.body.details?.reason_code).toBe('SKU_PHYSICAL_PROFILE_INCOMPLETE');
      expect(await owner.order.count({ where: { memberId: fixture.memberId } })).toBe(before);
    } finally {
      await owner.sku.update({
        data: { heightMillimeters: 80 },
        where: { id: fixture.skuId },
      });
    }
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
    const order = await owner.order.findFirstOrThrow({
      where: { memberId: fixture.memberId, status: 'PENDING_CONFIRMATION' },
    });
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
