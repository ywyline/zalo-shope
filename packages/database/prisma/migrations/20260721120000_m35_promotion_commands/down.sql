-- LOCAL/TEST ONLY. Production rollback is forward-fix only after M3 facts exist.
DO $m35_down_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM promotion_operations)
    OR EXISTS (SELECT 1 FROM coupons WHERE new_customer_only)
  THEN
    RAISE EXCEPTION 'M3.5 promotion facts exist; rollback is forbidden, use a forward-fix migration' USING ERRCODE = '55000';
  END IF;
END
$m35_down_guard$;

DROP TABLE IF EXISTS "promotion_operations" CASCADE;
ALTER TABLE "coupons" DROP COLUMN IF EXISTS "new_customer_only";
