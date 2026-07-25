import type { ShipmentStatus } from '@zalo-shop/domain';

import type {
  ProviderCallbackResult,
  ProviderEnvironment,
  ProviderRawCallback,
} from './provider-contract';

export type ShippingAddress = Readonly<{
  addressLine: string;
  districtCode: string;
  name: string;
  phoneE164: string;
  provinceCode: string;
  wardCode: string;
}>;

export type ShippingParcel = Readonly<{
  heightCm: number;
  lengthCm: number;
  weightGrams: number;
  widthCm: number;
}>;

export type ShippingProviderFact = Readonly<{
  occurredAt?: Date;
  providerShipmentId: string;
  providerStatus: string;
  status?: ShipmentStatus;
}>;

export type ShippingCallbackHint = Readonly<{
  clientOrderCode?: string;
  providerShipmentId?: string;
  providerStatus?: string;
  shopId?: string;
}>;

export interface ShippingProvider {
  readonly code: string;
  readonly environment: ProviderEnvironment;

  listServices(input: {
    destination: Pick<ShippingAddress, 'districtCode' | 'wardCode'>;
    origin: Pick<ShippingAddress, 'districtCode' | 'wardCode'>;
    storeId: string;
  }): Promise<readonly Readonly<{ code: string; name: string }>[]>;

  quote(input: {
    codAmountVnd: number;
    destination: ShippingAddress;
    origin: ShippingAddress;
    parcel: ShippingParcel;
    serviceCode: string;
    storeId: string;
  }): Promise<
    Readonly<{
      amountVnd: number;
      estimatedDeliveryAt?: Date;
      expiresAt: Date;
      providerQuoteId?: string;
      serviceCode: string;
    }>
  >;

  createShipment(input: {
    clientOrderCode: string;
    codAmountVnd: number;
    destination: ShippingAddress;
    items: readonly Readonly<{ name: string; quantity: number; skuCode: string }>[];
    operationId: string;
    origin: ShippingAddress;
    parcel: ShippingParcel;
    serviceCode: string;
    storeId: string;
  }): Promise<ShippingProviderFact>;

  cancelShipment(input: {
    operationId: string;
    providerShipmentId: string;
    storeId: string;
  }): Promise<ShippingProviderFact>;

  queryShipment(input: {
    providerShipmentId: string;
    storeId: string;
  }): Promise<ShippingProviderFact>;

  getLabel(input: {
    format: 'A5' | 'THERMAL_80X80' | 'THERMAL_52X70';
    providerShipmentId: string;
    storeId: string;
  }): Promise<Readonly<{ expiresAt: Date; url: string }>>;

  parseCallback(
    callback: ProviderRawCallback,
  ): Promise<ProviderCallbackResult<ShippingProviderFact, ShippingCallbackHint>>;
}
