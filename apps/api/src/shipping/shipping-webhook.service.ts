import { createHash } from 'node:crypto';

import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { RuntimeConfig } from '@zalo-shop/config';
import {
  ReliableMessagingError,
  recordShippingCallbackHint,
  resolveShippingCallbackChannel,
  ShippingCallbackError,
  type PrismaClient,
} from '@zalo-shop/database';
import { inspectGhnCallbackRoute, ProviderIntegrationError } from '@zalo-shop/integrations';

import { DATABASE_CLIENT } from '../auth/auth.tokens';
import { RUNTIME_CONFIG } from '../health.controller';
import { SearchRateLimiter } from '../search/search-rate-limiter';
import { normalizeCallbackIp } from '../payments/payment-webhook.service';

const SHIPPING_WEBHOOK_ACTOR_ID = '00000000-0000-4000-8000-000000000008';

@Injectable()
export class ShippingWebhookRateLimiter {
  public constructor(
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
    @Inject(SearchRateLimiter) private readonly rateLimiter: SearchRateLimiter,
  ) {}

  public consume(remoteAddress?: string): Promise<void> {
    const key = remoteAddress ? normalizeCallbackIp(remoteAddress) : 'unknown';
    return this.rateLimiter.assertAllowed(key, 'shipping-callback', 'global', undefined, {
      errorCode: 'SHIPPING_CALLBACK_RATE_LIMITED',
      maxRequests: this.config.GHN_CALLBACK_RATE_LIMIT_PER_MINUTE,
      windowSeconds: 60,
    });
  }
}

@Injectable()
export class ShippingWebhookService {
  public constructor(
    @Inject(DATABASE_CLIENT) private readonly database: PrismaClient,
    @Inject(ShippingWebhookRateLimiter) private readonly rateLimiter: ShippingWebhookRateLimiter,
  ) {}

  public async handle(input: {
    headers: Readonly<Record<string, string | undefined>>;
    rawBody: Uint8Array;
    remoteAddress?: string;
  }): Promise<{ accepted: true }> {
    if (!input.headers['content-type']?.toLowerCase().startsWith('application/json')) {
      throw new BadRequestException('Shipping callback content type is invalid');
    }
    await this.rateLimiter.consume(input.remoteAddress);
    let route;
    try {
      route = inspectGhnCallbackRoute(input.rawBody);
    } catch (error) {
      if (error instanceof ProviderIntegrationError) {
        throw new BadRequestException('Shipping callback is invalid');
      }
      throw error;
    }

    let channel;
    try {
      channel = await resolveShippingCallbackChannel(this.database, route.shopId);
    } catch (error) {
      if (
        error instanceof ShippingCallbackError &&
        error.code === 'SHIPPING_CALLBACK_CHANNEL_INVALID'
      ) {
        // GHN callbacks are unsigned. A generic acceptance prevents this route
        // from becoming a ShopId enumeration oracle or retry amplifier.
        return { accepted: true };
      }
      throw error;
    }

    const payloadDigest = createHash('sha256').update(input.rawBody).digest('hex');
    const externalEventId = `ghn-hint:${payloadDigest}`;
    const eventDigest = createHash('sha256')
      .update(
        `${channel.channelId}\u0000${channel.providerEnvironment}\u0000${externalEventId}`,
        'utf8',
      )
      .digest('hex');
    const context = {
      actor: { id: SHIPPING_WEBHOOK_ACTOR_ID, type: 'admin' as const },
      correlationId: `shipping-webhook:${payloadDigest.slice(0, 24)}`,
      locale: channel.defaultLocale,
      storeCode: channel.storeCode,
      storeId: channel.storeId,
    };
    try {
      await recordShippingCallbackHint(this.database, context, {
        channelId: channel.channelId,
        ...(route.clientOrderCode ? { clientOrderCode: route.clientOrderCode } : {}),
        environment: channel.providerEnvironment,
        eventDigest,
        externalEventId,
        payloadDigest,
        ...(route.providerShipmentId ? { providerShipmentId: route.providerShipmentId } : {}),
      });
    } catch (error) {
      if (error instanceof ShippingCallbackError || error instanceof ReliableMessagingError) {
        throw new ServiceUnavailableException('SHIPPING_CALLBACK_RETRY');
      }
      throw error;
    }
    return { accepted: true };
  }
}
