import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';

import { config as loadEnvironment } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseRuntimeConfig } from '@zalo-shop/config';
import {
  appendOutboxMessage,
  claimOutboxMessages,
  completeOutboxMessage,
  createRuntimePrismaClient,
  failOutboxMessage,
  PrismaClient,
  recordInboxMessage,
  ReliableMessagingError,
  replayDeadLetterOutboxMessage,
  settleInboxMessage,
  startInboxMessageProcessing,
  withStoreTransaction,
  type OutboxMessageRecord,
  type StoreTransaction,
} from '@zalo-shop/database';
import { createStoreContext } from '@zalo-shop/domain';

import { OutboxMessageDispatcher } from '../../apps/worker/src/reliable-messaging/outbox-message-handler';
import { ReliableOutboxService } from '../../apps/worker/src/reliable-messaging/reliable-outbox.service';
import { TestOnlyOutboxHandler } from '../../apps/worker/src/reliable-messaging/test-only-outbox-handler';

const REPOSITORY_ROOT = resolve(__dirname, '../..');
const BEAUTY_STORE_ID = '10000000-0000-4000-8000-000000000001';
const FASHION_STORE_ID = '10000000-0000-4000-8000-000000000002';
const WORKER_ACTOR_ID = '00000000-0000-4000-8000-000000000005';
const SCRATCH_DATABASE_PATTERN = /^zalo_shop_m53_[0-9a-f]{12}$/u;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

type Fixture = {
  adminId: string;
  beautyPaymentChannelId: string;
  fashionPaymentChannelId: string;
  unauthorizedAdminId: string;
};

describe('M5.3 reliable outbox, inbox and worker', () => {
  loadEnvironment({ path: '.env.test.example', quiet: true, override: true });
  const sourceOwnerUrl = process.env.DATABASE_URL;
  const sourceRuntimeUrl = process.env.DATABASE_RUNTIME_URL;
  if (!sourceOwnerUrl || !sourceRuntimeUrl) throw new Error('M5.3 database URLs are required');

  const scratchDatabaseName = `zalo_shop_m53_${randomBytes(6).toString('hex')}`;
  const ownerUrl = scratchUrl(sourceOwnerUrl, scratchDatabaseName);
  const runtimeUrl = scratchUrl(sourceRuntimeUrl, scratchDatabaseName);
  const adminUrl = scratchUrl(sourceOwnerUrl, 'postgres');
  const admin = new PrismaClient({ datasourceUrl: adminUrl });
  let owner: PrismaClient | undefined;
  let runtimeA: PrismaClient | undefined;
  let runtimeB: PrismaClient | undefined;
  let fixture: Fixture | undefined;
  let scratchCreated = false;

  function scratchUrl(source: string, databaseName: string): string {
    const url = new URL(source);
    if (!LOOPBACK_HOSTS.has(url.hostname)) {
      throw new Error('M5.3 integration test requires a loopback PostgreSQL host');
    }
    url.pathname = `/${databaseName}`;
    return url.toString();
  }

  function assertScratchName(): void {
    if (process.env.NODE_ENV !== 'test' || !SCRATCH_DATABASE_PATTERN.test(scratchDatabaseName)) {
      throw new Error('Refusing unsafe M5.3 scratch database operation');
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

  function workerContext(storeId = BEAUTY_STORE_ID) {
    return createStoreContext({
      actor: { id: WORKER_ACTOR_ID, type: 'admin' },
      correlationId: randomUUID(),
      locale: 'vi',
      storeCode: storeId === BEAUTY_STORE_ID ? 'beauty-local' : 'fashion-local',
      storeId,
    });
  }

  function adminContext(adminId: string, storeId = BEAUTY_STORE_ID) {
    return createStoreContext({
      actor: { id: adminId, type: 'admin' },
      correlationId: randomUUID(),
      locale: 'vi',
      storeCode: storeId === BEAUTY_STORE_ID ? 'beauty-local' : 'fashion-local',
      storeId,
    });
  }

  async function setStoreContext(
    transaction: StoreTransaction,
    storeId: string,
    actorId = WORKER_ACTOR_ID,
  ): Promise<void> {
    await transaction.$executeRaw`
      SELECT
        set_config('app.store_id', ${storeId}, true),
        set_config('app.actor_id', ${actorId}, true),
        set_config('app.actor_type', 'admin', true),
        set_config('app.correlation_id', ${randomUUID()}, true)
    `;
  }

  async function createPaymentChannel(
    transaction: StoreTransaction,
    storeId: string,
    tag: string,
  ): Promise<string> {
    await setStoreContext(transaction, storeId);
    const miniAppId = `m53-${tag}-${randomUUID().slice(0, 8)}`;
    await transaction.storeZaloApp.update({
      data: { enabled: false, miniAppId },
      where: { storeId_environment: { environment: 'TEST', storeId } },
    });
    const channel = await transaction.storePaymentChannel.create({
      data: {
        checkoutAppId: miniAppId,
        deploymentEnvironment: 'TEST',
        keyVersion: 'test-v1',
        merchantReference: `m53-${tag}-merchant`,
        methodCode: 'ZALOPAY_SANDBOX',
        paymentWindowSeconds: 900,
        privateKeySecretRef: `test://m53/${tag}/private-key`,
        providerCode: 'ZALO_CHECKOUT_ZALOPAY',
        providerEnvironment: 'SANDBOX',
        secretFingerprint: digest(`m53-${tag}-payment`),
        status: 'DISABLED',
        storeId,
      },
    });
    return channel.id;
  }

  async function appendProbe(
    client: PrismaClient,
    input: {
      availableAt: Date;
      eventType?: string;
      maxAttempts?: number;
      outcome?: string;
      storeId?: string;
      tag: string;
    },
  ) {
    const storeId = input.storeId ?? BEAUTY_STORE_ID;
    return appendOutboxMessage(client, workerContext(storeId), {
      aggregateId: randomUUID(),
      aggregateType: input.eventType?.startsWith('payment.') ? 'PAYMENT_ATTEMPT' : 'TEST_PROBE',
      availableAt: input.availableAt,
      eventType: input.eventType ?? 'test.reliable-message.probe',
      eventVersion: 1,
      idempotencyKey: `m53:${input.tag}:${randomUUID()}`,
      ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
      payload: {
        ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
        store_id: storeId,
      },
    });
  }

  beforeAll(async () => {
    assertScratchName();
    await admin.$connect();
    const existing = await admin.$queryRaw<Array<{ database_name: string }>>`
      SELECT datname AS database_name FROM pg_database WHERE datname = ${scratchDatabaseName}
    `;
    if (existing.length !== 0) throw new Error('Generated M5.3 scratch database already exists');
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchDatabaseName}"`);
    scratchCreated = true;
    runPackageScript('migrate:deploy');
    runPackageScript('seed');

    owner = new PrismaClient({ datasourceUrl: ownerUrl });
    runtimeA = createRuntimePrismaClient(runtimeUrl);
    runtimeB = createRuntimePrismaClient(runtimeUrl);
    await Promise.all([owner.$connect(), runtimeA.$connect(), runtimeB.$connect()]);

    const adminId = randomUUID();
    const unauthorizedAdminId = randomUUID();
    await owner.adminUser.createMany({
      data: [
        {
          displayName: 'M5.3 authorized admin',
          email: `m53-${adminId}@example.test`,
          emailNormalized: `m53-${adminId}@example.test`,
          id: adminId,
          passwordHash: 'test-fixture-not-used',
        },
        {
          displayName: 'M5.3 unauthorized admin',
          email: `m53-${unauthorizedAdminId}@example.test`,
          emailNormalized: `m53-${unauthorizedAdminId}@example.test`,
          id: unauthorizedAdminId,
          passwordHash: 'test-fixture-not-used',
        },
      ],
    });
    const channels = await owner.$transaction(async (transaction) => {
      const beautyPaymentChannelId = await createPaymentChannel(
        transaction,
        BEAUTY_STORE_ID,
        'beauty',
      );
      const role = await transaction.storeRole.findUniqueOrThrow({
        where: { storeId_code: { code: 'store-admin', storeId: BEAUTY_STORE_ID } },
      });
      await transaction.adminStoreRole.create({
        data: {
          adminUserId: adminId,
          grantedBy: adminId,
          roleId: role.id,
          storeId: BEAUTY_STORE_ID,
        },
      });
      const fashionPaymentChannelId = await createPaymentChannel(
        transaction,
        FASHION_STORE_ID,
        'fashion',
      );
      return { beautyPaymentChannelId, fashionPaymentChannelId };
    });
    fixture = { adminId, unauthorizedAdminId, ...channels };
  }, 120_000);

  afterAll(async () => {
    await Promise.allSettled([
      owner?.$disconnect() ?? Promise.resolve(),
      runtimeA?.$disconnect() ?? Promise.resolve(),
      runtimeB?.$disconnect() ?? Promise.resolve(),
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

  it('appends versioned store-bound messages atomically and enforces idempotency', async () => {
    const [clientA, clientB] = requiredClients(runtimeA, runtimeB);
    const availableAt = new Date('2099-01-01T00:00:00.000Z');
    const aggregateId = randomUUID();
    const input = {
      aggregateId,
      aggregateType: 'TEST_PROBE',
      availableAt,
      eventType: 'test.reliable-message.probe',
      eventVersion: 1,
      idempotencyKey: `m53:concurrent:${randomUUID()}`,
      payload: { outcome: 'COMPLETE', store_id: BEAUTY_STORE_ID },
    } as const;
    const results = await Promise.all([
      appendOutboxMessage(clientA, workerContext(), input),
      appendOutboxMessage(clientB, workerContext(), input),
    ]);
    expect(results.map(({ replayed }) => replayed).sort()).toEqual([false, true]);
    expect(new Set(results.map(({ message }) => message.id))).toHaveLength(1);

    const defaultScheduleInput = {
      aggregateId: randomUUID(),
      aggregateType: 'TEST_PROBE',
      eventType: 'test.reliable-message.probe',
      eventVersion: 1,
      idempotencyKey: `m53:default-schedule:${randomUUID()}`,
      payload: { outcome: 'COMPLETE', store_id: BEAUTY_STORE_ID },
    } as const;
    const defaultScheduled = await appendOutboxMessage(
      clientA,
      workerContext(),
      defaultScheduleInput,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const defaultScheduleReplay = await appendOutboxMessage(
      clientA,
      workerContext(),
      defaultScheduleInput,
    );
    expect(defaultScheduleReplay).toMatchObject({
      message: { id: defaultScheduled.message.id },
      replayed: true,
    });
    const cleanupNow = new Date(defaultScheduled.message.availableAt.getTime() + 1);
    const cleanupWorkerId = 'm53-default-schedule-cleanup';
    const cleanupMessage = requiredMessage(
      (
        await claimOutboxMessages(clientA, workerContext(), {
          batchSize: 1,
          leaseDurationMs: 1_000,
          now: cleanupNow,
          workerId: cleanupWorkerId,
        })
      )[0],
    );
    expect(cleanupMessage.id).toBe(defaultScheduled.message.id);
    await completeOutboxMessage(clientA, workerContext(), {
      expectedVersion: cleanupMessage.version,
      messageId: cleanupMessage.id,
      now: cleanupNow,
      workerId: cleanupWorkerId,
    });

    await expect(
      appendOutboxMessage(clientA, workerContext(), {
        ...input,
        payload: { outcome: 'RETRYABLE', store_id: BEAUTY_STORE_ID },
      }),
    ).rejects.toEqual(new ReliableMessagingError('OUTBOX_IDEMPOTENCY_CONFLICT'));
    await expect(
      appendOutboxMessage(clientA, workerContext(), {
        ...input,
        availableAt: new Date(availableAt.getTime() + 1),
      }),
    ).rejects.toEqual(new ReliableMessagingError('OUTBOX_IDEMPOTENCY_CONFLICT'));
    await expect(
      appendOutboxMessage(clientA, workerContext(), {
        ...input,
        idempotencyKey: `${input.idempotencyKey}:wrong-store`,
        payload: { outcome: 'COMPLETE', store_id: FASHION_STORE_ID },
      }),
    ).rejects.toEqual(new ReliableMessagingError('OUTBOX_INPUT_INVALID'));
    await expect(
      appendOutboxMessage(clientA, workerContext(), {
        ...input,
        idempotencyKey: `${input.idempotencyKey}:camel-sensitive`,
        payload: {
          accessToken: 'forbidden-test-value',
          outcome: 'COMPLETE',
          store_id: BEAUTY_STORE_ID,
        },
      }),
    ).rejects.toEqual(new ReliableMessagingError('OUTBOX_INPUT_INVALID'));
    await expect(
      appendOutboxMessage(clientA, workerContext(), {
        ...input,
        idempotencyKey: `${input.idempotencyKey}:sensitive`,
        payload: {
          access_token: 'forbidden-test-value',
          outcome: 'COMPLETE',
          store_id: BEAUTY_STORE_ID,
        },
      }),
    ).rejects.toEqual(new ReliableMessagingError('OUTBOX_INPUT_INVALID'));
    await expect(
      appendOutboxMessage(clientA, workerContext(), {
        ...input,
        idempotencyKey: `${input.idempotencyKey}:camel-pii`,
        payload: {
          shippingAddress: 'full-address-must-not-enter-outbox',
          store_id: BEAUTY_STORE_ID,
        },
      }),
    ).rejects.toEqual(new ReliableMessagingError('OUTBOX_INPUT_INVALID'));
    await expect(
      appendOutboxMessage(clientA, workerContext(), {
        ...input,
        idempotencyKey: `${input.idempotencyKey}:pii`,
        payload: {
          shipping_address: 'full-address-must-not-enter-outbox',
          store_id: BEAUTY_STORE_ID,
        },
      }),
    ).rejects.toEqual(new ReliableMessagingError('OUTBOX_INPUT_INVALID'));

    await expect(
      withStoreTransaction(clientA, workerContext(), (transaction) =>
        transaction.outboxMessage.create({
          data: {
            aggregateId: randomUUID(),
            aggregateType: 'TEST_PROBE',
            eventType: 'test.reliable-message.probe',
            eventVersion: 1,
            idempotencyKey: `m53:database-store-guard:${randomUUID()}`,
            payload: { store_id: FASHION_STORE_ID },
            storeId: BEAUTY_STORE_ID,
          },
        }),
      ),
    ).rejects.toBeDefined();
  });

  it('claims disjoint leases, bounds retries and recovers expired leases', async () => {
    const [clientA, clientB] = requiredClients(runtimeA, runtimeB);
    const t0 = new Date('2031-01-01T00:00:00.000Z');
    await Promise.all([
      ...['a', 'b', 'c', 'd'].map((tag) => appendProbe(clientA, { availableAt: t0, tag })),
      appendProbe(clientA, { availableAt: t0, storeId: FASHION_STORE_ID, tag: 'fashion' }),
    ]);
    const [claimedA, claimedB] = await Promise.all([
      claimOutboxMessages(clientA, workerContext(), {
        batchSize: 2,
        leaseDurationMs: 10_000,
        now: t0,
        workerId: 'm53-worker-a',
      }),
      claimOutboxMessages(clientB, workerContext(), {
        batchSize: 2,
        leaseDurationMs: 10_000,
        now: t0,
        workerId: 'm53-worker-b',
      }),
    ]);
    const claimed = [...claimedA, ...claimedB];
    expect(claimed).toHaveLength(4);
    expect(new Set(claimed.map(({ id }) => id))).toHaveLength(4);
    expect(
      claimed.every(
        ({ attemptCount, storeId }) => attemptCount === 1 && storeId === BEAUTY_STORE_ID,
      ),
    ).toBe(true);

    const first = requiredMessage(claimed[0]);
    await expect(
      completeOutboxMessage(clientA, workerContext(), {
        expectedVersion: first.version,
        messageId: first.id,
        now: new Date(t0.getTime() + 1_000),
        workerId: 'wrong-worker',
      }),
    ).rejects.toEqual(new ReliableMessagingError('OUTBOX_LEASE_LOST'));
    await expect(
      completeOutboxMessage(clientA, workerContext(), {
        expectedVersion: first.version,
        messageId: first.id,
        now: new Date(t0.getTime() + 1_000),
        workerId: requiredOwner(first),
      }),
    ).resolves.toMatchObject({ status: 'COMPLETED' });

    const retry = requiredMessage(claimed[1]);
    const retryResult = await failOutboxMessage(clientA, workerContext(), {
      disposition: 'RETRYABLE',
      errorCode: 'TIMEOUT',
      expectedVersion: retry.version,
      messageId: retry.id,
      now: new Date(t0.getTime() + 1_000),
      randomValue: 0.5,
      workerId: requiredOwner(retry),
    });
    expect(retryResult).toMatchObject({ lastErrorCode: 'RETRYABLE_TIMEOUT', status: 'PENDING' });
    expect(retryResult.availableAt.toISOString()).toBe('2031-01-01T00:00:02.000Z');

    const permanent = requiredMessage(claimed[2]);
    await expect(
      failOutboxMessage(clientA, workerContext(), {
        disposition: 'PERMANENT',
        errorCode: 'INVALID_REQUEST',
        expectedVersion: permanent.version,
        messageId: permanent.id,
        now: new Date(t0.getTime() + 1_000),
        workerId: requiredOwner(permanent),
      }),
    ).resolves.toMatchObject({ lastErrorCode: 'PERMANENT_INVALID_REQUEST', status: 'DEAD_LETTER' });
    const review = requiredMessage(claimed[3]);
    await expect(
      failOutboxMessage(clientA, workerContext(), {
        disposition: 'REVIEW_REQUIRED',
        errorCode: 'FACT_MISMATCH',
        expectedVersion: review.version,
        messageId: review.id,
        now: new Date(t0.getTime() + 1_000),
        workerId: requiredOwner(review),
      }),
    ).resolves.toMatchObject({ lastErrorCode: 'REVIEW_FACT_MISMATCH', status: 'DEAD_LETTER' });

    const retryClaim = requiredMessage(
      (
        await claimOutboxMessages(clientA, workerContext(), {
          batchSize: 1,
          leaseDurationMs: 10_000,
          now: new Date(t0.getTime() + 2_000),
          workerId: 'm53-worker-a',
        })
      )[0],
    );
    await failOutboxMessage(clientA, workerContext(), {
      disposition: 'PERMANENT',
      errorCode: 'STOP_RETRY',
      expectedVersion: retryClaim.version,
      messageId: retryClaim.id,
      now: new Date(t0.getTime() + 3_000),
      workerId: requiredOwner(retryClaim),
    });

    const fashion = await claimOutboxMessages(clientA, workerContext(FASHION_STORE_ID), {
      batchSize: 1,
      leaseDurationMs: 10_000,
      now: t0,
      workerId: 'm53-fashion-worker',
    });
    expect(fashion).toHaveLength(1);
    expect(fashion[0]?.storeId).toBe(FASHION_STORE_ID);

    const leaseStart = new Date('2032-01-01T00:00:00.000Z');
    await appendProbe(clientA, { availableAt: leaseStart, maxAttempts: 2, tag: 'lease-recovery' });
    const leaseOne = requiredMessage(
      (
        await claimOutboxMessages(clientA, workerContext(), {
          batchSize: 1,
          leaseDurationMs: 5_000,
          now: leaseStart,
          workerId: 'm53-crashed-worker',
        })
      )[0],
    );
    const leaseTwo = requiredMessage(
      (
        await claimOutboxMessages(clientB, workerContext(), {
          batchSize: 1,
          leaseDurationMs: 5_000,
          now: new Date(leaseStart.getTime() + 5_001),
          workerId: 'm53-recovery-worker',
        })
      )[0],
    );
    expect(leaseTwo).toMatchObject({
      attemptCount: 2,
      id: leaseOne.id,
      leaseOwner: 'm53-recovery-worker',
    });
    await expect(
      claimOutboxMessages(clientA, workerContext(), {
        batchSize: 1,
        leaseDurationMs: 5_000,
        now: new Date(leaseStart.getTime() + 10_002),
        workerId: 'm53-final-worker',
      }),
    ).resolves.toEqual([]);
    await expect(
      withStoreTransaction(clientA, workerContext(), (transaction) =>
        transaction.outboxMessage.findUniqueOrThrow({ where: { id: leaseOne.id } }),
      ),
    ).resolves.toMatchObject({
      lastErrorCode: 'RETRY_EXHAUSTED_LEASE_EXPIRED',
      status: 'DEAD_LETTER',
    });
  });

  it('deduplicates inbox records concurrently and preserves digest identity', async () => {
    const [clientA, clientB] = requiredClients(runtimeA, runtimeB);
    const currentFixture = requiredFixture(fixture);
    const input = {
      channelId: currentFixture.beautyPaymentChannelId,
      environment: 'SANDBOX' as const,
      externalMessageKey: `m53-event-${randomUUID()}`,
      payloadDigest: digest('same-callback-payload'),
      source: 'ZALO_CHECKOUT_ZALOPAY',
    };
    const results = await Promise.all([
      recordInboxMessage(clientA, workerContext(), input),
      recordInboxMessage(clientB, workerContext(), input),
    ]);
    expect(results.map(({ replayed }) => replayed).sort()).toEqual([false, true]);
    expect(new Set(results.map(({ message }) => message.id))).toHaveLength(1);

    await expect(
      recordInboxMessage(clientA, workerContext(), {
        ...input,
        payloadDigest: digest('changed-callback-payload'),
      }),
    ).rejects.toEqual(new ReliableMessagingError('INBOX_IDEMPOTENCY_CONFLICT'));
    await expect(
      recordInboxMessage(clientA, workerContext(FASHION_STORE_ID), {
        ...input,
        externalMessageKey: `${input.externalMessageKey}-cross-store`,
      }),
    ).rejects.toBeDefined();

    const original = results[0]?.message;
    if (!original) throw new Error('Inbox fixture was not created');
    const started = await startInboxMessageProcessing(clientA, workerContext(), {
      expectedVersion: original.version,
      messageId: original.id,
    });
    const retry = await settleInboxMessage(clientA, workerContext(), {
      disposition: 'RETRYABLE',
      errorCode: 'TIMEOUT',
      expectedVersion: started.version,
      messageId: started.id,
    });
    expect(retry).toMatchObject({ errorCode: 'RETRYABLE_TIMEOUT', status: 'RETRY_PENDING' });
    const restarted = await startInboxMessageProcessing(clientA, workerContext(), {
      expectedVersion: retry.version,
      messageId: retry.id,
    });
    await expect(
      settleInboxMessage(clientA, workerContext(), {
        expectedVersion: restarted.version,
        messageId: restarted.id,
      }),
    ).resolves.toMatchObject({ errorCode: null, status: 'COMPLETED' });
  });

  it('requires scoped authorization, fresh MFA, confirmation and audit for dead-letter replay', async () => {
    const [clientA] = requiredClients(runtimeA, runtimeB);
    const currentFixture = requiredFixture(fixture);
    const now = new Date('2033-01-01T00:00:00.000Z');
    await appendProbe(clientA, {
      availableAt: now,
      eventType: 'payment.create.requested',
      tag: 'manual-replay',
    });
    const claimed = requiredMessage(
      (
        await claimOutboxMessages(clientA, workerContext(), {
          batchSize: 10,
          leaseDurationMs: 10_000,
          now,
          workerId: 'm53-replay-worker',
        })
      ).find(({ eventType }) => eventType === 'payment.create.requested'),
    );
    const dead = await failOutboxMessage(clientA, workerContext(), {
      disposition: 'PERMANENT',
      errorCode: 'INVALID_REQUEST',
      expectedVersion: claimed.version,
      messageId: claimed.id,
      now: new Date(now.getTime() + 1_000),
      workerId: requiredOwner(claimed),
    });
    const replayInput = {
      confirmation: 'RETRY_DEAD_LETTER',
      expectedVersion: dead.version,
      messageId: dead.id,
      mfaVerifiedAt: now,
      now,
      reason: 'Approved recovery after reviewed configuration correction',
    };

    await expect(
      replayDeadLetterOutboxMessage(
        clientA,
        adminContext(currentFixture.unauthorizedAdminId),
        replayInput,
      ),
    ).rejects.toEqual(new ReliableMessagingError('OUTBOX_REPLAY_PERMISSION_DENIED'));
    await expect(
      replayDeadLetterOutboxMessage(clientA, adminContext(currentFixture.adminId), {
        ...replayInput,
        confirmation: 'RETRY',
      }),
    ).rejects.toEqual(new ReliableMessagingError('OUTBOX_REPLAY_CONFIRMATION_REQUIRED'));
    await expect(
      replayDeadLetterOutboxMessage(clientA, adminContext(currentFixture.adminId), {
        ...replayInput,
        mfaVerifiedAt: new Date(now.getTime() - 300_001),
      }),
    ).rejects.toEqual(new ReliableMessagingError('OUTBOX_REPLAY_MFA_REQUIRED'));
    await expect(
      replayDeadLetterOutboxMessage(clientA, adminContext(currentFixture.adminId), {
        ...replayInput,
        expectedVersion: dead.version - 1,
      }),
    ).rejects.toEqual(new ReliableMessagingError('OUTBOX_STATE_CONFLICT'));
    await expect(
      replayDeadLetterOutboxMessage(
        clientA,
        adminContext(currentFixture.adminId, FASHION_STORE_ID),
        replayInput,
      ),
    ).rejects.toEqual(new ReliableMessagingError('OUTBOX_STATE_CONFLICT'));

    const replayed = await replayDeadLetterOutboxMessage(
      clientA,
      adminContext(currentFixture.adminId),
      replayInput,
    );
    expect(replayed).toMatchObject({
      aggregateId: dead.aggregateId,
      attemptCount: 0,
      eventType: dead.eventType,
      lastErrorCode: null,
      payload: dead.payload,
      status: 'PENDING',
      storeId: dead.storeId,
      version: dead.version + 1,
    });

    const audit = await withStoreTransaction(
      clientA,
      adminContext(currentFixture.adminId),
      (transaction) =>
        transaction.auditLog.findFirstOrThrow({
          where: { action: 'integration.outbox.dead_letter.replayed', targetId: dead.id },
        }),
    );
    expect(audit).toMatchObject({
      actorId: currentFixture.adminId,
      reason: replayInput.reason,
      storeId: BEAUTY_STORE_ID,
      targetType: 'outbox_message',
    });
    expect(JSON.stringify(audit)).not.toContain('store_id');
    expect(JSON.stringify(audit)).not.toContain('outcome');
  });

  it('runs only the hard-gated test handler and never calls a supplier', async () => {
    const [clientA] = requiredClients(runtimeA, runtimeB);
    const complete = await appendProbe(clientA, {
      availableAt: new Date(),
      outcome: 'COMPLETE',
      tag: 'worker-complete',
    });
    const exhausted = await appendProbe(clientA, {
      availableAt: new Date(),
      maxAttempts: 1,
      outcome: 'RETRYABLE',
      tag: 'worker-exhausted',
    });
    const config = parseRuntimeConfig({
      ...process.env,
      DATABASE_RUNTIME_URL: runtimeUrl,
      DATABASE_URL: ownerUrl,
      LOG_LEVEL: 'silent',
      NODE_ENV: 'test',
      OUTBOX_WORKER_BATCH_SIZE: '100',
    });
    const service = new ReliableOutboxService(
      clientA,
      config,
      new OutboxMessageDispatcher([new TestOnlyOutboxHandler('test')]),
    );
    await service.runOnce();

    const statuses = await withStoreTransaction(clientA, workerContext(), (transaction) =>
      transaction.outboxMessage.findMany({
        select: { id: true, lastErrorCode: true, status: true },
        where: { id: { in: [complete.message.id, exhausted.message.id] } },
      }),
    );
    expect(statuses).toEqual(
      expect.arrayContaining([
        { id: complete.message.id, lastErrorCode: null, status: 'COMPLETED' },
        {
          id: exhausted.message.id,
          lastErrorCode: 'RETRY_EXHAUSTED_TEST_RETRYABLE',
          status: 'DEAD_LETTER',
        },
      ]),
    );
  });
});

function requiredClients(
  first: PrismaClient | undefined,
  second: PrismaClient | undefined,
): readonly [PrismaClient, PrismaClient] {
  if (!first || !second) throw new Error('M5.3 clients are not initialized');
  return [first, second];
}

function requiredFixture(value: Fixture | undefined): Fixture {
  if (!value) throw new Error('M5.3 fixture is not initialized');
  return value;
}

function requiredMessage(value: OutboxMessageRecord | undefined): OutboxMessageRecord {
  if (!value) throw new Error('Expected an outbox message');
  return value;
}

function requiredOwner(message: OutboxMessageRecord): string {
  if (!message.leaseOwner) throw new Error('Expected an outbox lease owner');
  return message.leaseOwner;
}
