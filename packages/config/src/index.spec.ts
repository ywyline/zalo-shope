import { describe, expect, it } from 'vitest';

import { InvalidEnvironmentError, parseRuntimeConfig } from './index';

const validEnvironment = {
  AUTH_JWT_AUDIENCE: 'zalo-shop-test',
  AUTH_JWT_ISSUER: 'zalo-shop',
  AUTH_JWT_SECRET: 'test-jwt-secret-that-is-at-least-32-characters',
  DATABASE_RUNTIME_URL: 'postgresql://runtime:password@localhost:5432/database',
  DATABASE_URL: 'postgresql://user:password@localhost:5432/database',
  PII_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  PII_HASH_KEY: 'test-pii-hash-key-that-is-at-least-32-characters',
  REDIS_URL: 'redis://localhost:6379/0',
  S3_ACCESS_KEY: 'access-key',
  S3_BUCKET: 'test-bucket',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_SECRET_KEY: 'secret-key',
  ZALO_IDENTITY_PROVIDER: 'disabled',
};

describe('parseRuntimeConfig', () => {
  it('applies safe development defaults', () => {
    const config = parseRuntimeConfig(validEnvironment);

    expect(config.NODE_ENV).toBe('development');
    expect(config.API_PORT).toBe(3000);
    expect(config.WORKER_PORT).toBe(3001);
    expect(config.INVENTORY_EXPIRATION_INTERVAL_MS).toBe(5_000);
    expect(config.INVENTORY_EXPIRATION_BATCH_SIZE).toBe(100);
    expect(config.S3_FORCE_PATH_STYLE).toBe(true);
    expect(config.CONTENT_EXTERNAL_TARGET_HOSTS).toEqual([]);
  });

  it('normalizes the external content target allowlist', () => {
    const config = parseRuntimeConfig({
      ...validEnvironment,
      CONTENT_EXTERNAL_TARGET_HOSTS: ' Example.COM,shop.example.com ',
    });

    expect(config.CONTENT_EXTERNAL_TARGET_HOSTS).toEqual(['example.com', 'shop.example.com']);
  });

  it('parses false without treating it as a truthy string', () => {
    const config = parseRuntimeConfig({
      ...validEnvironment,
      S3_FORCE_PATH_STYLE: 'false',
    });

    expect(config.S3_FORCE_PATH_STYLE).toBe(false);
  });

  it('reports field names without exposing secret values', () => {
    expect(() =>
      parseRuntimeConfig({
        ...validEnvironment,
        DATABASE_URL: 'not-a-database-url',
        S3_SECRET_KEY: 'short',
      }),
    ).toThrow(InvalidEnvironmentError);

    try {
      parseRuntimeConfig({
        ...validEnvironment,
        DATABASE_URL: 'not-a-database-url',
        S3_SECRET_KEY: 'short',
      });
    } catch (error) {
      expect(String(error)).toContain('DATABASE_URL');
      expect(String(error)).toContain('S3_SECRET_KEY');
      expect(String(error)).not.toContain('not-a-database-url');
    }
  });

  it('requires server-only Zalo Open API configuration', () => {
    expect(() =>
      parseRuntimeConfig({
        ...validEnvironment,
        ZALO_IDENTITY_PROVIDER: 'open-api',
      }),
    ).toThrow(InvalidEnvironmentError);

    const config = parseRuntimeConfig({
      ...validEnvironment,
      ZALO_APP_ID: '1364144247280182439',
      ZALO_APP_SECRET: 'server-only-secret',
      ZALO_IDENTITY_PROVIDER: 'open-api',
      ZALO_MINI_APP_ID: '1054942727582608082',
    });
    expect(config).toMatchObject({
      ZALO_APP_ID: '1364144247280182439',
      ZALO_IDENTITY_PROVIDER: 'open-api',
      ZALO_MINI_APP_ID: '1054942727582608082',
      ZALO_OPEN_API_TIMEOUT_MS: 5_000,
      ZALO_TOKEN_METADATA_TTL_SECONDS: 300,
    });
  });

  it('does not expose an invalid Zalo secret in configuration errors', () => {
    const secret = 'tiny';
    try {
      parseRuntimeConfig({
        ...validEnvironment,
        ZALO_APP_ID: '1364144247280182439',
        ZALO_APP_SECRET: secret,
        ZALO_IDENTITY_PROVIDER: 'open-api',
        ZALO_MINI_APP_ID: '1054942727582608082',
      });
      throw new Error('expected configuration parsing to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidEnvironmentError);
      expect(String(error)).toContain('ZALO_APP_SECRET');
      expect(String(error)).not.toContain(secret);
    }
  });

  it('rejects an application identifier pasted as the Zalo secret', () => {
    const appId = '1364144247280182439';

    expect(() =>
      parseRuntimeConfig({
        ...validEnvironment,
        ZALO_APP_ID: appId,
        ZALO_APP_SECRET: appId,
        ZALO_IDENTITY_PROVIDER: 'open-api',
        ZALO_MINI_APP_ID: '1054942727582608082',
      }),
    ).toThrow(InvalidEnvironmentError);
  });
});
