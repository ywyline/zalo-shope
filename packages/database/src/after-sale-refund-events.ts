export const AFTER_SALE_REFUND_SYNC_EVENT_TYPE = 'after-sale.refund.sync';
export const AFTER_SALE_REFUND_SYNC_EVENT_VERSION = 1;

export type AfterSaleRefundSyncPayload = Readonly<{
  refund_id: string;
  refund_version: number;
  store_id: string;
}>;
