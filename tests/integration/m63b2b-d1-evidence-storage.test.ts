import { createHash, randomUUID } from 'node:crypto';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { config as loadEnvironment } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseRuntimeConfig, type RuntimeConfig } from '@zalo-shop/config';
import {
  AfterSaleEvidenceStorageError,
  canonicalAfterSaleEvidenceObjectKey,
  createAfterSaleEvidenceStorageProvider,
  createAfterSaleEvidenceStorageS3Client,
  createMediaStorageS3Client,
  type AfterSaleEvidenceObjectDeclaration,
  type AfterSaleEvidenceStorageMimeType,
  type S3AfterSaleEvidenceStorageProvider,
} from '@zalo-shop/integrations';

const deploymentEnvironment = 'test';
const storeId = '10000000-0000-4000-8000-000000000001';

function required<T>(value: T | null | undefined, field: string): T {
  if (value === undefined || value === null) throw new Error(`${field} is required for D1 tests`);
  return value;
}

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

function evidenceDeclaration(
  body: Uint8Array,
  mimeType: AfterSaleEvidenceStorageMimeType,
  evidenceId = randomUUID(),
): AfterSaleEvidenceObjectDeclaration {
  const identity = { deploymentEnvironment, evidenceId, storeId };
  return {
    ...identity,
    byteSize: body.byteLength,
    checksumSha256: createHash('sha256').update(body).digest('hex'),
    mimeType,
    objectKey: canonicalAfterSaleEvidenceObjectKey(identity),
  };
}

function fetchBody(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function putSignedObject(
  provider: S3AfterSaleEvidenceStorageProvider,
  declaration: AfterSaleEvidenceObjectDeclaration,
  body: Uint8Array,
  headerOverrides: Readonly<Record<string, string>> = {},
): Promise<Response> {
  const target = await provider.createUploadTarget(declaration);
  return fetch(target.url, {
    body: fetchBody(body),
    headers: { ...target.headers, ...headerOverrides },
    method: 'PUT',
  });
}

async function expectAccessDenied(operation: () => Promise<unknown>): Promise<void> {
  let status: number | undefined;
  try {
    await operation();
  } catch (error) {
    status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  }
  expect(status).toBe(403);
}

async function expectObjectAbsent(
  client: S3Client,
  bucket: string,
  objectKey: string,
): Promise<void> {
  let status: number | undefined;
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
  } catch (error) {
    status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  }
  expect(status).toBe(404);
}

describe('M6.3-B2b-D1 evidence storage against real MinIO', () => {
  let runtimeConfig: RuntimeConfig;
  let provider: S3AfterSaleEvidenceStorageProvider;
  let contentClient: S3Client;
  let uploadClient: S3Client;
  let readClient: S3Client;
  let deleteClient: S3Client;
  let evidenceBucket: string;
  let contentBucket: string;

  beforeAll(() => {
    loadEnvironment({ path: '.env.test.example', quiet: true });
    runtimeConfig = parseRuntimeConfig();
    const resolvedProvider = createAfterSaleEvidenceStorageProvider(runtimeConfig);
    if (!resolvedProvider) throw new Error('D1 evidence storage provider is disabled');
    provider = resolvedProvider;

    const clientConfig = {
      endpoint: required(runtimeConfig.EVIDENCE_STORAGE_ENDPOINT, 'EVIDENCE_STORAGE_ENDPOINT'),
      forcePathStyle: required(
        runtimeConfig.EVIDENCE_STORAGE_FORCE_PATH_STYLE,
        'EVIDENCE_STORAGE_FORCE_PATH_STYLE',
      ),
      region: required(runtimeConfig.EVIDENCE_STORAGE_REGION, 'EVIDENCE_STORAGE_REGION'),
    };
    uploadClient = createAfterSaleEvidenceStorageS3Client(clientConfig, {
      accessKeyId: required(
        runtimeConfig.EVIDENCE_STORAGE_UPLOAD_ACCESS_KEY,
        'EVIDENCE_STORAGE_UPLOAD_ACCESS_KEY',
      ),
      secretAccessKey: required(
        runtimeConfig.EVIDENCE_STORAGE_UPLOAD_SECRET_KEY,
        'EVIDENCE_STORAGE_UPLOAD_SECRET_KEY',
      ),
    });
    readClient = createAfterSaleEvidenceStorageS3Client(clientConfig, {
      accessKeyId: required(
        runtimeConfig.EVIDENCE_STORAGE_READ_ACCESS_KEY,
        'EVIDENCE_STORAGE_READ_ACCESS_KEY',
      ),
      secretAccessKey: required(
        runtimeConfig.EVIDENCE_STORAGE_READ_SECRET_KEY,
        'EVIDENCE_STORAGE_READ_SECRET_KEY',
      ),
    });
    deleteClient = createAfterSaleEvidenceStorageS3Client(clientConfig, {
      accessKeyId: required(
        runtimeConfig.EVIDENCE_STORAGE_DELETE_ACCESS_KEY,
        'EVIDENCE_STORAGE_DELETE_ACCESS_KEY',
      ),
      secretAccessKey: required(
        runtimeConfig.EVIDENCE_STORAGE_DELETE_SECRET_KEY,
        'EVIDENCE_STORAGE_DELETE_SECRET_KEY',
      ),
    });
    contentClient = createMediaStorageS3Client(runtimeConfig);
    evidenceBucket = required(runtimeConfig.EVIDENCE_STORAGE_BUCKET, 'EVIDENCE_STORAGE_BUCKET');
    contentBucket = runtimeConfig.S3_BUCKET;
  });

  afterAll(() => {
    provider.destroy();
    contentClient.destroy();
    uploadClient.destroy();
    readClient.destroy();
    deleteClient.destroy();
  });

  it.each(['image/jpeg', 'image/png', 'image/webp', 'video/mp4'] as const)(
    'uploads, streams, protects and deletes a real %s object',
    async (mimeType) => {
      const body = fixture(mimeType);
      const declaration = evidenceDeclaration(body, mimeType);
      try {
        const uploadResponse = await putSignedObject(provider, declaration, body);
        expect(uploadResponse.status).toBeLessThan(300);

        await expect(provider.validateUploadedObject(declaration)).resolves.toEqual({
          byteSize: body.byteLength,
          checksumSha256: declaration.checksumSha256,
          mimeType,
        });

        const readTarget = await provider.createProtectedReadTarget({
          ...declaration,
          accessDeadline: new Date(Date.now() + 120_000),
        });
        const readResponse = await fetch(readTarget.url);
        expect(readResponse.status).toBe(200);
        expect(readResponse.headers.get('cache-control')).toBe('private, no-store');
        expect(readResponse.headers.get('content-disposition')).toBe('inline');
        await expect(readResponse.arrayBuffer()).resolves.toEqual(
          body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
        );

        await expect(provider.removeObject(declaration)).resolves.toBe('DELETED_OR_NOT_FOUND');
        await expect(provider.validateUploadedObject(declaration)).rejects.toMatchObject({
          code: 'NOT_FOUND',
        });
        await expect(provider.removeObject(declaration)).resolves.toBe('DELETED_OR_NOT_FOUND');
      } finally {
        await provider.removeObject(declaration);
        await expectObjectAbsent(readClient, evidenceBucket, declaration.objectKey);
      }
    },
  );

  it('cryptographically binds MIME, checksum and create-only headers', async () => {
    const body = fixture('image/jpeg');
    const declaration = evidenceDeclaration(body, 'image/jpeg');
    const checksumHeader = Buffer.alloc(32, 9).toString('base64');
    try {
      const target = await provider.createUploadTarget(declaration);
      const signedHeaders = new URL(target.url).searchParams.get('X-Amz-SignedHeaders')?.split(';');
      expect(signedHeaders).toContain('content-length');
      expect(signedHeaders).toContain('content-type');
      expect(signedHeaders).toContain('if-none-match');
      expect(signedHeaders).toContain('x-amz-checksum-sha256');
      expect(new URL(target.url).searchParams.has('x-amz-checksum-sha256')).toBe(false);

      const mimeTamper = await fetch(target.url, {
        body: fetchBody(body),
        headers: { ...target.headers, 'content-type': 'image/png' },
        method: 'PUT',
      });
      expect(mimeTamper.status).toBe(403);

      const checksumTamper = await fetch(target.url, {
        body: fetchBody(body),
        headers: { ...target.headers, 'x-amz-checksum-sha256': checksumHeader },
        method: 'PUT',
      });
      expect(checksumTamper.status).toBe(403);

      const validResponse = await fetch(target.url, {
        body: fetchBody(body),
        headers: target.headers,
        method: 'PUT',
      });
      expect(validResponse.status).toBeLessThan(300);

      const replacement = Buffer.from(body);
      replacement[replacement.byteLength - 1] ^= 0xff;
      const replacementDeclaration = {
        ...declaration,
        checksumSha256: createHash('sha256').update(replacement).digest('hex'),
      };
      const overwriteResponse = await putSignedObject(
        provider,
        replacementDeclaration,
        replacement,
      );
      expect([409, 412]).toContain(overwriteResponse.status);
      await expect(provider.validateUploadedObject(declaration)).resolves.toMatchObject({
        checksumSha256: declaration.checksumSha256,
      });
    } finally {
      await provider.removeObject(declaration);
      await expectObjectAbsent(readClient, evidenceBucket, declaration.objectKey);
    }
  });

  it('detects real-byte magic, declared length and checksum deception', async () => {
    const pngBody = fixture('image/png');
    const declaration = evidenceDeclaration(pngBody, 'image/jpeg');
    try {
      const response = await putSignedObject(provider, declaration, pngBody);
      expect(response.status).toBeLessThan(300);
      await expect(provider.validateUploadedObject(declaration)).rejects.toMatchObject({
        code: 'CONTENT_MISMATCH',
      });
      await expect(
        provider.validateUploadedObject({ ...declaration, byteSize: declaration.byteSize + 1 }),
      ).rejects.toMatchObject({ code: 'METADATA_MISMATCH' });
      await expect(
        provider.validateUploadedObject({ ...declaration, checksumSha256: 'a'.repeat(64) }),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof AfterSaleEvidenceStorageError &&
          ['METADATA_MISMATCH', 'CONTENT_MISMATCH'].includes(error.code),
      );
    } finally {
      await provider.removeObject(declaration);
      await expectObjectAbsent(readClient, evidenceBucket, declaration.objectKey);
    }
  });

  it('enforces content/evidence bucket isolation and non-substitutable evidence roles', async () => {
    const body = fixture('image/jpeg');
    const declaration = evidenceDeclaration(body, 'image/jpeg');
    const crossEvidence = evidenceDeclaration(body, 'image/jpeg');
    const contentKey = `test/${storeId}/d1-iam/${randomUUID()}`;
    const crossContentKey = `test/${storeId}/d1-iam/${randomUUID()}`;
    const distinctAccessKeys = [
      runtimeConfig.S3_ACCESS_KEY,
      runtimeConfig.EVIDENCE_STORAGE_UPLOAD_ACCESS_KEY,
      runtimeConfig.EVIDENCE_STORAGE_READ_ACCESS_KEY,
      runtimeConfig.EVIDENCE_STORAGE_DELETE_ACCESS_KEY,
    ];
    expect(new Set(distinctAccessKeys).size).toBe(4);

    try {
      const response = await putSignedObject(provider, declaration, body);
      expect(response.status).toBeLessThan(300);
      await contentClient.send(
        new PutObjectCommand({ Bucket: contentBucket, Body: body, Key: contentKey }),
      );

      await expectAccessDenied(() =>
        contentClient.send(
          new PutObjectCommand({
            Bucket: evidenceBucket,
            Body: body,
            Key: crossEvidence.objectKey,
          }),
        ),
      );
      await expectAccessDenied(() =>
        contentClient.send(
          new HeadObjectCommand({ Bucket: evidenceBucket, Key: declaration.objectKey }),
        ),
      );
      await expectAccessDenied(() =>
        contentClient.send(
          new DeleteObjectCommand({ Bucket: evidenceBucket, Key: declaration.objectKey }),
        ),
      );

      await expectAccessDenied(() =>
        uploadClient.send(
          new GetObjectCommand({ Bucket: evidenceBucket, Key: declaration.objectKey }),
        ),
      );
      await expectAccessDenied(() =>
        uploadClient.send(
          new DeleteObjectCommand({ Bucket: evidenceBucket, Key: declaration.objectKey }),
        ),
      );
      await expectAccessDenied(() =>
        uploadClient.send(
          new PutObjectCommand({ Bucket: contentBucket, Body: body, Key: crossContentKey }),
        ),
      );

      await readClient.send(
        new HeadObjectCommand({ Bucket: evidenceBucket, Key: declaration.objectKey }),
      );
      await expectAccessDenied(() =>
        readClient.send(
          new PutObjectCommand({
            Bucket: evidenceBucket,
            Body: body,
            Key: crossEvidence.objectKey,
          }),
        ),
      );
      await expectAccessDenied(() =>
        readClient.send(
          new DeleteObjectCommand({ Bucket: evidenceBucket, Key: declaration.objectKey }),
        ),
      );
      await expectAccessDenied(() =>
        readClient.send(new GetObjectCommand({ Bucket: contentBucket, Key: contentKey })),
      );

      await expectAccessDenied(() =>
        deleteClient.send(
          new GetObjectCommand({ Bucket: evidenceBucket, Key: declaration.objectKey }),
        ),
      );
      await expectAccessDenied(() =>
        deleteClient.send(
          new PutObjectCommand({
            Bucket: evidenceBucket,
            Body: body,
            Key: crossEvidence.objectKey,
          }),
        ),
      );
      await expectAccessDenied(() =>
        deleteClient.send(new DeleteObjectCommand({ Bucket: contentBucket, Key: contentKey })),
      );

      await expect(provider.validateUploadedObject(declaration)).resolves.toMatchObject({
        checksumSha256: declaration.checksumSha256,
      });
    } finally {
      await provider.removeObject(declaration);
      await provider.removeObject(crossEvidence);
      await contentClient.send(new DeleteObjectCommand({ Bucket: contentBucket, Key: contentKey }));
      await contentClient.send(
        new DeleteObjectCommand({ Bucket: contentBucket, Key: crossContentKey }),
      );
      await expectObjectAbsent(readClient, evidenceBucket, declaration.objectKey);
      await expectObjectAbsent(readClient, evidenceBucket, crossEvidence.objectKey);
      await expectObjectAbsent(contentClient, contentBucket, contentKey);
      await expectObjectAbsent(contentClient, contentBucket, crossContentKey);
    }
  });
});
