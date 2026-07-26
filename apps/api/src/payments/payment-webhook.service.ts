import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { RuntimeConfig } from '@zalo-shop/config';
import {
  applyPaymentProviderFact,
  bindPaymentProviderOrder,
  claimVerifiedPaymentCallback,
  PaymentCallbackError,
  PaymentCommandError,
  ReliableMessagingError,
  resolvePaymentCallbackChannel,
  settlePaymentCallback,
  type PrismaClient,
} from '@zalo-shop/database';
import {
  ProviderIntegrationError,
  type PaymentProviderResolver,
  inspectZaloCheckoutCallbackRoute,
} from '@zalo-shop/integrations';

import { DATABASE_CLIENT } from '../auth/auth.tokens';
import { RUNTIME_CONFIG } from '../health.controller';
import { SearchRateLimiter } from '../search/search-rate-limiter';
import { PAYMENT_PROVIDER } from './payment.tokens';

const PAYMENT_WEBHOOK_ACTOR_ID = '00000000-0000-4000-8000-000000000007';

/** Normalize the address reported by Node before applying callback controls.
 *
 * Proxies and dual-stack listeners can expose an IPv4 client as an
 * IPv4-mapped IPv6 address (`::ffff:127.0.0.1`). Treating that spelling as a
 * separate limiter/allowlist key would allow an avoidable bypass.
 */
export function normalizeCallbackIp(address: string): string {
  const normalized = address.trim().toLowerCase();
  const mappedPrefix = '::ffff:';
  const mapped = normalized.startsWith(mappedPrefix)
    ? normalized.slice(mappedPrefix.length)
    : undefined;
  if (mapped && isIP(mapped) === 4) return mapped;
  return normalized;
}

@Injectable()
export class PaymentWebhookRateLimiter {
  public constructor(
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
    @Inject(SearchRateLimiter) private readonly rateLimiter: SearchRateLimiter,
  ) {}

  public consume(key: string): Promise<void> {
    return this.rateLimiter.assertAllowed(
      normalizeCallbackIp(key),
      'payment-callback',
      'global',
      undefined,
      {
        errorCode: 'PAYMENT_CALLBACK_RATE_LIMITED',
        maxRequests: this.config.ZALO_CHECKOUT_CALLBACK_RATE_LIMIT_PER_MINUTE,
        windowSeconds: 60,
      },
    );
  }
}

@Injectable()
export class PaymentWebhookService {
  public constructor(
    @Inject(DATABASE_CLIENT) private readonly database: PrismaClient,
    @Inject(PAYMENT_PROVIDER) private readonly providers: PaymentProviderResolver,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
    @Inject(PaymentWebhookRateLimiter) private readonly rateLimiter: PaymentWebhookRateLimiter,
  ) {}

  public async handle(input: {
    headers: Readonly<Record<string, string | undefined>>;
    rawBody: Uint8Array;
    remoteAddress?: string;
  }): Promise<{ accepted: boolean; returnCode: 1 | 2; returnMessage: string }> {
    const remoteAddress = input.remoteAddress
      ? normalizeCallbackIp(input.remoteAddress)
      : undefined;
    if (
      !remoteAddress ||
      !this.config.ZALO_CHECKOUT_CALLBACK_IP_ALLOWLIST.map(normalizeCallbackIp).includes(
        remoteAddress,
      )
    ) {
      throw new UnauthorizedException('Payment callback source is not allowed');
    }
    await this.rateLimiter.consume(remoteAddress);
    let route;
    try {
      route = inspectZaloCheckoutCallbackRoute(input.rawBody);
    } catch (error) {
      this.mapProviderError(error);
    }
    const channel = await this.resolveChannel(route.appId, route.method);
    const context = {
      actor: { id: PAYMENT_WEBHOOK_ACTOR_ID, type: 'admin' as const },
      correlationId: `payment-webhook:${createHash('sha256').update(input.rawBody).digest('hex').slice(0, 24)}`,
      locale: channel.defaultLocale,
      storeCode: channel.storeCode,
      storeId: channel.storeId,
    };
    let parsed;
    try {
      const provider = this.providers.resolve({
        checkoutAppId: channel.checkoutAppId,
        id: channel.channelId,
        keyVersion: channel.keyVersion,
        methodCode: channel.methodCode,
        privateKeySecretRef: channel.privateKeySecretRef,
        providerCode: channel.providerCode,
        providerEnvironment: channel.providerEnvironment,
        storeId: channel.storeId,
        version: channel.version,
      });
      parsed = await provider.parseCallback({
        headers: input.headers,
        rawBody: input.rawBody,
        ...(remoteAddress ? { remoteAddress } : {}),
      });
    } catch (error) {
      this.mapProviderError(error);
    }
    if (!parsed.fact || parsed.trust !== 'AUTHENTICATED_FACT' || !parsed.externalEventId) {
      throw new UnauthorizedException('Payment callback is not authenticated');
    }
    const payloadDigest = createHash('sha256').update(input.rawBody).digest('hex');
    const eventDigest = createHash('sha256')
      .update(
        `${channel.channelId}\u0000${channel.providerEnvironment}\u0000${parsed.externalEventId}`,
      )
      .digest('hex');
    let claim;
    try {
      claim = await claimVerifiedPaymentCallback(this.database, context, {
        channelId: channel.channelId,
        environment: channel.providerEnvironment,
        eventDigest,
        externalEventId: parsed.externalEventId,
        payloadDigest,
      });
    } catch (error) {
      if (error instanceof PaymentCallbackError) {
        throw new BadRequestException(error.code);
      }
      if (error instanceof ReliableMessagingError) {
        throw new BadRequestException('PAYMENT_CALLBACK_INPUT_INVALID');
      }
      throw error;
    }
    if (!claim.claimed) {
      if (claim.inFlight) {
        throw new ServiceUnavailableException('PAYMENT_CALLBACK_RETRY');
      }
      return { accepted: true, returnCode: 2, returnMessage: 'Callback already processed' };
    }
    try {
      await bindPaymentProviderOrder(this.database, context, {
        attemptId: parsed.fact.attemptId,
        fact: parsed.fact,
        providerEventId: parsed.externalEventId,
        scheduleReconciliation: this.config.PAYMENT_RECONCILIATION_ENABLED,
        source: 'WEBHOOK',
      });
      await applyPaymentProviderFact(this.database, context, {
        attemptId: parsed.fact.attemptId,
        fact: parsed.fact,
        providerEventId: parsed.externalEventId,
        source: 'WEBHOOK',
      });
    } catch (error) {
      const permanent = error instanceof PaymentCommandError;
      try {
        await settlePaymentCallback(this.database, context, {
          callbackId: claim.callbackId,
          callbackVersion: claim.callbackVersion,
          disposition: permanent ? 'REJECTED' : 'RETRY_PENDING',
          errorCode: permanent ? error.code : 'PAYMENT_CALLBACK_RETRY',
          inboxId: claim.inboxId,
          inboxVersion: claim.inboxVersion,
        });
      } catch {
        // The callback lease is reclaimed by the next delivery after the
        // processing timeout. Do not expose a database/provider error body.
        throw new ServiceUnavailableException('PAYMENT_CALLBACK_RETRY');
      }
      if (permanent) throw new BadRequestException(error.code);
      throw new ServiceUnavailableException('PAYMENT_CALLBACK_RETRY');
    }
    try {
      await settlePaymentCallback(this.database, context, {
        callbackId: claim.callbackId,
        callbackVersion: claim.callbackVersion,
        inboxId: claim.inboxId,
        inboxVersion: claim.inboxVersion,
      });
    } catch {
      // A network failure can happen after the transaction commits. A second
      // idempotent settle observes the target state and avoids reprocessing.
      try {
        await settlePaymentCallback(this.database, context, {
          callbackId: claim.callbackId,
          callbackVersion: claim.callbackVersion,
          inboxId: claim.inboxId,
          inboxVersion: claim.inboxVersion,
        });
      } catch {
        throw new ServiceUnavailableException('PAYMENT_CALLBACK_RETRY');
      }
    }
    return { accepted: true, returnCode: 1, returnMessage: 'Callback processed' };
  }

  private async resolveChannel(appId: string, method: 'ZALOPAY' | 'ZALOPAY_SANDBOX') {
    try {
      return await resolvePaymentCallbackChannel(this.database, { appId, methodCode: method });
    } catch (error) {
      if (error instanceof PaymentCallbackError) {
        throw new UnauthorizedException('Payment callback channel is invalid');
      }
      throw error;
    }
  }

  private mapProviderError(error: unknown): never {
    if (error instanceof ProviderIntegrationError) {
      if (error.code === 'AUTHENTICATION')
        throw new UnauthorizedException('Payment callback signature is invalid');
      if (error.code === 'INVALID_REQUEST')
        throw new BadRequestException('Payment callback is invalid');
      if (error.code === 'REJECTED')
        throw new UnauthorizedException('Payment callback is not accepted');
      if (error.code === 'INVALID_RESPONSE')
        throw new BadRequestException('Payment callback is invalid');
      if (error.code === 'CONFIGURATION') {
        throw new ServiceUnavailableException('Payment callback provider is unavailable');
      }
      throw new ServiceUnavailableException('Payment callback provider is unavailable');
    }
    throw error;
  }
}
