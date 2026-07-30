import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
  type HeadObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { RuntimeConfig } from '@zalo-shop/config';

export const AFTER_SALE_EVIDENCE_STORAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
] as const;

export type AfterSaleEvidenceStorageMimeType =
  (typeof AFTER_SALE_EVIDENCE_STORAGE_MIME_TYPES)[number];

export type AfterSaleEvidenceStorageErrorCode =
  | 'ACCESS_EXPIRED'
  | 'CONFIGURATION'
  | 'CONTENT_MISMATCH'
  | 'INVALID_IDENTITY'
  | 'METADATA_MISMATCH'
  | 'NOT_FOUND'
  | 'UPSTREAM_UNAVAILABLE';

export class AfterSaleEvidenceStorageError extends Error {
  public constructor(
    public readonly code: AfterSaleEvidenceStorageErrorCode,
    public readonly retryable: boolean,
  ) {
    super(`After-sale evidence storage failed: ${code}`);
    this.name = 'AfterSaleEvidenceStorageError';
  }
}

export type AfterSaleEvidenceObjectIdentity = Readonly<{
  deploymentEnvironment: string;
  evidenceId: string;
  objectRole?: 'DERIVATIVE' | 'ORIGINAL' | 'SCAN_TEMPORARY';
  objectKey: string;
  storeId: string;
}>;

export type AfterSaleEvidenceObjectDeclaration = AfterSaleEvidenceObjectIdentity &
  Readonly<{
    byteSize: number;
    checksumSha256: string;
    mimeType: AfterSaleEvidenceStorageMimeType;
  }>;

export type AfterSaleEvidenceProtectedReadIdentity = AfterSaleEvidenceObjectIdentity &
  Readonly<{
    accessDeadline: Date;
  }>;

export type ValidatedAfterSaleEvidenceObject = Readonly<{
  byteSize: number;
  checksumSha256: string;
  mimeType: AfterSaleEvidenceStorageMimeType;
}>;

export interface AfterSaleEvidenceObjectStorageProvider {
  consumeValidatedObject<T>(
    declaration: AfterSaleEvidenceObjectDeclaration,
    consumer: (bytes: AsyncIterable<Uint8Array>) => Promise<T>,
  ): Promise<Readonly<{ object: ValidatedAfterSaleEvidenceObject; result: T }>>;
  createProtectedReadTarget(
    identity: AfterSaleEvidenceProtectedReadIdentity,
  ): Promise<Readonly<{ expiresAt: Date; url: string }>>;
  createUploadTarget(declaration: AfterSaleEvidenceObjectDeclaration): Promise<
    Readonly<{
      expiresAt: Date;
      headers: Readonly<Record<string, string>>;
      url: string;
    }>
  >;
  destroy(): void;
  removeObject(identity: AfterSaleEvidenceObjectIdentity): Promise<'DELETED_OR_NOT_FOUND'>;
  validateUploadedObject(
    declaration: AfterSaleEvidenceObjectDeclaration,
  ): Promise<ValidatedAfterSaleEvidenceObject>;
}

type EvidenceStorageCredentials = Readonly<{
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}>;

export type S3AfterSaleEvidenceStorageConfig = Readonly<{
  bucket: string;
  deleteCredentials: EvidenceStorageCredentials;
  endpoint: string;
  forcePathStyle: boolean;
  kmsKeyId?: string;
  nodeEnvironment: 'development' | 'production' | 'test';
  readCredentials: EvidenceStorageCredentials;
  readUrlTtlSeconds: number;
  region: string;
  requestTimeoutMs: number;
  serverSideEncryption: 'AES256' | 'aws:kms' | 'none';
  uploadCredentials: EvidenceStorageCredentials;
  uploadUrlTtlSeconds: number;
}>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ENVIRONMENT_PATTERN = /^[a-z][a-z0-9-]{1,31}$/u;
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/u;
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const REGION_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const MAX_IMAGE_BYTES = 10 * 1_024 * 1_024;
const MAX_VIDEO_BYTES = 50 * 1_024 * 1_024;
const MAGIC_PREFIX_BYTES = 24;

function isValidBucketName(value: string): boolean {
  return BUCKET_PATTERN.test(value) && !value.includes('..') && isIP(value) === 0;
}

function fail(code: AfterSaleEvidenceStorageErrorCode, retryable = false): never {
  throw new AfterSaleEvidenceStorageError(code, retryable);
}

function isSupportedMimeType(value: string): value is AfterSaleEvidenceStorageMimeType {
  return (AFTER_SALE_EVIDENCE_STORAGE_MIME_TYPES as readonly string[]).includes(value);
}

function maximumBytes(mimeType: AfterSaleEvidenceStorageMimeType): number {
  return mimeType === 'video/mp4' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
}

export function canonicalAfterSaleEvidenceObjectKey(
  identity: Omit<AfterSaleEvidenceObjectIdentity, 'objectKey'>,
): string {
  if (
    !ENVIRONMENT_PATTERN.test(identity.deploymentEnvironment) ||
    !UUID_PATTERN.test(identity.storeId) ||
    !UUID_PATTERN.test(identity.evidenceId) ||
    (identity.objectRole !== undefined &&
      !(['DERIVATIVE', 'ORIGINAL', 'SCAN_TEMPORARY'] as const).includes(identity.objectRole))
  ) {
    return fail('INVALID_IDENTITY');
  }
  return `${identity.deploymentEnvironment}/${identity.storeId}/staged/${identity.evidenceId}/original`;
}

function assertIdentity(identity: AfterSaleEvidenceObjectIdentity): void {
  if (
    !ENVIRONMENT_PATTERN.test(identity.deploymentEnvironment) ||
    !UUID_PATTERN.test(identity.storeId) ||
    !UUID_PATTERN.test(identity.evidenceId) ||
    (identity.objectRole !== undefined &&
      !(['DERIVATIVE', 'ORIGINAL', 'SCAN_TEMPORARY'] as const).includes(identity.objectRole))
  ) {
    fail('INVALID_IDENTITY');
  }
  const segments = identity.objectKey.split('/');
  const leaf = segments.at(-1) ?? '';
  const canonical =
    identity.objectRole === 'DERIVATIVE'
      ? `${identity.deploymentEnvironment}/${identity.storeId}/derived/${identity.evidenceId}/${leaf}`
      : identity.objectRole === 'SCAN_TEMPORARY'
        ? `${identity.deploymentEnvironment}/${identity.storeId}/scan/${identity.evidenceId}/${leaf}`
        : canonicalAfterSaleEvidenceObjectKey(identity);
  if (
    identity.objectKey !== canonical ||
    identity.objectKey.includes('\\') ||
    [...identity.objectKey].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint === undefined || codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    fail('INVALID_IDENTITY');
  }
  if (
    identity.objectRole !== undefined &&
    identity.objectRole !== 'ORIGINAL' &&
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(leaf)
  ) {
    fail('INVALID_IDENTITY');
  }
}

function assertOriginalIdentity(identity: AfterSaleEvidenceObjectIdentity): void {
  if (identity.objectRole !== undefined && identity.objectRole !== 'ORIGINAL') {
    fail('INVALID_IDENTITY');
  }
  assertIdentity({ ...identity, objectRole: 'ORIGINAL' });
}

function protectedReadExpiry(
  config: S3AfterSaleEvidenceStorageConfig,
  accessDeadline: Date,
): Readonly<{ expiresAt: Date; expiresIn: number; signingDate: Date }> {
  if (!(accessDeadline instanceof Date) || !Number.isFinite(accessDeadline.getTime())) {
    return fail('INVALID_IDENTITY');
  }
  // Pin the signing clock to a whole second so the provider URL cannot outlive the DB deadline.
  const signingDate = new Date();
  signingDate.setMilliseconds(0);
  const remainingSeconds =
    Math.ceil((accessDeadline.getTime() - signingDate.getTime()) / 1_000) - 1;
  const expiresIn = Math.min(config.readUrlTtlSeconds, remainingSeconds);
  if (!Number.isSafeInteger(expiresIn) || expiresIn < 1) return fail('ACCESS_EXPIRED');
  return {
    expiresAt: new Date(signingDate.getTime() + expiresIn * 1_000),
    expiresIn,
    signingDate,
  };
}

function assertDeclaration(declaration: AfterSaleEvidenceObjectDeclaration): void {
  assertOriginalIdentity(declaration);
  if (
    !isSupportedMimeType(declaration.mimeType) ||
    !Number.isSafeInteger(declaration.byteSize) ||
    declaration.byteSize < 1 ||
    declaration.byteSize > maximumBytes(declaration.mimeType) ||
    !CHECKSUM_PATTERN.test(declaration.checksumSha256)
  ) {
    fail('INVALID_IDENTITY');
  }
}

function bytesEqual(bytes: Uint8Array, expected: readonly number[]): boolean {
  return expected.every((value, index) => bytes[index] === value);
}

export function detectAfterSaleEvidenceMimeType(
  prefix: Uint8Array,
  totalByteSize?: number,
): AfterSaleEvidenceStorageMimeType | null {
  if (prefix.byteLength >= 3 && bytesEqual(prefix, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (
    prefix.byteLength >= 8 &&
    bytesEqual(prefix, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  ) {
    return 'image/png';
  }
  if (
    prefix.byteLength >= 12 &&
    Buffer.from(prefix.subarray(0, 4)).toString('ascii') === 'RIFF' &&
    Buffer.from(prefix.subarray(8, 12)).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (prefix.byteLength >= 16 && Buffer.from(prefix.subarray(4, 8)).toString('ascii') === 'ftyp') {
    const boxSize = Buffer.from(prefix.subarray(0, 4)).readUInt32BE(0);
    if (boxSize >= 16 && (totalByteSize === undefined || boxSize <= totalByteSize)) {
      return 'video/mp4';
    }
    if (boxSize === 1 && prefix.byteLength >= 24) {
      const extendedBoxSize = Buffer.from(prefix.subarray(8, 16)).readBigUInt64BE(0);
      if (
        extendedBoxSize >= 24n &&
        (totalByteSize === undefined || extendedBoxSize <= BigInt(totalByteSize))
      ) {
        return 'video/mp4';
      }
    }
  }
  return null;
}

function assertCredentials(credentials: EvidenceStorageCredentials): void {
  if (
    !credentials.accessKeyId ||
    credentials.secretAccessKey.length < 8 ||
    (credentials.sessionToken !== undefined && credentials.sessionToken.length < 8)
  ) {
    fail('CONFIGURATION');
  }
}

function assertConfig(config: S3AfterSaleEvidenceStorageConfig): void {
  let endpoint: URL;
  try {
    endpoint = new URL(config.endpoint);
  } catch {
    return fail('CONFIGURATION');
  }
  assertCredentials(config.uploadCredentials);
  assertCredentials(config.readCredentials);
  assertCredentials(config.deleteCredentials);
  const accessKeys = [
    config.uploadCredentials.accessKeyId,
    config.readCredentials.accessKeyId,
    config.deleteCredentials.accessKeyId,
  ];
  const secretKeys = [
    config.uploadCredentials.secretAccessKey,
    config.readCredentials.secretAccessKey,
    config.deleteCredentials.secretAccessKey,
  ];
  if (
    !isValidBucketName(config.bucket) ||
    !REGION_PATTERN.test(config.region) ||
    new Set(accessKeys).size !== accessKeys.length ||
    new Set(secretKeys).size !== secretKeys.length ||
    !Number.isSafeInteger(config.requestTimeoutMs) ||
    config.requestTimeoutMs < 500 ||
    config.requestTimeoutMs > 30_000 ||
    !Number.isSafeInteger(config.uploadUrlTtlSeconds) ||
    config.uploadUrlTtlSeconds < 60 ||
    config.uploadUrlTtlSeconds > 900 ||
    !Number.isSafeInteger(config.readUrlTtlSeconds) ||
    config.readUrlTtlSeconds < 15 ||
    config.readUrlTtlSeconds > 300 ||
    (config.serverSideEncryption === 'aws:kms' && !config.kmsKeyId) ||
    (config.serverSideEncryption !== 'aws:kms' && config.kmsKeyId) ||
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    endpoint.search !== '' ||
    endpoint.hash !== '' ||
    (config.nodeEnvironment === 'production' && endpoint.protocol !== 'https:') ||
    (config.nodeEnvironment === 'production' && config.serverSideEncryption !== 'aws:kms')
  ) {
    fail('CONFIGURATION');
  }
}

export function createAfterSaleEvidenceStorageS3Client(
  config: Pick<S3AfterSaleEvidenceStorageConfig, 'endpoint' | 'forcePathStyle' | 'region'>,
  credentials: EvidenceStorageCredentials,
): S3Client {
  return new S3Client({
    credentials,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    region: config.region,
  });
}

function providerErrorIdentity(error: unknown): {
  httpStatusCode?: number;
  name?: string;
} | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as {
    $metadata?: { httpStatusCode?: number };
    name?: string;
  };
  return {
    ...(candidate.$metadata?.httpStatusCode === undefined
      ? {}
      : { httpStatusCode: candidate.$metadata.httpStatusCode }),
    ...(candidate.name === undefined ? {} : { name: candidate.name }),
  };
}

function isObjectNotFoundError(error: unknown): boolean {
  const identity = providerErrorIdentity(error);
  return (
    identity?.name === 'NoSuchKey' ||
    (identity?.name === 'NotFound' && identity.httpStatusCode === 404)
  );
}

function isExplicitNoSuchKeyError(error: unknown): boolean {
  const identity = providerErrorIdentity(error);
  return identity?.name === 'NoSuchKey' && identity.httpStatusCode === 404;
}

function isPreconditionFailedError(error: unknown): boolean {
  const identity = providerErrorIdentity(error);
  return identity?.httpStatusCode === 412 || identity?.name === 'PreconditionFailed';
}

function mapProviderError(error: unknown): never {
  if (error instanceof AfterSaleEvidenceStorageError) throw error;
  if (isObjectNotFoundError(error)) return fail('NOT_FOUND');
  return fail('UPSTREAM_UNAVAILABLE', true);
}

function providerChecksumToHex(value: string): string | null {
  try {
    const bytes = Buffer.from(value, 'base64');
    return bytes.byteLength === 32 ? bytes.toString('hex') : null;
  } catch {
    return null;
  }
}

function assertHeadMetadata(
  declaration: AfterSaleEvidenceObjectDeclaration,
  head: HeadObjectCommandOutput,
): string {
  const providerChecksum = head.ChecksumSHA256
    ? providerChecksumToHex(head.ChecksumSHA256)
    : undefined;
  if (
    head.ContentLength !== declaration.byteSize ||
    head.ContentType !== declaration.mimeType ||
    typeof head.ETag !== 'string' ||
    head.ETag.length < 3 ||
    head.ETag.length > 130 ||
    providerChecksum === null ||
    (providerChecksum !== undefined && providerChecksum !== declaration.checksumSha256)
  ) {
    fail('METADATA_MISMATCH');
  }
  return head.ETag;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function'
  );
}

function destroyBody(body: unknown): void {
  if (
    typeof body === 'object' &&
    body !== null &&
    'destroy' in body &&
    typeof (body as { destroy?: unknown }).destroy === 'function'
  ) {
    (body as { destroy: () => void }).destroy();
  }
}

type BodyValidationState = {
  object?: ValidatedAfterSaleEvidenceObject;
};

async function* validatedBody(
  declaration: AfterSaleEvidenceObjectDeclaration,
  response: GetObjectCommandOutput,
  abort: () => void,
  state: BodyValidationState,
): AsyncGenerator<Uint8Array, void, void> {
  const body = response.Body;
  if (!isAsyncIterable(body)) {
    abort();
    return fail('UPSTREAM_UNAVAILABLE', true);
  }
  const digest = createHash('sha256');
  const prefix = Buffer.alloc(MAGIC_PREFIX_BYTES);
  let prefixLength = 0;
  let byteSize = 0;
  let completed = false;
  try {
    try {
      for await (const rawChunk of body) {
        if (!(rawChunk instanceof Uint8Array)) return fail('UPSTREAM_UNAVAILABLE', true);
        const chunk = Buffer.from(rawChunk.buffer, rawChunk.byteOffset, rawChunk.byteLength);
        byteSize += chunk.byteLength;
        if (byteSize > declaration.byteSize || byteSize > maximumBytes(declaration.mimeType)) {
          abort();
          return fail('CONTENT_MISMATCH');
        }
        digest.update(chunk);
        if (prefixLength < prefix.byteLength) {
          const copyLength = Math.min(prefix.byteLength - prefixLength, chunk.byteLength);
          chunk.copy(prefix, prefixLength, 0, copyLength);
          prefixLength += copyLength;
        }
        yield chunk;
      }
    } catch (error) {
      return mapProviderError(error);
    }
    const checksumSha256 = digest.digest('hex');
    const detectedMimeType = detectAfterSaleEvidenceMimeType(
      prefix.subarray(0, prefixLength),
      byteSize,
    );
    if (
      byteSize !== declaration.byteSize ||
      checksumSha256 !== declaration.checksumSha256 ||
      detectedMimeType !== declaration.mimeType
    ) {
      return fail('CONTENT_MISMATCH');
    }
    state.object = { byteSize, checksumSha256, mimeType: detectedMimeType };
    completed = true;
  } finally {
    if (!completed) {
      abort();
    }
  }
}

function runtimeCredentials(
  accessKeyId: string | undefined,
  secretAccessKey: string | undefined,
  sessionToken: string | undefined,
): EvidenceStorageCredentials {
  if (!accessKeyId || !secretAccessKey) return fail('CONFIGURATION');
  return {
    accessKeyId,
    secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
  };
}

export function createAfterSaleEvidenceStorageProvider(
  config: RuntimeConfig,
): S3AfterSaleEvidenceStorageProvider | null {
  if (config.EVIDENCE_STORAGE_PROVIDER === 'disabled') return null;
  if (
    !config.EVIDENCE_STORAGE_BUCKET ||
    !config.EVIDENCE_STORAGE_ENDPOINT ||
    config.EVIDENCE_STORAGE_FORCE_PATH_STYLE === undefined ||
    !config.EVIDENCE_STORAGE_REGION
  ) {
    return fail('CONFIGURATION');
  }
  return new S3AfterSaleEvidenceStorageProvider({
    bucket: config.EVIDENCE_STORAGE_BUCKET,
    deleteCredentials: runtimeCredentials(
      config.EVIDENCE_STORAGE_DELETE_ACCESS_KEY,
      config.EVIDENCE_STORAGE_DELETE_SECRET_KEY,
      config.EVIDENCE_STORAGE_DELETE_SESSION_TOKEN,
    ),
    endpoint: config.EVIDENCE_STORAGE_ENDPOINT,
    forcePathStyle: config.EVIDENCE_STORAGE_FORCE_PATH_STYLE,
    ...(config.EVIDENCE_STORAGE_KMS_KEY_ID ? { kmsKeyId: config.EVIDENCE_STORAGE_KMS_KEY_ID } : {}),
    nodeEnvironment: config.NODE_ENV,
    readCredentials: runtimeCredentials(
      config.EVIDENCE_STORAGE_READ_ACCESS_KEY,
      config.EVIDENCE_STORAGE_READ_SECRET_KEY,
      config.EVIDENCE_STORAGE_READ_SESSION_TOKEN,
    ),
    readUrlTtlSeconds: config.EVIDENCE_STORAGE_READ_URL_TTL_SECONDS,
    region: config.EVIDENCE_STORAGE_REGION,
    requestTimeoutMs: config.EVIDENCE_STORAGE_REQUEST_TIMEOUT_MS,
    serverSideEncryption: config.EVIDENCE_STORAGE_SERVER_SIDE_ENCRYPTION,
    uploadCredentials: runtimeCredentials(
      config.EVIDENCE_STORAGE_UPLOAD_ACCESS_KEY,
      config.EVIDENCE_STORAGE_UPLOAD_SECRET_KEY,
      config.EVIDENCE_STORAGE_UPLOAD_SESSION_TOKEN,
    ),
    uploadUrlTtlSeconds: config.EVIDENCE_STORAGE_UPLOAD_URL_TTL_SECONDS,
  });
}

export class S3AfterSaleEvidenceStorageProvider implements AfterSaleEvidenceObjectStorageProvider {
  readonly #deleteClient: S3Client;
  readonly #readClient: S3Client;
  readonly #uploadClient: S3Client;

  public constructor(private readonly config: S3AfterSaleEvidenceStorageConfig) {
    assertConfig(config);
    this.#uploadClient = createAfterSaleEvidenceStorageS3Client(config, config.uploadCredentials);
    this.#readClient = createAfterSaleEvidenceStorageS3Client(config, config.readCredentials);
    this.#deleteClient = createAfterSaleEvidenceStorageS3Client(config, config.deleteCredentials);
  }

  public async createUploadTarget(declaration: AfterSaleEvidenceObjectDeclaration) {
    assertDeclaration(declaration);
    const expiresIn = this.config.uploadUrlTtlSeconds;
    const checksum = Buffer.from(declaration.checksumSha256, 'hex').toString('base64');
    const encryption =
      this.config.serverSideEncryption === 'none'
        ? {}
        : this.config.serverSideEncryption === 'AES256'
          ? { ServerSideEncryption: 'AES256' as const }
          : {
              SSEKMSKeyId: this.config.kmsKeyId,
              ServerSideEncryption: 'aws:kms' as const,
            };
    const command = new PutObjectCommand({
      Body: undefined,
      Bucket: this.config.bucket,
      ChecksumSHA256: checksum,
      ContentLength: declaration.byteSize,
      ContentType: declaration.mimeType,
      IfNoneMatch: '*',
      Key: declaration.objectKey,
      ...encryption,
    });
    try {
      return {
        expiresAt: new Date(Date.now() + expiresIn * 1_000),
        headers: {
          'content-type': declaration.mimeType,
          'if-none-match': '*',
          'x-amz-checksum-sha256': checksum,
          ...(this.config.serverSideEncryption === 'none'
            ? {}
            : {
                'x-amz-server-side-encryption': this.config.serverSideEncryption,
                ...(this.config.kmsKeyId
                  ? { 'x-amz-server-side-encryption-aws-kms-key-id': this.config.kmsKeyId }
                  : {}),
              }),
        },
        url: await getSignedUrl(this.#uploadClient, command, {
          expiresIn,
          signableHeaders: new Set(['content-type']),
          unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
        }),
      };
    } catch (error) {
      return mapProviderError(error);
    }
  }

  public async validateUploadedObject(
    declaration: AfterSaleEvidenceObjectDeclaration,
  ): Promise<ValidatedAfterSaleEvidenceObject> {
    const consumed = await this.consumeValidatedObject(declaration, async (bytes) => {
      for await (const chunk of bytes) void chunk;
    });
    return consumed.object;
  }

  public async consumeValidatedObject<T>(
    declaration: AfterSaleEvidenceObjectDeclaration,
    consumer: (bytes: AsyncIterable<Uint8Array>) => Promise<T>,
  ): Promise<Readonly<{ object: ValidatedAfterSaleEvidenceObject; result: T }>> {
    assertDeclaration(declaration);
    let entityTag: string;
    try {
      const head = await this.#readClient.send(
        new HeadObjectCommand({
          Bucket: this.config.bucket,
          ChecksumMode: 'ENABLED',
          Key: declaration.objectKey,
        }),
        { abortSignal: AbortSignal.timeout(this.config.requestTimeoutMs) },
      );
      entityTag = assertHeadMetadata(declaration, head);
    } catch (error) {
      return mapProviderError(error);
    }

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), this.config.requestTimeoutMs);
    timeout.unref();
    let response: GetObjectCommandOutput;
    try {
      response = await this.#readClient.send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          ChecksumMode: 'ENABLED',
          IfMatch: entityTag,
          Key: declaration.objectKey,
        }),
        { abortSignal: abortController.signal },
      );
    } catch (error) {
      clearTimeout(timeout);
      if (isPreconditionFailedError(error)) return fail('CONTENT_MISMATCH');
      return mapProviderError(error);
    }

    const state: BodyValidationState = {};
    let accepted = false;
    try {
      const result = await consumer(
        validatedBody(declaration, response, () => abortController.abort(), state),
      );
      if (!state.object) return fail('CONTENT_MISMATCH');
      accepted = true;
      return { object: state.object, result };
    } finally {
      clearTimeout(timeout);
      if (!accepted) {
        abortController.abort();
        destroyBody(response.Body);
      }
    }
  }

  public async createProtectedReadTarget(input: AfterSaleEvidenceProtectedReadIdentity) {
    const { accessDeadline, ...identity } = input;
    assertOriginalIdentity(identity);
    const { expiresAt, expiresIn, signingDate } = protectedReadExpiry(this.config, accessDeadline);
    try {
      return {
        expiresAt,
        url: await getSignedUrl(
          this.#readClient,
          new GetObjectCommand({
            Bucket: this.config.bucket,
            Key: identity.objectKey,
            ResponseCacheControl: 'private, no-store',
            ResponseContentDisposition: 'inline',
          }),
          { expiresIn, signingDate },
        ),
      };
    } catch (error) {
      return mapProviderError(error);
    }
  }

  public async removeObject(
    identity: AfterSaleEvidenceObjectIdentity,
  ): Promise<'DELETED_OR_NOT_FOUND'> {
    assertIdentity(identity);
    try {
      await this.#deleteClient.send(
        new DeleteObjectCommand({ Bucket: this.config.bucket, Key: identity.objectKey }),
        { abortSignal: AbortSignal.timeout(this.config.requestTimeoutMs) },
      );
      return 'DELETED_OR_NOT_FOUND';
    } catch (error) {
      if (isExplicitNoSuchKeyError(error)) return 'DELETED_OR_NOT_FOUND';
      if (error instanceof AfterSaleEvidenceStorageError) throw error;
      return fail('UPSTREAM_UNAVAILABLE', true);
    }
  }

  public destroy(): void {
    this.#uploadClient.destroy();
    this.#readClient.destroy();
    this.#deleteClient.destroy();
  }
}
