-- LOCAL/TEST ONLY. Refuse rollback once any M4 address or order fact exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "orders" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "addresses" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "order_items" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "order_snapshots" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "order_transitions" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "idempotency_records" LIMIT 1)
  THEN
    RAISE EXCEPTION 'M4 administrative-area rollback is unsafe after business facts exist'
      USING ERRCODE = '55000';
  END IF;
END
$$;

DROP TRIGGER IF EXISTS "administrative_areas_hierarchy_guard" ON "administrative_areas";
DROP FUNCTION IF EXISTS "app_security"."validate_administrative_area_hierarchy"();
DROP TABLE IF EXISTS "administrative_areas";
DROP TYPE IF EXISTS "administrative_area_level";
