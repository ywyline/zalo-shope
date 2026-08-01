import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { config as loadEnvironment } from 'dotenv';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseRuntimeConfig } from '@zalo-shop/config';
import type {
  AfterSaleCommandAcknowledgementResponse,
  AfterSalePolicyContent,
} from '@zalo-shop/contracts';
import { canonicalAfterSalePolicyHash, PrismaClient } from '@zalo-shop/database';
import { signJwt } from '@zalo-shop/security';

const STORE_SUFFIX = randomUUID().slice(0, 8);
const BEAUTY_STORE_ID = randomUUID();
const BEAUTY_STORE_CODE = `m63b3-api-beauty-${STORE_SUFFIX}`;
const FASHION_STORE_ID = randomUUID();
const FASHION_STORE_CODE = `m63b3-api-fashion-${STORE_SUFFIX}`;

describe.sequential('M6.3-B3 after-sale command API', () => {
  loadEnvironment({ path: '.env.test.example', quiet: true, override: true });
  const config = parseRuntimeConfig();
  const owner = new PrismaClient({ datasourceUrl: config.DATABASE_URL });
  const suffix = randomUUID().slice(0, 8);
  const fixture = {
    adminId: randomUUID(),
    adminSessionId: randomUUID(),
    assignmentId: randomUUID(),
    beautyRoleId: randomUUID(),
    brandId: randomUUID(),
    categoryId: randomUUID(),
    fashionRoleId: randomUUID(),
    memberId: randomUUID(),
    memberSessionId: randomUUID(),
    orderId: randomUUID(),
    orderItemId: randomUUID(),
    otherMemberId: randomUUID(),
    otherMemberSessionId: randomUUID(),
    paymentAttemptId: randomUUID(),
    paymentChannelId: randomUUID(),
    platformRoleId: randomUUID(),
    policyId: randomUUID(),
    policyVersionId: randomUUID(),
    productId: randomUUID(),
    shipmentId: randomUUID(),
    shippingChannelId: randomUUID(),
    shipmentItemId: randomUUID(),
    skuId: randomUUID(),
    warehouseId: randomUUID(),
  } as const;
  const description = 'The delivered item has a verified manufacturing defect.';
  const memberCreateIdempotencyKey = `m63b3-member-create-${suffix}`;
  const policy: AfterSalePolicyContent = {
    allowed_types: ['MERCHANT_REFUND', 'REFUND_ONLY', 'RETURN_REFUND'],
    category_id: null,
    condition_rules: {
      allowed_reason_codes: ['defective-item', 'merchant-refund'],
      evidence_required: false,
      evidence_required_reason_codes: [],
      opened_package_exception_reason_codes: [],
    },
    damaged_exception: true,
    defect_exception: true,
    exchange_attribute_code: null,
    exchange_same_product_only: true,
    hygiene_restricted: false,
    localizations: [
      {
        buyer_instructions: 'Gửi sản phẩm theo hướng dẫn sau khi yêu cầu được duyệt.',
        locale: 'vi',
        name: 'Chính sách hậu mãi B3',
        summary: 'Chính sách thử nghiệm cục bộ B3.',
      },
      {
        buyer_instructions: '请在申请获批后按指引寄回商品。',
        locale: 'zh',
        name: 'B3 售后政策',
        summary: 'B3 本地测试政策。',
      },
      {
        buyer_instructions: 'Return the item after the request is approved.',
        locale: 'en',
        name: 'B3 after-sale policy',
        summary: 'B3 local test policy.',
      },
    ],
    product_ids: [fixture.productId],
    request_window_days: 30,
    return_shipping_payer: 'MERCHANT',
    return_window_days: 7,
    unopened_required: false,
    wrong_item_exception: true,
  };
  const policyHash = canonicalAfterSalePolicyHash(policy);
  let app: INestApplication;
  let adminToken: string;
  let memberToken: string;
  let otherMemberToken: string;
  let limiterRedis: { del(...keys: string[]): Promise<number> };
  let memberCreateAcknowledgement: AfterSaleCommandAcknowledgementResponse;

  const api = () => request(app.getHttpServer() as Server);
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const memberHeaders = (token = memberToken, storeCode = BEAUTY_STORE_CODE) => ({
    Authorization: `Bearer ${token}`,
    'X-Store-Code': storeCode,
  });
  const adminHeaders = (storeCode = BEAUTY_STORE_CODE) => ({
    Authorization: `Bearer ${adminToken}`,
    'X-Store-Code': storeCode,
  });
  const memberBody = (quantity = 1, type: 'REFUND_ONLY' | 'RETURN_REFUND' = 'REFUND_ONLY') => ({
    description,
    evidence_ids: [],
    items: [{ order_item_id: fixture.orderItemId, quantity }],
    order_id: fixture.orderId,
    reason_code: 'defective-item',
    type,
  });

  function accessToken(input: {
    actorType: 'admin' | 'member';
    sessionId: string;
    storeId?: string;
    subjectId: string;
  }): string {
    const now = Math.floor(Date.now() / 1_000);
    return signJwt(
      {
        actor_type: input.actorType,
        aud: config.AUTH_JWT_AUDIENCE,
        exp: now + 900,
        iat: now,
        iss: config.AUTH_JWT_ISSUER,
        jti: randomUUID(),
        session_id: input.sessionId,
        ...(input.storeId === undefined ? {} : { store_id: input.storeId }),
        sub: input.subjectId,
      },
      config.AUTH_JWT_SECRET,
    );
  }

  function rateLimitKey(
    actorType: 'ADMIN' | 'MEMBER',
    actorId: string,
    storeId: string,
    windowOffset = 0,
  ): string {
    const window = Math.floor(Date.now() / 60_000) + windowOffset;
    const identity = createHmac('sha256', config.PII_HASH_KEY)
      .update(`${actorType}:${actorId}`)
      .digest('hex');
    return `${config.NODE_ENV}:${storeId}:after-sale-write:${actorType.toLowerCase()}:${identity}:${window}`;
  }

  beforeAll(async () => {
    if (
      !config.AFTER_SALE_COMMANDS_ENABLED ||
      !config.AFTER_SALE_RETURN_COMMANDS_ENABLED ||
      config.NODE_ENV !== 'test'
    ) {
      throw new Error('M6.3-B3 local/test command configuration is not enabled');
    }
    await owner.$connect();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1_000);
    const deliveredAt = new Date(Date.now() - 24 * 60 * 60 * 1_000);

    await owner.$transaction(async (transaction) => {
      await transaction.store.createMany({
        data: [
          {
            code: BEAUTY_STORE_CODE,
            defaultLocale: 'vi',
            id: BEAUTY_STORE_ID,
            industry: 'BEAUTY',
          },
          {
            code: FASHION_STORE_CODE,
            defaultLocale: 'vi',
            id: FASHION_STORE_ID,
            industry: 'FASHION',
          },
        ],
      });
      const miniAppId = `m63b3-api-app-${suffix}`;
      await transaction.storeZaloApp.create({
        data: {
          enabled: true,
          environment: 'TEST',
          miniAppId,
          parentAppId: `m63b3-api-parent-${suffix}`,
          storeId: BEAUTY_STORE_ID,
        },
      });
      await transaction.storePaymentChannel.create({
        data: {
          checkoutAppId: miniAppId,
          deploymentEnvironment: 'TEST',
          id: fixture.paymentChannelId,
          keyVersion: 'test-v1',
          merchantReference: `m63b3-api-merchant-${suffix}`,
          methodCode: 'ZALOPAY_SANDBOX',
          paymentWindowSeconds: 600,
          privateKeySecretRef: `test://m63b3-api/${suffix}/payment-key`,
          providerCode: 'ZALO_CHECKOUT_ZALOPAY',
          providerEnvironment: 'SANDBOX',
          secretFingerprint: digest(`payment-channel-${suffix}`),
          status: 'ACTIVE',
          storeId: BEAUTY_STORE_ID,
        },
      });
      await transaction.storeShippingChannel.create({
        data: {
          defaultServiceCode: 'LOCAL_TEST',
          id: fixture.shippingChannelId,
          keyVersion: 'test-v1',
          originAllowlistKey: 'GHN_SANDBOX',
          providerCode: 'GHN',
          providerEnvironment: 'SANDBOX',
          secretFingerprint: digest(`shipping-channel-${suffix}`),
          shopId: `m63b3-api-${suffix}`,
          status: 'ACTIVE',
          storeId: BEAUTY_STORE_ID,
          tokenSecretRef: `test://m63b3-api/${suffix}/shipping-token`,
        },
      });
      await transaction.warehouse.create({
        data: {
          code: `m63b3-api-warehouse-${suffix}`,
          id: fixture.warehouseId,
          isDefaultFulfillment: true,
          storeId: BEAUTY_STORE_ID,
        },
      });
      await transaction.adminUser.create({
        data: {
          displayName: 'M6.3-B3 API reviewer',
          email: `m63b3-api-${suffix}@example.invalid`,
          emailNormalized: `m63b3-api-${suffix}@example.invalid`,
          id: fixture.adminId,
          passwordHash: 'test-fixture-not-a-login-hash',
        },
      });
      await transaction.member.createMany({
        data: [
          { id: fixture.memberId, preferredLocale: 'en', storeId: BEAUTY_STORE_ID },
          { id: fixture.otherMemberId, preferredLocale: 'vi', storeId: BEAUTY_STORE_ID },
        ],
      });
      await transaction.memberSession.createMany({
        data: [
          {
            expiresAt,
            id: fixture.memberSessionId,
            memberId: fixture.memberId,
            refreshTokenHash: digest(`member-session-${fixture.memberId}`),
            storeId: BEAUTY_STORE_ID,
            tokenFamilyId: randomUUID(),
          },
          {
            expiresAt,
            id: fixture.otherMemberSessionId,
            memberId: fixture.otherMemberId,
            refreshTokenHash: digest(`member-session-${fixture.otherMemberId}`),
            storeId: BEAUTY_STORE_ID,
            tokenFamilyId: randomUUID(),
          },
        ],
      });
      await transaction.adminSession.create({
        data: {
          adminUserId: fixture.adminId,
          expiresAt,
          id: fixture.adminSessionId,
          mfaVerifiedAt: new Date(),
          refreshTokenHash: digest(`admin-session-${fixture.adminId}`),
          tokenFamilyId: randomUUID(),
        },
      });
      await transaction.platformRole.create({
        data: {
          code: `m63b3-cross-store-${suffix}`,
          id: fixture.platformRoleId,
          name: 'M6.3-B3 audited cross-store access',
        },
      });
      await transaction.platformRolePermission.create({
        data: {
          permissionCode: 'platform.stores.cross_access',
          platformRoleId: fixture.platformRoleId,
        },
      });
      await transaction.adminPlatformRole.create({
        data: {
          adminUserId: fixture.adminId,
          grantedBy: fixture.adminId,
          platformRoleId: fixture.platformRoleId,
        },
      });
      await transaction.storeRole.createMany({
        data: [
          {
            code: `m63b3-review-beauty-${suffix}`,
            id: fixture.beautyRoleId,
            name: 'M6.3-B3 beauty reviewer',
            storeId: BEAUTY_STORE_ID,
          },
          {
            code: `m63b3-review-fashion-${suffix}`,
            id: fixture.fashionRoleId,
            name: 'M6.3-B3 fashion reviewer',
            storeId: FASHION_STORE_ID,
          },
        ],
      });
      await transaction.storeRolePermission.createMany({
        data: [
          {
            permissionCode: 'store.after-sales.review',
            roleId: fixture.beautyRoleId,
            storeId: BEAUTY_STORE_ID,
          },
          {
            permissionCode: 'store.after-sales.review',
            roleId: fixture.fashionRoleId,
            storeId: FASHION_STORE_ID,
          },
        ],
      });
      await transaction.adminStoreRole.createMany({
        data: [
          {
            adminUserId: fixture.adminId,
            grantedBy: fixture.adminId,
            roleId: fixture.beautyRoleId,
            storeId: BEAUTY_STORE_ID,
          },
          {
            adminUserId: fixture.adminId,
            grantedBy: fixture.adminId,
            roleId: fixture.fashionRoleId,
            storeId: FASHION_STORE_ID,
          },
        ],
      });
      await transaction.category.create({
        data: {
          code: `m63b3-category-${suffix}`,
          depth: 1,
          id: fixture.categoryId,
          storeId: BEAUTY_STORE_ID,
        },
      });
      await transaction.brand.create({
        data: {
          code: `m63b3-brand-${suffix}`,
          id: fixture.brandId,
          storeId: BEAUTY_STORE_ID,
        },
      });
      await transaction.product.create({
        data: {
          brandId: fixture.brandId,
          code: `m63b3-product-${suffix}`,
          id: fixture.productId,
          mainCategoryId: fixture.categoryId,
          status: 'PUBLISHED',
          storeId: BEAUTY_STORE_ID,
        },
      });
      await transaction.sku.create({
        data: {
          code: `m63b3-sku-${suffix}`,
          id: fixture.skuId,
          optionCombinationHash: digest(`m63b3-sku-${suffix}`),
          optionCombinationKey: `m63b3=${suffix}`,
          productId: fixture.productId,
          salePriceVnd: 100_000,
          storeId: BEAUTY_STORE_ID,
        },
      });
      await transaction.$executeRaw`
        SELECT
          set_config('app.store_id', ${BEAUTY_STORE_ID}, true),
          set_config('app.actor_id', ${fixture.adminId}, true),
          set_config('app.actor_type', 'admin', true),
          set_config('app.correlation_id', ${`m63b3-api-fixture-${suffix}`}, true)
      `;
      await transaction.afterSalePolicy.create({
        data: {
          code: `m63b3-policy-${suffix}`,
          createdBy: fixture.adminId,
          draftHash: policyHash,
          draftPayload: policy,
          id: fixture.policyId,
          storeId: BEAUTY_STORE_ID,
          updatedBy: fixture.adminId,
        },
      });
      await transaction.afterSalePolicyVersion.create({
        data: {
          allowedTypes: policy.allowed_types,
          conditionRules: policy.condition_rules,
          damagedException: policy.damaged_exception,
          defectException: policy.defect_exception,
          effectiveAt: new Date(Date.now() - 60_000),
          exchangeAttributeCode: policy.exchange_attribute_code,
          exchangeSameProductOnly: policy.exchange_same_product_only,
          hygieneRestricted: policy.hygiene_restricted,
          id: fixture.policyVersionId,
          payload: policy,
          payloadHash: policyHash,
          policyId: fixture.policyId,
          publishedBy: fixture.adminId,
          requestWindowDays: policy.request_window_days,
          returnShippingPayer: policy.return_shipping_payer,
          returnWindowDays: policy.return_window_days,
          storeId: BEAUTY_STORE_ID,
          unopenedRequired: policy.unopened_required,
          versionNumber: 1,
          wrongItemException: policy.wrong_item_exception,
        },
      });
      await transaction.afterSalePolicyLocalization.createMany({
        data: policy.localizations.map((localization) => ({
          buyerInstructions: localization.buyer_instructions,
          locale: localization.locale,
          name: localization.name,
          policyVersionId: fixture.policyVersionId,
          storeId: BEAUTY_STORE_ID,
          summary: localization.summary,
        })),
      });
      await transaction.afterSalePolicyVersionAssignment.create({
        data: {
          id: fixture.assignmentId,
          policyId: fixture.policyId,
          policyVersionId: fixture.policyVersionId,
          productId: fixture.productId,
          storeId: BEAUTY_STORE_ID,
          targetType: 'PRODUCT',
        },
      });
      await transaction.afterSalePolicy.update({
        data: {
          currentVersionId: fixture.policyVersionId,
          status: 'ACTIVE',
          updatedBy: fixture.adminId,
          version: { increment: 1 },
        },
        where: { id: fixture.policyId },
      });
      await transaction.afterSaleActivePolicyAssignment.create({
        data: {
          assignmentId: fixture.assignmentId,
          policyId: fixture.policyId,
          policyVersionId: fixture.policyVersionId,
          productId: fixture.productId,
          storeId: BEAUTY_STORE_ID,
          targetType: 'PRODUCT',
        },
      });
      await transaction.order.create({
        data: {
          baseSubtotalVnd: 200_000,
          couponDiscountVnd: 0,
          currency: 'VND',
          id: fixture.orderId,
          itemDiscountVnd: 0,
          memberId: fixture.memberId,
          orderDiscountVnd: 0,
          orderNumber: `M63-B3-${suffix}`,
          payableVnd: 200_000,
          paymentMethod: 'ONLINE',
          paymentStatus: 'SUCCEEDED',
          quoteHash: digest(`m63b3-order-${suffix}`),
          remoteSurchargeVnd: 0,
          shippingDiscountVnd: 0,
          shippingFeeVnd: 0,
          status: 'DELIVERED',
          storeId: BEAUTY_STORE_ID,
        },
      });
      await transaction.orderItem.create({
        data: {
          brandId: fixture.brandId,
          brandName: 'M6.3-B3 brand',
          categoryId: fixture.categoryId,
          couponDiscountVnd: 0,
          id: fixture.orderItemId,
          itemDiscountVnd: 0,
          optionSnapshot: [],
          orderDiscountVnd: 0,
          orderId: fixture.orderId,
          payableVnd: 200_000,
          productId: fixture.productId,
          productName: 'M6.3-B3 product',
          quantity: 2,
          skuCode: `m63b3-sku-${suffix}`,
          skuId: fixture.skuId,
          storeId: BEAUTY_STORE_ID,
          subtotalVnd: 200_000,
          unitPriceVnd: 100_000,
        },
      });
      await transaction.orderItemAfterSalePolicySnapshot.create({
        data: {
          orderId: fixture.orderId,
          orderItemId: fixture.orderItemId,
          payload: policy,
          payloadHash: policyHash,
          policyCode: `m63b3-policy-${suffix}`,
          policyId: fixture.policyId,
          policyVersionId: fixture.policyVersionId,
          policyVersionNumber: 1,
          storeId: BEAUTY_STORE_ID,
        },
      });
      await transaction.paymentAttempt.create({
        data: {
          amountVnd: 200_000,
          attemptSequence: 1,
          channelId: fixture.paymentChannelId,
          correlationId: `m63b3-payment-${suffix}`,
          createIdempotencyKeyHash: digest(`m63b3-payment-key-${suffix}`),
          expiresAt,
          id: fixture.paymentAttemptId,
          orderId: fixture.orderId,
          providerOrderId: `m63b3-provider-order-${suffix}`,
          providerStatus: 'SUCCEEDED',
          providerTransactionId: `m63b3-provider-transaction-${suffix}`,
          publicPaymentNumber: `PAY-M63B3-${suffix.toUpperCase()}`,
          status: 'SUCCEEDED',
          storeId: BEAUTY_STORE_ID,
          succeededAt: new Date(),
        },
      });
      await transaction.shipment.create({
        data: {
          addressSnapshotCiphertext: 'm63b3-encrypted-address-fixture',
          channelId: fixture.shippingChannelId,
          clientOrderCode: `M63-B3-SHP-${suffix}`,
          deliveredAt,
          id: fixture.shipmentId,
          orderId: fixture.orderId,
          parcelSnapshot: { height_cm: 1, length_cm: 1, weight_grams: 1, width_cm: 1 },
          publicShipmentNumber: `SHP-M63B3-${suffix.toUpperCase()}`,
          purpose: 'ORDER_OUTBOUND',
          serviceCode: 'LOCAL_TEST',
          status: 'DELIVERED',
          storeId: BEAUTY_STORE_ID,
          warehouseId: fixture.warehouseId,
        },
      });
      await transaction.shipmentItem.create({
        data: {
          id: fixture.shipmentItemId,
          orderId: fixture.orderId,
          orderItemId: fixture.orderItemId,
          quantity: 2,
          shipmentId: fixture.shipmentId,
          storeId: BEAUTY_STORE_ID,
        },
      });
    });

    memberToken = accessToken({
      actorType: 'member',
      sessionId: fixture.memberSessionId,
      storeId: BEAUTY_STORE_ID,
      subjectId: fixture.memberId,
    });
    otherMemberToken = accessToken({
      actorType: 'member',
      sessionId: fixture.otherMemberSessionId,
      storeId: BEAUTY_STORE_ID,
      subjectId: fixture.otherMemberId,
    });
    adminToken = accessToken({
      actorType: 'admin',
      sessionId: fixture.adminSessionId,
      subjectId: fixture.adminId,
    });

    const [{ AppModule }, { ApiExceptionFilter }, { AfterSalesRateLimiter }] = await Promise.all([
      import('../../apps/api/src/app.module'),
      import('../../apps/api/src/api-exception.filter'),
      import('../../apps/api/src/after-sales/after-sales-rate-limiter'),
    ]);
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    limiterRedis = (app.get(AfterSalesRateLimiter) as unknown as { redis: typeof limiterRedis })
      .redis;
  });

  afterAll(async () => {
    const limiterKeys = [
      ...[-1, 0, 1].flatMap((offset) => [
        rateLimitKey('MEMBER', fixture.memberId, BEAUTY_STORE_ID, offset),
        rateLimitKey('MEMBER', fixture.otherMemberId, BEAUTY_STORE_ID, offset),
        rateLimitKey('ADMIN', fixture.adminId, BEAUTY_STORE_ID, offset),
        rateLimitKey('ADMIN', fixture.adminId, FASHION_STORE_ID, offset),
      ]),
    ];
    await limiterRedis?.del(...limiterKeys);
    await app?.close();
    const afterSales = await owner.afterSale.findMany({
      select: { id: true },
      where: { orderId: fixture.orderId, storeId: BEAUTY_STORE_ID },
    });
    const afterSaleIds = afterSales.map(({ id }) => id);
    await owner.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.auditLog.deleteMany({
        where: { actorId: { in: [fixture.memberId, fixture.otherMemberId, fixture.adminId] } },
      });
      if (afterSaleIds.length > 0) {
        await transaction.afterSaleReturnShipment.deleteMany({
          where: { afterSaleId: { in: afterSaleIds } },
        });
        await transaction.afterSaleTransition.deleteMany({
          where: { afterSaleId: { in: afterSaleIds } },
        });
        await transaction.afterSaleOperation.deleteMany({
          where: { afterSaleId: { in: afterSaleIds } },
        });
        await transaction.afterSaleItem.deleteMany({
          where: { afterSaleId: { in: afterSaleIds } },
        });
        await transaction.afterSaleOrderAllocation.deleteMany({
          where: { afterSaleId: { in: afterSaleIds } },
        });
        await transaction.afterSale.deleteMany({ where: { id: { in: afterSaleIds } } });
      }
      await transaction.shipmentItem.deleteMany({ where: { id: fixture.shipmentItemId } });
      await transaction.shipment.deleteMany({ where: { id: fixture.shipmentId } });
      await transaction.paymentAttempt.deleteMany({ where: { id: fixture.paymentAttemptId } });
      await transaction.orderItemAfterSalePolicySnapshot.deleteMany({
        where: { orderItemId: fixture.orderItemId, storeId: BEAUTY_STORE_ID },
      });
      await transaction.orderItem.deleteMany({ where: { id: fixture.orderItemId } });
      await transaction.order.deleteMany({ where: { id: fixture.orderId } });
      await transaction.afterSalePolicyLocalization.deleteMany({
        where: { policyVersionId: fixture.policyVersionId, storeId: BEAUTY_STORE_ID },
      });
      await transaction.afterSaleActivePolicyAssignment.deleteMany({
        where: { assignmentId: fixture.assignmentId },
      });
      await transaction.afterSalePolicyVersionAssignment.deleteMany({
        where: { id: fixture.assignmentId },
      });
      await transaction.afterSalePolicyVersion.deleteMany({
        where: { id: fixture.policyVersionId },
      });
      await transaction.afterSalePolicy.deleteMany({ where: { id: fixture.policyId } });
      await transaction.sku.deleteMany({ where: { id: fixture.skuId } });
      await transaction.product.deleteMany({ where: { id: fixture.productId } });
      await transaction.brand.deleteMany({ where: { id: fixture.brandId } });
      await transaction.category.deleteMany({ where: { id: fixture.categoryId } });
      await transaction.storePaymentChannel.deleteMany({
        where: { id: fixture.paymentChannelId },
      });
      await transaction.storeShippingChannel.deleteMany({
        where: { id: fixture.shippingChannelId },
      });
      await transaction.warehouse.deleteMany({ where: { id: fixture.warehouseId } });
      await transaction.memberSession.deleteMany({
        where: { id: { in: [fixture.memberSessionId, fixture.otherMemberSessionId] } },
      });
      await transaction.member.deleteMany({
        where: { id: { in: [fixture.memberId, fixture.otherMemberId] } },
      });
      await transaction.adminStoreRole.deleteMany({ where: { adminUserId: fixture.adminId } });
      await transaction.adminPlatformRole.deleteMany({ where: { adminUserId: fixture.adminId } });
      await transaction.platformRolePermission.deleteMany({
        where: { platformRoleId: fixture.platformRoleId },
      });
      await transaction.platformRole.delete({ where: { id: fixture.platformRoleId } });
      await transaction.storeRolePermission.deleteMany({
        where: { roleId: { in: [fixture.beautyRoleId, fixture.fashionRoleId] } },
      });
      await transaction.storeRole.deleteMany({
        where: { id: { in: [fixture.beautyRoleId, fixture.fashionRoleId] } },
      });
      await transaction.adminSession.deleteMany({ where: { id: fixture.adminSessionId } });
      await transaction.adminUser.deleteMany({ where: { id: fixture.adminId } });
      await transaction.storeZaloApp.deleteMany({ where: { storeId: BEAUTY_STORE_ID } });
      await transaction.storeAfterSaleSetting.deleteMany({
        where: { storeId: { in: [BEAUTY_STORE_ID, FASHION_STORE_ID] } },
      });
      await transaction.store.deleteMany({
        where: { id: { in: [BEAUTY_STORE_ID, FASHION_STORE_ID] } },
      });
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });
    await owner.$disconnect();
  });

  it('creates and replays a member request from server-owned facts', async () => {
    const first = await api()
      .post('/v1/after-sales')
      .set({
        ...memberHeaders(),
        'Idempotency-Key': memberCreateIdempotencyKey,
        'X-Correlation-Id': 'client-correlation-must-not-win',
      })
      .send(memberBody());

    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.headers['cache-control']).toBe('private, no-store');
    expect(first.headers['idempotency-replayed']).toBe('false');
    expect(first.headers['x-correlation-id']).not.toBe('client-correlation-must-not-win');
    expect(first.body).toEqual({
      id: expect.any(String),
      public_number: expect.stringMatching(/^ASC-[A-Z0-9]{16,32}$/),
      status: 'PENDING_REVIEW',
      version: 1,
    });
    memberCreateAcknowledgement = first.body as AfterSaleCommandAcknowledgementResponse;

    const detail = await api()
      .get(`/v1/after-sales/${memberCreateAcknowledgement.id}`)
      .set(memberHeaders());
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      currency: 'VND',
      id: memberCreateAcknowledgement.id,
      order_id: fixture.orderId,
      reason_code: 'defective-item',
      reason_detail: description,
      requested_item_vnd: 100_000,
      requested_other_vnd: 0,
      requested_shipping_vnd: 0,
      requested_total_vnd: 100_000,
      status: 'PENDING_REVIEW',
      type: 'REFUND_ONLY',
      version: 1,
    });
    expect(detail.body.timeline).toEqual([
      expect.objectContaining({ event: 'SUBMIT', status: 'PENDING_REVIEW' }),
    ]);

    const replay = await api()
      .post('/v1/after-sales')
      .set({ ...memberHeaders(), 'Idempotency-Key': memberCreateIdempotencyKey })
      .send(memberBody());
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.body).toEqual(memberCreateAcknowledgement);

    const conflict = await api()
      .post('/v1/after-sales')
      .set({ ...memberHeaders(), 'Idempotency-Key': memberCreateIdempotencyKey })
      .send(memberBody(2));
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({
      code: 'CONFLICT',
      details: { reason_code: 'AFTER_SALE_IDEMPOTENCY_CONFLICT' },
    });
  });

  it('rejects client-owned amount fields and hides another member order', async () => {
    const altered = await api()
      .post('/v1/after-sales')
      .set({ ...memberHeaders(), 'Idempotency-Key': `m63b3-client-amount-${suffix}` })
      .send({ ...memberBody(), requested_total_vnd: 1 });
    expect(altered.status).toBe(400);
    expect(altered.body).toMatchObject({ code: 'INPUT_INVALID' });

    const otherMember = await api()
      .post('/v1/after-sales')
      .set({
        ...memberHeaders(otherMemberToken),
        'Idempotency-Key': `m63b3-cross-member-${suffix}`,
      })
      .send(memberBody());
    expect(otherMember.status).toBe(404);
    expect(otherMember.body).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });

  it('cancels only with the expected version and replays without another transition', async () => {
    const existing = await owner.afterSale.findFirstOrThrow({
      select: { id: true, version: true },
      where: { orderId: fixture.orderId, source: 'MEMBER', storeId: BEAUTY_STORE_ID },
    });
    const idempotencyKey = `m63b3-member-cancel-${suffix}`;
    const body = {
      expected_version: existing.version,
      reason: 'The request is no longer needed after checking the item.',
    };
    const cancelled = await api()
      .post(`/v1/after-sales/${existing.id}/cancel`)
      .set({ ...memberHeaders(), 'Idempotency-Key': idempotencyKey })
      .send(body);
    expect(cancelled.status).toBe(200);
    expect(cancelled.headers['idempotency-replayed']).toBe('false');
    expect(cancelled.body).toEqual({
      id: existing.id,
      public_number: memberCreateAcknowledgement.public_number,
      status: 'CANCELLED',
      version: 2,
    });

    const replay = await api()
      .post(`/v1/after-sales/${existing.id}/cancel`)
      .set({ ...memberHeaders(), 'Idempotency-Key': idempotencyKey })
      .send(body);
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.body).toEqual(cancelled.body);

    const originalCreateReplay = await api()
      .post('/v1/after-sales')
      .set({ ...memberHeaders(), 'Idempotency-Key': memberCreateIdempotencyKey })
      .send(memberBody());
    expect(originalCreateReplay.status).toBe(201);
    expect(originalCreateReplay.headers['idempotency-replayed']).toBe('true');
    expect(originalCreateReplay.body).toEqual(memberCreateAcknowledgement);

    const current = await api().get(`/v1/after-sales/${existing.id}`).set(memberHeaders());
    expect(current.status).toBe(200);
    expect(current.body).toMatchObject({ id: existing.id, status: 'CANCELLED', version: 2 });
    expect(current.body.timeline.map(({ event }: { event: string }) => event)).toEqual([
      'SUBMIT',
      'CANCEL',
    ]);
  });

  it('returns 401 after member revocation and rejects cross-access-only merchant commands', async () => {
    await owner.memberSession.update({
      data: { revokedAt: new Date() },
      where: { id: fixture.memberSessionId },
    });
    try {
      const revokedMember = await api()
        .post('/v1/after-sales')
        .set({
          ...memberHeaders(),
          'Idempotency-Key': `m63b3-member-revoked-${suffix}`,
        })
        .send(memberBody());
      expect(revokedMember.status).toBe(401);
    } finally {
      await owner.memberSession.update({
        data: { revokedAt: null },
        where: { id: fixture.memberSessionId },
      });
    }

    await owner.storeRolePermission.delete({
      where: {
        storeId_roleId_permissionCode: {
          permissionCode: 'store.after-sales.review',
          roleId: fixture.beautyRoleId,
          storeId: BEAUTY_STORE_ID,
        },
      },
    });
    try {
      const revokedAdmin = await api()
        .post(`/v1/admin/orders/${fixture.orderId}/after-sales?store_id=${BEAUTY_STORE_ID}`)
        .set({
          ...adminHeaders(),
          'Idempotency-Key': `m63b3-admin-rbac-revoked-${suffix}`,
          'X-Access-Reason': 'Operational review for order ABC-1234',
        })
        .send({
          description: 'Merchant initiated a refund after fulfillment review.',
          items: [{ order_item_id: fixture.orderItemId, quantity: 1 }],
          reason_code: 'merchant-refund',
          type: 'MERCHANT_REFUND',
        });
      expect(revokedAdmin.status).toBe(403);
      expect(revokedAdmin.body).toMatchObject({ code: 'AUTHORIZATION_DENIED' });
    } finally {
      await owner.storeRolePermission.create({
        data: {
          permissionCode: 'store.after-sales.review',
          roleId: fixture.beautyRoleId,
          storeId: BEAUTY_STORE_ID,
        },
      });
    }
  });

  it('requires recent MFA and accepts a direct target-store review assignment', async () => {
    await owner.adminSession.update({
      data: { mfaVerifiedAt: new Date(Date.now() - 11 * 60 * 1_000) },
      where: { id: fixture.adminSessionId },
    });
    const stale = await api()
      .post(`/v1/admin/orders/${fixture.orderId}/after-sales?store_id=${BEAUTY_STORE_ID}`)
      .set({ ...adminHeaders(), 'Idempotency-Key': `m63b3-admin-stale-${suffix}` })
      .send({
        description: 'Merchant initiated the refund after a completed fulfillment review.',
        items: [{ order_item_id: fixture.orderItemId, quantity: 1 }],
        reason_code: 'merchant-refund',
        type: 'MERCHANT_REFUND',
      });
    expect(stale.status).toBe(403);
    expect(stale.body).toMatchObject({ code: 'AUTHORIZATION_DENIED' });

    await owner.adminSession.update({
      data: { mfaVerifiedAt: new Date() },
      where: { id: fixture.adminSessionId },
    });
    const created = await api()
      .post(`/v1/admin/orders/${fixture.orderId}/after-sales?store_id=${BEAUTY_STORE_ID}`)
      .set({
        ...adminHeaders(),
        'Idempotency-Key': `m63b3-admin-create-${suffix}`,
      })
      .send({
        description: 'Merchant initiated the refund after a completed fulfillment review.',
        items: [{ order_item_id: fixture.orderItemId, quantity: 1 }],
        reason_code: 'merchant-refund',
        type: 'MERCHANT_REFUND',
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.headers['idempotency-replayed']).toBe('false');
    expect(created.body).toEqual({
      id: expect.any(String),
      public_number: expect.stringMatching(/^ASC-[A-Z0-9]{16,32}$/),
      status: 'PENDING_REVIEW',
      version: 1,
    });
  });

  it('does not enumerate a beauty order through an authorized fashion context', async () => {
    const response = await api()
      .post(`/v1/admin/orders/${fixture.orderId}/after-sales?store_id=${FASHION_STORE_ID}`)
      .set({
        ...adminHeaders(FASHION_STORE_CODE),
        'Idempotency-Key': `m63b3-admin-cross-store-${suffix}`,
      })
      .send({
        description: 'Merchant initiated the refund after a completed fulfillment review.',
        items: [{ order_item_id: fixture.orderItemId, quantity: 1 }],
        reason_code: 'merchant-refund',
        type: 'MERCHANT_REFUND',
      });
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });

  it('reviews a member case through the real API with MFA, replay and store isolation', async () => {
    const created = await api()
      .post('/v1/after-sales')
      .set({
        ...memberHeaders(),
        'Idempotency-Key': `m63b4-api-member-create-${suffix}`,
      })
      .send(memberBody(1, 'RETURN_REFUND'));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ status: 'PENDING_REVIEW', version: 1 });

    const reviewBody = {
      confirmation_code: 'APPROVE_AFTER_SALE',
      decision: 'APPROVE',
      expected_version: 1,
      items: [{ approved_quantity: 1, order_item_id: fixture.orderItemId }],
      reason: 'Approve after completing the required administrator evidence review.',
    };
    const reviewKey = `m63b4-api-review-${suffix}`;
    await owner.adminSession.update({
      data: { mfaVerifiedAt: new Date(Date.now() - 11 * 60 * 1_000) },
      where: { id: fixture.adminSessionId },
    });
    const stale = await api()
      .post(`/v1/admin/after-sales/${created.body.id}/review?store_id=${BEAUTY_STORE_ID}`)
      .set({ ...adminHeaders(), 'Idempotency-Key': reviewKey })
      .send(reviewBody);
    expect(stale.status).toBe(403);
    await owner.adminSession.update({
      data: { mfaVerifiedAt: new Date() },
      where: { id: fixture.adminSessionId },
    });

    const approved = await api()
      .post(`/v1/admin/after-sales/${created.body.id}/review?store_id=${BEAUTY_STORE_ID}`)
      .set({ ...adminHeaders(), 'Idempotency-Key': reviewKey })
      .send(reviewBody);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.headers['idempotency-replayed']).toBe('false');
    expect(approved.body).toEqual({ ...created.body, status: 'APPROVED', version: 2 });

    const replay = await api()
      .post(`/v1/admin/after-sales/${created.body.id}/review?store_id=${BEAUTY_STORE_ID}`)
      .set({ ...adminHeaders(), 'Idempotency-Key': reviewKey })
      .send(reviewBody);
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.body).toEqual(approved.body);

    const conflict = await api()
      .post(`/v1/admin/after-sales/${created.body.id}/review?store_id=${BEAUTY_STORE_ID}`)
      .set({ ...adminHeaders(), 'Idempotency-Key': reviewKey })
      .send({
        confirmation_code: 'REJECT_AFTER_SALE',
        decision: 'REJECT',
        expected_version: 1,
        reason: 'A different decision cannot reuse the completed review command key.',
      });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({
      code: 'CONFLICT',
      details: { reason_code: 'AFTER_SALE_IDEMPOTENCY_CONFLICT' },
    });

    const foreign = await api()
      .post(`/v1/admin/after-sales/${created.body.id}/review?store_id=${FASHION_STORE_ID}`)
      .set({
        ...adminHeaders(FASHION_STORE_CODE),
        'Idempotency-Key': `m63b4-api-foreign-review-${suffix}`,
      })
      .send(reviewBody);
    expect(foreign.status).toBe(404);
    expect(foreign.body).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });

    const merchant = await owner.afterSale.findFirstOrThrow({
      select: { id: true },
      where: { orderId: fixture.orderId, source: 'ADMIN', storeId: BEAUTY_STORE_ID },
    });
    const selfReview = await api()
      .post(`/v1/admin/after-sales/${merchant.id}/review?store_id=${BEAUTY_STORE_ID}`)
      .set({
        ...adminHeaders(),
        'Idempotency-Key': `m63b4-api-maker-checker-${suffix}`,
      })
      .send(reviewBody);
    expect(selfReview.status).toBe(403);
    expect(selfReview.body).toMatchObject({ code: 'AUTHORIZATION_DENIED' });

    const trackingNumber = `GHN-API-RETURN-${suffix}-123456`;
    const submitKey = `m63b5-api-return-submit-${suffix}`;
    const submitBody = {
      carrier_name: 'GHN',
      expected_version: approved.body.version,
      tracking_number: trackingNumber,
    };
    const submitted = await api()
      .post(`/v1/after-sales/${created.body.id}/return-shipment`)
      .set({ ...memberHeaders(), 'Idempotency-Key': submitKey })
      .send(submitBody);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    expect(submitted.headers['idempotency-replayed']).toBe('false');
    expect(submitted.body).toEqual({ ...approved.body, status: 'RETURN_PENDING', version: 3 });
    expect(JSON.stringify(submitted.body)).not.toContain(trackingNumber);

    const submitReplay = await api()
      .post(`/v1/after-sales/${created.body.id}/return-shipment`)
      .set({ ...memberHeaders(), 'Idempotency-Key': submitKey })
      .send(submitBody);
    expect(submitReplay.status).toBe(200);
    expect(submitReplay.headers['idempotency-replayed']).toBe('true');
    expect(submitReplay.body).toEqual(submitted.body);

    const changedSubmit = await api()
      .post(`/v1/after-sales/${created.body.id}/return-shipment`)
      .set({ ...memberHeaders(), 'Idempotency-Key': submitKey })
      .send({ ...submitBody, tracking_number: `${trackingNumber}-CHANGED` });
    expect(changedSubmit.status).toBe(409);
    expect(changedSubmit.body).toMatchObject({
      code: 'CONFLICT',
      details: { reason_code: 'AFTER_SALE_IDEMPOTENCY_CONFLICT' },
    });

    const foreignMember = await api()
      .post(`/v1/after-sales/${created.body.id}/return-shipment`)
      .set({
        ...memberHeaders(otherMemberToken),
        'Idempotency-Key': `m63b5-api-foreign-member-${suffix}`,
      })
      .send(submitBody);
    expect(foreignMember.status).toBe(404);
    expect(foreignMember.body).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });

    const factKey = `m63b5-api-return-delivered-${suffix}`;
    const factBody = {
      confirmation_code: 'RECORD_RETURN_LOGISTICS_FACT',
      expected_return_shipment_version: 1,
      expected_version: submitted.body.version,
      reason: 'Carrier portal confirms delivery to the return warehouse.',
      status: 'DELIVERED',
    };
    await owner.storeRolePermission.delete({
      where: {
        storeId_roleId_permissionCode: {
          permissionCode: 'store.after-sales.review',
          roleId: fixture.beautyRoleId,
          storeId: BEAUTY_STORE_ID,
        },
      },
    });
    try {
      const revokedFact = await api()
        .post(
          `/v1/admin/after-sales/${created.body.id}/return-shipment/fact?store_id=${BEAUTY_STORE_ID}`,
        )
        .set({
          ...adminHeaders(),
          'Idempotency-Key': `m63b5-api-return-revoked-${suffix}`,
        })
        .send(factBody);
      expect(revokedFact.status).toBe(403);
      expect(revokedFact.body).toMatchObject({ code: 'AUTHORIZATION_DENIED' });
    } finally {
      await owner.storeRolePermission.create({
        data: {
          permissionCode: 'store.after-sales.review',
          roleId: fixture.beautyRoleId,
          storeId: BEAUTY_STORE_ID,
        },
      });
    }
    await owner.adminSession.update({
      data: { mfaVerifiedAt: new Date(Date.now() - 11 * 60 * 1_000) },
      where: { id: fixture.adminSessionId },
    });
    const staleFact = await api()
      .post(
        `/v1/admin/after-sales/${created.body.id}/return-shipment/fact?store_id=${BEAUTY_STORE_ID}`,
      )
      .set({ ...adminHeaders(), 'Idempotency-Key': factKey })
      .send(factBody);
    expect(staleFact.status).toBe(403);
    await owner.adminSession.update({
      data: { mfaVerifiedAt: new Date() },
      where: { id: fixture.adminSessionId },
    });

    const delivered = await api()
      .post(
        `/v1/admin/after-sales/${created.body.id}/return-shipment/fact?store_id=${BEAUTY_STORE_ID}`,
      )
      .set({ ...adminHeaders(), 'Idempotency-Key': factKey })
      .send(factBody);
    expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);
    expect(delivered.headers['idempotency-replayed']).toBe('false');
    expect(delivered.body).toEqual({
      ...approved.body,
      status: 'INSPECTION_PENDING',
      version: 5,
    });
    expect(JSON.stringify(delivered.body)).not.toContain(trackingNumber);

    const factReplay = await api()
      .post(
        `/v1/admin/after-sales/${created.body.id}/return-shipment/fact?store_id=${BEAUTY_STORE_ID}`,
      )
      .set({ ...adminHeaders(), 'Idempotency-Key': factKey })
      .send(factBody);
    expect(factReplay.status).toBe(200);
    expect(factReplay.headers['idempotency-replayed']).toBe('true');
    expect(factReplay.body).toEqual(delivered.body);

    const foreignFact = await api()
      .post(
        `/v1/admin/after-sales/${created.body.id}/return-shipment/fact?store_id=${FASHION_STORE_ID}`,
      )
      .set({
        ...adminHeaders(FASHION_STORE_CODE),
        'Idempotency-Key': `m63b5-api-foreign-fact-${suffix}`,
      })
      .send(factBody);
    expect(foreignFact.status).toBe(404);
    expect(foreignFact.body).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });

    const detail = await api()
      .get(`/v1/admin/after-sales/${created.body.id}?store_id=${BEAUTY_STORE_ID}`)
      .set({
        ...adminHeaders(),
        'X-Access-Reason': 'Inspect the returned parcel before after-sale acceptance.',
      });
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body).toMatchObject({
      id: created.body.id,
      return_shipments: [
        {
          carrier_name: 'GHN',
          masked_tracking_number: expect.any(String),
          status: 'DELIVERED',
        },
      ],
      status: 'INSPECTION_PENDING',
      version: 5,
    });
    expect(detail.body.return_shipments[0].masked_tracking_number).not.toBe(trackingNumber);
    expect(JSON.stringify(detail.body)).not.toContain(trackingNumber);
    expect(detail.body.timeline.map(({ event }: { event: string }) => event).slice(-3)).toEqual([
      'START_RETURN',
      'RETURN_SHIPPED',
      'RETURN_RECEIVED',
    ]);

    const inspectionQueue = await api()
      .get(`/v1/admin/after-sales?store_id=${BEAUTY_STORE_ID}&status=INSPECTION_PENDING&limit=20`)
      .set({
        ...adminHeaders(),
        'X-Access-Reason': 'Inspect the returned parcel queue for after-sale acceptance.',
      });
    expect(inspectionQueue.status, JSON.stringify(inspectionQueue.body)).toBe(200);
    expect(inspectionQueue.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: created.body.id, status: 'INSPECTION_PENDING' }),
      ]),
    );
  });
});
