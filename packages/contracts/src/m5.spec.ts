import { describe, expect, it } from 'vitest';

import {
  paymentAttemptCreateRequestSchema,
  paymentProviderOrderBindRequestSchema,
  refundCreateRequestSchema,
  shipmentCreateRequestSchema,
  shippingQuoteRequestSchema,
} from './index';

const orderId = 'fa4c1d0d-c0c2-4861-825e-c189d3c9526f';

describe('M5 strict payment DTOs', () => {
  it('accepts an empty payment retry command and rejects client payment facts', () => {
    expect(paymentAttemptCreateRequestSchema.parse({})).toEqual({});
    expect(() =>
      paymentAttemptCreateRequestSchema.parse({ amount_vnd: 100_000, status: 'SUCCEEDED' }),
    ).toThrow();
  });

  it('requires an integer refund amount, optimistic version and audit reason', () => {
    expect(
      refundCreateRequestSchema.parse({
        amount_vnd: 100_000,
        expected_payment_version: 2,
        reason: 'Customer-approved partial refund',
      }),
    ).toMatchObject({ amount_vnd: 100_000, expected_payment_version: 2 });
    expect(() =>
      refundCreateRequestSchema.parse({
        amount_vnd: 100_000.5,
        expected_payment_version: 2,
        reason: 'Customer-approved partial refund',
      }),
    ).toThrow();
    expect(() =>
      refundCreateRequestSchema.parse({
        amount_vnd: 100_000,
        expected_payment_version: 2,
        provider_refund_id: 'client-controlled',
        reason: 'Customer-approved partial refund',
      }),
    ).toThrow();
  });

  it('accepts only a launch token and provider order hint for active query binding', () => {
    expect(
      paymentProviderOrderBindRequestSchema.parse({
        launch_token: 'a'.repeat(32),
        provider_order_id: 'checkout-order-1',
      }),
    ).toMatchObject({ provider_order_id: 'checkout-order-1' });
    expect(() =>
      paymentProviderOrderBindRequestSchema.parse({
        amount_vnd: 100_000,
        launch_token: 'a'.repeat(32),
        provider_order_id: 'checkout-order-1',
        status: 'SUCCEEDED',
      }),
    ).toThrow();
  });
});

describe('M5 strict shipment DTOs', () => {
  it('allows only an order and optional internal service code for quote requests', () => {
    expect(shippingQuoteRequestSchema.parse({ order_id: orderId })).toEqual({
      order_id: orderId,
    });
    expect(() =>
      shippingQuoteRequestSchema.parse({ order_id: orderId, shipping_fee_vnd: 30_000 }),
    ).toThrow();
  });

  it('rejects client supplier IDs, status and COD amounts when creating a shipment', () => {
    expect(
      shipmentCreateRequestSchema.parse({
        confirmation_code: 'CREATE_SHIPMENT',
        expected_order_version: 3,
        inspection_policy: 'NO_INSPECTION',
        reason: 'Warehouse handoff approved',
        service_code: 'GHN_STANDARD',
      }),
    ).toMatchObject({ service_code: 'GHN_STANDARD' });
    expect(() =>
      shipmentCreateRequestSchema.parse({
        cod_amount_vnd: 500_000,
        confirmation_code: 'CREATE_SHIPMENT',
        expected_order_version: 3,
        inspection_policy: 'NO_INSPECTION',
        provider_shipment_id: 'client-controlled',
        reason: 'Warehouse handoff approved',
        service_code: 'GHN_STANDARD',
        status: 'DELIVERED',
      }),
    ).toThrow();
  });
});
