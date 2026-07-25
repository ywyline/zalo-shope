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

  it('does not map refusal, return or exception to an order completion event', () => {
    expect(orderEventsForShipmentStatus('IN_TRANSIT')).toEqual(['SHIP']);
    expect(orderEventsForShipmentStatus('DELIVERED')).toEqual(['SHIP', 'DELIVER']);
    expect(orderEventsForShipmentStatus('REFUSED')).toEqual([]);
    expect(orderEventsForShipmentStatus('RETURNED')).toEqual([]);
    expect(orderEventsForShipmentStatus('EXCEPTION')).toEqual([]);
  });
});
