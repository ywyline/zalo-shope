import { describe, expect, it, vi } from 'vitest';

import {
  GHN_ENDPOINT_PATHS,
  GHN_ORIGINS,
  GhnShippingProvider,
  inspectGhnCallbackRoute,
  ProviderIntegrationError,
} from './index';

const storeId = '10000000-0000-4000-8000-000000000001';
const now = 1_800_000_000_000;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ code: 200, data, message: 'Success' }), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

function provider(fetch: typeof globalThis.fetch) {
  return new GhnShippingProvider({
    environment: 'SANDBOX',
    fetch,
    now: () => now,
    resolveSecret: { resolve: vi.fn().mockResolvedValue('ghn-contract-token') },
    shopId: '123456',
    storeId,
    tokenSecretRef: 'env:GHN_BEAUTY_TOKEN',
  });
}

const origin = {
  addressLine: '39 Nguyen Trai',
  districtCode: '1442',
  name: 'Beauty warehouse',
  phoneE164: '+84901234567',
  provinceCode: '79',
  wardCode: '20308',
};
const destination = {
  addressLine: '72 Thanh Thai',
  districtCode: '1444',
  name: 'Nguyen Van A',
  phoneE164: '+84987654321',
  provinceCode: '79',
  wardCode: '20314',
};
const parcel = { heightCm: 10, lengthCm: 20, weightGrams: 500, widthCm: 15 };

describe('GHN shipping provider', () => {
  it('lists services with fixed sandbox origin and server-only credentials', async () => {
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        input instanceof URL ? input.href : typeof input === 'string' ? input : input.url,
      );
      expect(url.origin).toBe(GHN_ORIGINS.SANDBOX);
      expect(url.pathname).toBe(GHN_ENDPOINT_PATHS.availableServices);
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('token')).toBe('ghn-contract-token');
      expect(new Headers(init?.headers).get('shopid')).toBe('123456');
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
      expect(JSON.parse(init.body)).toEqual({
        from_district: 1442,
        shop_id: 123456,
        to_district: 1444,
      });
      return Promise.resolve(
        json([{ service_id: 53321, service_type_id: 2, short_name: 'Hàng nhẹ' }]),
      );
    });

    await expect(
      provider(fetchMock).listServices({ destination, origin, storeId }),
    ).resolves.toEqual([{ code: 'GHN:53321:2', name: 'Hàng nhẹ' }]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('quotes integer VND and lead time from two strict provider responses', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          cod_fee: 500,
          coupon_value: 0,
          deliver_remote_areas_fee: 1_000,
          double_check: 200,
          insurance_fee: 300,
          pick_remote_areas_fee: 500,
          pick_station_fee: 500,
          service_fee: 22_000,
          total: 25_000,
        }),
      )
      .mockResolvedValueOnce(json({ leadtime: Math.floor((now + 86_400_000) / 1_000) }));
    await expect(
      provider(fetchMock).quote({
        codAmountVnd: 120_000,
        destination,
        origin,
        parcel,
        serviceCode: 'GHN:53321:2',
        storeId,
      }),
    ).resolves.toEqual({
      baseFeeVnd: 22_000,
      codFeeVnd: 500,
      estimatedDeliveryAt: new Date(now + 86_400_000),
      expiresAt: new Date(now + 300_000),
      insuranceFeeVnd: 300,
      otherFeeVnd: 700,
      providerServiceId: 53321,
      providerServiceTypeId: 2,
      remoteFeeVnd: 1_500,
      serviceCode: 'GHN:53321:2',
      totalFeeVnd: 25_000,
    });
    const urls = fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname);
    expect(urls).toEqual([GHN_ENDPOINT_PATHS.quote, GHN_ENDPOINT_PATHS.leadTime]);
  });

  it('rejects a quote whose total cannot be explained by its integer fee breakdown', async () => {
    const inconsistent = vi
      .fn()
      .mockResolvedValueOnce(json({ service_fee: 22_000, total: 25_000 }))
      .mockResolvedValueOnce(json({ leadtime: Math.floor((now + 86_400_000) / 1_000) }));
    await expect(
      provider(inconsistent).quote({
        codAmountVnd: 120_000,
        destination,
        origin,
        parcel,
        serviceCode: 'GHN:53321:2',
        storeId,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE', retryable: false });
  });

  it('creates an idempotent client-coded shipment without accepting a provider id as input', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        created_date: new Date(now).toISOString(),
        order_code: 'GTEST123456',
      }),
    );
    await expect(
      provider(fetchMock).createShipment({
        clientOrderCode: 'SHIP_00000001',
        codAmountVnd: 120_000,
        destination,
        inspectionPolicy: 'NO_INSPECTION',
        items: [{ name: 'Serum dịu nhẹ', quantity: 1, skuCode: 'serum-01' }],
        operationId: '50000000-0000-4000-8000-000000000001',
        origin,
        parcel,
        serviceCode: 'GHN:53321:2',
        storeId,
      }),
    ).resolves.toMatchObject({
      clientOrderCode: 'SHIP_00000001',
      providerShipmentId: 'GTEST123456',
      providerStatus: 'ready_to_pick',
      status: 'PENDING_PICKUP',
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      client_order_code: 'SHIP_00000001',
      cod_amount: 120_000,
      required_note: 'KHONGCHOXEMHANG',
      service_id: 53321,
      service_type_id: 2,
    });
    expect(JSON.stringify(body)).not.toContain('ghn-contract-token');
  });

  it('normalizes query states but leaves an unknown state unmapped', async () => {
    const known = vi.fn().mockResolvedValue(
      json({
        client_order_code: 'SHIP_00000001',
        order_code: 'GTEST123456',
        status: 'delivering',
        updated_date: new Date(now - 10_000).toISOString(),
      }),
    );
    await expect(
      provider(known).queryShipment({ providerShipmentId: 'GTEST123456', storeId }),
    ).resolves.toMatchObject({
      clientOrderCode: 'SHIP_00000001',
      providerStatus: 'delivering',
      status: 'OUT_FOR_DELIVERY',
    });

    const unknown = vi.fn().mockResolvedValue(
      json({
        order_code: 'GTEST123456',
        status: 'future_state',
        updated_date: new Date(now).toISOString(),
      }),
    );
    const fact = await provider(unknown).queryShipment({
      providerShipmentId: 'GTEST123456',
      storeId,
    });
    expect(fact.status).toBeUndefined();
    expect(fact.providerStatus).toBe('future_state');
  });

  it('treats unsigned callbacks only as shop-bound query hints', async () => {
    const rawBody = Buffer.from(
      JSON.stringify({
        ClientOrderCode: 'SHIP_00000001',
        OrderCode: 'GTEST123456',
        ShopID: 123456,
        Status: 'delivered',
      }),
    );
    await expect(
      provider(vi.fn()).parseCallback({
        headers: { 'content-type': 'application/json' },
        rawBody,
      }),
    ).resolves.toMatchObject({
      externalEventId: expect.stringMatching(/^ghn-hint:[0-9a-f]{64}$/u),
      hint: {
        clientOrderCode: 'SHIP_00000001',
        providerShipmentId: 'GTEST123456',
        providerStatus: 'delivered',
        shopId: '123456',
      },
      trust: 'UNVERIFIED_HINT',
    });

    await expect(
      provider(vi.fn()).parseCallback({
        headers: { 'content-type': 'application/json' },
        rawBody: Buffer.from(JSON.stringify({ OrderCode: 'GTEST123456', ShopID: 999 })),
      }),
    ).rejects.toMatchObject({ code: 'REJECTED' });
  });

  it('inspects a callback route without resolving a token and requires a ShopId', () => {
    const rawBody = Buffer.from(
      JSON.stringify({ OrderCode: 'GTEST123456', ShopID: 123456, Status: 'ready_to_pick' }),
    );
    expect(inspectGhnCallbackRoute(rawBody)).toEqual({
      providerShipmentId: 'GTEST123456',
      providerStatus: 'ready_to_pick',
      shopId: '123456',
    });
    expect(() =>
      inspectGhnCallbackRoute(Buffer.from(JSON.stringify({ OrderCode: 'GTEST123456' }))),
    ).toThrow(ProviderIntegrationError);
  });

  it('fails closed on cross-store calls, throttling and invalid response content', async () => {
    const shipping = provider(vi.fn());
    await expect(
      shipping.listServices({
        destination,
        origin,
        storeId: '20000000-0000-4000-8000-000000000001',
      }),
    ).rejects.toMatchObject({ code: 'REJECTED' });

    await expect(
      provider(
        vi
          .fn()
          .mockResolvedValue(
            new Response('slow down', { headers: { 'content-type': 'text/plain' }, status: 429 }),
          ),
      ).queryShipment({ providerShipmentId: 'GTEST123456', storeId }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true });

    await expect(
      provider(
        vi.fn().mockResolvedValue(
          new Response('<html>bad gateway</html>', {
            headers: { 'content-type': 'text/html' },
            status: 200,
          }),
        ),
      ).queryShipment({ providerShipmentId: 'GTEST123456', storeId }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE', retryable: true });
  });

  it('cancels an oversized streamed response before buffering it', async () => {
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
    const shipping = new GhnShippingProvider({
      environment: 'SANDBOX',
      fetch: vi
        .fn()
        .mockResolvedValue(
          new Response(body, { headers: { 'content-type': 'application/json' }, status: 200 }),
        ),
      resolveSecret: { resolve: vi.fn().mockResolvedValue('ghn-contract-token') },
      responseLimitBytes: 1_024,
      shopId: '123456',
      storeId,
      tokenSecretRef: 'env:GHN_BEAUTY_TOKEN',
    });
    await expect(
      shipping.queryShipment({ providerShipmentId: 'GTEST123456', storeId }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE', retryable: true });
    expect(cancelled).toBe(true);
    expect(emitted).toBeLessThan(100);
  });

  it('rejects malformed services before issuing an external request', async () => {
    await expect(
      provider(vi.fn()).quote({
        codAmountVnd: 0,
        destination,
        origin,
        parcel,
        serviceCode: 'GHN:invalid',
        storeId,
      }),
    ).rejects.toBeInstanceOf(ProviderIntegrationError);
  });

  it('rejects explicit null fees and invalid provider timestamps', async () => {
    const nullFee = vi
      .fn()
      .mockResolvedValueOnce(json({ insurance_fee: null, service_fee: 25_000, total: 25_000 }))
      .mockResolvedValueOnce(json({ leadtime: Math.floor((now + 86_400_000) / 1_000) }));
    await expect(
      provider(nullFee).quote({
        codAmountVnd: 0,
        destination,
        origin,
        parcel,
        serviceCode: 'GHN:53321:2',
        storeId,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });

    await expect(
      provider(
        vi
          .fn()
          .mockResolvedValue(
            json({ order_code: 'GTEST123456', status: 'delivering', updated_date: 'not-a-date' }),
          ),
      ).queryShipment({ providerShipmentId: 'GTEST123456', storeId }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
