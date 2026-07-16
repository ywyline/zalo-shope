import { z } from 'zod';

const booleanFromString = z
  .enum(['true', 'false'])
  .default('true')
  .transform((value) => value === 'true');

const runtimeConfigSchema = z.object({
  API_HOST: z.string().min(1).default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  DATABASE_URL: z.string().url().startsWith('postgresql://'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  REDIS_URL: z.string().url().startsWith('redis://'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(3),
  S3_ENDPOINT: z.string().url(),
  S3_FORCE_PATH_STYLE: booleanFromString,
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_SECRET_KEY: z.string().min(8),
  WORKER_HOST: z.string().min(1).default('0.0.0.0'),
  WORKER_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
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
