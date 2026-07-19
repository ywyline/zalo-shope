import { createHmac, randomUUID } from 'node:crypto';

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

export type ZaloProviderErrorCode = 'CONFIGURATION' | 'INVALID_CREDENTIAL' | 'UPSTREAM_UNAVAILABLE';

export class ZaloProviderError extends Error {
  public constructor(
    message: string,
    public readonly code: ZaloProviderErrorCode = 'INVALID_CREDENTIAL',
  ) {
    super(message);
    this.name = 'ZaloProviderError';
  }
}

type ZaloOpenApiProviderOptions = {
  appSecret: string;
  fetch?: typeof fetch;
  miniAppId: string;
  now?: () => number;
  parentAppId: string;
  requestTimeoutMs?: number;
  tokenMetadataTtlSeconds?: number;
};

const ZALO_GRAPH_ORIGIN = 'https://graph.zalo.me';
const ZALO_RESPONSE_LIMIT_BYTES = 32 * 1_024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class ZaloOpenApiIdentityProvider implements ZaloIdentityProvider {
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #requestTimeoutMs: number;
  readonly #tokenMetadataTtlSeconds: number;

  public constructor(private readonly options: ZaloOpenApiProviderOptions) {
    if (
      !options.appSecret ||
      !options.miniAppId ||
      !options.parentAppId ||
      (options.requestTimeoutMs !== undefined && options.requestTimeoutMs < 500) ||
      (options.tokenMetadataTtlSeconds !== undefined && options.tokenMetadataTtlSeconds < 60)
    ) {
      throw new ZaloProviderError(
        'Zalo Open API provider configuration is invalid',
        'CONFIGURATION',
      );
    }
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
    this.#tokenMetadataTtlSeconds = options.tokenMetadataTtlSeconds ?? 300;
  }

  public async verifyAccessToken(input: {
    accessToken: string;
    expectedMiniAppId: string;
  }): Promise<ZaloIdentity> {
    this.assertMiniApp(input.expectedMiniAppId);
    if (!input.accessToken) {
      throw new ZaloProviderError('Zalo access credential is invalid');
    }
    const appSecretProof = createHmac('sha256', this.options.appSecret)
      .update(input.accessToken)
      .digest('hex');
    const response = await this.request('/v2.0/me?fields=id%2Cname%2Cpicture', {
      access_token: input.accessToken,
      appsecret_proof: appSecretProof,
    });
    const subjectId = response.id;
    if (typeof subjectId !== 'string' || !subjectId) {
      throw new ZaloProviderError('Zalo access credential is invalid');
    }
    const picture = isRecord(response.picture) ? response.picture : undefined;
    const pictureData = picture && isRecord(picture.data) ? picture.data : undefined;
    const avatarUrl = pictureData?.url;
    return {
      ...(typeof avatarUrl === 'string' && avatarUrl ? { avatarUrl } : {}),
      ...(typeof response.name === 'string' && response.name ? { displayName: response.name } : {}),
      expiresAt: new Date(this.#now() + this.#tokenMetadataTtlSeconds * 1_000),
      miniAppId: this.options.miniAppId,
      parentAppId: this.options.parentAppId,
      subjectId,
    };
  }

  public async decodePhoneToken(input: {
    accessToken: string;
    expectedMiniAppId: string;
    token: string;
  }): Promise<{ phoneE164: string }> {
    this.assertMiniApp(input.expectedMiniAppId);
    if (!input.accessToken || !input.token) {
      throw new ZaloProviderError('Zalo phone credential is invalid');
    }
    const response = await this.request('/v2.0/me/info', {
      access_token: input.accessToken,
      code: input.token,
      secret_key: this.options.appSecret,
    });
    const data = isRecord(response.data) ? response.data : undefined;
    if (typeof data?.number !== 'string' || !data.number) {
      throw new ZaloProviderError('Zalo phone credential is invalid');
    }
    return { phoneE164: data.number };
  }

  private assertMiniApp(expectedMiniAppId: string): void {
    if (expectedMiniAppId !== this.options.miniAppId) {
      throw new ZaloProviderError('Zalo credential does not belong to the expected Mini App');
    }
  }

  private async request(
    path: string,
    headers: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.#fetch(`${ZALO_GRAPH_ORIGIN}${path}`, {
        headers,
        method: 'GET',
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
      });
    } catch {
      throw new ZaloProviderError('Zalo identity service is unavailable', 'UPSTREAM_UNAVAILABLE');
    }
    if (!response.ok) {
      throw new ZaloProviderError(
        response.status === 429 || response.status >= 500
          ? 'Zalo identity service is unavailable'
          : 'Zalo credential was rejected',
        response.status === 429 || response.status >= 500
          ? 'UPSTREAM_UNAVAILABLE'
          : 'INVALID_CREDENTIAL',
      );
    }
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > ZALO_RESPONSE_LIMIT_BYTES) {
      throw new ZaloProviderError(
        'Zalo identity service returned an invalid response',
        'UPSTREAM_UNAVAILABLE',
      );
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new ZaloProviderError(
        'Zalo identity service returned an invalid response',
        'UPSTREAM_UNAVAILABLE',
      );
    }
    if (Buffer.byteLength(text, 'utf8') > ZALO_RESPONSE_LIMIT_BYTES) {
      throw new ZaloProviderError(
        'Zalo identity service returned an invalid response',
        'UPSTREAM_UNAVAILABLE',
      );
    }
    let result: unknown;
    try {
      result = JSON.parse(text);
    } catch {
      throw new ZaloProviderError(
        'Zalo identity service returned an invalid response',
        'UPSTREAM_UNAVAILABLE',
      );
    }
    if (!isRecord(result)) {
      throw new ZaloProviderError(
        'Zalo identity service returned an invalid response',
        'UPSTREAM_UNAVAILABLE',
      );
    }
    if (typeof result.error === 'number' && result.error !== 0) {
      throw new ZaloProviderError('Zalo credential was rejected');
    }
    return result;
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
    const claims = this.verifyToken(input.accessToken);
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
    const claims = this.verifyToken(input.token);
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

  private verifyToken(token: string): ReturnType<typeof verifyJwt> {
    try {
      return verifyJwt(token, {
        audience: this.options.audience,
        issuer: this.options.issuer,
        secret: this.options.secret,
      });
    } catch {
      throw new ZaloProviderError('Zalo test credential is invalid');
    }
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
