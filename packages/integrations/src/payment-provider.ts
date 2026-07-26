import type { PaymentAttemptStatus, RefundStatus } from '@zalo-shop/domain';

import type {
  ProviderCallbackResult,
  ProviderEnvironment,
  ProviderRawCallback,
} from './provider-contract';

export type PaymentProviderStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN';

export type RefundProviderStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';

export type PaymentProviderFact = Readonly<{
  amountVnd: number;
  attemptId: string;
  currency: 'VND';
  occurredAt?: Date;
  orderId: string;
  providerOrderId: string;
  providerStatus: string;
  providerTransactionId?: string;
  status: PaymentProviderStatus;
  storeId: string;
}>;

export type RefundProviderFact = Readonly<{
  amountVnd: number;
  occurredAt?: Date;
  providerRefundId?: string;
  providerStatus: string;
  status: RefundProviderStatus;
}>;

export type ZaloCheckoutLaunchAction = Readonly<{
  expiresAt: Date;
  kind: 'ZALO_CHECKOUT_CREATE_ORDER';
  payload: Readonly<{
    amount: number;
    desc: string;
    extradata: string;
    item: readonly Readonly<{ amount: number; id: string }>[];
    mac: string;
    method: string;
  }>;
}>;

export type PaymentLaunchAction = ZaloCheckoutLaunchAction;

export interface PaymentProvider {
  readonly code: string;
  readonly environment: ProviderEnvironment;

  createPayment(input: {
    amountVnd: number;
    attemptId: string;
    currency: 'VND';
    description: string;
    expiresAt: Date;
    items: readonly Readonly<{
      amountVnd: number;
      name: string;
      quantity: number;
      skuCode: string;
    }>[];
    orderId: string;
    publicOrderNumber: string;
    storeId: string;
  }): Promise<
    Readonly<{
      launchAction: PaymentLaunchAction;
      providerOrderId?: string;
      providerStatus?: string;
    }>
  >;

  queryPayment(input: { providerOrderId: string; storeId: string }): Promise<PaymentProviderFact>;

  parseCallback(
    callback: ProviderRawCallback,
  ): Promise<ProviderCallbackResult<PaymentProviderFact>>;

  cancelPayment?(input: { providerOrderId: string; storeId: string }): Promise<PaymentProviderFact>;

  createRefund(input: {
    amountVnd: number;
    description: string;
    paymentProviderTransactionId: string;
    publicRefundNumber: string;
    refundId: string;
    storeId: string;
  }): Promise<RefundProviderFact>;

  queryRefund(input: {
    amountVnd: number;
    providerRefundId: string;
    storeId: string;
  }): Promise<RefundProviderFact>;

  listSettlementRecords?(input: {
    businessDate: string;
    cursor?: string;
    storeId: string;
  }): Promise<
    Readonly<{
      nextCursor?: string;
      records: readonly Readonly<{
        amountVnd: number;
        providerTransactionId: string;
        settledAt: Date;
        type: 'PAYMENT' | 'REFUND';
      }>[];
    }>
  >;
}

export type PersistedPaymentAttempt = Readonly<{
  id: string;
  status: PaymentAttemptStatus;
}>;

export type PersistedRefund = Readonly<{
  id: string;
  status: RefundStatus;
}>;
