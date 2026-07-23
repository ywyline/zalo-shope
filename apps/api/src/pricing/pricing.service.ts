import { createHash, randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { PricingQuoteRequest } from '@zalo-shop/contracts';
import {
  type Locale,
  Prisma,
  type PrismaClient,
  type StoreTransaction,
  withStoreTransaction,
} from '@zalo-shop/database';
import {
  calculateVndSubtotal,
  canStackPricingRules,
  createStoreContext,
  evaluatePricingRule,
  evaluateShippingQualification,
  selectBestPricingRule,
  type PricingRule,
  type PricingRuleBucket,
  type PricingRuleEvaluation,
  type ShippingQualificationRule,
} from '@zalo-shop/domain';

import { AuthService } from '../auth/auth.service';
import { DATABASE_CLIENT } from '../auth/auth.tokens';
import { AdminService } from '../admin/admin.service';
import { SearchRateLimiter } from '../search/search-rate-limiter';

type ResolvedStore = { code: string; default_locale: Locale; id: string };
type MemberIdentity = { id: string; storeId: string };
type QuoteIssue = 'OUT_OF_STOCK' | 'PRODUCT_UNAVAILABLE' | 'SKU_UNAVAILABLE' | 'STOCK_INSUFFICIENT';
type RejectedReason =
  | 'COUPON_INVALID'
  | 'ENDED'
  | 'MEMBER_INELIGIBLE'
  | 'MINIMUM_NOT_MET'
  | 'MINIMUM_QUANTITY_NOT_MET'
  | 'NOT_BEST'
  | 'NOT_STACKABLE'
  | 'NOT_STARTED'
  | 'TARGET_MISMATCH';

type LoadedLine = {
  brandId: string;
  categoryIds: Set<string>;
  fact: unknown;
  issues: QuoteIssue[];
  productId: string;
  productVersion: number;
  quantity: number;
  skuCode: string;
  skuId: string;
  skuVersion: number;
  subtotalVnd: number;
  unitPriceVnd: number;
};
type LoadedPromotion = {
  benefitMethod: 'FIXED_VND' | 'FREE_SHIPPING_QUALIFICATION' | 'PERCENTAGE_BPS';
  bucket: 'COUPON' | 'ITEM' | 'ORDER' | 'SHIPPING';
  code: string;
  endsAt: Date | null;
  fixedDiscountVnd: bigint | null;
  id: string;
  maximumDiscountVnd: bigint | null;
  minimumQuantity: number | null;
  minimumSpendVnd: bigint | null;
  percentageBps: number | null;
  priority: number;
  promotionId: string;
  promotionRootVersion: number;
  stackableWith: Array<'COUPON' | 'ITEM' | 'ORDER' | 'SHIPPING'>;
  startsAt: Date;
  targets: Array<{
    brandId: string | null;
    categoryId: string | null;
    productId: string | null;
    skuId: string | null;
    targetType: 'BRAND' | 'CATEGORY' | 'PRODUCT' | 'SKU' | 'STORE';
  }>;
  versionNumber: number;
};
type ResolvedCoupon = {
  fact: unknown;
  promotion: LoadedPromotion;
};
type AppliedRule = {
  basis_vnd: number;
  bucket: PricingRuleBucket;
  code: string;
  discount_vnd: number;
  version_id: string;
};
type RejectedRule = {
  bucket: 'COUPON' | 'ITEM' | 'ORDER' | 'SHIPPING';
  code: string;
  reason: RejectedReason;
  version_id: string;
};

function safeVnd(value: bigint | null): number | undefined {
  if (value === null) return undefined;
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new TypeError('Stored VND amount is outside the safe integer range');
  }
  return amount;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashQuote(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function ruleFromPromotion(promotion: LoadedPromotion): PricingRule {
  if (
    promotion.bucket === 'SHIPPING' ||
    promotion.benefitMethod === 'FREE_SHIPPING_QUALIFICATION'
  ) {
    throw new TypeError('Shipping promotion is not a merchandise pricing rule');
  }
  return {
    bucket: promotion.bucket,
    code: promotion.code,
    ...(promotion.endsAt === null ? {} : { endsAt: promotion.endsAt }),
    ...(promotion.maximumDiscountVnd === null
      ? {}
      : { maximumDiscountVnd: safeVnd(promotion.maximumDiscountVnd)! }),
    method: promotion.benefitMethod,
    ...(promotion.minimumQuantity === null ? {} : { minimumQuantity: promotion.minimumQuantity }),
    ...(promotion.minimumSpendVnd === null
      ? {}
      : { minimumSpendVnd: safeVnd(promotion.minimumSpendVnd)! }),
    priority: promotion.priority,
    stackableWith: promotion.stackableWith,
    startsAt: promotion.startsAt,
    value:
      promotion.benefitMethod === 'FIXED_VND'
        ? safeVnd(promotion.fixedDiscountVnd)!
        : promotion.percentageBps!,
    version: promotion.versionNumber,
    versionId: promotion.id,
  };
}

function shippingRule(promotion: LoadedPromotion): ShippingQualificationRule {
  return {
    code: promotion.code,
    ...(promotion.endsAt === null ? {} : { endsAt: promotion.endsAt }),
    ...(promotion.minimumQuantity === null ? {} : { minimumQuantity: promotion.minimumQuantity }),
    ...(promotion.minimumSpendVnd === null
      ? {}
      : { minimumSpendVnd: safeVnd(promotion.minimumSpendVnd)! }),
    priority: promotion.priority,
    stackableWith: promotion.stackableWith.filter(
      (bucket): bucket is PricingRuleBucket => bucket !== 'SHIPPING',
    ),
    startsAt: promotion.startsAt,
    version: promotion.versionNumber,
    versionId: promotion.id,
  };
}

function targetMatches(promotion: LoadedPromotion, line: LoadedLine): boolean {
  return promotion.targets.some((target) => {
    if (target.targetType === 'STORE') return true;
    if (target.targetType === 'BRAND') return target.brandId === line.brandId;
    if (target.targetType === 'CATEGORY') {
      return target.categoryId !== null && line.categoryIds.has(target.categoryId);
    }
    if (target.targetType === 'PRODUCT') return target.productId === line.productId;
    return target.skuId === line.skuId;
  });
}

function rejected(promotion: LoadedPromotion, reason: RejectedReason): RejectedRule {
  return {
    bucket: promotion.bucket,
    code: promotion.code,
    reason,
    version_id: promotion.id,
  };
}

function rejectionFromEvaluation(evaluation: {
  reason?: 'ENDED' | 'MINIMUM_NOT_MET' | 'MINIMUM_QUANTITY_NOT_MET' | 'NOT_STARTED';
}): RejectedReason {
  if (evaluation.reason === 'NOT_STARTED') return 'NOT_STARTED';
  if (evaluation.reason === 'ENDED') return 'ENDED';
  if (evaluation.reason === 'MINIMUM_QUANTITY_NOT_MET') return 'MINIMUM_QUANTITY_NOT_MET';
  return 'MINIMUM_NOT_MET';
}

function safeSum(values: readonly number[]): number {
  const total = values.reduce((sum, value) => sum + BigInt(value), 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new BadRequestException('Quoted amount exceeds the supported VND range');
  }
  return Number(total);
}

export function allocateDiscount(
  payable: Array<{ key: string; value: number }>,
  amount: number,
): Map<string, number> {
  const basis = safeSum(payable.map(({ value }) => value));
  if (basis === 0 || amount === 0) return new Map(payable.map(({ key }) => [key, 0]));
  const allocations = payable.map((line) => {
    const numerator = BigInt(amount) * BigInt(line.value);
    return {
      baseValue: line.value,
      fraction: numerator % BigInt(basis),
      key: line.key,
      value: Number(numerator / BigInt(basis)),
    };
  });
  let remainder = amount - allocations.reduce((sum, line) => sum + line.value, 0);
  // A zero-value line must never receive a remainder unit.  Sale prices are
  // non-negative by contract, so a free line can legitimately be present in
  // the same quote as paid lines.  Restrict the largest-remainder pass to
  // positive bases while retaining zero allocations in the returned map.
  const positiveAllocations = allocations.filter((line) => line.baseValue > 0);
  positiveAllocations.sort(
    (left, right) =>
      (left.fraction === right.fraction ? 0 : left.fraction > right.fraction ? -1 : 1) ||
      left.key.localeCompare(right.key, 'en'),
  );
  for (const allocation of positiveAllocations) {
    if (remainder === 0) break;
    allocation.value += 1;
    remainder -= 1;
  }
  return new Map(allocations.map(({ key, value }) => [key, value]));
}

function evaluationOrder(
  left: { evaluation: PricingRuleEvaluation },
  right: { evaluation: PricingRuleEvaluation },
): number {
  const leftRule = left.evaluation.rule;
  const rightRule = right.evaluation.rule;
  return (
    right.evaluation.amountVnd - left.evaluation.amountVnd ||
    leftRule.priority - rightRule.priority ||
    leftRule.code.localeCompare(rightRule.code, 'en') ||
    leftRule.version - rightRule.version ||
    leftRule.versionId.localeCompare(rightRule.versionId, 'en')
  );
}

@Injectable()
export class PricingService {
  public constructor(
    @Inject(DATABASE_CLIENT) private readonly database: PrismaClient,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AdminService) private readonly admin: AdminService,
    @Inject(SearchRateLimiter) private readonly rateLimiter: SearchRateLimiter,
  ) {}

  public async quote(input: {
    authorization: string | undefined;
    accessReason?: string;
    address: string;
    request: PricingQuoteRequest;
    storeCode: string;
  }) {
    const store = await this.resolveStore(input.storeCode);
    let member: MemberIdentity | undefined;
    let adminContext: Awaited<ReturnType<AdminService['authorize']>> | undefined;
    if (input.authorization) {
      if (!input.authorization.startsWith('Bearer ') || input.authorization.length <= 7) {
        throw new UnauthorizedException('Authentication is required');
      }
      const accessToken = input.authorization.slice(7);
      const claims = await this.auth.authenticateAccessToken(accessToken, input.storeCode);
      if (claims.actorType === 'admin') {
        adminContext = await this.admin.authorize(
          {
            ...(input.accessReason === undefined ? {} : { accessReason: input.accessReason }),
            accessToken,
            storeCode: input.storeCode,
          },
          store.id,
          'store.promotions.read',
        );
      } else if (claims.storeId) {
        member = { id: claims.subjectId, storeId: claims.storeId };
      }
    }
    await this.rateLimiter.assertAllowed(
      input.address,
      'pricing',
      store.id,
      member?.id ?? adminContext?.actor.id,
    );
    const adminPreview = adminContext !== undefined;
    if (input.request.coupon_code !== null && !member && !adminPreview) {
      throw new UnauthorizedException('Coupon pricing requires member authentication');
    }
    const context =
      adminContext ??
      createStoreContext({
        actor: { id: member?.id ?? randomUUID(), type: 'member' },
        correlationId: randomUUID(),
        locale: input.request.locale,
        storeCode: store.code,
        storeId: store.id,
      });
    return withStoreTransaction(
      this.database,
      context,
      async (transaction) =>
        this.quoteMerchandise(transaction, {
          adminPreview,
          member,
          request: input.request,
          storeId: store.id,
        }),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  public async quoteMerchandise(
    transaction: StoreTransaction,
    input: {
      adminPreview: boolean;
      member: MemberIdentity | undefined;
      request: PricingQuoteRequest;
      storeId: string;
    },
  ) {
    const now = (
      await transaction.$queryRaw<Array<{ quoted_at: Date }>>`
        SELECT CURRENT_TIMESTAMP AS quoted_at
      `
    )[0]!.quoted_at;
    const lines = await this.loadLines(transaction, input.storeId, input.request);
    const promotions = await this.loadPromotions(transaction, input.storeId);
    const coupon = await this.resolveCoupon(
      transaction,
      input.storeId,
      input.member,
      input.adminPreview,
      input.request.coupon_code,
      promotions,
      now,
    );
    return this.calculate(input.storeId, input.member, lines, promotions, coupon, now);
  }

  private async loadLines(
    transaction: StoreTransaction,
    storeId: string,
    request: PricingQuoteRequest,
  ): Promise<LoadedLine[]> {
    const codes = request.items.map((item) => item.sku_code);
    const rows = await transaction.sku.findMany({
      include: {
        inventoryBalances: {
          include: { warehouse: true },
          where: { warehouse: { enabled: true, isDefaultFulfillment: true } },
        },
        products: {
          include: { brands: true, categories: true, product_secondary_categories: true },
        },
      },
      where: { code: { in: codes }, storeId },
    });
    const byCode = new Map(rows.map((sku) => [sku.code, sku]));
    return request.items.map((item) => {
      const sku = byCode.get(item.sku_code);
      if (!sku) throw new NotFoundException('SKU not found');
      const issues: QuoteIssue[] = [];
      if (
        !sku.products.enabled ||
        sku.products.deletedAt !== null ||
        sku.products.status !== 'PUBLISHED' ||
        sku.products.brands.status !== 'ACTIVE' ||
        sku.products.brands.deletedAt !== null ||
        sku.products.categories.status !== 'ACTIVE' ||
        sku.products.categories.deletedAt !== null
      ) {
        issues.push('PRODUCT_UNAVAILABLE');
      }
      if (sku.status !== 'ACTIVE') issues.push('SKU_UNAVAILABLE');
      const available = sku.inventoryBalances.reduce((sum, balance) => sum + balance.available, 0);
      if (available <= 0) issues.push('OUT_OF_STOCK');
      else if (available < item.quantity) issues.push('STOCK_INSUFFICIENT');
      const unitPriceVnd = safeVnd(sku.salePriceVnd)!;
      let subtotalVnd: number;
      try {
        subtotalVnd = calculateVndSubtotal(unitPriceVnd, item.quantity);
      } catch {
        throw new BadRequestException('Quoted amount exceeds the supported VND range');
      }
      return {
        brandId: sku.products.brandId,
        categoryIds: new Set([
          sku.products.mainCategoryId,
          ...sku.products.product_secondary_categories.map(({ categoryId }) => categoryId),
        ]),
        fact: {
          brand: {
            deleted_at: sku.products.brands.deletedAt?.toISOString() ?? null,
            id: sku.products.brands.id,
            status: sku.products.brands.status,
            version: sku.products.brands.version,
          },
          inventory_balances: sku.inventoryBalances
            .map((balance) => ({
              available: balance.available,
              id: balance.id,
              on_hand: balance.onHand,
              reserved: balance.reserved,
              version: balance.version,
              warehouse: {
                enabled: balance.warehouse.enabled,
                id: balance.warehouse.id,
                is_default_fulfillment: balance.warehouse.isDefaultFulfillment,
                version: balance.warehouse.version,
              },
            }))
            .sort((left, right) => left.id.localeCompare(right.id, 'en')),
          main_category: {
            deleted_at: sku.products.categories.deletedAt?.toISOString() ?? null,
            id: sku.products.categories.id,
            status: sku.products.categories.status,
            version: sku.products.categories.version,
          },
          product: {
            deleted_at: sku.products.deletedAt?.toISOString() ?? null,
            enabled: sku.products.enabled,
            id: sku.products.id,
            status: sku.products.status,
            version: sku.products.version,
          },
          secondary_category_ids: sku.products.product_secondary_categories
            .map(({ categoryId }) => categoryId)
            .sort((left, right) => left.localeCompare(right, 'en')),
          sku: {
            id: sku.id,
            status: sku.status,
            unit_price_vnd: unitPriceVnd,
            version: sku.version,
          },
        },
        issues,
        productId: sku.productId,
        productVersion: sku.products.version,
        quantity: item.quantity,
        skuCode: sku.code,
        skuId: sku.id,
        skuVersion: sku.version,
        subtotalVnd,
        unitPriceVnd,
      };
    });
  }

  private loadPromotions(transaction: StoreTransaction, storeId: string) {
    return transaction.promotionVersion
      .findMany({
        include: { promotion: true, targets: true },
        orderBy: [{ priority: 'asc' }, { versionNumber: 'asc' }, { id: 'asc' }],
        where: {
          promotion: { activeVersionId: { not: null }, status: 'ACTIVE' },
          status: 'PUBLISHED',
          storeId,
        },
      })
      .then(
        (versions) =>
          versions
            .filter((version) => version.promotion.activeVersionId === version.id)
            .map((version) => ({
              benefitMethod: version.benefitMethod,
              bucket: version.bucket,
              code: version.promotion.code,
              endsAt: version.endsAt,
              fixedDiscountVnd: version.fixedDiscountVnd,
              id: version.id,
              maximumDiscountVnd: version.maximumDiscountVnd,
              minimumQuantity: version.minimumQuantity,
              minimumSpendVnd: version.minimumSpendVnd,
              percentageBps: version.percentageBps,
              priority: version.priority,
              promotionId: version.promotionId,
              promotionRootVersion: version.promotion.version,
              stackableWith: version.stackableWith,
              startsAt: version.startsAt,
              targets: version.targets,
              versionNumber: version.versionNumber,
            })) satisfies LoadedPromotion[],
      );
  }

  private async resolveCoupon(
    transaction: StoreTransaction,
    storeId: string,
    member: MemberIdentity | undefined,
    adminPreview: boolean,
    couponCode: string | null,
    promotions: LoadedPromotion[],
    now: Date,
  ): Promise<ResolvedCoupon | null> {
    if (couponCode === null) return null;
    const coupon = await transaction.coupon.findUnique({
      where: { storeId_code: { code: couponCode, storeId } },
    });
    const memberCoupon =
      coupon && member
        ? await transaction.memberCoupon.findUnique({
            where: {
              storeId_couponId_memberId: {
                couponId: coupon.id,
                memberId: member.id,
                storeId,
              },
            },
          })
        : null;
    if (
      !coupon ||
      coupon.status !== 'ACTIVE' ||
      (!adminPreview &&
        (!memberCoupon ||
          memberCoupon.status !== 'CLAIMED' ||
          (memberCoupon.expiresAt !== null && memberCoupon.expiresAt <= now)))
    ) {
      throw new ConflictException('COUPON_INVALID');
    }
    if (coupon.newCustomerOnly && !adminPreview) {
      if (!member) throw new ConflictException('MEMBER_INELIGIBLE');
      const completedOrders = await transaction.order.count({
        where: { memberId: member.id, status: 'COMPLETED', storeId },
      });
      if (completedOrders > 0) throw new ConflictException('MEMBER_INELIGIBLE');
    }
    const promotion = promotions.find((item) => item.id === coupon.promotionVersionId);
    if (!promotion || promotion.bucket !== 'COUPON') {
      throw new ConflictException('COUPON_INVALID');
    }
    return {
      fact: {
        claimed_count: coupon.claimedCount,
        coupon_id: coupon.id,
        new_customer_only: coupon.newCustomerOnly,
        promotion_version_id: coupon.promotionVersionId,
        status: coupon.status,
        total_claim_limit: coupon.totalClaimLimit,
        updated_at: coupon.updatedAt.toISOString(),
        version: coupon.version,
        member_coupon:
          memberCoupon === null
            ? null
            : {
                expires_at: memberCoupon.expiresAt?.toISOString() ?? null,
                id: memberCoupon.id,
                status: memberCoupon.status,
                updated_at: memberCoupon.updatedAt.toISOString(),
              },
      },
      promotion: { ...promotion, code: coupon.code },
    };
  }

  private calculate(
    storeId: string,
    member: MemberIdentity | undefined,
    lines: LoadedLine[],
    promotions: LoadedPromotion[],
    coupon: ResolvedCoupon | null,
    now: Date,
  ) {
    const baseSubtotal = safeSum(lines.map((line) => line.subtotalVnd));
    const rejectedRules: RejectedRule[] = [];
    const appliedRules: AppliedRule[] = [];
    const lineApplied = new Map(lines.map((line) => [line.skuId, [] as AppliedRule[]]));
    const lineRejected = new Map(lines.map((line) => [line.skuId, [] as RejectedRule[]]));
    const currentPayable = new Map(lines.map((line) => [line.skuId, line.subtotalVnd]));

    const itemSelections = new Map<
      string,
      { evaluation: PricingRuleEvaluation; source: LoadedPromotion }
    >();
    for (const line of lines) {
      const candidates = promotions.filter(
        (promotion) => promotion.bucket === 'ITEM' && targetMatches(promotion, line),
      );
      const rules = candidates.map(ruleFromPromotion);
      const selected = selectBestPricingRule(line.subtotalVnd, line.quantity, rules, now);
      for (const promotion of promotions.filter((item) => item.bucket === 'ITEM')) {
        if (!targetMatches(promotion, line)) {
          const reason = rejected(promotion, 'TARGET_MISMATCH');
          lineRejected.get(line.skuId)!.push(reason);
          continue;
        }
        const evaluation = evaluatePricingRule(
          line.subtotalVnd,
          line.quantity,
          ruleFromPromotion(promotion),
          now,
        );
        if (!evaluation.eligible) {
          const reason = rejected(promotion, rejectionFromEvaluation(evaluation));
          lineRejected.get(line.skuId)!.push(reason);
        } else if (selected?.rule.versionId !== promotion.id) {
          const reason = rejected(promotion, 'NOT_BEST');
          lineRejected.get(line.skuId)!.push(reason);
        }
      }
      if (selected) {
        const source = candidates.find((promotion) => promotion.id === selected.rule.versionId)!;
        itemSelections.set(line.skuId, { evaluation: selected, source });
        currentPayable.set(line.skuId, line.subtotalVnd - selected.amountVnd);
        const applied = {
          basis_vnd: selected.basisVnd,
          bucket: 'ITEM',
          code: selected.rule.code,
          discount_vnd: selected.amountVnd,
          version_id: selected.rule.versionId,
        } satisfies AppliedRule;
        lineApplied.get(line.skuId)!.push(applied);
        appliedRules.push(applied);
      }
    }

    for (const promotion of promotions.filter((item) => item.bucket === 'ITEM')) {
      if ([...itemSelections.values()].some(({ source }) => source.id === promotion.id)) continue;
      const reasons = lines.flatMap((line) =>
        lineRejected
          .get(line.skuId)!
          .filter((item) => item.version_id === promotion.id)
          .map((item) => item.reason),
      );
      const reason =
        reasons.find((item) => item === 'NOT_BEST') ??
        reasons.find((item) => item !== 'TARGET_MISMATCH') ??
        'TARGET_MISMATCH';
      rejectedRules.push(rejected(promotion, reason));
    }

    const selectedAcrossBuckets: PricingRule[] = [
      ...new Map(
        [...itemSelections.values()].map(({ evaluation }) => [
          evaluation.rule.versionId,
          evaluation.rule,
        ]),
      ).values(),
    ];
    const targetedLines = (promotion: LoadedPromotion) =>
      lines.filter((line) => targetMatches(promotion, line));
    const targetedBasis = (targets: LoadedLine[]) =>
      safeSum(targets.map((line) => currentPayable.get(line.skuId)!));
    const targetedQuantity = (targets: LoadedLine[]) =>
      safeSum(targets.map((line) => line.quantity));
    const applyAggregate = (evaluation: PricingRuleEvaluation, targets: LoadedLine[]) => {
      const before = new Map(targets.map((line) => [line.skuId, currentPayable.get(line.skuId)!]));
      const allocation = allocateDiscount(
        targets.map((line) => ({ key: line.skuId, value: before.get(line.skuId)! })),
        evaluation.amountVnd,
      );
      for (const line of targets) {
        const allocated = allocation.get(line.skuId) ?? 0;
        if (allocated === 0) continue;
        currentPayable.set(line.skuId, before.get(line.skuId)! - allocated);
        lineApplied.get(line.skuId)!.push({
          basis_vnd: before.get(line.skuId)!,
          bucket: evaluation.rule.bucket,
          code: evaluation.rule.code,
          discount_vnd: allocated,
          version_id: evaluation.rule.versionId,
        });
      }
      appliedRules.push({
        basis_vnd: evaluation.basisVnd,
        bucket: evaluation.rule.bucket,
        code: evaluation.rule.code,
        discount_vnd: evaluation.amountVnd,
        version_id: evaluation.rule.versionId,
      });
      selectedAcrossBuckets.push(evaluation.rule);
    };

    if (coupon) {
      const couponRule = ruleFromPromotion(coupon.promotion);
      const targets = targetedLines(coupon.promotion);
      if (targets.length === 0) {
        rejectedRules.push(rejected(coupon.promotion, 'TARGET_MISMATCH'));
      } else {
        const evaluation = evaluatePricingRule(
          targetedBasis(targets),
          targetedQuantity(targets),
          couponRule,
          now,
        );
        const stackable = selectedAcrossBuckets.every((rule) =>
          canStackPricingRules(rule, couponRule),
        );
        if (!evaluation.eligible) {
          rejectedRules.push(rejected(coupon.promotion, rejectionFromEvaluation(evaluation)));
        } else if (!stackable) rejectedRules.push(rejected(coupon.promotion, 'NOT_STACKABLE'));
        else if (evaluation.amountVnd > 0) applyAggregate(evaluation, targets);
        else rejectedRules.push(rejected(coupon.promotion, 'NOT_BEST'));
      }
    }

    const eligibleOrders: Array<{
      evaluation: PricingRuleEvaluation;
      promotion: LoadedPromotion;
      targets: LoadedLine[];
    }> = [];
    for (const promotion of promotions.filter((item) => item.bucket === 'ORDER')) {
      const targets = targetedLines(promotion);
      if (targets.length === 0) {
        rejectedRules.push(rejected(promotion, 'TARGET_MISMATCH'));
        continue;
      }
      const evaluation = evaluatePricingRule(
        targetedBasis(targets),
        targetedQuantity(targets),
        ruleFromPromotion(promotion),
        now,
      );
      if (!evaluation.eligible) {
        rejectedRules.push(rejected(promotion, rejectionFromEvaluation(evaluation)));
      } else if (
        !selectedAcrossBuckets.every((rule) => canStackPricingRules(rule, evaluation.rule))
      ) {
        rejectedRules.push(rejected(promotion, 'NOT_STACKABLE'));
      } else if (evaluation.amountVnd > 0) {
        eligibleOrders.push({ evaluation, promotion, targets });
      } else rejectedRules.push(rejected(promotion, 'NOT_BEST'));
    }
    eligibleOrders.sort(evaluationOrder);
    const bestOrder = eligibleOrders[0];
    for (const candidate of eligibleOrders.slice(1)) {
      rejectedRules.push(rejected(candidate.promotion, 'NOT_BEST'));
    }
    if (bestOrder) applyAggregate(bestOrder.evaluation, bestOrder.targets);

    const merchandisePayable = safeSum([...currentPayable.values()]);

    const shippingPromotions = promotions.filter((promotion) => promotion.bucket === 'SHIPPING');
    for (const promotion of shippingPromotions) {
      if (targetedLines(promotion).length === 0) {
        rejectedRules.push(rejected(promotion, 'TARGET_MISMATCH'));
      }
    }
    const shippingCandidates = shippingPromotions
      .filter((promotion) => lines.some((line) => targetMatches(promotion, line)))
      .map((promotion) => ({
        evaluation: evaluateShippingQualification(
          targetedBasis(targetedLines(promotion)),
          targetedQuantity(targetedLines(promotion)),
          shippingRule(promotion),
          now,
        ),
        promotion,
      }))
      .filter(({ evaluation, promotion }) => {
        if (!evaluation.eligible) {
          rejectedRules.push(rejected(promotion, rejectionFromEvaluation(evaluation)));
          return false;
        }
        if (
          !selectedAcrossBuckets.every(
            (rule) =>
              rule.stackableWith.includes('SHIPPING') &&
              promotion.stackableWith.includes(rule.bucket),
          )
        ) {
          rejectedRules.push(rejected(promotion, 'NOT_STACKABLE'));
          return false;
        }
        return true;
      })
      .sort(
        (left, right) =>
          left.promotion.priority - right.promotion.priority ||
          left.promotion.code.localeCompare(right.promotion.code, 'en') ||
          left.promotion.versionNumber - right.promotion.versionNumber ||
          left.promotion.id.localeCompare(right.promotion.id, 'en'),
      );
    for (const candidate of shippingCandidates.slice(1)) {
      rejectedRules.push(rejected(candidate.promotion, 'NOT_BEST'));
    }

    const uniqueRejected = [
      ...new Map(
        rejectedRules.map((rule) => [`${rule.bucket}:${rule.version_id}:${rule.reason}`, rule]),
      ).values(),
    ];
    const lineViews = lines.map((line) => {
      const payable = currentPayable.get(line.skuId)!;
      return {
        applied_rules: lineApplied.get(line.skuId)!,
        base_subtotal_vnd: line.subtotalVnd,
        base_unit_price_vnd: line.unitPriceVnd,
        discount_vnd: line.subtotalVnd - payable,
        issues: line.issues,
        payable_vnd: payable,
        quantity: line.quantity,
        rejected_rules: [
          ...new Map(
            lineRejected
              .get(line.skuId)!
              .map((rule) => [`${rule.version_id}:${rule.reason}`, rule]),
          ).values(),
        ],
        sku_code: line.skuCode,
      };
    });
    const quoteCore = {
      applied_rules: appliedRules,
      base_subtotal_vnd: baseSubtotal,
      currency: 'VND' as const,
      discount_vnd: baseSubtotal - merchandisePayable,
      lines: lineViews,
      member_eligibility_fingerprint: member
        ? createHash('sha256').update(member.id).digest('hex')
        : null,
      coupon_fact: coupon?.fact ?? null,
      merchandise_payable_vnd: merchandisePayable,
      order_payable_vnd: null,
      quoted_at: now.toISOString(),
      rejected_rules: uniqueRejected,
      rule_facts: promotions.map((promotion) => ({
        id: promotion.id,
        promotion_id: promotion.promotionId,
        promotion_version: promotion.promotionRootVersion,
        version: promotion.versionNumber,
      })),
      schema_version: 'm3-v1',
      sku_facts: lines.map((line) => ({
        product_id: line.productId,
        product_version: line.productVersion,
        pricing_fact: line.fact,
        sku_id: line.skuId,
        sku_version: line.skuVersion,
        unit_price_vnd: line.unitPriceVnd,
      })),
      shipping_qualification: {
        candidates: shippingCandidates.slice(0, 1).map(({ promotion }) => ({
          code: promotion.code,
          version_id: promotion.id,
        })),
        status:
          shippingCandidates.length > 0
            ? ('ELIGIBLE_PENDING_FREIGHT' as const)
            : shippingPromotions.length > 0
              ? ('NOT_ELIGIBLE' as const)
              : ('NOT_REQUESTED' as const),
      },
      store_id: storeId,
    };
    return {
      applied_rules: quoteCore.applied_rules,
      base_subtotal_vnd: quoteCore.base_subtotal_vnd,
      currency: quoteCore.currency,
      discount_vnd: quoteCore.discount_vnd,
      lines: quoteCore.lines,
      merchandise_payable_vnd: quoteCore.merchandise_payable_vnd,
      order_payable_vnd: quoteCore.order_payable_vnd,
      quote_hash: hashQuote(quoteCore),
      quoted_at: quoteCore.quoted_at,
      rejected_rules: quoteCore.rejected_rules,
      shipping_qualification: quoteCore.shipping_qualification,
    };
  }

  private async resolveStore(storeCode: string): Promise<ResolvedStore> {
    const stores = await this.database.$queryRaw<ResolvedStore[]>`
      SELECT * FROM app_security.resolve_active_store(${storeCode.trim()})
    `;
    const store = stores[0];
    if (!store) throw new UnauthorizedException('Store context is invalid');
    return store;
  }
}
