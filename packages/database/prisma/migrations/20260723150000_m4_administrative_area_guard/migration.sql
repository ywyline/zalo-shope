-- M4 forward guard: only server-maintained administrative areas may become
-- address and delivery-pricing facts. This migration imports no production data.
CREATE TYPE "administrative_area_level" AS ENUM ('PROVINCE', 'DISTRICT', 'WARD');

CREATE TABLE "administrative_areas" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "store_id" UUID NOT NULL,
  "code" VARCHAR(32) NOT NULL,
  "level" "administrative_area_level" NOT NULL,
  "parent_code" VARCHAR(32),
  "name" VARCHAR(160) NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "source_version" VARCHAR(128) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "administrative_areas_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "administrative_areas_code_check" CHECK (
    "code" ~ '^[a-z0-9][a-z0-9_-]{0,31}$'
    AND btrim("name") <> ''
    AND btrim("source_version") <> ''
  ),
  CONSTRAINT "administrative_areas_parent_shape_check" CHECK (
    ("level" = 'PROVINCE' AND "parent_code" IS NULL)
    OR ("level" IN ('DISTRICT', 'WARD') AND "parent_code" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "administrative_areas_store_id_id_key"
  ON "administrative_areas"("store_id", "id");
CREATE UNIQUE INDEX "administrative_areas_store_id_code_key"
  ON "administrative_areas"("store_id", "code");
CREATE INDEX "administrative_areas_store_id_level_parent_enabled_code_idx"
  ON "administrative_areas"("store_id", "level", "parent_code", "enabled", "code");

ALTER TABLE "administrative_areas"
  ADD CONSTRAINT "administrative_areas_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "administrative_areas_store_id_parent_code_fkey"
    FOREIGN KEY ("store_id", "parent_code")
    REFERENCES "administrative_areas"("store_id", "code") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "app_security"."validate_administrative_area_hierarchy"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  expected_parent_level "administrative_area_level";
  actual_parent_level "administrative_area_level";
BEGIN
  IF NEW."level" = 'PROVINCE' THEN
    RETURN NEW;
  END IF;

  expected_parent_level := CASE NEW."level"
    WHEN 'DISTRICT' THEN 'PROVINCE'::"administrative_area_level"
    WHEN 'WARD' THEN 'DISTRICT'::"administrative_area_level"
  END;

  SELECT area."level"
  INTO actual_parent_level
  FROM "administrative_areas" area
  WHERE area."store_id" = NEW."store_id"
    AND area."code" = NEW."parent_code";

  IF actual_parent_level IS DISTINCT FROM expected_parent_level THEN
    RAISE EXCEPTION 'administrative area hierarchy is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "administrative_areas_hierarchy_guard"
  BEFORE INSERT OR UPDATE OF "store_id", "code", "level", "parent_code"
  ON "administrative_areas"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_administrative_area_hierarchy"();

REVOKE ALL ON FUNCTION "app_security"."validate_administrative_area_hierarchy"() FROM PUBLIC;

ALTER TABLE "administrative_areas" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "administrative_areas" FORCE ROW LEVEL SECURITY;
CREATE POLICY "administrative_areas_store_isolation" ON "administrative_areas"
  USING ("store_id" = "app_security"."current_store_id"())
  WITH CHECK ("store_id" = "app_security"."current_store_id"());

GRANT SELECT ON TABLE "administrative_areas" TO zalo_shop_runtime;
