import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { config as loadEnvironment } from 'dotenv';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseRuntimeConfig } from '@zalo-shop/config';
import { AFTER_SALE_RATE_LIMIT_POLICY } from '@zalo-shop/contracts';
import {
  AFTER_SALE_EVIDENCE_SCAN_EVENT,
  claimOutboxMessages,
  completeOutboxMessage,
  createRuntimePrismaClient,
  PrismaClient,
  type OutboxMessageRecord,
} from '@zalo-shop/database';
import { createStoreContext } from '@zalo-shop/domain';
import {
  ClamAvAfterSaleEvidenceScanner,
  type AfterSaleEvidenceObjectStorageProvider,
} from '@zalo-shop/integrations';
import { signJwt } from '@zalo-shop/security';

import { AFTER_SALE_EVIDENCE_STORAGE_PROVIDER } from '../../apps/api/src/after-sales-evidence/after-sales-evidence.tokens';
import { AfterSaleEvidenceScanRequestedHandler } from '../../apps/worker/src/after-sales-evidence/after-sale-evidence-scan.handler';

const BEAUTY_STORE_ID = '10000000-0000-4000-8000-000000000001';
const FASHION_STORE_ID = '10000000-0000-4000-8000-000000000002';

type UploadResponse = Readonly<{
  evidence_id: string;
  expires_at: string;
  upload_headers: Readonly<Record<string, string>>;
  upload_url: string;
  version: number;
}>;

function fetchBody(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function cleanJpeg(): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]),
    Buffer.from('M6.3-B2b-D3 clean member evidence', 'ascii'),
  ]);
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

describe.sequential('M6.3-B2b-D3 member evidence HTTP lifecycle', () => {
  loadEnvironment({ path: '.env.test.example', quiet: true, override: true });
  const config = parseRuntimeConfig();
  const owner = new PrismaClient({ datasourceUrl: config.DATABASE_URL });
  const runtime = createRuntimePrismaClient(config.DATABASE_RUNTIME_URL);
  const suffix = randomUUID().slice(0, 8);
  const fixture = {
    adminId: randomUUID(),
    beautyMemberId: randomUUID(),
    beautyMemberSessionId: randomUUID(),
    beautyOtherMemberId: randomUUID(),
    beautyOtherMemberSessionId: randomUUID(),
    fashionMemberId: randomUUID(),
    fashionMemberSessionId: randomUUID(),
    limitedMemberId: randomUUID(),
    limitedMemberSessionId: randomUUID(),
  };
  const evidenceIds = new Set<string>();
  let app: INestApplication;
  let storage: AfterSaleEvidenceObjectStorageProvider;
  let handler: AfterSaleEvidenceScanRequestedHandler;
  let beautyToken: string;
  let beautyOtherToken: string;
  let fashionToken: string;
  let limitedToken: string;
  let limiterRedis: {
    del(...keys: string[]): Promise<number>;
    set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  };

  const api = () => request(app.getHttpServer() as Server);
  const memberHeaders = (token = beautyToken, storeCode = 'beauty-local') => ({
    Authorization: `Bearer ${token}`,
    'X-Store-Code': storeCode,
  });

  function accessToken(input: { sessionId: string; storeId: string; subjectId: string }): string {
    const now = Math.floor(Date.now() / 1_000);
    return signJwt(
      {
        actor_type: 'member',
        aud: config.AUTH_JWT_AUDIENCE,
        exp: now + 900,
        iat: now,
        iss: config.AUTH_JWT_ISSUER,
        jti: randomUUID(),
        session_id: input.sessionId,
        store_id: input.storeId,
        sub: input.subjectId,
      },
      config.AUTH_JWT_SECRET,
    );
  }

  function workerContext(storeId = BEAUTY_STORE_ID, storeCode = 'beauty-local') {
    return createStoreContext({
      actor: { id: fixture.adminId, type: 'admin' },
      correlationId: randomUUID(),
      locale: 'vi',
      storeCode,
      storeId,
    });
  }

  function rateLimitKey(memberId: string, access: 'read' | 'write', windowOffset = 0): string {
    const window = Math.floor(Date.now() / 60_000) + windowOffset;
    const identity = createHmac('sha256', config.PII_HASH_KEY)
      .update(`MEMBER:${memberId}`)
      .digest('hex');
    return `${config.NODE_ENV}:${BEAUTY_STORE_ID}:after-sale-${access}:member:${identity}:${window}`;
  }

  async function initialize(
    body: Buffer,
    options: Readonly<{
      filename?: string;
      idempotencyKey?: string;
      mimeType?: 'image/jpeg' | 'image/png';
      token?: string;
    }> = {},
  ) {
    const idempotencyKey = options.idempotencyKey ?? `m63-d3-init-${randomUUID()}`;
    const response = await api()
      .post('/v1/after-sales/evidence-uploads')
      .set(memberHeaders(options.token))
      .set('Idempotency-Key', idempotencyKey)
      .send({
        byte_size: body.byteLength,
        checksum_sha256: createHash('sha256').update(body).digest('hex'),
        filename: options.filename ?? 'evidence.jpg',
        mime_type: options.mimeType ?? 'image/jpeg',
      });
    if (response.status === 201) evidenceIds.add(response.body.evidence_id as string);
    return { idempotencyKey, response };
  }

  async function putUpload(upload: UploadResponse, body: Buffer): Promise<Response> {
    return fetch(upload.upload_url, {
      body: fetchBody(body),
      headers: upload.upload_headers,
      method: 'PUT',
    });
  }

  async function confirm(
    upload: UploadResponse,
    idempotencyKey = `m63-d3-confirm-${randomUUID()}`,
  ) {
    return api()
      .post(`/v1/after-sales/evidence-uploads/${upload.evidence_id}/confirm`)
      .set(memberHeaders())
      .set('Idempotency-Key', idempotencyKey)
      .send({ expected_version: upload.version });
  }

  async function scan(evidenceId: string): Promise<OutboxMessageRecord> {
    const workerId = `m63-d3-worker-${randomUUID()}`;
    const messages = await claimOutboxMessages(runtime, workerContext(), {
      batchSize: 1,
      leaseDurationMs: config.OUTBOX_WORKER_LEASE_MS,
      workerId,
    });
    const message = messages[0];
    if (
      !message ||
      message.eventType !== AFTER_SALE_EVIDENCE_SCAN_EVENT ||
      message.aggregateId !== evidenceId
    ) {
      throw new Error('Expected one D3 evidence scan message');
    }
    await handler.handle(message);
    await completeOutboxMessage(runtime, workerContext(), {
      expectedVersion: message.version,
      messageId: message.id,
      workerId,
    });
    return message;
  }

  beforeAll(async () => {
    if (
      !config.AFTER_SALE_EVIDENCE_MEMBER_UPLOADS_ENABLED ||
      config.EVIDENCE_SCANNER_PROVIDER !== 'clamav' ||
      config.EVIDENCE_SCANNER_HOST === undefined ||
      config.EVIDENCE_SCANNER_SIGNATURE_MAX_AGE_SECONDS === undefined
    ) {
      throw new Error('M6.3-B2b-D3 integration configuration is incomplete');
    }
    await Promise.all([owner.$connect(), runtime.$connect()]);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1_000);
    await owner.$transaction(async (transaction) => {
      await transaction.adminUser.create({
        data: {
          displayName: 'M6.3-B2b-D3 worker fixture',
          email: `m63-d3-${suffix}@example.invalid`,
          emailNormalized: `m63-d3-${suffix}@example.invalid`,
          id: fixture.adminId,
          passwordHash: 'test-fixture-not-a-login-hash',
        },
      });
      await transaction.member.createMany({
        data: [
          { displayName: 'D3 beauty owner', id: fixture.beautyMemberId, storeId: BEAUTY_STORE_ID },
          {
            displayName: 'D3 beauty other',
            id: fixture.beautyOtherMemberId,
            storeId: BEAUTY_STORE_ID,
          },
          {
            displayName: 'D3 fashion owner',
            id: fixture.fashionMemberId,
            storeId: FASHION_STORE_ID,
          },
          {
            displayName: 'D3 limited owner',
            id: fixture.limitedMemberId,
            storeId: BEAUTY_STORE_ID,
          },
        ],
      });
      await transaction.memberSession.createMany({
        data: [
          {
            expiresAt,
            id: fixture.beautyMemberSessionId,
            memberId: fixture.beautyMemberId,
            refreshTokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
            storeId: BEAUTY_STORE_ID,
            tokenFamilyId: randomUUID(),
          },
          {
            expiresAt,
            id: fixture.beautyOtherMemberSessionId,
            memberId: fixture.beautyOtherMemberId,
            refreshTokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
            storeId: BEAUTY_STORE_ID,
            tokenFamilyId: randomUUID(),
          },
          {
            expiresAt,
            id: fixture.fashionMemberSessionId,
            memberId: fixture.fashionMemberId,
            refreshTokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
            storeId: FASHION_STORE_ID,
            tokenFamilyId: randomUUID(),
          },
          {
            expiresAt,
            id: fixture.limitedMemberSessionId,
            memberId: fixture.limitedMemberId,
            refreshTokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
            storeId: BEAUTY_STORE_ID,
            tokenFamilyId: randomUUID(),
          },
        ],
      });
    });
    beautyToken = accessToken({
      sessionId: fixture.beautyMemberSessionId,
      storeId: BEAUTY_STORE_ID,
      subjectId: fixture.beautyMemberId,
    });
    beautyOtherToken = accessToken({
      sessionId: fixture.beautyOtherMemberSessionId,
      storeId: BEAUTY_STORE_ID,
      subjectId: fixture.beautyOtherMemberId,
    });
    fashionToken = accessToken({
      sessionId: fixture.fashionMemberSessionId,
      storeId: FASHION_STORE_ID,
      subjectId: fixture.fashionMemberId,
    });
    limitedToken = accessToken({
      sessionId: fixture.limitedMemberSessionId,
      storeId: BEAUTY_STORE_ID,
      subjectId: fixture.limitedMemberId,
    });

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
    const scanner = new ClamAvAfterSaleEvidenceScanner({
      host: config.EVIDENCE_SCANNER_HOST,
      port: config.EVIDENCE_SCANNER_PORT,
      responseLimitBytes: config.EVIDENCE_SCANNER_RESPONSE_LIMIT_BYTES,
      signatureMaxAgeMs: config.EVIDENCE_SCANNER_SIGNATURE_MAX_AGE_SECONDS * 1_000,
      timeoutMs: config.EVIDENCE_SCANNER_REQUEST_TIMEOUT_MS,
    });
    handler = new AfterSaleEvidenceScanRequestedHandler(runtime, storage, scanner, config);
    limiterRedis = (app.get(AfterSalesRateLimiter) as unknown as { redis: typeof limiterRedis })
      .redis;
  });

  afterAll(async () => {
    for (const evidenceId of evidenceIds) {
      const evidence = await owner.afterSaleEvidenceFile.findUnique({
        select: { objectKey: true, storeId: true },
        where: { id: evidenceId },
      });
      if (evidence?.objectKey) {
        await storage
          ?.removeObject({
            deploymentEnvironment: 'test',
            evidenceId,
            objectKey: evidence.objectKey,
            storeId: evidence.storeId,
          })
          .catch(() => undefined);
      }
    }
    await limiterRedis?.del(
      ...[fixture.beautyMemberId, fixture.beautyOtherMemberId, fixture.limitedMemberId].flatMap(
        (memberId) =>
          ['read', 'write'].flatMap((access) =>
            [-1, 0, 1].map((offset) => rateLimitKey(memberId, access as 'read' | 'write', offset)),
          ),
      ),
    );
    await app?.close();
    await runtime.$disconnect();
    await owner.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        DELETE FROM after_sale_evidence_transitions
        WHERE evidence_file_id = ANY(${[...evidenceIds]}::uuid[])
      `;
      await transaction.$executeRaw`
        DELETE FROM after_sale_evidence_objects
        WHERE evidence_file_id = ANY(${[...evidenceIds]}::uuid[])
      `;
      await transaction.$executeRaw`
        DELETE FROM outbox_messages
        WHERE aggregate_id = ANY(${[...evidenceIds]}::uuid[])
          AND aggregate_type = 'AFTER_SALE_EVIDENCE'
      `;
      await transaction.idempotencyRecord.deleteMany({
        where: {
          memberId: {
            in: [
              fixture.beautyMemberId,
              fixture.beautyOtherMemberId,
              fixture.fashionMemberId,
              fixture.limitedMemberId,
            ],
          },
          operation: { startsWith: 'after-sale-evidence-' },
        },
      });
      await transaction.afterSaleEvidenceFile.deleteMany({
        where: { id: { in: [...evidenceIds] } },
      });
      await transaction.memberSession.deleteMany({
        where: {
          id: {
            in: [
              fixture.beautyMemberSessionId,
              fixture.beautyOtherMemberSessionId,
              fixture.fashionMemberSessionId,
              fixture.limitedMemberSessionId,
            ],
          },
        },
      });
      await transaction.member.deleteMany({
        where: {
          id: {
            in: [
              fixture.beautyMemberId,
              fixture.beautyOtherMemberId,
              fixture.fashionMemberId,
              fixture.limitedMemberId,
            ],
          },
        },
      });
      await transaction.adminUser.deleteMany({ where: { id: fixture.adminId } });
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });
    await owner.$disconnect();
  });

  it('runs initialize, signed upload, confirm, real scan and owner status end to end', async () => {
    const body = cleanJpeg();
    const initialized = await initialize(body);
    expect(initialized.response.status).toBe(201);
    expect(initialized.response.headers['cache-control']).toBe('private, no-store');
    expect(initialized.response.headers['referrer-policy']).toBe('no-referrer');
    expect(initialized.response.headers['idempotency-replayed']).toBe('false');
    const upload = initialized.response.body as UploadResponse;
    expect(upload.upload_headers).toMatchObject({
      'content-type': 'image/jpeg',
      'if-none-match': '*',
    });
    expect(JSON.stringify(upload)).not.toMatch(/object_key|bucket|secret|access_key/iu);

    const replay = await initialize(body, { idempotencyKey: initialized.idempotencyKey });
    expect(replay.response.status).toBe(201);
    expect(replay.response.headers['idempotency-replayed']).toBe('true');
    expect(replay.response.body.evidence_id).toBe(upload.evidence_id);

    expect((await putUpload(upload, body)).status).toBeLessThan(300);
    const confirmationKey = `m63-d3-confirm-${randomUUID()}`;
    const confirmed = await confirm(upload, confirmationKey);
    expect(confirmed.status).toBe(202);
    expect(confirmed.headers['idempotency-replayed']).toBe('false');
    expect(confirmed.body).toMatchObject({
      access_expires_at: null,
      evidence_id: upload.evidence_id,
      status: 'PENDING',
      version: 2,
    });
    const confirmReplay = await confirm(upload, confirmationKey);
    expect(confirmReplay.status).toBe(202);
    expect(confirmReplay.headers['idempotency-replayed']).toBe('true');

    const pending = await api()
      .get(`/v1/after-sales/evidence-uploads/${upload.evidence_id}`)
      .set(memberHeaders());
    expect(pending.status).toBe(200);
    expect(pending.body).toMatchObject({ status: 'PENDING', version: 2 });

    await scan(upload.evidence_id);
    const ready = await api()
      .get(`/v1/after-sales/evidence-uploads/${upload.evidence_id}`)
      .set(memberHeaders());
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({
      evidence_id: upload.evidence_id,
      status: 'READY',
      version: 3,
    });
    expect(new Date(ready.body.access_expires_at as string).getTime()).toBeGreaterThan(Date.now());
    expect(
      await owner.afterSaleEvidenceFile.findUniqueOrThrow({ where: { id: upload.evidence_id } }),
    ).toMatchObject({
      scanResultCode: 'CLEAN',
      scannerEngine: 'clamav',
      status: 'READY_UNCLAIMED',
    });
  });

  it('rejects content deception and hides known evidence across owner and store boundaries', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const initialized = await initialize(png, { filename: 'declared.jpg', mimeType: 'image/jpeg' });
    expect(initialized.response.status).toBe(201);
    const upload = initialized.response.body as UploadResponse;
    expect((await putUpload(upload, png)).status).toBeLessThan(300);

    const otherOwner = await api()
      .get(`/v1/after-sales/evidence-uploads/${upload.evidence_id}`)
      .set(memberHeaders(beautyOtherToken));
    expect(otherOwner.status).toBe(404);
    const otherStore = await api()
      .get(`/v1/after-sales/evidence-uploads/${upload.evidence_id}`)
      .set(memberHeaders(fashionToken, 'fashion-local'));
    expect(otherStore.status).toBe(404);
    const strictQuery = await api()
      .get(`/v1/after-sales/evidence-uploads/${upload.evidence_id}?include=internal`)
      .set(memberHeaders());
    expect(strictQuery.status).toBe(400);

    const confirmation = await confirm(upload);
    expect(confirmation.status).toBe(409);
    expect(JSON.stringify(confirmation.body)).not.toMatch(
      /object_key|checksum|magic|scanner|bucket|png|jpeg/iu,
    );
    expect(
      await owner.afterSaleEvidenceFile.findUniqueOrThrow({ where: { id: upload.evidence_id } }),
    ).toMatchObject({ confirmedAt: null, scanGeneration: 0, status: 'PENDING', version: 1 });
    expect(
      await owner.outboxMessage.count({
        where: { aggregateId: upload.evidence_id, eventType: AFTER_SALE_EVIDENCE_SCAN_EVENT },
      }),
    ).toBe(0);

    const conflictingReplay = await initialize(Buffer.concat([png, Buffer.from([1])]), {
      idempotencyKey: initialized.idempotencyKey,
      mimeType: 'image/png',
    });
    expect(conflictingReplay.response.status).toBe(409);
  });

  it('collapses a real malware verdict without exposing scanner details', async () => {
    const body = eicarJpeg();
    const initialized = await initialize(body);
    expect(initialized.response.status).toBe(201);
    const upload = initialized.response.body as UploadResponse;
    expect((await putUpload(upload, body)).status).toBeLessThan(300);
    expect((await confirm(upload)).status).toBe(202);
    await scan(upload.evidence_id);

    const unavailable = await api()
      .get(`/v1/after-sales/evidence-uploads/${upload.evidence_id}`)
      .set(memberHeaders());
    expect(unavailable.status).toBe(200);
    expect(unavailable.body).toEqual({
      access_expires_at: null,
      evidence_id: upload.evidence_id,
      status: 'UNAVAILABLE',
      version: 3,
    });
    expect(JSON.stringify(unavailable.body)).not.toMatch(/eicar|malware|scanner|quarantine/iu);
    expect(
      await owner.afterSaleEvidenceFile.findUniqueOrThrow({ where: { id: upload.evidence_id } }),
    ).toMatchObject({ scanResultCode: 'MALWARE_DETECTED', status: 'QUARANTINED' });
  });

  it('fails the write limiter before creating an evidence fact', async () => {
    const key = rateLimitKey(fixture.limitedMemberId, 'write');
    await limiterRedis.set(key, String(AFTER_SALE_RATE_LIMIT_POLICY.member_write.limit), 'EX', 61);
    const before = await owner.afterSaleEvidenceFile.count({
      where: { memberId: fixture.limitedMemberId, storeId: BEAUTY_STORE_ID },
    });
    const response = await initialize(cleanJpeg(), { token: limitedToken });
    expect(response.response.status).toBe(429);
    expect(Number(response.response.headers['retry-after'])).toBeGreaterThan(0);
    expect(
      await owner.afterSaleEvidenceFile.count({
        where: { memberId: fixture.limitedMemberId, storeId: BEAUTY_STORE_ID },
      }),
    ).toBe(before);
  });
});
