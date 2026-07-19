import { randomUUID } from 'node:crypto';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { RuntimeConfig } from '@zalo-shop/config';
import { signJwt, verifyJwt } from '@zalo-shop/security';

export type MediaObjectMetadata = Readonly<{
  byteSize: number;
  checksumSha256?: string;
  contentType?: string;
}>;

export interface MediaStorageProvider {
  createReadUrl(objectKey: string): Promise<{ expiresAt: Date; url: string }>;
  createUploadTarget(input: {
    byteSize: number;
    checksumSha256: string;
    contentType: string;
    objectKey: string;
  }): Promise<{ expiresAt: Date; headers: Readonly<Record<string, string>>; url: string }>;
  inspectObject(objectKey: string): Promise<MediaObjectMetadata>;
  removeObject?(objectKey: string): Promise<void>;
}

export class S3MediaStorageProvider implements MediaStorageProvider {
  readonly #client: S3Client;

  public constructor(private readonly config: RuntimeConfig) {
    this.#client = new S3Client({
      credentials: {
        accessKeyId: config.S3_ACCESS_KEY,
        secretAccessKey: config.S3_SECRET_KEY,
      },
      endpoint: config.S3_ENDPOINT,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      region: config.S3_REGION,
    });
  }

  public async createUploadTarget(input: {
    byteSize: number;
    checksumSha256: string;
    contentType: string;
    objectKey: string;
  }) {
    const expiresIn = 300;
    const command = new PutObjectCommand({
      Body: undefined,
      Bucket: this.config.S3_BUCKET,
      ChecksumSHA256: Buffer.from(input.checksumSha256, 'hex').toString('base64'),
      ContentLength: input.byteSize,
      ContentType: input.contentType,
      Key: input.objectKey,
    });
    return {
      expiresAt: new Date(Date.now() + expiresIn * 1_000),
      headers: {
        'content-type': input.contentType,
        'x-amz-checksum-sha256': Buffer.from(input.checksumSha256, 'hex').toString('base64'),
      },
      url: await getSignedUrl(this.#client, command, { expiresIn }),
    };
  }

  public async createReadUrl(objectKey: string): Promise<{ expiresAt: Date; url: string }> {
    const expiresIn = 300;
    return {
      expiresAt: new Date(Date.now() + expiresIn * 1_000),
      url: await getSignedUrl(
        this.#client,
        new GetObjectCommand({ Bucket: this.config.S3_BUCKET, Key: objectKey }),
        { expiresIn },
      ),
    };
  }

  public async inspectObject(objectKey: string): Promise<MediaObjectMetadata> {
    const result = await this.#client.send(
      new HeadObjectCommand({ Bucket: this.config.S3_BUCKET, Key: objectKey }),
    );
    return {
      byteSize: result.ContentLength ?? 0,
      ...(result.ChecksumSHA256
        ? { checksumSha256: Buffer.from(result.ChecksumSHA256, 'base64').toString('hex') }
        : {}),
      ...(result.ContentType ? { contentType: result.ContentType } : {}),
    };
  }

  public async removeObject(objectKey: string): Promise<void> {
    await this.#client.send(
      new DeleteObjectCommand({ Bucket: this.config.S3_BUCKET, Key: objectKey }),
    );
  }
}

export type ZaloIdentity = Readonly<{
  avatarUrl?: string;
  displayName?: string;
  expiresAt: Date;
  miniAppId: string;
  parentAppId: string;
  subjectId: string;
}>;

export interface ZaloIdentityProvider {
  decodePhoneToken(input: {
    accessToken: string;
    expectedMiniAppId: string;
    token: string;
  }): Promise<{ phoneE164: string }>;

  verifyAccessToken(input: {
    accessToken: string;
    expectedMiniAppId: string;
  }): Promise<ZaloIdentity>;
}

export class ZaloProviderError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ZaloProviderError';
  }
}

type TestProviderOptions = {
  audience: string;
  issuer: string;
  secret: string;
};

export class DeterministicZaloTestProvider implements ZaloIdentityProvider {
  readonly #consumedPhoneTokens = new Set<string>();

  public constructor(private readonly options: TestProviderOptions) {
    if (process.env.NODE_ENV !== 'test') {
      throw new ZaloProviderError('The deterministic Zalo provider is test-only');
    }
  }

  public async verifyAccessToken(input: {
    accessToken: string;
    expectedMiniAppId: string;
  }): Promise<ZaloIdentity> {
    await Promise.resolve();
    const claims = verifyJwt(input.accessToken, {
      audience: this.options.audience,
      issuer: this.options.issuer,
      secret: this.options.secret,
    });
    if (claims.kind !== 'zalo_access' || claims.mini_app_id !== input.expectedMiniAppId) {
      throw new ZaloProviderError('Zalo token does not belong to the expected Mini App');
    }
    if (typeof claims.parent_app_id !== 'string') {
      throw new ZaloProviderError('Zalo token is missing its parent App identity');
    }
    return {
      ...(typeof claims.avatar_url === 'string' ? { avatarUrl: claims.avatar_url } : {}),
      ...(typeof claims.display_name === 'string' ? { displayName: claims.display_name } : {}),
      expiresAt: new Date(claims.exp * 1_000),
      miniAppId: input.expectedMiniAppId,
      parentAppId: claims.parent_app_id,
      subjectId: claims.sub,
    };
  }

  public async decodePhoneToken(input: {
    accessToken: string;
    expectedMiniAppId: string;
    token: string;
  }): Promise<{ phoneE164: string }> {
    const identity = await this.verifyAccessToken(input);
    const claims = verifyJwt(input.token, {
      audience: this.options.audience,
      issuer: this.options.issuer,
      secret: this.options.secret,
    });
    if (
      claims.kind !== 'zalo_phone' ||
      claims.sub !== identity.subjectId ||
      claims.mini_app_id !== input.expectedMiniAppId ||
      typeof claims.phone !== 'string' ||
      this.#consumedPhoneTokens.has(claims.jti)
    ) {
      throw new ZaloProviderError('Zalo phone token is invalid or already consumed');
    }
    this.#consumedPhoneTokens.add(claims.jti);
    return { phoneE164: claims.phone };
  }
}

export function createZaloTestToken(
  input: {
    expiresInSeconds?: number;
    kind: 'zalo_access' | 'zalo_phone';
    miniAppId: string;
    parentAppId: string;
    phone?: string;
    subjectId: string;
  },
  options: TestProviderOptions,
): string {
  if (process.env.NODE_ENV !== 'test') {
    throw new ZaloProviderError('Test tokens can only be created in test');
  }
  const now = Math.floor(Date.now() / 1_000);
  return signJwt(
    {
      aud: options.audience,
      exp: now + (input.expiresInSeconds ?? 300),
      iat: now,
      iss: options.issuer,
      jti: randomUUID(),
      kind: input.kind,
      mini_app_id: input.miniAppId,
      parent_app_id: input.parentAppId,
      ...(input.phone === undefined ? {} : { phone: input.phone }),
      sub: input.subjectId,
    },
    options.secret,
  );
}
