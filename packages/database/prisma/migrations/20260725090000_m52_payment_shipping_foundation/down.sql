-- LOCAL/TEST ONLY. Refuse rollback after any M5 channel, callback or business fact exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "store_payment_channels" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "store_shipping_channels" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "payment_attempts" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "payment_transitions" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "provider_callbacks" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "refunds" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "refund_transitions" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "shipping_quotes" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "shipments" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "shipment_items" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "tracking_events" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "shipping_operations" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "outbox_messages" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "inbox_messages" LIMIT 1)
  THEN
    RAISE EXCEPTION 'M5 rollback is unsafe after channel or business facts exist'
      USING ERRCODE = '55000';
  END IF;
END
$$;

ALTER TABLE "shipments"
  DROP CONSTRAINT IF EXISTS "shipments_store_id_created_operation_id_fkey",
  DROP CONSTRAINT IF EXISTS "shipments_store_id_cancelled_operation_id_fkey";
ALTER TABLE "shipping_operations"
  DROP CONSTRAINT IF EXISTS "shipping_operations_store_id_shipment_id_order_id_fkey";

DROP TABLE IF EXISTS "tracking_events";
DROP TABLE IF EXISTS "shipment_items";
DROP TABLE IF EXISTS "shipping_operations";
DROP TABLE IF EXISTS "shipments";
DROP TABLE IF EXISTS "shipping_quotes";
DROP TABLE IF EXISTS "refund_transitions";
DROP TABLE IF EXISTS "refunds";
DROP TABLE IF EXISTS "payment_transitions";
DROP TABLE IF EXISTS "payment_attempts";
DROP TABLE IF EXISTS "provider_callbacks";
DROP TABLE IF EXISTS "inbox_messages";
DROP TABLE IF EXISTS "outbox_messages";
DROP TABLE IF EXISTS "store_shipping_channels";
DROP TABLE IF EXISTS "store_payment_channels";

DROP INDEX IF EXISTS "order_items_store_id_order_id_id_key";
DROP INDEX IF EXISTS "store_zalo_apps_store_id_environment_mini_app_id_key";

CREATE TYPE "order_payment_status_m4" AS ENUM (
  'PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED'
);
ALTER TABLE "orders"
  ALTER COLUMN "payment_status" TYPE "order_payment_status_m4"
  USING ("payment_status"::text::"order_payment_status_m4");
DROP TYPE "order_payment_status";
ALTER TYPE "order_payment_status_m4" RENAME TO "order_payment_status";

DROP FUNCTION IF EXISTS "app_security"."validate_payment_channel_activation"();
DROP FUNCTION IF EXISTS "app_security"."validate_provider_callback_channel"();
DROP FUNCTION IF EXISTS "app_security"."validate_inbox_channel"();
DROP FUNCTION IF EXISTS "app_security"."enforce_refund_capacity"();
DROP FUNCTION IF EXISTS "app_security"."reject_m5_append_only_mutation"();
DROP FUNCTION IF EXISTS "app_security"."reject_m5_fact_delete"();

DROP TYPE IF EXISTS "inbox_status";
DROP TYPE IF EXISTS "outbox_status";
DROP TYPE IF EXISTS "integration_operation_status";
DROP TYPE IF EXISTS "shipping_operation_type";
DROP TYPE IF EXISTS "tracking_event_source";
DROP TYPE IF EXISTS "shipping_quote_source";
DROP TYPE IF EXISTS "shipment_status";
DROP TYPE IF EXISTS "provider_callback_processing_status";
DROP TYPE IF EXISTS "provider_callback_trust";
DROP TYPE IF EXISTS "callback_signature_status";
DROP TYPE IF EXISTS "integration_channel_kind";
DROP TYPE IF EXISTS "provider_transition_source";
DROP TYPE IF EXISTS "refund_status";
DROP TYPE IF EXISTS "payment_attempt_status";
DROP TYPE IF EXISTS "shipping_provider_code";
DROP TYPE IF EXISTS "payment_provider_code";
DROP TYPE IF EXISTS "integration_channel_status";
DROP TYPE IF EXISTS "integration_environment";
