import { createHash } from 'node:crypto';

import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  afterSalePolicyContentSchema,
  afterSalePolicyDetailResponseSchema,
  afterSalePolicyDisableSchema,
  afterSalePolicyDraftSchema,
  afterSalePolicyPageResponseSchema,
  afterSalePolicySummaryResponseSchema,
  afterSalePolicyPublishSchema,
  afterSalePolicyVersionPageResponseSchema,
  afterSalePolicyVersionResponseSchema,
  type AfterSalePolicyDetailResponse,
  type AfterSalePolicyDisable,
  type AfterSalePolicyDraft,
  type AfterSalePolicyListQuery,
  type AfterSalePolicyPageResponse,
  type AfterSalePolicyPublish,
  type AfterSalePolicySummaryResponse,
  type AfterSalePolicyVersionListQuery,
  type AfterSalePolicyVersionPageResponse,
  type AfterSalePolicyVersionResponse,
} from '@zalo-shop/contracts';
import {
  AfterSalePolicyManagementError,
  afterSalePolicyContentHash,
  canonicalizeAfterSalePolicyContent,
  disableAfterSalePolicyInTransaction,
  Prisma,
  publishAfterSalePolicyInTransaction,
  putAfterSalePolicyDraftInTransaction,
  type PrismaClient,
  type StoreTransaction,
  withStoreTransaction,
} from '@zalo-shop/database';
import type { StoreContext } from '@zalo-shop/domain';
import { redactSensitiveData } from '@zalo-shop/logger';

import { AdminService, type AdminHeaders } from '../admin/admin.service';
import { DATABASE_CLIENT } from '../auth/auth.tokens';
import { AfterSalesCursor, hashAfterSaleCursorFilters } from '../after-sales/after-sales-cursor';
import { AfterSalesRateLimiter } from '../after-sales/after-sales-rate-limiter';

type PageKey = { id: string; sort_key: string };
type DecodedPageKey = { sortId: string; sortKey: string };
type PolicyCommandResult<T> = { body: T; replayed: boolean };
const policyVersionRelations = { assignments: true, localizations: true } as const;
type PolicyVersionRecord = {
  allowedTypes: readonly string[];
  assignments: ReadonlyArray<{
    categoryId: string | null;
    policyId: string;
    policyVersionId: string;
    productId: string | null;
    storeId: string;
    targetType: 'CATEGORY' | 'PRODUCT' | 'STORE_DEFAULT';
  }>;
  conditionRules: Prisma.JsonValue;
  damagedException: boolean;
  defectException: boolean;
  effectiveAt: Date;
  exchangeAttributeCode: string | null;
  exchangeSameProductOnly: boolean;
  hygieneRestricted: boolean;
  id: string;
  localizations: ReadonlyArray<{
    buyerInstructions: string;
    locale: 'en' | 'vi' | 'zh';
    name: string;
    storeId: string;
    summary: string;
  }>;
  payload: Prisma.JsonValue;
  payloadHash: string;
  policyId: string;
  publishedAt: Date;
  requestWindowDays: number;
  returnShippingPayer: 'BUYER' | 'CONDITIONAL' | 'MERCHANT';
  returnWindowDays: number;
  storeId: string;
  unopenedRequired: boolean;
  versionNumber: number;
  wrongItemException: boolean;
};

class AfterSalePolicyProjectionError extends Error {
  public constructor() {
    super('After-sale policy projection integrity failed');
    this.name = 'AfterSalePolicyProjectionError';
  }
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

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function databaseErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const record = error as { code?: unknown; meta?: unknown };
  if (record.code === 'P2010' && record.meta !== null && typeof record.meta === 'object') {
    const databaseCode = (record.meta as { code?: unknown }).code;
    if (typeof databaseCode === 'string') return databaseCode;
  }
  return typeof record.code === 'string' ? record.code : undefined;
}

function isRetryableTransactionConflict(error: unknown): boolean {
  return ['40001', '40P01', 'P2034'].includes(databaseErrorCode(error) ?? '');
}

function isUniqueConstraintConflict(error: unknown): boolean {
  return ['23505', 'P2002'].includes(databaseErrorCode(error) ?? '');
}

function isActiveTargetConstraintConflict(error: unknown): boolean {
  if (!isUniqueConstraintConflict(error) || error === null || typeof error !== 'object') {
    return false;
  }
  const meta = (error as { meta?: unknown }).meta;
  if (meta === undefined) return false;
  if (meta !== null && typeof meta === 'object') {
    const record = meta as { modelName?: unknown; target?: unknown };
    const target = Array.isArray(record.target) ? record.target : null;
    if (
      record.modelName === 'AfterSaleActivePolicyAssignment' &&
      target !== null &&
      target.every((field): field is string => typeof field === 'string') &&
      [['store_id'], ['store_id', 'category_id'], ['store_id', 'product_id']].some(
        (expected) => canonicalJson(target) === canonicalJson(expected),
      )
    ) {
      return true;
    }
  }
  const serializedMeta = canonicalJson(meta).toLowerCase();
  return [
    'after_sale_active_policy_assignments_target_key',
    'after_sale_active_policy_assignments_product_key',
    'after_sale_active_policy_assignments_category_key',
    'after_sale_active_policy_assignments_default_key',
  ].some((constraint) => serializedMeta.includes(constraint));
}

@Injectable()
export class AfterSalesPolicyManagementService {
  public constructor(
    @Inject(DATABASE_CLIENT) private readonly database: PrismaClient,
    @Inject(AdminService) private readonly admin: AdminService,
    @Inject(AfterSalesCursor) private readonly cursors: AfterSalesCursor,
    @Inject(AfterSalesRateLimiter) private readonly rateLimiter: AfterSalesRateLimiter,
  ) {}

  public async list(
    headers: AdminHeaders,
    query: AfterSalePolicyListQuery,
  ): Promise<AfterSalePolicyPageResponse> {
    const context = await this.authorize(headers, query.store_id, 'store.after-sales.policy.read');
    await this.consume(context, 'READ');
    return withStoreTransaction(
      this.database,
      context,
      async (transaction) => {
        const filtersHash = hashAfterSaleCursorFilters({
          sort: 'updated_at_desc_id_desc_v1',
          status: query.status ?? null,
        });
        const cursor = query.cursor
          ? this.cursors.decode(query.cursor, {
              filters_hash: filtersHash,
              resource: 'ADMIN_AFTER_SALE_POLICIES',
              store_id: context.storeId,
              subject_id: context.actor.id,
              subject_type: 'ADMIN',
            })
          : null;
        const pageKeys = await this.policyPageKeys(transaction, {
          cursor,
          limit: query.limit,
          status: query.status,
          storeId: context.storeId,
        });
        const hasMore = pageKeys.length > query.limit;
        const visibleKeys = pageKeys.slice(0, query.limit);
        const ids = visibleKeys.map((item) => item.id);
        const rows =
          ids.length === 0
            ? []
            : await transaction.afterSalePolicy.findMany({
                select: {
                  code: true,
                  currentVersion: { select: { versionNumber: true } },
                  id: true,
                  status: true,
                  storeId: true,
                  version: true,
                },
                where: { id: { in: ids }, storeId: context.storeId },
              });
        const byId = new Map(rows.map((row) => [row.id, row]));
        const items = visibleKeys.map((key) => {
          const row = byId.get(key.id);
          if (!row || row.storeId !== context.storeId) throw new AfterSalePolicyProjectionError();
          return this.summary(row);
        });
        const last = visibleKeys.at(-1);
        const nextCursor =
          hasMore && last
            ? this.cursors.encode({
                filters_hash: filtersHash,
                resource: 'ADMIN_AFTER_SALE_POLICIES',
                sort_id: last.id,
                sort_key: last.sort_key,
                store_id: context.storeId,
                subject_id: context.actor.id,
                subject_type: 'ADMIN',
              })
            : null;
        return afterSalePolicyPageResponseSchema.parse({ items, next_cursor: nextCursor });
      },
      { isolationLevel: 'RepeatableRead', timeout: 15_000 },
    );
  }

  public async detail(
    headers: AdminHeaders,
    storeId: string,
    code: string,
  ): Promise<AfterSalePolicyDetailResponse> {
    const context = await this.authorize(headers, storeId, 'store.after-sales.policy.read');
    await this.consume(context, 'READ');
    return withStoreTransaction(
      this.database,
      context,
      (transaction) => this.policyDetail(transaction, storeId, code),
      { isolationLevel: 'RepeatableRead', timeout: 15_000 },
    );
  }

  public async putDraft(
    headers: AdminHeaders,
    storeId: string,
    code: string,
    idempotencyKey: string,
    input: AfterSalePolicyDraft,
  ): Promise<PolicyCommandResult<AfterSalePolicyDetailResponse>> {
    const context = await this.authorize(headers, storeId, 'store.after-sales.policy.manage');
    await this.consume(context, 'WRITE');
    const parsedInput = afterSalePolicyDraftSchema.parse(input);
    const { expected_version: expectedVersion, ...contentInput } = parsedInput;
    const content = canonicalizeAfterSalePolicyContent(
      afterSalePolicyContentSchema.parse(contentInput),
    );
    return this.command(context, {
      code,
      execute: async (transaction) => {
        const existing = await transaction.afterSalePolicy.findUnique({
          select: { id: true },
          where: { storeId_code: { code, storeId } },
        });
        const before =
          existing === null ? null : await this.policyDetail(transaction, storeId, code);
        const result = await putAfterSalePolicyDraftInTransaction(transaction, {
          actorId: context.actor.id,
          code,
          content,
          expectedVersion,
          storeId,
        });
        const body = await this.policyDetail(transaction, storeId, code);
        await this.writeAudit(transaction, context, {
          action:
            before === null ? 'after-sale.policy.draft.created' : 'after-sale.policy.draft.updated',
          after: body,
          before: before ?? undefined,
          targetId: result.policy.id,
        });
        return body;
      },
      idempotencyKey,
      operation: 'after-sale.policy.draft.put',
      parseStored: (value) => this.parseStored(afterSalePolicyDetailResponseSchema, value),
      request: { content, expected_version: expectedVersion },
    });
  }

  public async listVersions(
    headers: AdminHeaders,
    code: string,
    query: AfterSalePolicyVersionListQuery,
  ): Promise<AfterSalePolicyVersionPageResponse> {
    const context = await this.authorize(headers, query.store_id, 'store.after-sales.policy.read');
    await this.consume(context, 'READ');
    return withStoreTransaction(
      this.database,
      context,
      async (transaction) => {
        const policy = await transaction.afterSalePolicy.findUnique({
          select: { id: true, storeId: true },
          where: { storeId_code: { code, storeId: context.storeId } },
        });
        if (!policy || policy.storeId !== context.storeId) {
          throw new NotFoundException('Resource not found');
        }
        const filtersHash = hashAfterSaleCursorFilters({
          policy_code: code,
          sort: 'published_at_desc_id_desc_v1',
        });
        const cursor = query.cursor
          ? this.cursors.decode(query.cursor, {
              filters_hash: filtersHash,
              resource: 'ADMIN_AFTER_SALE_POLICY_VERSIONS',
              store_id: context.storeId,
              subject_id: context.actor.id,
              subject_type: 'ADMIN',
            })
          : null;
        const pageKeys = await this.versionPageKeys(transaction, {
          cursor,
          limit: query.limit,
          policyId: policy.id,
          storeId: context.storeId,
        });
        const hasMore = pageKeys.length > query.limit;
        const visibleKeys = pageKeys.slice(0, query.limit);
        const ids = visibleKeys.map((item) => item.id);
        const rows =
          ids.length === 0
            ? []
            : await transaction.afterSalePolicyVersion.findMany({
                include: policyVersionRelations,
                where: { id: { in: ids }, policyId: policy.id, storeId: context.storeId },
              });
        const byId = new Map(rows.map((row) => [row.id, row]));
        const items = visibleKeys.map((key) => {
          const row = byId.get(key.id);
          if (!row || row.storeId !== context.storeId || row.policyId !== policy.id) {
            throw new AfterSalePolicyProjectionError();
          }
          return this.version(code, row);
        });
        const last = visibleKeys.at(-1);
        const nextCursor =
          hasMore && last
            ? this.cursors.encode({
                filters_hash: filtersHash,
                resource: 'ADMIN_AFTER_SALE_POLICY_VERSIONS',
                sort_id: last.id,
                sort_key: last.sort_key,
                store_id: context.storeId,
                subject_id: context.actor.id,
                subject_type: 'ADMIN',
              })
            : null;
        return afterSalePolicyVersionPageResponseSchema.parse({
          items,
          next_cursor: nextCursor,
        });
      },
      { isolationLevel: 'RepeatableRead', timeout: 15_000 },
    );
  }

  public async versionDetail(
    headers: AdminHeaders,
    storeId: string,
    code: string,
    versionNumber: number,
  ): Promise<AfterSalePolicyVersionResponse> {
    const context = await this.authorize(headers, storeId, 'store.after-sales.policy.read');
    await this.consume(context, 'READ');
    return withStoreTransaction(
      this.database,
      context,
      async (transaction) => {
        const policy = await transaction.afterSalePolicy.findUnique({
          select: { id: true, storeId: true },
          where: { storeId_code: { code, storeId } },
        });
        if (!policy || policy.storeId !== storeId)
          throw new NotFoundException('Resource not found');
        const record = await transaction.afterSalePolicyVersion.findUnique({
          include: policyVersionRelations,
          where: {
            storeId_policyId_versionNumber: {
              policyId: policy.id,
              storeId,
              versionNumber,
            },
          },
        });
        if (!record || record.storeId !== storeId || record.policyId !== policy.id) {
          throw new NotFoundException('Resource not found');
        }
        return this.version(code, record);
      },
      { isolationLevel: 'RepeatableRead', timeout: 15_000 },
    );
  }

  public async publish(
    headers: AdminHeaders,
    storeId: string,
    code: string,
    idempotencyKey: string,
    input: AfterSalePolicyPublish,
  ): Promise<PolicyCommandResult<AfterSalePolicyVersionResponse>> {
    const context = await this.authorizeSensitive(
      headers,
      storeId,
      'store.after-sales.policy.publish',
    );
    await this.consume(context, 'WRITE');
    const parsedInput = afterSalePolicyPublishSchema.parse(input);
    return this.command(context, {
      code,
      execute: async (transaction, now) => {
        const [before, beforeSettings] = await Promise.all([
          this.policyDetail(transaction, storeId, code),
          transaction.storeAfterSaleSetting.findUnique({ where: { storeId } }),
        ]);
        const result = await publishAfterSalePolicyInTransaction(transaction, {
          actorId: context.actor.id,
          code,
          expectedVersion: parsedInput.expected_version,
          now,
          storeId,
        });
        const publishedVersion = await transaction.afterSalePolicyVersion.findUnique({
          include: policyVersionRelations,
          where: {
            storeId_id: { id: result.version.id, storeId },
          },
        });
        if (
          !publishedVersion ||
          publishedVersion.policyId !== result.policy.id ||
          publishedVersion.storeId !== storeId
        ) {
          throw new AfterSalePolicyProjectionError();
        }
        const body = this.version(code, publishedVersion);
        const after = await this.policyDetail(transaction, storeId, code);
        await this.writeAudit(transaction, context, {
          action: 'after-sale.policy.published',
          after: {
            policy: after,
            settings: this.settingsAuditView(result.settings),
          },
          before: {
            policy: before,
            settings: beforeSettings === null ? null : this.settingsAuditView(beforeSettings),
          },
          reason: parsedInput.reason,
          targetId: result.policy.id,
        });
        return body;
      },
      idempotencyKey,
      operation: 'after-sale.policy.publish',
      parseStored: (value) => this.parseStored(afterSalePolicyVersionResponseSchema, value),
      request: parsedInput,
    });
  }

  public async disable(
    headers: AdminHeaders,
    storeId: string,
    code: string,
    idempotencyKey: string,
    input: AfterSalePolicyDisable,
  ): Promise<PolicyCommandResult<AfterSalePolicySummaryResponse>> {
    const context = await this.authorizeSensitive(
      headers,
      storeId,
      'store.after-sales.policy.disable',
    );
    await this.consume(context, 'WRITE');
    const parsedInput = afterSalePolicyDisableSchema.parse(input);
    return this.command(context, {
      code,
      execute: async (transaction, now) => {
        const [before, beforeSettings] = await Promise.all([
          this.policyDetail(transaction, storeId, code),
          transaction.storeAfterSaleSetting.findUnique({ where: { storeId } }),
        ]);
        const result = await disableAfterSalePolicyInTransaction(transaction, {
          actorId: context.actor.id,
          code,
          expectedVersion: parsedInput.expected_version,
          now,
          storeId,
        });
        const record = await transaction.afterSalePolicy.findUnique({
          select: {
            code: true,
            currentVersion: { select: { versionNumber: true } },
            id: true,
            status: true,
            storeId: true,
            version: true,
          },
          where: { storeId_code: { code, storeId } },
        });
        if (!record || record.storeId !== storeId) throw new AfterSalePolicyProjectionError();
        const body = this.summary(record);
        const after = await this.policyDetail(transaction, storeId, code);
        await this.writeAudit(transaction, context, {
          action: 'after-sale.policy.disabled',
          after: {
            policy: after,
            settings: this.settingsAuditView(result.settings),
          },
          before: {
            policy: before,
            settings: beforeSettings === null ? null : this.settingsAuditView(beforeSettings),
          },
          reason: parsedInput.reason,
          targetId: result.policy.id,
        });
        return body;
      },
      idempotencyKey,
      operation: 'after-sale.policy.disable',
      parseStored: (value) => this.parseStored(afterSalePolicySummaryResponseSchema, value),
      request: parsedInput,
    });
  }

  private async authorize(
    headers: AdminHeaders,
    storeId: string,
    permission: string,
  ): Promise<StoreContext> {
    return this.admin.authorize(headers, storeId, permission);
  }

  private async authorizeSensitive(
    headers: AdminHeaders,
    storeId: string,
    permission: string,
  ): Promise<StoreContext> {
    return this.admin.authorizeSensitive(headers, storeId, permission);
  }

  private consume(context: StoreContext, access: 'READ' | 'WRITE'): Promise<void> {
    return this.rateLimiter.consume({
      access,
      actorId: context.actor.id,
      actorType: 'ADMIN',
      storeId: context.storeId,
    });
  }

  private async command<T>(
    context: StoreContext,
    input: {
      code: string;
      execute: (transaction: StoreTransaction, now: Date) => Promise<T>;
      idempotencyKey: string;
      operation: string;
      parseStored: (value: Prisma.JsonValue) => T;
      request: unknown;
    },
  ): Promise<PolicyCommandResult<T>> {
    const keyHash = hash(input.idempotencyKey);
    const requestHash = hash({ policy_code: input.code, request: input.request });
    const replayCommittedWinner = () =>
      withStoreTransaction(
        this.database,
        context,
        async (transaction) => {
          const clock = (
            await transaction.$queryRaw<Array<{ current_time: Date }>>`
              SELECT CURRENT_TIMESTAMP AS current_time
            `
          )[0];
          if (!clock) throw new AfterSalePolicyProjectionError();
          const existing = await transaction.idempotencyRecord.findUnique({
            where: {
              storeId_operation_idempotencyKey: {
                idempotencyKey: keyHash,
                operation: input.operation,
                storeId: context.storeId,
              },
            },
          });
          if (existing === null || existing.expiresAt <= clock.current_time) return null;
          if (existing.requestHash !== requestHash) {
            throw new ConflictException('AFTER_SALE_POLICY_IDEMPOTENCY_CONFLICT');
          }
          return { body: input.parseStored(existing.response), replayed: true };
        },
        { isolationLevel: 'ReadCommitted', timeout: 15_000 },
      );
    const execute = () =>
      withStoreTransaction(
        this.database,
        context,
        async (transaction) => {
          await transaction.$executeRaw`
            SELECT pg_advisory_xact_lock(hashtextextended(${`m62-policy:${context.storeId}`}, 0))
          `;
          const clock = (
            await transaction.$queryRaw<Array<{ current_time: Date }>>`
              SELECT CURRENT_TIMESTAMP AS current_time
            `
          )[0];
          if (!clock) throw new AfterSalePolicyProjectionError();
          await transaction.idempotencyRecord.deleteMany({
            where: {
              expiresAt: { lte: clock.current_time },
              idempotencyKey: keyHash,
              operation: input.operation,
              storeId: context.storeId,
            },
          });
          const existing = await transaction.idempotencyRecord.findUnique({
            where: {
              storeId_operation_idempotencyKey: {
                idempotencyKey: keyHash,
                operation: input.operation,
                storeId: context.storeId,
              },
            },
          });
          if (existing) {
            if (existing.requestHash !== requestHash) {
              throw new ConflictException('AFTER_SALE_POLICY_IDEMPOTENCY_CONFLICT');
            }
            return { body: input.parseStored(existing.response), replayed: true };
          }
          const body = await input.execute(transaction, clock.current_time);
          await transaction.idempotencyRecord.create({
            data: {
              expiresAt: new Date(clock.current_time.getTime() + 24 * 60 * 60 * 1_000),
              idempotencyKey: keyHash,
              operation: input.operation,
              requestHash,
              response: body as Prisma.InputJsonValue,
              storeId: context.storeId,
            },
          });
          return { body, replayed: false };
        },
        { isolationLevel: 'Serializable', timeout: 15_000 },
      );

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await execute();
      } catch (error) {
        if (isRetryableTransactionConflict(error) && attempt === 0) continue;
        if (isUniqueConstraintConflict(error)) {
          const replay = await replayCommittedWinner();
          if (replay !== null) return replay;
        }
        throw this.mapCommandError(error);
      }
    }
    throw new ConflictException('AFTER_SALE_POLICY_CONCURRENT_CONFLICT');
  }

  private mapCommandError(error: unknown): unknown {
    if (error instanceof AfterSalePolicyProjectionError) {
      return new ConflictException('AFTER_SALE_POLICY_SNAPSHOT_INVALID');
    }
    if (error instanceof AfterSalePolicyManagementError) {
      if (
        error.code === 'AFTER_SALE_POLICY_NOT_FOUND' ||
        error.code === 'AFTER_SALE_POLICY_TARGET_INVALID'
      ) {
        return new NotFoundException('Resource not found');
      }
      return new ConflictException(error.code);
    }
    if (isActiveTargetConstraintConflict(error)) {
      return new ConflictException('AFTER_SALE_POLICY_TARGET_CONFLICT');
    }
    if (isUniqueConstraintConflict(error)) {
      return new ConflictException('AFTER_SALE_POLICY_CONCURRENT_CONFLICT');
    }
    if (isRetryableTransactionConflict(error)) {
      return new ConflictException('AFTER_SALE_POLICY_CONCURRENT_CONFLICT');
    }
    return error;
  }

  private parseStored<T>(
    schema: { safeParse(value: unknown): { data?: T; success: boolean } },
    value: unknown,
  ): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new ConflictException('AFTER_SALE_POLICY_IDEMPOTENCY_INVALID');
    }
    return parsed.data as T;
  }

  private async policyDetail(
    transaction: StoreTransaction,
    storeId: string,
    code: string,
  ): Promise<AfterSalePolicyDetailResponse> {
    const record = await transaction.afterSalePolicy.findUnique({
      include: {
        currentVersion: { include: policyVersionRelations },
        draftProducts: { select: { productId: true } },
      },
      where: { storeId_code: { code, storeId } },
    });
    if (!record || record.storeId !== storeId) throw new NotFoundException('Resource not found');
    const parsedDraft = afterSalePolicyContentSchema.safeParse(record.draftPayload);
    if (!parsedDraft.success) throw new AfterSalePolicyProjectionError();
    const draft = canonicalizeAfterSalePolicyContent(parsedDraft.data);
    const draftProductIds = record.draftProducts
      .map((item) => item.productId)
      .sort((left, right) => left.localeCompare(right, 'en'));
    if (
      canonicalJson(record.draftPayload) !== canonicalJson(draft) ||
      afterSalePolicyContentHash(draft) !== record.draftHash ||
      canonicalJson(draftProductIds) !== canonicalJson(draft.product_ids)
    ) {
      throw new AfterSalePolicyProjectionError();
    }
    const currentVersion =
      record.currentVersion === null ? null : this.version(record.code, record.currentVersion);
    const isDraftHeadValid =
      record.status === 'DRAFT' &&
      record.currentVersion === null &&
      record.categoryId === draft.category_id;
    const isPublishedHeadValid =
      record.status !== 'DRAFT' &&
      record.currentVersion !== null &&
      record.currentVersion.policyId === record.id &&
      record.currentVersion.storeId === record.storeId &&
      record.categoryId === currentVersion?.content.category_id;
    if (!isDraftHeadValid && !isPublishedHeadValid) {
      throw new AfterSalePolicyProjectionError();
    }
    return afterSalePolicyDetailResponseSchema.parse({
      code: record.code,
      current_version: currentVersion,
      current_version_number: currentVersion?.version_number ?? null,
      draft,
      status: record.status,
      version: record.version,
    });
  }

  private summary(input: {
    code: string;
    currentVersion: { versionNumber: number } | null;
    status: 'ACTIVE' | 'DISABLED' | 'DRAFT';
    version: number;
  }): AfterSalePolicySummaryResponse {
    return afterSalePolicySummaryResponseSchema.parse({
      code: input.code,
      current_version_number: input.currentVersion?.versionNumber ?? null,
      status: input.status,
      version: input.version,
    });
  }

  private version(code: string, input: PolicyVersionRecord): AfterSalePolicyVersionResponse {
    const parsedContent = afterSalePolicyContentSchema.safeParse(input.payload);
    if (!parsedContent.success) {
      throw new AfterSalePolicyProjectionError();
    }
    const content = canonicalizeAfterSalePolicyContent(parsedContent.data);
    const localeOrder = new Map([
      ['vi', 0],
      ['zh', 1],
      ['en', 2],
    ]);
    const localizations = input.localizations
      .map((localization) => ({
        buyer_instructions: localization.buyerInstructions,
        locale: localization.locale,
        name: localization.name,
        summary: localization.summary,
      }))
      .sort(
        (left, right) =>
          (localeOrder.get(left.locale) ?? 99) - (localeOrder.get(right.locale) ?? 99),
      );
    const expectedAssignments = [
      ...content.product_ids.map((productId) => ({
        category_id: null,
        product_id: productId,
        target_type: 'PRODUCT',
      })),
      content.category_id === null
        ? { category_id: null, product_id: null, target_type: 'STORE_DEFAULT' }
        : { category_id: content.category_id, product_id: null, target_type: 'CATEGORY' },
    ].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right), 'en'));
    const assignments = input.assignments
      .map((assignment) => ({
        category_id: assignment.categoryId,
        product_id: assignment.productId,
        target_type: assignment.targetType,
      }))
      .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right), 'en'));
    const assignmentScopeValid = input.assignments.every(
      (assignment) =>
        assignment.storeId === input.storeId &&
        assignment.policyId === input.policyId &&
        assignment.policyVersionId === input.id,
    );
    const localizationScopeValid = input.localizations.every(
      (localization) => localization.storeId === input.storeId,
    );
    if (
      canonicalJson(input.payload) !== canonicalJson(content) ||
      afterSalePolicyContentHash(content) !== input.payloadHash ||
      canonicalJson(input.allowedTypes) !== canonicalJson(content.allowed_types) ||
      canonicalJson(input.conditionRules) !== canonicalJson(content.condition_rules) ||
      input.damagedException !== content.damaged_exception ||
      input.defectException !== content.defect_exception ||
      input.exchangeAttributeCode !== content.exchange_attribute_code ||
      input.exchangeSameProductOnly !== content.exchange_same_product_only ||
      input.hygieneRestricted !== content.hygiene_restricted ||
      input.requestWindowDays !== content.request_window_days ||
      input.returnShippingPayer !== content.return_shipping_payer ||
      input.returnWindowDays !== content.return_window_days ||
      input.unopenedRequired !== content.unopened_required ||
      input.wrongItemException !== content.wrong_item_exception ||
      !localizationScopeValid ||
      canonicalJson(localizations) !== canonicalJson(content.localizations) ||
      !assignmentScopeValid ||
      canonicalJson(assignments) !== canonicalJson(expectedAssignments) ||
      !Number.isFinite(input.effectiveAt.getTime()) ||
      !Number.isFinite(input.publishedAt.getTime()) ||
      input.effectiveAt.getTime() !== input.publishedAt.getTime()
    ) {
      throw new AfterSalePolicyProjectionError();
    }
    return afterSalePolicyVersionResponseSchema.parse({
      code,
      content,
      effective_at: input.effectiveAt.toISOString(),
      payload_hash: input.payloadHash,
      published_at: input.publishedAt.toISOString(),
      version_number: input.versionNumber,
    });
  }

  private settingsAuditView(input: {
    createdAt: Date;
    currentVersionId: string | null;
    defaultPolicyId: string | null;
    enforcePolicySnapshots: boolean;
    readinessCheckedAt: Date | null;
    readinessCheckedBy: string | null;
    readinessHash: string | null;
    readinessReadyAt: Date | null;
    storeId: string;
    updatedAt: Date;
    updatedBy: string | null;
    version: number;
  }) {
    return {
      created_at: input.createdAt.toISOString(),
      current_version_id: input.currentVersionId,
      default_policy_id: input.defaultPolicyId,
      enforce_policy_snapshots: input.enforcePolicySnapshots,
      readiness_checked_at: input.readinessCheckedAt?.toISOString() ?? null,
      readiness_checked_by: input.readinessCheckedBy,
      readiness_hash: input.readinessHash,
      readiness_ready_at: input.readinessReadyAt?.toISOString() ?? null,
      store_id: input.storeId,
      updated_at: input.updatedAt.toISOString(),
      updated_by: input.updatedBy,
      version: input.version,
    };
  }

  private async writeAudit(
    transaction: StoreTransaction,
    context: StoreContext,
    input: {
      action: string;
      after: unknown;
      before?: unknown;
      reason?: string;
      targetId: string;
    },
  ): Promise<void> {
    const json = (value: unknown): Prisma.InputJsonValue =>
      redactSensitiveData(value) as Prisma.InputJsonValue;
    await transaction.auditLog.create({
      data: {
        action: input.action,
        actorId: context.actor.id,
        actorType: 'ADMIN',
        afterData: json(input.after),
        beforeData: input.before === undefined ? Prisma.JsonNull : json(input.before),
        correlationId: context.correlationId,
        reason: input.reason ?? context.accessReason,
        storeId: context.storeId,
        targetId: input.targetId,
        targetType: 'after_sale_policy',
      },
    });
  }

  private policyPageKeys(
    transaction: StoreTransaction,
    input: {
      cursor: DecodedPageKey | null;
      limit: number;
      status?: 'ACTIVE' | 'DISABLED' | 'DRAFT';
      storeId: string;
    },
  ): Promise<PageKey[]> {
    const predicates: Prisma.Sql[] = [Prisma.sql`policy.store_id = ${input.storeId}::uuid`];
    if (input.status) {
      predicates.push(Prisma.sql`policy.status = ${input.status}::after_sale_policy_status`);
    }
    if (input.cursor) {
      predicates.push(
        Prisma.sql`(policy.updated_at, policy.id) < (${input.cursor.sortKey}::timestamptz, ${input.cursor.sortId}::uuid)`,
      );
    }
    return transaction.$queryRaw<PageKey[]>(Prisma.sql`
      SELECT
        policy.id,
        to_char(
          policy.updated_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) AS sort_key
      FROM after_sale_policies AS policy
      WHERE ${Prisma.join(predicates, ' AND ')}
      ORDER BY policy.updated_at DESC, policy.id DESC
      LIMIT ${input.limit + 1}
    `);
  }

  private versionPageKeys(
    transaction: StoreTransaction,
    input: {
      cursor: DecodedPageKey | null;
      limit: number;
      policyId: string;
      storeId: string;
    },
  ): Promise<PageKey[]> {
    const predicates: Prisma.Sql[] = [
      Prisma.sql`version.store_id = ${input.storeId}::uuid`,
      Prisma.sql`version.policy_id = ${input.policyId}::uuid`,
    ];
    if (input.cursor) {
      predicates.push(
        Prisma.sql`(version.published_at, version.id) < (${input.cursor.sortKey}::timestamptz, ${input.cursor.sortId}::uuid)`,
      );
    }
    return transaction.$queryRaw<PageKey[]>(Prisma.sql`
      SELECT
        version.id,
        to_char(
          version.published_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) AS sort_key
      FROM after_sale_policy_versions AS version
      WHERE ${Prisma.join(predicates, ' AND ')}
      ORDER BY version.published_at DESC, version.id DESC
      LIMIT ${input.limit + 1}
    `);
  }
}
