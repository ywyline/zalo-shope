import type { ShipmentStatus } from '@zalo-shop/domain';

import type { ProviderCallbackTrust, ProviderEnvironment } from './provider-contract';

export const GHN_DOCUMENT_RETRIEVED_AT = '2026-07-24';
export const GHN_CALLBACK_TRUST: ProviderCallbackTrust = 'UNVERIFIED_HINT';

export const GHN_ORIGINS = {
  SANDBOX: 'https://dev-online-gateway.ghn.vn',
  PRODUCTION: 'https://online-gateway.ghn.vn',
} as const;

export const GHN_ENDPOINT_PATHS = {
  availableServices: '/shiip/public-api/v2/shipping-order/available-services',
  cancelShipment: '/shiip/public-api/v2/switch-status/cancel',
  createShipment: '/shiip/public-api/v2/shipping-order/create',
  labelToken: '/shiip/public-api/v2/a5/gen-token',
  leadTime: '/shiip/public-api/v2/shipping-order/leadtime',
  queryShipment: '/shiip/public-api/v2/shipping-order/detail',
  quote: '/shiip/public-api/v2/shipping-order/fee',
} as const;

export function ghnOrigin(environment: ProviderEnvironment): string {
  return GHN_ORIGINS[environment];
}

const ghnStatusMap: Readonly<Record<string, ShipmentStatus>> = {
  ready_to_pick: 'PENDING_PICKUP',
  picking: 'PENDING_PICKUP',
  money_collect_picking: 'PENDING_PICKUP',
  picked: 'IN_TRANSIT',
  storing: 'IN_TRANSIT',
  transporting: 'IN_TRANSIT',
  sorting: 'IN_TRANSIT',
  delivering: 'OUT_FOR_DELIVERY',
  money_collect_delivering: 'OUT_FOR_DELIVERY',
  delivered: 'DELIVERED',
  delivery_fail: 'EXCEPTION',
  waiting_to_return: 'EXCEPTION',
  return: 'RETURNING',
  return_transporting: 'RETURNING',
  return_sorting: 'RETURNING',
  returning: 'RETURNING',
  return_fail: 'EXCEPTION',
  returned: 'RETURNED',
  exception: 'EXCEPTION',
  damage: 'EXCEPTION',
  lost: 'EXCEPTION',
  cancel: 'CANCELLED',
};

export function mapGhnShippingStatus(providerStatus: string): ShipmentStatus | undefined {
  return ghnStatusMap[providerStatus.trim().toLowerCase()];
}
