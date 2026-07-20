export type PricingRuleErrorCode =
  | 'AMOUNT_INVALID'
  | 'QUANTITY_INVALID'
  | 'RULE_BUCKET_DUPLICATED'
  | 'RULE_INVALID'
  | 'RULES_NOT_STACKABLE'
  | 'SHIPPING_BASIS_REQUIRED';

export class PricingRuleError extends Error {
  public constructor(public readonly code: PricingRuleErrorCode) {
    super(code);
    this.name = 'PricingRuleError';
  }
}

export type PricingRuleBucket = 'COUPON' | 'ITEM' | 'ORDER';
export type PricingApplicationSlot = PricingRuleBucket | 'SHIPPING';
export type PricingDiscountMethod = 'FIXED_VND' | 'PERCENTAGE_BPS';
export type PricingIneligibilityReason = 'ENDED' | 'MINIMUM_NOT_MET' | 'NOT_STARTED';

export type PricingRule = Readonly<{
  bucket: PricingRuleBucket;
  code: string;
  endsAt?: Date;
  maximumDiscountVnd?: number;
  method: PricingDiscountMethod;
  minimumSpendVnd?: number;
  priority: number;
  stackableWith: readonly PricingRuleBucket[];
  startsAt?: Date;
  value: number;
  version: number;
}>;

export type PricingRuleEvaluation = Readonly<{
  amountVnd: number;
  basisVnd: number;
  eligible: boolean;
  reason?: PricingIneligibilityReason;
  rule: PricingRule;
}>;

export type AppliedPricingRule = Readonly<{
  amountVnd: number;
  basisVnd: number;
  bucket: PricingRuleBucket;
  code: string;
  version: number;
}>;

const BUCKET_ORDER: Readonly<Record<PricingRuleBucket, number>> = Object.freeze({
  ITEM: 0,
  ORDER: 1,
  COUPON: 2,
});

const PRICING_RULE_BUCKETS = Object.freeze(['ITEM', 'ORDER', 'COUPON'] as const);
const PRICING_DISCOUNT_METHODS = Object.freeze(['FIXED_VND', 'PERCENTAGE_BPS'] as const);

function vndAmount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PricingRuleError('AMOUNT_INVALID');
  }
  return value;
}

function validatedRule(rule: PricingRule): PricingRule {
  const code = rule.code.trim().toLowerCase();
  if (
    !PRICING_RULE_BUCKETS.includes(rule.bucket) ||
    !PRICING_DISCOUNT_METHODS.includes(rule.method) ||
    !/^[a-z][a-z0-9-]{1,63}$/.test(code) ||
    !Number.isSafeInteger(rule.priority) ||
    rule.priority < 0 ||
    !Number.isSafeInteger(rule.version) ||
    rule.version < 1 ||
    (rule.minimumSpendVnd !== undefined &&
      (!Number.isSafeInteger(rule.minimumSpendVnd) || rule.minimumSpendVnd < 0)) ||
    (rule.maximumDiscountVnd !== undefined &&
      (!Number.isSafeInteger(rule.maximumDiscountVnd) || rule.maximumDiscountVnd <= 0)) ||
    (rule.method === 'FIXED_VND' && (!Number.isSafeInteger(rule.value) || rule.value <= 0)) ||
    (rule.method === 'PERCENTAGE_BPS' &&
      (!Number.isInteger(rule.value) || rule.value < 1 || rule.value > 10_000)) ||
    (rule.startsAt !== undefined && Number.isNaN(rule.startsAt.getTime())) ||
    (rule.endsAt !== undefined && Number.isNaN(rule.endsAt.getTime())) ||
    (rule.startsAt !== undefined &&
      rule.endsAt !== undefined &&
      rule.startsAt.getTime() >= rule.endsAt.getTime())
  ) {
    throw new PricingRuleError('RULE_INVALID');
  }
  const stackableWith = [...new Set(rule.stackableWith)];
  if (
    stackableWith.length !== rule.stackableWith.length ||
    stackableWith.includes(rule.bucket) ||
    stackableWith.some((bucket) => !PRICING_RULE_BUCKETS.includes(bucket))
  ) {
    throw new PricingRuleError('RULE_INVALID');
  }
  return Object.freeze({ ...rule, code, stackableWith: Object.freeze(stackableWith) });
}

export function calculateVndSubtotal(unitPriceVnd: number, quantity: number): number {
  vndAmount(unitPriceVnd);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) {
    throw new PricingRuleError('QUANTITY_INVALID');
  }
  const subtotal = BigInt(unitPriceVnd) * BigInt(quantity);
  if (subtotal > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new PricingRuleError('AMOUNT_INVALID');
  }
  return Number(subtotal);
}

export function evaluatePricingRule(
  basisVnd: number,
  inputRule: PricingRule,
  now = new Date(),
): PricingRuleEvaluation {
  const basis = vndAmount(basisVnd);
  const rule = validatedRule(inputRule);
  const timestamp = now.getTime();
  if (Number.isNaN(timestamp)) throw new PricingRuleError('RULE_INVALID');
  if (rule.startsAt !== undefined && timestamp < rule.startsAt.getTime()) {
    return Object.freeze({
      amountVnd: 0,
      basisVnd: basis,
      eligible: false,
      reason: 'NOT_STARTED',
      rule,
    });
  }
  if (rule.endsAt !== undefined && timestamp >= rule.endsAt.getTime()) {
    return Object.freeze({ amountVnd: 0, basisVnd: basis, eligible: false, reason: 'ENDED', rule });
  }
  if (rule.minimumSpendVnd !== undefined && basis < rule.minimumSpendVnd) {
    return Object.freeze({
      amountVnd: 0,
      basisVnd: basis,
      eligible: false,
      reason: 'MINIMUM_NOT_MET',
      rule,
    });
  }

  const rawAmount =
    rule.method === 'FIXED_VND'
      ? rule.value
      : Number((BigInt(basis) * BigInt(rule.value)) / 10_000n);
  const cappedAmount =
    rule.maximumDiscountVnd === undefined
      ? rawAmount
      : Math.min(rawAmount, rule.maximumDiscountVnd);
  return Object.freeze({
    amountVnd: Math.min(basis, cappedAmount),
    basisVnd: basis,
    eligible: true,
    rule,
  });
}

function compareEvaluations(left: PricingRuleEvaluation, right: PricingRuleEvaluation): number {
  return (
    right.amountVnd - left.amountVnd ||
    left.rule.priority - right.rule.priority ||
    left.rule.code.localeCompare(right.rule.code, 'en') ||
    left.rule.version - right.rule.version
  );
}

export function selectBestPricingRule(
  basisVnd: number,
  rules: readonly PricingRule[],
  now = new Date(),
): PricingRuleEvaluation | null {
  const evaluations = rules
    .map((rule) => evaluatePricingRule(basisVnd, rule, now))
    .filter((evaluation) => evaluation.eligible && evaluation.amountVnd > 0)
    .sort(compareEvaluations);
  return evaluations[0] ?? null;
}

export function canStackPricingRules(leftInput: PricingRule, rightInput: PricingRule): boolean {
  const left = validatedRule(leftInput);
  const right = validatedRule(rightInput);
  return (
    left.bucket !== right.bucket &&
    left.stackableWith.includes(right.bucket) &&
    right.stackableWith.includes(left.bucket)
  );
}

export function applyPricingRuleSequence(
  initialBasisVnd: number,
  inputs: readonly PricingRule[],
  now = new Date(),
): Readonly<{
  applied: readonly AppliedPricingRule[];
  payableVnd: number;
  totalDiscountVnd: number;
}> {
  const basis = vndAmount(initialBasisVnd);
  if (inputs.some((rule) => String(rule.bucket) === 'SHIPPING')) {
    throw new PricingRuleError('SHIPPING_BASIS_REQUIRED');
  }
  const rules = inputs
    .map(validatedRule)
    .sort(
      (left, right) =>
        BUCKET_ORDER[left.bucket] - BUCKET_ORDER[right.bucket] ||
        left.priority - right.priority ||
        left.code.localeCompare(right.code, 'en') ||
        left.version - right.version,
    );
  if (new Set(rules.map((rule) => rule.bucket)).size !== rules.length) {
    throw new PricingRuleError('RULE_BUCKET_DUPLICATED');
  }
  for (let leftIndex = 0; leftIndex < rules.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < rules.length; rightIndex += 1) {
      if (!canStackPricingRules(rules[leftIndex]!, rules[rightIndex]!)) {
        throw new PricingRuleError('RULES_NOT_STACKABLE');
      }
    }
  }

  let payableVnd = basis;
  const applied: AppliedPricingRule[] = [];
  for (const rule of rules) {
    const evaluation = evaluatePricingRule(payableVnd, rule, now);
    if (!evaluation.eligible || evaluation.amountVnd === 0) continue;
    applied.push(
      Object.freeze({
        amountVnd: evaluation.amountVnd,
        basisVnd: evaluation.basisVnd,
        bucket: rule.bucket,
        code: rule.code,
        version: rule.version,
      }),
    );
    payableVnd -= evaluation.amountVnd;
  }

  return Object.freeze({
    applied: Object.freeze(applied),
    payableVnd,
    totalDiscountVnd: basis - payableVnd,
  });
}

export type ShippingQualificationRule = Readonly<{
  code: string;
  endsAt?: Date;
  minimumQuantity?: number;
  minimumSpendVnd?: number;
  priority: number;
  stackableWith: readonly PricingRuleBucket[];
  startsAt: Date;
  version: number;
}>;

export type ShippingQualificationReason = PricingIneligibilityReason | 'MINIMUM_QUANTITY_NOT_MET';

export type ShippingQualificationEvaluation = Readonly<{
  eligible: boolean;
  reason?: ShippingQualificationReason;
  rule: ShippingQualificationRule;
}>;

function validatedShippingRule(input: ShippingQualificationRule): ShippingQualificationRule {
  const code = input.code.trim().toLowerCase();
  const stackableWith = [...new Set(input.stackableWith)];
  if (
    !/^[a-z][a-z0-9-]{1,63}$/.test(code) ||
    !Number.isSafeInteger(input.priority) ||
    input.priority < 0 ||
    !Number.isSafeInteger(input.version) ||
    input.version < 1 ||
    Number.isNaN(input.startsAt.getTime()) ||
    (input.endsAt !== undefined && Number.isNaN(input.endsAt.getTime())) ||
    (input.endsAt !== undefined && input.startsAt >= input.endsAt) ||
    (input.minimumSpendVnd !== undefined &&
      (!Number.isSafeInteger(input.minimumSpendVnd) || input.minimumSpendVnd < 0)) ||
    (input.minimumQuantity !== undefined &&
      (!Number.isSafeInteger(input.minimumQuantity) ||
        input.minimumQuantity < 1 ||
        input.minimumQuantity > 99)) ||
    stackableWith.length !== input.stackableWith.length ||
    stackableWith.some((bucket) => !PRICING_RULE_BUCKETS.includes(bucket))
  ) {
    throw new PricingRuleError('RULE_INVALID');
  }
  return Object.freeze({ ...input, code, stackableWith: Object.freeze(stackableWith) });
}

export function evaluateShippingQualification(
  merchandisePayableVnd: number,
  totalQuantity: number,
  inputRule: ShippingQualificationRule,
  now = new Date(),
): ShippingQualificationEvaluation {
  const basis = vndAmount(merchandisePayableVnd);
  if (!Number.isSafeInteger(totalQuantity) || totalQuantity < 1) {
    throw new PricingRuleError('QUANTITY_INVALID');
  }
  const rule = validatedShippingRule(inputRule);
  const timestamp = now.getTime();
  if (Number.isNaN(timestamp)) throw new PricingRuleError('RULE_INVALID');
  if (timestamp < rule.startsAt.getTime()) {
    return Object.freeze({ eligible: false, reason: 'NOT_STARTED', rule });
  }
  if (rule.endsAt !== undefined && timestamp >= rule.endsAt.getTime()) {
    return Object.freeze({ eligible: false, reason: 'ENDED', rule });
  }
  if (rule.minimumSpendVnd !== undefined && basis < rule.minimumSpendVnd) {
    return Object.freeze({ eligible: false, reason: 'MINIMUM_NOT_MET', rule });
  }
  if (rule.minimumQuantity !== undefined && totalQuantity < rule.minimumQuantity) {
    return Object.freeze({ eligible: false, reason: 'MINIMUM_QUANTITY_NOT_MET', rule });
  }
  return Object.freeze({ eligible: true, rule });
}
