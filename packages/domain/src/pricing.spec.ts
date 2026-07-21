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
const versionIds = {
  first: '00000000-0000-4000-8000-000000000001',
  second: '00000000-0000-4000-8000-000000000002',
  third: '00000000-0000-4000-8000-000000000003',
} as const;

function rule(overrides: Partial<PricingRule> = {}): PricingRule {
  return {
    bucket: 'ITEM',
    code: 'item-discount',
    method: 'PERCENTAGE_BPS',
    priority: 10,
    stackableWith: [],
    value: 1_000,
    version: 1,
    versionId: versionIds.first,
    ...overrides,
  };
}

describe('M3 integer VND calculations', () => {
  it('multiplies with BigInt intermediates and rejects unsafe or invalid totals', () => {
    expect(calculateVndSubtotal(249_000, 3)).toBe(747_000);
    expect(calculateVndSubtotal(Math.floor(Number.MAX_SAFE_INTEGER / 2), 2)).toBe(
      Number.MAX_SAFE_INTEGER - 1,
    );
    expect(() => calculateVndSubtotal(Number.MAX_SAFE_INTEGER, 2)).toThrowError(
      new PricingRuleError('AMOUNT_INVALID'),
    );
    expect(() => calculateVndSubtotal(249_000.5, 1)).toThrowError(
      new PricingRuleError('AMOUNT_INVALID'),
    );
    expect(() => calculateVndSubtotal(249_000, 0)).toThrowError(
      new PricingRuleError('QUANTITY_INVALID'),
    );
  });

  it('rounds percentage discounts down, caps them and never discounts below zero', () => {
    expect(evaluatePricingRule(99_999, 1, rule({ value: 1_500 }), now).amountVnd).toBe(14_999);
    expect(
      evaluatePricingRule(500_000, 1, rule({ maximumDiscountVnd: 25_000, value: 2_000 }), now)
        .amountVnd,
    ).toBe(25_000);
    expect(
      evaluatePricingRule(20_000, 1, rule({ method: 'FIXED_VND', value: 50_000 }), now).amountVnd,
    ).toBe(20_000);
  });

  it('preserves exact floor and bound invariants at safe-integer extremes', () => {
    const bases = [0, 1, 9_999, 100_000, Number.MAX_SAFE_INTEGER];
    const percentages = [1, 3_333, 9_999, 10_000];

    for (const basis of bases) {
      for (const percentage of percentages) {
        const evaluation = evaluatePricingRule(basis, 1, rule({ value: percentage }), now);
        const expected = Number((BigInt(basis) * BigInt(percentage)) / 10_000n);
        expect(evaluation.amountVnd).toBe(expected);
        expect(evaluation.amountVnd).toBeGreaterThanOrEqual(0);
        expect(evaluation.amountVnd).toBeLessThanOrEqual(basis);
      }
    }
  });
});

describe('M3 promotion eligibility and deterministic selection', () => {
  it('uses inclusive start, exclusive end, spend and quantity thresholds', () => {
    const timed = rule({
      endsAt: new Date('2026-07-20T13:00:00.000Z'),
      minimumQuantity: 2,
      minimumSpendVnd: 100_000,
      startsAt: new Date('2026-07-20T12:00:00.000Z'),
    });

    expect(evaluatePricingRule(100_000, 2, timed, now)).toMatchObject({ eligible: true });
    expect(
      evaluatePricingRule(100_000, 2, timed, new Date('2026-07-20T11:59:59.999Z')),
    ).toMatchObject({ eligible: false, reason: 'NOT_STARTED' });
    expect(evaluatePricingRule(99_999, 2, timed, now)).toMatchObject({
      eligible: false,
      reason: 'MINIMUM_NOT_MET',
    });
    expect(evaluatePricingRule(100_000, 1, timed, now)).toMatchObject({
      eligible: false,
      reason: 'MINIMUM_QUANTITY_NOT_MET',
    });
    expect(
      evaluatePricingRule(100_000, 2, timed, new Date('2026-07-20T12:59:59.999Z')),
    ).toMatchObject({ eligible: true });
    expect(evaluatePricingRule(100_000, 2, timed, timed.endsAt)).toMatchObject({
      eligible: false,
      reason: 'ENDED',
    });
  });

  it('selects by discount, priority, code, version and versionId in that order', () => {
    expect(
      selectBestPricingRule(
        100_000,
        1,
        [
          rule({ code: 'smaller', priority: 1, value: 1_000 }),
          rule({ code: 'larger', priority: 99, value: 2_000 }),
        ],
        now,
      )?.rule.code,
    ).toBe('larger');

    expect(
      selectBestPricingRule(
        100_000,
        1,
        [rule({ code: 'priority-one', priority: 1 }), rule({ code: 'priority-two', priority: 2 })],
        now,
      )?.rule.code,
    ).toBe('priority-one');

    expect(
      selectBestPricingRule(100_000, 1, [rule({ code: 'z-rule' }), rule({ code: 'a-rule' })], now)
        ?.rule.code,
    ).toBe('a-rule');

    expect(
      selectBestPricingRule(
        100_000,
        1,
        [rule({ version: 2 }), rule({ version: 1, versionId: versionIds.second })],
        now,
      )?.rule.version,
    ).toBe(1);

    expect(
      selectBestPricingRule(
        100_000,
        1,
        [rule({ versionId: versionIds.second }), rule({ versionId: versionIds.first })],
        now,
      )?.rule.versionId,
    ).toBe(versionIds.first);
  });

  it('ignores a larger rule below its quantity threshold and is input-order independent', () => {
    const candidates = [
      rule({ code: 'eligible', value: 1_000, versionId: versionIds.first }),
      rule({
        code: 'quantity-gated',
        minimumQuantity: 2,
        value: 3_000,
        versionId: versionIds.second,
      }),
    ];

    expect(selectBestPricingRule(100_000, 1, candidates, now)?.rule.code).toBe('eligible');
    expect(selectBestPricingRule(100_000, 2, [...candidates].reverse(), now)?.rule.code).toBe(
      'quantity-gated',
    );
  });

  it('rejects invalid identifiers, quantities, basis points, windows and declarations', () => {
    expect(() =>
      evaluatePricingRule(100_000, 1, rule({ versionId: 'unstable' }), now),
    ).toThrowError(new PricingRuleError('RULE_INVALID'));
    expect(() => evaluatePricingRule(100_000, 1, rule({ minimumQuantity: 0 }), now)).toThrowError(
      new PricingRuleError('RULE_INVALID'),
    );
    expect(() => evaluatePricingRule(100_000, 0, rule(), now)).toThrowError(
      new PricingRuleError('QUANTITY_INVALID'),
    );
    expect(() => evaluatePricingRule(100_000, 1, rule({ value: 10_001 }), now)).toThrowError(
      new PricingRuleError('RULE_INVALID'),
    );
    expect(() =>
      evaluatePricingRule(
        100_000,
        1,
        rule({
          endsAt: new Date('2026-07-20T11:00:00.000Z'),
          startsAt: new Date('2026-07-20T12:00:00.000Z'),
        }),
        now,
      ),
    ).toThrowError(new PricingRuleError('RULE_INVALID'));
    expect(() =>
      evaluatePricingRule(100_000, 1, rule({ stackableWith: ['ITEM'] }), now),
    ).toThrowError(new PricingRuleError('RULE_INVALID'));
  });
});

describe('M3 promotion stacking', () => {
  const itemRule = rule({
    stackableWith: ['ORDER', 'COUPON'],
    versionId: versionIds.first,
  });
  const couponRule = rule({
    bucket: 'COUPON',
    code: 'welcome-coupon',
    stackableWith: ['ITEM', 'ORDER'],
    value: 1_000,
    versionId: versionIds.second,
  });
  const orderRule = rule({
    bucket: 'ORDER',
    code: 'order-discount',
    method: 'FIXED_VND',
    stackableWith: ['ITEM', 'COUPON'],
    value: 10_000,
    versionId: versionIds.third,
  });

  it('requires reciprocal declarations in either call direction', () => {
    expect(canStackPricingRules(itemRule, orderRule)).toBe(true);
    expect(canStackPricingRules(orderRule, itemRule)).toBe(true);

    const unilateralOrder = { ...orderRule, stackableWith: [] };
    expect(canStackPricingRules(itemRule, unilateralOrder)).toBe(false);
    expect(canStackPricingRules(unilateralOrder, itemRule)).toBe(false);
  });

  it('always applies ITEM, COUPON, ORDER regardless of input order', () => {
    const expected = {
      applied: [
        {
          amountVnd: 10_000,
          basisVnd: 100_000,
          bucket: 'ITEM',
          code: 'item-discount',
          version: 1,
          versionId: versionIds.first,
        },
        {
          amountVnd: 9_000,
          basisVnd: 90_000,
          bucket: 'COUPON',
          code: 'welcome-coupon',
          version: 1,
          versionId: versionIds.second,
        },
        {
          amountVnd: 10_000,
          basisVnd: 81_000,
          bucket: 'ORDER',
          code: 'order-discount',
          version: 1,
          versionId: versionIds.third,
        },
      ],
      payableVnd: 71_000,
      totalDiscountVnd: 29_000,
    };
    const permutations = [
      [itemRule, couponRule, orderRule],
      [itemRule, orderRule, couponRule],
      [couponRule, itemRule, orderRule],
      [couponRule, orderRule, itemRule],
      [orderRule, itemRule, couponRule],
      [orderRule, couponRule, itemRule],
    ];

    for (const rules of permutations) {
      expect(applyPricingRuleSequence(100_000, 1, rules, now)).toEqual(expected);
    }
  });

  it('propagates quantity eligibility and rejects unilateral or duplicate buckets', () => {
    expect(
      applyPricingRuleSequence(100_000, 1, [rule({ minimumQuantity: 2, stackableWith: [] })], now),
    ).toEqual({ applied: [], payableVnd: 100_000, totalDiscountVnd: 0 });
    expect(() =>
      applyPricingRuleSequence(100_000, 1, [itemRule, { ...orderRule, stackableWith: [] }], now),
    ).toThrowError(new PricingRuleError('RULES_NOT_STACKABLE'));
    expect(() =>
      applyPricingRuleSequence(
        100_000,
        1,
        [itemRule, rule({ code: 'second-item', versionId: versionIds.second })],
        now,
      ),
    ).toThrowError(new PricingRuleError('RULE_BUCKET_DUPLICATED'));
  });
});

describe('M3 shipping promotion qualification', () => {
  it('returns qualification only and preserves time, amount and quantity checks', () => {
    const shippingRule = {
      code: 'free-ship',
      endsAt: new Date('2026-08-01T00:00:00.000Z'),
      minimumQuantity: 2,
      minimumSpendVnd: 500_000,
      priority: 1,
      stackableWith: ['ITEM', 'ORDER', 'COUPON'] as const,
      startsAt: new Date('2026-07-01T00:00:00.000Z'),
      version: 1,
      versionId: versionIds.first,
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
    expect(
      evaluateShippingQualification(500_000, 2, shippingRule, shippingRule.endsAt),
    ).toMatchObject({ eligible: false, reason: 'ENDED' });
  });

  it('rejects shipping rules in merchandise discount application', () => {
    expect(() =>
      applyPricingRuleSequence(500_000, 1, [
        {
          bucket: 'SHIPPING',
          code: 'invalid-shipping-discount',
          method: 'FIXED_VND',
          priority: 1,
          stackableWith: [],
          value: 20_000,
          version: 1,
          versionId: versionIds.first,
        } as unknown as PricingRule,
      ]),
    ).toThrowError(new PricingRuleError('SHIPPING_BASIS_REQUIRED'));
  });
});
