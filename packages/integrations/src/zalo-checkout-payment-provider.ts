import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import {
  buildZaloCheckoutCallbackMacData,
  buildZaloCheckoutCreateRefundMacData,
  buildZaloCheckoutCreateOrderMacData,
  buildZaloCheckoutQueryRefundMacData,
  canonicalizeZaloCheckoutOverallMacFields,
  mapZaloCheckoutCreateRefundResult,
  mapZaloCheckoutPaymentResult,
  mapZaloCheckoutRefundStatusResult,
  zaloPayCheckoutMethod,
  zaloPayCheckoutMethodJson,
} from './zalo-checkout-contract';
import {
  ProviderIntegrationError,
  type ProviderCallbackResult,
  type ProviderRawCallback,
} from './provider-contract';
import type { PaymentProvider, PaymentProviderFact, RefundProviderFact } from './payment-provider';

export const ZALO_CHECKOUT_PAYMENT_PROVIDER_CODE = 'ZALO_CHECKOUT_ZALOPAY';
export const ZALO_CHECKOUT_STATUS_ENDPOINT =
  'https://payment-mini.zalo.me/api/transaction/get-status';
export const ZALO_CHECKOUT_REFUND_CREATE_ENDPOINT =
  'https://payment-mini.zalo.me/api/refund/create';
export const ZALO_CHECKOUT_REFUND_STATUS_ENDPOINT = 'https://payment-mini.zalo.me/api/refund';
export const ZALO_CHECKOUT_CALLBACK_MAX_BYTES = 128 * 1_024;

export type ZaloCheckoutCallbackRoute = Readonly<{
  appId: string;
  method: 'ZALOPAY_SANDBOX' | 'ZALOPAY';
}>;

export interface SecretReferenceResolver {
  resolve(reference: string): Promise<string>;
}

export type ZaloCheckoutPaymentProviderOptions = Readonly<{
  appId: string;
  environment: 'SANDBOX' | 'PRODUCTION';
  fetch?: typeof fetch;
  now?: () => number;
  privateKeySecretRef: string;
  resolveSecret: SecretReferenceResolver;
  responseLimitBytes?: number;
  requestTimeoutMs?: number;
  storeId: string;
  statusEndpoint?: string;
  refundCreateEndpoint?: string;
  refundStatusEndpoint?: string;
  allowedStatusOrigins?: readonly string[];
}>;

type CallbackData = Readonly<{
  amount: number;
  appId: string;
  description: string;
  extradata?: string;
  isProcessing?: boolean;
  message: string;
  merchantTransId?: string;
  method?: string;
  orderId: string;
  paymentChannel?: string;
  resultCode: number;
  transId: string;
  transTime?: number;
}>;

type OrderStatusResponse = Readonly<{
  amount: number;
  extradata?: string;
  isProcessing?: boolean;
  merchantTransId?: string;
  method?: string;
  returnCode: number;
  returnMessage?: string;
  transId?: string;
  transTime?: number;
}>;

type CheckoutIdentity = Readonly<{
  attemptId: string;
  nonce: string;
  orderId: string;
  storeId: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, field: string, max = 1024): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new ProviderIntegrationError('INVALID_RESPONSE', false, `Invalid ${field}`);
  }
  return value;
}

function safeAmount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ProviderIntegrationError('INVALID_RESPONSE', false, 'Invalid VND amount');
  }
  return value;
}

function safeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new ProviderIntegrationError('INVALID_RESPONSE', false, `Invalid ${field}`);
  }
  return value;
}

function equalHex(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function decodeExtradata(value: unknown): CheckoutIdentity {
  const encoded = nonEmptyString(value, 'extradata', 8_192);
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    throw new ProviderIntegrationError('INVALID_RESPONSE', false, 'Invalid extradata encoding');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new ProviderIntegrationError('INVALID_RESPONSE', false, 'Invalid extradata JSON');
  }
  if (!isRecord(parsed)) {
    throw new ProviderIntegrationError('INVALID_RESPONSE', false, 'Invalid extradata object');
  }
  const identity = {
    attemptId: nonEmptyString(parsed.attempt_id, 'extradata.attempt_id', 128),
    nonce: nonEmptyString(parsed.nonce, 'extradata.nonce', 128),
    orderId: nonEmptyString(parsed.order_id, 'extradata.order_id', 128),
    storeId: nonEmptyString(parsed.store_id, 'extradata.store_id', 128),
  };
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  if (
    !uuidPattern.test(identity.attemptId) ||
    !uuidPattern.test(identity.orderId) ||
    !uuidPattern.test(identity.storeId) ||
    !/^[0-9a-f]{64}$/u.test(identity.nonce)
  ) {
    throw new ProviderIntegrationError('INVALID_RESPONSE', false, 'Invalid extradata identity');
  }
  return identity;
}

function occurredAt(value: unknown, now: number): Date | undefined {
  if (value === undefined) return undefined;
  const timestamp = safeInteger(value, 'transTime');
  if (timestamp <= 0 || timestamp > now + 86_400_000) {
    throw new ProviderIntegrationError('INVALID_RESPONSE', false, 'Invalid transaction time');
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    throw new ProviderIntegrationError('INVALID_RESPONSE', false, 'Invalid transaction time');
  }
  return date;
}

function parseJson(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProviderIntegrationError('INVALID_RESPONSE', true, 'Provider returned invalid JSON');
  }
  if (!isRecord(parsed)) {
    throw new ProviderIntegrationError('INVALID_RESPONSE', true, 'Provider returned invalid JSON');
  }
  return parsed;
}

async function readResponseText(response: Response, limitBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > limitBytes) {
        try {
          await reader.cancel();
        } catch {
          // The size violation remains authoritative even if cancellation fails.
        }
        throw new ProviderIntegrationError(
          'INVALID_RESPONSE',
          true,
          'Zalo Checkout response is too large',
        );
      }
      chunks.push(Buffer.from(chunk.value));
    }
  } catch (error) {
    if (error instanceof ProviderIntegrationError) throw error;
    throw new ProviderIntegrationError(
      'INVALID_RESPONSE',
      true,
      'Zalo Checkout response is unreadable',
    );
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

function stableNonce(input: { attemptId: string; orderId: string; storeId: string }): string {
  return createHash('sha256')
    .update(`${input.storeId}\u0000${input.orderId}\u0000${input.attemptId}`, 'utf8')
    .digest('hex');
}

export function inspectZaloCheckoutCallbackRoute(rawBody: Uint8Array): ZaloCheckoutCallbackRoute {
  if (rawBody.byteLength > ZALO_CHECKOUT_CALLBACK_MAX_BYTES) {
    throw new ProviderIntegrationError('INVALID_REQUEST', false, 'Callback body is too large');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(rawBody).toString('utf8'));
  } catch {
    throw new ProviderIntegrationError('INVALID_REQUEST', false, 'Callback body is invalid JSON');
  }
  if (!isRecord(parsed) || !isRecord(parsed.data)) {
    throw new ProviderIntegrationError('INVALID_REQUEST', false, 'Callback shape is invalid');
  }
  const app = nonEmptyString(parsed.data.appId, 'appId', 128);
  const method = nonEmptyString(parsed.data.method, 'method', 64);
  if (method !== 'ZALOPAY_SANDBOX' && method !== 'ZALOPAY') {
    throw new ProviderIntegrationError('INVALID_REQUEST', false, 'Callback method is invalid');
  }
  return { appId: app, method };
}

export class ZaloCheckoutPaymentProvider implements PaymentProvider {
  public readonly code = ZALO_CHECKOUT_PAYMENT_PROVIDER_CODE;
  public readonly environment: 'SANDBOX' | 'PRODUCTION';
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #responseLimitBytes: number;
  readonly #requestTimeoutMs: number;
  readonly #statusEndpoint: URL;
  readonly #refundCreateEndpoint: URL;
  readonly #refundStatusEndpoint: URL;
  readonly #allowedStatusOrigins: ReadonlySet<string>;

  public constructor(private readonly options: ZaloCheckoutPaymentProviderOptions) {
    if (
      !options.appId ||
      !options.privateKeySecretRef ||
      !options.resolveSecret ||
      !options.storeId
    ) {
      throw new ProviderIntegrationError(
        'CONFIGURATION',
        false,
        'Zalo Checkout configuration is incomplete',
      );
    }
    this.environment = options.environment;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#responseLimitBytes = options.responseLimitBytes ?? ZALO_CHECKOUT_CALLBACK_MAX_BYTES;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
    if (
      !Number.isInteger(this.#responseLimitBytes) ||
      this.#responseLimitBytes < 1_024 ||
      !Number.isInteger(this.#requestTimeoutMs) ||
      this.#requestTimeoutMs < 500
    ) {
      throw new ProviderIntegrationError(
        'CONFIGURATION',
        false,
        'Zalo Checkout HTTP limits are invalid',
      );
    }
    try {
      this.#statusEndpoint = new URL(options.statusEndpoint ?? ZALO_CHECKOUT_STATUS_ENDPOINT);
      this.#refundCreateEndpoint = new URL(
        options.refundCreateEndpoint ?? ZALO_CHECKOUT_REFUND_CREATE_ENDPOINT,
      );
      this.#refundStatusEndpoint = new URL(
        options.refundStatusEndpoint ?? ZALO_CHECKOUT_REFUND_STATUS_ENDPOINT,
      );
    } catch {
      throw new ProviderIntegrationError(
        'CONFIGURATION',
        false,
        'Zalo Checkout status endpoint is invalid',
      );
    }
    const allowed = new Set(options.allowedStatusOrigins ?? [this.#statusEndpoint.origin]);
    for (const origin of allowed) {
      let parsed: URL;
      try {
        parsed = new URL(origin);
      } catch {
        throw new ProviderIntegrationError(
          'CONFIGURATION',
          false,
          'Zalo Checkout origin is invalid',
        );
      }
      if (parsed.protocol !== 'https:') {
        throw new ProviderIntegrationError(
          'CONFIGURATION',
          false,
          'Zalo Checkout origin must use HTTPS',
        );
      }
    }
    if (
      [this.#statusEndpoint, this.#refundCreateEndpoint, this.#refundStatusEndpoint].some(
        (endpoint) => endpoint.protocol !== 'https:' || !allowed.has(endpoint.origin),
      )
    ) {
      throw new ProviderIntegrationError(
        'CONFIGURATION',
        false,
        'Zalo Checkout endpoint is not allowlisted',
      );
    }
    this.#allowedStatusOrigins = allowed;
  }

  public async createPayment(input: Parameters<PaymentProvider['createPayment']>[0]) {
    this.assertCreateInput(input);
    const privateKey = await this.privateKey();
    const extraData = JSON.stringify({
      attempt_id: input.attemptId,
      nonce: stableNonce(input),
      order_id: input.orderId,
      store_id: input.storeId,
    });
    const method = zaloPayCheckoutMethodJson(this.environment);
    const item = input.items.map((line) => ({ amount: line.amountVnd, id: line.skuCode }));
    const itemsJson = JSON.stringify(item);
    const macData = buildZaloCheckoutCreateOrderMacData({
      amountVnd: input.amountVnd,
      description: input.description,
      extraDataJson: extraData,
      itemsJson,
      methodJson: method,
    });
    return {
      launchAction: {
        expiresAt: input.expiresAt,
        kind: 'ZALO_CHECKOUT_CREATE_ORDER' as const,
        payload: {
          amount: input.amountVnd,
          desc: input.description,
          extradata: extraData,
          item,
          mac: createHmac('sha256', privateKey).update(macData, 'utf8').digest('hex'),
          method,
        },
      },
      providerStatus: 'CHECKOUT_LAUNCH_READY',
    };
  }

  public async queryPayment(input: {
    providerOrderId: string;
    storeId: string;
  }): Promise<PaymentProviderFact> {
    if (input.storeId !== this.options.storeId) {
      throw new ProviderIntegrationError(
        'REJECTED',
        false,
        'Payment query belongs to another store',
      );
    }
    const privateKey = await this.privateKey();
    const macData = `appId=${this.options.appId}&orderId=${input.providerOrderId}&privateKey=${privateKey}`;
    const mac = createHmac('sha256', privateKey).update(macData, 'utf8').digest('hex');
    const url = new URL(this.#statusEndpoint.href);
    url.searchParams.set('orderId', input.providerOrderId);
    url.searchParams.set('appId', this.options.appId);
    url.searchParams.set('mac', mac);
    const response = await this.request(url);
    const status = this.parseOrderStatus(response, input.providerOrderId);
    const identity = decodeExtradata(response.extradata);
    if (identity.storeId !== input.storeId) {
      throw new ProviderIntegrationError(
        'REJECTED',
        false,
        'Provider order belongs to another store',
      );
    }
    return this.toFact(status, identity, input.providerOrderId);
  }

  public async parseCallback(
    callback: ProviderRawCallback,
  ): Promise<ProviderCallbackResult<PaymentProviderFact>> {
    const contentType = callback.headers['content-type']?.toLowerCase();
    if (!contentType?.startsWith('application/json')) {
      throw new ProviderIntegrationError(
        'INVALID_REQUEST',
        false,
        'Callback content type is invalid',
      );
    }
    if (callback.rawBody.byteLength > this.#responseLimitBytes) {
      throw new ProviderIntegrationError('INVALID_REQUEST', false, 'Callback body is too large');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(callback.rawBody).toString('utf8'));
    } catch {
      throw new ProviderIntegrationError('INVALID_REQUEST', false, 'Callback body is invalid JSON');
    }
    if (!isRecord(parsed) || !isRecord(parsed.data)) {
      throw new ProviderIntegrationError('INVALID_REQUEST', false, 'Callback shape is invalid');
    }
    const mac = nonEmptyString(parsed.mac, 'mac', 256);
    const overallMac = nonEmptyString(parsed.overallMac, 'overallMac', 256);
    const data = this.parseCallbackData(parsed.data);
    const privateKey = await this.privateKey();
    const callbackMacData = buildZaloCheckoutCallbackMacData({
      amountVnd: data.amount,
      appId: data.appId,
      description: data.description,
      message: data.message,
      orderId: data.orderId,
      resultCode: data.resultCode,
      transactionId: data.transId,
    });
    const expectedMac = createHmac('sha256', privateKey)
      .update(callbackMacData, 'utf8')
      .digest('hex');
    if (!equalHex(mac.toLowerCase(), expectedMac)) {
      throw new ProviderIntegrationError('AUTHENTICATION', false, 'Callback MAC is invalid');
    }
    const overallData = canonicalizeZaloCheckoutOverallMacFields(parsed.data);
    const expectedOverallMac = createHmac('sha256', privateKey)
      .update(overallData, 'utf8')
      .digest('hex');
    if (!equalHex(overallMac.toLowerCase(), expectedOverallMac)) {
      throw new ProviderIntegrationError(
        'AUTHENTICATION',
        false,
        'Callback overall MAC is invalid',
      );
    }
    if (
      data.appId !== this.options.appId ||
      data.method !== zaloPayCheckoutMethod(this.environment)
    ) {
      throw new ProviderIntegrationError('REJECTED', false, 'Callback app or method is invalid');
    }
    const identity = decodeExtradata(data.extradata);
    if (identity.storeId !== this.options.storeId) {
      throw new ProviderIntegrationError('REJECTED', false, 'Callback belongs to another store');
    }
    const fact = this.toFact(data, identity, data.orderId);
    return {
      externalEventId: `zc:${createHash('sha256').update(overallData, 'utf8').digest('hex')}`,
      fact,
      trust: 'AUTHENTICATED_FACT',
    };
  }

  public async createRefund(
    input: Parameters<PaymentProvider['createRefund']>[0],
  ): Promise<RefundProviderFact> {
    this.assertRefundInput(input);
    const privateKey = await this.privateKey();
    const macData = buildZaloCheckoutCreateRefundMacData({
      amountVnd: input.amountVnd,
      appId: this.options.appId,
      description: input.description,
      privateKey,
      transactionId: input.paymentProviderTransactionId,
    });
    const body = await this.requestRefund(
      this.#refundCreateEndpoint,
      {
        body: JSON.stringify({
          amount: input.amountVnd,
          appId: this.options.appId,
          description: input.description,
          mac: createHmac('sha256', privateKey).update(macData, 'utf8').digest('hex'),
          transId: input.paymentProviderTransactionId,
        }),
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        method: 'POST',
      },
      false,
    );
    const returnCode = safeInteger(body.returnCode, 'returnCode');
    const status = mapZaloCheckoutCreateRefundResult(returnCode);
    const providerRefundId =
      body.refundId === undefined ? undefined : nonEmptyString(body.refundId, 'refundId', 160);
    if (status !== 'FAILED' && !providerRefundId) {
      throw new ProviderIntegrationError(
        'INVALID_RESPONSE',
        false,
        'Accepted refund has no refund id',
      );
    }
    return {
      amountVnd: input.amountVnd,
      ...(providerRefundId ? { providerRefundId } : {}),
      providerStatus: `ZALO_CHECKOUT_${returnCode}`,
      status,
    };
  }

  public async queryRefund(
    input: Parameters<PaymentProvider['queryRefund']>[0],
  ): Promise<RefundProviderFact> {
    if (
      input.storeId !== this.options.storeId ||
      !Number.isSafeInteger(input.amountVnd) ||
      input.amountVnd <= 0 ||
      !input.providerRefundId ||
      input.providerRefundId.length > 160
    ) {
      throw new ProviderIntegrationError('INVALID_REQUEST', false, 'Refund query is invalid');
    }
    const privateKey = await this.privateKey();
    const macData = buildZaloCheckoutQueryRefundMacData({
      appId: this.options.appId,
      privateKey,
      refundId: input.providerRefundId,
    });
    const url = new URL(this.#refundStatusEndpoint.href);
    url.searchParams.set('appId', this.options.appId);
    url.searchParams.set('refundId', input.providerRefundId);
    url.searchParams.set(
      'mac',
      createHmac('sha256', privateKey).update(macData, 'utf8').digest('hex'),
    );
    const body = await this.requestRefund(url, { method: 'GET' }, true);
    const returnCode = safeInteger(body.returnCode, 'returnCode');
    return {
      amountVnd: input.amountVnd,
      providerRefundId: input.providerRefundId,
      providerStatus: `ZALO_CHECKOUT_${returnCode}`,
      status: mapZaloCheckoutRefundStatusResult(returnCode),
    };
  }

  private async privateKey(): Promise<string> {
    let value: string;
    try {
      value = await this.options.resolveSecret.resolve(this.options.privateKeySecretRef);
    } catch {
      throw new ProviderIntegrationError(
        'CONFIGURATION',
        false,
        'Zalo Checkout secret is unavailable',
      );
    }
    if (typeof value !== 'string' || value.length < 16 || value.length > 4_096) {
      throw new ProviderIntegrationError('CONFIGURATION', false, 'Zalo Checkout secret is invalid');
    }
    return value;
  }

  private async request(url: URL): Promise<OrderStatusResponse> {
    if (!this.#allowedStatusOrigins.has(url.origin) || url.protocol !== 'https:') {
      throw new ProviderIntegrationError(
        'CONFIGURATION',
        false,
        'Zalo Checkout request origin is invalid',
      );
    }
    let response: Response;
    try {
      response = await this.#fetch(url, {
        headers: { accept: 'application/json' },
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
      });
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new ProviderIntegrationError(
        timedOut ? 'TIMEOUT' : 'UPSTREAM_UNAVAILABLE',
        true,
        'Zalo Checkout status request failed',
      );
    }
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(contentLength) && contentLength > this.#responseLimitBytes) {
      throw new ProviderIntegrationError(
        'INVALID_RESPONSE',
        true,
        'Zalo Checkout response is too large',
      );
    }
    const text = await readResponseText(response, this.#responseLimitBytes);
    if (response.status === 429) {
      throw new ProviderIntegrationError('RATE_LIMITED', true, 'Zalo Checkout rate limit');
    }
    if (!response.ok) {
      throw new ProviderIntegrationError(
        response.status >= 500 ? 'UPSTREAM_UNAVAILABLE' : 'REJECTED',
        response.status >= 500,
        'Zalo Checkout status request was rejected',
      );
    }
    const contentType = response.headers.get('content-type')?.toLowerCase();
    if (!contentType?.startsWith('application/json')) {
      throw new ProviderIntegrationError(
        'INVALID_RESPONSE',
        true,
        'Zalo Checkout response content type is invalid',
      );
    }
    const body = parseJson(text);
    return {
      amount: safeAmount(body.amount),
      ...(body.extradata === undefined
        ? {}
        : { extradata: nonEmptyString(body.extradata, 'extradata', 8_192) }),
      ...(typeof body.isProcessing === 'boolean' ? { isProcessing: body.isProcessing } : {}),
      ...(body.merchantTransId === undefined
        ? {}
        : { merchantTransId: nonEmptyString(body.merchantTransId, 'merchantTransId', 256) }),
      ...(body.method === undefined ? {} : { method: nonEmptyString(body.method, 'method', 64) }),
      returnCode: safeInteger(body.returnCode, 'returnCode'),
      ...(body.returnMessage === undefined
        ? {}
        : { returnMessage: nonEmptyString(body.returnMessage, 'returnMessage', 1_024) }),
      ...(body.transId === undefined
        ? {}
        : { transId: nonEmptyString(body.transId, 'transId', 256) }),
      ...(body.transTime === undefined
        ? {}
        : { transTime: safeInteger(body.transTime, 'transTime') }),
    };
  }

  private async requestRefund(
    url: URL,
    init: Pick<RequestInit, 'body' | 'headers' | 'method'>,
    safeToRetry: boolean,
  ): Promise<Record<string, unknown>> {
    if (!this.#allowedStatusOrigins.has(url.origin) || url.protocol !== 'https:') {
      throw new ProviderIntegrationError(
        'CONFIGURATION',
        false,
        'Zalo Checkout refund origin is invalid',
      );
    }
    let response: Response;
    try {
      response = await this.#fetch(url, {
        ...init,
        headers: { accept: 'application/json', ...init.headers },
        redirect: 'error',
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
      });
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new ProviderIntegrationError(
        timedOut ? 'TIMEOUT' : 'UPSTREAM_UNAVAILABLE',
        safeToRetry,
        'Zalo Checkout refund request failed',
      );
    }
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(contentLength) && contentLength > this.#responseLimitBytes) {
      throw new ProviderIntegrationError(
        'INVALID_RESPONSE',
        safeToRetry,
        'Zalo Checkout refund response is too large',
      );
    }
    const text = await readResponseText(response, this.#responseLimitBytes);
    if (response.status === 429) {
      throw new ProviderIntegrationError('RATE_LIMITED', safeToRetry, 'Zalo Checkout rate limit');
    }
    if (!response.ok) {
      throw new ProviderIntegrationError(
        response.status >= 500 ? 'UPSTREAM_UNAVAILABLE' : 'REJECTED',
        safeToRetry && response.status >= 500,
        'Zalo Checkout refund request was rejected',
      );
    }
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
      throw new ProviderIntegrationError(
        'INVALID_RESPONSE',
        safeToRetry,
        'Zalo Checkout refund response content type is invalid',
      );
    }
    return parseJson(text);
  }

  private parseOrderStatus(response: OrderStatusResponse, providerOrderId: string): CallbackData {
    const method = nonEmptyString(response.method, 'method', 64);
    return {
      amount: response.amount,
      appId: this.options.appId,
      description: response.returnMessage ?? 'Zalo Checkout payment',
      ...(response.extradata === undefined ? {} : { extradata: response.extradata }),
      ...(response.isProcessing === undefined ? {} : { isProcessing: response.isProcessing }),
      message: response.returnMessage ?? '',
      ...(response.merchantTransId === undefined
        ? {}
        : { merchantTransId: response.merchantTransId }),
      method,
      orderId: providerOrderId,
      resultCode: response.returnCode,
      transId: response.transId ?? '',
      ...(response.transTime === undefined ? {} : { transTime: response.transTime }),
    };
  }

  private parseCallbackData(value: Record<string, unknown>): CallbackData {
    return {
      amount: safeAmount(value.amount),
      appId: nonEmptyString(value.appId, 'appId', 128),
      description: typeof value.description === 'string' ? value.description : '',
      ...(value.extradata === undefined
        ? {}
        : { extradata: nonEmptyString(value.extradata, 'extradata', 8_192) }),
      ...(typeof value.isProcessing === 'boolean' ? { isProcessing: value.isProcessing } : {}),
      message: typeof value.message === 'string' ? value.message : '',
      ...(value.merchantTransId === undefined
        ? {}
        : { merchantTransId: nonEmptyString(value.merchantTransId, 'merchantTransId', 256) }),
      ...(value.method === undefined ? {} : { method: nonEmptyString(value.method, 'method', 64) }),
      orderId: nonEmptyString(value.orderId, 'orderId', 256),
      ...(value.paymentChannel === undefined
        ? {}
        : { paymentChannel: nonEmptyString(value.paymentChannel, 'paymentChannel', 64) }),
      resultCode: safeInteger(value.resultCode, 'resultCode'),
      transId: nonEmptyString(value.transId, 'transId', 256),
      ...(value.transTime === undefined
        ? {}
        : { transTime: safeInteger(value.transTime, 'transTime') }),
    };
  }

  private toFact(
    data: CallbackData,
    identity: CheckoutIdentity,
    providerOrderId: string,
  ): PaymentProviderFact {
    if (identity.nonce !== stableNonce(identity)) {
      throw new ProviderIntegrationError('REJECTED', false, 'Checkout nonce is invalid');
    }
    if (data.method !== undefined && data.method !== zaloPayCheckoutMethod(this.environment)) {
      throw new ProviderIntegrationError('REJECTED', false, 'Checkout method is invalid');
    }
    const status = mapZaloCheckoutPaymentResult(data.resultCode, data.isProcessing);
    if (status === 'SUCCEEDED' && !data.transId) {
      throw new ProviderIntegrationError(
        'INVALID_RESPONSE',
        false,
        'Successful payment has no transaction id',
      );
    }
    const providerOccurredAt = occurredAt(data.transTime, this.#now());
    return {
      amountVnd: data.amount,
      attemptId: identity.attemptId,
      currency: 'VND',
      ...(providerOccurredAt ? { occurredAt: providerOccurredAt } : {}),
      orderId: identity.orderId,
      providerOrderId,
      providerStatus: `ZALO_CHECKOUT_${data.resultCode}`,
      ...(status === 'SUCCEEDED' ? { providerTransactionId: data.transId } : {}),
      status,
      storeId: identity.storeId,
    };
  }

  private assertCreateInput(input: Parameters<PaymentProvider['createPayment']>[0]): void {
    if (
      input.currency !== 'VND' ||
      input.storeId !== this.options.storeId ||
      !Number.isSafeInteger(input.amountVnd) ||
      input.amountVnd <= 0 ||
      input.expiresAt.getTime() <= this.#now() ||
      input.items.length === 0 ||
      input.description.length === 0 ||
      input.description.length > 1_024 ||
      input.items.some(
        (item) =>
          !item.skuCode ||
          !Number.isSafeInteger(item.amountVnd) ||
          item.amountVnd < 0 ||
          !Number.isSafeInteger(item.quantity) ||
          item.quantity < 1,
      )
    ) {
      throw new ProviderIntegrationError(
        'INVALID_REQUEST',
        false,
        'Zalo Checkout create input is invalid',
      );
    }
  }

  private assertRefundInput(input: Parameters<PaymentProvider['createRefund']>[0]): void {
    if (
      input.storeId !== this.options.storeId ||
      !Number.isSafeInteger(input.amountVnd) ||
      input.amountVnd <= 0 ||
      !input.description ||
      input.description.length > 500 ||
      !input.paymentProviderTransactionId ||
      input.paymentProviderTransactionId.length > 160 ||
      !input.publicRefundNumber ||
      !input.refundId
    ) {
      throw new ProviderIntegrationError('INVALID_REQUEST', false, 'Refund input is invalid');
    }
  }
}
