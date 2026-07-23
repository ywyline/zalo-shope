-- LOCAL/TEST ONLY. Refuse rollback once any M4 business fact exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "orders" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "addresses" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "order_items" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "order_snapshots" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "order_transitions" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "idempotency_records" LIMIT 1)
  THEN
    RAISE EXCEPTION 'M4 rollback is unsafe after business facts exist' USING ERRCODE = '55000';
  END IF;
END
$$;

DROP TRIGGER IF EXISTS "order_items_append_only" ON "order_items";
DROP TRIGGER IF EXISTS "order_snapshots_append_only" ON "order_snapshots";
DROP TRIGGER IF EXISTS "order_transitions_append_only" ON "order_transitions";
DROP FUNCTION IF EXISTS "app_security"."reject_m4_fact_mutation"();

DROP TABLE IF EXISTS "idempotency_records";
DROP TABLE IF EXISTS "order_transitions";
DROP TABLE IF EXISTS "order_snapshots";
DROP TABLE IF EXISTS "order_items";
DROP TABLE IF EXISTS "orders";
DROP TABLE IF EXISTS "addresses";
DROP TABLE IF EXISTS "store_delivery_policies";

DROP TYPE IF EXISTS "order_snapshot_type";
DROP TYPE IF EXISTS "order_payment_status";
DROP TYPE IF EXISTS "order_payment_method";
DROP TYPE IF EXISTS "order_status";
DROP TYPE IF EXISTS "address_status";
