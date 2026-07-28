import { Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type {
  AdminAfterSaleListQuery,
  AfterSaleAdminReadQuery,
  AfterSaleListQuery,
  AfterSalePageResponse,
  AfterSaleResponse,
} from '@zalo-shop/contracts';
import { afterSalePageResponseSchema } from '@zalo-shop/contracts';
import {
  Prisma,
  type PrismaClient,
  type StoreTransaction,
  withStoreTransaction,
} from '@zalo-shop/database';
import { createStoreContext, type StoreContext } from '@zalo-shop/domain';
import { resolveCorrelationId } from '@zalo-shop/logger';

import { AdminService, type AdminHeaders } from '../admin/admin.service';
import { AuthService } from '../auth/auth.service';
import { DATABASE_CLIENT } from '../auth/auth.tokens';
import { AfterSalesCursor, hashAfterSaleCursorFilters } from './after-sales-cursor';
import {
  AfterSalesProjector,
  createAfterSaleReadSelect,
  type AfterSaleLocale,
  type AfterSaleReadRecord,
} from './after-sales-projector';
import { AfterSalesRateLimiter } from './after-sales-rate-limiter';

type ResolvedStore = { code: string; default_locale: AfterSaleLocale; id: string };
type PageKey = { id: string; sort_key: string };
type DecodedPageKey = { sortId: string; sortKey: string };

class AfterSaleReadIntegrityError extends Error {
  public constructor() {
    super('After-sale read projection integrity failed');
    this.name = 'AfterSaleReadIntegrityError';
  }
}

@Injectable()
export class AfterSalesService {
  public constructor(
    @Inject(DATABASE_CLIENT) private readonly database: PrismaClient,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AdminService) private readonly admin: AdminService,
    @Inject(AfterSalesCursor) private readonly cursors: AfterSalesCursor,
    @Inject(AfterSalesProjector) private readonly projector: AfterSalesProjector,
    @Inject(AfterSalesRateLimiter) private readonly rateLimiter: AfterSalesRateLimiter,
  ) {}

  public async memberList(input: {
    authorization?: string;
    correlationId: string;
    query: AfterSaleListQuery;
    storeCode: string;
  }): Promise<AfterSalePageResponse> {
    const context = await this.memberContext(input);
    await this.rateLimiter.consume({
      actorId: context.actor.id,
      actorType: 'MEMBER',
      storeId: context.storeId,
    });
    return withStoreTransaction(
      this.database,
      context,
      async (transaction) => {
        const locale = await this.memberLocale(transaction, context);
        const filtersHash = hashAfterSaleCursorFilters({
          locale,
          sort: 'created_at_desc_id_desc_v1',
          status: input.query.status ?? null,
          type: input.query.type ?? null,
        });
        const cursor = input.query.cursor
          ? this.cursors.decode(input.query.cursor, {
              filters_hash: filtersHash,
              resource: 'MEMBER_AFTER_SALES',
              store_id: context.storeId,
              subject_id: context.actor.id,
              subject_type: 'MEMBER',
            })
          : null;
        const pageKeys = await this.memberPageKeys(transaction, {
          cursor,
          limit: input.query.limit,
          memberId: context.actor.id,
          status: input.query.status,
          storeId: context.storeId,
          type: input.query.type,
        });
        return this.page(transaction, {
          filtersHash,
          limit: input.query.limit,
          locale,
          memberId: context.actor.id,
          pageKeys,
          resource: 'MEMBER_AFTER_SALES',
          storeId: context.storeId,
          subjectId: context.actor.id,
          subjectType: 'MEMBER',
        });
      },
      { isolationLevel: 'RepeatableRead', timeout: 15_000 },
    );
  }

  public async memberDetail(input: {
    afterSaleId: string;
    authorization?: string;
    correlationId: string;
    storeCode: string;
  }): Promise<AfterSaleResponse> {
    const context = await this.memberContext(input);
    await this.rateLimiter.consume({
      actorId: context.actor.id,
      actorType: 'MEMBER',
      storeId: context.storeId,
    });
    return withStoreTransaction(
      this.database,
      context,
      async (transaction) => {
        const locale = await this.memberLocale(transaction, context);
        const record = await transaction.afterSale.findFirst({
          select: createAfterSaleReadSelect(locale),
          where: {
            id: input.afterSaleId,
            memberId: context.actor.id,
            storeId: context.storeId,
          },
        });
        if (!record) throw new NotFoundException('Resource not found');
        this.assertScope(record, context.storeId, context.actor.id);
        return this.projector.project(record, locale);
      },
      { isolationLevel: 'RepeatableRead', timeout: 15_000 },
    );
  }

  public async adminList(input: {
    headers: AdminHeaders;
    query: AdminAfterSaleListQuery;
  }): Promise<AfterSalePageResponse> {
    const context = await this.admin.authorize(
      input.headers,
      input.query.store_id,
      'store.after-sales.read',
    );
    await this.rateLimiter.consume({
      actorId: context.actor.id,
      actorType: 'ADMIN',
      storeId: context.storeId,
    });
    const locale = input.query.locale ?? context.locale ?? 'vi';
    return withStoreTransaction(
      this.database,
      context,
      async (transaction) => {
        const filtersHash = hashAfterSaleCursorFilters({
          locale,
          member_id: input.query.member_id ?? null,
          order_id: input.query.order_id ?? null,
          sort: 'updated_at_desc_id_desc_v1',
          status: input.query.status ?? null,
          type: input.query.type ?? null,
        });
        const cursor = input.query.cursor
          ? this.cursors.decode(input.query.cursor, {
              filters_hash: filtersHash,
              resource: 'ADMIN_AFTER_SALES',
              store_id: context.storeId,
              subject_id: context.actor.id,
              subject_type: 'ADMIN',
            })
          : null;
        const pageKeys = await this.adminPageKeys(transaction, {
          cursor,
          limit: input.query.limit,
          memberId: input.query.member_id,
          orderId: input.query.order_id,
          status: input.query.status,
          storeId: context.storeId,
          type: input.query.type,
        });
        return this.page(transaction, {
          filtersHash,
          limit: input.query.limit,
          locale,
          pageKeys,
          resource: 'ADMIN_AFTER_SALES',
          storeId: context.storeId,
          subjectId: context.actor.id,
          subjectType: 'ADMIN',
        });
      },
      { isolationLevel: 'RepeatableRead', timeout: 15_000 },
    );
  }

  public async adminDetail(input: {
    afterSaleId: string;
    headers: AdminHeaders;
    query: AfterSaleAdminReadQuery;
  }): Promise<AfterSaleResponse> {
    const context = await this.admin.authorize(
      input.headers,
      input.query.store_id,
      'store.after-sales.read',
    );
    await this.rateLimiter.consume({
      actorId: context.actor.id,
      actorType: 'ADMIN',
      storeId: context.storeId,
    });
    const locale = input.query.locale ?? context.locale ?? 'vi';
    return withStoreTransaction(
      this.database,
      context,
      async (transaction) => {
        const record = await transaction.afterSale.findFirst({
          select: createAfterSaleReadSelect(locale),
          where: { id: input.afterSaleId, storeId: context.storeId },
        });
        if (!record) throw new NotFoundException('Resource not found');
        this.assertScope(record, context.storeId);
        return this.projector.project(record, locale);
      },
      { isolationLevel: 'RepeatableRead', timeout: 15_000 },
    );
  }

  private async page(
    transaction: StoreTransaction,
    input: {
      filtersHash: string;
      limit: number;
      locale: AfterSaleLocale;
      memberId?: string;
      pageKeys: PageKey[];
      resource: 'ADMIN_AFTER_SALES' | 'MEMBER_AFTER_SALES';
      storeId: string;
      subjectId: string;
      subjectType: 'ADMIN' | 'MEMBER';
    },
  ): Promise<AfterSalePageResponse> {
    const hasMore = input.pageKeys.length > input.limit;
    const visibleKeys = input.pageKeys.slice(0, input.limit);
    const ids = visibleKeys.map((item) => item.id);
    const rows =
      ids.length === 0
        ? []
        : await transaction.afterSale.findMany({
            select: createAfterSaleReadSelect(input.locale),
            where: {
              id: { in: ids },
              ...(input.memberId === undefined ? {} : { memberId: input.memberId }),
              storeId: input.storeId,
            },
          });
    const byId = new Map<string, AfterSaleReadRecord>(rows.map((row) => [row.id, row]));
    const now = new Date();
    const items = visibleKeys.map((key) => {
      const record = byId.get(key.id);
      if (!record) throw new AfterSaleReadIntegrityError();
      this.assertScope(record, input.storeId, input.memberId);
      return this.projector.project(record, input.locale, now);
    });
    const last = visibleKeys.at(-1);
    const nextCursor =
      hasMore && last
        ? this.cursors.encode({
            filters_hash: input.filtersHash,
            resource: input.resource,
            sort_id: last.id,
            sort_key: last.sort_key,
            store_id: input.storeId,
            subject_id: input.subjectId,
            subject_type: input.subjectType,
          })
        : null;
    return afterSalePageResponseSchema.parse({ items, next_cursor: nextCursor });
  }

  private async memberPageKeys(
    transaction: StoreTransaction,
    input: {
      cursor: DecodedPageKey | null;
      limit: number;
      memberId: string;
      status?: string;
      storeId: string;
      type?: string;
    },
  ): Promise<PageKey[]> {
    const predicates: Prisma.Sql[] = [
      Prisma.sql`a.store_id = ${input.storeId}::uuid`,
      Prisma.sql`a.member_id = ${input.memberId}::uuid`,
    ];
    if (input.status) {
      predicates.push(Prisma.sql`a.status = ${input.status}::"after_sale_status"`);
    }
    if (input.type) {
      predicates.push(Prisma.sql`a.type = ${input.type}::"after_sale_type"`);
    }
    if (input.cursor) {
      predicates.push(
        Prisma.sql`(a.created_at, a.id) < (${input.cursor.sortKey}::timestamptz, ${input.cursor.sortId}::uuid)`,
      );
    }
    return transaction.$queryRaw<PageKey[]>(Prisma.sql`
      SELECT
        a.id,
        to_char(
          a.created_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) AS sort_key
      FROM after_sales AS a
      WHERE ${Prisma.join(predicates, ' AND ')}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ${input.limit + 1}
    `);
  }

  private async adminPageKeys(
    transaction: StoreTransaction,
    input: {
      cursor: DecodedPageKey | null;
      limit: number;
      memberId?: string;
      orderId?: string;
      status?: string;
      storeId: string;
      type?: string;
    },
  ): Promise<PageKey[]> {
    const predicates: Prisma.Sql[] = [Prisma.sql`a.store_id = ${input.storeId}::uuid`];
    if (input.orderId) {
      predicates.push(Prisma.sql`a.order_id = ${input.orderId}::uuid`);
    }
    if (input.memberId) {
      predicates.push(Prisma.sql`a.member_id = ${input.memberId}::uuid`);
    }
    if (input.status) {
      predicates.push(Prisma.sql`a.status = ${input.status}::"after_sale_status"`);
    }
    if (input.type) {
      predicates.push(Prisma.sql`a.type = ${input.type}::"after_sale_type"`);
    }
    if (input.cursor) {
      predicates.push(
        Prisma.sql`(a.updated_at, a.id) < (${input.cursor.sortKey}::timestamptz, ${input.cursor.sortId}::uuid)`,
      );
    }
    return transaction.$queryRaw<PageKey[]>(Prisma.sql`
      SELECT
        a.id,
        to_char(
          a.updated_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) AS sort_key
      FROM after_sales AS a
      WHERE ${Prisma.join(predicates, ' AND ')}
      ORDER BY a.updated_at DESC, a.id DESC
      LIMIT ${input.limit + 1}
    `);
  }

  private async memberLocale(
    transaction: StoreTransaction,
    context: StoreContext,
  ): Promise<AfterSaleLocale> {
    const member = await transaction.member.findFirst({
      select: { preferredLocale: true },
      where: { id: context.actor.id, storeId: context.storeId },
    });
    if (!member) throw new UnauthorizedException('Member authentication is required');
    return member.preferredLocale ?? 'vi';
  }

  private assertScope(record: AfterSaleReadRecord, storeId: string, memberId?: string): void {
    if (record.storeId !== storeId || (memberId !== undefined && record.memberId !== memberId)) {
      throw new AfterSaleReadIntegrityError();
    }
  }

  private async memberContext(input: {
    authorization?: string;
    correlationId: string;
    storeCode: string;
  }): Promise<StoreContext> {
    if (!input.authorization?.startsWith('Bearer ') || input.authorization.length <= 7) {
      throw new UnauthorizedException('Member authentication is required');
    }
    const correlationId = resolveCorrelationId(input.correlationId);
    const storeCode = input.storeCode.trim();
    const principal = await this.auth.authenticateAccessToken(
      input.authorization.slice(7),
      storeCode,
      correlationId,
    );
    if (principal.actorType !== 'member' || !principal.storeId) {
      throw new UnauthorizedException('Member authentication is required');
    }
    const stores = await this.database.$queryRaw<ResolvedStore[]>`
      SELECT * FROM app_security.resolve_active_store(${storeCode})
    `;
    const store = stores[0];
    if (!store || store.id !== principal.storeId) {
      throw new UnauthorizedException('Store context is invalid');
    }
    return createStoreContext({
      actor: { id: principal.subjectId, type: 'member' },
      correlationId,
      locale: store.default_locale,
      storeCode: store.code,
      storeId: store.id,
    });
  }
}
