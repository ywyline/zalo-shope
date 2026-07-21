import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { MemberCouponListQuery } from '@zalo-shop/contracts';
import { Prisma, type Locale, type PrismaClient, withStoreTransaction } from '@zalo-shop/database';
import { createStoreContext } from '@zalo-shop/domain';

import { AuthService } from '../auth/auth.service';
import { DATABASE_CLIENT } from '../auth/auth.tokens';
import { SearchRateLimiter } from '../search/search-rate-limiter';

type ResolvedStore = { code: string; default_locale: Locale; id: string };
type CouponCursor = { claimed_at: string; id: string; v: 1 };
type MemberCouponRow = {
  claimed_at: Date;
  code: string;
  effective_status: 'CLAIMED' | 'DISABLED' | 'EXPIRED';
  expires_at: Date | null;
  id: string;
};

function decodeCursor(value: string | undefined): CouponCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as CouponCursor;
    if (
      parsed.v !== 1 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        parsed.id,
      ) ||
      Number.isNaN(Date.parse(parsed.claimed_at))
    ) {
      throw new Error('invalid');
    }
    return parsed;
  } catch {
    throw new BadRequestException('Cursor is invalid');
  }
}

function encodeCursor(row: MemberCouponRow): string {
  return Buffer.from(
    JSON.stringify({ claimed_at: row.claimed_at.toISOString(), id: row.id, v: 1 }),
    'utf8',
  ).toString('base64url');
}

function view(row: MemberCouponRow) {
  return {
    claimed_at: row.claimed_at.toISOString(),
    code: row.code,
    expires_at: row.expires_at?.toISOString() ?? null,
    id: row.id,
    status: row.effective_status,
  };
}

@Injectable()
export class MemberCouponService {
  public constructor(
    @Inject(DATABASE_CLIENT) private readonly database: PrismaClient,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SearchRateLimiter) private readonly rateLimiter: SearchRateLimiter,
  ) {}

  public async list(input: {
    authorization: string | undefined;
    query: MemberCouponListQuery;
    storeCode: string;
  }) {
    const { context, memberId, store } = await this.memberContext(
      input.authorization,
      input.storeCode,
    );
    const cursor = decodeCursor(input.query.cursor);
    const status = input.query.status;
    return withStoreTransaction(this.database, context, async (transaction) => {
      const rows = await transaction.$queryRaw<MemberCouponRow[]>(Prisma.sql`
        WITH member_coupon_view AS (
          SELECT
            mc.id,
            c.code,
            mc.claimed_at,
            mc.expires_at,
            CASE
              WHEN mc.status = 'DISABLED'
                OR c.status <> 'ACTIVE'
                OR p.status <> 'ACTIVE'
                OR p.active_version_id IS DISTINCT FROM pv.id
                THEN 'DISABLED'
              WHEN mc.status = 'EXPIRED' OR (mc.expires_at IS NOT NULL AND mc.expires_at <= CURRENT_TIMESTAMP)
                THEN 'EXPIRED'
              ELSE 'CLAIMED'
            END AS effective_status
          FROM member_coupons mc
          JOIN coupons c ON c.store_id = mc.store_id AND c.id = mc.coupon_id
          JOIN promotion_versions pv
            ON pv.store_id = c.store_id AND pv.id = c.promotion_version_id
          JOIN promotions p
            ON p.store_id = pv.store_id AND p.id = pv.promotion_id
          WHERE mc.store_id = ${store.id}::uuid AND mc.member_id = ${memberId}::uuid
        )
        SELECT id, code, claimed_at, expires_at, effective_status
        FROM member_coupon_view
        WHERE (${status ?? null}::text IS NULL OR effective_status = ${status ?? null}::text)
          AND (
            ${cursor?.claimed_at ?? null}::timestamptz IS NULL
            OR (claimed_at, id) < (${cursor?.claimed_at ?? null}::timestamptz, ${cursor?.id ?? null}::uuid)
          )
        ORDER BY claimed_at DESC, id DESC
        LIMIT ${input.query.limit + 1}
      `);
      const items = rows.slice(0, input.query.limit);
      return {
        items: items.map(view),
        next_cursor: rows.length > input.query.limit ? encodeCursor(items.at(-1)!) : null,
      };
    });
  }

  public async claim(input: {
    authorization: string | undefined;
    address: string;
    couponCode: string;
    storeCode: string;
  }) {
    await this.rateLimiter.assertAllowed(input.address, 'coupon-claim');
    const { context, memberId, store } = await this.memberContext(
      input.authorization,
      input.storeCode,
    );
    return withStoreTransaction(this.database, context, async (transaction) => {
      const locked = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id FROM coupons
        WHERE store_id = ${store.id}::uuid AND code = ${input.couponCode}
        FOR UPDATE
      `);
      if (!locked[0]) throw new NotFoundException('Coupon not found');

      const coupon = await transaction.coupon.findUnique({
        include: { promotionVersion: { include: { promotion: true } } },
        where: { storeId_id: { id: locked[0].id, storeId: store.id } },
      });
      if (!coupon) throw new NotFoundException('Coupon not found');
      const existing = await transaction.memberCoupon.findUnique({
        include: { coupon: true },
        where: {
          storeId_couponId_memberId: { couponId: coupon.id, memberId, storeId: store.id },
        },
      });
      if (existing) {
        return view({
          claimed_at: existing.claimedAt,
          code: existing.coupon.code,
          effective_status:
            existing.status === 'DISABLED' ||
            existing.coupon.status !== 'ACTIVE' ||
            coupon.promotionVersion.promotion.status !== 'ACTIVE' ||
            coupon.promotionVersion.promotion.activeVersionId !== coupon.promotionVersion.id
              ? 'DISABLED'
              : existing.status === 'EXPIRED' ||
                  (existing.expiresAt !== null && existing.expiresAt <= new Date())
                ? 'EXPIRED'
                : 'CLAIMED',
          expires_at: existing.expiresAt,
          id: existing.id,
        });
      }

      const nowRows = await transaction.$queryRaw<Array<{ quoted_at: Date }>>`
        SELECT CURRENT_TIMESTAMP AS quoted_at
      `;
      const now = nowRows[0]!.quoted_at;
      const version = coupon.promotionVersion;
      if (
        coupon.status !== 'ACTIVE' ||
        version.status !== 'PUBLISHED' ||
        version.bucket !== 'COUPON' ||
        version.startsAt > now ||
        (version.endsAt !== null && version.endsAt <= now) ||
        version.promotion.status !== 'ACTIVE' ||
        version.promotion.activeVersionId !== version.id
      ) {
        throw new ConflictException('COUPON_INVALID');
      }
      if (coupon.totalClaimLimit !== null && coupon.claimedCount >= coupon.totalClaimLimit) {
        throw new ConflictException('COUPON_CLAIM_LIMIT');
      }

      // M3 has no order facts yet. Every authenticated member is provisionally new;
      // M4 replaces this branch with a same-store completed-order query.
      if (coupon.newCustomerOnly && !memberId) {
        throw new ConflictException('MEMBER_INELIGIBLE');
      }
      const created = await transaction.memberCoupon.create({
        data: {
          couponId: coupon.id,
          expiresAt: version.endsAt,
          memberId,
          storeId: store.id,
        },
      });
      const incremented = await transaction.coupon.updateMany({
        data: { claimedCount: { increment: 1 } },
        where: {
          id: coupon.id,
          storeId: store.id,
          ...(coupon.totalClaimLimit === null
            ? {}
            : { claimedCount: { lt: coupon.totalClaimLimit } }),
        },
      });
      if (incremented.count !== 1) throw new ConflictException('COUPON_CLAIM_LIMIT');
      return view({
        claimed_at: created.claimedAt,
        code: coupon.code,
        effective_status: 'CLAIMED',
        expires_at: created.expiresAt,
        id: created.id,
      });
    });
  }

  private async memberContext(authorization: string | undefined, storeCode: string) {
    if (!authorization?.startsWith('Bearer ') || authorization.length <= 7) {
      throw new UnauthorizedException('Member authentication is required');
    }
    const claims = await this.auth.authenticateAccessToken(authorization.slice(7), storeCode);
    if (claims.actorType !== 'member' || !claims.storeId) {
      throw new UnauthorizedException('Member authentication is required');
    }
    const stores = await this.database.$queryRaw<ResolvedStore[]>`
      SELECT * FROM app_security.resolve_active_store(${storeCode.trim()})
    `;
    const store = stores[0];
    if (!store || store.id !== claims.storeId) {
      throw new UnauthorizedException('Store context is invalid');
    }
    return {
      context: createStoreContext({
        actor: { id: claims.subjectId, type: 'member' },
        correlationId: randomUUID(),
        locale: store.default_locale,
        storeCode: store.code,
        storeId: store.id,
      }),
      memberId: claims.subjectId,
      store,
    };
  }
}
