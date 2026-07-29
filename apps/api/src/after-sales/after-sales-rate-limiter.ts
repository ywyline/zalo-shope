import { createHmac } from 'node:crypto';

import {
  HttpException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { RuntimeConfig } from '@zalo-shop/config';
import { AFTER_SALE_RATE_LIMIT_POLICY } from '@zalo-shop/contracts';
import Redis from 'ioredis';

import { RUNTIME_CONFIG } from '../health.controller';

export type AfterSaleReadActorType = 'ADMIN' | 'MEMBER';
export type AfterSaleRateLimitAccess = 'READ' | 'WRITE';

export class AfterSaleRateLimitException extends HttpException {
  public constructor(public readonly retryAfterSeconds: number) {
    super('After-sale rate limit exceeded', 429);
  }
}

@Injectable()
export class AfterSalesRateLimiter implements OnApplicationShutdown {
  private readonly redis: Redis;

  public constructor(@Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig) {
    this.redis = new Redis(config.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
  }

  public async consume(input: {
    access?: AfterSaleRateLimitAccess;
    actorId: string;
    actorType: AfterSaleReadActorType;
    storeId: string;
  }): Promise<void> {
    const access = input.access ?? 'READ';
    const policy =
      input.actorType === 'MEMBER'
        ? access === 'WRITE'
          ? AFTER_SALE_RATE_LIMIT_POLICY.member_write
          : AFTER_SALE_RATE_LIMIT_POLICY.member_read
        : access === 'WRITE'
          ? AFTER_SALE_RATE_LIMIT_POLICY.admin_write
          : AFTER_SALE_RATE_LIMIT_POLICY.admin_read;
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const window = Math.floor(nowSeconds / policy.window_seconds);
    const digest = createHmac('sha256', this.config.PII_HASH_KEY)
      .update(`${input.actorType}:${input.actorId}`)
      .digest('hex');
    const key = `${this.config.NODE_ENV}:${input.storeId}:after-sale-${access.toLowerCase()}:${input.actorType.toLowerCase()}:${digest}:${window}`;
    let count: unknown;
    try {
      count = await this.redis.eval(
        "local value = redis.call('INCR', KEYS[1]); if value == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end; return value",
        1,
        key,
        String(policy.window_seconds + 1),
      );
    } catch {
      throw new ServiceUnavailableException('After-sale rate limiter is unavailable');
    }
    if (Number(count) > policy.limit) {
      const retryAfterSeconds = Math.max(1, (window + 1) * policy.window_seconds - nowSeconds);
      throw new AfterSaleRateLimitException(retryAfterSeconds);
    }
  }

  public onApplicationShutdown(): void {
    this.redis.disconnect(false);
  }
}
