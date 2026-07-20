import { z } from 'zod';

const booleanFromString = z
  .enum(['true', 'false'])
  .default('true')
  .transform((value) => value === 'true');

const optionalNumericIdentifier = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().regex(/^\d+$/, 'must contain digits only').optional(),
);

const optionalSecret = z.preprocess(
  (value) => (typeof value === 'string' && value === '' ? undefined : value),
  z.string().min(8).optional(),
);

const runtimeConfigSchema = z
  .object({
    AUTH_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
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
    INVENTORY_EXPIRATION_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),
    INVENTORY_EXPIRATION_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(300_000)
      .default(5_000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PII_ENCRYPTION_KEY: z
      .string()
      .refine((value) => Buffer.from(value, 'base64').length === 32, 'must decode to 32 bytes'),
    PII_HASH_KEY: z.string().min(32),
    REDIS_URL: z.string().url().startsWith('redis://'),
    S3_ACCESS_KEY: z.string().min(1),
    S3_BUCKET: z.string().min(3),
    S3_ENDPOINT: z.string().url(),
    S3_FORCE_PATH_STYLE: booleanFromString,
    S3_REGION: z.string().min(1).default('us-east-1'),
    S3_SECRET_KEY: z.string().min(8),
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
