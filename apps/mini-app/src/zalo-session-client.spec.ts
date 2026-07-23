import { describe, expect, it, vi } from 'vitest';

import { establishZaloSession, type SessionFetch, ZaloSessionError } from './zalo-session-client';

const API_BASE = 'https://api.example.test';
const STORE_CODE = 'beauty-local';

function response(ok: boolean, body: unknown): Awaited<ReturnType<SessionFetch>> {
  return {
    json: () => Promise.resolve(body),
    ok,
  };
}

describe('establishZaloSession', () => {
  it('classifies a missing Zalo runtime before requesting a token', async () => {
    const getAccessToken = vi.fn(() => Promise.resolve('unused'));
    const fetcher = vi.fn<SessionFetch>();

    await expect(
      establishZaloSession({
        apiBase: API_BASE,
        fetcher,
        getAccessToken,
        runtimeAvailable: false,
        storeCode: STORE_CODE,
      }),
    ).rejects.toMatchObject({ code: 'ZALO_RUNTIME_UNAVAILABLE' });
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('classifies an SDK rejection without retaining its potentially sensitive message', async () => {
    const sensitiveMarker = 'zalo-token-sensitive-marker';
    const fetcher = vi.fn<SessionFetch>();
    let caught: unknown;

    try {
      await establishZaloSession({
        apiBase: API_BASE,
        fetcher,
        getAccessToken: () => Promise.reject(new Error(`SDK rejected ${sensitiveMarker}`)),
        runtimeAvailable: true,
        storeCode: STORE_CODE,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ZaloSessionError);
    expect(caught).toMatchObject({ code: 'ZALO_TOKEN_REJECTED' });
    expect(String(caught)).not.toContain(sensitiveMarker);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([undefined, null, '', '   ', { token: 'unexpected-shape' }])(
    'classifies an empty or invalid SDK token: %j',
    async (token) => {
      const fetcher = vi.fn<SessionFetch>();

      await expect(
        establishZaloSession({
          apiBase: API_BASE,
          fetcher,
          getAccessToken: () => Promise.resolve(token),
          runtimeAvailable: true,
          storeCode: STORE_CODE,
        }),
      ).rejects.toMatchObject({ code: 'ZALO_TOKEN_EMPTY' });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([
    () => Promise.reject(new Error('network unavailable')),
    () => Promise.resolve(response(false, { error: 'upstream details' })),
  ])('classifies exchange transport and HTTP failures', async (fetcher) => {
    await expect(
      establishZaloSession({
        apiBase: API_BASE,
        fetcher,
        getAccessToken: () => Promise.resolve('zalo-access-token'),
        runtimeAvailable: true,
        storeCode: STORE_CODE,
      }),
    ).rejects.toMatchObject({ code: 'ZALO_EXCHANGE_HTTP_FAILURE' });
  });

  it.each([
    () => Promise.resolve(response(true, {})),
    () => Promise.resolve(response(true, { access_token: '' })),
    () =>
      Promise.resolve({
        json: () => Promise.reject(new Error('invalid json')),
        ok: true,
      }),
  ])('classifies invalid successful exchange responses', async (fetcher) => {
    await expect(
      establishZaloSession({
        apiBase: API_BASE,
        fetcher,
        getAccessToken: () => Promise.resolve('zalo-access-token'),
        runtimeAvailable: true,
        storeCode: STORE_CODE,
      }),
    ).rejects.toMatchObject({ code: 'ZALO_EXCHANGE_RESPONSE_INVALID' });
  });

  it('returns both tokens and sends the Zalo token only in the exchange header', async () => {
    const fetcher = vi.fn<SessionFetch>(() =>
      Promise.resolve(response(true, { access_token: 'member-session-token' })),
    );

    await expect(
      establishZaloSession({
        apiBase: API_BASE,
        fetcher,
        getAccessToken: () => Promise.resolve('zalo-access-token'),
        runtimeAvailable: true,
        storeCode: STORE_CODE,
      }),
    ).resolves.toEqual({
      accessToken: 'member-session-token',
      zaloAccessToken: 'zalo-access-token',
    });
    expect(fetcher).toHaveBeenCalledWith(`${API_BASE}/v1/auth/zalo/exchange`, {
      headers: {
        'X-Store-Code': STORE_CODE,
        'X-Zalo-Access-Token': 'zalo-access-token',
      },
      method: 'POST',
    });
  });
});
