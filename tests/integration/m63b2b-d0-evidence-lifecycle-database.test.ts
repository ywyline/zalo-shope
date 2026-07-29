import { createHash, randomUUID } from 'node:crypto';

import { config as loadEnvironment } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AFTER_SALE_EVIDENCE_AGGREGATE_TYPE,
  AFTER_SALE_EVIDENCE_DELETE_EVENT,
  AFTER_SALE_EVIDENCE_EXPIRE_EVENT,
  AFTER_SALE_EVIDENCE_SCAN_EVENT,
  AfterSaleEvidenceLifecycleError,
  applyAfterSaleEvidenceScanResult,
  appendOutboxMessageInTransaction,
  beginAfterSaleEvidenceDeletion,
  claimAfterSaleEvidenceInTransaction,
  completeAfterSaleEvidenceDeletion,
  confirmAfterSaleEvidenceUpload,
  createRuntimePrismaClient,
  failOutboxMessage,
  initializeAfterSaleEvidenceUpload,
  listAfterSaleEvidenceDeletionObjects,
  PrismaClient,
  reconcileAfterSaleEvidenceDeadLetter,
  recordAfterSaleEvidenceDeletionFailure,
  requestAfterSaleEvidenceRescan,
  withAfterSaleEvidenceSystemTransaction,
  withStoreTransaction,
} from '@zalo-shop/database';
import {
  createAfterSaleEvidenceSystemContext,
  createStoreContext,
  type StoreContext,
} from '@zalo-shop/domain';

const UPLOAD_TTL_SECONDS = 15 * 60;
const CLAIM_TTL_SECONDS = 24 * 60 * 60;
const FAILED_RETENTION_SECONDS = 24 * 60 * 60;
const MAX_UNCLAIMED_FILES = 12;
const MAX_UNCLAIMED_BYTES = 200 * 1_024 * 1_024;
const DELETE_BASE_DELAY_MS = 60_000;
const DELETE_MAX_DELAY_MS = 6 * 60 * 60 * 1_000;
const DELETE_MAX_ATTEMPTS = 8;

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

type EvidenceEventType =
  | typeof AFTER_SALE_EVIDENCE_DELETE_EVENT
  | typeof AFTER_SALE_EVIDENCE_EXPIRE_EVENT
  | typeof AFTER_SALE_EVIDENCE_SCAN_EVENT;

type OutboxRow = {
  available_at: Date;
  event_type: string;
  id: string;
  payload: unknown;
  status: 'COMPLETED' | 'DEAD_LETTER' | 'PENDING' | 'PROCESSING';
  version: number;
};

describe.sequential('M6.3-B2b-D0 evidence lifecycle database primitives', () => {
  loadEnvironment({ path: '.env.test.example', quiet: true, override: true });
  const ownerUrl = process.env.DATABASE_URL;
  const runtimeUrl = process.env.DATABASE_RUNTIME_URL;
  if (!ownerUrl || !runtimeUrl) throw new Error('M6.3-B2b-D0 database URLs are required');

  const owner = new PrismaClient({ datasourceUrl: ownerUrl });
  const runtime = createRuntimePrismaClient(runtimeUrl);
  const contender = createRuntimePrismaClient(runtimeUrl);
  const suffix = randomUUID().slice(0, 8);
  const storeAId = randomUUID();
  const storeBId = randomUUID();
  const storeACode = `m63b2b-a-${suffix}`;
  const storeBCode = `m63b2b-b-${suffix}`;
  const adminId = randomUUID();
  const memberOwnerId = randomUUID();
  const memberOtherId = randomUUID();
  const memberStoreBId = randomUUID();
  const memberCountQuotaId = randomUUID();
  const memberByteQuotaId = randomUUID();
  const retentionRegressionOrderId = randomUUID();
  const retentionRegressionAfterSaleId = randomUUID();
  const createdEvidenceIds = new Set<string>();

  function context(input: {
    actorId: string;
    actorType: 'admin' | 'member';
    correlationId?: string | undefined;
    store?: 'a' | 'b';
  }): StoreContext {
    const store = input.store ?? 'a';
    return createStoreContext({
      actor: { id: input.actorId, type: input.actorType },
      correlationId: input.correlationId ?? randomUUID(),
      locale: 'vi',
      storeCode: store === 'a' ? storeACode : storeBCode,
      storeId: store === 'a' ? storeAId : storeBId,
    });
  }

  function memberContext(
    memberId = memberOwnerId,
    store: 'a' | 'b' = 'a',
    correlationId?: string,
  ): StoreContext {
    return context({ actorId: memberId, actorType: 'member', correlationId, store });
  }

  function adminContext(store: 'a' | 'b' = 'a'): StoreContext {
    return context({ actorId: adminId, actorType: 'admin', store });
  }

  function systemContext(store: 'a' | 'b' = 'a', correlationId = randomUUID()) {
    return createAfterSaleEvidenceSystemContext({
      correlationId,
      storeId: store === 'a' ? storeAId : storeBId,
    });
  }

  async function initialize(
    member = memberContext(),
    overrides: Partial<Parameters<typeof initializeAfterSaleEvidenceUpload>[2]> = {},
    client = runtime,
  ) {
    const idempotencyKey = overrides.idempotencyKey ?? `m63b2b-init-${randomUUID()}`;
    const result = await initializeAfterSaleEvidenceUpload(client, member, {
      byteSize: 1_024,
      checksumSha256: digest(idempotencyKey),
      deploymentEnvironment: 'test',
      filename: 'evidence.jpg',
      idempotencyKey,
      maxUnclaimedBytes: MAX_UNCLAIMED_BYTES,
      maxUnclaimedFiles: MAX_UNCLAIMED_FILES,
      mimeType: 'image/jpeg',
      uploadTtlSeconds: UPLOAD_TTL_SECONDS,
      ...overrides,
    });
    createdEvidenceIds.add(result.evidence.id);
    return result;
  }

  async function outboxRows(
    evidenceId: string,
    eventType: EvidenceEventType,
  ): Promise<OutboxRow[]> {
    return owner.$queryRaw<OutboxRow[]>`
      SELECT id, event_type, payload, status, available_at, version
      FROM outbox_messages
      WHERE store_id = ${storeAId}::uuid
        AND aggregate_id = ${evidenceId}::uuid
        AND event_type = ${eventType}
      ORDER BY created_at, id
    `;
  }

  async function makeUploadDue(evidenceId: string): Promise<void> {
    await owner.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        UPDATE after_sale_evidence_files
        SET upload_deadline_at = clock_timestamp() - interval '1 second'
        WHERE store_id = ${storeAId}::uuid AND id = ${evidenceId}::uuid
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });
  }

  async function makeDeleteRetryDue(evidenceId: string): Promise<void> {
    await owner.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        UPDATE after_sale_evidence_files
        SET next_delete_attempt_at = clock_timestamp() - interval '1 second'
        WHERE store_id = ${storeAId}::uuid AND id = ${evidenceId}::uuid
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });
  }

  async function expectDatabaseFailure(
    action: () => Promise<unknown>,
    sqlState: string,
  ): Promise<void> {
    let failure: unknown;
    try {
      await action();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    const databaseFailure = failure as {
      code?: unknown;
      meta?: { code?: unknown; message?: unknown };
    };
    const failureMessage =
      typeof databaseFailure.meta?.message === 'string' ? databaseFailure.meta.message : '';
    expect(databaseFailure.meta?.code, failureMessage).toBe(sqlState);
  }

  async function expectLifecycleFailure(
    action: () => Promise<unknown>,
    code: AfterSaleEvidenceLifecycleError['code'],
  ): Promise<void> {
    let failure: unknown;
    try {
      await action();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AfterSaleEvidenceLifecycleError);
    expect((failure as AfterSaleEvidenceLifecycleError).code).toBe(code);
  }

  async function leaseAndDeadLetter(
    evidenceId: string,
    eventType: EvidenceEventType,
  ): Promise<OutboxRow> {
    const workerId = `m63b2b-worker-${randomUUID()}`;
    const rows = await withStoreTransaction(
      runtime,
      adminContext(),
      (transaction) =>
        transaction.$queryRaw<OutboxRow[]>`
        UPDATE outbox_messages
        SET status = 'PROCESSING', lease_owner = ${workerId},
          lease_expires_at = clock_timestamp() + interval '5 minutes',
          attempt_count = attempt_count + 1, version = version + 1,
          updated_at = clock_timestamp()
        WHERE id = (
          SELECT id FROM outbox_messages
          WHERE store_id = ${storeAId}::uuid
            AND aggregate_id = ${evidenceId}::uuid
            AND event_type = ${eventType}
            AND status = 'PENDING'
          ORDER BY created_at, id
          LIMIT 1
        )
        RETURNING id, event_type, payload, status, available_at, version
      `,
    );
    const leased = rows[0];
    if (!leased) throw new Error(`Missing ${eventType} message for ${evidenceId}`);
    const deadLetter = await failOutboxMessage(runtime, adminContext(), {
      disposition: 'PERMANENT',
      errorCode: 'EVIDENCE_TEST_PERMANENT',
      expectedVersion: leased.version,
      messageId: leased.id,
      workerId,
    });
    return {
      available_at: deadLetter.availableAt,
      event_type: deadLetter.eventType,
      id: deadLetter.id,
      payload: deadLetter.payload,
      status: deadLetter.status,
      version: deadLetter.version,
    };
  }

  async function reconcileDeadLetter(messageId: string) {
    return reconcileAfterSaleEvidenceDeadLetter(runtime, systemContext(), {
      deletionBaseDelayMs: DELETE_BASE_DELAY_MS,
      deletionMaxAttempts: DELETE_MAX_ATTEMPTS,
      deletionMaxDelayMs: DELETE_MAX_DELAY_MS,
      messageId,
      scanFailedRetentionSeconds: FAILED_RETENTION_SECONDS,
    });
  }

  beforeAll(async () => {
    await owner.$transaction(async (transaction) => {
      await transaction.adminUser.create({
        data: {
          displayName: 'M6.3-B2b-D0 fixture administrator',
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
          { displayName: 'D0 evidence owner', id: memberOwnerId, storeId: storeAId },
          { displayName: 'D0 other member', id: memberOtherId, storeId: storeAId },
          { displayName: 'D0 store B member', id: memberStoreBId, storeId: storeBId },
          { displayName: 'D0 count quota member', id: memberCountQuotaId, storeId: storeAId },
          { displayName: 'D0 byte quota member', id: memberByteQuotaId, storeId: storeAId },
        ],
      });
    });
  });

  afterAll(async () => {
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
        DELETE FROM after_sales WHERE id = ${retentionRegressionAfterSaleId}::uuid
      `;
      await transaction.$executeRaw`
        DELETE FROM orders WHERE id = ${retentionRegressionOrderId}::uuid
      `;
      await transaction.$executeRaw`
        DELETE FROM members
        WHERE id = ANY(ARRAY[
          ${memberOwnerId}::uuid, ${memberOtherId}::uuid, ${memberStoreBId}::uuid,
          ${memberCountQuotaId}::uuid, ${memberByteQuotaId}::uuid
        ])
      `;
      await transaction.$executeRaw`
        DELETE FROM stores WHERE id = ANY(ARRAY[${storeAId}::uuid, ${storeBId}::uuid])
      `;
      await transaction.$executeRaw`DELETE FROM admin_users WHERE id = ${adminId}::uuid`;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });
    await Promise.all([owner.$disconnect(), runtime.$disconnect(), contender.$disconnect()]);
  });

  it('initializes a canonical owner-bound ledger and isolates known evidence IDs', async () => {
    const created = await initialize();
    expect(created.replayed).toBe(false);
    expect(created.evidence).toMatchObject({
      memberId: memberOwnerId,
      scanGeneration: 0,
      status: 'PENDING',
      storeId: storeAId,
      version: 1,
    });
    expect(created.objectKey).toBe(`test/${storeAId}/staged/${created.evidence.id}/original`);

    const objects = await owner.$queryRaw<
      Array<{ object_key: string | null; object_key_hash: string; object_role: string }>
    >`
      SELECT object_key, object_key_hash, object_role
      FROM after_sale_evidence_objects
      WHERE store_id = ${storeAId}::uuid AND evidence_file_id = ${created.evidence.id}::uuid
    `;
    expect(objects).toEqual([
      {
        object_key: created.objectKey,
        object_key_hash: digest(created.objectKey),
        object_role: 'ORIGINAL',
      },
    ]);

    const expiryMessages = await outboxRows(created.evidence.id, AFTER_SALE_EVIDENCE_EXPIRE_EVENT);
    expect(expiryMessages).toHaveLength(1);
    expect(expiryMessages[0]?.payload).toEqual({
      evidence_id: created.evidence.id,
      expected_version: 1,
      store_id: storeAId,
    });
    expect(Object.keys(expiryMessages[0]?.payload as object).sort()).toEqual([
      'evidence_id',
      'expected_version',
      'store_id',
    ]);

    const otherMemberRows = await withStoreTransaction(
      runtime,
      memberContext(memberOtherId),
      (transaction) =>
        transaction.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM after_sale_evidence_files WHERE id = ${created.evidence.id}::uuid
        `,
    );
    const otherStoreRows = await withStoreTransaction(
      runtime,
      memberContext(memberStoreBId, 'b'),
      (transaction) =>
        transaction.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM after_sale_evidence_files WHERE id = ${created.evidence.id}::uuid
        `,
    );
    expect(otherMemberRows).toEqual([]);
    expect(otherStoreRows).toEqual([]);

    await expectLifecycleFailure(
      () =>
        initializeAfterSaleEvidenceUpload(runtime, adminContext(), {
          byteSize: 1_024,
          checksumSha256: digest('admin-evidence'),
          deploymentEnvironment: 'test',
          filename: 'admin.jpg',
          idempotencyKey: `m63b2b-admin-${randomUUID()}`,
          maxUnclaimedBytes: MAX_UNCLAIMED_BYTES,
          maxUnclaimedFiles: MAX_UNCLAIMED_FILES,
          mimeType: 'image/jpeg',
          uploadTtlSeconds: UPLOAD_TTL_SECONDS,
        }),
      'AFTER_SALE_EVIDENCE_SCOPE_DENIED',
    );

    await expectDatabaseFailure(
      () =>
        withStoreTransaction(
          runtime,
          adminContext(),
          (transaction) =>
            transaction.$executeRaw`
            UPDATE after_sale_evidence_files
            SET status = 'FAILED', scan_result_code = 'ADMIN_FORGED',
              scan_completed_at = clock_timestamp(),
              claim_deadline_at = clock_timestamp() + interval '1 hour',
              version = version + 1, updated_at = clock_timestamp()
            WHERE store_id = ${storeAId}::uuid AND id = ${created.evidence.id}::uuid
          `,
        ),
      '42501',
    );
  });

  it('serializes member count and byte quotas under concurrent initialization', async () => {
    const countContext = memberContext(memberCountQuotaId);
    for (let index = 0; index < MAX_UNCLAIMED_FILES - 1; index += 1) {
      await initialize(countContext, {
        idempotencyKey: `m63b2b-count-${index}-${randomUUID()}`,
      });
    }
    const countBoundary = await Promise.allSettled([
      initialize(countContext, { idempotencyKey: `m63b2b-count-left-${randomUUID()}` }, runtime),
      initialize(countContext, { idempotencyKey: `m63b2b-count-right-${randomUUID()}` }, contender),
    ]);
    expect(countBoundary.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(
      await owner.afterSaleEvidenceFile.count({
        where: { memberId: memberCountQuotaId, storeId: storeAId },
      }),
    ).toBe(MAX_UNCLAIMED_FILES);

    const byteContext = memberContext(memberByteQuotaId);
    for (let index = 0; index < 3; index += 1) {
      await initialize(byteContext, {
        byteSize: 50 * 1_024 * 1_024,
        checksumSha256: digest(`m63b2b-byte-${index}`),
        filename: `evidence-${index}.mp4`,
        idempotencyKey: `m63b2b-byte-${index}-${randomUUID()}`,
        mimeType: 'video/mp4',
      });
    }
    const byteBoundary = await Promise.allSettled([
      initialize(
        byteContext,
        {
          byteSize: 30 * 1_024 * 1_024,
          checksumSha256: digest('m63b2b-byte-left'),
          filename: 'left.mp4',
          idempotencyKey: `m63b2b-byte-left-${randomUUID()}`,
          mimeType: 'video/mp4',
        },
        runtime,
      ),
      initialize(
        byteContext,
        {
          byteSize: 30 * 1_024 * 1_024,
          checksumSha256: digest('m63b2b-byte-right'),
          filename: 'right.mp4',
          idempotencyKey: `m63b2b-byte-right-${randomUUID()}`,
          mimeType: 'video/mp4',
        },
        contender,
      ),
    ]);
    expect(byteBoundary.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const [byteUsage] = await owner.$queryRaw<Array<{ bytes: bigint; files: bigint }>>`
      SELECT count(*)::bigint AS files, sum(byte_size)::bigint AS bytes
      FROM after_sale_evidence_files
      WHERE store_id = ${storeAId}::uuid AND member_id = ${memberByteQuotaId}::uuid
    `;
    expect(byteUsage).toEqual({ bytes: 180n * 1_024n * 1_024n, files: 4n });
  });

  it('commits confirmation and its strict scan identity atomically', async () => {
    const created = await initialize();
    const idempotencyKey = `m63b2b-confirm-${randomUUID()}`;
    const correlationId = randomUUID();
    const confirmed = await confirmAfterSaleEvidenceUpload(
      runtime,
      memberContext(memberOwnerId, 'a', correlationId),
      {
        evidenceId: created.evidence.id,
        expectedVersion: created.evidence.version,
        idempotencyKey,
      },
    );
    expect(confirmed).toMatchObject({
      evidence: { scanGeneration: 1, status: 'PENDING', version: 2 },
      replayed: false,
    });

    const replay = await confirmAfterSaleEvidenceUpload(runtime, memberContext(), {
      evidenceId: created.evidence.id,
      expectedVersion: created.evidence.version,
      idempotencyKey,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.evidence.version).toBe(2);

    const scanMessages = await outboxRows(created.evidence.id, AFTER_SALE_EVIDENCE_SCAN_EVENT);
    expect(scanMessages).toHaveLength(1);
    expect(scanMessages[0]?.payload).toEqual({
      evidence_id: created.evidence.id,
      expected_version: 2,
      store_id: storeAId,
    });
    expect(Object.keys(scanMessages[0]?.payload as object).sort()).toEqual([
      'evidence_id',
      'expected_version',
      'store_id',
    ]);
    const [scanRequestTransition] = await owner.$queryRaw<
      Array<{
        actor_type: string;
        correlation_id: string;
        evidence_version: number;
        event: string;
        scan_generation: number;
      }>
    >`
      SELECT actor_type, correlation_id, evidence_version, event, scan_generation
      FROM after_sale_evidence_transitions
      WHERE store_id = ${storeAId}::uuid AND evidence_file_id = ${created.evidence.id}::uuid
        AND event = 'SCAN_REQUESTED'
      ORDER BY created_at, id
      LIMIT 1
    `;
    expect(scanRequestTransition).toEqual({
      actor_type: 'MEMBER',
      correlation_id: correlationId,
      evidence_version: 2,
      event: 'SCAN_REQUESTED',
      scan_generation: 1,
    });

    await expectLifecycleFailure(
      () =>
        confirmAfterSaleEvidenceUpload(runtime, memberContext(memberOtherId), {
          evidenceId: created.evidence.id,
          expectedVersion: 1,
          idempotencyKey: `m63b2b-other-confirm-${randomUUID()}`,
        }),
      'AFTER_SALE_EVIDENCE_NOT_FOUND',
    );

    const unqueued = await initialize();
    await expectDatabaseFailure(
      () =>
        withStoreTransaction(runtime, memberContext(), async (transaction) => {
          await transaction.$executeRaw`
              UPDATE after_sale_evidence_files
              SET confirmed_at = CURRENT_TIMESTAMP, scan_requested_at = CURRENT_TIMESTAMP,
                scan_generation = scan_generation + 1, version = version + 1,
                updated_at = CURRENT_TIMESTAMP
              WHERE store_id = ${storeAId}::uuid AND id = ${unqueued.evidence.id}::uuid
            `;
          await transaction.$executeRaw`
              SET CONSTRAINTS after_sale_evidence_files_queue_commit_guard IMMEDIATE
            `;
        }),
      '23514',
    );
    const [rolledBack] = await owner.$queryRaw<
      Array<{ confirmed_at: Date | null; scan_generation: number; version: number }>
    >`
      SELECT confirmed_at, scan_generation, version
      FROM after_sale_evidence_files
      WHERE store_id = ${storeAId}::uuid AND id = ${unqueued.evidence.id}::uuid
    `;
    expect(rolledBack).toEqual({ confirmed_at: null, scan_generation: 0, version: 1 });

    await expectDatabaseFailure(
      () =>
        withStoreTransaction(
          runtime,
          memberContext(),
          (transaction) =>
            transaction.$executeRaw`
            INSERT INTO outbox_messages (
              store_id, aggregate_type, aggregate_id, event_type, event_version,
              idempotency_key, payload, available_at, max_attempts, updated_at
            ) VALUES (
              ${storeAId}::uuid, 'AFTER_SALE_EVIDENCE', ${created.evidence.id}::uuid,
              ${AFTER_SALE_EVIDENCE_SCAN_EVENT}, 1, ${`m63b2b-malformed-${randomUUID()}`},
              ${JSON.stringify({
                evidence_id: created.evidence.id,
                expected_version: 2,
                object_key: 'MUST_NOT_ENTER_THE_MESSAGE',
                store_id: storeAId,
              })}::jsonb,
              clock_timestamp(), 5, clock_timestamp()
            )
          `,
        ),
      '23514',
    );
    await expectDatabaseFailure(
      () =>
        withStoreTransaction(
          runtime,
          memberContext(),
          (transaction) =>
            transaction.$executeRaw`
            INSERT INTO outbox_messages (
              store_id, aggregate_type, aggregate_id, event_type, event_version,
              idempotency_key, payload, available_at, max_attempts, updated_at
            ) VALUES (
              ${storeAId}::uuid, 'AFTER_SALE_EVIDENCE', ${created.evidence.id}::uuid,
              ${AFTER_SALE_EVIDENCE_SCAN_EVENT}, 1,
              ${`${AFTER_SALE_EVIDENCE_SCAN_EVENT}:${created.evidence.id}:2`},
              ${JSON.stringify({
                evidence_id: created.evidence.id,
                expected_version: '2',
                store_id: storeAId,
              })}::jsonb,
              clock_timestamp(), 5, clock_timestamp()
            )
          `,
        ),
      '23514',
    );
  });

  it('audits a same-state SYSTEM rescan and requires its scan outbox atomically', async () => {
    const created = await initialize();
    const confirmationCorrelationId = randomUUID();
    await confirmAfterSaleEvidenceUpload(
      runtime,
      memberContext(memberOwnerId, 'a', confirmationCorrelationId),
      {
        evidenceId: created.evidence.id,
        expectedVersion: created.evidence.version,
        idempotencyKey: `m63b2b-rescan-confirm-${randomUUID()}`,
      },
    );

    const rescanCorrelationId = randomUUID();
    const rescan = await requestAfterSaleEvidenceRescan(
      runtime,
      systemContext('a', rescanCorrelationId),
      {
        evidenceId: created.evidence.id,
        expectedVersion: 2,
      },
    );
    expect(rescan).toMatchObject({
      evidence: { scanGeneration: 2, status: 'PENDING', version: 3 },
      requested: true,
    });
    const staleRescan = await requestAfterSaleEvidenceRescan(runtime, systemContext(), {
      evidenceId: created.evidence.id,
      expectedVersion: 2,
    });
    expect(staleRescan).toMatchObject({
      evidence: { scanGeneration: 2, status: 'PENDING', version: 3 },
      requested: false,
    });

    const transitions = await owner.$queryRaw<
      Array<{
        actor_type: string;
        correlation_id: string;
        evidence_version: number;
        event: string;
        from_status: string;
        scan_generation: number;
        to_status: string;
      }>
    >`
      SELECT actor_type, correlation_id, evidence_version, event, from_status,
        scan_generation, to_status
      FROM after_sale_evidence_transitions
      WHERE store_id = ${storeAId}::uuid AND evidence_file_id = ${created.evidence.id}::uuid
      ORDER BY created_at, id
    `;
    expect(transitions).toEqual([
      {
        actor_type: 'MEMBER',
        correlation_id: confirmationCorrelationId,
        evidence_version: 2,
        event: 'SCAN_REQUESTED',
        from_status: 'PENDING',
        scan_generation: 1,
        to_status: 'PENDING',
      },
      {
        actor_type: 'SYSTEM',
        correlation_id: rescanCorrelationId,
        evidence_version: 3,
        event: 'SCAN_REQUESTED',
        from_status: 'PENDING',
        scan_generation: 2,
        to_status: 'PENDING',
      },
    ]);
    const scanMessages = await outboxRows(created.evidence.id, AFTER_SALE_EVIDENCE_SCAN_EVENT);
    expect(scanMessages.map(({ payload }) => payload)).toEqual([
      { evidence_id: created.evidence.id, expected_version: 2, store_id: storeAId },
      { evidence_id: created.evidence.id, expected_version: 3, store_id: storeAId },
    ]);

    await expectDatabaseFailure(
      () =>
        withAfterSaleEvidenceSystemTransaction(runtime, systemContext(), async (transaction) => {
          const [clockRow] = await transaction.$queryRaw<Array<{ now: Date }>>`
              SELECT clock_timestamp() AS now
            `;
          if (!clockRow) throw new Error('unqueued rescan database clock is required');
          const affected = await transaction.$executeRaw`
              UPDATE after_sale_evidence_files
              SET scan_requested_at = ${clockRow.now}, scan_generation = scan_generation + 1,
                version = version + 1, updated_at = ${clockRow.now}
              WHERE store_id = ${storeAId}::uuid AND id = ${created.evidence.id}::uuid
                AND status = 'PENDING' AND confirmed_at IS NOT NULL
                AND scan_completed_at IS NULL AND scan_result_code IS NULL AND version = 3
            `;
          expect(affected).toBe(1);
          await transaction.$executeRaw`
              SET CONSTRAINTS after_sale_evidence_files_queue_commit_guard IMMEDIATE
            `;
        }),
      '23514',
    );
    const [rolledBackRescan] = await owner.$queryRaw<
      Array<{ scan_generation: number; version: number }>
    >`
      SELECT scan_generation, version
      FROM after_sale_evidence_files
      WHERE store_id = ${storeAId}::uuid AND id = ${created.evidence.id}::uuid
    `;
    expect(rolledBackRescan).toEqual({ scan_generation: 2, version: 3 });
    const [transitionCount] = await owner.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count
      FROM after_sale_evidence_transitions
      WHERE store_id = ${storeAId}::uuid AND evidence_file_id = ${created.evidence.id}::uuid
    `;
    expect(transitionCount?.count).toBe(2n);
  });

  it('requires the dedicated SYSTEM scope and rejects stale scan generations', async () => {
    const created = await initialize();
    const confirmed = await confirmAfterSaleEvidenceUpload(runtime, memberContext(), {
      evidenceId: created.evidence.id,
      expectedVersion: 1,
      idempotencyKey: `m63b2b-scan-confirm-${randomUUID()}`,
    });
    const correlationId = randomUUID();
    const scanned = await applyAfterSaleEvidenceScanResult(
      runtime,
      systemContext('a', correlationId),
      {
        claimTtlSeconds: CLAIM_TTL_SECONDS,
        evidenceId: created.evidence.id,
        expectedVersion: confirmed.evidence.version,
        failedRetentionSeconds: FAILED_RETENTION_SECONDS,
        result: {
          engine: 'clamav',
          engineVersion: '1.4.2',
          signatureVersion: '20260729',
          verdict: 'CLEAN',
        },
        scanGeneration: confirmed.evidence.scanGeneration,
      },
    );
    expect(scanned).toMatchObject({
      applied: true,
      evidence: { scanGeneration: 1, status: 'READY_UNCLAIMED', version: 3 },
    });

    const stale = await applyAfterSaleEvidenceScanResult(runtime, systemContext(), {
      claimTtlSeconds: CLAIM_TTL_SECONDS,
      evidenceId: created.evidence.id,
      expectedVersion: confirmed.evidence.version,
      failedRetentionSeconds: FAILED_RETENTION_SECONDS,
      result: {
        engine: 'clamav',
        engineVersion: '1.4.2',
        signatureVersion: '20260729',
        verdict: 'CLEAN',
      },
      scanGeneration: 1,
    });
    expect(stale.applied).toBe(false);
    expect(stale.evidence.status).toBe('READY_UNCLAIMED');

    const [transition] = await owner.$queryRaw<
      Array<{
        actor_id: string;
        actor_type: string;
        correlation_id: string;
        evidence_version: number;
        event: string;
        scan_generation: number;
      }>
    >`
      SELECT actor_id, actor_type, correlation_id, evidence_version, event, scan_generation
      FROM after_sale_evidence_transitions
      WHERE store_id = ${storeAId}::uuid AND evidence_file_id = ${created.evidence.id}::uuid
      ORDER BY created_at DESC, id DESC LIMIT 1
    `;
    expect(transition).toEqual({
      actor_id: '00000000-0000-4000-8000-000000000006',
      actor_type: 'SYSTEM',
      correlation_id: correlationId,
      evidence_version: 3,
      event: 'SCAN_PASSED',
      scan_generation: 1,
    });

    await expectLifecycleFailure(
      () =>
        applyAfterSaleEvidenceScanResult(runtime, systemContext('b'), {
          claimTtlSeconds: CLAIM_TTL_SECONDS,
          evidenceId: created.evidence.id,
          expectedVersion: confirmed.evidence.version,
          failedRetentionSeconds: FAILED_RETENTION_SECONDS,
          result: { code: 'UNAVAILABLE', verdict: 'INDETERMINATE' },
          scanGeneration: 1,
        }),
      'AFTER_SALE_EVIDENCE_NOT_FOUND',
    );

    const wrongScope = await initialize();
    await confirmAfterSaleEvidenceUpload(runtime, memberContext(), {
      evidenceId: wrongScope.evidence.id,
      expectedVersion: 1,
      idempotencyKey: `m63b2b-wrong-scope-${randomUUID()}`,
    });
    const wrongScopeAffected = await runtime.$transaction(async (transaction) => {
      await transaction.$executeRaw`
        SELECT
          set_config('app.store_id', ${storeAId}, true),
          set_config('app.actor_id', '00000000-0000-4000-8000-000000000006', true),
          set_config('app.actor_type', 'system', true),
          set_config('app.system_scope', 'after-sale-transition', true),
          set_config('app.correlation_id', ${randomUUID()}, true)
      `;
      return transaction.$executeRaw`
        UPDATE after_sale_evidence_files
        SET status = 'FAILED', scan_result_code = 'UNAVAILABLE',
          scan_completed_at = clock_timestamp(),
          claim_deadline_at = clock_timestamp() + interval '1 hour',
          version = version + 1, updated_at = clock_timestamp()
        WHERE store_id = ${storeAId}::uuid AND id = ${wrongScope.evidence.id}::uuid
      `;
    });
    expect(wrongScopeAffected).toBe(0);

    const wrongActorAffected = await runtime.$transaction(async (transaction) => {
      await transaction.$executeRaw`
        SELECT
          set_config('app.store_id', ${storeAId}, true),
          set_config('app.actor_id', ${adminId}, true),
          set_config('app.actor_type', 'system', true),
          set_config('app.system_scope', 'after-sale-evidence-lifecycle', true),
          set_config('app.correlation_id', ${randomUUID()}, true)
      `;
      return transaction.$executeRaw`
        UPDATE after_sale_evidence_files
        SET status = 'FAILED', scan_result_code = 'UNAVAILABLE',
          scan_completed_at = clock_timestamp(),
          claim_deadline_at = clock_timestamp() + interval '1 hour',
          version = version + 1, updated_at = clock_timestamp()
        WHERE store_id = ${storeAId}::uuid AND id = ${wrongScope.evidence.id}::uuid
      `;
    });
    expect(wrongActorAffected).toBe(0);
  });

  it('claims through narrow member RLS and keeps late quarantine on retention', async () => {
    const ownerMemberContext = memberContext();
    await owner.order.create({
      data: {
        baseSubtotalVnd: 1_000,
        couponDiscountVnd: 0,
        currency: 'VND',
        id: retentionRegressionOrderId,
        itemDiscountVnd: 0,
        memberId: memberOwnerId,
        orderDiscountVnd: 0,
        orderNumber: `M63-D0-${retentionRegressionOrderId.slice(0, 12)}`,
        payableVnd: 1_000,
        paymentMethod: 'COD',
        paymentStatus: 'SUCCEEDED',
        quoteHash: digest(`retention-order-${retentionRegressionOrderId}`),
        remoteSurchargeVnd: 0,
        shippingDiscountVnd: 0,
        shippingFeeVnd: 0,
        status: 'PENDING_FULFILLMENT',
        storeId: storeAId,
      },
    });
    await withStoreTransaction(
      runtime,
      ownerMemberContext,
      (transaction) =>
        transaction.$executeRaw`
        INSERT INTO after_sales (
          id, store_id, order_id, member_id, public_case_number, type, status, source,
          reason_code, legacy_policy_review, idempotency_key_hash, request_hash,
          initiated_by, correlation_id, updated_at
        ) VALUES (
          ${retentionRegressionAfterSaleId}::uuid, ${storeAId}::uuid,
          ${retentionRegressionOrderId}::uuid, ${memberOwnerId}::uuid,
          ${`ASC-${retentionRegressionAfterSaleId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
          'REFUND_ONLY', 'REVIEW_REQUIRED', 'MEMBER', 'late-malicious-regression', true,
          ${digest(`retention-case-key-${retentionRegressionAfterSaleId}`)},
          ${digest(`retention-case-request-${retentionRegressionAfterSaleId}`)},
          ${memberOwnerId}::uuid, ${ownerMemberContext.correlationId}, clock_timestamp()
        )
      `,
    );
    expect(
      await withStoreTransaction(
        runtime,
        ownerMemberContext,
        (transaction) =>
          transaction.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM after_sales
          WHERE store_id = ${storeAId}::uuid
            AND id = ${retentionRegressionAfterSaleId}::uuid
        `,
      ),
    ).toEqual([{ id: retentionRegressionAfterSaleId }]);

    const created = await initialize(ownerMemberContext);
    const confirmed = await confirmAfterSaleEvidenceUpload(runtime, ownerMemberContext, {
      evidenceId: created.evidence.id,
      expectedVersion: created.evidence.version,
      idempotencyKey: `m63b2b-retention-confirm-${randomUUID()}`,
    });
    const clean = await applyAfterSaleEvidenceScanResult(runtime, systemContext(), {
      claimTtlSeconds: CLAIM_TTL_SECONDS,
      evidenceId: created.evidence.id,
      expectedVersion: confirmed.evidence.version,
      failedRetentionSeconds: FAILED_RETENTION_SECONDS,
      result: {
        engine: 'clamav',
        engineVersion: '1.4.2',
        signatureVersion: '20260729',
        verdict: 'CLEAN',
      },
      scanGeneration: confirmed.evidence.scanGeneration,
    });
    const [claimed] = await withStoreTransaction(runtime, ownerMemberContext, (transaction) =>
      claimAfterSaleEvidenceInTransaction(transaction, ownerMemberContext, {
        afterSaleId: retentionRegressionAfterSaleId,
        evidenceIds: [created.evidence.id],
        ordinaryAccessTtlSeconds: 1,
        retentionTtlSeconds: 2,
      }),
    );
    if (!claimed?.claimDeadlineAt || !claimed.retentionDeadlineAt) {
      throw new Error('Claimed evidence did not retain both lifecycle deadlines');
    }
    expect(claimed.status).toBe('READY');
    expect(claimed.retentionDeadlineAt.getTime()).toBeLessThan(claimed.claimDeadlineAt.getTime());

    const waitMs = Math.max(0, claimed.retentionDeadlineAt.getTime() - Date.now() + 100);
    await new Promise<void>((resolve) => setTimeout(resolve, waitMs));

    const quarantineAt = new Date();
    const lateMaliciousContext = systemContext();
    const quarantined = await withAfterSaleEvidenceSystemTransaction(
      runtime,
      lateMaliciousContext,
      async (transaction) => {
        const [updated] = await transaction.$queryRaw<
          Array<{ retention_deadline_at: Date; version: number }>
        >`
          UPDATE after_sale_evidence_files
          SET status = 'QUARANTINED', scan_result_code = 'MALICIOUS_LATE',
            scan_completed_at = ${quarantineAt}, scanner_engine = 'clamav',
            scanner_engine_version = '1.4.3', scanner_signature_version = '20260729-late',
            version = version + 1, updated_at = ${quarantineAt}
          WHERE store_id = ${storeAId}::uuid AND id = ${created.evidence.id}::uuid
            AND status = 'READY' AND version = ${claimed.version}
          RETURNING retention_deadline_at, version
        `;
        if (!updated) throw new Error('Failed to quarantine claimed evidence');
        await appendOutboxMessageInTransaction(transaction, lateMaliciousContext, {
          aggregateId: created.evidence.id,
          aggregateType: AFTER_SALE_EVIDENCE_AGGREGATE_TYPE,
          availableAt: updated.retention_deadline_at,
          eventType: AFTER_SALE_EVIDENCE_EXPIRE_EVENT,
          eventVersion: 1,
          idempotencyKey: `${AFTER_SALE_EVIDENCE_EXPIRE_EVENT}:${created.evidence.id}:${updated.version}`,
          maxAttempts: 3,
          payload: {
            evidence_id: created.evidence.id,
            expected_version: updated.version,
            store_id: storeAId,
          },
        });
        return updated;
      },
    );

    const quarantineExpiry = (
      await outboxRows(created.evidence.id, AFTER_SALE_EVIDENCE_EXPIRE_EVENT)
    ).find(
      ({ payload }) =>
        (payload as { expected_version?: unknown }).expected_version === quarantined.version,
    );
    expect(quarantineExpiry?.available_at.getTime()).toBe(claimed.retentionDeadlineAt.getTime());

    const deletion = await beginAfterSaleEvidenceDeletion(runtime, systemContext(), {
      evidenceId: created.evidence.id,
      expectedVersion: quarantined.version,
    });
    expect(deletion).toMatchObject({
      evidence: { status: 'DELETION_PENDING' },
      outcome: 'READY',
    });
    expect(clean.evidence.claimDeadlineAt?.getTime()).toBe(claimed.claimDeadlineAt.getTime());
  });

  it('rechecks legal hold and deletes every canonical ledger object before the parent', async () => {
    const held = await initialize();
    await makeUploadDue(held.evidence.id);
    const [activatedHold] = await withStoreTransaction(
      runtime,
      adminContext(),
      (transaction) =>
        transaction.$queryRaw<Array<{ version: number }>>`
        UPDATE after_sale_evidence_files
        SET legal_hold_active = true, held_at = clock_timestamp(), held_by = ${adminId}::uuid,
          hold_reason = 'D0 integration legal hold', version = version + 1,
          updated_at = clock_timestamp()
        WHERE store_id = ${storeAId}::uuid AND id = ${held.evidence.id}::uuid
        RETURNING version
      `,
    );
    if (!activatedHold) throw new Error('Failed to activate the D0 evidence hold');
    expect(
      await beginAfterSaleEvidenceDeletion(runtime, systemContext(), {
        evidenceId: held.evidence.id,
        expectedVersion: activatedHold.version,
      }),
    ).toMatchObject({ outcome: 'HELD' });
    const [releasedHold] = await withStoreTransaction(
      runtime,
      adminContext(),
      (transaction) =>
        transaction.$queryRaw<Array<{ version: number }>>`
        UPDATE after_sale_evidence_files
        SET legal_hold_active = false, held_at = NULL, held_by = NULL, hold_reason = NULL,
          version = version + 1, updated_at = clock_timestamp()
        WHERE store_id = ${storeAId}::uuid AND id = ${held.evidence.id}::uuid
        RETURNING version
      `,
    );
    if (!releasedHold) throw new Error('Failed to release the D0 evidence hold');

    const deletion = await beginAfterSaleEvidenceDeletion(runtime, systemContext(), {
      evidenceId: held.evidence.id,
      expectedVersion: releasedHold.version,
    });
    expect(deletion).toMatchObject({ evidence: { status: 'DELETION_PENDING' }, outcome: 'READY' });

    const derivativeKey = `test/${storeAId}/derived/${held.evidence.id}/thumbnail`;
    const scanTemporaryKey = `test/${storeAId}/scan/${held.evidence.id}/temporary`;
    await withAfterSaleEvidenceSystemTransaction(runtime, systemContext(), async (transaction) => {
      await transaction.$executeRaw`
          INSERT INTO after_sale_evidence_objects (
            store_id, evidence_file_id, object_role, object_key, object_key_hash, updated_at
          ) VALUES
            (${storeAId}::uuid, ${held.evidence.id}::uuid, 'DERIVATIVE',
              ${derivativeKey}, ${digest(derivativeKey)}, clock_timestamp()),
            (${storeAId}::uuid, ${held.evidence.id}::uuid, 'SCAN_TEMPORARY',
              ${scanTemporaryKey}, ${digest(scanTemporaryKey)}, clock_timestamp())
        `;
    });

    const objects = await listAfterSaleEvidenceDeletionObjects(runtime, systemContext(), {
      evidenceId: held.evidence.id,
      expectedVersion: deletion.evidence.version,
    });
    expect(objects.map(({ role }) => role).sort()).toEqual([
      'DERIVATIVE',
      'ORIGINAL',
      'SCAN_TEMPORARY',
    ]);

    const lateDerivativeKey = `test/${storeAId}/derived/${held.evidence.id}/late-object`;
    await withAfterSaleEvidenceSystemTransaction(
      runtime,
      systemContext(),
      (transaction) =>
        transaction.$executeRaw`
        INSERT INTO after_sale_evidence_objects (
          store_id, evidence_file_id, object_role, object_key, object_key_hash, updated_at
        ) VALUES (
          ${storeAId}::uuid, ${held.evidence.id}::uuid, 'DERIVATIVE',
          ${lateDerivativeKey}, ${digest(lateDerivativeKey)}, clock_timestamp()
        )
      `,
    );
    await expectLifecycleFailure(
      () =>
        completeAfterSaleEvidenceDeletion(runtime, systemContext(), {
          evidenceId: held.evidence.id,
          expectedVersion: deletion.evidence.version,
          objects: objects.map(({ id, version }) => ({ expectedVersion: version, id })),
        }),
      'AFTER_SALE_EVIDENCE_STATE_CONFLICT',
    );
    const refreshedObjects = await listAfterSaleEvidenceDeletionObjects(runtime, systemContext(), {
      evidenceId: held.evidence.id,
      expectedVersion: deletion.evidence.version,
    });
    expect(refreshedObjects).toHaveLength(4);
    const deleted = await completeAfterSaleEvidenceDeletion(runtime, systemContext(), {
      evidenceId: held.evidence.id,
      expectedVersion: deletion.evidence.version,
      objects: refreshedObjects.map(({ id, version }) => ({ expectedVersion: version, id })),
    });
    expect(deleted).toMatchObject({ objectKey: null, status: 'DELETED' });
    const ledger = await owner.$queryRaw<
      Array<{ deleted_at: Date | null; object_key: string | null; object_key_hash: string }>
    >`
      SELECT object_key, object_key_hash, deleted_at
      FROM after_sale_evidence_objects
      WHERE store_id = ${storeAId}::uuid AND evidence_file_id = ${held.evidence.id}::uuid
      ORDER BY object_role, id
    `;
    expect(ledger).toHaveLength(4);
    expect(
      ledger.every(({ deleted_at, object_key }) => deleted_at !== null && object_key === null),
    ).toBe(true);
    expect(ledger.every(({ object_key_hash }) => /^[0-9a-f]{64}$/u.test(object_key_hash))).toBe(
      true,
    );

    const events = await owner.$queryRaw<Array<{ actor_type: string; event: string }>>`
      SELECT actor_type, event
      FROM after_sale_evidence_transitions
      WHERE store_id = ${storeAId}::uuid AND evidence_file_id = ${held.evidence.id}::uuid
      ORDER BY created_at, id
    `;
    expect(events).toEqual([
      { actor_type: 'SYSTEM', event: 'EXPIRE' },
      { actor_type: 'SYSTEM', event: 'DELETE_SUCCEEDED' },
    ]);
  });

  it('bounds delete retries and persists the fifth warning and eighth exhaustion conditions', async () => {
    const created = await initialize();
    await makeUploadDue(created.evidence.id);
    const initialDeletion = await beginAfterSaleEvidenceDeletion(runtime, systemContext(), {
      evidenceId: created.evidence.id,
      expectedVersion: created.evidence.version,
    });
    let deletionVersion = initialDeletion.evidence.version;

    await expectDatabaseFailure(
      () =>
        withAfterSaleEvidenceSystemTransaction(runtime, systemContext(), async (transaction) => {
          await transaction.$executeRaw`
            UPDATE after_sale_evidence_files
            SET status = 'DELETE_FAILED', delete_attempt_count = delete_attempt_count + 1,
              delete_error_code = 'UNQUEUED_DELETE_FAILURE',
              next_delete_attempt_at = clock_timestamp() + interval '1 minute',
              version = version + 1, updated_at = clock_timestamp()
            WHERE store_id = ${storeAId}::uuid AND id = ${created.evidence.id}::uuid
          `;
          await transaction.$executeRaw`
            SET CONSTRAINTS after_sale_evidence_files_queue_commit_guard IMMEDIATE
          `;
        }),
      '23514',
    );

    for (let attempt = 1; attempt <= DELETE_MAX_ATTEMPTS; attempt += 1) {
      const failed = await recordAfterSaleEvidenceDeletionFailure(runtime, systemContext(), {
        baseDelayMs: DELETE_BASE_DELAY_MS,
        errorCode: 'OBJECT_STORE_UNAVAILABLE',
        evidenceId: created.evidence.id,
        expectedVersion: deletionVersion,
        maxAttempts: DELETE_MAX_ATTEMPTS,
        maxDelayMs: DELETE_MAX_DELAY_MS,
      });
      deletionVersion = failed.version;
      expect(failed.deleteAttemptCount).toBe(attempt);
      if (attempt === 5) {
        expect(failed.status).toBe('DELETE_FAILED');
        const warningFacts = await owner.$queryRaw<Array<{ count: bigint }>>`
          SELECT count(*)::bigint AS count
          FROM after_sale_evidence_transitions
          WHERE store_id = ${storeAId}::uuid
            AND evidence_file_id = ${created.evidence.id}::uuid
            AND event = 'DELETE_FAILED'
        `;
        expect(warningFacts).toEqual([{ count: 5n }]);
      }
      if (attempt < DELETE_MAX_ATTEMPTS) {
        expect(failed.nextDeleteAttemptAt).not.toBeNull();
        expect(failed.deleteExhaustedAt).toBeNull();
        await makeDeleteRetryDue(created.evidence.id);
        const retry = await beginAfterSaleEvidenceDeletion(runtime, systemContext(), {
          evidenceId: created.evidence.id,
          expectedVersion: deletionVersion,
        });
        expect(retry).toMatchObject({ outcome: 'READY' });
        deletionVersion = retry.evidence.version;
      } else {
        expect(failed.nextDeleteAttemptAt).toBeNull();
        expect(failed.deleteExhaustedAt).not.toBeNull();
      }
    }

    expect(
      await beginAfterSaleEvidenceDeletion(runtime, systemContext(), {
        evidenceId: created.evidence.id,
        expectedVersion: deletionVersion,
      }),
    ).toMatchObject({ evidence: { status: 'DELETE_FAILED' }, outcome: 'NOT_DUE' });
    const [activeObject] = await owner.$queryRaw<Array<{ object_key: string | null }>>`
      SELECT object_key FROM after_sale_evidence_objects
      WHERE store_id = ${storeAId}::uuid AND evidence_file_id = ${created.evidence.id}::uuid
    `;
    expect(activeObject?.object_key).toBe(created.objectKey);
  });

  it('keeps scan, expire and delete dead letters in safe database states for reconciliation', async () => {
    const scanEvidence = await initialize();
    await confirmAfterSaleEvidenceUpload(runtime, memberContext(), {
      evidenceId: scanEvidence.evidence.id,
      expectedVersion: 1,
      idempotencyKey: `m63b2b-dead-scan-${randomUUID()}`,
    });
    const scanDeadLetter = await leaseAndDeadLetter(
      scanEvidence.evidence.id,
      AFTER_SALE_EVIDENCE_SCAN_EVENT,
    );
    expect(scanDeadLetter).toMatchObject({ status: 'DEAD_LETTER' });
    await withStoreTransaction(
      runtime,
      adminContext(),
      (transaction) =>
        transaction.$executeRaw`
        UPDATE after_sale_evidence_files
        SET legal_hold_active = true, held_at = clock_timestamp(), held_by = ${adminId}::uuid,
          hold_reason = 'D0 scan dead-letter orthogonal version regression',
          version = version + 1, updated_at = clock_timestamp()
        WHERE store_id = ${storeAId}::uuid AND id = ${scanEvidence.evidence.id}::uuid
      `,
    );
    const reconciledScan = await reconcileDeadLetter(scanDeadLetter.id);
    expect(reconciledScan).toMatchObject({
      evidence: { legalHoldActive: true, status: 'FAILED' },
      outcome: 'SCAN_FAILED',
    });
    const scanSafe = await owner.afterSaleEvidenceFile.findUniqueOrThrow({
      where: { id: scanEvidence.evidence.id },
    });
    expect(scanSafe.status).toBe('FAILED');
    expect(scanSafe.scanResultCode).toBe('SCAN_OUTBOX_DEAD_LETTER');
    expect(await reconcileDeadLetter(scanDeadLetter.id)).toMatchObject({ outcome: 'SUPERSEDED' });

    const expireEvidence = await initialize();
    const expireDeadLetter = await leaseAndDeadLetter(
      expireEvidence.evidence.id,
      AFTER_SALE_EVIDENCE_EXPIRE_EVENT,
    );
    expect(expireDeadLetter).toMatchObject({ status: 'DEAD_LETTER' });
    await makeUploadDue(expireEvidence.evidence.id);
    const reconciledExpiry = await reconcileDeadLetter(expireDeadLetter.id);
    expect(reconciledExpiry).toMatchObject({
      evidence: { status: 'DELETION_PENDING' },
      outcome: 'EXPIRE_DELETE_SCHEDULED',
    });

    const deleteDeadLetter = await leaseAndDeadLetter(
      expireEvidence.evidence.id,
      AFTER_SALE_EVIDENCE_DELETE_EVENT,
    );
    expect(deleteDeadLetter).toMatchObject({ status: 'DEAD_LETTER' });
    const beforeReconciliation = await owner.afterSaleEvidenceFile.findUniqueOrThrow({
      where: { id: expireEvidence.evidence.id },
    });
    expect(beforeReconciliation.status).toBe('DELETION_PENDING');
    expect(beforeReconciliation.objectKey).not.toBeNull();

    const reconciledDelete = await reconcileDeadLetter(deleteDeadLetter.id);
    expect(reconciledDelete).toMatchObject({
      evidence: { deleteAttemptCount: 1, status: 'DELETE_FAILED' },
      outcome: 'DELETE_RETRY_SCHEDULED',
    });
    const [protectedObject] = await owner.$queryRaw<Array<{ object_key: string | null }>>`
      SELECT object_key FROM after_sale_evidence_objects
      WHERE store_id = ${storeAId}::uuid
        AND evidence_file_id = ${expireEvidence.evidence.id}::uuid
        AND object_role = 'ORIGINAL'
    `;
    expect(protectedObject?.object_key).toBe(expireEvidence.objectKey);
  });
});
