import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { config as loadEnvironment } from 'dotenv';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseRuntimeConfig } from '@zalo-shop/config';
import { adjustInventory, createRuntimePrismaClient, PrismaClient } from '@zalo-shop/database';
import { createStoreContext } from '@zalo-shop/domain';
import { hashSensitive, signJwt } from '@zalo-shop/security';

const BEAUTY_STORE_ID = '10000000-0000-4000-8000-000000000001';
const FASHION_STORE_ID = '10000000-0000-4000-8000-000000000002';
const BEAUTY_ROOT_CATEGORY_ID = '11000000-0000-4000-8000-000000000001';
const BEAUTY_CATEGORY_ID = '12000000-0000-4000-8000-000000000001';
const FASHION_CATEGORY_ID = '12000000-0000-4000-8000-000000000002';
const BEAUTY_TEMPLATE_ID = '14000000-0000-4000-8000-000000000001';
const FASHION_TEMPLATE_ID = '14000000-0000-4000-8000-000000000002';
const BEAUTY_WAREHOUSE_ID = '17000000-0000-4000-8000-000000000001';

type AdminKind = 'manager' | 'publisher' | 'reader';
type StoreKind = 'beauty' | 'fashion';
type PricingBucket = 'COUPON' | 'ITEM' | 'ORDER';
type Benefit =
  | { maximum_discount_vnd: null; method: 'PERCENTAGE_BPS'; value: number }
  | { method: 'FIXED_VND'; value: number };
type PromotionView = {
  active_version: { id: string } | null;
  id: string;
  status: string;
  version: number;
};
type PromotionVersionView = {
  bucket: PricingBucket;
  id: string;
  localizations: Array<{ locale: string; name: string }>;
  status: string;
  targets: Array<{ target_id: string | null; target_type: string }>;
  version_number: number;
};

describe('M3.5 promotions, coupons and trusted pricing API', () => {
  loadEnvironment({ path: '.env.test.example', quiet: true, override: true });
  const config = parseRuntimeConfig();
  const owner = new PrismaClient({ datasourceUrl: config.DATABASE_URL });
  const runtime = createRuntimePrismaClient(config.DATABASE_RUNTIME_URL);
  const suffix = randomUUID().slice(0, 8);
  const fixture = {
    adminIds: {
      manager: randomUUID(),
      publisher: randomUUID(),
      reader: randomUUID(),
    } satisfies Record<AdminKind, string>,
    balanceId: randomUUID(),
    balanceSecondId: randomUUID(),
    beautyBrandId: randomUUID(),
    beautyProductId: randomUUID(),
    beautySkuId: randomUUID(),
    beautySecondSkuId: randomUUID(),
    fashionBrandId: randomUUID(),
    fashionMemberIds: [randomUUID(), randomUUID()] as const,
    fashionProductId: randomUUID(),
    memberIds: [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ] as const,
    roleIds: {
      manager: randomUUID(),
      publisher: randomUUID(),
      reader: randomUUID(),
    } satisfies Record<AdminKind, string>,
  };
  const adminTokens: Partial<Record<AdminKind, string>> = {};
  const memberTokens: Record<StoreKind, string[]> = { beauty: [], fashion: [] };
  const stores = {
    beauty: { code: 'beauty-local', id: BEAUTY_STORE_ID },
    fashion: { code: 'fashion-local', id: FASHION_STORE_ID },
  } as const;
  const skuCode = `m35-sku-${suffix}`;
  const secondSkuCode = `m35-sku-second-${suffix}`;
  const couponCode = `m35-coupon-${suffix}`;
  const inventoryOperationKey = `m35-stock-${suffix}`;
  let app: INestApplication;

  const api = () => request(app.getHttpServer() as Server);
  const adminToken = (kind: AdminKind) => {
    const token = adminTokens[kind];
    if (!token) throw new Error(`Missing ${kind} token`);
    return token;
  };
  const adminHeaders = (kind: AdminKind, store: StoreKind = 'beauty') => ({
    Authorization: `Bearer ${adminToken(kind)}`,
    'X-Store-Code': stores[store].code,
  });
  const adminPath = (path: string, store: StoreKind = 'beauty') =>
    `${path}?store_id=${stores[store].id}`;
  const memberHeaders = (index = 0, store: StoreKind = 'beauty') => {
    const token = memberTokens[store][index];
    if (!token) throw new Error(`Missing ${store} member token ${index}`);
    return { Authorization: `Bearer ${token}`, 'X-Store-Code': stores[store].code };
  };
  const versionInput = (input: {
    benefit: Benefit;
    bucket: PricingBucket;
    expectedVersion: number;
    label: string;
    stackableWith?: PricingBucket[];
    targets?: Array<{ target_id: string | null; target_type: string }>;
  }) => ({
    benefit: input.benefit,
    bucket: input.bucket,
    ends_at: null,
    expected_promotion_version: input.expectedVersion,
    localizations: [
      { description: `${input.label} vi`, locale: 'vi', name: `Ưu đãi ${input.label}` },
      { description: `${input.label} zh`, locale: 'zh', name: `${input.label}优惠` },
      { description: `${input.label} en`, locale: 'en', name: `${input.label} offer` },
    ],
    minimum_quantity: null,
    minimum_spend_vnd: null,
    priority: 10,
    stackable_with: input.stackableWith ?? [],
    starts_at: new Date(Date.now() - 60_000).toISOString(),
    targets: input.targets ?? [{ target_id: null, target_type: 'STORE' }],
  });

  async function createPublishedPromotion(input: {
    benefit: Benefit;
    bucket: PricingBucket;
    code: string;
    stackableWith: PricingBucket[];
    store?: StoreKind;
    targets?: Array<{ target_id: string | null; target_type: string }>;
  }): Promise<{ promotion: PromotionView; version: PromotionVersionView }> {
    const store = input.store ?? 'beauty';
    const created = await api()
      .post(adminPath('/v1/admin/promotions', store))
      .set(adminHeaders('manager', store))
      .send({ code: input.code })
      .expect(201);
    const promotion = created.body as PromotionView;
    const versionResponse = await api()
      .post(adminPath(`/v1/admin/promotions/${promotion.id}/versions`, store))
      .set(adminHeaders('manager', store))
      .send(
        versionInput({
          benefit: input.benefit,
          bucket: input.bucket,
          expectedVersion: promotion.version,
          label: input.code,
          stackableWith: input.stackableWith,
          targets: input.targets,
        }),
      )
      .expect(201);
    const version = versionResponse.body as PromotionVersionView;
    const published = await api()
      .post(adminPath(`/v1/admin/promotions/${promotion.id}/publish`, store))
      .set({
        ...adminHeaders('publisher', store),
        'Idempotency-Key': `m35:publish:${input.code}:${suffix}`,
      })
      .send({
        confirmation_code: 'PUBLISH',
        expected_promotion_version: promotion.version + 1,
        version_id: version.id,
      })
      .expect(200);
    return { promotion: published.body as PromotionView, version };
  }

  async function createActiveCoupon(input: {
    code: string;
    promotionVersionId: string;
    store?: StoreKind;
    totalClaimLimit: number;
  }): Promise<{ id: string; status: string; version: number }> {
    const store = input.store ?? 'beauty';
    const created = await api()
      .post(adminPath('/v1/admin/coupons', store))
      .set(adminHeaders('manager', store))
      .send({
        code: input.code,
        new_customer_only: false,
        per_member_claim_limit: 1,
        promotion_version_id: input.promotionVersionId,
        total_claim_limit: input.totalClaimLimit,
      })
      .expect(201);
    const coupon = created.body as { id: string; status: string; version: number };
    await api()
      .post(adminPath(`/v1/admin/coupons/${coupon.id}/status`, store))
      .set({
        ...adminHeaders('publisher', store),
        'Idempotency-Key': `m35:coupon:activate:${input.code}:${suffix}`,
      })
      .send({ confirmation_code: 'ACTIVATE', expected_version: 1, status: 'ACTIVE' })
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ status: 'ACTIVE', version: 2 }));
    return { ...coupon, status: 'ACTIVE', version: 2 };
  }

  beforeAll(async () => {
    await Promise.all([owner.$connect(), runtime.$connect()]);

    const permissionSets: Record<AdminKind, string[]> = {
      manager: ['store.promotions.read', 'store.promotions.manage'],
      publisher: ['store.promotions.read', 'store.promotions.manage', 'store.promotions.publish'],
      reader: ['store.promotions.read'],
    };
    for (const kind of ['reader', 'manager', 'publisher'] as const) {
      const adminId = fixture.adminIds[kind];
      const email = `m35-${kind}-${suffix}@example.test`;
      await owner.adminUser.create({
        data: {
          displayName: `M3.5 ${kind}`,
          email,
          emailNormalized: email,
          id: adminId,
          passwordHash: 'test-fixture-not-used',
        },
      });
      await owner.storeRole.create({
        data: {
          code: `m35-${kind}-${suffix}`,
          id: fixture.roleIds[kind],
          name: `M3.5 ${kind}`,
          permissions: {
            create: permissionSets[kind].map((permissionCode) => ({ permissionCode })),
          },
          storeId: BEAUTY_STORE_ID,
        },
      });
      await owner.adminStoreRole.create({
        data: {
          adminUserId: adminId,
          grantedBy: adminId,
          roleId: fixture.roleIds[kind],
          storeId: BEAUTY_STORE_ID,
        },
      });
      const session = await owner.adminSession.create({
        data: {
          adminUserId: adminId,
          expiresAt: new Date(Date.now() + 3_600_000),
          mfaVerifiedAt: new Date(),
          refreshTokenHash: hashSensitive(randomUUID(), config.PII_HASH_KEY),
          tokenFamilyId: randomUUID(),
        },
      });
      const timestamp = Math.floor(Date.now() / 1_000);
      adminTokens[kind] = signJwt(
        {
          actor_type: 'admin',
          aud: config.AUTH_JWT_AUDIENCE,
          exp: timestamp + 900,
          iat: timestamp,
          iss: config.AUTH_JWT_ISSUER,
          jti: randomUUID(),
          session_id: session.id,
          sub: adminId,
        },
        config.AUTH_JWT_SECRET,
      );
    }

    const fashionAdminRole = await owner.storeRole.findUniqueOrThrow({
      where: { storeId_code: { code: 'store-admin', storeId: FASHION_STORE_ID } },
    });
    await owner.adminStoreRole.createMany({
      data: (['manager', 'publisher'] as const).map((kind) => ({
        adminUserId: fixture.adminIds[kind],
        grantedBy: fixture.adminIds[kind],
        roleId: fashionAdminRole.id,
        storeId: FASHION_STORE_ID,
      })),
    });

    await owner.brand.createMany({
      data: [
        {
          code: `m35-beauty-${suffix}`,
          id: fixture.beautyBrandId,
          status: 'ACTIVE',
          storeId: BEAUTY_STORE_ID,
        },
        {
          code: `m35-fashion-${suffix}`,
          id: fixture.fashionBrandId,
          status: 'ACTIVE',
          storeId: FASHION_STORE_ID,
        },
      ],
    });
    await owner.product.createMany({
      data: [
        {
          attributeTemplateVersionId: BEAUTY_TEMPLATE_ID,
          brandId: fixture.beautyBrandId,
          code: `m35-product-${suffix}`,
          id: fixture.beautyProductId,
          mainCategoryId: BEAUTY_CATEGORY_ID,
          publishedAt: new Date(),
          status: 'PUBLISHED',
          storeId: BEAUTY_STORE_ID,
        },
        {
          attributeTemplateVersionId: FASHION_TEMPLATE_ID,
          brandId: fixture.fashionBrandId,
          code: `m35-sentinel-${suffix}`,
          id: fixture.fashionProductId,
          mainCategoryId: FASHION_CATEGORY_ID,
          publishedAt: new Date(),
          status: 'PUBLISHED',
          storeId: FASHION_STORE_ID,
        },
      ],
    });
    await owner.sku.createMany({
      data: [
        {
          code: skuCode,
          id: fixture.beautySkuId,
          optionCombinationHash: '5'.repeat(64),
          optionCombinationKey: `m35=${suffix}`,
          productId: fixture.beautyProductId,
          salePriceVnd: 100_001,
          storeId: BEAUTY_STORE_ID,
        },
        {
          code: secondSkuCode,
          id: fixture.beautySecondSkuId,
          optionCombinationHash: '6'.repeat(64),
          optionCombinationKey: `m35-second=${suffix}`,
          productId: fixture.beautyProductId,
          salePriceVnd: 50_002,
          storeId: BEAUTY_STORE_ID,
        },
      ],
    });
    await owner.inventoryBalance.createMany({
      data: [
        {
          id: fixture.balanceId,
          skuId: fixture.beautySkuId,
          storeId: BEAUTY_STORE_ID,
          warehouseId: BEAUTY_WAREHOUSE_ID,
        },
        {
          id: fixture.balanceSecondId,
          skuId: fixture.beautySecondSkuId,
          storeId: BEAUTY_STORE_ID,
          warehouseId: BEAUTY_WAREHOUSE_ID,
        },
      ],
    });
    await adjustInventory(
      runtime,
      createStoreContext({
        actor: { id: fixture.adminIds.publisher, type: 'admin' },
        correlationId: randomUUID(),
        locale: 'vi',
        storeCode: 'beauty-local',
        storeId: BEAUTY_STORE_ID,
      }),
      {
        items: [
          {
            delta: 10,
            expectedVersion: 1,
            reasonCode: 'M35_TEST_INITIAL_STOCK',
            skuId: fixture.beautySkuId,
            warehouseId: BEAUTY_WAREHOUSE_ID,
          },
          {
            delta: 10,
            expectedVersion: 1,
            reasonCode: 'M35_TEST_INITIAL_STOCK',
            skuId: fixture.beautySecondSkuId,
            warehouseId: BEAUTY_WAREHOUSE_ID,
          },
        ],
        operationKey: inventoryOperationKey,
        operationType: 'IMPORT',
      },
    );

    for (const group of [
      { ids: fixture.memberIds, store: 'beauty' as const },
      { ids: fixture.fashionMemberIds, store: 'fashion' as const },
    ]) {
      for (const [index, memberId] of group.ids.entries()) {
        const store = stores[group.store];
        await owner.member.create({
          data: {
            displayName: `M3.5 ${group.store} member ${index + 1}`,
            id: memberId,
            preferredLocale: 'vi',
            storeId: store.id,
          },
        });
        const session = await owner.memberSession.create({
          data: {
            expiresAt: new Date(Date.now() + 3_600_000),
            memberId,
            refreshTokenHash: hashSensitive(randomUUID(), config.PII_HASH_KEY),
            storeId: store.id,
            tokenFamilyId: randomUUID(),
          },
        });
        const timestamp = Math.floor(Date.now() / 1_000);
        memberTokens[group.store].push(
          signJwt(
            {
              actor_type: 'member',
              aud: config.AUTH_JWT_AUDIENCE,
              exp: timestamp + 900,
              iat: timestamp,
              iss: config.AUTH_JWT_ISSUER,
              jti: randomUUID(),
              session_id: session.id,
              store_id: store.id,
              sub: memberId,
            },
            config.AUTH_JWT_SECRET,
          ),
        );
      }
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
      const promotions = await transaction.promotion.findMany({
        select: { id: true },
        where: {
          code: { endsWith: suffix },
          storeId: { in: [BEAUTY_STORE_ID, FASHION_STORE_ID] },
        },
      });
      const promotionIds = promotions.map(({ id }) => id);
      const versions = await transaction.promotionVersion.findMany({
        select: { id: true },
        where: {
          promotionId: { in: promotionIds },
          storeId: { in: [BEAUTY_STORE_ID, FASHION_STORE_ID] },
        },
      });
      const versionIds = versions.map(({ id }) => id);
      const allMemberIds = [...fixture.memberIds, ...fixture.fashionMemberIds];
      await transaction.memberCoupon.deleteMany({
        where: { memberId: { in: allMemberIds } },
      });
      await transaction.coupon.deleteMany({
        where: {
          code: { endsWith: suffix },
          storeId: { in: [BEAUTY_STORE_ID, FASHION_STORE_ID] },
        },
      });
      await transaction.promotionOperation.deleteMany({
        where: { createdByAdminId: { in: Object.values(fixture.adminIds) } },
      });
      await transaction.promotionTarget.deleteMany({
        where: { promotionVersionId: { in: versionIds } },
      });
      await transaction.promotionVersionLocalization.deleteMany({
        where: { promotionVersionId: { in: versionIds } },
      });
      await transaction.promotionVersion.deleteMany({ where: { id: { in: versionIds } } });
      await transaction.promotion.deleteMany({ where: { id: { in: promotionIds } } });
      // Audit logs are append-only. Keep this test's audit history so cleanup
      // does not violate the same invariant enforced in production.
      await transaction.inventoryMovement.deleteMany({
        where: { balanceId: { in: [fixture.balanceId, fixture.balanceSecondId] } },
      });
      await transaction.inventoryOperation.deleteMany({
        where: { operationKey: inventoryOperationKey, storeId: BEAUTY_STORE_ID },
      });
      await transaction.inventoryBalance.deleteMany({
        where: { id: { in: [fixture.balanceId, fixture.balanceSecondId] } },
      });
      await transaction.sku.deleteMany({
        where: { id: { in: [fixture.beautySkuId, fixture.beautySecondSkuId] } },
      });
      await transaction.productSearchDocument.deleteMany({
        where: { productId: { in: [fixture.beautyProductId, fixture.fashionProductId] } },
      });
      await transaction.product.deleteMany({
        where: { id: { in: [fixture.beautyProductId, fixture.fashionProductId] } },
      });
      await transaction.brand.deleteMany({
        where: { id: { in: [fixture.beautyBrandId, fixture.fashionBrandId] } },
      });
      await transaction.memberSession.deleteMany({
        where: { memberId: { in: allMemberIds } },
      });
      await transaction.member.deleteMany({ where: { id: { in: allMemberIds } } });
      await transaction.adminStoreRole.deleteMany({
        where: { adminUserId: { in: Object.values(fixture.adminIds) } },
      });
      await transaction.storeRolePermission.deleteMany({
        where: { roleId: { in: Object.values(fixture.roleIds) } },
      });
      await transaction.storeRole.deleteMany({
        where: { id: { in: Object.values(fixture.roleIds) } },
      });
      await transaction.adminSession.deleteMany({
        where: { adminUserId: { in: Object.values(fixture.adminIds) } },
      });
      await transaction.adminUser.deleteMany({
        where: { id: { in: Object.values(fixture.adminIds) } },
      });
    });
    await Promise.all([runtime.$disconnect(), owner.$disconnect()]);
  });

  it('separates permissions and preserves localized published versions through lifecycle commands', async () => {
    await api().get(adminPath('/v1/admin/promotions')).set(adminHeaders('reader')).expect(200);
    const targetLookup = await api()
      .get(
        `${adminPath('/v1/admin/promotions/targets')}&target_type=PRODUCT&q=${encodeURIComponent(
          `m35-product-${suffix}`,
        )}`,
      )
      .set(adminHeaders('reader'))
      .expect(200);
    expect(targetLookup.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: `m35-product-${suffix}`, id: fixture.beautyProductId }),
      ]),
    );
    expect(targetLookup.body.items).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: fixture.fashionProductId })]),
    );
    await api()
      .post(adminPath('/v1/admin/promotions'))
      .set(adminHeaders('reader'))
      .send({ code: `m35-reader-denied-${suffix}` })
      .expect(403);

    const created = await api()
      .post(adminPath('/v1/admin/promotions'))
      .set(adminHeaders('manager'))
      .send({ code: `m35-lifecycle-${suffix}` })
      .expect(201);
    const promotion = created.body as PromotionView;
    expect(promotion).toMatchObject({ active_version: null, status: 'DRAFT', version: 1 });

    const draftPage = await api()
      .get(`${adminPath('/v1/admin/promotions')}&status=DRAFT`)
      .set(adminHeaders('reader'))
      .expect(200);
    expect(draftPage.body.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: promotion.id, status: 'DRAFT' })]),
    );
    expect(
      (draftPage.body.items as Array<{ status: string }>).every(({ status }) => status === 'DRAFT'),
    ).toBe(true);

    const draft = await api()
      .post(adminPath(`/v1/admin/promotions/${promotion.id}/versions`))
      .set(adminHeaders('manager'))
      .send(
        versionInput({
          benefit: { maximum_discount_vnd: null, method: 'PERCENTAGE_BPS', value: 1_000 },
          bucket: 'ITEM',
          expectedVersion: 1,
          label: 'lifecycle',
        }),
      )
      .expect(201);
    const version = draft.body as PromotionVersionView;
    expect(version.localizations.map(({ locale }) => locale).sort()).toEqual(['en', 'vi', 'zh']);
    expect(version.targets).toEqual([{ target_id: null, target_type: 'STORE' }]);
    expect(version).toMatchObject({ bucket: 'ITEM', status: 'DRAFT', version_number: 1 });

    const publishBody = {
      confirmation_code: 'PUBLISH',
      expected_promotion_version: 2,
      version_id: version.id,
    };
    await api()
      .post(adminPath(`/v1/admin/promotions/${promotion.id}/publish`))
      .set({ ...adminHeaders('manager'), 'Idempotency-Key': `m35:manager-denied:${suffix}` })
      .send(publishBody)
      .expect(403);

    const publishKey = `m35:lifecycle:publish:${suffix}`;
    const first = await api()
      .post(adminPath(`/v1/admin/promotions/${promotion.id}/publish`))
      .set({ ...adminHeaders('publisher'), 'Idempotency-Key': publishKey })
      .send(publishBody)
      .expect(200);
    expect(first.headers['idempotency-replayed']).toBe('false');
    expect(first.body).toMatchObject({
      active_version: { id: version.id },
      status: 'ACTIVE',
      version: 3,
    });

    const replay = await api()
      .post(adminPath(`/v1/admin/promotions/${promotion.id}/publish`))
      .set({ ...adminHeaders('publisher'), 'Idempotency-Key': publishKey })
      .send(publishBody)
      .expect(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.body).toEqual(first.body);
    await api()
      .post(adminPath(`/v1/admin/promotions/${promotion.id}/publish`))
      .set({ ...adminHeaders('publisher'), 'Idempotency-Key': publishKey })
      .send({ ...publishBody, expected_promotion_version: 3 })
      .expect(409);

    await expect(
      owner.promotionVersion.update({ data: { priority: 999 }, where: { id: version.id } }),
    ).rejects.toThrow();

    const paused = await api()
      .post(adminPath(`/v1/admin/promotions/${promotion.id}/pause`))
      .set({
        ...adminHeaders('publisher'),
        'Idempotency-Key': `m35:lifecycle:pause:${suffix}`,
      })
      .send({ confirmation_code: 'PAUSE', expected_promotion_version: 3 })
      .expect(200);
    expect(paused.body).toMatchObject({ status: 'PAUSED', version: 4 });

    const resumed = await api()
      .post(adminPath(`/v1/admin/promotions/${promotion.id}/publish`))
      .set({
        ...adminHeaders('publisher'),
        'Idempotency-Key': `m35:lifecycle:resume:${suffix}`,
      })
      .send({ ...publishBody, expected_promotion_version: 4 })
      .expect(200);
    expect(resumed.body).toMatchObject({ status: 'ACTIVE', version: 5 });

    const ended = await api()
      .post(adminPath(`/v1/admin/promotions/${promotion.id}/end`))
      .set({
        ...adminHeaders('publisher'),
        'Idempotency-Key': `m35:lifecycle:end:${suffix}`,
      })
      .send({ confirmation_code: 'END', expected_promotion_version: 5 })
      .expect(200);
    expect(ended.body).toMatchObject({ status: 'ENDED', version: 6 });

    const auditActions = (
      await owner.auditLog.findMany({
        select: { action: true },
        where: { targetId: promotion.id },
      })
    ).map(({ action }) => action);
    expect(auditActions).toEqual(
      expect.arrayContaining([
        'promotion.created',
        'promotion.published',
        'promotion.paused',
        'promotion.resumed',
        'promotion.ended',
      ]),
    );
  });

  it('returns one conflict, never a server error, for concurrent publishes with different keys', async () => {
    const created = await api()
      .post(adminPath('/v1/admin/promotions'))
      .set(adminHeaders('manager'))
      .send({ code: `m35-concurrent-publish-${suffix}` })
      .expect(201);
    const promotion = created.body as PromotionView;
    const versionResponse = await api()
      .post(adminPath(`/v1/admin/promotions/${promotion.id}/versions`))
      .set(adminHeaders('manager'))
      .send(
        versionInput({
          benefit: { method: 'FIXED_VND', value: 2_000 },
          bucket: 'ITEM',
          expectedVersion: 1,
          label: 'concurrent-publish',
        }),
      )
      .expect(201);
    const version = versionResponse.body as PromotionVersionView;
    const body = {
      confirmation_code: 'PUBLISH',
      expected_promotion_version: 2,
      version_id: version.id,
    };

    const responses = await Promise.all(
      ['first', 'second'].map((key) =>
        api()
          .post(adminPath(`/v1/admin/promotions/${promotion.id}/publish`))
          .set({
            ...adminHeaders('publisher'),
            'Idempotency-Key': `m35:concurrent:${key}:${suffix}`,
          })
          .send(body),
      ),
    );
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
    expect(responses.find(({ status }) => status === 409)?.body).toMatchObject({
      code: 'CONFLICT',
      details: { reason_code: 'VERSION_CONFLICT' },
    });
    expect(await owner.promotionOperation.count({ where: { targetId: promotion.id } })).toBe(1);
    expect(
      await owner.auditLog.count({
        where: { action: 'promotion.published', targetId: promotion.id },
      }),
    ).toBe(1);
  });

  it('replays concurrent identical publishes with one state change and audit fact', async () => {
    const created = await api()
      .post(adminPath('/v1/admin/promotions'))
      .set(adminHeaders('manager'))
      .send({ code: `m35-concurrent-replay-${suffix}` })
      .expect(201);
    const promotion = created.body as PromotionView;
    const draft = await api()
      .post(adminPath(`/v1/admin/promotions/${promotion.id}/versions`))
      .set(adminHeaders('manager'))
      .send(
        versionInput({
          benefit: { method: 'FIXED_VND', value: 2_500 },
          bucket: 'ITEM',
          expectedVersion: promotion.version,
          label: 'concurrent-replay',
        }),
      )
      .expect(201);
    const version = draft.body as PromotionVersionView;
    const body = {
      confirmation_code: 'PUBLISH',
      expected_promotion_version: 2,
      version_id: version.id,
    };
    const operationKey = `m35:concurrent-replay:${suffix}`;

    const responses = await Promise.all(
      Array.from({ length: 2 }, () =>
        api()
          .post(adminPath(`/v1/admin/promotions/${promotion.id}/publish`))
          .set({ ...adminHeaders('publisher'), 'Idempotency-Key': operationKey })
          .send(body),
      ),
    );

    expect(responses.map(({ status }) => status)).toEqual([200, 200]);
    expect(responses[0].body).toEqual(responses[1].body);
    expect(responses.map(({ headers }) => headers['idempotency-replayed']).sort()).toEqual([
      'false',
      'true',
    ]);
    expect(responses[0].body).toMatchObject({ status: 'ACTIVE', version: 3 });
    expect(
      await owner.promotionOperation.count({
        where: { operationKey, storeId: BEAUTY_STORE_ID, targetId: promotion.id },
      }),
    ).toBe(1);
    expect(
      await owner.auditLog.count({
        where: { action: 'promotion.published', targetId: promotion.id },
      }),
    ).toBe(1);
    expect(
      await owner.promotion.findUniqueOrThrow({
        select: { activeVersionId: true, status: true, version: true },
        where: { id: promotion.id },
      }),
    ).toEqual({ activeVersionId: version.id, status: 'ACTIVE', version: 3 });
  });

  it('rejects a promotion target owned by another store without creating a version', async () => {
    const created = await api()
      .post(adminPath('/v1/admin/promotions'))
      .set(adminHeaders('manager'))
      .send({ code: `m35-cross-store-${suffix}` })
      .expect(201);
    const promotion = created.body as PromotionView;
    await api()
      .post(adminPath(`/v1/admin/promotions/${promotion.id}/versions`))
      .set(adminHeaders('manager'))
      .send(
        versionInput({
          benefit: { method: 'FIXED_VND', value: 1_000 },
          bucket: 'ITEM',
          expectedVersion: 1,
          label: 'cross-store',
          targets: [{ target_id: fixture.fashionProductId, target_type: 'PRODUCT' }],
        }),
      )
      .expect(404);
    expect(await owner.promotionVersion.count({ where: { promotionId: promotion.id } })).toBe(0);
  });

  it('does not recursively apply a parent CATEGORY target to a descendant category', async () => {
    const code = `m35-parent-category-${suffix}`;
    await createPublishedPromotion({
      benefit: { method: 'FIXED_VND', value: 9_000 },
      bucket: 'ITEM',
      code,
      stackableWith: [],
      targets: [{ target_id: BEAUTY_ROOT_CATEGORY_ID, target_type: 'CATEGORY' }],
    });

    const quote = await api()
      .post('/v1/pricing/quotes')
      .set(adminHeaders('reader'))
      .send({ coupon_code: null, items: [{ quantity: 1, sku_code: skuCode }], locale: 'vi' })
      .expect(200);

    expect(quote.body.applied_rules).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code })]),
    );
    expect(quote.body.rejected_rules).toEqual(
      expect.arrayContaining([expect.objectContaining({ code, reason: 'TARGET_MISMATCH' })]),
    );
    expect(quote.body.lines[0].rejected_rules).toEqual(
      expect.arrayContaining([expect.objectContaining({ code, reason: 'TARGET_MISMATCH' })]),
    );
  });

  it('limits concurrent multi-member claims to the remaining coupon quota', async () => {
    const rule = await createPublishedPromotion({
      benefit: { method: 'FIXED_VND', value: 5_000 },
      bucket: 'COUPON',
      code: `m35-quota-rule-${suffix}`,
      stackableWith: [],
    });
    const code = `m35-quota-coupon-${suffix}`;
    const coupon = await createActiveCoupon({
      code,
      promotionVersionId: rule.version.id,
      totalClaimLimit: 3,
    });

    await api().put(`/v1/members/me/coupons/by-code/${code}`).set(memberHeaders(0)).expect(200);
    const contenders = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((index) =>
        api().put(`/v1/members/me/coupons/by-code/${code}`).set(memberHeaders(index)),
      ),
    );
    const successful = contenders.filter(({ status }) => status === 200);
    const rejected = contenders.filter(({ status }) => status === 409);

    expect(successful).toHaveLength(2);
    expect(rejected).toHaveLength(4);
    for (const response of rejected) {
      expect(response.body).toMatchObject({
        code: 'CONFLICT',
        details: { reason_code: 'COUPON_CLAIM_LIMIT' },
      });
    }
    const factCount = await owner.memberCoupon.count({ where: { couponId: coupon.id } });
    const persisted = await owner.coupon.findUniqueOrThrow({
      select: { claimedCount: true, totalClaimLimit: true },
      where: { id: coupon.id },
    });
    expect(factCount).toBe(3);
    expect(persisted).toEqual({ claimedCount: factCount, totalClaimLimit: 3 });
  });

  it('isolates same-code coupon quotas and member rate buckets by store', async () => {
    const ruleCode = `m35-isolated-rule-${suffix}`;
    const couponIsolationCode = `m35-isolated-coupon-${suffix}`;
    const [beautyRule, fashionRule] = await Promise.all([
      createPublishedPromotion({
        benefit: { method: 'FIXED_VND', value: 3_000 },
        bucket: 'COUPON',
        code: ruleCode,
        stackableWith: [],
      }),
      createPublishedPromotion({
        benefit: { method: 'FIXED_VND', value: 3_000 },
        bucket: 'COUPON',
        code: ruleCode,
        stackableWith: [],
        store: 'fashion',
      }),
    ]);
    const [beautyCoupon, fashionCoupon] = await Promise.all([
      createActiveCoupon({
        code: couponIsolationCode,
        promotionVersionId: beautyRule.version.id,
        totalClaimLimit: 1,
      }),
      createActiveCoupon({
        code: couponIsolationCode,
        promotionVersionId: fashionRule.version.id,
        store: 'fashion',
        totalClaimLimit: 1,
      }),
    ]);

    await api()
      .put(`/v1/members/me/coupons/by-code/${couponIsolationCode}`)
      .set(memberHeaders(0, 'beauty'))
      .expect(200);
    await api()
      .put(`/v1/members/me/coupons/by-code/${couponIsolationCode}`)
      .set(memberHeaders(1, 'beauty'))
      .expect(409);
    await api()
      .put(`/v1/members/me/coupons/by-code/${couponIsolationCode}`)
      .set(memberHeaders(0, 'fashion'))
      .expect(200);
    await api()
      .put(`/v1/members/me/coupons/by-code/${couponIsolationCode}`)
      .set(memberHeaders(1, 'fashion'))
      .expect(409);

    const coupons = await owner.coupon.findMany({
      select: { claimedCount: true, id: true, storeId: true },
      where: { id: { in: [beautyCoupon.id, fashionCoupon.id] } },
    });
    expect(coupons).toEqual(
      expect.arrayContaining([
        { claimedCount: 1, id: beautyCoupon.id, storeId: BEAUTY_STORE_ID },
        { claimedCount: 1, id: fashionCoupon.id, storeId: FASHION_STORE_ID },
      ]),
    );
    expect(
      await owner.memberCoupon.groupBy({
        by: ['storeId'],
        _count: { _all: true },
        where: { couponId: { in: [beautyCoupon.id, fashionCoupon.id] } },
      }),
    ).toEqual(
      expect.arrayContaining([
        { _count: { _all: 1 }, storeId: BEAUTY_STORE_ID },
        { _count: { _all: 1 }, storeId: FASHION_STORE_ID },
      ]),
    );

    const { SearchRateLimiter } = await import('../../apps/api/src/search/search-rate-limiter');
    const limiter = new SearchRateLimiter({
      ...config,
      SEARCH_RATE_LIMIT_MAX_REQUESTS: 10,
      SEARCH_RATE_LIMIT_WINDOW_SECONDS: 10,
    });
    const address = `m35-rate-${randomUUID()}`;
    const memberA = randomUUID();
    const memberB = randomUUID();
    try {
      for (let requestNumber = 0; requestNumber < 10; requestNumber += 1) {
        await limiter.assertAllowed(address, 'coupon-claim', BEAUTY_STORE_ID, memberA);
      }
      await expect(
        limiter.assertAllowed(address, 'coupon-claim', BEAUTY_STORE_ID, memberA),
      ).rejects.toMatchObject({ status: 429 });
      await expect(
        limiter.assertAllowed(address, 'coupon-claim', FASHION_STORE_ID, memberA),
      ).resolves.toBeUndefined();
      await expect(
        limiter.assertAllowed(address, 'coupon-claim', BEAUTY_STORE_ID, memberB),
      ).resolves.toBeUndefined();
    } finally {
      limiter.onApplicationShutdown();
    }
  });

  it('claims a limited coupon concurrently and prices trusted facts without side effects', async () => {
    const item = await createPublishedPromotion({
      benefit: { maximum_discount_vnd: null, method: 'PERCENTAGE_BPS', value: 1_000 },
      bucket: 'ITEM',
      code: `m35-item-${suffix}`,
      stackableWith: ['COUPON', 'ORDER'],
    });
    const couponPromotion = await createPublishedPromotion({
      benefit: { maximum_discount_vnd: null, method: 'PERCENTAGE_BPS', value: 1_000 },
      bucket: 'COUPON',
      code: `m35-coupon-rule-${suffix}`,
      stackableWith: ['ITEM', 'ORDER'],
    });
    const order = await createPublishedPromotion({
      benefit: { method: 'FIXED_VND', value: 1_000 },
      bucket: 'ORDER',
      code: `m35-order-${suffix}`,
      stackableWith: ['ITEM', 'COUPON'],
    });
    expect([
      item.promotion.status,
      couponPromotion.promotion.status,
      order.promotion.status,
    ]).toEqual(['ACTIVE', 'ACTIVE', 'ACTIVE']);

    const createdCoupon = await api()
      .post(adminPath('/v1/admin/coupons'))
      .set(adminHeaders('manager'))
      .send({
        code: couponCode,
        new_customer_only: false,
        per_member_claim_limit: 1,
        promotion_version_id: couponPromotion.version.id,
        total_claim_limit: 1,
      })
      .expect(201);
    const coupon = createdCoupon.body as { id: string; status: string; version: number };
    expect(coupon).toMatchObject({ status: 'DRAFT', version: 1 });
    await api()
      .post(adminPath(`/v1/admin/coupons/${coupon.id}/status`))
      .set({
        ...adminHeaders('publisher'),
        'Idempotency-Key': `m35:coupon:activate:${suffix}`,
      })
      .send({ confirmation_code: 'ACTIVATE', expected_version: 1, status: 'ACTIVE' })
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ status: 'ACTIVE', version: 2 }));
    await expect(
      owner.coupon.update({ data: { totalClaimLimit: 2 }, where: { id: coupon.id } }),
    ).rejects.toThrow();

    const claims = await Promise.all([
      api().put(`/v1/members/me/coupons/by-code/${couponCode}`).set(memberHeaders(0)),
      api().put(`/v1/members/me/coupons/by-code/${couponCode}`).set(memberHeaders(0)),
    ]);
    expect(claims.map(({ status }) => status)).toEqual([200, 200]);
    expect(claims[0].body.id).toBe(claims[1].body.id);
    expect(
      await owner.memberCoupon.count({
        where: { couponId: coupon.id, memberId: fixture.memberIds[0] },
      }),
    ).toBe(1);
    expect(
      await owner.coupon.findUniqueOrThrow({
        select: { claimedCount: true },
        where: { id: coupon.id },
      }),
    ).toEqual({ claimedCount: 1 });
    await api()
      .put(`/v1/members/me/coupons/by-code/${couponCode}`)
      .set(memberHeaders(1))
      .expect(409);

    await api()
      .post(adminPath(`/v1/admin/coupons/${coupon.id}/status`))
      .set({
        ...adminHeaders('publisher'),
        'Idempotency-Key': `m35:coupon:pause:${suffix}`,
      })
      .send({ confirmation_code: 'PAUSE', expected_version: 2, status: 'PAUSED' })
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ status: 'PAUSED', version: 3 }));
    await api()
      .get('/v1/members/me/coupons')
      .set(memberHeaders(0))
      .expect(200)
      .expect(({ body }) =>
        expect(body.items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: couponCode, status: 'DISABLED' }),
          ]),
        ),
      );
    await api()
      .post('/v1/pricing/quotes')
      .set(memberHeaders(0))
      .send({ coupon_code: couponCode, items: [{ quantity: 1, sku_code: skuCode }], locale: 'vi' })
      .expect(409);
    await api()
      .post(adminPath(`/v1/admin/coupons/${coupon.id}/status`))
      .set({
        ...adminHeaders('publisher'),
        'Idempotency-Key': `m35:coupon:resume:${suffix}`,
      })
      .send({ confirmation_code: 'ACTIVATE', expected_version: 3, status: 'ACTIVE' })
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ status: 'ACTIVE', version: 4 }));
    await api()
      .put(`/v1/members/me/coupons/by-code/${couponCode}`)
      .set(memberHeaders(0))
      .expect(200)
      .expect(({ body }) =>
        expect(body).toMatchObject({ id: claims[0].body.id, status: 'CLAIMED' }),
      );

    await api()
      .post('/v1/pricing/quotes')
      .set('X-Store-Code', 'beauty-local')
      .send({ coupon_code: couponCode, items: [{ quantity: 1, sku_code: skuCode }], locale: 'vi' })
      .expect(401);
    await api()
      .post('/v1/pricing/quotes')
      .set({ ...memberHeaders(0, 'beauty'), 'X-Store-Code': 'fashion-local' })
      .send({ coupon_code: couponCode, items: [{ quantity: 1, sku_code: skuCode }], locale: 'vi' })
      .expect(401);

    const balanceBefore = await owner.inventoryBalance.findUniqueOrThrow({
      select: { onHand: true, reserved: true, version: true },
      where: { id: fixture.balanceId },
    });
    const reservationsBefore = await owner.inventoryReservationItem.count({
      where: { skuId: fixture.beautySkuId },
    });
    const quote = await api()
      .post('/v1/pricing/quotes')
      .set(memberHeaders(0))
      .send({ coupon_code: couponCode, items: [{ quantity: 1, sku_code: skuCode }], locale: 'vi' });
    expect.soft(quote.status).toBe(200);
    expect(quote.body).toMatchObject({
      base_subtotal_vnd: 100_001,
      currency: 'VND',
      discount_vnd: 20_000,
      merchandise_payable_vnd: 80_001,
      order_payable_vnd: null,
      shipping_qualification: { candidates: [], status: 'NOT_REQUESTED' },
    });
    expect(quote.body.quote_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(Date.parse(quote.body.quoted_at as string)).not.toBeNaN();
    expect(quote.body.applied_rules).toEqual([
      expect.objectContaining({ bucket: 'ITEM', discount_vnd: 10_000 }),
      expect.objectContaining({ bucket: 'COUPON', code: couponCode, discount_vnd: 9_000 }),
      expect.objectContaining({ bucket: 'ORDER', discount_vnd: 1_000 }),
    ]);
    expect(quote.body.lines).toEqual([
      expect.objectContaining({
        base_subtotal_vnd: 100_001,
        base_unit_price_vnd: 100_001,
        discount_vnd: 20_000,
        issues: [],
        payable_vnd: 80_001,
        quantity: 1,
        sku_code: skuCode,
      }),
    ]);

    const multiLineQuote = await api()
      .post('/v1/pricing/quotes')
      .set(memberHeaders(0))
      .send({
        coupon_code: couponCode,
        items: [
          { quantity: 1, sku_code: skuCode },
          { quantity: 1, sku_code: secondSkuCode },
        ],
        locale: 'vi',
      })
      .expect(200);
    expect(multiLineQuote.body).toMatchObject({
      base_subtotal_vnd: 150_003,
      discount_vnd: 29_500,
      merchandise_payable_vnd: 120_503,
    });
    expect(multiLineQuote.body.lines).toEqual([
      expect.objectContaining({
        discount_vnd: 19_667,
        payable_vnd: 80_334,
        sku_code: skuCode,
      }),
      expect.objectContaining({
        discount_vnd: 9_833,
        payable_vnd: 40_169,
        sku_code: secondSkuCode,
      }),
    ]);

    const memberCouponFactsBeforePreview = await owner.memberCoupon.count({
      where: { couponId: coupon.id },
    });
    const adminPreview = await api()
      .post('/v1/pricing/quotes')
      .set(adminHeaders('reader'))
      .send({ coupon_code: couponCode, items: [{ quantity: 1, sku_code: skuCode }], locale: 'vi' })
      .expect(200);
    expect(adminPreview.body).toMatchObject({
      merchandise_payable_vnd: 80_001,
      order_payable_vnd: null,
    });
    expect(await owner.memberCoupon.count({ where: { couponId: coupon.id } })).toBe(
      memberCouponFactsBeforePreview,
    );

    expect(
      await owner.inventoryBalance.findUniqueOrThrow({
        select: { onHand: true, reserved: true, version: true },
        where: { id: fixture.balanceId },
      }),
    ).toEqual(balanceBefore);
    expect(
      await owner.inventoryReservationItem.count({ where: { skuId: fixture.beautySkuId } }),
    ).toBe(reservationsBefore);
    expect(
      await owner.memberCoupon.findUniqueOrThrow({
        select: { status: true },
        where: {
          storeId_couponId_memberId: {
            couponId: coupon.id,
            memberId: fixture.memberIds[0],
            storeId: BEAUTY_STORE_ID,
          },
        },
      }),
    ).toEqual({ status: 'CLAIMED' });
    expect(
      await owner.coupon.findUniqueOrThrow({
        select: { claimedCount: true },
        where: { id: coupon.id },
      }),
    ).toEqual({ claimedCount: 1 });
  });

  it('rejects client amount injection with strict quote DTOs', async () => {
    await api()
      .post('/v1/pricing/quotes')
      .set('X-Store-Code', 'beauty-local')
      .send({
        coupon_code: null,
        items: [{ base_unit_price_vnd: 1, quantity: 1, sku_code: skuCode }],
        locale: 'vi',
        merchandise_payable_vnd: 1,
      })
      .expect(400);

    await api()
      .post(adminPath('/v1/admin/coupons'))
      .set(adminHeaders('manager'))
      .send({
        code: `m35-overflow-${suffix}`,
        new_customer_only: false,
        per_member_claim_limit: 1,
        promotion_version_id: randomUUID(),
        total_claim_limit: 2_147_483_648,
      })
      .expect(400);
  });

  it('binds the quote hash to inventory fact versions at one database time', async () => {
    const { PricingService } = await import('../../apps/api/src/pricing/pricing.service');
    const pricing = app.get(PricingService);
    const result = await owner.$transaction(async (transaction) => {
      const input = {
        adminPreview: true,
        member: undefined,
        request: {
          coupon_code: null,
          items: [{ quantity: 1, sku_code: skuCode }],
          locale: 'vi' as const,
        },
        storeId: BEAUTY_STORE_ID,
      };
      const before = await pricing.quoteMerchandise(transaction, input);
      await transaction.inventoryBalance.update({
        data: { version: { increment: 1 } },
        where: { id: fixture.balanceId },
      });
      const after = await pricing.quoteMerchandise(transaction, input);
      return { after, before };
    });
    expect(result.after.quoted_at).toBe(result.before.quoted_at);
    expect(result.after.base_subtotal_vnd).toBe(result.before.base_subtotal_vnd);
    expect(result.after.merchandise_payable_vnd).toBe(result.before.merchandise_payable_vnd);
    expect(result.after.quote_hash).not.toBe(result.before.quote_hash);
  });

  it('maps an otherwise valid line subtotal overflow to a safe client error', async () => {
    await owner.sku.update({
      data: { salePriceVnd: BigInt(Number.MAX_SAFE_INTEGER) },
      where: { id: fixture.beautySkuId },
    });
    try {
      await api()
        .post('/v1/pricing/quotes')
        .set('X-Store-Code', 'beauty-local')
        .send({ coupon_code: null, items: [{ quantity: 2, sku_code: skuCode }], locale: 'vi' })
        .expect(400)
        .expect(({ body }) => expect(body).toMatchObject({ code: 'INPUT_INVALID' }));
    } finally {
      await owner.sku.update({
        data: { salePriceVnd: 100_001 },
        where: { id: fixture.beautySkuId },
      });
    }
  });
});
