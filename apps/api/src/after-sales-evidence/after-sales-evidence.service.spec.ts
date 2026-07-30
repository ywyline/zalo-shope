import { ServiceUnavailableException } from '@nestjs/common';
import type { RuntimeConfig } from '@zalo-shop/config';
import type { AfterSaleEvidenceRecord, PrismaClient } from '@zalo-shop/database';
import type { AfterSaleEvidenceObjectStorageProvider } from '@zalo-shop/integrations';
import { describe, expect, it, vi } from 'vitest';

import type { AuthService } from '../auth/auth.service';
import type { AfterSalesRateLimiter } from '../after-sales/after-sales-rate-limiter';
import { AfterSalesEvidenceService, projectMemberEvidence } from './after-sales-evidence.service';

const STORE_ID = '10000000-0000-4000-8000-000000000001';
const MEMBER_ID = '20000000-0000-4000-8000-000000000001';
const EVIDENCE_ID = '30000000-0000-4000-8000-000000000001';

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
      actorType: 'member',
      sessionId: 'session',
      storeId: STORE_ID,
      subjectId: MEMBER_ID,
    });
    const auth = { authenticateAccessToken } as unknown as AuthService;
    const consume = vi.fn().mockResolvedValue(undefined);
    const rateLimiter = { consume } as unknown as AfterSalesRateLimiter;
    const service = new AfterSalesEvidenceService(
      database,
      auth,
      rateLimiter,
      {
        AFTER_SALE_EVIDENCE_MEMBER_UPLOADS_ENABLED: false,
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
});
