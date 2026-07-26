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
  applyPaymentProviderFact,
  createRuntimePrismaClient,
  expireDueReservations,
  PrismaClient,
  reconcileReservationBackedOrders,
  withStoreTransaction,
} from '@zalo-shop/database';
import { createStoreContext } from '@zalo-shop/domain';
import { DeterministicPaymentTestProvider, type PaymentProvider } from '@zalo-shop/integrations';
import { hashSensitive, signJwt } from '@zalo-shop/security';

import { PAYMENT_PROVIDER } from '../../apps/api/src/payments/payment.tokens';
import { PaymentCreateRequestedHandler } from '../../apps/worker/src/payments/payment-create-requested.handler';
import { OutboxMessageDispatcher } from '../../apps/worker/src/reliable-messaging/outbox-message-handler';
import { ReliableOutboxService } from '../../apps/worker/src/reliable-messaging/reliable-outbox.service';

const REPOSITORY_ROOT = resolve(__dirname, '../..');
const BEAUTY_STORE_ID = '10000000-0000-4000-8000-000000000001';
const FASHION_STORE_ID = '10000000-0000-4000-8000-000000000002';
const BEAUTY_CATEGORY_ID = '12000000-0000-4000-8000-000000000001';
const BEAUTY_TEMPLATE_ID = '14000000-0000-4000-8000-000000000001';
const BEAUTY_WAREHOUSE_ID = '17000000-0000-4000-8000-000000000001';
const WORKER_ACTOR_ID = '00000000-0000-4000-8000-000000000006';
const SCRATCH_DATABASE_PATTERN = /^zalo_shop_m54_[0-9a-f]{12}$/u;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

describe('M5.4 online payment core and test adapter', () => {
  loadEnvironment({ path: '.env.test.example', quiet: true, override: true });
  const sourceOwnerUrl = process.env.DATABASE_URL;
  const sourceRuntimeUrl = process.env.DATABASE_RUNTIME_URL;
  if (!sourceOwnerUrl || !sourceRuntimeUrl) throw new Error('M5.4 database URLs are required');

  const scratchDatabaseName = `zalo_shop_m54_${randomBytes(6).toString('hex')}`;
  const ownerUrl = scratchUrl(sourceOwnerUrl, scratchDatabaseName);
  const runtimeUrl = scratchUrl(sourceRuntimeUrl, scratchDatabaseName);
  const adminUrl = scratchUrl(sourceOwnerUrl, 'postgres');
  process.env.DATABASE_URL = ownerUrl;
  process.env.DATABASE_RUNTIME_URL = runtimeUrl;
  const config = parseRuntimeConfig();
  const admin = new PrismaClient({ datasourceUrl: adminUrl });
  let owner: PrismaClient | undefined;
  let runtime: ReturnType<typeof createRuntimePrismaClient> | undefined;
  let app: INestApplication;
  let outboxWorker: ReliableOutboxService | undefined;
  let scratchCreated = false;
  let memberToken = '';
  let secondMemberToken = '';
  let addressId = '';
  const suffix = randomUUID().slice(0, 8);
  const fixture = {
    balanceId: randomUUID(),
    brandId: randomUUID(),
    channelId: randomUUID(),
    memberId: randomUUID(),
    productId: randomUUID(),
    secondMemberId: randomUUID(),
    skuId: randomUUID(),
  };
  const skuCode = `m54-pay-${suffix}`;

  function scratchUrl(source: string, databaseName: string): string {
    const url = new URL(source);
    if (!LOOPBACK_HOSTS.has(url.hostname)) {
      throw new Error('M5.4 integration test requires a loopback PostgreSQL host');
    }
    url.pathname = `/${databaseName}`;
    return url.toString();
  }

  function assertScratchName(): void {
    if (process.env.NODE_ENV !== 'test' || !SCRATCH_DATABASE_PATTERN.test(scratchDatabaseName)) {
      throw new Error('Refusing unsafe M5.4 scratch database operation');
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

  function requiredOwner(): PrismaClient {
    if (!owner) throw new Error('M5.4 owner client is unavailable');
    return owner;
  }

  function requiredRuntime() {
    if (!runtime) throw new Error('M5.4 runtime client is unavailable');
    return runtime;
  }

  function api() {
    if (!app) throw new Error('M5.4 API is unavailable');
    return request(app.getHttpServer() as Server);
  }

  function memberHeaders(token = memberToken) {
    return { Authorization: `Bearer ${token}`, 'X-Store-Code': 'beauty-local' };
  }

  function memberContext(storeId = BEAUTY_STORE_ID) {
    return createStoreContext({
      actor: { id: fixture.memberId, type: 'member' },
      correlationId: randomUUID(),
      locale: 'vi',
      storeCode: storeId === BEAUTY_STORE_ID ? 'beauty-local' : 'fashion-local',
      storeId,
    });
  }

  function workerContext(storeId = BEAUTY_STORE_ID) {
    return createStoreContext({
      actor: { id: WORKER_ACTOR_ID, type: 'admin' },
      correlationId: randomUUID(),
      locale: 'vi',
      storeCode: storeId === BEAUTY_STORE_ID ? 'beauty-local' : 'fashion-local',
      storeId,
    });
  }

  async function createOnlineOrder(tag: string) {
    const body = {
      address_id: addressId,
      coupon_code: null,
      items: [{ quantity: 1, sku_code: skuCode }],
      locale: 'vi',
      payment_method: 'ONLINE',
    } as const;
    const quote = await api().post('/v1/checkout/quote').set(memberHeaders()).send(body);
    expect(quote.status).toBe(201);
    expect(quote.body).not.toHaveProperty('payment_policy');
    const idempotencyKey = `m54-order-${tag}-${suffix}`;
    const created = await api()
      .post('/v1/checkout/orders')
      .set({ ...memberHeaders(), 'Idempotency-Key': idempotencyKey })
      .send({ ...body, quote_hash: quote.body.quote_hash });
    expect(created.status).toBe(201);
    return created.body as {
      id: string;
      payment_attempt_id: string;
      payment_status: string;
      payable_vnd: number;
      status: string;
    };
  }

  async function processPaymentCreate(): Promise<void> {
    if (!outboxWorker) throw new Error('M5.4 outbox worker is unavailable');
    await outboxWorker.runOnce();
  }

  async function paymentFact(
    paymentId: string,
    status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN',
    factOverrides?: ConstructorParameters<
      typeof DeterministicPaymentTestProvider
    >[0]['factOverrides'],
  ) {
    const attempt = await requiredOwner().paymentAttempt.findUniqueOrThrow({
      where: { id: paymentId },
    });
    if (!attempt.providerOrderId) throw new Error('M5.4 provider order was not bound');
    const provider = new DeterministicPaymentTestProvider({
      ...(factOverrides ? { factOverrides } : {}),
      nodeEnvironment: 'test',
      secret: config.PAYMENT_TEST_PROVIDER_SECRET!,
      status,
    });
    return provider.queryPayment({
      providerOrderId: attempt.providerOrderId,
      storeId: BEAUTY_STORE_ID,
    });
  }

  beforeAll(async () => {
    assertScratchName();
    await admin.$connect();
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchDatabaseName}"`);
    scratchCreated = true;
    runPackageScript('migrate:deploy');
    runPackageScript('seed');
    owner = new PrismaClient({ datasourceUrl: ownerUrl });
    runtime = createRuntimePrismaClient(runtimeUrl);
    await Promise.all([owner.$connect(), runtime.$connect()]);

    const miniAppId = `m54-beauty-app-${suffix}`;
    await owner.storeZaloApp.update({
      data: { enabled: true, miniAppId, parentAppId: `m54-parent-${suffix}` },
      where: { storeId_environment: { environment: 'TEST', storeId: BEAUTY_STORE_ID } },
    });
    await owner.storePaymentChannel.create({
      data: {
        checkoutAppId: miniAppId,
        deploymentEnvironment: 'TEST',
        id: fixture.channelId,
        keyVersion: 'test-v1',
        merchantReference: `m54-merchant-${suffix}`,
        methodCode: 'ZALOPAY_SANDBOX',
        paymentWindowSeconds: 600,
        privateKeySecretRef: `test://m54/${suffix}/checkout-private-key`,
        providerCode: 'ZALO_CHECKOUT_ZALOPAY',
        providerEnvironment: 'SANDBOX',
        secretFingerprint: createHash('sha256').update(`m54-${suffix}`).digest('hex'),
        status: 'ACTIVE',
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.brand.create({
      data: { code: `m54-brand-${suffix}`, id: fixture.brandId, storeId: BEAUTY_STORE_ID },
    });
    await owner.product.create({
      data: {
        attributeTemplateVersionId: BEAUTY_TEMPLATE_ID,
        brandId: fixture.brandId,
        code: `m54-product-${suffix}`,
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
          name: `Sản phẩm M5.4 ${suffix}`,
          productId: fixture.productId,
          storeId: BEAUTY_STORE_ID,
        },
        {
          locale: 'en',
          name: `M5.4 product ${suffix}`,
          productId: fixture.productId,
          storeId: BEAUTY_STORE_ID,
        },
        {
          locale: 'zh',
          name: `M5.4 商品 ${suffix}`,
          productId: fixture.productId,
          storeId: BEAUTY_STORE_ID,
        },
      ],
    });
    await owner.sku.create({
      data: {
        code: skuCode,
        id: fixture.skuId,
        optionCombinationHash: 'b'.repeat(64),
        optionCombinationKey: `m54=${suffix}`,
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
    await owner.member.createMany({
      data: [
        { id: fixture.memberId, storeId: BEAUTY_STORE_ID },
        { id: fixture.secondMemberId, storeId: BEAUTY_STORE_ID },
      ],
    });
    const [session, secondSession] = await Promise.all([
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
    const token = (memberId: string, sessionId: string) =>
      signJwt(
        {
          actor_type: 'member',
          aud: config.AUTH_JWT_AUDIENCE,
          exp: now + 3_000,
          iat: now,
          iss: config.AUTH_JWT_ISSUER,
          jti: randomUUID(),
          session_id: sessionId,
          store_id: BEAUTY_STORE_ID,
          sub: memberId,
        },
        config.AUTH_JWT_SECRET,
      );
    memberToken = token(fixture.memberId, session.id);
    secondMemberToken = token(fixture.secondMemberId, secondSession.id);
    await adjustInventory(runtime, memberContext(), {
      items: [
        {
          delta: 30,
          expectedVersion: 1,
          reasonCode: 'M54_TEST_INITIAL_STOCK',
          skuId: fixture.skuId,
          warehouseId: BEAUTY_WAREHOUSE_ID,
        },
      ],
      operationKey: `m54-stock-${suffix}`,
      operationType: 'IMPORT',
    });

    const [{ AppModule }, { ApiExceptionFilter }] = await Promise.all([
      import('../../apps/api/src/app.module'),
      import('../../apps/api/src/api-exception.filter'),
    ]);
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    const provider: PaymentProvider | null = app.get(PAYMENT_PROVIDER);
    if (!provider) throw new Error('M5.4 test payment provider is unavailable');
    const dispatcher = new OutboxMessageDispatcher([
      new PaymentCreateRequestedHandler(runtime, provider),
    ]);
    outboxWorker = new ReliableOutboxService(runtime, config, dispatcher);

    const address = await api().post('/v1/member/addresses').set(memberHeaders()).send({
      detail: '12 Nguyen Trai',
      district_code: 'ba-dinh',
      is_default: true,
      phone: '+84901234567',
      province_code: 'hn',
      recipient_name: 'Nguyen M54',
      ward_code: 'phuc-xa',
    });
    if (address.status !== 201) throw new Error(`M5.4 address setup failed: ${address.text}`);
    addressId = address.body.id;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await Promise.allSettled([
      owner?.$disconnect() ?? Promise.resolve(),
      runtime?.$disconnect() ?? Promise.resolve(),
    ]);
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

  it('creates the online order, reservation, first attempt and outbox atomically with RLS isolation', async () => {
    const created = await createOnlineOrder('atomic');
    expect(created).toMatchObject({ payment_status: 'PENDING', status: 'PENDING_PAYMENT' });
    const facts = await withStoreTransaction(
      requiredRuntime(),
      memberContext(),
      async (transaction) => ({
        attempt: await transaction.paymentAttempt.findUnique({
          where: { storeId_id: { id: created.payment_attempt_id, storeId: BEAUTY_STORE_ID } },
        }),
        order: await transaction.order.findUnique({
          where: { storeId_id: { id: created.id, storeId: BEAUTY_STORE_ID } },
        }),
        outbox: await transaction.outboxMessage.findFirst({
          where: { aggregateId: created.payment_attempt_id, storeId: BEAUTY_STORE_ID },
        }),
        reservation: await transaction.inventoryReservation.findFirst({
          where: { order: { id: created.id }, storeId: BEAUTY_STORE_ID },
        }),
      }),
    );
    expect(facts.order).toMatchObject({ paymentMethod: 'ONLINE', status: 'PENDING_PAYMENT' });
    expect(facts.attempt).toMatchObject({ amountVnd: facts.order!.payableVnd, status: 'CREATED' });
    expect(facts.reservation?.status).toBe('ACTIVE');
    expect(facts.outbox).toMatchObject({
      eventType: 'payment.create.requested',
      eventVersion: 1,
      status: 'PENDING',
    });
    expect(
      await withStoreTransaction(
        requiredRuntime(),
        workerContext(FASHION_STORE_ID),
        (transaction) =>
          transaction.paymentAttempt.count({ where: { id: created.payment_attempt_id } }),
      ),
    ).toBe(0);
    const otherMember = await api()
      .get(`/v1/payments/${created.payment_attempt_id}`)
      .set(memberHeaders(secondMemberToken));
    expect(otherMember.status).toBe(404);
  });

  it('uses the reliable worker to bind a deterministic launch and exposes no launch before readiness', async () => {
    const created = await createOnlineOrder('launch');
    const early = await api()
      .get(`/v1/payments/${created.payment_attempt_id}/launch`)
      .set(memberHeaders());
    expect(early.status).toBe(409);
    await processPaymentCreate();
    const detail = await api()
      .get(`/v1/payments/${created.payment_attempt_id}`)
      .set(memberHeaders());
    expect(detail.body).toMatchObject({ launch_ready: true, status: 'PROVIDER_PENDING' });
    const launch = await api()
      .get(`/v1/payments/${created.payment_attempt_id}/launch`)
      .set(memberHeaders());
    expect(launch.status).toBe(200);
    expect(launch.body).toMatchObject({
      kind: 'ZALO_CHECKOUT_CREATE_ORDER',
      payload: { amount: created.payable_vnd },
    });
    expect(launch.body.payload).toHaveProperty('mac');
    expect(launch.body.payload).not.toHaveProperty('private_key');
    const queried = await api()
      .post(`/v1/payments/${created.payment_attempt_id}/query`)
      .set(memberHeaders());
    expect(queried.status).toBe(201);
    expect(queried.body.status).toBe('PROVIDER_PENDING');
  });

  it('commits a matching success once with inventory and both order transitions', async () => {
    const created = await createOnlineOrder('success');
    await processPaymentCreate();
    const fact = await paymentFact(created.payment_attempt_id, 'SUCCEEDED');
    const first = await applyPaymentProviderFact(requiredRuntime(), workerContext(), {
      attemptId: created.payment_attempt_id,
      fact,
      source: 'QUERY',
    });
    const replay = await applyPaymentProviderFact(requiredRuntime(), workerContext(), {
      attemptId: created.payment_attempt_id,
      fact,
      source: 'QUERY',
    });
    expect(first).toMatchObject({
      orderStatus: 'PENDING_FULFILLMENT',
      paymentStatus: 'SUCCEEDED',
      replayed: false,
      status: 'SUCCEEDED',
    });
    expect(replay.replayed).toBe(true);
    const [order, reservation, balance, consumeOperations] = await Promise.all([
      requiredOwner().order.findUniqueOrThrow({
        include: { transitions: { orderBy: { createdAt: 'asc' } } },
        where: { id: created.id },
      }),
      requiredOwner().inventoryReservation.findFirstOrThrow({
        where: { order: { id: created.id } },
      }),
      requiredOwner().inventoryBalance.findUniqueOrThrow({ where: { id: fixture.balanceId } }),
      requiredOwner().inventoryOperation.count({
        where: { operationKey: `m54-payment-consume-${created.payment_attempt_id}` },
      }),
    ]);
    expect(order.transitions.slice(-2).map(({ event }) => event)).toEqual([
      'PAYMENT_SUCCEEDED',
      'FULFILLMENT_READY',
    ]);
    expect(order.confirmedAt!.getTime()).toBeGreaterThanOrEqual(order.createdAt.getTime());
    expect(reservation.status).toBe('CONSUMED');
    expect(balance.onHand).toBe(29);
    expect(consumeOperations).toBe(1);
  });

  it('keeps a failed attempt retryable and enforces one active idempotent retry', async () => {
    const created = await createOnlineOrder('retry');
    await processPaymentCreate();
    await applyPaymentProviderFact(requiredRuntime(), workerContext(), {
      attemptId: created.payment_attempt_id,
      fact: await paymentFact(created.payment_attempt_id, 'FAILED'),
      source: 'QUERY',
    });
    const key = `m54-payment-retry-${suffix}`;
    const retry = await api()
      .post(`/v1/orders/${created.id}/payments`)
      .set({ ...memberHeaders(), 'Idempotency-Key': key })
      .send({});
    expect(retry.status).toBe(201);
    expect(retry.body).toMatchObject({ status: 'CREATED' });
    expect(
      (await requiredOwner().order.findUniqueOrThrow({ where: { id: created.id } })).paymentStatus,
    ).toBe('PENDING');
    const replay = await api()
      .post(`/v1/orders/${created.id}/payments`)
      .set({ ...memberHeaders(), 'Idempotency-Key': key })
      .send({});
    expect(replay.body.id).toBe(retry.body.id);
    const competing = await api()
      .post(`/v1/orders/${created.id}/payments`)
      .set({ ...memberHeaders(), 'Idempotency-Key': `m54-competing-${suffix}` })
      .send({});
    expect(competing.status).toBe(409);
    expect(await requiredOwner().paymentAttempt.count({ where: { orderId: created.id } })).toBe(2);
  });

  it('does not revive a cancelled order when a success arrives late', async () => {
    const created = await createOnlineOrder('late');
    await processPaymentCreate();
    const success = await paymentFact(created.payment_attempt_id, 'SUCCEEDED');
    const cancelled = await api()
      .post(`/v1/orders/${created.id}/cancel`)
      .set(memberHeaders())
      .send({ reason: 'Buyer cancelled before payment completed' });
    expect(cancelled.status).toBe(201);
    const late = await applyPaymentProviderFact(requiredRuntime(), workerContext(), {
      attemptId: created.payment_attempt_id,
      fact: success,
      source: 'QUERY',
    });
    expect(late).toMatchObject({
      orderStatus: 'CANCELLED',
      paymentStatus: 'CANCELLED',
      status: 'REVIEW_REQUIRED',
    });
    const reservation = await requiredOwner().inventoryReservation.findFirstOrThrow({
      where: { order: { id: created.id } },
    });
    expect(reservation.status).toBe('RELEASED');
  });

  it('completes an obsolete create message without calling the provider after cancellation', async () => {
    const created = await createOnlineOrder('cancel-before-worker');
    const cancelled = await api()
      .post(`/v1/orders/${created.id}/cancel`)
      .set(memberHeaders())
      .send({ reason: 'Buyer cancelled before launch preparation' });
    expect(cancelled.status).toBe(201);
    await processPaymentCreate();
    const [attempt, outbox] = await Promise.all([
      requiredOwner().paymentAttempt.findUniqueOrThrow({
        where: { id: created.payment_attempt_id },
      }),
      requiredOwner().outboxMessage.findFirstOrThrow({
        where: { aggregateId: created.payment_attempt_id },
      }),
    ]);
    expect(attempt).toMatchObject({ providerOrderId: null, status: 'CANCELLED' });
    expect(outbox.status).toBe('COMPLETED');
  });

  it('routes tampered and unknown facts to review without consuming inventory', async () => {
    const tamperedOrder = await createOnlineOrder('tampered');
    const unknownOrder = await createOnlineOrder('unknown');
    await processPaymentCreate();
    const tampered = await applyPaymentProviderFact(requiredRuntime(), workerContext(), {
      attemptId: tamperedOrder.payment_attempt_id,
      fact: await paymentFact(tamperedOrder.payment_attempt_id, 'SUCCEEDED', { amountVnd: 1 }),
      source: 'WEBHOOK',
    });
    const unknown = await applyPaymentProviderFact(requiredRuntime(), workerContext(), {
      attemptId: unknownOrder.payment_attempt_id,
      fact: await paymentFact(unknownOrder.payment_attempt_id, 'UNKNOWN'),
      source: 'QUERY',
    });
    expect(tampered.status).toBe('REVIEW_REQUIRED');
    expect(unknown.status).toBe('REVIEW_REQUIRED');
    const reservations = await requiredOwner().inventoryReservation.findMany({
      where: { order: { id: { in: [tamperedOrder.id, unknownOrder.id] } } },
    });
    expect(reservations.map(({ status }) => status)).toEqual(['ACTIVE', 'ACTIVE']);
  });

  it('expires an active attempt before closing the reservation-backed order', async () => {
    const created = await createOnlineOrder('expire');
    await processPaymentCreate();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 11 * 60 * 1_000);
      await expireDueReservations(requiredRuntime(), workerContext());
      await reconcileReservationBackedOrders(requiredRuntime(), workerContext());
    } finally {
      vi.useRealTimers();
    }
    const [order, attempt] = await Promise.all([
      requiredOwner().order.findUniqueOrThrow({ where: { id: created.id } }),
      requiredOwner().paymentAttempt.findUniqueOrThrow({
        where: { id: created.payment_attempt_id },
      }),
    ]);
    expect(order).toMatchObject({ paymentStatus: 'EXPIRED', status: 'CLOSED' });
    expect(attempt.status).toBe('EXPIRED');
  });
});
