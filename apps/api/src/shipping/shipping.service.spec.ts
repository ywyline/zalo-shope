import { vi } from 'vitest';

const databaseMocks = vi.hoisted(() => ({
  create: vi.fn(),
  prepareQuote: vi.fn(),
  recordQuote: vi.fn(),
  requestOperation: vi.fn(),
  withStore: vi.fn(),
}));

vi.mock('@zalo-shop/database', async () => {
  const actual: Record<string, unknown> = await vi.importActual('@zalo-shop/database');
  return {
    ...actual,
    createShipmentCommand: databaseMocks.create,
    getShippingQuotePreparation: databaseMocks.prepareQuote,
    recordShippingQuote: databaseMocks.recordQuote,
    requestShipmentOperation: databaseMocks.requestOperation,
    withStoreTransaction: databaseMocks.withStore,
  };
});

import { ServiceUnavailableException } from '@nestjs/common';
import type { RuntimeConfig } from '@zalo-shop/config';
import type { ShippingProvider, ShippingProviderResolver } from '@zalo-shop/integrations';
import { beforeEach, describe, expect, it } from 'vitest';

import { ShippingService } from './shipping.service';

const storeId = '10000000-0000-4000-8000-000000000001';
const orderId = '30000000-0000-4000-8000-000000000001';
const shipmentId = '50000000-0000-4000-8000-000000000001';
const context = {
  actor: { id: '20000000-0000-4000-8000-000000000001', type: 'admin' as const },
  correlationId: 'shipping-service-unit',
  locale: 'vi' as const,
  storeCode: 'beauty-local',
  storeId,
};
const config = {
  AUTH_JWT_AUDIENCE: 'zalo-shop-test',
  AUTH_JWT_ISSUER: 'zalo-shop-test',
  AUTH_JWT_SECRET: 'test_jwt_secret_that_is_at_least_32_characters',
  GHN_REQUEST_TIMEOUT_MS: 5_000,
  NODE_ENV: 'test',
  PII_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64'),
} as unknown as RuntimeConfig;

function shippingProvider(overrides: Partial<ShippingProvider> = {}): ShippingProvider {
  return {
    cancelShipment: vi.fn(),
    code: 'GHN',
    createShipment: vi.fn(),
    environment: 'SANDBOX',
    getLabel: vi.fn(),
    listServices: vi.fn(),
    parseCallback: vi.fn(),
    queryShipment: vi.fn(),
    quote: vi.fn(),
    ...overrides,
  };
}

function fixture(provider = shippingProvider()) {
  const admin = {
    authorize: vi.fn().mockResolvedValue(context),
    authorizeSensitive: vi.fn().mockResolvedValue(context),
    writeAudit: vi.fn().mockResolvedValue(undefined),
  };
  const resolver: ShippingProviderResolver = { resolve: vi.fn().mockReturnValue(provider) };
  return {
    admin,
    resolver,
    service: new ShippingService({} as never, {} as never, admin as never, config, resolver),
  };
}

describe('ShippingService', () => {
  beforeEach(() => {
    for (const mock of Object.values(databaseMocks)) mock.mockReset();
  });

  it('requires recent MFA and forwards only server-owned shipment command fields', async () => {
    const result = {
      operationId: '60000000-0000-4000-8000-000000000001',
      operationStatus: 'PENDING',
      orderId,
      providerShipmentReferenceMasked: null,
      publicShipmentNumber: 'SHP-M56-1',
      replayed: false,
      shipmentId,
      status: 'CREATION_PENDING',
      version: 1,
    };
    databaseMocks.create.mockResolvedValue(result);
    const { admin, service } = fixture();
    await expect(
      service.create(
        { accessToken: 'admin-token', storeCode: 'beauty-local' },
        storeId,
        orderId,
        'm56-create-idempotency-key',
        {
          confirmation_code: 'CREATE_SHIPMENT',
          expected_order_version: 3,
          inspection_policy: 'NO_INSPECTION',
          reason: 'Create a GHN shipment for the confirmed order',
          service_code: 'GHN:53320:2',
        },
      ),
    ).resolves.toEqual({
      operation_id: result.operationId,
      operation_status: result.operationStatus,
      order_id: orderId,
      provider_shipment_reference_masked: null,
      public_number: result.publicShipmentNumber,
      replayed: false,
      shipment_id: shipmentId,
      status: 'CREATION_PENDING',
      version: 1,
    });
    expect(admin.authorizeSensitive).toHaveBeenCalledWith(
      expect.anything(),
      storeId,
      'store.shipments.create',
    );
    const command = databaseMocks.create.mock.calls[0]?.[2];
    expect(command).toEqual({
      expectedOrderVersion: 3,
      idempotencyKey: 'm56-create-idempotency-key',
      inspectionPolicy: 'NO_INSPECTION',
      orderId,
      providerEnvironment: 'SANDBOX',
      reason: 'Create a GHN shipment for the confirmed order',
      serviceCode: 'GHN:53320:2',
    });
    expect(command).not.toHaveProperty('address');
    expect(command).not.toHaveProperty('amountVnd');
    expect(command).not.toHaveProperty('providerShipmentId');
  });

  it('issues only an internal short-lived label proxy URL', async () => {
    const transaction = {
      shipment: {
        findFirst: vi.fn().mockResolvedValue({ id: shipmentId, providerShipmentId: 'GHN-1' }),
      },
    };
    databaseMocks.withStore.mockImplementation(
      (_database, _context, callback: (value: typeof transaction) => unknown) =>
        callback(transaction),
    );
    const { admin, service } = fixture();
    const result = await service.issueLabelAccess(
      { accessToken: 'admin-token', storeCode: 'beauty-local' },
      storeId,
      shipmentId,
      'A5',
    );
    expect(result.url).toMatch(/^\/v1\/shipping\/labels\/[A-Za-z0-9._-]+$/u);
    expect(result.url).not.toContain('ghn.vn');
    expect(result.url).not.toContain('token=');
    expect(admin.writeAudit).toHaveBeenCalledWith(
      transaction,
      context,
      expect.objectContaining({ action: 'shipping.shipment.label_access_issued' }),
    );
  });

  it('rejects a provider label URL outside the frozen GHN origin before fetching it', async () => {
    const transaction = {
      shipment: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({ id: shipmentId, providerShipmentId: 'GHN-1' })
          .mockResolvedValueOnce({
            channel: {
              id: '40000000-0000-4000-8000-000000000001',
              keyVersion: 'v1',
              originAllowlistKey: 'GHN_SANDBOX',
              providerCode: 'GHN',
              providerEnvironment: 'SANDBOX',
              shopId: '123456',
              storeId,
              tokenSecretRef: 'env:GHN_BEAUTY_TOKEN',
              version: 1,
            },
            id: shipmentId,
            providerShipmentId: 'GHN-1',
          }),
      },
    };
    databaseMocks.withStore.mockImplementation(
      (_database, _context, callback: (value: typeof transaction) => unknown) =>
        callback(transaction),
    );
    const getLabel = vi.fn().mockResolvedValue({
      expiresAt: new Date(Date.now() + 60_000),
      url: 'https://attacker.example/label.pdf?token=stolen',
    });
    const { service } = fixture(shippingProvider({ getLabel }));
    const issued = await service.issueLabelAccess(
      { accessToken: 'admin-token', storeCode: 'beauty-local' },
      storeId,
      shipmentId,
      'A5',
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(
      service.proxyLabel(decodeURIComponent(issued.url.slice('/v1/shipping/labels/'.length))),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
