import { describe, expect, it } from 'vitest';

import {
  buildZaloCheckoutCallbackMacData,
  buildZaloCheckoutCreateOrderMacData,
  canonicalizeZaloCheckoutOverallMacFields,
  GHN_CALLBACK_TRUST,
  GHN_ENDPOINT_PATHS,
  ghnOrigin,
  mapGhnShippingStatus,
  mapZaloCheckoutCreateRefundResult,
  mapZaloCheckoutPaymentResult,
  mapZaloCheckoutRefundStatusResult,
  zaloPayCheckoutMethod,
  zaloPayCheckoutMethodJson,
} from './index';

describe('M5 Zalo Checkout contract', () => {
  it('selects only the approved ZaloPay method for each environment', () => {
    expect(zaloPayCheckoutMethod('SANDBOX')).toBe('ZALOPAY_SANDBOX');
    expect(zaloPayCheckoutMethod('PRODUCTION')).toBe('ZALOPAY');
    expect(zaloPayCheckoutMethodJson('SANDBOX')).toBe('{"id":"ZALOPAY_SANDBOX","isCustom":false}');
  });

  it('uses the official create-order and callback MAC field order', () => {
    expect(
      buildZaloCheckoutCreateOrderMacData({
        amountVnd: 50_000,
        description: 'Thanh toan ZS-1',
        extraDataJson: '{"attempt_id":"pay-1"}',
        itemsJson: '[{"name":"Serum","quantity":1}]',
        methodJson: '{"id":"ZALOPAY_SANDBOX","isCustom":false}',
      }),
    ).toBe(
      'amount=50000&desc=Thanh toan ZS-1&extradata={"attempt_id":"pay-1"}&item=[{"name":"Serum","quantity":1}]&method={"id":"ZALOPAY_SANDBOX","isCustom":false}',
    );
    expect(
      buildZaloCheckoutCallbackMacData({
        amountVnd: 50_000,
        appId: 'mini-app-1',
        description: 'Thanh toan ZS-1',
        message: 'Payment_successful',
        orderId: 'zmp-order-1',
        resultCode: 1,
        transactionId: 'provider-transaction-1',
      }),
    ).toBe(
      'appId=mini-app-1&amount=50000&description=Thanh toan ZS-1&orderId=zmp-order-1&message=Payment_successful&resultCode=1&transId=provider-transaction-1',
    );
  });

  it('sorts callback data fields for overall MAC and rejects top-level MAC fields', () => {
    expect(
      canonicalizeZaloCheckoutOverallMacFields({
        transId: 'transaction-1',
        amount: 50_000,
        appId: 'mini-app-1',
        extra: { attempt_id: 'pay-1' },
      }),
    ).toBe('amount=50000&appId=mini-app-1&extra={"attempt_id":"pay-1"}&transId=transaction-1');
    expect(() =>
      canonicalizeZaloCheckoutOverallMacFields({
        appId: 'mini-app-1',
        mac: 'top-level-field',
      }),
    ).toThrow('callback data fields only');
  });

  it('fails closed for undocumented payment and refund result codes', () => {
    expect(mapZaloCheckoutPaymentResult(1)).toBe('SUCCEEDED');
    expect(mapZaloCheckoutPaymentResult(0)).toBe('PENDING');
    expect(mapZaloCheckoutPaymentResult(-1)).toBe('FAILED');
    expect(mapZaloCheckoutPaymentResult(99)).toBe('UNKNOWN');
    expect(mapZaloCheckoutCreateRefundResult(1)).toBe('SUCCEEDED');
    expect(mapZaloCheckoutCreateRefundResult(2)).toBe('PENDING');
    expect(mapZaloCheckoutCreateRefundResult(-1)).toBe('FAILED');
    expect(mapZaloCheckoutRefundStatusResult(1)).toBe('SUCCEEDED');
    expect(mapZaloCheckoutRefundStatusResult(2)).toBe('FAILED');
  });
});

describe('M5 GHN contract', () => {
  it('uses the documented sandbox origin and v2 shipment endpoints', () => {
    expect(ghnOrigin('SANDBOX')).toBe('https://dev-online-gateway.ghn.vn');
    expect(GHN_ENDPOINT_PATHS.createShipment).toBe('/shiip/public-api/v2/shipping-order/create');
    expect(GHN_ENDPOINT_PATHS.queryShipment).toBe('/shiip/public-api/v2/shipping-order/detail');
  });

  it('maps documented GHN states without treating delivery failure as refusal', () => {
    expect(mapGhnShippingStatus('ready_to_pick')).toBe('PENDING_PICKUP');
    expect(mapGhnShippingStatus('transporting')).toBe('IN_TRANSIT');
    expect(mapGhnShippingStatus('delivering')).toBe('OUT_FOR_DELIVERY');
    expect(mapGhnShippingStatus('delivered')).toBe('DELIVERED');
    expect(mapGhnShippingStatus('delivery_fail')).toBe('EXCEPTION');
    expect(mapGhnShippingStatus('returning')).toBe('RETURNING');
    expect(mapGhnShippingStatus('returned')).toBe('RETURNED');
    expect(mapGhnShippingStatus('new-undocumented-status')).toBeUndefined();
  });

  it('treats the unsigned GHN webhook as a hint that requires active query', () => {
    expect(GHN_CALLBACK_TRUST).toBe('UNVERIFIED_HINT');
  });
});
