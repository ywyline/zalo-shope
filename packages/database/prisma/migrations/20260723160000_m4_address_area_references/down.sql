-- LOCAL/TEST ONLY. Refuse rollback once any M4 address or order fact exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "orders" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "addresses" LIMIT 1)
  THEN
    RAISE EXCEPTION 'M4 address-area reference rollback is unsafe after business facts exist'
      USING ERRCODE = '55000';
  END IF;
END
$$;

ALTER TABLE "addresses"
  DROP CONSTRAINT IF EXISTS "addresses_store_id_ward_code_fkey",
  DROP CONSTRAINT IF EXISTS "addresses_store_id_district_code_fkey",
  DROP CONSTRAINT IF EXISTS "addresses_store_id_province_code_fkey";
