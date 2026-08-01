import { createHash, randomUUID } from 'node:crypto';

import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { RuntimeConfig } from '@zalo-shop/config';
import {
  appendOutboxMessageInTransaction,
  applyPaymentProviderFact,
  bindPaymentProviderOrder,
  getPaymentCreationRequest,
  paymentLaunchPayloadHash,
  PaymentCommandError,
  type PrismaClient,
  type StoreTransaction,
  withStoreTransaction,
} from '@zalo-shop/database';
import { createStoreContext, type StoreContext } from '@zalo-shop/domain';
import {
  ProviderIntegrationError,
  type PaymentProviderChannelConfig,
  type PaymentProviderResolver,
} from '@zalo-shop/integrations';

import { AuthService } from '../auth/auth.service';
import { DATABASE_CLIENT } from '../auth/auth.tokens';
import { RUNTIME_CONFIG } from '../health.controller';
import { SearchRateLimiter } from '../search/search-rate-limiter';
import { PAYMENT_PROVIDER } from './payment.tokens';

type StoreRecord = { code: string; default_locale: 'en' | 'vi' | 'zh'; id: string };
type MemberContext = Readonly<{ context: StoreContext; memberId: string; storeId: string }>;

const PAYMENT_BIND_IDEMPOTENCY_OPERATION = 'payment.bind-provider-order';
const PAYMENT_BIND_CLAIM_LEASE_MS = 30_000;
const PAYMENT_BIND_RESULT_TTL_MS = 24 * 60 * 60_000;

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function safeAmount(value: bigint): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new ConflictException('AMOUNT_INVALID');
  return amount;
}

@Injectable()
export class PaymentsService {
  public constructor(
    @Inject(DATABASE_CLIENT) private readonly database: PrismaClient,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
    @Inject(PAYMENT_PROVIDER) private readonly providers: PaymentProviderResolver,
    @Inject(SearchRateLimiter) private readonly rateLimiter: SearchRateLimiter,
  ) {}

  public async detail(input: { authorization?: string; paymentId: string; storeCode: string }) {
    const member = await this.memberContext(input.authorization, input.storeCode);
    return withStoreTransaction(this.database, member.context, async (transaction) => {
      const attempt = await this.memberAttempt(transaction, member, input.paymentId);
      return this.render(attempt);
    });
  }

  public async launch(input: { authorization?: string; paymentId: string; storeCode: string }) {
    const member = await this.memberContext(input.authorization, input.storeCode);
    const attempt = await withStoreTransaction(this.database, member.context, (transaction) =>
      this.memberAttempt(transaction, member, input.paymentId),
    );
    let request;
    try {
      request = await getPaymentCreationRequest(this.database, member.context, input.paymentId);
    } catch (error) {
      this.mapCommandError(error);
    }
    if (
      !attempt.launchPayloadHash ||
      !attempt.launchNonceHash ||
      (attempt.status !== 'CREATED' && attempt.status !== 'PROVIDER_PENDING') ||
      attempt.expiresAt.getTime() <= Date.now()
    ) {
      throw new ConflictException('PAYMENT_LAUNCH_NOT_READY');
    }
    const created = await this.callProvider(() =>
      this.providers
        .resolve({ ...request.channel, storeId: member.storeId })
        .createPayment(request),
    );
    if (
      paymentLaunchPayloadHash(created.launchAction) !== attempt.launchPayloadHash ||
      (attempt.providerOrderId && created.providerOrderId !== attempt.providerOrderId)
    ) {
      throw new ServiceUnavailableException('PAYMENT_LAUNCH_INTEGRITY_FAILED');
    }
    return {
      expires_at: created.launchAction.expiresAt.toISOString(),
      kind: created.launchAction.kind,
      launch_token: created.launchAction.payload.extradata,
      payload: created.launchAction.payload,
      payment_id: attempt.id,
    };
  }

  public async bindProviderOrder(input: {
    authorization?: string;
    idempotencyKey: string;
    launchToken: string;
    orderId: string;
    paymentId: string;
    providerOrderId: string;
    storeCode: string;
  }) {
    const member = await this.memberContext(input.authorization, input.storeCode);
    await this.assertPaymentQueryAllowed(member, input.paymentId);
    const current = await withStoreTransaction(this.database, member.context, (transaction) =>
      this.memberAttempt(transaction, member, input.paymentId),
    );
    if (current.orderId !== input.orderId) throw new NotFoundException('Payment not found');
    let request;
    try {
      request = await getPaymentCreationRequest(this.database, member.context, input.paymentId);
    } catch (error) {
      this.mapCommandError(error);
    }
    const idempotency = await this.claimProviderOrderBinding(member, input);
    if (!idempotency.claimId) {
      return this.detail({
        authorization: input.authorization,
        paymentId: input.paymentId,
        storeCode: input.storeCode,
      });
    }
    try {
      const fact = await this.callProvider(async () => {
        const provider = this.providers.resolve({ ...request.channel, storeId: member.storeId });
        const launch = await provider.createPayment(request);
        if (
          paymentLaunchPayloadHash(launch.launchAction) !== current.launchPayloadHash ||
          !this.equal(input.launchToken, launch.launchAction.payload.extradata)
        ) {
          throw new ProviderIntegrationError('REJECTED', false, 'Payment launch token is invalid');
        }
        return provider.queryPayment({
          providerOrderId: input.providerOrderId,
          storeId: member.storeId,
        });
      });
      await bindPaymentProviderOrder(this.database, member.context, {
        attemptId: current.id,
        fact,
        scheduleReconciliation: this.config.PAYMENT_RECONCILIATION_ENABLED,
        source: 'QUERY',
      });
      await applyPaymentProviderFact(this.database, member.context, {
        attemptId: current.id,
        fact,
        source: 'QUERY',
      });
      await this.completeProviderOrderBinding(member, idempotency, input.paymentId);
    } catch (error) {
      await this.releaseProviderOrderBinding(member, idempotency);
      this.mapCommandError(error);
    }
    return this.detail({
      authorization: input.authorization,
      paymentId: input.paymentId,
      storeCode: input.storeCode,
    });
  }

  public async query(input: { authorization?: string; paymentId: string; storeCode: string }) {
    const member = await this.memberContext(input.authorization, input.storeCode);
    await this.assertPaymentQueryAllowed(member, input.paymentId);
    const current = await withStoreTransaction(this.database, member.context, (transaction) =>
      this.memberAttempt(transaction, member, input.paymentId),
    );
    if (!current.providerOrderId) throw new ConflictException('PAYMENT_PROVIDER_ORDER_NOT_BOUND');
    const fact = await this.callProvider(() => {
      const provider = this.providers.resolve(this.channelConfig(current.channel, member.storeId));
      return provider.queryPayment({
        providerOrderId: current.providerOrderId!,
        storeId: member.storeId,
      });
    });
    try {
      await applyPaymentProviderFact(this.database, member.context, {
        attemptId: current.id,
        fact,
        source: 'QUERY',
      });
    } catch (error) {
      this.mapCommandError(error);
    }
    return this.detail(input);
  }

  public async retry(input: {
    authorization?: string;
    idempotencyKey: string;
    orderId: string;
    storeCode: string;
  }) {
    const member = await this.memberContext(input.authorization, input.storeCode);
    this.ensureOnlinePaymentEnabled();
    return withStoreTransaction(
      this.database,
      member.context,
      async (transaction) => {
        await transaction.$executeRaw`
          SELECT pg_advisory_xact_lock(hashtextextended(${`${member.storeId}:${input.orderId}`}, 0))
        `;
        const locked = await transaction.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM orders
          WHERE store_id = ${member.storeId}::uuid
            AND id = ${input.orderId}::uuid
            AND member_id = ${member.memberId}::uuid
          FOR UPDATE
        `;
        if (locked.length !== 1) throw new NotFoundException('Order not found');
        const order = await transaction.order.findFirst({
          include: { reservation: true },
          where: { id: input.orderId, memberId: member.memberId, storeId: member.storeId },
        });
        if (
          !order ||
          order.paymentMethod !== 'ONLINE' ||
          order.status !== 'PENDING_PAYMENT' ||
          order.reservation?.status !== 'ACTIVE' ||
          order.reservation.expiresAt.getTime() <= Date.now()
        ) {
          throw new ConflictException('ORDER_NOT_PAYABLE');
        }
        const keyHash = hash(`${member.storeId}\u0000${order.id}\u0000${input.idempotencyKey}`);
        const replay = await transaction.paymentAttempt.findUnique({
          include: { channel: true, order: true, transitions: { orderBy: { createdAt: 'asc' } } },
          where: {
            storeId_orderId_createIdempotencyKeyHash: {
              createIdempotencyKeyHash: keyHash,
              orderId: order.id,
              storeId: member.storeId,
            },
          },
        });
        if (replay) return this.render(replay);
        const active = await transaction.paymentAttempt.findFirst({
          where: {
            orderId: order.id,
            status: { in: ['CREATED', 'PROVIDER_PENDING'] },
            storeId: member.storeId,
          },
        });
        if (active) throw new ConflictException('PAYMENT_ATTEMPT_ACTIVE');
        const channel = await this.activeChannel(transaction, member.storeId);
        const latest = await transaction.paymentAttempt.findFirst({
          orderBy: { attemptSequence: 'desc' },
          select: { attemptSequence: true },
          where: { orderId: order.id, storeId: member.storeId },
        });
        const sequence = (latest?.attemptSequence ?? 0) + 1;
        const expiresAt = new Date(
          Math.min(
            order.reservation.expiresAt.getTime(),
            Date.now() + channel.paymentWindowSeconds * 1_000,
          ),
        );
        if (expiresAt.getTime() <= Date.now()) throw new ConflictException('ORDER_NOT_PAYABLE');
        const attempt = await transaction.paymentAttempt.create({
          data: {
            amountVnd: order.payableVnd,
            attemptSequence: sequence,
            channelId: channel.id,
            correlationId: member.context.correlationId,
            createIdempotencyKeyHash: keyHash,
            currency: 'VND',
            expiresAt,
            orderId: order.id,
            publicPaymentNumber: `PAY-${order.id.replaceAll('-', '').toUpperCase()}-${sequence}`,
            status: 'CREATED',
            storeId: member.storeId,
          },
        });
        await transaction.paymentTransition.create({
          data: {
            actorId: member.memberId,
            actorType: 'MEMBER',
            correlationId: member.context.correlationId,
            event: 'CREATE',
            fromStatus: null,
            paymentAttemptId: attempt.id,
            source: 'MEMBER',
            storeId: member.storeId,
            toStatus: 'CREATED',
          },
        });
        await appendOutboxMessageInTransaction(transaction, member.context, {
          aggregateId: attempt.id,
          aggregateType: 'PAYMENT_ATTEMPT',
          eventType: 'payment.create.requested',
          eventVersion: 1,
          idempotencyKey: `payment.create.requested:${attempt.id}`,
          payload: { payment_attempt_id: attempt.id, store_id: member.storeId },
        });
        await transaction.order.update({
          data: { paymentStatus: 'PENDING', version: { increment: 1 } },
          where: { storeId_id: { id: order.id, storeId: member.storeId } },
        });
        return this.render(await this.memberAttempt(transaction, member, attempt.id));
      },
      { isolationLevel: 'Serializable', timeout: 15_000 },
    );
  }

  private async activeChannel(transaction: StoreTransaction, storeId: string) {
    this.ensureOnlinePaymentEnabled();
    const deploymentEnvironment =
      this.config.NODE_ENV === 'production'
        ? 'PRODUCTION'
        : this.config.NODE_ENV === 'test'
          ? 'TEST'
          : 'STAGING';
    const providerEnvironment =
      this.config.PAYMENT_PROVIDER === 'test' || this.config.NODE_ENV !== 'production'
        ? 'SANDBOX'
        : undefined;
    if (this.config.PAYMENT_PROVIDER === 'test' && this.config.NODE_ENV !== 'test') {
      throw new ConflictException('ONLINE_PAYMENT_UNAVAILABLE');
    }
    const channel = await transaction.storePaymentChannel.findFirst({
      where: {
        deploymentEnvironment,
        providerCode: 'ZALO_CHECKOUT_ZALOPAY',
        ...(providerEnvironment ? { providerEnvironment } : {}),
        status: 'ACTIVE',
        storeId,
      },
    });
    if (!channel) throw new ConflictException('ONLINE_PAYMENT_UNAVAILABLE');
    return channel;
  }

  private ensureOnlinePaymentEnabled(): void {
    if (this.config.PAYMENT_PROVIDER === 'disabled') {
      throw new ServiceUnavailableException('Payment provider is not configured');
    }
  }

  private channelConfig(
    channel: {
      checkoutAppId: string;
      id: string;
      keyVersion: string;
      methodCode: string;
      privateKeySecretRef: string;
      providerCode: string;
      providerEnvironment: 'SANDBOX' | 'PRODUCTION';
      version: number;
    },
    storeId: string,
  ): PaymentProviderChannelConfig {
    return { ...channel, storeId };
  }

  private async callProvider<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ProviderIntegrationError) {
        throw new ServiceUnavailableException('PAYMENT_PROVIDER_UNAVAILABLE');
      }
      throw error;
    }
  }

  private equal(left: string, right: string): boolean {
    const leftHash = createHash('sha256').update(left, 'utf8').digest();
    const rightHash = createHash('sha256').update(right, 'utf8').digest();
    return leftHash.equals(rightHash);
  }

  private assertPaymentQueryAllowed(member: MemberContext, paymentId: string): Promise<void> {
    return this.rateLimiter.assertAllowed(
      '',
      'payment-query',
      member.storeId,
      `${member.memberId}:${paymentId}`,
      {
        errorCode: 'PAYMENT_QUERY_RATE_LIMITED',
        maxRequests: this.config.ZALO_CHECKOUT_MEMBER_QUERY_RATE_LIMIT_PER_MINUTE,
        windowSeconds: 60,
      },
    );
  }

  private async claimProviderOrderBinding(
    member: MemberContext,
    input: {
      idempotencyKey: string;
      launchToken: string;
      orderId: string;
      paymentId: string;
      providerOrderId: string;
    },
  ): Promise<Readonly<{ claimId?: string; idempotencyKeyHash: string; requestHash: string }>> {
    const idempotencyKeyHash = hash(
      `${member.storeId}\u0000${member.memberId}\u0000${input.idempotencyKey}`,
    );
    const requestHash = hash(
      [
        member.storeId,
        member.memberId,
        input.orderId,
        input.paymentId,
        input.providerOrderId,
        hash(input.launchToken),
      ].join('\u0000'),
    );
    return withStoreTransaction(
      this.database,
      member.context,
      async (transaction) => {
        await transaction.$executeRaw`
          SELECT pg_advisory_xact_lock(
            hashtextextended(
              ${`${member.storeId}:${PAYMENT_BIND_IDEMPOTENCY_OPERATION}:${idempotencyKeyHash}`},
              0
            )
          )
        `;
        const current = await transaction.idempotencyRecord.findUnique({
          where: {
            storeId_operation_idempotencyKey: {
              idempotencyKey: idempotencyKeyHash,
              operation: PAYMENT_BIND_IDEMPOTENCY_OPERATION,
              storeId: member.storeId,
            },
          },
        });
        if (current) {
          if (
            current.requestHash !== requestHash ||
            current.memberId !== member.memberId ||
            current.orderId !== input.orderId
          ) {
            throw new ConflictException('PAYMENT_BIND_IDEMPOTENCY_CONFLICT');
          }
          const response = this.providerOrderBindingState(current.response);
          if (response.state === 'COMPLETED') {
            return { idempotencyKeyHash, requestHash };
          }
          if (current.expiresAt.getTime() > Date.now()) {
            throw new ServiceUnavailableException('PAYMENT_BIND_IN_PROGRESS');
          }
          const claimId = randomUUID();
          await transaction.idempotencyRecord.update({
            data: {
              expiresAt: new Date(Date.now() + PAYMENT_BIND_CLAIM_LEASE_MS),
              response: { claim_id: claimId, payment_id: input.paymentId, state: 'PROCESSING' },
            },
            where: { id: current.id },
          });
          return { claimId, idempotencyKeyHash, requestHash };
        }
        const claimId = randomUUID();
        await transaction.idempotencyRecord.create({
          data: {
            expiresAt: new Date(Date.now() + PAYMENT_BIND_CLAIM_LEASE_MS),
            idempotencyKey: idempotencyKeyHash,
            memberId: member.memberId,
            operation: PAYMENT_BIND_IDEMPOTENCY_OPERATION,
            orderId: input.orderId,
            requestHash,
            response: { claim_id: claimId, payment_id: input.paymentId, state: 'PROCESSING' },
            storeId: member.storeId,
          },
        });
        return { claimId, idempotencyKeyHash, requestHash };
      },
      { isolationLevel: 'Serializable' },
    );
  }

  private async completeProviderOrderBinding(
    member: MemberContext,
    claim: Readonly<{ claimId?: string; idempotencyKeyHash: string; requestHash: string }>,
    paymentId: string,
  ): Promise<void> {
    if (!claim.claimId) return;
    await withStoreTransaction(this.database, member.context, async (transaction) => {
      const updated = await transaction.idempotencyRecord.updateMany({
        data: {
          expiresAt: new Date(Date.now() + PAYMENT_BIND_RESULT_TTL_MS),
          response: { payment_id: paymentId, state: 'COMPLETED' },
        },
        where: {
          idempotencyKey: claim.idempotencyKeyHash,
          operation: PAYMENT_BIND_IDEMPOTENCY_OPERATION,
          requestHash: claim.requestHash,
          response: { path: ['claim_id'], equals: claim.claimId },
          storeId: member.storeId,
        },
      });
      if (updated.count !== 1) {
        throw new ServiceUnavailableException('PAYMENT_BIND_CLAIM_LOST');
      }
    });
  }

  private async releaseProviderOrderBinding(
    member: MemberContext,
    claim: Readonly<{ claimId?: string; idempotencyKeyHash: string; requestHash: string }>,
  ): Promise<void> {
    if (!claim.claimId) return;
    try {
      await withStoreTransaction(this.database, member.context, async (transaction) => {
        await transaction.idempotencyRecord.updateMany({
          data: { expiresAt: new Date() },
          where: {
            idempotencyKey: claim.idempotencyKeyHash,
            operation: PAYMENT_BIND_IDEMPOTENCY_OPERATION,
            requestHash: claim.requestHash,
            response: { path: ['claim_id'], equals: claim.claimId },
            storeId: member.storeId,
          },
        });
      });
    } catch {
      // The short lease makes a failed release recoverable without hiding the original error.
    }
  }

  private providerOrderBindingState(
    value: unknown,
  ): Readonly<{ state: 'COMPLETED' | 'PROCESSING' }> {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      ((value as { state?: unknown }).state !== 'COMPLETED' &&
        (value as { state?: unknown }).state !== 'PROCESSING')
    ) {
      throw new ConflictException('PAYMENT_BIND_IDEMPOTENCY_INVALID');
    }
    return { state: (value as { state: 'COMPLETED' | 'PROCESSING' }).state };
  }

  private async memberAttempt(
    transaction: StoreTransaction,
    member: MemberContext,
    paymentId: string,
  ) {
    const attempt = await transaction.paymentAttempt.findFirst({
      include: { channel: true, order: true, transitions: { orderBy: { createdAt: 'asc' } } },
      where: { id: paymentId, order: { memberId: member.memberId }, storeId: member.storeId },
    });
    if (!attempt) throw new NotFoundException('Payment not found');
    return attempt;
  }

  private render(attempt: Awaited<ReturnType<PaymentsService['memberAttempt']>>) {
    return {
      amount_vnd: safeAmount(attempt.amountVnd),
      created_at: attempt.createdAt.toISOString(),
      currency: attempt.currency,
      expires_at: attempt.expiresAt.toISOString(),
      id: attempt.id,
      launch_ready: Boolean(attempt.launchPayloadHash && attempt.launchNonceHash),
      order_id: attempt.orderId,
      payment_number: attempt.publicPaymentNumber,
      provider_order_bound: Boolean(attempt.providerOrderId),
      status: attempt.status,
      transitions: attempt.transitions.map((transition) => ({
        created_at: transition.createdAt.toISOString(),
        event: transition.event,
        from_status: transition.fromStatus,
        to_status: transition.toStatus,
      })),
      version: attempt.version,
    };
  }

  private mapCommandError(error: unknown): never {
    if (error instanceof PaymentCommandError) {
      if (error.code === 'PAYMENT_ATTEMPT_NOT_FOUND')
        throw new NotFoundException('Payment not found');
      throw new ConflictException(error.code);
    }
    throw error;
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
    const stores = await this.database.$queryRaw<
      StoreRecord[]
    >`SELECT * FROM app_security.resolve_active_store(${storeCode.trim()})`;
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
      storeId: store.id,
    };
  }
}
