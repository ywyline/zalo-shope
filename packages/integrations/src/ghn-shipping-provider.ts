import { createHash } from 'node:crypto';

import {
  GHN_CALLBACK_TRUST,
  GHN_ENDPOINT_PATHS,
  GHN_LABEL_PATH,
  ghnOrigin,
  ghnServiceCode,
  mapGhnShippingStatus,
  parseGhnServiceCode,
} from './ghn-contract';
import {
  ProviderIntegrationError,
  type ProviderEnvironment,
  type ProviderRawCallback,
} from './provider-contract';
import type { ShippingAddress, ShippingParcel, ShippingProvider } from './shipping-provider';
import type { SecretReferenceResolver } from './zalo-checkout-payment-provider';

export const GHN_SHIPPING_PROVIDER_CODE = 'GHN';
export const GHN_RESPONSE_MAX_BYTES = 128 * 1_024;
export const GHN_CALLBACK_MAX_BYTES = 32 * 1_024;

export type GhnCallbackRoute = Readonly<{
  clientOrderCode?: string;
  providerShipmentId?: string;
  providerStatus?: string;
  shopId: string;
}>;

export type GhnShippingProviderOptions = Readonly<{
  environment: ProviderEnvironment;
  fetch?: typeof fetch;
  now?: () => number;
  requestTimeoutMs?: number;
  responseLimitBytes?: number;
  resolveSecret: SecretReferenceResolver;
  shopId: string;
  storeId: string;
  tokenSecretRef: string;
}>;

type JsonRecord = Record<string, unknown>;

function record(value: unknown, field = 'response'): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProviderIntegrationError('INVALID_RESPONSE', false, `GHN ${field} is invalid`);
  }
  return value as JsonRecord;
}

function callbackText(value: unknown, field: string, max: number): string {
  if (
    (typeof value !== 'string' && typeof value !== 'number') ||
    String(value).trim().length === 0 ||
    String(value).length > max
  ) {
    throw new ProviderIntegrationError(
      'INVALID_REQUEST',
      false,
      `GHN callback ${field} is invalid`,
    );
  }
  return String(value).trim();
}

export function inspectGhnCallbackRoute(rawBody: Uint8Array): GhnCallbackRoute {
  if (rawBody.byteLength > GHN_CALLBACK_MAX_BYTES) {
    throw new ProviderIntegrationError('INVALID_REQUEST', false, 'GHN callback is too large');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(rawBody).toString('utf8'));
  } catch {
    throw new ProviderIntegrationError('INVALID_REQUEST', false, 'GHN callback is invalid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ProviderIntegrationError('INVALID_REQUEST', false, 'GHN callback shape is invalid');
  }
  const body = parsed as JsonRecord;
  const shopId = callbackText(body.ShopID ?? body.ShopId ?? body.shop_id, 'shop_id', 64);
  if (!/^\d{1,20}$/u.test(shopId)) {
    throw new ProviderIntegrationError('INVALID_REQUEST', false, 'GHN callback shop_id is invalid');
  }
  const providerShipmentId = body.OrderCode ?? body.order_code;
  const clientOrderCode = body.ClientOrderCode ?? body.client_order_code;
  if (providerShipmentId === undefined && clientOrderCode === undefined) {
    throw new ProviderIntegrationError(
      'INVALID_REQUEST',
      false,
      'GHN callback has no shipment identity',
    );
  }
  const providerStatus = body.Status ?? body.status;
  return {
    ...(clientOrderCode === undefined
      ? {}
      : { clientOrderCode: callbackText(clientOrderCode, 'client_order_code', 160) }),
    ...(providerShipmentId === undefined
      ? {}
      : { providerShipmentId: callbackText(providerShipmentId, 'order_code', 160) }),
    ...(providerStatus === undefined
      ? {}
      : { providerStatus: callbackText(providerStatus, 'status', 64).toLowerCase() }),
    shopId,
  };
}

function text(value: unknown, field: string, max = 1_024): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new ProviderIntegrationError('INVALID_RESPONSE', false, `GHN ${field} is invalid`);
  }
  return value.trim();
}

function integer(value: unknown, field: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new ProviderIntegrationError('INVALID_RESPONSE', false, `GHN ${field} is invalid`);
  }
  return value;
}

function optionalInteger(value: unknown, field: string): number {
  return value === undefined ? 0 : integer(value, field);
}

function sumFees(values: readonly number[]): number {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total)) {
    throw new ProviderIntegrationError('INVALID_RESPONSE', false, 'GHN fee total is invalid');
  }
  return total;
}

function districtId(value: string): number {
  if (!/^\d{1,10}$/u.test(value)) {
    throw new ProviderIntegrationError('INVALID_REQUEST', false, 'GHN district code is invalid');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ProviderIntegrationError('INVALID_REQUEST', false, 'GHN district code is invalid');
  }
  return parsed;
}

function validAddress(value: ShippingAddress): boolean {
  return (
    value.addressLine.trim().length >= 3 &&
    value.addressLine.length <= 500 &&
    value.name.trim().length > 0 &&
    value.name.length <= 160 &&
    /^\+\d{8,15}$/u.test(value.phoneE164) &&
    value.wardCode.trim().length > 0 &&
    value.wardCode.length <= 32
  );
}

function assertParcel(value: ShippingParcel): void {
  if (
    !Number.isSafeInteger(value.weightGrams) ||
    value.weightGrams <= 0 ||
    value.weightGrams > 1_600_000 ||
    [value.heightCm, value.lengthCm, value.widthCm].some(
      (dimension) => !Number.isSafeInteger(dimension) || dimension <= 0 || dimension > 200,
    )
  ) {
    throw new ProviderIntegrationError('INVALID_REQUEST', false, 'GHN parcel is invalid');
  }
}

function providerDate(value: unknown, field: string): Date {
  let milliseconds: number | undefined;
  if (typeof value === 'string' && value.length <= 64) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) milliseconds = parsed;
  }
  if (
    milliseconds === undefined &&
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0
  ) {
    milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
  }
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) {
    throw new ProviderIntegrationError('INVALID_RESPONSE', false, `GHN ${field} is invalid`);
  }
  return new Date(milliseconds);
}

async function readResponseText(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > limit) {
    throw new ProviderIntegrationError('INVALID_RESPONSE', true, 'GHN response is too large');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > limit) {
        try {
          await reader.cancel();
        } catch {
          // The size violation remains authoritative if cancellation fails.
        }
        throw new ProviderIntegrationError('INVALID_RESPONSE', true, 'GHN response is too large');
      }
      chunks.push(Buffer.from(chunk.value));
    }
  } catch (error) {
    if (error instanceof ProviderIntegrationError) throw error;
    throw new ProviderIntegrationError('INVALID_RESPONSE', true, 'GHN response is unreadable');
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

export class GhnShippingProvider implements ShippingProvider {
  public readonly code = GHN_SHIPPING_PROVIDER_CODE;
  public readonly environment: ProviderEnvironment;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #origin: string;
  readonly #requestTimeoutMs: number;
  readonly #responseLimitBytes: number;

  public constructor(private readonly options: GhnShippingProviderOptions) {
    if (
      !options.storeId ||
      !/^\d{1,20}$/u.test(options.shopId) ||
      !options.tokenSecretRef ||
      !options.resolveSecret
    ) {
      throw new ProviderIntegrationError('CONFIGURATION', false, 'GHN configuration is incomplete');
    }
    this.environment = options.environment;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#origin = ghnOrigin(options.environment);
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
    this.#responseLimitBytes = options.responseLimitBytes ?? GHN_RESPONSE_MAX_BYTES;
    if (
      !Number.isSafeInteger(this.#requestTimeoutMs) ||
      this.#requestTimeoutMs < 500 ||
      !Number.isSafeInteger(this.#responseLimitBytes) ||
      this.#responseLimitBytes < 1_024
    ) {
      throw new ProviderIntegrationError('CONFIGURATION', false, 'GHN HTTP limits are invalid');
    }
  }

  public async listServices(input: Parameters<ShippingProvider['listServices']>[0]) {
    this.assertStore(input.storeId);
    const data = await this.post(GHN_ENDPOINT_PATHS.availableServices, {
      from_district: districtId(input.origin.districtCode),
      shop_id: Number(this.options.shopId),
      to_district: districtId(input.destination.districtCode),
    });
    if (!Array.isArray(data)) {
      throw new ProviderIntegrationError('INVALID_RESPONSE', false, 'GHN services are invalid');
    }
    return data.map((value) => {
      const service = record(value, 'service');
      return {
        code: ghnServiceCode(
          integer(service.service_id, 'service_id', 1),
          integer(service.service_type_id, 'service_type_id', 1),
        ),
        name: text(service.short_name ?? service.name, 'service name', 160),
      };
    });
  }

  public async quote(input: Parameters<ShippingProvider['quote']>[0]) {
    this.assertStore(input.storeId);
    this.assertQuoteInput(input);
    const service = this.service(input.serviceCode);
    const request = {
      cod_value: input.codAmountVnd,
      from_district_id: districtId(input.origin.districtCode),
      from_ward_code: input.origin.wardCode,
      height: input.parcel.heightCm,
      insurance_value: 0,
      length: input.parcel.lengthCm,
      service_id: service.serviceId,
      service_type_id: service.serviceTypeId,
      to_district_id: districtId(input.destination.districtCode),
      to_ward_code: input.destination.wardCode,
      weight: input.parcel.weightGrams,
      width: input.parcel.widthCm,
    };
    const fee = record(await this.post(GHN_ENDPOINT_PATHS.quote, request), 'quote');
    const lead = record(
      await this.post(GHN_ENDPOINT_PATHS.leadTime, {
        from_district_id: request.from_district_id,
        from_ward_code: request.from_ward_code,
        service_id: request.service_id,
        to_district_id: request.to_district_id,
        to_ward_code: request.to_ward_code,
      }),
      'lead time',
    );
    const baseFeeVnd = integer(fee.service_fee, 'service fee');
    const insuranceFeeVnd = optionalInteger(fee.insurance_fee, 'insurance fee');
    const codFeeVnd = optionalInteger(fee.cod_fee, 'COD fee');
    const remoteFeeVnd = sumFees([
      optionalInteger(fee.pick_remote_areas_fee, 'pickup remote area fee'),
      optionalInteger(fee.deliver_remote_areas_fee, 'delivery remote area fee'),
    ]);
    const otherFeeVnd = sumFees([
      optionalInteger(fee.pick_station_fee, 'pickup station fee'),
      optionalInteger(fee.r2s_fee, 'return-to-sender fee'),
      optionalInteger(fee.return_again, 'return-again fee'),
      optionalInteger(fee.document_return, 'document return fee'),
      optionalInteger(fee.double_check, 'double-check fee'),
      optionalInteger(fee.cod_failed_fee, 'failed COD fee'),
    ]);
    const couponValueVnd = optionalInteger(fee.coupon_value, 'coupon value');
    const totalFeeVnd = integer(fee.total, 'total fee');
    if (
      couponValueVnd !== 0 ||
      totalFeeVnd !== sumFees([baseFeeVnd, insuranceFeeVnd, codFeeVnd, remoteFeeVnd, otherFeeVnd])
    ) {
      throw new ProviderIntegrationError(
        'INVALID_RESPONSE',
        false,
        'GHN fee breakdown is inconsistent',
      );
    }
    return {
      baseFeeVnd,
      codFeeVnd,
      estimatedDeliveryAt: providerDate(lead.leadtime, 'lead time'),
      expiresAt: new Date(this.#now() + 5 * 60 * 1_000),
      insuranceFeeVnd,
      otherFeeVnd,
      providerServiceId: service.serviceId,
      providerServiceTypeId: service.serviceTypeId,
      remoteFeeVnd,
      serviceCode: input.serviceCode,
      totalFeeVnd,
    };
  }

  public async createShipment(input: Parameters<ShippingProvider['createShipment']>[0]) {
    this.assertStore(input.storeId);
    this.assertShipmentInput(input);
    const service = this.service(input.serviceCode);
    const data = record(
      await this.post(GHN_ENDPOINT_PATHS.createShipment, {
        client_order_code: input.clientOrderCode,
        cod_amount: input.codAmountVnd,
        content: input.items
          .map((item) => item.name)
          .join(', ')
          .slice(0, 2_000),
        height: input.parcel.heightCm,
        insurance_value: 0,
        items: input.items.map((item) => ({
          code: item.skuCode,
          name: item.name,
          quantity: item.quantity,
        })),
        length: input.parcel.lengthCm,
        payment_type_id: 2,
        required_note:
          input.inspectionPolicy === 'NO_INSPECTION' ? 'KHONGCHOXEMHANG' : 'CHOXEMHANGKHONGTHU',
        return_address: input.origin.addressLine,
        return_district_id: districtId(input.origin.districtCode),
        return_phone: input.origin.phoneE164,
        return_ward_code: input.origin.wardCode,
        service_id: service.serviceId,
        service_type_id: service.serviceTypeId,
        to_address: input.destination.addressLine,
        to_district_id: districtId(input.destination.districtCode),
        to_name: input.destination.name,
        to_phone: input.destination.phoneE164,
        to_ward_code: input.destination.wardCode,
        weight: input.parcel.weightGrams,
        width: input.parcel.widthCm,
      }),
      'create shipment',
    );
    return {
      clientOrderCode: input.clientOrderCode,
      occurredAt: providerDate(data.created_date, 'created date'),
      providerShipmentId: text(data.order_code, 'order_code', 160),
      providerStatus: 'ready_to_pick',
      status: 'PENDING_PICKUP' as const,
    };
  }

  public async cancelShipment(input: Parameters<ShippingProvider['cancelShipment']>[0]) {
    this.assertStore(input.storeId);
    if (!input.operationId || !input.providerShipmentId) {
      throw new ProviderIntegrationError('INVALID_REQUEST', false, 'GHN cancellation is invalid');
    }
    const data = await this.post(GHN_ENDPOINT_PATHS.cancelShipment, {
      order_codes: [input.providerShipmentId],
    });
    if (!Array.isArray(data) || data.length !== 1) {
      throw new ProviderIntegrationError('INVALID_RESPONSE', false, 'GHN cancellation is invalid');
    }
    const result = record(data[0], 'cancellation');
    if (text(result.order_code, 'order_code', 160) !== input.providerShipmentId) {
      throw new ProviderIntegrationError(
        'INVALID_RESPONSE',
        false,
        'GHN cancellation identity differs',
      );
    }
    if (result.result !== true) {
      throw new ProviderIntegrationError('REJECTED', false, 'GHN cancellation was rejected');
    }
    return {
      occurredAt: new Date(this.#now()),
      providerShipmentId: input.providerShipmentId,
      providerStatus: 'cancel',
      status: 'CANCELLED' as const,
    };
  }

  public async queryShipment(input: Parameters<ShippingProvider['queryShipment']>[0]) {
    this.assertStore(input.storeId);
    if (!input.providerShipmentId) {
      throw new ProviderIntegrationError(
        'INVALID_REQUEST',
        false,
        'GHN shipment reference is invalid',
      );
    }
    const data = record(
      await this.post(GHN_ENDPOINT_PATHS.queryShipment, { order_code: input.providerShipmentId }),
      'shipment',
    );
    const providerShipmentId = text(data.order_code, 'order_code', 160);
    if (providerShipmentId !== input.providerShipmentId) {
      throw new ProviderIntegrationError(
        'INVALID_RESPONSE',
        false,
        'GHN shipment identity differs',
      );
    }
    const providerStatus = text(data.status, 'status', 64).toLowerCase();
    const status = mapGhnShippingStatus(providerStatus);
    return {
      ...(data.client_order_code === undefined || data.client_order_code === null
        ? {}
        : { clientOrderCode: text(data.client_order_code, 'client_order_code', 160) }),
      occurredAt: providerDate(data.updated_date, 'updated date'),
      providerShipmentId,
      providerStatus,
      ...(status ? { status } : {}),
    };
  }

  public async getLabel(input: Parameters<ShippingProvider['getLabel']>[0]) {
    this.assertStore(input.storeId);
    if (input.format !== 'A5') {
      throw new ProviderIntegrationError('REJECTED', false, 'GHN label format is unavailable');
    }
    const data = record(
      await this.post(GHN_ENDPOINT_PATHS.labelToken, { order_codes: [input.providerShipmentId] }),
      'label',
    );
    const token = text(data.token, 'label token', 2_048);
    const url = new URL(GHN_LABEL_PATH, this.#origin);
    url.searchParams.set('token', token);
    return { expiresAt: new Date(this.#now() + 30 * 60 * 1_000), url: url.href };
  }

  public parseCallback(callback: ProviderRawCallback) {
    return Promise.resolve().then(() => {
      const contentType = callback.headers['content-type']?.toLowerCase();
      if (!contentType?.startsWith('application/json')) {
        throw new ProviderIntegrationError(
          'INVALID_REQUEST',
          false,
          'GHN callback content type is invalid',
        );
      }
      const route = inspectGhnCallbackRoute(callback.rawBody);
      if (route.shopId !== this.options.shopId) {
        throw new ProviderIntegrationError(
          'REJECTED',
          false,
          'GHN callback belongs to another shop',
        );
      }
      return {
        externalEventId: `ghn-hint:${createHash('sha256').update(callback.rawBody).digest('hex')}`,
        hint: route,
        trust: GHN_CALLBACK_TRUST,
      } as const;
    });
  }

  private assertStore(storeId: string): void {
    if (storeId !== this.options.storeId) {
      throw new ProviderIntegrationError('REJECTED', false, 'GHN request belongs to another store');
    }
  }

  private assertQuoteInput(input: Parameters<ShippingProvider['quote']>[0]): void {
    assertParcel(input.parcel);
    if (
      !validAddress(input.origin) ||
      !validAddress(input.destination) ||
      !Number.isSafeInteger(input.codAmountVnd) ||
      input.codAmountVnd < 0
    ) {
      throw new ProviderIntegrationError('INVALID_REQUEST', false, 'GHN quote is invalid');
    }
  }

  private assertShipmentInput(input: Parameters<ShippingProvider['createShipment']>[0]): void {
    this.assertQuoteInput(input);
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/u.test(input.clientOrderCode) ||
      !input.operationId ||
      input.items.length === 0 ||
      input.items.some(
        (item) =>
          item.name.trim().length === 0 ||
          item.name.length > 240 ||
          item.skuCode.length === 0 ||
          item.skuCode.length > 64 ||
          !Number.isSafeInteger(item.quantity) ||
          item.quantity <= 0,
      )
    ) {
      throw new ProviderIntegrationError('INVALID_REQUEST', false, 'GHN shipment is invalid');
    }
  }

  private service(code: string): { serviceId: number; serviceTypeId: number } {
    try {
      return parseGhnServiceCode(code);
    } catch {
      throw new ProviderIntegrationError('INVALID_REQUEST', false, 'GHN service code is invalid');
    }
  }

  private async token(): Promise<string> {
    let token: string;
    try {
      token = await this.options.resolveSecret.resolve(this.options.tokenSecretRef);
    } catch {
      throw new ProviderIntegrationError('CONFIGURATION', false, 'GHN secret is unavailable');
    }
    if (token.length < 8 || token.length > 4_096 || /[\r\n]/u.test(token)) {
      throw new ProviderIntegrationError('CONFIGURATION', false, 'GHN secret is invalid');
    }
    return token;
  }

  private async post(path: string, body: JsonRecord): Promise<unknown> {
    const allowedPaths: readonly string[] = Object.values(GHN_ENDPOINT_PATHS);
    if (!allowedPaths.includes(path)) {
      throw new ProviderIntegrationError('CONFIGURATION', false, 'GHN endpoint is not allowlisted');
    }
    const url = new URL(path, this.#origin);
    if (url.protocol !== 'https:' || url.origin !== this.#origin) {
      throw new ProviderIntegrationError('CONFIGURATION', false, 'GHN endpoint is invalid');
    }
    let response: Response;
    try {
      response = await this.#fetch(url, {
        body: JSON.stringify(body),
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          shopid: this.options.shopId,
          token: await this.token(),
        },
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
      });
    } catch (error) {
      if (error instanceof ProviderIntegrationError) throw error;
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new ProviderIntegrationError(
        timedOut ? 'TIMEOUT' : 'UPSTREAM_UNAVAILABLE',
        true,
        'GHN request failed',
      );
    }
    const value = await readResponseText(response, this.#responseLimitBytes);
    if (response.status === 429) {
      throw new ProviderIntegrationError('RATE_LIMITED', true, 'GHN rate limit');
    }
    if (!response.ok) {
      throw new ProviderIntegrationError(
        response.status >= 500 ? 'UPSTREAM_UNAVAILABLE' : 'REJECTED',
        response.status >= 500,
        'GHN request was rejected',
      );
    }
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
      throw new ProviderIntegrationError(
        'INVALID_RESPONSE',
        true,
        'GHN response content type is invalid',
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new ProviderIntegrationError('INVALID_RESPONSE', true, 'GHN response is invalid JSON');
    }
    const envelope = record(parsed);
    if (integer(envelope.code, 'response code') !== 200) {
      throw new ProviderIntegrationError('REJECTED', false, 'GHN operation was rejected');
    }
    if (!Object.hasOwn(envelope, 'data')) {
      throw new ProviderIntegrationError('INVALID_RESPONSE', false, 'GHN response has no data');
    }
    return envelope.data;
  }
}
