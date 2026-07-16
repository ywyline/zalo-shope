import { beforeEach, describe, expect, it } from 'vitest';

import { createZaloTestToken, DeterministicZaloTestProvider, ZaloProviderError } from './index';

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
