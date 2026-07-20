import { describe, expect, it } from 'vitest';

import {
  applyPricingRuleSequence,
  calculateVndSubtotal,
  canStackPricingRules,
  evaluatePricingRule,
  evaluateShippingQualification,
  PricingRuleError,
  selectBestPricingRule,
  type PricingRule,
} from './pricing';

const now = new Date('2026-07-20T12:00:00.000Z');

function rule(overrides: Partial<PricingRule> = {}): PricingRule {
  return {
    bucket: 'ITEM',
    code: 'item-discount',
    method: 'PERCENTAGE_BPS',
    priority: 10,
    stackableWith: [],
    value: 1_000,
    version: 1,
    ...overrides,
  };
}

describe('M3 integer VND calculations', () => {
  it('multiplies safe integer prices and quantities without binary floating point', () => {
    expect(calculateVndSubtotal(249_000, 3)).toBe(747_000);
    expect(() => calculateVndSubtotal(249_000.5, 1)).toThrowError(
      new PricingRuleError('AMOUNT_INVALID'),
    );
    expect(() => calculateVndSubtotal(249_000, 0)).toThrowError(
      new PricingRuleError('QUANTITY_INVALID'),
    );
  });

  it('rounds percentage discounts down, caps them and never discounts below zero', () => {
    expect(evaluatePricingRule(99_999, rule({ value: 1_500 }), now).amountVnd).toBe(14_999);
    expect(
      evaluatePricingRule(500_000, rule({ maximumDiscountVnd: 25_000, value: 2_000 }), now)
        .amountVnd,
    ).toBe(25_000);
    expect(
      evaluatePricingRule(20_000, rule({ method: 'FIXED_VND', value: 50_000 }), now).amountVnd,
    ).toBe(20_000);
  });
});

describe('M3 promotion eligibility and deterministic selection', () => {
  it('uses an inclusive start and exclusive end time window plus the current basis threshold', () => {
    const timed = rule({
      endsAt: new Date('2026-07-20T13:00:00.000Z'),
      minimumSpendVnd: 100_000,
      startsAt: new Date('2026-07-20T12:00:00.000Z'),
    });
    expect(evaluatePricingRule(100_000, timed, now)).toMatchObject({ eligible: true });
    expect(evaluatePricingRule(99_999, timed, now)).toMatchObject({
      eligible: false,
      reason: 'MINIMUM_NOT_MET',
    });
    expect(evaluatePricingRule(100_000, timed, timed.endsAt)).toMatchObject({
      eligible: false,
      reason: 'ENDED',
    });
  });

  it('selects the largest VND benefit then priority, code and version as stable tie-breakers', () => {
    const selected = selectBestPricingRule(
      100_000,
      [
        rule({ code: 'later-code', priority: 1, value: 1_000 }),
        rule({ code: 'larger', priority: 99, value: 2_000 }),
        rule({ code: 'earlier-code', priority: 1, value: 1_000 }),
      ],
      now,
    );
    expect(selected?.rule.code).toBe('larger');

    const tied = selectBestPricingRule(
      100_000,
      [rule({ code: 'z-rule', priority: 2 }), rule({ code: 'a-rule', priority: 2 })],
      now,
    );
    expect(tied?.rule.code).toBe('a-rule');
  });

  it('rejects invalid basis points, time windows and same-bucket stacking declarations', () => {
    expect(() => evaluatePricingRule(100_000, rule({ value: 10_001 }), now)).toThrowError(
      new PricingRuleError('RULE_INVALID'),
    );
    expect(() =>
      evaluatePricingRule(
        100_000,
        rule({
          endsAt: new Date('2026-07-20T11:00:00.000Z'),
          startsAt: new Date('2026-07-20T12:00:00.000Z'),
        }),
        now,
      ),
    ).toThrowError(new PricingRuleError('RULE_INVALID'));
    expect(() => evaluatePricingRule(100_000, rule({ stackableWith: ['ITEM'] }), now)).toThrowError(
      new PricingRuleError('RULE_INVALID'),
    );
  });
});

describe('M3 promotion stacking', () => {
  const itemRule = rule({ stackableWith: ['ORDER', 'COUPON'] });
  const orderRule = rule({
    bucket: 'ORDER',
    code: 'order-discount',
    method: 'FIXED_VND',
    stackableWith: ['ITEM', 'COUPON'],
    value: 10_000,
  });
  const couponRule = rule({
    bucket: 'COUPON',
    code: 'welcome-coupon',
    stackableWith: ['ITEM', 'ORDER'],
    value: 1_000,
  });

  it('requires reciprocal declarations and applies item, order then coupon to the remaining basis', () => {
    expect(canStackPricingRules(itemRule, orderRule)).toBe(true);
    expect(applyPricingRuleSequence(100_000, [couponRule, orderRule, itemRule], now)).toEqual({
      applied: [
        {
          amountVnd: 10_000,
          basisVnd: 100_000,
          bucket: 'ITEM',
          code: 'item-discount',
          version: 1,
        },
        {
          amountVnd: 10_000,
          basisVnd: 90_000,
          bucket: 'ORDER',
          code: 'order-discount',
          version: 1,
        },
        {
          amountVnd: 8_000,
          basisVnd: 80_000,
          bucket: 'COUPON',
          code: 'welcome-coupon',
          version: 1,
        },
      ],
      payableVnd: 72_000,
      totalDiscountVnd: 28_000,
    });
  });

  it('rejects unilateral stacking and more than one rule from the same bucket', () => {
    expect(() =>
      applyPricingRuleSequence(100_000, [itemRule, { ...orderRule, stackableWith: [] }], now),
    ).toThrowError(new PricingRuleError('RULES_NOT_STACKABLE'));
    expect(() =>
      applyPricingRuleSequence(100_000, [itemRule, rule({ code: 'second-item' })], now),
    ).toThrowError(new PricingRuleError('RULE_BUCKET_DUPLICATED'));
  });
});

describe('M3 shipping promotion qualification', () => {
  it('returns qualification only and never invents a freight discount before M4', () => {
    const shippingRule = {
      code: 'free-ship',
      minimumQuantity: 2,
      minimumSpendVnd: 500_000,
      priority: 1,
      stackableWith: ['ITEM', 'ORDER', 'COUPON'] as const,
      startsAt: new Date('2026-07-01T00:00:00.000Z'),
      version: 1,
    };
    expect(evaluateShippingQualification(500_000, 2, shippingRule, now)).toEqual({
      eligible: true,
      rule: shippingRule,
    });
    expect(evaluateShippingQualification(499_999, 2, shippingRule, now)).toMatchObject({
      eligible: false,
      reason: 'MINIMUM_NOT_MET',
    });
    expect(evaluateShippingQualification(500_000, 1, shippingRule, now)).toMatchObject({
      eligible: false,
      reason: 'MINIMUM_QUANTITY_NOT_MET',
    });
  });

  it('rejects shipping rules in merchandise discount application', () => {
    expect(() =>
      applyPricingRuleSequence(500_000, [
        {
          bucket: 'SHIPPING',
          code: 'invalid-shipping-discount',
          method: 'FIXED_VND',
          priority: 1,
          stackableWith: [],
          value: 20_000,
          version: 1,
        } as unknown as PricingRule,
      ]),
    ).toThrowError(new PricingRuleError('SHIPPING_BASIS_REQUIRED'));
  });
});
