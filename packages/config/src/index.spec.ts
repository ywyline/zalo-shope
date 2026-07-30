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
  AFTER_SALE_CURSOR_HMAC_KEYS: Buffer.alloc(32, 4).toString('base64url'),
  AUTH_JWT_SECRET: 'j'.repeat(64),
  NODE_ENV: 'production',
  PII_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
  PII_HASH_KEY: 'h'.repeat(64),
  S3_ACCESS_KEY: 'a'.repeat(24),
  S3_BUCKET: 'production-fixture-bucket',
  S3_ENDPOINT: 'https://objects.example.test',
  S3_SECRET_KEY: 's'.repeat(32),
};

const validEvidenceStorageEnvironment = {
  ...validEnvironment,
  EVIDENCE_STORAGE_BUCKET: 'zalo-shop-evidence-test',
  EVIDENCE_STORAGE_DELETE_ACCESS_KEY: 'evidence-delete',
  EVIDENCE_STORAGE_DELETE_SECRET_KEY: 'evidence-delete-secret',
  EVIDENCE_STORAGE_ENDPOINT: 'http://localhost:9000',
  EVIDENCE_STORAGE_FORCE_PATH_STYLE: 'true',
  EVIDENCE_STORAGE_PROVIDER: 's3',
  EVIDENCE_STORAGE_READ_ACCESS_KEY: 'evidence-read',
  EVIDENCE_STORAGE_READ_SECRET_KEY: 'evidence-read-secret',
  EVIDENCE_STORAGE_REGION: 'us-east-1',
  EVIDENCE_STORAGE_SERVER_SIDE_ENCRYPTION: 'none',
  EVIDENCE_STORAGE_UPLOAD_ACCESS_KEY: 'evidence-upload',
  EVIDENCE_STORAGE_UPLOAD_SECRET_KEY: 'evidence-upload-secret',
  NODE_ENV: 'test',
};

const validEvidenceScannerEnvironment = {
  ...validEvidenceStorageEnvironment,
  AFTER_SALE_EVIDENCE_CLAIM_TTL_SECONDS: '86400',
  AFTER_SALE_EVIDENCE_DELETE_MAX_ATTEMPTS: '8',
  AFTER_SALE_EVIDENCE_DELETE_RETRY_BASE_DELAY_MS: '60000',
  AFTER_SALE_EVIDENCE_DELETE_RETRY_MAX_DELAY_MS: '21600000',
  AFTER_SALE_EVIDENCE_DELETION_WORKER_ENABLED: 'true',
  AFTER_SALE_EVIDENCE_FAILED_RETENTION_SECONDS: '86400',
  EVIDENCE_SCANNER_HOST: '127.0.0.1',
  EVIDENCE_SCANNER_PROVIDER: 'clamav',
  EVIDENCE_SCANNER_SIGNATURE_MAX_AGE_SECONDS: '604800',
};

const validMemberEvidenceUploadsEnvironment = {
  ...validEvidenceScannerEnvironment,
  AFTER_SALE_EVIDENCE_MAX_UNCLAIMED_BYTES: String(200 * 1_024 * 1_024),
  AFTER_SALE_EVIDENCE_MAX_UNCLAIMED_FILES: '12',
  AFTER_SALE_EVIDENCE_MEMBER_UPLOADS_ENABLED: 'true',
  AFTER_SALE_EVIDENCE_UPLOAD_TTL_SECONDS: '900',
};

const productionPlaceholderFields = [
  'AFTER_SALE_CURSOR_HMAC_KEYS',
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
    expect(config.AFTER_SALE_CURSOR_TTL_SECONDS).toBe(900);
    expect(config.API_PORT).toBe(3000);
    expect(config.WORKER_PORT).toBe(3001);
    expect(config.INVENTORY_EXPIRATION_INTERVAL_MS).toBe(5_000);
    expect(config.INVENTORY_EXPIRATION_BATCH_SIZE).toBe(100);
    expect(config.OUTBOX_WORKER_BATCH_SIZE).toBe(25);
    expect(config.OUTBOX_WORKER_INTERVAL_MS).toBe(1_000);
    expect(config.OUTBOX_WORKER_LEASE_MS).toBe(30_000);
    expect(config.OUTBOX_WORKER_RETRY_BASE_DELAY_MS).toBe(1_000);
    expect(config.OUTBOX_WORKER_RETRY_MAX_DELAY_MS).toBe(300_000);
    expect(config.PAYMENT_PROVIDER).toBe('disabled');
    expect(config.EVIDENCE_STORAGE_PROVIDER).toBe('disabled');
    expect(config.EVIDENCE_STORAGE_READ_URL_TTL_SECONDS).toBe(60);
    expect(config.EVIDENCE_STORAGE_REQUEST_TIMEOUT_MS).toBe(10_000);
    expect(config.EVIDENCE_STORAGE_UPLOAD_URL_TTL_SECONDS).toBe(300);
    expect(config.EVIDENCE_SCANNER_DEAD_LETTER_BATCH_SIZE).toBe(25);
    expect(config.EVIDENCE_SCANNER_DEAD_LETTER_INTERVAL_MS).toBe(5_000);
    expect(config.EVIDENCE_SCANNER_PORT).toBe(3310);
    expect(config.EVIDENCE_SCANNER_PROVIDER).toBe('disabled');
    expect(config.AFTER_SALE_EVIDENCE_DELETION_WORKER_ENABLED).toBe(false);
    expect(config.AFTER_SALE_EVIDENCE_DELETE_MAX_ATTEMPTS).toBeUndefined();
    expect(config.AFTER_SALE_EVIDENCE_LIFECYCLE_DEAD_LETTER_BATCH_SIZE).toBe(25);
    expect(config.AFTER_SALE_EVIDENCE_LIFECYCLE_DEAD_LETTER_INTERVAL_MS).toBe(5_000);
    expect(config.EVIDENCE_SCANNER_REQUEST_TIMEOUT_MS).toBe(10_000);
    expect(config.EVIDENCE_SCANNER_RESPONSE_LIMIT_BYTES).toBe(4_096);
    expect(config.EVIDENCE_SCANNER_SIGNATURE_MAX_AGE_SECONDS).toBeUndefined();
    expect(config.AFTER_SALE_EVIDENCE_MEMBER_UPLOADS_ENABLED).toBe(false);
    expect(config.AFTER_SALE_EVIDENCE_UPLOAD_TTL_SECONDS).toBeUndefined();
    expect(config.AFTER_SALE_EVIDENCE_MAX_UNCLAIMED_FILES).toBeUndefined();
    expect(config.AFTER_SALE_EVIDENCE_MAX_UNCLAIMED_BYTES).toBeUndefined();
    expect(config.PAYMENT_RECONCILIATION_ENABLED).toBe(false);
    expect(config.ZALO_CHECKOUT_REQUEST_TIMEOUT_MS).toBe(5_000);
    expect(config.ZALO_CHECKOUT_RESPONSE_LIMIT_BYTES).toBe(131_072);
    expect(config.ZALO_CHECKOUT_CALLBACK_IP_ALLOWLIST).toEqual(['118.102.2.29', '49.213.78.2']);
    expect(config.ZALO_CHECKOUT_CALLBACK_RATE_LIMIT_PER_MINUTE).toBe(120);
    expect(config.ZALO_CHECKOUT_MEMBER_QUERY_RATE_LIMIT_PER_MINUTE).toBe(10);
    expect(config.SEARCH_RATE_LIMIT_MAX_REQUESTS).toBe(120);
    expect(config.SEARCH_RATE_LIMIT_WINDOW_SECONDS).toBe(60);
    expect(config.S3_FORCE_PATH_STYLE).toBe(true);
    expect(config.S3_SESSION_TOKEN).toBeUndefined();
    expect(config.CONTENT_EXTERNAL_TARGET_HOSTS).toEqual([]);
  });

  it('enables evidence storage only with separate bucket and role credentials', () => {
    const config = parseRuntimeConfig(validEvidenceStorageEnvironment);
    expect(config).toMatchObject({
      EVIDENCE_STORAGE_BUCKET: 'zalo-shop-evidence-test',
      EVIDENCE_STORAGE_FORCE_PATH_STYLE: true,
      EVIDENCE_STORAGE_PROVIDER: 's3',
      EVIDENCE_STORAGE_SERVER_SIDE_ENCRYPTION: 'none',
    });

    expect(() =>
      parseRuntimeConfig({
        ...validEvidenceStorageEnvironment,
        EVIDENCE_STORAGE_BUCKET: validEnvironment.S3_BUCKET,
      }),
    ).toThrow(InvalidEnvironmentError);
    expect(() =>
      parseRuntimeConfig({
        ...validEvidenceStorageEnvironment,
        EVIDENCE_STORAGE_READ_ACCESS_KEY:
          validEvidenceStorageEnvironment.EVIDENCE_STORAGE_UPLOAD_ACCESS_KEY,
      }),
    ).toThrow(InvalidEnvironmentError);
    expect(() =>
      parseRuntimeConfig({
        ...validEvidenceStorageEnvironment,
        EVIDENCE_STORAGE_DELETE_SECRET_KEY: validEnvironment.S3_SECRET_KEY,
      }),
    ).toThrow(InvalidEnvironmentError);
  });

  it('keeps partial evidence configuration disabled and fails closed when enabled', () => {
    expect(
      parseRuntimeConfig({
        ...validEnvironment,
        EVIDENCE_STORAGE_BUCKET: 'unused-evidence-bucket',
      }).EVIDENCE_STORAGE_PROVIDER,
    ).toBe('disabled');
    expect(() =>
      parseRuntimeConfig({
        ...validEnvironment,
        EVIDENCE_STORAGE_BUCKET: 'evidence-bucket',
        EVIDENCE_STORAGE_PROVIDER: 's3',
      }),
    ).toThrow(InvalidEnvironmentError);
  });

  it('enables the real evidence scanner only with storage, lifecycle policy and lease budget', () => {
    expect(parseRuntimeConfig(validEvidenceScannerEnvironment)).toMatchObject({
      AFTER_SALE_EVIDENCE_CLAIM_TTL_SECONDS: 86_400,
      AFTER_SALE_EVIDENCE_FAILED_RETENTION_SECONDS: 86_400,
      EVIDENCE_SCANNER_HOST: '127.0.0.1',
      EVIDENCE_SCANNER_PORT: 3_310,
      EVIDENCE_SCANNER_PROVIDER: 'clamav',
      EVIDENCE_SCANNER_SIGNATURE_MAX_AGE_SECONDS: 604_800,
    });

    for (const field of [
      'AFTER_SALE_EVIDENCE_CLAIM_TTL_SECONDS',
      'AFTER_SALE_EVIDENCE_FAILED_RETENTION_SECONDS',
      'EVIDENCE_SCANNER_HOST',
      'EVIDENCE_SCANNER_SIGNATURE_MAX_AGE_SECONDS',
    ] as const) {
      expect(() => parseRuntimeConfig({ ...validEvidenceScannerEnvironment, [field]: '' })).toThrow(
        InvalidEnvironmentError,
      );
    }
    expect(() =>
      parseRuntimeConfig({
        ...validEvidenceScannerEnvironment,
        EVIDENCE_STORAGE_PROVIDER: 'disabled',
      }),
    ).toThrow(InvalidEnvironmentError);
    expect(() =>
      parseRuntimeConfig({
        ...validEvidenceScannerEnvironment,
        OUTBOX_WORKER_LEASE_MS: '28999',
      }),
    ).toThrow(InvalidEnvironmentError);
    expect(
      parseRuntimeConfig({
        ...validEvidenceScannerEnvironment,
        OUTBOX_WORKER_LEASE_MS: '29000',
      }).OUTBOX_WORKER_LEASE_MS,
    ).toBe(29_000);
    expect(
      parseRuntimeConfig({
        ...validEvidenceScannerEnvironment,
        OUTBOX_WORKER_LEASE_MS: '30000',
      }).OUTBOX_WORKER_LEASE_MS,
    ).toBe(30_000);
    expect(() =>
      parseRuntimeConfig({
        ...validEvidenceScannerEnvironment,
        EVIDENCE_SCANNER_RESPONSE_LIMIT_BYTES: '255',
      }),
    ).toThrow(InvalidEnvironmentError);
  });

  it('keeps deletion independent from ClamAV and freezes the bounded retry contract', () => {
    const deletionOnly = {
      ...validEvidenceStorageEnvironment,
      AFTER_SALE_EVIDENCE_DELETE_MAX_ATTEMPTS: '8',
      AFTER_SALE_EVIDENCE_DELETE_RETRY_BASE_DELAY_MS: '60000',
      AFTER_SALE_EVIDENCE_DELETE_RETRY_MAX_DELAY_MS: '21600000',
      AFTER_SALE_EVIDENCE_DELETION_WORKER_ENABLED: 'true',
    };
    expect(parseRuntimeConfig(deletionOnly)).toMatchObject({
      AFTER_SALE_EVIDENCE_DELETE_MAX_ATTEMPTS: 8,
      AFTER_SALE_EVIDENCE_DELETION_WORKER_ENABLED: true,
      EVIDENCE_SCANNER_PROVIDER: 'disabled',
    });
    for (const field of [
      'AFTER_SALE_EVIDENCE_DELETE_MAX_ATTEMPTS',
      'AFTER_SALE_EVIDENCE_DELETE_RETRY_BASE_DELAY_MS',
      'AFTER_SALE_EVIDENCE_DELETE_RETRY_MAX_DELAY_MS',
    ] as const) {
      expect(() => parseRuntimeConfig({ ...deletionOnly, [field]: '' })).toThrow(
        InvalidEnvironmentError,
      );
    }
    expect(() =>
      parseRuntimeConfig({ ...deletionOnly, AFTER_SALE_EVIDENCE_DELETE_MAX_ATTEMPTS: '7' }),
    ).toThrow(InvalidEnvironmentError);
    expect(() => parseRuntimeConfig({ ...deletionOnly, OUTBOX_WORKER_LEASE_MS: '18999' })).toThrow(
      InvalidEnvironmentError,
    );
    expect(
      parseRuntimeConfig({ ...deletionOnly, OUTBOX_WORKER_LEASE_MS: '19000' })
        .OUTBOX_WORKER_LEASE_MS,
    ).toBe(19_000);
  });

  it('enables member evidence HTTP only with explicit limits, storage and scanning', () => {
    expect(parseRuntimeConfig(validMemberEvidenceUploadsEnvironment)).toMatchObject({
      AFTER_SALE_EVIDENCE_MAX_UNCLAIMED_BYTES: 200 * 1_024 * 1_024,
      AFTER_SALE_EVIDENCE_MAX_UNCLAIMED_FILES: 12,
      AFTER_SALE_EVIDENCE_MEMBER_UPLOADS_ENABLED: true,
      AFTER_SALE_EVIDENCE_UPLOAD_TTL_SECONDS: 900,
    });

    for (const field of [
      'AFTER_SALE_EVIDENCE_MAX_UNCLAIMED_BYTES',
      'AFTER_SALE_EVIDENCE_MAX_UNCLAIMED_FILES',
      'AFTER_SALE_EVIDENCE_UPLOAD_TTL_SECONDS',
    ] as const) {
      expect(() =>
        parseRuntimeConfig({ ...validMemberEvidenceUploadsEnvironment, [field]: '' }),
      ).toThrow(InvalidEnvironmentError);
    }
    expect(() =>
      parseRuntimeConfig({
        ...validMemberEvidenceUploadsEnvironment,
        EVIDENCE_SCANNER_PROVIDER: 'disabled',
      }),
    ).toThrow(InvalidEnvironmentError);
    expect(() =>
      parseRuntimeConfig({
        ...validMemberEvidenceUploadsEnvironment,
        AFTER_SALE_EVIDENCE_UPLOAD_TTL_SECONDS: '299',
      }),
    ).toThrow(InvalidEnvironmentError);
    expect(
      parseRuntimeConfig({
        ...validEvidenceScannerEnvironment,
        AFTER_SALE_EVIDENCE_MEMBER_UPLOADS_ENABLED: 'false',
      }).AFTER_SALE_EVIDENCE_MEMBER_UPLOADS_ENABLED,
    ).toBe(false);
  });

  it('allows only an explicit loopback ClamAV sidecar in production', () => {
    const productionScanner = {
      ...validEvidenceScannerEnvironment,
      ...validProductionEnvironment,
      EVIDENCE_STORAGE_BUCKET: 'production-evidence-fixture',
      EVIDENCE_STORAGE_DELETE_ACCESS_KEY: 'd'.repeat(24),
      EVIDENCE_STORAGE_DELETE_SECRET_KEY: 'D'.repeat(40),
      EVIDENCE_STORAGE_ENDPOINT: 'https://evidence.example.test',
      EVIDENCE_STORAGE_FORCE_PATH_STYLE: 'false',
      EVIDENCE_STORAGE_KMS_KEY_ID: 'arn:aws:kms:ap-southeast-1:123456789012:key/example',
      EVIDENCE_STORAGE_PROVIDER: 's3',
      EVIDENCE_STORAGE_READ_ACCESS_KEY: 'r'.repeat(24),
      EVIDENCE_STORAGE_READ_SECRET_KEY: 'R'.repeat(40),
      EVIDENCE_STORAGE_REGION: 'ap-southeast-1',
      EVIDENCE_STORAGE_SERVER_SIDE_ENCRYPTION: 'aws:kms',
      EVIDENCE_STORAGE_UPLOAD_ACCESS_KEY: 'u'.repeat(24),
      EVIDENCE_STORAGE_UPLOAD_SECRET_KEY: 'U'.repeat(40),
      EVIDENCE_SCANNER_HOST: '127.0.0.1',
      NODE_ENV: 'production',
    };
    expect(parseRuntimeConfig(productionScanner).EVIDENCE_SCANNER_PROVIDER).toBe('clamav');
    expect(() =>
      parseRuntimeConfig({ ...productionScanner, EVIDENCE_SCANNER_HOST: 'clamd.internal' }),
    ).toThrow(InvalidEnvironmentError);
    expect(() =>
      parseRuntimeConfig({ ...productionScanner, EVIDENCE_SCANNER_HOST: 'localhost' }),
    ).toThrow(InvalidEnvironmentError);
  });

  it.each([
    'ftp://objects.example.test',
    'http://user:password@objects.example.test',
    'http://objects.example.test?bucket=evidence',
    'http://objects.example.test#evidence',
  ])('rejects an unsafe evidence storage endpoint: %s', (endpoint) => {
    expect(() =>
      parseRuntimeConfig({
        ...validEvidenceStorageEnvironment,
        EVIDENCE_STORAGE_ENDPOINT: endpoint,
      }),
    ).toThrow(InvalidEnvironmentError);
  });

  it.each([
    ['EVIDENCE_STORAGE_BUCKET', 'Invalid/Bucket'],
    ['EVIDENCE_STORAGE_BUCKET', '-invalid-bucket'],
    ['EVIDENCE_STORAGE_BUCKET', 'invalid..bucket'],
    ['EVIDENCE_STORAGE_BUCKET', '192.168.0.1'],
    ['EVIDENCE_STORAGE_REGION', 'US_EAST_1'],
  ] as const)('rejects an invalid evidence storage %s', (field, value) => {
    expect(() =>
      parseRuntimeConfig({
        ...validEvidenceStorageEnvironment,
        [field]: value,
      }),
    ).toThrow(InvalidEnvironmentError);
  });

  it('requires HTTPS and a non-placeholder KMS configuration for production evidence storage', () => {
    const productionEvidence = {
      ...validEvidenceStorageEnvironment,
      ...validProductionEnvironment,
      EVIDENCE_STORAGE_BUCKET: 'production-evidence-fixture',
      EVIDENCE_STORAGE_DELETE_ACCESS_KEY: 'd'.repeat(24),
      EVIDENCE_STORAGE_DELETE_SECRET_KEY: 'D'.repeat(40),
      EVIDENCE_STORAGE_ENDPOINT: 'https://evidence.example.test',
      EVIDENCE_STORAGE_KMS_KEY_ID: 'arn:aws:kms:ap-southeast-1:123456789012:key/example',
      EVIDENCE_STORAGE_READ_ACCESS_KEY: 'r'.repeat(24),
      EVIDENCE_STORAGE_READ_SECRET_KEY: 'R'.repeat(40),
      EVIDENCE_STORAGE_SERVER_SIDE_ENCRYPTION: 'aws:kms',
      EVIDENCE_STORAGE_UPLOAD_ACCESS_KEY: 'u'.repeat(24),
      EVIDENCE_STORAGE_UPLOAD_SECRET_KEY: 'U'.repeat(40),
      NODE_ENV: 'production',
    };
    expect(parseRuntimeConfig(productionEvidence).EVIDENCE_STORAGE_PROVIDER).toBe('s3');
    expect(() =>
      parseRuntimeConfig({ ...productionEvidence, EVIDENCE_STORAGE_ENDPOINT: 'http://s3.test' }),
    ).toThrow(InvalidEnvironmentError);
    expect(() =>
      parseRuntimeConfig({
        ...productionEvidence,
        EVIDENCE_STORAGE_KMS_KEY_ID: '',
        EVIDENCE_STORAGE_SERVER_SIDE_ENCRYPTION: 'AES256',
      }),
    ).toThrow(InvalidEnvironmentError);
    expect(() =>
      parseRuntimeConfig({
        ...productionEvidence,
        EVIDENCE_STORAGE_BUCKET: 'zalo-shop-evidence-local',
      }),
    ).toThrow(InvalidEnvironmentError);
  });

  it('does not expose invalid evidence secrets in configuration errors', () => {
    const secret = 'tiny';
    try {
      parseRuntimeConfig({
        ...validEvidenceStorageEnvironment,
        EVIDENCE_STORAGE_DELETE_SECRET_KEY: secret,
      });
      throw new Error('expected evidence storage validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidEnvironmentError);
      expect(String(error)).toContain('EVIDENCE_STORAGE_DELETE_SECRET_KEY');
      expect(String(error)).not.toContain(secret);
    }
  });

  it('validates the dedicated rotatable after-sale cursor key ring', () => {
    const current = Buffer.alloc(32, 4).toString('base64url');
    const previous = Buffer.alloc(32, 5).toString('base64url');
    expect(
      parseRuntimeConfig({
        ...validEnvironment,
        AFTER_SALE_CURSOR_HMAC_KEYS: `${current},${previous}`,
      }).AFTER_SALE_CURSOR_HMAC_KEYS,
    ).toBe(`${current},${previous}`);
    expect(() =>
      parseRuntimeConfig({ ...validEnvironment, AFTER_SALE_CURSOR_HMAC_KEYS: 'too-short' }),
    ).toThrow(InvalidEnvironmentError);
    expect(() =>
      parseRuntimeConfig({
        ...validEnvironment,
        AFTER_SALE_CURSOR_HMAC_KEYS: `${current},${current}`,
      }),
    ).toThrow(InvalidEnvironmentError);
  });

  it('rejects a repository cursor key mixed into either position of a production key ring', () => {
    const realKey = Buffer.alloc(32, 6).toString('base64url');
    const placeholders = ['.env.example', '.env.test.example'].map((fileName) => {
      const placeholder = readExampleEnvironment(fileName).AFTER_SALE_CURSOR_HMAC_KEYS;
      if (!placeholder) throw new Error(`${fileName} is missing AFTER_SALE_CURSOR_HMAC_KEYS`);
      return placeholder;
    });

    for (const placeholder of placeholders) {
      expect(() =>
        parseRuntimeConfig({
          ...validProductionEnvironment,
          AFTER_SALE_CURSOR_HMAC_KEYS: `${placeholder},${realKey}`,
        }),
      ).toThrow(InvalidEnvironmentError);
      expect(() =>
        parseRuntimeConfig({
          ...validProductionEnvironment,
          AFTER_SALE_CURSOR_HMAC_KEYS: `${realKey},${placeholder}`,
        }),
      ).toThrow(InvalidEnvironmentError);
    }
  });

  it('rejects an outbox retry cap below its base delay', () => {
    expect(() =>
      parseRuntimeConfig({
        ...validEnvironment,
        OUTBOX_WORKER_RETRY_BASE_DELAY_MS: '5000',
        OUTBOX_WORKER_RETRY_MAX_DELAY_MS: '1000',
      }),
    ).toThrow(InvalidEnvironmentError);
  });

  it('allows the deterministic payment provider only in test with a dedicated secret', () => {
    expect(
      parseRuntimeConfig({
        ...validEnvironment,
        NODE_ENV: 'test',
        PAYMENT_PROVIDER: 'test',
        PAYMENT_TEST_PROVIDER_SECRET: 'p'.repeat(32),
      }).PAYMENT_PROVIDER,
    ).toBe('test');
    expect(() =>
      parseRuntimeConfig({ ...validEnvironment, NODE_ENV: 'test', PAYMENT_PROVIDER: 'test' }),
    ).toThrow(InvalidEnvironmentError);
    expect(() =>
      parseRuntimeConfig({
        ...validEnvironment,
        NODE_ENV: 'development',
        PAYMENT_PROVIDER: 'test',
        PAYMENT_TEST_PROVIDER_SECRET: 'p'.repeat(32),
      }),
    ).toThrow(InvalidEnvironmentError);
  });

  it('gates reconciliation production and keeps provider work inside the outbox lease', () => {
    expect(() =>
      parseRuntimeConfig({
        ...validEnvironment,
        PAYMENT_RECONCILIATION_ENABLED: 'true',
      }),
    ).toThrow(InvalidEnvironmentError);
    expect(() =>
      parseRuntimeConfig({
        ...validEnvironment,
        NODE_ENV: 'test',
        OUTBOX_WORKER_INTERVAL_MS: '30001',
        PAYMENT_PROVIDER: 'test',
        PAYMENT_RECONCILIATION_ENABLED: 'true',
        PAYMENT_TEST_PROVIDER_SECRET: 'p'.repeat(32),
      }),
    ).toThrow(InvalidEnvironmentError);
    expect(() =>
      parseRuntimeConfig({
        ...validEnvironment,
        NODE_ENV: 'test',
        OUTBOX_WORKER_LEASE_MS: '9000',
        PAYMENT_PROVIDER: 'test',
        PAYMENT_RECONCILIATION_ENABLED: 'true',
        PAYMENT_TEST_PROVIDER_SECRET: 'p'.repeat(32),
        ZALO_CHECKOUT_REQUEST_TIMEOUT_MS: '5000',
      }),
    ).toThrow(InvalidEnvironmentError);
    expect(
      parseRuntimeConfig({
        ...validEnvironment,
        NODE_ENV: 'test',
        PAYMENT_PROVIDER: 'test',
        PAYMENT_RECONCILIATION_ENABLED: 'true',
        PAYMENT_TEST_PROVIDER_SECRET: 'p'.repeat(32),
      }).PAYMENT_RECONCILIATION_ENABLED,
    ).toBe(true);
  });

  it('allows the real adapter mode without accepting a repository secret value', () => {
    const config = parseRuntimeConfig({
      ...validProductionEnvironment,
      PAYMENT_PROVIDER: 'zalo-checkout',
    });
    expect(config.PAYMENT_PROVIDER).toBe('zalo-checkout');
    expect(config.PAYMENT_TEST_PROVIDER_SECRET).toBeUndefined();
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
