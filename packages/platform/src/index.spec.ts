import { HeadBucketCommand } from '@aws-sdk/client-s3';
import type { RuntimeConfig } from '@zalo-shop/config';
import { describe, expect, it, vi } from 'vitest';

import { checkObjectStorage, createObjectStorageClient } from './index';

const storageConfig = {
  S3_ACCESS_KEY: 'temporary-access-key',
  S3_BUCKET: 'zalo-shop-staging',
  S3_ENDPOINT: 'https://objects.example.test',
  S3_FORCE_PATH_STYLE: false,
  S3_REGION: 'ap-southeast-1',
  S3_SECRET_KEY: 'temporary-secret-key',
  S3_SESSION_TOKEN: 'temporary-session-token',
} as RuntimeConfig;

describe('object storage readiness', () => {
  it('probes only the configured bucket and always destroys the client', async () => {
    const send = vi.fn().mockResolvedValue({});
    const destroy = vi.fn();

    await checkObjectStorage(storageConfig, { destroy, send });

    expect(send).toHaveBeenCalledOnce();
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(HeadBucketCommand);
    expect((command as HeadBucketCommand).input).toEqual({ Bucket: 'zalo-shop-staging' });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('destroys the client when the target bucket cannot be accessed', async () => {
    const send = vi.fn().mockRejectedValue(new Error('access denied'));
    const destroy = vi.fn();

    await expect(checkObjectStorage(storageConfig, { destroy, send })).rejects.toThrow(
      'access denied',
    );
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('passes a temporary STS session token to the S3 client', async () => {
    const client = createObjectStorageClient(storageConfig);
    try {
      await expect(client.config.credentials()).resolves.toMatchObject({
        accessKeyId: 'temporary-access-key',
        secretAccessKey: 'temporary-secret-key',
        sessionToken: 'temporary-session-token',
      });
    } finally {
      client.destroy();
    }
  });
});
