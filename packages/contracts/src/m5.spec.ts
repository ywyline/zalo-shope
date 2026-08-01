import { describe, expect, it } from 'vitest';

import {
  codRemittanceBatchImportSchema,
  paymentAttemptCreateRequestSchema,
  paymentProviderOrderBindRequestSchema,
  paymentSettlementBatchImportSchema,
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
        confirmation_code: 'CREATE_REFUND',
        expected_payment_version: 2,
        reason: 'Customer-approved partial refund',
      }),
    ).toMatchObject({ amount_vnd: 100_000, expected_payment_version: 2 });
    expect(() =>
      refundCreateRequestSchema.parse({
        amount_vnd: 100_000.5,
        confirmation_code: 'CREATE_REFUND',
        expected_payment_version: 2,
        reason: 'Customer-approved partial refund',
      }),
    ).toThrow();
    expect(() =>
      refundCreateRequestSchema.parse({
        amount_vnd: 100_000,
        confirmation_code: 'CREATE_REFUND',
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

describe('P0-M5-005 strict financial reconciliation DTOs', () => {
  const validBatch = {
    batch_reference: 'settlement-2026-08-01-001',
    business_date: '2026-08-01',
    confirmation_code: 'IMPORT_PAYMENT_SETTLEMENT',
    provider_code: 'ZALO_CHECKOUT_ZALOPAY',
    provider_environment: 'SANDBOX',
    reason: 'Finance reviewed the normalized provider statement',
    records: [
      {
        fee_amount_vnd: 2_000,
        gross_amount_vnd: 100_000,
        occurred_at: '2026-08-01T03:00:00.000Z',
        provider_reference: 'payment-provider-reference',
        record_reference: 'statement-line-1',
        type: 'PAYMENT',
      },
    ],
  } as const;

  it('accepts normalized integer-VND settlement records and coerces occurred_at', () => {
    const parsed = paymentSettlementBatchImportSchema.parse(validBatch);
    expect(parsed.records[0]!.occurred_at).toBeInstanceOf(Date);
    expect(parsed.records[0]!.gross_amount_vnd).toBe(100_000);
  });

  it('rejects duplicate record references and payment fees above gross', () => {
    expect(() =>
      paymentSettlementBatchImportSchema.parse({
        ...validBatch,
        records: [validBatch.records[0], validBatch.records[0]],
      }),
    ).toThrow();
    expect(() =>
      paymentSettlementBatchImportSchema.parse({
        ...validBatch,
        records: [{ ...validBatch.records[0], fee_amount_vnd: 100_001 }],
      }),
    ).toThrow();
  });

  it('rejects client business facts, malformed dates and fractional VND', () => {
    expect(() =>
      paymentSettlementBatchImportSchema.parse({
        ...validBatch,
        payment_status: 'SUCCEEDED',
      }),
    ).toThrow();
    expect(() =>
      paymentSettlementBatchImportSchema.parse({ ...validBatch, business_date: '2026-02-30' }),
    ).toThrow();
    expect(() =>
      paymentSettlementBatchImportSchema.parse({
        ...validBatch,
        records: [{ ...validBatch.records[0], gross_amount_vnd: 100_000.5 }],
      }),
    ).toThrow();
  });

  it('accepts normalized GHN COD remittance fees and rejects client shipment state', () => {
    const validCodBatch = {
      batch_reference: 'ghn-remittance-2026-08-01-001',
      business_date: '2026-08-01',
      confirmation_code: 'IMPORT_GHN_COD_SETTLEMENT',
      provider_code: 'GHN',
      provider_environment: 'SANDBOX',
      reason: 'Finance reviewed the normalized GHN remittance statement',
      records: [
        {
          cod_amount_vnd: 120_000,
          cod_fee_vnd: 3_000,
          occurred_at: '2026-08-01T05:00:00.000Z',
          provider_reference: 'GHN-SHIPMENT-001',
          record_reference: 'remittance-line-1',
          shipping_fee_vnd: 22_000,
        },
      ],
    } as const;
    expect(codRemittanceBatchImportSchema.parse(validCodBatch).records[0]).toMatchObject({
      cod_amount_vnd: 120_000,
      cod_fee_vnd: 3_000,
      shipping_fee_vnd: 22_000,
    });
    expect(() =>
      codRemittanceBatchImportSchema.parse({
        ...validCodBatch,
        records: [{ ...validCodBatch.records[0], shipment_status: 'DELIVERED' }],
      }),
    ).toThrow();
    expect(() =>
      codRemittanceBatchImportSchema.parse({
        ...validCodBatch,
        records: [{ ...validCodBatch.records[0], cod_fee_vnd: 0.5 }],
      }),
    ).toThrow();
  });
});
