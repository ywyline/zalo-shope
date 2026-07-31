import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { config as loadEnvironment } from 'dotenv';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { parseRuntimeConfig } from '@zalo-shop/config';
import { AFTER_SALE_RATE_LIMIT_POLICY } from '@zalo-shop/contracts';
import {
  AFTER_SALE_EVIDENCE_AGGREGATE_TYPE,
  AFTER_SALE_EVIDENCE_EXPIRE_EVENT,
  applyAfterSaleEvidenceScanResult,
  appendOutboxMessageInTransaction,
  beginAfterSaleEvidenceDeletion,
  claimAfterSaleEvidenceInTransaction,
  completeAfterSaleEvidenceDeletion,
  confirmAfterSaleEvidenceUpload,
  createRuntimePrismaClient,
  initializeAfterSaleEvidenceUpload,
  listAfterSaleEvidenceDeletionObjects,
  PrismaClient,
  recordAfterSaleEvidenceDeletionFailure,
  withAfterSaleEvidenceSystemTransaction,
  withStoreTransaction,
} from '@zalo-shop/database';
import {
  createAfterSaleEvidenceSystemContext,
  createStoreContext,
  type StoreContext,
} from '@zalo-shop/domain';
import { type AfterSaleEvidenceObjectStorageProvider } from '@zalo-shop/integrations';
import { signJwt } from '@zalo-shop/security';

import { AdminService } from '../../apps/api/src/admin/admin.service';
import { AFTER_SALE_EVIDENCE_STORAGE_PROVIDER } from '../../apps/api/src/after-sales-evidence/after-sales-evidence.tokens';

type StoreName = 'a' | 'b';
type MemberName = 'aOther' | 'aOwner' | 'bOwner';

type ReadyEvidence = Readonly<{
  afterSaleId: string;
  evidenceId: string;
  objectKey: string;
  ordinaryAccessDeadlineAt: Date;
  retentionDeadlineAt: Date;
  store: StoreName;
}>;

type ReadyUnclaimedEvidence = Readonly<{
  evidenceId: string;
  objectKey: string;
  store: StoreName;
}>;

type ConfirmedPendingEvidence = ReadyUnclaimedEvidence &
  Readonly<{
    scanGeneration: number;
    version: number;
  }>;

type ProtectedReadEvidence = Readonly<{
  afterSaleId: string;
  evidenceId: string;
  store: StoreName;
}>;

type TrackedObject = Readonly<{ evidenceId: string; objectKey: string; store: StoreName }>;

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function jpegBytes(): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]),
    Buffer.from('M6.3-B2b-D5 protected evidence read', 'ascii'),
  ]);
}

describe.sequential('M6.3-B2b-D5 protected evidence read API', () => {
  loadEnvironment({ path: '.env.test.example', quiet: true, override: true });
  const config = parseRuntimeConfig();
  const owner = new PrismaClient({ datasourceUrl: config.DATABASE_URL });
  const runtime = createRuntimePrismaClient(config.DATABASE_RUNTIME_URL);
  const suffix = randomUUID().slice(0, 8);
  const stores = {
    a: { code: `m63d5-a-${suffix}`, id: randomUUID() },
    b: { code: `m63d5-b-${suffix}`, id: randomUUID() },
  } as const;
  const members = {
    aOther: { id: randomUUID(), sessionId: randomUUID(), store: 'a' as const },
    aOwner: { id: randomUUID(), sessionId: randomUUID(), store: 'a' as const },
    bOwner: { id: randomUUID(), sessionId: randomUUID(), store: 'b' as const },
  } as const;
  const admins = {
    denied: { id: randomUUID(), roleId: randomUUID(), sessionId: randomUUID() },
    reader: { id: randomUUID(), roleId: randomUUID(), sessionId: randomUUID() },
    super: { id: randomUUID(), platformRoleId: randomUUID(), sessionId: randomUUID() },
  } as const;
  const evidenceIds = new Set<string>();
  const afterSaleIds = new Set<string>();
  const orderIds = new Set<string>();
  const trackedObjects: TrackedObject[] = [];
  const tokens = {} as Record<
    'aOther' | 'aOwner' | 'bOwner' | 'denied' | 'reader' | 'super',
    string
  >;
  let app: INestApplication;
  let limiterRedis: {
    del(...keys: string[]): Promise<number>;
    eval(...args: unknown[]): Promise<unknown>;
    set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  };
  let adminService: AdminService;
  let storage: AfterSaleEvidenceObjectStorageProvider;

  const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
  const api = () => request(app.getHttpServer() as Server);

  function memberContext(member: MemberName): StoreContext {
    const entry = members[member];
    const store = stores[entry.store];
    const accessExpiresAt = new Date(Date.now() + 60 * 60 * 1_000);
    return createStoreContext({
      accessSessionExpiresAt: accessExpiresAt,
      accessSessionId: entry.sessionId,
      accessTokenExpiresAt: accessExpiresAt,
      actor: { id: entry.id, type: 'member' },
      correlationId: randomUUID(),
      locale: 'vi',
      storeCode: store.code,
      storeId: store.id,
    });
  }

  function systemContext(store: StoreName) {
    return createAfterSaleEvidenceSystemContext({
      correlationId: randomUUID(),
      storeId: stores[store].id,
    });
  }

  function adminContext(store: StoreName): StoreContext {
    const accessExpiresAt = new Date(Date.now() + 60 * 60 * 1_000);
    return createStoreContext({
      accessSessionExpiresAt: accessExpiresAt,
      accessSessionId: admins.reader.sessionId,
      accessTokenExpiresAt: accessExpiresAt,
      adminAuthorizationScope: 'STORE',
      actor: { id: admins.reader.id, type: 'admin' },
      correlationId: randomUUID(),
      locale: 'vi',
      storeCode: stores[store].code,
      storeId: stores[store].id,
    });
  }

  function accessToken(input: {
    actorType: 'admin' | 'member';
    expiresAt?: Date;
    sessionId: string;
    storeId?: string;
    subjectId: string;
  }): string {
    const now = Math.floor(Date.now() / 1_000);
    const expiresAt =
      input.expiresAt === undefined ? now + 900 : Math.floor(input.expiresAt.getTime() / 1_000);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
      throw new Error('M6.3-B2b-D5 test access token expiry must be in the future');
    }
    return signJwt(
      {
        actor_type: input.actorType,
        aud: config.AUTH_JWT_AUDIENCE,
        exp: expiresAt,
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

  function memberHeaders(member: MemberName = 'aOwner') {
    const entry = members[member];
    return {
      Authorization: `Bearer ${tokens[member]}`,
      'X-Store-Code': stores[entry.store].code,
    };
  }

  function adminHeaders(
    admin: 'denied' | 'reader' | 'super' = 'reader',
    store: StoreName = 'a',
    extra: Record<string, string> = {},
  ) {
    return {
      Authorization: `Bearer ${tokens[admin]}`,
      'X-Store-Code': stores[store].code,
      ...extra,
    };
  }

  function protectedReadPath(evidence: Pick<ReadyEvidence, 'afterSaleId' | 'evidenceId'>): string {
    return `/v1/after-sales/${evidence.afterSaleId}/evidence/${evidence.evidenceId}`;
  }

  function adminProtectedReadPath(
    evidence: Pick<ReadyEvidence, 'afterSaleId' | 'evidenceId' | 'store'>,
  ): string {
    return `/v1/admin/after-sales/${evidence.afterSaleId}/evidence/${evidence.evidenceId}?store_id=${stores[evidence.store].id}`;
  }

  function rateLimitKey(member: MemberName, windowOffset = 0): string {
    const entry = members[member];
    const store = stores[entry.store];
    const window = Math.floor(Date.now() / 60_000) + windowOffset;
    const identity = createHmac('sha256', config.PII_HASH_KEY)
      .update(`MEMBER:${entry.id}`)
      .digest('hex');
    return `${config.NODE_ENV}:${store.id}:after-sale-read:member:${identity}:${window}`;
  }

  async function insertCase(context: StoreContext): Promise<string> {
    const afterSaleId = randomUUID();
    const orderId = randomUUID();
    afterSaleIds.add(afterSaleId);
    orderIds.add(orderId);
    await owner.order.create({
      data: {
        baseSubtotalVnd: 1_000,
        couponDiscountVnd: 0,
        currency: 'VND',
        id: orderId,
        itemDiscountVnd: 0,
        memberId: context.actor.id,
        orderDiscountVnd: 0,
        orderNumber: `M63-D5-${orderId.replaceAll('-', '').slice(0, 16).toUpperCase()}`,
        payableVnd: 1_000,
        paymentMethod: 'COD',
        paymentStatus: 'SUCCEEDED',
        quoteHash: digest(`d5-order-${orderId}`),
        remoteSurchargeVnd: 0,
        shippingDiscountVnd: 0,
        shippingFeeVnd: 0,
        status: 'PENDING_FULFILLMENT',
        storeId: context.storeId,
      },
    });
    // D5 needs a pre-existing case to exercise protected reads. B3 intentionally
    // forbids runtime callers from committing a bare case without command facts,
    // so keep this historical fixture on the owner-only test path.
    await withStoreTransaction(
      owner,
      context,
      (transaction) =>
        transaction.$executeRaw`
        INSERT INTO after_sales (
          id, store_id, order_id, member_id, public_case_number, type, status, source,
          reason_code, legacy_policy_review, idempotency_key_hash, request_hash,
          initiated_by, correlation_id, updated_at
        ) VALUES (
          ${afterSaleId}::uuid, ${context.storeId}::uuid, ${orderId}::uuid,
          ${context.actor.id}::uuid,
          ${`ASC-${afterSaleId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
          'REFUND_ONLY', 'REVIEW_REQUIRED', 'MEMBER', 'd5-evidence-read', true,
          ${digest(`d5-case-key-${afterSaleId}`)}, ${digest(`d5-case-request-${afterSaleId}`)},
          ${context.actor.id}::uuid, ${context.correlationId}, pg_catalog.clock_timestamp()
        )
      `,
    );
    return afterSaleId;
  }

  async function createConfirmedPendingEvidence(
    member: MemberName,
  ): Promise<ConfirmedPendingEvidence> {
    const context = memberContext(member);
    const body = jpegBytes();
    const checksumSha256 = createHash('sha256').update(body).digest('hex');
    const initialized = await initializeAfterSaleEvidenceUpload(runtime, context, {
      byteSize: body.byteLength,
      checksumSha256,
      deploymentEnvironment: 'test',
      filename: 'evidence.jpg',
      idempotencyKey: `m63d5-init-${randomUUID()}`,
      maxUnclaimedBytes: 200 * 1_024 * 1_024,
      maxUnclaimedFiles: 12,
      mimeType: 'image/jpeg',
      uploadTtlSeconds: 15 * 60,
    });
    evidenceIds.add(initialized.evidence.id);
    const target = await storage.createUploadTarget({
      byteSize: body.byteLength,
      checksumSha256,
      deploymentEnvironment: 'test',
      evidenceId: initialized.evidence.id,
      mimeType: 'image/jpeg',
      objectKey: initialized.objectKey,
      storeId: context.storeId,
    });
    const uploaded = await fetch(target.url, {
      body: Uint8Array.from(body),
      headers: target.headers,
      method: 'PUT',
    });
    expect(uploaded.status).toBeLessThan(300);
    trackedObjects.push({
      evidenceId: initialized.evidence.id,
      objectKey: initialized.objectKey,
      store: members[member].store,
    });
    const confirmed = await confirmAfterSaleEvidenceUpload(runtime, context, {
      evidenceId: initialized.evidence.id,
      expectedVersion: initialized.evidence.version,
      idempotencyKey: `m63d5-confirm-${randomUUID()}`,
    });
    if (!confirmed.evidence.objectKey || confirmed.evidence.status !== 'PENDING') {
      throw new Error('M6.3-B2b-D5 fixture did not retain confirmed PENDING evidence');
    }
    return {
      evidenceId: confirmed.evidence.id,
      objectKey: confirmed.evidence.objectKey,
      scanGeneration: confirmed.evidence.scanGeneration,
      store: members[member].store,
      version: confirmed.evidence.version,
    };
  }

  async function createReadyUnclaimedEvidence(member: MemberName): Promise<ReadyUnclaimedEvidence> {
    const pending = await createConfirmedPendingEvidence(member);
    const clean = await applyAfterSaleEvidenceScanResult(runtime, systemContext(pending.store), {
      claimTtlSeconds: 24 * 60 * 60,
      evidenceId: pending.evidenceId,
      expectedVersion: pending.version,
      failedRetentionSeconds: 24 * 60 * 60,
      result: {
        engine: 'clamav',
        engineVersion: '1.5.3',
        signatureVersion: 'm63d5-test',
        verdict: 'CLEAN',
      },
      scanGeneration: pending.scanGeneration,
    });
    if (!clean.evidence.objectKey || clean.evidence.status !== 'READY_UNCLAIMED') {
      throw new Error('M6.3-B2b-D5 fixture did not reach READY_UNCLAIMED');
    }
    return {
      evidenceId: clean.evidence.id,
      objectKey: clean.evidence.objectKey,
      store: pending.store,
    };
  }

  async function createReadyEvidence(
    member: MemberName,
    input: Readonly<{ ordinaryAccessTtlSeconds?: number; retentionTtlSeconds?: number }> = {},
  ): Promise<ReadyEvidence> {
    const context = memberContext(member);
    const unclaimed = await createReadyUnclaimedEvidence(member);
    const afterSaleId = await insertCase(context);
    const [claimed] = await withStoreTransaction(runtime, context, (transaction) =>
      claimAfterSaleEvidenceInTransaction(transaction, context, {
        afterSaleId,
        evidenceIds: [unclaimed.evidenceId],
        ordinaryAccessTtlSeconds: input.ordinaryAccessTtlSeconds ?? 180,
        retentionTtlSeconds: input.retentionTtlSeconds ?? 600,
      }),
    );
    if (!claimed?.objectKey || !claimed.ordinaryAccessDeadlineAt || !claimed.retentionDeadlineAt) {
      throw new Error('M6.3-B2b-D5 fixture did not reach claimed READY');
    }
    return {
      afterSaleId,
      evidenceId: claimed.id,
      objectKey: claimed.objectKey,
      ordinaryAccessDeadlineAt: claimed.ordinaryAccessDeadlineAt,
      retentionDeadlineAt: claimed.retentionDeadlineAt,
      store: members[member].store,
    };
  }

  async function waitUntil(deadline: Date): Promise<void> {
    const remainingMs = deadline.getTime() - Date.now();
    if (remainingMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, remainingMs + 25));
    }
  }

  function holdEvidenceWriteLock(evidence: ReadyEvidence): Readonly<{
    acquired: Promise<void>;
    complete: Promise<void>;
    release: () => void;
  }> {
    let rejectAcquired: (reason?: unknown) => void;
    let releaseLock: (() => void) | undefined;
    let signalAcquired: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const acquired = new Promise<void>((resolve, reject) => {
      signalAcquired = resolve;
      rejectAcquired = reject;
    });
    const complete = owner
      .$transaction(
        async (transaction) => {
          const rows = await transaction.$queryRaw<Array<{ id: string }>>`
            SELECT id
            FROM after_sale_evidence_files
            WHERE id = ${evidence.evidenceId}::uuid
            FOR UPDATE
          `;
          if (rows.length !== 1 || rows[0]?.id !== evidence.evidenceId) {
            throw new Error('M6.3-B2b-D5 expiry race fixture could not lock its evidence row');
          }
          signalAcquired?.();
          await released;
        },
        { timeout: 15_000 },
      )
      .catch((error: unknown) => {
        rejectAcquired(error);
        throw error;
      });
    return Object.freeze({
      acquired,
      complete,
      release: () => releaseLock?.(),
    });
  }

  async function assertFinalReadWaitsForExpiry<T>(
    input: Readonly<{
      deadline: Date;
      request: Promise<T>;
      signingCompleted: Promise<void>;
    }>,
  ): Promise<void> {
    let completed = false;
    void input.request.then(
      () => {
        completed = true;
      },
      () => {
        completed = true;
      },
    );
    await input.signingCompleted;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(completed).toBe(false);
    await waitUntil(input.deadline);
  }

  async function placeLegalHold(evidence: ReadyEvidence): Promise<void> {
    const context = adminContext(evidence.store);
    await withStoreTransaction(
      owner,
      context,
      (transaction) =>
        transaction.$executeRaw`
        UPDATE after_sale_evidence_files
        SET legal_hold_active = true, held_at = pg_catalog.clock_timestamp(),
          held_by = ${context.actor.id}::uuid, hold_reason = 'D5 legal hold race fixture',
          version = version + 1, updated_at = pg_catalog.clock_timestamp()
        WHERE store_id = ${context.storeId}::uuid AND id = ${evidence.evidenceId}::uuid
      `,
    );
  }

  async function quarantineReadyEvidence(
    evidence: ReadyEvidence,
    resultCode: string,
  ): Promise<void> {
    const current = await owner.afterSaleEvidenceFile.findUniqueOrThrow({
      select: { version: true },
      where: { id: evidence.evidenceId },
    });
    const context = systemContext(evidence.store);
    const quarantined = await withAfterSaleEvidenceSystemTransaction(
      runtime,
      context,
      async (transaction) => {
        const rows = await transaction.$queryRaw<
          Array<{
            ordinary_access_deadline_at: Date | null;
            retention_deadline_at: Date;
            status: string;
            version: number;
          }>
        >`
          WITH scan_clock AS (SELECT pg_catalog.clock_timestamp() AS value)
          UPDATE after_sale_evidence_files
          SET status = 'QUARANTINED', scan_result_code = ${resultCode},
            scan_completed_at = scan_clock.value, scanner_engine = 'clamav',
            scanner_engine_version = '1.5.3', scanner_signature_version = 'm63d5-quarantine',
            version = after_sale_evidence_files.version + 1, updated_at = scan_clock.value
          FROM scan_clock
          WHERE after_sale_evidence_files.store_id = ${stores[evidence.store].id}::uuid
            AND after_sale_evidence_files.id = ${evidence.evidenceId}::uuid
            AND after_sale_evidence_files.status = 'READY'
            AND after_sale_evidence_files.version = ${current.version}
          RETURNING after_sale_evidence_files.status,
            after_sale_evidence_files.ordinary_access_deadline_at,
            after_sale_evidence_files.retention_deadline_at,
            after_sale_evidence_files.version
        `;
        const updated = rows[0];
        if (!updated) {
          throw new Error('M6.3-B2b-D5 fixture could not quarantine READY evidence');
        }
        await appendOutboxMessageInTransaction(transaction, context, {
          aggregateId: evidence.evidenceId,
          aggregateType: AFTER_SALE_EVIDENCE_AGGREGATE_TYPE,
          availableAt: updated.retention_deadline_at,
          eventType: AFTER_SALE_EVIDENCE_EXPIRE_EVENT,
          eventVersion: 1,
          idempotencyKey: `${AFTER_SALE_EVIDENCE_EXPIRE_EVENT}:${evidence.evidenceId}:${updated.version}`,
          maxAttempts: 3,
          payload: {
            evidence_id: evidence.evidenceId,
            expected_version: updated.version,
            store_id: stores[evidence.store].id,
          },
        });
        return updated;
      },
    );
    if (
      quarantined.status !== 'QUARANTINED' ||
      quarantined.ordinary_access_deadline_at === null ||
      quarantined.ordinary_access_deadline_at.getTime() <= Date.now()
    ) {
      throw new Error('M6.3-B2b-D5 fixture did not reach live-window QUARANTINED');
    }
  }

  async function beginDueD4Deletion(evidence: ReadyEvidence): Promise<void> {
    await waitUntil(evidence.retentionDeadlineAt);
    const current = await owner.afterSaleEvidenceFile.findUniqueOrThrow({
      select: { version: true },
      where: { id: evidence.evidenceId },
    });
    const begun = await beginAfterSaleEvidenceDeletion(runtime, systemContext(evidence.store), {
      evidenceId: evidence.evidenceId,
      expectedVersion: current.version,
    });
    if (begun.outcome !== 'READY' || begun.evidence.status !== 'DELETION_PENDING') {
      throw new Error('M6.3-B2b-D5 fixture did not reach D4 DELETION_PENDING');
    }
  }

  async function failDueD4Deletion(evidence: ReadyEvidence): Promise<void> {
    await beginDueD4Deletion(evidence);
    const current = await owner.afterSaleEvidenceFile.findUniqueOrThrow({
      select: { version: true },
      where: { id: evidence.evidenceId },
    });
    const failed = await recordAfterSaleEvidenceDeletionFailure(
      runtime,
      systemContext(evidence.store),
      {
        baseDelayMs: 60_000,
        errorCode: 'PROVIDER_UNAVAILABLE',
        evidenceId: evidence.evidenceId,
        expectedVersion: current.version,
        maxAttempts: 8,
        maxDelayMs: 6 * 60 * 60 * 1_000,
      },
    );
    if (failed.status !== 'DELETE_FAILED') {
      throw new Error('M6.3-B2b-D5 fixture did not reach D4 DELETE_FAILED');
    }
  }

  async function completeDueD4Deletion(evidence: ReadyEvidence): Promise<void> {
    await beginDueD4Deletion(evidence);
    const current = await owner.afterSaleEvidenceFile.findUniqueOrThrow({
      select: { version: true },
      where: { id: evidence.evidenceId },
    });
    const objects = await listAfterSaleEvidenceDeletionObjects(
      runtime,
      systemContext(evidence.store),
      {
        evidenceId: evidence.evidenceId,
        expectedVersion: current.version,
      },
    );
    if (objects.length !== 1 || objects[0]?.objectKey !== evidence.objectKey) {
      throw new Error('M6.3-B2b-D5 fixture did not retain exactly one ORIGINAL for D4 deletion');
    }
    await storage.removeObject({
      deploymentEnvironment: 'test',
      evidenceId: evidence.evidenceId,
      objectKey: evidence.objectKey,
      objectRole: 'ORIGINAL',
      storeId: stores[evidence.store].id,
    });
    await completeAfterSaleEvidenceDeletion(runtime, systemContext(evidence.store), {
      evidenceId: evidence.evidenceId,
      expectedVersion: current.version,
      objects: objects.map(({ id, version }) => ({ expectedVersion: version, id })),
    });
  }

  beforeAll(async () => {
    if (
      !config.AFTER_SALE_EVIDENCE_PROTECTED_READS_ENABLED ||
      !config.AFTER_SALE_EVIDENCE_DELETION_WORKER_ENABLED ||
      config.EVIDENCE_STORAGE_PROVIDER !== 's3'
    ) {
      throw new Error('M6.3-B2b-D5 local protected-read configuration is incomplete');
    }
    await Promise.all([owner.$connect(), runtime.$connect()]);
    const sessionExpiry = new Date(Date.now() + 60 * 60 * 1_000);
    await owner.$transaction(async (transaction) => {
      await transaction.adminUser.createMany({
        data: [
          ...Object.values(admins).map((admin) => ({
            displayName: 'M6.3-B2b-D5 administrator',
            email: `m63d5-${admin.id}@example.invalid`,
            emailNormalized: `m63d5-${admin.id}@example.invalid`,
            id: admin.id,
            passwordHash: 'test-fixture-not-a-login-hash',
          })),
        ],
      });
      await transaction.store.createMany({
        data: [
          { code: stores.a.code, id: stores.a.id, industry: 'BEAUTY' },
          { code: stores.b.code, id: stores.b.id, industry: 'FASHION' },
        ],
      });
      await transaction.member.createMany({
        data: Object.values(members).map((member) => ({
          displayName: 'M6.3-B2b-D5 evidence member',
          id: member.id,
          storeId: stores[member.store].id,
        })),
      });
      await transaction.memberSession.createMany({
        data: Object.values(members).map((member) => ({
          expiresAt: sessionExpiry,
          id: member.sessionId,
          memberId: member.id,
          refreshTokenHash: digest(`m63d5-member-session-${member.id}`),
          storeId: stores[member.store].id,
          tokenFamilyId: randomUUID(),
        })),
      });
      await transaction.adminSession.createMany({
        data: Object.values(admins).map((admin) => ({
          adminUserId: admin.id,
          expiresAt: sessionExpiry,
          id: admin.sessionId,
          mfaVerifiedAt: new Date(),
          refreshTokenHash: digest(`m63d5-admin-session-${admin.id}`),
          tokenFamilyId: randomUUID(),
        })),
      });
      await transaction.storeRole.createMany({
        data: [
          {
            code: `m63d5-reader-${suffix}`,
            id: admins.reader.roleId,
            name: 'M6.3-B2b-D5 reader',
            storeId: stores.a.id,
          },
          {
            code: `m63d5-denied-${suffix}`,
            id: admins.denied.roleId,
            name: 'M6.3-B2b-D5 denied',
            storeId: stores.a.id,
          },
        ],
      });
      await transaction.storeRolePermission.create({
        data: {
          permissionCode: 'store.after-sales.evidence.read',
          roleId: admins.reader.roleId,
          storeId: stores.a.id,
        },
      });
      await transaction.adminStoreRole.createMany({
        data: [
          {
            adminUserId: admins.reader.id,
            grantedBy: admins.reader.id,
            roleId: admins.reader.roleId,
            storeId: stores.a.id,
          },
          {
            adminUserId: admins.denied.id,
            grantedBy: admins.denied.id,
            roleId: admins.denied.roleId,
            storeId: stores.a.id,
          },
        ],
      });
      await transaction.platformRole.create({
        data: {
          code: `m63d5-super-${suffix}`,
          id: admins.super.platformRoleId,
          name: 'M6.3-B2b-D5 cross-store reader',
          permissions: { create: [{ permissionCode: 'platform.stores.cross_access' }] },
        },
      });
      await transaction.adminPlatformRole.create({
        data: {
          adminUserId: admins.super.id,
          grantedBy: admins.super.id,
          platformRoleId: admins.super.platformRoleId,
        },
      });
    });
    for (const [name, member] of Object.entries(members) as Array<
      [MemberName, (typeof members)[MemberName]]
    >) {
      tokens[name] = accessToken({
        actorType: 'member',
        sessionId: member.sessionId,
        storeId: stores[member.store].id,
        subjectId: member.id,
      });
    }
    for (const [name, admin] of Object.entries(admins) as Array<
      ['denied' | 'reader' | 'super', (typeof admins)['denied' | 'reader' | 'super']]
    >) {
      tokens[name] = accessToken({
        actorType: 'admin',
        sessionId: admin.sessionId,
        subjectId: admin.id,
      });
    }
    const [{ AppModule }, { ApiExceptionFilter }, { AfterSalesRateLimiter }] = await Promise.all([
      import('../../apps/api/src/app.module'),
      import('../../apps/api/src/api-exception.filter'),
      import('../../apps/api/src/after-sales/after-sales-rate-limiter'),
    ]);
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    storage = app.get(AFTER_SALE_EVIDENCE_STORAGE_PROVIDER);
    adminService = app.get(AdminService);
    limiterRedis = (app.get(AfterSalesRateLimiter) as unknown as { redis: typeof limiterRedis })
      .redis;
  });

  afterAll(async () => {
    for (const object of trackedObjects) {
      await storage
        ?.removeObject({
          deploymentEnvironment: 'test',
          evidenceId: object.evidenceId,
          objectKey: object.objectKey,
          objectRole: 'ORIGINAL',
          storeId: stores[object.store].id,
        })
        .catch(() => undefined);
    }
    const limiterKeys = (Object.keys(members) as MemberName[]).flatMap((member) =>
      [-1, 0, 1].map((offset) => rateLimitKey(member, offset)),
    );
    await limiterRedis?.del(...limiterKeys);
    await app?.close();
    await runtime.$disconnect();
    await owner.$transaction(async (transaction) => {
      // Audit records are append-only in every runtime context; test cleanup is the sole exception.
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.auditLog.deleteMany({
        where: { storeId: { in: [stores.a.id, stores.b.id] } },
      });
      await transaction.afterSaleEvidenceTransition.deleteMany({
        where: { evidenceFileId: { in: [...evidenceIds] } },
      });
      await transaction.afterSaleEvidenceObject.deleteMany({
        where: { evidenceFileId: { in: [...evidenceIds] } },
      });
      await transaction.outboxMessage.deleteMany({
        where: { aggregateId: { in: [...evidenceIds] }, aggregateType: 'AFTER_SALE_EVIDENCE' },
      });
      await transaction.idempotencyRecord.deleteMany({
        where: { storeId: { in: [stores.a.id, stores.b.id] } },
      });
      await transaction.afterSaleEvidenceFile.deleteMany({
        where: { id: { in: [...evidenceIds] } },
      });
      await transaction.afterSale.deleteMany({ where: { id: { in: [...afterSaleIds] } } });
      await transaction.order.deleteMany({ where: { id: { in: [...orderIds] } } });
      await transaction.memberSession.deleteMany({
        where: { id: { in: Object.values(members).map((member) => member.sessionId) } },
      });
      await transaction.member.deleteMany({
        where: { id: { in: Object.values(members).map((member) => member.id) } },
      });
      await transaction.adminStoreRole.deleteMany({
        where: { adminUserId: { in: Object.values(admins).map((admin) => admin.id) } },
      });
      await transaction.adminPlatformRole.deleteMany({
        where: { platformRoleId: admins.super.platformRoleId },
      });
      await transaction.platformRolePermission.deleteMany({
        where: { platformRoleId: admins.super.platformRoleId },
      });
      await transaction.platformRole.deleteMany({ where: { id: admins.super.platformRoleId } });
      await transaction.storeRolePermission.deleteMany({
        where: { roleId: { in: [admins.reader.roleId, admins.denied.roleId] } },
      });
      await transaction.storeRole.deleteMany({
        where: { id: { in: [admins.reader.roleId, admins.denied.roleId] } },
      });
      await transaction.adminSession.deleteMany({
        where: { id: { in: Object.values(admins).map((admin) => admin.sessionId) } },
      });
      await transaction.adminUser.deleteMany({
        where: { id: { in: Object.values(admins).map((admin) => admin.id) } },
      });
      await transaction.store.deleteMany({ where: { id: { in: [stores.a.id, stores.b.id] } } });
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });
    await owner.$disconnect();
  });

  it('issues a real bounded member URL while hiding member, case and store boundaries', async () => {
    const evidence = await createReadyEvidence('aOwner');
    const response = await api()
      .get(protectedReadPath(evidence))
      .set({ ...memberHeaders(), 'X-Correlation-Id': 'm63d5-member-read' });
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-correlation-id']).toMatch(UUID_V4_PATTERN);
    expect(response.headers['x-correlation-id']).not.toBe('m63d5-member-read');
    expect(response.body).toEqual({
      expires_at: expect.any(String),
      url: expect.stringMatching(/^https?:\/\//u),
    });
    const expiresAt = new Date(response.body.expires_at as string);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(expiresAt.getTime()).toBeLessThan(evidence.ordinaryAccessDeadlineAt.getTime());

    const downloaded = await fetch(response.body.url as string);
    expect(downloaded.status).toBeLessThan(300);
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(jpegBytes());

    const deniedRequests = [
      () => api().get(protectedReadPath(evidence)).set(memberHeaders('aOther')),
      () =>
        api()
          .get(`/v1/after-sales/${randomUUID()}/evidence/${evidence.evidenceId}`)
          .set(memberHeaders()),
      () => api().get(protectedReadPath(evidence)).set(memberHeaders('bOwner')),
    ];
    for (const requestDeniedRead of deniedRequests) {
      const denied = await requestDeniedRead();
      expect(denied.status).toBe(404);
      expect(denied.body.code).toBe('RESOURCE_NOT_FOUND');
      expect(JSON.stringify(denied.body)).not.toMatch(
        /object_key|checksum|bucket|scanner|secret/iu,
      );
    }
    const strictQuery = await api()
      .get(`${protectedReadPath(evidence)}?include=internal`)
      .set(memberHeaders());
    expect(strictQuery.status).toBe(400);
  });

  it('uses a scoped guard lock without granting the runtime role direct evidence locking', async () => {
    const evidence = await createReadyEvidence('aOwner');
    const targetExpiresAt = new Date(evidence.ordinaryAccessDeadlineAt.getTime() - 1_000);

    const directLock = await withStoreTransaction(
      runtime,
      memberContext('aOwner'),
      (transaction) =>
        transaction.$queryRaw<Array<{ id: string }>>`
          SELECT id
          FROM after_sale_evidence_files
          WHERE store_id = ${stores.a.id}::uuid AND id = ${evidence.evidenceId}::uuid
          FOR SHARE
        `,
    );
    expect(directLock).toEqual([]);

    await expect(
      withStoreTransaction(
        runtime,
        memberContext('aOwner'),
        (transaction) =>
          transaction.$queryRaw<Array<{ id: string }>>`
          SELECT id
          FROM app_security.lock_m63_b2b_protected_evidence_read(
            ${evidence.evidenceId}::uuid,
            ${evidence.afterSaleId}::uuid,
            ${targetExpiresAt}::timestamptz
          )
        `,
      ),
    ).rejects.toThrow(/42501|permission denied/iu);

    const locked = await withStoreTransaction(
      runtime,
      memberContext('aOwner'),
      (transaction) =>
        transaction.$queryRaw<Array<{ id: string }>>`
        SELECT id
        FROM app_security.lock_m63_b2b_protected_evidence_read_authorized(
          ${evidence.evidenceId}::uuid,
          ${evidence.afterSaleId}::uuid,
          ${targetExpiresAt}::timestamptz
        )
      `,
    );
    expect(locked).toEqual([{ id: evidence.evidenceId }]);

    const beforeGuardUpdate = await owner.afterSaleEvidenceFile.findUniqueOrThrow({
      select: { id: true, version: true },
      where: { id: evidence.evidenceId },
    });
    await expect(
      owner.$transaction(async (transaction) => {
        await transaction.$executeRaw`SET LOCAL ROLE zalo_shop_evidence_read_guard`;
        await transaction.$executeRaw`
          SELECT
            set_config('app.store_id', ${stores.a.id}, true),
            set_config('app.actor_type', 'member', true),
            set_config('app.actor_id', ${members.aOwner.id}, true)
        `;
        await transaction.$executeRaw`
          UPDATE after_sale_evidence_files
          SET id = id
          WHERE store_id = ${stores.a.id}::uuid AND id = ${evidence.evidenceId}::uuid
        `;
      }),
    ).rejects.toThrow(/42501|row-level security policy/iu);
    await expect(
      owner.afterSaleEvidenceFile.findUniqueOrThrow({
        select: { id: true, version: true },
        where: { id: evidence.evidenceId },
      }),
    ).resolves.toEqual(beforeGuardUpdate);
    await expect(
      owner.$transaction(async (transaction) => {
        await transaction.$executeRaw`SET LOCAL ROLE zalo_shop_evidence_read_guard`;
        await transaction.$executeRaw`
          SELECT
            set_config('app.store_id', ${stores.a.id}, true),
            set_config('app.actor_type', 'member', true),
            set_config('app.actor_id', ${members.aOwner.id}, true)
        `;
        await transaction.$queryRaw`
          SELECT checksum_sha256
          FROM after_sale_evidence_files
          WHERE store_id = ${stores.a.id}::uuid AND id = ${evidence.evidenceId}::uuid
        `;
      }),
    ).rejects.toThrow(/42501|permission denied/iu);

    const [wrongCase, wrongMember, wrongStore, objectLedger] = await Promise.all([
      withStoreTransaction(
        runtime,
        memberContext('aOwner'),
        (transaction) =>
          transaction.$queryRaw<Array<{ id: string }>>`
          SELECT id
          FROM app_security.lock_m63_b2b_protected_evidence_read_authorized(
            ${evidence.evidenceId}::uuid,
            ${randomUUID()}::uuid,
            ${targetExpiresAt}::timestamptz
          )
        `,
      ),
      withStoreTransaction(
        runtime,
        memberContext('aOther'),
        (transaction) =>
          transaction.$queryRaw<Array<{ id: string }>>`
          SELECT id
          FROM app_security.lock_m63_b2b_protected_evidence_read_authorized(
            ${evidence.evidenceId}::uuid,
            ${evidence.afterSaleId}::uuid,
            ${targetExpiresAt}::timestamptz
          )
        `,
      ),
      withStoreTransaction(
        runtime,
        memberContext('bOwner'),
        (transaction) =>
          transaction.$queryRaw<Array<{ id: string }>>`
          SELECT id
          FROM app_security.lock_m63_b2b_protected_evidence_read_authorized(
            ${evidence.evidenceId}::uuid,
            ${evidence.afterSaleId}::uuid,
            ${targetExpiresAt}::timestamptz
          )
        `,
      ),
      withStoreTransaction(
        runtime,
        memberContext('aOwner'),
        (transaction) =>
          transaction.$queryRaw<Array<{ id: string }>>`
          SELECT id
          FROM after_sale_evidence_objects
          WHERE store_id = ${stores.a.id}::uuid
            AND evidence_file_id = ${evidence.evidenceId}::uuid
        `,
      ),
    ]);
    expect(wrongCase).toEqual([]);
    expect(wrongMember).toEqual([]);
    expect(wrongStore).toEqual([]);
    expect(objectLedger).toEqual([]);

    let releaseLock: (() => void) | undefined;
    let signalLock: (() => void) | undefined;
    const lockReleased = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const lockAcquired = new Promise<void>((resolve) => {
      signalLock = resolve;
    });
    const heldLock = withStoreTransaction(runtime, memberContext('aOwner'), async (transaction) => {
      const rows = await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT id
        FROM app_security.lock_m63_b2b_protected_evidence_read_authorized(
          ${evidence.evidenceId}::uuid,
          ${evidence.afterSaleId}::uuid,
          ${targetExpiresAt}::timestamptz
        )
      `;
      if (rows.length !== 1 || rows[0]?.id !== evidence.evidenceId) {
        throw new Error('D5 guard did not acquire the expected protected-read lock');
      }
      signalLock?.();
      await lockReleased;
    });
    await lockAcquired;
    try {
      await expect(
        withAfterSaleEvidenceSystemTransaction(
          runtime,
          systemContext('a'),
          async (transaction) => {
            await transaction.$executeRaw`SET LOCAL lock_timeout = '250ms'`;
            await transaction.$executeRaw`
              WITH lock_clock AS (SELECT pg_catalog.clock_timestamp() AS value)
              UPDATE after_sale_evidence_files
              SET status = 'QUARANTINED', scan_result_code = 'D5_LOCK_TEST',
                scan_completed_at = lock_clock.value, scanner_engine = 'clamav',
                scanner_engine_version = '1.5.3', scanner_signature_version = 'd5-lock-test',
                version = after_sale_evidence_files.version + 1,
                updated_at = lock_clock.value
              FROM lock_clock
              WHERE after_sale_evidence_files.store_id = ${stores.a.id}::uuid
                AND after_sale_evidence_files.id = ${evidence.evidenceId}::uuid
            `;
          },
          { isolationLevel: 'ReadCommitted', timeout: 15_000 },
        ),
      ).rejects.toThrow(/55P03|lock timeout/iu);
    } finally {
      releaseLock?.();
      await heldLock;
    }

    const adminEvidence = await createReadyEvidence('aOwner');
    const adminTargetExpiresAt = new Date(adminEvidence.ordinaryAccessDeadlineAt.getTime() - 1_000);
    let releaseAuthorizationLock: (() => void) | undefined;
    let signalAuthorizationLock: (() => void) | undefined;
    const authorizationLockReleased = new Promise<void>((resolve) => {
      releaseAuthorizationLock = resolve;
    });
    const authorizationLockAcquired = new Promise<void>((resolve) => {
      signalAuthorizationLock = resolve;
    });
    const heldAuthorizationLock = withStoreTransaction(
      runtime,
      adminContext('a'),
      async (transaction) => {
        const rows = await transaction.$queryRaw<Array<{ id: string }>>`
          SELECT id
          FROM app_security.lock_m63_b2b_protected_evidence_read_authorized(
            ${adminEvidence.evidenceId}::uuid,
            ${adminEvidence.afterSaleId}::uuid,
            ${adminTargetExpiresAt}::timestamptz
          )
        `;
        if (rows.length !== 1 || rows[0]?.id !== adminEvidence.evidenceId) {
          throw new Error('D5 guard did not acquire the expected authorization locks');
        }
        signalAuthorizationLock?.();
        await authorizationLockReleased;
      },
    );
    await authorizationLockAcquired;
    try {
      await expect(
        owner.$transaction(async (transaction) => {
          await transaction.$executeRaw`SET LOCAL lock_timeout = '250ms'`;
          await transaction.storeRolePermission.delete({
            where: {
              storeId_roleId_permissionCode: {
                permissionCode: 'store.after-sales.evidence.read',
                roleId: admins.reader.roleId,
                storeId: stores.a.id,
              },
            },
          });
        }),
      ).rejects.toThrow(/55P03|lock timeout/iu);
    } finally {
      releaseAuthorizationLock?.();
      await heldAuthorizationLock;
    }
    await expect(
      owner.storeRolePermission.count({
        where: {
          permissionCode: 'store.after-sales.evidence.read',
          roleId: admins.reader.roleId,
          storeId: stores.a.id,
        },
      }),
    ).resolves.toBe(1);
  });

  it('returns one opaque not-found result for unclaimed, expired and deletion lifecycle facts', async () => {
    const unclaimed = {
      ...(await createReadyUnclaimedEvidence('aOwner')),
      afterSaleId: await insertCase(memberContext('aOwner')),
    };
    const expired = await createReadyEvidence('aOwner', {
      ordinaryAccessTtlSeconds: 1,
      retentionTtlSeconds: 10,
    });
    await waitUntil(expired.ordinaryAccessDeadlineAt);
    const deleting = await createReadyEvidence('aOwner', {
      ordinaryAccessTtlSeconds: 1,
      retentionTtlSeconds: 2,
    });
    await beginDueD4Deletion(deleting);
    const deleted = await createReadyEvidence('aOwner', {
      ordinaryAccessTtlSeconds: 1,
      retentionTtlSeconds: 2,
    });
    await completeDueD4Deletion(deleted);

    for (const evidence of [unclaimed, expired, deleting, deleted]) {
      const response = await api().get(protectedReadPath(evidence)).set(memberHeaders());
      expect(response.status).toBe(404);
      expect(response.body.code).toBe('RESOURCE_NOT_FOUND');
    }
  }, 15_000);

  it('returns one opaque not-found result for every unavailable evidence status', async () => {
    const pendingSource = await createConfirmedPendingEvidence('aOwner');
    const pending: ProtectedReadEvidence = {
      afterSaleId: await insertCase(memberContext('aOwner')),
      evidenceId: pendingSource.evidenceId,
      store: pendingSource.store,
    };

    const failedSource = await createConfirmedPendingEvidence('aOwner');
    const failedResult = await applyAfterSaleEvidenceScanResult(
      runtime,
      systemContext(failedSource.store),
      {
        claimTtlSeconds: 24 * 60 * 60,
        evidenceId: failedSource.evidenceId,
        expectedVersion: failedSource.version,
        failedRetentionSeconds: 24 * 60 * 60,
        result: { code: 'SCANNER_UNAVAILABLE', verdict: 'INDETERMINATE' },
        scanGeneration: failedSource.scanGeneration,
      },
    );
    if (failedResult.evidence.status !== 'FAILED') {
      throw new Error('M6.3-B2b-D5 fixture did not reach FAILED');
    }
    const failed: ProtectedReadEvidence = {
      afterSaleId: await insertCase(memberContext('aOwner')),
      evidenceId: failedSource.evidenceId,
      store: failedSource.store,
    };

    const quarantined = await createReadyEvidence('aOwner');
    await quarantineReadyEvidence(quarantined, 'D5_UNAVAILABLE_STATE');

    const deleteFailed = await createReadyEvidence('aOwner', {
      ordinaryAccessTtlSeconds: 1,
      retentionTtlSeconds: 2,
    });
    await failDueD4Deletion(deleteFailed);

    const cases = [
      { evidence: pending, status: 'PENDING' },
      { evidence: failed, status: 'FAILED' },
      { evidence: quarantined, status: 'QUARANTINED' },
      { evidence: deleteFailed, status: 'DELETE_FAILED' },
    ] as const;
    const signer = vi.spyOn(storage, 'createProtectedReadTarget');
    try {
      for (const entry of cases) {
        const stored = await owner.afterSaleEvidenceFile.findUniqueOrThrow({
          select: { ordinaryAccessDeadlineAt: true, status: true },
          where: { id: entry.evidence.evidenceId },
        });
        expect(stored.status).toBe(entry.status);
        if (entry.status === 'QUARANTINED') {
          expect(stored.ordinaryAccessDeadlineAt?.getTime()).toBeGreaterThan(Date.now());
        }

        const response = await api().get(protectedReadPath(entry.evidence)).set(memberHeaders());
        expect(response.status).toBe(404);
        expect(response.body.code).toBe('RESOURCE_NOT_FOUND');
        expect(response.body).not.toHaveProperty('url');
      }
      expect(signer).not.toHaveBeenCalled();
    } finally {
      signer.mockRestore();
    }
  }, 30_000);

  it('allows a legal-hold-only change but rejects a D4 deletion transition during signing', async () => {
    const held = await createReadyEvidence('aOwner');
    const originalCreateTarget = storage.createProtectedReadTarget.bind(storage);
    const holdSpy = vi
      .spyOn(storage, 'createProtectedReadTarget')
      .mockImplementationOnce(async (input) => {
        const target = await originalCreateTarget(input);
        await placeLegalHold(held);
        return target;
      });
    try {
      const response = await api().get(protectedReadPath(held)).set(memberHeaders());
      expect(response.status).toBe(200);
    } finally {
      holdSpy.mockRestore();
    }

    const deleting = await createReadyEvidence('aOwner', {
      ordinaryAccessTtlSeconds: 1,
      retentionTtlSeconds: 2,
    });
    const deletionSpy = vi
      .spyOn(storage, 'createProtectedReadTarget')
      .mockImplementationOnce(async (input) => {
        const target = await originalCreateTarget(input);
        await beginDueD4Deletion(deleting);
        return target;
      });
    try {
      const response = await api().get(protectedReadPath(deleting)).set(memberHeaders());
      expect(response.status).toBe(404);
      expect(response.body.code).toBe('RESOURCE_NOT_FOUND');
    } finally {
      deletionSpy.mockRestore();
    }
  });

  it('rejects a live READY-to-QUARANTINED transition during signing', async () => {
    const evidence = await createReadyEvidence('aOwner');
    expect(evidence.ordinaryAccessDeadlineAt.getTime()).toBeGreaterThan(Date.now());
    const originalCreateTarget = storage.createProtectedReadTarget.bind(storage);
    const signer = vi
      .spyOn(storage, 'createProtectedReadTarget')
      .mockImplementationOnce(async (input) => {
        const target = await originalCreateTarget(input);
        await quarantineReadyEvidence(evidence, 'D5_SIGNING_RACE');
        expect(evidence.ordinaryAccessDeadlineAt.getTime()).toBeGreaterThan(Date.now());
        return target;
      });
    try {
      const response = await api().get(protectedReadPath(evidence)).set(memberHeaders());
      expect(response.status).toBe(404);
      expect(response.body.code).toBe('RESOURCE_NOT_FOUND');
      expect(response.body).not.toHaveProperty('url');
      expect(signer).toHaveBeenCalledOnce();
    } finally {
      signer.mockRestore();
    }
  });

  it('revalidates and locks authorization facts after signing before issuing a URL', async () => {
    const originalCreateTarget = storage.createProtectedReadTarget.bind(storage);

    const memberEvidence = await createReadyEvidence('aOwner');
    const memberSessionSpy = vi
      .spyOn(storage, 'createProtectedReadTarget')
      .mockImplementationOnce(async (input) => {
        const target = await originalCreateTarget(input);
        await owner.memberSession.update({
          data: { revokedAt: new Date() },
          where: { id: members.aOwner.sessionId },
        });
        return target;
      });
    try {
      const response = await api().get(protectedReadPath(memberEvidence)).set(memberHeaders());
      expect(response.status).toBe(404);
      expect(response.body).not.toHaveProperty('url');
    } finally {
      memberSessionSpy.mockRestore();
      await owner.memberSession.update({
        data: { revokedAt: null },
        where: { id: members.aOwner.sessionId },
      });
    }

    const disabledStoreEvidence = await createReadyEvidence('aOwner');
    const disabledStoreSpy = vi
      .spyOn(storage, 'createProtectedReadTarget')
      .mockImplementationOnce(async (input) => {
        const target = await originalCreateTarget(input);
        await owner.store.update({ data: { status: 'DISABLED' }, where: { id: stores.a.id } });
        return target;
      });
    try {
      const response = await api()
        .get(protectedReadPath(disabledStoreEvidence))
        .set(memberHeaders());
      expect(response.status).toBe(404);
      expect(response.body).not.toHaveProperty('url');
    } finally {
      disabledStoreSpy.mockRestore();
      await owner.store.update({ data: { status: 'ACTIVE' }, where: { id: stores.a.id } });
    }

    const disabledMemberEvidence = await createReadyEvidence('aOwner');
    const disabledMemberSpy = vi
      .spyOn(storage, 'createProtectedReadTarget')
      .mockImplementationOnce(async (input) => {
        const target = await originalCreateTarget(input);
        await owner.member.update({
          data: { status: 'DISABLED' },
          where: { storeId_id: { id: members.aOwner.id, storeId: stores.a.id } },
        });
        return target;
      });
    try {
      const response = await api()
        .get(protectedReadPath(disabledMemberEvidence))
        .set(memberHeaders());
      expect(response.status).toBe(404);
      expect(response.body).not.toHaveProperty('url');
    } finally {
      disabledMemberSpy.mockRestore();
      await owner.member.update({
        data: { status: 'ACTIVE' },
        where: { storeId_id: { id: members.aOwner.id, storeId: stores.a.id } },
      });
    }

    const disabledAdminEvidence = await createReadyEvidence('aOwner');
    const disabledAdminSpy = vi
      .spyOn(storage, 'createProtectedReadTarget')
      .mockImplementationOnce(async (input) => {
        const target = await originalCreateTarget(input);
        await owner.adminUser.update({
          data: { status: 'DISABLED' },
          where: { id: admins.reader.id },
        });
        return target;
      });
    try {
      const response = await api()
        .get(adminProtectedReadPath(disabledAdminEvidence))
        .set(adminHeaders('reader'));
      expect(response.status).toBe(404);
      expect(response.body).not.toHaveProperty('url');
    } finally {
      disabledAdminSpy.mockRestore();
      await owner.adminUser.update({
        data: { status: 'ACTIVE' },
        where: { id: admins.reader.id },
      });
    }

    const revokedAdminSessionEvidence = await createReadyEvidence('aOwner');
    const revokedAdminSessionSpy = vi
      .spyOn(storage, 'createProtectedReadTarget')
      .mockImplementationOnce(async (input) => {
        const target = await originalCreateTarget(input);
        await owner.adminSession.update({
          data: { revokedAt: new Date() },
          where: { id: admins.reader.sessionId },
        });
        return target;
      });
    try {
      const response = await api()
        .get(adminProtectedReadPath(revokedAdminSessionEvidence))
        .set(adminHeaders('reader'));
      expect(response.status).toBe(404);
      expect(response.body).not.toHaveProperty('url');
    } finally {
      revokedAdminSessionSpy.mockRestore();
      await owner.adminSession.update({
        data: { revokedAt: null },
        where: { id: admins.reader.sessionId },
      });
    }

    const directAdminEvidence = await createReadyEvidence('aOwner');
    const directRoleSpy = vi
      .spyOn(storage, 'createProtectedReadTarget')
      .mockImplementationOnce(async (input) => {
        const target = await originalCreateTarget(input);
        await owner.adminStoreRole.delete({
          where: {
            storeId_adminUserId_roleId: {
              adminUserId: admins.reader.id,
              roleId: admins.reader.roleId,
              storeId: stores.a.id,
            },
          },
        });
        return target;
      });
    try {
      const response = await api()
        .get(adminProtectedReadPath(directAdminEvidence))
        .set(adminHeaders('reader'));
      expect(response.status).toBe(404);
      expect(response.body).not.toHaveProperty('url');
      await expect(
        owner.auditLog.count({
          where: {
            action: 'after-sale.evidence.protected_read.issued',
            targetId: directAdminEvidence.evidenceId,
          },
        }),
      ).resolves.toBe(0);
    } finally {
      directRoleSpy.mockRestore();
      await owner.adminStoreRole.create({
        data: {
          adminUserId: admins.reader.id,
          grantedBy: admins.reader.id,
          roleId: admins.reader.roleId,
          storeId: stores.a.id,
        },
      });
    }

    const directPermissionEvidence = await createReadyEvidence('aOwner');
    const directPermissionSpy = vi
      .spyOn(storage, 'createProtectedReadTarget')
      .mockImplementationOnce(async (input) => {
        const target = await originalCreateTarget(input);
        await owner.storeRolePermission.delete({
          where: {
            storeId_roleId_permissionCode: {
              permissionCode: 'store.after-sales.evidence.read',
              roleId: admins.reader.roleId,
              storeId: stores.a.id,
            },
          },
        });
        return target;
      });
    try {
      const response = await api()
        .get(adminProtectedReadPath(directPermissionEvidence))
        .set(adminHeaders('reader'));
      expect(response.status).toBe(404);
      expect(response.body).not.toHaveProperty('url');
      await expect(
        owner.auditLog.count({
          where: {
            action: 'after-sale.evidence.protected_read.issued',
            targetId: directPermissionEvidence.evidenceId,
          },
        }),
      ).resolves.toBe(0);
    } finally {
      directPermissionSpy.mockRestore();
      await owner.storeRolePermission.create({
        data: {
          permissionCode: 'store.after-sales.evidence.read',
          roleId: admins.reader.roleId,
          storeId: stores.a.id,
        },
      });
    }

    const crossStoreEvidence = await createReadyEvidence('bOwner');
    const platformRoleSpy = vi
      .spyOn(storage, 'createProtectedReadTarget')
      .mockImplementationOnce(async (input) => {
        const target = await originalCreateTarget(input);
        await owner.adminPlatformRole.delete({
          where: {
            adminUserId_platformRoleId: {
              adminUserId: admins.super.id,
              platformRoleId: admins.super.platformRoleId,
            },
          },
        });
        return target;
      });
    try {
      const response = await api()
        .get(adminProtectedReadPath(crossStoreEvidence))
        .set(
          adminHeaders('super', 'b', {
            'X-Access-Reason': 'Protected evidence incident D5-1003',
          }),
        );
      expect(response.status).toBe(404);
      expect(response.body).not.toHaveProperty('url');
      await expect(
        owner.auditLog.count({
          where: {
            action: 'after-sale.evidence.protected_read.issued',
            targetId: crossStoreEvidence.evidenceId,
          },
        }),
      ).resolves.toBe(0);
    } finally {
      platformRoleSpy.mockRestore();
      await owner.adminPlatformRole.create({
        data: {
          adminUserId: admins.super.id,
          grantedBy: admins.super.id,
          platformRoleId: admins.super.platformRoleId,
        },
      });
    }

    const platformPermissionEvidence = await createReadyEvidence('bOwner');
    const platformPermissionSpy = vi
      .spyOn(storage, 'createProtectedReadTarget')
      .mockImplementationOnce(async (input) => {
        const target = await originalCreateTarget(input);
        await owner.platformRolePermission.delete({
          where: {
            platformRoleId_permissionCode: {
              permissionCode: 'platform.stores.cross_access',
              platformRoleId: admins.super.platformRoleId,
            },
          },
        });
        return target;
      });
    try {
      const response = await api()
        .get(adminProtectedReadPath(platformPermissionEvidence))
        .set(
          adminHeaders('super', 'b', {
            'X-Access-Reason': 'Protected evidence incident D5-1004',
          }),
        );
      expect(response.status).toBe(404);
      expect(response.body).not.toHaveProperty('url');
      await expect(
        owner.auditLog.count({
          where: {
            action: 'after-sale.evidence.protected_read.issued',
            targetId: platformPermissionEvidence.evidenceId,
          },
        }),
      ).resolves.toBe(0);
    } finally {
      platformPermissionSpy.mockRestore();
      await owner.platformRolePermission.create({
        data: {
          permissionCode: 'platform.stores.cross_access',
          platformRoleId: admins.super.platformRoleId,
        },
      });
    }
  });

  it('rejects final protected reads when a token, session, or signed target expires while the evidence lock waits', async () => {
    const originalCreateTarget = storage.createProtectedReadTarget.bind(storage);

    const memberEvidence = await createReadyEvidence('aOwner');
    const memberDeadline = new Date((Math.floor(Date.now() / 1_000) + 5) * 1_000);
    let signalMemberSigning: (() => void) | undefined;
    const memberSigning = new Promise<void>((resolve) => {
      signalMemberSigning = resolve;
    });
    const memberSigner = vi
      .spyOn(storage, 'createProtectedReadTarget')
      .mockImplementationOnce(async (input) => {
        const target = await originalCreateTarget(input);
        signalMemberSigning?.();
        return target;
      });
    const memberLock = holdEvidenceWriteLock(memberEvidence);
    await memberLock.acquired;
    try {
      const memberResponse = api()
        .get(protectedReadPath(memberEvidence))
        .set({
          Authorization: `Bearer ${accessToken({
            actorType: 'member',
            expiresAt: memberDeadline,
            sessionId: members.aOwner.sessionId,
            storeId: stores.a.id,
            subjectId: members.aOwner.id,
          })}`,
          'X-Store-Code': stores.a.code,
        })
        .then((response) => response);
      await assertFinalReadWaitsForExpiry({
        deadline: memberDeadline,
        request: memberResponse,
        signingCompleted: memberSigning,
      });
      memberLock.release();
      const response = await memberResponse;
      expect(response.status).toBe(404);
      expect(response.body).not.toHaveProperty('url');
    } finally {
      memberLock.release();
      await memberLock.complete;
      memberSigner.mockRestore();
    }

    const adminEvidence = await createReadyEvidence('aOwner');
    const previousAdminSession = await owner.adminSession.findUniqueOrThrow({
      select: { expiresAt: true },
      where: { id: admins.reader.sessionId },
    });
    const adminSessionDeadline = new Date((Math.floor(Date.now() / 1_000) + 5) * 1_000);
    await owner.adminSession.update({
      data: { expiresAt: adminSessionDeadline },
      where: { id: admins.reader.sessionId },
    });
    let signalAdminSigning: (() => void) | undefined;
    const adminSigning = new Promise<void>((resolve) => {
      signalAdminSigning = resolve;
    });
    const adminSigner = vi
      .spyOn(storage, 'createProtectedReadTarget')
      .mockImplementationOnce(async (input) => {
        const target = await originalCreateTarget(input);
        signalAdminSigning?.();
        return target;
      });
    const adminLock = holdEvidenceWriteLock(adminEvidence);
    await adminLock.acquired;
    try {
      const adminResponse = api()
        .get(adminProtectedReadPath(adminEvidence))
        .set(adminHeaders('reader'))
        .then((response) => response);
      await assertFinalReadWaitsForExpiry({
        deadline: adminSessionDeadline,
        request: adminResponse,
        signingCompleted: adminSigning,
      });
      adminLock.release();
      const response = await adminResponse;
      expect(response.status).toBe(404);
      expect(response.body).not.toHaveProperty('url');
      await expect(
        owner.auditLog.count({
          where: {
            action: 'after-sale.evidence.protected_read.issued',
            targetId: adminEvidence.evidenceId,
          },
        }),
      ).resolves.toBe(0);
    } finally {
      adminLock.release();
      await adminLock.complete;
      adminSigner.mockRestore();
      await owner.adminSession.update({
        data: { expiresAt: previousAdminSession.expiresAt },
        where: { id: admins.reader.sessionId },
      });
    }

    const targetEvidence = await createReadyEvidence('aOwner');
    const targetDeadline = new Date((Math.floor(Date.now() / 1_000) + 5) * 1_000);
    let signalTargetSigning: (() => void) | undefined;
    const targetSigning = new Promise<void>((resolve) => {
      signalTargetSigning = resolve;
    });
    const targetSigner = vi
      .spyOn(storage, 'createProtectedReadTarget')
      .mockImplementationOnce(async (input) => {
        const target = await originalCreateTarget(input);
        signalTargetSigning?.();
        return { ...target, expiresAt: targetDeadline };
      });
    const targetLock = holdEvidenceWriteLock(targetEvidence);
    await targetLock.acquired;
    try {
      const targetResponse = api()
        .get(protectedReadPath(targetEvidence))
        .set(memberHeaders())
        .then((response) => response);
      await assertFinalReadWaitsForExpiry({
        deadline: targetDeadline,
        request: targetResponse,
        signingCompleted: targetSigning,
      });
      targetLock.release();
      const response = await targetResponse;
      expect(response.status).toBe(404);
      expect(response.body).not.toHaveProperty('url');
    } finally {
      targetLock.release();
      await targetLock.complete;
      targetSigner.mockRestore();
    }
  }, 45_000);

  it('never issues a protected URL beyond the caller token or session expiry', async () => {
    const memberEvidence = await createReadyEvidence('aOwner');
    const memberTokenExpiresAt = new Date((Math.floor(Date.now() / 1_000) + 15) * 1_000);
    const memberResponse = await api()
      .get(protectedReadPath(memberEvidence))
      .set({
        Authorization: `Bearer ${accessToken({
          actorType: 'member',
          expiresAt: memberTokenExpiresAt,
          sessionId: members.aOwner.sessionId,
          storeId: stores.a.id,
          subjectId: members.aOwner.id,
        })}`,
        'X-Store-Code': stores.a.code,
      });
    expect(memberResponse.status).toBe(200);
    expect(new Date(memberResponse.body.expires_at as string).getTime()).toBeLessThanOrEqual(
      memberTokenExpiresAt.getTime(),
    );

    const adminEvidence = await createReadyEvidence('aOwner');
    const previousAdminSession = await owner.adminSession.findUniqueOrThrow({
      select: { expiresAt: true },
      where: { id: admins.reader.sessionId },
    });
    const adminSessionExpiresAt = new Date((Math.floor(Date.now() / 1_000) + 15) * 1_000);
    await owner.adminSession.update({
      data: { expiresAt: adminSessionExpiresAt },
      where: { id: admins.reader.sessionId },
    });
    try {
      const adminResponse = await api()
        .get(adminProtectedReadPath(adminEvidence))
        .set(adminHeaders('reader'));
      expect(adminResponse.status).toBe(200);
      expect(new Date(adminResponse.body.expires_at as string).getTime()).toBeLessThanOrEqual(
        adminSessionExpiresAt.getTime(),
      );
    } finally {
      await owner.adminSession.update({
        data: { expiresAt: previousAdminSession.expiresAt },
        where: { id: admins.reader.sessionId },
      });
    }
  });

  it('enforces protected-read RBAC, cross-store reason and an atomic safe audit', async () => {
    const evidence = await createReadyEvidence('aOwner');
    const denied = await api().get(adminProtectedReadPath(evidence)).set(adminHeaders('denied'));
    expect(denied.status).toBe(403);

    const sensitiveCorrelationId = 'a'.repeat(64);
    const response = await api()
      .get(adminProtectedReadPath(evidence))
      .set({ ...adminHeaders('reader'), 'X-Correlation-Id': sensitiveCorrelationId });
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    const issuedCorrelationId = response.headers['x-correlation-id'] as string;
    expect(issuedCorrelationId).toMatch(UUID_V4_PATTERN);
    expect(issuedCorrelationId).not.toBe(sensitiveCorrelationId);
    const auditRows = await owner.auditLog.findMany({
      where: {
        action: 'after-sale.evidence.protected_read.issued',
        actorId: admins.reader.id,
        targetId: evidence.evidenceId,
      },
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      correlationId: issuedCorrelationId,
      sourceIp: '127.0.0.1',
      storeId: stores.a.id,
      targetType: 'after_sale_evidence_file',
    });
    const serializedAudit = JSON.stringify(auditRows[0]);
    expect(serializedAudit).not.toContain(sensitiveCorrelationId);
    expect(serializedAudit).not.toContain(response.body.url as string);
    expect(serializedAudit).not.toContain(evidence.objectKey);
    expect(serializedAudit).not.toMatch(/checksum|bucket|scanner|provider|secret/iu);

    const crossStoreEvidence = await createReadyEvidence('bOwner');
    const missingReason = await api()
      .get(adminProtectedReadPath(crossStoreEvidence))
      .set(adminHeaders('super', 'b'));
    expect(missingReason.status).toBe(403);
    const crossStore = await api()
      .get(adminProtectedReadPath(crossStoreEvidence))
      .set(
        adminHeaders('super', 'b', {
          'X-Access-Reason': 'Protected evidence incident D5-1001',
          'X-Correlation-Id': 'm63d5-cross-store-read',
        }),
      );
    expect(crossStore.status).toBe(200);
    const crossStoreCorrelationId = crossStore.headers['x-correlation-id'] as string;
    expect(crossStoreCorrelationId).toMatch(UUID_V4_PATTERN);
    expect(crossStoreCorrelationId).not.toBe('m63d5-cross-store-read');
    await expect(
      owner.auditLog.count({
        where: {
          action: 'after-sale.evidence.protected_read.issued',
          actorId: admins.super.id,
          targetId: crossStoreEvidence.evidenceId,
        },
      }),
    ).resolves.toBe(1);
    await expect(
      owner.auditLog.count({
        where: {
          action: 'platform.cross_store.accessed',
          actorId: admins.super.id,
          reason: 'Protected evidence incident D5-1001',
          storeId: stores.b.id,
        },
      }),
    ).resolves.toBe(1);
    const crossStoreAudits = await owner.auditLog.findMany({
      where: { correlationId: crossStoreCorrelationId },
    });
    expect(crossStoreAudits).toHaveLength(2);
    expect(crossStoreAudits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'after-sale.evidence.protected_read.issued',
          sourceIp: '127.0.0.1',
        }),
        expect.objectContaining({
          action: 'platform.cross_store.accessed',
          sourceIp: '127.0.0.1',
        }),
      ]),
    );
    const serializedCrossStoreAudits = JSON.stringify(crossStoreAudits);
    expect(serializedCrossStoreAudits).toContain('Protected evidence incident D5-1001');
    expect(serializedCrossStoreAudits).not.toContain(crossStore.body.url as string);
    expect(serializedCrossStoreAudits).not.toContain(crossStoreEvidence.objectKey);

    const sensitiveReasonEvidence = await createReadyEvidence('bOwner');
    const sensitiveReason = `Protected evidence incident D5-1002 ${sensitiveReasonEvidence.objectKey}`;
    const rejectedSensitiveReason = await api()
      .get(adminProtectedReadPath(sensitiveReasonEvidence))
      .set(
        adminHeaders('super', 'b', {
          'X-Access-Reason': sensitiveReason,
          'X-Correlation-Id': 'm63d5-sensitive-reason',
        }),
      );
    expect(rejectedSensitiveReason.status).toBe(400);
    expect(rejectedSensitiveReason.body.code).toBe('INPUT_INVALID');
    expect(JSON.stringify(rejectedSensitiveReason.body)).not.toContain(
      sensitiveReasonEvidence.objectKey,
    );
    await expect(
      owner.auditLog.count({ where: { correlationId: 'm63d5-sensitive-reason' } }),
    ).resolves.toBe(0);
  });

  it('does not sign or audit denied, wrong-case, or rate-limiter-unavailable admin reads', async () => {
    const evidence = await createReadyEvidence('aOwner');
    const signer = vi.spyOn(storage, 'createProtectedReadTarget');
    const auditCount = () =>
      owner.auditLog.count({
        where: {
          action: 'after-sale.evidence.protected_read.issued',
          targetId: evidence.evidenceId,
        },
      });
    try {
      const denied = await api().get(adminProtectedReadPath(evidence)).set(adminHeaders('denied'));
      expect(denied.status).toBe(403);

      const wrongCase = await api()
        .get(
          `/v1/admin/after-sales/${randomUUID()}/evidence/${evidence.evidenceId}?store_id=${stores.a.id}`,
        )
        .set(adminHeaders('reader'));
      expect(wrongCase.status).toBe(404);
      expect(wrongCase.body.code).toBe('RESOURCE_NOT_FOUND');
      expect(signer).not.toHaveBeenCalled();

      const evalFailure = vi
        .spyOn(limiterRedis, 'eval')
        .mockRejectedValueOnce(new Error('redis is unavailable'));
      try {
        const unavailable = await api()
          .get(adminProtectedReadPath(evidence))
          .set(adminHeaders('reader'));
        expect(unavailable.status).toBe(503);
        expect(unavailable.body.code).toBe('UPSTREAM_UNAVAILABLE');
        expect(signer).not.toHaveBeenCalled();
      } finally {
        evalFailure.mockRestore();
      }
      await expect(auditCount()).resolves.toBe(0);
    } finally {
      signer.mockRestore();
    }
  });

  it('rolls back a failed cross-store authorization audit before signing', async () => {
    const evidence = await createReadyEvidence('bOwner');
    const correlationId = 'm63d5-cross-store-audit-failure';
    const signer = vi.spyOn(storage, 'createProtectedReadTarget');
    const originalWriteAudit = adminService.writeAudit.bind(adminService);
    const audit = vi
      .spyOn(adminService, 'writeAudit')
      .mockImplementationOnce(async (transaction, context, event) => {
        expect(event.action).toBe('platform.cross_store.accessed');
        await originalWriteAudit(transaction, context, event);
        throw new Error('forced cross-store audit persistence failure');
      });
    try {
      const response = await api()
        .get(adminProtectedReadPath(evidence))
        .set(
          adminHeaders('super', 'b', {
            'X-Access-Reason': 'Protected evidence incident D5-1005',
            'X-Correlation-Id': correlationId,
          }),
        );
      expect(response.status).toBe(503);
      expect(response.body.code).toBe('UPSTREAM_UNAVAILABLE');
      expect(response.body).not.toHaveProperty('url');
      expect(signer).not.toHaveBeenCalled();
      const issuedCorrelationId = response.headers['x-correlation-id'] as string;
      expect(issuedCorrelationId).toMatch(UUID_V4_PATTERN);
      expect(issuedCorrelationId).not.toBe(correlationId);
      await expect(
        owner.auditLog.findMany({
          select: { action: true },
          where: { correlationId: issuedCorrelationId },
        }),
      ).resolves.toEqual([]);
    } finally {
      audit.mockRestore();
      signer.mockRestore();
    }
  });

  it('rolls back an issued audit when audit work crosses the signed URL expiry', async () => {
    const evidence = await createReadyEvidence('aOwner', {
      ordinaryAccessTtlSeconds: 5,
      retentionTtlSeconds: 10,
    });
    const originalCreateTarget = storage.createProtectedReadTarget.bind(storage);
    const originalWriteAudit = adminService.writeAudit.bind(adminService);
    let signedExpiry: Date | undefined;
    const signer = vi
      .spyOn(storage, 'createProtectedReadTarget')
      .mockImplementationOnce(async (input) => {
        const target = await originalCreateTarget(input);
        signedExpiry = target.expiresAt;
        return target;
      });
    const audit = vi
      .spyOn(adminService, 'writeAudit')
      .mockImplementationOnce(async (transaction, context, event) => {
        await originalWriteAudit(transaction, context, event);
        if (signedExpiry === undefined) {
          throw new Error('D5 audit-delay test did not observe the signed expiry');
        }
        await waitUntil(signedExpiry);
      });
    try {
      const response = await api()
        .get(adminProtectedReadPath(evidence))
        .set(adminHeaders('reader'));
      expect(response.status).toBe(404);
      expect(response.body).not.toHaveProperty('url');
      await expect(
        owner.auditLog.count({
          where: {
            action: 'after-sale.evidence.protected_read.issued',
            targetId: evidence.evidenceId,
          },
        }),
      ).resolves.toBe(0);
    } finally {
      audit.mockRestore();
      signer.mockRestore();
    }
  });

  it('rolls back an admin audit write failure and returns no protected URL', async () => {
    const evidence = await createReadyEvidence('aOwner');
    const signer = vi.spyOn(storage, 'createProtectedReadTarget');
    const originalWriteAudit = adminService.writeAudit.bind(adminService);
    const writeAudit = vi
      .spyOn(adminService, 'writeAudit')
      .mockImplementation(async (...args: Parameters<AdminService['writeAudit']>) => {
        await originalWriteAudit(...args);
        throw new Error('forced protected-read audit persistence failure');
      });
    try {
      const response = await api()
        .get(adminProtectedReadPath(evidence))
        .set(adminHeaders('reader'));
      expect(response.status).toBe(503);
      expect(response.body.code).toBe('UPSTREAM_UNAVAILABLE');
      expect(response.body).not.toHaveProperty('url');
      expect(signer).toHaveBeenCalledOnce();
      await expect(
        owner.auditLog.count({
          where: {
            action: 'after-sale.evidence.protected_read.issued',
            targetId: evidence.evidenceId,
          },
        }),
      ).resolves.toBe(0);
    } finally {
      writeAudit.mockRestore();
      signer.mockRestore();
    }
  });

  it('applies the existing member read limiter before signing', async () => {
    const evidence = await createReadyEvidence('aOwner');
    const key = rateLimitKey('aOwner');
    await limiterRedis.set(key, String(AFTER_SALE_RATE_LIMIT_POLICY.member_read.limit), 'EX', 61);
    const response = await api().get(protectedReadPath(evidence)).set(memberHeaders());
    expect(response.status).toBe(429);
    expect(response.body.code).toBe('RATE_LIMITED');
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
    await limiterRedis.del(key);
  });
});
