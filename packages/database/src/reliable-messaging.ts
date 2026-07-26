import { createHash, randomUUID } from 'node:crypto';

import type { IntegrationEnvironment, Prisma } from '@prisma/client';
import {
  calculateExponentialBackoffMs,
  type OutboxFailureDisposition,
  type StoreContext,
} from '@zalo-shop/domain';

import { type PrismaClient, type StoreTransaction, withStoreTransaction } from './index';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/u;
const AGGREGATE_TYPE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/u;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,39}$/u;
const IDEMPOTENCY_KEY_PATTERN = /^[!-~]{16,128}$/u;
const PAYLOAD_LIMIT_BYTES = 16 * 1_024;
const MAX_PAYLOAD_DEPTH = 10;
const FORBIDDEN_PAYLOAD_KEY =
  /(?:^|_)(?:api_?key|authorization|credential|password|private_?key|raw_?body|secret|token)(?:_|$)/iu;
const PII_PAYLOAD_KEY = /(?:^|_)(?:address|email|phone)(?:_|$)/iu;
const REPLAY_CONFIRMATION = 'RETRY_DEAD_LETTER';
const REPLAY_PERMISSION = 'store.integration-jobs.retry';
const MFA_FRESHNESS_MS = 5 * 60_000;
const MFA_FUTURE_SKEW_MS = 60_000;

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizedPayloadKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/[^a-z0-9]+/giu, '_')
    .replace(/^_+|_+$/gu, '')
    .toLowerCase();
}

export type ReliableMessagingErrorCode =
  | 'INBOX_IDEMPOTENCY_CONFLICT'
  | 'INBOX_INPUT_INVALID'
  | 'INBOX_STATE_CONFLICT'
  | 'OUTBOX_IDEMPOTENCY_CONFLICT'
  | 'OUTBOX_INPUT_INVALID'
  | 'OUTBOX_LEASE_LOST'
  | 'OUTBOX_REPLAY_CONFIRMATION_REQUIRED'
  | 'OUTBOX_REPLAY_MFA_REQUIRED'
  | 'OUTBOX_REPLAY_PERMISSION_DENIED'
  | 'OUTBOX_REPLAY_REASON_REQUIRED'
  | 'OUTBOX_STATE_CONFLICT'
  | 'OUTBOX_UNSUPPORTED_EVENT_TYPE';

export class ReliableMessagingError extends Error {
  public constructor(public readonly code: ReliableMessagingErrorCode) {
    super(code);
    this.name = 'ReliableMessagingError';
  }
}

export type OutboxMessageRecord = Readonly<{
  aggregateId: string;
  aggregateType: string;
  attemptCount: number;
  availableAt: Date;
  completedAt: Date | null;
  eventType: string;
  eventVersion: number;
  id: string;
  idempotencyKey: string;
  lastErrorCode: string | null;
  leaseExpiresAt: Date | null;
  leaseOwner: string | null;
  maxAttempts: number;
  payload: Prisma.JsonValue;
  status: 'COMPLETED' | 'DEAD_LETTER' | 'PENDING' | 'PROCESSING';
  storeId: string;
  version: number;
}>;

type OutboxRow = {
  aggregate_id: string;
  aggregate_type: string;
  attempt_count: number;
  available_at: Date;
  completed_at: Date | null;
  event_type: string;
  event_version: number;
  id: string;
  idempotency_key: string;
  last_error_code: string | null;
  lease_expires_at: Date | null;
  lease_owner: string | null;
  max_attempts: number;
  payload: Prisma.JsonValue;
  status: OutboxMessageRecord['status'];
  store_id: string;
  version: number;
};

export type InboxMessageRecord = Readonly<{
  channelId: string;
  completedAt: Date | null;
  environment: IntegrationEnvironment;
  errorCode: string | null;
  externalMessageKey: string;
  id: string;
  payloadDigest: string;
  processingStartedAt: Date | null;
  receivedAt: Date;
  source: string;
  status: 'COMPLETED' | 'DEAD_LETTER' | 'PROCESSING' | 'RECEIVED' | 'REJECTED' | 'RETRY_PENDING';
  storeId: string;
  version: number;
}>;

type InboxRow = {
  channel_id: string;
  completed_at: Date | null;
  environment: IntegrationEnvironment;
  error_code: string | null;
  external_message_key: string;
  id: string;
  payload_digest: string;
  processing_started_at: Date | null;
  received_at: Date;
  source: string;
  status: InboxMessageRecord['status'];
  store_id: string;
  version: number;
};

function outboxRecord(row: OutboxRow): OutboxMessageRecord {
  return {
    aggregateId: row.aggregate_id,
    aggregateType: row.aggregate_type,
    attemptCount: row.attempt_count,
    availableAt: row.available_at,
    completedAt: row.completed_at,
    eventType: row.event_type,
    eventVersion: row.event_version,
    id: row.id,
    idempotencyKey: row.idempotency_key,
    lastErrorCode: row.last_error_code,
    leaseExpiresAt: row.lease_expires_at,
    leaseOwner: row.lease_owner,
    maxAttempts: row.max_attempts,
    payload: row.payload,
    status: row.status,
    storeId: row.store_id,
    version: row.version,
  };
}

function inboxRecord(row: InboxRow): InboxMessageRecord {
  return {
    channelId: row.channel_id,
    completedAt: row.completed_at,
    environment: row.environment,
    errorCode: row.error_code,
    externalMessageKey: row.external_message_key,
    id: row.id,
    payloadDigest: row.payload_digest,
    processingStartedAt: row.processing_started_at,
    receivedAt: row.received_at,
    source: row.source,
    status: row.status,
    storeId: row.store_id,
    version: row.version,
  };
}

function assertDate(
  value: Date,
  errorCode: 'INBOX_INPUT_INVALID' | 'OUTBOX_INPUT_INVALID' = 'OUTBOX_INPUT_INVALID',
): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new ReliableMessagingError(errorCode);
  }
}

function assertPayloadValue(value: unknown, depth: number, seen: Set<object>): void {
  if (depth > MAX_PAYLOAD_DEPTH) throw new ReliableMessagingError('OUTBOX_INPUT_INVALID');
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value !== 'object') throw new ReliableMessagingError('OUTBOX_INPUT_INVALID');
  if (seen.has(value)) throw new ReliableMessagingError('OUTBOX_INPUT_INVALID');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (const item of value) assertPayloadValue(item, depth + 1, seen);
      return;
    }
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      throw new ReliableMessagingError('OUTBOX_INPUT_INVALID');
    }
    for (const [key, nested] of Object.entries(value)) {
      const normalizedKey = normalizedPayloadKey(key);
      if (
        !normalizedKey ||
        FORBIDDEN_PAYLOAD_KEY.test(normalizedKey) ||
        (PII_PAYLOAD_KEY.test(normalizedKey) && !normalizedKey.endsWith('_id'))
      ) {
        throw new ReliableMessagingError('OUTBOX_INPUT_INVALID');
      }
      assertPayloadValue(nested, depth + 1, seen);
    }
  } finally {
    seen.delete(value);
  }
}

function validatedPayload(
  payload: Readonly<Record<string, unknown>>,
  storeId: string,
): Prisma.InputJsonObject {
  assertPayloadValue(payload, 0, new Set());
  if (payload.store_id !== storeId) throw new ReliableMessagingError('OUTBOX_INPUT_INVALID');
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, 'utf8') > PAYLOAD_LIMIT_BYTES) {
    throw new ReliableMessagingError('OUTBOX_INPUT_INVALID');
  }
  return payload as Prisma.InputJsonObject;
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') throw new ReliableMessagingError('OUTBOX_INPUT_INVALID');
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(',')}}`;
}

function assertOutboxInput(input: {
  aggregateId: string;
  aggregateType: string;
  eventType: string;
  eventVersion: number;
  idempotencyKey: string;
  maxAttempts: number;
}): void {
  if (
    !UUID_PATTERN.test(input.aggregateId) ||
    !AGGREGATE_TYPE_PATTERN.test(input.aggregateType) ||
    !EVENT_TYPE_PATTERN.test(input.eventType) ||
    input.eventType.length > 128 ||
    !Number.isSafeInteger(input.eventVersion) ||
    input.eventVersion < 1 ||
    !input.idempotencyKey.trim() ||
    input.idempotencyKey.length > 160 ||
    !Number.isSafeInteger(input.maxAttempts) ||
    input.maxAttempts < 1 ||
    input.maxAttempts > 100
  ) {
    throw new ReliableMessagingError('OUTBOX_INPUT_INVALID');
  }
}

export type AppendOutboxMessageInput = Readonly<{
  aggregateId: string;
  aggregateType: string;
  availableAt?: Date;
  eventType: string;
  eventVersion: number;
  idempotencyKey: string;
  maxAttempts?: number;
  payload: Readonly<Record<string, unknown>>;
}>;

export async function appendOutboxMessageInTransaction(
  transaction: StoreTransaction,
  context: StoreContext,
  input: AppendOutboxMessageInput,
): Promise<Readonly<{ message: OutboxMessageRecord; replayed: boolean }>> {
  const availableAt = input.availableAt ?? new Date();
  const maxAttempts = input.maxAttempts ?? 8;
  assertDate(availableAt);
  assertOutboxInput({ ...input, maxAttempts });
  const payload = validatedPayload(input.payload, context.storeId);
  const id = randomUUID();
  const inserted = await transaction.$queryRaw<OutboxRow[]>`
    INSERT INTO outbox_messages (
      id, store_id, aggregate_type, aggregate_id, event_type, event_version,
      idempotency_key, payload, available_at, max_attempts, updated_at
    ) VALUES (
      ${id}::uuid, ${context.storeId}::uuid, ${input.aggregateType}, ${input.aggregateId}::uuid,
      ${input.eventType}, ${input.eventVersion}, ${input.idempotencyKey},
      ${JSON.stringify(payload)}::jsonb, ${availableAt}, ${maxAttempts}, now()
    )
    ON CONFLICT (store_id, idempotency_key) DO NOTHING
    RETURNING id, store_id, aggregate_type, aggregate_id, event_type, event_version,
      idempotency_key, payload, status, available_at, lease_owner, lease_expires_at,
      attempt_count, max_attempts, last_error_code, completed_at, version
  `;
  const created = inserted[0];
  if (created) return { message: outboxRecord(created), replayed: false };

  const existing = await transaction.$queryRaw<OutboxRow[]>`
    SELECT id, store_id, aggregate_type, aggregate_id, event_type, event_version,
      idempotency_key, payload, status, available_at, lease_owner, lease_expires_at,
      attempt_count, max_attempts, last_error_code, completed_at, version
    FROM outbox_messages
    WHERE store_id = ${context.storeId}::uuid AND idempotency_key = ${input.idempotencyKey}
    LIMIT 1
  `;
  const replay = existing[0];
  if (
    !replay ||
    replay.aggregate_id !== input.aggregateId ||
    replay.aggregate_type !== input.aggregateType ||
    replay.event_type !== input.eventType ||
    replay.event_version !== input.eventVersion ||
    replay.max_attempts !== maxAttempts ||
    (input.availableAt !== undefined && replay.available_at.getTime() !== availableAt.getTime()) ||
    canonicalJson(replay.payload) !== canonicalJson(payload)
  ) {
    throw new ReliableMessagingError('OUTBOX_IDEMPOTENCY_CONFLICT');
  }
  return { message: outboxRecord(replay), replayed: true };
}

export function appendOutboxMessage(
  client: PrismaClient,
  context: StoreContext,
  input: AppendOutboxMessageInput,
) {
  return withStoreTransaction(client, context, (transaction) =>
    appendOutboxMessageInTransaction(transaction, context, input),
  );
}

export type ClaimOutboxMessagesInput = Readonly<{
  batchSize: number;
  leaseDurationMs: number;
  now?: Date;
  workerId: string;
}>;

function assertClaimInput(input: ClaimOutboxMessagesInput, now: Date): void {
  assertDate(now);
  if (
    !Number.isSafeInteger(input.batchSize) ||
    input.batchSize < 1 ||
    input.batchSize > 100 ||
    !Number.isSafeInteger(input.leaseDurationMs) ||
    input.leaseDurationMs < 1_000 ||
    input.leaseDurationMs > 300_000 ||
    !input.workerId.trim() ||
    input.workerId.length > 128
  ) {
    throw new ReliableMessagingError('OUTBOX_INPUT_INVALID');
  }
}

export async function claimOutboxMessages(
  client: PrismaClient,
  context: StoreContext,
  input: ClaimOutboxMessagesInput,
): Promise<readonly OutboxMessageRecord[]> {
  const now = input.now ?? new Date();
  assertClaimInput(input, now);
  const leaseExpiresAt = new Date(now.getTime() + input.leaseDurationMs);
  return withStoreTransaction(client, context, async (transaction) => {
    await transaction.$executeRaw`
      UPDATE outbox_messages
      SET status = 'DEAD_LETTER'::outbox_status,
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error_code = 'RETRY_EXHAUSTED_LEASE_EXPIRED',
          completed_at = ${now},
          version = version + 1,
          updated_at = ${now}
      WHERE store_id = ${context.storeId}::uuid
        AND status = 'PROCESSING'::outbox_status
        AND lease_expires_at <= ${now}
        AND attempt_count >= max_attempts
    `;
    const rows = await transaction.$queryRaw<OutboxRow[]>`
      WITH candidates AS (
        SELECT id
        FROM outbox_messages
        WHERE store_id = ${context.storeId}::uuid
          AND attempt_count < max_attempts
          AND (
            (status = 'PENDING'::outbox_status AND available_at <= ${now})
            OR (status = 'PROCESSING'::outbox_status AND lease_expires_at <= ${now})
          )
        ORDER BY available_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT ${input.batchSize}
      )
      UPDATE outbox_messages AS message
      SET status = 'PROCESSING'::outbox_status,
          lease_owner = ${input.workerId},
          lease_expires_at = ${leaseExpiresAt},
          attempt_count = message.attempt_count + 1,
          last_error_code = CASE
            WHEN message.status = 'PROCESSING'::outbox_status THEN 'RETRYABLE_LEASE_EXPIRED'
            ELSE message.last_error_code
          END,
          completed_at = NULL,
          version = message.version + 1,
          updated_at = ${now}
      FROM candidates
      WHERE message.id = candidates.id
      RETURNING message.id, message.store_id, message.aggregate_type, message.aggregate_id,
        message.event_type, message.event_version, message.idempotency_key, message.payload,
        message.status, message.available_at, message.lease_owner, message.lease_expires_at,
        message.attempt_count, message.max_attempts, message.last_error_code,
        message.completed_at, message.version
    `;
    return rows.map(outboxRecord);
  });
}

function assertLeaseMutationInput(input: {
  expectedVersion: number;
  messageId: string;
  now: Date;
  workerId: string;
}): void {
  assertDate(input.now);
  if (
    !UUID_PATTERN.test(input.messageId) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1 ||
    !input.workerId.trim() ||
    input.workerId.length > 128
  ) {
    throw new ReliableMessagingError('OUTBOX_INPUT_INVALID');
  }
}

export async function completeOutboxMessage(
  client: PrismaClient,
  context: StoreContext,
  input: Readonly<{
    expectedVersion: number;
    messageId: string;
    now?: Date;
    workerId: string;
  }>,
): Promise<OutboxMessageRecord> {
  const now = input.now ?? new Date();
  assertLeaseMutationInput({ ...input, now });
  return withStoreTransaction(client, context, async (transaction) => {
    const rows = await transaction.$queryRaw<OutboxRow[]>`
      UPDATE outbox_messages
      SET status = 'COMPLETED'::outbox_status,
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error_code = NULL,
          completed_at = ${now},
          version = version + 1,
          updated_at = ${now}
      WHERE store_id = ${context.storeId}::uuid
        AND id = ${input.messageId}::uuid
        AND status = 'PROCESSING'::outbox_status
        AND lease_owner = ${input.workerId}
        AND lease_expires_at > ${now}
        AND version = ${input.expectedVersion}
      RETURNING id, store_id, aggregate_type, aggregate_id, event_type, event_version,
        idempotency_key, payload, status, available_at, lease_owner, lease_expires_at,
        attempt_count, max_attempts, last_error_code, completed_at, version
    `;
    const completed = rows[0];
    if (!completed) throw new ReliableMessagingError('OUTBOX_LEASE_LOST');
    return outboxRecord(completed);
  });
}

function storedFailureCode(
  disposition: OutboxFailureDisposition,
  errorCode: string,
  exhausted: boolean,
): string {
  if (disposition === 'REVIEW_REQUIRED') return `REVIEW_${errorCode}`;
  if (disposition === 'PERMANENT') return `PERMANENT_${errorCode}`;
  return exhausted ? `RETRY_EXHAUSTED_${errorCode}` : `RETRYABLE_${errorCode}`;
}

export async function failOutboxMessage(
  client: PrismaClient,
  context: StoreContext,
  input: Readonly<{
    baseDelayMs?: number;
    disposition: OutboxFailureDisposition;
    errorCode: string;
    expectedVersion: number;
    jitterRatio?: number;
    maxDelayMs?: number;
    messageId: string;
    now?: Date;
    randomValue?: number;
    workerId: string;
  }>,
): Promise<OutboxMessageRecord> {
  const now = input.now ?? new Date();
  assertLeaseMutationInput({ ...input, now });
  if (!ERROR_CODE_PATTERN.test(input.errorCode)) {
    throw new ReliableMessagingError('OUTBOX_INPUT_INVALID');
  }
  return withStoreTransaction(client, context, async (transaction) => {
    const locked = await transaction.$queryRaw<OutboxRow[]>`
      SELECT id, store_id, aggregate_type, aggregate_id, event_type, event_version,
        idempotency_key, payload, status, available_at, lease_owner, lease_expires_at,
        attempt_count, max_attempts, last_error_code, completed_at, version
      FROM outbox_messages
      WHERE store_id = ${context.storeId}::uuid AND id = ${input.messageId}::uuid
      FOR UPDATE
    `;
    const current = locked[0];
    if (
      !current ||
      current.status !== 'PROCESSING' ||
      current.lease_owner !== input.workerId ||
      !current.lease_expires_at ||
      current.lease_expires_at <= now ||
      current.version !== input.expectedVersion
    ) {
      throw new ReliableMessagingError('OUTBOX_LEASE_LOST');
    }
    const exhausted = current.attempt_count >= current.max_attempts;
    const shouldRetry = input.disposition === 'RETRYABLE' && !exhausted;
    const availableAt = shouldRetry
      ? new Date(
          now.getTime() +
            calculateExponentialBackoffMs({
              attemptCount: current.attempt_count,
              ...(input.baseDelayMs === undefined ? {} : { baseDelayMs: input.baseDelayMs }),
              ...(input.jitterRatio === undefined ? {} : { jitterRatio: input.jitterRatio }),
              ...(input.maxDelayMs === undefined ? {} : { maxDelayMs: input.maxDelayMs }),
              ...(input.randomValue === undefined ? {} : { randomValue: input.randomValue }),
            }),
        )
      : current.available_at;
    const status = shouldRetry ? 'PENDING' : 'DEAD_LETTER';
    const errorCode = storedFailureCode(input.disposition, input.errorCode, exhausted);
    const rows = await transaction.$queryRaw<OutboxRow[]>`
      UPDATE outbox_messages
      SET status = ${status}::outbox_status,
          available_at = ${availableAt},
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error_code = ${errorCode},
          completed_at = ${shouldRetry ? null : now},
          version = version + 1,
          updated_at = ${now}
      WHERE store_id = ${context.storeId}::uuid
        AND id = ${input.messageId}::uuid
        AND status = 'PROCESSING'::outbox_status
        AND version = ${input.expectedVersion}
      RETURNING id, store_id, aggregate_type, aggregate_id, event_type, event_version,
        idempotency_key, payload, status, available_at, lease_owner, lease_expires_at,
        attempt_count, max_attempts, last_error_code, completed_at, version
    `;
    const failed = rows[0];
    if (!failed) throw new ReliableMessagingError('OUTBOX_LEASE_LOST');
    return outboxRecord(failed);
  });
}

function replayDomainPermission(eventType: string): string | undefined {
  if (eventType.startsWith('payment.')) return 'store.payments.reconcile';
  if (eventType.startsWith('refund.')) return 'store.refunds.create';
  if (eventType.startsWith('shipment.') || eventType.startsWith('shipping.')) {
    return 'store.shipments.reconcile';
  }
  if (eventType.startsWith('test.')) return undefined;
  throw new ReliableMessagingError('OUTBOX_UNSUPPORTED_EVENT_TYPE');
}

export async function replayDeadLetterOutboxMessage(
  client: PrismaClient,
  context: StoreContext,
  input: Readonly<{
    confirmation: string;
    expectedVersion: number;
    idempotencyKey?: string;
    messageId: string;
    mfaVerifiedAt: Date;
    now?: Date;
    reason: string;
  }>,
): Promise<OutboxMessageRecord> {
  const now = input.now ?? new Date();
  assertDate(now);
  if (context.actor.type !== 'admin') {
    throw new ReliableMessagingError('OUTBOX_REPLAY_PERMISSION_DENIED');
  }
  if (input.confirmation !== REPLAY_CONFIRMATION) {
    throw new ReliableMessagingError('OUTBOX_REPLAY_CONFIRMATION_REQUIRED');
  }
  const reason = input.reason.trim();
  if (reason.length < 10 || reason.length > 500) {
    throw new ReliableMessagingError('OUTBOX_REPLAY_REASON_REQUIRED');
  }
  if (
    !(input.mfaVerifiedAt instanceof Date) ||
    !Number.isFinite(input.mfaVerifiedAt.getTime()) ||
    now.getTime() - input.mfaVerifiedAt.getTime() > MFA_FRESHNESS_MS ||
    input.mfaVerifiedAt.getTime() - now.getTime() > MFA_FUTURE_SKEW_MS
  ) {
    throw new ReliableMessagingError('OUTBOX_REPLAY_MFA_REQUIRED');
  }
  if (
    !UUID_PATTERN.test(input.messageId) ||
    (input.idempotencyKey !== undefined && !IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1
  ) {
    throw new ReliableMessagingError('OUTBOX_INPUT_INVALID');
  }
  const replayIdempotencyKeyHash =
    input.idempotencyKey === undefined
      ? undefined
      : digest(`${context.storeId}\u0000${input.messageId}\u0000${input.idempotencyKey}`);
  const replayRequestHash = replayIdempotencyKeyHash
    ? digest(
        [
          context.storeId,
          context.actor.id,
          input.messageId,
          String(input.expectedVersion),
          input.confirmation,
          reason,
        ].join('\u0000'),
      )
    : undefined;

  return withStoreTransaction(client, context, async (transaction) => {
    const locked = await transaction.$queryRaw<OutboxRow[]>`
      SELECT id, store_id, aggregate_type, aggregate_id, event_type, event_version,
        idempotency_key, payload, status, available_at, lease_owner, lease_expires_at,
        attempt_count, max_attempts, last_error_code, completed_at, version
      FROM outbox_messages
      WHERE store_id = ${context.storeId}::uuid AND id = ${input.messageId}::uuid
      FOR UPDATE
    `;
    const current = locked[0];
    if (!current) {
      throw new ReliableMessagingError('OUTBOX_STATE_CONFLICT');
    }
    const domainPermission = replayDomainPermission(current.event_type);
    const requiredPermissions = [REPLAY_PERMISSION, domainPermission].filter(
      (permission): permission is string => permission !== undefined,
    );
    const permissions = await transaction.$queryRaw<Array<{ permission_code: string }>>`
      SELECT DISTINCT role_permission.permission_code
      FROM admin_store_roles AS assignment
      JOIN store_role_permissions AS role_permission
        ON role_permission.store_id = assignment.store_id
       AND role_permission.role_id = assignment.role_id
      WHERE assignment.store_id = ${context.storeId}::uuid
        AND assignment.admin_user_id = ${context.actor.id}::uuid
        AND role_permission.permission_code = ANY(${requiredPermissions})
    `;
    if (
      new Set(permissions.map(({ permission_code }) => permission_code)).size !==
      requiredPermissions.length
    ) {
      throw new ReliableMessagingError('OUTBOX_REPLAY_PERMISSION_DENIED');
    }

    if (current.status !== 'DEAD_LETTER' || current.version !== input.expectedVersion) {
      if (!replayIdempotencyKeyHash || !replayRequestHash) {
        throw new ReliableMessagingError('OUTBOX_STATE_CONFLICT');
      }
      const priorReplays = await transaction.$queryRaw<Array<{ request_hash: string | null }>>`
        SELECT after_data ->> 'replay_request_hash' AS request_hash
        FROM audit_logs
        WHERE store_id = ${context.storeId}::uuid
          AND action = 'integration.outbox.dead_letter.replayed'
          AND target_type = 'outbox_message'
          AND target_id = ${current.id}
          AND after_data ->> 'replay_idempotency_key_hash' = ${replayIdempotencyKeyHash}
        LIMIT 1
      `;
      const priorReplay = priorReplays[0];
      if (!priorReplay) throw new ReliableMessagingError('OUTBOX_STATE_CONFLICT');
      if (priorReplay.request_hash !== replayRequestHash) {
        throw new ReliableMessagingError('OUTBOX_IDEMPOTENCY_CONFLICT');
      }
      return outboxRecord(current);
    }

    await transaction.auditLog.create({
      data: {
        action: 'integration.outbox.dead_letter.replayed',
        actorId: context.actor.id,
        actorType: 'ADMIN',
        afterData: {
          attempt_count: 0,
          available_at: now.toISOString(),
          ...(replayIdempotencyKeyHash
            ? {
                replay_idempotency_key_hash: replayIdempotencyKeyHash,
                replay_request_hash: replayRequestHash,
              }
            : {}),
          status: 'PENDING',
          version: current.version + 1,
        },
        beforeData: {
          attempt_count: current.attempt_count,
          error_code: current.last_error_code,
          status: current.status,
          version: current.version,
        },
        correlationId: context.correlationId,
        reason,
        storeId: context.storeId,
        targetId: current.id,
        targetType: 'outbox_message',
      },
    });
    const rows = await transaction.$queryRaw<OutboxRow[]>`
      UPDATE outbox_messages
      SET status = 'PENDING'::outbox_status,
          available_at = ${now},
          lease_owner = NULL,
          lease_expires_at = NULL,
          attempt_count = 0,
          last_error_code = NULL,
          completed_at = NULL,
          version = version + 1,
          updated_at = ${now}
      WHERE store_id = ${context.storeId}::uuid
        AND id = ${current.id}::uuid
        AND status = 'DEAD_LETTER'::outbox_status
        AND version = ${input.expectedVersion}
      RETURNING id, store_id, aggregate_type, aggregate_id, event_type, event_version,
        idempotency_key, payload, status, available_at, lease_owner, lease_expires_at,
        attempt_count, max_attempts, last_error_code, completed_at, version
    `;
    const replayed = rows[0];
    if (!replayed) throw new ReliableMessagingError('OUTBOX_STATE_CONFLICT');
    return outboxRecord(replayed);
  });
}

function assertInboxInput(input: {
  channelId: string;
  externalMessageKey: string;
  payloadDigest: string;
  source: string;
}): void {
  if (
    !UUID_PATTERN.test(input.channelId) ||
    !input.source.trim() ||
    input.source.length > 64 ||
    !input.externalMessageKey.trim() ||
    input.externalMessageKey.length > 160 ||
    !/^[0-9a-f]{64}$/u.test(input.payloadDigest)
  ) {
    throw new ReliableMessagingError('INBOX_INPUT_INVALID');
  }
}

export type RecordInboxMessageInput = Readonly<{
  channelId: string;
  environment: IntegrationEnvironment;
  externalMessageKey: string;
  payloadDigest: string;
  source: string;
}>;

export async function recordInboxMessageInTransaction(
  transaction: StoreTransaction,
  context: StoreContext,
  input: RecordInboxMessageInput,
): Promise<Readonly<{ message: InboxMessageRecord; replayed: boolean }>> {
  assertInboxInput(input);
  const id = randomUUID();
  const inserted = await transaction.$queryRaw<InboxRow[]>`
    INSERT INTO inbox_messages (
      id, store_id, source, channel_id, environment, external_message_key, payload_digest
    ) VALUES (
      ${id}::uuid, ${context.storeId}::uuid, ${input.source}, ${input.channelId}::uuid,
      ${input.environment}::integration_environment, ${input.externalMessageKey},
      ${input.payloadDigest}
    )
    ON CONFLICT (source, channel_id, environment, external_message_key) DO NOTHING
    RETURNING id, store_id, source, channel_id, environment, external_message_key,
      payload_digest, status, received_at, processing_started_at, completed_at,
      error_code, version
  `;
  const created = inserted[0];
  if (created) return { message: inboxRecord(created), replayed: false };
  const existing = await transaction.$queryRaw<InboxRow[]>`
    SELECT id, store_id, source, channel_id, environment, external_message_key,
      payload_digest, status, received_at, processing_started_at, completed_at,
      error_code, version
    FROM inbox_messages
    WHERE source = ${input.source}
      AND channel_id = ${input.channelId}::uuid
      AND environment = ${input.environment}::integration_environment
      AND external_message_key = ${input.externalMessageKey}
    LIMIT 1
  `;
  const replay = existing[0];
  if (!replay || replay.payload_digest !== input.payloadDigest) {
    throw new ReliableMessagingError('INBOX_IDEMPOTENCY_CONFLICT');
  }
  return { message: inboxRecord(replay), replayed: true };
}

export function recordInboxMessage(
  client: PrismaClient,
  context: StoreContext,
  input: RecordInboxMessageInput,
) {
  return withStoreTransaction(client, context, (transaction) =>
    recordInboxMessageInTransaction(transaction, context, input),
  );
}

export async function startInboxMessageProcessing(
  client: PrismaClient,
  context: StoreContext,
  input: Readonly<{ expectedVersion: number; messageId: string; now?: Date }>,
): Promise<InboxMessageRecord> {
  const now = input.now ?? new Date();
  assertDate(now, 'INBOX_INPUT_INVALID');
  if (
    !UUID_PATTERN.test(input.messageId) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1
  ) {
    throw new ReliableMessagingError('INBOX_INPUT_INVALID');
  }
  return withStoreTransaction(client, context, async (transaction) => {
    const rows = await transaction.$queryRaw<InboxRow[]>`
      UPDATE inbox_messages
      SET status = 'PROCESSING'::inbox_status,
          processing_started_at = ${now},
          completed_at = NULL,
          error_code = NULL,
          version = version + 1
      WHERE store_id = ${context.storeId}::uuid
        AND id = ${input.messageId}::uuid
        AND status IN ('RECEIVED'::inbox_status, 'RETRY_PENDING'::inbox_status)
        AND version = ${input.expectedVersion}
      RETURNING id, store_id, source, channel_id, environment, external_message_key,
        payload_digest, status, received_at, processing_started_at, completed_at,
        error_code, version
    `;
    const started = rows[0];
    if (!started) throw new ReliableMessagingError('INBOX_STATE_CONFLICT');
    return inboxRecord(started);
  });
}

export async function settleInboxMessage(
  client: PrismaClient,
  context: StoreContext,
  input: Readonly<{
    disposition?: OutboxFailureDisposition;
    errorCode?: string;
    expectedVersion: number;
    messageId: string;
    now?: Date;
  }>,
): Promise<InboxMessageRecord> {
  const now = input.now ?? new Date();
  assertDate(now, 'INBOX_INPUT_INVALID');
  if (
    !UUID_PATTERN.test(input.messageId) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1 ||
    (input.disposition === undefined) !== (input.errorCode === undefined) ||
    (input.errorCode !== undefined && !ERROR_CODE_PATTERN.test(input.errorCode))
  ) {
    throw new ReliableMessagingError('INBOX_INPUT_INVALID');
  }
  const status =
    input.disposition === undefined
      ? 'COMPLETED'
      : input.disposition === 'RETRYABLE'
        ? 'RETRY_PENDING'
        : input.disposition === 'PERMANENT'
          ? 'REJECTED'
          : 'DEAD_LETTER';
  const errorCode =
    input.disposition === undefined || input.errorCode === undefined
      ? null
      : storedFailureCode(input.disposition, input.errorCode, false);
  const completedAt = status === 'RETRY_PENDING' ? null : now;
  return withStoreTransaction(client, context, async (transaction) => {
    const rows = await transaction.$queryRaw<InboxRow[]>`
      UPDATE inbox_messages
      SET status = ${status}::inbox_status,
          completed_at = ${completedAt},
          error_code = ${errorCode},
          version = version + 1
      WHERE store_id = ${context.storeId}::uuid
        AND id = ${input.messageId}::uuid
        AND status = 'PROCESSING'::inbox_status
        AND version = ${input.expectedVersion}
      RETURNING id, store_id, source, channel_id, environment, external_message_key,
        payload_digest, status, received_at, processing_started_at, completed_at,
        error_code, version
    `;
    const settled = rows[0];
    if (!settled) throw new ReliableMessagingError('INBOX_STATE_CONFLICT');
    return inboxRecord(settled);
  });
}
