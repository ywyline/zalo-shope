import { createHmac } from 'node:crypto';

import { HttpException, Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { RuntimeConfig } from '@zalo-shop/config';
import Redis from 'ioredis';

import { RUNTIME_CONFIG } from '../health.controller';

@Injectable()
export class SearchRateLimiter implements OnApplicationShutdown {
  private readonly redis: Redis;

  public constructor(@Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig) {
    this.redis = new Redis(config.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
  }

  public async assertAllowed(
    address: string,
    scope: 'coupon-claim' | 'payment-callback' | 'payment-query' | 'pricing' | 'search' = 'search',
    storeId = 'global',
    subjectId?: string,
    policy?: Readonly<{ errorCode: string; maxRequests: number; windowSeconds: number }>,
  ): Promise<void> {
    const identity = subjectId ? `subject:${subjectId}` : `address:${address || 'unknown'}`;
    const digest = createHmac('sha256', this.config.PII_HASH_KEY).update(identity).digest('hex');
    const windowSeconds = policy?.windowSeconds ?? this.config.SEARCH_RATE_LIMIT_WINDOW_SECONDS;
    const maxRequests = policy?.maxRequests ?? this.config.SEARCH_RATE_LIMIT_MAX_REQUESTS;
    const window = Math.floor(Date.now() / (windowSeconds * 1_000));
    const key = `${this.config.NODE_ENV}:${storeId}:${scope}-rate:${digest}:${window}`;
    const count = await this.redis.eval(
      "local value = redis.call('INCR', KEYS[1]); if value == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end; return value",
      1,
      key,
      String(windowSeconds + 1),
    );
    if (Number(count) > maxRequests) {
      throw new HttpException(policy?.errorCode ?? 'Search rate limit exceeded', 429);
    }
  }

  public onApplicationShutdown(): void {
    this.redis.disconnect(false);
  }
}
