import type { ProviderEnvironment } from './provider-contract';
import type { PaymentProviderStatus, RefundProviderStatus } from './payment-provider';

export const ZALO_CHECKOUT_DOCUMENT_VERSION = '2026-06-15';

export const ZALO_CHECKOUT_ZALOPAY_METHODS = ['ZALOPAY_SANDBOX', 'ZALOPAY'] as const;

export type ZaloCheckoutZaloPayMethod = (typeof ZALO_CHECKOUT_ZALOPAY_METHODS)[number];

export function zaloPayCheckoutMethod(environment: ProviderEnvironment): ZaloCheckoutZaloPayMethod {
  return environment === 'SANDBOX' ? 'ZALOPAY_SANDBOX' : 'ZALOPAY';
}

export function zaloPayCheckoutMethodJson(environment: ProviderEnvironment): string {
  return JSON.stringify({ id: zaloPayCheckoutMethod(environment), isCustom: false });
}

function requireNonEmpty(value: string, field: string): string {
  if (value.length === 0) throw new RangeError(`${field} is required`);
  return value;
}

export function buildZaloCheckoutCreateOrderMacData(input: {
  amountVnd: number;
  description: string;
  extraDataJson: string;
  itemsJson: string;
  methodJson: string;
}): string {
  if (!Number.isSafeInteger(input.amountVnd) || input.amountVnd <= 0) {
    throw new RangeError('amountVnd must be a positive safe integer');
  }
  return [
    `amount=${input.amountVnd}`,
    `desc=${requireNonEmpty(input.description, 'description')}`,
    `extradata=${requireNonEmpty(input.extraDataJson, 'extraDataJson')}`,
    `item=${requireNonEmpty(input.itemsJson, 'itemsJson')}`,
    `method=${requireNonEmpty(input.methodJson, 'methodJson')}`,
  ].join('&');
}

export function buildZaloCheckoutCallbackMacData(input: {
  amountVnd: number;
  appId: string;
  description: string;
  message: string;
  orderId: string;
  resultCode: number;
  transactionId: string;
}): string {
  if (!Number.isSafeInteger(input.amountVnd) || input.amountVnd <= 0) {
    throw new RangeError('amountVnd must be a positive safe integer');
  }
  return [
    `appId=${requireNonEmpty(input.appId, 'appId')}`,
    `amount=${input.amountVnd}`,
    `description=${input.description}`,
    `orderId=${requireNonEmpty(input.orderId, 'orderId')}`,
    `message=${input.message}`,
    `resultCode=${input.resultCode}`,
    `transId=${requireNonEmpty(input.transactionId, 'transactionId')}`,
  ].join('&');
}

export function buildZaloCheckoutCreateRefundMacData(input: {
  amountVnd: number;
  appId: string;
  description: string;
  privateKey: string;
  transactionId: string;
}): string {
  if (!Number.isSafeInteger(input.amountVnd) || input.amountVnd <= 0) {
    throw new RangeError('amountVnd must be a positive safe integer');
  }
  return [
    `appId=${requireNonEmpty(input.appId, 'appId')}`,
    `transId=${requireNonEmpty(input.transactionId, 'transactionId')}`,
    `amount=${input.amountVnd}`,
    `description=${input.description}`,
    `privateKey=${requireNonEmpty(input.privateKey, 'privateKey')}`,
  ].join('&');
}

export function buildZaloCheckoutQueryRefundMacData(input: {
  appId: string;
  privateKey: string;
  refundId: string;
}): string {
  return [
    `appId=${requireNonEmpty(input.appId, 'appId')}`,
    `refundId=${requireNonEmpty(input.refundId, 'refundId')}`,
    `privateKey=${requireNonEmpty(input.privateKey, 'privateKey')}`,
  ].join('&');
}

export function canonicalizeZaloCheckoutOverallMacFields(
  fields: Readonly<Record<string, unknown>>,
): string {
  const keys = Object.keys(fields);
  if (keys.includes('mac') || keys.includes('overallMac')) {
    throw new RangeError('overall MAC input must contain callback data fields only');
  }
  return keys
    .sort()
    .map((key) => {
      const value = fields[key];
      let normalized: string | undefined;
      if (value === null || typeof value === 'object') {
        normalized = JSON.stringify(value);
      } else if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      ) {
        normalized = value.toString();
      }
      if (normalized === undefined) throw new RangeError(`overall MAC field ${key} is invalid`);
      return `${key}=${normalized}`;
    })
    .join('&');
}

export function mapZaloCheckoutPaymentResult(
  resultCode: number,
  processing?: boolean,
): PaymentProviderStatus {
  if (resultCode === 1) return 'SUCCEEDED';
  if (resultCode === 0 || processing === true) return 'PENDING';
  if (resultCode === -1) return 'FAILED';
  return 'UNKNOWN';
}

export function mapZaloCheckoutCreateRefundResult(resultCode: number): RefundProviderStatus {
  if (resultCode === 1) return 'SUCCEEDED';
  if (resultCode > 1) return 'PENDING';
  if (resultCode < 1) return 'FAILED';
  return 'UNKNOWN';
}

export function mapZaloCheckoutRefundStatusResult(resultCode: number): RefundProviderStatus {
  return resultCode === 1 ? 'SUCCEEDED' : 'FAILED';
}
