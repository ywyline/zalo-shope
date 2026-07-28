import { describe, expect, it } from 'vitest';

import { orderEventsForShipmentStatus, transitionShipmentStatus } from './shipment';

describe('M5 shipment state machine', () => {
  it('accepts skipped provider milestones without inventing intermediate provider facts', () => {
    expect(transitionShipmentStatus('PENDING_PICKUP', 'OUT_FOR_DELIVERY')).toBe('OUT_FOR_DELIVERY');
    expect(transitionShipmentStatus('PENDING_PICKUP', 'DELIVERED')).toBe('DELIVERED');
  });

  it('is idempotent for duplicate normalized facts and rejects terminal regression', () => {
    expect(transitionShipmentStatus('IN_TRANSIT', 'IN_TRANSIT')).toBe('IN_TRANSIT');
    expect(() => transitionShipmentStatus('DELIVERED', 'IN_TRANSIT')).toThrow(
      'SHIPMENT_STATE_CONFLICT',
    );
    expect(() => transitionShipmentStatus('RETURNED', 'OUT_FOR_DELIVERY')).toThrow(
      'SHIPMENT_STATE_CONFLICT',
    );
  });

  it('maps only order outbound provider facts to original-order events', () => {
    expect(orderEventsForShipmentStatus('ORDER_OUTBOUND', 'IN_TRANSIT')).toEqual(['SHIP']);
    expect(orderEventsForShipmentStatus('ORDER_OUTBOUND', 'DELIVERED')).toEqual([
      'SHIP',
      'DELIVER',
    ]);
    expect(orderEventsForShipmentStatus('ORDER_OUTBOUND', 'REFUSED')).toEqual([]);
    expect(orderEventsForShipmentStatus('ORDER_OUTBOUND', 'RETURNED')).toEqual([]);
    expect(orderEventsForShipmentStatus('ORDER_OUTBOUND', 'EXCEPTION')).toEqual([]);

    for (const purpose of ['AFTER_SALE_RETURN', 'EXCHANGE_OUTBOUND'] as const) {
      expect(orderEventsForShipmentStatus(purpose, 'IN_TRANSIT')).toEqual([]);
      expect(orderEventsForShipmentStatus(purpose, 'OUT_FOR_DELIVERY')).toEqual([]);
      expect(orderEventsForShipmentStatus(purpose, 'DELIVERED')).toEqual([]);
    }
  });
});
