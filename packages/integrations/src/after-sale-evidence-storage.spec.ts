import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { S3Client } from '@aws-sdk/client-s3';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import {
  AfterSaleEvidenceStorageError,
  canonicalAfterSaleEvidenceObjectKey,
  createAfterSaleEvidenceStorageS3Client,
  detectAfterSaleEvidenceMimeType,
  S3AfterSaleEvidenceStorageProvider,
  type AfterSaleEvidenceObjectDeclaration,
  type AfterSaleEvidenceStorageMimeType,
  type S3AfterSaleEvidenceStorageConfig,
} from './after-sale-evidence-storage';

const getSignedUrl = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl }));

const deploymentEnvironment = 'test';
const storeId = '10000000-0000-4000-8000-000000000001';
const evidenceId = '10000000-0000-4000-8000-000000000099';

const storageConfig: S3AfterSaleEvidenceStorageConfig = {
  bucket: 'zalo-shop-evidence-test',
  deleteCredentials: {
    accessKeyId: 'evidence-delete',
    secretAccessKey: 'evidence-delete-secret',
  },
  endpoint: 'http://localhost:9000',
  forcePathStyle: true,
  nodeEnvironment: 'test',
  readCredentials: {
    accessKeyId: 'evidence-read',
    secretAccessKey: 'evidence-read-secret',
  },
  readUrlTtlSeconds: 60,
  region: 'us-east-1',
  requestTimeoutMs: 1_000,
  serverSideEncryption: 'none',
  uploadCredentials: {
    accessKeyId: 'evidence-upload',
    secretAccessKey: 'evidence-upload-secret',
  },
  uploadUrlTtlSeconds: 300,
};

function fixture(mimeType: AfterSaleEvidenceStorageMimeType): Buffer {
  switch (mimeType) {
    case 'image/jpeg':
      return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
    case 'image/png':
      return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    case 'image/webp': {
      const body = Buffer.alloc(20);
      body.write('RIFF', 0, 'ascii');
      body.writeUInt32LE(12, 4);
      body.write('WEBP', 8, 'ascii');
      body.write('VP8 ', 12, 'ascii');
      return body;
    }
    case 'video/mp4': {
      const body = Buffer.alloc(24);
      body.writeUInt32BE(body.byteLength, 0);
      body.write('ftyp', 4, 'ascii');
      body.write('isom', 8, 'ascii');
      body.writeUInt32BE(0, 12);
      body.write('isom', 16, 'ascii');
      body.write('mp42', 20, 'ascii');
      return body;
    }
  }
}

function declaration(
  body: Uint8Array,
  mimeType: AfterSaleEvidenceStorageMimeType,
): AfterSaleEvidenceObjectDeclaration {
  return {
    byteSize: body.byteLength,
    checksumSha256: createHash('sha256').update(body).digest('hex'),
    deploymentEnvironment,
    evidenceId,
    mimeType,
    objectKey: `${deploymentEnvironment}/${storeId}/staged/${evidenceId}/original`,
    storeId,
  };
}

function chunks(...values: unknown[]): Readable {
  return Readable.from(values);
}

function expectStorageError(
  promise: Promise<unknown>,
  code: AfterSaleEvidenceStorageError['code'],
  retryable = false,
) {
  return expect(promise).rejects.toMatchObject({ code, retryable });
}

describe('after-sale evidence object identity and magic bytes', () => {
  it('creates only the frozen store-scoped ORIGINAL key', () => {
    expect(
      canonicalAfterSaleEvidenceObjectKey({ deploymentEnvironment, evidenceId, storeId }),
    ).toBe(`${deploymentEnvironment}/${storeId}/staged/${evidenceId}/original`);

    expect(() =>
      canonicalAfterSaleEvidenceObjectKey({
        deploymentEnvironment: '../production',
        evidenceId,
        storeId,
      }),
    ).toThrow(AfterSaleEvidenceStorageError);
    expect(() =>
      canonicalAfterSaleEvidenceObjectKey({
        deploymentEnvironment,
        evidenceId: `${evidenceId}/../other`,
        storeId,
      }),
    ).toThrow(AfterSaleEvidenceStorageError);
  });

  it.each(['image/jpeg', 'image/png', 'image/webp', 'video/mp4'] as const)(
    'detects %s from real bytes instead of metadata',
    (mimeType) => {
      const body = fixture(mimeType);
      expect(detectAfterSaleEvidenceMimeType(body, body.byteLength)).toBe(mimeType);
    },
  );

  it('rejects truncated, spoofed and impossible MP4 signatures', () => {
    expect(detectAfterSaleEvidenceMimeType(Buffer.from('image/jpeg'))).toBeNull();
    expect(detectAfterSaleEvidenceMimeType(fixture('image/png').subarray(0, 7))).toBeNull();

    const impossibleMp4 = fixture('video/mp4');
    impossibleMp4.writeUInt32BE(4_096, 0);
    expect(detectAfterSaleEvidenceMimeType(impossibleMp4, impossibleMp4.byteLength)).toBeNull();

    const truncatedExtendedMp4 = fixture('video/mp4');
    truncatedExtendedMp4.writeUInt32BE(1, 0);
    expect(detectAfterSaleEvidenceMimeType(truncatedExtendedMp4.subarray(0, 16), 24)).toBeNull();
  });
});

describe('S3 after-sale evidence storage provider', () => {
  let provider: S3AfterSaleEvidenceStorageProvider;
  let send: MockInstance;

  beforeEach(() => {
    getSignedUrl.mockReset().mockResolvedValue('https://signed.example.test/object');
    send = vi.spyOn(S3Client.prototype, 'send');
    provider = new S3AfterSaleEvidenceStorageProvider(storageConfig);
  });

  afterEach(() => {
    provider.destroy();
    vi.restoreAllMocks();
  });

  it('passes optional STS tokens only to the selected role client', async () => {
    const client = createAfterSaleEvidenceStorageS3Client(storageConfig, {
      accessKeyId: 'temporary-read-access',
      secretAccessKey: 'temporary-read-secret',
      sessionToken: 'temporary-session-token',
    });
    try {
      await expect(client.config.credentials()).resolves.toMatchObject({
        accessKeyId: 'temporary-read-access',
        secretAccessKey: 'temporary-read-secret',
        sessionToken: 'temporary-session-token',
      });
    } finally {
      client.destroy();
    }
  });

  it('signs a checksum-bound create-only upload without exposing credentials', async () => {
    const body = fixture('image/jpeg');
    const target = await provider.createUploadTarget(declaration(body, 'image/jpeg'));

    expect(target.url).toBe('https://signed.example.test/object');
    expect(target.headers).toEqual({
      'content-type': 'image/jpeg',
      'if-none-match': '*',
      'x-amz-checksum-sha256': createHash('sha256').update(body).digest('base64'),
    });
    const command = getSignedUrl.mock.calls[0]?.[1] as { input?: Record<string, unknown> };
    expect(command.input).toMatchObject({
      Bucket: storageConfig.bucket,
      ContentLength: body.byteLength,
      ContentType: 'image/jpeg',
      IfNoneMatch: '*',
    });
    expect(getSignedUrl).toHaveBeenCalledWith(expect.any(S3Client), expect.anything(), {
      expiresIn: 300,
      signableHeaders: new Set(['content-type']),
      unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
    });
  });

  it('signs a short no-store protected read target', async () => {
    const input = declaration(fixture('image/png'), 'image/png');
    await provider.createProtectedReadTarget(input);

    const command = getSignedUrl.mock.calls[0]?.[1] as { input?: Record<string, unknown> };
    expect(command.input).toMatchObject({
      Bucket: storageConfig.bucket,
      Key: input.objectKey,
      ResponseCacheControl: 'private, no-store',
      ResponseContentDisposition: 'inline',
    });
    expect(getSignedUrl).toHaveBeenCalledWith(expect.any(S3Client), expect.anything(), {
      expiresIn: 60,
    });
  });

  it('recomputes byte length, checksum and magic from a bounded stream', async () => {
    const body = fixture('image/webp');
    const expected = declaration(body, 'image/webp');
    send
      .mockResolvedValueOnce({
        ChecksumSHA256: Buffer.from(expected.checksumSha256, 'hex').toString('base64'),
        ContentLength: body.byteLength,
        ContentType: expected.mimeType,
        ETag: '"validated-etag"',
      })
      .mockResolvedValueOnce({ Body: chunks(body.subarray(0, 5), body.subarray(5)) });

    await expect(provider.validateUploadedObject(expected)).resolves.toEqual({
      byteSize: body.byteLength,
      checksumSha256: expected.checksumSha256,
      mimeType: expected.mimeType,
    });
    const getCommand = send.mock.calls[1]?.[0] as { input?: Record<string, unknown> };
    expect(getCommand.input).toMatchObject({ IfMatch: '"validated-etag"' });
    const headCommand = send.mock.calls[0]?.[0] as { input?: Record<string, unknown> };
    expect(headCommand.input).toMatchObject({ ChecksumMode: 'ENABLED' });
  });

  it('feeds the same ETag-bound validated stream to a bounded consumer', async () => {
    const body = fixture('image/png');
    const expected = declaration(body, 'image/png');
    send
      .mockResolvedValueOnce({
        ContentLength: body.byteLength,
        ContentType: expected.mimeType,
        ETag: '"consumer-etag"',
      })
      .mockResolvedValueOnce({ Body: chunks(body.subarray(0, 4), body.subarray(4)) });

    const consumed = await provider.consumeValidatedObject(expected, async (bytes) => {
      const observed: Buffer[] = [];
      for await (const chunk of bytes) observed.push(Buffer.from(chunk));
      return Buffer.concat(observed).toString('hex');
    });

    expect(consumed.object).toEqual({
      byteSize: body.byteLength,
      checksumSha256: expected.checksumSha256,
      mimeType: expected.mimeType,
    });
    expect(consumed.result).toBe(body.toString('hex'));
    const getCommand = send.mock.calls[1]?.[0] as { input?: Record<string, unknown> };
    expect(getCommand.input).toMatchObject({ IfMatch: '"consumer-etag"' });
  });

  it('aborts an ETag-bound body when a consumer returns before validation completes', async () => {
    const body = fixture('image/png');
    const expected = declaration(body, 'image/png');
    const responseBody = chunks(body.subarray(0, 4), body.subarray(4));
    const destroy = vi.spyOn(responseBody, 'destroy');
    send
      .mockResolvedValueOnce({
        ContentLength: body.byteLength,
        ContentType: expected.mimeType,
        ETag: '"early-return-etag"',
      })
      .mockResolvedValueOnce({ Body: responseBody });

    await expectStorageError(
      provider.consumeValidatedObject(expected, async (bytes) => {
        for await (const chunk of bytes) {
          void chunk;
          break;
        }
        return 'EARLY';
      }),
      'CONTENT_MISMATCH',
    );
    expect(destroy).toHaveBeenCalled();
  });

  it('rejects a HEAD-to-GET object change without exposing the ETag', async () => {
    const body = fixture('image/jpeg');
    const expected = declaration(body, 'image/jpeg');
    send
      .mockResolvedValueOnce({
        ContentLength: body.byteLength,
        ContentType: expected.mimeType,
        ETag: '"sensitive-provider-etag"',
      })
      .mockRejectedValueOnce({ $metadata: { httpStatusCode: 412 }, name: 'PreconditionFailed' });

    let received: unknown;
    try {
      await provider.validateUploadedObject(expected);
    } catch (error) {
      received = error;
    }
    expect(received).toMatchObject({ code: 'CONTENT_MISMATCH', retryable: false });
    expect(String(received)).not.toContain('sensitive-provider-etag');
  });

  it('fails closed on HEAD length, MIME or provider-checksum mismatches', async () => {
    const body = fixture('image/jpeg');
    const expected = declaration(body, 'image/jpeg');
    send.mockResolvedValueOnce({
      ContentLength: body.byteLength + 1,
      ContentType: expected.mimeType,
    });
    await expectStorageError(provider.validateUploadedObject(expected), 'METADATA_MISMATCH');

    send.mockResolvedValueOnce({
      ChecksumSHA256: Buffer.alloc(32, 7).toString('base64'),
      ContentLength: body.byteLength,
      ContentType: expected.mimeType,
    });
    await expectStorageError(provider.validateUploadedObject(expected), 'METADATA_MISMATCH');
  });

  it('fails closed on checksum, magic, short and overlong content', async () => {
    const body = fixture('image/png');
    const expected = declaration(body, 'image/png');
    const head = {
      ContentLength: body.byteLength,
      ContentType: expected.mimeType,
      ETag: '"content-etag"',
    };

    send
      .mockResolvedValueOnce(head)
      .mockResolvedValueOnce({ Body: chunks(Buffer.alloc(body.byteLength, 1)) });
    await expectStorageError(provider.validateUploadedObject(expected), 'CONTENT_MISMATCH');

    send
      .mockResolvedValueOnce(head)
      .mockResolvedValueOnce({ Body: chunks(body.subarray(0, body.byteLength - 1)) });
    await expectStorageError(provider.validateUploadedObject(expected), 'CONTENT_MISMATCH');

    send
      .mockResolvedValueOnce(head)
      .mockResolvedValueOnce({ Body: chunks(body, Buffer.from([0])) });
    await expectStorageError(provider.validateUploadedObject(expected), 'CONTENT_MISMATCH');
  });

  it('aborts and destroys malformed or interrupted provider streams', async () => {
    const body = fixture('image/jpeg');
    const expected = declaration(body, 'image/jpeg');
    const destroyMalformed = vi.fn();
    send
      .mockResolvedValueOnce({
        ContentLength: body.byteLength,
        ContentType: expected.mimeType,
        ETag: '"malformed-etag"',
      })
      .mockResolvedValueOnce({ Body: { destroy: destroyMalformed } });
    await expectStorageError(
      provider.validateUploadedObject(expected),
      'UPSTREAM_UNAVAILABLE',
      true,
    );
    expect(destroyMalformed).toHaveBeenCalledOnce();

    const destroyInterrupted = vi.fn();
    const interruptedBody = {
      destroy: destroyInterrupted,
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        yield body;
        throw new Error('provider stream interrupted with sensitive text');
      },
    };
    send
      .mockResolvedValueOnce({
        ContentLength: body.byteLength,
        ContentType: expected.mimeType,
        ETag: '"interrupted-etag"',
      })
      .mockResolvedValueOnce({ Body: interruptedBody });
    await expectStorageError(
      provider.validateUploadedObject(expected),
      'UPSTREAM_UNAVAILABLE',
      true,
    );
    expect(destroyInterrupted).toHaveBeenCalledOnce();
  });

  it('rejects unsupported declarations and limits before contacting S3', async () => {
    const body = fixture('image/jpeg');
    const invalidKey = { ...declaration(body, 'image/jpeg'), objectKey: '../outside' };
    await expectStorageError(provider.validateUploadedObject(invalidKey), 'INVALID_IDENTITY');

    const oversized = {
      ...declaration(body, 'image/jpeg'),
      byteSize: 10 * 1_024 * 1_024 + 1,
    };
    await expectStorageError(provider.createUploadTarget(oversized), 'INVALID_IDENTITY');
    expect(send).not.toHaveBeenCalled();
  });

  it('maps not-found and opaque upstream failures without leaking provider text or keys', async () => {
    const expected = declaration(fixture('image/jpeg'), 'image/jpeg');
    send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 }, name: 'NoSuchKey' });
    await expectStorageError(provider.validateUploadedObject(expected), 'NOT_FOUND');

    const sensitive = `provider rejected ${expected.objectKey} evidence-read-secret`;
    send.mockRejectedValueOnce(new Error(sensitive));
    let received: unknown;
    try {
      await provider.validateUploadedObject(expected);
    } catch (error) {
      received = error;
    }
    expect(received).toBeInstanceOf(AfterSaleEvidenceStorageError);
    expect(received).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', retryable: true });
    expect(String(received)).not.toContain(sensitive);
    expect(String(received)).not.toContain(expected.objectKey);
    expect(String(received)).not.toContain('evidence-read-secret');
  });

  it('treats delete not-found as idempotent but not unknown failures', async () => {
    const expected = declaration(fixture('image/jpeg'), 'image/jpeg');
    send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 }, name: 'NoSuchKey' });
    await expect(provider.removeObject(expected)).resolves.toBe('DELETED_OR_NOT_FOUND');

    send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 }, name: 'NoSuchBucket' });
    await expectStorageError(provider.removeObject(expected), 'UPSTREAM_UNAVAILABLE', true);

    send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 }, name: 'NotFound' });
    await expectStorageError(provider.removeObject(expected), 'UPSTREAM_UNAVAILABLE', true);

    send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } });
    await expectStorageError(provider.removeObject(expected), 'UPSTREAM_UNAVAILABLE', true);

    send.mockRejectedValueOnce(new Error('network unavailable'));
    await expectStorageError(provider.removeObject(expected), 'UPSTREAM_UNAVAILABLE', true);
  });

  it('allows delete-only identities for every ledger role but keeps read ORIGINAL-only', async () => {
    const derivative = {
      deploymentEnvironment,
      evidenceId,
      objectKey: `${deploymentEnvironment}/${storeId}/derived/${evidenceId}/thumbnail.webp`,
      objectRole: 'DERIVATIVE' as const,
      storeId,
    };
    send.mockResolvedValueOnce({});
    await expect(provider.removeObject(derivative)).resolves.toBe('DELETED_OR_NOT_FOUND');
    expect(send).toHaveBeenCalledOnce();
    await expectStorageError(provider.createProtectedReadTarget(derivative), 'INVALID_IDENTITY');
    expect(send).toHaveBeenCalledOnce();
  });
});

describe('S3 evidence configuration fail-closed checks', () => {
  it('rejects reused roles, unsupported endpoints and incomplete KMS settings', () => {
    expect(
      () =>
        new S3AfterSaleEvidenceStorageProvider({
          ...storageConfig,
          readCredentials: storageConfig.uploadCredentials,
        }),
    ).toThrow(AfterSaleEvidenceStorageError);
    expect(
      () =>
        new S3AfterSaleEvidenceStorageProvider({
          ...storageConfig,
          bucket: 'invalid..bucket',
        }),
    ).toThrow(AfterSaleEvidenceStorageError);
    expect(
      () =>
        new S3AfterSaleEvidenceStorageProvider({
          ...storageConfig,
          bucket: '192.168.0.1',
        }),
    ).toThrow(AfterSaleEvidenceStorageError);
    expect(
      () =>
        new S3AfterSaleEvidenceStorageProvider({
          ...storageConfig,
          endpoint: 'ftp://objects.example.test',
        }),
    ).toThrow(AfterSaleEvidenceStorageError);
    expect(
      () =>
        new S3AfterSaleEvidenceStorageProvider({
          ...storageConfig,
          serverSideEncryption: 'aws:kms',
        }),
    ).toThrow(AfterSaleEvidenceStorageError);
    expect(
      () =>
        new S3AfterSaleEvidenceStorageProvider({
          ...storageConfig,
          endpoint: 'http://objects.example.test',
          nodeEnvironment: 'production',
        }),
    ).toThrow(AfterSaleEvidenceStorageError);
  });
});
