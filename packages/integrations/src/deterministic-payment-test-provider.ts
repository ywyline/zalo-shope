import { createHmac, timingSafeEqual } from 'node:crypto';

import type { PaymentProviderStatus, RefundProviderStatus } from './payment-provider';
import {
  type PaymentProvider,
  type PaymentProviderFact,
  type RefundProviderFact,
} from './payment-provider';
import {
  ProviderIntegrationError,
  type ProviderCallbackResult,
  type ProviderRawCallback,
} from './provider-contract';

type TestPaymentProviderOptions = Readonly<{
  factOverrides?: Partial<
    Pick<PaymentProviderFact, 'amountVnd' | 'attemptId' | 'currency' | 'orderId' | 'storeId'>
  >;
  nodeEnvironment?: string;
  refundStatus?: RefundProviderStatus;
  secret: string;
  status?: PaymentProviderStatus;
}>;

type ParsedProviderOrder = Readonly<{
  amountVnd: number;
  attemptId: string;
  orderId: string;
  storeId: string;
}>;

const UUID_HEX_PATTERN = /^[0-9a-f]{32}$/u;

function compactUuid(value: string): string {
  const compact = value.replaceAll('-', '').toLowerCase();
  if (!UUID_HEX_PATTERN.test(compact)) {
    throw new ProviderIntegrationError('INVALID_REQUEST', false);
  }
  return compact;
}

function expandedUuid(value: string): string {
  if (!UUID_HEX_PATTERN.test(value)) {
    throw new ProviderIntegrationError('INVALID_RESPONSE', false);
  }
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export class DeterministicPaymentTestProvider implements PaymentProvider {
  public readonly code = 'ZALO_CHECKOUT_ZALOPAY';
  public readonly environment = 'SANDBOX' as const;
  readonly #status: PaymentProviderStatus;
  readonly #refundStatus: RefundProviderStatus;

  public constructor(private readonly options: TestPaymentProviderOptions) {
    if ((options.nodeEnvironment ?? process.env.NODE_ENV) !== 'test') {
      throw new ProviderIntegrationError(
        'CONFIGURATION',
        false,
        'Test payment provider is test-only',
      );
    }
    if (options.secret.length < 32) {
      throw new ProviderIntegrationError('CONFIGURATION', false);
    }
    this.#status = options.status ?? 'PENDING';
    this.#refundStatus = options.refundStatus ?? 'PENDING';
  }

  public async createPayment(input: {
    amountVnd: number;
    attemptId: string;
    currency: 'VND';
    description: string;
    expiresAt: Date;
    items: readonly Readonly<{
      amountVnd: number;
      name: string;
      quantity: number;
      skuCode: string;
    }>[];
    orderId: string;
    publicOrderNumber: string;
    storeId: string;
  }) {
    await Promise.resolve();
    this.assertCreateInput(input);
    const providerOrderId = this.providerOrderId(input);
    const nonce = this.digest(`nonce\u0000${input.attemptId}`);
    const extraData = stableJson({
      attempt_id: input.attemptId,
      nonce,
      order_id: input.orderId,
      store_id: input.storeId,
    });
    const method = stableJson({ id: 'ZALOPAY_SANDBOX', isCustom: false });
    const items = input.items.map((item) => ({ amount: item.amountVnd, id: item.skuCode }));
    const payloadWithoutMac = {
      amount: input.amountVnd,
      desc: input.description,
      extradata: extraData,
      item: items,
      method,
    };
    return {
      launchAction: {
        expiresAt: input.expiresAt,
        kind: 'ZALO_CHECKOUT_CREATE_ORDER' as const,
        payload: { ...payloadWithoutMac, mac: this.digest(stableJson(payloadWithoutMac)) },
      },
      providerOrderId,
      providerStatus: 'TEST_PROVIDER_PENDING',
    };
  }

  public async queryPayment(input: {
    providerOrderId: string;
    storeId: string;
  }): Promise<PaymentProviderFact> {
    await Promise.resolve();
    const parsed = this.parseProviderOrderId(input.providerOrderId);
    if (parsed.storeId !== input.storeId) {
      throw new ProviderIntegrationError('REJECTED', false);
    }
    const providerStatus = `TEST_${this.#status}`;
    return {
      amountVnd: parsed.amountVnd,
      attemptId: parsed.attemptId,
      currency: 'VND',
      orderId: parsed.orderId,
      providerOrderId: input.providerOrderId,
      providerStatus,
      ...(this.#status === 'SUCCEEDED'
        ? { providerTransactionId: `test-tx-${this.digest(input.providerOrderId).slice(0, 24)}` }
        : {}),
      status: this.#status,
      storeId: parsed.storeId,
      ...this.options.factOverrides,
    };
  }

  public async parseCallback(
    callback: ProviderRawCallback,
  ): Promise<ProviderCallbackResult<PaymentProviderFact>> {
    await Promise.resolve();
    const signature = callback.headers['x-test-payment-signature'];
    const expected = this.digest(callback.rawBody);
    if (!signature || !this.equal(signature, expected)) {
      throw new ProviderIntegrationError('AUTHENTICATION', false);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(callback.rawBody).toString('utf8'));
    } catch {
      throw new ProviderIntegrationError('INVALID_REQUEST', false);
    }
    if (
      payload === null ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      typeof (payload as { provider_order_id?: unknown }).provider_order_id !== 'string'
    ) {
      throw new ProviderIntegrationError('INVALID_REQUEST', false);
    }
    const providerOrderId = (payload as { provider_order_id: string }).provider_order_id;
    const parsed = this.parseProviderOrderId(providerOrderId);
    return {
      externalEventId: `test-event-${this.digest(callback.rawBody).slice(0, 24)}`,
      fact: await this.queryPayment({ providerOrderId, storeId: parsed.storeId }),
      trust: 'AUTHENTICATED_FACT',
    };
  }

  public async createRefund(
    input: Parameters<PaymentProvider['createRefund']>[0],
  ): Promise<RefundProviderFact> {
    await Promise.resolve();
    if (
      !Number.isSafeInteger(input.amountVnd) ||
      input.amountVnd <= 0 ||
      !input.description ||
      !input.paymentProviderTransactionId ||
      !input.publicRefundNumber
    ) {
      throw new ProviderIntegrationError('INVALID_REQUEST', false);
    }
    const storeId = compactUuid(input.storeId);
    const refundId = compactUuid(input.refundId);
    const data = `${storeId}.${refundId}.${String(input.amountVnd)}`;
    return {
      amountVnd: input.amountVnd,
      providerRefundId: `r.${data}.${this.digest(data).slice(0, 20)}`,
      providerStatus: `TEST_REFUND_${this.#refundStatus}`,
      status: this.#refundStatus,
    };
  }

  public async queryRefund(
    input: Parameters<PaymentProvider['queryRefund']>[0],
  ): Promise<RefundProviderFact> {
    await Promise.resolve();
    const parts = input.providerRefundId.split('.');
    if (parts.length !== 5 || parts[0] !== 'r') {
      throw new ProviderIntegrationError('INVALID_RESPONSE', false);
    }
    const [, storeId, refundId, amountText, signature] = parts;
    const data = `${storeId}.${refundId}.${amountText}`;
    if (!this.equal(signature!, this.digest(data).slice(0, 20))) {
      throw new ProviderIntegrationError('AUTHENTICATION', false);
    }
    const amountVnd = Number(amountText);
    if (
      expandedUuid(storeId!) !== input.storeId ||
      !UUID_HEX_PATTERN.test(refundId!) ||
      !Number.isSafeInteger(amountVnd) ||
      amountVnd <= 0 ||
      amountVnd !== input.amountVnd
    ) {
      throw new ProviderIntegrationError('REJECTED', false);
    }
    return {
      amountVnd,
      providerRefundId: input.providerRefundId,
      providerStatus: `TEST_REFUND_${this.#refundStatus}`,
      status: this.#refundStatus,
    };
  }

  private assertCreateInput(input: Parameters<PaymentProvider['createPayment']>[0]): void {
    if (
      input.currency !== 'VND' ||
      !Number.isSafeInteger(input.amountVnd) ||
      input.amountVnd <= 0 ||
      input.expiresAt.getTime() <= Date.now() ||
      input.items.length === 0 ||
      input.items.some(
        (item) =>
          !item.name ||
          !item.skuCode ||
          !Number.isSafeInteger(item.amountVnd) ||
          item.amountVnd < 0 ||
          !Number.isSafeInteger(item.quantity) ||
          item.quantity < 1,
      )
    ) {
      throw new ProviderIntegrationError('INVALID_REQUEST', false);
    }
    compactUuid(input.storeId);
    compactUuid(input.orderId);
    compactUuid(input.attemptId);
  }

  private providerOrderId(input: {
    amountVnd: number;
    attemptId: string;
    orderId: string;
    storeId: string;
  }): string {
    const data = [
      compactUuid(input.storeId),
      compactUuid(input.orderId),
      compactUuid(input.attemptId),
      String(input.amountVnd),
    ].join('.');
    return `t.${data}.${this.digest(data).slice(0, 20)}`;
  }

  private parseProviderOrderId(value: string): ParsedProviderOrder {
    const parts = value.split('.');
    if (parts.length !== 6 || parts[0] !== 't') {
      throw new ProviderIntegrationError('INVALID_RESPONSE', false);
    }
    const [, storeId, orderId, attemptId, amountText, signature] = parts;
    const data = [storeId, orderId, attemptId, amountText].join('.');
    if (!this.equal(signature!, this.digest(data).slice(0, 20))) {
      throw new ProviderIntegrationError('AUTHENTICATION', false);
    }
    const amountVnd = Number(amountText);
    if (!Number.isSafeInteger(amountVnd) || amountVnd <= 0) {
      throw new ProviderIntegrationError('INVALID_RESPONSE', false);
    }
    return {
      amountVnd,
      attemptId: expandedUuid(attemptId!),
      orderId: expandedUuid(orderId!),
      storeId: expandedUuid(storeId!),
    };
  }

  private digest(value: string | Uint8Array): string {
    return createHmac('sha256', this.options.secret).update(value).digest('hex');
  }

  private equal(left: string, right: string): boolean {
    const leftBytes = Buffer.from(left);
    const rightBytes = Buffer.from(right);
    return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
  }
}
