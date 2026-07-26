import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { Server } from 'node:http';
import { dirname, resolve } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { config as loadEnvironment } from 'dotenv';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseRuntimeConfig } from '@zalo-shop/config';
import {
  applyRefundProviderFact,
  createRefundCommand,
  createRuntimePrismaClient,
  markRefundReviewRequired,
  PrismaClient,
} from '@zalo-shop/database';
import { createStoreContext } from '@zalo-shop/domain';
import { hashSensitive, signJwt } from '@zalo-shop/security';

const REPOSITORY_ROOT = resolve(__dirname, '../..');
const BEAUTY_STORE_ID = '10000000-0000-4000-8000-000000000001';
const SCRATCH_DATABASE_PATTERN = /^zalo_shop_m57_[0-9a-f]{12}$/u;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

describe('M5.7 refund API and database invariants', () => {
  loadEnvironment({ path: '.env.test.example', quiet: true, override: true });
  const sourceOwnerUrl = process.env.DATABASE_URL;
  const sourceRuntimeUrl = process.env.DATABASE_RUNTIME_URL;
  if (!sourceOwnerUrl || !sourceRuntimeUrl) throw new Error('M5.7 database URLs are required');

  const scratchDatabaseName = `zalo_shop_m57_${randomBytes(6).toString('hex')}`;
  const ownerUrl = scratchUrl(sourceOwnerUrl, scratchDatabaseName);
  const runtimeUrl = scratchUrl(sourceRuntimeUrl, scratchDatabaseName);
  const adminUrl = scratchUrl(sourceOwnerUrl, 'postgres');
  process.env.DATABASE_URL = ownerUrl;
  process.env.DATABASE_RUNTIME_URL = runtimeUrl;
  const config = parseRuntimeConfig();
  const admin = new PrismaClient({ datasourceUrl: adminUrl });
  const owner = new PrismaClient({ datasourceUrl: ownerUrl });
  const runtime = createRuntimePrismaClient(runtimeUrl);
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const fixture = {
    adminId: randomUUID(),
    channelId: randomUUID(),
    jobReaderAdminId: randomUUID(),
    jobReaderRoleId: randomUUID(),
    memberId: randomUUID(),
  };
  let scratchCreated = false;
  let app: INestApplication;
  let adminToken = '';
  let jobReaderToken = '';
  let memberToken = '';
  let staleAdminToken = '';

  function scratchUrl(source: string, databaseName: string): string {
    const url = new URL(source);
    if (!LOOPBACK_HOSTS.has(url.hostname)) {
      throw new Error('M5.7 integration test requires a loopback PostgreSQL host');
    }
    url.pathname = `/${databaseName}`;
    return url.toString();
  }

  function assertScratchName(): void {
    if (process.env.NODE_ENV !== 'test' || !SCRATCH_DATABASE_PATTERN.test(scratchDatabaseName)) {
      throw new Error('Refusing unsafe M5.7 scratch database operation');
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
    return request(app.getHttpServer() as Server);
  }

  function headers(token = adminToken, storeCode = 'beauty-local') {
    return { Authorization: `Bearer ${token}`, 'X-Store-Code': storeCode };
  }

  function context() {
    return createStoreContext({
      actor: { id: fixture.adminId, type: 'admin' },
      correlationId: `m57-${suffix}-${randomUUID()}`,
      locale: 'vi',
      storeCode: 'beauty-local',
      storeId: BEAUTY_STORE_ID,
    });
  }

  async function issueAdminToken(adminId: string, mfaVerifiedAt: Date): Promise<string> {
    const session = await owner.adminSession.create({
      data: {
        adminUserId: adminId,
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
        sub: adminId,
      },
      config.AUTH_JWT_SECRET,
    );
  }

  async function issueMemberToken(memberId: string): Promise<string> {
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
        sub: memberId,
      },
      config.AUTH_JWT_SECRET,
    );
  }

  async function createSucceededPayment(tag: string, amountVnd = 120_000) {
    const order = await owner.order.create({
      data: {
        baseSubtotalVnd: amountVnd,
        couponDiscountVnd: 0,
        currency: 'VND',
        itemDiscountVnd: 0,
        memberId: fixture.memberId,
        orderDiscountVnd: 0,
        orderNumber: `M57-${tag}-${suffix}`,
        payableVnd: amountVnd,
        paymentMethod: 'ONLINE',
        paymentStatus: 'SUCCEEDED',
        quoteHash: createHash('sha256').update(`m57-${tag}-${suffix}`).digest('hex'),
        remoteSurchargeVnd: 0,
        shippingDiscountVnd: 0,
        shippingFeeVnd: 0,
        status: 'PENDING_FULFILLMENT',
        storeId: BEAUTY_STORE_ID,
      },
    });
    const payment = await owner.paymentAttempt.create({
      data: {
        amountVnd,
        attemptSequence: 1,
        channelId: fixture.channelId,
        correlationId: `m57-payment-${tag}`,
        createIdempotencyKeyHash: createHash('sha256')
          .update(`m57-payment-key-${tag}-${suffix}`)
          .digest('hex'),
        currency: 'VND',
        expiresAt: new Date(Date.now() + 600_000),
        orderId: order.id,
        providerOrderId: `zalo-order-${tag}-${suffix}`,
        providerStatus: 'ZALO_CHECKOUT_1',
        providerTransactionId: `zalo-transaction-${tag}-${suffix}`,
        publicPaymentNumber: `PAY-${tag}-${suffix}`,
        status: 'SUCCEEDED',
        storeId: BEAUTY_STORE_ID,
        succeededAt: new Date(),
      },
    });
    return { order, payment };
  }

  beforeAll(async () => {
    assertScratchName();
    await admin.$connect();
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchDatabaseName}"`);
    scratchCreated = true;
    runPackageScript('migrate:deploy');
    runPackageScript('seed');
    await Promise.all([owner.$connect(), runtime.$connect()]);

    await owner.adminUser.createMany({
      data: [
        {
          displayName: 'M5.7 refund admin',
          email: `m57-admin-${suffix}@example.test`,
          emailNormalized: `m57-admin-${suffix}@example.test`,
          id: fixture.adminId,
          passwordHash: 'test-fixture-not-used',
        },
        {
          displayName: 'M5.7 payment job reader',
          email: `m57-job-reader-${suffix}@example.test`,
          emailNormalized: `m57-job-reader-${suffix}@example.test`,
          id: fixture.jobReaderAdminId,
          passwordHash: 'test-fixture-not-used',
        },
      ],
    });
    const storeAdminRole = await owner.storeRole.findUniqueOrThrow({
      where: { storeId_code: { code: 'store-admin', storeId: BEAUTY_STORE_ID } },
    });
    await owner.storeRole.create({
      data: {
        code: `m57-payment-job-reader-${suffix}`,
        id: fixture.jobReaderRoleId,
        name: 'M5.7 payment job reader',
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.storeRolePermission.create({
      data: {
        permissionCode: 'store.payments.read',
        roleId: fixture.jobReaderRoleId,
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.adminStoreRole.createMany({
      data: [
        {
          adminUserId: fixture.adminId,
          grantedBy: fixture.adminId,
          roleId: storeAdminRole.id,
          storeId: BEAUTY_STORE_ID,
        },
        {
          adminUserId: fixture.jobReaderAdminId,
          grantedBy: fixture.adminId,
          roleId: fixture.jobReaderRoleId,
          storeId: BEAUTY_STORE_ID,
        },
      ],
    });
    await owner.member.create({ data: { id: fixture.memberId, storeId: BEAUTY_STORE_ID } });
    const miniAppId = `m57-beauty-app-${suffix}`;
    await owner.storeZaloApp.update({
      data: { enabled: true, miniAppId, parentAppId: `m57-parent-${suffix}` },
      where: { storeId_environment: { environment: 'TEST', storeId: BEAUTY_STORE_ID } },
    });
    await owner.storePaymentChannel.create({
      data: {
        checkoutAppId: miniAppId,
        deploymentEnvironment: 'TEST',
        id: fixture.channelId,
        keyVersion: 'm57-test-v1',
        merchantReference: `m57-merchant-${suffix}`,
        methodCode: 'ZALOPAY_SANDBOX',
        paymentWindowSeconds: 600,
        privateKeySecretRef: `test://m57/${suffix}/checkout-private-key`,
        providerCode: 'ZALO_CHECKOUT_ZALOPAY',
        providerEnvironment: 'SANDBOX',
        secretFingerprint: createHash('sha256').update(`m57-${suffix}`).digest('hex'),
        status: 'ACTIVE',
        storeId: BEAUTY_STORE_ID,
      },
    });
    adminToken = await issueAdminToken(fixture.adminId, new Date());
    jobReaderToken = await issueAdminToken(fixture.jobReaderAdminId, new Date());
    memberToken = await issueMemberToken(fixture.memberId);
    staleAdminToken = await issueAdminToken(fixture.adminId, new Date(Date.now() - 11 * 60_000));

    const [{ AppModule }, { ApiExceptionFilter }] = await Promise.all([
      import('../../apps/api/src/app.module'),
      import('../../apps/api/src/api-exception.filter'),
    ]);
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication({ rawBody: true });
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await Promise.allSettled([owner.$disconnect(), runtime.$disconnect()]);
    if (scratchCreated) {
      assertScratchName();
      await admin.$executeRaw`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${scratchDatabaseName} AND pid <> pg_backend_pid()`;
      await admin.$executeRawUnsafe(`DROP DATABASE "${scratchDatabaseName}"`);
    }
    await admin.$disconnect();
  }, 60_000);

  it('requires recent MFA and an explicit confirmation for refund creation', async () => {
    const { payment } = await createSucceededPayment('mfa');
    const path = `/v1/admin/payments/${payment.id}/refunds?store_id=${BEAUTY_STORE_ID}`;
    const body = {
      amount_vnd: 20_000,
      confirmation_code: 'CREATE_REFUND',
      expected_payment_version: payment.version,
      reason: 'Customer approved partial refund',
    };
    await api()
      .post(path)
      .set({ ...headers(staleAdminToken), 'Idempotency-Key': `m57-stale-${suffix}` })
      .send(body)
      .expect(403);
    await api()
      .post(path)
      .set({ ...headers(), 'Idempotency-Key': `m57-confirm-${suffix}` })
      .send({ ...body, confirmation_code: 'WRONG' })
      .expect(400);
  });

  it('creates and replays a partial refund without reserving the amount twice', async () => {
    const { order, payment } = await createSucceededPayment('partial');
    const path = `/v1/admin/payments/${payment.id}/refunds?store_id=${BEAUTY_STORE_ID}`;
    const key = `m57-partial-${suffix}`;
    const body = {
      amount_vnd: 40_000,
      confirmation_code: 'CREATE_REFUND',
      expected_payment_version: payment.version,
      reason: 'Customer approved partial refund',
    };
    const first = await api()
      .post(path)
      .set({ ...headers(), 'Idempotency-Key': key })
      .send(body);
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({
      amount_vnd: 40_000,
      payment_id: payment.id,
      reason: body.reason,
      status: 'REQUESTED',
    });
    expect(Date.parse(first.body.requested_at as string)).not.toBeNaN();
    expect(Date.parse(first.body.updated_at as string)).not.toBeNaN();
    const replay = await api()
      .post(path)
      .set({ ...headers(), 'Idempotency-Key': key })
      .send(body);
    expect(replay.status).toBe(202);
    expect(replay.body.id).toBe(first.body.id);
    expect(await owner.refund.count({ where: { paymentAttemptId: payment.id } })).toBe(1);

    await applyRefundProviderFact(runtime, context(), {
      fact: {
        amountVnd: 40_000,
        providerRefundId: `zalo-refund-partial-${suffix}`,
        providerStatus: 'ZALO_CHECKOUT_2',
        status: 'PENDING',
      },
      refundId: first.body.id,
      source: 'QUERY',
    });
    await applyRefundProviderFact(runtime, context(), {
      fact: {
        amountVnd: 40_000,
        providerRefundId: `zalo-refund-partial-${suffix}`,
        providerStatus: 'ZALO_CHECKOUT_1',
        status: 'SUCCEEDED',
      },
      refundId: first.body.id,
      source: 'QUERY',
    });
    expect((await owner.order.findUniqueOrThrow({ where: { id: order.id } })).paymentStatus).toBe(
      'PARTIALLY_REFUNDED',
    );
  });

  it('projects a full refund without changing order fulfillment or inventory facts', async () => {
    const { order, payment } = await createSucceededPayment('full');
    const created = await createRefundCommand(runtime, context(), {
      amountVnd: 120_000,
      confirmation: 'CREATE_REFUND',
      expectedPaymentVersion: payment.version,
      idempotencyKey: `m57-full-${suffix}`,
      paymentAttemptId: payment.id,
      reason: 'Customer approved full payment refund',
    });
    await applyRefundProviderFact(runtime, context(), {
      fact: {
        amountVnd: 120_000,
        providerRefundId: `zalo-refund-full-${suffix}`,
        providerStatus: 'ZALO_CHECKOUT_1',
        status: 'SUCCEEDED',
      },
      refundId: created.refundId,
      source: 'QUERY',
    });
    const current = await owner.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(current.paymentStatus).toBe('FULLY_REFUNDED');
    expect(current.status).toBe('PENDING_FULFILLMENT');
    expect(await owner.inventoryMovement.count({ where: { storeId: BEAUTY_STORE_ID } })).toBe(0);
    await expect(
      applyRefundProviderFact(runtime, context(), {
        fact: {
          amountVnd: 120_000,
          providerRefundId: `zalo-refund-full-${suffix}`,
          providerStatus: 'ZALO_CHECKOUT_-1',
          status: 'FAILED',
        },
        refundId: created.refundId,
        source: 'QUERY',
      }),
    ).rejects.toMatchObject({ code: 'REFUND_STATE_CONFLICT' });
  });

  it('rejects excess amounts and cross-store administration', async () => {
    const { order, payment } = await createSucceededPayment('guard');
    const path = `/v1/admin/payments/${payment.id}/refunds?store_id=${BEAUTY_STORE_ID}`;
    await api()
      .post(path)
      .set({ ...headers(), 'Idempotency-Key': `m57-excess-${suffix}` })
      .send({
        amount_vnd: 120_001,
        confirmation_code: 'CREATE_REFUND',
        expected_payment_version: payment.version,
        reason: 'Attempted refund above captured amount',
      })
      .expect(409);

    const reviewRefund = await createRefundCommand(runtime, context(), {
      amountVnd: 80_000,
      confirmation: 'CREATE_REFUND',
      expectedPaymentVersion: payment.version,
      idempotencyKey: `m57-review-capacity-${suffix}`,
      paymentAttemptId: payment.id,
      reason: 'Provider result is ambiguous and requires review',
    });
    await markRefundReviewRequired(runtime, context(), {
      reason: 'REFUND_PROVIDER_TIMEOUT',
      refundId: reviewRefund.refundId,
    });
    await expect(
      owner.refund.create({
        data: {
          amountVnd: 50_000,
          idempotencyKeyHash: createHash('sha256')
            .update(`m57-review-direct-${suffix}`)
            .digest('hex'),
          orderId: order.id,
          paymentAttemptId: payment.id,
          publicRefundNumber: `RFD-REVIEW-GUARD-${suffix}`,
          reason: 'Database guard must retain ambiguous refund capacity',
          requestedBy: fixture.adminId,
          storeId: BEAUTY_STORE_ID,
        },
      }),
    ).rejects.toThrow();
    await expect(
      createRefundCommand(runtime, context(), {
        amountVnd: 50_000,
        confirmation: 'CREATE_REFUND',
        expectedPaymentVersion: payment.version,
        idempotencyKey: `m57-review-command-${suffix}`,
        paymentAttemptId: payment.id,
        reason: 'Application guard must retain ambiguous refund capacity',
      }),
    ).rejects.toMatchObject({ code: 'REFUND_AMOUNT_EXCEEDS_AVAILABLE' });
    const blocked = await api()
      .post(path)
      .set({ ...headers(), 'Idempotency-Key': `m57-review-excess-${suffix}` })
      .send({
        amount_vnd: 50_000,
        confirmation_code: 'CREATE_REFUND',
        expected_payment_version: payment.version,
        reason: 'Must retain ambiguous refund capacity until reviewed',
      });
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(409);
    await api()
      .get(`/v1/admin/refunds?store_id=${BEAUTY_STORE_ID}`)
      .set(headers(adminToken, 'fashion-local'))
      .expect(403);
  });

  it('exposes only public refund facts on the owning member order', async () => {
    const { order, payment } = await createSucceededPayment('member');
    const created = await createRefundCommand(runtime, context(), {
      amountVnd: 25_000,
      confirmation: 'CREATE_REFUND',
      expectedPaymentVersion: payment.version,
      idempotencyKey: `m57-member-${suffix}`,
      paymentAttemptId: payment.id,
      reason: 'Internal operator-approved member refund reason',
    });
    await applyRefundProviderFact(runtime, context(), {
      fact: {
        amountVnd: 25_000,
        providerRefundId: `zalo-refund-member-${suffix}`,
        providerStatus: 'ZALO_CHECKOUT_1',
        status: 'SUCCEEDED',
      },
      refundId: created.refundId,
      source: 'QUERY',
    });

    const detail = await api().get(`/v1/orders/${order.id}`).set(headers(memberToken)).expect(200);
    expect(detail.body.refunds).toEqual([
      expect.objectContaining({
        amount_vnd: 25_000,
        public_number: created.publicRefundNumber,
        status: 'SUCCEEDED',
      }),
    ]);
    const serialized = JSON.stringify(detail.body.refunds);
    expect(serialized).not.toContain('Internal operator-approved');
    expect(serialized).not.toContain('zalo-refund-member');
    expect(serialized).not.toContain('provider');

    const otherMemberId = randomUUID();
    await owner.member.create({ data: { id: otherMemberId, storeId: BEAUTY_STORE_ID } });
    const otherOrder = await owner.order.create({
      data: {
        baseSubtotalVnd: 10_000,
        couponDiscountVnd: 0,
        currency: 'VND',
        itemDiscountVnd: 0,
        memberId: otherMemberId,
        orderDiscountVnd: 0,
        orderNumber: `M57-OTHER-${suffix}`,
        payableVnd: 10_000,
        paymentMethod: 'COD',
        paymentStatus: 'PENDING',
        quoteHash: createHash('sha256').update(`m57-other-${suffix}`).digest('hex'),
        remoteSurchargeVnd: 0,
        shippingDiscountVnd: 0,
        shippingFeeVnd: 0,
        status: 'PENDING_CONFIRMATION',
        storeId: BEAUTY_STORE_ID,
      },
    });
    await api().get(`/v1/orders/${otherOrder.id}`).set(headers(memberToken)).expect(404);
  });

  it('binds dead-letter retry idempotency keys without replaying the command twice', async () => {
    const job = await owner.outboxMessage.create({
      data: {
        aggregateId: randomUUID(),
        aggregateType: 'REFUND',
        attemptCount: 1,
        completedAt: new Date(),
        eventType: 'refund.test.retry',
        eventVersion: 1,
        idempotencyKey: `m57-dead-letter-${suffix}`,
        lastErrorCode: 'RETRY_EXHAUSTED_TEST_TIMEOUT',
        payload: { store_id: BEAUTY_STORE_ID },
        status: 'DEAD_LETTER',
        storeId: BEAUTY_STORE_ID,
      },
    });
    const path = `/v1/admin/integration-jobs/${job.id}/retry?store_id=${BEAUTY_STORE_ID}`;
    const key = `m57-replay-command-${suffix}`;
    const body = {
      confirmation_code: 'RETRY_DEAD_LETTER',
      expected_version: job.version,
      reason: 'Reviewed provider recovery before retrying the refund job',
    };
    const first = await api()
      .post(path)
      .set({ ...headers(), 'Idempotency-Key': key })
      .send(body)
      .expect(202);
    expect(first.body).toMatchObject({
      attempt_count: 0,
      id: job.id,
      last_error_code: null,
      status: 'PENDING',
      version: job.version + 1,
    });

    const replay = await api()
      .post(path)
      .set({ ...headers(), 'Idempotency-Key': key })
      .send(body)
      .expect(202);
    expect(replay.body).toEqual(first.body);
    await api()
      .post(path)
      .set({ ...headers(), 'Idempotency-Key': key })
      .send({ ...body, reason: 'A changed reason must not reuse the original command key' })
      .expect(409);
    await api()
      .post(path)
      .set({ ...headers(), 'Idempotency-Key': `m57-other-replay-${suffix}` })
      .send(body)
      .expect(409);

    const audits = await owner.auditLog.findMany({
      where: { action: 'integration.outbox.dead_letter.replayed', targetId: job.id },
    });
    expect(audits).toHaveLength(1);
    const serializedAudit = JSON.stringify(audits[0]);
    expect(serializedAudit).not.toContain(key);
    expect(serializedAudit).toMatch(/replay_idempotency_key_hash[^}]*[a-f0-9]{64}/u);
  });

  it('keeps retry-wait filtering when an integration-job cursor is present', async () => {
    const hiddenRefundJobId = randomUUID();
    await owner.outboxMessage.createMany({
      data: [
        {
          aggregateId: randomUUID(),
          aggregateType: 'PAYMENT_ATTEMPT',
          attemptCount: 1,
          eventType: 'payment.test.retry',
          eventVersion: 1,
          idempotencyKey: `m57-retry-a-${suffix}`,
          lastErrorCode: 'RETRYABLE_TEST_TIMEOUT',
          payload: { store_id: BEAUTY_STORE_ID },
          status: 'PENDING',
          storeId: BEAUTY_STORE_ID,
        },
        {
          aggregateId: randomUUID(),
          aggregateType: 'PAYMENT_ATTEMPT',
          attemptCount: 1,
          eventType: 'payment.test.retry',
          eventVersion: 1,
          idempotencyKey: `m57-retry-b-${suffix}`,
          lastErrorCode: 'RETRYABLE_TEST_TIMEOUT',
          payload: { store_id: BEAUTY_STORE_ID },
          status: 'PENDING',
          storeId: BEAUTY_STORE_ID,
        },
        {
          aggregateId: randomUUID(),
          aggregateType: 'PAYMENT_ATTEMPT',
          attemptCount: 0,
          eventType: 'payment.test.pending',
          eventVersion: 1,
          idempotencyKey: `m57-pending-${suffix}`,
          payload: { store_id: BEAUTY_STORE_ID },
          status: 'PENDING',
          storeId: BEAUTY_STORE_ID,
        },
        {
          aggregateId: randomUUID(),
          aggregateType: 'REFUND',
          attemptCount: 1,
          eventType: 'refund.test.retry',
          eventVersion: 1,
          id: hiddenRefundJobId,
          idempotencyKey: `m57-refund-retry-${suffix}`,
          lastErrorCode: 'RETRYABLE_TEST_TIMEOUT',
          payload: { store_id: BEAUTY_STORE_ID },
          status: 'PENDING',
          storeId: BEAUTY_STORE_ID,
        },
        {
          aggregateId: randomUUID(),
          aggregateType: 'SHIPMENT',
          attemptCount: 1,
          eventType: 'shipment.test.retry',
          eventVersion: 1,
          idempotencyKey: `m57-shipment-retry-${suffix}`,
          lastErrorCode: 'RETRYABLE_TEST_TIMEOUT',
          payload: { store_id: BEAUTY_STORE_ID },
          status: 'PENDING',
          storeId: BEAUTY_STORE_ID,
        },
      ],
    });
    const path = `/v1/admin/integration-jobs?store_id=${BEAUTY_STORE_ID}&status=RETRY_WAIT&limit=1`;
    const first = await api().get(path).set(headers()).expect(200);
    expect(first.body.items).toHaveLength(1);
    expect(first.body.items[0]).toMatchObject({
      last_error_code: 'RETRYABLE_TEST_TIMEOUT',
      status: 'RETRY_WAIT',
    });
    expect(first.body.items[0].operation).toMatch(/^(payment|refund|shipment)\.test\.retry$/u);
    expect(first.body.items[0]).not.toHaveProperty('payload');
    expect(first.body.items[0]).not.toHaveProperty('aggregate_id');
    const second = await api()
      .get(`${path}&cursor=${first.body.next_cursor as string}`)
      .set(headers())
      .expect(200);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.items[0]).toMatchObject({ status: 'RETRY_WAIT' });
    expect(second.body.items[0].operation).toMatch(/^(payment|refund|shipment)\.test\.retry$/u);

    const restricted = await api()
      .get(`/v1/admin/integration-jobs?store_id=${BEAUTY_STORE_ID}&status=RETRY_WAIT&limit=100`)
      .set(headers(jobReaderToken))
      .expect(200);
    expect(restricted.body.items).toHaveLength(2);
    expect(
      restricted.body.items.every((item: { operation: string }) =>
        item.operation.startsWith('payment.'),
      ),
    ).toBe(true);
    await api()
      .get(
        `/v1/admin/integration-jobs?store_id=${BEAUTY_STORE_ID}&status=RETRY_WAIT&limit=1&cursor=${hiddenRefundJobId}`,
      )
      .set(headers(jobReaderToken))
      .expect(404);
  });
});
