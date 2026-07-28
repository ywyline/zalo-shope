import type { StoreTransaction } from './index';
import { describe, expect, it, vi } from 'vitest';

import {
  AFTER_SALE_POLICY_SNAPSHOT_RUNTIME_CAPABILITY,
  assessAfterSalePolicyReadinessInTransaction,
  canonicalAfterSalePolicyHash,
  writeCheckoutAfterSalePolicySnapshotsInTransaction,
} from './after-sale-policy-primitives';

const CATEGORY_ROOT = '10000000-0000-4000-8000-000000000001';
const CATEGORY_LEAF = '10000000-0000-4000-8000-000000000002';
const CATEGORY_OTHER = '10000000-0000-4000-8000-000000000003';
const PRODUCT_ONE = '20000000-0000-4000-8000-000000000001';
const PRODUCT_TWO = '20000000-0000-4000-8000-000000000002';
const PRODUCT_THREE = '20000000-0000-4000-8000-000000000003';

function assignment(input: {
  categoryId?: string;
  id: string;
  policyCode: string;
  productId?: string;
  targetType: 'CATEGORY' | 'PRODUCT' | 'STORE_DEFAULT';
}) {
  const localizations = ['vi', 'zh', 'en'].map((locale) => ({
    buyer_instructions: `Instructions ${locale}`,
    locale,
    name: `Policy ${locale}`,
    summary: `Summary ${locale}`,
  }));
  const payload = {
    allowed_types: ['REFUND_ONLY'],
    category_id: input.categoryId ?? null,
    condition_rules: {
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
    product_ids: input.productId ? [input.productId] : [],
    request_window_days: 30,
    return_shipping_payer: 'MERCHANT',
    return_window_days: 7,
    unopened_required: false,
    wrong_item_exception: true,
  };
  const policyId = `policy-${input.id}`;
  const versionId = `version-${input.id}`;
  const assignmentId = `assignment-${input.id}`;
  return {
    assignment: {
      categoryId: input.categoryId ?? null,
      policyId,
      policyVersionId: versionId,
      productId: input.productId ?? null,
      targetType: input.targetType,
    },
    assignmentId,
    categoryId: input.categoryId ?? null,
    id: input.id,
    policy: {
      categoryId: input.categoryId ?? null,
      code: input.policyCode,
      currentVersionId: versionId,
      status: 'ACTIVE',
    },
    policyId,
    policyVersion: {
      allowedTypes: ['REFUND_ONLY'],
      assignments: [
        {
          categoryId: input.categoryId ?? null,
          id: assignmentId,
          productId: input.productId ?? null,
          targetType: input.targetType,
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
    policyVersionId: versionId,
    productId: input.productId ?? null,
    targetType: input.targetType,
  };
}

function enforcedSetting(assignments: ReturnType<typeof assignment>[]) {
  const defaults = assignments.find(({ targetType }) => targetType === 'STORE_DEFAULT')!;
  return {
    currentVersionId: defaults.policyVersionId,
    defaultPolicyId: defaults.policyId,
    enforcePolicySnapshots: true,
    readinessCheckedAt: new Date(0),
    readinessHash: canonicalAfterSalePolicyHash({
      assignments: assignments.map((item) => ({
        assignment_id: item.assignmentId,
        category_id: item.categoryId,
        policy_id: item.policyId,
        policy_version_id: item.policyVersionId,
        policy_version_payload_hash: item.policyVersion.payloadHash,
        product_id: item.productId,
        target_type: item.targetType,
      })),
      checkout_snapshot_runtime_capability: AFTER_SALE_POLICY_SNAPSHOT_RUNTIME_CAPABILITY,
    }),
    version: 2,
  };
}

describe('after-sale policy runtime primitives', () => {
  it('hashes canonical JSON independently of object key insertion order', () => {
    const left = canonicalAfterSalePolicyHash({
      allowed_types: ['REFUND_ONLY', 'RETURN_REFUND'],
      condition_rules: { evidence_required: true, reason_codes: ['damaged'] },
      request_window_days: 30,
    });
    const right = canonicalAfterSalePolicyHash({
      request_window_days: 30,
      condition_rules: { reason_codes: ['damaged'], evidence_required: true },
      allowed_types: ['REFUND_ONLY', 'RETURN_REFUND'],
    });

    expect(left).toBe(right);
    expect(left).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('does not collapse policy arrays because their order is part of the payload', () => {
    expect(canonicalAfterSalePolicyHash({ allowed_types: ['REFUND_ONLY', 'EXCHANGE'] })).not.toBe(
      canonicalAfterSalePolicyHash({ allowed_types: ['EXCHANGE', 'REFUND_ONLY'] }),
    );
  });

  it('writes one complete snapshot set with product, nearest category and default priority', async () => {
    const assignments = [
      assignment({ id: 'default', policyCode: 'default-policy', targetType: 'STORE_DEFAULT' }),
      assignment({
        categoryId: CATEGORY_ROOT,
        id: 'category',
        policyCode: 'category-policy',
        targetType: 'CATEGORY',
      }),
      assignment({
        id: 'product',
        policyCode: 'product-policy',
        productId: PRODUCT_ONE,
        targetType: 'PRODUCT',
      }),
    ];
    const created = vi.fn().mockResolvedValue({ count: 3 });
    const categoryParents = new Map([
      [CATEGORY_LEAF, CATEGORY_ROOT],
      [CATEGORY_OTHER, null],
      [CATEGORY_ROOT, null],
    ]);
    const transaction = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn().mockResolvedValue([{ enforce_policy_snapshots: true }]),
      afterSaleActivePolicyAssignment: {
        findMany: vi.fn().mockResolvedValue(assignments),
      },
      category: {
        findMany: vi
          .fn()
          .mockImplementation((query: { where: { id: { in: string[] } } }) =>
            query.where.id.in.map((id) => ({ id, parentId: categoryParents.get(id) ?? null })),
          ),
      },
      orderItemAfterSalePolicySnapshot: { createMany: created },
      storeAfterSaleSetting: {
        findUnique: vi.fn().mockResolvedValue(enforcedSetting(assignments)),
      },
    } as unknown as StoreTransaction;

    await expect(
      writeCheckoutAfterSalePolicySnapshotsInTransaction(transaction, {
        lines: [
          {
            categoryId: CATEGORY_LEAF,
            orderId: 'order',
            orderItemId: 'line-product',
            productId: PRODUCT_ONE,
          },
          {
            categoryId: CATEGORY_LEAF,
            orderId: 'order',
            orderItemId: 'line-category',
            productId: PRODUCT_TWO,
          },
          {
            categoryId: CATEGORY_OTHER,
            orderId: 'order',
            orderItemId: 'line-default',
            productId: PRODUCT_THREE,
          },
        ],
        storeId: 'store',
      }),
    ).resolves.toEqual({ enforced: true, written: 3 });

    const data = created.mock.calls[0]?.[0].data as Array<{ policyCode: string }>;
    expect(data.map((item) => item.policyCode)).toEqual([
      'product-policy',
      'category-policy',
      'default-policy',
    ]);
  });

  it('writes no snapshots while a ready store remains explicitly OFF', async () => {
    const assignments = [
      assignment({ id: 'default-off', policyCode: 'default-off', targetType: 'STORE_DEFAULT' }),
    ];
    const created = vi.fn();
    const transaction = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn().mockResolvedValue([{ enforce_policy_snapshots: false }]),
      afterSaleActivePolicyAssignment: { findMany: vi.fn().mockResolvedValue(assignments) },
      orderItemAfterSalePolicySnapshot: { createMany: created },
      storeAfterSaleSetting: {
        findUnique: vi.fn().mockResolvedValue({
          ...enforcedSetting(assignments),
          enforcePolicySnapshots: false,
        }),
      },
    } as unknown as StoreTransaction;

    await expect(
      writeCheckoutAfterSalePolicySnapshotsInTransaction(transaction, {
        lines: [
          {
            categoryId: CATEGORY_LEAF,
            orderId: 'order',
            orderItemId: 'line',
            productId: PRODUCT_ONE,
          },
        ],
        storeId: 'store',
      }),
    ).resolves.toEqual({ enforced: false, written: 0 });
    expect(created).not.toHaveBeenCalled();
  });

  it('does not report malformed immutable content as ready even when its hash is self-consistent', async () => {
    const invalid = assignment({
      id: 'invalid-payload',
      policyCode: 'invalid-payload',
      targetType: 'STORE_DEFAULT',
    });
    invalid.policyVersion.payload = { request_window_days: 30 } as never;
    invalid.policyVersion.payloadHash = canonicalAfterSalePolicyHash(invalid.policyVersion.payload);
    const transaction = {
      afterSaleActivePolicyAssignment: { findMany: vi.fn().mockResolvedValue([invalid]) },
      storeAfterSaleSetting: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as StoreTransaction;

    await expect(
      assessAfterSalePolicyReadinessInTransaction(transaction, 'store'),
    ).resolves.toMatchObject({ ready: false, readinessHash: null });
  });

  it('fails closed when enforcement is enabled without a complete active default', async () => {
    const transaction = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn().mockResolvedValue([{ enforce_policy_snapshots: true }]),
      afterSaleActivePolicyAssignment: { findMany: vi.fn().mockResolvedValue([]) },
      storeAfterSaleSetting: {
        findUnique: vi.fn().mockResolvedValue({
          currentVersionId: null,
          defaultPolicyId: null,
          enforcePolicySnapshots: true,
          readinessHash: null,
          version: 1,
        }),
      },
    } as unknown as StoreTransaction;

    await expect(
      writeCheckoutAfterSalePolicySnapshotsInTransaction(transaction, {
        lines: [
          {
            categoryId: 'category',
            orderId: 'order',
            orderItemId: 'line',
            productId: 'product',
          },
        ],
        storeId: 'store',
      }),
    ).rejects.toMatchObject({ code: 'AFTER_SALE_POLICY_NOT_READY' });
  });
});
