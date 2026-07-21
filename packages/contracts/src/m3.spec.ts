import { describe, expect, it } from 'vitest';

import {
  cartLocaleQuerySchema,
  cartSchema,
  deleteCartItemQuerySchema,
  setCartItemSchema,
  updateCartItemSchema,
} from './cart';
import { inventoryAdjustmentSchema, inventoryOperationKeySchema } from './inventory';
import {
  couponDraftUpdateSchema,
  couponInputSchema,
  couponStatusCommandSchema,
  pricingQuoteRequestSchema,
  promotionTargetLookupQuerySchema,
  promotionVersionInputSchema,
} from './pricing';
import { productSearchQuerySchema } from './search';

describe('M3 inventory contracts', () => {
  it('requires an auditable non-zero adjustment and a bounded operation key', () => {
    const base = {
      confirmation_code: 'ADJUST',
      delta: 5,
      expected_version: 1,
      note: null,
      reason_code: 'INITIAL_LOAD',
      sku_id: '11111111-1111-4111-8111-111111111111',
      warehouse_id: '22222222-2222-4222-8222-222222222222',
    };
    expect(inventoryAdjustmentSchema.parse(base).delta).toBe(5);
    expect(inventoryAdjustmentSchema.safeParse({ ...base, delta: 0 }).success).toBe(false);
    expect(inventoryOperationKeySchema.safeParse('adjustment:fixture:0001').success).toBe(true);
  });
});

describe('M3 search contracts', () => {
  it('rejects inverted price ranges, duplicate filters and unknown keys', () => {
    const base = { brand_codes: ['brand-a'], max_price_vnd: '100', min_price_vnd: '10', q: 'son' };
    expect(productSearchQuerySchema.parse(base).locale).toBe('vi');
    expect(productSearchQuerySchema.safeParse({ ...base, max_price_vnd: '9' }).success).toBe(false);
    expect(
      productSearchQuerySchema.safeParse({ ...base, brand_codes: ['brand-a', 'brand-a'] }).success,
    ).toBe(false);
    expect(productSearchQuerySchema.safeParse({ ...base, store_id: 'forbidden' }).success).toBe(
      false,
    );
  });
});

describe('M3 pricing contracts', () => {
  it('accepts only SKU codes and quantities in buyer quote requests', () => {
    const quote = { items: [{ quantity: 2, sku_code: 'lipstick-red' }] };
    expect(pricingQuoteRequestSchema.parse(quote).items).toHaveLength(1);
    expect(
      pricingQuoteRequestSchema.safeParse({
        ...quote,
        items: [{ quantity: 2, sku_code: 'lipstick-red', unit_price_vnd: 1 }],
      }).success,
    ).toBe(false);
    expect(
      pricingQuoteRequestSchema.safeParse({ items: [...quote.items, ...quote.items] }).success,
    ).toBe(false);
  });

  it('keeps shipping rules as eligibility-only until M4 supplies freight facts', () => {
    const base = {
      benefit: { method: 'FREE_SHIPPING_QUALIFICATION' },
      bucket: 'SHIPPING',
      ends_at: null,
      expected_promotion_version: 1,
      localizations: [{ locale: 'vi', name: 'Miễn phí vận chuyển' }],
      minimum_quantity: null,
      minimum_spend_vnd: 500_000,
      priority: 10,
      stackable_with: ['ITEM'],
      starts_at: '2026-07-20T00:00:00.000Z',
      targets: [{ target_id: null, target_type: 'STORE' }],
    };
    expect(promotionVersionInputSchema.safeParse(base).success).toBe(true);
    expect(
      promotionVersionInputSchema.safeParse({
        ...base,
        benefit: { method: 'FIXED_VND', value: 20_000 },
      }).success,
    ).toBe(false);
  });

  it('requires coupon status confirmations to match the requested transition', () => {
    expect(
      couponStatusCommandSchema.safeParse({
        confirmation_code: 'PAUSE',
        expected_version: 1,
        status: 'PAUSED',
      }).success,
    ).toBe(true);
    expect(
      couponStatusCommandSchema.safeParse({
        confirmation_code: 'END',
        expected_version: 1,
        status: 'PAUSED',
      }).success,
    ).toBe(false);
  });

  it('keeps coupon counters within PostgreSQL integer bounds', () => {
    const base = {
      code: 'welcome-2026',
      new_customer_only: false,
      per_member_claim_limit: 1,
      promotion_version_id: '11111111-1111-4111-8111-111111111111',
      total_claim_limit: 2_147_483_647,
    };
    expect(couponInputSchema.safeParse(base).success).toBe(true);
    expect(couponInputSchema.safeParse({ ...base, total_claim_limit: 2_147_483_648 }).success).toBe(
      false,
    );
    expect(
      couponDraftUpdateSchema.safeParse({
        expected_version: 1,
        total_claim_limit: 2_147_483_648,
      }).success,
    ).toBe(false);
  });

  it('bounds same-store promotion target lookups to typed catalogue resources', () => {
    expect(
      promotionTargetLookupQuerySchema.parse({ q: '  serum  ', target_type: 'PRODUCT' }),
    ).toEqual({ limit: 50, q: 'serum', target_type: 'PRODUCT' });
    expect(promotionTargetLookupQuerySchema.safeParse({ target_type: 'STORE' }).success).toBe(
      false,
    );
    expect(
      promotionTargetLookupQuerySchema.safeParse({ store_id: 'hidden', target_type: 'SKU' })
        .success,
    ).toBe(false);
  });
});

describe('M3 cart contracts', () => {
  it('defaults cart display locale to Vietnamese and accepts an explicit supported locale', () => {
    expect(cartLocaleQuerySchema.parse({})).toEqual({ locale: 'vi' });
    expect(deleteCartItemQuerySchema.parse({ expected_version: '2', locale: 'zh' })).toEqual({
      expected_version: 2,
      locale: 'zh',
    });
    expect(cartLocaleQuerySchema.safeParse({ locale: 'fr' }).success).toBe(false);
  });

  it('freezes bounded set-quantity semantics and optimistic updates', () => {
    expect(setCartItemSchema.parse({ quantity: 2 })).toEqual({ quantity: 2, selected: true });
    expect(setCartItemSchema.safeParse({ quantity: 100 }).success).toBe(false);
    expect(updateCartItemSchema.safeParse({ expected_version: 1 }).success).toBe(false);
    expect(updateCartItemSchema.safeParse({ expected_version: 1, selected: false }).success).toBe(
      true,
    );
  });

  it('accepts a server-priced cart while keeping the final order amount null', () => {
    const response = {
      blocking: false,
      id: '11111111-1111-4111-8111-111111111111',
      items: [
        {
          added_unit_price_vnd: 100_000,
          available_quantity: 5,
          current_subtotal_vnd: 180_000,
          current_unit_price_vnd: 90_000,
          id: '22222222-2222-4222-8222-222222222222',
          issues: [{ blocking: false, code: 'PRICE_CHANGED' }],
          quantity: 2,
          selected: true,
          sku_code: 'serum-rose',
          version: 2,
        },
      ],
      quote: {
        applied_rules: [],
        base_subtotal_vnd: 180_000,
        currency: 'VND',
        discount_vnd: 0,
        lines: [{}],
        merchandise_payable_vnd: 180_000,
        order_payable_vnd: null,
        quote_hash: 'a'.repeat(64),
        quoted_at: '2026-07-22T00:00:00.000Z',
        rejected_rules: [],
        shipping_qualification: { candidates: [], status: 'NOT_REQUESTED' },
      },
      version: 2,
    };
    expect(cartSchema.safeParse(response).success).toBe(true);
    expect(
      cartSchema.safeParse({ ...response, quote: { ...response.quote, order_payable_vnd: 1 } })
        .success,
    ).toBe(false);
  });
});
