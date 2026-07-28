import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { Server } from 'node:http';
import { dirname, resolve } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { config as loadEnvironment } from 'dotenv';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { parseRuntimeConfig } from '@zalo-shop/config';
import {
  adjustInventory,
  applyShippingProviderFact,
  createRuntimePrismaClient,
  getShipmentProviderOperationRequest,
  PrismaClient,
  recordShipmentCreated,
  recordShippingCallbackHint,
  recordShippingOperationError,
  reserveInventory,
  requestShipmentOperation,
  resolveShippingCallbackChannel,
} from '@zalo-shop/database';
import { createStoreContext } from '@zalo-shop/domain';
import type { ShippingProvider, ShippingProviderResolver } from '@zalo-shop/integrations';
import { encryptSensitive, hashSensitive, signJwt } from '@zalo-shop/security';

import { SHIPPING_PROVIDER } from '../../apps/api/src/shipping/shipping.tokens';

const BEAUTY_STORE_ID = '10000000-0000-4000-8000-000000000001';
const FASHION_STORE_ID = '10000000-0000-4000-8000-000000000002';
const BEAUTY_CATEGORY_ID = '12000000-0000-4000-8000-000000000001';
const BEAUTY_TEMPLATE_ID = '14000000-0000-4000-8000-000000000001';
const REPOSITORY_ROOT = resolve(__dirname, '../..');
const SCRATCH_DATABASE_PATTERN = /^zalo_shop_m56_[0-9a-f]{12}$/u;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

describe('M5.6 GHN shipping primitives', () => {
  loadEnvironment({ path: '.env.test.example', quiet: true, override: true });
  const sourceOwnerUrl = process.env.DATABASE_URL;
  const sourceRuntimeUrl = process.env.DATABASE_RUNTIME_URL;
  if (!sourceOwnerUrl || !sourceRuntimeUrl) throw new Error('M5.6 database URLs are required');
  const scratchDatabaseName = `zalo_shop_m56_${randomBytes(6).toString('hex')}`;
  const ownerUrl = scratchUrl(sourceOwnerUrl, scratchDatabaseName);
  const runtimeUrl = scratchUrl(sourceRuntimeUrl, scratchDatabaseName);
  const adminUrl = scratchUrl(sourceOwnerUrl, 'postgres');
  process.env.DATABASE_URL = ownerUrl;
  process.env.DATABASE_RUNTIME_URL = runtimeUrl;
  const config = parseRuntimeConfig();
  const admin = new PrismaClient({ datasourceUrl: adminUrl });
  const owner = new PrismaClient({ datasourceUrl: ownerUrl });
  const runtime = createRuntimePrismaClient(runtimeUrl);
  let scratchCreated = false;
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const shopId = `9${Date.now().toString().slice(-10)}${Math.floor(Math.random() * 1_000)
    .toString()
    .padStart(3, '0')}`;
  let channelId = '';
  let shipmentId = '';
  let orderId = '';
  let memberId = '';
  let warehouseId = '';
  let app: INestApplication;
  let adminToken = '';
  let staleAdminToken = '';
  let restrictedAdminToken = '';
  let memberToken = '';
  let apiOrderId = '';
  let foreignOrderId = '';
  let apiShipmentId = '';
  const apiFixture = {
    adminId: randomUUID(),
    brandId: randomUUID(),
    channelId: randomUUID(),
    memberId: randomUUID(),
    productId: randomUUID(),
    restrictedAdminId: randomUUID(),
    restrictedRoleId: randomUUID(),
    skuId: randomUUID(),
    staleAdminId: randomUUID(),
  };
  const providerQuote = vi.fn().mockResolvedValue({
    baseFeeVnd: 22_000,
    codFeeVnd: 500,
    estimatedDeliveryAt: new Date(Date.now() + 2 * 86_400_000),
    expiresAt: new Date(Date.now() + 300_000),
    insuranceFeeVnd: 300,
    otherFeeVnd: 700,
    providerServiceId: 53320,
    providerServiceTypeId: 2,
    remoteFeeVnd: 1_500,
    serviceCode: 'GHN:53320:2',
    totalFeeVnd: 25_000,
  });
  const provider: ShippingProvider = {
    cancelShipment: vi.fn(),
    code: 'GHN',
    createShipment: vi.fn(),
    environment: 'SANDBOX',
    getLabel: vi.fn().mockResolvedValue({
      expiresAt: new Date(Date.now() + 60_000),
      url: 'https://attacker.example/label.pdf?token=stolen',
    }),
    listServices: vi.fn().mockResolvedValue([{ code: 'GHN:53320:2', name: 'GHN Test' }]),
    parseCallback: vi.fn(),
    queryShipment: vi.fn(),
    quote: providerQuote,
  };
  const providerResolver: ShippingProviderResolver = { resolve: () => provider };

  function scratchUrl(source: string, databaseName: string): string {
    const url = new URL(source);
    if (!LOOPBACK_HOSTS.has(url.hostname)) {
      throw new Error('M5.6 integration test requires a loopback PostgreSQL host');
    }
    url.pathname = `/${databaseName}`;
    return url.toString();
  }

  function assertScratchName(): void {
    if (process.env.NODE_ENV !== 'test' || !SCRATCH_DATABASE_PATTERN.test(scratchDatabaseName)) {
      throw new Error('Refusing unsafe M5.6 scratch database operation');
    }
  }

  function runPackageScript(script: 'migrate:deploy' | 'seed'): void {
    const corepackCli = resolve(
      dirname(process.execPath),
      'node_modules/corepack/dist/corepack.js',
    );
    const result = spawnSync(
      process.execPath,
      [corepackCli, 'pnpm', '--filter', '@zalo-shop/database', script],
      {
        cwd: REPOSITORY_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          DATABASE_RUNTIME_URL: runtimeUrl,
          DATABASE_URL: ownerUrl,
          NODE_ENV: 'test',
        },
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`${script} failed: ${(result.stderr || result.stdout).trim()}`);
    }
  }

  function api() {
    if (!app) throw new Error('M5.6 API is unavailable');
    return request(app.getHttpServer() as Server);
  }

  function adminHeaders(token = adminToken, storeCode = 'beauty-local') {
    return { Authorization: `Bearer ${token}`, 'X-Store-Code': storeCode };
  }

  function memberHeaders(token = memberToken) {
    return { Authorization: `Bearer ${token}`, 'X-Store-Code': 'beauty-local' };
  }

  async function issueAdminToken(adminUserId: string, mfaVerifiedAt: Date): Promise<string> {
    const session = await owner.adminSession.create({
      data: {
        adminUserId,
        expiresAt: new Date(Date.now() + 3_600_000),
        mfaVerifiedAt,
        refreshTokenHash: hashSensitive(randomUUID(), config.PII_HASH_KEY),
        tokenFamilyId: randomUUID(),
      },
    });
    const now = Math.floor(Date.now() / 1_000);
    return signJwt(
      {
        actor_type: 'admin',
        aud: config.AUTH_JWT_AUDIENCE,
        exp: now + 900,
        iat: now,
        iss: config.AUTH_JWT_ISSUER,
        jti: randomUUID(),
        session_id: session.id,
        sub: adminUserId,
      },
      config.AUTH_JWT_SECRET,
    );
  }

  async function issueMemberToken(targetMemberId: string): Promise<string> {
    const session = await owner.memberSession.create({
      data: {
        expiresAt: new Date(Date.now() + 3_600_000),
        memberId: targetMemberId,
        refreshTokenHash: hashSensitive(randomUUID(), config.PII_HASH_KEY),
        storeId: BEAUTY_STORE_ID,
        tokenFamilyId: randomUUID(),
      },
    });
    const now = Math.floor(Date.now() / 1_000);
    return signJwt(
      {
        actor_type: 'member',
        aud: config.AUTH_JWT_AUDIENCE,
        exp: now + 900,
        iat: now,
        iss: config.AUTH_JWT_ISSUER,
        jti: randomUUID(),
        session_id: session.id,
        store_id: BEAUTY_STORE_ID,
        sub: targetMemberId,
      },
      config.AUTH_JWT_SECRET,
    );
  }

  const context = () =>
    createStoreContext({
      actor: { id: apiFixture.adminId, type: 'admin' },
      correlationId: `m56-${suffix}-${randomUUID()}`,
      locale: 'vi',
      storeCode: 'beauty-local',
      storeId: BEAUTY_STORE_ID,
    });

  beforeAll(async () => {
    assertScratchName();
    await admin.$connect();
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchDatabaseName}"`);
    scratchCreated = true;
    runPackageScript('migrate:deploy');
    runPackageScript('seed');
    await Promise.all([owner.$connect(), runtime.$connect()]);
    const warehouse = await owner.warehouse.findUniqueOrThrow({
      where: { storeId_code: { code: 'local-default', storeId: BEAUTY_STORE_ID } },
    });
    warehouseId = warehouse.id;
    memberId = randomUUID();
    await owner.member.create({ data: { id: memberId, storeId: BEAUTY_STORE_ID } });
    const order = await owner.order.create({
      data: {
        baseSubtotalVnd: 120_000,
        couponDiscountVnd: 0,
        currency: 'VND',
        itemDiscountVnd: 0,
        memberId,
        orderDiscountVnd: 0,
        orderNumber: `M56-${suffix}`,
        payableVnd: 120_000,
        paymentMethod: 'COD',
        paymentStatus: 'PENDING',
        quoteHash: digest(`quote-${suffix}`),
        remoteSurchargeVnd: 0,
        shippingDiscountVnd: 0,
        shippingFeeVnd: 0,
        status: 'PENDING_FULFILLMENT',
        storeId: BEAUTY_STORE_ID,
      },
    });
    orderId = order.id;
    const channel = await owner.storeShippingChannel.create({
      data: {
        defaultServiceCode: 'GHN:53320:2',
        keyVersion: 'm56-test-v1',
        originAllowlistKey: 'GHN_PRODUCTION',
        providerCode: 'GHN',
        providerEnvironment: 'PRODUCTION',
        secretFingerprint: digest(`shipping-${suffix}`),
        shopId,
        status: 'DISABLED',
        storeId: BEAUTY_STORE_ID,
        tokenSecretRef: `env:GHN_M56_${suffix}_TOKEN`,
      },
    });
    channelId = channel.id;
    const shipment = await owner.shipment.create({
      data: {
        addressSnapshotCiphertext: JSON.stringify({
          detail_ciphertext: 'encrypted-detail',
          district_code: '760',
          phone_ciphertext: 'encrypted-phone',
          province_code: '79',
          recipient_name_ciphertext: 'encrypted-name',
          ward_code: '26734',
        }),
        channelId,
        clientOrderCode: `SHP-${suffix}`,
        codAmountVnd: 120_000,
        orderId,
        parcelSnapshot: {
          height_cm: 8,
          inspection_policy: 'NO_INSPECTION',
          length_cm: 18,
          origin: {
            contact_name_ciphertext: 'encrypted-origin-name',
            detail_ciphertext: 'encrypted-origin-detail',
            district_code: '760',
            phone_ciphertext: 'encrypted-origin-phone',
            province_code: '79',
            ward_code: '26734',
          },
          weight_grams: 250,
          width_cm: 12,
        },
        providerShipmentId: `GHN-${suffix}`,
        publicShipmentNumber: `SHP-${suffix}`,
        serviceCode: 'GHN:53320:2',
        status: 'PENDING_PICKUP',
        storeId: BEAUTY_STORE_ID,
        warehouseId,
      },
    });
    shipmentId = shipment.id;

    await owner.adminUser.createMany({
      data: [
        {
          displayName: 'M5.6 shipping admin',
          email: `m56-admin-${suffix}@example.test`,
          emailNormalized: `m56-admin-${suffix}@example.test`,
          id: apiFixture.adminId,
          passwordHash: 'test-fixture-not-used',
        },
        {
          displayName: 'M5.6 stale shipping admin',
          email: `m56-stale-${suffix}@example.test`,
          emailNormalized: `m56-stale-${suffix}@example.test`,
          id: apiFixture.staleAdminId,
          passwordHash: 'test-fixture-not-used',
        },
        {
          displayName: 'M5.6 restricted shipping admin',
          email: `m56-restricted-${suffix}@example.test`,
          emailNormalized: `m56-restricted-${suffix}@example.test`,
          id: apiFixture.restrictedAdminId,
          passwordHash: 'test-fixture-not-used',
        },
      ],
    });
    const storeAdminRole = await owner.storeRole.findUniqueOrThrow({
      where: { storeId_code: { code: 'store-admin', storeId: BEAUTY_STORE_ID } },
    });
    await owner.storeRole.create({
      data: {
        code: `m56-orders-read-${suffix}`,
        id: apiFixture.restrictedRoleId,
        name: 'M5.6 orders read only',
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.storeRolePermission.create({
      data: {
        permissionCode: 'store.orders.read',
        roleId: apiFixture.restrictedRoleId,
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.adminStoreRole.createMany({
      data: [
        {
          adminUserId: apiFixture.adminId,
          grantedBy: apiFixture.adminId,
          roleId: storeAdminRole.id,
          storeId: BEAUTY_STORE_ID,
        },
        {
          adminUserId: apiFixture.staleAdminId,
          grantedBy: apiFixture.adminId,
          roleId: storeAdminRole.id,
          storeId: BEAUTY_STORE_ID,
        },
        {
          adminUserId: apiFixture.restrictedAdminId,
          grantedBy: apiFixture.adminId,
          roleId: apiFixture.restrictedRoleId,
          storeId: BEAUTY_STORE_ID,
        },
      ],
    });
    adminToken = await issueAdminToken(apiFixture.adminId, new Date());
    staleAdminToken = await issueAdminToken(
      apiFixture.staleAdminId,
      new Date(Date.now() - 11 * 60 * 1_000),
    );
    restrictedAdminToken = await issueAdminToken(apiFixture.restrictedAdminId, new Date());

    const encrypted = (value: string) => encryptSensitive(value, config.PII_ENCRYPTION_KEY);
    await owner.warehouseFulfillmentProfile.create({
      data: {
        contactNameCiphertext: encrypted('M56 Warehouse Contact'),
        detailCiphertext: encrypted('12 Nguyen Trai'),
        districtCode: 'ba-dinh',
        districtName: 'Ba Dinh',
        enabled: true,
        phoneCiphertext: encrypted('+84901234567'),
        provinceCode: 'hn',
        provinceName: 'Ha Noi',
        storeId: BEAUTY_STORE_ID,
        updatedByAdminId: apiFixture.adminId,
        wardCode: 'phuc-xa',
        wardName: 'Phuc Xa',
        warehouseId,
      },
    });
    await owner.storeShippingChannel.create({
      data: {
        defaultServiceCode: 'GHN:53320:2',
        id: apiFixture.channelId,
        keyVersion: 'm56-api-v1',
        originAllowlistKey: 'GHN_SANDBOX',
        providerCode: 'GHN',
        providerEnvironment: 'SANDBOX',
        secretFingerprint: digest(`api-shipping-${suffix}`),
        shopId: `sandbox-${shopId}`,
        status: 'ACTIVE',
        storeId: BEAUTY_STORE_ID,
        tokenSecretRef: `test://m56/${suffix}/ghn-token`,
      },
    });
    await owner.brand.create({
      data: { code: `m56-api-brand-${suffix}`, id: apiFixture.brandId, storeId: BEAUTY_STORE_ID },
    });
    await owner.product.create({
      data: {
        attributeTemplateVersionId: BEAUTY_TEMPLATE_ID,
        brandId: apiFixture.brandId,
        code: `m56-api-product-${suffix}`,
        id: apiFixture.productId,
        mainCategoryId: BEAUTY_CATEGORY_ID,
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.sku.create({
      data: {
        code: `m56-api-sku-${suffix}`,
        heightMillimeters: 80,
        id: apiFixture.skuId,
        lengthMillimeters: 180,
        optionCombinationHash: digest(`m56-api-option-${suffix}`),
        optionCombinationKey: `m56-api=${suffix}`,
        productId: apiFixture.productId,
        salePriceVnd: 120_000,
        storeId: BEAUTY_STORE_ID,
        weightGrams: 250,
        widthMillimeters: 120,
      },
    });
    await owner.member.create({ data: { id: apiFixture.memberId, storeId: BEAUTY_STORE_ID } });
    memberToken = await issueMemberToken(apiFixture.memberId);
    await owner.inventoryBalance.create({
      data: {
        skuId: apiFixture.skuId,
        storeId: BEAUTY_STORE_ID,
        warehouseId,
      },
    });
    await adjustInventory(runtime, context(), {
      items: [
        {
          delta: 5,
          expectedVersion: 1,
          reasonCode: 'M56_API_TEST_STOCK',
          skuId: apiFixture.skuId,
          warehouseId,
        },
      ],
      operationKey: `m56-api-stock-${suffix}`,
      operationType: 'IMPORT',
    });
    const reservation = await reserveInventory(runtime, context(), {
      expiresAt: new Date(Date.now() + 3_600_000),
      items: [{ quantity: 1, skuId: apiFixture.skuId, warehouseId }],
      operationKey: `m56-api-reservation-${suffix}`,
    });
    const apiOrder = await owner.order.create({
      data: {
        baseSubtotalVnd: 120_000,
        couponDiscountVnd: 0,
        currency: 'VND',
        itemDiscountVnd: 0,
        memberId: apiFixture.memberId,
        orderDiscountVnd: 0,
        orderNumber: `M56-API-${suffix}`,
        payableVnd: 120_000,
        paymentMethod: 'COD',
        paymentStatus: 'PENDING',
        quoteHash: digest(`api-quote-${suffix}`),
        remoteSurchargeVnd: 0,
        reservationId: reservation.result.reservation_id,
        shippingDiscountVnd: 0,
        shippingFeeVnd: 0,
        status: 'PENDING_FULFILLMENT',
        storeId: BEAUTY_STORE_ID,
      },
    });
    apiOrderId = apiOrder.id;
    await owner.orderItem.create({
      data: {
        brandId: apiFixture.brandId,
        brandName: 'M56 Brand',
        categoryId: BEAUTY_CATEGORY_ID,
        couponDiscountVnd: 0,
        heightMillimeters: 80,
        itemDiscountVnd: 0,
        lengthMillimeters: 180,
        optionSnapshot: {},
        orderDiscountVnd: 0,
        orderId: apiOrder.id,
        payableVnd: 120_000,
        productId: apiFixture.productId,
        productName: 'M56 Product',
        quantity: 1,
        skuCode: `m56-api-sku-${suffix}`,
        skuId: apiFixture.skuId,
        storeId: BEAUTY_STORE_ID,
        subtotalVnd: 120_000,
        unitPriceVnd: 120_000,
        weightGrams: 250,
        widthMillimeters: 120,
      },
    });
    const destinationSnapshot = {
      detail_ciphertext: encrypted('18 Tran Hung Dao'),
      district_code: 'ba-dinh',
      phone_ciphertext: encrypted('+84901234568'),
      province_code: 'hn',
      recipient_name_ciphertext: encrypted('M56 Buyer'),
      ward_code: 'phuc-xa',
    };
    await owner.orderSnapshot.create({
      data: {
        orderId: apiOrder.id,
        payload: destinationSnapshot,
        payloadHash: digest(JSON.stringify(destinationSnapshot)),
        snapshotType: 'ADDRESS',
        storeId: BEAUTY_STORE_ID,
      },
    });
    const foreignMember = await owner.member.create({
      data: { storeId: FASHION_STORE_ID },
    });
    const foreignOrder = await owner.order.create({
      data: {
        baseSubtotalVnd: 80_000,
        couponDiscountVnd: 0,
        currency: 'VND',
        itemDiscountVnd: 0,
        memberId: foreignMember.id,
        orderDiscountVnd: 0,
        orderNumber: `M56-FOREIGN-${suffix}`,
        payableVnd: 80_000,
        paymentMethod: 'COD',
        paymentStatus: 'PENDING',
        quoteHash: digest(`foreign-quote-${suffix}`),
        remoteSurchargeVnd: 0,
        shippingDiscountVnd: 0,
        shippingFeeVnd: 0,
        status: 'PENDING_FULFILLMENT',
        storeId: FASHION_STORE_ID,
      },
    });
    foreignOrderId = foreignOrder.id;

    const [{ AppModule }, { ApiExceptionFilter }] = await Promise.all([
      import('../../apps/api/src/app.module'),
      import('../../apps/api/src/api-exception.filter'),
    ]);
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SHIPPING_PROVIDER)
      .useValue(providerResolver)
      .compile();
    app = module.createNestApplication({ rawBody: true });
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await Promise.allSettled([owner.$disconnect(), runtime.$disconnect()]);
    if (scratchCreated) {
      assertScratchName();
      await admin.$executeRawUnsafe(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${scratchDatabaseName}' AND pid <> pg_backend_pid()`,
      );
      assertScratchName();
      await admin.$executeRawUnsafe(`DROP DATABASE "${scratchDatabaseName}"`);
    }
    await admin.$disconnect();
  }, 60_000);

  it('resolves exactly one GHN callback channel before tenant context exists', async () => {
    await expect(resolveShippingCallbackChannel(runtime, shopId)).resolves.toMatchObject({
      channelId,
      providerCode: 'GHN',
      providerEnvironment: 'PRODUCTION',
      storeId: BEAUTY_STORE_ID,
    });
    await expect(resolveShippingCallbackChannel(runtime, '123456789')).rejects.toMatchObject({
      code: 'SHIPPING_CALLBACK_CHANNEL_INVALID',
    });
  });

  it('fails closed when a ShopId resolves to channels in more than one store or environment', async () => {
    await owner.storeShippingChannel.create({
      data: {
        defaultServiceCode: 'GHN:53320:2',
        keyVersion: 'm56-collision-v1',
        originAllowlistKey: 'GHN_SANDBOX',
        providerCode: 'GHN',
        providerEnvironment: 'SANDBOX',
        secretFingerprint: digest(`shipping-collision-${suffix}`),
        shopId,
        status: 'DISABLED',
        storeId: FASHION_STORE_ID,
        tokenSecretRef: `env:GHN_M56_COLLISION_${suffix}_TOKEN`,
      },
    });
    await expect(resolveShippingCallbackChannel(runtime, shopId)).rejects.toMatchObject({
      code: 'SHIPPING_CALLBACK_CHANNEL_INVALID',
    });
  });

  it('deduplicates unsigned hints and schedules only an authoritative query', async () => {
    const payloadDigest = digest(`callback-payload-${suffix}`);
    const externalEventId = `ghn-hint:${payloadDigest}`;
    const input = {
      channelId,
      clientOrderCode: `SHP-${suffix}`,
      environment: 'PRODUCTION' as const,
      eventDigest: digest(`callback-event-${suffix}`),
      externalEventId,
      payloadDigest,
      providerShipmentId: `GHN-${suffix}`,
    };
    const first = await recordShippingCallbackHint(runtime, context(), input);
    const replay = await recordShippingCallbackHint(runtime, context(), input);
    expect(first).toMatchObject({ duplicate: false, queryScheduled: true, shipmentId });
    expect(replay).toMatchObject({ duplicate: true, queryScheduled: true });

    const [callback, inbox, operations, messages, shipment, order] = await Promise.all([
      owner.providerCallback.findMany({ where: { channelId, externalEventId } }),
      owner.inboxMessage.findMany({ where: { channelId, externalMessageKey: externalEventId } }),
      owner.shippingOperation.findMany({
        where: { operationType: 'QUERY_TRACKING', shipmentId },
      }),
      owner.outboxMessage.findMany({
        where: { aggregateId: shipmentId, eventType: 'shipment.query.requested' },
      }),
      owner.shipment.findUniqueOrThrow({ where: { id: shipmentId } }),
      owner.order.findUniqueOrThrow({ where: { id: orderId } }),
    ]);
    expect(callback).toHaveLength(1);
    expect(callback[0]).toMatchObject({
      processingStatus: 'PROCESSED',
      signatureStatus: 'NOT_AVAILABLE',
      trust: 'UNVERIFIED_HINT',
    });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.status).toBe('COMPLETED');
    expect(operations).toHaveLength(1);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.payload).toEqual({
      operation_id: operations[0]?.id,
      shipment_id: shipmentId,
      store_id: BEAUTY_STORE_ID,
    });
    expect(shipment.status).toBe('PENDING_PICKUP');
    expect(order.status).toBe('PENDING_FULFILLMENT');
  });

  it('rejects a cross-store or unknown shipment hint without scheduling a query', async () => {
    const payloadDigest = digest(`callback-cross-store-${suffix}`);
    const externalEventId = `ghn-hint:${payloadDigest}`;
    const result = await recordShippingCallbackHint(runtime, context(), {
      channelId,
      environment: 'PRODUCTION',
      eventDigest: digest(`callback-cross-event-${suffix}`),
      externalEventId,
      payloadDigest,
      providerShipmentId: 'GHN-OTHER-STORE',
    });
    expect(result).toEqual({ duplicate: false, queryScheduled: false });
    const callback = await owner.providerCallback.findFirstOrThrow({
      where: { channelId, externalEventId },
    });
    expect(callback.processingStatus).toBe('REJECTED');
    expect(callback.lastErrorCode).toBe('SHIPPING_CALLBACK_SHIPMENT_NOT_FOUND');
    await expect(
      owner.outboxMessage.count({
        where: { idempotencyKey: { contains: callback.id } },
      }),
    ).resolves.toBe(0);
  });

  it('advances orders only from authoritative forward facts and preserves succeeded operations', async () => {
    const createFactFixture = async (
      tag: string,
      orderStatus: 'DELIVERED' | 'PENDING_FULFILLMENT',
      shipmentStatus: 'DELIVERED' | 'PENDING_PICKUP',
    ) => {
      const factMember = await owner.member.create({
        data: { storeId: BEAUTY_STORE_ID },
      });
      const order = await owner.order.create({
        data: {
          baseSubtotalVnd: 100_000,
          couponDiscountVnd: 0,
          currency: 'VND',
          itemDiscountVnd: 0,
          memberId: factMember.id,
          orderDiscountVnd: 0,
          orderNumber: `M56-FACT-${tag}-${suffix}`,
          payableVnd: 100_000,
          paymentMethod: 'COD',
          paymentStatus: 'PENDING',
          quoteHash: digest(`fact-quote-${tag}-${suffix}`),
          remoteSurchargeVnd: 0,
          shippingDiscountVnd: 0,
          shippingFeeVnd: 0,
          status: orderStatus,
          storeId: BEAUTY_STORE_ID,
        },
      });
      const shipment = await owner.shipment.create({
        data: {
          addressSnapshotCiphertext: 'encrypted-address',
          channelId,
          clientOrderCode: `SHP-FACT-${tag}-${suffix}`,
          ...(shipmentStatus === 'DELIVERED' ? { deliveredAt: new Date() } : {}),
          orderId: order.id,
          parcelSnapshot: { height_cm: 1, length_cm: 1, weight_grams: 1, width_cm: 1 },
          providerShipmentId: `GHN-FACT-${tag}-${suffix}`,
          publicShipmentNumber: `SHP-FACT-${tag}-${suffix}`,
          serviceCode: 'GHN:53320:2',
          status: shipmentStatus,
          storeId: BEAUTY_STORE_ID,
          warehouseId,
        },
      });
      const operation = await owner.shippingOperation.create({
        data: {
          channelId,
          correlationId: `m56-fact-${tag}`,
          idempotencyKeyHash: digest(`fact-idempotency-${tag}-${suffix}`),
          operationType: 'QUERY_TRACKING',
          orderId: order.id,
          requestHash: digest(`fact-request-${tag}-${suffix}`),
          shipmentId: shipment.id,
          storeId: BEAUTY_STORE_ID,
        },
      });
      return { operation, order, shipment };
    };

    const delivered = await createFactFixture('delivered', 'PENDING_FULFILLMENT', 'PENDING_PICKUP');
    await applyShippingProviderFact(runtime, context(), {
      fact: {
        occurredAt: new Date(),
        providerShipmentId: delivered.shipment.providerShipmentId!,
        providerStatus: 'delivered',
        status: 'DELIVERED',
      },
      operationId: delivered.operation.id,
      operationType: 'QUERY_TRACKING',
      shipmentId: delivered.shipment.id,
      source: 'QUERY',
    });
    const [deliveredOrder, deliveredShipment, deliveredTransitions] = await Promise.all([
      owner.order.findUniqueOrThrow({ where: { id: delivered.order.id } }),
      owner.shipment.findUniqueOrThrow({ where: { id: delivered.shipment.id } }),
      owner.orderTransition.findMany({
        orderBy: { createdAt: 'asc' },
        where: { orderId: delivered.order.id },
      }),
    ]);
    expect(deliveredOrder.status).toBe('DELIVERED');
    expect(deliveredShipment.status).toBe('DELIVERED');
    expect(deliveredTransitions.map((transition) => transition.event)).toEqual(['SHIP', 'DELIVER']);

    await recordShippingOperationError(runtime, context(), {
      errorCode: 'LATE_PROVIDER_REJECTION',
      operationId: delivered.operation.id,
      status: 'FAILED',
    });
    await expect(
      owner.shippingOperation.findUniqueOrThrow({ where: { id: delivered.operation.id } }),
    ).resolves.toMatchObject({ errorCode: null, status: 'SUCCEEDED' });

    const unknown = await createFactFixture('unknown', 'PENDING_FULFILLMENT', 'PENDING_PICKUP');
    await applyShippingProviderFact(runtime, context(), {
      fact: {
        providerShipmentId: unknown.shipment.providerShipmentId!,
        providerStatus: 'future_state',
      },
      operationId: unknown.operation.id,
      operationType: 'QUERY_TRACKING',
      shipmentId: unknown.shipment.id,
      source: 'QUERY',
    });
    await expect(
      owner.shipment.findUniqueOrThrow({ where: { id: unknown.shipment.id } }),
    ).resolves.toMatchObject({ status: 'REVIEW_REQUIRED' });
    await expect(
      owner.order.findUniqueOrThrow({ where: { id: unknown.order.id } }),
    ).resolves.toMatchObject({ status: 'PENDING_FULFILLMENT' });

    const backward = await createFactFixture('backward', 'DELIVERED', 'DELIVERED');
    await applyShippingProviderFact(runtime, context(), {
      fact: {
        providerShipmentId: backward.shipment.providerShipmentId!,
        providerStatus: 'transporting',
        status: 'IN_TRANSIT',
      },
      operationId: backward.operation.id,
      operationType: 'QUERY_TRACKING',
      shipmentId: backward.shipment.id,
      source: 'QUERY',
    });
    await expect(
      owner.shipment.findUniqueOrThrow({ where: { id: backward.shipment.id } }),
    ).resolves.toMatchObject({ status: 'REVIEW_REQUIRED' });
    await expect(
      owner.order.findUniqueOrThrow({ where: { id: backward.order.id } }),
    ).resolves.toMatchObject({ status: 'DELIVERED' });
  });

  it('keeps non-order shipment facts isolated from the original order aggregate', async () => {
    const cases = [
      {
        afterSaleStatus: 'APPROVED' as const,
        afterSaleType: 'RETURN_REFUND' as const,
        purpose: 'AFTER_SALE_RETURN' as const,
        tag: 'RETURN',
      },
      {
        afterSaleStatus: 'EXCHANGE_PENDING' as const,
        afterSaleType: 'EXCHANGE' as const,
        purpose: 'EXCHANGE_OUTBOUND' as const,
        tag: 'EXCHANGE',
      },
    ];

    for (const fixture of cases) {
      const afterSale = await owner.$transaction(async (transaction) => {
        await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
        try {
          return await transaction.afterSale.create({
            data: {
              correlationId: `m56-purpose-${fixture.tag.toLowerCase()}-${suffix}`,
              idempotencyKeyHash: digest(`purpose-idempotency-${fixture.tag}-${suffix}`),
              initiatedBy: memberId,
              legacyPolicyReview: true,
              memberId,
              orderId,
              publicCaseNumber: `ASC-M56${fixture.tag}${suffix}`.toUpperCase(),
              reasonCode: 'M56_SHIPPING_PURPOSE_REGRESSION',
              requestHash: digest(`purpose-request-${fixture.tag}-${suffix}`),
              source: 'MEMBER',
              status: fixture.afterSaleStatus,
              storeId: BEAUTY_STORE_ID,
              type: fixture.afterSaleType,
            },
          });
        } finally {
          await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
        }
      });
      const providerShipmentId = `GHN-M63-${fixture.tag}-${suffix}`;
      const shipment = await owner.shipment.create({
        data: {
          addressSnapshotCiphertext: 'encrypted-after-sale-address',
          afterSaleId: afterSale.id,
          channelId,
          clientOrderCode: `SHP-M63-${fixture.tag}-${suffix}`,
          orderId,
          parcelSnapshot: { height_cm: 1, length_cm: 1, weight_grams: 1, width_cm: 1 },
          providerShipmentId,
          publicShipmentNumber: `SHP-M63-${fixture.tag}-${suffix}`,
          purpose: fixture.purpose,
          serviceCode: 'GHN:53320:2',
          status: 'PENDING_PICKUP',
          storeId: BEAUTY_STORE_ID,
          warehouseId,
        },
      });
      const operation = await owner.shippingOperation.create({
        data: {
          channelId,
          correlationId: `m56-purpose-operation-${fixture.tag.toLowerCase()}-${suffix}`,
          idempotencyKeyHash: digest(`purpose-operation-idempotency-${fixture.tag}-${suffix}`),
          operationType: 'QUERY_TRACKING',
          orderId,
          requestHash: digest(`purpose-operation-request-${fixture.tag}-${suffix}`),
          shipmentId: shipment.id,
          storeId: BEAUTY_STORE_ID,
        },
      });
      const [orderBefore, transitionCountBefore] = await Promise.all([
        owner.order.findUniqueOrThrow({ where: { id: orderId } }),
        owner.orderTransition.count({ where: { orderId } }),
      ]);

      await applyShippingProviderFact(runtime, context(), {
        fact: {
          occurredAt: new Date(),
          providerShipmentId,
          providerStatus: 'transporting',
          status: 'IN_TRANSIT',
        },
        operationId: operation.id,
        operationType: 'QUERY_TRACKING',
        purpose: fixture.purpose,
        shipmentId: shipment.id,
        source: 'QUERY',
      });

      const [updatedShipment, trackingEvents, updatedOperation, orderAfter, transitionCountAfter] =
        await Promise.all([
          owner.shipment.findUniqueOrThrow({ where: { id: shipment.id } }),
          owner.trackingEvent.findMany({ where: { shipmentId: shipment.id } }),
          owner.shippingOperation.findUniqueOrThrow({ where: { id: operation.id } }),
          owner.order.findUniqueOrThrow({ where: { id: orderId } }),
          owner.orderTransition.count({ where: { orderId } }),
        ]);
      expect(updatedShipment).toMatchObject({
        providerShipmentId,
        purpose: fixture.purpose,
        status: 'IN_TRANSIT',
        version: shipment.version + 1,
      });
      expect(trackingEvents).toHaveLength(1);
      expect(trackingEvents[0]).toMatchObject({
        providerStatus: 'transporting',
        source: 'QUERY',
        status: 'IN_TRANSIT',
      });
      expect(updatedOperation).toMatchObject({ errorCode: null, status: 'SUCCEEDED' });
      expect(orderAfter.status).toBe(orderBefore.status);
      expect(orderAfter.version).toBe(orderBefore.version);
      expect(transitionCountAfter).toBe(transitionCountBefore);
    }
  });

  it('replays a cancellation after its first request increments the shipment version', async () => {
    const idempotencyKey = `m56-cancel-${suffix}`;
    const first = await requestShipmentOperation(runtime, context(), {
      expectedVersion: 1,
      idempotencyKey,
      operationType: 'CANCEL',
      reason: 'M5.6 integration cancellation idempotency check',
      shipmentId,
    });
    const replay = await requestShipmentOperation(runtime, context(), {
      expectedVersion: 1,
      idempotencyKey,
      operationType: 'CANCEL',
      reason: 'M5.6 integration cancellation idempotency check',
      shipmentId,
    });
    expect(first).toMatchObject({ replayed: false, version: 2 });
    expect(replay).toMatchObject({ operationId: first.operationId, replayed: true, version: 2 });
    await expect(
      owner.outboxMessage.count({
        where: { aggregateId: shipmentId, eventType: 'shipment.cancel.requested' },
      }),
    ).resolves.toBe(1);
  });

  it('retries cancellation until an in-flight creation records its provider reference', async () => {
    const raceMember = await owner.member.create({ data: { storeId: BEAUTY_STORE_ID } });
    const raceOrder = await owner.order.create({
      data: {
        baseSubtotalVnd: 100_000,
        couponDiscountVnd: 0,
        currency: 'VND',
        itemDiscountVnd: 0,
        memberId: raceMember.id,
        orderDiscountVnd: 0,
        orderNumber: `M56-CANCEL-RACE-${suffix}`,
        payableVnd: 100_000,
        paymentMethod: 'COD',
        paymentStatus: 'PENDING',
        quoteHash: digest(`cancel-race-quote-${suffix}`),
        remoteSurchargeVnd: 0,
        shippingDiscountVnd: 0,
        shippingFeeVnd: 0,
        status: 'PENDING_FULFILLMENT',
        storeId: BEAUTY_STORE_ID,
      },
    });
    const raceShipment = await owner.shipment.create({
      data: {
        addressSnapshotCiphertext: 'encrypted-cancel-race-address',
        channelId,
        clientOrderCode: `SHP-CANCEL-RACE-${suffix}`,
        orderId: raceOrder.id,
        parcelSnapshot: { height_cm: 1, length_cm: 1, weight_grams: 1, width_cm: 1 },
        publicShipmentNumber: `SHP-CANCEL-RACE-${suffix}`,
        purpose: 'ORDER_OUTBOUND',
        serviceCode: 'GHN:53320:2',
        status: 'CREATION_PENDING',
        storeId: BEAUTY_STORE_ID,
        warehouseId,
      },
    });
    const createOperation = await owner.shippingOperation.create({
      data: {
        channelId,
        correlationId: `m56-cancel-race-create-${suffix}`,
        idempotencyKeyHash: digest(`cancel-race-create-idempotency-${suffix}`),
        operationType: 'CREATE',
        orderId: raceOrder.id,
        requestHash: digest(`cancel-race-create-request-${suffix}`),
        shipmentId: raceShipment.id,
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.shipment.update({
      data: { createdOperationId: createOperation.id },
      where: { id: raceShipment.id },
    });
    const cancel = await requestShipmentOperation(runtime, context(), {
      expectedVersion: raceShipment.version,
      idempotencyKey: `m56-cancel-race-${suffix}`,
      operationType: 'CANCEL',
      reason: 'Cancel while the provider creation call is still in flight',
      shipmentId: raceShipment.id,
    });

    await expect(
      getShipmentProviderOperationRequest(runtime, context(), raceShipment.id, cancel.operationId),
    ).rejects.toMatchObject({ code: 'SHIPMENT_PROVIDER_REFERENCE_PENDING' });

    const providerShipmentId = `GHN-CANCEL-RACE-${suffix}`;
    await recordShipmentCreated(runtime, context(), {
      fact: {
        clientOrderCode: raceShipment.clientOrderCode,
        providerShipmentId,
        providerStatus: 'ready_to_pick',
        status: 'PENDING_PICKUP',
      },
      operationId: createOperation.id,
      purpose: 'ORDER_OUTBOUND',
      shipmentId: raceShipment.id,
    });

    await expect(
      getShipmentProviderOperationRequest(runtime, context(), raceShipment.id, cancel.operationId),
    ).resolves.toMatchObject({
      operationId: cancel.operationId,
      operationStatus: 'PENDING',
      operationType: 'CANCEL',
      providerShipmentId,
      purpose: 'ORDER_OUTBOUND',
      shipmentId: raceShipment.id,
    });
  });

  it('allows only one active shipment under concurrent inserts', async () => {
    const concurrentMemberId = randomUUID();
    await owner.member.create({
      data: { id: concurrentMemberId, storeId: BEAUTY_STORE_ID },
    });
    const concurrentOrder = await owner.order.create({
      data: {
        baseSubtotalVnd: 100_000,
        couponDiscountVnd: 0,
        currency: 'VND',
        itemDiscountVnd: 0,
        memberId: concurrentMemberId,
        orderDiscountVnd: 0,
        orderNumber: `M56-CONCURRENT-${suffix}`,
        payableVnd: 100_000,
        paymentMethod: 'COD',
        paymentStatus: 'PENDING',
        quoteHash: digest(`concurrent-quote-${suffix}`),
        remoteSurchargeVnd: 0,
        shippingDiscountVnd: 0,
        shippingFeeVnd: 0,
        status: 'PENDING_FULFILLMENT',
        storeId: BEAUTY_STORE_ID,
      },
    });
    const create = (tag: string) =>
      owner.shipment.create({
        data: {
          addressSnapshotCiphertext: 'encrypted-address',
          channelId,
          clientOrderCode: `SHP-${suffix}-${tag}`,
          orderId: concurrentOrder.id,
          parcelSnapshot: { height_cm: 1, length_cm: 1, weight_grams: 1, width_cm: 1 },
          publicShipmentNumber: `SHP-${suffix}-${tag}`,
          serviceCode: 'GHN:53320:2',
          storeId: BEAUTY_STORE_ID,
          warehouseId,
        },
      });
    const results = await Promise.allSettled([create('A'), create('B')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await expect(owner.shipment.count({ where: { orderId: concurrentOrder.id } })).resolves.toBe(1);
  });

  it('protects fulfillment configuration with store scope, RBAC and recent MFA', async () => {
    const areaPath = `/v1/admin/inventory/administrative-areas?store_id=${BEAUTY_STORE_ID}&level=PROVINCE`;
    await api().get(areaPath).expect(401);
    await api().get(areaPath).set(adminHeaders(restrictedAdminToken)).expect(403);
    await api()
      .get(`/v1/admin/inventory/administrative-areas?store_id=${FASHION_STORE_ID}&level=PROVINCE`)
      .set(adminHeaders())
      .expect(403);
    const areas = await api().get(areaPath).set(adminHeaders()).expect(200);
    expect(areas.body.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'hn', level: 'PROVINCE' })]),
    );

    const profileBody = {
      confirmation_code: 'FULFILLMENT',
      contact_name: 'Updated M56 Warehouse Contact',
      detail: '20 Nguyen Trai',
      district_code: 'ba-dinh',
      enabled: true,
      expected_profile_version: 1,
      phone: '+84901234569',
      province_code: 'hn',
      ward_code: 'phuc-xa',
    };
    const profilePath = `/v1/admin/inventory/warehouses/${warehouseId}/fulfillment-profile?store_id=${BEAUTY_STORE_ID}`;
    await api().put(profilePath).set(adminHeaders(staleAdminToken)).send(profileBody).expect(403);
    const updated = await api().put(profilePath).set(adminHeaders()).send(profileBody).expect(200);
    expect(updated.body).toMatchObject({ configured: true, enabled: true, version: 2 });
    expect(JSON.stringify(updated.body)).not.toContain(profileBody.contact_name);
    expect(JSON.stringify(updated.body)).not.toContain(profileBody.phone);
    expect(JSON.stringify(updated.body)).not.toContain(profileBody.detail);
    const stored = await owner.warehouseFulfillmentProfile.findUniqueOrThrow({
      where: { storeId_warehouseId: { storeId: BEAUTY_STORE_ID, warehouseId } },
    });
    expect(stored.contactNameCiphertext).not.toContain(profileBody.contact_name);
    expect(stored.phoneCiphertext).not.toContain(profileBody.phone);
    expect(stored.detailCiphertext).not.toContain(profileBody.detail);
  });

  it('rejects shipping quote tampering and derives the quote from trusted order facts', async () => {
    const quotePath = `/v1/admin/shipping/quotes?store_id=${BEAUTY_STORE_ID}`;
    await api().post(quotePath).send({ order_id: apiOrderId }).expect(401);
    await api()
      .post(quotePath)
      .set(adminHeaders(restrictedAdminToken))
      .send({ order_id: apiOrderId })
      .expect(403);
    await api()
      .post(`/v1/admin/shipping/quotes?store_id=${FASHION_STORE_ID}`)
      .set(adminHeaders())
      .send({ order_id: foreignOrderId })
      .expect(403);
    await api()
      .post(quotePath)
      .set(adminHeaders())
      .send({
        amount_vnd: 1,
        destination: 'attacker supplied',
        order_id: apiOrderId,
        provider_shipment_id: 'FORGED',
        weight_grams: 1,
      })
      .expect(400);
    expect(providerQuote).not.toHaveBeenCalled();

    const quote = await api()
      .post(quotePath)
      .set(adminHeaders())
      .send({ order_id: apiOrderId })
      .expect(201);
    expect(quote.body).toMatchObject({
      base_fee_vnd: 22_000,
      cod_fee_vnd: 500,
      insurance_fee_vnd: 300,
      other_fee_vnd: 700,
      remote_fee_vnd: 1_500,
      service_code: 'GHN:53320:2',
      total_fee_vnd: 25_000,
    });
    const storedQuote = await owner.shippingQuote.findUniqueOrThrow({
      where: { id: quote.body.id as string },
    });
    expect(storedQuote).toMatchObject({
      baseFeeVnd: 22_000n,
      codFeeVnd: 500n,
      insuranceFeeVnd: 300n,
      otherFeeVnd: 700n,
      providerServiceId: 53320,
      providerServiceTypeId: 2,
      remoteFeeVnd: 1_500n,
      totalFeeVnd: 25_000n,
    });
    expect(providerQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        codAmountVnd: 120_000,
        destination: expect.objectContaining({
          addressLine: '18 Tran Hung Dao',
          phoneE164: '+84901234568',
        }),
        origin: expect.objectContaining({
          addressLine: '20 Nguyen Trai',
          phoneE164: '+84901234569',
        }),
        parcel: { heightCm: 8, lengthCm: 18, weightGrams: 250, widthCm: 12 },
        storeId: BEAUTY_STORE_ID,
      }),
    );
    expect(JSON.stringify(quote.body)).not.toContain('+84901234568');
    expect(JSON.stringify(quote.body)).not.toContain('Tran Hung Dao');
  });

  it('requires fresh MFA, creates one shipment idempotently and prevents order IDOR', async () => {
    const createPath = `/v1/admin/orders/${apiOrderId}/shipments?store_id=${BEAUTY_STORE_ID}`;
    const createBody = {
      confirmation_code: 'CREATE_SHIPMENT',
      expected_order_version: 1,
      inspection_policy: 'NO_INSPECTION',
      reason: 'Create the reviewed M5.6 API integration shipment',
      service_code: 'GHN:53320:2',
    };
    await api()
      .post(createPath)
      .set({ ...adminHeaders(staleAdminToken), 'Idempotency-Key': `m56-stale-${suffix}` })
      .send(createBody)
      .expect(403);
    await api()
      .post(createPath)
      .set({ ...adminHeaders(), 'Idempotency-Key': `m56-tampered-${suffix}` })
      .send({ ...createBody, cod_amount_vnd: 1, provider_shipment_id: 'FORGED' })
      .expect(400);
    const idempotencyKey = `m56-create-api-${suffix}`;
    const created = await api()
      .post(createPath)
      .set({ ...adminHeaders(), 'Idempotency-Key': idempotencyKey })
      .send(createBody)
      .expect(202);
    apiShipmentId = created.body.shipment_id as string;
    expect(created.body).toMatchObject({
      replayed: false,
      status: 'CREATION_PENDING',
      version: 1,
    });
    const replay = await api()
      .post(createPath)
      .set({ ...adminHeaders(), 'Idempotency-Key': idempotencyKey })
      .send(createBody)
      .expect(202);
    expect(replay.body).toMatchObject({ replayed: true, shipment_id: apiShipmentId });
    await api()
      .post(createPath)
      .set({ ...adminHeaders(), 'Idempotency-Key': `m56-second-create-${suffix}` })
      .send(createBody)
      .expect(409);

    const memberShipment = await api()
      .get(`/v1/orders/${apiOrderId}/shipment`)
      .set(memberHeaders())
      .expect(200);
    expect(memberShipment.body.shipment).toMatchObject({
      public_number: created.body.public_number,
      status: 'CREATION_PENDING',
    });
    expect(memberShipment.body.shipment).not.toHaveProperty('shipment_id');
    expect(memberShipment.body.shipment).not.toHaveProperty('provider_reference_masked');
    await api().get(`/v1/orders/${foreignOrderId}/shipment`).set(memberHeaders()).expect(404);
    await api()
      .get(`/v1/admin/orders/${apiOrderId}/shipment?store_id=${BEAUTY_STORE_ID}`)
      .set(adminHeaders(restrictedAdminToken))
      .expect(403);
    await api()
      .get(`/v1/admin/orders/${foreignOrderId}/shipment?store_id=${BEAUTY_STORE_ID}`)
      .set(adminHeaders())
      .expect(404);
  });

  it('keeps operation requests scoped and rejects malicious label proxy targets', async () => {
    await owner.shipment.update({
      data: { providerShipmentId: `GHN-API-${suffix}`, status: 'PENDING_PICKUP' },
      where: { id: apiShipmentId },
    });
    const syncPath = `/v1/admin/shipments/${apiShipmentId}/sync?store_id=${BEAUTY_STORE_ID}`;
    await api()
      .post(syncPath)
      .set({ ...adminHeaders(staleAdminToken), 'Idempotency-Key': `m56-stale-sync-${suffix}` })
      .send({
        confirmation_code: 'SYNC_SHIPMENT',
        expected_version: 1,
        reason: 'Synchronize the M5.6 shipment after operations review',
      })
      .expect(403);
    await api()
      .post(syncPath)
      .set({ ...adminHeaders(), 'Idempotency-Key': `m56-tampered-sync-${suffix}` })
      .send({
        confirmation_code: 'SYNC_SHIPMENT',
        expected_version: 1,
        provider_status: 'DELIVERED',
        reason: 'Attempt to inject a provider shipment status',
      })
      .expect(400);
    await api()
      .post(`/v1/admin/shipments/${apiShipmentId}/sync?store_id=${FASHION_STORE_ID}`)
      .set({ ...adminHeaders(), 'Idempotency-Key': `m56-cross-sync-${suffix}` })
      .send({
        confirmation_code: 'SYNC_SHIPMENT',
        expected_version: 1,
        reason: 'Attempt a cross-store shipment synchronization',
      })
      .expect(403);

    const issued = await api()
      .get(`/v1/admin/shipments/${apiShipmentId}/label?store_id=${BEAUTY_STORE_ID}&format=A5`)
      .set(adminHeaders())
      .expect(200);
    expect(issued.body.url).toMatch(/^\/v1\/shipping\/labels\/[A-Za-z0-9._-]+$/u);
    expect(issued.body.url).not.toContain('attacker.example');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await api()
      .get(issued.body.url as string)
      .expect(503);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    await api().get('/v1/shipping/labels/not-a-valid-token').expect(401);
  });
});
