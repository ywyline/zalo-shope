-- Local/test-only rollback. Existing policy runtime facts require a forward
-- fix; only an empty policy scope may remove automatic OFF-row provisioning.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "after_sale_policies" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "order_item_after_sale_policy_snapshots" LIMIT 1)
     OR EXISTS (
       SELECT 1
       FROM "store_after_sale_settings"
       WHERE "enforce_policy_snapshots"
          OR "default_policy_id" IS NOT NULL
          OR "current_version_id" IS NOT NULL
          OR "readiness_checked_at" IS NOT NULL
          OR "readiness_ready_at" IS NOT NULL
          OR "readiness_hash" IS NOT NULL
          OR "readiness_checked_by" IS NOT NULL
          OR "updated_by" IS NOT NULL
          OR "version" <> 1
       LIMIT 1
     )
  THEN
    RAISE EXCEPTION 'M6.3 policy settings-provisioning rollback requires an empty local/test policy scope'
      USING ERRCODE = '55000';
  END IF;
END
$$;

DROP TRIGGER "stores_after_sale_setting_provisioner" ON "stores";
DROP FUNCTION "app_security"."provision_m63_after_sale_setting"();

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_policy_settings_actor"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE readiness_changed boolean;
BEGIN
  readiness_changed := TG_OP = 'INSERT'
    OR NEW.readiness_checked_at IS DISTINCT FROM OLD.readiness_checked_at
    OR NEW.readiness_ready_at IS DISTINCT FROM OLD.readiness_ready_at
    OR NEW.readiness_hash IS DISTINCT FROM OLD.readiness_hash
    OR NEW.readiness_checked_by IS DISTINCT FROM OLD.readiness_checked_by;
  IF pg_catalog.current_setting('app.actor_type', true) <> 'admin'
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
  THEN
    RAISE EXCEPTION 'after-sale policy settings audit actors must match the current administrator'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
