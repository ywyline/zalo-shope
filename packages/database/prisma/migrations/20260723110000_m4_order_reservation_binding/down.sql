DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "orders" WHERE "reservation_id" IS NOT NULL LIMIT 1) THEN
    RAISE EXCEPTION 'M4 reservation binding rollback is unsafe after orders exist' USING ERRCODE = '55000';
  END IF;
END
$$;

ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_store_id_reservation_id_fkey";
DROP INDEX IF EXISTS "orders_store_id_reservation_id_key";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "reservation_id";
