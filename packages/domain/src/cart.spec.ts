import { describe, expect, it } from 'vitest';

import { assessCartLine, CartRuleError } from './cart';

describe('M3 cart line assessment', () => {
  it('blocks unavailable products, disabled SKUs and insufficient stock', () => {
    expect(
      assessCartLine({
        addedUnitPriceVnd: 100_000,
        availableStock: 1,
        currentUnitPriceVnd: 100_000,
        productPublished: false,
        quantity: 2,
        skuEnabled: false,
      }),
    ).toEqual({
      blocking: true,
      currentSubtotalVnd: 200_000,
      issues: [
        { blocking: true, code: 'PRODUCT_UNAVAILABLE' },
        { blocking: true, code: 'SKU_UNAVAILABLE' },
        { blocking: true, code: 'STOCK_INSUFFICIENT' },
      ],
    });
  });

  it('reports price and promotion changes without treating cart prices as authoritative', () => {
    expect(
      assessCartLine({
        addedPromotionFingerprint: 'promo-v1',
        addedUnitPriceVnd: 100_000,
        availableStock: 5,
        currentPromotionFingerprint: 'promo-v2',
        currentUnitPriceVnd: 90_000,
        productPublished: true,
        quantity: 2,
        skuEnabled: true,
      }),
    ).toEqual({
      blocking: false,
      currentSubtotalVnd: 180_000,
      issues: [
        { blocking: false, code: 'PRICE_CHANGED' },
        { blocking: false, code: 'PROMOTION_CHANGED' },
      ],
    });
  });

  it('distinguishes zero stock and rejects invalid quantities or money', () => {
    const valid = {
      addedUnitPriceVnd: 100_000,
      availableStock: 0,
      currentUnitPriceVnd: 100_000,
      productPublished: true,
      quantity: 1,
      skuEnabled: true,
    } as const;
    expect(assessCartLine(valid).issues).toEqual([{ blocking: true, code: 'OUT_OF_STOCK' }]);
    expect(() => assessCartLine({ ...valid, quantity: 0 })).toThrowError(
      new CartRuleError('QUANTITY_INVALID'),
    );
    expect(() => assessCartLine({ ...valid, currentUnitPriceVnd: 0.5 })).toThrowError(
      new CartRuleError('PRICE_INVALID'),
    );
  });
});
