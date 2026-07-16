import { config as loadEnvironment } from 'dotenv';
import { beforeAll, describe, expect, it } from 'vitest';

import { parseRuntimeConfig, type RuntimeConfig } from '@zalo-shop/config';
import { checkInfrastructure } from '@zalo-shop/platform';

describe('local infrastructure', () => {
  let runtimeConfig: RuntimeConfig;

  beforeAll(() => {
    loadEnvironment({ path: '.env.test.example', quiet: true });
    runtimeConfig = parseRuntimeConfig();
  });

  it('connects to PostgreSQL, Redis and S3-compatible storage', async () => {
    await expect(checkInfrastructure(runtimeConfig)).resolves.toEqual({
      objectStorage: 'up',
      postgres: 'up',
      redis: 'up',
    });
  });
});
