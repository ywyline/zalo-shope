import { createHash } from 'node:crypto';

import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CouponDraftUpdate,
  CouponInput,
  CouponListQuery,
  CouponStatusCommand,
  PromotionListQuery,
  PromotionTargetLookupItem,
  PromotionTargetLookupQuery,
  PromotionStateCommand,
  PromotionVersionInput,
  PublishPromotionInput,
} from '@zalo-shop/contracts';
import {
  Prisma,
  type PrismaClient,
  type StoreTransaction,
  withStoreTransaction,
} from '@zalo-shop/database';
import type { StoreContext } from '@zalo-shop/domain';

import { AdminService, type AdminHeaders } from '../admin/admin.service';
import { DATABASE_CLIENT } from '../auth/auth.tokens';

type PromotionsContext = { headers: AdminHeaders; storeId: string };
type Execution<T> = { body: T; replayed: boolean };

const versionInclude = {
  localizations: { orderBy: { locale: 'asc' as const } },
  targets: { orderBy: [{ targetType: 'asc' as const }, { id: 'asc' as const }] },
};

function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right, 'en'))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function requestHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function safeVnd(value: bigint | null): number | null {
  if (value === null) return null;
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new TypeError('Stored VND amount is outside the safe integer range');
  }
  return amount;
}

type TargetLookupNames = PromotionTargetLookupItem['names'];

function targetLookupNames(
  localizations: Array<{ locale: string; name: string }>,
): TargetLookupNames {
  const names: TargetLookupNames = { en: null, vi: null, zh: null };
  for (const localization of localizations) {
    if (
      localization.locale === 'en' ||
      localization.locale === 'vi' ||
      localization.locale === 'zh'
    ) {
      names[localization.locale] = localization.name;
    }
  }
  return names;
}

function promotionTargetView(target: {
  brandId: string | null;
  categoryId: string | null;
  productId: string | null;
  skuId: string | null;
  targetType: string;
}) {
  return {
    target_id: target.brandId ?? target.categoryId ?? target.productId ?? target.skuId,
    target_type: target.targetType,
  };
}

function promotionVersionView(version: {
  benefitMethod: string;
  bucket: string;
  createdAt: Date;
  endsAt: Date | null;
  fixedDiscountVnd: bigint | null;
  id: string;
  localizations: Array<{ description: string | null; locale: string; name: string }>;
  maximumDiscountVnd: bigint | null;
  minimumQuantity: number | null;
  minimumSpendVnd: bigint | null;
  percentageBps: number | null;
  priority: number;
  publishedAt: Date | null;
  stackableWith: string[];
  startsAt: Date;
  status: string;
  targets: Array<{
    brandId: string | null;
    categoryId: string | null;
    productId: string | null;
    skuId: string | null;
    targetType: string;
  }>;
  versionNumber: number;
}) {
  const benefit =
    version.benefitMethod === 'FIXED_VND'
      ? { method: 'FIXED_VND', value: safeVnd(version.fixedDiscountVnd)! }
      : version.benefitMethod === 'PERCENTAGE_BPS'
        ? {
            maximum_discount_vnd: safeVnd(version.maximumDiscountVnd),
            method: 'PERCENTAGE_BPS',
            value: version.percentageBps,
          }
        : { method: 'FREE_SHIPPING_QUALIFICATION' };
  return {
    benefit,
    bucket: version.bucket,
    created_at: version.createdAt.toISOString(),
    ends_at: version.endsAt?.toISOString() ?? null,
    id: version.id,
    localizations: version.localizations.map((item) => ({
      description: item.description,
      locale: item.locale,
      name: item.name,
    })),
    minimum_quantity: version.minimumQuantity,
    minimum_spend_vnd: safeVnd(version.minimumSpendVnd),
    priority: version.priority,
    published_at: version.publishedAt?.toISOString() ?? null,
    stackable_with: version.stackableWith,
    starts_at: version.startsAt.toISOString(),
    status: version.status,
    targets: version.targets.map(promotionTargetView),
    version_number: version.versionNumber,
  };
}

function promotionView(promotion: {
  activeVersion: Parameters<typeof promotionVersionView>[0] | null;
  code: string;
  createdAt: Date;
  id: string;
  status: string;
  updatedAt: Date;
  version: number;
}) {
  return {
    active_version:
      promotion.activeVersion === null ? null : promotionVersionView(promotion.activeVersion),
    code: promotion.code,
    created_at: promotion.createdAt.toISOString(),
    id: promotion.id,
    status: promotion.status,
    updated_at: promotion.updatedAt.toISOString(),
    version: promotion.version,
  };
}

function couponView(coupon: {
  claimedCount: number;
  code: string;
  createdAt: Date;
  id: string;
  newCustomerOnly: boolean;
  perMemberClaimLimit: number;
  promotionVersionId: string;
  status: string;
  totalClaimLimit: number | null;
  updatedAt: Date;
  version: number;
}) {
  return {
    claimed_count: coupon.claimedCount,
    code: coupon.code,
    created_at: coupon.createdAt.toISOString(),
    id: coupon.id,
    new_customer_only: coupon.newCustomerOnly,
    per_member_claim_limit: coupon.perMemberClaimLimit,
    promotion_version_id: coupon.promotionVersionId,
    status: coupon.status,
    total_claim_limit: coupon.totalClaimLimit,
    updated_at: coupon.updatedAt.toISOString(),
    version: coupon.version,
  };
}

@Injectable()
export class PromotionsAdminService {
  public constructor(
    @Inject(DATABASE_CLIENT) private readonly database: PrismaClient,
    @Inject(AdminService) private readonly admin: AdminService,
  ) {}

  private promotionInclude() {
    return { activeVersion: { include: versionInclude } } as const;
  }

  public async listPromotions(request: PromotionsContext, query: PromotionListQuery) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.promotions.read',
    );
    return withStoreTransaction(this.database, context, async (transaction) => {
      const rows = await transaction.promotion.findMany({
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        include: this.promotionInclude(),
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        where: {
          storeId: request.storeId,
          ...(query.status === undefined ? {} : { status: query.status }),
        },
      });
      const hasMore = rows.length > query.limit;
      const items = rows.slice(0, query.limit);
      return {
        items: items.map(promotionView),
        next_cursor: hasMore ? (items.at(-1)?.id ?? null) : null,
      };
    });
  }

  /**
   * Return the small, same-store catalogue projection needed by the promotion
   * editor.  This intentionally lives behind the promotions permission rather
   * than requiring a second catalog role: promotion operators must be able to
   * choose an exact target without receiving the full catalog payload.
   */
  public async listTargetLookup(
    request: PromotionsContext,
    query: PromotionTargetLookupQuery,
  ): Promise<{ items: PromotionTargetLookupItem[]; next_cursor: string | null }> {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.promotions.read',
    );
    return withStoreTransaction(this.database, context, async (transaction) => {
      const q = query.q;
      const take = query.limit + 1;

      if (query.target_type === 'BRAND') {
        const rows = await transaction.brand.findMany({
          ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
          orderBy: [{ code: 'asc' }, { id: 'asc' }],
          select: {
            brand_localizations: { select: { locale: true, name: true } },
            code: true,
            id: true,
          },
          take,
          where: {
            ...(q
              ? {
                  OR: [
                    { code: { contains: q, mode: 'insensitive' as const } },
                    {
                      brand_localizations: {
                        some: { name: { contains: q, mode: 'insensitive' as const } },
                      },
                    },
                  ],
                }
              : {}),
            deletedAt: null,
            storeId: request.storeId,
          },
        });
        const items = rows.slice(0, query.limit).map((row) => ({
          code: row.code,
          id: row.id,
          names: targetLookupNames(row.brand_localizations),
        }));
        return {
          items,
          next_cursor: rows.length > query.limit ? (items.at(-1)?.id ?? null) : null,
        };
      }

      if (query.target_type === 'CATEGORY') {
        const rows = await transaction.category.findMany({
          ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
          orderBy: [{ code: 'asc' }, { id: 'asc' }],
          select: {
            category_localizations: { select: { locale: true, name: true } },
            code: true,
            id: true,
          },
          take,
          where: {
            ...(q
              ? {
                  OR: [
                    { code: { contains: q, mode: 'insensitive' as const } },
                    {
                      category_localizations: {
                        some: { name: { contains: q, mode: 'insensitive' as const } },
                      },
                    },
                  ],
                }
              : {}),
            deletedAt: null,
            storeId: request.storeId,
          },
        });
        const items = rows.slice(0, query.limit).map((row) => ({
          code: row.code,
          id: row.id,
          names: targetLookupNames(row.category_localizations),
        }));
        return {
          items,
          next_cursor: rows.length > query.limit ? (items.at(-1)?.id ?? null) : null,
        };
      }

      if (query.target_type === 'PRODUCT') {
        const rows = await transaction.product.findMany({
          ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
          orderBy: [{ code: 'asc' }, { id: 'asc' }],
          select: {
            code: true,
            id: true,
            product_localizations: { select: { locale: true, name: true } },
          },
          take,
          where: {
            ...(q
              ? {
                  OR: [
                    { code: { contains: q, mode: 'insensitive' as const } },
                    {
                      product_localizations: {
                        some: { name: { contains: q, mode: 'insensitive' as const } },
                      },
                    },
                  ],
                }
              : {}),
            deletedAt: null,
            storeId: request.storeId,
          },
        });
        const items = rows.slice(0, query.limit).map((row) => ({
          code: row.code,
          id: row.id,
          names: targetLookupNames(row.product_localizations),
        }));
        return {
          items,
          next_cursor: rows.length > query.limit ? (items.at(-1)?.id ?? null) : null,
        };
      }

      const rows = await transaction.sku.findMany({
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        orderBy: [{ code: 'asc' }, { id: 'asc' }],
        select: {
          code: true,
          id: true,
          products: {
            select: { product_localizations: { select: { locale: true, name: true } } },
          },
        },
        take,
        where: {
          ...(q
            ? {
                OR: [
                  { code: { contains: q, mode: 'insensitive' as const } },
                  {
                    products: {
                      product_localizations: {
                        some: { name: { contains: q, mode: 'insensitive' as const } },
                      },
                    },
                  },
                ],
              }
            : {}),
          products: { deletedAt: null },
          storeId: request.storeId,
        },
      });
      const items = rows.slice(0, query.limit).map((row) => ({
        code: row.code,
        id: row.id,
        names: targetLookupNames(row.products.product_localizations),
      }));
      return { items, next_cursor: rows.length > query.limit ? (items.at(-1)?.id ?? null) : null };
    });
  }

  public async createPromotion(request: PromotionsContext, code: string) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.promotions.manage',
    );
    try {
      return await withStoreTransaction(this.database, context, async (transaction) => {
        const promotion = await transaction.promotion.create({
          data: {
            code,
            createdByAdminId: context.actor.id,
            storeId: request.storeId,
            updatedByAdminId: context.actor.id,
          },
          include: this.promotionInclude(),
        });
        const after = promotionView(promotion);
        await this.admin.writeAudit(transaction, context, {
          action: 'promotion.created',
          after,
          targetId: promotion.id,
          targetType: 'promotion',
        });
        return after;
      });
    } catch (error) {
      if (isUniqueConflict(error)) throw new ConflictException('Promotion code conflict');
      throw error;
    }
  }

  public async listPromotionVersions(
    request: PromotionsContext,
    promotionId: string,
    query: PromotionListQuery,
  ) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.promotions.read',
    );
    return withStoreTransaction(this.database, context, async (transaction) => {
      const promotion = await transaction.promotion.findUnique({
        select: { id: true },
        where: { storeId_id: { id: promotionId, storeId: request.storeId } },
      });
      if (!promotion) throw new NotFoundException('Promotion not found');
      const rows = await transaction.promotionVersion.findMany({
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        include: versionInclude,
        orderBy: [{ versionNumber: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        where: { promotionId, storeId: request.storeId },
      });
      const hasMore = rows.length > query.limit;
      const items = rows.slice(0, query.limit);
      return {
        items: items.map(promotionVersionView),
        next_cursor: hasMore ? (items.at(-1)?.id ?? null) : null,
      };
    });
  }

  public async createPromotionVersion(
    request: PromotionsContext,
    promotionId: string,
    input: PromotionVersionInput,
  ) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.promotions.manage',
    );
    try {
      return await withStoreTransaction(this.database, context, async (transaction) => {
        const promotion = await transaction.promotion.findUnique({
          where: { storeId_id: { id: promotionId, storeId: request.storeId } },
        });
        if (!promotion) throw new NotFoundException('Promotion not found');
        if (promotion.status === 'ENDED') throw new ConflictException('PROMOTION_STATE_CONFLICT');
        if (promotion.version !== input.expected_promotion_version) {
          throw new ConflictException('VERSION_CONFLICT');
        }
        await this.assertTargets(transaction, request.storeId, input.targets);

        const existingDrafts = await transaction.promotionVersion.findMany({
          select: { id: true },
          where: { promotionId, status: 'DRAFT', storeId: request.storeId },
        });
        for (const draft of existingDrafts) {
          await transaction.promotionTarget.deleteMany({
            where: { promotionVersionId: draft.id, storeId: request.storeId },
          });
          await transaction.promotionVersionLocalization.deleteMany({
            where: { promotionVersionId: draft.id, storeId: request.storeId },
          });
        }
        await transaction.promotionVersion.deleteMany({
          where: { promotionId, status: 'DRAFT', storeId: request.storeId },
        });
        const latest = await transaction.promotionVersion.aggregate({
          _max: { versionNumber: true },
          where: { promotionId, storeId: request.storeId },
        });
        const benefit = this.benefitData(input);
        const created = await transaction.promotionVersion.create({
          data: {
            ...benefit,
            bucket: input.bucket,
            endsAt: input.ends_at,
            minimumQuantity: input.minimum_quantity,
            minimumSpendVnd: input.minimum_spend_vnd,
            priority: input.priority,
            promotionId,
            stackableWith: input.stackable_with,
            startsAt: input.starts_at,
            storeId: request.storeId,
            versionNumber: (latest._max.versionNumber ?? 0) + 1,
          },
        });
        await transaction.promotionVersionLocalization.createMany({
          data: input.localizations.map((item) => ({
            description: item.description,
            locale: item.locale,
            name: item.name,
            promotionVersionId: created.id,
            storeId: request.storeId,
          })),
        });
        await transaction.promotionTarget.createMany({
          data: input.targets.map((target) => this.targetData(request.storeId, created.id, target)),
        });
        const updatedPromotion = await transaction.promotion.updateMany({
          data: { updatedByAdminId: context.actor.id, version: { increment: 1 } },
          where: {
            id: promotionId,
            storeId: request.storeId,
            version: input.expected_promotion_version,
          },
        });
        if (updatedPromotion.count !== 1) throw new ConflictException('VERSION_CONFLICT');
        const version = await transaction.promotionVersion.findUniqueOrThrow({
          include: versionInclude,
          where: { storeId_id: { id: created.id, storeId: request.storeId } },
        });
        const after = promotionVersionView(version);
        await this.admin.writeAudit(transaction, context, {
          action: 'promotion.version.draft_created',
          after,
          targetId: version.id,
          targetType: 'promotion_version',
        });
        return after;
      });
    } catch (error) {
      if (isUniqueConflict(error)) throw new ConflictException('Promotion version conflict');
      throw error;
    }
  }

  public publishPromotion(
    request: PromotionsContext,
    promotionId: string,
    operationKey: string,
    input: PublishPromotionInput,
  ): Promise<Execution<ReturnType<typeof promotionView>>> {
    return this.executePromotionCommand(
      request,
      operationKey,
      'PUBLISH',
      promotionId,
      input,
      async (transaction, context) => {
        const before = await this.requirePromotion(transaction, request.storeId, promotionId);
        if (before.version !== input.expected_promotion_version) {
          throw new ConflictException('VERSION_CONFLICT');
        }
        const selected = await transaction.promotionVersion.findUnique({
          include: versionInclude,
          where: { storeId_id: { id: input.version_id, storeId: request.storeId } },
        });
        if (!selected || selected.promotionId !== promotionId) {
          throw new NotFoundException('Promotion version not found');
        }
        if (before.status === 'ENDED') throw new ConflictException('PROMOTION_STATE_CONFLICT');
        if (before.status === 'PAUSED' && selected.status === 'PUBLISHED') {
          if (before.activeVersionId !== selected.id) {
            throw new ConflictException('PROMOTION_STATE_CONFLICT');
          }
        } else if (selected.status !== 'DRAFT') {
          throw new ConflictException('PROMOTION_VERSION_STATE_CONFLICT');
        }
        const now = new Date();
        if (selected.status === 'DRAFT') {
          const published = await transaction.promotionVersion.updateMany({
            data: {
              publishedAt: now,
              publishedByAdminId: context.actor.id,
              status: 'PUBLISHED',
            },
            where: { id: selected.id, status: 'DRAFT', storeId: request.storeId },
          });
          if (published.count !== 1) throw new ConflictException('VERSION_CONFLICT');
        }
        const changed = await transaction.promotion.updateMany({
          data: {
            activeVersionId: selected.id,
            status: 'ACTIVE',
            updatedByAdminId: context.actor.id,
            version: { increment: 1 },
          },
          where: {
            id: promotionId,
            status: { in: ['DRAFT', 'ACTIVE', 'PAUSED'] },
            storeId: request.storeId,
            version: input.expected_promotion_version,
          },
        });
        if (changed.count !== 1) throw new ConflictException('VERSION_CONFLICT');
        const after = await this.requirePromotion(transaction, request.storeId, promotionId);
        await this.admin.writeAudit(transaction, context, {
          action: before.status === 'PAUSED' ? 'promotion.resumed' : 'promotion.published',
          after: promotionView(after),
          before: promotionView(before),
          targetId: promotionId,
          targetType: 'promotion',
        });
        return promotionView(after);
      },
    );
  }

  public pausePromotion(
    request: PromotionsContext,
    promotionId: string,
    operationKey: string,
    input: PromotionStateCommand & { confirmation_code: 'PAUSE' },
  ) {
    return this.changePromotionState(request, promotionId, operationKey, input, 'PAUSED');
  }

  public endPromotion(
    request: PromotionsContext,
    promotionId: string,
    operationKey: string,
    input: PromotionStateCommand & { confirmation_code: 'END' },
  ) {
    return this.changePromotionState(request, promotionId, operationKey, input, 'ENDED');
  }

  private changePromotionState(
    request: PromotionsContext,
    promotionId: string,
    operationKey: string,
    input: PromotionStateCommand,
    status: 'ENDED' | 'PAUSED',
  ) {
    return this.executePromotionCommand(
      request,
      operationKey,
      status === 'PAUSED' ? 'PAUSE' : 'END',
      promotionId,
      input,
      async (transaction, context) => {
        const before = await this.requirePromotion(transaction, request.storeId, promotionId);
        if (before.version !== input.expected_promotion_version) {
          throw new ConflictException('VERSION_CONFLICT');
        }
        if (before.status !== 'ACTIVE' && !(status === 'ENDED' && before.status === 'PAUSED')) {
          throw new ConflictException('PROMOTION_STATE_CONFLICT');
        }
        const changed = await transaction.promotion.updateMany({
          data: { status, updatedByAdminId: context.actor.id, version: { increment: 1 } },
          where: {
            id: promotionId,
            status: before.status,
            storeId: request.storeId,
            version: input.expected_promotion_version,
          },
        });
        if (changed.count !== 1) throw new ConflictException('VERSION_CONFLICT');
        const after = await this.requirePromotion(transaction, request.storeId, promotionId);
        await this.admin.writeAudit(transaction, context, {
          action: status === 'PAUSED' ? 'promotion.paused' : 'promotion.ended',
          after: promotionView(after),
          before: promotionView(before),
          targetId: promotionId,
          targetType: 'promotion',
        });
        return promotionView(after);
      },
    );
  }

  public async listCoupons(request: PromotionsContext, query: CouponListQuery) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.promotions.read',
    );
    return withStoreTransaction(this.database, context, async (transaction) => {
      const rows = await transaction.coupon.findMany({
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        where: { storeId: request.storeId },
      });
      const hasMore = rows.length > query.limit;
      const items = rows.slice(0, query.limit);
      return {
        items: items.map(couponView),
        next_cursor: hasMore ? (items.at(-1)?.id ?? null) : null,
      };
    });
  }

  public async createCoupon(request: PromotionsContext, input: CouponInput) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.promotions.manage',
    );
    try {
      return await withStoreTransaction(this.database, context, async (transaction) => {
        await this.requireCouponRule(transaction, request.storeId, input.promotion_version_id);
        const coupon = await transaction.coupon.create({
          data: {
            code: input.code,
            newCustomerOnly: input.new_customer_only,
            perMemberClaimLimit: input.per_member_claim_limit,
            promotionVersionId: input.promotion_version_id,
            storeId: request.storeId,
            totalClaimLimit: input.total_claim_limit,
          },
        });
        const after = couponView(coupon);
        await this.admin.writeAudit(transaction, context, {
          action: 'coupon.created',
          after,
          targetId: coupon.id,
          targetType: 'coupon',
        });
        return after;
      });
    } catch (error) {
      if (isUniqueConflict(error)) throw new ConflictException('Coupon code conflict');
      throw error;
    }
  }

  public async updateCoupon(
    request: PromotionsContext,
    couponId: string,
    input: CouponDraftUpdate,
  ) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.promotions.manage',
    );
    return withStoreTransaction(this.database, context, async (transaction) => {
      const before = await transaction.coupon.findUnique({
        where: { storeId_id: { id: couponId, storeId: request.storeId } },
      });
      if (!before) throw new NotFoundException('Coupon not found');
      if (before.status !== 'DRAFT') throw new ConflictException('COUPON_STATE_CONFLICT');
      if (before.version !== input.expected_version)
        throw new ConflictException('VERSION_CONFLICT');
      if (input.promotion_version_id !== undefined) {
        await this.requireCouponRule(transaction, request.storeId, input.promotion_version_id);
      }
      const changed = await transaction.coupon.updateMany({
        data: {
          ...(input.new_customer_only === undefined
            ? {}
            : { newCustomerOnly: input.new_customer_only }),
          ...(input.per_member_claim_limit === undefined
            ? {}
            : { perMemberClaimLimit: input.per_member_claim_limit }),
          ...(input.promotion_version_id === undefined
            ? {}
            : { promotionVersionId: input.promotion_version_id }),
          ...(input.total_claim_limit === undefined
            ? {}
            : { totalClaimLimit: input.total_claim_limit }),
          version: { increment: 1 },
        },
        where: {
          id: couponId,
          status: 'DRAFT',
          storeId: request.storeId,
          version: input.expected_version,
        },
      });
      if (changed.count !== 1) throw new ConflictException('VERSION_CONFLICT');
      const after = await transaction.coupon.findUniqueOrThrow({
        where: { storeId_id: { id: couponId, storeId: request.storeId } },
      });
      await this.admin.writeAudit(transaction, context, {
        action: 'coupon.draft_updated',
        after: couponView(after),
        before: couponView(before),
        targetId: couponId,
        targetType: 'coupon',
      });
      return couponView(after);
    });
  }

  public setCouponStatus(
    request: PromotionsContext,
    couponId: string,
    operationKey: string,
    input: CouponStatusCommand,
  ) {
    return this.executePromotionCommand(
      request,
      operationKey,
      `COUPON_${input.status}`,
      couponId,
      input,
      async (transaction, context) => {
        const before = await transaction.coupon.findUnique({
          where: { storeId_id: { id: couponId, storeId: request.storeId } },
        });
        if (!before) throw new NotFoundException('Coupon not found');
        if (before.version !== input.expected_version)
          throw new ConflictException('VERSION_CONFLICT');
        const allowed =
          (before.status === 'DRAFT' && input.status === 'ACTIVE') ||
          (before.status === 'ACTIVE' && ['PAUSED', 'ENDED'].includes(input.status)) ||
          (before.status === 'PAUSED' && ['ACTIVE', 'ENDED'].includes(input.status));
        if (!allowed) throw new ConflictException('COUPON_STATE_CONFLICT');
        if (input.status === 'ACTIVE') {
          await this.requireCouponRule(transaction, request.storeId, before.promotionVersionId);
        }
        const changed = await transaction.coupon.updateMany({
          data: { status: input.status, version: { increment: 1 } },
          where: {
            id: couponId,
            status: before.status,
            storeId: request.storeId,
            version: input.expected_version,
          },
        });
        if (changed.count !== 1) throw new ConflictException('VERSION_CONFLICT');
        const after = await transaction.coupon.findUniqueOrThrow({
          where: { storeId_id: { id: couponId, storeId: request.storeId } },
        });
        await this.admin.writeAudit(transaction, context, {
          action: `coupon.${input.status.toLowerCase()}`,
          after: couponView(after),
          before: couponView(before),
          targetId: couponId,
          targetType: 'coupon',
        });
        return couponView(after);
      },
      'coupon',
    );
  }

  private async executePromotionCommand<T>(
    request: PromotionsContext,
    operationKey: string,
    operationType: string,
    targetId: string,
    input: unknown,
    execute: (transaction: StoreTransaction, context: StoreContext) => Promise<T>,
    targetType = 'promotion',
  ): Promise<Execution<T>> {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.promotions.publish',
    );
    const hash = requestHash({ input, operationType, targetId, targetType });
    try {
      return await withStoreTransaction(this.database, context, async (transaction) => {
        await transaction.$executeRaw`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${`${request.storeId}:${operationKey}`}, 0)
          )
        `;
        const replayed = await this.findReplay<T>(transaction, request.storeId, operationKey, hash);
        if (replayed !== undefined) return { body: replayed, replayed: true };
        const body = await execute(transaction, context);
        await transaction.promotionOperation.create({
          data: {
            createdByAdminId: context.actor.id,
            operationKey,
            operationType,
            requestHash: hash,
            resultData: json(body),
            storeId: request.storeId,
            targetId,
            targetType,
          },
        });
        return { body, replayed: false };
      });
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      const body = await withStoreTransaction(this.database, context, (transaction) =>
        this.findReplay<T>(transaction, request.storeId, operationKey, hash),
      );
      if (body === undefined) throw new ConflictException('VERSION_CONFLICT');
      return { body, replayed: true };
    }
  }

  private async findReplay<T>(
    transaction: StoreTransaction,
    storeId: string,
    operationKey: string,
    hash: string,
  ): Promise<T | undefined> {
    const existing = await transaction.promotionOperation.findUnique({
      where: { storeId_operationKey: { operationKey, storeId } },
    });
    if (!existing) return undefined;
    if (existing.requestHash !== hash) throw new ConflictException('IDEMPOTENCY_KEY_REUSED');
    return existing.resultData as T;
  }

  private async requirePromotion(
    transaction: StoreTransaction,
    storeId: string,
    promotionId: string,
  ) {
    const promotion = await transaction.promotion.findUnique({
      include: this.promotionInclude(),
      where: { storeId_id: { id: promotionId, storeId } },
    });
    if (!promotion) throw new NotFoundException('Promotion not found');
    return promotion;
  }

  private async requireCouponRule(
    transaction: StoreTransaction,
    storeId: string,
    versionId: string,
  ) {
    const version = await transaction.promotionVersion.findUnique({
      include: { promotion: true },
      where: { storeId_id: { id: versionId, storeId } },
    });
    if (
      !version ||
      version.bucket !== 'COUPON' ||
      version.status !== 'PUBLISHED' ||
      version.promotion.status !== 'ACTIVE' ||
      version.promotion.activeVersionId !== version.id
    ) {
      throw new NotFoundException('Promotion version not found');
    }
    return version;
  }

  private benefitData(input: PromotionVersionInput) {
    if (input.benefit.method === 'FIXED_VND') {
      return {
        benefitMethod: input.benefit.method,
        fixedDiscountVnd: input.benefit.value,
        maximumDiscountVnd: null,
        percentageBps: null,
      } as const;
    }
    if (input.benefit.method === 'PERCENTAGE_BPS') {
      return {
        benefitMethod: input.benefit.method,
        fixedDiscountVnd: null,
        maximumDiscountVnd: input.benefit.maximum_discount_vnd,
        percentageBps: input.benefit.value,
      } as const;
    }
    return {
      benefitMethod: input.benefit.method,
      fixedDiscountVnd: null,
      maximumDiscountVnd: null,
      percentageBps: null,
    } as const;
  }

  private targetData(
    storeId: string,
    promotionVersionId: string,
    target: PromotionVersionInput['targets'][number],
  ) {
    return {
      ...(target.target_type === 'BRAND' ? { brandId: target.target_id } : {}),
      ...(target.target_type === 'CATEGORY' ? { categoryId: target.target_id } : {}),
      ...(target.target_type === 'PRODUCT' ? { productId: target.target_id } : {}),
      ...(target.target_type === 'SKU' ? { skuId: target.target_id } : {}),
      promotionVersionId,
      storeId,
      targetType: target.target_type,
    };
  }

  private async assertTargets(
    transaction: StoreTransaction,
    storeId: string,
    targets: PromotionVersionInput['targets'],
  ): Promise<void> {
    const ids = (type: string) =>
      targets.flatMap((target) =>
        target.target_type === type && target.target_id !== null ? [target.target_id] : [],
      );
    const brandIds = ids('BRAND');
    const categoryIds = ids('CATEGORY');
    const productIds = ids('PRODUCT');
    const skuIds = ids('SKU');
    const [brands, categories, products, skus] = await Promise.all([
      transaction.brand.count({ where: { id: { in: brandIds }, storeId } }),
      transaction.category.count({ where: { id: { in: categoryIds }, storeId } }),
      transaction.product.count({ where: { id: { in: productIds }, storeId } }),
      transaction.sku.count({ where: { id: { in: skuIds }, storeId } }),
    ]);
    if (
      brands !== brandIds.length ||
      categories !== categoryIds.length ||
      products !== productIds.length ||
      skus !== skuIds.length
    ) {
      throw new NotFoundException('Promotion target not found');
    }
  }
}
