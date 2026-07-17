import { z } from 'zod';

const booleanFromString = z
  .enum(['true', 'false'])
  .default('true')
  .transform((value) => value === 'true');

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
    ZALO_IDENTITY_PROVIDER: z.enum(['disabled', 'test']).default('disabled'),
    ZALO_TEST_TOKEN_SECRET: z.string().min(32).optional(),
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
