import { createHash, randomUUID } from 'node:crypto';

import { config as loadEnvironment } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createRuntimePrismaClient,
  PrismaClient,
  type StoreTransaction,
} from '@zalo-shop/database';

const BEAUTY_STORE_ID = '10000000-0000-4000-8000-000000000001';
const FASHION_STORE_ID = '10000000-0000-4000-8000-000000000002';
const ACTOR_ID = '20000000-0000-4000-8000-000000000001';
const M5_TABLES = [
  'inbox_messages',
  'outbox_messages',
  'payment_attempts',
  'payment_transitions',
  'provider_callbacks',
  'refund_transitions',
  'refunds',
  'shipment_items',
  'shipments',
  'shipping_operations',
  'shipping_quotes',
  'store_payment_channels',
  'store_shipping_channels',
  'tracking_events',
] as const;
const M5_PERMISSION_CODES = [
  'store.integration-jobs.retry',
  'store.integrations.manage',
  'store.integrations.read',
  'store.payments.read',
  'store.payments.reconcile',
  'store.refunds.create',
  'store.refunds.read',
  'store.shipments.cancel',
  'store.shipments.create',
  'store.shipments.label.read',
  'store.shipments.read',
  'store.shipments.reconcile',
] as const;

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

describe('M5.2 payment, shipping and reliable-message database foundation', () => {
  loadEnvironment({ path: '.env.test.example', quiet: true, override: true });
  const ownerUrl = process.env.DATABASE_URL;
  const runtimeUrl = process.env.DATABASE_RUNTIME_URL;
  if (!ownerUrl || !runtimeUrl) throw new Error('M5.2 database URLs are required');
  const owner = new PrismaClient({ datasourceUrl: ownerUrl });
  const runtime = createRuntimePrismaClient(runtimeUrl);
  const suffix = randomUUID().slice(0, 8);

  async function setStoreContext(transaction: StoreTransaction, storeId: string): Promise<void> {
    await transaction.$executeRaw`
      SELECT
        set_config('app.store_id', ${storeId}, true),
        set_config('app.actor_id', ${ACTOR_ID}, true),
        set_config('app.actor_type', 'admin', true),
        set_config('app.correlation_id', ${randomUUID()}, true)
    `;
  }

  async function withRollback(
    callback: (transaction: StoreTransaction) => Promise<void>,
  ): Promise<void> {
    const rollback = new Error(`m52-rollback-${randomUUID()}`);
    try {
      await runtime.$transaction(async (transaction) => {
        await callback(transaction);
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }

  async function expectDatabaseFailure(
    transaction: StoreTransaction,
    action: () => Promise<unknown>,
  ): Promise<void> {
    await transaction.$executeRawUnsafe('SAVEPOINT m52_expected_failure');
    let failure: unknown;
    try {
      await action();
    } catch (error) {
      failure = error;
    }
    await transaction.$executeRawUnsafe('ROLLBACK TO SAVEPOINT m52_expected_failure');
    await transaction.$executeRawUnsafe('RELEASE SAVEPOINT m52_expected_failure');
    expect(failure).toBeDefined();
  }

  async function createChannels(
    transaction: StoreTransaction,
    input: { storeId: string; tag: string },
  ) {
    await setStoreContext(transaction, input.storeId);
    const miniAppId = `m52-${input.tag}-app-${suffix}`;
    await transaction.storeZaloApp.update({
      data: { enabled: false, miniAppId },
      where: {
        storeId_environment: { environment: 'TEST', storeId: input.storeId },
      },
    });
    const paymentChannel = await transaction.storePaymentChannel.create({
      data: {
        checkoutAppId: miniAppId,
        deploymentEnvironment: 'TEST',
        keyVersion: 'test-v1',
        merchantReference: `test-merchant-${input.tag}-${suffix}`,
        methodCode: 'ZALOPAY_SANDBOX',
        paymentWindowSeconds: 900,
        privateKeySecretRef: `test://m52/${suffix}/${input.tag}/checkout-private-key`,
        providerCode: 'ZALO_CHECKOUT_ZALOPAY',
        providerEnvironment: 'SANDBOX',
        secretFingerprint: digest(`payment-${input.tag}-${suffix}`),
        status: 'DISABLED',
        storeId: input.storeId,
      },
    });
    const shippingChannel = await transaction.storeShippingChannel.create({
      data: {
        defaultServiceCode: 'GHN_STANDARD',
        keyVersion: 'test-v1',
        originAllowlistKey: 'GHN_SANDBOX',
        providerCode: 'GHN',
        providerEnvironment: 'SANDBOX',
        secretFingerprint: digest(`shipping-${input.tag}-${suffix}`),
        shopId: `test-shop-${input.tag}-${suffix}`,
        status: 'DISABLED',
        storeId: input.storeId,
        tokenSecretRef: `test://m52/${suffix}/${input.tag}/ghn-token`,
      },
    });
    return { miniAppId, paymentChannel, shippingChannel };
  }

  async function createOrder(
    transaction: StoreTransaction,
    input: { memberId?: string; payableVnd?: bigint; storeId: string; tag: string },
  ) {
    const memberId = input.memberId ?? randomUUID();
    const payableVnd = input.payableVnd ?? 100_000n;
    await transaction.member.create({ data: { id: memberId, storeId: input.storeId } });
    return transaction.order.create({
      data: {
        baseSubtotalVnd: payableVnd,
        couponDiscountVnd: 0,
        currency: 'VND',
        itemDiscountVnd: 0,
        memberId,
        orderDiscountVnd: 0,
        orderNumber: `M52-${input.tag}-${suffix}-${randomUUID().slice(0, 6)}`,
        payableVnd,
        paymentMethod: 'ONLINE',
        paymentStatus: 'PENDING',
        quoteHash: digest(`quote-${input.tag}-${randomUUID()}`),
        remoteSurchargeVnd: 0,
        shippingDiscountVnd: 0,
        shippingFeeVnd: 0,
        status: 'PENDING_PAYMENT',
        storeId: input.storeId,
      },
    });
  }

  beforeAll(async () => {
    await Promise.all([owner.$connect(), runtime.$connect()]);
  });

  afterAll(async () => {
    await Promise.all([owner.$disconnect(), runtime.$disconnect()]);
  });

  it('enables and forces RLS, registers permissions and fails closed without context', async () => {
    const policies = await owner.$queryRaw<
      Array<{ relforcerowsecurity: boolean; relname: string; relrowsecurity: boolean }>
    >`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relname = ANY(${[...M5_TABLES]})
      ORDER BY relname
    `;
    expect(policies).toHaveLength(M5_TABLES.length);
    expect(policies.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);

    const permissions = await owner.permission.findMany({
      select: { code: true, scope: true },
      where: { code: { in: [...M5_PERMISSION_CODES] } },
    });
    expect(permissions).toHaveLength(M5_PERMISSION_CODES.length);
    expect(permissions.every(({ scope }) => scope === 'STORE')).toBe(true);

    const updatePrivileges = await owner.$queryRaw<
      Array<{
        broad_update: boolean;
        identity_update: boolean;
        mutable_update: boolean;
        table_name: string;
      }>
    >`
      SELECT
        privilege.table_name,
        has_table_privilege('zalo_shop_runtime', privilege.table_name, 'UPDATE') AS broad_update,
        has_column_privilege(
          'zalo_shop_runtime', privilege.table_name, privilege.identity_column, 'UPDATE'
        ) AS identity_update,
        has_column_privilege(
          'zalo_shop_runtime', privilege.table_name, privilege.mutable_column, 'UPDATE'
        ) AS mutable_update
      FROM (VALUES
        ('payment_attempts', 'amount_vnd', 'status'),
        ('refunds', 'amount_vnd', 'status'),
        ('shipments', 'order_id', 'status'),
        ('shipping_operations', 'request_hash', 'status'),
        ('store_payment_channels', 'provider_code', 'status'),
        ('store_shipping_channels', 'shop_id', 'status')
      ) AS privilege(table_name, identity_column, mutable_column)
      ORDER BY privilege.table_name
    `;
    expect(updatePrivileges).toHaveLength(6);
    expect(
      updatePrivileges.every(
        ({ broad_update, identity_update, mutable_update }) =>
          !broad_update && !identity_update && mutable_update,
      ),
    ).toBe(true);

    await expect(runtime.storePaymentChannel.count()).resolves.toBe(0);
    await expect(runtime.outboxMessage.count()).resolves.toBe(0);
  });

  it('isolates channels by store and refuses activation before the Mini App is enabled', async () => {
    await withRollback(async (transaction) => {
      const beauty = await createChannels(transaction, { storeId: BEAUTY_STORE_ID, tag: 'beauty' });
      const fashion = await createChannels(transaction, {
        storeId: FASHION_STORE_ID,
        tag: 'fashion',
      });

      expect(await transaction.storePaymentChannel.count()).toBe(1);
      expect(await transaction.storeShippingChannel.count()).toBe(1);
      await setStoreContext(transaction, BEAUTY_STORE_ID);
      expect(await transaction.storePaymentChannel.findMany({ select: { id: true } })).toEqual([
        { id: beauty.paymentChannel.id },
      ]);
      expect(await transaction.storeShippingChannel.findMany({ select: { id: true } })).toEqual([
        { id: beauty.shippingChannel.id },
      ]);

      await expectDatabaseFailure(transaction, () =>
        transaction.storePaymentChannel.update({
          data: { status: 'ACTIVE' },
          where: { id: beauty.paymentChannel.id },
        }),
      );
      await transaction.storeZaloApp.update({
        data: { enabled: true },
        where: {
          storeId_environment: { environment: 'TEST', storeId: BEAUTY_STORE_ID },
        },
      });
      await expect(
        transaction.storePaymentChannel.update({
          data: { status: 'ACTIVE' },
          where: { id: beauty.paymentChannel.id },
        }),
      ).resolves.toMatchObject({ status: 'ACTIVE' });

      await setStoreContext(transaction, FASHION_STORE_ID);
      expect(await transaction.storePaymentChannel.findMany({ select: { id: true } })).toEqual([
        { id: fashion.paymentChannel.id },
      ]);
    });
  });

  it('enforces composite store references, one active payment attempt and refund capacity', async () => {
    await withRollback(async (transaction) => {
      const beauty = await createChannels(transaction, { storeId: BEAUTY_STORE_ID, tag: 'pay' });
      await setStoreContext(transaction, FASHION_STORE_ID);
      const fashionOrder = await createOrder(transaction, {
        storeId: FASHION_STORE_ID,
        tag: 'cross-store',
      });
      await expectDatabaseFailure(transaction, () =>
        transaction.paymentAttempt.create({
          data: {
            amountVnd: fashionOrder.payableVnd,
            attemptSequence: 1,
            channelId: beauty.paymentChannel.id,
            correlationId: randomUUID(),
            createIdempotencyKeyHash: digest('cross-store-attempt'),
            expiresAt: new Date(Date.now() + 900_000),
            orderId: fashionOrder.id,
            publicPaymentNumber: `PAY-CROSS-${suffix}`,
            storeId: FASHION_STORE_ID,
          },
        }),
      );

      const fashion = await createChannels(transaction, {
        storeId: FASHION_STORE_ID,
        tag: 'refund',
      });
      const activeOrder = await createOrder(transaction, {
        storeId: FASHION_STORE_ID,
        tag: 'active',
      });
      await expectDatabaseFailure(transaction, () =>
        transaction.paymentAttempt.create({
          data: {
            amountVnd: activeOrder.payableVnd + 1n,
            attemptSequence: 1,
            channelId: fashion.paymentChannel.id,
            correlationId: randomUUID(),
            createIdempotencyKeyHash: digest(`amount-mismatch-${suffix}`),
            expiresAt: new Date(Date.now() + 900_000),
            orderId: activeOrder.id,
            publicPaymentNumber: `PAY-AMOUNT-MISMATCH-${suffix}`,
            storeId: FASHION_STORE_ID,
          },
        }),
      );
      await transaction.paymentAttempt.create({
        data: {
          amountVnd: activeOrder.payableVnd,
          attemptSequence: 1,
          channelId: fashion.paymentChannel.id,
          correlationId: randomUUID(),
          createIdempotencyKeyHash: digest(`active-1-${suffix}`),
          expiresAt: new Date(Date.now() + 900_000),
          orderId: activeOrder.id,
          publicPaymentNumber: `PAY-ACTIVE-1-${suffix}`,
          storeId: FASHION_STORE_ID,
        },
      });
      await expectDatabaseFailure(transaction, () =>
        transaction.paymentAttempt.create({
          data: {
            amountVnd: activeOrder.payableVnd,
            attemptSequence: 2,
            channelId: fashion.paymentChannel.id,
            correlationId: randomUUID(),
            createIdempotencyKeyHash: digest(`active-2-${suffix}`),
            expiresAt: new Date(Date.now() + 900_000),
            orderId: activeOrder.id,
            publicPaymentNumber: `PAY-ACTIVE-2-${suffix}`,
            status: 'PROVIDER_PENDING',
            storeId: FASHION_STORE_ID,
          },
        }),
      );

      const refundOrder = await createOrder(transaction, {
        payableVnd: 100_000n,
        storeId: FASHION_STORE_ID,
        tag: 'refund',
      });
      const payment = await transaction.paymentAttempt.create({
        data: {
          amountVnd: refundOrder.payableVnd,
          attemptSequence: 1,
          channelId: fashion.paymentChannel.id,
          correlationId: randomUUID(),
          createIdempotencyKeyHash: digest(`refund-payment-${suffix}`),
          expiresAt: new Date(Date.now() + 900_000),
          orderId: refundOrder.id,
          providerOrderId: `provider-order-${suffix}`,
          providerTransactionId: `provider-transaction-${suffix}`,
          publicPaymentNumber: `PAY-REFUND-${suffix}`,
          status: 'SUCCEEDED',
          storeId: FASHION_STORE_ID,
          succeededAt: new Date(),
        },
      });
      const admin = await transaction.adminUser.create({
        data: {
          displayName: 'M5.2 refund test admin',
          email: `m52-${suffix}@example.test`,
          emailNormalized: `m52-${suffix}@example.test`,
          passwordHash: 'test-fixture-not-used',
        },
      });
      await expect(
        transaction.paymentAttempt.update({
          data: { providerStatus: '1' },
          where: { id: payment.id },
        }),
      ).resolves.toMatchObject({ providerStatus: '1' });
      await expectDatabaseFailure(transaction, () =>
        transaction.paymentAttempt.update({
          data: { amountVnd: 99_999n },
          where: { id: payment.id },
        }),
      );
      await transaction.refund.create({
        data: {
          amountVnd: 60_000,
          idempotencyKeyHash: digest(`refund-1-${suffix}`),
          orderId: refundOrder.id,
          paymentAttemptId: payment.id,
          publicRefundNumber: `REF-1-${suffix}`,
          reason: 'Approved M5.2 capacity test',
          requestedBy: admin.id,
          storeId: FASHION_STORE_ID,
        },
      });
      await expectDatabaseFailure(transaction, () =>
        transaction.refund.create({
          data: {
            amountVnd: 40_001,
            idempotencyKeyHash: digest(`refund-2-${suffix}`),
            orderId: refundOrder.id,
            paymentAttemptId: payment.id,
            publicRefundNumber: `REF-2-${suffix}`,
            reason: 'Must exceed the remaining refundable amount',
            requestedBy: admin.id,
            storeId: FASHION_STORE_ID,
          },
        }),
      );
    });
  });

  it('keeps GHN callbacks as hints and protects append-only facts', async () => {
    await withRollback(async (transaction) => {
      const beauty = await createChannels(transaction, {
        storeId: BEAUTY_STORE_ID,
        tag: 'callback',
      });
      const callback = await transaction.providerCallback.create({
        data: {
          channelId: beauty.shippingChannel.id,
          channelKind: 'SHIPPING',
          environment: 'SANDBOX',
          eventDigest: digest(`ghn-event-${suffix}`),
          payloadDigest: digest(`ghn-payload-${suffix}`),
          processingStatus: 'RECEIVED',
          providerCode: 'GHN',
          signatureStatus: 'NOT_AVAILABLE',
          storeId: BEAUTY_STORE_ID,
          trust: 'UNVERIFIED_HINT',
        },
      });
      expect(callback.trust).toBe('UNVERIFIED_HINT');
      await expectDatabaseFailure(transaction, () =>
        transaction.providerCallback.create({
          data: {
            channelId: beauty.shippingChannel.id,
            channelKind: 'SHIPPING',
            environment: 'SANDBOX',
            eventDigest: digest(`forged-ghn-event-${suffix}`),
            payloadDigest: digest(`forged-ghn-payload-${suffix}`),
            processingStatus: 'RECEIVED',
            providerCode: 'GHN',
            signatureStatus: 'VERIFIED',
            storeId: BEAUTY_STORE_ID,
            trust: 'AUTHENTICATED_FACT',
          },
        }),
      );

      const order = await createOrder(transaction, {
        storeId: BEAUTY_STORE_ID,
        tag: 'transition',
      });
      const attempt = await transaction.paymentAttempt.create({
        data: {
          amountVnd: order.payableVnd,
          attemptSequence: 1,
          channelId: beauty.paymentChannel.id,
          correlationId: randomUUID(),
          createIdempotencyKeyHash: digest(`transition-${suffix}`),
          expiresAt: new Date(Date.now() + 900_000),
          orderId: order.id,
          publicPaymentNumber: `PAY-TRANSITION-${suffix}`,
          storeId: BEAUTY_STORE_ID,
        },
      });
      const transition = await transaction.paymentTransition.create({
        data: {
          actorId: ACTOR_ID,
          actorType: 'ADMIN',
          correlationId: randomUUID(),
          event: 'CREATED',
          paymentAttemptId: attempt.id,
          source: 'SYSTEM',
          storeId: BEAUTY_STORE_ID,
          toStatus: 'CREATED',
        },
      });
      await expectDatabaseFailure(transaction, () =>
        transaction.paymentTransition.update({
          data: { reason: 'tampered' },
          where: { id: transition.id },
        }),
      );
    });
  });

  it('allows worker status updates without allowing outbox identity mutation', async () => {
    await withRollback(async (transaction) => {
      await setStoreContext(transaction, BEAUTY_STORE_ID);
      const message = await transaction.outboxMessage.create({
        data: {
          aggregateId: randomUUID(),
          aggregateType: 'PAYMENT_ATTEMPT',
          eventType: 'payment.create.requested',
          eventVersion: 1,
          idempotencyKey: `m52-outbox-${suffix}`,
          payload: { payment_attempt_id: randomUUID(), store_id: BEAUTY_STORE_ID },
          storeId: BEAUTY_STORE_ID,
        },
      });
      await expect(
        transaction.outboxMessage.update({
          data: {
            leaseExpiresAt: new Date(Date.now() + 30_000),
            leaseOwner: `worker-${suffix}`,
            status: 'PROCESSING',
          },
          where: { id: message.id },
        }),
      ).resolves.toMatchObject({ status: 'PROCESSING' });
      await expectDatabaseFailure(transaction, () =>
        transaction.outboxMessage.update({
          data: { aggregateType: 'TAMPERED' },
          where: { id: message.id },
        }),
      );
    });
  });
});
