import { createHash } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { RuntimeConfig } from '@zalo-shop/config';
import type {
  AdminAfterSaleListQuery,
  AfterSaleAdminReadQuery,
  AfterSaleAdminStoreQuery,
  AfterSaleCancelRequest,
  AfterSaleCommandAcknowledgementResponse,
  AfterSaleCreateRequest,
  AfterSaleListQuery,
  AfterSalePageResponse,
  AfterSaleReviewRequest,
  AfterSaleReviewResolveRequest,
  AfterSaleResponse,
  MerchantAfterSaleCreateRequest,
} from '@zalo-shop/contracts';
import {
  afterSaleCommandAcknowledgementResponseSchema,
  afterSalePageResponseSchema,
} from '@zalo-shop/contracts';
import {
  AfterSaleCommandDatabaseError,
  Prisma,
  cancelMemberAfterSaleCommand,
  createMemberAfterSaleCommand,
  createMerchantRefundAfterSaleCommand,
  resolveAfterSaleReviewCommand,
  reviewAfterSaleCommand,
  type AfterSaleCommandResult,
  type PrismaClient,
  type StoreTransaction,
  withStoreTransaction,
} from '@zalo-shop/database';
import { createStoreContext, type AfterSaleStatus, type StoreContext } from '@zalo-shop/domain';
import { resolveCorrelationId } from '@zalo-shop/logger';
import { encryptSensitive } from '@zalo-shop/security';

import { AdminService, type AdminHeaders } from '../admin/admin.service';
import { AuthService } from '../auth/auth.service';
import { DATABASE_CLIENT } from '../auth/auth.tokens';
import { RUNTIME_CONFIG } from '../health.controller';
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
type AfterSaleCommandExecution = {
  body: AfterSaleCommandAcknowledgementResponse;
  replayed: boolean;
};
type AcknowledgedAfterSaleCommand = Readonly<{
  afterSaleId: string;
  publicCaseNumber: string;
  status: AfterSaleStatus;
  version: number;
}>;

function sensitiveReasonDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

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
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
  ) {}

  public async memberCreate(input: {
    authorization?: string;
    body: AfterSaleCreateRequest;
    correlationId: string;
    idempotencyKey: string;
    sourceIp: string;
    storeCode: string;
  }): Promise<AfterSaleCommandExecution> {
    const context = await this.memberContext(input);
    await this.consumeWriteLimit(context, 'MEMBER');
    this.assertCommandsEnabled();
    const evidenceConfig = this.evidenceCommandConfig();
    let command: Awaited<ReturnType<typeof createMemberAfterSaleCommand>>;
    try {
      command = await createMemberAfterSaleCommand(this.database, context, {
        evidenceCapabilities: evidenceConfig.evidenceCapabilities,
        evidenceIds: input.body.evidence_ids,
        idempotencyKey: input.idempotencyKey,
        items: input.body.items.map((item) => ({
          orderItemId: item.order_item_id,
          quantity: item.quantity,
          ...('replacement_sku_id' in item ? { replacementSkuId: item.replacement_sku_id } : {}),
        })),
        orderId: input.body.order_id,
        ...(evidenceConfig.ordinaryAccessTtlSeconds === undefined
          ? {}
          : { ordinaryAccessTtlSeconds: evidenceConfig.ordinaryAccessTtlSeconds }),
        reasonCode: input.body.reason_code,
        reasonDetailCiphertext: encryptSensitive(
          input.body.description,
          this.config.PII_ENCRYPTION_KEY,
        ),
        reasonDetailHash: sensitiveReasonDigest(input.body.description),
        ...(evidenceConfig.retentionTtlSeconds === undefined
          ? {}
          : { retentionTtlSeconds: evidenceConfig.retentionTtlSeconds }),
        sourceIp: input.sourceIp,
        type: input.body.type,
      });
    } catch (error) {
      this.throwCommandError(error, 'member');
    }
    return {
      body: this.acknowledgeCommand(command),
      replayed: command.replayed,
    };
  }

  public async memberCancel(input: {
    afterSaleId: string;
    authorization?: string;
    body: AfterSaleCancelRequest;
    correlationId: string;
    idempotencyKey: string;
    sourceIp: string;
    storeCode: string;
  }): Promise<AfterSaleCommandExecution> {
    const context = await this.memberContext(input);
    await this.consumeWriteLimit(context, 'MEMBER');
    this.assertCommandsEnabled();
    let command: Awaited<ReturnType<typeof cancelMemberAfterSaleCommand>>;
    try {
      command = await cancelMemberAfterSaleCommand(this.database, context, {
        afterSaleId: input.afterSaleId,
        expectedVersion: input.body.expected_version,
        idempotencyKey: input.idempotencyKey,
        reason: input.body.reason,
        sourceIp: input.sourceIp,
      });
    } catch (error) {
      this.throwCommandError(error, 'member');
    }
    return {
      body: this.acknowledgeCommand(command),
      replayed: command.replayed,
    };
  }

  public async adminCreateMerchantRefund(input: {
    body: MerchantAfterSaleCreateRequest;
    headers: AdminHeaders;
    idempotencyKey: string;
    orderId: string;
    query: AfterSaleAdminStoreQuery;
  }): Promise<AfterSaleCommandExecution> {
    const context = await this.admin.authorizeSensitive(
      input.headers,
      input.query.store_id,
      'store.after-sales.review',
    );
    this.assertDirectReviewAuthorization(context);
    await this.consumeWriteLimit(context, 'ADMIN');
    this.assertCommandsEnabled();
    let command: Awaited<ReturnType<typeof createMerchantRefundAfterSaleCommand>>;
    try {
      command = await createMerchantRefundAfterSaleCommand(this.database, context, {
        idempotencyKey: input.idempotencyKey,
        items: input.body.items.map((item) => ({
          orderItemId: item.order_item_id,
          quantity: item.quantity,
        })),
        orderId: input.orderId,
        reasonCode: input.body.reason_code,
        reasonDetailCiphertext: encryptSensitive(
          input.body.description,
          this.config.PII_ENCRYPTION_KEY,
        ),
        reasonDetailHash: sensitiveReasonDigest(input.body.description),
        ...(input.headers.sourceIp === undefined ? {} : { sourceIp: input.headers.sourceIp }),
        type: 'MERCHANT_REFUND',
      });
    } catch (error) {
      this.throwCommandError(error, 'admin');
    }
    return {
      body: this.acknowledgeCommand(command),
      replayed: command.replayed,
    };
  }

  public async adminReview(input: {
    afterSaleId: string;
    body: AfterSaleReviewRequest;
    headers: AdminHeaders;
    idempotencyKey: string;
    query: AfterSaleAdminStoreQuery;
  }): Promise<AfterSaleCommandExecution> {
    const context = await this.admin.authorizeSensitive(
      input.headers,
      input.query.store_id,
      'store.after-sales.review',
    );
    this.assertDirectReviewAuthorization(context);
    await this.consumeWriteLimit(context, 'ADMIN');
    this.assertReviewCommandsEnabled();
    let command: Awaited<ReturnType<typeof reviewAfterSaleCommand>>;
    try {
      command = await reviewAfterSaleCommand(this.database, context, {
        afterSaleId: input.afterSaleId,
        body: input.body,
        idempotencyKey: input.idempotencyKey,
        ...(input.headers.sourceIp === undefined ? {} : { sourceIp: input.headers.sourceIp }),
      });
    } catch (error) {
      this.throwCommandError(error, 'admin');
    }
    return { body: this.acknowledgeCommand(command), replayed: command.replayed };
  }

  public async adminResolveReview(input: {
    afterSaleId: string;
    body: AfterSaleReviewResolveRequest;
    headers: AdminHeaders;
    idempotencyKey: string;
    query: AfterSaleAdminStoreQuery;
  }): Promise<AfterSaleCommandExecution> {
    const context = await this.admin.authorizeSensitive(
      input.headers,
      input.query.store_id,
      'store.after-sales.review',
    );
    this.assertDirectReviewAuthorization(context);
    await this.consumeWriteLimit(context, 'ADMIN');
    this.assertReviewCommandsEnabled();
    const policyBasis = 'policy_basis' in input.body ? input.body.policy_basis : undefined;
    let command: Awaited<ReturnType<typeof resolveAfterSaleReviewCommand>>;
    try {
      command = await resolveAfterSaleReviewCommand(this.database, context, {
        afterSaleId: input.afterSaleId,
        body: input.body,
        idempotencyKey: input.idempotencyKey,
        ...(policyBasis === undefined
          ? {}
          : {
              policyBasisCiphertext: encryptSensitive(policyBasis, this.config.PII_ENCRYPTION_KEY),
              policyBasisHash: sensitiveReasonDigest(policyBasis),
            }),
        ...(input.headers.sourceIp === undefined ? {} : { sourceIp: input.headers.sourceIp }),
      });
    } catch (error) {
      this.throwCommandError(error, 'admin');
    }
    return { body: this.acknowledgeCommand(command), replayed: command.replayed };
  }

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

  private async consumeWriteLimit(
    context: StoreContext,
    actorType: 'ADMIN' | 'MEMBER',
  ): Promise<void> {
    await this.rateLimiter.consume({
      access: 'WRITE',
      actorId: context.actor.id,
      actorType,
      storeId: context.storeId,
    });
  }

  private assertDirectReviewAuthorization(context: StoreContext): void {
    // Generic platform cross-store access is an audited scope entry, not a substitute for the
    // target store's high-risk after-sale review permission. AdminService returns STORE only after
    // resolving that concrete store permission; keep this stricter boundary local to B3/B4 so other
    // existing admin routes retain their frozen authorization contract.
    if (context.adminAuthorizationScope !== 'STORE') {
      throw new ForbiddenException('Target store after-sale review permission is required');
    }
  }

  private assertReviewCommandsEnabled(): void {
    if (!this.config.AFTER_SALE_REVIEW_COMMANDS_ENABLED || this.config.NODE_ENV === 'production') {
      throw new ServiceUnavailableException('After-sale review commands are unavailable');
    }
  }

  private assertCommandsEnabled(): void {
    if (!this.config.AFTER_SALE_COMMANDS_ENABLED || this.config.NODE_ENV === 'production') {
      throw new ServiceUnavailableException('After-sale commands are unavailable');
    }
  }

  private evidenceCommandConfig(): {
    evidenceCapabilities: {
      claimAvailable: boolean;
      deletionCompensationAvailable: boolean;
      malwareScanningAvailable: boolean;
      protectedReadAvailable: boolean;
      uploadValidationAvailable: boolean;
    };
    ordinaryAccessTtlSeconds?: number;
    retentionTtlSeconds?: number;
  } {
    const ordinaryAccessTtlSeconds = this.config.AFTER_SALE_EVIDENCE_ORDINARY_ACCESS_TTL_SECONDS;
    const retentionTtlSeconds = this.config.AFTER_SALE_EVIDENCE_RETENTION_TTL_SECONDS;
    const ttlAvailable =
      ordinaryAccessTtlSeconds !== undefined &&
      retentionTtlSeconds !== undefined &&
      ordinaryAccessTtlSeconds < retentionTtlSeconds;
    const storageAvailable = this.config.EVIDENCE_STORAGE_PROVIDER === 's3';
    const deletionCompensationAvailable =
      storageAvailable && this.config.AFTER_SALE_EVIDENCE_DELETION_WORKER_ENABLED;
    const malwareScanningAvailable =
      deletionCompensationAvailable && this.config.EVIDENCE_SCANNER_PROVIDER === 'clamav';
    return {
      evidenceCapabilities: {
        claimAvailable: ttlAvailable,
        deletionCompensationAvailable,
        malwareScanningAvailable,
        protectedReadAvailable:
          deletionCompensationAvailable && this.config.AFTER_SALE_EVIDENCE_PROTECTED_READS_ENABLED,
        uploadValidationAvailable:
          malwareScanningAvailable && this.config.AFTER_SALE_EVIDENCE_MEMBER_UPLOADS_ENABLED,
      },
      ...(ttlAvailable ? { ordinaryAccessTtlSeconds, retentionTtlSeconds } : {}),
    };
  }

  private acknowledgeCommand(
    command: AfterSaleCommandResult | AcknowledgedAfterSaleCommand,
  ): AfterSaleCommandAcknowledgementResponse {
    return afterSaleCommandAcknowledgementResponseSchema.parse({
      id: command.afterSaleId,
      public_number: command.publicCaseNumber,
      status: command.status,
      version: command.version,
    });
  }

  private throwCommandError(error: unknown, actorType: 'admin' | 'member'): never {
    if (!(error instanceof AfterSaleCommandDatabaseError)) throw error;
    switch (error.code) {
      case 'AFTER_SALE_INPUT_INVALID':
        throw new BadRequestException('Input is invalid');
      case 'AFTER_SALE_NOT_FOUND':
        throw new NotFoundException('Resource not found');
      case 'AFTER_SALE_AUTHORIZATION_DENIED':
        if (actorType === 'member') {
          throw new UnauthorizedException('Authentication is no longer valid');
        }
        throw new ForbiddenException('Authorization is no longer valid');
      case 'AFTER_SALE_IDEMPOTENCY_CONFLICT':
        throw new ConflictException('AFTER_SALE_IDEMPOTENCY_CONFLICT');
      case 'AFTER_SALE_STATE_CONFLICT':
        throw new ConflictException('AFTER_SALE_STATE_CONFLICT');
      case 'AFTER_SALE_VERSION_CONFLICT':
        throw new ConflictException('AFTER_SALE_VERSION_CONFLICT');
      case 'AFTER_SALE_QUANTITY_EXCEEDS_AVAILABLE':
        throw new ConflictException('AFTER_SALE_QUANTITY_EXCEEDS_AVAILABLE');
      case 'AFTER_SALE_EVIDENCE_STATE_CONFLICT':
        throw new ConflictException('AFTER_SALE_EVIDENCE_STATE_CONFLICT');
      case 'AFTER_SALE_ORDER_NOT_ELIGIBLE':
        throw new UnprocessableEntityException('AFTER_SALE_ORDER_NOT_ELIGIBLE');
      case 'AFTER_SALE_PAYMENT_NOT_PROVEN':
        throw new UnprocessableEntityException('AFTER_SALE_PAYMENT_NOT_PROVEN');
      case 'AFTER_SALE_DELIVERY_NOT_PROVEN':
        throw new UnprocessableEntityException('AFTER_SALE_DELIVERY_NOT_PROVEN');
      case 'AFTER_SALE_REASON_NOT_ALLOWED':
        throw new UnprocessableEntityException('AFTER_SALE_REASON_NOT_ALLOWED');
      case 'AFTER_SALE_EXCHANGE_NOT_ALLOWED':
        throw new UnprocessableEntityException('AFTER_SALE_EXCHANGE_NOT_ALLOWED');
      case 'AFTER_SALE_POLICY_MISMATCH':
        throw new UnprocessableEntityException('AFTER_SALE_POLICY_MISMATCH');
      case 'AFTER_SALE_RETURN_WINDOW_CLOSED':
        throw new UnprocessableEntityException('AFTER_SALE_RETURN_WINDOW_CLOSED');
      case 'AFTER_SALE_REQUEST_WINDOW_CLOSED':
        throw new UnprocessableEntityException('AFTER_SALE_REQUEST_WINDOW_CLOSED');
      case 'AFTER_SALE_EVIDENCE_REQUIRED':
        throw new UnprocessableEntityException('AFTER_SALE_EVIDENCE_REQUIRED');
      case 'AFTER_SALE_EVIDENCE_CAPABILITY_UNAVAILABLE':
        throw new ServiceUnavailableException('AFTER_SALE_EVIDENCE_CAPABILITY_UNAVAILABLE');
      default:
        throw error;
    }
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
      accessSessionExpiresAt: principal.accessSessionExpiresAt,
      accessSessionId: principal.sessionId,
      accessTokenExpiresAt: principal.accessTokenExpiresAt,
      actor: { id: principal.subjectId, type: 'member' },
      correlationId,
      locale: store.default_locale,
      storeCode: store.code,
      storeId: store.id,
    });
  }
}
