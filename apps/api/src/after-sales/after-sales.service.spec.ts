import { createHash } from 'node:crypto';

import { ServiceUnavailableException } from '@nestjs/common';
import type { RuntimeConfig } from '@zalo-shop/config';
import type * as DatabaseModule from '@zalo-shop/database';
import { AfterSaleCommandDatabaseError, type PrismaClient } from '@zalo-shop/database';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminService } from '../admin/admin.service';
import type { AuthService } from '../auth/auth.service';
import type { AfterSalesCursor } from './after-sales-cursor';
import type { AfterSalesProjector } from './after-sales-projector';
import type { AfterSalesRateLimiter } from './after-sales-rate-limiter';

const commandMocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  createMember: vi.fn(),
  createMerchant: vi.fn(),
  recordReturnFact: vi.fn(),
  resolveReview: vi.fn(),
  review: vi.fn(),
  submitReturn: vi.fn(),
  withStoreTransaction: vi.fn(),
}));

vi.mock('@zalo-shop/database', async () => {
  const actual = await vi.importActual<typeof DatabaseModule>('@zalo-shop/database');
  return {
    ...actual,
    cancelMemberAfterSaleCommand: commandMocks.cancel,
    createMemberAfterSaleCommand: commandMocks.createMember,
    createMerchantRefundAfterSaleCommand: commandMocks.createMerchant,
    recordAfterSaleReturnFact: commandMocks.recordReturnFact,
    resolveAfterSaleReviewCommand: commandMocks.resolveReview,
    reviewAfterSaleCommand: commandMocks.review,
    submitMemberAfterSaleReturn: commandMocks.submitReturn,
    withStoreTransaction: commandMocks.withStoreTransaction,
  };
});

import { AfterSalesService } from './after-sales.service';

const STORE_ID = '10000000-0000-4000-8000-000000000001';
const MEMBER_ID = '20000000-0000-4000-8000-000000000001';
const ADMIN_ID = '30000000-0000-4000-8000-000000000001';
const ORDER_ID = '40000000-0000-4000-8000-000000000001';
const ORDER_ITEM_ID = '50000000-0000-4000-8000-000000000001';
const AFTER_SALE_ID = '60000000-0000-4000-8000-000000000001';
const MEMBER_SESSION_ID = '70000000-0000-4000-8000-000000000001';
const OPERATION_ID = '80000000-0000-4000-8000-000000000001';
const PUBLIC_CASE_NUMBER = 'ASC-60000000000040008000000000000001';
const ACCESS_SESSION_EXPIRES_AT = new Date('2099-08-01T12:30:00.000Z');
const ACCESS_TOKEN_EXPIRES_AT = new Date('2099-08-01T12:00:00.000Z');

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function acknowledgement(
  status:
    | 'APPROVED'
    | 'CANCELLED'
    | 'INSPECTION_PENDING'
    | 'PENDING_REVIEW'
    | 'REJECTED'
    | 'RETURN_IN_TRANSIT'
    | 'RETURN_PENDING'
    | 'REVIEW_REQUIRED',
  version: number,
) {
  return {
    id: AFTER_SALE_ID,
    public_number: PUBLIC_CASE_NUMBER,
    status,
    version,
  };
}

function commandResult(
  status:
    | 'APPROVED'
    | 'CANCELLED'
    | 'INSPECTION_PENDING'
    | 'PENDING_REVIEW'
    | 'REJECTED'
    | 'RETURN_IN_TRANSIT'
    | 'RETURN_PENDING'
    | 'REVIEW_REQUIRED',
  version: number,
  replayed = false,
) {
  return {
    afterSaleId: AFTER_SALE_ID,
    operationId: OPERATION_ID,
    publicCaseNumber: PUBLIC_CASE_NUMBER,
    replayed,
    status,
    version,
  };
}

function enabledConfig(): RuntimeConfig {
  return {
    AFTER_SALE_COMMANDS_ENABLED: true,
    AFTER_SALE_REVIEW_COMMANDS_ENABLED: true,
    AFTER_SALE_RETURN_COMMANDS_ENABLED: true,
    AFTER_SALE_EVIDENCE_DELETION_WORKER_ENABLED: true,
    AFTER_SALE_EVIDENCE_MEMBER_UPLOADS_ENABLED: true,
    AFTER_SALE_EVIDENCE_ORDINARY_ACCESS_TTL_SECONDS: 30 * 24 * 60 * 60,
    AFTER_SALE_EVIDENCE_PROTECTED_READS_ENABLED: true,
    AFTER_SALE_EVIDENCE_RETENTION_TTL_SECONDS: 90 * 24 * 60 * 60,
    EVIDENCE_SCANNER_PROVIDER: 'clamav',
    EVIDENCE_STORAGE_PROVIDER: 's3',
    NODE_ENV: 'test',
    PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    PII_HASH_KEY: Buffer.alloc(32, 8).toString('base64'),
  } as RuntimeConfig;
}

function commandOnlyConfig(): RuntimeConfig {
  return {
    AFTER_SALE_COMMANDS_ENABLED: true,
    AFTER_SALE_REVIEW_COMMANDS_ENABLED: true,
    AFTER_SALE_RETURN_COMMANDS_ENABLED: true,
    AFTER_SALE_EVIDENCE_DELETION_WORKER_ENABLED: false,
    AFTER_SALE_EVIDENCE_MEMBER_UPLOADS_ENABLED: false,
    AFTER_SALE_EVIDENCE_PROTECTED_READS_ENABLED: false,
    EVIDENCE_SCANNER_PROVIDER: 'disabled',
    EVIDENCE_STORAGE_PROVIDER: 'disabled',
    NODE_ENV: 'test',
    PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    PII_HASH_KEY: Buffer.alloc(32, 8).toString('base64'),
  } as RuntimeConfig;
}

function harness(config = enabledConfig()) {
  const database = {
    $queryRaw: vi
      .fn()
      .mockResolvedValue([{ code: 'beauty-local', default_locale: 'vi', id: STORE_ID }]),
  } as unknown as PrismaClient;
  const auth = {
    authenticateAccessToken: vi.fn().mockResolvedValue({
      accessSessionExpiresAt: ACCESS_SESSION_EXPIRES_AT,
      accessTokenExpiresAt: ACCESS_TOKEN_EXPIRES_AT,
      actorType: 'member',
      sessionId: MEMBER_SESSION_ID,
      storeId: STORE_ID,
      subjectId: MEMBER_ID,
    }),
  } as unknown as AuthService;
  const authorizeSensitive = vi.fn().mockResolvedValue({
    adminAuthorizationScope: 'STORE',
    actor: { id: ADMIN_ID, type: 'admin' },
    correlationId: 'admin-command-correlation',
    locale: 'vi',
    storeCode: 'beauty-local',
    storeId: STORE_ID,
  });
  const admin = { authorizeSensitive } as unknown as AdminService;
  const project = vi.fn();
  const projector = { project } as unknown as AfterSalesProjector;
  const consume = vi.fn();
  const rateLimiter = { consume } as unknown as AfterSalesRateLimiter;
  const service = new AfterSalesService(
    database,
    auth,
    admin,
    {} as AfterSalesCursor,
    projector,
    rateLimiter,
    config,
  );
  return { admin, auth, authorizeSensitive, consume, project, rateLimiter, service };
}

describe('AfterSalesService B3 commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commandMocks.cancel.mockResolvedValue(commandResult('CANCELLED', 2));
    commandMocks.createMember.mockResolvedValue(commandResult('PENDING_REVIEW', 1));
    commandMocks.createMerchant.mockResolvedValue(commandResult('PENDING_REVIEW', 1));
    commandMocks.resolveReview.mockResolvedValue(commandResult('APPROVED', 3));
    commandMocks.review.mockResolvedValue(commandResult('APPROVED', 2));
    commandMocks.submitReturn.mockResolvedValue(commandResult('RETURN_PENDING', 3));
    commandMocks.recordReturnFact.mockResolvedValue(commandResult('RETURN_IN_TRANSIT', 4));
  });

  it('creates a member case with stable detail digest, encrypted detail and all capabilities', async () => {
    const { consume, project, service } = harness();
    const description = 'The delivered item has a verified defect.';
    await expect(
      service.memberCreate({
        authorization: 'Bearer member-token',
        body: {
          description,
          evidence_ids: [],
          items: [{ order_item_id: ORDER_ITEM_ID, quantity: 1 }],
          order_id: ORDER_ID,
          reason_code: 'defective-item',
          type: 'RETURN_REFUND',
        },
        correlationId: 'member-command-correlation',
        idempotencyKey: 'member-create-idempotency-key',
        sourceIp: '127.0.0.1',
        storeCode: 'beauty-local',
      }),
    ).resolves.toEqual({ body: acknowledgement('PENDING_REVIEW', 1), replayed: false });

    expect(consume).toHaveBeenCalledWith({
      access: 'WRITE',
      actorId: MEMBER_ID,
      actorType: 'MEMBER',
      storeId: STORE_ID,
    });
    expect(commandMocks.createMember.mock.calls[0]?.[1]).toMatchObject({
      accessSessionExpiresAt: ACCESS_SESSION_EXPIRES_AT.toISOString(),
      accessSessionId: MEMBER_SESSION_ID,
      accessTokenExpiresAt: ACCESS_TOKEN_EXPIRES_AT.toISOString(),
    });
    const command = commandMocks.createMember.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(command).toMatchObject({
      evidenceCapabilities: {
        claimAvailable: true,
        deletionCompensationAvailable: true,
        malwareScanningAvailable: true,
        protectedReadAvailable: true,
        uploadValidationAvailable: true,
      },
      ordinaryAccessTtlSeconds: 30 * 24 * 60 * 60,
      reasonDetailHash: digest(description),
      retentionTtlSeconds: 90 * 24 * 60 * 60,
    });
    expect(command.reasonDetailCiphertext).not.toBe(description);
    expect(project).not.toHaveBeenCalled();
  });

  it('passes cancellation reason only to the primitive that canonicalizes and discards it', async () => {
    const { service } = harness(commandOnlyConfig());
    const reason = 'The request is no longer needed.';
    await expect(
      service.memberCancel({
        afterSaleId: AFTER_SALE_ID,
        authorization: 'Bearer member-token',
        body: { expected_version: 1, reason },
        correlationId: 'member-cancel-correlation',
        idempotencyKey: 'member-cancel-idempotency-key',
        sourceIp: '127.0.0.1',
        storeCode: 'beauty-local',
      }),
    ).resolves.toEqual({ body: acknowledgement('CANCELLED', 2), replayed: false });
    const command = commandMocks.cancel.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(command).toMatchObject({ reason });
  });

  it('requires recent MFA and the review permission for a merchant refund', async () => {
    const { authorizeSensitive, service } = harness(commandOnlyConfig());
    const description = 'Merchant initiated a refund after fulfillment review.';
    await service.adminCreateMerchantRefund({
      body: {
        description,
        items: [{ order_item_id: ORDER_ITEM_ID, quantity: 1 }],
        reason_code: 'merchant-refund',
        type: 'MERCHANT_REFUND',
      },
      headers: {
        accessToken: 'admin-token',
        correlationId: 'admin-command-correlation',
        sourceIp: '127.0.0.1',
        storeCode: 'beauty-local',
      },
      idempotencyKey: 'merchant-refund-idempotency-key',
      orderId: ORDER_ID,
      query: { store_id: STORE_ID },
    });
    expect(authorizeSensitive).toHaveBeenCalledWith(
      expect.anything(),
      STORE_ID,
      'store.after-sales.review',
    );
    expect(commandMocks.createMerchant.mock.calls[0]?.[2]).toMatchObject({
      reasonDetailHash: digest(description),
      sourceIp: '127.0.0.1',
    });
  });

  it('does not let generic platform cross access substitute for target-store review', async () => {
    const { authorizeSensitive, service } = harness(commandOnlyConfig());
    authorizeSensitive.mockResolvedValueOnce({
      accessReason: 'Operational review for order ABC-1234',
      adminAuthorizationScope: 'CROSS_STORE',
      actor: { id: ADMIN_ID, type: 'admin' },
      correlationId: 'admin-command-correlation',
      locale: 'vi',
      storeCode: 'beauty-local',
      storeId: STORE_ID,
    });

    await expect(
      service.adminCreateMerchantRefund({
        body: {
          description: 'Merchant initiated a refund after fulfillment review.',
          items: [{ order_item_id: ORDER_ITEM_ID, quantity: 1 }],
          reason_code: 'merchant-refund',
          type: 'MERCHANT_REFUND',
        },
        headers: {
          accessReason: 'Operational review for order ABC-1234',
          accessToken: 'admin-token',
          correlationId: 'admin-command-correlation',
          sourceIp: '127.0.0.1',
          storeCode: 'beauty-local',
        },
        idempotencyKey: 'merchant-cross-only-key',
        orderId: ORDER_ID,
        query: { store_id: STORE_ID },
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(commandMocks.createMerchant).not.toHaveBeenCalled();
  });

  it('maps a locked administrator authorization recheck failure to the public 403 boundary', async () => {
    commandMocks.createMerchant.mockRejectedValue(
      new AfterSaleCommandDatabaseError('AFTER_SALE_AUTHORIZATION_DENIED'),
    );
    const { service } = harness(commandOnlyConfig());
    await expect(
      service.adminCreateMerchantRefund({
        body: {
          description: 'Merchant initiated a refund after fulfillment review.',
          items: [{ order_item_id: ORDER_ITEM_ID, quantity: 1 }],
          reason_code: 'merchant-refund',
          type: 'MERCHANT_REFUND',
        },
        headers: {
          accessToken: 'admin-token',
          correlationId: 'admin-command-correlation',
          sourceIp: '127.0.0.1',
          storeCode: 'beauty-local',
        },
        idempotencyKey: 'merchant-authorization-denied-key',
        orderId: ORDER_ID,
        query: { store_id: STORE_ID },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('maps a locked member session recheck failure to the public 401 boundary', async () => {
    commandMocks.createMember.mockRejectedValue(
      new AfterSaleCommandDatabaseError('AFTER_SALE_AUTHORIZATION_DENIED'),
    );
    const { service } = harness(commandOnlyConfig());
    await expect(
      service.memberCreate({
        authorization: 'Bearer member-token',
        body: {
          description: 'The delivered item has a verified defect.',
          evidence_ids: [],
          items: [{ order_item_id: ORDER_ITEM_ID, quantity: 1 }],
          order_id: ORDER_ID,
          reason_code: 'defective-item',
          type: 'REFUND_ONLY',
        },
        correlationId: 'member-authorization-denied',
        idempotencyKey: 'member-authorization-denied-key',
        sourceIp: '127.0.0.1',
        storeCode: 'beauty-local',
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('allows evidence-free member commands while forwarding unavailable evidence capabilities', async () => {
    const { project, service } = harness(commandOnlyConfig());
    await expect(
      service.memberCreate({
        authorization: 'Bearer member-token',
        body: {
          description: 'The delivered item has a verified defect.',
          evidence_ids: [],
          items: [{ order_item_id: ORDER_ITEM_ID, quantity: 1 }],
          order_id: ORDER_ID,
          reason_code: 'defective-item',
          type: 'REFUND_ONLY',
        },
        correlationId: 'member-command-without-evidence',
        idempotencyKey: 'member-command-without-evidence-key',
        sourceIp: '127.0.0.1',
        storeCode: 'beauty-local',
      }),
    ).resolves.toEqual({ body: acknowledgement('PENDING_REVIEW', 1), replayed: false });

    expect(commandMocks.createMember.mock.calls[0]?.[2]).toMatchObject({
      evidenceCapabilities: {
        claimAvailable: false,
        deletionCompensationAvailable: false,
        malwareScanningAvailable: false,
        protectedReadAvailable: false,
        uploadValidationAvailable: false,
      },
    });
    expect(commandMocks.createMember.mock.calls[0]?.[2]).not.toHaveProperty(
      'ordinaryAccessTtlSeconds',
    );
    expect(commandMocks.createMember.mock.calls[0]?.[2]).not.toHaveProperty('retentionTtlSeconds');
    expect(project).not.toHaveBeenCalled();
  });

  it('lets the primitive fail closed when supplied evidence needs unavailable capabilities', async () => {
    commandMocks.createMember.mockRejectedValue(
      new AfterSaleCommandDatabaseError('AFTER_SALE_EVIDENCE_CAPABILITY_UNAVAILABLE'),
    );
    const { service } = harness(commandOnlyConfig());
    await expect(
      service.memberCreate({
        authorization: 'Bearer member-token',
        body: {
          description: 'The delivered item has a verified defect.',
          evidence_ids: ['80000000-0000-4000-8000-000000000001'],
          items: [{ order_item_id: ORDER_ITEM_ID, quantity: 1 }],
          order_id: ORDER_ID,
          reason_code: 'defective-item',
          type: 'REFUND_ONLY',
        },
        correlationId: 'member-command-with-evidence',
        idempotencyKey: 'member-command-with-evidence-key',
        sourceIp: '127.0.0.1',
        storeCode: 'beauty-local',
      }),
    ).rejects.toMatchObject({
      message: 'AFTER_SALE_EVIDENCE_CAPABILITY_UNAVAILABLE',
      status: 503,
    });
    expect(commandMocks.createMember).toHaveBeenCalledOnce();
  });

  it('fails closed before the primitive when commands are disabled', async () => {
    const config = enabledConfig();
    config.AFTER_SALE_COMMANDS_ENABLED = false;
    const { service } = harness(config);
    await expect(
      service.memberCreate({
        authorization: 'Bearer member-token',
        body: {
          description: 'The delivered item has a verified defect.',
          evidence_ids: [],
          items: [{ order_item_id: ORDER_ITEM_ID, quantity: 1 }],
          order_id: ORDER_ID,
          reason_code: 'defective-item',
          type: 'REFUND_ONLY',
        },
        correlationId: 'member-command-correlation',
        idempotencyKey: 'disabled-command-idempotency-key',
        sourceIp: '127.0.0.1',
        storeCode: 'beauty-local',
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(commandMocks.createMember).not.toHaveBeenCalled();
  });

  it('keeps the repository command implementation disabled in production', async () => {
    const config = commandOnlyConfig();
    config.NODE_ENV = 'production';
    const { service } = harness(config);
    await expect(
      service.memberCancel({
        afterSaleId: AFTER_SALE_ID,
        authorization: 'Bearer member-token',
        body: { expected_version: 1, reason: 'The request is no longer needed.' },
        correlationId: 'production-command-correlation',
        idempotencyKey: 'production-command-idempotency-key',
        sourceIp: '127.0.0.1',
        storeCode: 'beauty-local',
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(commandMocks.cancel).not.toHaveBeenCalled();
  });

  it('maps only stable primitive admission errors to the public 422 boundary', async () => {
    commandMocks.createMember.mockRejectedValue(
      new AfterSaleCommandDatabaseError('AFTER_SALE_PAYMENT_NOT_PROVEN'),
    );
    const { service } = harness();
    await expect(
      service.memberCreate({
        authorization: 'Bearer member-token',
        body: {
          description: 'The delivered item has a verified defect.',
          evidence_ids: [],
          items: [{ order_item_id: ORDER_ITEM_ID, quantity: 1 }],
          order_id: ORDER_ID,
          reason_code: 'defective-item',
          type: 'REFUND_ONLY',
        },
        correlationId: 'member-command-correlation',
        idempotencyKey: 'payment-error-idempotency-key',
        sourceIp: '127.0.0.1',
        storeCode: 'beauty-local',
      }),
    ).rejects.toMatchObject({
      message: 'AFTER_SALE_PAYMENT_NOT_PROVEN',
      status: 422,
    });
  });

  it('authorizes and acknowledges a direct target-store review command', async () => {
    const { authorizeSensitive, consume, service } = harness(commandOnlyConfig());
    const body = {
      confirmation_code: 'APPROVE_AFTER_SALE' as const,
      decision: 'APPROVE' as const,
      expected_version: 1,
      items: [{ approved_quantity: 1, order_item_id: ORDER_ITEM_ID }],
      reason: 'Approve the verified request after completing administrator review.',
    };
    await expect(
      service.adminReview({
        afterSaleId: AFTER_SALE_ID,
        body,
        headers: {
          accessToken: 'admin-token',
          correlationId: 'admin-review-correlation',
          sourceIp: '127.0.0.1',
          storeCode: 'beauty-local',
        },
        idempotencyKey: 'admin-review-idempotency-key',
        query: { store_id: STORE_ID },
      }),
    ).resolves.toEqual({ body: acknowledgement('APPROVED', 2), replayed: false });
    expect(authorizeSensitive).toHaveBeenCalledWith(
      expect.anything(),
      STORE_ID,
      'store.after-sales.review',
    );
    expect(consume).toHaveBeenCalledWith({
      access: 'WRITE',
      actorId: ADMIN_ID,
      actorType: 'ADMIN',
      storeId: STORE_ID,
    });
    expect(commandMocks.review).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ adminAuthorizationScope: 'STORE' }),
      expect.objectContaining({ afterSaleId: AFTER_SALE_ID, body, sourceIp: '127.0.0.1' }),
    );
  });

  it('encrypts legacy policy basis while hashing the normalized plaintext', async () => {
    const { service } = harness(commandOnlyConfig());
    const policyBasis = 'Legacy policy evidence retained for this specific order.';
    await expect(
      service.adminResolveReview({
        afterSaleId: AFTER_SALE_ID,
        body: {
          confirmation_code: 'RESOLVE_AFTER_SALE_REVIEW',
          decision: 'LEGACY_APPROVE',
          expected_version: 2,
          policy_basis: policyBasis,
          reason: 'Approve after validating the immutable legacy policy evidence.',
          return_shipping_payer: null,
          return_window_days: null,
        },
        headers: {
          accessToken: 'admin-token',
          correlationId: 'legacy-review-correlation',
          storeCode: 'beauty-local',
        },
        idempotencyKey: 'legacy-review-idempotency-key',
        query: { store_id: STORE_ID },
      }),
    ).resolves.toEqual({ body: acknowledgement('APPROVED', 3), replayed: false });
    const command = commandMocks.resolveReview.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(command).toMatchObject({ policyBasisHash: digest(policyBasis) });
    expect(command.policyBasisCiphertext).not.toBe(policyBasis);
    expect(String(command.policyBasisCiphertext)).not.toContain(policyBasis);
  });

  it('fails closed before review primitives when the independent switch is disabled', async () => {
    const config = commandOnlyConfig();
    config.AFTER_SALE_REVIEW_COMMANDS_ENABLED = false;
    const { service } = harness(config);
    await expect(
      service.adminReview({
        afterSaleId: AFTER_SALE_ID,
        body: {
          confirmation_code: 'REJECT_AFTER_SALE',
          decision: 'REJECT',
          expected_version: 1,
          reason: 'Reject after completing the required administrator review.',
        },
        headers: {
          accessToken: 'admin-token',
          correlationId: 'disabled-review-correlation',
          storeCode: 'beauty-local',
        },
        idempotencyKey: 'disabled-review-idempotency-key',
        query: { store_id: STORE_ID },
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(commandMocks.review).not.toHaveBeenCalled();
  });

  it('submits a member return with the independent switch and server HMAC key', async () => {
    const { consume, service } = harness(commandOnlyConfig());
    const body = {
      carrier_name: 'GHN',
      expected_version: 2,
      tracking_number: 'GHN-RETURN-000012345678',
    };
    await expect(
      service.memberSubmitReturn({
        afterSaleId: AFTER_SALE_ID,
        authorization: 'Bearer member-token',
        body,
        correlationId: 'member-return-correlation',
        idempotencyKey: 'member-return-idempotency-key',
        sourceIp: '127.0.0.1',
        storeCode: 'beauty-local',
      }),
    ).resolves.toEqual({ body: acknowledgement('RETURN_PENDING', 3), replayed: false });

    expect(consume).toHaveBeenCalledWith({
      access: 'WRITE',
      actorId: MEMBER_ID,
      actorType: 'MEMBER',
      storeId: STORE_ID,
    });
    expect(commandMocks.submitReturn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actor: { id: MEMBER_ID, type: 'member' } }),
      expect.objectContaining({
        afterSaleId: AFTER_SALE_ID,
        body,
        trackingHashKey: Buffer.alloc(32, 8).toString('base64'),
      }),
    );
  });

  it('requires direct review authorization before recording a trusted return fact', async () => {
    const { authorizeSensitive, consume, service } = harness(commandOnlyConfig());
    const body = {
      confirmation_code: 'RECORD_RETURN_LOGISTICS_FACT' as const,
      expected_return_shipment_version: 1,
      expected_version: 3,
      reason: 'Carrier portal confirms the return is now in transit.',
      status: 'IN_TRANSIT' as const,
    };
    await expect(
      service.adminRecordReturnFact({
        afterSaleId: AFTER_SALE_ID,
        body,
        headers: {
          accessToken: 'admin-token',
          correlationId: 'admin-return-fact-correlation',
          sourceIp: '127.0.0.1',
          storeCode: 'beauty-local',
        },
        idempotencyKey: 'admin-return-fact-idempotency-key',
        query: { store_id: STORE_ID },
      }),
    ).resolves.toEqual({ body: acknowledgement('RETURN_IN_TRANSIT', 4), replayed: false });

    expect(authorizeSensitive).toHaveBeenCalledWith(
      expect.anything(),
      STORE_ID,
      'store.after-sales.review',
    );
    expect(consume).toHaveBeenCalledWith({
      access: 'WRITE',
      actorId: ADMIN_ID,
      actorType: 'ADMIN',
      storeId: STORE_ID,
    });
    expect(commandMocks.recordReturnFact).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ adminAuthorizationScope: 'STORE' }),
      expect.objectContaining({ afterSaleId: AFTER_SALE_ID, body, sourceIp: '127.0.0.1' }),
    );
  });

  it('fails closed before return primitives when the B5 switch is disabled or production', async () => {
    const disabled = commandOnlyConfig();
    disabled.AFTER_SALE_RETURN_COMMANDS_ENABLED = false;
    await expect(
      harness(disabled).service.memberSubmitReturn({
        afterSaleId: AFTER_SALE_ID,
        authorization: 'Bearer member-token',
        body: { carrier_name: 'GHN', expected_version: 2, tracking_number: 'GHN-RETURN-1' },
        correlationId: 'disabled-member-return',
        idempotencyKey: 'disabled-member-return-key',
        sourceIp: '127.0.0.1',
        storeCode: 'beauty-local',
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    const production = commandOnlyConfig();
    production.NODE_ENV = 'production';
    await expect(
      harness(production).service.adminRecordReturnFact({
        afterSaleId: AFTER_SALE_ID,
        body: {
          confirmation_code: 'RECORD_RETURN_LOGISTICS_FACT',
          expected_return_shipment_version: 1,
          expected_version: 3,
          reason: 'Carrier portal confirms the return is now in transit.',
          status: 'IN_TRANSIT',
        },
        headers: {
          accessToken: 'admin-token',
          correlationId: 'production-return-fact',
          storeCode: 'beauty-local',
        },
        idempotencyKey: 'production-return-fact-key',
        query: { store_id: STORE_ID },
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(commandMocks.submitReturn).not.toHaveBeenCalled();
    expect(commandMocks.recordReturnFact).not.toHaveBeenCalled();
  });
});
