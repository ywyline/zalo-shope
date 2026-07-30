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
import { appendOutboxMessageInTransaction, ReliableMessagingError } from './reliable-messaging';

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

export type AfterSaleEvidenceProtectedReadSnapshot = Readonly<{
  afterSaleId: string;
  evidenceId: string;
  legalHoldActive: boolean;
  objectKey: string;
  ordinaryAccessDeadlineAt: Date;
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

type ScanWorkRow = {
  byte_size: bigint;
  checksum_sha256: string;
  deployment_environment: string;
  evidence_id: string;
  mime_type: string;
  object_key: string;
  scan_generation: number;
};

type EvidenceConfirmationRow = EvidenceRow & {
  checksum_sha256: string;
  deployment_environment: string;
  mime_type: string;
};

type ProtectedReadEvidenceRow = Readonly<{
  after_sale_id: string | null;
  id: string;
  legal_hold_active: boolean;
  member_id: string;
  object_key: string | null;
  ordinary_access_deadline_at: Date | null;
  status: AfterSaleEvidenceStatus;
  store_id: string;
  version: number;
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
const SCAN_LEASE_TRANSACTION_TIMEOUT_MS = 2_000;
const PROTECTED_READ_FINALIZATION_SAFETY_MS = 1_000;

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

function assertAdminContext(context: StoreContext): void {
  if (context.actor.type !== 'admin') {
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

function protectedReadAuthorizationDeadline(context: StoreContext): Date | undefined {
  if (context.accessTokenExpiresAt === undefined || context.accessSessionExpiresAt === undefined) {
    return undefined;
  }
  const tokenExpiresAt = new Date(context.accessTokenExpiresAt);
  const sessionExpiresAt = new Date(context.accessSessionExpiresAt);
  if (!Number.isFinite(tokenExpiresAt.getTime()) || !Number.isFinite(sessionExpiresAt.getTime())) {
    return undefined;
  }
  return new Date(Math.min(tokenExpiresAt.getTime(), sessionExpiresAt.getTime()));
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

async function wallClock(transaction: StoreTransaction): Promise<Date> {
  const row = (
    await transaction.$queryRaw<ClockRow[]>`
      SELECT pg_catalog.clock_timestamp() AS current_time
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

async function protectedReadEvidenceSnapshot(
  transaction: StoreTransaction,
  evidenceId: string,
): Promise<ProtectedReadEvidenceRow | undefined> {
  return (
    await transaction.$queryRaw<ProtectedReadEvidenceRow[]>`
      SELECT id, store_id, member_id, after_sale_id, object_key, status, legal_hold_active,
        ordinary_access_deadline_at, version
      FROM after_sale_evidence_files
      WHERE store_id = app_security.current_store_id()
        AND id = ${evidenceId}::uuid
    `
  )[0];
}

async function lockedProtectedReadEvidenceSnapshot(
  transaction: StoreTransaction,
  input: Readonly<{
    afterSaleId: string;
    evidenceId: string;
    targetExpiresAt: Date;
  }>,
): Promise<ProtectedReadEvidenceRow | undefined> {
  return (
    await transaction.$queryRaw<ProtectedReadEvidenceRow[]>`
      SELECT id, store_id, member_id, after_sale_id, object_key, status, legal_hold_active,
        ordinary_access_deadline_at, version
      FROM app_security.lock_m63_b2b_protected_evidence_read_authorized(
        ${input.evidenceId}::uuid,
        ${input.afterSaleId}::uuid,
        ${input.targetExpiresAt}::timestamptz
      )
    `
  )[0];
}

function assertProtectedReadInput(
  input: Readonly<{ afterSaleId: string; evidenceId: string }>,
): void {
  if (!UUID_PATTERN.test(input.afterSaleId) || !UUID_PATTERN.test(input.evidenceId)) {
    throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_INPUT_INVALID');
  }
}

function protectedReadSnapshot(
  row: ProtectedReadEvidenceRow | undefined,
  context: StoreContext,
  input: Readonly<{ afterSaleId: string; evidenceId: string }> &
    Readonly<{
      memberId?: string;
      previous?: AfterSaleEvidenceProtectedReadSnapshot;
      targetExpiresAt?: Date;
    }>,
  now: Date,
): AfterSaleEvidenceProtectedReadSnapshot {
  const authorizationDeadline = protectedReadAuthorizationDeadline(context);
  const holdOnlyVersionDrift =
    input.previous !== undefined &&
    row !== undefined &&
    row.version === input.previous.version + 1 &&
    row.legal_hold_active !== input.previous.legalHoldActive;
  if (
    !row ||
    row.id !== input.evidenceId ||
    row.store_id !== context.storeId ||
    row.after_sale_id !== input.afterSaleId ||
    row.status !== 'READY' ||
    row.object_key === null ||
    row.ordinary_access_deadline_at === null ||
    now >= row.ordinary_access_deadline_at ||
    (input.memberId !== undefined && row.member_id !== input.memberId) ||
    (input.previous !== undefined &&
      (row.object_key !== input.previous.objectKey ||
        row.ordinary_access_deadline_at.getTime() !==
          input.previous.ordinaryAccessDeadlineAt.getTime() ||
        (row.version !== input.previous.version && !holdOnlyVersionDrift))) ||
    (input.targetExpiresAt !== undefined &&
      (!(input.targetExpiresAt instanceof Date) ||
        !Number.isFinite(input.targetExpiresAt.getTime()) ||
        authorizationDeadline === undefined ||
        now >= authorizationDeadline ||
        input.targetExpiresAt.getTime() <= now.getTime() + PROTECTED_READ_FINALIZATION_SAFETY_MS ||
        input.targetExpiresAt > authorizationDeadline ||
        input.targetExpiresAt >= row.ordinary_access_deadline_at))
  ) {
    throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_NOT_FOUND');
  }
  return {
    afterSaleId: row.after_sale_id,
    evidenceId: row.id,
    legalHoldActive: row.legal_hold_active,
    objectKey: row.object_key,
    ordinaryAccessDeadlineAt: row.ordinary_access_deadline_at,
    version: row.version,
  };
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

export type AfterSaleEvidenceScanLeaseInput = Readonly<{
  outboxExpectedVersion: number;
  outboxMessageId: string;
  workerId: string;
}>;

export type AfterSaleEvidenceLifecycleLeaseInput = Readonly<{
  outboxExpectedVersion: number;
  outboxMessageId: string;
  workerId: string;
}>;

function assertEvidenceOutboxLeaseInput(input: AfterSaleEvidenceScanLeaseInput): void {
  if (
    !UUID_PATTERN.test(input.outboxMessageId) ||
    !Number.isSafeInteger(input.outboxExpectedVersion) ||
    input.outboxExpectedVersion < 1 ||
    !input.workerId.trim() ||
    input.workerId.length > 128
  ) {
    throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_INPUT_INVALID');
  }
}

function assertEvidenceLifecycleLeaseInput(input: AfterSaleEvidenceLifecycleLeaseInput): void {
  if (
    !UUID_PATTERN.test(input.outboxMessageId) ||
    !Number.isSafeInteger(input.outboxExpectedVersion) ||
    input.outboxExpectedVersion < 1 ||
    !input.workerId.trim() ||
    input.workerId.length > 128
  ) {
    throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_INPUT_INVALID');
  }
}

async function lockedValidEvidenceLifecycleOutboxLease(
  transaction: StoreTransaction,
  context: AfterSaleEvidenceSystemContext,
  input: AfterSaleEvidenceLifecycleLeaseInput,
  eventType: typeof AFTER_SALE_EVIDENCE_EXPIRE_EVENT | typeof AFTER_SALE_EVIDENCE_DELETE_EVENT,
): Promise<Readonly<{ message: EvidenceOutboxRow; parsed: ParsedEvidenceOutbox; now: Date }>> {
  const message = await lockedEvidenceOutbox(transaction, context, input.outboxMessageId);
  const now = await wallClock(transaction);
  if (
    !message ||
    message.status !== 'PROCESSING' ||
    message.lease_owner !== input.workerId ||
    !(message.lease_expires_at instanceof Date) ||
    message.lease_expires_at <= now ||
    message.version !== input.outboxExpectedVersion
  ) {
    throw new ReliableMessagingError('OUTBOX_LEASE_LOST');
  }
  const parsed = parseEvidenceOutbox(message, context.storeId);
  if (parsed.eventType !== eventType) return stateConflict();
  return { message, parsed, now };
}

async function lockedValidScanOutboxLease(
  transaction: StoreTransaction,
  context: AfterSaleEvidenceSystemContext,
  input: AfterSaleEvidenceScanLeaseInput,
): Promise<Readonly<{ message: EvidenceOutboxRow; parsed: ParsedEvidenceOutbox }>> {
  const message = await lockedEvidenceOutbox(transaction, context, input.outboxMessageId);
  const current = await assertLockedScanOutboxLeaseCurrent(transaction, message, input);
  const parsed = parseEvidenceOutbox(current.message, context.storeId);
  if (parsed.eventType !== AFTER_SALE_EVIDENCE_SCAN_EVENT) return stateConflict();
  return { message: current.message, parsed };
}

async function assertLockedScanOutboxLeaseCurrent(
  transaction: StoreTransaction,
  message: EvidenceOutboxRow | undefined,
  input: AfterSaleEvidenceScanLeaseInput,
): Promise<Readonly<{ message: EvidenceOutboxRow; now: Date }>> {
  const now = await wallClock(transaction);
  if (
    !message ||
    message.status !== 'PROCESSING' ||
    message.lease_owner !== input.workerId ||
    !(message.lease_expires_at instanceof Date) ||
    message.lease_expires_at <= now ||
    message.version !== input.outboxExpectedVersion
  ) {
    throw new ReliableMessagingError('OUTBOX_LEASE_LOST');
  }
  return { message, now };
}

async function evidenceOutboxIdentity(
  transaction: StoreTransaction,
  context: AfterSaleEvidenceSystemContext,
  input: Readonly<{
    eventType: AfterSaleEvidenceLifecycleEvent;
    evidenceId: string;
    expectedVersion: number;
  }>,
): Promise<EvidenceOutboxRow | undefined> {
  return (
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
  const row = await evidenceOutboxIdentity(transaction, context, input);
  if (!row) return false;
  const parsed = parseEvidenceOutbox(row, context.storeId);
  return (
    parsed.evidenceId === input.evidenceId &&
    parsed.eventType === input.eventType &&
    parsed.expectedVersion === input.expectedVersion
  );
}

async function hasConvergentScanOutboxIdentity(
  transaction: StoreTransaction,
  context: AfterSaleEvidenceSystemContext,
  input: Readonly<{ evidenceId: string; expectedVersion: number }>,
): Promise<boolean> {
  const row = await evidenceOutboxIdentity(transaction, context, {
    ...input,
    eventType: AFTER_SALE_EVIDENCE_SCAN_EVENT,
  });
  if (!row || row.status === 'COMPLETED') return false;
  const parsed = parseEvidenceOutbox(row, context.storeId);
  return (
    parsed.evidenceId === input.evidenceId &&
    parsed.eventType === AFTER_SALE_EVIDENCE_SCAN_EVENT &&
    parsed.expectedVersion === input.expectedVersion
  );
}

async function hasNewerConvergentScanOutboxIdentity(
  transaction: StoreTransaction,
  context: AfterSaleEvidenceSystemContext,
  input: Readonly<{
    currentEvidenceVersion: number;
    evidenceId: string;
    oldExpectedVersion: number;
  }>,
): Promise<boolean> {
  const row = (
    await transaction.$queryRaw<EvidenceOutboxRow[]>`
      SELECT id, store_id, aggregate_type, aggregate_id, event_type, event_version,
        payload, status, lease_owner, lease_expires_at, completed_at, version
      FROM outbox_messages newer
      WHERE newer.store_id = ${context.storeId}::uuid
        AND newer.aggregate_type = ${AFTER_SALE_EVIDENCE_AGGREGATE_TYPE}
        AND newer.aggregate_id = ${input.evidenceId}::uuid
        AND newer.event_type = ${AFTER_SALE_EVIDENCE_SCAN_EVENT}
        AND newer.event_version = 1
        AND newer.status IN (
          'PENDING'::outbox_status,
          'PROCESSING'::outbox_status,
          'DEAD_LETTER'::outbox_status
        )
        AND (
          (
            newer.status = 'PENDING'::outbox_status
            AND newer.lease_owner IS NULL AND newer.lease_expires_at IS NULL
            AND newer.completed_at IS NULL
          ) OR (
            newer.status = 'PROCESSING'::outbox_status
            AND newer.lease_owner IS NOT NULL AND newer.lease_expires_at IS NOT NULL
            AND newer.completed_at IS NULL
          ) OR (
            newer.status = 'DEAD_LETTER'::outbox_status
            AND newer.lease_owner IS NULL AND newer.lease_expires_at IS NULL
            AND newer.completed_at IS NOT NULL
          )
        )
        AND pg_catalog.jsonb_typeof(newer.payload) = 'object'
        AND newer.payload ?& ARRAY['evidence_id', 'expected_version', 'store_id']::text[]
        AND newer.payload - ARRAY['evidence_id', 'expected_version', 'store_id']::text[] = '{}'::jsonb
        AND newer.payload->>'store_id' = newer.store_id::text
        AND newer.payload->>'evidence_id' = newer.aggregate_id::text
        AND CASE
          WHEN pg_catalog.jsonb_typeof(newer.payload->'expected_version') = 'number'
            AND newer.payload->>'expected_version' ~ '^[1-9][0-9]*$'
          THEN (newer.payload->>'expected_version')::numeric <= 9007199254740991
            AND (newer.payload->>'expected_version')::numeric > ${input.oldExpectedVersion}
            AND (newer.payload->>'expected_version')::numeric <= ${input.currentEvidenceVersion}
          ELSE false
        END
      ORDER BY newer.id DESC
      LIMIT 1
    `
  )[0];
  if (!row) return false;
  const parsed = parseEvidenceOutbox(row, context.storeId);
  return (
    parsed.eventType === AFTER_SALE_EVIDENCE_SCAN_EVENT &&
    parsed.evidenceId === input.evidenceId &&
    parsed.expectedVersion > input.oldExpectedVersion &&
    parsed.expectedVersion <= input.currentEvidenceVersion
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

export type AfterSaleEvidenceUploadConfirmationPreparation =
  | Readonly<{
      declaration: Readonly<{
        byteSize: number;
        checksumSha256: string;
        deploymentEnvironment: string;
        evidenceId: string;
        mimeType: AfterSaleEvidenceMimeType;
        objectKey: string;
        storeId: string;
      }>;
      replayed: false;
    }>
  | Readonly<{ evidence: AfterSaleEvidenceRecord; replayed: true }>;

export async function prepareAfterSaleEvidenceUploadConfirmation(
  client: PrismaClient,
  context: StoreContext,
  input: Readonly<{
    evidenceId: string;
    expectedVersion: number;
    idempotencyKey: string;
  }>,
): Promise<AfterSaleEvidenceUploadConfirmationPreparation> {
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
      const now = await clock(transaction);
      const replay = await transaction.idempotencyRecord.findUnique({
        where: {
          storeId_operation_idempotencyKey: {
            idempotencyKey: keyHash,
            operation,
            storeId: context.storeId,
          },
        },
      });
      if (replay && replay.expiresAt > now) {
        if (replay.memberId !== context.actor.id || replay.requestHash !== requestHash) {
          throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_IDEMPOTENCY_CONFLICT');
        }
        const row = await evidenceSnapshot(transaction, input.evidenceId);
        if (!row || row.member_id !== context.actor.id || row.confirmed_at === null) {
          throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_STATE_CONFLICT');
        }
        return { evidence: evidenceRecord(row), replayed: true };
      }

      const rows = await transaction.$queryRaw<EvidenceConfirmationRow[]>`
        SELECT evidence.id, evidence.store_id, evidence.member_id, evidence.after_sale_id,
          evidence.object_key, evidence.byte_size, evidence.status,
          evidence.upload_deadline_at, evidence.confirmed_at, evidence.scan_generation,
          evidence.claim_deadline_at, evidence.ordinary_access_deadline_at,
          evidence.retention_deadline_at, evidence.legal_hold_active,
          evidence.delete_attempt_count, evidence.next_delete_attempt_at,
          evidence.delete_exhausted_at, evidence.version, evidence.checksum_sha256,
          evidence.mime_type,
          split_part(evidence.object_key, '/', 1) AS deployment_environment
        FROM after_sale_evidence_files AS evidence
        WHERE evidence.store_id = ${context.storeId}::uuid
          AND evidence.member_id = ${context.actor.id}::uuid
          AND evidence.id = ${input.evidenceId}::uuid
      `;
      const row = rows[0];
      if (!row) {
        throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_NOT_FOUND');
      }
      if (
        row.version !== input.expectedVersion ||
        row.status !== 'PENDING' ||
        row.confirmed_at !== null ||
        row.upload_deadline_at === null ||
        now >= row.upload_deadline_at ||
        row.object_key === null ||
        !CHECKSUM_PATTERN.test(row.checksum_sha256) ||
        !ENVIRONMENT_PATTERN.test(row.deployment_environment) ||
        !AFTER_SALE_EVIDENCE_MIME_TYPES.includes(row.mime_type as AfterSaleEvidenceMimeType) ||
        row.byte_size < 1n ||
        row.byte_size > BigInt(Number.MAX_SAFE_INTEGER)
      ) {
        throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_STATE_CONFLICT');
      }
      return {
        declaration: {
          byteSize: Number(row.byte_size),
          checksumSha256: row.checksum_sha256,
          deploymentEnvironment: row.deployment_environment,
          evidenceId: row.id,
          mimeType: row.mime_type as AfterSaleEvidenceMimeType,
          objectKey: row.object_key,
          storeId: row.store_id,
        },
        replayed: false,
      };
    },
    { isolationLevel: 'RepeatableRead', timeout: 15_000 },
  );
}

export async function readMemberAfterSaleEvidenceUpload(
  client: PrismaClient,
  context: StoreContext,
  evidenceId: string,
): Promise<Readonly<{ evidence: AfterSaleEvidenceRecord; observedAt: Date }>> {
  assertMemberContext(context);
  if (!UUID_PATTERN.test(evidenceId)) {
    throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_INPUT_INVALID');
  }
  return withStoreTransaction(
    client,
    context,
    async (transaction) => {
      const observedAt = await clock(transaction);
      const row = await evidenceSnapshot(transaction, evidenceId);
      if (!row || row.member_id !== context.actor.id || row.store_id !== context.storeId) {
        throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_NOT_FOUND');
      }
      return { evidence: evidenceRecord(row), observedAt };
    },
    { isolationLevel: 'RepeatableRead', timeout: 15_000 },
  );
}

export async function prepareMemberAfterSaleEvidenceProtectedRead(
  client: PrismaClient,
  context: StoreContext,
  input: Readonly<{ afterSaleId: string; evidenceId: string }>,
): Promise<AfterSaleEvidenceProtectedReadSnapshot> {
  assertMemberContext(context);
  assertProtectedReadInput(input);
  return withStoreTransaction(
    client,
    context,
    async (transaction) =>
      protectedReadSnapshot(
        await protectedReadEvidenceSnapshot(transaction, input.evidenceId),
        context,
        { ...input, memberId: context.actor.id },
        await wallClock(transaction),
      ),
    { isolationLevel: 'RepeatableRead', timeout: 15_000 },
  );
}

export async function prepareAdminAfterSaleEvidenceProtectedRead(
  client: PrismaClient,
  context: StoreContext,
  input: Readonly<{ afterSaleId: string; evidenceId: string }>,
): Promise<AfterSaleEvidenceProtectedReadSnapshot> {
  assertAdminContext(context);
  assertProtectedReadInput(input);
  return withStoreTransaction(
    client,
    context,
    async (transaction) =>
      protectedReadSnapshot(
        await protectedReadEvidenceSnapshot(transaction, input.evidenceId),
        context,
        input,
        await wallClock(transaction),
      ),
    { isolationLevel: 'RepeatableRead', timeout: 15_000 },
  );
}

export async function revalidateMemberAfterSaleEvidenceProtectedReadInTransaction(
  transaction: StoreTransaction,
  context: StoreContext,
  snapshot: AfterSaleEvidenceProtectedReadSnapshot,
  targetExpiresAt: Date,
): Promise<AfterSaleEvidenceProtectedReadSnapshot> {
  assertMemberContext(context);
  assertProtectedReadInput(snapshot);
  assertDate(targetExpiresAt);
  return protectedReadSnapshot(
    await lockedProtectedReadEvidenceSnapshot(transaction, {
      afterSaleId: snapshot.afterSaleId,
      evidenceId: snapshot.evidenceId,
      targetExpiresAt,
    }),
    context,
    { ...snapshot, memberId: context.actor.id, previous: snapshot, targetExpiresAt },
    await wallClock(transaction),
  );
}

export async function revalidateAdminAfterSaleEvidenceProtectedReadInTransaction(
  transaction: StoreTransaction,
  context: StoreContext,
  snapshot: AfterSaleEvidenceProtectedReadSnapshot,
  targetExpiresAt: Date,
): Promise<AfterSaleEvidenceProtectedReadSnapshot> {
  assertAdminContext(context);
  assertProtectedReadInput(snapshot);
  assertDate(targetExpiresAt);
  return protectedReadSnapshot(
    await lockedProtectedReadEvidenceSnapshot(transaction, {
      afterSaleId: snapshot.afterSaleId,
      evidenceId: snapshot.evidenceId,
      targetExpiresAt,
    }),
    context,
    { ...snapshot, previous: snapshot, targetExpiresAt },
    await wallClock(transaction),
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

async function requeuePendingEvidenceScanInTransaction(
  transaction: StoreTransaction,
  context: AfterSaleEvidenceSystemContext,
  current: EvidenceRow,
): Promise<EvidenceRow> {
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
      AND evidence.id = ${current.id}::uuid
      AND evidence.version = ${current.version}
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
  if (!rescanned) stateConflict();
  // PostgreSQL timestamps retain microseconds while JavaScript Date values retain
  // milliseconds. The extra millisecond keeps the outbox within the guarded window.
  await appendEvidenceMessage(transaction, context, {
    availableAt: new Date(rescanned.scan_requested_at.getTime() + 1),
    eventType: AFTER_SALE_EVIDENCE_SCAN_EVENT,
    evidenceId: rescanned.id,
    expectedVersion: rescanned.version,
    maxAttempts: 5,
  });
  return rescanned;
}

async function ensureAuthoritativeScanAfterVersionDrift(
  transaction: StoreTransaction,
  context: AfterSaleEvidenceSystemContext,
  input: Readonly<{ current: EvidenceRow; expectedVersion: number }>,
): Promise<EvidenceRow> {
  if (
    input.current.version <= input.expectedVersion ||
    input.current.status !== 'PENDING' ||
    input.current.after_sale_id !== null ||
    input.current.confirmed_at === null ||
    input.current.scan_generation < 1
  ) {
    return input.current;
  }
  if (
    await hasConvergentScanOutboxIdentity(transaction, context, {
      evidenceId: input.current.id,
      expectedVersion: input.current.version,
    })
  ) {
    return input.current;
  }
  return requeuePendingEvidenceScanInTransaction(transaction, context, input.current);
}

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
      const rescanned = await requeuePendingEvidenceScanInTransaction(
        transaction,
        context,
        current,
      );
      return { evidence: evidenceRecord(rescanned), requested: true };
    },
    { isolationLevel: 'Serializable', timeout: 15_000 },
  );
}

export type AfterSaleEvidenceScanWork = Readonly<{
  byteSize: number;
  checksumSha256: string;
  deploymentEnvironment: string;
  evidenceId: string;
  mimeType: AfterSaleEvidenceMimeType;
  objectKey: string;
  scanGeneration: number;
}>;

export type LoadAfterSaleEvidenceScanWorkForLeaseResult =
  | Readonly<{ outcome: 'READY'; work: AfterSaleEvidenceScanWork }>
  | Readonly<{ outcome: 'SUPERSEDED' }>;

export async function loadAfterSaleEvidenceScanWorkForLease(
  client: PrismaClient,
  context: AfterSaleEvidenceSystemContext,
  input: AfterSaleEvidenceScanLeaseInput,
): Promise<LoadAfterSaleEvidenceScanWorkForLeaseResult> {
  assertEvidenceOutboxLeaseInput(input);
  return withAfterSaleEvidenceSystemTransaction(
    client,
    context,
    async (transaction) => {
      const lease = await lockedValidScanOutboxLease(transaction, context, input);
      const current = await lockedEvidence(transaction, lease.parsed.evidenceId);
      if (!current) return stateConflict();
      await assertLockedScanOutboxLeaseCurrent(transaction, lease.message, input);
      if (current.version !== lease.parsed.expectedVersion) {
        await ensureAuthoritativeScanAfterVersionDrift(transaction, context, {
          current,
          expectedVersion: lease.parsed.expectedVersion,
        });
        await assertLockedScanOutboxLeaseCurrent(transaction, lease.message, input);
        return { outcome: 'SUPERSEDED' };
      }
      if (
        current.status !== 'PENDING' ||
        current.confirmed_at === null ||
        current.scan_generation < 1
      ) {
        return { outcome: 'SUPERSEDED' };
      }
      const row = (
        await transaction.$queryRaw<ScanWorkRow[]>`
          SELECT evidence.id AS evidence_id, evidence.byte_size,
            evidence.checksum_sha256, evidence.mime_type::text AS mime_type,
            evidence.scan_generation, object.object_key,
            pg_catalog.split_part(object.object_key, '/', 1) AS deployment_environment
          FROM after_sale_evidence_files evidence
          JOIN after_sale_evidence_objects object
            ON object.store_id = evidence.store_id
            AND object.evidence_file_id = evidence.id
            AND object.object_role = 'ORIGINAL'::after_sale_evidence_object_role
            AND object.deleted_at IS NULL
          WHERE evidence.store_id = ${context.storeId}::uuid
            AND evidence.id = ${lease.parsed.evidenceId}::uuid
            AND evidence.version = ${lease.parsed.expectedVersion}
            AND evidence.status = 'PENDING'::after_sale_evidence_status
            AND evidence.confirmed_at IS NOT NULL
            AND evidence.scan_requested_at IS NOT NULL
            AND evidence.scan_completed_at IS NULL
            AND evidence.scan_result_code IS NULL
            AND evidence.object_key = object.object_key
        `
      )[0];
      const byteSize = row ? Number(row.byte_size) : Number.NaN;
      if (
        !row ||
        !Number.isSafeInteger(byteSize) ||
        byteSize < 1 ||
        !AFTER_SALE_EVIDENCE_MIME_TYPES.includes(row.mime_type as AfterSaleEvidenceMimeType) ||
        !CHECKSUM_PATTERN.test(row.checksum_sha256) ||
        !ENVIRONMENT_PATTERN.test(row.deployment_environment) ||
        row.scan_generation !== current.scan_generation
      ) {
        return stateConflict();
      }
      await assertLockedScanOutboxLeaseCurrent(transaction, lease.message, input);
      return {
        outcome: 'READY',
        work: {
          byteSize,
          checksumSha256: row.checksum_sha256,
          deploymentEnvironment: row.deployment_environment,
          evidenceId: row.evidence_id,
          mimeType: row.mime_type as AfterSaleEvidenceMimeType,
          objectKey: row.object_key,
          scanGeneration: row.scan_generation,
        },
      };
    },
    { isolationLevel: 'Serializable', timeout: SCAN_LEASE_TRANSACTION_TIMEOUT_MS },
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

type ScanResultProjectionInput = Readonly<{
  claimTtlSeconds: number;
  failedRetentionSeconds: number;
  result: AfterSaleEvidenceScanResult;
  scanGeneration: number;
}>;

function assertScanResult(input: ScanResultProjectionInput): void {
  assertPositiveInteger(input.claimTtlSeconds, 7 * 24 * 60 * 60);
  assertPositiveInteger(input.failedRetentionSeconds, 7 * 24 * 60 * 60);
  if (!Number.isSafeInteger(input.scanGeneration) || input.scanGeneration < 1) {
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

async function applyAfterSaleEvidenceScanResultInTransaction(
  transaction: StoreTransaction,
  context: AfterSaleEvidenceSystemContext,
  input: ApplyAfterSaleEvidenceScanResultInput,
  current: EvidenceRow,
  now: Date,
): Promise<Readonly<{ applied: boolean; evidence: AfterSaleEvidenceRecord }>> {
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
      (input.result.verdict === 'CLEAN' ? input.claimTtlSeconds : input.failedRetentionSeconds) *
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
}

export async function applyAfterSaleEvidenceScanResult(
  client: PrismaClient,
  context: AfterSaleEvidenceSystemContext,
  input: ApplyAfterSaleEvidenceScanResultInput,
): Promise<Readonly<{ applied: boolean; evidence: AfterSaleEvidenceRecord }>> {
  assertScanResult(input);
  assertPositiveInteger(input.expectedVersion, Number.MAX_SAFE_INTEGER);
  if (!UUID_PATTERN.test(input.evidenceId)) {
    throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_INPUT_INVALID');
  }
  return withAfterSaleEvidenceSystemTransaction(
    client,
    context,
    async (transaction) => {
      const now = await clock(transaction);
      const current = await lockedEvidence(transaction, input.evidenceId);
      if (!current) {
        throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_NOT_FOUND');
      }
      return applyAfterSaleEvidenceScanResultInTransaction(
        transaction,
        context,
        input,
        current,
        now,
      );
    },
    { isolationLevel: 'Serializable', timeout: 15_000 },
  );
}

export type ApplyAfterSaleEvidenceScanResultForLeaseInput = AfterSaleEvidenceScanLeaseInput &
  ScanResultProjectionInput;

export type ApplyAfterSaleEvidenceScanResultForLeaseResult = Readonly<{
  evidence: AfterSaleEvidenceRecord;
  outcome: 'APPLIED' | 'SUPERSEDED';
}>;

export async function applyAfterSaleEvidenceScanResultForLease(
  client: PrismaClient,
  context: AfterSaleEvidenceSystemContext,
  input: ApplyAfterSaleEvidenceScanResultForLeaseInput,
): Promise<ApplyAfterSaleEvidenceScanResultForLeaseResult> {
  assertEvidenceOutboxLeaseInput(input);
  assertScanResult(input);
  return withAfterSaleEvidenceSystemTransaction(
    client,
    context,
    async (transaction) => {
      const lease = await lockedValidScanOutboxLease(transaction, context, input);
      const current = await lockedEvidence(transaction, lease.parsed.evidenceId);
      if (!current) return stateConflict();
      const { now } = await assertLockedScanOutboxLeaseCurrent(transaction, lease.message, input);
      if (current.version !== lease.parsed.expectedVersion) {
        const authoritative = await ensureAuthoritativeScanAfterVersionDrift(transaction, context, {
          current,
          expectedVersion: lease.parsed.expectedVersion,
        });
        await assertLockedScanOutboxLeaseCurrent(transaction, lease.message, input);
        return { evidence: evidenceRecord(authoritative), outcome: 'SUPERSEDED' };
      }
      const projected = await applyAfterSaleEvidenceScanResultInTransaction(
        transaction,
        context,
        {
          claimTtlSeconds: input.claimTtlSeconds,
          evidenceId: lease.parsed.evidenceId,
          expectedVersion: lease.parsed.expectedVersion,
          failedRetentionSeconds: input.failedRetentionSeconds,
          result: input.result,
          scanGeneration: input.scanGeneration,
        },
        current,
        now,
      );
      await assertLockedScanOutboxLeaseCurrent(transaction, lease.message, input);
      return {
        evidence: projected.evidence,
        outcome: projected.applied ? 'APPLIED' : 'SUPERSEDED',
      };
    },
    { isolationLevel: 'Serializable', timeout: SCAN_LEASE_TRANSACTION_TIMEOUT_MS },
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

export type ApplyAfterSaleEvidenceExpirationForLeaseResult = Readonly<{
  evidence: AfterSaleEvidenceRecord;
  nextAttemptAt: Date | null;
  outcome: 'DELETE_SCHEDULED' | 'HELD' | 'NOT_DUE' | 'SUPERSEDED';
}>;

export async function applyAfterSaleEvidenceExpirationForLease(
  client: PrismaClient,
  context: AfterSaleEvidenceSystemContext,
  input: AfterSaleEvidenceLifecycleLeaseInput,
): Promise<ApplyAfterSaleEvidenceExpirationForLeaseResult> {
  assertEvidenceLifecycleLeaseInput(input);
  return withAfterSaleEvidenceSystemTransaction(
    client,
    context,
    async (transaction) => {
      const lease = await lockedValidEvidenceLifecycleOutboxLease(
        transaction,
        context,
        input,
        AFTER_SALE_EVIDENCE_EXPIRE_EVENT,
      );
      const current = await lockedEvidence(transaction, lease.parsed.evidenceId);
      if (!current) return stateConflict();
      const now = await assertLockedEvidenceLifecycleLeaseCurrent(
        transaction,
        lease.message,
        input,
      );
      if (
        current.version !== lease.parsed.expectedVersion ||
        !['PENDING', 'READY_UNCLAIMED', 'READY', 'FAILED', 'QUARANTINED'].includes(current.status)
      ) {
        return {
          evidence: evidenceRecord(current),
          nextAttemptAt: null,
          outcome: 'SUPERSEDED',
        };
      }
      const begun = await beginDeletionInTransaction(transaction, context, {
        evidenceId: current.id,
        expectedVersion: current.version,
        now,
      });
      await assertLockedEvidenceLifecycleLeaseCurrent(transaction, lease.message, input);
      if (begun.outcome === 'READY') {
        return {
          evidence: begun.evidence,
          nextAttemptAt: null,
          outcome: 'DELETE_SCHEDULED',
        };
      }
      return {
        evidence: begun.evidence,
        nextAttemptAt: deletionDeadline(current),
        outcome: begun.outcome === 'HELD' ? 'HELD' : 'NOT_DUE',
      };
    },
    { isolationLevel: 'Serializable', timeout: SCAN_LEASE_TRANSACTION_TIMEOUT_MS },
  );
}

async function assertLockedEvidenceLifecycleLeaseCurrent(
  transaction: StoreTransaction,
  message: EvidenceOutboxRow,
  input: AfterSaleEvidenceLifecycleLeaseInput,
): Promise<Date> {
  const now = await wallClock(transaction);
  if (
    message.status !== 'PROCESSING' ||
    message.lease_owner !== input.workerId ||
    !(message.lease_expires_at instanceof Date) ||
    message.lease_expires_at <= now ||
    message.version !== input.outboxExpectedVersion
  ) {
    throw new ReliableMessagingError('OUTBOX_LEASE_LOST');
  }
  return now;
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

export type AfterSaleEvidenceDeletionWork = Readonly<{
  evidenceId: string;
  evidenceVersion: number;
  objects: readonly AfterSaleEvidenceObjectRecord[];
}>;

export type LoadAfterSaleEvidenceDeletionWorkForLeaseResult =
  | Readonly<{ outcome: 'READY'; work: AfterSaleEvidenceDeletionWork }>
  | Readonly<{ nextAttemptAt: Date; outcome: 'NOT_DUE' }>
  | Readonly<{ outcome: 'SUPERSEDED' }>;

export async function loadAfterSaleEvidenceDeletionWorkForLease(
  client: PrismaClient,
  context: AfterSaleEvidenceSystemContext,
  input: AfterSaleEvidenceLifecycleLeaseInput,
): Promise<LoadAfterSaleEvidenceDeletionWorkForLeaseResult> {
  assertEvidenceLifecycleLeaseInput(input);
  return withAfterSaleEvidenceSystemTransaction(
    client,
    context,
    async (transaction) => {
      const lease = await lockedValidEvidenceLifecycleOutboxLease(
        transaction,
        context,
        input,
        AFTER_SALE_EVIDENCE_DELETE_EVENT,
      );
      const current = await lockedEvidence(transaction, lease.parsed.evidenceId);
      if (!current) return stateConflict();
      const now = await assertLockedEvidenceLifecycleLeaseCurrent(
        transaction,
        lease.message,
        input,
      );
      if (current.legal_hold_active || current.delete_exhausted_at !== null) {
        return { outcome: 'SUPERSEDED' };
      }
      let deletionVersion: number;
      if (current.version === lease.parsed.expectedVersion && current.status === 'DELETE_FAILED') {
        const nextAttemptAt = current.next_delete_attempt_at;
        if (!(nextAttemptAt instanceof Date) || !Number.isFinite(nextAttemptAt.getTime())) {
          return stateConflict();
        }
        if (now < nextAttemptAt) return { nextAttemptAt, outcome: 'NOT_DUE' };
        const begun = await beginDeletionInTransaction(transaction, context, {
          evidenceId: current.id,
          expectedVersion: current.version,
          now,
        });
        if (begun.outcome !== 'READY') return stateConflict();
        deletionVersion = begun.evidence.version;
      } else if (
        current.status === 'DELETION_PENDING' &&
        (current.version === lease.parsed.expectedVersion ||
          (current.delete_attempt_count > 0 &&
            current.version === lease.parsed.expectedVersion + 1))
      ) {
        deletionVersion = current.version;
      } else {
        return { outcome: 'SUPERSEDED' };
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
          AND evidence_file_id = ${current.id}::uuid
          AND object_key IS NOT NULL
        ORDER BY object_role, id
      `;
      if (rows.length < 1) return stateConflict();
      const objects = rows.map((row) => ({
        id: row.id,
        objectKey: row.object_key,
        role: row.object_role,
        version: row.version,
      }));
      await assertLockedEvidenceLifecycleLeaseCurrent(transaction, lease.message, input);
      return {
        outcome: 'READY',
        work: {
          evidenceId: current.id,
          evidenceVersion: deletionVersion,
          objects,
        },
      };
    },
    { isolationLevel: 'Serializable', timeout: SCAN_LEASE_TRANSACTION_TIMEOUT_MS },
  );
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

export type AfterSaleEvidenceScanDeadLetterCandidate = Readonly<{
  messageId: string;
}>;

export async function listAfterSaleEvidenceScanDeadLetterCandidates(
  client: PrismaClient,
  context: AfterSaleEvidenceSystemContext,
  input: Readonly<{ batchSize: number }>,
): Promise<readonly AfterSaleEvidenceScanDeadLetterCandidate[]> {
  assertPositiveInteger(input.batchSize, 100);
  return withAfterSaleEvidenceSystemTransaction(client, context, async (transaction) => {
    const rows = await transaction.$queryRaw<Array<{ message_id: string }>>`
      SELECT message.id AS message_id
      FROM outbox_messages message
      JOIN after_sale_evidence_files evidence
        ON evidence.store_id = message.store_id
        AND evidence.id = message.aggregate_id
      WHERE message.store_id = ${context.storeId}::uuid
        AND message.status = 'DEAD_LETTER'::outbox_status
        AND message.aggregate_type = ${AFTER_SALE_EVIDENCE_AGGREGATE_TYPE}
        AND message.event_type = ${AFTER_SALE_EVIDENCE_SCAN_EVENT}
        AND message.event_version = 1
        AND message.lease_owner IS NULL
        AND message.lease_expires_at IS NULL
        AND message.completed_at IS NOT NULL
        AND pg_catalog.jsonb_typeof(message.payload) = 'object'
        AND message.payload ?& ARRAY['evidence_id', 'expected_version', 'store_id']::text[]
        AND message.payload - ARRAY['evidence_id', 'expected_version', 'store_id']::text[] = '{}'::jsonb
        AND message.payload->>'store_id' = message.store_id::text
        AND message.payload->>'evidence_id' = message.aggregate_id::text
        AND evidence.status = 'PENDING'::after_sale_evidence_status
        AND evidence.confirmed_at IS NOT NULL
        AND evidence.scan_generation > 0
        AND CASE
          WHEN pg_catalog.jsonb_typeof(message.payload->'expected_version') = 'number'
            AND message.payload->>'expected_version' ~ '^[1-9][0-9]*$'
          THEN (message.payload->>'expected_version')::numeric <= 9007199254740991
            AND evidence.version >= (message.payload->>'expected_version')::numeric
          ELSE false
        END
        AND NOT EXISTS (
          SELECT 1
          FROM outbox_messages newer
          WHERE newer.store_id = evidence.store_id
              AND newer.aggregate_type = ${AFTER_SALE_EVIDENCE_AGGREGATE_TYPE}
              AND newer.aggregate_id = evidence.id
              AND newer.event_type = ${AFTER_SALE_EVIDENCE_SCAN_EVENT}
              AND newer.event_version = 1
              AND newer.status IN (
                'PENDING'::outbox_status,
                'PROCESSING'::outbox_status,
                'DEAD_LETTER'::outbox_status
              )
              AND pg_catalog.jsonb_typeof(newer.payload) = 'object'
              AND newer.payload ?& ARRAY['evidence_id', 'expected_version', 'store_id']::text[]
              AND newer.payload - ARRAY['evidence_id', 'expected_version', 'store_id']::text[] = '{}'::jsonb
              AND newer.payload->>'store_id' = evidence.store_id::text
              AND newer.payload->>'evidence_id' = evidence.id::text
              AND (
                (
                  newer.status = 'PENDING'::outbox_status
                  AND newer.lease_owner IS NULL AND newer.lease_expires_at IS NULL
                  AND newer.completed_at IS NULL
                ) OR (
                  newer.status = 'PROCESSING'::outbox_status
                  AND newer.lease_owner IS NOT NULL AND newer.lease_expires_at IS NOT NULL
                  AND newer.completed_at IS NULL
                ) OR (
                  newer.status = 'DEAD_LETTER'::outbox_status
                  AND newer.lease_owner IS NULL AND newer.lease_expires_at IS NULL
                  AND newer.completed_at IS NOT NULL
                )
              )
              AND CASE
                WHEN pg_catalog.jsonb_typeof(newer.payload->'expected_version') = 'number'
                  AND newer.payload->>'expected_version' ~ '^[1-9][0-9]*$'
                  AND pg_catalog.jsonb_typeof(message.payload->'expected_version') = 'number'
                  AND message.payload->>'expected_version' ~ '^[1-9][0-9]*$'
                THEN (newer.payload->>'expected_version')::numeric <= 9007199254740991
                  AND (newer.payload->>'expected_version')::numeric
                    > (message.payload->>'expected_version')::numeric
                  AND (newer.payload->>'expected_version')::numeric <= evidence.version
                ELSE false
              END
        )
      ORDER BY message.completed_at, message.id
      LIMIT ${input.batchSize}
    `;
    return rows.map((row) => ({ messageId: row.message_id }));
  });
}

export type AfterSaleEvidenceLifecycleDeadLetterCandidate = Readonly<{
  messageId: string;
}>;

export async function listAfterSaleEvidenceLifecycleDeadLetterCandidates(
  client: PrismaClient,
  context: AfterSaleEvidenceSystemContext,
  input: Readonly<{ batchSize: number }>,
): Promise<readonly AfterSaleEvidenceLifecycleDeadLetterCandidate[]> {
  assertPositiveInteger(input.batchSize, 100);
  return withAfterSaleEvidenceSystemTransaction(client, context, async (transaction) => {
    const rows = await transaction.$queryRaw<Array<{ message_id: string }>>`
      SELECT message.id AS message_id
      FROM outbox_messages message
      JOIN after_sale_evidence_files evidence
        ON evidence.store_id = message.store_id
        AND evidence.id = message.aggregate_id
      WHERE message.store_id = ${context.storeId}::uuid
        AND message.status = 'DEAD_LETTER'::outbox_status
        AND message.aggregate_type = ${AFTER_SALE_EVIDENCE_AGGREGATE_TYPE}
        AND message.event_type IN (
          ${AFTER_SALE_EVIDENCE_EXPIRE_EVENT}, ${AFTER_SALE_EVIDENCE_DELETE_EVENT}
        )
        AND message.event_version = 1
        AND message.lease_owner IS NULL
        AND message.lease_expires_at IS NULL
        AND message.completed_at IS NOT NULL
        AND pg_catalog.jsonb_typeof(message.payload) = 'object'
        AND message.payload ?& ARRAY['evidence_id', 'expected_version', 'store_id']::text[]
        AND message.payload - ARRAY['evidence_id', 'expected_version', 'store_id']::text[] = '{}'::jsonb
        AND message.payload->>'store_id' = message.store_id::text
        AND message.payload->>'evidence_id' = message.aggregate_id::text
        AND CASE
          WHEN pg_catalog.jsonb_typeof(message.payload->'expected_version') = 'number'
            AND message.payload->>'expected_version' ~ '^[1-9][0-9]*$'
          THEN (message.payload->>'expected_version')::numeric <= 9007199254740991
            AND evidence.version >= (message.payload->>'expected_version')::numeric
          ELSE false
        END
        AND (
          (
            message.event_type = ${AFTER_SALE_EVIDENCE_EXPIRE_EVENT}
            AND NOT evidence.legal_hold_active
            AND evidence.status IN (
              'PENDING'::after_sale_evidence_status,
              'READY_UNCLAIMED'::after_sale_evidence_status,
              'READY'::after_sale_evidence_status,
              'FAILED'::after_sale_evidence_status,
              'QUARANTINED'::after_sale_evidence_status
            )
            AND (
              evidence.status <> 'PENDING'::after_sale_evidence_status
              OR evidence.confirmed_at IS NULL
            )
          ) OR (
            message.event_type = ${AFTER_SALE_EVIDENCE_DELETE_EVENT}
            AND NOT evidence.legal_hold_active
            AND evidence.status IN (
              'DELETION_PENDING'::after_sale_evidence_status,
              'DELETE_FAILED'::after_sale_evidence_status
            )
            AND evidence.delete_exhausted_at IS NULL
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM outbox_messages newer
          WHERE newer.store_id = evidence.store_id
            AND newer.aggregate_type = ${AFTER_SALE_EVIDENCE_AGGREGATE_TYPE}
            AND newer.aggregate_id = evidence.id
            AND newer.event_type = message.event_type
            AND newer.event_version = 1
            AND newer.status IN (
              'PENDING'::outbox_status,
              'PROCESSING'::outbox_status,
              'DEAD_LETTER'::outbox_status
            )
            AND pg_catalog.jsonb_typeof(newer.payload) = 'object'
            AND newer.payload ?& ARRAY['evidence_id', 'expected_version', 'store_id']::text[]
            AND newer.payload - ARRAY['evidence_id', 'expected_version', 'store_id']::text[] = '{}'::jsonb
            AND newer.payload->>'store_id' = evidence.store_id::text
            AND newer.payload->>'evidence_id' = evidence.id::text
            AND CASE
              WHEN pg_catalog.jsonb_typeof(newer.payload->'expected_version') = 'number'
                AND newer.payload->>'expected_version' ~ '^[1-9][0-9]*$'
                AND pg_catalog.jsonb_typeof(message.payload->'expected_version') = 'number'
                AND message.payload->>'expected_version' ~ '^[1-9][0-9]*$'
              THEN (newer.payload->>'expected_version')::numeric <= 9007199254740991
                AND (newer.payload->>'expected_version')::numeric
                  > (message.payload->>'expected_version')::numeric
                AND (newer.payload->>'expected_version')::numeric <= evidence.version
              ELSE false
            END
        )
      ORDER BY message.completed_at, message.id
      LIMIT ${input.batchSize}
    `;
    return rows.map((row) => ({ messageId: row.message_id }));
  });
}

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
    (await hasNewerConvergentScanOutboxIdentity(transaction, context, {
      currentEvidenceVersion: input.current.version,
      evidenceId: input.current.id,
      oldExpectedVersion: input.parsed.expectedVersion,
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

export async function reconcileAfterSaleEvidenceScanDeadLetter(
  client: PrismaClient,
  context: AfterSaleEvidenceSystemContext,
  input: Readonly<{ messageId: string; scanFailedRetentionSeconds: number }>,
): Promise<AfterSaleEvidenceDeadLetterReconciliationResult> {
  assertPositiveInteger(input.scanFailedRetentionSeconds, 7 * 24 * 60 * 60);
  if (!UUID_PATTERN.test(input.messageId)) {
    throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_INPUT_INVALID');
  }
  return withAfterSaleEvidenceSystemTransaction(
    client,
    context,
    async (transaction) => {
      const message = await lockedEvidenceOutbox(transaction, context, input.messageId);
      if (!message) return stateConflict();
      const parsed = parseEvidenceOutbox(message, context.storeId);
      if (parsed.eventType !== AFTER_SALE_EVIDENCE_SCAN_EVENT) return stateConflict();
      const current = await lockedEvidence(transaction, parsed.evidenceId);
      if (!current) return stateConflict();
      if (message.status !== 'DEAD_LETTER') {
        return {
          evidence: evidenceRecord(current),
          eventType: parsed.eventType,
          outcome: 'NOT_DEAD_LETTER',
        };
      }
      assertDeadLetterShape(message);
      return reconcileScanDeadLetterInTransaction(transaction, context, {
        current,
        now: await wallClock(transaction),
        parsed,
        scanFailedRetentionSeconds: input.scanFailedRetentionSeconds,
      });
    },
    { isolationLevel: 'Serializable', timeout: 15_000 },
  );
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
      const message = await lockedEvidenceOutbox(transaction, context, input.messageId);
      if (!message) return stateConflict();
      const parsed = parseEvidenceOutbox(message, context.storeId);
      const current = await lockedEvidence(transaction, parsed.evidenceId);
      if (!current) return stateConflict();
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

export async function reconcileAfterSaleEvidenceLifecycleDeadLetter(
  client: PrismaClient,
  context: AfterSaleEvidenceSystemContext,
  input: Readonly<{
    deletionBaseDelayMs: number;
    deletionMaxAttempts: number;
    deletionMaxDelayMs: number;
    messageId: string;
    now?: Date;
  }>,
): Promise<AfterSaleEvidenceDeadLetterReconciliationResult> {
  assertDeletionRetryPolicy({
    baseDelayMs: input.deletionBaseDelayMs,
    maxAttempts: input.deletionMaxAttempts,
    maxDelayMs: input.deletionMaxDelayMs,
  });
  if (!UUID_PATTERN.test(input.messageId)) {
    throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_INPUT_INVALID');
  }
  if (input.now !== undefined) assertDate(input.now);
  return withAfterSaleEvidenceSystemTransaction(
    client,
    context,
    async (transaction) => {
      const message = await lockedEvidenceOutbox(transaction, context, input.messageId);
      if (!message) return stateConflict();
      const parsed = parseEvidenceOutbox(message, context.storeId);
      if (
        parsed.eventType !== AFTER_SALE_EVIDENCE_EXPIRE_EVENT &&
        parsed.eventType !== AFTER_SALE_EVIDENCE_DELETE_EVENT
      ) {
        return stateConflict();
      }
      const current = await lockedEvidence(transaction, parsed.evidenceId);
      if (!current) return stateConflict();
      if (message.status !== 'DEAD_LETTER') {
        return {
          evidence: evidenceRecord(current),
          eventType: parsed.eventType,
          outcome: 'NOT_DEAD_LETTER',
        };
      }
      assertDeadLetterShape(message);
      const now = input.now ?? (await clock(transaction));
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

type CompleteAfterSaleEvidenceDeletionInTransactionInput = Readonly<{
  evidenceId: string;
  expectedVersion: number;
  objects: readonly Readonly<{ id: string; expectedVersion: number }>[];
  now: Date;
}>;

async function completeAfterSaleEvidenceDeletionInTransaction(
  transaction: StoreTransaction,
  context: AfterSaleEvidenceSystemContext,
  input: CompleteAfterSaleEvidenceDeletionInTransactionInput,
): Promise<AfterSaleEvidenceRecord> {
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
      SET object_key = NULL, deleted_at = ${input.now}, version = version + 1, updated_at = ${input.now}
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
      delete_error_code = NULL, delete_exhausted_at = NULL, deleted_at = ${input.now},
      version = version + 1, updated_at = ${input.now}
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
}

export type ApplyAfterSaleEvidenceDeletionResult =
  Readonly<{ outcome: 'SUCCESS' }> | Readonly<{ errorCode: string; outcome: 'FAILURE' }>;

export type ApplyAfterSaleEvidenceDeletionForLeaseInput = AfterSaleEvidenceLifecycleLeaseInput &
  Readonly<{
    deletionBaseDelayMs: number;
    deletionMaxAttempts: number;
    deletionMaxDelayMs: number;
    evidenceExpectedVersion: number;
    objects: readonly Readonly<{ id: string; expectedVersion: number }>[];
    result: ApplyAfterSaleEvidenceDeletionResult;
  }>;

export type ApplyAfterSaleEvidenceDeletionForLeaseResult = Readonly<{
  evidence: AfterSaleEvidenceRecord;
  outcome: 'DELETED' | 'EXHAUSTED' | 'RETRY_SCHEDULED' | 'SUPERSEDED';
}>;

export async function applyAfterSaleEvidenceDeletionResultForLease(
  client: PrismaClient,
  context: AfterSaleEvidenceSystemContext,
  input: ApplyAfterSaleEvidenceDeletionForLeaseInput,
): Promise<ApplyAfterSaleEvidenceDeletionForLeaseResult> {
  assertEvidenceLifecycleLeaseInput(input);
  assertPositiveInteger(input.evidenceExpectedVersion, Number.MAX_SAFE_INTEGER);
  assertDeletionRetryPolicy({
    baseDelayMs: input.deletionBaseDelayMs,
    maxAttempts: input.deletionMaxAttempts,
    maxDelayMs: input.deletionMaxDelayMs,
  });
  if (
    input.objects.length < 1 ||
    new Set(input.objects.map(({ id }) => id)).size !== input.objects.length ||
    input.objects.some(
      ({ expectedVersion, id }) =>
        !UUID_PATTERN.test(id) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1,
    )
  ) {
    throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_INPUT_INVALID');
  }
  if (input.result.outcome === 'FAILURE' && !STABLE_CODE_PATTERN.test(input.result.errorCode)) {
    throw new AfterSaleEvidenceLifecycleError('AFTER_SALE_EVIDENCE_INPUT_INVALID');
  }
  return withAfterSaleEvidenceSystemTransaction(
    client,
    context,
    async (transaction) => {
      const lease = await lockedValidEvidenceLifecycleOutboxLease(
        transaction,
        context,
        input,
        AFTER_SALE_EVIDENCE_DELETE_EVENT,
      );
      const memberId = await evidenceOwner(transaction, lease.parsed.evidenceId);
      if (!memberId) return stateConflict();
      await lockMemberEvidenceQuota(transaction, context.storeId, memberId);
      const current = await lockedEvidence(transaction, lease.parsed.evidenceId);
      if (!current) return stateConflict();
      const now = await assertLockedEvidenceLifecycleLeaseCurrent(
        transaction,
        lease.message,
        input,
      );
      if (
        current.version !== input.evidenceExpectedVersion ||
        !(
          current.version === lease.parsed.expectedVersion ||
          (current.delete_attempt_count > 0 && current.version === lease.parsed.expectedVersion + 1)
        ) ||
        current.status !== 'DELETION_PENDING' ||
        current.legal_hold_active
      ) {
        return { evidence: evidenceRecord(current), outcome: 'SUPERSEDED' };
      }
      const currentObjects = await transaction.$queryRaw<Array<{ id: string; version: number }>>`
        SELECT id, version
        FROM after_sale_evidence_objects
        WHERE store_id = ${context.storeId}::uuid
          AND evidence_file_id = ${current.id}::uuid
          AND object_key IS NOT NULL
        ORDER BY id
        FOR UPDATE
      `;
      const expectedObjects = [...input.objects].sort((left, right) =>
        left.id.localeCompare(right.id, 'en'),
      );
      if (
        currentObjects.length !== expectedObjects.length ||
        currentObjects.some(
          (object, index) =>
            object.id !== expectedObjects[index]?.id ||
            object.version !== expectedObjects[index]?.expectedVersion,
        )
      ) {
        return stateConflict();
      }
      await assertLockedEvidenceLifecycleLeaseCurrent(transaction, lease.message, input);
      if (input.result.outcome === 'SUCCESS') {
        const evidence = await completeAfterSaleEvidenceDeletionInTransaction(
          transaction,
          context,
          {
            evidenceId: current.id,
            expectedVersion: current.version,
            objects: input.objects,
            now,
          },
        );
        await assertLockedEvidenceLifecycleLeaseCurrent(transaction, lease.message, input);
        return { evidence, outcome: 'DELETED' };
      }
      const evidence = await recordDeletionFailureInTransaction(transaction, context, {
        baseDelayMs: input.deletionBaseDelayMs,
        errorCode: input.result.errorCode,
        evidenceId: current.id,
        expectedVersion: current.version,
        maxAttempts: input.deletionMaxAttempts,
        maxDelayMs: input.deletionMaxDelayMs,
        now,
      });
      await assertLockedEvidenceLifecycleLeaseCurrent(transaction, lease.message, input);
      return {
        evidence,
        outcome: evidence.deleteExhaustedAt === null ? 'RETRY_SCHEDULED' : 'EXHAUSTED',
      };
    },
    { isolationLevel: 'Serializable', timeout: SCAN_LEASE_TRANSACTION_TIMEOUT_MS },
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
    async (transaction) =>
      completeAfterSaleEvidenceDeletionInTransaction(transaction, context, {
        evidenceId: input.evidenceId,
        expectedVersion: input.expectedVersion,
        objects: input.objects,
        now: input.now ?? (await clock(transaction)),
      }),
    { isolationLevel: 'Serializable', timeout: 15_000 },
  );
}
