import { createHash, createHmac } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  buildZaloCheckoutCallbackMacData,
  buildZaloCheckoutCreateOrderMacData,
  canonicalizeZaloCheckoutOverallMacFields,
  ProviderIntegrationError,
  ZALO_CHECKOUT_STATUS_ENDPOINT,
  ZaloCheckoutPaymentProvider,
} from './index';

const privateKey = 'checkout-private-key-for-contract-tests';
const appId = '123456789';
const storeId = '10000000-0000-4000-8000-000000000001';
const orderId = '32000000-0000-4000-8000-000000000001';
const attemptId = '31000000-0000-4000-8000-000000000001';
const providerOrderId = 'zalo-checkout-order-1';
const now = 1_800_000_000_000;

function provider(
  options: Partial<ConstructorParameters<typeof ZaloCheckoutPaymentProvider>[0]> = {},
) {
  return new ZaloCheckoutPaymentProvider({
    appId,
    environment: 'SANDBOX',
    now: () => now,
    privateKeySecretRef: 'secret://stores/beauty/zalo-checkout/private-key/v1',
    resolveSecret: { resolve: vi.fn().mockResolvedValue(privateKey) },
    storeId,
    ...options,
  });
}

const createInput = {
  amountVnd: 120_000,
  attemptId,
  currency: 'VND' as const,
  description: 'Thanh toan ZS-1',
  expiresAt: new Date(now + 300_000),
  items: [{ amountVnd: 120_000, name: 'Serum', quantity: 1, skuCode: 'SERUM-1' }],
  orderId,
  publicOrderNumber: 'ZS-1',
  storeId,
};

function extraData(): string {
  return JSON.stringify({
    attempt_id: attemptId,
    nonce: createHash('sha256')
      .update(`${storeId}\u0000${orderId}\u0000${attemptId}`, 'utf8')
      .digest('hex'),
    order_id: orderId,
    store_id: storeId,
  });
}

function signedCallback(overrides: Record<string, unknown> = {}) {
  const data = {
    amount: 120_000,
    appId,
    description: 'Thanh toan ZS-1',
    extradata: encodeURIComponent(extraData()),
    merchantTransId: 'merchant-transaction-1',
    message: 'Payment successful',
    method: 'ZALOPAY_SANDBOX',
    orderId: providerOrderId,
    resultCode: 1,
    transId: 'zalopay-transaction-1',
    transTime: now - 10_000,
    ...overrides,
  };
  const mac = createHmac('sha256', privateKey)
    .update(
      buildZaloCheckoutCallbackMacData({
        amountVnd: data.amount,
        appId: data.appId,
        description: data.description,
        message: data.message,
        orderId: data.orderId,
        resultCode: data.resultCode,
        transactionId: data.transId,
      }),
    )
    .digest('hex');
  const overallMac = createHmac('sha256', privateKey)
    .update(canonicalizeZaloCheckoutOverallMacFields(data))
    .digest('hex');
  return Buffer.from(JSON.stringify({ data, mac, overallMac }));
}

describe('Zalo Checkout payment provider', () => {
  it('generates an idempotent official createOrder MAC without exposing the secret', async () => {
    const checkout = provider();
    const first = await checkout.createPayment(createInput);
    const second = await checkout.createPayment(createInput);
    expect(second).toEqual(first);
    expect((first as { providerOrderId?: string }).providerOrderId).toBeUndefined();
    expect(first.launchAction.payload.method).toBe('{"id":"ZALOPAY_SANDBOX","isCustom":false}');
    expect(first.launchAction.payload.extradata).not.toContain(privateKey);
    expect(first.launchAction.payload.mac).toBe(
      createHmac('sha256', privateKey)
        .update(
          buildZaloCheckoutCreateOrderMacData({
            amountVnd: createInput.amountVnd,
            description: createInput.description,
            extraDataJson: first.launchAction.payload.extradata,
            itemsJson: JSON.stringify(first.launchAction.payload.item),
            methodJson: first.launchAction.payload.method,
          }),
        )
        .digest('hex'),
    );
  });

  it('verifies callback mac and overallMac before returning an authenticated fact', async () => {
    await expect(
      provider().parseCallback({
        headers: { 'content-type': 'application/json; charset=utf-8' },
        rawBody: signedCallback(),
      }),
    ).resolves.toMatchObject({
      externalEventId: expect.stringMatching(/^zc:[0-9a-f]{64}$/u),
      fact: {
        amountVnd: 120_000,
        attemptId,
        orderId,
        providerOrderId,
        providerTransactionId: 'zalopay-transaction-1',
        status: 'SUCCEEDED',
        storeId,
      },
      trust: 'AUTHENTICATED_FACT',
    });
  });

  it('assigns distinct event identities to pending and successful facts for one transaction', async () => {
    const checkout = provider();
    const pending = await checkout.parseCallback({
      headers: { 'content-type': 'application/json' },
      rawBody: signedCallback({ isProcessing: true, resultCode: 0 }),
    });
    const succeeded = await checkout.parseCallback({
      headers: { 'content-type': 'application/json' },
      rawBody: signedCallback({ isProcessing: false, resultCode: 1 }),
    });

    expect(pending.fact?.status).toBe('PENDING');
    expect(succeeded.fact?.status).toBe('SUCCEEDED');
    expect(pending.externalEventId).not.toBe(succeeded.externalEventId);
  });

  it.each([
    {
      body: () => {
        const parsed = JSON.parse(signedCallback().toString('utf8')) as Record<string, unknown>;
        parsed.overallMac = '0'.repeat(64);
        return Buffer.from(JSON.stringify(parsed));
      },
      code: 'AUTHENTICATION',
      contentType: 'application/json',
    },
    {
      body: signedCallback,
      code: 'INVALID_REQUEST',
      contentType: 'text/plain',
    },
    {
      body: () => Buffer.alloc(128 * 1_024 + 1),
      code: 'INVALID_REQUEST',
      contentType: 'application/json',
    },
  ])('rejects unauthenticated or malformed callbacks', async ({ body, code, contentType }) => {
    const promise = provider().parseCallback({
      headers: { 'content-type': contentType },
      rawBody: body(),
    });
    await expect(promise).rejects.toMatchObject({ code });
  });

  it('queries only the allowlisted HTTPS endpoint and normalizes the signed identity', async () => {
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = new URL(
        input instanceof URL ? input.href : typeof input === 'string' ? input : input.url,
      );
      expect(url.origin + url.pathname).toBe(ZALO_CHECKOUT_STATUS_ENDPOINT);
      expect(url.searchParams.get('appId')).toBe(appId);
      expect(url.searchParams.get('orderId')).toBe(providerOrderId);
      expect(url.searchParams.get('mac')).toMatch(/^[0-9a-f]{64}$/u);
      expect(url.href).not.toContain(privateKey);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            amount: 120_000,
            extradata: encodeURIComponent(extraData()),
            isProcessing: false,
            merchantTransId: 'merchant-transaction-1',
            method: 'ZALOPAY_SANDBOX',
            returnCode: 1,
            returnMessage: 'Payment successful',
            transId: 'zalopay-transaction-1',
            transTime: now - 10_000,
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 },
        ),
      );
    });
    await expect(
      provider({ fetch: fetchMock }).queryPayment({ providerOrderId, storeId }),
    ).resolves.toMatchObject({
      amountVnd: 120_000,
      attemptId,
      orderId,
      providerOrderId,
      providerTransactionId: 'zalopay-transaction-1',
      status: 'SUCCEEDED',
      storeId,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects a successful query response without a provider transaction id', async () => {
    const response = new Response(
      JSON.stringify({
        amount: 120_000,
        extradata: encodeURIComponent(extraData()),
        isProcessing: false,
        method: 'ZALOPAY_SANDBOX',
        returnCode: 1,
        returnMessage: 'Payment successful',
      }),
      { headers: { 'content-type': 'application/json' }, status: 200 },
    );

    await expect(
      provider({ fetch: vi.fn().mockResolvedValue(response) }).queryPayment({
        providerOrderId,
        storeId,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('fails closed for cross-store query facts, unknown methods and unsafe HTTP origins', async () => {
    expect(() =>
      provider({
        allowedStatusOrigins: ['http://payment-mini.zalo.me'],
        statusEndpoint: 'http://payment-mini.zalo.me/api/transaction/get-status',
      }),
    ).toThrow(ProviderIntegrationError);

    const response = new Response(
      JSON.stringify({
        amount: 120_000,
        extradata: encodeURIComponent(extraData()),
        isProcessing: false,
        method: 'CARD',
        returnCode: 1,
        returnMessage: 'Payment successful',
        transId: 'zalopay-transaction-1',
      }),
      { headers: { 'content-type': 'application/json' }, status: 200 },
    );
    await expect(
      provider({ fetch: vi.fn().mockResolvedValue(response) }).queryPayment({
        providerOrderId,
        storeId,
      }),
    ).rejects.toMatchObject({ code: 'REJECTED' });

    const crossStore = signedCallback({
      extradata: encodeURIComponent(
        JSON.stringify({
          attempt_id: attemptId,
          nonce: 'a'.repeat(64),
          order_id: orderId,
          store_id: '20000000-0000-4000-8000-000000000001',
        }),
      ),
    });
    await expect(
      provider().parseCallback({
        headers: { 'content-type': 'application/json' },
        rawBody: crossStore,
      }),
    ).rejects.toMatchObject({ code: 'REJECTED' });
  });

  it('rejects signed callback identity with a nonce from another launch', async () => {
    const tampered = signedCallback({
      extradata: encodeURIComponent(
        JSON.stringify({
          attempt_id: attemptId,
          nonce: 'b'.repeat(64),
          order_id: orderId,
          store_id: storeId,
        }),
      ),
    });
    await expect(
      provider().parseCallback({
        headers: { 'content-type': 'application/json' },
        rawBody: tampered,
      }),
    ).rejects.toMatchObject({ code: 'REJECTED' });
  });

  it('classifies provider throttling and invalid response content without leaking bodies', async () => {
    const throttled = provider({
      fetch: vi
        .fn()
        .mockResolvedValue(
          new Response('slow down', { headers: { 'content-type': 'text/plain' }, status: 429 }),
        ),
    });
    await expect(throttled.queryPayment({ providerOrderId, storeId })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
    });

    const invalid = provider({
      fetch: vi.fn().mockResolvedValue(
        new Response('<html>bad gateway</html>', {
          headers: { 'content-type': 'text/html' },
          status: 200,
        }),
      ),
    });
    await expect(invalid.queryPayment({ providerOrderId, storeId })).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      retryable: true,
    });
  });

  it('cancels an oversized streamed response before buffering the full body', async () => {
    let cancelled = false;
    let emitted = 0;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true;
      },
      pull: (controller) => {
        emitted += 1;
        controller.enqueue(new Uint8Array(600));
        if (emitted === 100) controller.close();
      },
    });
    const checkout = provider({
      fetch: vi.fn().mockResolvedValue(
        new Response(body, {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
      ),
      responseLimitBytes: 1_024,
    });

    await expect(checkout.queryPayment({ providerOrderId, storeId })).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      retryable: true,
    });
    expect(cancelled).toBe(true);
    expect(emitted).toBeLessThan(100);
  });
});
