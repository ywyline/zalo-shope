-- M4: addresses, checkout, COD orders and immutable order facts.
-- No historical order, payment or shipping facts are fabricated here.

CREATE TYPE "address_status" AS ENUM ('ACTIVE', 'DISABLED');
CREATE TYPE "order_status" AS ENUM (
  'PENDING_PAYMENT', 'PENDING_CONFIRMATION', 'CONFIRMED', 'PENDING_FULFILLMENT',
  'SHIPPED', 'DELIVERED', 'COMPLETED', 'CANCELLED', 'CLOSED'
);
CREATE TYPE "order_payment_method" AS ENUM ('COD', 'ONLINE');
CREATE TYPE "order_payment_status" AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED');
CREATE TYPE "order_snapshot_type" AS ENUM ('ADDRESS', 'PRICING', 'DELIVERY_POLICY', 'COUPON');

CREATE TABLE "store_delivery_policies" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "store_id" UUID NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "flat_shipping_fee_vnd" BIGINT NOT NULL,
  "free_shipping_threshold_vnd" BIGINT,
  "remote_surcharge_vnd" BIGINT NOT NULL DEFAULT 0,
  "remote_province_codes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "cod_enabled" BOOLEAN NOT NULL DEFAULT true,
  "cod_max_amount_vnd" BIGINT,
  "updated_by_admin_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "store_delivery_policies_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "addresses" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "store_id" UUID NOT NULL,
  "member_id" UUID NOT NULL,
  "recipient_name_ciphertext" TEXT NOT NULL,
  "phone_hash" VARCHAR(128) NOT NULL,
  "phone_ciphertext" TEXT NOT NULL,
  "province_code" VARCHAR(32) NOT NULL,
  "province_name" VARCHAR(160) NOT NULL,
  "district_code" VARCHAR(32) NOT NULL,
  "district_name" VARCHAR(160) NOT NULL,
  "ward_code" VARCHAR(32) NOT NULL,
  "ward_name" VARCHAR(160) NOT NULL,
  "detail_ciphertext" TEXT NOT NULL,
  "label" VARCHAR(64),
  "is_default" BOOLEAN NOT NULL DEFAULT false,
  "status" "address_status" NOT NULL DEFAULT 'ACTIVE',
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "addresses_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "orders" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "store_id" UUID NOT NULL,
  "member_id" UUID NOT NULL,
  "cart_id" UUID,
  "address_id" UUID,
  "reservation_id" UUID,
  "order_number" VARCHAR(40) NOT NULL,
  "status" "order_status" NOT NULL DEFAULT 'PENDING_CONFIRMATION',
  "payment_method" "order_payment_method" NOT NULL,
  "payment_status" "order_payment_status" NOT NULL,
  "currency" CHAR(3) NOT NULL DEFAULT 'VND',
  "base_subtotal_vnd" BIGINT NOT NULL,
  "item_discount_vnd" BIGINT NOT NULL DEFAULT 0,
  "coupon_discount_vnd" BIGINT NOT NULL DEFAULT 0,
  "order_discount_vnd" BIGINT NOT NULL DEFAULT 0,
  "shipping_fee_vnd" BIGINT NOT NULL,
  "remote_surcharge_vnd" BIGINT NOT NULL DEFAULT 0,
  "shipping_discount_vnd" BIGINT NOT NULL DEFAULT 0,
  "payable_vnd" BIGINT NOT NULL,
  "quote_hash" CHAR(64) NOT NULL,
  "cancellation_reason" VARCHAR(500),
  "admin_note" VARCHAR(2000),
  "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "confirmed_at" TIMESTAMPTZ(6),
  "cancelled_at" TIMESTAMPTZ(6),
  "closed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "order_items" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "store_id" UUID NOT NULL,
  "order_id" UUID NOT NULL,
  "sku_id" UUID NOT NULL,
  "product_id" UUID NOT NULL,
  "brand_id" UUID NOT NULL,
  "category_id" UUID NOT NULL,
  "sku_code" VARCHAR(64) NOT NULL,
  "product_name" VARCHAR(240) NOT NULL,
  "brand_name" VARCHAR(240) NOT NULL,
  "option_snapshot" JSONB NOT NULL,
  "unit_price_vnd" BIGINT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "subtotal_vnd" BIGINT NOT NULL,
  "item_discount_vnd" BIGINT NOT NULL DEFAULT 0,
  "coupon_discount_vnd" BIGINT NOT NULL DEFAULT 0,
  "order_discount_vnd" BIGINT NOT NULL DEFAULT 0,
  "payable_vnd" BIGINT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "order_snapshots" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "store_id" UUID NOT NULL,
  "order_id" UUID NOT NULL,
  "snapshot_type" "order_snapshot_type" NOT NULL,
  "payload" JSONB NOT NULL,
  "payload_hash" CHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "order_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "order_transitions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "store_id" UUID NOT NULL,
  "order_id" UUID NOT NULL,
  "from_status" "order_status",
  "to_status" "order_status" NOT NULL,
  "event" VARCHAR(64) NOT NULL,
  "reason" VARCHAR(500),
  "actor_type" "AuditActorType" NOT NULL,
  "actor_id" UUID NOT NULL,
  "correlation_id" VARCHAR(128) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "order_transitions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "idempotency_records" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "store_id" UUID NOT NULL,
  "member_id" UUID,
  "order_id" UUID,
  "operation" VARCHAR(64) NOT NULL,
  "idempotency_key" VARCHAR(128) NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "response" JSONB NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "store_delivery_policies_store_id_key" ON "store_delivery_policies"("store_id");
CREATE UNIQUE INDEX "store_delivery_policies_store_id_id_key" ON "store_delivery_policies"("store_id", "id");
CREATE UNIQUE INDEX "addresses_store_id_id_key" ON "addresses"("store_id", "id");
CREATE UNIQUE INDEX "addresses_store_id_member_id_phone_hash_key" ON "addresses"("store_id", "member_id", "phone_hash");
CREATE INDEX "addresses_store_id_member_id_status_updated_at_idx" ON "addresses"("store_id", "member_id", "status", "updated_at" DESC);
CREATE UNIQUE INDEX "addresses_one_default_per_member_key" ON "addresses"("store_id", "member_id") WHERE "is_default" AND "status" = 'ACTIVE';
CREATE UNIQUE INDEX "orders_store_id_id_key" ON "orders"("store_id", "id");
CREATE UNIQUE INDEX "orders_store_id_order_number_key" ON "orders"("store_id", "order_number");
CREATE UNIQUE INDEX "orders_store_id_reservation_id_key" ON "orders"("store_id", "reservation_id");
CREATE INDEX "orders_store_id_member_id_created_at_id_idx" ON "orders"("store_id", "member_id", "created_at" DESC, "id" DESC);
CREATE INDEX "orders_store_id_status_created_at_id_idx" ON "orders"("store_id", "status", "created_at" DESC, "id" DESC);
CREATE UNIQUE INDEX "order_items_store_id_id_key" ON "order_items"("store_id", "id");
CREATE INDEX "order_items_store_id_order_id_idx" ON "order_items"("store_id", "order_id");
CREATE UNIQUE INDEX "order_snapshots_store_id_id_key" ON "order_snapshots"("store_id", "id");
CREATE UNIQUE INDEX "order_snapshots_store_id_order_id_snapshot_type_key" ON "order_snapshots"("store_id", "order_id", "snapshot_type");
CREATE UNIQUE INDEX "order_transitions_store_id_id_key" ON "order_transitions"("store_id", "id");
CREATE INDEX "order_transitions_store_id_order_id_created_at_id_idx" ON "order_transitions"("store_id", "order_id", "created_at" DESC, "id" DESC);
CREATE UNIQUE INDEX "idempotency_records_store_id_id_key" ON "idempotency_records"("store_id", "id");
CREATE UNIQUE INDEX "idempotency_records_store_id_operation_idempotency_key_key" ON "idempotency_records"("store_id", "operation", "idempotency_key");
CREATE INDEX "idempotency_records_store_id_expires_at_idx" ON "idempotency_records"("store_id", "expires_at");

ALTER TABLE "store_delivery_policies" ADD CONSTRAINT "store_delivery_policies_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "store_delivery_policies" ADD CONSTRAINT "store_delivery_policies_updated_by_admin_id_fkey" FOREIGN KEY ("updated_by_admin_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_store_id_member_id_fkey" FOREIGN KEY ("store_id", "member_id") REFERENCES "members"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_store_id_member_id_fkey" FOREIGN KEY ("store_id", "member_id") REFERENCES "members"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_store_id_cart_id_fkey" FOREIGN KEY ("store_id", "cart_id") REFERENCES "carts"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_store_id_address_id_fkey" FOREIGN KEY ("store_id", "address_id") REFERENCES "addresses"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_store_id_reservation_id_fkey" FOREIGN KEY ("store_id", "reservation_id") REFERENCES "inventory_reservations"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_store_id_order_id_fkey" FOREIGN KEY ("store_id", "order_id") REFERENCES "orders"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_store_id_sku_id_fkey" FOREIGN KEY ("store_id", "sku_id") REFERENCES "skus"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_store_id_product_id_fkey" FOREIGN KEY ("store_id", "product_id") REFERENCES "products"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_store_id_brand_id_fkey" FOREIGN KEY ("store_id", "brand_id") REFERENCES "brands"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_store_id_category_id_fkey" FOREIGN KEY ("store_id", "category_id") REFERENCES "categories"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_snapshots" ADD CONSTRAINT "order_snapshots_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_snapshots" ADD CONSTRAINT "order_snapshots_store_id_order_id_fkey" FOREIGN KEY ("store_id", "order_id") REFERENCES "orders"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_transitions" ADD CONSTRAINT "order_transitions_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_transitions" ADD CONSTRAINT "order_transitions_store_id_order_id_fkey" FOREIGN KEY ("store_id", "order_id") REFERENCES "orders"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_store_id_member_id_fkey" FOREIGN KEY ("store_id", "member_id") REFERENCES "members"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_store_id_order_id_fkey" FOREIGN KEY ("store_id", "order_id") REFERENCES "orders"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "store_delivery_policies"
  ADD CONSTRAINT "store_delivery_policies_version_check" CHECK ("version" >= 1),
  ADD CONSTRAINT "store_delivery_policies_amount_check" CHECK (
    "flat_shipping_fee_vnd" >= 0 AND "remote_surcharge_vnd" >= 0
    AND ("free_shipping_threshold_vnd" IS NULL OR "free_shipping_threshold_vnd" >= 0)
    AND ("cod_max_amount_vnd" IS NULL OR "cod_max_amount_vnd" > 0)
  );
ALTER TABLE "addresses"
  ADD CONSTRAINT "addresses_version_check" CHECK ("version" >= 1),
  ADD CONSTRAINT "addresses_code_check" CHECK (
    btrim("province_code") <> '' AND btrim("district_code") <> '' AND btrim("ward_code") <> ''
  );
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_amount_check" CHECK (
    "currency" = 'VND' AND "base_subtotal_vnd" >= 0 AND "item_discount_vnd" >= 0
    AND "coupon_discount_vnd" >= 0 AND "order_discount_vnd" >= 0 AND "shipping_fee_vnd" >= 0
    AND "remote_surcharge_vnd" >= 0 AND "shipping_discount_vnd" >= 0 AND "payable_vnd" >= 0
    AND "payable_vnd" = "base_subtotal_vnd" - "item_discount_vnd" - "coupon_discount_vnd"
      - "order_discount_vnd" + "shipping_fee_vnd" + "remote_surcharge_vnd" - "shipping_discount_vnd"
  ),
  ADD CONSTRAINT "orders_quote_hash_check" CHECK ("quote_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_amount_check" CHECK (
    "unit_price_vnd" >= 0 AND "quantity" BETWEEN 1 AND 99 AND "subtotal_vnd" >= 0
    AND "item_discount_vnd" >= 0 AND "coupon_discount_vnd" >= 0 AND "order_discount_vnd" >= 0
    AND "payable_vnd" >= 0
  );
ALTER TABLE "order_snapshots"
  ADD CONSTRAINT "order_snapshots_payload_check" CHECK (jsonb_typeof("payload") = 'object'),
  ADD CONSTRAINT "order_snapshots_hash_check" CHECK ("payload_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "idempotency_records"
  ADD CONSTRAINT "idempotency_records_key_check" CHECK ("idempotency_key" ~ '^[!-~]{16,128}$'),
  ADD CONSTRAINT "idempotency_records_hash_check" CHECK ("request_hash" ~ '^[0-9a-f]{64}$');

CREATE OR REPLACE FUNCTION "app_security"."reject_m4_fact_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '42501';
END
$$;

CREATE TRIGGER "order_items_append_only" BEFORE UPDATE OR DELETE ON "order_items"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_m4_fact_mutation"();
CREATE TRIGGER "order_snapshots_append_only" BEFORE UPDATE OR DELETE ON "order_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_m4_fact_mutation"();
CREATE TRIGGER "order_transitions_append_only" BEFORE UPDATE OR DELETE ON "order_transitions"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_m4_fact_mutation"();

REVOKE ALL ON FUNCTION "app_security"."reject_m4_fact_mutation"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app_security"."reject_m4_fact_mutation"() TO zalo_shop_runtime;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'store_delivery_policies', 'addresses', 'orders', 'order_items',
    'order_snapshots', 'order_transitions', 'idempotency_records'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (store_id = app_security.current_store_id()) WITH CHECK (store_id = app_security.current_store_id())',
      table_name || '_tenant_isolation', table_name
    );
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  "store_delivery_policies", "addresses", "orders", "order_items",
  "order_snapshots", "order_transitions", "idempotency_records"
TO zalo_shop_runtime;
REVOKE UPDATE, DELETE ON TABLE "order_items", "order_snapshots", "order_transitions" FROM zalo_shop_runtime;
