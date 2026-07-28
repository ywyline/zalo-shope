-- Local/test-only rollback. Policy or snapshot facts make removing the stable
-- serialization row unsafe; production environments must use a forward fix.
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
    RAISE EXCEPTION 'M6.3 policy settings-row rollback requires an empty local/test policy scope'
      USING ERRCODE = '55000';
  END IF;
END
$$;

DELETE FROM "store_after_sale_settings";
