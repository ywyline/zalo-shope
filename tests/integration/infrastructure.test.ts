import { config as loadEnvironment } from 'dotenv';
import { beforeAll, describe, expect, it } from 'vitest';

import { parseRuntimeConfig, type RuntimeConfig } from '@zalo-shop/config';
import { checkInfrastructure } from '@zalo-shop/platform';
import { S3MediaStorageProvider } from '@zalo-shop/integrations';
import { createHash, randomUUID } from 'node:crypto';

describe('local infrastructure', () => {
  let runtimeConfig: RuntimeConfig;

  beforeAll(() => {
    loadEnvironment({ path: '.env.test.example', quiet: true });
    runtimeConfig = parseRuntimeConfig();
  });

  it('connects to PostgreSQL, Redis and S3-compatible storage', async () => {
    await expect(checkInfrastructure(runtimeConfig)).resolves.toEqual({
      objectStorage: 'up',
      postgres: 'up',
      redis: 'up',
    });
  });

  it('uploads and verifies a checksum-bound store-scoped media object', async () => {
    const storage = new S3MediaStorageProvider(runtimeConfig);
    const body = Buffer.from('m2.4-media-integrity');
    const checksumSha256 = createHash('sha256').update(body).digest('hex');
    const objectKey = `test/10000000-0000-4000-8000-000000000001/product/${randomUUID()}`;
    const target = await storage.createUploadTarget({
      byteSize: body.length,
      checksumSha256,
      contentType: 'image/webp',
      objectKey,
    });
    try {
      const response = await fetch(target.url, { body, headers: target.headers, method: 'PUT' });
      expect(response.status).toBeLessThan(300);
      await expect(storage.inspectObject(objectKey)).resolves.toMatchObject({
        byteSize: body.length,
        contentType: 'image/webp',
      });
      const readTarget = await storage.createReadUrl(objectKey);
      const readResponse = await fetch(readTarget.url);
      expect(readResponse.status).toBe(200);
      await expect(readResponse.arrayBuffer()).resolves.toEqual(
        body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      );

      const invalidObjectKey = `${objectKey}-invalid`;
      const invalidTarget = await storage.createUploadTarget({
        byteSize: body.length,
        checksumSha256,
        contentType: 'image/webp',
        objectKey: invalidObjectKey,
      });
      const invalidResponse = await fetch(invalidTarget.url, {
        body: Buffer.from('x'.repeat(body.length)),
        headers: invalidTarget.headers,
        method: 'PUT',
      });
      expect(invalidResponse.status).toBeGreaterThanOrEqual(400);
      await storage.removeObject(invalidObjectKey);
    } finally {
      await storage.removeObject(objectKey);
    }
  });
});
