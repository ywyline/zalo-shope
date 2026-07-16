CREATE OR REPLACE FUNCTION "app_security"."list_active_stores"()
RETURNS TABLE (id uuid, code varchar, default_locale "Locale")
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT s.id, s.code, s.default_locale
  FROM stores s
  WHERE s.status = 'ACTIVE'
  ORDER BY s.code
$$;

REVOKE ALL ON FUNCTION "app_security"."list_active_stores"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app_security"."list_active_stores"() TO zalo_shop_runtime;
