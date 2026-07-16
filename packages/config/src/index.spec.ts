import { describe, expect, it } from 'vitest';

import { InvalidEnvironmentError, parseRuntimeConfig } from './index';

const validEnvironment = {
  DATABASE_URL: 'postgresql://user:password@localhost:5432/database',
  REDIS_URL: 'redis://localhost:6379/0',
  S3_ACCESS_KEY: 'access-key',
  S3_BUCKET: 'test-bucket',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_SECRET_KEY: 'secret-key',
};

describe('parseRuntimeConfig', () => {
  it('applies safe development defaults', () => {
    const config = parseRuntimeConfig(validEnvironment);

    expect(config.NODE_ENV).toBe('development');
    expect(config.API_PORT).toBe(3000);
    expect(config.WORKER_PORT).toBe(3001);
    expect(config.S3_FORCE_PATH_STYLE).toBe(true);
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
});
