import { describe, expect, it } from 'vitest';

import {
  AFTER_SALE_RATE_LIMIT_POLICY,
  adminAfterSaleListQuerySchema,
  afterSaleCodRefundConfirmRequestSchema,
  afterSaleCreateRequestSchema,
  afterSaleAdminStoreQuerySchema,
  afterSaleAdminReadQuerySchema,
  afterSaleCursorScopeSchema,
  afterSaleCursorSchema,
  afterSaleEvidenceIdParamsSchema,
  afterSaleEvidenceUploadRequestSchema,
  afterSaleExchangeToRefundRequestSchema,
  afterSaleListQuerySchema,
  afterSaleMemberReadQuerySchema,
  afterSalePolicyDraftSchema,
  afterSalePolicyDisableSchema,
  afterSalePageResponseSchema,
  afterSalePublicConflictCodeSchema,
  afterSalePublicNumberSchema,
  afterSaleReasonDetailResponseSchema,
  afterSalePolicyVersionParamsSchema,
  afterSalePolicyVersionListQuerySchema,
  afterSaleReviewRequestSchema,
  afterSaleReviewResolveRequestSchema,
  afterSaleSettingsEnforcementSchema,
  afterSaleStoreCodeHeaderSchema,
  afterSaleSettlementNumberParamsSchema,
  memberProductCodeParamsSchema,
  memberProductHistoryUpsertSchema,
  merchantAfterSaleCreateRequestSchema,
  privacyRequestCreateSchema,
  privacyRequestListQuerySchema,
  shareCreateRequestSchema,
  shareOutcomeRequestSchema,
} from './index';

const orderId = '11111111-1111-4111-8111-111111111111';
const orderItemId = '22222222-2222-4222-8222-222222222222';
const replacementSkuId = '33333333-3333-4333-8333-333333333333';

describe('M6 strict after-sale DTOs', () => {
  it('accepts buyer facts but rejects client-owned amount, state and store fields', () => {
    expect(
      afterSaleCreateRequestSchema.parse({
        description: 'The delivered item has a verified defect.',
        evidence_ids: [],
        items: [{ order_item_id: orderItemId, quantity: 1 }],
        order_id: orderId,
        reason_code: 'defective-item',
        type: 'RETURN_REFUND',
      }),
    ).toMatchObject({ order_id: orderId, type: 'RETURN_REFUND' });
    expect(() =>
      afterSaleCreateRequestSchema.parse({
        amount_vnd: 500_000,
        description: 'The delivered item has a verified defect.',
        evidence_ids: [],
        items: [{ order_item_id: orderItemId, quantity: 1 }],
        order_id: orderId,
        reason_code: 'defective-item',
        status: 'REFUNDED',
        store_id: orderId,
        type: 'RETURN_REFUND',
      }),
    ).toThrow();
  });

  it('validates combined route params and admin store scope without dropping fields', () => {
    const evidenceId = '44444444-4444-4444-8444-444444444444';
    expect(afterSaleEvidenceIdParamsSchema.parse({ afterSaleId: orderId, evidenceId })).toEqual({
      afterSaleId: orderId,
      evidenceId,
    });
    const settlementNumber = 'AST-01J9Z6Y4T8K2M7NQ';
    expect(
      afterSaleSettlementNumberParamsSchema.parse({ afterSaleId: orderId, settlementNumber }),
    ).toEqual({ afterSaleId: orderId, settlementNumber });
    expect(() =>
      afterSaleSettlementNumberParamsSchema.parse({
        afterSaleId: orderId,
        settlementNumber: evidenceId,
      }),
    ).toThrow();
    expect(
      afterSalePolicyVersionParamsSchema.parse({
        policyCode: 'hygiene-return',
        versionNumber: '2',
      }),
    ).toEqual({ policyCode: 'hygiene-return', versionNumber: 2 });
    expect(afterSaleAdminStoreQuerySchema.parse({ store_id: orderId })).toEqual({
      store_id: orderId,
    });
    expect(afterSalePolicyVersionListQuerySchema.parse({ store_id: orderId })).toMatchObject({
      limit: 20,
      store_id: orderId,
    });
    expect(() =>
      afterSalePolicyVersionListQuerySchema.parse({ status: 'ACTIVE', store_id: orderId }),
    ).toThrow();
    expect(() =>
      afterSaleEvidenceIdParamsSchema.parse({
        afterSaleId: orderId,
        evidenceId,
        store_id: orderId,
      }),
    ).toThrow();
  });

  it('requires a replacement SKU only for equal-scope exchange requests', () => {
    expect(
      afterSaleCreateRequestSchema.parse({
        description: 'I need the same garment in another size.',
        evidence_ids: [],
        items: [{ order_item_id: orderItemId, quantity: 1, replacement_sku_id: replacementSkuId }],
        order_id: orderId,
        reason_code: 'size-exchange',
        type: 'EXCHANGE',
      }),
    ).toMatchObject({ type: 'EXCHANGE' });
    expect(() =>
      afterSaleCreateRequestSchema.parse({
        description: 'I need the same garment in another size.',
        evidence_ids: [],
        items: [{ order_item_id: orderItemId, quantity: 1 }],
        order_id: orderId,
        reason_code: 'size-exchange',
        type: 'EXCHANGE',
      }),
    ).toThrow();
  });

  it('limits evidence types and rejects path-bearing filenames', () => {
    expect(
      afterSaleEvidenceUploadRequestSchema.parse({
        byte_size: 1_024,
        checksum_sha256: 'a'.repeat(64),
        filename: 'evidence.webp',
        mime_type: 'image/webp',
      }),
    ).toMatchObject({ mime_type: 'image/webp' });
    expect(() =>
      afterSaleEvidenceUploadRequestSchema.parse({
        byte_size: 1_024,
        checksum_sha256: 'a'.repeat(64),
        filename: '../evidence.svg',
        mime_type: 'image/svg+xml',
      }),
    ).toThrow();
  });

  it('binds review confirmation and a complete per-line quantity decision to approval', () => {
    expect(() =>
      afterSaleReviewRequestSchema.parse({
        confirmation_code: 'REJECT_AFTER_SALE',
        decision: 'APPROVE',
        expected_version: 1,
        items: [{ approved_quantity: 1, order_item_id: orderItemId }],
        reason: 'Approved after checking order and policy facts',
      }),
    ).toThrow();
    const approved = afterSaleReviewRequestSchema.parse({
      confirmation_code: 'APPROVE_AFTER_SALE',
      decision: 'APPROVE',
      expected_version: 2,
      items: [
        { approved_quantity: 1, order_item_id: orderItemId },
        {
          approved_quantity: 0,
          order_item_id: '44444444-4444-4444-8444-444444444444',
        },
      ],
      reason: 'Approved quantities follow the immutable order and policy facts',
    });
    expect(approved).toMatchObject({ decision: 'APPROVE' });
    if (approved.decision !== 'APPROVE') throw new Error('Expected approved review');
    expect(approved.items[0]).toMatchObject({ approved_quantity: 1 });
    expect(() =>
      afterSaleReviewRequestSchema.parse({
        confirmation_code: 'APPROVE_AFTER_SALE',
        decision: 'APPROVE',
        expected_version: 2,
        items: [{ approved_quantity: 0, order_item_id: orderItemId }],
        reason: 'An approval must approve at least one requested unit',
      }),
    ).toThrow();
    expect(() =>
      afterSaleReviewRequestSchema.parse({
        confirmation_code: 'REJECT_AFTER_SALE',
        decision: 'REJECT',
        expected_version: 2,
        items: [{ approved_quantity: 0, order_item_id: orderItemId }],
        reason: 'Rejected after checking immutable order and policy facts',
      }),
    ).toThrow();
  });

  it('freezes signed cursor scope, public numbers, locale fallback and rate-limit tiers', () => {
    const cursor = `c1_${'A'.repeat(20)}`;
    expect(afterSaleCursorSchema.parse(cursor)).toBe(cursor);
    expect(() => afterSaleCursorSchema.parse(`c2_${'A'.repeat(20)}`)).toThrow();
    expect(
      afterSaleCursorScopeSchema.parse({
        expires_at_epoch_seconds: 2_000_000_000,
        filters_hash: 'a'.repeat(64),
        resource: 'ADMIN_AFTER_SALES',
        sort_id: orderId,
        sort_key: '2026-07-28T12:00:00.000731Z',
        store_id: orderId,
        subject_id: replacementSkuId,
        subject_type: 'ADMIN',
        version: 1,
      }),
    ).toMatchObject({ resource: 'ADMIN_AFTER_SALES', version: 1 });
    expect(() =>
      afterSaleCursorScopeSchema.parse({
        expires_at_epoch_seconds: 2_000_000_000,
        filters_hash: 'a'.repeat(64),
        resource: 'MEMBER_AFTER_SALES',
        sort_id: orderId,
        sort_key: '2026-07-28T12:00:00.000731Z',
        store_id: orderId,
        subject_id: replacementSkuId,
        subject_type: 'ADMIN',
        version: 1,
      }),
    ).toThrow();
    expect(afterSalePublicNumberSchema.parse('ASC-01J9Z6Y4T8K2M7NQ')).toBe('ASC-01J9Z6Y4T8K2M7NQ');
    expect(() => afterSalePublicNumberSchema.parse('ASC-short')).toThrow();
    expect(afterSaleReasonDetailResponseSchema.parse(null)).toBeNull();
    expect(afterSaleListQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(adminAfterSaleListQuerySchema.parse({ store_id: orderId })).toEqual({
      limit: 20,
      store_id: orderId,
    });
    expect(adminAfterSaleListQuerySchema.parse({ locale: 'zh', store_id: orderId })).toEqual({
      limit: 20,
      locale: 'zh',
      store_id: orderId,
    });
    expect(afterSaleAdminReadQuerySchema.parse({ store_id: orderId })).toEqual({
      store_id: orderId,
    });
    expect(afterSaleAdminReadQuerySchema.parse({ locale: 'zh', store_id: orderId })).toEqual({
      locale: 'zh',
      store_id: orderId,
    });
    expect(afterSaleMemberReadQuerySchema.parse({})).toEqual({});
    expect(() => afterSaleMemberReadQuerySchema.parse({ unexpected: true })).toThrow();
    expect(afterSaleStoreCodeHeaderSchema.parse('beauty-local')).toBe('beauty-local');
    expect(() => afterSaleStoreCodeHeaderSchema.parse('Beauty-local')).toThrow();
    expect(() => afterSaleStoreCodeHeaderSchema.parse('a')).toThrow();
    expect(AFTER_SALE_RATE_LIMIT_POLICY).toEqual({
      admin_read: { limit: 120, scope: 'store_id:admin_id', window_seconds: 60 },
      admin_write: { limit: 30, scope: 'store_id:admin_id', window_seconds: 60 },
      member_read: { limit: 60, scope: 'store_id:member_id', window_seconds: 60 },
      member_write: { limit: 10, scope: 'store_id:member_id', window_seconds: 60 },
    });
    expect(afterSalePublicConflictCodeSchema.parse('AFTER_SALE_POLICY_MISMATCH')).toBe(
      'AFTER_SALE_POLICY_MISMATCH',
    );
    expect(() =>
      afterSalePublicConflictCodeSchema.parse('AFTER_SALE_INTERNAL_SQL_ERROR'),
    ).toThrow();
  });

  it('accepts only the B1 public after-sale response allowlist', () => {
    const afterSaleId = '55555555-5555-4555-8555-555555555555';
    const evidenceId = '66666666-6666-4666-8666-666666666666';
    const wireCase = {
      approved_refund_vnd: 120_000,
      created_at: '2026-07-28T12:00:00.000Z',
      currency: 'VND',
      evidence: [
        {
          access_expires_at: '2026-08-28T12:00:00.000Z',
          evidence_id: evidenceId,
          status: 'READY',
          version: 2,
        },
      ],
      evidence_count: 1,
      id: afterSaleId,
      items: [
        {
          accepted_quantity: 1,
          approved_quantity: 1,
          order_item_id: orderItemId,
          received_quantity: 1,
          rejected_quantity: 0,
          replacement_sku_id: null,
          requested_quantity: 1,
          restockable_quantity: 1,
          restored_quantity: 0,
        },
      ],
      order_id: orderId,
      policy_snapshot: {
        buyer_instructions: 'Return the item with its original packaging.',
        legacy_policy_review: false,
        name: 'Standard return policy',
        policy_code: 'standard-return',
        policy_version_number: 2,
        resolved_locale: 'en',
        summary: 'Returns are accepted for verified defects.',
      },
      public_number: 'ASC-01J9Z6Y4T8K2M7NQ',
      reason_code: 'defective-item',
      reason_detail: 'The delivered item has a verified defect.',
      return_deadline_at: '2026-08-04T12:00:00.000Z',
      return_shipments: [
        {
          carrier_name: 'GHN',
          masked_tracking_number: 'GH****90',
          status: 'IN_TRANSIT',
          submitted_at: '2026-07-29T12:00:00.000Z',
        },
      ],
      settlements: [
        {
          amount_vnd: 120_000,
          created_at: '2026-07-30T12:00:00.000Z',
          method: 'ONLINE_ORIGINAL',
          public_number: 'AST-01J9Z6Y4T8K2M7NQ',
          refund_public_number: 'RFD-01J9Z6Y4T8K2M7NQ',
          status: 'PROCESSING',
          updated_at: '2026-07-30T12:01:00.000Z',
        },
      ],
      status: 'RETURN_IN_TRANSIT',
      timeline: [
        {
          created_at: '2026-07-28T12:00:00.000Z',
          event: 'APPROVE',
          status: 'APPROVED',
        },
      ],
      type: 'RETURN_REFUND',
      updated_at: '2026-07-30T12:01:00.000Z',
      version: 4,
    };

    expect(
      afterSalePageResponseSchema.parse({
        items: [wireCase],
        next_cursor: `c1_${'A'.repeat(20)}`,
      }),
    ).toMatchObject({ items: [{ public_number: wireCase.public_number }] });
    expect(() =>
      afterSalePageResponseSchema.parse({
        items: [{ ...wireCase, transfer_evidence_ciphertext: 'must-never-leak' }],
        next_cursor: null,
      }),
    ).toThrow();
    expect(() =>
      afterSalePageResponseSchema.parse({
        items: [{ ...wireCase, reason_detail: null }],
        next_cursor: null,
      }),
    ).toThrow();
    expect(() =>
      afterSalePageResponseSchema.parse({
        items: [
          {
            ...wireCase,
            evidence: [
              {
                access_expires_at: null,
                evidence_id: evidenceId,
                status: 'QUARANTINED',
                version: 2,
              },
            ],
          },
        ],
        next_cursor: null,
      }),
    ).toThrow();
  });

  it('keeps legacy policy fields null and requires ready evidence to have an expiry', () => {
    const base = {
      approved_refund_vnd: 0,
      created_at: '2026-07-28T12:00:00.000Z',
      currency: 'VND',
      evidence: [],
      id: '55555555-5555-4555-8555-555555555555',
      items: [],
      order_id: orderId,
      policy_snapshot: {
        buyer_instructions: null,
        legacy_policy_review: true,
        name: null,
        policy_code: null,
        policy_version_number: null,
        resolved_locale: null,
        summary: null,
      },
      public_number: 'ASC-01J9Z6Y4T8K2M7NQ',
      reason_code: 'legacy-review',
      reason_detail: null,
      return_deadline_at: null,
      return_shipments: [],
      settlements: [],
      status: 'REVIEW_REQUIRED',
      timeline: [],
      type: 'REFUND_ONLY',
      updated_at: '2026-07-28T12:00:00.000Z',
      version: 1,
    };
    expect(afterSalePageResponseSchema.parse({ items: [base], next_cursor: null })).toMatchObject({
      items: [{ policy_snapshot: { legacy_policy_review: true } }],
    });
    expect(() =>
      afterSalePageResponseSchema.parse({
        items: [
          {
            ...base,
            policy_snapshot: { ...base.policy_snapshot, name: 'Leaked current policy' },
          },
        ],
        next_cursor: null,
      }),
    ).toThrow();
  });

  it('freezes complete policy conditions without duplicating the path policy code', () => {
    expect(
      afterSalePolicyDraftSchema.parse({
        allowed_types: ['RETURN_REFUND', 'EXCHANGE'],
        category_id: null,
        condition_rules: {
          evidence_required: true,
          evidence_required_reason_codes: ['damaged-item'],
          opened_package_exception_reason_codes: ['defective-item'],
        },
        damaged_exception: true,
        defect_exception: true,
        exchange_attribute_code: 'size',
        exchange_same_product_only: true,
        expected_version: 0,
        hygiene_restricted: false,
        localizations: ['vi', 'zh', 'en'].map((locale) => ({
          buyer_instructions: `Instructions in ${locale}`,
          locale,
          name: `Policy ${locale}`,
          summary: `Summary ${locale}`,
        })),
        product_ids: [],
        request_window_days: 7,
        return_shipping_payer: 'CONDITIONAL',
        return_window_days: 14,
        unopened_required: false,
        wrong_item_exception: true,
      }),
    ).toMatchObject({ expected_version: 0 });
    expect(() =>
      afterSalePolicyDraftSchema.parse({
        allowed_types: ['EXCHANGE'],
        category_id: null,
        condition_rules: {
          evidence_required: false,
          evidence_required_reason_codes: [],
          opened_package_exception_reason_codes: [],
        },
        damaged_exception: false,
        defect_exception: false,
        exchange_attribute_code: null,
        exchange_same_product_only: true,
        expected_version: 0,
        hygiene_restricted: false,
        localizations: ['vi', 'zh', 'en'].map((locale) => ({
          buyer_instructions: `Instructions in ${locale}`,
          locale,
          name: `Policy ${locale}`,
          summary: `Summary ${locale}`,
        })),
        product_ids: [],
        request_window_days: 7,
        return_shipping_payer: 'BUYER',
        return_window_days: 14,
        unopened_required: false,
        wrong_item_exception: false,
      }),
    ).toThrow();
  });

  it('binds policy disable and enforcement confirmation to the requested action', () => {
    expect(
      afterSalePolicyDisableSchema.parse({
        confirmation_code: 'DISABLE_AFTER_SALE_POLICY',
        expected_version: 3,
        reason: 'Policy is superseded by a reviewed replacement version',
      }),
    ).toMatchObject({ expected_version: 3 });
    expect(() =>
      afterSaleSettingsEnforcementSchema.parse({
        confirmation_code: 'DISABLE_AFTER_SALE_POLICY_ENFORCEMENT',
        enabled: true,
        expected_version: 1,
        reason: 'All current-store policy readiness checks passed',
      }),
    ).toThrow();
  });

  it('keeps merchant refunds, review resolution and COD confirmation server controlled', () => {
    expect(
      merchantAfterSaleCreateRequestSchema.parse({
        description: 'Merchant approved a proactive refund after fulfillment review.',
        items: [{ order_item_id: orderItemId, quantity: 1 }],
        reason_code: 'merchant-refund',
        type: 'MERCHANT_REFUND',
      }),
    ).toMatchObject({ type: 'MERCHANT_REFUND' });
    expect(() =>
      merchantAfterSaleCreateRequestSchema.parse({
        amount_vnd: 100_000,
        description: 'Merchant approved a proactive refund after fulfillment review.',
        items: [{ order_item_id: orderItemId, quantity: 1 }],
        reason_code: 'merchant-refund',
        type: 'MERCHANT_REFUND',
      }),
    ).toThrow();
    expect(
      afterSaleReviewResolveRequestSchema.parse({
        confirmation_code: 'RESOLVE_AFTER_SALE_REVIEW',
        decision: 'RESUME',
        expected_version: 4,
        reason: 'Provider truth and case facts were independently reconciled',
      }),
    ).toMatchObject({ decision: 'RESUME' });
    expect(() =>
      afterSaleReviewResolveRequestSchema.parse({
        confirmation_code: 'RESOLVE_AFTER_SALE_REVIEW',
        decision: 'RESUME',
        expected_version: 4,
        reason: 'Provider truth and case facts were independently reconciled',
        target_status: 'REFUNDED',
      }),
    ).toThrow();
    expect(() =>
      afterSaleReviewResolveRequestSchema.parse({
        confirmation_code: 'RESOLVE_AFTER_SALE_REVIEW',
        decision: 'LEGACY_APPROVE',
        expected_version: 1,
        policy_basis: 'Archived store policy and immutable order evidence were reviewed',
        reason: 'The historical order predates enforceable policy snapshots',
        return_shipping_payer: null,
        return_window_days: 14,
      }),
    ).toThrow();
    expect(
      afterSaleReviewResolveRequestSchema.parse({
        confirmation_code: 'RESOLVE_AFTER_SALE_REVIEW',
        decision: 'LEGACY_REJECT',
        expected_version: 1,
        policy_basis: 'Archived store policy and immutable order evidence were reviewed',
        reason: 'The historical order is not eligible under the reviewed archival terms',
      }),
    ).toMatchObject({ decision: 'LEGACY_REJECT' });
    expect(() =>
      afterSaleReviewResolveRequestSchema.parse({
        confirmation_code: 'RESOLVE_AFTER_SALE_REVIEW',
        decision: 'LEGACY_REJECT',
        expected_version: 1,
        policy_basis: 'Archived store policy and immutable order evidence were reviewed',
        reason: 'The historical order is not eligible under the reviewed archival terms',
        return_shipping_payer: 'BUYER',
      }),
    ).toThrow();
    expect(
      afterSaleReviewResolveRequestSchema.parse({
        confirmation_code: 'RESOLVE_AFTER_SALE_REVIEW',
        decision: 'LEGACY_APPROVE',
        expected_version: 1,
        policy_basis: 'Archived store policy and immutable order evidence were reviewed',
        reason: 'The historical order predates enforceable policy snapshots',
        return_shipping_payer: 'MERCHANT',
        return_window_days: 14,
      }),
    ).toMatchObject({ decision: 'LEGACY_APPROVE' });
    expect(() =>
      afterSaleReviewResolveRequestSchema.parse({
        confirmation_code: 'RESOLVE_AFTER_SALE_REVIEW',
        decision: 'LEGACY_APPROVE',
        expected_version: 1,
        reason: 'The historical order predates enforceable policy snapshots',
        return_shipping_payer: 'MERCHANT',
        return_window_days: 14,
      }),
    ).toThrow();
    expect(() =>
      afterSaleCodRefundConfirmRequestSchema.parse({
        amount_vnd: 100_000,
        confirmation_code: 'CONFIRM_COD_REFUND',
        expected_settlement_version: 2,
        expected_version: 4,
        payout_reference: 'client-controlled',
        reason: 'Transfer proof independently verified by finance reviewer',
      }),
    ).toThrow();
    expect(
      afterSaleExchangeToRefundRequestSchema.parse({
        confirmation_code: 'CONVERT_EXCHANGE_TO_REFUND',
        expected_version: 5,
        reason: 'No equivalent replacement remains after the returned item passed inspection',
      }),
    ).toMatchObject({ expected_version: 5 });
  });
});

describe('M6 strict member and share DTOs', () => {
  it('uses safe product codes and an empty idempotent history touch body', () => {
    expect(memberProductCodeParamsSchema.parse({ productCode: 'ao-khoac-01' })).toEqual({
      productCode: 'ao-khoac-01',
    });
    expect(memberProductHistoryUpsertSchema.parse({})).toEqual({});
    expect(() => memberProductHistoryUpsertSchema.parse({ member_id: orderId })).toThrow();
    expect(() => memberProductCodeParamsSchema.parse({ productCode: '../fashion' })).toThrow();
    expect(() => memberProductCodeParamsSchema.parse({ productCode: 'Ao-Khoac-01' })).toThrow();
    expect(() => privacyRequestListQuerySchema.parse({ cursor: orderId })).toThrow();
    expect(() => privacyRequestListQuerySchema.parse({ locale: 'vi' })).toThrow();
  });

  it('creates a real privacy intake fact without claiming fulfillment', () => {
    expect(
      privacyRequestCreateSchema.parse({
        confirmation_code: 'SUBMIT_DATA_ACCESS_REQUEST',
        description: 'Please provide access to my personal data held by this store.',
        request_type: 'ACCESS',
      }),
    ).toMatchObject({ request_type: 'ACCESS' });
    expect(() =>
      privacyRequestCreateSchema.parse({
        confirmation_code: 'SUBMIT_DATA_ACCESS_REQUEST',
        description: 'Please close and delete my account data where legally permitted.',
        request_type: 'ACCOUNT_CLOSURE',
      }),
    ).toThrow();
  });

  it('accepts only server-resolvable share targets without arbitrary content or URLs', () => {
    expect(
      shareCreateRequestSchema.parse({
        attribution_token: 'Abcdefghijklmnopqrst',
        locale: 'vi',
        source: 'PRODUCT_DETAIL',
        target_code: 'serum-01',
        target_type: 'PRODUCT',
      }),
    ).toMatchObject({ target_type: 'PRODUCT' });
    expect(() =>
      shareCreateRequestSchema.parse({
        image_url: 'https://attacker.example/a.png',
        locale: 'vi',
        redirect_url: 'https://attacker.example',
        source: 'PRODUCT_DETAIL',
        target_code: 'serum-01',
        target_type: 'PRODUCT',
        title: 'Client supplied',
      }),
    ).toThrow();
    expect(() =>
      shareCreateRequestSchema.parse({
        campaign_code: 'fake-campaign',
        locale: 'vi',
        source: 'PRODUCT_DETAIL',
        target_code: 'serum-01',
        target_type: 'PRODUCT',
      }),
    ).toThrow();
    expect(() =>
      shareCreateRequestSchema.parse({
        locale: 'vi',
        source: 'STORE_HOME',
        target_code: 'beauty',
        target_type: 'STORE',
      }),
    ).toThrow();
    expect(
      shareOutcomeRequestSchema.parse({
        interaction_token: 'a'.repeat(32),
        outcome: 'CANCELLED',
      }),
    ).toMatchObject({ outcome: 'CANCELLED' });
    expect(() =>
      shareOutcomeRequestSchema.parse({
        interaction_token: 'a'.repeat(32),
        outcome: 'OPENED',
      }),
    ).toThrow();
  });
});
