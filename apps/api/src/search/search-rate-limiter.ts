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

  public async assertAllowed(address: string): Promise<void> {
    const digest = createHmac('sha256', this.config.PII_HASH_KEY)
      .update(address || 'unknown')
      .digest('hex');
    const window = Math.floor(Date.now() / (this.config.SEARCH_RATE_LIMIT_WINDOW_SECONDS * 1_000));
    const key = `${this.config.NODE_ENV}:search-rate:${digest}:${window}`;
    const count = await this.redis.eval(
      "local value = redis.call('INCR', KEYS[1]); if value == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end; return value",
      1,
      key,
      String(this.config.SEARCH_RATE_LIMIT_WINDOW_SECONDS + 1),
    );
    if (Number(count) > this.config.SEARCH_RATE_LIMIT_MAX_REQUESTS) {
      throw new HttpException('Search rate limit exceeded', 429);
    }
  }

  public onApplicationShutdown(): void {
    this.redis.disconnect(false);
  }
}
