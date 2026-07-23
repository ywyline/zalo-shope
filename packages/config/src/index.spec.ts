import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

const validProductionEnvironment = {
  ...validEnvironment,
  AUTH_JWT_SECRET: 'j'.repeat(64),
  NODE_ENV: 'production',
  PII_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
  PII_HASH_KEY: 'h'.repeat(64),
  S3_ACCESS_KEY: 'a'.repeat(24),
  S3_BUCKET: 'production-fixture-bucket',
  S3_ENDPOINT: 'https://objects.example.test',
  S3_SECRET_KEY: 's'.repeat(32),
};

const productionPlaceholderFields = [
  'AUTH_JWT_SECRET',
  'PII_ENCRYPTION_KEY',
  'PII_HASH_KEY',
  'S3_ACCESS_KEY',
  'S3_BUCKET',
  'S3_ENDPOINT',
  'S3_SECRET_KEY',
] as const;

function readExampleEnvironment(fileName: string): Record<string, string> {
  return Object.fromEntries(
    readFileSync(resolve(__dirname, '../../..', fileName), 'utf8')
      .split(/\r?\n/u)
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

const productionPlaceholderCases = ['.env.example', '.env.test.example'].flatMap((fileName) => {
  const environment = readExampleEnvironment(fileName);
  return productionPlaceholderFields.map((field) => {
    const placeholder = environment[field];
    if (!placeholder) throw new Error(`${fileName} is missing ${field}`);
    return [fileName, field, placeholder] as const;
  });
});

describe('parseRuntimeConfig', () => {
  it('applies safe development defaults', () => {
    const config = parseRuntimeConfig(validEnvironment);

    expect(config.NODE_ENV).toBe('development');
    expect(config.API_PORT).toBe(3000);
    expect(config.WORKER_PORT).toBe(3001);
    expect(config.INVENTORY_EXPIRATION_INTERVAL_MS).toBe(5_000);
    expect(config.INVENTORY_EXPIRATION_BATCH_SIZE).toBe(100);
    expect(config.SEARCH_RATE_LIMIT_MAX_REQUESTS).toBe(120);
    expect(config.SEARCH_RATE_LIMIT_WINDOW_SECONDS).toBe(60);
    expect(config.S3_FORCE_PATH_STYLE).toBe(true);
    expect(config.S3_SESSION_TOKEN).toBeUndefined();
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

  it('normalizes an empty S3 session token and accepts a supplied STS token', () => {
    expect(parseRuntimeConfig({ ...validEnvironment, S3_SESSION_TOKEN: '' }).S3_SESSION_TOKEN).toBe(
      undefined,
    );
    expect(
      parseRuntimeConfig({ ...validEnvironment, S3_SESSION_TOKEN: 't'.repeat(32) })
        .S3_SESSION_TOKEN,
    ).toBe('t'.repeat(32));
  });

  it('does not expose an invalid S3 session token in configuration errors', () => {
    const token = 'tiny';
    try {
      parseRuntimeConfig({ ...validEnvironment, S3_SESSION_TOKEN: token });
      throw new Error('expected S3 session token validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidEnvironmentError);
      expect(String(error)).toContain('S3_SESSION_TOKEN');
      expect(String(error)).not.toContain(token);
    }
  });

  it('accepts non-placeholder production credentials', () => {
    expect(parseRuntimeConfig(validProductionEnvironment).NODE_ENV).toBe('production');
  });

  it.each(productionPlaceholderCases)(
    'rejects the %s repository placeholder for %s in production without exposing it',
    (_fileName, field, placeholder) => {
      try {
        parseRuntimeConfig({ ...validProductionEnvironment, [field]: placeholder });
        throw new Error('expected production placeholder validation to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidEnvironmentError);
        expect(String(error)).toContain(field);
        expect(String(error)).not.toContain(placeholder);
      }
    },
  );

  it('rejects a semantically equivalent unpadded public PII encryption key', () => {
    const unpaddedPlaceholder = readExampleEnvironment('.env.example').PII_ENCRYPTION_KEY?.replace(
      /=+$/u,
      '',
    );
    expect(unpaddedPlaceholder).toBeTruthy();
    expect(() =>
      parseRuntimeConfig({
        ...validProductionEnvironment,
        PII_ENCRYPTION_KEY: unpaddedPlaceholder,
      }),
    ).toThrow(InvalidEnvironmentError);
  });

  it('normalizes the local S3 endpoint before checking the production placeholder', () => {
    expect(() =>
      parseRuntimeConfig({
        ...validProductionEnvironment,
        S3_ENDPOINT: 'http://LOCALHOST:9000/',
      }),
    ).toThrow(InvalidEnvironmentError);
  });

  it('keeps repository placeholders available only in development and test', () => {
    expect(() =>
      parseRuntimeConfig({
        ...validEnvironment,
        AUTH_JWT_SECRET: 'local_jwt_secret_replace_before_shared_deployment',
        NODE_ENV: 'development',
        PII_ENCRYPTION_KEY: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
        PII_HASH_KEY: 'local_pii_hash_key_replace_before_shared_deployment',
        S3_ACCESS_KEY: 'minio_local',
        S3_BUCKET: 'zalo-shop-local',
        S3_ENDPOINT: 'http://localhost:9000',
        S3_SECRET_KEY: 'minio_local_development_only',
      }),
    ).not.toThrow();
    expect(() =>
      parseRuntimeConfig({
        ...validEnvironment,
        AUTH_JWT_SECRET: 'test_jwt_secret_that_is_at_least_32_characters',
        NODE_ENV: 'test',
        PII_ENCRYPTION_KEY: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=',
        PII_HASH_KEY: 'test_pii_hash_key_that_is_at_least_32_characters',
        S3_ACCESS_KEY: 'minio_local',
        S3_BUCKET: 'zalo-shop-local',
        S3_ENDPOINT: 'http://localhost:9000',
        S3_SECRET_KEY: 'minio_local_development_only',
      }),
    ).not.toThrow();
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
