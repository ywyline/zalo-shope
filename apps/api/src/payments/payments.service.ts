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
  getPaymentCreationRequest,
  paymentLaunchPayloadHash,
  PaymentCommandError,
  type PrismaClient,
  type StoreTransaction,
  withStoreTransaction,
} from '@zalo-shop/database';
import { createStoreContext, type StoreContext } from '@zalo-shop/domain';
import { ProviderIntegrationError, type PaymentProvider } from '@zalo-shop/integrations';

import { AuthService } from '../auth/auth.service';
import { DATABASE_CLIENT } from '../auth/auth.tokens';
import { RUNTIME_CONFIG } from '../health.controller';
import { PAYMENT_PROVIDER } from './payment.tokens';

type StoreRecord = { code: string; default_locale: 'en' | 'vi' | 'zh'; id: string };
type MemberContext = Readonly<{ context: StoreContext; memberId: string; storeId: string }>;

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
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider | null,
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
    const provider = this.requireProvider();
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
    this.assertProvider(
      request.channel.providerCode,
      request.channel.providerEnvironment,
      provider,
    );
    const created = await this.callProvider(() => provider.createPayment(request));
    if (
      paymentLaunchPayloadHash(created.launchAction) !== attempt.launchPayloadHash ||
      (attempt.providerOrderId && created.providerOrderId !== attempt.providerOrderId)
    ) {
      throw new ServiceUnavailableException('PAYMENT_LAUNCH_INTEGRITY_FAILED');
    }
    return {
      expires_at: created.launchAction.expiresAt.toISOString(),
      kind: created.launchAction.kind,
      payload: created.launchAction.payload,
      payment_id: attempt.id,
    };
  }

  public async query(input: { authorization?: string; paymentId: string; storeCode: string }) {
    const member = await this.memberContext(input.authorization, input.storeCode);
    const provider = this.requireProvider();
    const current = await withStoreTransaction(this.database, member.context, (transaction) =>
      this.memberAttempt(transaction, member, input.paymentId),
    );
    if (!current.providerOrderId) throw new ConflictException('PAYMENT_PROVIDER_ORDER_NOT_BOUND');
    this.assertProvider(
      current.channel.providerCode,
      current.channel.providerEnvironment,
      provider,
    );
    const fact = await this.callProvider(() =>
      provider.queryPayment({
        providerOrderId: current.providerOrderId!,
        storeId: member.storeId,
      }),
    );
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
    this.requireProvider();
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
        const channel = await this.activeTestChannel(transaction, member.storeId);
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

  private async activeTestChannel(transaction: StoreTransaction, storeId: string) {
    if (this.config.NODE_ENV !== 'test' || this.config.PAYMENT_PROVIDER !== 'test') {
      throw new ConflictException('ONLINE_PAYMENT_UNAVAILABLE');
    }
    const channel = await transaction.storePaymentChannel.findFirst({
      where: {
        deploymentEnvironment: 'TEST',
        providerCode: 'ZALO_CHECKOUT_ZALOPAY',
        providerEnvironment: 'SANDBOX',
        status: 'ACTIVE',
        storeId,
      },
    });
    if (!channel) throw new ConflictException('ONLINE_PAYMENT_UNAVAILABLE');
    return channel;
  }

  private assertProvider(
    code: string,
    environment: 'SANDBOX' | 'PRODUCTION',
    provider: PaymentProvider,
  ): void {
    if (provider.code !== code || provider.environment !== environment) {
      throw new ServiceUnavailableException('PAYMENT_PROVIDER_CONFIGURATION_MISMATCH');
    }
  }

  private requireProvider(): PaymentProvider {
    if (!this.provider) throw new ServiceUnavailableException('Payment provider is not configured');
    return this.provider;
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
