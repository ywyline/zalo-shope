import { createHash } from 'node:crypto';

import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { RefundCreateRequest } from '@zalo-shop/contracts';
import {
  appendOutboxMessageInTransaction,
  createRefundCommand,
  PAYMENT_RECONCILIATION_EVENT_TYPE,
  PAYMENT_RECONCILIATION_MAX_ATTEMPTS,
  replayDeadLetterOutboxMessage,
  requestRefundQuery,
  RefundCommandError,
  ReliableMessagingError,
  type PrismaClient,
  withStoreTransaction,
} from '@zalo-shop/database';
import type { StoreContext } from '@zalo-shop/domain';

import { AdminService, type AdminHeaders } from '../admin/admin.service';
import { AuthService } from '../auth/auth.service';
import { DATABASE_CLIENT } from '../auth/auth.tokens';

type PageQuery = Readonly<{
  cursor?: string;
  limit: number;
  order_id?: string;
  status?: string;
}>;

type RefundPageQuery = PageQuery & Readonly<{ payment_id?: string }>;
type JobPageQuery = Readonly<{
  cursor?: string;
  limit: number;
  status?: 'DEAD_LETTER' | 'PENDING' | 'PROCESSING' | 'RETRY_WAIT' | 'SUCCEEDED';
}>;
type JobReadScope = Readonly<{
  context: StoreContext;
  eventTypePrefixes: readonly string[] | null;
}>;

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function safeAmount(value: bigint): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new ConflictException('AMOUNT_INVALID');
  return amount;
}

function mask(value: string | null): string | null {
  if (!value) return null;
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${value.slice(0, 2)}${'*'.repeat(Math.min(8, value.length - 4))}${value.slice(-2)}`;
}

@Injectable()
export class PaymentsAdminService {
  public constructor(
    @Inject(DATABASE_CLIENT) private readonly database: PrismaClient,
    @Inject(AdminService) private readonly admin: AdminService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  public async listPayments(headers: AdminHeaders, storeId: string, query: PageQuery) {
    const context = await this.admin.authorize(headers, storeId, 'store.payments.read');
    return withStoreTransaction(this.database, context, async (transaction) => {
      const cursor = query.cursor
        ? await transaction.paymentAttempt.findFirst({
            select: { createdAt: true, id: true },
            where: { id: query.cursor, storeId },
          })
        : null;
      if (query.cursor && !cursor) throw new NotFoundException('Payment cursor not found');
      const rows = await transaction.paymentAttempt.findMany({
        include: { transitions: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit,
        where: {
          storeId,
          ...(query.order_id ? { orderId: query.order_id } : {}),
          ...(query.status ? { status: query.status as never } : {}),
          ...(cursor
            ? {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              }
            : {}),
        },
      });
      return {
        items: rows.map((row) => ({
          amount_vnd: safeAmount(row.amountVnd),
          created_at: row.createdAt.toISOString(),
          currency: 'VND',
          expires_at: row.expiresAt.toISOString(),
          id: row.id,
          launch_ready: row.launchPayloadHash !== null,
          order_id: row.orderId,
          payment_number: row.publicPaymentNumber,
          provider_reference_masked: mask(row.providerTransactionId ?? row.providerOrderId),
          status: row.status,
          transitions: row.transitions.map((transition) => ({
            created_at: transition.createdAt.toISOString(),
            event: transition.event,
            from_status: transition.fromStatus,
            to_status: transition.toStatus,
          })),
          version: row.version,
        })),
        next_cursor: rows.length === query.limit ? rows.at(-1)!.id : null,
      };
    });
  }

  public async queryPayment(
    headers: AdminHeaders,
    storeId: string,
    paymentId: string,
    idempotencyKey: string,
    input: { expected_version: number; reason: string },
  ) {
    const context = await this.admin.authorize(headers, storeId, 'store.payments.reconcile');
    return withStoreTransaction(this.database, context, async (transaction) => {
      const payment = await transaction.paymentAttempt.findFirst({
        where: { id: paymentId, storeId },
      });
      if (!payment) throw new NotFoundException('Payment not found');
      if (
        payment.version !== input.expected_version ||
        payment.status !== 'PROVIDER_PENDING' ||
        !payment.providerOrderId
      ) {
        throw new ConflictException('PAYMENT_STATE_CONFLICT');
      }
      const message = await appendOutboxMessageInTransaction(transaction, context, {
        aggregateId: payment.id,
        aggregateType: 'PAYMENT_ATTEMPT',
        eventType: PAYMENT_RECONCILIATION_EVENT_TYPE,
        eventVersion: 1,
        idempotencyKey: `${PAYMENT_RECONCILIATION_EVENT_TYPE}:manual:${hash(`${storeId}\u0000${payment.id}\u0000${idempotencyKey}`)}`,
        maxAttempts: PAYMENT_RECONCILIATION_MAX_ATTEMPTS,
        payload: { payment_attempt_id: payment.id, store_id: storeId },
      });
      if (!message.replayed) {
        await this.admin.writeAudit(transaction, context, {
          action: 'payment.reconciliation.requested',
          after: { payment_id: payment.id, status: payment.status },
          targetId: message.message.id,
          targetType: 'outbox_message',
        });
      }
      return this.jobView(message.message);
    });
  }

  public async createRefund(
    headers: AdminHeaders,
    storeId: string,
    paymentId: string,
    idempotencyKey: string,
    input: RefundCreateRequest,
  ) {
    const context = await this.admin.authorizeSensitive(headers, storeId, 'store.refunds.create');
    try {
      const created = await createRefundCommand(this.database, context, {
        amountVnd: input.amount_vnd,
        confirmation: input.confirmation_code,
        expectedPaymentVersion: input.expected_payment_version,
        idempotencyKey,
        paymentAttemptId: paymentId,
        reason: input.reason,
      });
      return this.refundResultView(created);
    } catch (error) {
      this.mapRefundError(error);
    }
  }

  public async listRefunds(headers: AdminHeaders, storeId: string, query: RefundPageQuery) {
    const context = await this.admin.authorize(headers, storeId, 'store.refunds.read');
    return withStoreTransaction(this.database, context, async (transaction) => {
      const cursor = query.cursor
        ? await transaction.refund.findFirst({
            select: { id: true, requestedAt: true },
            where: { id: query.cursor, storeId },
          })
        : null;
      if (query.cursor && !cursor) throw new NotFoundException('Refund cursor not found');
      const rows = await transaction.refund.findMany({
        include: { transitions: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
        orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
        take: query.limit,
        where: {
          storeId,
          ...(query.order_id ? { orderId: query.order_id } : {}),
          ...(query.payment_id ? { paymentAttemptId: query.payment_id } : {}),
          ...(query.status ? { status: query.status as never } : {}),
          ...(cursor
            ? {
                OR: [
                  { requestedAt: { lt: cursor.requestedAt } },
                  { requestedAt: cursor.requestedAt, id: { lt: cursor.id } },
                ],
              }
            : {}),
        },
      });
      return {
        items: rows.map((row) => this.refundView(row)),
        next_cursor: rows.length === query.limit ? rows.at(-1)!.id : null,
      };
    });
  }

  public async queryRefund(
    headers: AdminHeaders,
    storeId: string,
    refundId: string,
    idempotencyKey: string,
    input: { expected_version: number; reason: string },
  ) {
    const context = await this.admin.authorize(headers, storeId, 'store.payments.reconcile');
    await this.admin.authorize(headers, storeId, 'store.refunds.read');
    try {
      return this.jobView(
        await requestRefundQuery(this.database, context, {
          expectedVersion: input.expected_version,
          idempotencyKey,
          reason: input.reason,
          refundId,
        }),
      );
    } catch (error) {
      this.mapRefundError(error);
    }
  }

  public async listJobs(headers: AdminHeaders, storeId: string, query: JobPageQuery) {
    const scope = await this.authorizeJobRead(headers, storeId);
    const visibilityWhere = scope.eventTypePrefixes
      ? {
          OR: scope.eventTypePrefixes.map((prefix) => ({ eventType: { startsWith: prefix } })),
        }
      : {};
    return withStoreTransaction(this.database, scope.context, async (transaction) => {
      const cursor = query.cursor
        ? await transaction.outboxMessage.findFirst({
            select: { createdAt: true, id: true },
            where: { id: query.cursor, storeId, ...visibilityWhere },
          })
        : null;
      if (query.cursor && !cursor) throw new NotFoundException('Integration job cursor not found');
      const rows = await transaction.outboxMessage.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit,
        where: {
          storeId,
          AND: [
            visibilityWhere,
            this.jobStatusWhere(query.status),
            ...(cursor
              ? [
                  {
                    OR: [
                      { createdAt: { lt: cursor.createdAt } },
                      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                    ],
                  },
                ]
              : []),
          ],
        },
      });
      return {
        items: rows.map((row) => this.jobView(row)),
        next_cursor: rows.length === query.limit ? rows.at(-1)!.id : null,
      };
    });
  }

  public async retryJob(
    headers: AdminHeaders,
    storeId: string,
    jobId: string,
    idempotencyKey: string,
    input: {
      confirmation_code: 'RETRY_DEAD_LETTER';
      expected_version: number;
      reason: string;
    },
  ) {
    const context = await this.admin.authorizeSensitive(
      headers,
      storeId,
      'store.integration-jobs.retry',
    );
    const principal = await this.auth.authenticateAccessToken(headers.accessToken);
    if (principal.actorType !== 'admin') throw new ForbiddenException('Access denied');
    const session = await this.database.adminSession.findUnique({
      select: { mfaVerifiedAt: true },
      where: { id: principal.sessionId },
    });
    if (!session) throw new ForbiddenException('Recent MFA verification is required');
    try {
      return this.jobView(
        await replayDeadLetterOutboxMessage(this.database, context, {
          confirmation: input.confirmation_code,
          expectedVersion: input.expected_version,
          idempotencyKey,
          messageId: jobId,
          mfaVerifiedAt: session.mfaVerifiedAt,
          reason: input.reason,
        }),
      );
    } catch (error) {
      if (error instanceof ReliableMessagingError) {
        if (error.code === 'OUTBOX_REPLAY_PERMISSION_DENIED') {
          throw new ForbiddenException('Access denied');
        }
        throw new ConflictException(error.code);
      }
      throw error;
    }
  }

  private async authorizeJobRead(headers: AdminHeaders, storeId: string): Promise<JobReadScope> {
    let denied: ForbiddenException | undefined;
    try {
      return {
        context: await this.admin.authorize(headers, storeId, 'store.integrations.read'),
        eventTypePrefixes: null,
      };
    } catch (error) {
      if (!(error instanceof ForbiddenException)) throw error;
      denied = error;
    }

    const allowed: string[] = [];
    let context: StoreContext | undefined;
    for (const [permission, prefixes] of [
      ['store.payments.read', ['payment.']],
      ['store.refunds.read', ['refund.']],
      ['store.shipments.read', ['shipment.', 'shipping.']],
    ] as const) {
      try {
        const permittedContext = await this.admin.authorize(headers, storeId, permission);
        context ??= permittedContext;
        allowed.push(...prefixes);
      } catch (error) {
        if (!(error instanceof ForbiddenException)) throw error;
        denied = error;
      }
    }
    if (context) return { context, eventTypePrefixes: allowed };
    throw denied ?? new ForbiddenException('Access denied');
  }

  private refundResultView(refund: {
    amountVnd: number;
    paymentAttemptId: string;
    publicRefundNumber: string;
    reason: string;
    refundId: string;
    requestedAt: Date;
    status: string;
    updatedAt: Date;
    version: number;
  }) {
    return {
      amount_vnd: refund.amountVnd,
      currency: 'VND',
      id: refund.refundId,
      payment_id: refund.paymentAttemptId,
      public_number: refund.publicRefundNumber,
      reason: refund.reason,
      requested_at: refund.requestedAt.toISOString(),
      status: refund.status,
      updated_at: refund.updatedAt.toISOString(),
      version: refund.version,
    };
  }

  private refundView(refund: {
    amountVnd: bigint;
    id: string;
    paymentAttemptId: string;
    providerRefundId: string | null;
    publicRefundNumber: string;
    reason: string;
    requestedAt: Date;
    status: string;
    transitions: Array<{
      createdAt: Date;
      event: string;
      fromStatus: string | null;
      toStatus: string;
    }>;
    updatedAt: Date;
    version: number;
  }) {
    return {
      amount_vnd: safeAmount(refund.amountVnd),
      currency: 'VND',
      id: refund.id,
      payment_id: refund.paymentAttemptId,
      provider_refund_reference_masked: mask(refund.providerRefundId),
      public_number: refund.publicRefundNumber,
      reason: refund.reason,
      requested_at: refund.requestedAt.toISOString(),
      status: refund.status,
      transitions: refund.transitions.map((transition) => ({
        created_at: transition.createdAt.toISOString(),
        event: transition.event,
        from_status: transition.fromStatus,
        to_status: transition.toStatus,
      })),
      updated_at: refund.updatedAt.toISOString(),
      version: refund.version,
    };
  }

  private jobView(job: {
    attemptCount: number;
    availableAt: Date;
    createdAt?: Date;
    eventType: string;
    id: string;
    lastErrorCode: string | null;
    maxAttempts: number;
    status: string;
    version: number;
  }) {
    const status =
      job.status === 'COMPLETED'
        ? 'SUCCEEDED'
        : job.status === 'PENDING' && (job.attemptCount > 0 || job.lastErrorCode)
          ? 'RETRY_WAIT'
          : job.status;
    return {
      attempt_count: job.attemptCount,
      created_at: (job.createdAt ?? job.availableAt).toISOString(),
      id: job.id,
      last_error_code: job.lastErrorCode,
      next_attempt_at:
        status === 'PENDING' || status === 'RETRY_WAIT' ? job.availableAt.toISOString() : null,
      operation: job.eventType,
      status,
      version: job.version,
    };
  }

  private jobStatusWhere(status: JobPageQuery['status']): Record<string, unknown> {
    if (status === 'SUCCEEDED') return { status: 'COMPLETED' };
    if (status === 'RETRY_WAIT') {
      return {
        status: 'PENDING',
        OR: [{ attemptCount: { gt: 0 } }, { lastErrorCode: { not: null } }],
      };
    }
    if (status === 'PENDING') {
      return { attemptCount: 0, lastErrorCode: null, status: 'PENDING' };
    }
    return status ? { status } : {};
  }

  private mapRefundError(error: unknown): never {
    if (error instanceof RefundCommandError) {
      if (error.code === 'REFUND_NOT_FOUND' || error.code === 'PAYMENT_NOT_REFUNDABLE') {
        throw new NotFoundException('Refundable payment or refund not found');
      }
      throw new ConflictException(error.code);
    }
    throw error;
  }
}
