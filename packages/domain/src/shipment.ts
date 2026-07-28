import type { OrderEvent } from './order';

export const SHIPMENT_STATUSES = [
  'CREATION_PENDING',
  'PENDING_PICKUP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'REFUSED',
  'RETURNING',
  'RETURNED',
  'EXCEPTION',
  'CANCELLED',
  'REVIEW_REQUIRED',
] as const;

export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export const SHIPMENT_PURPOSES = [
  'ORDER_OUTBOUND',
  'AFTER_SALE_RETURN',
  'EXCHANGE_OUTBOUND',
] as const;

export type ShipmentPurpose = (typeof SHIPMENT_PURPOSES)[number];

export class ShipmentStateError extends Error {
  public constructor(public readonly code: 'SHIPMENT_STATE_CONFLICT') {
    super(code);
    this.name = 'ShipmentStateError';
  }
}

const allowedTargets: Readonly<Record<ShipmentStatus, ReadonlySet<ShipmentStatus>>> = {
  CREATION_PENDING: new Set(['PENDING_PICKUP', 'CANCELLED', 'EXCEPTION', 'REVIEW_REQUIRED']),
  PENDING_PICKUP: new Set([
    'IN_TRANSIT',
    'OUT_FOR_DELIVERY',
    'DELIVERED',
    'CANCELLED',
    'EXCEPTION',
    'RETURNING',
    'RETURNED',
    'REVIEW_REQUIRED',
  ]),
  IN_TRANSIT: new Set([
    'OUT_FOR_DELIVERY',
    'DELIVERED',
    'REFUSED',
    'RETURNING',
    'RETURNED',
    'EXCEPTION',
    'REVIEW_REQUIRED',
  ]),
  OUT_FOR_DELIVERY: new Set([
    'DELIVERED',
    'REFUSED',
    'RETURNING',
    'RETURNED',
    'EXCEPTION',
    'REVIEW_REQUIRED',
  ]),
  DELIVERED: new Set(['REVIEW_REQUIRED']),
  REFUSED: new Set(['RETURNING', 'RETURNED', 'EXCEPTION', 'REVIEW_REQUIRED']),
  RETURNING: new Set(['RETURNED', 'EXCEPTION', 'REVIEW_REQUIRED']),
  RETURNED: new Set(['REVIEW_REQUIRED']),
  EXCEPTION: new Set([
    'PENDING_PICKUP',
    'IN_TRANSIT',
    'OUT_FOR_DELIVERY',
    'DELIVERED',
    'REFUSED',
    'RETURNING',
    'RETURNED',
    'CANCELLED',
    'REVIEW_REQUIRED',
  ]),
  CANCELLED: new Set(['REVIEW_REQUIRED']),
  REVIEW_REQUIRED: new Set(),
};

export function transitionShipmentStatus(
  current: ShipmentStatus,
  target: ShipmentStatus,
): ShipmentStatus {
  if (current === target) return current;
  if (!allowedTargets[current].has(target)) {
    throw new ShipmentStateError('SHIPMENT_STATE_CONFLICT');
  }
  return target;
}

export function orderEventsForShipmentStatus(
  purpose: ShipmentPurpose,
  status: ShipmentStatus,
): readonly OrderEvent[] {
  if (purpose !== 'ORDER_OUTBOUND') return [];
  switch (status) {
    case 'IN_TRANSIT':
    case 'OUT_FOR_DELIVERY':
      return ['SHIP'];
    case 'DELIVERED':
      return ['SHIP', 'DELIVER'];
    default:
      return [];
  }
}
