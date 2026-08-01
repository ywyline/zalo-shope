import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { dirname, resolve } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { config as loadEnvironment } from 'dotenv';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseRuntimeConfig } from '@zalo-shop/config';
import { createRuntimePrismaClient, PrismaClient, withStoreTransaction } from '@zalo-shop/database';
import { createStoreContext } from '@zalo-shop/domain';
import { hashSensitive, signJwt } from '@zalo-shop/security';

const REPOSITORY_ROOT = resolve(__dirname, '../..');
const BEAUTY_STORE_ID = '10000000-0000-4000-8000-000000000001';
const FASHION_STORE_ID = '10000000-0000-4000-8000-000000000002';
const SCRATCH_DATABASE_PATTERN = /^zalo_shop_p0m5005_[0-9a-f]{12}$/u;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

describe('P0-M5-005 financial reconciliation API and database invariants', () => {
  loadEnvironment({ path: '.env.test.example', quiet: true, override: true });
  const sourceOwnerUrl = process.env.DATABASE_URL;
  const sourceRuntimeUrl = process.env.DATABASE_RUNTIME_URL;
  if (!sourceOwnerUrl || !sourceRuntimeUrl) {
    throw new Error('P0-M5-005 database URLs are required');
  }

  const scratchDatabaseName = `zalo_shop_p0m5005_${randomBytes(6).toString('hex')}`;
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
    memberId: randomUUID(),
    readerAdminId: randomUUID(),
    readerRoleId: randomUUID(),
    shippingChannelId: randomUUID(),
  };
  let scratchCreated = false;
  let app: INestApplication;
  let adminToken = '';
  let readerToken = '';
  let staleAdminToken = '';
  let storeAdminRoleId = '';
  let warehouseId = '';

  function scratchUrl(source: string, databaseName: string): string {
    const url = new URL(source);
    if (!LOOPBACK_HOSTS.has(url.hostname)) {
      throw new Error('P0-M5-005 integration test requires a loopback PostgreSQL host');
    }
    url.pathname = `/${databaseName}`;
    return url.toString();
  }

  function assertScratchName(): void {
    if (process.env.NODE_ENV !== 'test' || !SCRATCH_DATABASE_PATTERN.test(scratchDatabaseName)) {
      throw new Error('Refusing unsafe P0-M5-005 scratch database operation');
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

  function hash(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  async function waitForBlockedAdvisoryLock(): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const rows = await admin.$queryRaw<Array<{ waiting: bigint }>>`
        SELECT count(*)::bigint AS waiting
        FROM pg_locks
        WHERE locktype = 'advisory'
          AND NOT granted
          AND database = (SELECT oid FROM pg_database WHERE datname = ${scratchDatabaseName})
      `;
      if ((rows[0]?.waiting ?? 0n) > 0n) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    throw new Error('Timed out waiting for the financial reconciliation advisory lock');
  }

  function context(storeId = BEAUTY_STORE_ID) {
    return createStoreContext({
      actor: { id: fixture.adminId, type: 'admin' },
      correlationId: `p0-m5-005-${suffix}-${randomUUID()}`,
      locale: 'vi',
      storeCode: storeId === BEAUTY_STORE_ID ? 'beauty-local' : 'fashion-local',
      storeId,
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

  async function createOrder(tag: string, paymentStatus = 'SUCCEEDED' as const) {
    return owner.order.create({
      data: {
        baseSubtotalVnd: 120_000,
        couponDiscountVnd: 0,
        currency: 'VND',
        itemDiscountVnd: 0,
        memberId: fixture.memberId,
        orderDiscountVnd: 0,
        orderNumber: `P0M5005-${tag}-${suffix}`,
        payableVnd: 120_000,
        paymentMethod: 'ONLINE',
        paymentStatus,
        quoteHash: hash(`p0-m5-005-${tag}-${suffix}`),
        remoteSurchargeVnd: 0,
        shippingDiscountVnd: 0,
        shippingFeeVnd: 0,
        status: 'PENDING_FULFILLMENT',
        storeId: BEAUTY_STORE_ID,
      },
    });
  }

  async function createPayment(
    tag: string,
    input: {
      amountVnd?: number;
      providerReference: string;
      status?: 'PROVIDER_PENDING' | 'SUCCEEDED';
    },
  ) {
    const status = input.status ?? 'SUCCEEDED';
    const amountVnd = input.amountVnd ?? 120_000;
    const order = await createOrder(tag, status === 'SUCCEEDED' ? 'SUCCEEDED' : 'PROCESSING');
    const payment = await owner.paymentAttempt.create({
      data: {
        amountVnd,
        attemptSequence: 1,
        channelId: fixture.channelId,
        correlationId: `p0-m5-005-${tag}-${suffix}`,
        createIdempotencyKeyHash: hash(`p0-m5-005-payment-${tag}-${suffix}`),
        expiresAt: new Date(Date.now() + 600_000),
        orderId: order.id,
        providerOrderId: `provider-order-${tag}-${suffix}`,
        providerStatus: status === 'SUCCEEDED' ? '1' : '2',
        providerTransactionId: input.providerReference,
        publicPaymentNumber: `PAY-P0M5005-${tag}-${suffix}`,
        status,
        storeId: BEAUTY_STORE_ID,
        ...(status === 'SUCCEEDED' ? { succeededAt: new Date() } : {}),
      },
    });
    return { order, payment };
  }

  async function createRefund(
    payment: { amountVnd: bigint; id: string; orderId: string },
    providerReference: string,
    amountVnd: number,
  ) {
    return owner.refund.create({
      data: {
        amountVnd,
        idempotencyKeyHash: hash(`p0-m5-005-refund-${providerReference}`),
        orderId: payment.orderId,
        paymentAttemptId: payment.id,
        providerRefundId: providerReference,
        providerStatus: '1',
        publicRefundNumber: `REF-P0M5005-${randomUUID().slice(0, 12)}`,
        reason: 'Financial reconciliation integration fixture',
        requestedBy: fixture.adminId,
        status: 'SUCCEEDED',
        storeId: BEAUTY_STORE_ID,
        succeededAt: new Date(),
      },
    });
  }

  function importBody(
    batchReference: string,
    records: Array<{
      fee_amount_vnd: number;
      gross_amount_vnd: number;
      occurred_at: string;
      provider_reference: string;
      record_reference: string;
      type: 'PAYMENT' | 'REFUND';
    }>,
  ) {
    return {
      batch_reference: batchReference,
      business_date: '2026-08-01',
      confirmation_code: 'IMPORT_PAYMENT_SETTLEMENT',
      provider_code: 'ZALO_CHECKOUT_ZALOPAY',
      provider_environment: 'SANDBOX',
      reason: 'Finance reviewed this normalized settlement batch',
      records,
    };
  }

  async function createCodShipment(
    tag: string,
    input: {
      expectedFeeVnd?: number;
      status?: 'DELIVERED' | 'PENDING_PICKUP' | 'RETURNED';
      withQuote?: boolean;
    } = {},
  ) {
    const status = input.status ?? 'DELIVERED';
    const order = await owner.order.create({
      data: {
        baseSubtotalVnd: 120_000,
        memberId: fixture.memberId,
        orderNumber: `P0M5005-COD-${tag}-${suffix}`,
        payableVnd: 120_000,
        paymentMethod: 'COD',
        paymentStatus: 'PENDING',
        quoteHash: hash(`p0-m5-005-cod-${tag}-${suffix}`),
        shippingFeeVnd: 0,
        status: status === 'DELIVERED' ? 'DELIVERED' : 'PENDING_FULFILLMENT',
        storeId: BEAUTY_STORE_ID,
      },
    });
    const createdAt = new Date(Date.now() - 60_000);
    if (input.withQuote !== false) {
      const expectedFeeVnd = input.expectedFeeVnd ?? 25_000;
      await owner.shippingQuote.create({
        data: {
          baseFeeVnd: expectedFeeVnd - 3_000,
          channelId: fixture.shippingChannelId,
          codFeeVnd: 3_000,
          expiresAt: new Date(Date.now() + 3_600_000),
          orderId: order.id,
          requestHash: hash(`p0-m5-005-cod-quote-${tag}-${suffix}`),
          serviceCode: 'GHN:53320:2',
          source: 'PROVIDER',
          storeId: BEAUTY_STORE_ID,
          totalFeeVnd: expectedFeeVnd,
          createdAt: new Date(createdAt.getTime() - 60_000),
        },
      });
    }
    const shipment = await owner.shipment.create({
      data: {
        addressSnapshotCiphertext: 'encrypted-cod-reconciliation-address',
        channelId: fixture.shippingChannelId,
        clientOrderCode: `P0M5005-COD-${tag}-${suffix}`,
        codAmountVnd: 120_000,
        createdAt,
        ...(status === 'DELIVERED' ? { deliveredAt: new Date() } : {}),
        orderId: order.id,
        parcelSnapshot: { height_cm: 1, length_cm: 1, weight_grams: 1, width_cm: 1 },
        providerShipmentId: `GHN-COD-${tag}-${suffix}`,
        publicShipmentNumber: `SHP-P0M5005-COD-${tag}-${suffix}`,
        ...(status === 'RETURNED' ? { returnedAt: new Date() } : {}),
        serviceCode: 'GHN:53320:2',
        status,
        storeId: BEAUTY_STORE_ID,
        warehouseId,
      },
    });
    return { order, shipment };
  }

  beforeAll(async () => {
    assertScratchName();
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchDatabaseName}"`);
    scratchCreated = true;
    runPackageScript('migrate:deploy');
    runPackageScript('seed');

    await owner.adminUser.createMany({
      data: [
        {
          displayName: 'P0-M5-005 finance admin',
          email: `p0-m5-005-admin-${suffix}@example.test`,
          emailNormalized: `p0-m5-005-admin-${suffix}@example.test`,
          id: fixture.adminId,
          passwordHash: 'test-fixture-not-used',
        },
        {
          displayName: 'P0-M5-005 finance reader',
          email: `p0-m5-005-reader-${suffix}@example.test`,
          emailNormalized: `p0-m5-005-reader-${suffix}@example.test`,
          id: fixture.readerAdminId,
          passwordHash: 'test-fixture-not-used',
        },
      ],
    });
    const storeAdminRole = await owner.storeRole.findUniqueOrThrow({
      where: { storeId_code: { code: 'store-admin', storeId: BEAUTY_STORE_ID } },
    });
    storeAdminRoleId = storeAdminRole.id;
    await owner.storeRole.create({
      data: {
        code: `finance-reader-${suffix}`,
        id: fixture.readerRoleId,
        name: 'Financial reconciliation reader',
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.storeRolePermission.create({
      data: {
        permissionCode: 'store.finance.read',
        roleId: fixture.readerRoleId,
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
          adminUserId: fixture.readerAdminId,
          grantedBy: fixture.adminId,
          roleId: fixture.readerRoleId,
          storeId: BEAUTY_STORE_ID,
        },
      ],
    });
    await owner.member.create({ data: { id: fixture.memberId, storeId: BEAUTY_STORE_ID } });
    const miniAppId = `p0-m5-005-beauty-${suffix}`;
    await owner.storeZaloApp.update({
      data: { enabled: true, miniAppId, parentAppId: `p0-m5-005-parent-${suffix}` },
      where: { storeId_environment: { environment: 'TEST', storeId: BEAUTY_STORE_ID } },
    });
    await owner.storePaymentChannel.create({
      data: {
        checkoutAppId: miniAppId,
        deploymentEnvironment: 'TEST',
        id: fixture.channelId,
        keyVersion: 'test-v1',
        merchantReference: `p0-m5-005-merchant-${suffix}`,
        methodCode: 'ZALOPAY_SANDBOX',
        paymentWindowSeconds: 600,
        privateKeySecretRef: `test://p0-m5-005/${suffix}/private-key`,
        providerCode: 'ZALO_CHECKOUT_ZALOPAY',
        providerEnvironment: 'SANDBOX',
        secretFingerprint: hash(`p0-m5-005-secret-${suffix}`),
        status: 'ACTIVE',
        storeId: BEAUTY_STORE_ID,
      },
    });
    warehouseId = (await owner.warehouse.findFirstOrThrow({ where: { storeId: BEAUTY_STORE_ID } }))
      .id;
    await owner.storeShippingChannel.create({
      data: {
        defaultServiceCode: 'GHN:53320:2',
        id: fixture.shippingChannelId,
        keyVersion: 'test-v1',
        originAllowlistKey: 'GHN_SANDBOX',
        providerCode: 'GHN',
        providerEnvironment: 'SANDBOX',
        secretFingerprint: hash(`p0-m5-005-ghn-secret-${suffix}`),
        shopId: `p0-m5-005-shop-${suffix}`,
        status: 'ACTIVE',
        storeId: BEAUTY_STORE_ID,
        tokenSecretRef: `test://p0-m5-005/${suffix}/ghn-token`,
      },
    });
    adminToken = await issueAdminToken(fixture.adminId, new Date());
    readerToken = await issueAdminToken(fixture.readerAdminId, new Date());
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

  it('imports matched payment/refund lines with integer fees, signed net and redacted audit', async () => {
    const providerPaymentReference = `payment-reference-${suffix}`;
    const providerRefundReference = `refund-reference-${suffix}`;
    const { payment } = await createPayment('matched', {
      providerReference: providerPaymentReference,
    });
    await createRefund(payment, providerRefundReference, 20_000);
    const body = importBody(`matched-batch-${suffix}`, [
      {
        fee_amount_vnd: 2_000,
        gross_amount_vnd: 120_000,
        occurred_at: '2026-08-01T03:00:00.000Z',
        provider_reference: providerPaymentReference,
        record_reference: `matched-payment-line-${suffix}`,
        type: 'PAYMENT',
      },
      {
        fee_amount_vnd: 500,
        gross_amount_vnd: 20_000,
        occurred_at: '2026-08-01T04:00:00.000Z',
        provider_reference: providerRefundReference,
        record_reference: `matched-refund-line-${suffix}`,
        type: 'REFUND',
      },
    ]);
    const response = await api()
      .post(`/v1/admin/financial-reconciliation/payment-batches?store_id=${BEAUTY_STORE_ID}`)
      .set({ ...headers(), 'Idempotency-Key': `matched-import-${suffix}` })
      .send(body);
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      difference_vnd: 0,
      exception_count: 0,
      fee_amount_vnd: 2_500,
      gross_amount_vnd: 140_000,
      local_expected_amount_vnd: 140_000,
      matched_count: 2,
      net_amount_vnd: 97_500,
      record_count: 2,
      replayed: false,
      status: 'MATCHED',
    });
    expect(response.body.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ net_amount_vnd: 118_000, status: 'MATCHED', type: 'PAYMENT' }),
        expect.objectContaining({ net_amount_vnd: -20_500, status: 'MATCHED', type: 'REFUND' }),
      ]),
    );
    expect(JSON.stringify(response.body)).not.toContain(providerPaymentReference);
    expect(JSON.stringify(response.body)).not.toContain(providerRefundReference);

    const audit = await owner.auditLog.findFirstOrThrow({
      where: {
        action: 'financial-reconciliation.payment-batch.imported',
        targetId: response.body.id,
      },
    });
    expect(JSON.stringify(audit)).not.toContain(providerPaymentReference);
    expect(JSON.stringify(audit)).not.toContain(providerRefundReference);
    expect(audit.afterData).toMatchObject({ exception_count: 0, record_count: 2 });

    const detail = await api()
      .get(
        `/v1/admin/financial-reconciliation/batches/${response.body.id}?store_id=${BEAUTY_STORE_ID}`,
      )
      .set(headers(readerToken))
      .expect(200);
    expect(detail.body).toMatchObject({ id: response.body.id, status: 'MATCHED' });
    expect(detail.body.lines).toHaveLength(2);
  });

  it('replays one request and rejects idempotency or batch-reference conflicts', async () => {
    const providerReference = `replay-payment-${suffix}`;
    await createPayment('replay', { providerReference });
    const body = importBody(`replay-batch-${suffix}`, [
      {
        fee_amount_vnd: 1_000,
        gross_amount_vnd: 120_000,
        occurred_at: '2026-08-01T05:00:00.000Z',
        provider_reference: providerReference,
        record_reference: `replay-line-${suffix}`,
        type: 'PAYMENT',
      },
    ]);
    const path = `/v1/admin/financial-reconciliation/payment-batches?store_id=${BEAUTY_STORE_ID}`;
    const key = `replay-import-${suffix}`;
    const first = await api()
      .post(path)
      .set({ ...headers(), 'Idempotency-Key': key })
      .send(body)
      .expect(201);
    const replay = await api()
      .post(path)
      .set({ ...headers(), 'Idempotency-Key': key })
      .send(body)
      .expect(201);
    expect(replay.body).toMatchObject({ id: first.body.id, replayed: true });
    expect(
      await owner.financialReconciliationBatch.count({
        where: { batchReferenceDigest: { not: '' }, id: first.body.id },
      }),
    ).toBe(1);
    await api()
      .post(path)
      .set({ ...headers(), 'Idempotency-Key': key })
      .send({ ...body, reason: 'A changed reason must conflict with the original request' })
      .expect(409);
    await api()
      .post(path)
      .set({ ...headers(), 'Idempotency-Key': `other-replay-import-${suffix}` })
      .send(body)
      .expect(409);
  });

  it('classifies amount, non-final, missing and duplicate provider references without mutation', async () => {
    const mismatchReference = `mismatch-payment-${suffix}`;
    const pendingReference = `pending-payment-${suffix}`;
    await createPayment('mismatch', { amountVnd: 120_000, providerReference: mismatchReference });
    await createPayment('pending', {
      providerReference: pendingReference,
      status: 'PROVIDER_PENDING',
    });
    const body = importBody(`exceptions-batch-${suffix}`, [
      {
        fee_amount_vnd: 1_000,
        gross_amount_vnd: 110_000,
        occurred_at: '2026-08-01T06:00:00.000Z',
        provider_reference: mismatchReference,
        record_reference: `mismatch-line-${suffix}`,
        type: 'PAYMENT',
      },
      {
        fee_amount_vnd: 1_000,
        gross_amount_vnd: 120_000,
        occurred_at: '2026-08-01T06:01:00.000Z',
        provider_reference: pendingReference,
        record_reference: `pending-line-${suffix}`,
        type: 'PAYMENT',
      },
      {
        fee_amount_vnd: 0,
        gross_amount_vnd: 10_000,
        occurred_at: '2026-08-01T06:02:00.000Z',
        provider_reference: `missing-payment-${suffix}`,
        record_reference: `missing-line-${suffix}`,
        type: 'PAYMENT',
      },
      {
        fee_amount_vnd: 0,
        gross_amount_vnd: 5_000,
        occurred_at: '2026-08-01T06:03:00.000Z',
        provider_reference: `duplicate-refund-${suffix}`,
        record_reference: `duplicate-line-a-${suffix}`,
        type: 'REFUND',
      },
      {
        fee_amount_vnd: 0,
        gross_amount_vnd: 5_000,
        occurred_at: '2026-08-01T06:04:00.000Z',
        provider_reference: `duplicate-refund-${suffix}`,
        record_reference: `duplicate-line-b-${suffix}`,
        type: 'REFUND',
      },
    ]);
    const response = await api()
      .post(`/v1/admin/financial-reconciliation/payment-batches?store_id=${BEAUTY_STORE_ID}`)
      .set({ ...headers(), 'Idempotency-Key': `exceptions-import-${suffix}` })
      .send(body)
      .expect(201);
    expect(response.body).toMatchObject({
      difference_vnd: -10_000,
      exception_count: 5,
      matched_count: 0,
      status: 'REVIEW_REQUIRED',
    });
    expect(response.body.lines.map((line: { status: string }) => line.status)).toEqual([
      'AMOUNT_MISMATCH',
      'FACT_NOT_FINAL',
      'REFERENCE_NOT_FOUND',
      'DUPLICATE_REFERENCE',
      'DUPLICATE_REFERENCE',
    ]);
    expect(
      await owner.paymentAttempt.findUniqueOrThrow({
        where: {
          storeId_id: {
            id: (
              await owner.paymentAttempt.findFirstOrThrow({
                where: { providerTransactionId: pendingReference },
              })
            ).id,
            storeId: BEAUTY_STORE_ID,
          },
        },
      }),
    ).toMatchObject({ status: 'PROVIDER_PENDING' });
  });

  it('projects COD receivables and classifies normalized GHN remittance facts without mutating shipments', async () => {
    const matched = await createCodShipment('matched');
    const amountMismatch = await createCodShipment('amount-mismatch');
    const feeMismatch = await createCodShipment('fee-mismatch');
    const missingFee = await createCodShipment('missing-fee', { withQuote: false });
    const pending = await createCodShipment('pending', { status: 'PENDING_PICKUP' });
    const returned = await createCodShipment('returned', { status: 'RETURNED' });
    const duplicate = await createCodShipment('duplicate');

    const before = await api()
      .get(
        `/v1/admin/financial-reconciliation/cod-receivables?store_id=${BEAUTY_STORE_ID}&limit=100`,
      )
      .set(headers())
      .expect(200);
    expect(
      before.body.items.find((item: { id: string }) => item.id === matched.shipment.id),
    ).toMatchObject({
      expected_cod_amount_vnd: 120_000,
      expected_fee_amount_vnd: 25_000,
      expected_net_amount_vnd: 95_000,
      status: 'UNREMITTED',
    });

    const record = (
      shipment: { providerShipmentId: string | null },
      tag: string,
      codAmountVnd = 120_000,
      shippingFeeVnd = 22_000,
      codFeeVnd = 3_000,
    ) => ({
      cod_amount_vnd: codAmountVnd,
      cod_fee_vnd: codFeeVnd,
      occurred_at: '2026-08-01T08:00:00.000Z',
      provider_reference: shipment.providerShipmentId,
      record_reference: `cod-remittance-${tag}-${suffix}`,
      shipping_fee_vnd: shippingFeeVnd,
    });
    const path = `/v1/admin/financial-reconciliation/cod-batches?store_id=${BEAUTY_STORE_ID}`;
    const body = {
      batch_reference: `ghn-remittance-${suffix}`,
      business_date: '2026-08-01',
      confirmation_code: 'IMPORT_GHN_COD_SETTLEMENT',
      provider_code: 'GHN',
      provider_environment: 'SANDBOX',
      reason: 'Finance reviewed the normalized GHN COD remittance statement',
      records: [
        record(matched.shipment, 'matched'),
        record(amountMismatch.shipment, 'amount', 110_000),
        record(feeMismatch.shipment, 'fee', 120_000, 23_000),
        record(missingFee.shipment, 'missing-fee'),
        record(pending.shipment, 'pending'),
        record(returned.shipment, 'returned'),
        {
          ...record(matched.shipment, 'missing'),
          provider_reference: `GHN-COD-MISSING-${suffix}`,
        },
        record(duplicate.shipment, 'duplicate-a'),
        record(duplicate.shipment, 'duplicate-b'),
      ],
    };
    const response = await api()
      .post(path)
      .set({ ...headers(), 'Idempotency-Key': `cod-remittance-import-${suffix}` })
      .send(body)
      .expect(201);
    expect(response.body).toMatchObject({
      exception_count: 8,
      matched_count: 1,
      source: 'SHIPPING_PROVIDER',
      status: 'REVIEW_REQUIRED',
    });
    expect(response.body.lines.map((line: { status: string }) => line.status)).toEqual([
      'MATCHED',
      'AMOUNT_MISMATCH',
      'FEE_MISMATCH',
      'EXPECTED_FEE_NOT_FOUND',
      'FACT_NOT_FINAL',
      'COD_NOT_RECEIVABLE',
      'REFERENCE_NOT_FOUND',
      'DUPLICATE_REFERENCE',
      'DUPLICATE_REFERENCE',
    ]);
    expect(response.body.lines[2]).toMatchObject({
      difference_vnd: 0,
      fee_difference_vnd: 1_000,
      local_expected_fee_amount_vnd: 25_000,
    });

    const replay = await api()
      .post(path)
      .set({ ...headers(), 'Idempotency-Key': `cod-remittance-import-${suffix}` })
      .send(body)
      .expect(201);
    expect(replay.body).toMatchObject({ id: response.body.id, replayed: true });
    await api()
      .post(path)
      .set({ ...headers(), 'Idempotency-Key': `cod-remittance-import-${suffix}` })
      .send({ ...body, reason: `${body.reason} changed` })
      .expect(409);

    const crossBatchDuplicate = await api()
      .post(path)
      .set({ ...headers(), 'Idempotency-Key': `cod-remittance-repeat-${suffix}` })
      .send({
        ...body,
        batch_reference: `ghn-remittance-repeat-${suffix}`,
        records: [record(matched.shipment, 'cross-batch-duplicate')],
      })
      .expect(201);
    expect(crossBatchDuplicate.body).toMatchObject({
      exception_count: 1,
      matched_count: 0,
      status: 'REVIEW_REQUIRED',
    });
    expect(crossBatchDuplicate.body.lines[0]).toMatchObject({
      local_expected_amount_vnd: null,
      status: 'DUPLICATE_REFERENCE',
    });

    await api()
      .post(path)
      .set({ ...headers(readerToken), 'Idempotency-Key': `cod-reader-${suffix}` })
      .send(body)
      .expect(403);
    await api()
      .post(path)
      .set({ ...headers(staleAdminToken), 'Idempotency-Key': `cod-stale-${suffix}` })
      .send(body)
      .expect(403);
    await api()
      .get(`/v1/admin/financial-reconciliation/cod-receivables?store_id=${FASHION_STORE_ID}`)
      .set(headers(adminToken, 'beauty-local'))
      .expect(403);

    const after = await api()
      .get(
        `/v1/admin/financial-reconciliation/cod-receivables?store_id=${BEAUTY_STORE_ID}&limit=100`,
      )
      .set(headers())
      .expect(200);
    expect(
      after.body.items.find((item: { id: string }) => item.id === matched.shipment.id),
    ).toMatchObject({ status: 'REMITTED' });
    expect(
      after.body.items.find((item: { id: string }) => item.id === feeMismatch.shipment.id),
    ).toMatchObject({ status: 'REVIEW_REQUIRED' });

    const reviewIds: string[] = [];
    let reviewCursor: string | null = null;
    do {
      const query = new URLSearchParams({
        limit: '1',
        status: 'REVIEW_REQUIRED',
        store_id: BEAUTY_STORE_ID,
      });
      if (reviewCursor) query.set('cursor', reviewCursor);
      const page = await api()
        .get(`/v1/admin/financial-reconciliation/cod-receivables?${query.toString()}`)
        .set(headers())
        .expect(200);
      expect(page.body.items).toHaveLength(1);
      const reviewId: unknown = page.body.items[0]?.id;
      expect(reviewId).toEqual(expect.any(String));
      if (typeof reviewId !== 'string') throw new Error('Expected a COD receivable id');
      reviewIds.push(reviewId);
      reviewCursor = page.body.next_cursor;
    } while (reviewCursor);
    expect(reviewIds.length).toBeGreaterThanOrEqual(3);
    expect(new Set(reviewIds).size).toBe(reviewIds.length);
    await api()
      .get(
        `/v1/admin/financial-reconciliation/cod-receivables?store_id=${BEAUTY_STORE_ID}&cursor=${pending.shipment.id}`,
      )
      .set(headers())
      .expect(404);

    await expect(
      owner.shipment.findUniqueOrThrow({ where: { id: matched.shipment.id } }),
    ).resolves.toMatchObject({ codAmountVnd: 120_000n, status: 'DELIVERED' });
  });

  it('revalidates direct permission after an advisory-lock wait before replay or write', async () => {
    const providerReference = `revoked-payment-${suffix}`;
    await createPayment('revoked', { providerReference });
    const batchReference = `revoked-batch-${suffix}`;
    const key = `revoked-import-${suffix}`;
    const body = importBody(batchReference, [
      {
        fee_amount_vnd: 0,
        gross_amount_vnd: 120_000,
        occurred_at: '2026-08-01T06:30:00.000Z',
        provider_reference: providerReference,
        record_reference: `revoked-line-${suffix}`,
        type: 'PAYMENT',
      },
    ]);
    const idempotencyKeyHash = hash(`${BEAUTY_STORE_ID}\u0000PAYMENT_PROVIDER\u0000${key}`);
    const advisoryKey = `financial-reconciliation:${BEAUTY_STORE_ID}:${idempotencyKeyHash}`;
    let releaseLock = () => undefined;
    let markLockAcquired = () => undefined;
    const lockRelease = new Promise<void>((resolveLock) => {
      releaseLock = resolveLock;
    });
    const lockAcquired = new Promise<void>((resolveLock) => {
      markLockAcquired = resolveLock;
    });
    const blocker = owner.$transaction(
      async (transaction) => {
        await transaction.$executeRaw`
          SELECT pg_advisory_xact_lock(hashtextextended(${advisoryKey}, 0))
        `;
        markLockAcquired();
        await lockRelease;
      },
      { timeout: 15_000 },
    );
    let assignmentRevoked = false;
    let pendingRequest: Promise<request.Response> | undefined;
    try {
      await lockAcquired;
      pendingRequest = api()
        .post(`/v1/admin/financial-reconciliation/payment-batches?store_id=${BEAUTY_STORE_ID}`)
        .set({ ...headers(), 'Idempotency-Key': key })
        .send(body)
        .then((response) => response);
      await waitForBlockedAdvisoryLock();
      await owner.adminStoreRole.delete({
        where: {
          storeId_adminUserId_roleId: {
            adminUserId: fixture.adminId,
            roleId: storeAdminRoleId,
            storeId: BEAUTY_STORE_ID,
          },
        },
      });
      assignmentRevoked = true;
      releaseLock();
      await blocker;
      const response = await pendingRequest;
      expect(response.status).toBe(403);
      expect(
        await owner.financialReconciliationBatch.count({
          where: { idempotencyKeyHash, storeId: BEAUTY_STORE_ID },
        }),
      ).toBe(0);
    } finally {
      releaseLock();
      await blocker.catch(() => undefined);
      await pendingRequest?.catch(() => undefined);
      if (assignmentRevoked) {
        await owner.adminStoreRole.create({
          data: {
            adminUserId: fixture.adminId,
            grantedBy: fixture.adminId,
            roleId: storeAdminRoleId,
            storeId: BEAUTY_STORE_ID,
          },
        });
      }
    }
  });

  it('revalidates COD reconciliation permission after an advisory-lock wait', async () => {
    const { shipment } = await createCodShipment('revoked-cod');
    const key = `revoked-cod-import-${suffix}`;
    const idempotencyKeyHash = hash(`${BEAUTY_STORE_ID}\u0000SHIPPING_PROVIDER\u0000${key}`);
    const advisoryKey = `financial-reconciliation:${BEAUTY_STORE_ID}:${idempotencyKeyHash}`;
    const body = {
      batch_reference: `revoked-cod-batch-${suffix}`,
      business_date: '2026-08-01',
      confirmation_code: 'IMPORT_GHN_COD_SETTLEMENT',
      provider_code: 'GHN',
      provider_environment: 'SANDBOX',
      reason: 'Finance reviewed this blocked normalized GHN COD statement',
      records: [
        {
          cod_amount_vnd: 120_000,
          cod_fee_vnd: 3_000,
          occurred_at: '2026-08-01T08:15:00.000Z',
          provider_reference: shipment.providerShipmentId,
          record_reference: `revoked-cod-line-${suffix}`,
          shipping_fee_vnd: 22_000,
        },
      ],
    };
    let releaseLock = () => undefined;
    let markLockAcquired = () => undefined;
    const lockRelease = new Promise<void>((resolveLock) => {
      releaseLock = resolveLock;
    });
    const lockAcquired = new Promise<void>((resolveLock) => {
      markLockAcquired = resolveLock;
    });
    const blocker = owner.$transaction(
      async (transaction) => {
        await transaction.$executeRaw`
          SELECT pg_advisory_xact_lock(hashtextextended(${advisoryKey}, 0))
        `;
        markLockAcquired();
        await lockRelease;
      },
      { timeout: 15_000 },
    );
    let assignmentRevoked = false;
    let pendingRequest: Promise<request.Response> | undefined;
    try {
      await lockAcquired;
      pendingRequest = api()
        .post(`/v1/admin/financial-reconciliation/cod-batches?store_id=${BEAUTY_STORE_ID}`)
        .set({ ...headers(), 'Idempotency-Key': key })
        .send(body)
        .then((response) => response);
      await waitForBlockedAdvisoryLock();
      await owner.adminStoreRole.delete({
        where: {
          storeId_adminUserId_roleId: {
            adminUserId: fixture.adminId,
            roleId: storeAdminRoleId,
            storeId: BEAUTY_STORE_ID,
          },
        },
      });
      assignmentRevoked = true;
      releaseLock();
      await blocker;
      const response = await pendingRequest;
      expect(response.status).toBe(403);
      expect(
        await owner.financialReconciliationBatch.count({
          where: { idempotencyKeyHash, storeId: BEAUTY_STORE_ID },
        }),
      ).toBe(0);
    } finally {
      releaseLock();
      await blocker.catch(() => undefined);
      await pendingRequest?.catch(() => undefined);
      if (assignmentRevoked) {
        await owner.adminStoreRole.create({
          data: {
            adminUserId: fixture.adminId,
            grantedBy: fixture.adminId,
            roleId: storeAdminRoleId,
            storeId: BEAUTY_STORE_ID,
          },
        });
      }
    }
  });

  it('serializes concurrent imports of one channel batch reference', async () => {
    const providerReference = `concurrent-payment-${suffix}`;
    await createPayment('concurrent', { providerReference });
    const batchReference = `concurrent-batch-${suffix}`;
    const body = importBody(batchReference, [
      {
        fee_amount_vnd: 1_000,
        gross_amount_vnd: 120_000,
        occurred_at: '2026-08-01T06:45:00.000Z',
        provider_reference: providerReference,
        record_reference: `concurrent-line-${suffix}`,
        type: 'PAYMENT',
      },
    ]);
    const path = `/v1/admin/financial-reconciliation/payment-batches?store_id=${BEAUTY_STORE_ID}`;
    const responses = await Promise.all([
      api()
        .post(path)
        .set({ ...headers(), 'Idempotency-Key': `concurrent-import-a-${suffix}` })
        .send(body),
      api()
        .post(path)
        .set({ ...headers(), 'Idempotency-Key': `concurrent-import-b-${suffix}` })
        .send(body),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(
      await owner.financialReconciliationBatch.count({
        where: {
          batchReferenceDigest: hash(
            `${BEAUTY_STORE_ID}\u0000SANDBOX\u0000ZALO_CHECKOUT_ZALOPAY\u0000${batchReference}`,
          ),
          paymentChannelId: fixture.channelId,
          storeId: BEAUTY_STORE_ID,
        },
      }),
    ).toBe(1);
  });

  it('enforces recent MFA, write/read separation and store isolation', async () => {
    const providerReference = `authorization-payment-${suffix}`;
    await createPayment('authorization', { providerReference });
    const body = importBody(`authorization-batch-${suffix}`, [
      {
        fee_amount_vnd: 0,
        gross_amount_vnd: 120_000,
        occurred_at: '2026-08-01T07:00:00.000Z',
        provider_reference: providerReference,
        record_reference: `authorization-line-${suffix}`,
        type: 'PAYMENT',
      },
    ]);
    const path = `/v1/admin/financial-reconciliation/payment-batches?store_id=${BEAUTY_STORE_ID}`;
    await api()
      .post(path)
      .set({ ...headers(staleAdminToken), 'Idempotency-Key': `stale-import-${suffix}` })
      .send(body)
      .expect(403);
    await api()
      .post(path)
      .set({ ...headers(readerToken), 'Idempotency-Key': `reader-import-${suffix}` })
      .send(body)
      .expect(403);
    await api()
      .get(`/v1/admin/financial-reconciliation/batches?store_id=${FASHION_STORE_ID}`)
      .set(headers(adminToken, 'beauty-local'))
      .expect(403);

    const beautyBatch = await owner.financialReconciliationBatch.findFirstOrThrow({
      where: { storeId: BEAUTY_STORE_ID },
    });
    const fashionVisible = await withStoreTransaction(
      runtime,
      context(FASHION_STORE_ID),
      (transaction) =>
        transaction.financialReconciliationBatch.findFirst({ where: { id: beautyBatch.id } }),
    );
    expect(fashionVisible).toBeNull();
  });

  it('paginates the filtered ledger without duplicates or a phantom final cursor', async () => {
    const expectedIds = (
      await owner.financialReconciliationBatch.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
        where: { status: 'MATCHED', storeId: BEAUTY_STORE_ID },
      })
    ).map((batch) => batch.id);
    expect(expectedIds.length).toBeGreaterThan(1);

    const actualIds: string[] = [];
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({
        business_date_from: '2026-08-01',
        business_date_to: '2026-08-01',
        limit: '1',
        status: 'MATCHED',
        store_id: BEAUTY_STORE_ID,
      });
      if (cursor) query.set('cursor', cursor);
      const response = await api()
        .get(`/v1/admin/financial-reconciliation/batches?${query.toString()}`)
        .set(headers(readerToken))
        .expect(200);
      const page = response.body as {
        items: Array<{ id: string }>;
        next_cursor: string | null;
      };
      expect(page.items).toHaveLength(1);
      actualIds.push(page.items[0]!.id);
      cursor = page.next_cursor;
    } while (cursor);

    expect(actualIds).toEqual(expectedIds);
    expect(new Set(actualIds).size).toBe(actualIds.length);
  });

  it('keeps financial facts append-only and runtime grants minimal', async () => {
    const batch = await owner.financialReconciliationBatch.findFirstOrThrow({
      where: { storeId: BEAUTY_STORE_ID },
    });
    await expect(
      owner.$executeRaw`UPDATE financial_reconciliation_batches SET reason = 'Mutation must be rejected' WHERE id = ${batch.id}::uuid`,
    ).rejects.toMatchObject({ meta: expect.objectContaining({ code: '42501' }) });

    const grants = await owner.$queryRaw<Array<{ privilege_type: string; table_name: string }>>`
      SELECT table_name, privilege_type
      FROM information_schema.role_table_grants
      WHERE grantee = 'zalo_shop_runtime'
        AND table_name IN ('financial_reconciliation_batches', 'financial_reconciliation_lines')
      ORDER BY table_name, privilege_type
    `;
    expect(grants).toEqual([
      { privilege_type: 'INSERT', table_name: 'financial_reconciliation_batches' },
      { privilege_type: 'SELECT', table_name: 'financial_reconciliation_batches' },
      { privilege_type: 'INSERT', table_name: 'financial_reconciliation_lines' },
      { privilege_type: 'SELECT', table_name: 'financial_reconciliation_lines' },
    ]);

    const lineCount = await owner.financialReconciliationLine.count({
      where: { batchId: batch.id, storeId: BEAUTY_STORE_ID },
    });
    await expect(
      owner.$transaction(async (transaction) => {
        await transaction.financialReconciliationLine.create({
          data: {
            batchId: batch.id,
            feeAmountVnd: 0,
            grossAmountVnd: 1,
            lineNumber: 500,
            netAmountVnd: 1,
            occurredAt: new Date('2026-08-01T08:00:00.000Z'),
            providerReferenceDigest: hash(`unmatched-provider-${suffix}`),
            providerReferenceMasked: 'un********er',
            recordReferenceDigest: hash(`unmatched-record-${suffix}`),
            recordReferenceMasked: 'un********rd',
            status: 'REFERENCE_NOT_FOUND',
            storeId: BEAUTY_STORE_ID,
            type: 'PAYMENT',
          },
        });
      }),
    ).rejects.toThrow('financial reconciliation batch summary does not match its lines');
    expect(
      await owner.financialReconciliationLine.count({
        where: { batchId: batch.id, storeId: BEAUTY_STORE_ID },
      }),
    ).toBe(lineCount);
  });

  it('rejects the local/test down script before deleting existing financial facts', async () => {
    const codDownPath = resolve(
      REPOSITORY_ROOT,
      'packages/database/prisma/migrations/20260801100000_p0_m5_005_cod_reconciliation/down.sql',
    );
    const codDownSql = readFileSync(codDownPath, 'utf8');
    const codGuardEnd = codDownSql.indexOf('$$;');
    expect(codGuardEnd).toBeGreaterThan(0);
    await expect(
      owner.$executeRawUnsafe(codDownSql.slice(0, codGuardEnd + 3)),
    ).rejects.toMatchObject({
      meta: expect.objectContaining({ code: '55000' }),
    });

    const downPath = resolve(
      REPOSITORY_ROOT,
      'packages/database/prisma/migrations/20260801090000_p0_m5_005_financial_reconciliation/down.sql',
    );
    const batchCount = await owner.financialReconciliationBatch.count();
    expect(batchCount).toBeGreaterThan(0);
    const downSql = readFileSync(downPath, 'utf8');
    const guardEnd = downSql.indexOf('$$;');
    expect(guardEnd).toBeGreaterThan(0);
    await expect(owner.$executeRawUnsafe(downSql.slice(0, guardEnd + 3))).rejects.toMatchObject({
      meta: expect.objectContaining({ code: '55000' }),
    });

    const corepackCli = resolve(
      dirname(process.execPath),
      'node_modules/corepack/dist/corepack.js',
    );
    const rollback = spawnSync(
      process.execPath,
      [
        corepackCli,
        'pnpm',
        '--filter',
        '@zalo-shop/database',
        'exec',
        'prisma',
        'db',
        'execute',
        '--file',
        downPath,
        '--schema',
        resolve(REPOSITORY_ROOT, 'packages/database/prisma/schema.prisma'),
      ],
      {
        cwd: REPOSITORY_ROOT,
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: ownerUrl, NODE_ENV: 'test' },
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
    );
    if (rollback.error) throw rollback.error;
    const detail = `${rollback.stderr}\n${rollback.stdout}`;
    expect(rollback.status).not.toBe(0);
    expect(detail).toContain(
      'P0-M5-005 reconciliation rollback is unsafe after financial facts exist',
    );
    expect(await owner.financialReconciliationBatch.count()).toBe(batchCount);
  });
});
