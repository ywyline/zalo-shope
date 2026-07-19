import { createHmac } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createZaloTestToken,
  DeterministicZaloTestProvider,
  ZaloOpenApiIdentityProvider,
  ZaloProviderError,
} from './index';

const options = {
  audience: 'zalo-test',
  issuer: 'zalo-test-provider',
  secret: 'zalo-test-secret-that-is-at-least-32-characters',
};

describe('deterministic Zalo test provider', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
  });

  it('verifies signature, expiry and Mini App ownership', async () => {
    const provider = new DeterministicZaloTestProvider(options);
    const accessToken = createZaloTestToken(
      {
        kind: 'zalo_access',
        miniAppId: 'mini-beauty',
        parentAppId: 'parent-1',
        subjectId: 'zalo-user-1',
      },
      options,
    );
    await expect(
      provider.verifyAccessToken({ accessToken, expectedMiniAppId: 'mini-beauty' }),
    ).resolves.toMatchObject({
      miniAppId: 'mini-beauty',
      parentAppId: 'parent-1',
      subjectId: 'zalo-user-1',
    });
    await expect(
      provider.verifyAccessToken({ accessToken, expectedMiniAppId: 'mini-fashion' }),
    ).rejects.toThrow(ZaloProviderError);
  });

  it('consumes a signed phone token only once for the same identity', async () => {
    const provider = new DeterministicZaloTestProvider(options);
    const accessToken = createZaloTestToken(
      {
        kind: 'zalo_access',
        miniAppId: 'mini-beauty',
        parentAppId: 'parent-1',
        subjectId: 'zalo-user-1',
      },
      options,
    );
    const token = createZaloTestToken(
      {
        kind: 'zalo_phone',
        miniAppId: 'mini-beauty',
        parentAppId: 'parent-1',
        phone: '+84912345678',
        subjectId: 'zalo-user-1',
      },
      options,
    );
    await expect(
      provider.decodePhoneToken({ accessToken, expectedMiniAppId: 'mini-beauty', token }),
    ).resolves.toEqual({ phoneE164: '+84912345678' });
    await expect(
      provider.decodePhoneToken({ accessToken, expectedMiniAppId: 'mini-beauty', token }),
    ).rejects.toThrow('already consumed');
  });

  it('cannot be instantiated outside tests', () => {
    process.env.NODE_ENV = 'production';
    expect(() => new DeterministicZaloTestProvider(options)).toThrow('test-only');
  });
});

describe('Zalo Open API identity provider', () => {
  const appSecret = 'server-only-zalo-app-secret';
  const miniAppId = '1054942727582608082';
  const parentAppId = '1364144247280182439';

  it('verifies identity through Graph API with an HMAC appsecret proof', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'zalo-user-1',
          name: 'Nguyen Test',
          picture: { data: { url: 'https://example.test/avatar.jpg' } },
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      ),
    );
    const provider = new ZaloOpenApiIdentityProvider({
      appSecret,
      fetch: request,
      miniAppId,
      now: () => Date.UTC(2026, 6, 19),
      parentAppId,
      tokenMetadataTtlSeconds: 300,
    });

    await expect(
      provider.verifyAccessToken({ accessToken: 'access-token', expectedMiniAppId: miniAppId }),
    ).resolves.toEqual({
      avatarUrl: 'https://example.test/avatar.jpg',
      displayName: 'Nguyen Test',
      expiresAt: new Date(Date.UTC(2026, 6, 19) + 300_000),
      miniAppId,
      parentAppId,
      subjectId: 'zalo-user-1',
    });
    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe('https://graph.zalo.me/v2.0/me?fields=id%2Cname%2Cpicture');
    const headers = new Headers(init?.headers);
    expect(headers.get('access_token')).toBe('access-token');
    expect(headers.get('appsecret_proof')).toBe(
      createHmac('sha256', appSecret).update('access-token').digest('hex'),
    );
    expect(headers.has('secret_key')).toBe(false);
  });

  it('rejects another Mini App before sending credentials over the network', async () => {
    const request = vi.fn<typeof fetch>();
    const provider = new ZaloOpenApiIdentityProvider({
      appSecret,
      fetch: request,
      miniAppId,
      parentAppId,
    });

    await expect(
      provider.verifyAccessToken({ accessToken: 'access-token', expectedMiniAppId: 'other-app' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' });
    expect(request).not.toHaveBeenCalled();
  });

  it('decodes a one-time phone token only on the server endpoint', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: { number: '84912345678' }, error: 0 }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      }),
    );
    const provider = new ZaloOpenApiIdentityProvider({
      appSecret,
      fetch: request,
      miniAppId,
      parentAppId,
    });

    await expect(
      provider.decodePhoneToken({
        accessToken: 'access-token',
        expectedMiniAppId: miniAppId,
        token: 'one-time-phone-token',
      }),
    ).resolves.toEqual({ phoneE164: '84912345678' });
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe('https://graph.zalo.me/v2.0/me/info');
    const headers = new Headers(init?.headers);
    expect(headers.get('access_token')).toBe('access-token');
    expect(headers.get('code')).toBe('one-time-phone-token');
    expect(headers.get('secret_key')).toBe(appSecret);
    expect(headers.has('appsecret_proof')).toBe(false);
  });

  it('classifies upstream failures without exposing credentials or raw responses', async () => {
    const sensitiveUpstreamMessage = `rejected ${appSecret} access-token`;
    const provider = new ZaloOpenApiIdentityProvider({
      appSecret,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ error: -201, message: sensitiveUpstreamMessage }), {
          status: 200,
        }),
      ),
      miniAppId,
      parentAppId,
    });

    let received: unknown;
    try {
      await provider.verifyAccessToken({
        accessToken: 'access-token',
        expectedMiniAppId: miniAppId,
      });
    } catch (error) {
      received = error;
    }
    expect(received).toBeInstanceOf(ZaloProviderError);
    expect(received).toMatchObject({ code: 'INVALID_CREDENTIAL' });
    expect(String(received)).not.toContain(appSecret);
    expect(String(received)).not.toContain('access-token');
    expect(String(received)).not.toContain(sensitiveUpstreamMessage);
  });

  it('maps network and rate-limit failures to an unavailable upstream', async () => {
    const networkProvider = new ZaloOpenApiIdentityProvider({
      appSecret,
      fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error('socket failed with secret')),
      miniAppId,
      parentAppId,
    });
    await expect(
      networkProvider.verifyAccessToken({
        accessToken: 'access-token',
        expectedMiniAppId: miniAppId,
      }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });

    const limitedProvider = new ZaloOpenApiIdentityProvider({
      appSecret,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 429 })),
      miniAppId,
      parentAppId,
    });
    await expect(
      limitedProvider.decodePhoneToken({
        accessToken: 'access-token',
        expectedMiniAppId: miniAppId,
        token: 'phone-token',
      }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });
});
