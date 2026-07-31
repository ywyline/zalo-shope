import { ConflictException } from '@nestjs/common';
import type { PrismaClient, StoreTransaction } from '@zalo-shop/database';
import type { StoreContext } from '@zalo-shop/domain';
import { describe, expect, it, vi } from 'vitest';

import type { AdminService } from '../admin/admin.service';
import type { AfterSalesRateLimiter } from '../after-sales/after-sales-rate-limiter';
import { AfterSalesPolicyService } from './after-sales-policy.service';

const STORE_ID = '10000000-0000-4000-8000-000000000001';
const ADMIN_ID = '20000000-0000-4000-8000-000000000001';

const context: StoreContext = {
  actor: { id: ADMIN_ID, type: 'admin' },
  correlationId: 'm63-policy-test',
  locale: 'vi',
  storeCode: 'beauty-local',
  storeId: STORE_ID,
};

function defaultAssignment() {
  const localizations = ['vi', 'zh', 'en'].map((locale) => ({
    buyer_instructions: `Instructions ${locale}`,
    locale,
    name: `Policy ${locale}`,
    summary: `Summary ${locale}`,
  }));
  const payload = {
    allowed_types: ['REFUND_ONLY'],
    category_id: null,
    condition_rules: {
      allowed_reason_codes: ['damaged'],
      evidence_required: true,
      evidence_required_reason_codes: ['damaged'],
      opened_package_exception_reason_codes: [],
    },
    damaged_exception: true,
    defect_exception: true,
    exchange_attribute_code: null,
    exchange_same_product_only: true,
    hygiene_restricted: false,
    localizations,
    product_ids: [],
    request_window_days: 30,
    return_shipping_payer: 'MERCHANT',
    return_window_days: 7,
    unopened_required: false,
    wrong_item_exception: true,
  };
  return { localizations, payload };
}

async function readyAssignment() {
  const { canonicalAfterSalePolicyHash } = await import('@zalo-shop/database');
  const { localizations, payload } = defaultAssignment();
  const policyId = '30000000-0000-4000-8000-000000000001';
  const policyVersionId = '31000000-0000-4000-8000-000000000001';
  return {
    assignment: {
      categoryId: null,
      policyId,
      policyVersionId,
      productId: null,
      targetType: 'STORE_DEFAULT',
    },
    assignmentId: '32000000-0000-4000-8000-000000000001',
    categoryId: null,
    id: '33000000-0000-4000-8000-000000000001',
    policy: {
      categoryId: null,
      code: 'beauty-default',
      currentVersionId: policyVersionId,
      status: 'ACTIVE',
    },
    policyId,
    policyVersion: {
      allowedTypes: ['REFUND_ONLY'],
      assignments: [
        {
          categoryId: null,
          id: '32000000-0000-4000-8000-000000000001',
          productId: null,
          targetType: 'STORE_DEFAULT',
        },
      ],
      conditionRules: payload.condition_rules,
      damagedException: true,
      defectException: true,
      effectiveAt: new Date(0),
      exchangeAttributeCode: null,
      exchangeSameProductOnly: true,
      hygieneRestricted: false,
      localizations: localizations.map((localization) => ({
        buyerInstructions: localization.buyer_instructions,
        locale: localization.locale,
        name: localization.name,
        summary: localization.summary,
      })),
      payload,
      payloadHash: canonicalAfterSalePolicyHash(payload),
      requestWindowDays: 30,
      returnShippingPayer: 'MERCHANT',
      returnWindowDays: 7,
      unopenedRequired: false,
      versionNumber: 1,
      wrongItemException: true,
    },
    policyVersionId,
    productId: null,
    targetType: 'STORE_DEFAULT',
  };
}

function serviceWith(transaction: StoreTransaction) {
  const authorize = vi.fn().mockResolvedValue(context);
  const authorizeSensitive = vi.fn().mockResolvedValue(context);
  const database = {
    $transaction: vi.fn((callback: (value: StoreTransaction) => unknown) => callback(transaction)),
  } as unknown as PrismaClient;
  const admin = {
    authorize,
    authorizeSensitive,
  } as unknown as AdminService;
  const consume = vi.fn().mockResolvedValue(undefined);
  const rateLimiter = { consume } as unknown as AfterSalesRateLimiter;
  return {
    authorize,
    authorizeSensitive,
    consume,
    service: new AfterSalesPolicyService(database, admin, rateLimiter),
  };
}

async function readyEnforcementFixture() {
  const assignment = await readyAssignment();
  const auditCreate = vi.fn().mockResolvedValue({});
  const idempotencyCreate = vi.fn().mockResolvedValue({});
  const idempotencyDelete = vi.fn().mockResolvedValue({ count: 0 });
  const createSetting = vi.fn(
    ({
      data,
    }: {
      data: {
        currentVersionId: string | null;
        defaultPolicyId: string | null;
        enforcePolicySnapshots: boolean;
        readinessCheckedAt: Date;
        readinessCheckedBy: string;
        readinessHash: string | null;
        readinessReadyAt: Date | null;
        storeId: string;
        updatedBy: string;
        version: number;
      };
    }) => ({
      ...data,
      createdAt: new Date('2026-07-29T00:00:00.000Z'),
      updatedAt: new Date('2026-07-29T00:00:00.000Z'),
    }),
  );
  const transaction = {
    $executeRaw: vi.fn(),
    $queryRaw: vi
      .fn()
      .mockResolvedValueOnce([{ current_time: new Date('2026-07-29T00:00:00.000Z') }])
      .mockResolvedValueOnce([{ enforce_policy_snapshots: false }]),
    afterSaleActivePolicyAssignment: { findMany: vi.fn().mockResolvedValue([assignment]) },
    auditLog: { create: auditCreate },
    idempotencyRecord: {
      create: idempotencyCreate,
      deleteMany: idempotencyDelete,
      findUnique: vi.fn().mockResolvedValue(null),
    },
    storeAfterSaleSetting: {
      create: createSetting,
      findUnique: vi.fn().mockResolvedValue(null),
    },
  } as unknown as StoreTransaction;
  return { auditCreate, idempotencyCreate, idempotencyDelete, transaction };
}

const enableInput = {
  confirmation_code: 'ENABLE_AFTER_SALE_POLICY_ENFORCEMENT' as const,
  enabled: true as const,
  expected_version: 1,
  reason: 'Enable the immutable after-sale snapshots for this ready store',
};

describe('AfterSalesPolicyService', () => {
  it('keeps a store NOT_READY without manufacturing a default policy', async () => {
    const transaction = {
      $executeRaw: vi.fn(),
      afterSaleActivePolicyAssignment: { findMany: vi.fn().mockResolvedValue([]) },
      storeAfterSaleSetting: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as StoreTransaction;
    const { authorize, consume, service } = serviceWith(transaction);

    await expect(
      service.getSettings({ accessToken: 'token', storeCode: 'beauty-local' }, STORE_ID),
    ).resolves.toEqual({
      current_version_number: null,
      default_policy_code: null,
      enforce_policy_snapshots: false,
      readiness_checked_at: null,
      readiness_state: 'NOT_READY',
      version: 1,
    });
    expect(authorize).toHaveBeenCalledWith(
      expect.anything(),
      STORE_ID,
      'store.after-sales.policy.read',
    );
    expect(consume).toHaveBeenCalledWith({
      access: 'READ',
      actorId: ADMIN_ID,
      actorType: 'ADMIN',
      storeId: STORE_ID,
    });
  });

  it('fails an enable command closed when the server-side preflight is not ready', async () => {
    const transaction = {
      $executeRaw: vi.fn(),
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ current_time: new Date('2026-07-29T00:00:00.000Z') }])
        .mockResolvedValueOnce([]),
      afterSaleActivePolicyAssignment: { findMany: vi.fn().mockResolvedValue([]) },
      idempotencyRecord: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        findUnique: vi.fn().mockResolvedValue(null),
      },
      storeAfterSaleSetting: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as StoreTransaction;
    const { authorizeSensitive, consume, service } = serviceWith(transaction);

    await expect(
      service.setEnforcement(
        { accessToken: 'token', storeCode: 'beauty-local' },
        STORE_ID,
        'm63-policy-enable-not-ready',
        {
          confirmation_code: 'ENABLE_AFTER_SALE_POLICY_ENFORCEMENT',
          enabled: true,
          expected_version: 1,
          reason: 'Enable only after the server-side readiness preflight succeeds',
        },
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(authorizeSensitive).toHaveBeenCalledWith(
      expect.anything(),
      STORE_ID,
      'store.after-sales.policy.enforce',
    );
    expect(consume).toHaveBeenCalledWith({
      access: 'WRITE',
      actorId: ADMIN_ID,
      actorType: 'ADMIN',
      storeId: STORE_ID,
    });
  });

  it('enables a ready store with versioning, hashed idempotency and an audit fact', async () => {
    const { auditCreate, idempotencyCreate, idempotencyDelete, transaction } =
      await readyEnforcementFixture();
    const { service } = serviceWith(transaction);

    const execution = await service.setEnforcement(
      { accessToken: 'token', storeCode: 'beauty-local' },
      STORE_ID,
      'm63-policy-enable-ready-store',
      enableInput,
    );

    expect(execution.replayed).toBe(false);
    expect(execution.body).toMatchObject({
      current_version_number: 1,
      default_policy_code: 'beauty-default',
      enforce_policy_snapshots: true,
      readiness_state: 'ENFORCED',
      version: 2,
    });
    expect(idempotencyCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        expiresAt: new Date('2026-07-30T00:00:00.000Z'),
        idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/u),
        operation: 'after-sale.policy.enforce',
      }),
    });
    expect(idempotencyDelete).toHaveBeenCalledWith({
      where: {
        expiresAt: { lte: new Date('2026-07-29T00:00:00.000Z') },
        idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/u),
        operation: 'after-sale.policy.enforce',
        storeId: STORE_ID,
      },
    });
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        afterData: expect.objectContaining({
          current_version_id: '31000000-0000-4000-8000-000000000001',
          default_policy_id: '30000000-0000-4000-8000-000000000001',
          readiness_checked_by: ADMIN_ID,
          readiness_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          store_id: STORE_ID,
          updated_by: ADMIN_ID,
        }),
      }),
    });
  });

  it('retries one transient serialization conflict before committing the command', async () => {
    const { transaction } = await readyEnforcementFixture();
    const transactionRunner = vi
      .fn()
      .mockRejectedValueOnce({ code: 'P2034' })
      .mockImplementationOnce((callback: (value: StoreTransaction) => unknown) =>
        callback(transaction),
      );
    const database = {
      $transaction: transactionRunner,
    } as unknown as PrismaClient;
    const admin = {
      authorizeSensitive: vi.fn().mockResolvedValue(context),
    } as unknown as AdminService;
    const service = new AfterSalesPolicyService(database, admin, {
      consume: vi.fn().mockResolvedValue(undefined),
    } as unknown as AfterSalesRateLimiter);

    await expect(
      service.setEnforcement(
        { accessToken: 'token', storeCode: 'beauty-local' },
        STORE_ID,
        'm63-policy-retry-once',
        enableInput,
      ),
    ).resolves.toMatchObject({ replayed: false });
    expect(transactionRunner).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['PostgreSQL serialization', { code: '40001' }],
    ['PostgreSQL deadlock', { code: '40P01' }],
    ['Prisma transaction timeout', { code: 'P2028' }],
    ['Prisma write conflict', { code: 'P2034' }],
    ['Prisma raw serialization', { code: 'P2010', meta: { code: '40001' } }],
  ])('maps an exhausted %s conflict to a stable API conflict', async (_label, databaseError) => {
    const transactionRunner = vi.fn().mockRejectedValue(databaseError);
    const database = { $transaction: transactionRunner } as unknown as PrismaClient;
    const admin = {
      authorizeSensitive: vi.fn().mockResolvedValue(context),
    } as unknown as AdminService;
    const service = new AfterSalesPolicyService(database, admin, {
      consume: vi.fn().mockResolvedValue(undefined),
    } as unknown as AfterSalesRateLimiter);

    await expect(
      service.setEnforcement(
        { accessToken: 'token', storeCode: 'beauty-local' },
        STORE_ID,
        'm63-policy-retry-exhausted',
        enableInput,
      ),
    ).rejects.toMatchObject({ message: 'AFTER_SALE_SETTINGS_CONCURRENT_CONFLICT' });
    expect(transactionRunner).toHaveBeenCalledTimes(2);
  });
});
