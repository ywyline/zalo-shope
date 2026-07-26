-- M5.6 trusted fulfillment facts. Existing orders are deliberately not backfilled
-- from mutable SKU data; incomplete historical facts must block shipment creation.

ALTER TABLE "order_items"
  ADD COLUMN "weight_grams" INTEGER,
  ADD COLUMN "length_millimeters" INTEGER,
  ADD COLUMN "width_millimeters" INTEGER,
  ADD COLUMN "height_millimeters" INTEGER,
  ADD CONSTRAINT "order_items_physical_snapshot_check" CHECK (
    (
      "weight_grams" IS NULL
      AND "length_millimeters" IS NULL
      AND "width_millimeters" IS NULL
      AND "height_millimeters" IS NULL
    )
    OR (
      "weight_grams" > 0
      AND "length_millimeters" > 0
      AND "width_millimeters" > 0
      AND "height_millimeters" > 0
    )
  );

CREATE TABLE "warehouse_fulfillment_profiles" (
  "store_id" UUID NOT NULL,
  "warehouse_id" UUID NOT NULL,
  "contact_name_ciphertext" TEXT NOT NULL,
  "phone_ciphertext" TEXT NOT NULL,
  "province_code" VARCHAR(32) NOT NULL,
  "province_name" VARCHAR(160) NOT NULL,
  "district_code" VARCHAR(32) NOT NULL,
  "district_name" VARCHAR(160) NOT NULL,
  "ward_code" VARCHAR(32) NOT NULL,
  "ward_name" VARCHAR(160) NOT NULL,
  "detail_ciphertext" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updated_by_admin_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "warehouse_fulfillment_profiles_pkey" PRIMARY KEY ("store_id", "warehouse_id"),
  CONSTRAINT "warehouse_fulfillment_profiles_shape_check" CHECK (
    "version" >= 1
    AND btrim("contact_name_ciphertext") <> ''
    AND btrim("phone_ciphertext") <> ''
    AND btrim("province_code") <> ''
    AND btrim("province_name") <> ''
    AND btrim("district_code") <> ''
    AND btrim("district_name") <> ''
    AND btrim("ward_code") <> ''
    AND btrim("ward_name") <> ''
    AND btrim("detail_ciphertext") <> ''
  )
);

CREATE INDEX "warehouse_fulfillment_profiles_store_id_enabled_warehouse_id_idx"
  ON "warehouse_fulfillment_profiles"("store_id", "enabled", "warehouse_id");

ALTER TABLE "warehouse_fulfillment_profiles"
  ADD CONSTRAINT "warehouse_fulfillment_profiles_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "warehouse_fulfillment_profiles_store_id_warehouse_id_fkey"
    FOREIGN KEY ("store_id", "warehouse_id")
    REFERENCES "warehouses"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "warehouse_fulfillment_profiles_store_id_province_code_fkey"
    FOREIGN KEY ("store_id", "province_code")
    REFERENCES "administrative_areas"("store_id", "code") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "warehouse_fulfillment_profiles_store_id_district_code_fkey"
    FOREIGN KEY ("store_id", "district_code")
    REFERENCES "administrative_areas"("store_id", "code") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "warehouse_fulfillment_profiles_store_id_ward_code_fkey"
    FOREIGN KEY ("store_id", "ward_code")
    REFERENCES "administrative_areas"("store_id", "code") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "warehouse_fulfillment_profiles_updated_by_admin_id_fkey"
    FOREIGN KEY ("updated_by_admin_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "warehouse_fulfillment_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "warehouse_fulfillment_profiles" FORCE ROW LEVEL SECURITY;
CREATE POLICY "warehouse_fulfillment_profiles_tenant_isolation"
  ON "warehouse_fulfillment_profiles"
  USING ("store_id" = "app_security"."current_store_id"())
  WITH CHECK ("store_id" = "app_security"."current_store_id"());

GRANT SELECT, INSERT, UPDATE ON TABLE "warehouse_fulfillment_profiles" TO zalo_shop_runtime;

-- GHN does not sign callbacks. Resolve one candidate channel by ShopId before
-- tenant RLS context exists, then treat the body only as a query hint.
CREATE OR REPLACE FUNCTION "app_security"."resolve_shipping_callback_channel"(
  requested_shop_id text
)
RETURNS TABLE (
  store_id uuid,
  store_code varchar,
  default_locale "Locale",
  channel_id uuid,
  provider_code "shipping_provider_code",
  provider_environment "integration_environment",
  shop_id varchar,
  token_secret_ref varchar,
  key_version varchar,
  origin_allowlist_key varchar,
  channel_version integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    channel.store_id,
    store.code,
    store.default_locale,
    channel.id,
    channel.provider_code,
    channel.provider_environment,
    channel.shop_id,
    channel.token_secret_ref,
    channel.key_version,
    channel.origin_allowlist_key,
    channel.version
  FROM public.store_shipping_channels AS channel
  JOIN public.stores AS store ON store.id = channel.store_id
  WHERE channel.shop_id = requested_shop_id
    AND channel.provider_code = 'GHN'
    AND store.status = 'ACTIVE'
$$;

REVOKE ALL ON FUNCTION "app_security"."resolve_shipping_callback_channel"(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app_security"."resolve_shipping_callback_channel"(text)
  TO zalo_shop_runtime;
