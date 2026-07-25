-- LOCAL/TEST ONLY. Refuse rollback after any M5 channel or business fact exists.
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
    RAISE EXCEPTION 'M5 amount and permission rollback is unsafe after channel or business facts exist'
      USING ERRCODE = '55000';
  END IF;
END
$$;

ALTER TABLE "payment_attempts"
  DROP CONSTRAINT IF EXISTS "payment_attempts_store_order_amount_currency_fkey";
DROP INDEX IF EXISTS "orders_store_id_id_payable_vnd_currency_m52_key";

GRANT UPDATE ON TABLE
  "store_payment_channels", "store_shipping_channels", "payment_attempts",
  "refunds", "shipments", "shipping_operations"
TO zalo_shop_runtime;
