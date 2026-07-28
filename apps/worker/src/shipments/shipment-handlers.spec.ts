import { vi } from 'vitest';

const databaseMocks = vi.hoisted(() => ({
  applyFact: vi.fn(),
  creationRequest: vi.fn(),
  operationError: vi.fn(),
  operationRequest: vi.fn(),
  shipmentCreated: vi.fn(),
}));

vi.mock('@zalo-shop/database', async () => {
  const actual: Record<string, unknown> = await vi.importActual('@zalo-shop/database');
  return {
    ...actual,
    applyShippingProviderFact: databaseMocks.applyFact,
    getShipmentCreationRequest: databaseMocks.creationRequest,
    getShipmentProviderOperationRequest: databaseMocks.operationRequest,
    recordShipmentCreated: databaseMocks.shipmentCreated,
    recordShippingOperationError: databaseMocks.operationError,
  };
});

import {
  ShippingCommandError,
  SHIPMENT_CANCEL_EVENT_TYPE,
  SHIPMENT_CREATE_EVENT_TYPE,
  SHIPMENT_QUERY_EVENT_TYPE,
  type OutboxMessageRecord,
} from '@zalo-shop/database';
import { ProviderIntegrationError, type ShippingProvider } from '@zalo-shop/integrations';
import { encryptSensitive } from '@zalo-shop/security';
import { beforeEach, describe, expect, it } from 'vitest';

import { OutboxHandlerError } from '../reliable-messaging/outbox-message-handler';
import { ShipmentCreateRequestedHandler } from './shipment-create-requested.handler';
import { ShipmentProviderOperationHandler } from './shipment-provider-operation.handler';

const storeId = '10000000-0000-4000-8000-000000000001';
const shipmentId = '50000000-0000-4000-8000-000000000001';
const operationId = '60000000-0000-4000-8000-000000000001';
const key = Buffer.alloc(32, 7).toString('base64');

function message(eventType: string): OutboxMessageRecord {
  return {
    aggregateId: shipmentId,
    aggregateType: 'SHIPMENT',
    attemptCount: 1,
    availableAt: new Date(),
    completedAt: null,
    eventType,
    eventVersion: 1,
    id: '70000000-0000-4000-8000-000000000001',
    idempotencyKey: `shipment-test:${operationId}`,
    lastErrorCode: null,
    leaseExpiresAt: new Date(Date.now() + 30_000),
    leaseOwner: 'unit-test',
    maxAttempts: 8,
    payload: { operation_id: operationId, shipment_id: shipmentId, store_id: storeId },
    status: 'PROCESSING',
    storeId,
    version: 2,
  };
}

function provider(overrides: Partial<ShippingProvider> = {}): ShippingProvider {
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

const channel = {
  id: '40000000-0000-4000-8000-000000000001',
  keyVersion: 'v1',
  originAllowlistKey: 'GHN_SANDBOX',
  providerCode: 'GHN',
  providerEnvironment: 'SANDBOX' as const,
  shopId: '123456',
  tokenSecretRef: 'env:GHN_BEAUTY_TOKEN',
  version: 1,
};

describe('shipment outbox handlers', () => {
  beforeEach(() => {
    for (const mock of Object.values(databaseMocks)) mock.mockReset().mockResolvedValue(undefined);
  });

  it('decrypts PII only for the GHN create call and persists the returned fact', async () => {
    databaseMocks.creationRequest.mockResolvedValue({
      channel,
      clientOrderCode: 'SHP-TEST0001',
      codAmountVnd: 120_000,
      destination: {
        addressLineCiphertext: encryptSensitive('72 Thanh Thai', key),
        districtCode: '1444',
        nameCiphertext: encryptSensitive('Nguyen Van A', key),
        phoneCiphertext: encryptSensitive('+84987654321', key),
        provinceCode: '79',
        wardCode: '20308',
      },
      inspectionPolicy: 'NO_INSPECTION',
      items: [{ name: 'Serum', quantity: 1, skuCode: 'SERUM-01' }],
      operationId,
      operationStatus: 'PENDING',
      origin: {
        addressLineCiphertext: encryptSensitive('39 Nguyen Trai', key),
        districtCode: '1442',
        nameCiphertext: encryptSensitive('Beauty warehouse', key),
        phoneCiphertext: encryptSensitive('+84901234567', key),
        provinceCode: '79',
        wardCode: '20308',
      },
      parcel: { heightCm: 8, lengthCm: 18, weightGrams: 250, widthCm: 12 },
      purpose: 'ORDER_OUTBOUND',
      serviceCode: 'GHN:53320:2',
      shipmentId,
      status: 'CREATION_PENDING',
      storeId,
    });
    const fact = {
      clientOrderCode: 'SHP-TEST0001',
      providerShipmentId: 'GHN-TEST0001',
      providerStatus: 'ready_to_pick',
      status: 'PENDING_PICKUP' as const,
    };
    const createShipment = vi.fn().mockResolvedValue(fact);
    const handler = new ShipmentCreateRequestedHandler(
      {} as never,
      { resolve: vi.fn().mockReturnValue(provider({ createShipment })) },
      { PII_ENCRYPTION_KEY: key },
    );
    await handler.handle(message(SHIPMENT_CREATE_EVENT_TYPE));
    expect(createShipment).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: expect.objectContaining({
          addressLine: '72 Thanh Thai',
          name: 'Nguyen Van A',
          phoneE164: '+84987654321',
        }),
        origin: expect.objectContaining({
          addressLine: '39 Nguyen Trai',
          name: 'Beauty warehouse',
          phoneE164: '+84901234567',
        }),
      }),
    );
    expect(databaseMocks.shipmentCreated).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { fact, operationId, purpose: 'ORDER_OUTBOUND', shipmentId },
    );
  });

  it('classifies a retryable provider failure without persisting request PII', async () => {
    databaseMocks.creationRequest.mockResolvedValue({
      channel,
      clientOrderCode: 'SHP-TEST0001',
      codAmountVnd: 0,
      destination: {
        addressLineCiphertext: encryptSensitive('72 Thanh Thai', key),
        districtCode: '1444',
        nameCiphertext: encryptSensitive('Nguyen Van A', key),
        phoneCiphertext: encryptSensitive('+84987654321', key),
        provinceCode: '79',
        wardCode: '20308',
      },
      inspectionPolicy: 'NO_INSPECTION',
      items: [{ name: 'Serum', quantity: 1, skuCode: 'SERUM-01' }],
      operationId,
      operationStatus: 'PENDING',
      origin: {
        addressLineCiphertext: encryptSensitive('39 Nguyen Trai', key),
        districtCode: '1442',
        nameCiphertext: encryptSensitive('Beauty warehouse', key),
        phoneCiphertext: encryptSensitive('+84901234567', key),
        provinceCode: '79',
        wardCode: '20308',
      },
      parcel: { heightCm: 8, lengthCm: 18, weightGrams: 250, widthCm: 12 },
      purpose: 'ORDER_OUTBOUND',
      serviceCode: 'GHN:53320:2',
      shipmentId,
      status: 'CREATION_PENDING',
      storeId,
    });
    const handler = new ShipmentCreateRequestedHandler(
      {} as never,
      {
        resolve: vi.fn().mockReturnValue(
          provider({
            createShipment: vi
              .fn()
              .mockRejectedValue(new ProviderIntegrationError('TIMEOUT', true)),
          }),
        ),
      },
      { PII_ENCRYPTION_KEY: key },
    );
    await expect(handler.handle(message(SHIPMENT_CREATE_EVENT_TYPE))).rejects.toMatchObject({
      code: 'SHIPPING_PROVIDER_TIMEOUT',
      disposition: 'RETRYABLE',
    });
    expect(databaseMocks.operationError).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { errorCode: 'SHIPPING_PROVIDER_TIMEOUT', operationId, status: 'PENDING' },
    );
    expect(JSON.stringify(databaseMocks.operationError.mock.calls)).not.toContain('72 Thanh Thai');
  });

  it('applies only the active query result for a query operation', async () => {
    databaseMocks.operationRequest.mockResolvedValue({
      channel,
      operationId,
      operationStatus: 'PENDING',
      operationType: 'QUERY_TRACKING',
      providerShipmentId: 'GHN-TEST0001',
      purpose: 'AFTER_SALE_RETURN',
      shipmentId,
      status: 'PENDING_PICKUP',
      storeId,
    });
    const fact = {
      providerShipmentId: 'GHN-TEST0001',
      providerStatus: 'delivering',
      status: 'OUT_FOR_DELIVERY' as const,
    };
    const handler = new ShipmentProviderOperationHandler(SHIPMENT_QUERY_EVENT_TYPE, {} as never, {
      resolve: vi
        .fn()
        .mockReturnValue(provider({ queryShipment: vi.fn().mockResolvedValue(fact) })),
    });
    await handler.handle(message(SHIPMENT_QUERY_EVENT_TYPE));
    expect(databaseMocks.applyFact).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      fact,
      operationId,
      operationType: 'QUERY_TRACKING',
      purpose: 'AFTER_SALE_RETURN',
      shipmentId,
      source: 'QUERY',
    });
  });

  it('does not call the provider again after an operation has succeeded', async () => {
    databaseMocks.operationRequest.mockResolvedValue({
      channel,
      operationId,
      operationStatus: 'SUCCEEDED',
      operationType: 'QUERY_TRACKING',
      providerShipmentId: 'GHN-TEST0001',
      purpose: 'ORDER_OUTBOUND',
      shipmentId,
      status: 'OUT_FOR_DELIVERY',
      storeId,
    });
    const resolve = vi.fn();
    const handler = new ShipmentProviderOperationHandler(SHIPMENT_QUERY_EVENT_TYPE, {} as never, {
      resolve,
    });
    await handler.handle(message(SHIPMENT_QUERY_EVENT_TYPE));
    expect(resolve).not.toHaveBeenCalled();
    expect(databaseMocks.applyFact).not.toHaveBeenCalled();
  });

  it('permanently rejects an orphaned operation without masking it with an impossible update', async () => {
    databaseMocks.operationRequest.mockRejectedValue(
      new ShippingCommandError('SHIPMENT_OPERATION_NOT_FOUND'),
    );
    const resolve = vi.fn();
    const handler = new ShipmentProviderOperationHandler(SHIPMENT_CANCEL_EVENT_TYPE, {} as never, {
      resolve,
    });

    await expect(handler.handle(message(SHIPMENT_CANCEL_EVENT_TYPE))).rejects.toMatchObject({
      code: 'SHIPMENT_OPERATION_NOT_FOUND',
      disposition: 'PERMANENT',
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(databaseMocks.applyFact).not.toHaveBeenCalled();
    expect(databaseMocks.operationError).not.toHaveBeenCalled();
  });

  it('retries a cancel operation while the create worker is still writing the provider reference', async () => {
    databaseMocks.operationRequest.mockRejectedValue(
      new ShippingCommandError('SHIPMENT_PROVIDER_REFERENCE_PENDING'),
    );
    const resolve = vi.fn();
    const handler = new ShipmentProviderOperationHandler(SHIPMENT_CANCEL_EVENT_TYPE, {} as never, {
      resolve,
    });

    await expect(handler.handle(message(SHIPMENT_CANCEL_EVENT_TYPE))).rejects.toMatchObject({
      code: 'SHIPMENT_PROVIDER_REFERENCE_PENDING',
      disposition: 'RETRYABLE',
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(databaseMocks.applyFact).not.toHaveBeenCalled();
    expect(databaseMocks.operationError).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      {
        errorCode: 'SHIPMENT_PROVIDER_REFERENCE_PENDING',
        operationId,
        status: 'PENDING',
      },
    );
  });

  it.each(['AFTER_SALE_RETURN', 'EXCHANGE_OUTBOUND'] as const)(
    'does not reuse the order-outbound create worker for %s',
    async (purpose) => {
      databaseMocks.creationRequest.mockResolvedValue({
        operationId,
        operationStatus: 'PENDING',
        purpose,
        shipmentId,
        status: 'CREATION_PENDING',
        storeId,
      });
      const resolve = vi.fn();
      const handler = new ShipmentCreateRequestedHandler(
        {} as never,
        { resolve },
        { PII_ENCRYPTION_KEY: key },
      );

      await expect(handler.handle(message(SHIPMENT_CREATE_EVENT_TYPE))).rejects.toMatchObject({
        code: 'SHIPMENT_CREATE_PURPOSE_UNSUPPORTED',
        disposition: 'PERMANENT',
      });
      expect(resolve).not.toHaveBeenCalled();
      expect(databaseMocks.shipmentCreated).not.toHaveBeenCalled();
    },
  );

  it('rejects malformed outbox identity before any provider call', async () => {
    const handler = new ShipmentCreateRequestedHandler(
      {} as never,
      { resolve: vi.fn() },
      { PII_ENCRYPTION_KEY: key },
    );
    await expect(
      handler.handle({ ...message(SHIPMENT_CREATE_EVENT_TYPE), aggregateType: 'ORDER' }),
    ).rejects.toBeInstanceOf(OutboxHandlerError);
    expect(databaseMocks.creationRequest).not.toHaveBeenCalled();

    await expect(
      handler.handle({
        ...message(SHIPMENT_CREATE_EVENT_TYPE),
        payload: { operation_id: 'not-a-uuid', shipment_id: shipmentId, store_id: storeId },
      }),
    ).rejects.toBeInstanceOf(OutboxHandlerError);
    expect(databaseMocks.creationRequest).not.toHaveBeenCalled();
  });
});
