import { ConflictException } from '@nestjs/common';
import type { AfterSalePolicyContent } from '@zalo-shop/contracts';
import {
  afterSalePolicyContentHash,
  canonicalizeAfterSalePolicyContent,
  type PrismaClient,
  type StoreTransaction,
} from '@zalo-shop/database';
import type { StoreContext } from '@zalo-shop/domain';
import { describe, expect, it } from 'vitest';

import type { AdminService } from '../admin/admin.service';
import type { AfterSalesCursor } from '../after-sales/after-sales-cursor';
import type { AfterSalesRateLimiter } from '../after-sales/after-sales-rate-limiter';
import { AfterSalesPolicyManagementService } from './after-sales-policy-management.service';

const STORE_ID = '10000000-0000-4000-8000-000000000001';
const POLICY_ID = '20000000-0000-4000-8000-000000000001';
const VERSION_ID = '30000000-0000-4000-8000-000000000001';
const PRODUCT_ID = '40000000-0000-4000-8000-000000000001';

function policyContent(): AfterSalePolicyContent {
  return canonicalizeAfterSalePolicyContent({
    allowed_types: ['RETURN_REFUND'],
    category_id: null,
    condition_rules: {
      allowed_reason_codes: ['damaged-item', 'wrong-item'],
      evidence_required: true,
      evidence_required_reason_codes: ['damaged-item'],
      opened_package_exception_reason_codes: ['wrong-item'],
    },
    damaged_exception: true,
    defect_exception: true,
    exchange_attribute_code: null,
    exchange_same_product_only: true,
    hygiene_restricted: false,
    localizations: [
      {
        buyer_instructions: 'Hướng dẫn người mua',
        locale: 'vi',
        name: 'Chính sách',
        summary: 'Tóm tắt',
      },
      {
        buyer_instructions: '买家说明',
        locale: 'zh',
        name: '政策',
        summary: '摘要',
      },
      {
        buyer_instructions: 'Buyer instructions',
        locale: 'en',
        name: 'Policy',
        summary: 'Summary',
      },
    ],
    product_ids: [PRODUCT_ID],
    request_window_days: 30,
    return_shipping_payer: 'MERCHANT',
    return_window_days: 7,
    unopened_required: false,
    wrong_item_exception: true,
  });
}

function versionRecord(content = policyContent()) {
  const publishedAt = new Date('2026-07-29T00:00:00.000Z');
  return {
    allowedTypes: content.allowed_types,
    assignments: [
      {
        categoryId: null,
        policyId: POLICY_ID,
        policyVersionId: VERSION_ID,
        productId: PRODUCT_ID,
        storeId: STORE_ID,
        targetType: 'PRODUCT' as const,
      },
      {
        categoryId: null,
        policyId: POLICY_ID,
        policyVersionId: VERSION_ID,
        productId: null,
        storeId: STORE_ID,
        targetType: 'STORE_DEFAULT' as const,
      },
    ],
    conditionRules: content.condition_rules,
    damagedException: content.damaged_exception,
    defectException: content.defect_exception,
    effectiveAt: publishedAt,
    exchangeAttributeCode: content.exchange_attribute_code,
    exchangeSameProductOnly: content.exchange_same_product_only,
    hygieneRestricted: content.hygiene_restricted,
    id: VERSION_ID,
    localizations: content.localizations.map((localization) => ({
      buyerInstructions: localization.buyer_instructions,
      locale: localization.locale,
      name: localization.name,
      storeId: STORE_ID,
      summary: localization.summary,
    })),
    payload: content,
    payloadHash: afterSalePolicyContentHash(content),
    policyId: POLICY_ID,
    publishedAt,
    requestWindowDays: content.request_window_days,
    returnShippingPayer: content.return_shipping_payer,
    returnWindowDays: content.return_window_days,
    storeId: STORE_ID,
    unopenedRequired: content.unopened_required,
    versionNumber: 1,
    wrongItemException: content.wrong_item_exception,
  };
}

function service(database = {} as PrismaClient) {
  return new AfterSalesPolicyManagementService(
    database,
    {} as AdminService,
    {} as AfterSalesCursor,
    {} as AfterSalesRateLimiter,
  );
}

type ManagementInternals = {
  command<T>(
    context: StoreContext,
    input: {
      code: string;
      execute: (transaction: StoreTransaction, now: Date) => Promise<T>;
      idempotencyKey: string;
      operation: string;
      parseStored: (value: unknown) => T;
      request: unknown;
    },
  ): Promise<{ body: T; replayed: boolean }>;
  mapCommandError(error: unknown): unknown;
  policyDetail(transaction: StoreTransaction, storeId: string, code: string): Promise<unknown>;
  version(code: string, input: ReturnType<typeof versionRecord>): unknown;
};

function internals(): ManagementInternals {
  return service() as unknown as ManagementInternals;
}

describe('AfterSalesPolicyManagementService integrity boundaries', () => {
  it('reads a committed idempotency winner after a unique race without rerunning the command', async () => {
    const context: StoreContext = {
      actor: { id: '50000000-0000-4000-8000-000000000001', type: 'admin' },
      correlationId: 'm63b2-policy-unique-retry',
      locale: 'vi',
      storeCode: 'beauty',
      storeId: STORE_ID,
    };
    const clock = new Date('2026-07-31T00:00:00.000Z');
    const uniqueError = (meta?: unknown) =>
      Object.assign(new Error('Test unique constraint conflict'), {
        code: 'P2002',
        ...(meta === undefined ? {} : { meta }),
      });
    let businessExecutions = 0;
    let requestHash: string | undefined;
    const commandTransaction = {
      $executeRaw: () => Promise.resolve(1),
      $queryRaw: () => Promise.resolve([{ current_time: clock }]),
      idempotencyRecord: {
        create: (input: { data: { requestHash: string } }) => {
          requestHash = input.data.requestHash;
          return Promise.reject(uniqueError());
        },
        deleteMany: () => Promise.resolve({ count: 0 }),
        findUnique: () => Promise.resolve(null),
      },
    } as unknown as StoreTransaction;
    const replayTransaction = {
      $executeRaw: () => Promise.resolve(1),
      $queryRaw: () => Promise.resolve([{ current_time: clock }]),
      idempotencyRecord: {
        findUnique: () =>
          Promise.resolve({
            expiresAt: new Date(clock.getTime() + 60_000),
            requestHash,
            response: { id: POLICY_ID },
          }),
      },
    } as unknown as StoreTransaction;
    const input = {
      code: 'default-policy',
      execute: () => {
        businessExecutions += 1;
        return Promise.resolve({ id: POLICY_ID });
      },
      idempotencyKey: 'm63b2-policy-unique-retry-0001',
      operation: 'after-sale.policy.draft.put',
      parseStored: (value: unknown) => value as { id: string },
      request: { expected_version: 0 },
    };

    let transactions = 0;
    const database = {
      $transaction: async (callback: (value: StoreTransaction) => Promise<unknown>) => {
        transactions += 1;
        return callback(transactions === 1 ? commandTransaction : replayTransaction);
      },
    } as unknown as PrismaClient;
    await expect(
      (service(database) as unknown as ManagementInternals).command(context, input),
    ).resolves.toEqual({ body: { id: POLICY_ID }, replayed: true });
    expect(transactions).toBe(2);
    expect(businessExecutions).toBe(1);

    transactions = 0;
    businessExecutions = 0;
    const missingWinnerTransaction = {
      ...replayTransaction,
      idempotencyRecord: { findUnique: () => Promise.resolve(null) },
    } as unknown as StoreTransaction;
    const missingWinnerDatabase = {
      $transaction: async (callback: (value: StoreTransaction) => Promise<unknown>) => {
        transactions += 1;
        if (transactions === 1) {
          return callback({
            ...commandTransaction,
            idempotencyRecord: {
              ...commandTransaction.idempotencyRecord,
              create: () =>
                Promise.reject(
                  uniqueError({
                    modelName: 'AfterSaleActivePolicyAssignment',
                    target: ['store_id'],
                  }),
                ),
            },
          } as unknown as StoreTransaction);
        }
        return callback(missingWinnerTransaction);
      },
    } as unknown as PrismaClient;
    await expect(
      (service(missingWinnerDatabase) as unknown as ManagementInternals).command(context, input),
    ).rejects.toMatchObject({ message: 'AFTER_SALE_POLICY_TARGET_CONFLICT' });
    expect(transactions).toBe(2);
    expect(businessExecutions).toBe(1);
  });

  it('maps only active target unique constraints to the stable target conflict', () => {
    const subject = internals();
    for (const meta of [
      { modelName: 'AfterSaleActivePolicyAssignment', target: ['store_id'] },
      {
        modelName: 'AfterSaleActivePolicyAssignment',
        target: ['store_id', 'category_id'],
      },
      { modelName: 'AfterSaleActivePolicyAssignment', target: ['store_id', 'product_id'] },
      { target: 'after_sale_active_policy_assignments_target_key' },
    ]) {
      const target = subject.mapCommandError({ code: 'P2002', meta });
      expect(target).toBeInstanceOf(ConflictException);
      expect(target).toMatchObject({ message: 'AFTER_SALE_POLICY_TARGET_CONFLICT' });
    }

    const generic = subject.mapCommandError({
      code: 'P2002',
      meta: { target: ['store_id', 'code'] },
    });
    expect(generic).toMatchObject({ message: 'AFTER_SALE_POLICY_CONCURRENT_CONFLICT' });
    expect(subject.mapCommandError({ code: 'P2002' })).toMatchObject({
      message: 'AFTER_SALE_POLICY_CONCURRENT_CONFLICT',
    });

    const transactionTimeout = { code: 'P2028' };
    expect(subject.mapCommandError(transactionTimeout)).toBe(transactionTimeout);
  });

  it('fails closed when immediate publication timestamps diverge', () => {
    const record = versionRecord();
    expect(() => internals().version('default-policy', record)).not.toThrow();
    expect(() =>
      internals().version('default-policy', {
        ...record,
        effectiveAt: new Date(record.publishedAt.getTime() + 1),
      }),
    ).toThrow('After-sale policy projection integrity failed');
  });

  it('rejects a non-canonical draft payload and an inconsistent draft head category', async () => {
    const content = policyContent();
    const baseRecord: {
      categoryId: string | null;
      code: string;
      currentVersion: null;
      draftHash: string;
      draftPayload: unknown;
      draftProducts: Array<{ productId: string }>;
      id: string;
      status: 'DRAFT';
      storeId: string;
      version: number;
    } = {
      categoryId: null,
      code: 'default-policy',
      currentVersion: null,
      draftHash: afterSalePolicyContentHash(content),
      draftPayload: content,
      draftProducts: [{ productId: PRODUCT_ID }],
      id: POLICY_ID,
      status: 'DRAFT' as const,
      storeId: STORE_ID,
      version: 1,
    };
    const transaction = (record: typeof baseRecord) =>
      ({
        afterSalePolicy: { findUnique: () => Promise.resolve(record) },
      }) as unknown as StoreTransaction;

    await expect(
      internals().policyDetail(transaction(baseRecord), STORE_ID, baseRecord.code),
    ).resolves.toMatchObject({ code: baseRecord.code, status: 'DRAFT' });

    let projectionError: unknown;
    try {
      await internals().policyDetail(
        transaction({
          ...baseRecord,
          draftPayload: {
            ...content,
            localizations: [...content.localizations].reverse(),
          },
        }),
        STORE_ID,
        baseRecord.code,
      );
    } catch (error) {
      projectionError = error;
    }
    expect(projectionError).toMatchObject({
      message: 'After-sale policy projection integrity failed',
    });
    expect(internals().mapCommandError(projectionError)).toMatchObject({
      message: 'AFTER_SALE_POLICY_SNAPSHOT_INVALID',
    });

    await expect(
      internals().policyDetail(
        transaction({ ...baseRecord, categoryId: PRODUCT_ID }),
        STORE_ID,
        baseRecord.code,
      ),
    ).rejects.toThrow('After-sale policy projection integrity failed');
  });
});
