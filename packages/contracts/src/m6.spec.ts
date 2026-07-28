import { describe, expect, it } from 'vitest';

import {
  afterSaleCodRefundConfirmRequestSchema,
  afterSaleCreateRequestSchema,
  afterSaleAdminStoreQuerySchema,
  afterSaleEvidenceIdParamsSchema,
  afterSaleEvidenceUploadRequestSchema,
  afterSaleExchangeToRefundRequestSchema,
  afterSaleInspectionRequestSchema,
  afterSalePolicyDraftSchema,
  afterSalePolicyDisableSchema,
  afterSalePolicyVersionParamsSchema,
  afterSalePolicyVersionListQuerySchema,
  afterSaleReviewRequestSchema,
  afterSaleReviewResolveRequestSchema,
  afterSaleSettingsEnforcementSchema,
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

  it('binds review confirmation to the decision and inventory restoration to inspection', () => {
    expect(() =>
      afterSaleReviewRequestSchema.parse({
        confirmation_code: 'REJECT_AFTER_SALE',
        decision: 'APPROVE',
        expected_version: 1,
        reason: 'Approved after checking order and policy facts',
      }),
    ).toThrow();
    expect(
      afterSaleInspectionRequestSchema.parse({
        confirmation_code: 'INSPECT_RETURN',
        expected_version: 2,
        items: [
          {
            dispositions: [
              { disposition: 'RESTOCK_SELLABLE', quantity: 1 },
              { disposition: 'QUARANTINE', quantity: 1 },
            ],
            order_item_id: orderItemId,
            received_quantity: 2,
          },
        ],
        reason: 'Returned item requires quarantine inspection',
      }),
    ).toMatchObject({ items: [{ received_quantity: 2 }] });
    expect(() =>
      afterSaleInspectionRequestSchema.parse({
        confirmation_code: 'INSPECT_RETURN',
        expected_version: 2,
        items: [
          {
            dispositions: [{ disposition: 'RESTOCK_SELLABLE', quantity: 1 }],
            order_item_id: orderItemId,
            received_quantity: 2,
          },
        ],
        reason: 'Returned item requires quarantine inspection',
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
