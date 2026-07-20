import { calculateVndSubtotal, PricingRuleError } from './pricing';

export const MAX_CART_LINE_QUANTITY = 99;

export type CartRuleErrorCode =
  'AVAILABLE_STOCK_INVALID' | 'CART_LINE_INVALID' | 'PRICE_INVALID' | 'QUANTITY_INVALID';

export class CartRuleError extends Error {
  public constructor(public readonly code: CartRuleErrorCode) {
    super(code);
    this.name = 'CartRuleError';
  }
}

export type CartLineIssueCode =
  | 'OUT_OF_STOCK'
  | 'PRICE_CHANGED'
  | 'PRODUCT_UNAVAILABLE'
  | 'PROMOTION_CHANGED'
  | 'SKU_UNAVAILABLE'
  | 'STOCK_INSUFFICIENT';

export type CartLineAssessmentInput = Readonly<{
  addedPromotionFingerprint?: string;
  addedUnitPriceVnd: number;
  availableStock: number;
  currentPromotionFingerprint?: string;
  currentUnitPriceVnd: number;
  productPublished: boolean;
  quantity: number;
  skuEnabled: boolean;
}>;

export type CartLineAssessment = Readonly<{
  blocking: boolean;
  currentSubtotalVnd: number;
  issues: readonly Readonly<{ blocking: boolean; code: CartLineIssueCode }>[];
}>;

export function assessCartLine(input: CartLineAssessmentInput): CartLineAssessment {
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > 99) {
    throw new CartRuleError('QUANTITY_INVALID');
  }
  if (!Number.isSafeInteger(input.availableStock) || input.availableStock < 0) {
    throw new CartRuleError('AVAILABLE_STOCK_INVALID');
  }

  let currentSubtotalVnd: number;
  try {
    calculateVndSubtotal(input.addedUnitPriceVnd, 1);
    currentSubtotalVnd = calculateVndSubtotal(input.currentUnitPriceVnd, input.quantity);
  } catch (error) {
    if (error instanceof PricingRuleError) throw new CartRuleError('PRICE_INVALID');
    throw error;
  }

  const issues: { blocking: boolean; code: CartLineIssueCode }[] = [];
  if (!input.productPublished) issues.push({ blocking: true, code: 'PRODUCT_UNAVAILABLE' });
  if (!input.skuEnabled) issues.push({ blocking: true, code: 'SKU_UNAVAILABLE' });
  if (input.availableStock === 0) {
    issues.push({ blocking: true, code: 'OUT_OF_STOCK' });
  } else if (input.availableStock < input.quantity) {
    issues.push({ blocking: true, code: 'STOCK_INSUFFICIENT' });
  }
  if (input.addedUnitPriceVnd !== input.currentUnitPriceVnd) {
    issues.push({ blocking: false, code: 'PRICE_CHANGED' });
  }
  if (input.addedPromotionFingerprint !== input.currentPromotionFingerprint) {
    issues.push({ blocking: false, code: 'PROMOTION_CHANGED' });
  }

  return Object.freeze({
    blocking: issues.some((issue) => issue.blocking),
    currentSubtotalVnd,
    issues: Object.freeze(issues.map((issue) => Object.freeze(issue))),
  });
}
