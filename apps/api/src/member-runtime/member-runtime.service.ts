import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { RuntimeConfig } from '@zalo-shop/config';
import {
  Prisma,
  type PrismaClient,
  type StoreTransaction,
  withStoreTransaction,
} from '@zalo-shop/database';
import {
  createStoreContext,
  transitionPrivacyRequest,
  type Locale,
  type PrivacyRequestType,
} from '@zalo-shop/domain';
import type { MediaStorageProvider } from '@zalo-shop/integrations';
import { decryptSensitive, encryptSensitive } from '@zalo-shop/security';

import { AuthService } from '../auth/auth.service';
import { DATABASE_CLIENT, MEDIA_STORAGE_PROVIDER } from '../auth/auth.tokens';
import { RUNTIME_CONFIG } from '../health.controller';
import { SearchRateLimiter } from '../search/search-rate-limiter';
import { MemberRuntimeCursor, type MemberCursorResource } from './member-runtime-cursor';

type StoreRecord = { code: string; default_locale: Locale; id: string };
type MemberContext = Readonly<{
  context: ReturnType<typeof createStoreContext>;
  memberId: string;
  store: StoreRecord;
}>;
type MemberProductRow = {
  available: boolean;
  cursor_time: string;
  interaction_at: Date;
  name: string;
  object_key: string | null;
  product_code: string;
  product_id: string;
};
type PrivacyRow = {
  created_at: Date;
  cursor_time: string;
  description_ciphertext: string;
  id: string;
  public_number: string;
  status:
    | 'ACTION_REQUIRED'
    | 'CANCELLED'
    | 'COMPLETED'
    | 'IN_PROGRESS'
    | 'REJECTED'
    | 'SUBMITTED'
    | 'UNDER_REVIEW';
  type: PrivacyRequestType;
  updated_at: Date;
  version: number;
};

const MEMBER_READ_POLICY = {
  errorCode: 'Member read rate limit exceeded',
  maxRequests: 60,
  windowSeconds: 60,
} as const;
const MEMBER_WRITE_POLICY = {
  errorCode: 'Member write rate limit exceeded',
  maxRequests: 10,
  windowSeconds: 60,
} as const;
const PRIVACY_CANCEL_OPERATION = 'member.privacy.cancel';
const PRIVACY_MEMBER_CANCEL_REASON = 'MEMBER_CANCELLED_BEFORE_FULFILLMENT';
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function privacyPublicNumber(): string {
  return `PRV-${randomBytes(16).toString('hex').toUpperCase()}`;
}

@Injectable()
export class MemberRuntimeService {
  public constructor(
    @Inject(DATABASE_CLIENT) private readonly database: PrismaClient,
    @Inject(MEDIA_STORAGE_PROVIDER) private readonly mediaStorage: MediaStorageProvider,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(MemberRuntimeCursor) private readonly cursor: MemberRuntimeCursor,
    @Inject(SearchRateLimiter) private readonly rateLimiter: SearchRateLimiter,
  ) {}

  public async listFavorites(input: {
    address: string;
    authorization?: string;
    cursor?: string;
    limit: number;
    locale: Locale;
    storeCode: string;
  }) {
    const member = await this.memberContext(input.authorization, input.storeCode);
    await this.limit(member, input.address, 'READ');
    const cursor = this.cursor.decode(input.cursor, {
      locale: input.locale,
      memberId: member.memberId,
      resource: 'FAVORITES',
      storeId: member.store.id,
    });
    const rows = await withStoreTransaction(this.database, member.context, (transaction) =>
      transaction.$queryRaw<MemberProductRow[]>(Prisma.sql`
        SELECT
          favorite.product_id,
          product.code AS product_code,
          COALESCE(localized.name, vietnamese.name, product.code) AS name,
          favorite.created_at AS interaction_at,
          to_char(
            favorite.created_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ) AS cursor_time,
          media.object_key,
          (
            product.status = 'PUBLISHED'
            AND product.enabled = TRUE
            AND product.deleted_at IS NULL
            AND vietnamese.name IS NOT NULL
          ) AS available
        FROM member_favorites favorite
        JOIN products product
          ON product.store_id = favorite.store_id AND product.id = favorite.product_id
        LEFT JOIN product_localizations localized
          ON localized.store_id = product.store_id
         AND localized.product_id = product.id
         AND localized.locale = ${input.locale}::"Locale"
        LEFT JOIN product_localizations vietnamese
          ON vietnamese.store_id = product.store_id
         AND vietnamese.product_id = product.id
         AND vietnamese.locale = 'vi'
        LEFT JOIN LATERAL (
          SELECT asset.object_key
          FROM product_media product_media
          JOIN media_assets asset
            ON asset.store_id = product_media.store_id AND asset.id = product_media.media_id
          WHERE product_media.store_id = product.store_id
            AND product_media.product_id = product.id
            AND product_media.purpose = 'PRIMARY'
            AND asset.status = 'READY'
          ORDER BY product_media.sort_order ASC, product_media.media_id ASC
          LIMIT 1
        ) media ON TRUE
        WHERE favorite.store_id = ${member.store.id}::uuid
          AND favorite.member_id = ${member.memberId}::uuid
          AND (
            ${cursor?.sortKey ?? null}::timestamptz IS NULL
            OR (favorite.created_at, favorite.product_id) <
              (${cursor?.sortKey ?? null}::timestamptz, ${cursor?.sortId ?? null}::uuid)
          )
        ORDER BY favorite.created_at DESC, favorite.product_id DESC
        LIMIT ${input.limit + 1}
      `),
    );
    return this.productPage(rows, input.limit, member, input.locale, 'FAVORITES');
  }

  public async putFavorite(input: {
    address: string;
    authorization?: string;
    productCode: string;
    storeCode: string;
  }): Promise<void> {
    const member = await this.memberContext(input.authorization, input.storeCode);
    await this.limit(member, input.address, 'WRITE');
    await withStoreTransaction(this.database, member.context, async (transaction) => {
      const productId = await this.publicProductId(transaction, member.store.id, input.productCode);
      await transaction.memberFavorite.createMany({
        data: [{ memberId: member.memberId, productId, storeId: member.store.id }],
        skipDuplicates: true,
      });
    });
  }

  public async favoriteStatus(input: {
    address: string;
    authorization?: string;
    productCode: string;
    storeCode: string;
  }): Promise<{ favorited: boolean }> {
    const member = await this.memberContext(input.authorization, input.storeCode);
    await this.limit(member, input.address, 'READ');
    return withStoreTransaction(this.database, member.context, async (transaction) => {
      const favorite = await transaction.memberFavorite.findFirst({
        select: { productId: true },
        where: {
          memberId: member.memberId,
          product: { code: input.productCode },
          storeId: member.store.id,
        },
      });
      return { favorited: favorite !== null };
    });
  }

  public async deleteFavorite(input: {
    address: string;
    authorization?: string;
    productCode: string;
    storeCode: string;
  }): Promise<void> {
    const member = await this.memberContext(input.authorization, input.storeCode);
    await this.limit(member, input.address, 'WRITE');
    await withStoreTransaction(this.database, member.context, async (transaction) => {
      const product = await transaction.product.findFirst({
        select: { id: true },
        where: { code: input.productCode, storeId: member.store.id },
      });
      if (!product) return;
      await transaction.memberFavorite.deleteMany({
        where: { memberId: member.memberId, productId: product.id, storeId: member.store.id },
      });
    });
  }

  public async listProductHistory(input: {
    address: string;
    authorization?: string;
    cursor?: string;
    limit: number;
    locale: Locale;
    storeCode: string;
  }) {
    const member = await this.memberContext(input.authorization, input.storeCode);
    await this.limit(member, input.address, 'READ');
    const cursor = this.cursor.decode(input.cursor, {
      locale: input.locale,
      memberId: member.memberId,
      resource: 'PRODUCT_HISTORY',
      storeId: member.store.id,
    });
    const rows = await withStoreTransaction(this.database, member.context, (transaction) =>
      transaction.$queryRaw<MemberProductRow[]>(Prisma.sql`
        SELECT
          history.product_id,
          product.code AS product_code,
          COALESCE(localized.name, vietnamese.name, product.code) AS name,
          history.last_viewed_at AS interaction_at,
          to_char(
            history.last_viewed_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ) AS cursor_time,
          media.object_key,
          (
            product.status = 'PUBLISHED'
            AND product.enabled = TRUE
            AND product.deleted_at IS NULL
            AND vietnamese.name IS NOT NULL
          ) AS available
        FROM member_product_views history
        JOIN products product
          ON product.store_id = history.store_id AND product.id = history.product_id
        LEFT JOIN product_localizations localized
          ON localized.store_id = product.store_id
         AND localized.product_id = product.id
         AND localized.locale = ${input.locale}::"Locale"
        LEFT JOIN product_localizations vietnamese
          ON vietnamese.store_id = product.store_id
         AND vietnamese.product_id = product.id
         AND vietnamese.locale = 'vi'
        LEFT JOIN LATERAL (
          SELECT asset.object_key
          FROM product_media product_media
          JOIN media_assets asset
            ON asset.store_id = product_media.store_id AND asset.id = product_media.media_id
          WHERE product_media.store_id = product.store_id
            AND product_media.product_id = product.id
            AND product_media.purpose = 'PRIMARY'
            AND asset.status = 'READY'
          ORDER BY product_media.sort_order ASC, product_media.media_id ASC
          LIMIT 1
        ) media ON TRUE
        WHERE history.store_id = ${member.store.id}::uuid
          AND history.member_id = ${member.memberId}::uuid
          AND (
            ${cursor?.sortKey ?? null}::timestamptz IS NULL
            OR (history.last_viewed_at, history.product_id) <
              (${cursor?.sortKey ?? null}::timestamptz, ${cursor?.sortId ?? null}::uuid)
          )
        ORDER BY history.last_viewed_at DESC, history.product_id DESC
        LIMIT ${input.limit + 1}
      `),
    );
    return this.productPage(rows, input.limit, member, input.locale, 'PRODUCT_HISTORY');
  }

  public async touchProductHistory(input: {
    address: string;
    authorization?: string;
    productCode: string;
    storeCode: string;
  }): Promise<void> {
    const member = await this.memberContext(input.authorization, input.storeCode);
    await this.limit(member, input.address, 'WRITE');
    await withStoreTransaction(this.database, member.context, async (transaction) => {
      await transaction.$executeRaw`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${`${member.store.id}:${member.memberId}:product-history`}, 0)
        )
      `;
      const productId = await this.publicProductId(transaction, member.store.id, input.productCode);
      const now = new Date();
      await transaction.memberProductView.upsert({
        create: {
          firstViewedAt: now,
          lastViewedAt: now,
          memberId: member.memberId,
          productId,
          storeId: member.store.id,
        },
        update: { lastViewedAt: now },
        where: {
          storeId_memberId_productId: {
            memberId: member.memberId,
            productId,
            storeId: member.store.id,
          },
        },
      });
      await transaction.$executeRaw`
        DELETE FROM member_product_views
        WHERE store_id = ${member.store.id}::uuid
          AND member_id = ${member.memberId}::uuid
          AND product_id IN (
            SELECT product_id
            FROM member_product_views
            WHERE store_id = ${member.store.id}::uuid
              AND member_id = ${member.memberId}::uuid
            ORDER BY last_viewed_at DESC, product_id DESC
            OFFSET 100
          )
      `;
    });
  }

  public async deleteProductHistoryItem(input: {
    address: string;
    authorization?: string;
    productCode: string;
    storeCode: string;
  }): Promise<void> {
    const member = await this.memberContext(input.authorization, input.storeCode);
    await this.limit(member, input.address, 'WRITE');
    await withStoreTransaction(this.database, member.context, async (transaction) => {
      const product = await transaction.product.findFirst({
        select: { id: true },
        where: { code: input.productCode, storeId: member.store.id },
      });
      if (!product) return;
      await transaction.memberProductView.deleteMany({
        where: { memberId: member.memberId, productId: product.id, storeId: member.store.id },
      });
    });
  }

  public async clearProductHistory(input: {
    address: string;
    authorization?: string;
    idempotencyKey: string;
    storeCode: string;
  }): Promise<void> {
    const member = await this.memberContext(input.authorization, input.storeCode);
    await this.limit(member, input.address, 'WRITE');
    await withStoreTransaction(this.database, member.context, async (transaction) => {
      await transaction.$executeRaw`
        SELECT pg_advisory_xact_lock(
          hashtextextended(
            ${`${member.store.id}:${member.memberId}:history-clear:${hash(input.idempotencyKey)}`},
            0
          )
        )
      `;
      await transaction.memberProductView.deleteMany({
        where: { memberId: member.memberId, storeId: member.store.id },
      });
    });
  }

  public async summary(input: { address: string; authorization?: string; storeCode: string }) {
    const member = await this.memberContext(input.authorization, input.storeCode);
    await this.limit(member, input.address, 'READ');
    return withStoreTransaction(this.database, member.context, async (transaction) => {
      const [addressCount, favoriteCount, historyCount, couponRows, orderRows] = await Promise.all([
        transaction.address.count({
          where: { memberId: member.memberId, status: 'ACTIVE', storeId: member.store.id },
        }),
        transaction.memberFavorite.count({
          where: { memberId: member.memberId, storeId: member.store.id },
        }),
        transaction.memberProductView.count({
          where: { memberId: member.memberId, storeId: member.store.id },
        }),
        transaction.$queryRaw<Array<{ count: bigint }>>`
          SELECT COUNT(*)::bigint AS count
          FROM member_coupons member_coupon
          JOIN coupons coupon
            ON coupon.store_id = member_coupon.store_id AND coupon.id = member_coupon.coupon_id
          JOIN promotion_versions promotion_version
            ON promotion_version.store_id = coupon.store_id
           AND promotion_version.id = coupon.promotion_version_id
          JOIN promotions promotion
            ON promotion.store_id = promotion_version.store_id
           AND promotion.id = promotion_version.promotion_id
          WHERE member_coupon.store_id = ${member.store.id}::uuid
            AND member_coupon.member_id = ${member.memberId}::uuid
            AND member_coupon.status = 'CLAIMED'
            AND (member_coupon.expires_at IS NULL OR member_coupon.expires_at > CURRENT_TIMESTAMP)
            AND coupon.status = 'ACTIVE'
            AND promotion.status = 'ACTIVE'
            AND promotion.active_version_id = promotion_version.id
            AND promotion_version.status = 'PUBLISHED'
            AND promotion_version.starts_at <= CURRENT_TIMESTAMP
            AND (promotion_version.ends_at IS NULL OR promotion_version.ends_at > CURRENT_TIMESTAMP)
        `,
        transaction.order.groupBy({
          _count: { _all: true },
          by: ['status'],
          where: { memberId: member.memberId, storeId: member.store.id },
        }),
      ]);
      return {
        address_count: addressCount,
        favorite_count: favoriteCount,
        order_status_counts: Object.fromEntries(
          orderRows.map((row) => [row.status, row._count._all]),
        ),
        product_history_count: Math.min(100, historyCount),
        usable_coupon_count: Number(couponRows[0]?.count ?? 0n),
      };
    });
  }

  public async currentConsents(input: {
    address: string;
    authorization?: string;
    storeCode: string;
  }) {
    const member = await this.memberContext(input.authorization, input.storeCode);
    await this.limit(member, input.address, 'READ');
    return withStoreTransaction(this.database, member.context, async (transaction) => {
      const rows = await transaction.consent.findMany({
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        select: {
          occurredAt: true,
          policyVersion: true,
          purpose: true,
          source: true,
          status: true,
        },
        where: { memberId: member.memberId, storeId: member.store.id },
      });
      const latest = new Map<string, (typeof rows)[number]>();
      for (const row of rows) {
        if (!latest.has(row.purpose)) latest.set(row.purpose, row);
      }
      return {
        items: [...latest.values()]
          .sort((left, right) => left.purpose.localeCompare(right.purpose))
          .map((row) => ({
            occurred_at: row.occurredAt.toISOString(),
            policy_version: row.policyVersion,
            purpose: row.purpose,
            source: row.source,
            status: row.status,
          })),
      };
    });
  }

  public async listPrivacyRequests(input: {
    address: string;
    authorization?: string;
    cursor?: string;
    limit: number;
    storeCode: string;
  }) {
    const member = await this.memberContext(input.authorization, input.storeCode);
    await this.limit(member, input.address, 'READ');
    const cursor = this.cursor.decode(input.cursor, {
      locale: '-',
      memberId: member.memberId,
      resource: 'PRIVACY_REQUESTS',
      storeId: member.store.id,
    });
    const rows = await withStoreTransaction(this.database, member.context, (transaction) =>
      transaction.$queryRaw<PrivacyRow[]>(Prisma.sql`
        SELECT
          request.id,
          request.public_number,
          request.type,
          request.status,
          request.version,
          request.description_ciphertext,
          request.created_at,
          request.updated_at,
          to_char(
            request.created_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ) AS cursor_time
        FROM privacy_requests request
        WHERE request.store_id = ${member.store.id}::uuid
          AND request.member_id = ${member.memberId}::uuid
          AND (
            ${cursor?.sortKey ?? null}::timestamptz IS NULL
            OR (request.created_at, request.id) <
              (${cursor?.sortKey ?? null}::timestamptz, ${cursor?.sortId ?? null}::uuid)
          )
        ORDER BY request.created_at DESC, request.id DESC
        LIMIT ${input.limit + 1}
      `),
    );
    const visible = rows.slice(0, input.limit);
    const last = visible.at(-1);
    return {
      items: visible.map((row) => this.privacyView(row)),
      next_cursor:
        rows.length > input.limit && last
          ? this.cursor.encode({
              locale: '-',
              memberId: member.memberId,
              resource: 'PRIVACY_REQUESTS',
              sortId: last.id,
              sortKey: last.cursor_time,
              storeId: member.store.id,
            })
          : null,
    };
  }

  public async createPrivacyRequest(input: {
    address: string;
    authorization?: string;
    description: string;
    idempotencyKey: string;
    requestType: PrivacyRequestType;
    storeCode: string;
  }) {
    const member = await this.memberContext(input.authorization, input.storeCode);
    await this.limit(member, input.address, 'WRITE');
    const keyHash = hash(input.idempotencyKey);
    const requestHash = hash(
      JSON.stringify({ description: input.description, request_type: input.requestType }),
    );
    return withStoreTransaction(
      this.database,
      member.context,
      async (transaction) => {
        await transaction.$executeRaw`
          SELECT pg_advisory_xact_lock(
            hashtextextended(
              ${`${member.store.id}:${member.memberId}:privacy-create:${keyHash}`},
              0
            )
          )
        `;
        const existing = await transaction.privacyRequest.findUnique({
          where: {
            storeId_memberId_idempotencyKeyHash: {
              idempotencyKeyHash: keyHash,
              memberId: member.memberId,
              storeId: member.store.id,
            },
          },
        });
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new ConflictException('PRIVACY_REQUEST_IDEMPOTENCY_CONFLICT');
          }
          return this.privacyView(existing);
        }
        const created = await transaction.privacyRequest.create({
          data: {
            descriptionCiphertext: encryptSensitive(
              input.description,
              this.config.PII_ENCRYPTION_KEY,
            ),
            idempotencyKeyHash: keyHash,
            memberId: member.memberId,
            publicNumber: privacyPublicNumber(),
            requestHash,
            storeId: member.store.id,
            type: input.requestType,
          },
        });
        return this.privacyView(created);
      },
      { isolationLevel: 'Serializable' },
    );
  }

  public async getPrivacyRequest(input: {
    address: string;
    authorization?: string;
    requestNumber: string;
    storeCode: string;
  }) {
    const member = await this.memberContext(input.authorization, input.storeCode);
    await this.limit(member, input.address, 'READ');
    return withStoreTransaction(this.database, member.context, async (transaction) => {
      const request = await transaction.privacyRequest.findFirst({
        where: {
          memberId: member.memberId,
          publicNumber: input.requestNumber,
          storeId: member.store.id,
        },
      });
      if (!request) throw new NotFoundException('Privacy request not found');
      return this.privacyView(request);
    });
  }

  public async cancelPrivacyRequest(input: {
    address: string;
    authorization?: string;
    expectedVersion: number;
    idempotencyKey: string;
    reason: string;
    requestNumber: string;
    storeCode: string;
  }) {
    const member = await this.memberContext(input.authorization, input.storeCode);
    await this.limit(member, input.address, 'WRITE');
    const keyHash = hash(`${member.memberId}\u0000${input.idempotencyKey}`);
    const requestHash = hash(
      JSON.stringify({
        expected_version: input.expectedVersion,
        reason: input.reason,
        request_number: input.requestNumber,
      }),
    );
    return withStoreTransaction(
      this.database,
      member.context,
      async (transaction) => {
        await transaction.$executeRaw`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${`${member.store.id}:${PRIVACY_CANCEL_OPERATION}:${keyHash}`}, 0)
          )
        `;
        await transaction.idempotencyRecord.deleteMany({
          where: {
            expiresAt: { lte: new Date() },
            idempotencyKey: keyHash,
            operation: PRIVACY_CANCEL_OPERATION,
            storeId: member.store.id,
          },
        });
        const replay = await transaction.idempotencyRecord.findUnique({
          where: {
            storeId_operation_idempotencyKey: {
              idempotencyKey: keyHash,
              operation: PRIVACY_CANCEL_OPERATION,
              storeId: member.store.id,
            },
          },
        });
        if (replay) {
          if (replay.memberId !== member.memberId || replay.requestHash !== requestHash) {
            throw new ConflictException('PRIVACY_REQUEST_IDEMPOTENCY_CONFLICT');
          }
          const request = await this.lockedPrivacyRequest(
            transaction,
            member,
            input.requestNumber,
            false,
          );
          return this.privacyView(request);
        }
        let request = await this.lockedPrivacyRequest(
          transaction,
          member,
          input.requestNumber,
          true,
        );
        if (request.status !== 'CANCELLED') {
          if (request.version !== input.expectedVersion) {
            throw new ConflictException('PRIVACY_REQUEST_VERSION_CONFLICT');
          }
          let target: 'CANCELLED';
          try {
            target = transitionPrivacyRequest(request.status, 'CANCEL') as 'CANCELLED';
          } catch {
            throw new ConflictException('PRIVACY_REQUEST_STATE_CONFLICT');
          }
          await transaction.privacyRequestTransition.create({
            data: {
              actorId: member.memberId,
              actorType: 'MEMBER',
              correlationId: member.context.correlationId,
              event: 'CANCEL',
              fromStatus: request.status,
              memberId: member.memberId,
              privacyRequestId: request.id,
              reason: PRIVACY_MEMBER_CANCEL_REASON,
              storeId: member.store.id,
              toStatus: target,
            },
          });
          request = await this.lockedPrivacyRequest(
            transaction,
            member,
            input.requestNumber,
            false,
          );
        }
        await transaction.idempotencyRecord.create({
          data: {
            expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
            idempotencyKey: keyHash,
            memberId: member.memberId,
            operation: PRIVACY_CANCEL_OPERATION,
            requestHash,
            response: { request_number: input.requestNumber },
            storeId: member.store.id,
          },
        });
        return this.privacyView(request);
      },
      { isolationLevel: 'Serializable' },
    );
  }

  private async productPage(
    rows: MemberProductRow[],
    limit: number,
    member: MemberContext,
    locale: Locale,
    resource: Extract<MemberCursorResource, 'FAVORITES' | 'PRODUCT_HISTORY'>,
  ) {
    const visible = rows.slice(0, limit);
    const items = await Promise.all(
      visible.map(async (row) => ({
        available: row.available,
        last_interaction_at: row.interaction_at.toISOString(),
        name: row.name,
        primary_media_url:
          row.available && row.object_key
            ? (await this.mediaStorage.createReadUrl(row.object_key)).url
            : null,
        product_code: row.product_code,
      })),
    );
    const last = visible.at(-1);
    return {
      items,
      next_cursor:
        rows.length > limit && last
          ? this.cursor.encode({
              locale,
              memberId: member.memberId,
              resource,
              sortId: last.product_id,
              sortKey: last.cursor_time,
              storeId: member.store.id,
            })
          : null,
    };
  }

  private privacyView(request: {
    createdAt?: Date;
    created_at?: Date;
    descriptionCiphertext?: string;
    description_ciphertext?: string;
    publicNumber?: string;
    public_number?: string;
    status: PrivacyRow['status'];
    type: PrivacyRequestType;
    updatedAt?: Date;
    updated_at?: Date;
    version: number;
  }) {
    const description = request.descriptionCiphertext ?? request.description_ciphertext;
    const createdAt = request.createdAt ?? request.created_at;
    const updatedAt = request.updatedAt ?? request.updated_at;
    const publicNumber = request.publicNumber ?? request.public_number;
    if (!description || !createdAt || !updatedAt || !publicNumber) {
      throw new ServiceUnavailableException('PRIVACY_REQUEST_PROJECTION_INVALID');
    }
    return {
      created_at: createdAt.toISOString(),
      description: decryptSensitive(description, this.config.PII_ENCRYPTION_KEY),
      public_number: publicNumber,
      request_type: request.type,
      status: request.status,
      updated_at: updatedAt.toISOString(),
      version: request.version,
    };
  }

  private async lockedPrivacyRequest(
    transaction: StoreTransaction,
    member: MemberContext,
    requestNumber: string,
    lock: boolean,
  ) {
    if (lock) {
      await transaction.$executeRaw`
        SELECT pg_advisory_xact_lock(
          hashtextextended(
            ${`${member.store.id}:${member.memberId}:privacy-request:${requestNumber}`},
            0
          )
        )
      `;
    }
    const request = await transaction.privacyRequest.findFirst({
      where: {
        memberId: member.memberId,
        publicNumber: requestNumber,
        storeId: member.store.id,
      },
    });
    if (!request) throw new NotFoundException('Privacy request not found');
    return request;
  }

  private async publicProductId(
    transaction: StoreTransaction,
    storeId: string,
    productCode: string,
  ): Promise<string> {
    const product = await transaction.product.findFirst({
      select: { id: true },
      where: {
        code: productCode,
        deletedAt: null,
        enabled: true,
        product_localizations: { some: { locale: 'vi' } },
        status: 'PUBLISHED',
        storeId,
      },
    });
    if (!product) throw new NotFoundException('Product not found');
    return product.id;
  }

  private async limit(
    member: MemberContext,
    address: string,
    access: 'READ' | 'WRITE',
  ): Promise<void> {
    try {
      await this.rateLimiter.assertAllowed(
        address,
        access === 'READ' ? 'member-read' : 'member-write',
        member.store.id,
        member.memberId,
        access === 'READ' ? MEMBER_READ_POLICY : MEMBER_WRITE_POLICY,
      );
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('Member rate limiter is unavailable');
    }
  }

  private async memberContext(
    authorization: string | undefined,
    storeCode: string,
  ): Promise<MemberContext> {
    if (!authorization?.startsWith('Bearer ') || authorization.length <= 7) {
      throw new UnauthorizedException('Member authentication is required');
    }
    const claims = await this.auth.authenticateAccessToken(authorization.slice(7), storeCode);
    if (claims.actorType !== 'member' || !claims.storeId) {
      throw new UnauthorizedException('Member authentication is required');
    }
    const stores = await this.database.$queryRaw<StoreRecord[]>`
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
