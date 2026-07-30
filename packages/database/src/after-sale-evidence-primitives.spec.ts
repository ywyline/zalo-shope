import type { PrismaClient } from '@prisma/client';
import {
  createAfterSaleEvidenceSystemContext,
  createStoreContext,
  type StoreContext,
} from '@zalo-shop/domain';
import { describe, expect, it, vi } from 'vitest';

import type { StoreTransaction } from './index';
import {
  applyAfterSaleEvidenceScanResult,
  applyAfterSaleEvidenceScanResultForLease,
  beginAfterSaleEvidenceDeletion,
  claimAfterSaleEvidenceInTransaction,
  completeAfterSaleEvidenceDeletion,
  initializeAfterSaleEvidenceUpload,
  listAfterSaleEvidenceScanDeadLetterCandidates,
  loadAfterSaleEvidenceScanWorkForLease,
  reconcileAfterSaleEvidenceDeadLetter,
  reconcileAfterSaleEvidenceScanDeadLetter,
  recordAfterSaleEvidenceDeletionFailure,
  requestAfterSaleEvidenceRescan,
  type InitializeAfterSaleEvidenceInput,
} from './after-sale-evidence-primitives';

const STORE_ID = '10000000-0000-4000-8000-000000000001';
const MEMBER_ID = '20000000-0000-4000-8000-000000000001';
const EVIDENCE_ID = '30000000-0000-4000-8000-000000000001';
const AFTER_SALE_ID = '40000000-0000-4000-8000-000000000001';
const MESSAGE_ID = '50000000-0000-4000-8000-000000000001';
const OBJECT_ID = '60000000-0000-4000-8000-000000000001';
const unusedClient = {} as PrismaClient;
const unusedTransaction = {} as StoreTransaction;
const VALID_DELETE_POLICY = {
  baseDelayMs: 60_000,
  maxAttempts: 8,
  maxDelayMs: 6 * 60 * 60 * 1_000,
};
const VALID_RECONCILIATION_DELETE_POLICY = {
  deletionBaseDelayMs: VALID_DELETE_POLICY.baseDelayMs,
  deletionMaxAttempts: VALID_DELETE_POLICY.maxAttempts,
  deletionMaxDelayMs: VALID_DELETE_POLICY.maxDelayMs,
};

const memberContext = createStoreContext({
  actor: { id: MEMBER_ID, type: 'member' },
  correlationId: 'm63-b2b-d0-input-boundaries',
  locale: 'vi',
  storeCode: 'beauty',
  storeId: STORE_ID,
});
const adminContext: StoreContext = createStoreContext({
  actor: { id: MEMBER_ID, type: 'admin' },
  correlationId: 'm63-b2b-d0-admin-boundary',
  locale: 'vi',
  storeCode: 'beauty',
  storeId: STORE_ID,
});
const systemContext = createAfterSaleEvidenceSystemContext({
  correlationId: 'm63-b2b-d0-system-boundaries',
  storeId: STORE_ID,
});

const validUpload: InitializeAfterSaleEvidenceInput = {
  byteSize: 1_024,
  checksumSha256: 'a'.repeat(64),
  deploymentEnvironment: 'test',
  filename: 'evidence.jpg',
  idempotencyKey: 'm63-b2b-input-01',
  maxUnclaimedBytes: 200 * 1_024 * 1_024,
  maxUnclaimedFiles: 12,
  mimeType: 'image/jpeg',
  uploadTtlSeconds: 15 * 60,
};

function inputError(promise: Promise<unknown>) {
  return expect(promise).rejects.toMatchObject({ code: 'AFTER_SALE_EVIDENCE_INPUT_INVALID' });
}

describe('after-sale evidence lifecycle input boundaries', () => {
  it('rejects non-member upload scope before opening a transaction', async () => {
    await expect(
      initializeAfterSaleEvidenceUpload(unusedClient, adminContext, validUpload),
    ).rejects.toMatchObject({ code: 'AFTER_SALE_EVIDENCE_SCOPE_DENIED' });
  });

  it.each([
    ['an image over 10 MiB', { byteSize: 10 * 1_024 * 1_024 + 1 }],
    ['a path-like filename', { filename: '../evidence.jpg' }],
    ['a C0 control character in a filename', { filename: 'evidence\u0000.jpg' }],
    ['a DEL control character in a filename', { filename: 'evidence\u007f.jpg' }],
    ['a non-canonical checksum', { checksumSha256: 'A'.repeat(64) }],
    ['an invalid environment', { deploymentEnvironment: 'Production' }],
    ['a short idempotency key', { idempotencyKey: 'too-short' }],
    ['an unsupported MIME type', { mimeType: 'application/pdf' as never }],
  ] satisfies ReadonlyArray<readonly [string, Partial<InitializeAfterSaleEvidenceInput>]>)(
    'rejects %s before opening a transaction',
    async (_label, override) => {
      await inputError(
        initializeAfterSaleEvidenceUpload(unusedClient, memberContext, {
          ...validUpload,
          ...override,
        }),
      );
    },
  );

  it('rejects invalid rescan identities before opening a transaction', async () => {
    await inputError(
      requestAfterSaleEvidenceRescan(unusedClient, systemContext, {
        evidenceId: 'not-a-uuid',
        expectedVersion: 2,
      }),
    );
    await inputError(
      requestAfterSaleEvidenceRescan(unusedClient, systemContext, {
        evidenceId: EVIDENCE_ID,
        expectedVersion: 0,
      }),
    );
  });

  it('rejects non-positive scan generations and incomplete trusted scanner identity', async () => {
    const baseInput = {
      claimTtlSeconds: 24 * 60 * 60,
      evidenceId: EVIDENCE_ID,
      expectedVersion: 2,
      failedRetentionSeconds: 24 * 60 * 60,
      result: {
        engine: 'scanner',
        engineVersion: '1.0.0',
        signatureVersion: '2026.07.29',
        verdict: 'CLEAN' as const,
      },
      scanGeneration: 1,
    };

    await inputError(
      applyAfterSaleEvidenceScanResult(unusedClient, systemContext, {
        ...baseInput,
        scanGeneration: 0,
      }),
    );
    await inputError(
      applyAfterSaleEvidenceScanResult(unusedClient, systemContext, {
        ...baseInput,
        result: { ...baseInput.result, engine: '' },
      }),
    );
    await inputError(
      applyAfterSaleEvidenceScanResult(unusedClient, systemContext, {
        ...baseInput,
        evidenceId: 'not-a-uuid',
      }),
    );
    await inputError(
      applyAfterSaleEvidenceScanResult(unusedClient, systemContext, {
        ...baseInput,
        expectedVersion: 0,
      }),
    );
  });

  it('rejects invalid scan lease identities before opening a transaction', async () => {
    const lease = {
      outboxExpectedVersion: 2,
      outboxMessageId: MESSAGE_ID,
      workerId: 'm63-b2b-d2-worker',
    };
    await inputError(
      loadAfterSaleEvidenceScanWorkForLease(unusedClient, systemContext, {
        ...lease,
        workerId: '',
      }),
    );
    await inputError(
      loadAfterSaleEvidenceScanWorkForLease(unusedClient, systemContext, {
        ...lease,
        outboxExpectedVersion: 0,
      }),
    );
    await inputError(
      applyAfterSaleEvidenceScanResultForLease(unusedClient, systemContext, {
        ...lease,
        claimTtlSeconds: 24 * 60 * 60,
        failedRetentionSeconds: 24 * 60 * 60,
        result: {
          engine: 'clamav',
          engineVersion: '1.5.3',
          signatureVersion: '20260729',
          verdict: 'CLEAN',
        },
        scanGeneration: 0,
      }),
    );
  });

  it('bounds both lease-bound scan transactions to two seconds', async () => {
    const sentinel = new Error('transaction callback must not run');
    const transaction = vi.fn().mockRejectedValue(sentinel);
    const client = { $transaction: transaction } as never;
    const lease = {
      outboxExpectedVersion: 2,
      outboxMessageId: MESSAGE_ID,
      workerId: 'm63-b2b-d2-worker',
    };

    await expect(loadAfterSaleEvidenceScanWorkForLease(client, systemContext, lease)).rejects.toBe(
      sentinel,
    );
    expect(transaction).toHaveBeenLastCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
      timeout: 2_000,
    });

    transaction.mockClear();
    await expect(
      applyAfterSaleEvidenceScanResultForLease(client, systemContext, {
        ...lease,
        claimTtlSeconds: 24 * 60 * 60,
        failedRetentionSeconds: 24 * 60 * 60,
        result: {
          engine: 'clamav',
          engineVersion: '1.5.3',
          signatureVersion: '20260729',
          verdict: 'CLEAN',
        },
        scanGeneration: 1,
      }),
    ).rejects.toBe(sentinel);
    expect(transaction).toHaveBeenLastCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
      timeout: 2_000,
    });
  });

  it('requires a bounded unique claim set and access to expire before retention', async () => {
    await inputError(
      claimAfterSaleEvidenceInTransaction(unusedTransaction, memberContext, {
        afterSaleId: AFTER_SALE_ID,
        evidenceIds: [EVIDENCE_ID],
        ordinaryAccessTtlSeconds: 30 * 24 * 60 * 60,
        retentionTtlSeconds: 30 * 24 * 60 * 60,
      }),
    );
    await inputError(
      claimAfterSaleEvidenceInTransaction(unusedTransaction, memberContext, {
        afterSaleId: AFTER_SALE_ID,
        evidenceIds: [EVIDENCE_ID, EVIDENCE_ID],
        ordinaryAccessTtlSeconds: 30 * 24 * 60 * 60,
        retentionTtlSeconds: 90 * 24 * 60 * 60,
      }),
    );
  });

  it('rejects invalid clocks before opening a transaction', async () => {
    await inputError(
      beginAfterSaleEvidenceDeletion(unusedClient, systemContext, {
        evidenceId: EVIDENCE_ID,
        expectedVersion: 3,
        now: new Date(Number.NaN),
      }),
    );
  });

  it.each([
    ['a base delay below 60 seconds', { baseDelayMs: 59_999 }],
    ['seven maximum attempts', { maxAttempts: 7 }],
    ['nine maximum attempts', { maxAttempts: 9 }],
    ['a maximum delay above six hours', { maxDelayMs: 6 * 60 * 60 * 1_000 + 1 }],
    ['a maximum delay below the base delay', { baseDelayMs: 120_000, maxDelayMs: 60_000 }],
  ])('rejects %s for deletion failure recording', async (_label, override) => {
    await inputError(
      recordAfterSaleEvidenceDeletionFailure(unusedClient, systemContext, {
        ...VALID_DELETE_POLICY,
        ...override,
        errorCode: 'PROVIDER_TIMEOUT',
        evidenceId: EVIDENCE_ID,
        expectedVersion: 3,
      }),
    );
  });

  it.each([
    ['a base delay below 60 seconds', { deletionBaseDelayMs: 59_999 }],
    ['seven maximum attempts', { deletionMaxAttempts: 7 }],
    ['nine maximum attempts', { deletionMaxAttempts: 9 }],
    ['a maximum delay above six hours', { deletionMaxDelayMs: 6 * 60 * 60 * 1_000 + 1 }],
    [
      'a maximum delay below the base delay',
      { deletionBaseDelayMs: 120_000, deletionMaxDelayMs: 60_000 },
    ],
  ])('rejects %s for dead-letter reconciliation', async (_label, override) => {
    await inputError(
      reconcileAfterSaleEvidenceDeadLetter(unusedClient, systemContext, {
        ...VALID_RECONCILIATION_DELETE_POLICY,
        ...override,
        messageId: MESSAGE_ID,
        scanFailedRetentionSeconds: 24 * 60 * 60,
      }),
    );
  });

  it('bounds scan dead-letter listing and validates its narrow reconciliation input', async () => {
    await inputError(
      listAfterSaleEvidenceScanDeadLetterCandidates(unusedClient, systemContext, {
        batchSize: 0,
      }),
    );
    await inputError(
      reconcileAfterSaleEvidenceScanDeadLetter(unusedClient, systemContext, {
        messageId: 'not-a-uuid',
        scanFailedRetentionSeconds: 24 * 60 * 60,
      }),
    );
    await inputError(
      reconcileAfterSaleEvidenceScanDeadLetter(unusedClient, systemContext, {
        messageId: MESSAGE_ID,
        scanFailedRetentionSeconds: 0,
      }),
    );
  });

  it('requires an exact non-empty set of unique object versions for final deletion', async () => {
    await inputError(
      completeAfterSaleEvidenceDeletion(unusedClient, systemContext, {
        evidenceId: EVIDENCE_ID,
        expectedVersion: 3,
        objects: [],
      }),
    );
    await inputError(
      completeAfterSaleEvidenceDeletion(unusedClient, systemContext, {
        evidenceId: EVIDENCE_ID,
        expectedVersion: 3,
        objects: [
          { expectedVersion: 1, id: OBJECT_ID },
          { expectedVersion: 2, id: OBJECT_ID },
        ],
      }),
    );
  });
});
