import { describe, expect, it, vi } from 'vitest';

import { createStoreContext, type ShipmentPurpose } from '@zalo-shop/domain';

import { applyShippingProviderFact } from './shipping-primitives';

const storeId = '10000000-0000-4000-8000-000000000001';
const orderId = '30000000-0000-4000-8000-000000000001';
const shipmentId = '50000000-0000-4000-8000-000000000001';
const operationId = '60000000-0000-4000-8000-000000000001';

function fixture(purpose: ShipmentPurpose) {
  const shipment = {
    clientOrderCode: 'SHP-M63-PURPOSE',
    deliveredAt: null,
    id: shipmentId,
    order: { status: 'PENDING_FULFILLMENT' },
    orderId,
    pickedUpAt: null,
    providerCreatedAt: new Date('2026-07-28T00:00:00.000Z'),
    providerShipmentId: 'GHN-M63-PURPOSE',
    publicShipmentNumber: 'SHP-M63-PURPOSE',
    purpose,
    returnedAt: null,
    status: 'PENDING_PICKUP',
    version: 1,
  } as const;
  const updatedShipment = {
    ...shipment,
    deliveredAt: new Date('2026-07-28T01:00:00.000Z'),
    status: 'DELIVERED' as const,
    version: 2,
  };
  const transaction = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi.fn().mockResolvedValue([{ id: orderId }]),
    order: { update: vi.fn().mockResolvedValue(undefined) },
    orderTransition: { create: vi.fn().mockResolvedValue(undefined) },
    shipment: {
      findFirst: vi.fn().mockResolvedValueOnce({ orderId }).mockResolvedValueOnce(shipment),
      update: vi.fn().mockResolvedValue(updatedShipment),
    },
    shippingOperation: {
      findFirst: vi.fn().mockResolvedValue({
        id: operationId,
        operationType: 'QUERY_TRACKING',
        status: 'PENDING',
      }),
      update: vi.fn().mockResolvedValue({ id: operationId, status: 'SUCCEEDED' }),
    },
    trackingEvent: {
      create: vi.fn().mockResolvedValue(undefined),
      findUnique: vi.fn().mockResolvedValue(null),
    },
  };
  const client = {
    $transaction: vi.fn((callback: (value: typeof transaction) => unknown) =>
      callback(transaction),
    ),
  };
  const context = createStoreContext({
    actor: { id: '20000000-0000-4000-8000-000000000001', type: 'admin' },
    correlationId: 'm63-shipment-purpose-unit',
    locale: 'vi',
    storeCode: 'beauty-local',
    storeId,
  });
  return { client, context, transaction };
}

describe('shipping provider fact purpose guard', () => {
  it.each(['AFTER_SALE_RETURN', 'EXCHANGE_OUTBOUND'] as const)(
    'persists %s tracking facts without advancing the original order',
    async (purpose) => {
      const { client, context, transaction } = fixture(purpose);

      await expect(
        applyShippingProviderFact(client as never, context, {
          fact: {
            occurredAt: new Date('2026-07-28T01:00:00.000Z'),
            providerShipmentId: 'GHN-M63-PURPOSE',
            providerStatus: 'delivered',
            status: 'DELIVERED',
          },
          operationId,
          operationType: 'QUERY_TRACKING',
          purpose,
          shipmentId,
          source: 'QUERY',
        }),
      ).resolves.toMatchObject({ status: 'DELIVERED' });

      expect(transaction.shipment.update).toHaveBeenCalledOnce();
      expect(transaction.trackingEvent.create).toHaveBeenCalledOnce();
      expect(transaction.order.update).not.toHaveBeenCalled();
      expect(transaction.orderTransition.create).not.toHaveBeenCalled();
    },
  );

  it('preserves ORDER_OUTBOUND SHIP and DELIVER projection behavior', async () => {
    const { client, context, transaction } = fixture('ORDER_OUTBOUND');

    await applyShippingProviderFact(client as never, context, {
      fact: {
        providerShipmentId: 'GHN-M63-PURPOSE',
        providerStatus: 'delivered',
        status: 'DELIVERED',
      },
      operationId,
      operationType: 'QUERY_TRACKING',
      purpose: 'ORDER_OUTBOUND',
      shipmentId,
      source: 'QUERY',
    });

    expect(transaction.order.update).toHaveBeenCalledTimes(2);
    expect(transaction.orderTransition.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ data: expect.objectContaining({ event: 'SHIP' }) }),
    );
    expect(transaction.orderTransition.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ data: expect.objectContaining({ event: 'DELIVER' }) }),
    );
  });
});
