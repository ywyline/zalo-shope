import type { AfterSalePolicyContent } from '@zalo-shop/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  afterSalePolicyContentHash,
  canonicalizeAfterSalePolicyContent,
  publishAfterSalePolicyInTransaction,
  putAfterSalePolicyDraftInTransaction,
} from './after-sale-policy-management-primitives';
import type { StoreTransaction } from './index';

const CATEGORY_ID = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
const PRODUCT_A = 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB';
const PRODUCT_B = '11111111-1111-4111-8111-111111111111';

function policyContent(overrides: Partial<AfterSalePolicyContent> = {}): AfterSalePolicyContent {
  return {
    allowed_types: ['EXCHANGE', 'REFUND_ONLY'],
    category_id: null,
    condition_rules: {
      allowed_reason_codes: ['wrong-item', 'damaged', 'defect'],
      evidence_required: true,
      evidence_required_reason_codes: ['wrong-item', 'damaged'],
      opened_package_exception_reason_codes: ['wrong-item', 'defect'],
    },
    damaged_exception: true,
    defect_exception: true,
    exchange_attribute_code: 'size',
    exchange_same_product_only: true,
    hygiene_restricted: false,
    localizations: [
      {
        buyer_instructions: 'English instructions',
        locale: 'en',
        name: 'English policy',
        summary: 'English summary',
      },
      {
        buyer_instructions: 'Hướng dẫn tiếng Việt',
        locale: 'vi',
        name: 'Chính sách tiếng Việt',
        summary: 'Tóm tắt tiếng Việt',
      },
      {
        buyer_instructions: '中文说明',
        locale: 'zh',
        name: '中文政策',
        summary: '中文摘要',
      },
    ],
    product_ids: [],
    request_window_days: 30,
    return_shipping_payer: 'MERCHANT',
    return_window_days: 7,
    unopened_required: false,
    wrong_item_exception: true,
    ...overrides,
  };
}

describe('after-sale policy management primitives', () => {
  it('canonicalizes enum, locale, reason-code and lowercase UUID order before hashing', () => {
    const canonical = canonicalizeAfterSalePolicyContent(
      policyContent({
        category_id: CATEGORY_ID,
        product_ids: [PRODUCT_A, PRODUCT_B],
      }),
    );

    expect(canonical.allowed_types).toEqual(['REFUND_ONLY', 'EXCHANGE']);
    expect(canonical.category_id).toBe(CATEGORY_ID.toLowerCase());
    expect(canonical.product_ids).toEqual([PRODUCT_B.toLowerCase(), PRODUCT_A.toLowerCase()]);
    expect(canonical.localizations.map(({ locale }) => locale)).toEqual(['vi', 'zh', 'en']);
    expect(canonical.condition_rules.evidence_required_reason_codes).toEqual([
      'damaged',
      'wrong-item',
    ]);
    expect(canonical.condition_rules.allowed_reason_codes).toEqual([
      'damaged',
      'defect',
      'wrong-item',
    ]);
    expect(canonical.condition_rules.opened_package_exception_reason_codes).toEqual([
      'defect',
      'wrong-item',
    ]);

    expect(afterSalePolicyContentHash(canonical)).toBe(
      afterSalePolicyContentHash(
        policyContent({
          allowed_types: ['REFUND_ONLY', 'EXCHANGE'],
          category_id: CATEGORY_ID.toLowerCase(),
          condition_rules: {
            allowed_reason_codes: ['damaged', 'defect', 'wrong-item'],
            evidence_required: true,
            evidence_required_reason_codes: ['damaged', 'wrong-item'],
            opened_package_exception_reason_codes: ['defect', 'wrong-item'],
          },
          localizations: [
            policyContent().localizations[1]!,
            policyContent().localizations[2]!,
            policyContent().localizations[0]!,
          ],
          product_ids: [PRODUCT_B.toLowerCase(), PRODUCT_A.toLowerCase()],
        }),
      ),
    );
  });

  it('keeps an ACTIVE head category unchanged while replacing only its next draft', async () => {
    const existing = {
      categoryId: null,
      code: 'active-policy',
      currentVersionId: 'version-1',
      draftHash: 'old-hash',
      draftPayload: {},
      id: 'policy-1',
      status: 'ACTIVE',
      storeId: 'store-1',
      version: 4,
    };
    const updated = { ...existing, version: 5 };
    const update = vi.fn().mockResolvedValue(updated);
    const queryRaw = vi.fn().mockResolvedValue([{ id: existing.id }]);
    const transaction = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: queryRaw,
      afterSalePolicy: {
        findUnique: vi.fn().mockResolvedValue(existing),
        update,
      },
      afterSalePolicyDraftProduct: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      category: { count: vi.fn().mockResolvedValue(1) },
    } as unknown as StoreTransaction;

    await expect(
      putAfterSalePolicyDraftInTransaction(transaction, {
        actorId: 'admin-1',
        code: existing.code,
        content: policyContent({ category_id: CATEGORY_ID }),
        expectedVersion: 4,
        storeId: existing.storeId,
      }),
    ).resolves.toMatchObject({ before: existing, policy: updated });

    const data = update.mock.calls[0]?.[0].data as Record<string, unknown>;
    expect(data.categoryId).toBeUndefined();
    expect(data.draftPayload).toMatchObject({ category_id: CATEGORY_ID.toLowerCase() });
    expect(data.updatedBy).toBe('admin-1');
    expect(data.version).toEqual({ increment: 1 });
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect((queryRaw.mock.calls[0]?.[0] as TemplateStringsArray).join(' ')).toContain('FOR UPDATE');
    expect(queryRaw.mock.calls[0]?.slice(1)).toEqual([existing.storeId, existing.code]);
  });

  it('rejects a target outside the current store before creating a draft head', async () => {
    const findUnique = vi.fn();
    const transaction = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn().mockResolvedValue([]),
      afterSalePolicy: { findUnique },
      category: { count: vi.fn().mockResolvedValue(0) },
    } as unknown as StoreTransaction;

    await expect(
      putAfterSalePolicyDraftInTransaction(transaction, {
        actorId: 'admin-1',
        code: 'invalid-target',
        content: policyContent({ category_id: CATEGORY_ID }),
        expectedVersion: 0,
        storeId: 'store-1',
      }),
    ).rejects.toMatchObject({ code: 'AFTER_SALE_POLICY_TARGET_INVALID' });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('matches a nullable STORE_DEFAULT target exactly and rejects another active owner', async () => {
    const content = canonicalizeAfterSalePolicyContent(policyContent());
    const conflictLookup = vi.fn().mockResolvedValue([{ policyId: 'other-policy' }]);
    const transaction = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'policy-1' }]),
      afterSaleActivePolicyAssignment: { findMany: conflictLookup },
      afterSalePolicy: {
        findUnique: vi.fn().mockResolvedValue({
          code: 'default-policy',
          draftHash: afterSalePolicyContentHash(content),
          draftPayload: content,
          draftProducts: [],
          id: 'policy-1',
          status: 'DRAFT',
          storeId: 'store-1',
          version: 1,
        }),
      },
    } as unknown as StoreTransaction;

    await expect(
      publishAfterSalePolicyInTransaction(transaction, {
        actorId: 'admin-1',
        code: 'default-policy',
        expectedVersion: 1,
        now: new Date('2026-07-29T00:00:00.123Z'),
        storeId: 'store-1',
      }),
    ).rejects.toMatchObject({ code: 'AFTER_SALE_POLICY_TARGET_CONFLICT' });

    expect(conflictLookup).toHaveBeenCalledWith({
      select: { policyId: true },
      where: {
        OR: [{ categoryId: null, productId: null, targetType: 'STORE_DEFAULT' }],
        storeId: 'store-1',
      },
    });
  });

  it('fails closed before publication when stored draft arrays are not canonical', async () => {
    const content = canonicalizeAfterSalePolicyContent(policyContent());
    const conflictLookup = vi.fn();
    const transaction = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'policy-1' }]),
      afterSaleActivePolicyAssignment: { findMany: conflictLookup },
      afterSalePolicy: {
        findUnique: vi.fn().mockResolvedValue({
          code: 'default-policy',
          draftHash: afterSalePolicyContentHash(content),
          draftPayload: { ...content, localizations: [...content.localizations].reverse() },
          draftProducts: [],
          id: 'policy-1',
          status: 'DRAFT',
          storeId: 'store-1',
          version: 1,
        }),
      },
    } as unknown as StoreTransaction;

    await expect(
      publishAfterSalePolicyInTransaction(transaction, {
        actorId: 'admin-1',
        code: 'default-policy',
        expectedVersion: 1,
        now: new Date('2026-07-29T00:00:00.123Z'),
        storeId: 'store-1',
      }),
    ).rejects.toMatchObject({ code: 'AFTER_SALE_POLICY_SNAPSHOT_INVALID' });
    expect(conflictLookup).not.toHaveBeenCalled();
  });
});
