-- M6.3-A: every store needs a stable OFF row so checkout can lock it and
-- serialize against an enforcement switch that commits while checkout is in flight.
-- Keep the temporary trigger suspension atomic even if the backfill fails.

BEGIN;

ALTER TABLE "store_after_sale_settings"
  DISABLE TRIGGER "store_after_sale_settings_actor_guard";

INSERT INTO "store_after_sale_settings"
  ("store_id", "enforce_policy_snapshots", "version")
SELECT "id", false, 1
FROM "stores"
ON CONFLICT ("store_id") DO NOTHING;

ALTER TABLE "store_after_sale_settings"
  ENABLE TRIGGER "store_after_sale_settings_actor_guard";

COMMIT;
