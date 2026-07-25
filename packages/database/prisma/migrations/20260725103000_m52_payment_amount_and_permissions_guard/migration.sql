-- M5.2 forward hardening: bind payment amounts to immutable order totals and
-- reduce runtime updates to the columns required by reviewed state changes.
CREATE UNIQUE INDEX "orders_store_id_id_payable_vnd_currency_m52_key"
  ON "orders"("store_id", "id", "payable_vnd", "currency");

ALTER TABLE "payment_attempts"
  ADD CONSTRAINT "payment_attempts_store_order_amount_currency_fkey"
  FOREIGN KEY ("store_id", "order_id", "amount_vnd", "currency")
  REFERENCES "orders"("store_id", "id", "payable_vnd", "currency")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

REVOKE UPDATE ON TABLE
  "store_payment_channels", "store_shipping_channels", "payment_attempts",
  "refunds", "shipments", "shipping_operations"
FROM zalo_shop_runtime;

GRANT UPDATE (
  "merchant_reference", "private_key_secret_ref", "secret_fingerprint", "key_version",
  "status", "payment_window_seconds", "version", "updated_at"
) ON "store_payment_channels" TO zalo_shop_runtime;

GRANT UPDATE (
  "token_secret_ref", "secret_fingerprint", "key_version", "status",
  "origin_allowlist_key", "default_service_code", "webhook_path_token_hash",
  "version", "updated_at"
) ON "store_shipping_channels" TO zalo_shop_runtime;

GRANT UPDATE (
  "status", "version", "launch_nonce_hash", "launch_payload_hash", "provider_order_id",
  "provider_transaction_id", "provider_status", "provider_occurred_at", "succeeded_at",
  "failed_at", "cancelled_at", "expired_at", "review_required_at", "updated_at"
) ON "payment_attempts" TO zalo_shop_runtime;

GRANT UPDATE (
  "status", "version", "provider_refund_id", "provider_status", "succeeded_at",
  "failed_at", "review_required_at", "updated_at"
) ON "refunds" TO zalo_shop_runtime;

GRANT UPDATE (
  "status", "version", "provider_shipment_id", "provider_service_id",
  "provider_service_type_id", "label_metadata", "created_operation_id",
  "cancelled_operation_id", "provider_created_at", "picked_up_at", "delivered_at",
  "returned_at", "updated_at"
) ON "shipments" TO zalo_shop_runtime;

GRANT UPDATE (
  "shipment_id", "status", "attempt_count", "next_attempt_at", "error_code",
  "version", "updated_at"
) ON "shipping_operations" TO zalo_shop_runtime;
