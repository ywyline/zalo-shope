import { createHash, randomUUID } from 'node:crypto';

import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config as loadEnvironment } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseRuntimeConfig } from '@zalo-shop/config';
import {
  AFTER_SALE_EVIDENCE_DELETE_EVENT,
  AFTER_SALE_EVIDENCE_EXPIRE_EVENT,
  applyAfterSaleEvidenceDeletionResultForLease,
  claimOutboxMessages,
  completeOutboxMessage,
  createRuntimePrismaClient,
  failOutboxMessage,
  initializeAfterSaleEvidenceUpload,
  listAfterSaleEvidenceLifecycleDeadLetterCandidates,
  loadAfterSaleEvidenceDeletionWorkForLease,
  PrismaClient,
  reconcileAfterSaleEvidenceLifecycleDeadLetter,
  type OutboxMessageRecord,
  withAfterSaleEvidenceSystemTransaction,
  withStoreTransaction,
} from '@zalo-shop/database';
import { createAfterSaleEvidenceSystemContext, createStoreContext } from '@zalo-shop/domain';
import {
  AfterSaleEvidenceStorageError,
  createAfterSaleEvidenceStorageProvider,
  type AfterSaleEvidenceObjectStorageProvider,
  type S3AfterSaleEvidenceStorageProvider,
} from '@zalo-shop/integrations';

import {
  AfterSaleEvidenceDeleteRequestedHandler,
  AfterSaleEvidenceExpireRequestedHandler,
} from '../../apps/worker/src/after-sales-evidence/after-sale-evidence-deletion.handler';

const DELETE_BASE_DELAY_MS = 60_000;
const DELETE_MAX_DELAY_MS = 6 * 60 * 60 * 1_000;
const DELETE_MAX_ATTEMPTS = 8;

type ObjectRole = 'DERIVATIVE' | 'ORIGINAL' | 'SCAN_TEMPORARY';
type TrackedObject = Readonly<{ evidenceId: string; key: string; role: ObjectRole }>;

function jpegBytes(): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]),
    Buffer.from('M6.3-B2b-D4 deletion evidence', 'ascii'),
  ]);
}

describe.sequential('M6.3-B2b-D4 evidence deletion worker', () => {
  loadEnvironment({ path: '.env.test.example', quiet: true, override: true });
  const config = parseRuntimeConfig();
  const ownerUrl = process.env.DATABASE_URL;
  if (!ownerUrl) throw new Error('M6.3-B2b-D4 owner database URL is required');

  const owner = new PrismaClient({ datasourceUrl: ownerUrl });
  const runtime = createRuntimePrismaClient(config.DATABASE_RUNTIME_URL);
  const suffix = randomUUID().slice(0, 8);
  const storeId = randomUUID();
  const storeCode = `m63d4-${suffix}`;
  const adminId = randomUUID();
  const memberId = randomUUID();
  const trackedObjects: TrackedObject[] = [];
  let storage: S3AfterSaleEvidenceStorageProvider;
  let uploadClient: S3Client;
  let readClient: S3Client;
  let expireHandler: AfterSaleEvidenceExpireRequestedHandler;
  let deleteHandler: AfterSaleEvidenceDeleteRequestedHandler;

  function memberContext() {
    return createStoreContext({
      actor: { id: memberId, type: 'member' },
      correlationId: randomUUID(),
      locale: 'vi',
      storeCode,
      storeId,
    });
  }

  function workerContext() {
    return createStoreContext({
      actor: { id: adminId, type: 'admin' },
      correlationId: randomUUID(),
      locale: 'vi',
      storeCode,
      storeId,
    });
  }

  function systemContext() {
    return createAfterSaleEvidenceSystemContext({ correlationId: randomUUID(), storeId });
  }

  async function initializeObject(): Promise<Readonly<{ evidenceId: string; objectKey: string }>> {
    const body = jpegBytes();
    const checksumSha256 = createHash('sha256').update(body).digest('hex');
    const initialized = await initializeAfterSaleEvidenceUpload(runtime, memberContext(), {
      byteSize: body.byteLength,
      checksumSha256,
      deploymentEnvironment: 'test',
      filename: 'evidence.jpg',
      idempotencyKey: `m63-d4-init-${randomUUID()}`,
      maxUnclaimedBytes: 200 * 1_024 * 1_024,
      maxUnclaimedFiles: 20,
      mimeType: 'image/jpeg',
      uploadTtlSeconds: 15 * 60,
    });
    const target = await storage.createUploadTarget({
      byteSize: body.byteLength,
      checksumSha256,
      deploymentEnvironment: 'test',
      evidenceId: initialized.evidence.id,
      mimeType: 'image/jpeg',
      objectKey: initialized.objectKey,
      storeId,
    });
    const response = await fetch(target.url, {
      body: Uint8Array.from(body),
      headers: target.headers,
      method: 'PUT',
    });
    expect(response.status).toBeLessThan(300);
    trackedObjects.push({
      evidenceId: initialized.evidence.id,
      key: initialized.objectKey,
      role: 'ORIGINAL',
    });
    return { evidenceId: initialized.evidence.id, objectKey: initialized.objectKey };
  }

  async function addLedgerObject(
    evidenceId: string,
    role: 'DERIVATIVE' | 'SCAN_TEMPORARY',
    leaf: string,
  ): Promise<string> {
    const namespace = role === 'DERIVATIVE' ? 'derived' : 'scan';
    const key = `test/${storeId}/${namespace}/${evidenceId}/${leaf}`;
    await uploadClient.send(
      new PutObjectCommand({
        Body: Uint8Array.from(Buffer.from(`D4 ${role} bytes`, 'ascii')),
        Bucket: config.EVIDENCE_STORAGE_BUCKET,
        Key: key,
      }),
    );
    await withAfterSaleEvidenceSystemTransaction(
      runtime,
      systemContext(),
      (transaction) =>
        transaction.$executeRaw`
        INSERT INTO after_sale_evidence_objects (
          store_id, evidence_file_id, object_role, object_key, object_key_hash, updated_at
        ) VALUES (
          ${storeId}::uuid, ${evidenceId}::uuid,
          ${role}::after_sale_evidence_object_role, ${key},
          ${createHash('sha256').update(key).digest('hex')}, pg_catalog.clock_timestamp()
        )
      `,
    );
    trackedObjects.push({ evidenceId, key, role });
    return key;
  }

  async function makeUploadExpireDue(evidenceId: string): Promise<void> {
    await owner.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        UPDATE after_sale_evidence_files
        SET upload_deadline_at = pg_catalog.clock_timestamp() - interval '1 second'
        WHERE store_id = ${storeId}::uuid AND id = ${evidenceId}::uuid
      `;
      await transaction.$executeRaw`
        UPDATE outbox_messages
        SET available_at = pg_catalog.clock_timestamp() - interval '1 second',
          updated_at = pg_catalog.clock_timestamp()
        WHERE store_id = ${storeId}::uuid AND aggregate_id = ${evidenceId}::uuid
          AND event_type = ${AFTER_SALE_EVIDENCE_EXPIRE_EVENT}
          AND status = 'PENDING'::outbox_status
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });
  }

  async function makeDeleteRetryDue(evidenceId: string): Promise<void> {
    await owner.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        UPDATE after_sale_evidence_files
        SET next_delete_attempt_at = pg_catalog.clock_timestamp() - interval '1 second'
        WHERE store_id = ${storeId}::uuid AND id = ${evidenceId}::uuid
      `;
      await transaction.$executeRaw`
        UPDATE outbox_messages
        SET available_at = pg_catalog.clock_timestamp() - interval '1 second',
          updated_at = pg_catalog.clock_timestamp()
        WHERE store_id = ${storeId}::uuid AND aggregate_id = ${evidenceId}::uuid
          AND event_type = ${AFTER_SALE_EVIDENCE_DELETE_EVENT}
          AND status = 'PENDING'::outbox_status
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });
  }

  async function claimEvent(
    evidenceId: string,
    eventType: string,
    workerId: string,
    input: Readonly<{ leaseDurationMs?: number; now?: Date }> = {},
  ): Promise<OutboxMessageRecord> {
    const [message] = await claimOutboxMessages(runtime, workerContext(), {
      batchSize: 1,
      leaseDurationMs: input.leaseDurationMs ?? config.OUTBOX_WORKER_LEASE_MS,
      ...(input.now ? { now: input.now } : {}),
      workerId,
    });
    if (!message || message.aggregateId !== evidenceId || message.eventType !== eventType) {
      throw new Error(`Expected ${eventType} for ${evidenceId}`);
    }
    return message;
  }

  async function handleAndComplete(
    handler: AfterSaleEvidenceExpireRequestedHandler | AfterSaleEvidenceDeleteRequestedHandler,
    evidenceId: string,
    eventType: string,
  ): Promise<OutboxMessageRecord> {
    const workerId = `m63-d4-worker-${randomUUID()}`;
    const message = await claimEvent(evidenceId, eventType, workerId);
    await handler.handle(message);
    await completeOutboxMessage(runtime, workerContext(), {
      expectedVersion: message.version,
      messageId: message.id,
      workerId,
    });
    return message;
  }

  async function expectObjectMissing(key: string): Promise<void> {
    let failure: unknown;
    try {
      await readClient.send(
        new HeadObjectCommand({ Bucket: config.EVIDENCE_STORAGE_BUCKET, Key: key }),
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    expect((failure as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode).toBe(
      404,
    );
  }

  beforeAll(async () => {
    if (
      !config.AFTER_SALE_EVIDENCE_DELETION_WORKER_ENABLED ||
      config.EVIDENCE_STORAGE_PROVIDER !== 's3' ||
      config.EVIDENCE_STORAGE_ENDPOINT === undefined ||
      config.EVIDENCE_STORAGE_BUCKET === undefined ||
      config.EVIDENCE_STORAGE_FORCE_PATH_STYLE === undefined ||
      config.EVIDENCE_STORAGE_REGION === undefined ||
      config.EVIDENCE_STORAGE_UPLOAD_ACCESS_KEY === undefined ||
      config.EVIDENCE_STORAGE_UPLOAD_SECRET_KEY === undefined ||
      config.EVIDENCE_STORAGE_READ_ACCESS_KEY === undefined ||
      config.EVIDENCE_STORAGE_READ_SECRET_KEY === undefined
    ) {
      throw new Error('M6.3-B2b-D4 storage/deletion configuration is incomplete');
    }
    const configuredStorage = createAfterSaleEvidenceStorageProvider(config);
    if (!configuredStorage) throw new Error('M6.3-B2b-D4 evidence storage is disabled');
    storage = configuredStorage;
    const clientConfig = {
      endpoint: config.EVIDENCE_STORAGE_ENDPOINT,
      forcePathStyle: config.EVIDENCE_STORAGE_FORCE_PATH_STYLE,
      region: config.EVIDENCE_STORAGE_REGION,
    };
    uploadClient = new S3Client({
      ...clientConfig,
      credentials: {
        accessKeyId: config.EVIDENCE_STORAGE_UPLOAD_ACCESS_KEY,
        secretAccessKey: config.EVIDENCE_STORAGE_UPLOAD_SECRET_KEY,
      },
    });
    readClient = new S3Client({
      ...clientConfig,
      credentials: {
        accessKeyId: config.EVIDENCE_STORAGE_READ_ACCESS_KEY,
        secretAccessKey: config.EVIDENCE_STORAGE_READ_SECRET_KEY,
      },
    });
    expireHandler = new AfterSaleEvidenceExpireRequestedHandler(runtime, config);
    deleteHandler = new AfterSaleEvidenceDeleteRequestedHandler(runtime, storage, config);
    await owner.$transaction(async (transaction) => {
      await transaction.adminUser.create({
        data: {
          displayName: 'M6.3-B2b-D4 fixture administrator',
          email: `${adminId}@example.invalid`,
          emailNormalized: `${adminId}@example.invalid`,
          id: adminId,
          passwordHash: 'test-fixture-not-a-login-hash',
        },
      });
      await transaction.store.create({
        data: { code: storeCode, id: storeId, industry: 'BEAUTY' },
      });
      await transaction.member.create({
        data: { displayName: 'D4 evidence owner', id: memberId, storeId },
      });
    });
  });

  afterAll(async () => {
    if (storage) {
      for (const object of trackedObjects) {
        await storage
          .removeObject({
            deploymentEnvironment: 'test',
            evidenceId: object.evidenceId,
            objectKey: object.key,
            objectRole: object.role,
            storeId,
          })
          .catch(() => undefined);
      }
      storage.destroy();
    }
    uploadClient?.destroy();
    readClient?.destroy();
    await owner.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        DELETE FROM after_sale_evidence_transitions WHERE store_id = ${storeId}::uuid
      `;
      await transaction.$executeRaw`
        DELETE FROM after_sale_evidence_objects WHERE store_id = ${storeId}::uuid
      `;
      await transaction.$executeRaw`
        DELETE FROM outbox_messages
        WHERE store_id = ${storeId}::uuid AND aggregate_type = 'AFTER_SALE_EVIDENCE'
      `;
      await transaction.$executeRaw`
        DELETE FROM idempotency_records
        WHERE store_id = ${storeId}::uuid AND operation LIKE 'after-sale-evidence-%'
      `;
      await transaction.$executeRaw`
        DELETE FROM after_sale_evidence_files WHERE store_id = ${storeId}::uuid
      `;
      await transaction.$executeRaw`DELETE FROM members WHERE id = ${memberId}::uuid`;
      await transaction.$executeRaw`DELETE FROM stores WHERE id = ${storeId}::uuid`;
      await transaction.$executeRaw`DELETE FROM admin_users WHERE id = ${adminId}::uuid`;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });
    await Promise.all([owner.$disconnect(), runtime.$disconnect()]);
  });

  it('expires and physically deletes ORIGINAL, DERIVATIVE and SCAN_TEMPORARY objects', async () => {
    const created = await initializeObject();
    const derivativeKey = await addLedgerObject(created.evidenceId, 'DERIVATIVE', 'thumbnail.webp');
    const scanKey = await addLedgerObject(created.evidenceId, 'SCAN_TEMPORARY', 'scan.tmp');
    await makeUploadExpireDue(created.evidenceId);
    await handleAndComplete(expireHandler, created.evidenceId, AFTER_SALE_EVIDENCE_EXPIRE_EVENT);
    await handleAndComplete(deleteHandler, created.evidenceId, AFTER_SALE_EVIDENCE_DELETE_EVENT);

    expect(
      await owner.afterSaleEvidenceFile.findUniqueOrThrow({ where: { id: created.evidenceId } }),
    ).toMatchObject({ objectKey: null, status: 'DELETED' });
    expect(
      await owner.afterSaleEvidenceObject.count({
        where: { evidenceFileId: created.evidenceId, objectKey: { not: null } },
      }),
    ).toBe(0);
    await Promise.all([
      expectObjectMissing(created.objectKey),
      expectObjectMissing(derivativeKey),
      expectObjectMissing(scanKey),
    ]);
  });

  it('recovers when the provider already deleted the object before the database commit', async () => {
    const created = await initializeObject();
    await makeUploadExpireDue(created.evidenceId);
    await handleAndComplete(expireHandler, created.evidenceId, AFTER_SALE_EVIDENCE_EXPIRE_EVENT);
    await storage.removeObject({
      deploymentEnvironment: 'test',
      evidenceId: created.evidenceId,
      objectKey: created.objectKey,
      objectRole: 'ORIGINAL',
      storeId,
    });
    await handleAndComplete(deleteHandler, created.evidenceId, AFTER_SALE_EVIDENCE_DELETE_EVENT);
    expect(
      await owner.afterSaleEvidenceFile.findUniqueOrThrow({ where: { id: created.evidenceId } }),
    ).toMatchObject({ status: 'DELETED' });
  });

  it('records a stable failure and resumes after a crash following retry-state advancement', async () => {
    const created = await initializeObject();
    await makeUploadExpireDue(created.evidenceId);
    await handleAndComplete(expireHandler, created.evidenceId, AFTER_SALE_EVIDENCE_EXPIRE_EVENT);
    const unavailableStorage = {
      removeObject: () =>
        Promise.reject(new AfterSaleEvidenceStorageError('UPSTREAM_UNAVAILABLE', true)),
    } as unknown as AfterSaleEvidenceObjectStorageProvider;
    const failingHandler = new AfterSaleEvidenceDeleteRequestedHandler(
      runtime,
      unavailableStorage,
      config,
    );
    await handleAndComplete(failingHandler, created.evidenceId, AFTER_SALE_EVIDENCE_DELETE_EVENT);
    expect(
      await owner.afterSaleEvidenceFile.findUniqueOrThrow({ where: { id: created.evidenceId } }),
    ).toMatchObject({
      deleteAttemptCount: 1,
      deleteErrorCode: 'EVIDENCE_DELETE_PROVIDER_UNAVAILABLE',
      status: 'DELETE_FAILED',
    });

    await makeDeleteRetryDue(created.evidenceId);
    const workerA = `m63-d4-retry-a-${randomUUID()}`;
    const retryMessage = await claimEvent(
      created.evidenceId,
      AFTER_SALE_EVIDENCE_DELETE_EVENT,
      workerA,
      { leaseDurationMs: 1_000 },
    );
    const loaded = await loadAfterSaleEvidenceDeletionWorkForLease(runtime, systemContext(), {
      outboxExpectedVersion: retryMessage.version,
      outboxMessageId: retryMessage.id,
      workerId: workerA,
    });
    expect(loaded).toMatchObject({ outcome: 'READY' });
    const workerB = `m63-d4-retry-b-${randomUUID()}`;
    const reclaimed = await claimEvent(
      created.evidenceId,
      AFTER_SALE_EVIDENCE_DELETE_EVENT,
      workerB,
      { now: new Date((retryMessage.leaseExpiresAt as Date).getTime() + 1) },
    );
    await deleteHandler.handle(reclaimed);
    await completeOutboxMessage(runtime, workerContext(), {
      expectedVersion: reclaimed.version,
      messageId: reclaimed.id,
      workerId: workerB,
    });
    expect(
      await owner.afterSaleEvidenceFile.findUniqueOrThrow({ where: { id: created.evidenceId } }),
    ).toMatchObject({ deleteAttemptCount: 1, status: 'DELETED' });
  });

  it('rejects cross-store loading and a stale worker after the delete lease is re-owned', async () => {
    const created = await initializeObject();
    await makeUploadExpireDue(created.evidenceId);
    await handleAndComplete(expireHandler, created.evidenceId, AFTER_SALE_EVIDENCE_EXPIRE_EVENT);
    const workerA = `m63-d4-lease-a-${randomUUID()}`;
    const messageA = await claimEvent(
      created.evidenceId,
      AFTER_SALE_EVIDENCE_DELETE_EVENT,
      workerA,
      { leaseDurationMs: 1_000 },
    );
    const leaseA = {
      outboxExpectedVersion: messageA.version,
      outboxMessageId: messageA.id,
      workerId: workerA,
    };
    await expect(
      loadAfterSaleEvidenceDeletionWorkForLease(
        runtime,
        createAfterSaleEvidenceSystemContext({
          correlationId: randomUUID(),
          storeId: randomUUID(),
        }),
        leaseA,
      ),
    ).rejects.toMatchObject({ code: 'OUTBOX_LEASE_LOST' });
    const loaded = await loadAfterSaleEvidenceDeletionWorkForLease(
      runtime,
      systemContext(),
      leaseA,
    );
    if (loaded.outcome !== 'READY') throw new Error('Expected delete work for worker A');
    const workerB = `m63-d4-lease-b-${randomUUID()}`;
    const messageB = await claimEvent(
      created.evidenceId,
      AFTER_SALE_EVIDENCE_DELETE_EVENT,
      workerB,
      { now: new Date((messageA.leaseExpiresAt as Date).getTime() + 1) },
    );
    await expect(
      applyAfterSaleEvidenceDeletionResultForLease(runtime, systemContext(), {
        deletionBaseDelayMs: DELETE_BASE_DELAY_MS,
        deletionMaxAttempts: DELETE_MAX_ATTEMPTS,
        deletionMaxDelayMs: DELETE_MAX_DELAY_MS,
        evidenceExpectedVersion: loaded.work.evidenceVersion,
        objects: loaded.work.objects.map(({ id, version }) => ({ expectedVersion: version, id })),
        ...leaseA,
        result: { outcome: 'SUCCESS' },
      }),
    ).rejects.toMatchObject({ code: 'OUTBOX_LEASE_LOST' });
    await deleteHandler.handle(messageB);
    await completeOutboxMessage(runtime, workerContext(), {
      expectedVersion: messageB.version,
      messageId: messageB.id,
      workerId: workerB,
    });
  });

  it('rejects a stale object snapshot and retries the same lease with the authoritative ledger', async () => {
    const created = await initializeObject();
    await makeUploadExpireDue(created.evidenceId);
    await handleAndComplete(expireHandler, created.evidenceId, AFTER_SALE_EVIDENCE_EXPIRE_EVENT);
    const workerId = `m63-d4-ledger-${randomUUID()}`;
    const message = await claimEvent(
      created.evidenceId,
      AFTER_SALE_EVIDENCE_DELETE_EVENT,
      workerId,
    );
    const lease = {
      outboxExpectedVersion: message.version,
      outboxMessageId: message.id,
      workerId,
    };
    const loaded = await loadAfterSaleEvidenceDeletionWorkForLease(runtime, systemContext(), lease);
    if (loaded.outcome !== 'READY') throw new Error('Expected initial delete work');
    const lateKey = await addLedgerObject(created.evidenceId, 'DERIVATIVE', 'late.webp');
    await expect(
      applyAfterSaleEvidenceDeletionResultForLease(runtime, systemContext(), {
        deletionBaseDelayMs: DELETE_BASE_DELAY_MS,
        deletionMaxAttempts: DELETE_MAX_ATTEMPTS,
        deletionMaxDelayMs: DELETE_MAX_DELAY_MS,
        evidenceExpectedVersion: loaded.work.evidenceVersion,
        objects: loaded.work.objects.map(({ id, version }) => ({ expectedVersion: version, id })),
        ...lease,
        result: { outcome: 'SUCCESS' },
      }),
    ).rejects.toMatchObject({ code: 'AFTER_SALE_EVIDENCE_STATE_CONFLICT' });
    await deleteHandler.handle(message);
    await completeOutboxMessage(runtime, workerContext(), {
      expectedVersion: message.version,
      messageId: message.id,
      workerId,
    });
    await expectObjectMissing(lateKey);
  });

  it('rejects a stale success after legal hold/version drift and reconciles an expire dead letter', async () => {
    const held = await initializeObject();
    await makeUploadExpireDue(held.evidenceId);
    await handleAndComplete(expireHandler, held.evidenceId, AFTER_SALE_EVIDENCE_EXPIRE_EVENT);
    const workerId = `m63-d4-held-${randomUUID()}`;
    const deleteMessage = await claimEvent(
      held.evidenceId,
      AFTER_SALE_EVIDENCE_DELETE_EVENT,
      workerId,
    );
    const loaded = await loadAfterSaleEvidenceDeletionWorkForLease(runtime, systemContext(), {
      outboxExpectedVersion: deleteMessage.version,
      outboxMessageId: deleteMessage.id,
      workerId,
    });
    if (loaded.outcome !== 'READY') throw new Error('Expected held deletion work');
    await withStoreTransaction(
      runtime,
      workerContext(),
      (transaction) =>
        transaction.$executeRaw`
        UPDATE after_sale_evidence_files
        SET legal_hold_active = true, held_at = pg_catalog.clock_timestamp(),
          held_by = ${adminId}::uuid, hold_reason = 'D4 lease regression',
          version = version + 1, updated_at = pg_catalog.clock_timestamp()
        WHERE store_id = ${storeId}::uuid AND id = ${held.evidenceId}::uuid
      `,
    );
    expect(
      await applyAfterSaleEvidenceDeletionResultForLease(runtime, systemContext(), {
        deletionBaseDelayMs: DELETE_BASE_DELAY_MS,
        deletionMaxAttempts: DELETE_MAX_ATTEMPTS,
        deletionMaxDelayMs: DELETE_MAX_DELAY_MS,
        evidenceExpectedVersion: loaded.work.evidenceVersion,
        objects: loaded.work.objects.map(({ id, version }) => ({ expectedVersion: version, id })),
        outboxExpectedVersion: deleteMessage.version,
        outboxMessageId: deleteMessage.id,
        result: { outcome: 'SUCCESS' },
        workerId,
      }),
    ).toMatchObject({ outcome: 'SUPERSEDED' });

    const dead = await initializeObject();
    await makeUploadExpireDue(dead.evidenceId);
    const deadWorker = `m63-d4-dead-${randomUUID()}`;
    const expireMessage = await claimEvent(
      dead.evidenceId,
      AFTER_SALE_EVIDENCE_EXPIRE_EVENT,
      deadWorker,
    );
    await failOutboxMessage(runtime, workerContext(), {
      disposition: 'PERMANENT',
      errorCode: 'EVIDENCE_TEST_PERMANENT',
      expectedVersion: expireMessage.version,
      messageId: expireMessage.id,
      workerId: deadWorker,
    });
    expect(
      await listAfterSaleEvidenceLifecycleDeadLetterCandidates(runtime, systemContext(), {
        batchSize: 25,
      }),
    ).toContainEqual({ messageId: expireMessage.id });
    expect(
      await reconcileAfterSaleEvidenceLifecycleDeadLetter(runtime, systemContext(), {
        deletionBaseDelayMs: DELETE_BASE_DELAY_MS,
        deletionMaxAttempts: DELETE_MAX_ATTEMPTS,
        deletionMaxDelayMs: DELETE_MAX_DELAY_MS,
        messageId: expireMessage.id,
      }),
    ).toMatchObject({ outcome: 'EXPIRE_DELETE_SCHEDULED' });
    await handleAndComplete(deleteHandler, dead.evidenceId, AFTER_SALE_EVIDENCE_DELETE_EVENT);
  });
});
