-- Local/test-only rollback. Dropping the checkout serialization function while
-- policy runtime facts remain would leave the current application unable to
-- preserve the reviewed enforcement boundary.
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
    RAISE EXCEPTION 'M6.3 policy settings-lock rollback requires an empty local/test policy scope'
      USING ERRCODE = '55000';
  END IF;
END
$$;

REVOKE ALL ON FUNCTION "app_security"."lock_m63_after_sale_setting"()
  FROM zalo_shop_runtime;
DROP FUNCTION "app_security"."lock_m63_after_sale_setting"();
