import { ServiceUnavailableException } from '@nestjs/common';
import type { RuntimeConfig } from '@zalo-shop/config';
import type { AfterSaleEvidenceRecord, PrismaClient, StoreTransaction } from '@zalo-shop/database';
import { createStoreContext } from '@zalo-shop/domain';
import type { AfterSaleEvidenceObjectStorageProvider } from '@zalo-shop/integrations';
import { describe, expect, it, vi } from 'vitest';

import type { AdminService } from '../admin/admin.service';
import type { AuthService } from '../auth/auth.service';
import type { AfterSalesRateLimiter } from '../after-sales/after-sales-rate-limiter';
import { AfterSalesEvidenceService, projectMemberEvidence } from './after-sales-evidence.service';

const STORE_ID = '10000000-0000-4000-8000-000000000001';
const MEMBER_ID = '20000000-0000-4000-8000-000000000001';
const EVIDENCE_ID = '30000000-0000-4000-8000-000000000001';
const AFTER_SALE_ID = '40000000-0000-4000-8000-000000000001';
const ADMIN_ID = '50000000-0000-4000-8000-000000000001';
const ACCESS_DEADLINE = new Date('2099-08-01T12:00:00.000Z');
const ACCESS_TOKEN_EXPIRY = new Date('2099-08-01T12:30:00.000Z');
const SIGNED_EXPIRY = new Date('2099-08-01T11:59:00.000Z');
const OBSERVED_AT = new Date('2099-08-01T11:00:00.000Z');
const OBJECT_KEY = `test/${STORE_ID}/staged/${EVIDENCE_ID}/original`;

type ProtectedReadRow = {
  after_sale_id: string;
  id: string;
  legal_hold_active: boolean;
  member_id: string;
  object_key: string;
  ordinary_access_deadline_at: Date;
  status: 'READY';
  store_id: string;
  version: number;
};

function protectedReadRow(overrides: Partial<ProtectedReadRow> = {}): ProtectedReadRow {
  return {
    after_sale_id: AFTER_SALE_ID,
    id: EVIDENCE_ID,
    legal_hold_active: false,
    member_id: MEMBER_ID,
    object_key: OBJECT_KEY,
    ordinary_access_deadline_at: ACCESS_DEADLINE,
    status: 'READY',
    store_id: STORE_ID,
    version: 4,
    ...overrides,
  };
}

function protectedReadDatabase(rows: readonly unknown[]) {
  const queuedRows = [...rows];
  const transaction = {
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    $queryRaw: vi.fn().mockImplementation(() => Promise.resolve(queuedRows.shift() ?? [])),
  } as unknown as StoreTransaction;
  const $transaction = vi.fn(async (callback: (current: StoreTransaction) => Promise<unknown>) =>
    callback(transaction),
  );
  return {
    database: {
      $queryRaw: vi
        .fn()
        .mockResolvedValue([{ code: 'beauty', default_locale: 'vi', id: STORE_ID }]),
      $transaction,
    } as unknown as PrismaClient,
    $transaction,
    transaction,
  };
}

function protectedReadStorage() {
  const createProtectedReadTarget = vi.fn().mockResolvedValue({
    expiresAt: SIGNED_EXPIRY,
    url: 'http://localhost:9000/zalo-shop-evidence/signed-original',
  });
  return {
    createProtectedReadTarget,
    storage: {
      createProtectedReadTarget,
      destroy: vi.fn(),
    } as unknown as AfterSaleEvidenceObjectStorageProvider,
  };
}

function protectedReadConfig(): RuntimeConfig {
  return {
    AFTER_SALE_EVIDENCE_PROTECTED_READS_ENABLED: true,
    EVIDENCE_STORAGE_PROVIDER: 's3',
    NODE_ENV: 'test',
  } as RuntimeConfig;
}

function evidence(overrides: Partial<AfterSaleEvidenceRecord> = {}): AfterSaleEvidenceRecord {
  return {
    afterSaleId: null,
    byteSize: 1_024n,
    claimDeadlineAt: null,
    confirmedAt: null,
    deleteAttemptCount: 0,
    deleteExhaustedAt: null,
    id: EVIDENCE_ID,
    legalHoldActive: false,
    memberId: MEMBER_ID,
    nextDeleteAttemptAt: null,
    objectKey: null,
    ordinaryAccessDeadlineAt: null,
    retentionDeadlineAt: null,
    scanGeneration: 0,
    status: 'PENDING',
    storeId: STORE_ID,
    uploadDeadlineAt: new Date('2026-07-30T10:00:00.000Z'),
    version: 1,
    ...overrides,
  };
}

describe('member evidence projection', () => {
  it('uses exclusive upload and claim deadlines without exposing internal states', () => {
    expect(projectMemberEvidence(evidence(), new Date('2026-07-30T09:59:59.999Z'))).toMatchObject({
      status: 'PENDING',
    });
    expect(projectMemberEvidence(evidence(), new Date('2026-07-30T10:00:00.000Z'))).toMatchObject({
      status: 'UNAVAILABLE',
    });

    const ready = evidence({
      claimDeadlineAt: new Date('2026-07-30T11:00:00.000Z'),
      confirmedAt: new Date('2026-07-30T09:00:00.000Z'),
      status: 'READY_UNCLAIMED',
      version: 3,
    });
    expect(projectMemberEvidence(ready, new Date('2026-07-30T10:00:00.000Z'))).toEqual({
      access_expires_at: '2026-07-30T11:00:00.000Z',
      evidence_id: EVIDENCE_ID,
      status: 'READY',
      version: 3,
    });
    expect(projectMemberEvidence(ready, ready.claimDeadlineAt!)).toMatchObject({
      access_expires_at: null,
      status: 'UNAVAILABLE',
    });
    expect(
      projectMemberEvidence(
        evidence({
          confirmedAt: new Date('2026-07-30T09:00:00.000Z'),
          retentionDeadlineAt: new Date('2026-08-30T09:00:00.000Z'),
          status: 'QUARANTINED',
        }),
        new Date('2026-07-30T10:00:00.000Z'),
      ),
    ).toMatchObject({ access_expires_at: null, status: 'UNAVAILABLE' });
  });
});

describe('AfterSalesEvidenceService capability gate', () => {
  it('authenticates and rate-limits before failing closed when member uploads are disabled', async () => {
    const database = {
      $queryRaw: vi
        .fn()
        .mockResolvedValue([{ code: 'beauty', default_locale: 'vi', id: STORE_ID }]),
    } as unknown as PrismaClient;
    const authenticateAccessToken = vi.fn().mockResolvedValue({
      accessSessionExpiresAt: ACCESS_TOKEN_EXPIRY,
      accessTokenExpiresAt: ACCESS_TOKEN_EXPIRY,
      actorType: 'member',
      sessionId: 'session',
      storeId: STORE_ID,
      subjectId: MEMBER_ID,
    });
    const auth = { authenticateAccessToken } as unknown as AuthService;
    const admin = {} as AdminService;
    const consume = vi.fn().mockResolvedValue(undefined);
    const rateLimiter = { consume } as unknown as AfterSalesRateLimiter;
    const service = new AfterSalesEvidenceService(
      database,
      auth,
      admin,
      rateLimiter,
      {
        AFTER_SALE_EVIDENCE_MEMBER_UPLOADS_ENABLED: false,
        AFTER_SALE_EVIDENCE_PROTECTED_READS_ENABLED: false,
        EVIDENCE_SCANNER_PROVIDER: 'disabled',
        EVIDENCE_STORAGE_PROVIDER: 'disabled',
      } as RuntimeConfig,
      null as AfterSaleEvidenceObjectStorageProvider | null,
    );

    await expect(
      service.status({
        evidenceId: EVIDENCE_ID,
        headers: {
          authorization: 'Bearer member-token',
          correlationId: 'm63-b2b-d3-disabled',
          storeCode: 'beauty',
        },
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(authenticateAccessToken).toHaveBeenCalledOnce();
    expect(consume).toHaveBeenCalledWith({
      access: 'READ',
      actorId: MEMBER_ID,
      actorType: 'MEMBER',
      storeId: STORE_ID,
    });
  });

  it('keeps protected reads closed after member authentication and rate limiting by default', async () => {
    const database = {
      $queryRaw: vi
        .fn()
        .mockResolvedValue([{ code: 'beauty', default_locale: 'vi', id: STORE_ID }]),
    } as unknown as PrismaClient;
    const authenticateAccessToken = vi.fn().mockResolvedValue({
      accessSessionExpiresAt: ACCESS_TOKEN_EXPIRY,
      accessTokenExpiresAt: ACCESS_TOKEN_EXPIRY,
      actorType: 'member',
      sessionId: 'session',
      storeId: STORE_ID,
      subjectId: MEMBER_ID,
    });
    const consume = vi.fn().mockResolvedValue(undefined);
    const service = new AfterSalesEvidenceService(
      database,
      { authenticateAccessToken } as unknown as AuthService,
      {} as AdminService,
      { consume } as unknown as AfterSalesRateLimiter,
      {
        AFTER_SALE_EVIDENCE_PROTECTED_READS_ENABLED: false,
        EVIDENCE_STORAGE_PROVIDER: 'disabled',
      } as RuntimeConfig,
      null,
    );

    await expect(
      service.memberProtectedRead({
        afterSaleId: AFTER_SALE_ID,
        evidenceId: EVIDENCE_ID,
        headers: {
          authorization: 'Bearer member-token',
          correlationId: 'm63-b2b-d5-disabled',
          storeCode: 'beauty',
        },
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(authenticateAccessToken).toHaveBeenCalledOnce();
    expect(consume).toHaveBeenCalledWith({
      access: 'READ',
      actorId: MEMBER_ID,
      actorType: 'MEMBER',
      storeId: STORE_ID,
    });
  });

  it('revalidates a member protected read before returning an original-only URL', async () => {
    const { database, $transaction, transaction } = protectedReadDatabase([
      [protectedReadRow()],
      [{ current_time: OBSERVED_AT }],
      [protectedReadRow()],
      [{ current_time: OBSERVED_AT }],
    ]);
    const authenticateAccessToken = vi.fn().mockResolvedValue({
      accessSessionExpiresAt: ACCESS_TOKEN_EXPIRY,
      accessTokenExpiresAt: ACCESS_TOKEN_EXPIRY,
      actorType: 'member',
      sessionId: 'session',
      storeId: STORE_ID,
      subjectId: MEMBER_ID,
    });
    const consume = vi.fn().mockResolvedValue(undefined);
    const { createProtectedReadTarget, storage } = protectedReadStorage();
    const service = new AfterSalesEvidenceService(
      database,
      { authenticateAccessToken } as unknown as AuthService,
      {} as AdminService,
      { consume } as unknown as AfterSalesRateLimiter,
      protectedReadConfig(),
      storage,
    );

    await expect(
      service.memberProtectedRead({
        afterSaleId: AFTER_SALE_ID,
        evidenceId: EVIDENCE_ID,
        headers: {
          authorization: 'Bearer member-token',
          correlationId: 'm63-b2b-d5-member-read',
          storeCode: 'beauty',
        },
      }),
    ).resolves.toEqual({
      expires_at: SIGNED_EXPIRY.toISOString(),
      url: 'http://localhost:9000/zalo-shop-evidence/signed-original',
    });

    expect(createProtectedReadTarget).toHaveBeenCalledWith({
      accessDeadline: ACCESS_DEADLINE,
      deploymentEnvironment: 'test',
      evidenceId: EVIDENCE_ID,
      objectKey: OBJECT_KEY,
      objectRole: 'ORIGINAL',
      storeId: STORE_ID,
    });
    expect($transaction).toHaveBeenNthCalledWith(1, expect.any(Function), {
      isolationLevel: 'RepeatableRead',
      timeout: 15_000,
    });
    expect($transaction).toHaveBeenNthCalledWith(2, expect.any(Function), {
      isolationLevel: 'ReadCommitted',
      timeout: 15_000,
    });
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(4);
  });

  it('rejects an invalid provider URL before administrator revalidation or audit', async () => {
    const { database, $transaction, transaction } = protectedReadDatabase([
      [protectedReadRow()],
      [{ current_time: OBSERVED_AT }],
    ]);
    const context = createStoreContext({
      accessSessionExpiresAt: ACCESS_TOKEN_EXPIRY,
      accessSessionId: '60000000-0000-4000-8000-000000000001',
      accessTokenExpiresAt: ACCESS_TOKEN_EXPIRY,
      actor: { id: ADMIN_ID, type: 'admin' },
      correlationId: 'm63-b2b-d5-admin-invalid-url',
      locale: 'vi',
      storeCode: 'beauty',
      storeId: STORE_ID,
    });
    const authorize = vi.fn().mockResolvedValue(context);
    const writeAudit = vi.fn().mockResolvedValue(undefined);
    const { createProtectedReadTarget, storage } = protectedReadStorage();
    createProtectedReadTarget.mockResolvedValueOnce({
      expiresAt: SIGNED_EXPIRY,
      url: 'not-a-url',
    });
    const service = new AfterSalesEvidenceService(
      database,
      {} as AuthService,
      { authorize, writeAudit } as unknown as AdminService,
      { consume: vi.fn().mockResolvedValue(undefined) } as unknown as AfterSalesRateLimiter,
      protectedReadConfig(),
      storage,
    );

    const error = await service
      .adminProtectedRead({
        afterSaleId: AFTER_SALE_ID,
        evidenceId: EVIDENCE_ID,
        headers: {
          accessToken: 'admin-token',
          correlationId: context.correlationId,
          sourceIp: '127.0.0.1',
          storeCode: 'beauty',
        },
        storeId: STORE_ID,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getStatus()).toBe(503);
    expect($transaction).toHaveBeenCalledOnce();
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(2);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('fails closed with 503 and no response when the administrator audit cannot commit', async () => {
    const { database, transaction } = protectedReadDatabase([
      [protectedReadRow()],
      [{ current_time: OBSERVED_AT }],
      [protectedReadRow()],
      [{ current_time: OBSERVED_AT }],
    ]);
    const context = createStoreContext({
      accessSessionExpiresAt: ACCESS_TOKEN_EXPIRY,
      accessSessionId: '60000000-0000-4000-8000-000000000001',
      accessTokenExpiresAt: ACCESS_TOKEN_EXPIRY,
      actor: { id: ADMIN_ID, type: 'admin' },
      correlationId: 'm63-b2b-d5-admin-audit',
      locale: 'vi',
      storeCode: 'beauty',
      storeId: STORE_ID,
    });
    const authorize = vi.fn().mockResolvedValue(context);
    const writeAudit = vi.fn().mockRejectedValue(new Error('audit persistence failed'));
    const { storage } = protectedReadStorage();
    const service = new AfterSalesEvidenceService(
      database,
      {} as AuthService,
      { authorize, writeAudit } as unknown as AdminService,
      { consume: vi.fn().mockResolvedValue(undefined) } as unknown as AfterSalesRateLimiter,
      protectedReadConfig(),
      storage,
    );

    const error = await service
      .adminProtectedRead({
        afterSaleId: AFTER_SALE_ID,
        evidenceId: EVIDENCE_ID,
        headers: {
          accessToken: 'admin-token',
          correlationId: context.correlationId,
          sourceIp: '127.0.0.1',
          storeCode: 'beauty',
        },
        storeId: STORE_ID,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getStatus()).toBe(503);
    expect(writeAudit).toHaveBeenCalledWith(
      transaction,
      context,
      expect.objectContaining({
        action: 'after-sale.evidence.protected_read.issued',
        targetId: EVIDENCE_ID,
        targetType: 'after_sale_evidence_file',
      }),
    );
    const auditEvent = writeAudit.mock.calls[0]?.[2];
    expect(auditEvent).toMatchObject({
      after: {
        after_sale_id: AFTER_SALE_ID,
        evidence_version: 4,
        expires_at: SIGNED_EXPIRY.toISOString(),
      },
    });
    expect(JSON.stringify(auditEvent)).not.toContain('signed-original');
    expect(JSON.stringify(auditEvent)).not.toContain(OBJECT_KEY);
  });
});
