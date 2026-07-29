import { createHash, randomUUID } from 'node:crypto';

import { Prisma, type PrismaClient } from '@prisma/client';
import type {
  AfterSaleEvidenceSystemContext,
  AfterSaleEvidenceStatus,
  StoreContext,
} from '@zalo-shop/domain';

import {
  type StoreTransaction,
  withAfterSaleEvidenceSystemTransaction,
  withStoreTransaction,
} from './index';
import { appendOutboxMessageInTransaction } from './reliable-messaging';

export const AFTER_SALE_EVIDENCE_AGGREGATE_TYPE = 'AFTER_SALE_EVIDENCE' as const;
export const AFTER_SALE_EVIDENCE_SCAN_EVENT = 'after-sale.evidence.scan.requested' as const;
export const AFTER_SALE_EVIDENCE_EXPIRE_EVENT = 'after-sale.evidence.expire.requested' as const;
export const AFTER_SALE_EVIDENCE_DELETE_EVENT = 'after-sale.evidence.delete.requested' as const;

const AFTER_SALE_EVIDENCE_LIFECYCLE_EVENTS = [
  AFTER_SALE_EVIDENCE_SCAN_EVENT,
  AFTER_SALE_EVIDENCE_EXPIRE_EVENT,
  AFTER_SALE_EVIDENCE_DELETE_EVENT,
] as const;

const AFTER_SALE_EVIDENCE_OUTBOX_PAYLOAD_KEYS = [
  'evidence_id',
  'expected_version',
  'store_id',
] as const;

export type AfterSaleEvidenceLifecycleEvent = (typeof AFTER_SALE_EVIDENCE_LIFECYCLE_EVENTS)[number];

export const AFTER_SALE_EVIDENCE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
] as const;

export type AfterSaleEvidenceMimeType = (typeof AFTER_SALE_EVIDENCE_MIME_TYPES)[number];

export type AfterSaleEvidenceLifecycleErrorCode =
  | 'AFTER_SALE_EVIDENCE_IDEMPOTENCY_CONFLICT'
  | 'AFTER_SALE_EVIDENCE_INPUT_INVALID'
  | 'AFTER_SALE_EVIDENCE_NOT_FOUND'
  | 'AFTER_SALE_EVIDENCE_QUOTA_EXCEEDED'
  | 'AFTER_SALE_EVIDENCE_RETENTION_ACTIVE'
  | 'AFTER_SALE_EVIDENCE_SCOPE_DENIED'
  | 'AFTER_SALE_EVIDENCE_STATE_CONFLICT';

export class AfterSaleEvidenceLifecycleError extends Error {
  public constructor(public readonly code: AfterSaleEvidenceLifecycleErrorCode) {
    super(code);
    this.name = 'AfterSaleEvidenceLifecycleError';
  }
}

type EvidenceRow = {
  after_sale_id: string | null;
  byte_size: bigint;
  claim_deadline_at: Date | null;
  confirmed_at: Date | null;
  delete_attempt_count: number;
  delete_exhausted_at: Date | null;
  id: string;
  legal_hold_active: boolean;
  member_id: string;
  next_delete_attempt_at: Date | null;
  object_key: string | null;
  ordinary_access_deadline_at: Date | null;
  retention_deadline_at: Date | null;
  scan_generation: number;
  status: AfterSaleEvidenceStatus;
  store_id: string;
  upload_deadline_at: Date | null;
  version: number;
};

export type AfterSaleEvidenceRecord = Readonly<{
  afterSaleId: string | null;
  byteSize: bigint;
  claimDeadlineAt: Date | null;
  confirmedAt: Date | null;
  deleteAttemptCount: number;
  deleteExhaustedAt: Date | null;
  id: string;
  legalHoldActive: boolean;
  memberId: string;
  nextDeleteAttemptAt: Date | null;
  objectKey: string | null;
  ordinaryAccessDeadlineAt: Date | null;
  retentionDeadlineAt: Date | null;
  scanGeneration: number;
  status: AfterSaleEvidenceStatus;
  storeId: string;
  uploadDeadlineAt: Date | null;
  version: number;
}>;

type ClockRow = { current_time: Date };
type QuotaRow = { byte_count: bigint; file_count: bigint };
type EvidenceOutboxRow = {
  aggregate_id: string;
  aggregate_type: string;
  completed_at: Date | null;
  event_type: string;
  event_version: number;
  id: string;
  lease_expires_at: Date | null;
  lease_owner: string | null;
  payload: Prisma.JsonValue;
  status: 'COMPLETED' | 'DEAD_LETTER' | 'PENDING' | 'PROCESSING';
  store_id: string;
  version: number;
};

type ParsedEvidenceOutbox = Readonly<{
  evidenceId: string;
  eventType: AfterSaleEvidenceLifecycleEvent;
  expectedVersion: number;
}>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/u;
const ENVIRONMENT_PATTERN = /^[a-z][a-z0-9-]{1,31}$/u;
const IDEMPOTENCY_KEY_PATTERN = /^[!-~]{16,128}$/u;
const STABLE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/u;
const SCANNER_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u;
const MAX_IMAGE_BYTES = 10 * 1_024 * 1_024;
const MAX_VIDEO_BYTES = 50 * 1_024 * 1_024;
const DELETE_MIN_BASE_DELAY_MS = 60_000;
const DELETE_MAX_DELAY_MS = 6 * 60 * 60 * 1_000;
const DELETE_MAX_ATTEMPTS = 8;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;

function digest(value: unknown): string {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
    .digest('hex');
}

function evidenceRecord(row: EvidenceRow): AfterSaleEvidenceRecord {
  return {
    afterSaleId: row.after_sale_id,
    byteSize: row.byte_size,
    claimDeadlineAt: row.claim_deadline_at,
    confirmedAt: row.confirmed_at,
    deleteAttemptCount: row.delete_attempt_count,
    deleteExhaustedAt: row.delete_exhausted_at,
    id: row.id,
    legalHoldActive: row.legal_hold_active,
    memberId: row.member_id,
    nextDeleteAttemptAt: row.next_delete_attempt_at,
    objectKey: row.object_key,
    ordinaryAccessDeadlineAt: row.ordinary_access_deadline_at,
    retentionDeadlineAt: row.retention_deadline_at,
    scanGeneration: row.scan_generation,
    status: row.status,
    storeId: row.store_id,
    uploadDeadlineAt: row.upload_deadline_at,
    version: row.version,
  };
}

function assertMemberContext(context: StoreContext): void {
  if (context.actor.type !== 'member') {
    throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_SCOPE_DENIED');
  }
}

function assertPositiveInteger(value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_INPUT_INVALID');
  }
}

function assertDeletionRetryPolicy(
  input: Readonly<{ baseDelayMs: number; maxAttempts: number; maxDelayMs: number }>,
): void {
  assertPositiveInteger(input.baseDelayMs, DELETE_MAX_DELAY_MS);
  assertPositiveInteger(input.maxDelayMs, DELETE_MAX_DELAY_MS);
  if (
    input.baseDelayMs < DELETE_MIN_BASE_DELAY_MS ||
    input.maxAttempts !== DELETE_MAX_ATTEMPTS ||
    input.maxDelayMs < input.baseDelayMs
  ) {
    throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_INPUT_INVALID');
  }
}

function assertDate(value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_INPUT_INVALID');
  }
}

function stateConflict(): never {
  throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_STATE_CONFLICT');
}

function isEvidenceLifecycleEvent(value: string): value is AfterSaleEvidenceLifecycleEvent {
  return (AFTER_SALE_EVIDENCE_LIFECYCLE_EVENTS as readonly string[]).includes(value);
}

function isPlainJsonObject(value: Prisma.JsonValue): value is Prisma.JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseEvidenceOutbox(
  row: EvidenceOutboxRow,
  expectedStoreId: string,
): ParsedEvidenceOutbox {
  if (
    row.store_id !== expectedStoreId ||
    row.aggregate_type !== AFTER_SALE_EVIDENCE_AGGREGATE_TYPE ||
    row.event_version !== 1 ||
    !isEvidenceLifecycleEvent(row.event_type) ||
    !UUID_PATTERN.test(row.aggregate_id) ||
    !isPlainJsonObject(row.payload)
  ) {
    return stateConflict();
  }
  const keys = Object.keys(row.payload).sort();
  const expectedKeys = [...AFTER_SALE_EVIDENCE_OUTBOX_PAYLOAD_KEYS].sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    return stateConflict();
  }
  const storeId = row.payload.store_id;
  const evidenceId = row.payload.evidence_id;
  const expectedVersion = row.payload.expected_version;
  if (
    typeof storeId !== 'string' ||
    storeId !== expectedStoreId ||
    typeof evidenceId !== 'string' ||
    !UUID_PATTERN.test(evidenceId) ||
    evidenceId !== row.aggregate_id ||
    typeof expectedVersion !== 'number' ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 1
  ) {
    return stateConflict();
  }
  return { evidenceId, eventType: row.event_type, expectedVersion };
}

function assertDeadLetterShape(row: EvidenceOutboxRow): void {
  if (
    row.status !== 'DEAD_LETTER' ||
    row.lease_owner !== null ||
    row.lease_expires_at !== null ||
    !(row.completed_at instanceof Date) ||
    !Number.isFinite(row.completed_at.getTime())
  ) {
    stateConflict();
  }
}

function assertIdempotencyKey(value: string): void {
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_INPUT_INVALID');
  }
}

function hasUnsafeFilenameCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint === undefined ||
      codePoint <= 0x1f ||
      codePoint === 0x7f ||
      character === '/' ||
      character === '\\'
    );
  });
}

function assertUploadInput(input: InitializeAfterSaleEvidenceInput): void {
  assertIdempotencyKey(input.idempotencyKey);
  assertPositiveInteger(input.byteSize, MAX_VIDEO_BYTES);
  assertPositiveInteger(input.maxUnclaimedBytes, Number.MAX_SAFE_INTEGER);
  assertPositiveInteger(input.maxUnclaimedFiles, 100);
  assertPositiveInteger(input.uploadTtlSeconds, 86_400);
  if (
    !AFTER_SALE_EVIDENCE_MIME_TYPES.includes(input.mimeType) ||
    !CHECKSUM_PATTERN.test(input.checksumSha256) ||
    !ENVIRONMENT_PATTERN.test(input.deploymentEnvironment) ||
    !input.filename.trim() ||
    input.filename.length > 255 ||
    hasUnsafeFilenameCharacter(input.filename) ||
    (input.mimeType.startsWith('image/') && input.byteSize > MAX_IMAGE_BYTES)
  ) {
    throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_INPUT_INVALID');
  }
}

async function clock(transaction: StoreTransaction): Promise<Date> {
  const row = (
    await transaction.$queryRaw<ClockRow[]>`
    SELECT CURRENT_TIMESTAMP AS current_time
  `
  )[0];
  if (!row) throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_STATE_CONFLICT');
  return row.current_time;
}

async function lockMemberEvidenceQuota(
  transaction: StoreTransaction,
  storeId: string,
  memberId: string,
): Promise<void> {
  await transaction.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`m63b2-evidence:${storeId}:${memberId}`}, 0)
    )
  `;
}

async function evidenceOwner(
  transaction: StoreTransaction,
  evidenceId: string,
): Promise<string | undefined> {
  return (
    await transaction.$queryRaw<Array<{ member_id: string }>>`
      SELECT member_id
      FROM after_sale_evidence_files
      WHERE store_id = app_security.current_store_id() AND id = ${evidenceId}::uuid
    `
  )[0]?.member_id;
}

async function evidenceSnapshot(
  transaction: StoreTransaction,
  evidenceId: string,
): Promise<EvidenceRow | undefined> {
  return (
    await transaction.$queryRaw<EvidenceRow[]>`
      SELECT id, store_id, member_id, after_sale_id, object_key, byte_size, status,
        upload_deadline_at, confirmed_at, scan_generation, claim_deadline_at,
        ordinary_access_deadline_at, retention_deadline_at, legal_hold_active,
        delete_attempt_count, next_delete_attempt_at, delete_exhausted_at, version
      FROM after_sale_evidence_files
      WHERE store_id = app_security.current_store_id()
        AND id = ${evidenceId}::uuid
    `
  )[0];
}

async function lockedEvidence(
  transaction: StoreTransaction,
  evidenceId: string,
): Promise<EvidenceRow | undefined> {
  return (
    await transaction.$queryRaw<EvidenceRow[]>`
      SELECT id, store_id, member_id, after_sale_id, object_key, byte_size, status,
        upload_deadline_at, confirmed_at, scan_generation, claim_deadline_at,
        ordinary_access_deadline_at, retention_deadline_at, legal_hold_active,
        delete_attempt_count, next_delete_attempt_at, delete_exhausted_at, version
      FROM after_sale_evidence_files
      WHERE store_id = app_security.current_store_id()
        AND id = ${evidenceId}::uuid
      FOR UPDATE
    `
  )[0];
}

async function evidenceOutbox(
  transaction: StoreTransaction,
  context: AfterSaleEvidenceSystemContext,
  messageId: string,
): Promise<EvidenceOutboxRow | undefined> {
  return (
    await transaction.$queryRaw<EvidenceOutboxRow[]>`
      SELECT id, store_id, aggregate_type, aggregate_id, event_type, event_version,
        payload, status, lease_owner, lease_expires_at, completed_at, version
      FROM outbox_messages
      WHERE store_id = ${context.storeId}::uuid AND id = ${messageId}::uuid
    `
  )[0];
}

async function lockedEvidenceOutbox(
  transaction: StoreTransaction,
  context: AfterSaleEvidenceSystemContext,
  messageId: string,
): Promise<EvidenceOutboxRow | undefined> {
  return (
    await transaction.$queryRaw<EvidenceOutboxRow[]>`
      SELECT id, store_id, aggregate_type, aggregate_id, event_type, event_version,
        payload, status, lease_owner, lease_expires_at, completed_at, version
      FROM outbox_messages
      WHERE store_id = ${context.storeId}::uuid AND id = ${messageId}::uuid
      FOR UPDATE
    `
  )[0];
}

async function hasEvidenceOutboxIdentity(
  transaction: StoreTransaction,
  context: AfterSaleEvidenceSystemContext,
  input: Readonly<{
    eventType: AfterSaleEvidenceLifecycleEvent;
    evidenceId: string;
    expectedVersion: number;
  }>,
): Promise<boolean> {
  const row = (
    await transaction.$queryRaw<EvidenceOutboxRow[]>`
      SELECT id, store_id, aggregate_type, aggregate_id, event_type, event_version,
        payload, status, lease_owner, lease_expires_at, completed_at, version
      FROM outbox_messages
      WHERE store_id = ${context.storeId}::uuid
        AND aggregate_type = ${AFTER_SALE_EVIDENCE_AGGREGATE_TYPE}
        AND aggregate_id = ${input.evidenceId}::uuid
        AND event_type = ${input.eventType}
        AND payload = pg_catalog.jsonb_build_object(
          'store_id', ${context.storeId},
          'evidence_id', ${input.evidenceId},
          'expected_version', ${input.expectedVersion}
        )
      ORDER BY id DESC
      LIMIT 1
    `
  )[0];
  if (!row) return false;
  const parsed = parseEvidenceOutbox(row, context.storeId);
  return (
    parsed.evidenceId === input.evidenceId &&
    parsed.eventType === input.eventType &&
    parsed.expectedVersion === input.expectedVersion
  );
}

async function rescheduleDeadLetterOutbox(
  transaction: StoreTransaction,
  context: AfterSaleEvidenceSystemContext,
  input: Readonly<{
    availableAt: Date;
    message: EvidenceOutboxRow;
    now: Date;
  }>,
): Promise<void> {
  const affected = await transaction.$executeRaw`
    UPDATE outbox_messages
    SET status = 'PENDING'::outbox_status, available_at = ${input.availableAt},
      lease_owner = NULL, lease_expires_at = NULL, attempt_count = 0,
      last_error_code = NULL, completed_at = NULL, version = version + 1,
      updated_at = ${input.now}
    WHERE store_id = ${context.storeId}::uuid AND id = ${input.message.id}::uuid
      AND status = 'DEAD_LETTER'::outbox_status AND version = ${input.message.version}
      AND lease_owner IS NULL AND lease_expires_at IS NULL AND completed_at IS NOT NULL
  `;
  if (affected !== 1) stateConflict();
}

async function appendEvidenceMessage(
  transaction: StoreTransaction,
  context: Pick<StoreContext, 'storeId'> | Pick<AfterSaleEvidenceSystemContext, 'storeId'>,
  input: {
    availableAt: Date;
    eventType:
      | typeof AFTER_SALE_EVIDENCE_DELETE_EVENT
      | typeof AFTER_SALE_EVIDENCE_EXPIRE_EVENT
      | typeof AFTER_SALE_EVIDENCE_SCAN_EVENT;
    evidenceId: string;
    expectedVersion: number;
    maxAttempts: number;
  },
): Promise<void> {
  await appendOutboxMessageInTransaction(transaction, context, {
    aggregateId: input.evidenceId,
    aggregateType: AFTER_SALE_EVIDENCE_AGGREGATE_TYPE,
    availableAt: input.availableAt,
    eventType: input.eventType,
    eventVersion: 1,
    idempotencyKey: `${input.eventType}:${input.evidenceId}:${input.expectedVersion}`,
    maxAttempts: input.maxAttempts,
    payload: {
      evidence_id: input.evidenceId,
      expected_version: input.expectedVersion,
      store_id: context.storeId,
    },
  });
}

export type InitializeAfterSaleEvidenceInput = Readonly<{
  byteSize: number;
  checksumSha256: string;
  deploymentEnvironment: string;
  filename: string;
  idempotencyKey: string;
  maxUnclaimedBytes: number;
  maxUnclaimedFiles: number;
  mimeType: AfterSaleEvidenceMimeType;
  uploadTtlSeconds: number;
}>;

export async function initializeAfterSaleEvidenceUpload(
  client: PrismaClient,
  context: StoreContext,
  input: InitializeAfterSaleEvidenceInput,
): Promise<Readonly<{ evidence: AfterSaleEvidenceRecord; objectKey: string; replayed: boolean }>> {
  assertMemberContext(context);
  assertUploadInput(input);
  const keyHash = digest(input.idempotencyKey);
  const requestHash = digest({
    byte_size: input.byteSize,
    checksum_sha256: input.checksumSha256,
    filename: input.filename,
    mime_type: input.mimeType,
  });
  const operation = `after-sale-evidence-upload:${context.actor.id}`;
  return withStoreTransaction(
    client,
    context,
    async (transaction) => {
      await lockMemberEvidenceQuota(transaction, context.storeId, context.actor.id);
      const now = await clock(transaction);
      await transaction.idempotencyRecord.deleteMany({
        where: {
          expiresAt: { lte: now },
          idempotencyKey: keyHash,
          operation,
          storeId: context.storeId,
        },
      });
      const replay = await transaction.idempotencyRecord.findUnique({
        where: {
          storeId_operation_idempotencyKey: {
            idempotencyKey: keyHash,
            operation,
            storeId: context.storeId,
          },
        },
      });
      if (replay) {
        if (replay.memberId !== context.actor.id || replay.requestHash !== requestHash) {
          throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_IDEMPOTENCY_CONFLICT');
        }
        const response = replay.response as { evidence_id?: unknown };
        if (typeof response.evidence_id !== 'string' || !UUID_PATTERN.test(response.evidence_id)) {
          throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_STATE_CONFLICT');
        }
        const row = await evidenceSnapshot(transaction, response.evidence_id);
        if (
          !row ||
          row.member_id !== context.actor.id ||
          row.object_key === null ||
          row.status !== 'PENDING' ||
          row.confirmed_at !== null ||
          row.upload_deadline_at === null ||
          now >= row.upload_deadline_at
        ) {
          throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_STATE_CONFLICT');
        }
        return { evidence: evidenceRecord(row), objectKey: row.object_key, replayed: true };
      }

      const quota = (
        await transaction.$queryRaw<QuotaRow[]>`
          SELECT pg_catalog.count(*)::bigint AS file_count,
            COALESCE(pg_catalog.sum(byte_size), 0)::bigint AS byte_count
          FROM after_sale_evidence_files
          WHERE store_id = ${context.storeId}::uuid
            AND member_id = ${context.actor.id}::uuid
            AND after_sale_id IS NULL
            AND status <> 'DELETED'
        `
      )[0];
      if (
        !quota ||
        quota.file_count >= BigInt(input.maxUnclaimedFiles) ||
        quota.byte_count + BigInt(input.byteSize) > BigInt(input.maxUnclaimedBytes)
      ) {
        throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_QUOTA_EXCEEDED');
      }

      const evidenceId = randomUUID();
      const uploadSessionId = randomUUID();
      const objectKey = `${input.deploymentEnvironment}/${context.storeId}/staged/${evidenceId}/original`;
      const uploadDeadlineAt = new Date(now.getTime() + input.uploadTtlSeconds * 1_000);
      const rows = await transaction.$queryRaw<EvidenceRow[]>`
        INSERT INTO after_sale_evidence_files (
          id, store_id, member_id, upload_session_id, object_key, mime_type,
          byte_size, checksum_sha256, original_filename, upload_deadline_at,
          updated_at
        ) VALUES (
          ${evidenceId}::uuid, ${context.storeId}::uuid, ${context.actor.id}::uuid,
          ${uploadSessionId}::uuid, ${objectKey}, ${input.mimeType}, ${input.byteSize},
          ${input.checksumSha256}, ${input.filename.trim()}, ${uploadDeadlineAt}, ${now}
        )
        RETURNING id, store_id, member_id, after_sale_id, object_key, byte_size, status,
          upload_deadline_at, confirmed_at, scan_generation, claim_deadline_at,
          ordinary_access_deadline_at, retention_deadline_at, legal_hold_active,
          delete_attempt_count, next_delete_attempt_at, delete_exhausted_at, version
      `;
      const created = rows[0];
      if (!created) {
        throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_STATE_CONFLICT');
      }
      await transaction.$executeRaw`
        INSERT INTO after_sale_evidence_objects (
          store_id, evidence_file_id, object_role, object_key, object_key_hash,
          created_at, updated_at
        ) VALUES (
          ${context.storeId}::uuid, ${evidenceId}::uuid, 'ORIGINAL', ${objectKey},
          ${digest(objectKey)}, ${now}, ${now}
        )
      `;
      await appendEvidenceMessage(transaction, context, {
        availableAt: uploadDeadlineAt,
        eventType: AFTER_SALE_EVIDENCE_EXPIRE_EVENT,
        evidenceId,
        expectedVersion: created.version,
        maxAttempts: 3,
      });
      await transaction.idempotencyRecord.create({
        data: {
          expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
          idempotencyKey: keyHash,
          memberId: context.actor.id,
          operation,
          requestHash,
          response: { evidence_id: evidenceId, version: created.version },
          storeId: context.storeId,
        },
      });
      return { evidence: evidenceRecord(created), objectKey, replayed: false };
    },
    { isolationLevel: 'Serializable', timeout: 15_000 },
  );
}

export async function confirmAfterSaleEvidenceUpload(
  client: PrismaClient,
  context: StoreContext,
  input: Readonly<{
    evidenceId: string;
    expectedVersion: number;
    idempotencyKey: string;
  }>,
): Promise<Readonly<{ evidence: AfterSaleEvidenceRecord; replayed: boolean }>> {
  assertMemberContext(context);
  assertIdempotencyKey(input.idempotencyKey);
  assertPositiveInteger(input.expectedVersion, Number.MAX_SAFE_INTEGER);
  if (!UUID_PATTERN.test(input.evidenceId)) {
    throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_INPUT_INVALID');
  }
  const keyHash = digest(input.idempotencyKey);
  const requestHash = digest({
    evidence_id: input.evidenceId,
    expected_version: input.expectedVersion,
  });
  const operation = `after-sale-evidence-confirm:${context.actor.id}`;
  return withStoreTransaction(
    client,
    context,
    async (transaction) => {
      await lockMemberEvidenceQuota(transaction, context.storeId, context.actor.id);
      const now = await clock(transaction);
      await transaction.idempotencyRecord.deleteMany({
        where: {
          expiresAt: { lte: now },
          idempotencyKey: keyHash,
          operation,
          storeId: context.storeId,
        },
      });
      const replay = await transaction.idempotencyRecord.findUnique({
        where: {
          storeId_operation_idempotencyKey: {
            idempotencyKey: keyHash,
            operation,
            storeId: context.storeId,
          },
        },
      });
      if (replay) {
        if (replay.memberId !== context.actor.id || replay.requestHash !== requestHash) {
          throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_IDEMPOTENCY_CONFLICT');
        }
        const row = await evidenceSnapshot(transaction, input.evidenceId);
        if (!row || row.member_id !== context.actor.id || row.confirmed_at === null) {
          throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_STATE_CONFLICT');
        }
        return { evidence: evidenceRecord(row), replayed: true };
      }
      const current = await lockedEvidence(transaction, input.evidenceId);
      if (!current || current.member_id !== context.actor.id) {
        throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_NOT_FOUND');
      }
      if (
        current.version !== input.expectedVersion ||
        current.status !== 'PENDING' ||
        current.confirmed_at !== null ||
        current.upload_deadline_at === null ||
        now >= current.upload_deadline_at
      ) {
        throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_STATE_CONFLICT');
      }
      const rows = await transaction.$queryRaw<EvidenceRow[]>`
        UPDATE after_sale_evidence_files
        SET confirmed_at = ${now}, scan_requested_at = ${now},
          scan_generation = scan_generation + 1, version = version + 1,
          updated_at = ${now}
        WHERE store_id = ${context.storeId}::uuid AND id = ${input.evidenceId}::uuid
          AND member_id = ${context.actor.id}::uuid AND version = ${input.expectedVersion}
        RETURNING id, store_id, member_id, after_sale_id, object_key, byte_size, status,
          upload_deadline_at, confirmed_at, scan_generation, claim_deadline_at,
          ordinary_access_deadline_at, retention_deadline_at, legal_hold_active,
          delete_attempt_count, next_delete_attempt_at, delete_exhausted_at, version
      `;
      const confirmed = rows[0];
      if (!confirmed) {
        throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_STATE_CONFLICT');
      }
      await appendEvidenceMessage(transaction, context, {
        availableAt: now,
        eventType: AFTER_SALE_EVIDENCE_SCAN_EVENT,
        evidenceId: confirmed.id,
        expectedVersion: confirmed.version,
        maxAttempts: 5,
      });
      await transaction.idempotencyRecord.create({
        data: {
          expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
          idempotencyKey: keyHash,
          memberId: context.actor.id,
          operation,
          requestHash,
          response: { evidence_id: confirmed.id, version: confirmed.version },
          storeId: context.storeId,
        },
      });
      return { evidence: evidenceRecord(confirmed), replayed: false };
    },
    { isolationLevel: 'Serializable', timeout: 15_000 },
  );
}

export type RequestAfterSaleEvidenceRescanInput = Readonly<{
  evidenceId: string;
  expectedVersion: number;
}>;

export async function requestAfterSaleEvidenceRescan(
  client: PrismaClient,
  context: AfterSaleEvidenceSystemContext,
  input: RequestAfterSaleEvidenceRescanInput,
): Promise<Readonly<{ evidence: AfterSaleEvidenceRecord; requested: boolean }>> {
  assertPositiveInteger(input.expectedVersion, Number.MAX_SAFE_INTEGER);
  if (!UUID_PATTERN.test(input.evidenceId)) {
    throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_INPUT_INVALID');
  }
  return withAfterSaleEvidenceSystemTransaction(
    client,
    context,
    async (transaction) => {
      const current = await lockedEvidence(transaction, input.evidenceId);
      if (!current) {
        throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_NOT_FOUND');
      }
      if (
        current.version !== input.expectedVersion ||
        current.status !== 'PENDING' ||
        current.after_sale_id !== null ||
        current.confirmed_at === null
      ) {
        return { evidence: evidenceRecord(current), requested: false };
      }
      const rows = await transaction.$queryRaw<Array<EvidenceRow & { scan_requested_at: Date }>>`
        WITH timing AS (
          SELECT pg_catalog.clock_timestamp() AS requested_at
        )
        UPDATE after_sale_evidence_files evidence
        SET scan_requested_at = timing.requested_at,
          scan_generation = evidence.scan_generation + 1,
          version = evidence.version + 1, updated_at = timing.requested_at
        FROM timing
        WHERE evidence.store_id = ${context.storeId}::uuid
          AND evidence.id = ${input.evidenceId}::uuid
          AND evidence.version = ${input.expectedVersion}
          AND evidence.status = 'PENDING' AND evidence.after_sale_id IS NULL
          AND evidence.confirmed_at IS NOT NULL AND evidence.scan_requested_at IS NOT NULL
          AND evidence.scan_completed_at IS NULL AND evidence.scan_result_code IS NULL
          AND evidence.scan_requested_at < timing.requested_at
        RETURNING evidence.id, evidence.store_id, evidence.member_id, evidence.after_sale_id,
          evidence.object_key, evidence.byte_size, evidence.status,
          evidence.upload_deadline_at, evidence.confirmed_at, evidence.scan_requested_at,
          evidence.scan_generation, evidence.claim_deadline_at,
          evidence.ordinary_access_deadline_at, evidence.retention_deadline_at,
          evidence.legal_hold_active, evidence.delete_attempt_count,
          evidence.next_delete_attempt_at, evidence.delete_exhausted_at, evidence.version
      `;
      const rescanned = rows[0];
      if (!rescanned) {
        throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_STATE_CONFLICT');
      }
      // PostgreSQL timestamps retain microseconds while JavaScript Date values retain
      // milliseconds. Scheduling one millisecond later keeps the outbox time at or after
      // the authoritative scan request without widening the database's one-second guard.
      await appendEvidenceMessage(transaction, context, {
        availableAt: new Date(rescanned.scan_requested_at.getTime() + 1),
        eventType: AFTER_SALE_EVIDENCE_SCAN_EVENT,
        evidenceId: rescanned.id,
        expectedVersion: rescanned.version,
        maxAttempts: 5,
      });
      return { evidence: evidenceRecord(rescanned), requested: true };
    },
    { isolationLevel: 'Serializable', timeout: 15_000 },
  );
}

export type AfterSaleEvidenceScanResult =
  | Readonly<{
      engine: string;
      engineVersion: string;
      signatureVersion: string;
      verdict: 'CLEAN';
    }>
  | Readonly<{
      code: string;
      engine?: string;
      engineVersion?: string;
      signatureVersion?: string;
      verdict: 'INDETERMINATE' | 'MALICIOUS';
    }>;

function assertScanResult(input: ApplyAfterSaleEvidenceScanResultInput): void {
  assertPositiveInteger(input.claimTtlSeconds, 7 * 24 * 60 * 60);
  assertPositiveInteger(input.expectedVersion, Number.MAX_SAFE_INTEGER);
  assertPositiveInteger(input.failedRetentionSeconds, 7 * 24 * 60 * 60);
  if (
    !UUID_PATTERN.test(input.evidenceId) ||
    !Number.isSafeInteger(input.scanGeneration) ||
    input.scanGeneration < 1
  ) {
    throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_INPUT_INVALID');
  }
  const versions = [input.result.engine, input.result.engineVersion, input.result.signatureVersion];
  if (
    (input.result.verdict === 'CLEAN' && versions.some((value) => !value)) ||
    versions.some((value) => value !== undefined && !SCANNER_VERSION_PATTERN.test(value)) ||
    ('code' in input.result && !STABLE_CODE_PATTERN.test(input.result.code))
  ) {
    throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_INPUT_INVALID');
  }
}

export type ApplyAfterSaleEvidenceScanResultInput = Readonly<{
  claimTtlSeconds: number;
  evidenceId: string;
  expectedVersion: number;
  failedRetentionSeconds: number;
  result: AfterSaleEvidenceScanResult;
  scanGeneration: number;
}>;

export async function applyAfterSaleEvidenceScanResult(
  client: PrismaClient,
  context: AfterSaleEvidenceSystemContext,
  input: ApplyAfterSaleEvidenceScanResultInput,
): Promise<Readonly<{ applied: boolean; evidence: AfterSaleEvidenceRecord }>> {
  assertScanResult(input);
  return withAfterSaleEvidenceSystemTransaction(
    client,
    context,
    async (transaction) => {
      const now = await clock(transaction);
      const current = await lockedEvidence(transaction, input.evidenceId);
      if (!current) {
        throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_NOT_FOUND');
      }
      if (
        current.version !== input.expectedVersion ||
        current.scan_generation !== input.scanGeneration ||
        current.confirmed_at === null ||
        current.status !== 'PENDING'
      ) {
        return { applied: false, evidence: evidenceRecord(current) };
      }
      const status =
        input.result.verdict === 'CLEAN'
          ? 'READY_UNCLAIMED'
          : input.result.verdict === 'MALICIOUS'
            ? 'QUARANTINED'
            : 'FAILED';
      const resultCode = input.result.verdict === 'CLEAN' ? 'CLEAN' : input.result.code;
      const deadline = new Date(
        now.getTime() +
          (input.result.verdict === 'CLEAN'
            ? input.claimTtlSeconds
            : input.failedRetentionSeconds) *
            1_000,
      );
      const engine = input.result.engine ?? null;
      const engineVersion = input.result.engineVersion ?? null;
      const signatureVersion = input.result.signatureVersion ?? null;
      const rows = await transaction.$queryRaw<EvidenceRow[]>(Prisma.sql`
        UPDATE after_sale_evidence_files
        SET status = ${status}::after_sale_evidence_status,
          scan_result_code = ${resultCode}, scan_completed_at = ${now},
          scanner_engine = ${engine}, scanner_engine_version = ${engineVersion},
          scanner_signature_version = ${signatureVersion},
          claim_deadline_at = ${deadline}, version = version + 1, updated_at = ${now}
        WHERE store_id = ${context.storeId}::uuid AND id = ${input.evidenceId}::uuid
          AND status = 'PENDING' AND scan_generation = ${input.scanGeneration}
          AND version = ${input.expectedVersion}
        RETURNING id, store_id, member_id, after_sale_id, object_key, byte_size, status,
          upload_deadline_at, confirmed_at, scan_generation, claim_deadline_at,
          ordinary_access_deadline_at, retention_deadline_at, legal_hold_active,
          delete_attempt_count, next_delete_attempt_at, delete_exhausted_at, version
      `);
      const updated = rows[0];
      if (!updated) {
        throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_STATE_CONFLICT');
      }
      await appendEvidenceMessage(transaction, context, {
        availableAt: deadline,
        eventType: AFTER_SALE_EVIDENCE_EXPIRE_EVENT,
        evidenceId: updated.id,
        expectedVersion: updated.version,
        maxAttempts: 3,
      });
      return { applied: true, evidence: evidenceRecord(updated) };
    },
    { isolationLevel: 'Serializable', timeout: 15_000 },
  );
}

export async function claimAfterSaleEvidenceInTransaction(
  transaction: StoreTransaction,
  context: StoreContext,
  input: Readonly<{
    afterSaleId: string;
    evidenceIds: readonly string[];
    ordinaryAccessTtlSeconds: number;
    retentionTtlSeconds: number;
  }>,
): Promise<readonly AfterSaleEvidenceRecord[]> {
  assertMemberContext(context);
  assertPositiveInteger(input.ordinaryAccessTtlSeconds, 10 * 365 * 24 * 60 * 60);
  assertPositiveInteger(input.retentionTtlSeconds, 10 * 365 * 24 * 60 * 60);
  if (
    !UUID_PATTERN.test(input.afterSaleId) ||
    input.evidenceIds.length < 1 ||
    input.evidenceIds.length > 6 ||
    new Set(input.evidenceIds).size !== input.evidenceIds.length ||
    input.evidenceIds.some((id) => !UUID_PATTERN.test(id)) ||
    input.retentionTtlSeconds <= input.ordinaryAccessTtlSeconds
  ) {
    throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_INPUT_INVALID');
  }
  await lockMemberEvidenceQuota(transaction, context.storeId, context.actor.id);
  const now = await clock(transaction);
  // Member RLS intentionally exposes the case as read-only. The quota lock serializes owner
  // claims; the evidence trigger takes the per-case advisory lock before enforcing six.
  const afterSales = await transaction.$queryRaw<Array<{ evidence_count: bigint; id: string }>>`
    SELECT sale.id,
      (SELECT pg_catalog.count(*)::bigint
       FROM after_sale_evidence_files evidence
       WHERE evidence.store_id = sale.store_id AND evidence.after_sale_id = sale.id)
        AS evidence_count
    FROM after_sales sale
    WHERE sale.store_id = ${context.storeId}::uuid
      AND sale.id = ${input.afterSaleId}::uuid
      AND sale.member_id = ${context.actor.id}::uuid
  `;
  const afterSale = afterSales[0];
  if (!afterSale) {
    throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_NOT_FOUND');
  }
  if (afterSale.evidence_count + BigInt(input.evidenceIds.length) > 6n) {
    throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_QUOTA_EXCEEDED');
  }
  const sortedIds = [...input.evidenceIds].sort((left, right) => left.localeCompare(right, 'en'));
  const locked = await transaction.$queryRaw<EvidenceRow[]>(Prisma.sql`
    SELECT id, store_id, member_id, after_sale_id, object_key, byte_size, status,
      upload_deadline_at, confirmed_at, scan_generation, claim_deadline_at,
      ordinary_access_deadline_at, retention_deadline_at, legal_hold_active,
      delete_attempt_count, next_delete_attempt_at, delete_exhausted_at, version
    FROM after_sale_evidence_files
    WHERE store_id = ${context.storeId}::uuid
      AND member_id = ${context.actor.id}::uuid
      AND id IN (${Prisma.join(sortedIds.map((id) => Prisma.sql`${id}::uuid`))})
    ORDER BY id
    FOR UPDATE
  `);
  if (
    locked.length !== sortedIds.length ||
    locked.some(
      (row) =>
        row.after_sale_id !== null ||
        row.status !== 'READY_UNCLAIMED' ||
        row.claim_deadline_at === null ||
        now >= row.claim_deadline_at ||
        row.legal_hold_active,
    )
  ) {
    throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_STATE_CONFLICT');
  }
  const ordinaryAccessDeadlineAt = new Date(now.getTime() + input.ordinaryAccessTtlSeconds * 1_000);
  const retentionDeadlineAt = new Date(now.getTime() + input.retentionTtlSeconds * 1_000);
  const claimed: AfterSaleEvidenceRecord[] = [];
  for (const row of locked) {
    const rows = await transaction.$queryRaw<EvidenceRow[]>`
      UPDATE after_sale_evidence_files
      SET after_sale_id = ${input.afterSaleId}::uuid, status = 'READY', claimed_at = ${now},
        ordinary_access_deadline_at = ${ordinaryAccessDeadlineAt},
        retention_deadline_at = ${retentionDeadlineAt}, version = version + 1,
        updated_at = ${now}
      WHERE store_id = ${context.storeId}::uuid AND id = ${row.id}::uuid
        AND member_id = ${context.actor.id}::uuid AND version = ${row.version}
      RETURNING id, store_id, member_id, after_sale_id, object_key, byte_size, status,
        upload_deadline_at, confirmed_at, scan_generation, claim_deadline_at,
        ordinary_access_deadline_at, retention_deadline_at, legal_hold_active,
        delete_attempt_count, next_delete_attempt_at, delete_exhausted_at, version
    `;
    const updated = rows[0];
    if (!updated) {
      throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_STATE_CONFLICT');
    }
    await appendEvidenceMessage(transaction, context, {
      availableAt: retentionDeadlineAt,
      eventType: AFTER_SALE_EVIDENCE_EXPIRE_EVENT,
      evidenceId: updated.id,
      expectedVersion: updated.version,
      maxAttempts: 3,
    });
    claimed.push(evidenceRecord(updated));
  }
  return claimed;
}

function deletionDeadline(row: EvidenceRow): Date | null {
  if (row.status === 'PENDING') return row.upload_deadline_at;
  if (row.status === 'READY') return row.retention_deadline_at;
  if (row.status === 'QUARANTINED' && row.retention_deadline_at !== null) {
    return row.retention_deadline_at;
  }
  if (row.status === 'READY_UNCLAIMED' || row.status === 'FAILED' || row.status === 'QUARANTINED') {
    return row.claim_deadline_at;
  }
  if (row.status === 'DELETE_FAILED') return row.next_delete_attempt_at;
  return null;
}

async function beginDeletionInTransaction(
  transaction: StoreTransaction,
  context: AfterSaleEvidenceSystemContext,
  input: Readonly<{ evidenceId: string; expectedVersion?: number; now: Date }>,
): Promise<
  Readonly<{ evidence: AfterSaleEvidenceRecord; outcome: 'HELD' | 'NOT_DUE' | 'READY' | 'STALE' }>
> {
  const current = await lockedEvidence(transaction, input.evidenceId);
  if (!current) {
    throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_NOT_FOUND');
  }
  if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
    return { evidence: evidenceRecord(current), outcome: 'STALE' };
  }
  if (current.status === 'DELETED') {
    return { evidence: evidenceRecord(current), outcome: 'NOT_DUE' };
  }
  if (current.legal_hold_active) {
    return { evidence: evidenceRecord(current), outcome: 'HELD' };
  }
  if (current.status === 'DELETION_PENDING') {
    return { evidence: evidenceRecord(current), outcome: 'READY' };
  }
  const deadline = deletionDeadline(current);
  if (deadline === null || input.now < deadline || current.delete_exhausted_at !== null) {
    return { evidence: evidenceRecord(current), outcome: 'NOT_DUE' };
  }
  const rows = await transaction.$queryRaw<EvidenceRow[]>`
    UPDATE after_sale_evidence_files
    SET status = 'DELETION_PENDING', next_delete_attempt_at = NULL,
      delete_error_code = NULL, delete_exhausted_at = NULL,
      version = version + 1, updated_at = ${input.now}
    WHERE store_id = ${context.storeId}::uuid AND id = ${input.evidenceId}::uuid
      AND version = ${current.version}
    RETURNING id, store_id, member_id, after_sale_id, object_key, byte_size, status,
      upload_deadline_at, confirmed_at, scan_generation, claim_deadline_at,
      ordinary_access_deadline_at, retention_deadline_at, legal_hold_active,
      delete_attempt_count, next_delete_attempt_at, delete_exhausted_at, version
  `;
  const updated = rows[0];
  if (!updated) {
    throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_STATE_CONFLICT');
  }
  if (current.status !== 'DELETE_FAILED') {
    await appendEvidenceMessage(transaction, context, {
      availableAt: input.now,
      eventType: AFTER_SALE_EVIDENCE_DELETE_EVENT,
      evidenceId: updated.id,
      expectedVersion: updated.version,
      maxAttempts: 3,
    });
  }
  return { evidence: evidenceRecord(updated), outcome: 'READY' };
}

export async function beginAfterSaleEvidenceDeletion(
  client: PrismaClient,
  context: AfterSaleEvidenceSystemContext,
  input: Readonly<{ evidenceId: string; expectedVersion: number; now?: Date }>,
): Promise<
  Readonly<{ evidence: AfterSaleEvidenceRecord; outcome: 'HELD' | 'NOT_DUE' | 'READY' | 'STALE' }>
> {
  if (!UUID_PATTERN.test(input.evidenceId)) {
    throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_INPUT_INVALID');
  }
  assertPositiveInteger(input.expectedVersion, Number.MAX_SAFE_INTEGER);
  if (input.now !== undefined) assertDate(input.now);
  return withAfterSaleEvidenceSystemTransaction(
    client,
    context,
    async (transaction) =>
      beginDeletionInTransaction(transaction, context, {
        evidenceId: input.evidenceId,
        expectedVersion: input.expectedVersion,
        now: input.now ?? (await clock(transaction)),
      }),
    { isolationLevel: 'Serializable', timeout: 15_000 },
  );
}

export type AfterSaleEvidenceObjectRecord = Readonly<{
  id: string;
  objectKey: string;
  role: 'DERIVATIVE' | 'ORIGINAL' | 'SCAN_TEMPORARY';
  version: number;
}>;

export async function listAfterSaleEvidenceDeletionObjects(
  client: PrismaClient,
  context: AfterSaleEvidenceSystemContext,
  input: Readonly<{ evidenceId: string; expectedVersion: number }>,
): Promise<readonly AfterSaleEvidenceObjectRecord[]> {
  if (!UUID_PATTERN.test(input.evidenceId)) {
    throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_INPUT_INVALID');
  }
  assertPositiveInteger(input.expectedVersion, Number.MAX_SAFE_INTEGER);
  return withAfterSaleEvidenceSystemTransaction(client, context, async (transaction) => {
    const evidence = await lockedEvidence(transaction, input.evidenceId);
    if (
      !evidence ||
      evidence.version !== input.expectedVersion ||
      evidence.status !== 'DELETION_PENDING' ||
      evidence.legal_hold_active
    ) {
      throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_STATE_CONFLICT');
    }
    const rows = await transaction.$queryRaw<
      Array<{
        id: string;
        object_key: string;
        object_role: AfterSaleEvidenceObjectRecord['role'];
        version: number;
      }>
    >`
      SELECT id, object_key, object_role, version
      FROM after_sale_evidence_objects
      WHERE store_id = ${context.storeId}::uuid
        AND evidence_file_id = ${input.evidenceId}::uuid
        AND object_key IS NOT NULL
      ORDER BY object_role, id
    `;
    return rows.map((row) => ({
      id: row.id,
      objectKey: row.object_key,
      role: row.object_role,
      version: row.version,
    }));
  });
}

type RecordDeletionFailureInTransactionInput = Readonly<{
  baseDelayMs: number;
  errorCode: string;
  evidenceId: string;
  expectedVersion?: number;
  maxAttempts: number;
  maxDelayMs: number;
  now: Date;
}>;

async function recordDeletionFailureInTransaction(
  transaction: StoreTransaction,
  context: AfterSaleEvidenceSystemContext,
  input: RecordDeletionFailureInTransactionInput,
): Promise<AfterSaleEvidenceRecord> {
  assertDeletionRetryPolicy(input);
  const current = await lockedEvidence(transaction, input.evidenceId);
  if (
    !current ||
    (input.expectedVersion !== undefined && current.version !== input.expectedVersion) ||
    current.status !== 'DELETION_PENDING' ||
    current.legal_hold_active
  ) {
    return stateConflict();
  }
  const attemptCount = current.delete_attempt_count + 1;
  if (attemptCount > DELETE_MAX_ATTEMPTS) return stateConflict();
  const exhausted = attemptCount === DELETE_MAX_ATTEMPTS;
  const nextAttemptAt = exhausted
    ? null
    : new Date(
        input.now.getTime() +
          Math.min(input.maxDelayMs, input.baseDelayMs * 2 ** (attemptCount - 1)),
      );
  const exhaustedAt = exhausted ? input.now : null;
  if (nextAttemptAt !== null && !Number.isFinite(nextAttemptAt.getTime())) {
    return stateConflict();
  }
  const rows = await transaction.$queryRaw<EvidenceRow[]>`
    UPDATE after_sale_evidence_files
    SET status = 'DELETE_FAILED', delete_attempt_count = ${attemptCount},
      next_delete_attempt_at = ${nextAttemptAt}, delete_error_code = ${input.errorCode},
      delete_exhausted_at = ${exhaustedAt}, version = version + 1, updated_at = ${input.now}
    WHERE store_id = ${context.storeId}::uuid AND id = ${input.evidenceId}::uuid
      AND version = ${current.version}
    RETURNING id, store_id, member_id, after_sale_id, object_key, byte_size, status,
      upload_deadline_at, confirmed_at, scan_generation, claim_deadline_at,
      ordinary_access_deadline_at, retention_deadline_at, legal_hold_active,
      delete_attempt_count, next_delete_attempt_at, delete_exhausted_at, version
  `;
  const updated = rows[0];
  if (!updated) return stateConflict();
  if (nextAttemptAt !== null) {
    await appendEvidenceMessage(transaction, context, {
      availableAt: nextAttemptAt,
      eventType: AFTER_SALE_EVIDENCE_DELETE_EVENT,
      evidenceId: updated.id,
      expectedVersion: updated.version,
      maxAttempts: 3,
    });
  }
  return evidenceRecord(updated);
}

export async function recordAfterSaleEvidenceDeletionFailure(
  client: PrismaClient,
  context: AfterSaleEvidenceSystemContext,
  input: Readonly<{
    baseDelayMs: number;
    errorCode: string;
    evidenceId: string;
    expectedVersion: number;
    maxAttempts: number;
    maxDelayMs: number;
    now?: Date;
  }>,
): Promise<AfterSaleEvidenceRecord> {
  assertDeletionRetryPolicy(input);
  assertPositiveInteger(input.expectedVersion, Number.MAX_SAFE_INTEGER);
  if (input.now !== undefined) assertDate(input.now);
  if (!UUID_PATTERN.test(input.evidenceId) || !STABLE_CODE_PATTERN.test(input.errorCode)) {
    throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_INPUT_INVALID');
  }
  return withAfterSaleEvidenceSystemTransaction(
    client,
    context,
    async (transaction) =>
      recordDeletionFailureInTransaction(transaction, context, {
        ...input,
        now: input.now ?? (await clock(transaction)),
      }),
    { isolationLevel: 'Serializable', timeout: 15_000 },
  );
}

export type AfterSaleEvidenceDeadLetterReconciliationOutcome =
  | 'DELETE_EXHAUSTED'
  | 'DELETE_HELD'
  | 'DELETE_RESCHEDULED'
  | 'DELETE_RETRY_SCHEDULED'
  | 'EXPIRE_DELETE_SCHEDULED'
  | 'EXPIRE_HELD'
  | 'EXPIRE_RESCHEDULED'
  | 'NOT_DEAD_LETTER'
  | 'SCAN_FAILED'
  | 'SUPERSEDED';

export type ReconcileAfterSaleEvidenceDeadLetterInput = Readonly<{
  deletionBaseDelayMs: number;
  deletionMaxAttempts: number;
  deletionMaxDelayMs: number;
  messageId: string;
  now?: Date;
  scanFailedRetentionSeconds: number;
}>;

export type AfterSaleEvidenceDeadLetterReconciliationResult = Readonly<{
  evidence: AfterSaleEvidenceRecord;
  eventType: AfterSaleEvidenceLifecycleEvent;
  outcome: AfterSaleEvidenceDeadLetterReconciliationOutcome;
}>;

function assertDeadLetterReconciliationInput(
  input: ReconcileAfterSaleEvidenceDeadLetterInput,
): void {
  assertPositiveInteger(input.scanFailedRetentionSeconds, 7 * 24 * 60 * 60);
  assertDeletionRetryPolicy({
    baseDelayMs: input.deletionBaseDelayMs,
    maxAttempts: input.deletionMaxAttempts,
    maxDelayMs: input.deletionMaxDelayMs,
  });
  if (input.now !== undefined) assertDate(input.now);
  if (!UUID_PATTERN.test(input.messageId)) {
    throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_INPUT_INVALID');
  }
}

async function reconcileScanDeadLetterInTransaction(
  transaction: StoreTransaction,
  context: AfterSaleEvidenceSystemContext,
  input: Readonly<{
    current: EvidenceRow;
    now: Date;
    parsed: ParsedEvidenceOutbox;
    scanFailedRetentionSeconds: number;
  }>,
): Promise<AfterSaleEvidenceDeadLetterReconciliationResult> {
  if (
    input.current.version < input.parsed.expectedVersion ||
    input.current.status !== 'PENDING' ||
    input.current.confirmed_at === null ||
    input.current.scan_generation < 1
  ) {
    return {
      evidence: evidenceRecord(input.current),
      eventType: input.parsed.eventType,
      outcome: 'SUPERSEDED',
    };
  }
  if (
    input.current.version > input.parsed.expectedVersion &&
    (await hasEvidenceOutboxIdentity(transaction, context, {
      eventType: AFTER_SALE_EVIDENCE_SCAN_EVENT,
      evidenceId: input.current.id,
      expectedVersion: input.current.version,
    }))
  ) {
    return {
      evidence: evidenceRecord(input.current),
      eventType: input.parsed.eventType,
      outcome: 'SUPERSEDED',
    };
  }
  const claimDeadlineAt = new Date(input.now.getTime() + input.scanFailedRetentionSeconds * 1_000);
  if (!Number.isFinite(claimDeadlineAt.getTime())) return stateConflict();
  const rows = await transaction.$queryRaw<EvidenceRow[]>`
    UPDATE after_sale_evidence_files
    SET status = 'FAILED', scan_result_code = 'SCAN_OUTBOX_DEAD_LETTER',
      scan_completed_at = ${input.now}, scanner_engine = NULL,
      scanner_engine_version = NULL, scanner_signature_version = NULL,
      claim_deadline_at = ${claimDeadlineAt}, version = version + 1,
      updated_at = ${input.now}
    WHERE store_id = ${context.storeId}::uuid AND id = ${input.current.id}::uuid
      AND status = 'PENDING' AND confirmed_at IS NOT NULL AND scan_generation > 0
      AND version = ${input.current.version}
    RETURNING id, store_id, member_id, after_sale_id, object_key, byte_size, status,
      upload_deadline_at, confirmed_at, scan_generation, claim_deadline_at,
      ordinary_access_deadline_at, retention_deadline_at, legal_hold_active,
      delete_attempt_count, next_delete_attempt_at, delete_exhausted_at, version
  `;
  const failed = rows[0];
  if (!failed) return stateConflict();
  await appendEvidenceMessage(transaction, context, {
    availableAt: claimDeadlineAt,
    eventType: AFTER_SALE_EVIDENCE_EXPIRE_EVENT,
    evidenceId: failed.id,
    expectedVersion: failed.version,
    maxAttempts: 3,
  });
  return {
    evidence: evidenceRecord(failed),
    eventType: input.parsed.eventType,
    outcome: 'SCAN_FAILED',
  };
}

async function reconcileExpireDeadLetterInTransaction(
  transaction: StoreTransaction,
  context: AfterSaleEvidenceSystemContext,
  input: Readonly<{
    current: EvidenceRow;
    message: EvidenceOutboxRow;
    now: Date;
    parsed: ParsedEvidenceOutbox;
  }>,
): Promise<AfterSaleEvidenceDeadLetterReconciliationResult> {
  if (
    input.current.version < input.parsed.expectedVersion ||
    (input.current.status === 'PENDING' && input.current.confirmed_at !== null) ||
    !['PENDING', 'READY_UNCLAIMED', 'READY', 'FAILED', 'QUARANTINED'].includes(input.current.status)
  ) {
    return {
      evidence: evidenceRecord(input.current),
      eventType: input.parsed.eventType,
      outcome: 'SUPERSEDED',
    };
  }
  const versionMatches = input.current.version === input.parsed.expectedVersion;
  if (
    !versionMatches &&
    (await hasEvidenceOutboxIdentity(transaction, context, {
      eventType: AFTER_SALE_EVIDENCE_EXPIRE_EVENT,
      evidenceId: input.current.id,
      expectedVersion: input.current.version,
    }))
  ) {
    return {
      evidence: evidenceRecord(input.current),
      eventType: input.parsed.eventType,
      outcome: 'SUPERSEDED',
    };
  }
  const deadline = deletionDeadline(input.current);
  if (!(deadline instanceof Date) || !Number.isFinite(deadline.getTime())) {
    return stateConflict();
  }
  if (input.current.legal_hold_active) {
    return {
      evidence: evidenceRecord(input.current),
      eventType: input.parsed.eventType,
      outcome: 'EXPIRE_HELD',
    };
  }
  if (input.now < deadline) {
    if (versionMatches) {
      await rescheduleDeadLetterOutbox(transaction, context, {
        availableAt: deadline,
        message: input.message,
        now: input.now,
      });
    } else {
      await appendEvidenceMessage(transaction, context, {
        availableAt: deadline,
        eventType: AFTER_SALE_EVIDENCE_EXPIRE_EVENT,
        evidenceId: input.current.id,
        expectedVersion: input.current.version,
        maxAttempts: 3,
      });
    }
    return {
      evidence: evidenceRecord(input.current),
      eventType: input.parsed.eventType,
      outcome: 'EXPIRE_RESCHEDULED',
    };
  }
  const begun = await beginDeletionInTransaction(transaction, context, {
    evidenceId: input.current.id,
    expectedVersion: input.current.version,
    now: input.now,
  });
  if (begun.outcome !== 'READY') return stateConflict();
  return {
    evidence: begun.evidence,
    eventType: input.parsed.eventType,
    outcome: 'EXPIRE_DELETE_SCHEDULED',
  };
}

async function reconcileDeleteDeadLetterInTransaction(
  transaction: StoreTransaction,
  context: AfterSaleEvidenceSystemContext,
  input: Readonly<{
    current: EvidenceRow;
    deletionBaseDelayMs: number;
    deletionMaxAttempts: number;
    deletionMaxDelayMs: number;
    message: EvidenceOutboxRow;
    now: Date;
    parsed: ParsedEvidenceOutbox;
  }>,
): Promise<AfterSaleEvidenceDeadLetterReconciliationResult> {
  if (
    input.current.version < input.parsed.expectedVersion ||
    (input.current.status !== 'DELETION_PENDING' && input.current.status !== 'DELETE_FAILED')
  ) {
    return {
      evidence: evidenceRecord(input.current),
      eventType: input.parsed.eventType,
      outcome: 'SUPERSEDED',
    };
  }
  const versionMatches = input.current.version === input.parsed.expectedVersion;
  if (
    !versionMatches &&
    (await hasEvidenceOutboxIdentity(transaction, context, {
      eventType: AFTER_SALE_EVIDENCE_DELETE_EVENT,
      evidenceId: input.current.id,
      expectedVersion: input.current.version,
    }))
  ) {
    return {
      evidence: evidenceRecord(input.current),
      eventType: input.parsed.eventType,
      outcome: 'SUPERSEDED',
    };
  }
  if (input.current.legal_hold_active) {
    return {
      evidence: evidenceRecord(input.current),
      eventType: input.parsed.eventType,
      outcome: 'DELETE_HELD',
    };
  }
  let deletionPendingVersion = input.current.version;
  if (input.current.status === 'DELETE_FAILED') {
    if (input.current.delete_exhausted_at !== null) {
      return {
        evidence: evidenceRecord(input.current),
        eventType: input.parsed.eventType,
        outcome: 'DELETE_EXHAUSTED',
      };
    }
    const nextAttemptAt = input.current.next_delete_attempt_at;
    if (!(nextAttemptAt instanceof Date) || !Number.isFinite(nextAttemptAt.getTime())) {
      return stateConflict();
    }
    if (input.now < nextAttemptAt) {
      if (versionMatches) {
        await rescheduleDeadLetterOutbox(transaction, context, {
          availableAt: nextAttemptAt,
          message: input.message,
          now: input.now,
        });
      } else {
        await appendEvidenceMessage(transaction, context, {
          availableAt: nextAttemptAt,
          eventType: AFTER_SALE_EVIDENCE_DELETE_EVENT,
          evidenceId: input.current.id,
          expectedVersion: input.current.version,
          maxAttempts: 3,
        });
      }
      return {
        evidence: evidenceRecord(input.current),
        eventType: input.parsed.eventType,
        outcome: 'DELETE_RESCHEDULED',
      };
    }
    const begun = await beginDeletionInTransaction(transaction, context, {
      evidenceId: input.current.id,
      expectedVersion: input.current.version,
      now: input.now,
    });
    if (begun.outcome !== 'READY') return stateConflict();
    deletionPendingVersion = begun.evidence.version;
  }
  const failed = await recordDeletionFailureInTransaction(transaction, context, {
    baseDelayMs: input.deletionBaseDelayMs,
    errorCode: 'DELETE_OUTBOX_DEAD_LETTER',
    evidenceId: input.current.id,
    expectedVersion: deletionPendingVersion,
    maxAttempts: input.deletionMaxAttempts,
    maxDelayMs: input.deletionMaxDelayMs,
    now: input.now,
  });
  return {
    evidence: failed,
    eventType: input.parsed.eventType,
    outcome: failed.deleteExhaustedAt === null ? 'DELETE_RETRY_SCHEDULED' : 'DELETE_EXHAUSTED',
  };
}

export async function reconcileAfterSaleEvidenceDeadLetter(
  client: PrismaClient,
  context: AfterSaleEvidenceSystemContext,
  input: ReconcileAfterSaleEvidenceDeadLetterInput,
): Promise<AfterSaleEvidenceDeadLetterReconciliationResult> {
  assertDeadLetterReconciliationInput(input);
  return withAfterSaleEvidenceSystemTransaction(
    client,
    context,
    async (transaction) => {
      const snapshot = await evidenceOutbox(transaction, context, input.messageId);
      if (!snapshot) return stateConflict();
      const snapshotParsed = parseEvidenceOutbox(snapshot, context.storeId);
      const current = await lockedEvidence(transaction, snapshotParsed.evidenceId);
      if (!current) return stateConflict();
      const message = await lockedEvidenceOutbox(transaction, context, input.messageId);
      if (!message) return stateConflict();
      const parsed = parseEvidenceOutbox(message, context.storeId);
      if (
        message.id !== snapshot.id ||
        parsed.evidenceId !== snapshotParsed.evidenceId ||
        parsed.eventType !== snapshotParsed.eventType ||
        parsed.expectedVersion !== snapshotParsed.expectedVersion
      ) {
        return stateConflict();
      }
      if (message.status !== 'DEAD_LETTER') {
        return {
          evidence: evidenceRecord(current),
          eventType: parsed.eventType,
          outcome: 'NOT_DEAD_LETTER',
        };
      }
      assertDeadLetterShape(message);
      const now = input.now ?? (await clock(transaction));
      if (parsed.eventType === AFTER_SALE_EVIDENCE_SCAN_EVENT) {
        return reconcileScanDeadLetterInTransaction(transaction, context, {
          current,
          now,
          parsed,
          scanFailedRetentionSeconds: input.scanFailedRetentionSeconds,
        });
      }
      if (parsed.eventType === AFTER_SALE_EVIDENCE_EXPIRE_EVENT) {
        return reconcileExpireDeadLetterInTransaction(transaction, context, {
          current,
          message,
          now,
          parsed,
        });
      }
      return reconcileDeleteDeadLetterInTransaction(transaction, context, {
        current,
        deletionBaseDelayMs: input.deletionBaseDelayMs,
        deletionMaxAttempts: input.deletionMaxAttempts,
        deletionMaxDelayMs: input.deletionMaxDelayMs,
        message,
        now,
        parsed,
      });
    },
    { isolationLevel: 'Serializable', timeout: 15_000 },
  );
}

export async function completeAfterSaleEvidenceDeletion(
  client: PrismaClient,
  context: AfterSaleEvidenceSystemContext,
  input: Readonly<{
    evidenceId: string;
    expectedVersion: number;
    objects: readonly Readonly<{ id: string; expectedVersion: number }>[];
    now?: Date;
  }>,
): Promise<AfterSaleEvidenceRecord> {
  if (
    !UUID_PATTERN.test(input.evidenceId) ||
    input.objects.length < 1 ||
    new Set(input.objects.map(({ id }) => id)).size !== input.objects.length ||
    input.objects.some(
      ({ expectedVersion, id }) =>
        !UUID_PATTERN.test(id) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1,
    )
  ) {
    throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_INPUT_INVALID');
  }
  assertPositiveInteger(input.expectedVersion, Number.MAX_SAFE_INTEGER);
  if (input.now !== undefined) assertDate(input.now);
  return withAfterSaleEvidenceSystemTransaction(
    client,
    context,
    async (transaction) => {
      const now = input.now ?? (await clock(transaction));
      const memberId = await evidenceOwner(transaction, input.evidenceId);
      if (!memberId) {
        throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_NOT_FOUND');
      }
      await lockMemberEvidenceQuota(transaction, context.storeId, memberId);
      const current = await lockedEvidence(transaction, input.evidenceId);
      if (
        !current ||
        current.version !== input.expectedVersion ||
        current.status !== 'DELETION_PENDING' ||
        current.legal_hold_active
      ) {
        throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_STATE_CONFLICT');
      }
      const objects = await transaction.$queryRaw<Array<{ id: string; version: number }>>`
        SELECT id, version FROM after_sale_evidence_objects
        WHERE store_id = ${context.storeId}::uuid
          AND evidence_file_id = ${input.evidenceId}::uuid AND object_key IS NOT NULL
        ORDER BY id FOR UPDATE
      `;
      const expectedObjects = [...input.objects].sort((left, right) =>
        left.id.localeCompare(right.id, 'en'),
      );
      if (
        objects.length !== expectedObjects.length ||
        objects.some(
          (object, index) =>
            object.id !== expectedObjects[index]?.id ||
            object.version !== expectedObjects[index]?.expectedVersion,
        )
      ) {
        throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_STATE_CONFLICT');
      }
      for (const object of objects) {
        const affected = await transaction.$executeRaw`
          UPDATE after_sale_evidence_objects
          SET object_key = NULL, deleted_at = ${now}, version = version + 1, updated_at = ${now}
          WHERE store_id = ${context.storeId}::uuid AND id = ${object.id}::uuid
            AND version = ${object.version} AND object_key IS NOT NULL
        `;
        if (affected !== 1) {
          throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_STATE_CONFLICT');
        }
      }
      const rows = await transaction.$queryRaw<EvidenceRow[]>`
        UPDATE after_sale_evidence_files
        SET status = 'DELETED', object_key = NULL, derivative_object_keys = NULL,
          scan_temporary_object_key = NULL, original_filename = NULL,
          scan_result_code = NULL, scanner_engine = NULL, scanner_engine_version = NULL,
          scanner_signature_version = NULL, next_delete_attempt_at = NULL,
          delete_error_code = NULL, delete_exhausted_at = NULL, deleted_at = ${now},
          version = version + 1, updated_at = ${now}
        WHERE store_id = ${context.storeId}::uuid AND id = ${input.evidenceId}::uuid
          AND version = ${current.version}
        RETURNING id, store_id, member_id, after_sale_id, object_key, byte_size, status,
          upload_deadline_at, confirmed_at, scan_generation, claim_deadline_at,
          ordinary_access_deadline_at, retention_deadline_at, legal_hold_active,
          delete_attempt_count, next_delete_attempt_at, delete_exhausted_at, version
      `;
      const deleted = rows[0];
      if (!deleted) {
        throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_STATE_CONFLICT');
      }
      return evidenceRecord(deleted);
    },
    { isolationLevel: 'Serializable', timeout: 15_000 },
  );
}
