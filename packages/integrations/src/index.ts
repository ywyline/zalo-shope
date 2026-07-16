import { randomUUID } from 'node:crypto';

import { signJwt, verifyJwt } from '@zalo-shop/security';

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
