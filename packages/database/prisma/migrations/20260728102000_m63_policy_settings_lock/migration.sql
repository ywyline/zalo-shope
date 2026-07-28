-- M6.3-A: checkout actors may read and lock only their context store's stable
-- policy setting row. The definer boundary avoids granting member actors a
-- general UPDATE path while preserving Serializable switch coordination.

CREATE OR REPLACE FUNCTION "app_security"."lock_m63_after_sale_setting"()
RETURNS TABLE("enforce_policy_snapshots" boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE scoped_store_id uuid;
BEGIN
  scoped_store_id := app_security.current_store_id();
  IF scoped_store_id IS NULL THEN
    RAISE EXCEPTION 'store context is required to lock after-sale settings'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT settings.enforce_policy_snapshots
  FROM public.store_after_sale_settings settings
  WHERE settings.store_id = scoped_store_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'stable after-sale settings row is missing'
      USING ERRCODE = '23514';
  END IF;
END
$$;

REVOKE ALL ON FUNCTION "app_security"."lock_m63_after_sale_setting"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app_security"."lock_m63_after_sale_setting"()
  TO zalo_shop_runtime;
