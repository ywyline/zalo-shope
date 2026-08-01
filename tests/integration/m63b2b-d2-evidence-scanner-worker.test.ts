import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type AddressInfo } from 'node:net';

import { config as loadEnvironment } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { parseRuntimeConfig } from '@zalo-shop/config';
import {
  AFTER_SALE_EVIDENCE_EXPIRE_EVENT,
  AFTER_SALE_EVIDENCE_SCAN_EVENT,
  applyAfterSaleEvidenceScanResultForLease,
  claimOutboxMessages,
  completeOutboxMessage,
  confirmAfterSaleEvidenceUpload,
  createRuntimePrismaClient,
  failOutboxMessage,
  initializeAfterSaleEvidenceUpload,
  listAfterSaleEvidenceScanDeadLetterCandidates,
  loadAfterSaleEvidenceScanWorkForLease,
  PrismaClient,
  reconcileAfterSaleEvidenceScanDeadLetter,
  ReliableMessagingError,
  requestAfterSaleEvidenceRescan,
  type OutboxMessageRecord,
  withStoreTransaction,
} from '@zalo-shop/database';
import { createAfterSaleEvidenceSystemContext, createStoreContext } from '@zalo-shop/domain';
import {
  ClamAvAfterSaleEvidenceScanner,
  createAfterSaleEvidenceStorageProvider,
  type AfterSaleEvidenceObjectDeclaration,
  type AfterSaleEvidenceScanner,
  type S3AfterSaleEvidenceStorageProvider,
} from '@zalo-shop/integrations';

import { AfterSaleEvidenceDeadLetterService } from '../../apps/worker/src/after-sales-evidence/after-sale-evidence-dead-letter.service';
import { AfterSaleEvidenceScanRequestedHandler } from '../../apps/worker/src/after-sales-evidence/after-sale-evidence-scan.handler';

const UPLOAD_TTL_SECONDS = 15 * 60;
const MAX_UNCLAIMED_FILES = 20;
const MAX_UNCLAIMED_BYTES = 200 * 1_024 * 1_024;

type StagedEvidence = Readonly<{
  declaration: AfterSaleEvidenceObjectDeclaration;
  evidenceId: string;
}>;

type FixtureStore = 'a' | 'b';

function fetchBody(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function cleanJpeg(): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]),
    Buffer.from('M6.3-B2b-D2 clean evidence', 'ascii'),
  ]);
}

function eicarJpeg(): Buffer {
  const testMarker = [
    'X5O!P%@AP',
    '[4\\PZX54(P^)',
    '7CC)7}$EICAR-',
    'STANDARD-ANTIVIRUS-',
    'TEST-FILE!$H+H*',
  ].join('');
  const jpegPrefix = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const filename = Buffer.from('evidence.txt', 'ascii');
  const payload = Buffer.from(testMarker, 'ascii');
  const crc = crc32(payload);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(payload.byteLength, 18);
  local.writeUInt32LE(payload.byteLength, 22);
  local.writeUInt16LE(filename.byteLength, 26);
  const centralOffset =
    jpegPrefix.byteLength + local.byteLength + filename.byteLength + payload.byteLength;
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(payload.byteLength, 20);
  central.writeUInt32LE(payload.byteLength, 24);
  central.writeUInt16LE(filename.byteLength, 28);
  central.writeUInt32LE(jpegPrefix.byteLength, 42);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.byteLength + filename.byteLength, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([jpegPrefix, local, filename, payload, central, filename, end]);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngBytes(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
}

async function unusedTcpPort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe.sequential('M6.3-B2b-D2 real evidence scanner worker', () => {
  loadEnvironment({ path: '.env.test.example', quiet: true, override: true });
  const config = parseRuntimeConfig();
  const ownerUrl = process.env.DATABASE_URL;
  if (!ownerUrl) throw new Error('M6.3-B2b-D2 owner database URL is required');

  const owner = new PrismaClient({ datasourceUrl: ownerUrl });
  const runtime = createRuntimePrismaClient(config.DATABASE_RUNTIME_URL);
  const suffix = randomUUID().slice(0, 8);
  const storeAId = randomUUID();
  const storeBId = randomUUID();
  const storeACode = `m63d2-a-${suffix}`;
  const storeBCode = `m63d2-b-${suffix}`;
  const adminId = randomUUID();
  const memberAId = randomUUID();
  const memberBId = randomUUID();
  const staged = new Map<string, AfterSaleEvidenceObjectDeclaration>();
  let storage: S3AfterSaleEvidenceStorageProvider;
  let scanner: ClamAvAfterSaleEvidenceScanner;
  let handler: AfterSaleEvidenceScanRequestedHandler;

  function memberContext(store: 'a' | 'b' = 'a') {
    return createStoreContext({
      actor: { id: store === 'a' ? memberAId : memberBId, type: 'member' },
      correlationId: randomUUID(),
      locale: 'vi',
      storeCode: store === 'a' ? storeACode : storeBCode,
      storeId: store === 'a' ? storeAId : storeBId,
    });
  }

  function workerContext(store: 'a' | 'b' = 'a') {
    return createStoreContext({
      actor: { id: adminId, type: 'admin' },
      correlationId: randomUUID(),
      locale: 'vi',
      storeCode: store === 'a' ? storeACode : storeBCode,
      storeId: store === 'a' ? storeAId : storeBId,
    });
  }

  function systemContext(store: 'a' | 'b' = 'a') {
    return createAfterSaleEvidenceSystemContext({
      correlationId: randomUUID(),
      storeId: store === 'a' ? storeAId : storeBId,
    });
  }

  async function stageEvidence(
    body: Uint8Array,
    mimeType: 'image/jpeg' | 'image/png' = 'image/jpeg',
    store: FixtureStore = 'a',
  ): Promise<StagedEvidence> {
    const storeId = store === 'a' ? storeAId : storeBId;
    const checksumSha256 = createHash('sha256').update(body).digest('hex');
    const initialized = await initializeAfterSaleEvidenceUpload(runtime, memberContext(store), {
      byteSize: body.byteLength,
      checksumSha256,
      deploymentEnvironment: 'test',
      filename: 'evidence.jpg',
      idempotencyKey: `m63-d2-init-${randomUUID()}`,
      maxUnclaimedBytes: MAX_UNCLAIMED_BYTES,
      maxUnclaimedFiles: MAX_UNCLAIMED_FILES,
      mimeType,
      uploadTtlSeconds: UPLOAD_TTL_SECONDS,
    });
    const declaration: AfterSaleEvidenceObjectDeclaration = {
      byteSize: body.byteLength,
      checksumSha256,
      deploymentEnvironment: 'test',
      evidenceId: initialized.evidence.id,
      mimeType,
      objectKey: initialized.objectKey,
      storeId,
    };
    staged.set(declaration.evidenceId, declaration);
    const target = await storage.createUploadTarget(declaration);
    const response = await fetch(target.url, {
      body: fetchBody(body),
      headers: target.headers,
      method: 'PUT',
    });
    expect(response.status).toBeLessThan(300);
    const confirmed = await confirmAfterSaleEvidenceUpload(runtime, memberContext(store), {
      evidenceId: initialized.evidence.id,
      expectedVersion: initialized.evidence.version,
      idempotencyKey: `m63-d2-confirm-${randomUUID()}`,
    });
    expect(confirmed.evidence).toMatchObject({ scanGeneration: 1, version: 2 });
    return { declaration, evidenceId: initialized.evidence.id };
  }

  async function claimScan(
    evidenceId: string,
    workerId: string,
    options: Readonly<{
      leaseDurationMs?: number;
      now?: Date;
      store?: FixtureStore;
    }> = {},
  ): Promise<OutboxMessageRecord> {
    const deadline = Date.now() + 1_000;
    while (true) {
      const messages = await claimOutboxMessages(runtime, workerContext(options.store), {
        batchSize: 1,
        leaseDurationMs: options.leaseDurationMs ?? config.OUTBOX_WORKER_LEASE_MS,
        ...(options.now ? { now: options.now } : {}),
        workerId,
      });
      const message = messages[0];
      if (message) {
        if (
          message.eventType !== AFTER_SALE_EVIDENCE_SCAN_EVENT ||
          message.aggregateId !== evidenceId
        ) {
          throw new Error(
            `Expected scan ${evidenceId}; received ${message.eventType} ${message.aggregateId}`,
          );
        }
        return message;
      }
      if (options.now || Date.now() >= deadline) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Expected scan ${evidenceId}; received none none`);
  }

  async function holdEvidenceRow(evidenceId: string): Promise<() => Promise<void>> {
    let acquired!: () => void;
    let release!: () => void;
    const acquiredPromise = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transaction = owner.$transaction(async (database) => {
      await database.$queryRaw`
        SELECT id
        FROM after_sale_evidence_files
        WHERE store_id = ${storeAId}::uuid AND id = ${evidenceId}::uuid
        FOR UPDATE
      `;
      acquired();
      await releasePromise;
    });
    await acquiredPromise;
    return async () => {
      release();
      await transaction;
    };
  }

  async function activateLegalHold(evidenceId: string): Promise<number> {
    return withStoreTransaction(runtime, workerContext(), async (transaction) => {
      const [held] = await transaction.$queryRaw<Array<{ version: number }>>`
        UPDATE after_sale_evidence_files
        SET legal_hold_active = true, held_at = pg_catalog.clock_timestamp(),
          held_by = ${adminId}::uuid, hold_reason = 'D2 scan concurrency regression',
          version = version + 1, updated_at = pg_catalog.clock_timestamp()
        WHERE store_id = ${storeAId}::uuid AND id = ${evidenceId}::uuid
          AND status = 'PENDING'::after_sale_evidence_status
          AND NOT legal_hold_active
        RETURNING version
      `;
      if (!held) throw new Error('Failed to activate the D2 evidence legal hold');
      return held.version;
    });
  }

  async function waitForOutboxRowLock(messageId: string): Promise<void> {
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      try {
        await owner.$transaction(async (database) => {
          await database.$queryRaw`
            SELECT id
            FROM outbox_messages
            WHERE id = ${messageId}::uuid
            FOR UPDATE NOWAIT
          `;
        });
      } catch (error) {
        if ((error as { meta?: { code?: unknown } }).meta?.code === '55P03') return;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Evidence scan transaction did not lock its outbox row');
  }

  async function waitUntilLeaseExpires(messageId: string): Promise<void> {
    const [row] = await owner.$queryRaw<
      Array<{ current_time: Date; lease_expires_at: Date | null }>
    >`
      SELECT pg_catalog.clock_timestamp() AS current_time, lease_expires_at
      FROM outbox_messages
      WHERE id = ${messageId}::uuid
    `;
    const remainingMs =
      row?.lease_expires_at instanceof Date
        ? Math.max(0, row.lease_expires_at.getTime() - row.current_time.getTime())
        : 0;
    await new Promise((resolve) => setTimeout(resolve, remainingMs + 100));
  }

  async function recoverExpiredScan(evidenceId: string): Promise<void> {
    const workerId = `m63-d2-lock-recovery-${randomUUID()}`;
    const message = await claimScan(evidenceId, workerId);
    await handler.handle(message);
    await completeOutboxMessage(runtime, workerContext(), {
      expectedVersion: message.version,
      messageId: message.id,
      workerId,
    });
  }

  async function handleAndComplete(
    activeHandler: AfterSaleEvidenceScanRequestedHandler,
    evidenceId: string,
    workerId = `m63-d2-worker-${randomUUID()}`,
    store: FixtureStore = 'a',
  ): Promise<OutboxMessageRecord> {
    const message = await claimScan(evidenceId, workerId, { store });
    await activeHandler.handle(message);
    await completeOutboxMessage(runtime, workerContext(store), {
      expectedVersion: message.version,
      messageId: message.id,
      workerId,
    });
    return message;
  }

  beforeAll(async () => {
    if (
      config.EVIDENCE_SCANNER_PROVIDER !== 'clamav' ||
      config.EVIDENCE_SCANNER_HOST === undefined ||
      config.EVIDENCE_SCANNER_SIGNATURE_MAX_AGE_SECONDS === undefined
    ) {
      throw new Error('M6.3-B2b-D2 scanner test configuration is incomplete');
    }
    const configuredStorage = createAfterSaleEvidenceStorageProvider(config);
    if (!configuredStorage) throw new Error('M6.3-B2b-D2 evidence storage is disabled');
    storage = configuredStorage;
    scanner = new ClamAvAfterSaleEvidenceScanner({
      host: config.EVIDENCE_SCANNER_HOST,
      port: config.EVIDENCE_SCANNER_PORT,
      responseLimitBytes: config.EVIDENCE_SCANNER_RESPONSE_LIMIT_BYTES,
      signatureMaxAgeMs: config.EVIDENCE_SCANNER_SIGNATURE_MAX_AGE_SECONDS * 1_000,
      timeoutMs: config.EVIDENCE_SCANNER_REQUEST_TIMEOUT_MS,
    });
    handler = new AfterSaleEvidenceScanRequestedHandler(runtime, storage, scanner, config);
    await owner.$transaction(async (transaction) => {
      await transaction.adminUser.create({
        data: {
          displayName: 'M6.3-B2b-D2 fixture administrator',
          email: `${adminId}@example.invalid`,
          emailNormalized: `${adminId}@example.invalid`,
          id: adminId,
          passwordHash: 'test-fixture-not-a-login-hash',
        },
      });
      await transaction.store.createMany({
        data: [
          { code: storeACode, id: storeAId, industry: 'BEAUTY' },
          { code: storeBCode, id: storeBId, industry: 'FASHION' },
        ],
      });
      await transaction.member.createMany({
        data: [
          { displayName: 'D2 evidence owner A', id: memberAId, storeId: storeAId },
          { displayName: 'D2 evidence owner B', id: memberBId, storeId: storeBId },
        ],
      });
    });
  });

  afterAll(async () => {
    if (storage) {
      for (const declaration of staged.values()) {
        await storage.removeObject(declaration).catch(() => undefined);
      }
      storage.destroy();
    }
    await owner.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        DELETE FROM after_sale_evidence_transitions
        WHERE store_id = ANY(ARRAY[${storeAId}::uuid, ${storeBId}::uuid])
      `;
      await transaction.$executeRaw`
        DELETE FROM after_sale_evidence_objects
        WHERE store_id = ANY(ARRAY[${storeAId}::uuid, ${storeBId}::uuid])
      `;
      await transaction.$executeRaw`
        DELETE FROM outbox_messages
        WHERE store_id = ANY(ARRAY[${storeAId}::uuid, ${storeBId}::uuid])
          AND aggregate_type = 'AFTER_SALE_EVIDENCE'
      `;
      await transaction.$executeRaw`
        DELETE FROM idempotency_records
        WHERE store_id = ANY(ARRAY[${storeAId}::uuid, ${storeBId}::uuid])
          AND operation LIKE 'after-sale-evidence-%'
      `;
      await transaction.$executeRaw`
        DELETE FROM after_sale_evidence_files
        WHERE store_id = ANY(ARRAY[${storeAId}::uuid, ${storeBId}::uuid])
      `;
      await transaction.$executeRaw`
        DELETE FROM members WHERE id = ANY(ARRAY[${memberAId}::uuid, ${memberBId}::uuid])
      `;
      await transaction.$executeRaw`
        DELETE FROM stores WHERE id = ANY(ARRAY[${storeAId}::uuid, ${storeBId}::uuid])
      `;
      await transaction.$executeRaw`DELETE FROM admin_users WHERE id = ${adminId}::uuid`;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });
    await Promise.all([owner.$disconnect(), runtime.$disconnect()]);
  });

  it('projects a real clean object and persists only stable ClamAV identity', async () => {
    const stagedEvidence = await stageEvidence(cleanJpeg());
    await handleAndComplete(handler, stagedEvidence.evidenceId);

    const evidence = await owner.afterSaleEvidenceFile.findUniqueOrThrow({
      where: { id: stagedEvidence.evidenceId },
    });
    expect(evidence).toMatchObject({
      scanResultCode: 'CLEAN',
      scannerEngine: 'clamav',
      status: 'READY_UNCLAIMED',
    });
    expect(evidence.scannerEngineVersion).toMatch(/^[A-Za-z0-9._:+-]+$/u);
    expect(evidence.scannerSignatureVersion).toMatch(/^[0-9]+$/u);
    expect(
      await owner.outboxMessage.count({
        where: {
          aggregateId: stagedEvidence.evidenceId,
          eventType: AFTER_SALE_EVIDENCE_EXPIRE_EVENT,
        },
      }),
    ).toBe(2);
  });

  it('quarantines a runtime-constructed EICAR object without persisting its signature name', async () => {
    const stagedEvidence = await stageEvidence(eicarJpeg());
    await handleAndComplete(handler, stagedEvidence.evidenceId);

    const evidence = await owner.afterSaleEvidenceFile.findUniqueOrThrow({
      where: { id: stagedEvidence.evidenceId },
    });
    expect(evidence).toMatchObject({
      scanResultCode: 'MALWARE_DETECTED',
      scannerEngine: 'clamav',
      status: 'QUARANTINED',
    });
    const persisted = JSON.stringify({
      result: evidence.scanResultCode,
      scannerEngine: evidence.scannerEngine,
      scannerEngineVersion: evidence.scannerEngineVersion,
      scannerSignatureVersion: evidence.scannerSignatureVersion,
    });
    expect(persisted).not.toMatch(/eicar|signature-name/iu);
  });

  it('fails closed when real bytes do not match the declared allowed MIME', async () => {
    const stagedEvidence = await stageEvidence(pngBytes(), 'image/jpeg');
    await handleAndComplete(handler, stagedEvidence.evidenceId);

    const evidence = await owner.afterSaleEvidenceFile.findUniqueOrThrow({
      where: { id: stagedEvidence.evidenceId },
    });
    expect(evidence).toMatchObject({
      scanResultCode: 'OBJECT_VALIDATION_FAILED',
      scannerEngine: null,
      status: 'FAILED',
    });
  });

  it('rejects a stale lease after another worker reclaims the message', async () => {
    const stagedEvidence = await stageEvidence(cleanJpeg());
    const workerA = `m63-d2-a-${randomUUID()}`;
    const messageA = await claimScan(stagedEvidence.evidenceId, workerA, {
      leaseDurationMs: 1_000,
    });
    const leaseA = {
      outboxExpectedVersion: messageA.version,
      outboxMessageId: messageA.id,
      workerId: workerA,
    };
    const loaded = await loadAfterSaleEvidenceScanWorkForLease(runtime, systemContext(), leaseA);
    expect(loaded.outcome).toBe('READY');
    const workerB = `m63-d2-b-${randomUUID()}`;
    const messageB = await claimScan(stagedEvidence.evidenceId, workerB, {
      now: new Date((messageA.leaseExpiresAt as Date).getTime() + 1),
    });
    expect(messageB.id).toBe(messageA.id);

    await expect(
      applyAfterSaleEvidenceScanResultForLease(runtime, systemContext(), {
        ...leaseA,
        claimTtlSeconds: config.AFTER_SALE_EVIDENCE_CLAIM_TTL_SECONDS as number,
        failedRetentionSeconds: config.AFTER_SALE_EVIDENCE_FAILED_RETENTION_SECONDS as number,
        result: {
          engine: 'clamav',
          engineVersion: '1.5.3',
          signatureVersion: '27790',
          verdict: 'CLEAN',
        },
        scanGeneration: 1,
      }),
    ).rejects.toMatchObject({ code: 'OUTBOX_LEASE_LOST' });
    expect(
      await owner.afterSaleEvidenceFile.findUniqueOrThrow({
        where: { id: stagedEvidence.evidenceId },
      }),
    ).toMatchObject({ status: 'PENDING', version: 2 });
    await handler.handle(messageB);
    await completeOutboxMessage(runtime, workerContext(), {
      expectedVersion: messageB.version,
      messageId: messageB.id,
      workerId: workerB,
    });
  });

  it('uses database wall clock and rejects a lease exactly at its deadline', async () => {
    const stagedEvidence = await stageEvidence(cleanJpeg());
    const workerId = `m63-d2-equal-${randomUUID()}`;
    const message = await claimScan(stagedEvidence.evidenceId, workerId);
    await owner.$executeRaw`
      UPDATE outbox_messages
      SET lease_expires_at = pg_catalog.clock_timestamp(), updated_at = pg_catalog.clock_timestamp()
      WHERE id = ${message.id}::uuid
    `;
    await expect(
      loadAfterSaleEvidenceScanWorkForLease(runtime, systemContext(), {
        outboxExpectedVersion: message.version,
        outboxMessageId: message.id,
        workerId,
      }),
    ).rejects.toBeInstanceOf(ReliableMessagingError);
    const recoveryWorkerId = `m63-d2-equal-recovery-${randomUUID()}`;
    const expired = await owner.outboxMessage.findUniqueOrThrow({
      select: { leaseExpiresAt: true },
      where: { id: message.id },
    });
    if (!expired.leaseExpiresAt) throw new Error('Expected the expired evidence scan lease');
    const recovered = await claimScan(stagedEvidence.evidenceId, recoveryWorkerId, {
      now: new Date(expired.leaseExpiresAt.getTime() + 1),
    });
    await handler.handle(recovered);
    await completeOutboxMessage(runtime, workerContext(), {
      expectedVersion: recovered.version,
      messageId: recovered.id,
      workerId: recoveryWorkerId,
    });
  });

  it('rechecks the lease after loader evidence-lock wait crosses its deadline', async () => {
    const stagedEvidence = await stageEvidence(cleanJpeg());
    const workerId = `m63-d2-loader-lock-${randomUUID()}`;
    const message = await claimScan(stagedEvidence.evidenceId, workerId);
    await owner.$executeRaw`
      UPDATE outbox_messages
      SET lease_expires_at = pg_catalog.clock_timestamp() + interval '1500 milliseconds',
        updated_at = pg_catalog.clock_timestamp()
      WHERE id = ${message.id}::uuid
    `;
    const releaseEvidence = await holdEvidenceRow(stagedEvidence.evidenceId);
    const loading = loadAfterSaleEvidenceScanWorkForLease(runtime, systemContext(), {
      outboxExpectedVersion: message.version,
      outboxMessageId: message.id,
      workerId,
    });
    await waitForOutboxRowLock(message.id);
    await waitUntilLeaseExpires(message.id);
    await releaseEvidence();

    await expect(loading).rejects.toMatchObject({ code: 'OUTBOX_LEASE_LOST' });
    await recoverExpiredScan(stagedEvidence.evidenceId);
  });

  it('rechecks the lease before result projection after an evidence-lock wait', async () => {
    const stagedEvidence = await stageEvidence(cleanJpeg());
    const workerId = `m63-d2-result-lock-${randomUUID()}`;
    const message = await claimScan(stagedEvidence.evidenceId, workerId);
    await owner.$executeRaw`
      UPDATE outbox_messages
      SET lease_expires_at = pg_catalog.clock_timestamp() + interval '1500 milliseconds',
        updated_at = pg_catalog.clock_timestamp()
      WHERE id = ${message.id}::uuid
    `;
    const releaseEvidence = await holdEvidenceRow(stagedEvidence.evidenceId);
    const applying = applyAfterSaleEvidenceScanResultForLease(runtime, systemContext(), {
      claimTtlSeconds: config.AFTER_SALE_EVIDENCE_CLAIM_TTL_SECONDS as number,
      failedRetentionSeconds: config.AFTER_SALE_EVIDENCE_FAILED_RETENTION_SECONDS as number,
      outboxExpectedVersion: message.version,
      outboxMessageId: message.id,
      result: {
        engine: 'clamav',
        engineVersion: '1.5.3',
        signatureVersion: '27790',
        verdict: 'CLEAN',
      },
      scanGeneration: 1,
      workerId,
    });
    await waitForOutboxRowLock(message.id);
    await waitUntilLeaseExpires(message.id);
    await releaseEvidence();

    await expect(applying).rejects.toMatchObject({ code: 'OUTBOX_LEASE_LOST' });
    expect(
      await owner.afterSaleEvidenceFile.findUniqueOrThrow({
        where: { id: stagedEvidence.evidenceId },
      }),
    ).toMatchObject({ scanResultCode: null, status: 'PENDING', version: 2 });
    await recoverExpiredScan(stagedEvidence.evidenceId);
  });

  it('rejects wrong lease owner, version and completed message state', async () => {
    const stagedEvidence = await stageEvidence(cleanJpeg());
    const workerId = `m63-d2-lease-${randomUUID()}`;
    const message = await claimScan(stagedEvidence.evidenceId, workerId);
    const baseLease = {
      outboxExpectedVersion: message.version,
      outboxMessageId: message.id,
      workerId,
    };
    await expect(
      loadAfterSaleEvidenceScanWorkForLease(runtime, systemContext(), {
        ...baseLease,
        workerId: `${workerId}-wrong`,
      }),
    ).rejects.toMatchObject({ code: 'OUTBOX_LEASE_LOST' });
    await expect(
      loadAfterSaleEvidenceScanWorkForLease(runtime, systemContext(), {
        ...baseLease,
        outboxExpectedVersion: message.version + 1,
      }),
    ).rejects.toMatchObject({ code: 'OUTBOX_LEASE_LOST' });

    await handler.handle(message);
    await completeOutboxMessage(runtime, workerContext(), {
      expectedVersion: message.version,
      messageId: message.id,
      workerId,
    });
    await expect(
      loadAfterSaleEvidenceScanWorkForLease(runtime, systemContext(), baseLease),
    ).rejects.toMatchObject({ code: 'OUTBOX_LEASE_LOST' });
  });

  it('recovers a crash after projection without duplicating transition or expiry', async () => {
    const stagedEvidence = await stageEvidence(cleanJpeg());
    const workerA = `m63-d2-crash-a-${randomUUID()}`;
    const messageA = await claimScan(stagedEvidence.evidenceId, workerA);
    await handler.handle(messageA);

    await owner.$executeRaw`
      UPDATE outbox_messages
      SET lease_expires_at = pg_catalog.clock_timestamp() - interval '1 second',
        updated_at = pg_catalog.clock_timestamp()
      WHERE id = ${messageA.id}::uuid
    `;
    const workerB = `m63-d2-crash-b-${randomUUID()}`;
    const messageB = await claimScan(stagedEvidence.evidenceId, workerB);
    const scanSpy = vi.spyOn(scanner, 'scan');
    await handler.handle(messageB);
    expect(scanSpy).not.toHaveBeenCalled();
    scanSpy.mockRestore();
    await completeOutboxMessage(runtime, workerContext(), {
      expectedVersion: messageB.version,
      messageId: messageB.id,
      workerId: workerB,
    });

    const [transitionCount] = await owner.$queryRaw<Array<{ count: bigint }>>`
      SELECT pg_catalog.count(*)::bigint AS count
      FROM after_sale_evidence_transitions
      WHERE store_id = ${storeAId}::uuid
        AND evidence_file_id = ${stagedEvidence.evidenceId}::uuid
        AND event = 'SCAN_PASSED'
    `;
    expect(transitionCount?.count).toBe(1n);
    expect(
      await owner.outboxMessage.count({
        where: {
          aggregateId: stagedEvidence.evidenceId,
          eventType: AFTER_SALE_EVIDENCE_EXPIRE_EVENT,
        },
      }),
    ).toBe(2);
  });

  it('requeues the authoritative pending version when legal hold changes before loading', async () => {
    const stagedEvidence = await stageEvidence(cleanJpeg());
    const workerId = `m63-d2-hold-before-load-${randomUUID()}`;
    const message = await claimScan(stagedEvidence.evidenceId, workerId);
    expect(await activateLegalHold(stagedEvidence.evidenceId)).toBe(3);

    const scanSpy = vi.spyOn(scanner, 'scan');
    await handler.handle(message);
    expect(scanSpy).not.toHaveBeenCalled();
    scanSpy.mockRestore();
    await completeOutboxMessage(runtime, workerContext(), {
      expectedVersion: message.version,
      messageId: message.id,
      workerId,
    });

    expect(
      await owner.afterSaleEvidenceFile.findUniqueOrThrow({
        where: { id: stagedEvidence.evidenceId },
      }),
    ).toMatchObject({
      legalHoldActive: true,
      scanGeneration: 2,
      status: 'PENDING',
      version: 4,
    });
    expect(
      await owner.outboxMessage.findMany({
        orderBy: { createdAt: 'asc' },
        select: { payload: true, status: true },
        where: {
          aggregateId: stagedEvidence.evidenceId,
          eventType: AFTER_SALE_EVIDENCE_SCAN_EVENT,
        },
      }),
    ).toEqual([
      {
        payload: {
          evidence_id: stagedEvidence.evidenceId,
          expected_version: 2,
          store_id: storeAId,
        },
        status: 'COMPLETED',
      },
      {
        payload: {
          evidence_id: stagedEvidence.evidenceId,
          expected_version: 4,
          store_id: storeAId,
        },
        status: 'PENDING',
      },
    ]);

    await handleAndComplete(handler, stagedEvidence.evidenceId);
    expect(
      await owner.afterSaleEvidenceFile.findUniqueOrThrow({
        where: { id: stagedEvidence.evidenceId },
      }),
    ).toMatchObject({ scanResultCode: 'CLEAN', status: 'READY_UNCLAIMED' });
  });

  it('requeues the authoritative pending version when legal hold changes before projection', async () => {
    const stagedEvidence = await stageEvidence(cleanJpeg());
    const scannerWithConcurrentHold: AfterSaleEvidenceScanner = {
      scan: async (input) => {
        const result = await scanner.scan(input);
        expect(await activateLegalHold(stagedEvidence.evidenceId)).toBe(3);
        return result;
      },
    };
    const concurrentHandler = new AfterSaleEvidenceScanRequestedHandler(
      runtime,
      storage,
      scannerWithConcurrentHold,
      config,
    );
    const workerId = `m63-d2-hold-before-result-${randomUUID()}`;
    const message = await handleAndComplete(concurrentHandler, stagedEvidence.evidenceId, workerId);

    expect(
      await owner.afterSaleEvidenceFile.findUniqueOrThrow({
        where: { id: stagedEvidence.evidenceId },
      }),
    ).toMatchObject({
      legalHoldActive: true,
      scanGeneration: 2,
      status: 'PENDING',
      version: 4,
    });
    expect(
      await owner.outboxMessage.findMany({
        orderBy: { createdAt: 'asc' },
        select: { payload: true, status: true },
        where: {
          aggregateId: stagedEvidence.evidenceId,
          eventType: AFTER_SALE_EVIDENCE_SCAN_EVENT,
        },
      }),
    ).toEqual([
      {
        payload: {
          evidence_id: stagedEvidence.evidenceId,
          expected_version: 2,
          store_id: storeAId,
        },
        status: 'COMPLETED',
      },
      {
        payload: {
          evidence_id: stagedEvidence.evidenceId,
          expected_version: 4,
          store_id: storeAId,
        },
        status: 'PENDING',
      },
    ]);
    expect(message.aggregateId).toBe(stagedEvidence.evidenceId);

    await handleAndComplete(handler, stagedEvidence.evidenceId);
    expect(
      await owner.afterSaleEvidenceFile.findUniqueOrThrow({
        where: { id: stagedEvidence.evidenceId },
      }),
    ).toMatchObject({ scanResultCode: 'CLEAN', status: 'READY_UNCLAIMED' });
  });

  it('projects scanner unavailability only on the final bounded attempt', async () => {
    const stagedEvidence = await stageEvidence(cleanJpeg());
    const prepared = await owner.$executeRaw`
      UPDATE outbox_messages
      SET attempt_count = max_attempts - 1, updated_at = pg_catalog.clock_timestamp()
      WHERE store_id = ${storeAId}::uuid
        AND aggregate_id = ${stagedEvidence.evidenceId}::uuid
        AND event_type = ${AFTER_SALE_EVIDENCE_SCAN_EVENT}
        AND status = 'PENDING'::outbox_status
    `;
    expect(prepared).toBe(1);
    const unavailableScanner = new ClamAvAfterSaleEvidenceScanner({
      host: '127.0.0.1',
      port: await unusedTcpPort(),
      responseLimitBytes: config.EVIDENCE_SCANNER_RESPONSE_LIMIT_BYTES,
      signatureMaxAgeMs: 60_000,
      timeoutMs: 500,
    });
    const unavailableHandler = new AfterSaleEvidenceScanRequestedHandler(
      runtime,
      storage,
      unavailableScanner,
      config,
    );
    const workerId = `m63-d2-unavailable-${randomUUID()}`;
    const message = await claimScan(stagedEvidence.evidenceId, workerId);
    expect(message.attemptCount).toBe(message.maxAttempts);
    await unavailableHandler.handle(message);
    await completeOutboxMessage(runtime, workerContext(), {
      expectedVersion: message.version,
      messageId: message.id,
      workerId,
    });

    expect(
      await owner.afterSaleEvidenceFile.findUniqueOrThrow({
        where: { id: stagedEvidence.evidenceId },
      }),
    ).toMatchObject({
      scanResultCode: 'SCANNER_UNAVAILABLE',
      status: 'FAILED',
    });
  });

  it('keeps a non-final unavailable attempt pending and later recovers', async () => {
    const stagedEvidence = await stageEvidence(cleanJpeg());
    const unavailableScanner = new ClamAvAfterSaleEvidenceScanner({
      host: '127.0.0.1',
      port: await unusedTcpPort(),
      responseLimitBytes: config.EVIDENCE_SCANNER_RESPONSE_LIMIT_BYTES,
      signatureMaxAgeMs: 60_000,
      timeoutMs: 500,
    });
    const unavailableHandler = new AfterSaleEvidenceScanRequestedHandler(
      runtime,
      storage,
      unavailableScanner,
      config,
    );
    const workerA = `m63-d2-retry-a-${randomUUID()}`;
    const messageA = await claimScan(stagedEvidence.evidenceId, workerA);
    await expect(unavailableHandler.handle(messageA)).rejects.toMatchObject({
      code: 'SCANNER_UNAVAILABLE',
      disposition: 'RETRYABLE',
    });
    const pending = await failOutboxMessage(runtime, workerContext(), {
      disposition: 'RETRYABLE',
      errorCode: 'SCANNER_UNAVAILABLE',
      expectedVersion: messageA.version,
      messageId: messageA.id,
      randomValue: 0,
      workerId: workerA,
    });
    expect(pending.status).toBe('PENDING');
    expect(
      await owner.afterSaleEvidenceFile.findUniqueOrThrow({
        where: { id: stagedEvidence.evidenceId },
      }),
    ).toMatchObject({ scanResultCode: null, status: 'PENDING' });

    const workerB = `m63-d2-retry-b-${randomUUID()}`;
    const messageB = await claimScan(stagedEvidence.evidenceId, workerB, {
      now: pending.availableAt,
    });
    await handler.handle(messageB);
    await completeOutboxMessage(runtime, workerContext(), {
      expectedVersion: messageB.version,
      messageId: messageB.id,
      workerId: workerB,
    });
    expect(
      await owner.afterSaleEvidenceFile.findUniqueOrThrow({
        where: { id: stagedEvidence.evidenceId },
      }),
    ).toMatchObject({ scanResultCode: 'CLEAN', status: 'READY_UNCLAIMED' });
  });

  it('persistently reconciles an exhausted scan dead letter and removes it from candidates', async () => {
    const stagedEvidence = await stageEvidence(cleanJpeg());
    const workerId = `m63-d2-dead-${randomUUID()}`;
    const message = await claimScan(stagedEvidence.evidenceId, workerId);
    await failOutboxMessage(runtime, workerContext(), {
      disposition: 'PERMANENT',
      errorCode: 'EVIDENCE_TEST_PERMANENT',
      expectedVersion: message.version,
      messageId: message.id,
      workerId,
    });
    expect(
      await listAfterSaleEvidenceScanDeadLetterCandidates(runtime, systemContext(), {
        batchSize: 25,
      }),
    ).toContainEqual({ messageId: message.id });

    const service = new AfterSaleEvidenceDeadLetterService(runtime, config);
    await service.runOnce();
    expect(
      await owner.afterSaleEvidenceFile.findUniqueOrThrow({
        where: { id: stagedEvidence.evidenceId },
      }),
    ).toMatchObject({
      scanResultCode: 'SCAN_OUTBOX_DEAD_LETTER',
      status: 'FAILED',
    });
    expect(
      await listAfterSaleEvidenceScanDeadLetterCandidates(runtime, systemContext(), {
        batchSize: 25,
      }),
    ).not.toContainEqual({ messageId: message.id });
  });

  it('reconciles a dead letter produced by expired-lease attempt exhaustion', async () => {
    const stagedEvidence = await stageEvidence(cleanJpeg());
    const workerA = `m63-d2-exhaust-a-${randomUUID()}`;
    const message = await claimScan(stagedEvidence.evidenceId, workerA);
    await owner.$executeRaw`
      UPDATE outbox_messages
      SET attempt_count = max_attempts,
        lease_expires_at = pg_catalog.clock_timestamp() - interval '1 second',
        updated_at = pg_catalog.clock_timestamp()
      WHERE id = ${message.id}::uuid
    `;
    const reclaimed = await claimOutboxMessages(runtime, workerContext(), {
      batchSize: 1,
      leaseDurationMs: config.OUTBOX_WORKER_LEASE_MS,
      workerId: `m63-d2-exhaust-b-${randomUUID()}`,
    });
    expect(reclaimed).toEqual([]);
    expect(
      await owner.outboxMessage.findUniqueOrThrow({ where: { id: message.id } }),
    ).toMatchObject({
      lastErrorCode: 'RETRY_EXHAUSTED_LEASE_EXPIRED',
      status: 'DEAD_LETTER',
    });

    const service = new AfterSaleEvidenceDeadLetterService(runtime, config);
    await service.runOnce();
    expect(
      await owner.afterSaleEvidenceFile.findUniqueOrThrow({
        where: { id: stagedEvidence.evidenceId },
      }),
    ).toMatchObject({
      scanResultCode: 'SCAN_OUTBOX_DEAD_LETTER',
      status: 'FAILED',
    });
  });

  it('does not let an old scan dead letter overwrite a newer generation', async () => {
    const stagedEvidence = await stageEvidence(cleanJpeg());
    const workerId = `m63-d2-old-dead-letter-${randomUUID()}`;
    const oldMessage = await claimScan(stagedEvidence.evidenceId, workerId);
    await failOutboxMessage(runtime, workerContext(), {
      disposition: 'PERMANENT',
      errorCode: 'EVIDENCE_TEST_OLD_GENERATION',
      expectedVersion: oldMessage.version,
      messageId: oldMessage.id,
      workerId,
    });
    const rescan = await requestAfterSaleEvidenceRescan(runtime, systemContext(), {
      evidenceId: stagedEvidence.evidenceId,
      expectedVersion: 2,
    });
    expect(rescan).toMatchObject({
      evidence: { scanGeneration: 2, status: 'PENDING', version: 3 },
      requested: true,
    });
    expect(
      await listAfterSaleEvidenceScanDeadLetterCandidates(runtime, systemContext(), {
        batchSize: 25,
      }),
    ).not.toContainEqual({ messageId: oldMessage.id });

    const service = new AfterSaleEvidenceDeadLetterService(runtime, config);
    await service.runOnce();
    expect(
      await owner.afterSaleEvidenceFile.findUniqueOrThrow({
        where: { id: stagedEvidence.evidenceId },
      }),
    ).toMatchObject({ scanGeneration: 2, scanResultCode: null, status: 'PENDING', version: 3 });

    await handleAndComplete(handler, stagedEvidence.evidenceId);
    expect(
      await owner.afterSaleEvidenceFile.findUniqueOrThrow({
        where: { id: stagedEvidence.evidenceId },
      }),
    ).toMatchObject({ scanGeneration: 2, scanResultCode: 'CLEAN', status: 'READY_UNCLAIMED' });
  });

  it('does not let an old scan dead letter overwrite a held newer generation', async () => {
    const stagedEvidence = await stageEvidence(cleanJpeg());
    const workerId = `m63-d2-held-old-dead-letter-${randomUUID()}`;
    const oldMessage = await claimScan(stagedEvidence.evidenceId, workerId);
    await failOutboxMessage(runtime, workerContext(), {
      disposition: 'PERMANENT',
      errorCode: 'EVIDENCE_TEST_HELD_OLD_GENERATION',
      expectedVersion: oldMessage.version,
      messageId: oldMessage.id,
      workerId,
    });
    const rescan = await requestAfterSaleEvidenceRescan(runtime, systemContext(), {
      evidenceId: stagedEvidence.evidenceId,
      expectedVersion: 2,
    });
    expect(rescan).toMatchObject({
      evidence: { scanGeneration: 2, status: 'PENDING', version: 3 },
      requested: true,
    });
    expect(await activateLegalHold(stagedEvidence.evidenceId)).toBe(4);

    expect(
      await listAfterSaleEvidenceScanDeadLetterCandidates(runtime, systemContext(), {
        batchSize: 25,
      }),
    ).not.toContainEqual({ messageId: oldMessage.id });
    await expect(
      reconcileAfterSaleEvidenceScanDeadLetter(runtime, systemContext(), {
        messageId: oldMessage.id,
        scanFailedRetentionSeconds: config.AFTER_SALE_EVIDENCE_FAILED_RETENTION_SECONDS,
      }),
    ).resolves.toMatchObject({ outcome: 'SUPERSEDED' });
    expect(
      await owner.afterSaleEvidenceFile.findUniqueOrThrow({
        where: { id: stagedEvidence.evidenceId },
      }),
    ).toMatchObject({ scanGeneration: 2, scanResultCode: null, status: 'PENDING', version: 4 });

    await handleAndComplete(handler, stagedEvidence.evidenceId);
    expect(
      await owner.afterSaleEvidenceFile.findUniqueOrThrow({
        where: { id: stagedEvidence.evidenceId },
      }),
    ).toMatchObject({ scanGeneration: 3, scanResultCode: null, status: 'PENDING', version: 5 });
    await handleAndComplete(handler, stagedEvidence.evidenceId);
    expect(
      await owner.afterSaleEvidenceFile.findUniqueOrThrow({
        where: { id: stagedEvidence.evidenceId },
      }),
    ).toMatchObject({ scanGeneration: 3, scanResultCode: 'CLEAN', status: 'READY_UNCLAIMED' });
  });

  it('reconciles only the latest dead scan generation after legal hold version drift', async () => {
    const stagedEvidence = await stageEvidence(cleanJpeg());
    const oldWorkerId = `m63-d2-held-old-dead-${randomUUID()}`;
    const oldMessage = await claimScan(stagedEvidence.evidenceId, oldWorkerId);
    await failOutboxMessage(runtime, workerContext(), {
      disposition: 'PERMANENT',
      errorCode: 'EVIDENCE_TEST_OLDER_DEAD_GENERATION',
      expectedVersion: oldMessage.version,
      messageId: oldMessage.id,
      workerId: oldWorkerId,
    });
    await requestAfterSaleEvidenceRescan(runtime, systemContext(), {
      evidenceId: stagedEvidence.evidenceId,
      expectedVersion: 2,
    });
    const newerWorkerId = `m63-d2-held-newer-dead-${randomUUID()}`;
    const newerMessage = await claimScan(stagedEvidence.evidenceId, newerWorkerId);
    await failOutboxMessage(runtime, workerContext(), {
      disposition: 'PERMANENT',
      errorCode: 'EVIDENCE_TEST_NEWER_DEAD_GENERATION',
      expectedVersion: newerMessage.version,
      messageId: newerMessage.id,
      workerId: newerWorkerId,
    });
    expect(await activateLegalHold(stagedEvidence.evidenceId)).toBe(4);

    const candidates = await listAfterSaleEvidenceScanDeadLetterCandidates(
      runtime,
      systemContext(),
      { batchSize: 25 },
    );
    expect(candidates).not.toContainEqual({ messageId: oldMessage.id });
    expect(candidates).toContainEqual({ messageId: newerMessage.id });
    await expect(
      reconcileAfterSaleEvidenceScanDeadLetter(runtime, systemContext(), {
        messageId: oldMessage.id,
        scanFailedRetentionSeconds: config.AFTER_SALE_EVIDENCE_FAILED_RETENTION_SECONDS,
      }),
    ).resolves.toMatchObject({ outcome: 'SUPERSEDED' });
    await expect(
      reconcileAfterSaleEvidenceScanDeadLetter(runtime, systemContext(), {
        messageId: newerMessage.id,
        scanFailedRetentionSeconds: config.AFTER_SALE_EVIDENCE_FAILED_RETENTION_SECONDS,
      }),
    ).resolves.toMatchObject({ outcome: 'SCAN_FAILED' });
    expect(
      await owner.afterSaleEvidenceFile.findUniqueOrThrow({
        where: { id: stagedEvidence.evidenceId },
      }),
    ).toMatchObject({
      scanGeneration: 2,
      scanResultCode: 'SCAN_OUTBOX_DEAD_LETTER',
      status: 'FAILED',
      version: 5,
    });
  });

  it('processes real store B evidence only through the matching SYSTEM scope', async () => {
    const stagedEvidence = await stageEvidence(cleanJpeg(), 'image/jpeg', 'b');
    const workerId = `m63-d2-store-b-${randomUUID()}`;
    const message = await claimScan(stagedEvidence.evidenceId, workerId, { store: 'b' });
    const lease = {
      outboxExpectedVersion: message.version,
      outboxMessageId: message.id,
      workerId,
    };
    await expect(
      loadAfterSaleEvidenceScanWorkForLease(runtime, systemContext('a'), lease),
    ).rejects.toMatchObject({ code: 'OUTBOX_LEASE_LOST' });

    await handler.handle(message);
    await completeOutboxMessage(runtime, workerContext('b'), {
      expectedVersion: message.version,
      messageId: message.id,
      workerId,
    });
    expect(
      await owner.afterSaleEvidenceFile.findUniqueOrThrow({
        where: { id: stagedEvidence.evidenceId },
      }),
    ).toMatchObject({
      scanResultCode: 'CLEAN',
      status: 'READY_UNCLAIMED',
      storeId: storeBId,
    });
    expect(stagedEvidence.declaration.objectKey).toContain(`/${storeBId}/`);
  });

  it('rejects a forged cross-store message before any scanner call', async () => {
    const stagedEvidence = await stageEvidence(cleanJpeg());
    const workerId = `m63-d2-cross-${randomUUID()}`;
    const message = await claimScan(stagedEvidence.evidenceId, workerId);
    const scanSpy = vi.spyOn(scanner, 'scan');
    const forged: OutboxMessageRecord = {
      ...message,
      payload: {
        evidence_id: message.aggregateId,
        expected_version: 2,
        store_id: storeBId,
      },
      storeId: storeBId,
    };
    await expect(handler.handle(forged)).rejects.toMatchObject({ code: 'OUTBOX_LEASE_LOST' });
    expect(scanSpy).not.toHaveBeenCalled();
    scanSpy.mockRestore();
  });
});
