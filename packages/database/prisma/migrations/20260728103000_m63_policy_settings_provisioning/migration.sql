-- M6.3-A: stores created after migration deployment must receive the same
-- stable OFF policy-settings row as stores that existed during deployment.

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_policy_settings_actor"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE readiness_changed boolean;
DECLARE system_default_insert boolean;
BEGIN
  readiness_changed := TG_OP = 'INSERT'
    OR NEW.readiness_checked_at IS DISTINCT FROM OLD.readiness_checked_at
    OR NEW.readiness_ready_at IS DISTINCT FROM OLD.readiness_ready_at
    OR NEW.readiness_hash IS DISTINCT FROM OLD.readiness_hash
    OR NEW.readiness_checked_by IS DISTINCT FROM OLD.readiness_checked_by;

  system_default_insert := TG_OP = 'INSERT'
    AND pg_catalog.pg_trigger_depth() > 1
    AND NOT NEW.enforce_policy_snapshots
    AND NEW.default_policy_id IS NULL
    AND NEW.current_version_id IS NULL
    AND NEW.readiness_checked_at IS NULL
    AND NEW.readiness_ready_at IS NULL
    AND NEW.readiness_hash IS NULL
    AND NEW.readiness_checked_by IS NULL
    AND NEW.updated_by IS NULL
    AND NEW.version = 1;

  IF NOT system_default_insert AND (
    pg_catalog.current_setting('app.actor_type', true) <> 'admin'
    OR NEW.store_id IS DISTINCT FROM app_security.current_store_id()
    OR NEW.updated_by IS DISTINCT FROM app_security.current_actor_id()
    OR NOT EXISTS (
      SELECT 1 FROM public.admin_users admin
      WHERE admin.id = app_security.current_actor_id()
    )
    OR (readiness_changed AND (
      ((NEW.readiness_checked_at IS NOT NULL
          OR NEW.readiness_ready_at IS NOT NULL
          OR NEW.readiness_hash IS NOT NULL)
        AND NEW.readiness_checked_by IS DISTINCT FROM app_security.current_actor_id())
      OR ((NEW.readiness_checked_at IS NULL
          AND NEW.readiness_ready_at IS NULL
          AND NEW.readiness_hash IS NULL)
        AND NEW.readiness_checked_by IS NOT NULL)
    ))
  ) THEN
    RAISE EXCEPTION 'after-sale policy settings audit actors must match the current administrator'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION "app_security"."provision_m63_after_sale_setting"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  INSERT INTO public.store_after_sale_settings
    (store_id, enforce_policy_snapshots, version)
  VALUES (NEW.id, false, 1)
  ON CONFLICT (store_id) DO NOTHING;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION "app_security"."provision_m63_after_sale_setting"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "app_security"."provision_m63_after_sale_setting"()
  FROM zalo_shop_runtime;

CREATE TRIGGER "stores_after_sale_setting_provisioner"
  AFTER INSERT ON "stores"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."provision_m63_after_sale_setting"();
