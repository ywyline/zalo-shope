import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import type { RuntimeConfig } from '@zalo-shop/config';
import Redis from 'ioredis';
import { Pool } from 'pg';

export type DependencyName = 'objectStorage' | 'postgres' | 'redis';
export type InfrastructureStatus = Record<DependencyName, 'up'>;

export class InfrastructureUnavailableError extends Error {
  public constructor(public readonly unavailable: readonly DependencyName[]) {
    super(`Infrastructure unavailable: ${unavailable.join(', ')}`);
    this.name = 'InfrastructureUnavailableError';
  }
}

async function checkPostgres(databaseUrl: string): Promise<void> {
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 3_000,
    max: 1,
  });
  try {
    await pool.query('SELECT 1');
  } finally {
    await pool.end();
  }
}

async function checkRedis(redisUrl: string): Promise<void> {
  const redis = new Redis(redisUrl, {
    connectTimeout: 3_000,
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  try {
    await redis.connect();
    await redis.ping();
  } finally {
    redis.disconnect(false);
  }
}

type ObjectStorageConfig = Pick<
  RuntimeConfig,
  | 'S3_ACCESS_KEY'
  | 'S3_BUCKET'
  | 'S3_ENDPOINT'
  | 'S3_FORCE_PATH_STYLE'
  | 'S3_REGION'
  | 'S3_SECRET_KEY'
  | 'S3_SESSION_TOKEN'
>;

type ObjectStorageClient = Pick<S3Client, 'destroy' | 'send'>;

export function createObjectStorageClient(config: ObjectStorageConfig): S3Client {
  return new S3Client({
    credentials: {
      accessKeyId: config.S3_ACCESS_KEY,
      secretAccessKey: config.S3_SECRET_KEY,
      ...(config.S3_SESSION_TOKEN ? { sessionToken: config.S3_SESSION_TOKEN } : {}),
    },
    endpoint: config.S3_ENDPOINT,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    region: config.S3_REGION,
  });
}

export async function checkObjectStorage(
  config: ObjectStorageConfig,
  client: ObjectStorageClient = createObjectStorageClient(config),
): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET }));
  } finally {
    client.destroy();
  }
}

export async function checkInfrastructure(config: RuntimeConfig): Promise<InfrastructureStatus> {
  const checks: ReadonlyArray<readonly [DependencyName, Promise<void>]> = [
    ['postgres', checkPostgres(config.DATABASE_RUNTIME_URL)],
    ['redis', checkRedis(config.REDIS_URL)],
    ['objectStorage', checkObjectStorage(config)],
  ];
  const results = await Promise.allSettled(checks.map(([, check]) => check));
  const unavailable = results.flatMap((result, index) =>
    result.status === 'rejected' ? [checks[index]![0]] : [],
  );

  if (unavailable.length > 0) {
    throw new InfrastructureUnavailableError(unavailable);
  }

  return {
    objectStorage: 'up',
    postgres: 'up',
    redis: 'up',
  };
}
