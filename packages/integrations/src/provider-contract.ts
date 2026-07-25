export type ProviderEnvironment = 'SANDBOX' | 'PRODUCTION';

export type ProviderFailureCode =
  | 'CONFIGURATION'
  | 'INVALID_REQUEST'
  | 'AUTHENTICATION'
  | 'REJECTED'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'UPSTREAM_UNAVAILABLE'
  | 'INVALID_RESPONSE'
  | 'UNKNOWN_STATUS';

export class ProviderIntegrationError extends Error {
  public constructor(
    public readonly code: ProviderFailureCode,
    public readonly retryable: boolean,
    message = 'Provider integration failed',
  ) {
    super(message);
    this.name = 'ProviderIntegrationError';
  }
}

export type ProviderCallbackTrust = 'AUTHENTICATED_FACT' | 'UNVERIFIED_HINT';

export type ProviderCallbackResult<TFact, THint = never> = Readonly<{
  externalEventId?: string;
  fact?: TFact;
  hint?: THint;
  trust: ProviderCallbackTrust;
}>;

export type ProviderRawCallback = Readonly<{
  headers: Readonly<Record<string, string | undefined>>;
  rawBody: Uint8Array;
  remoteAddress?: string;
}>;
