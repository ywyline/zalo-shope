export type ZaloSessionFailureCode =
  | 'ZALO_RUNTIME_UNAVAILABLE'
  | 'ZALO_TOKEN_REJECTED'
  | 'ZALO_TOKEN_EMPTY'
  | 'ZALO_EXCHANGE_HTTP_FAILURE'
  | 'ZALO_EXCHANGE_RESPONSE_INVALID';

type SessionResponse = {
  json(): Promise<unknown>;
  ok: boolean;
};

export type SessionFetch = (input: string, init: RequestInit) => Promise<SessionResponse>;

type EstablishZaloSessionInput = {
  apiBase: string;
  fetcher: SessionFetch;
  getAccessToken(): Promise<unknown>;
  runtimeAvailable: boolean;
  storeCode: string;
};

export type EstablishedZaloSession = {
  accessToken: string;
  zaloAccessToken: string;
};

export class ZaloSessionError extends Error {
  readonly code: ZaloSessionFailureCode;

  constructor(code: ZaloSessionFailureCode) {
    super(code);
    this.name = 'ZaloSessionError';
    this.code = code;
  }
}

function hasAccessToken(value: unknown): value is { access_token: string } {
  if (!value || typeof value !== 'object') return false;
  const accessToken = (value as { access_token?: unknown }).access_token;
  return typeof accessToken === 'string' && accessToken.trim().length > 0;
}

export async function establishZaloSession(
  input: EstablishZaloSessionInput,
): Promise<EstablishedZaloSession> {
  if (!input.runtimeAvailable) throw new ZaloSessionError('ZALO_RUNTIME_UNAVAILABLE');

  let rawToken: unknown;
  try {
    rawToken = await input.getAccessToken();
  } catch {
    throw new ZaloSessionError('ZALO_TOKEN_REJECTED');
  }
  if (typeof rawToken !== 'string' || rawToken.trim().length === 0) {
    throw new ZaloSessionError('ZALO_TOKEN_EMPTY');
  }
  const zaloAccessToken = rawToken.trim();

  let response: SessionResponse;
  try {
    response = await input.fetcher(`${input.apiBase}/v1/auth/zalo/exchange`, {
      headers: {
        'X-Store-Code': input.storeCode,
        'X-Zalo-Access-Token': zaloAccessToken,
      },
      method: 'POST',
    });
  } catch {
    throw new ZaloSessionError('ZALO_EXCHANGE_HTTP_FAILURE');
  }
  if (!response.ok) throw new ZaloSessionError('ZALO_EXCHANGE_HTTP_FAILURE');

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ZaloSessionError('ZALO_EXCHANGE_RESPONSE_INVALID');
  }
  if (!hasAccessToken(payload)) {
    throw new ZaloSessionError('ZALO_EXCHANGE_RESPONSE_INVALID');
  }

  return {
    accessToken: payload.access_token.trim(),
    zaloAccessToken,
  };
}
