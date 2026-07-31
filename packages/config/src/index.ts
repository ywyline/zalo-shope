import { z } from 'zod';
import { isIP } from 'node:net';

const booleanFromString = z
  .enum(['true', 'false'])
  .default('true')
  .transform((value) => value === 'true');

const disabledBooleanFromString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const optionalBooleanFromString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
);

const optionalNumericIdentifier = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().regex(/^\d+$/, 'must contain digits only').optional(),
);

const optionalSecret = z.preprocess(
  (value) => (typeof value === 'string' && value === '' ? undefined : value),
  z.string().min(8).optional(),
);

const optionalStrongSecret = z.preprocess(
  (value) => (typeof value === 'string' && value === '' ? undefined : value),
  z.string().min(32).optional(),
);

const optionalNonEmptyString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().min(1).optional(),
);

function optionalInteger(minimum: number, maximum: number) {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.coerce.number().int().min(minimum).max(maximum).optional(),
  );
}

const optionalScannerHost = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z
    .string()
    .trim()
    .min(1)
    .max(253)
    .refine(
      (value) =>
        isIP(value) !== 0 ||
        (/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/iu.test(value) && !value.includes('..')),
      'must be an IP address or DNS host name',
    )
    .transform((value) => value.toLowerCase())
    .optional(),
);

const OBJECT_STORAGE_BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const EVIDENCE_SCAN_LEASE_TRANSACTION_TIMEOUT_MS = 2_000;
const EVIDENCE_SCAN_COMMIT_MARGIN_MS = 5_000;
const EVIDENCE_DELETE_LEASE_TRANSACTION_TIMEOUT_MS = 2_000;
const EVIDENCE_DELETE_COMMIT_MARGIN_MS = 5_000;
const EVIDENCE_DELETE_MAX_ATTEMPTS = 8;
const EVIDENCE_DELETE_MIN_DELAY_MS = 60_000;
const EVIDENCE_DELETE_MAX_DELAY_MS = 6 * 60 * 60 * 1_000;

function isValidObjectStorageBucket(value: string): boolean {
  return OBJECT_STORAGE_BUCKET_PATTERN.test(value) && !value.includes('..') && isIP(value) === 0;
}

const optionalObjectStorageEndpoint = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z
    .string()
    .url()
    .refine((value) => {
      const endpoint = new URL(value);
      return (
        ['http:', 'https:'].includes(endpoint.protocol) &&
        endpoint.username === '' &&
        endpoint.password === '' &&
        endpoint.search === '' &&
        endpoint.hash === ''
      );
    }, 'must be an HTTP(S) origin without credentials, query parameters or fragments')
    .optional(),
);

const optionalObjectStorageBucket = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().refine(isValidObjectStorageBucket, 'must be a valid S3 bucket name').optional(),
);

const optionalObjectStorageRegion = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/u, 'must be a valid S3 region identifier')
    .optional(),
);

const localAfterSaleCursorHmacKey = 'bG9jYWxfYWZ0ZXJfc2FsZV9jdXJzb3JfaG1hY19rZXk';
const testAfterSaleCursorHmacKey = 'dGVzdF9hZnRlcl9zYWxlX2N1cnNvcl9obWFjX2tleV8x';

function isValidCursorHmacKeyRing(value: string): boolean {
  const keys = value.split(',');
  return (
    keys.length >= 1 &&
    keys.length <= 3 &&
    new Set(keys).size === keys.length &&
    keys.every((key) => {
      if (!/^[A-Za-z0-9_-]{43,128}$/u.test(key)) return false;
      const decoded = Buffer.from(key, 'base64url');
      return decoded.length >= 32 && decoded.toString('base64url') === key;
    })
  );
}

const productionPlaceholderValues = {
  AFTER_SALE_CURSOR_HMAC_KEYS: [localAfterSaleCursorHmacKey, testAfterSaleCursorHmacKey],
  AUTH_JWT_SECRET: [
    'local_jwt_secret_replace_before_shared_deployment',
    'test_jwt_secret_that_is_at_least_32_characters',
  ],
  PII_ENCRYPTION_KEY: [
    'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
    'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=',
  ],
  PII_HASH_KEY: [
    'local_pii_hash_key_replace_before_shared_deployment',
    'test_pii_hash_key_that_is_at_least_32_characters',
  ],
  S3_ACCESS_KEY: ['minio_local', 'minio_content_local', 'minio_content_test'],
  S3_BUCKET: ['zalo-shop-local'],
  S3_ENDPOINT: ['http://localhost:9000'],
  S3_SECRET_KEY: [
    'minio_local_development_only',
    'minio_content_local_development_only',
    'minio_content_test_only',
  ],
} as const;

const evidenceStorageProductionPlaceholderValues = {
  EVIDENCE_STORAGE_BUCKET: ['zalo-shop-evidence-local'],
  EVIDENCE_STORAGE_DELETE_ACCESS_KEY: ['minio_evidence_delete_local', 'minio_evidence_delete_test'],
  EVIDENCE_STORAGE_DELETE_SECRET_KEY: [
    'minio_evidence_delete_local_only',
    'minio_evidence_delete_test_only',
  ],
  EVIDENCE_STORAGE_ENDPOINT: ['http://localhost:9000'],
  EVIDENCE_STORAGE_KMS_KEY_ID: ['local-evidence-kms-key'],
  EVIDENCE_STORAGE_READ_ACCESS_KEY: ['minio_evidence_read_local', 'minio_evidence_read_test'],
  EVIDENCE_STORAGE_READ_SECRET_KEY: [
    'minio_evidence_read_local_only',
    'minio_evidence_read_test_only',
  ],
  EVIDENCE_STORAGE_UPLOAD_ACCESS_KEY: ['minio_evidence_upload_local', 'minio_evidence_upload_test'],
  EVIDENCE_STORAGE_UPLOAD_SECRET_KEY: [
    'minio_evidence_upload_local_only',
    'minio_evidence_upload_test_only',
  ],
} as const;

type ProductionPlaceholderField = keyof typeof productionPlaceholderValues;
type EvidenceStorageProductionPlaceholderField =
  keyof typeof evidenceStorageProductionPlaceholderValues;

function isProductionPlaceholder(field: ProductionPlaceholderField, value: string): boolean {
  const placeholders = productionPlaceholderValues[field] as readonly string[];
  if (field === 'AFTER_SALE_CURSOR_HMAC_KEYS') {
    return value.split(',').some((key) => placeholders.includes(key));
  }
  if (field === 'PII_ENCRYPTION_KEY') {
    const decodedValue = Buffer.from(value, 'base64');
    return placeholders.some((placeholder) =>
      decodedValue.equals(Buffer.from(placeholder, 'base64')),
    );
  }
  if (field !== 'S3_ENDPOINT') return placeholders.includes(value);

  try {
    const normalizedValue = new URL(value).href;
    return placeholders.some((placeholder) => new URL(placeholder).href === normalizedValue);
  } catch {
    return false;
  }
}

function isEvidenceStorageProductionPlaceholder(
  field: EvidenceStorageProductionPlaceholderField,
  value: string,
): boolean {
  return (evidenceStorageProductionPlaceholderValues[field] as readonly string[]).includes(value);
}

const runtimeConfigSchema = z
  .object({
    AUTH_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
    AFTER_SALE_CURSOR_HMAC_KEYS: z
      .string()
      .default(localAfterSaleCursorHmacKey)
      .refine(
        isValidCursorHmacKeyRing,
        'must contain one to three unique comma-separated base64url keys of at least 32 bytes',
      ),
    AFTER_SALE_CURSOR_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
    AFTER_SALE_COMMANDS_ENABLED: disabledBooleanFromString,
    AFTER_SALE_REVIEW_COMMANDS_ENABLED: disabledBooleanFromString,
    AFTER_SALE_RETURN_EXPIRATION_WORKER_ENABLED: disabledBooleanFromString,
    AFTER_SALE_RETURN_EXPIRATION_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),
    AFTER_SALE_RETURN_EXPIRATION_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(300_000)
      .default(5_000),
    AUTH_JWT_AUDIENCE: z.string().min(3),
    AUTH_JWT_ISSUER: z.string().min(3),
    AUTH_JWT_SECRET: z.string().min(32),
    AUTH_REFRESH_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(3_600)
      .max(60 * 60 * 24 * 90)
      .default(2_592_000),
    API_HOST: z.string().min(1).default('0.0.0.0'),
    API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    CONTENT_EXTERNAL_TARGET_HOSTS: z
      .string()
      .default('')
      .transform((value) =>
        value
          .split(',')
          .map((host) => host.trim().toLowerCase())
          .filter(Boolean),
      )
      .refine(
        (hosts) => hosts.every((host) => /^[a-z0-9.-]+$/.test(host) && !host.includes('..')),
        'must contain comma-separated host names',
      ),
    DATABASE_URL: z.string().url().startsWith('postgresql://'),
    DATABASE_RUNTIME_URL: z.string().url().startsWith('postgresql://'),
    EVIDENCE_STORAGE_BUCKET: optionalObjectStorageBucket,
    EVIDENCE_STORAGE_DELETE_ACCESS_KEY: optionalNonEmptyString,
    EVIDENCE_STORAGE_DELETE_SECRET_KEY: optionalSecret,
    EVIDENCE_STORAGE_DELETE_SESSION_TOKEN: optionalSecret,
    EVIDENCE_STORAGE_ENDPOINT: optionalObjectStorageEndpoint,
    EVIDENCE_STORAGE_FORCE_PATH_STYLE: optionalBooleanFromString,
    EVIDENCE_STORAGE_KMS_KEY_ID: optionalNonEmptyString,
    EVIDENCE_STORAGE_PROVIDER: z.enum(['disabled', 's3']).default('disabled'),
    EVIDENCE_STORAGE_READ_ACCESS_KEY: optionalNonEmptyString,
    EVIDENCE_STORAGE_READ_SECRET_KEY: optionalSecret,
    EVIDENCE_STORAGE_READ_SESSION_TOKEN: optionalSecret,
    EVIDENCE_STORAGE_READ_URL_TTL_SECONDS: z.coerce.number().int().min(15).max(300).default(60),
    EVIDENCE_STORAGE_REGION: optionalObjectStorageRegion,
    EVIDENCE_STORAGE_REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(500)
      .max(30_000)
      .default(10_000),
    EVIDENCE_STORAGE_SERVER_SIDE_ENCRYPTION: z.enum(['none', 'AES256', 'aws:kms']).default('none'),
    EVIDENCE_STORAGE_UPLOAD_ACCESS_KEY: optionalNonEmptyString,
    EVIDENCE_STORAGE_UPLOAD_SECRET_KEY: optionalSecret,
    EVIDENCE_STORAGE_UPLOAD_SESSION_TOKEN: optionalSecret,
    EVIDENCE_STORAGE_UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
    EVIDENCE_SCANNER_DEAD_LETTER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(25),
    EVIDENCE_SCANNER_DEAD_LETTER_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(300_000)
      .default(5_000),
    EVIDENCE_SCANNER_HOST: optionalScannerHost,
    EVIDENCE_SCANNER_PORT: z.coerce.number().int().min(1).max(65_535).default(3310),
    EVIDENCE_SCANNER_PROVIDER: z.enum(['clamav', 'disabled']).default('disabled'),
    EVIDENCE_SCANNER_REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(500)
      .max(120_000)
      .default(10_000),
    EVIDENCE_SCANNER_RESPONSE_LIMIT_BYTES: z.coerce
      .number()
      .int()
      .min(256)
      .max(16_384)
      .default(4_096),
    EVIDENCE_SCANNER_SIGNATURE_MAX_AGE_SECONDS: optionalInteger(3_600, 30 * 24 * 60 * 60),
    AFTER_SALE_EVIDENCE_DELETION_WORKER_ENABLED: disabledBooleanFromString,
    AFTER_SALE_EVIDENCE_DELETE_RETRY_BASE_DELAY_MS: optionalInteger(
      EVIDENCE_DELETE_MIN_DELAY_MS,
      EVIDENCE_DELETE_MAX_DELAY_MS,
    ),
    AFTER_SALE_EVIDENCE_DELETE_RETRY_MAX_DELAY_MS: optionalInteger(
      EVIDENCE_DELETE_MIN_DELAY_MS,
      EVIDENCE_DELETE_MAX_DELAY_MS,
    ),
    AFTER_SALE_EVIDENCE_DELETE_MAX_ATTEMPTS: optionalInteger(
      EVIDENCE_DELETE_MAX_ATTEMPTS,
      EVIDENCE_DELETE_MAX_ATTEMPTS,
    ),
    AFTER_SALE_EVIDENCE_LIFECYCLE_DEAD_LETTER_BATCH_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25),
    AFTER_SALE_EVIDENCE_LIFECYCLE_DEAD_LETTER_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(300_000)
      .default(5_000),
    AFTER_SALE_EVIDENCE_CLAIM_TTL_SECONDS: optionalInteger(60, 7 * 24 * 60 * 60),
    AFTER_SALE_EVIDENCE_FAILED_RETENTION_SECONDS: optionalInteger(60, 7 * 24 * 60 * 60),
    AFTER_SALE_EVIDENCE_MAX_UNCLAIMED_BYTES: optionalInteger(
      50 * 1_024 * 1_024,
      5 * 1_024 * 1_024 * 1_024,
    ),
    AFTER_SALE_EVIDENCE_MAX_UNCLAIMED_FILES: optionalInteger(1, 100),
    AFTER_SALE_EVIDENCE_MEMBER_UPLOADS_ENABLED: disabledBooleanFromString,
    AFTER_SALE_EVIDENCE_PROTECTED_READS_ENABLED: disabledBooleanFromString,
    AFTER_SALE_EVIDENCE_ORDINARY_ACCESS_TTL_SECONDS: optionalInteger(60, 10 * 365 * 24 * 60 * 60),
    AFTER_SALE_EVIDENCE_RETENTION_TTL_SECONDS: optionalInteger(60, 10 * 365 * 24 * 60 * 60),
    AFTER_SALE_EVIDENCE_UPLOAD_TTL_SECONDS: optionalInteger(60, 60 * 60),
    INVENTORY_EXPIRATION_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),
    INVENTORY_EXPIRATION_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(300_000)
      .default(5_000),
    OUTBOX_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(25),
    OUTBOX_WORKER_INTERVAL_MS: z.coerce.number().int().min(1_000).max(300_000).default(1_000),
    OUTBOX_WORKER_LEASE_MS: z.coerce.number().int().min(5_000).max(300_000).default(30_000),
    OUTBOX_WORKER_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(100).max(300_000).default(1_000),
    OUTBOX_WORKER_RETRY_MAX_DELAY_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(3_600_000)
      .default(300_000),
    PAYMENT_PROVIDER: z.enum(['disabled', 'test', 'zalo-checkout']).default('disabled'),
    PAYMENT_RECONCILIATION_ENABLED: disabledBooleanFromString,
    PAYMENT_TEST_PROVIDER_SECRET: optionalStrongSecret,
    SHIPPING_PROVIDER: z.enum(['disabled', 'ghn']).default('disabled'),
    GHN_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(500).max(10_000).default(5_000),
    GHN_RESPONSE_LIMIT_BYTES: z.coerce.number().int().min(1_024).max(262_144).default(131_072),
    GHN_CALLBACK_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).max(10_000).default(120),
    ZALO_CHECKOUT_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(500).max(10_000).default(5_000),
    ZALO_CHECKOUT_RESPONSE_LIMIT_BYTES: z.coerce
      .number()
      .int()
      .min(1_024)
      .max(262_144)
      .default(131_072),
    ZALO_CHECKOUT_CALLBACK_IP_ALLOWLIST: z
      .string()
      .default('118.102.2.29,49.213.78.2')
      .transform((value) =>
        value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      )
      .refine((values) => values.length > 0 && values.every((value) => isIP(value) !== 0), {
        message: 'must contain comma-separated IP addresses',
      }),
    ZALO_CHECKOUT_CALLBACK_RATE_LIMIT_PER_MINUTE: z.coerce
      .number()
      .int()
      .min(10)
      .max(10_000)
      .default(120),
    ZALO_CHECKOUT_MEMBER_QUERY_RATE_LIMIT_PER_MINUTE: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(10),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PII_ENCRYPTION_KEY: z
      .string()
      .refine((value) => Buffer.from(value, 'base64').length === 32, 'must decode to 32 bytes'),
    PII_HASH_KEY: z.string().min(32),
    REDIS_URL: z.string().url().startsWith('redis://'),
    SEARCH_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(10).max(10_000).default(120),
    SEARCH_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(10).max(3_600).default(60),
    S3_ACCESS_KEY: z.string().min(1),
    S3_BUCKET: z.string().min(3),
    S3_ENDPOINT: z.string().url(),
    S3_FORCE_PATH_STYLE: booleanFromString,
    S3_REGION: z.string().min(1).default('us-east-1'),
    S3_SECRET_KEY: z.string().min(8),
    S3_SESSION_TOKEN: optionalSecret,
    WORKER_HOST: z.string().min(1).default('0.0.0.0'),
    WORKER_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
    ZALO_APP_ID: optionalNumericIdentifier,
    ZALO_APP_SECRET: optionalSecret,
    ZALO_IDENTITY_PROVIDER: z.enum(['disabled', 'open-api', 'test']).default('disabled'),
    ZALO_MINI_APP_ID: optionalNumericIdentifier,
    ZALO_OPEN_API_TIMEOUT_MS: z.coerce.number().int().min(500).max(10_000).default(5_000),
    ZALO_TEST_TOKEN_SECRET: z.string().min(32).optional(),
    ZALO_TOKEN_METADATA_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(300),
  })
  .superRefine((config, context) => {
    if (config.EVIDENCE_STORAGE_PROVIDER === 's3') {
      const requiredFields = [
        'EVIDENCE_STORAGE_BUCKET',
        'EVIDENCE_STORAGE_DELETE_ACCESS_KEY',
        'EVIDENCE_STORAGE_DELETE_SECRET_KEY',
        'EVIDENCE_STORAGE_ENDPOINT',
        'EVIDENCE_STORAGE_FORCE_PATH_STYLE',
        'EVIDENCE_STORAGE_READ_ACCESS_KEY',
        'EVIDENCE_STORAGE_READ_SECRET_KEY',
        'EVIDENCE_STORAGE_REGION',
        'EVIDENCE_STORAGE_UPLOAD_ACCESS_KEY',
        'EVIDENCE_STORAGE_UPLOAD_SECRET_KEY',
      ] as const;
      for (const field of requiredFields) {
        if (config[field] !== undefined) continue;
        context.addIssue({
          code: 'custom',
          message: 'is required when EVIDENCE_STORAGE_PROVIDER=s3',
          path: [field],
        });
      }

      if (config.EVIDENCE_STORAGE_BUCKET === config.S3_BUCKET) {
        context.addIssue({
          code: 'custom',
          message: 'must be different from S3_BUCKET',
          path: ['EVIDENCE_STORAGE_BUCKET'],
        });
      }
      const accessKeys = [
        config.EVIDENCE_STORAGE_UPLOAD_ACCESS_KEY,
        config.EVIDENCE_STORAGE_READ_ACCESS_KEY,
        config.EVIDENCE_STORAGE_DELETE_ACCESS_KEY,
      ].filter((value): value is string => value !== undefined);
      if (
        accessKeys.includes(config.S3_ACCESS_KEY) ||
        new Set(accessKeys).size !== accessKeys.length
      ) {
        context.addIssue({
          code: 'custom',
          message: 'must use three distinct keys that are separate from S3_ACCESS_KEY',
          path: ['EVIDENCE_STORAGE_UPLOAD_ACCESS_KEY'],
        });
      }
      const secretKeys = [
        config.EVIDENCE_STORAGE_UPLOAD_SECRET_KEY,
        config.EVIDENCE_STORAGE_READ_SECRET_KEY,
        config.EVIDENCE_STORAGE_DELETE_SECRET_KEY,
      ].filter((value): value is string => value !== undefined);
      if (
        secretKeys.includes(config.S3_SECRET_KEY) ||
        new Set(secretKeys).size !== secretKeys.length
      ) {
        context.addIssue({
          code: 'custom',
          message: 'must use three distinct secrets that are separate from S3_SECRET_KEY',
          path: ['EVIDENCE_STORAGE_UPLOAD_SECRET_KEY'],
        });
      }
      if (
        config.EVIDENCE_STORAGE_SERVER_SIDE_ENCRYPTION === 'aws:kms' &&
        !config.EVIDENCE_STORAGE_KMS_KEY_ID
      ) {
        context.addIssue({
          code: 'custom',
          message: 'is required when evidence storage encryption is aws:kms',
          path: ['EVIDENCE_STORAGE_KMS_KEY_ID'],
        });
      }
      if (
        config.EVIDENCE_STORAGE_SERVER_SIDE_ENCRYPTION !== 'aws:kms' &&
        config.EVIDENCE_STORAGE_KMS_KEY_ID
      ) {
        context.addIssue({
          code: 'custom',
          message: 'is only allowed when evidence storage encryption is aws:kms',
          path: ['EVIDENCE_STORAGE_KMS_KEY_ID'],
        });
      }
    }
    if (config.EVIDENCE_SCANNER_PROVIDER === 'clamav') {
      for (const [field, value] of [
        ['EVIDENCE_SCANNER_HOST', config.EVIDENCE_SCANNER_HOST],
        [
          'EVIDENCE_SCANNER_SIGNATURE_MAX_AGE_SECONDS',
          config.EVIDENCE_SCANNER_SIGNATURE_MAX_AGE_SECONDS,
        ],
        ['AFTER_SALE_EVIDENCE_CLAIM_TTL_SECONDS', config.AFTER_SALE_EVIDENCE_CLAIM_TTL_SECONDS],
        [
          'AFTER_SALE_EVIDENCE_FAILED_RETENTION_SECONDS',
          config.AFTER_SALE_EVIDENCE_FAILED_RETENTION_SECONDS,
        ],
      ] as const) {
        if (value !== undefined) continue;
        context.addIssue({
          code: 'custom',
          message: 'is required when EVIDENCE_SCANNER_PROVIDER=clamav',
          path: [field],
        });
      }
      if (config.EVIDENCE_STORAGE_PROVIDER !== 's3') {
        context.addIssue({
          code: 'custom',
          message: 'requires EVIDENCE_STORAGE_PROVIDER=s3',
          path: ['EVIDENCE_SCANNER_PROVIDER'],
        });
      }
      if (!config.AFTER_SALE_EVIDENCE_DELETION_WORKER_ENABLED) {
        context.addIssue({
          code: 'custom',
          message: 'requires the evidence deletion worker to consume expire/delete events',
          path: ['AFTER_SALE_EVIDENCE_DELETION_WORKER_ENABLED'],
        });
      }
      const scanLeaseBudgetMs =
        config.EVIDENCE_STORAGE_REQUEST_TIMEOUT_MS +
        Math.max(
          config.EVIDENCE_STORAGE_REQUEST_TIMEOUT_MS,
          config.EVIDENCE_SCANNER_REQUEST_TIMEOUT_MS,
        ) +
        2 * EVIDENCE_SCAN_LEASE_TRANSACTION_TIMEOUT_MS +
        EVIDENCE_SCAN_COMMIT_MARGIN_MS;
      if (config.OUTBOX_WORKER_LEASE_MS < scanLeaseBudgetMs) {
        context.addIssue({
          code: 'custom',
          message:
            'must cover evidence storage and scanner timeouts, two 2000ms evidence transactions and a 5000ms commit margin',
          path: ['OUTBOX_WORKER_LEASE_MS'],
        });
      }
    }
    if (config.AFTER_SALE_EVIDENCE_DELETION_WORKER_ENABLED) {
      for (const [field, value] of [
        [
          'AFTER_SALE_EVIDENCE_DELETE_RETRY_BASE_DELAY_MS',
          config.AFTER_SALE_EVIDENCE_DELETE_RETRY_BASE_DELAY_MS,
        ],
        [
          'AFTER_SALE_EVIDENCE_DELETE_RETRY_MAX_DELAY_MS',
          config.AFTER_SALE_EVIDENCE_DELETE_RETRY_MAX_DELAY_MS,
        ],
        ['AFTER_SALE_EVIDENCE_DELETE_MAX_ATTEMPTS', config.AFTER_SALE_EVIDENCE_DELETE_MAX_ATTEMPTS],
      ] as const) {
        if (value !== undefined) continue;
        context.addIssue({
          code: 'custom',
          message: 'is required when the evidence deletion worker is enabled',
          path: [field],
        });
      }
      if (config.EVIDENCE_STORAGE_PROVIDER !== 's3') {
        context.addIssue({
          code: 'custom',
          message: 'requires EVIDENCE_STORAGE_PROVIDER=s3',
          path: ['AFTER_SALE_EVIDENCE_DELETION_WORKER_ENABLED'],
        });
      }
      if (
        config.AFTER_SALE_EVIDENCE_DELETE_RETRY_BASE_DELAY_MS !== undefined &&
        config.AFTER_SALE_EVIDENCE_DELETE_RETRY_MAX_DELAY_MS !== undefined &&
        config.AFTER_SALE_EVIDENCE_DELETE_RETRY_MAX_DELAY_MS <
          config.AFTER_SALE_EVIDENCE_DELETE_RETRY_BASE_DELAY_MS
      ) {
        context.addIssue({
          code: 'custom',
          message: 'must be greater than or equal to the deletion retry base delay',
          path: ['AFTER_SALE_EVIDENCE_DELETE_RETRY_MAX_DELAY_MS'],
        });
      }
      const deletionLeaseBudgetMs =
        config.EVIDENCE_STORAGE_REQUEST_TIMEOUT_MS +
        2 * EVIDENCE_DELETE_LEASE_TRANSACTION_TIMEOUT_MS +
        EVIDENCE_DELETE_COMMIT_MARGIN_MS;
      if (config.OUTBOX_WORKER_LEASE_MS < deletionLeaseBudgetMs) {
        context.addIssue({
          code: 'custom',
          message:
            'must cover evidence deletion timeout, two 2000ms evidence transactions and a 5000ms commit margin',
          path: ['OUTBOX_WORKER_LEASE_MS'],
        });
      }
    }
    if (config.AFTER_SALE_EVIDENCE_MEMBER_UPLOADS_ENABLED) {
      for (const [field, value] of [
        ['AFTER_SALE_EVIDENCE_MAX_UNCLAIMED_BYTES', config.AFTER_SALE_EVIDENCE_MAX_UNCLAIMED_BYTES],
        ['AFTER_SALE_EVIDENCE_MAX_UNCLAIMED_FILES', config.AFTER_SALE_EVIDENCE_MAX_UNCLAIMED_FILES],
        ['AFTER_SALE_EVIDENCE_UPLOAD_TTL_SECONDS', config.AFTER_SALE_EVIDENCE_UPLOAD_TTL_SECONDS],
      ] as const) {
        if (value !== undefined) continue;
        context.addIssue({
          code: 'custom',
          message: 'is required when member evidence uploads are enabled',
          path: [field],
        });
      }
      if (
        config.EVIDENCE_STORAGE_PROVIDER !== 's3' ||
        config.EVIDENCE_SCANNER_PROVIDER !== 'clamav' ||
        !config.AFTER_SALE_EVIDENCE_DELETION_WORKER_ENABLED
      ) {
        context.addIssue({
          code: 'custom',
          message: 'requires configured S3 evidence storage, ClamAV scanning and deletion worker',
          path: ['AFTER_SALE_EVIDENCE_MEMBER_UPLOADS_ENABLED'],
        });
      }
      if (
        config.AFTER_SALE_EVIDENCE_UPLOAD_TTL_SECONDS !== undefined &&
        config.EVIDENCE_STORAGE_UPLOAD_URL_TTL_SECONDS >
          config.AFTER_SALE_EVIDENCE_UPLOAD_TTL_SECONDS
      ) {
        context.addIssue({
          code: 'custom',
          message: 'must not be shorter than the signed upload URL TTL',
          path: ['AFTER_SALE_EVIDENCE_UPLOAD_TTL_SECONDS'],
        });
      }
    }
    if (config.AFTER_SALE_EVIDENCE_PROTECTED_READS_ENABLED) {
      if (config.EVIDENCE_STORAGE_PROVIDER !== 's3') {
        context.addIssue({
          code: 'custom',
          message: 'requires configured S3 evidence storage',
          path: ['AFTER_SALE_EVIDENCE_PROTECTED_READS_ENABLED'],
        });
      }
      if (!config.AFTER_SALE_EVIDENCE_DELETION_WORKER_ENABLED) {
        context.addIssue({
          code: 'custom',
          message: 'requires the evidence deletion worker to consume expire/delete events',
          path: ['AFTER_SALE_EVIDENCE_PROTECTED_READS_ENABLED'],
        });
      }
    }
    if (config.AFTER_SALE_COMMANDS_ENABLED) {
      if (config.NODE_ENV === 'production') {
        context.addIssue({
          code: 'custom',
          message: 'is not authorized in production',
          path: ['AFTER_SALE_COMMANDS_ENABLED'],
        });
      }
    }
    for (const field of [
      'AFTER_SALE_REVIEW_COMMANDS_ENABLED',
      'AFTER_SALE_RETURN_EXPIRATION_WORKER_ENABLED',
    ] as const) {
      if (config[field] && config.NODE_ENV === 'production') {
        context.addIssue({
          code: 'custom',
          message: 'is not authorized in production',
          path: [field],
        });
      }
    }
    if (
      config.AFTER_SALE_EVIDENCE_ORDINARY_ACCESS_TTL_SECONDS !== undefined &&
      config.AFTER_SALE_EVIDENCE_RETENTION_TTL_SECONDS !== undefined &&
      config.AFTER_SALE_EVIDENCE_ORDINARY_ACCESS_TTL_SECONDS >=
        config.AFTER_SALE_EVIDENCE_RETENTION_TTL_SECONDS
    ) {
      context.addIssue({
        code: 'custom',
        message: 'must be greater than the ordinary access TTL',
        path: ['AFTER_SALE_EVIDENCE_RETENTION_TTL_SECONDS'],
      });
    }
    if (config.OUTBOX_WORKER_RETRY_MAX_DELAY_MS < config.OUTBOX_WORKER_RETRY_BASE_DELAY_MS) {
      context.addIssue({
        code: 'custom',
        message: 'must be greater than or equal to OUTBOX_WORKER_RETRY_BASE_DELAY_MS',
        path: ['OUTBOX_WORKER_RETRY_MAX_DELAY_MS'],
      });
    }
    if (config.PAYMENT_PROVIDER === 'test' && !config.PAYMENT_TEST_PROVIDER_SECRET) {
      context.addIssue({
        code: 'custom',
        message: 'is required for the test provider',
        path: ['PAYMENT_TEST_PROVIDER_SECRET'],
      });
    }
    if (config.PAYMENT_PROVIDER === 'test' && config.NODE_ENV !== 'test') {
      context.addIssue({
        code: 'custom',
        message: 'test provider is allowed only when NODE_ENV=test',
        path: ['PAYMENT_PROVIDER'],
      });
    }
    if (config.PAYMENT_RECONCILIATION_ENABLED && config.PAYMENT_PROVIDER === 'disabled') {
      context.addIssue({
        code: 'custom',
        message: 'requires an enabled payment provider',
        path: ['PAYMENT_RECONCILIATION_ENABLED'],
      });
    }
    if (config.PAYMENT_RECONCILIATION_ENABLED && config.OUTBOX_WORKER_INTERVAL_MS > 30_000) {
      context.addIssue({
        code: 'custom',
        message: 'must not exceed 30000ms when payment reconciliation is enabled',
        path: ['OUTBOX_WORKER_INTERVAL_MS'],
      });
    }
    if (
      config.PAYMENT_PROVIDER !== 'disabled' &&
      config.OUTBOX_WORKER_LEASE_MS < config.ZALO_CHECKOUT_REQUEST_TIMEOUT_MS + 5_000
    ) {
      context.addIssue({
        code: 'custom',
        message: 'must cover the payment provider timeout plus a 5000ms commit margin',
        path: ['OUTBOX_WORKER_LEASE_MS'],
      });
    }
    if (
      config.SHIPPING_PROVIDER !== 'disabled' &&
      config.OUTBOX_WORKER_LEASE_MS < config.GHN_REQUEST_TIMEOUT_MS + 5_000
    ) {
      context.addIssue({
        code: 'custom',
        message: 'must cover the GHN timeout plus a 5000ms commit margin',
        path: ['OUTBOX_WORKER_LEASE_MS'],
      });
    }
    if (config.NODE_ENV === 'production') {
      for (const field of Object.keys(
        productionPlaceholderValues,
      ) as ProductionPlaceholderField[]) {
        if (!isProductionPlaceholder(field, config[field])) continue;
        context.addIssue({
          code: 'custom',
          message: 'must not use a repository development or test placeholder in production',
          path: [field],
        });
      }
      if (config.EVIDENCE_STORAGE_PROVIDER === 's3') {
        if (
          !config.EVIDENCE_STORAGE_ENDPOINT ||
          new URL(config.EVIDENCE_STORAGE_ENDPOINT).protocol !== 'https:'
        ) {
          context.addIssue({
            code: 'custom',
            message: 'must use HTTPS in production',
            path: ['EVIDENCE_STORAGE_ENDPOINT'],
          });
        }
        if (
          config.EVIDENCE_STORAGE_SERVER_SIDE_ENCRYPTION !== 'aws:kms' ||
          !config.EVIDENCE_STORAGE_KMS_KEY_ID
        ) {
          context.addIssue({
            code: 'custom',
            message: 'must use an explicit aws:kms key in production',
            path: ['EVIDENCE_STORAGE_SERVER_SIDE_ENCRYPTION'],
          });
        }
        for (const field of Object.keys(
          evidenceStorageProductionPlaceholderValues,
        ) as EvidenceStorageProductionPlaceholderField[]) {
          const value = config[field];
          if (typeof value !== 'string' || !isEvidenceStorageProductionPlaceholder(field, value)) {
            continue;
          }
          context.addIssue({
            code: 'custom',
            message: 'must not use a repository development or test placeholder in production',
            path: [field],
          });
        }
      }
      if (config.EVIDENCE_SCANNER_PROVIDER === 'clamav') {
        const host = config.EVIDENCE_SCANNER_HOST;
        const loopback =
          host === '::1' ||
          (host !== undefined && isIP(host) === 4 && host.split('.')[0] === '127');
        if (!loopback) {
          context.addIssue({
            code: 'custom',
            message: 'must use an explicit loopback sidecar address in production',
            path: ['EVIDENCE_SCANNER_HOST'],
          });
        }
      }
    }
    if (config.ZALO_IDENTITY_PROVIDER === 'test' && !config.ZALO_TEST_TOKEN_SECRET) {
      context.addIssue({
        code: 'custom',
        message: 'is required for the test provider',
        path: ['ZALO_TEST_TOKEN_SECRET'],
      });
    }
    if (config.NODE_ENV === 'production' && config.ZALO_IDENTITY_PROVIDER === 'test') {
      context.addIssue({
        code: 'custom',
        message: 'test provider is forbidden in production',
        path: ['ZALO_IDENTITY_PROVIDER'],
      });
    }
    if (config.ZALO_IDENTITY_PROVIDER === 'open-api') {
      for (const [field, value] of [
        ['ZALO_APP_ID', config.ZALO_APP_ID],
        ['ZALO_MINI_APP_ID', config.ZALO_MINI_APP_ID],
        ['ZALO_APP_SECRET', config.ZALO_APP_SECRET],
      ] as const) {
        if (!value) {
          context.addIssue({
            code: 'custom',
            message: 'is required for the open-api provider',
            path: [field],
          });
        }
      }
      if (
        config.ZALO_APP_SECRET &&
        (config.ZALO_APP_SECRET === config.ZALO_APP_ID ||
          config.ZALO_APP_SECRET === config.ZALO_MINI_APP_ID)
      ) {
        context.addIssue({
          code: 'custom',
          message: 'must not match a Zalo application identifier',
          path: ['ZALO_APP_SECRET'],
        });
      }
    }
  });

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

export class InvalidEnvironmentError extends Error {
  public constructor(public readonly issues: readonly string[]) {
    super(`Invalid environment configuration: ${issues.join('; ')}`);
    this.name = 'InvalidEnvironmentError';
  }
}

export function parseRuntimeConfig(
  environment: Record<string, string | undefined> = process.env,
): RuntimeConfig {
  const result = runtimeConfigSchema.safeParse(environment);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.join('.') || 'environment';
      return `${path}: ${issue.message}`;
    });
    throw new InvalidEnvironmentError(issues);
  }

  return result.data;
}
