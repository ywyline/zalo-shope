-- LOCAL/TEST ONLY. Refuse rollback after any M5.6 trusted fulfillment fact exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "warehouse_fulfillment_profiles" LIMIT 1)
     OR EXISTS (
       SELECT 1
       FROM "store_shipping_channels"
       WHERE "provider_code" = 'GHN'
         AND btrim("token_secret_ref") <> ''
       LIMIT 1
     )
     OR EXISTS (
       SELECT 1
       FROM "order_items"
       WHERE "weight_grams" IS NOT NULL
          OR "length_millimeters" IS NOT NULL
          OR "width_millimeters" IS NOT NULL
          OR "height_millimeters" IS NOT NULL
       LIMIT 1
     )
     OR EXISTS (SELECT 1 FROM "shipments" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "shipping_operations" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "tracking_events" LIMIT 1)
  THEN
    RAISE EXCEPTION 'M5.6 fulfillment-fact rollback is unsafe after business facts exist'
      USING ERRCODE = '55000';
  END IF;
END
$$;

DROP FUNCTION IF EXISTS "app_security"."resolve_shipping_callback_channel"(text);
DROP TABLE IF EXISTS "warehouse_fulfillment_profiles";

ALTER TABLE "order_items"
  DROP CONSTRAINT IF EXISTS "order_items_physical_snapshot_check",
  DROP COLUMN IF EXISTS "height_millimeters",
  DROP COLUMN IF EXISTS "width_millimeters",
  DROP COLUMN IF EXISTS "length_millimeters",
  DROP COLUMN IF EXISTS "weight_grams";
