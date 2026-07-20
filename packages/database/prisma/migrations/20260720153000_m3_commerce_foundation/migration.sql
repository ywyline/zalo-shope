-- M3.2 requires PostgreSQL full-text and accent-insensitive search support.
-- Fail before creating business objects when the server image cannot provide
-- either extension. CREATE EXTENSION itself deliberately surfaces an
-- insufficient-privilege error for an incorrectly provisioned migration role.
DO $m3_extensions$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'unaccent') THEN
    RAISE EXCEPTION 'M3.2 requires the PostgreSQL unaccent extension' USING ERRCODE = '0A000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_trgm') THEN
    RAISE EXCEPTION 'M3.2 requires the PostgreSQL pg_trgm extension' USING ERRCODE = '0A000';
  END IF;
END
$m3_extensions$;

CREATE EXTENSION IF NOT EXISTS "unaccent" WITH SCHEMA "public";
CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA "public";

-- CreateEnum
CREATE TYPE "inventory_movement_type" AS ENUM ('ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'RESERVE', 'RELEASE', 'CONSUME', 'RESTORE');

-- CreateEnum
CREATE TYPE "inventory_operation_type" AS ENUM ('ADJUST', 'IMPORT', 'RESERVE', 'RELEASE', 'CONSUME', 'EXPIRE', 'RESTORE');

-- CreateEnum
CREATE TYPE "inventory_reservation_status" AS ENUM ('ACTIVE', 'RELEASED', 'CONSUMED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "promotion_status" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ENDED');

-- CreateEnum
CREATE TYPE "promotion_version_status" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "pricing_bucket" AS ENUM ('ITEM', 'ORDER', 'COUPON', 'SHIPPING');

-- CreateEnum
CREATE TYPE "promotion_benefit_method" AS ENUM ('FIXED_VND', 'PERCENTAGE_BPS', 'FREE_SHIPPING_QUALIFICATION');

-- CreateEnum
CREATE TYPE "promotion_target_type" AS ENUM ('STORE', 'BRAND', 'CATEGORY', 'PRODUCT', 'SKU');

-- CreateEnum
CREATE TYPE "coupon_status" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ENDED');

-- CreateEnum
CREATE TYPE "member_coupon_status" AS ENUM ('CLAIMED', 'EXPIRED', 'DISABLED');

-- CreateEnum
CREATE TYPE "cart_status" AS ENUM ('ACTIVE', 'CONVERTED', 'ABANDONED');

-- CreateTable
CREATE TABLE "warehouses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "is_default_fulfillment" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_localizations" (
    "store_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "locale" "Locale" NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_localizations_pkey" PRIMARY KEY ("store_id","warehouse_id","locale")
);

-- CreateTable
CREATE TABLE "inventory_balances" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "on_hand" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "available" INTEGER GENERATED ALWAYS AS ("on_hand" - "reserved") STORED,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_operations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "operation_key" VARCHAR(128) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "operation_type" "inventory_operation_type" NOT NULL,
    "result_snapshot" JSONB NOT NULL,
    "admin_id" UUID,
    "source_type" VARCHAR(32),
    "source_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_reservations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "reservation_key" VARCHAR(128) NOT NULL,
    "status" "inventory_reservation_status" NOT NULL DEFAULT 'ACTIVE',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "terminal_operation_id" UUID,
    "source_type" VARCHAR(32),
    "source_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "terminal_at" TIMESTAMPTZ(6),

    CONSTRAINT "inventory_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_reservation_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_reservation_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_movements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "balance_id" UUID NOT NULL,
    "operation_id" UUID NOT NULL,
    "reservation_item_id" UUID,
    "movement_type" "inventory_movement_type" NOT NULL,
    "on_hand_before" INTEGER NOT NULL,
    "on_hand_after" INTEGER NOT NULL,
    "on_hand_delta" INTEGER NOT NULL,
    "reserved_before" INTEGER NOT NULL,
    "reserved_after" INTEGER NOT NULL,
    "reserved_delta" INTEGER NOT NULL,
    "reason_code" VARCHAR(64) NOT NULL,
    "note" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_search_documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "locale" "Locale" NOT NULL,
    "display_text" TEXT NOT NULL,
    "canonical_text" TEXT NOT NULL,
    "folded_text" TEXT NOT NULL,
    "search_vector" tsvector GENERATED ALWAYS AS (
      to_tsvector('simple'::regconfig, "canonical_text" || ' ' || "folded_text")
    ) STORED,
    "brand_id" UUID NOT NULL,
    "main_category_id" UUID NOT NULL,
    "category_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
    "filter_values" JSONB NOT NULL DEFAULT '{}',
    "minimum_sale_price_vnd" BIGINT NOT NULL,
    "published_at" TIMESTAMPTZ(6) NOT NULL,
    "source_version" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_search_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_search_history" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "display_query" VARCHAR(100) NOT NULL,
    "canonical_query" VARCHAR(100) NOT NULL,
    "folded_query" VARCHAR(100) NOT NULL,
    "locale" "Locale" NOT NULL,
    "last_searched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_search_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_query_stats" (
    "store_id" UUID NOT NULL,
    "locale" "Locale" NOT NULL,
    "folded_query" VARCHAR(100) NOT NULL,
    "display_query" VARCHAR(100) NOT NULL,
    "search_count" BIGINT NOT NULL DEFAULT 0,
    "result_click_count" BIGINT NOT NULL DEFAULT 0,
    "last_searched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "search_query_stats_pkey" PRIMARY KEY ("store_id","locale","folded_query")
);

-- CreateTable
CREATE TABLE "promotions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "status" "promotion_status" NOT NULL DEFAULT 'DRAFT',
    "active_version_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_admin_id" UUID NOT NULL,
    "updated_by_admin_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promotions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "promotion_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "status" "promotion_version_status" NOT NULL DEFAULT 'DRAFT',
    "bucket" "pricing_bucket" NOT NULL,
    "benefit_method" "promotion_benefit_method" NOT NULL,
    "fixed_discount_vnd" BIGINT,
    "percentage_bps" INTEGER,
    "maximum_discount_vnd" BIGINT,
    "minimum_spend_vnd" BIGINT,
    "minimum_quantity" INTEGER,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6),
    "priority" INTEGER NOT NULL DEFAULT 0,
    "stackable_with" "pricing_bucket"[] DEFAULT ARRAY[]::"pricing_bucket"[],
    "published_at" TIMESTAMPTZ(6),
    "published_by_admin_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promotion_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion_version_localizations" (
    "store_id" UUID NOT NULL,
    "promotion_version_id" UUID NOT NULL,
    "locale" "Locale" NOT NULL,
    "name" VARCHAR(240) NOT NULL,
    "description" VARCHAR(2000),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promotion_version_localizations_pkey" PRIMARY KEY ("store_id","promotion_version_id","locale")
);

-- CreateTable
CREATE TABLE "promotion_targets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "promotion_version_id" UUID NOT NULL,
    "target_type" "promotion_target_type" NOT NULL,
    "brand_id" UUID,
    "category_id" UUID,
    "product_id" UUID,
    "sku_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promotion_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupons" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "promotion_version_id" UUID NOT NULL,
    "status" "coupon_status" NOT NULL DEFAULT 'DRAFT',
    "total_claim_limit" INTEGER,
    "per_member_claim_limit" INTEGER NOT NULL DEFAULT 1,
    "claimed_count" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_coupons" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "coupon_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "status" "member_coupon_status" NOT NULL DEFAULT 'CLAIMED',
    "claimed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_coupons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "status" "cart_status" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "carts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cart_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "cart_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "selected" BOOLEAN NOT NULL DEFAULT true,
    "added_unit_price_vnd" BIGINT NOT NULL,
    "added_promotion_fingerprint" CHAR(64),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cart_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "warehouses_store_id_enabled_code_idx" ON "warehouses"("store_id", "enabled", "code");

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_store_id_id_key" ON "warehouses"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_store_id_code_key" ON "warehouses"("store_id", "code");

-- CreateIndex
CREATE INDEX "inventory_balances_store_id_warehouse_id_available_idx" ON "inventory_balances"("store_id", "warehouse_id", "available");

-- CreateIndex
CREATE INDEX "inventory_balances_store_id_sku_id_idx" ON "inventory_balances"("store_id", "sku_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_balances_store_id_id_key" ON "inventory_balances"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_balances_store_id_warehouse_id_sku_id_key" ON "inventory_balances"("store_id", "warehouse_id", "sku_id");

-- CreateIndex
CREATE INDEX "inventory_operations_store_id_created_at_id_idx" ON "inventory_operations"("store_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "inventory_operations_store_id_id_key" ON "inventory_operations"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_operations_store_id_operation_key_key" ON "inventory_operations"("store_id", "operation_key");

-- CreateIndex
CREATE INDEX "inventory_reservations_store_id_status_expires_at_idx" ON "inventory_reservations"("store_id", "status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_reservations_store_id_id_key" ON "inventory_reservations"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_reservations_store_id_reservation_key_key" ON "inventory_reservations"("store_id", "reservation_key");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_reservation_items_store_id_id_key" ON "inventory_reservation_items"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_reservation_items_store_id_reservation_id_warehou_key" ON "inventory_reservation_items"("store_id", "reservation_id", "warehouse_id", "sku_id");

-- CreateIndex
CREATE INDEX "inventory_movements_store_id_balance_id_created_at_id_idx" ON "inventory_movements"("store_id", "balance_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "inventory_movements_store_id_operation_id_idx" ON "inventory_movements"("store_id", "operation_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_movements_store_id_id_key" ON "inventory_movements"("store_id", "id");

-- CreateIndex
CREATE INDEX "product_search_documents_store_id_locale_published_at_id_idx" ON "product_search_documents"("store_id", "locale", "published_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "product_search_documents_store_id_locale_minimum_sale_price_idx" ON "product_search_documents"("store_id", "locale", "minimum_sale_price_vnd", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_search_documents_store_id_id_key" ON "product_search_documents"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_search_documents_store_id_product_id_locale_key" ON "product_search_documents"("store_id", "product_id", "locale");

-- CreateIndex
CREATE INDEX "member_search_history_store_id_member_id_last_searched_at_i_idx" ON "member_search_history"("store_id", "member_id", "last_searched_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "member_search_history_store_id_id_key" ON "member_search_history"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "member_search_history_store_id_member_id_locale_folded_quer_key" ON "member_search_history"("store_id", "member_id", "locale", "folded_query");

-- CreateIndex
CREATE INDEX "search_query_stats_store_id_locale_search_count_folded_quer_idx" ON "search_query_stats"("store_id", "locale", "search_count" DESC, "folded_query");

-- CreateIndex
CREATE INDEX "promotions_store_id_status_updated_at_id_idx" ON "promotions"("store_id", "status", "updated_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "promotions_store_id_id_key" ON "promotions"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "promotions_store_id_code_key" ON "promotions"("store_id", "code");

-- CreateIndex
CREATE INDEX "promotion_versions_store_id_status_starts_at_ends_at_idx" ON "promotion_versions"("store_id", "status", "starts_at", "ends_at");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_versions_store_id_id_key" ON "promotion_versions"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_versions_store_id_promotion_id_version_number_key" ON "promotion_versions"("store_id", "promotion_id", "version_number");

-- CreateIndex
CREATE INDEX "promotion_targets_store_id_promotion_version_id_target_type_idx" ON "promotion_targets"("store_id", "promotion_version_id", "target_type");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_targets_store_id_id_key" ON "promotion_targets"("store_id", "id");

-- CreateIndex
CREATE INDEX "coupons_store_id_status_updated_at_id_idx" ON "coupons"("store_id", "status", "updated_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "coupons_store_id_id_key" ON "coupons"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "coupons_store_id_code_key" ON "coupons"("store_id", "code");

-- CreateIndex
CREATE INDEX "member_coupons_store_id_member_id_status_expires_at_idx" ON "member_coupons"("store_id", "member_id", "status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "member_coupons_store_id_id_key" ON "member_coupons"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "member_coupons_store_id_coupon_id_member_id_key" ON "member_coupons"("store_id", "coupon_id", "member_id");

-- CreateIndex
CREATE INDEX "carts_store_id_member_id_status_idx" ON "carts"("store_id", "member_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "carts_store_id_id_key" ON "carts"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "cart_items_store_id_id_key" ON "cart_items"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "cart_items_store_id_cart_id_sku_id_key" ON "cart_items"("store_id", "cart_id", "sku_id");

-- AddForeignKey
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_localizations" ADD CONSTRAINT "warehouse_localizations_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_localizations" ADD CONSTRAINT "warehouse_localizations_store_id_warehouse_id_fkey" FOREIGN KEY ("store_id", "warehouse_id") REFERENCES "warehouses"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_store_id_warehouse_id_fkey" FOREIGN KEY ("store_id", "warehouse_id") REFERENCES "warehouses"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_store_id_sku_id_fkey" FOREIGN KEY ("store_id", "sku_id") REFERENCES "skus"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_operations" ADD CONSTRAINT "inventory_operations_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_operations" ADD CONSTRAINT "inventory_operations_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_store_id_terminal_operation_id_fkey" FOREIGN KEY ("store_id", "terminal_operation_id") REFERENCES "inventory_operations"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_reservation_items" ADD CONSTRAINT "inventory_reservation_items_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_reservation_items" ADD CONSTRAINT "inventory_reservation_items_store_id_reservation_id_fkey" FOREIGN KEY ("store_id", "reservation_id") REFERENCES "inventory_reservations"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_reservation_items" ADD CONSTRAINT "inventory_reservation_items_store_id_warehouse_id_fkey" FOREIGN KEY ("store_id", "warehouse_id") REFERENCES "warehouses"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_reservation_items" ADD CONSTRAINT "inventory_reservation_items_store_id_sku_id_fkey" FOREIGN KEY ("store_id", "sku_id") REFERENCES "skus"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_store_id_balance_id_fkey" FOREIGN KEY ("store_id", "balance_id") REFERENCES "inventory_balances"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_store_id_operation_id_fkey" FOREIGN KEY ("store_id", "operation_id") REFERENCES "inventory_operations"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_store_id_reservation_item_id_fkey" FOREIGN KEY ("store_id", "reservation_item_id") REFERENCES "inventory_reservation_items"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_search_documents" ADD CONSTRAINT "product_search_documents_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_search_documents" ADD CONSTRAINT "product_search_documents_store_id_product_id_fkey" FOREIGN KEY ("store_id", "product_id") REFERENCES "products"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_search_documents" ADD CONSTRAINT "product_search_documents_store_id_brand_id_fkey" FOREIGN KEY ("store_id", "brand_id") REFERENCES "brands"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_search_documents" ADD CONSTRAINT "product_search_documents_store_id_main_category_id_fkey" FOREIGN KEY ("store_id", "main_category_id") REFERENCES "categories"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_search_history" ADD CONSTRAINT "member_search_history_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_search_history" ADD CONSTRAINT "member_search_history_store_id_member_id_fkey" FOREIGN KEY ("store_id", "member_id") REFERENCES "members"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "search_query_stats" ADD CONSTRAINT "search_query_stats_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_created_by_admin_id_fkey" FOREIGN KEY ("created_by_admin_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_updated_by_admin_id_fkey" FOREIGN KEY ("updated_by_admin_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_store_id_active_version_id_fkey" FOREIGN KEY ("store_id", "active_version_id") REFERENCES "promotion_versions"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_versions" ADD CONSTRAINT "promotion_versions_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_versions" ADD CONSTRAINT "promotion_versions_store_id_promotion_id_fkey" FOREIGN KEY ("store_id", "promotion_id") REFERENCES "promotions"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_versions" ADD CONSTRAINT "promotion_versions_published_by_admin_id_fkey" FOREIGN KEY ("published_by_admin_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_version_localizations" ADD CONSTRAINT "promotion_version_localizations_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_version_localizations" ADD CONSTRAINT "promotion_version_localizations_store_id_promotion_version_fkey" FOREIGN KEY ("store_id", "promotion_version_id") REFERENCES "promotion_versions"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_targets" ADD CONSTRAINT "promotion_targets_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_targets" ADD CONSTRAINT "promotion_targets_store_id_promotion_version_id_fkey" FOREIGN KEY ("store_id", "promotion_version_id") REFERENCES "promotion_versions"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_targets" ADD CONSTRAINT "promotion_targets_store_id_brand_id_fkey" FOREIGN KEY ("store_id", "brand_id") REFERENCES "brands"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_targets" ADD CONSTRAINT "promotion_targets_store_id_category_id_fkey" FOREIGN KEY ("store_id", "category_id") REFERENCES "categories"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_targets" ADD CONSTRAINT "promotion_targets_store_id_product_id_fkey" FOREIGN KEY ("store_id", "product_id") REFERENCES "products"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_targets" ADD CONSTRAINT "promotion_targets_store_id_sku_id_fkey" FOREIGN KEY ("store_id", "sku_id") REFERENCES "skus"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_store_id_promotion_version_id_fkey" FOREIGN KEY ("store_id", "promotion_version_id") REFERENCES "promotion_versions"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_coupons" ADD CONSTRAINT "member_coupons_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_coupons" ADD CONSTRAINT "member_coupons_store_id_coupon_id_fkey" FOREIGN KEY ("store_id", "coupon_id") REFERENCES "coupons"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_coupons" ADD CONSTRAINT "member_coupons_store_id_member_id_fkey" FOREIGN KEY ("store_id", "member_id") REFERENCES "members"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carts" ADD CONSTRAINT "carts_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carts" ADD CONSTRAINT "carts_store_id_member_id_fkey" FOREIGN KEY ("store_id", "member_id") REFERENCES "members"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_store_id_cart_id_fkey" FOREIGN KEY ("store_id", "cart_id") REFERENCES "carts"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_store_id_sku_id_fkey" FOREIGN KEY ("store_id", "sku_id") REFERENCES "skus"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- M3 domain constraints that Prisma cannot express.
ALTER TABLE "warehouses"
  ADD CONSTRAINT "warehouses_code_check" CHECK ("code" ~ '^[a-z][a-z0-9-]{1,63}$'),
  ADD CONSTRAINT "warehouses_version_check" CHECK ("version" >= 1);
CREATE UNIQUE INDEX "warehouses_one_enabled_default_per_store_key"
  ON "warehouses"("store_id") WHERE "enabled" AND "is_default_fulfillment";

ALTER TABLE "inventory_balances"
  ADD CONSTRAINT "inventory_balances_quantity_check" CHECK (
    "on_hand" BETWEEN 0 AND 2147483647
    AND "reserved" BETWEEN 0 AND "on_hand"
  ),
  ADD CONSTRAINT "inventory_balances_version_check" CHECK ("version" >= 1);

ALTER TABLE "inventory_operations"
  ADD CONSTRAINT "inventory_operations_key_check" CHECK ("operation_key" ~ '^[!-~]{16,128}$'),
  ADD CONSTRAINT "inventory_operations_hash_check" CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "inventory_operations_result_check" CHECK (jsonb_typeof("result_snapshot") = 'object'),
  ADD CONSTRAINT "inventory_operations_source_check" CHECK (("source_type" IS NULL) = ("source_id" IS NULL));

ALTER TABLE "inventory_reservations"
  ADD CONSTRAINT "inventory_reservations_key_check" CHECK ("reservation_key" ~ '^[!-~]{16,128}$'),
  ADD CONSTRAINT "inventory_reservations_expiry_check" CHECK ("expires_at" > "created_at"),
  ADD CONSTRAINT "inventory_reservations_source_check" CHECK (("source_type" IS NULL) = ("source_id" IS NULL)),
  ADD CONSTRAINT "inventory_reservations_terminal_check" CHECK (
    ("status" = 'ACTIVE' AND "terminal_operation_id" IS NULL AND "terminal_at" IS NULL)
    OR
    ("status" <> 'ACTIVE' AND "terminal_operation_id" IS NOT NULL AND "terminal_at" IS NOT NULL)
  );

ALTER TABLE "inventory_reservation_items"
  ADD CONSTRAINT "inventory_reservation_items_quantity_check" CHECK ("quantity" BETWEEN 1 AND 2147483647);

ALTER TABLE "inventory_movements"
  ADD CONSTRAINT "inventory_movements_arithmetic_check" CHECK (
    "on_hand_after" = "on_hand_before" + "on_hand_delta"
    AND "reserved_after" = "reserved_before" + "reserved_delta"
  ),
  ADD CONSTRAINT "inventory_movements_balance_check" CHECK (
    "on_hand_before" BETWEEN 0 AND 2147483647
    AND "on_hand_after" BETWEEN 0 AND 2147483647
    AND "reserved_before" BETWEEN 0 AND "on_hand_before"
    AND "reserved_after" BETWEEN 0 AND "on_hand_after"
  ),
  ADD CONSTRAINT "inventory_movements_type_check" CHECK (
    ("movement_type" = 'ADJUSTMENT_IN' AND "on_hand_delta" > 0 AND "reserved_delta" = 0 AND "reservation_item_id" IS NULL)
    OR ("movement_type" = 'ADJUSTMENT_OUT' AND "on_hand_delta" < 0 AND "reserved_delta" = 0 AND "reservation_item_id" IS NULL)
    OR ("movement_type" = 'RESERVE' AND "on_hand_delta" = 0 AND "reserved_delta" > 0 AND "reservation_item_id" IS NOT NULL)
    OR ("movement_type" = 'RELEASE' AND "on_hand_delta" = 0 AND "reserved_delta" < 0 AND "reservation_item_id" IS NOT NULL)
    OR ("movement_type" = 'CONSUME' AND "on_hand_delta" < 0 AND "on_hand_delta" = "reserved_delta" AND "reservation_item_id" IS NOT NULL)
    OR ("movement_type" = 'RESTORE' AND "on_hand_delta" > 0 AND "reserved_delta" = 0)
  );

ALTER TABLE "product_search_documents"
  ADD CONSTRAINT "product_search_documents_text_check" CHECK (
    btrim("display_text") <> '' AND btrim("canonical_text") <> '' AND btrim("folded_text") <> ''
  ),
  ADD CONSTRAINT "product_search_documents_price_check" CHECK ("minimum_sale_price_vnd" >= 0),
  ADD CONSTRAINT "product_search_documents_version_check" CHECK ("source_version" >= 1);
CREATE INDEX "product_search_documents_search_vector_idx"
  ON "product_search_documents" USING GIN ("search_vector");
CREATE INDEX "product_search_documents_folded_text_trgm_idx"
  ON "product_search_documents" USING GIN ("folded_text" gin_trgm_ops);
CREATE INDEX "product_search_documents_category_ids_idx"
  ON "product_search_documents" USING GIN ("category_ids");
CREATE INDEX "product_search_documents_filter_values_idx"
  ON "product_search_documents" USING GIN ("filter_values" jsonb_path_ops);

ALTER TABLE "member_search_history"
  ADD CONSTRAINT "member_search_history_text_check" CHECK (
    btrim("display_query") <> '' AND btrim("canonical_query") <> '' AND btrim("folded_query") <> ''
  );

ALTER TABLE "search_query_stats"
  ADD CONSTRAINT "search_query_stats_text_check" CHECK (btrim("display_query") <> '' AND btrim("folded_query") <> ''),
  ADD CONSTRAINT "search_query_stats_counts_check" CHECK ("search_count" >= 0 AND "result_click_count" >= 0);

ALTER TABLE "promotions"
  ADD CONSTRAINT "promotions_code_check" CHECK ("code" ~ '^[a-z][a-z0-9-]{1,63}$'),
  ADD CONSTRAINT "promotions_version_check" CHECK ("version" >= 1),
  ADD CONSTRAINT "promotions_active_version_check" CHECK (
    ("status" = 'DRAFT' AND "active_version_id" IS NULL)
    OR ("status" <> 'DRAFT' AND "active_version_id" IS NOT NULL)
  );

ALTER TABLE "promotion_versions"
  ADD CONSTRAINT "promotion_versions_version_check" CHECK ("version_number" >= 1),
  ADD CONSTRAINT "promotion_versions_window_check" CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at"),
  ADD CONSTRAINT "promotion_versions_priority_check" CHECK ("priority" >= 0),
  ADD CONSTRAINT "promotion_versions_minimum_spend_check" CHECK ("minimum_spend_vnd" IS NULL OR "minimum_spend_vnd" >= 0),
  ADD CONSTRAINT "promotion_versions_minimum_quantity_check" CHECK ("minimum_quantity" IS NULL OR "minimum_quantity" BETWEEN 1 AND 99),
  ADD CONSTRAINT "promotion_versions_publication_check" CHECK (
    ("status" = 'DRAFT' AND "published_at" IS NULL AND "published_by_admin_id" IS NULL)
    OR ("status" = 'PUBLISHED' AND "published_at" IS NOT NULL AND "published_by_admin_id" IS NOT NULL)
  ),
  ADD CONSTRAINT "promotion_versions_benefit_check" CHECK (
    ("benefit_method" = 'FIXED_VND' AND "bucket" <> 'SHIPPING'
      AND "fixed_discount_vnd" > 0 AND "percentage_bps" IS NULL AND "maximum_discount_vnd" IS NULL)
    OR ("benefit_method" = 'PERCENTAGE_BPS' AND "bucket" <> 'SHIPPING'
      AND "fixed_discount_vnd" IS NULL AND "percentage_bps" BETWEEN 1 AND 10000
      AND ("maximum_discount_vnd" IS NULL OR "maximum_discount_vnd" > 0))
    OR ("benefit_method" = 'FREE_SHIPPING_QUALIFICATION' AND "bucket" = 'SHIPPING'
      AND "fixed_discount_vnd" IS NULL AND "percentage_bps" IS NULL AND "maximum_discount_vnd" IS NULL)
  ),
  ADD CONSTRAINT "promotion_versions_stackable_self_check" CHECK (NOT ("bucket" = ANY("stackable_with")));

ALTER TABLE "promotion_targets"
  ADD CONSTRAINT "promotion_targets_shape_check" CHECK (
    ("target_type" = 'STORE' AND num_nonnulls("brand_id", "category_id", "product_id", "sku_id") = 0)
    OR ("target_type" = 'BRAND' AND "brand_id" IS NOT NULL AND num_nonnulls("category_id", "product_id", "sku_id") = 0)
    OR ("target_type" = 'CATEGORY' AND "category_id" IS NOT NULL AND num_nonnulls("brand_id", "product_id", "sku_id") = 0)
    OR ("target_type" = 'PRODUCT' AND "product_id" IS NOT NULL AND num_nonnulls("brand_id", "category_id", "sku_id") = 0)
    OR ("target_type" = 'SKU' AND "sku_id" IS NOT NULL AND num_nonnulls("brand_id", "category_id", "product_id") = 0)
  );
CREATE UNIQUE INDEX "promotion_targets_version_target_key"
  ON "promotion_targets"(
    "store_id", "promotion_version_id", "target_type",
    COALESCE("brand_id", "category_id", "product_id", "sku_id", '00000000-0000-0000-0000-000000000000'::uuid)
  );

ALTER TABLE "coupons"
  ADD CONSTRAINT "coupons_code_check" CHECK ("code" ~ '^[a-z][a-z0-9-]{1,63}$'),
  ADD CONSTRAINT "coupons_limits_check" CHECK (
    ("total_claim_limit" IS NULL OR "total_claim_limit" > 0)
    AND "per_member_claim_limit" = 1
    AND "claimed_count" >= 0
    AND ("total_claim_limit" IS NULL OR "claimed_count" <= "total_claim_limit")
  ),
  ADD CONSTRAINT "coupons_version_check" CHECK ("version" >= 1);

ALTER TABLE "member_coupons"
  ADD CONSTRAINT "member_coupons_expiry_check" CHECK ("expires_at" IS NULL OR "expires_at" > "claimed_at");

ALTER TABLE "carts"
  ADD CONSTRAINT "carts_version_check" CHECK ("version" >= 1);
CREATE UNIQUE INDEX "carts_one_active_per_member_key"
  ON "carts"("store_id", "member_id") WHERE "status" = 'ACTIVE';

ALTER TABLE "cart_items"
  ADD CONSTRAINT "cart_items_quantity_check" CHECK ("quantity" BETWEEN 1 AND 99),
  ADD CONSTRAINT "cart_items_price_check" CHECK ("added_unit_price_vnd" >= 0),
  ADD CONSTRAINT "cart_items_fingerprint_check" CHECK (
    "added_promotion_fingerprint" IS NULL OR "added_promotion_fingerprint" ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT "cart_items_version_check" CHECK ("version" >= 1);

-- Append-only facts and frozen state machines.
CREATE OR REPLACE FUNCTION "app_security"."reject_m3_fact_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '42501';
END
$$;

CREATE OR REPLACE FUNCTION "app_security"."enforce_m3_state_transition"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'inventory_reservations' THEN
    IF TG_OP = 'DELETE' OR OLD.status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'inventory reservation terminal state is immutable' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'DRAFT' AND NEW.status = 'ACTIVE' THEN RETURN NEW; END IF;
  IF OLD.status = 'ACTIVE' AND NEW.status IN ('PAUSED', 'ENDED') THEN RETURN NEW; END IF;
  IF OLD.status = 'PAUSED' AND NEW.status IN ('ACTIVE', 'ENDED') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'invalid % status transition: % -> %', TG_TABLE_NAME, OLD.status, NEW.status USING ERRCODE = '23514';
END
$$;

CREATE OR REPLACE FUNCTION "app_security"."validate_promotion_version"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE value_count integer;
DECLARE unique_count integer;
BEGIN
  SELECT count(*), count(DISTINCT value) INTO value_count, unique_count
  FROM unnest(NEW.stackable_with) AS value;
  IF value_count <> unique_count THEN
    RAISE EXCEPTION 'stackable_with contains duplicate buckets' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status = 'PUBLISHED' THEN
    RAISE EXCEPTION 'published promotion versions are immutable' USING ERRCODE = '42501';
  END IF;

  IF NEW.status = 'PUBLISHED' THEN
    IF NOT EXISTS (
      SELECT 1 FROM promotion_version_localizations
      WHERE store_id = NEW.store_id AND promotion_version_id = NEW.id AND locale = 'vi'
    ) THEN
      RAISE EXCEPTION 'published promotion versions require Vietnamese localization' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM promotion_targets
      WHERE store_id = NEW.store_id AND promotion_version_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'published promotion versions require at least one target' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION "app_security"."reject_published_promotion_child_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_store uuid;
DECLARE target_version uuid;
DECLARE parent_status promotion_version_status;
BEGIN
  target_store := CASE WHEN TG_OP = 'DELETE' THEN OLD.store_id ELSE NEW.store_id END;
  target_version := CASE WHEN TG_OP = 'DELETE' THEN OLD.promotion_version_id ELSE NEW.promotion_version_id END;
  SELECT status INTO parent_status FROM promotion_versions
  WHERE store_id = target_store AND id = target_version;
  IF parent_status = 'PUBLISHED' THEN
    RAISE EXCEPTION 'published promotion version content is immutable' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION "app_security"."validate_promotion_active_version"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.active_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM promotion_versions pv
    WHERE pv.store_id = NEW.store_id
      AND pv.id = NEW.active_version_id
      AND pv.promotion_id = NEW.id
      AND pv.status = 'PUBLISHED'
  ) THEN
    RAISE EXCEPTION 'active_version_id must reference a published version of this promotion' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION "app_security"."validate_coupon_promotion_version"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM promotion_versions pv
    WHERE pv.store_id = NEW.store_id
      AND pv.id = NEW.promotion_version_id
      AND pv.status = 'PUBLISHED'
      AND pv.bucket = 'COUPON'
  ) THEN
    RAISE EXCEPTION 'coupon must reference a published COUPON promotion version' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "inventory_operations_append_only" BEFORE UPDATE OR DELETE ON "inventory_operations"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_m3_fact_mutation"();
CREATE TRIGGER "inventory_movements_append_only" BEFORE UPDATE OR DELETE ON "inventory_movements"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_m3_fact_mutation"();
CREATE TRIGGER "inventory_reservations_state_guard" BEFORE UPDATE OR DELETE ON "inventory_reservations"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."enforce_m3_state_transition"();
CREATE TRIGGER "promotions_state_guard" BEFORE UPDATE ON "promotions"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."enforce_m3_state_transition"();
CREATE TRIGGER "coupons_state_guard" BEFORE UPDATE ON "coupons"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."enforce_m3_state_transition"();
CREATE TRIGGER "promotion_versions_validation" BEFORE INSERT OR UPDATE ON "promotion_versions"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_promotion_version"();
CREATE TRIGGER "promotion_versions_delete_guard" BEFORE DELETE ON "promotion_versions"
  FOR EACH ROW WHEN (OLD.status = 'PUBLISHED') EXECUTE FUNCTION "app_security"."reject_m3_fact_mutation"();
CREATE TRIGGER "promotion_version_localizations_immutable" BEFORE INSERT OR UPDATE OR DELETE ON "promotion_version_localizations"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_published_promotion_child_mutation"();
CREATE TRIGGER "promotion_targets_immutable" BEFORE INSERT OR UPDATE OR DELETE ON "promotion_targets"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_published_promotion_child_mutation"();
CREATE TRIGGER "promotions_active_version_guard" BEFORE INSERT OR UPDATE ON "promotions"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_promotion_active_version"();
CREATE TRIGGER "coupons_promotion_version_guard" BEFORE INSERT OR UPDATE ON "coupons"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_coupon_promotion_version"();

REVOKE ALL ON FUNCTION "app_security"."reject_m3_fact_mutation"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "app_security"."enforce_m3_state_transition"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "app_security"."validate_promotion_version"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "app_security"."reject_published_promotion_child_mutation"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "app_security"."validate_promotion_active_version"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "app_security"."validate_coupon_promotion_version"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  "app_security"."reject_m3_fact_mutation"(),
  "app_security"."enforce_m3_state_transition"(),
  "app_security"."validate_promotion_version"(),
  "app_security"."reject_published_promotion_child_mutation"(),
  "app_security"."validate_promotion_active_version"(),
  "app_security"."validate_coupon_promotion_version"()
TO zalo_shop_runtime;

-- Idempotent initial projection for M2 databases that already contain current
-- published products. This is derived data only and deliberately creates no
-- inventory, sales, order, shipping, coupon redemption, or analytics facts.
WITH published_products AS (
  SELECT
    p.id AS product_id,
    p.store_id,
    p.brand_id,
    p.main_category_id,
    pl.locale,
    concat_ws(' ',
      pl.name,
      pl.subtitle,
      pl.selling_points,
      brand_name.name,
      category_name.name,
      secondary_categories.names,
      filter_projection.display_values
    ) AS display_text,
    ARRAY(
      SELECT DISTINCT category_id
      FROM (
        SELECT p.main_category_id AS category_id
        UNION ALL
        SELECT psc.category_id FROM product_secondary_categories psc
        WHERE psc.store_id = p.store_id AND psc.product_id = p.id
      ) categories
      ORDER BY category_id
    )::uuid[] AS category_ids,
    COALESCE(filter_projection.filter_values, '{}'::jsonb) AS filter_values,
    sku_price.minimum_sale_price_vnd,
    COALESCE(p.published_at, published_version.published_at) AS published_at,
    published_version.version AS source_version
  FROM products p
  JOIN product_localizations pl
    ON pl.store_id = p.store_id AND pl.product_id = p.id
  JOIN LATERAL (
    SELECT pv.version, pv.published_at
    FROM product_versions pv
    WHERE pv.store_id = p.store_id AND pv.product_id = p.id AND pv.publication_status = 'PUBLISHED'
    ORDER BY pv.version DESC
    LIMIT 1
  ) published_version ON true
  JOIN LATERAL (
    SELECT min(s.sale_price_vnd) AS minimum_sale_price_vnd
    FROM skus s
    WHERE s.store_id = p.store_id AND s.product_id = p.id AND s.status = 'ACTIVE'
  ) sku_price ON sku_price.minimum_sale_price_vnd IS NOT NULL
  JOIN LATERAL (
    SELECT bl.name
    FROM brand_localizations bl
    WHERE bl.store_id = p.store_id AND bl.brand_id = p.brand_id AND bl.locale IN (pl.locale, 'vi')
    ORDER BY CASE WHEN bl.locale = pl.locale THEN 0 ELSE 1 END
    LIMIT 1
  ) brand_name ON true
  JOIN LATERAL (
    SELECT cl.name
    FROM category_localizations cl
    WHERE cl.store_id = p.store_id AND cl.category_id = p.main_category_id AND cl.locale IN (pl.locale, 'vi')
    ORDER BY CASE WHEN cl.locale = pl.locale THEN 0 ELSE 1 END
    LIMIT 1
  ) category_name ON true
  LEFT JOIN LATERAL (
    SELECT string_agg(names.name, ' ' ORDER BY names.name) AS names
    FROM (
      SELECT DISTINCT ON (psc.category_id) cl.name
      FROM product_secondary_categories psc
      JOIN category_localizations cl
        ON cl.store_id = psc.store_id AND cl.category_id = psc.category_id AND cl.locale IN (pl.locale, 'vi')
      WHERE psc.store_id = p.store_id AND psc.product_id = p.id
      ORDER BY psc.category_id, CASE WHEN cl.locale = pl.locale THEN 0 ELSE 1 END
    ) names
  ) secondary_categories ON true
  LEFT JOIN LATERAL (
    SELECT
      jsonb_object_agg(values_by_attribute.code, values_by_attribute.values) AS filter_values,
      string_agg(values_by_attribute.display_value, ' ' ORDER BY values_by_attribute.code) AS display_values
    FROM (
      SELECT
        ad.code,
        jsonb_agg(value_rows.value ORDER BY value_rows.value::text) AS values,
        string_agg(trim(both '"' from value_rows.value::text), ' ' ORDER BY value_rows.value::text) AS display_value
      FROM product_attribute_values pav
      JOIN attribute_definitions ad
        ON ad.store_id = pav.store_id AND ad.id = pav.attribute_definition_id AND ad.filterable
      CROSS JOIN LATERAL (
        SELECT COALESCE(
          to_jsonb(pav.text_value), to_jsonb(pav.integer_value), to_jsonb(pav.decimal_value),
          to_jsonb(pav.boolean_value), to_jsonb(pav.date_value), to_jsonb(pav.option_id)
        ) AS value
      ) value_rows
      WHERE pav.store_id = p.store_id AND pav.product_id = p.id AND value_rows.value IS NOT NULL
      GROUP BY ad.code
    ) values_by_attribute
  ) filter_projection ON true
  WHERE p.status = 'PUBLISHED' AND p.enabled AND p.deleted_at IS NULL
), normalized AS (
  SELECT
    published_products.*,
    lower(regexp_replace(btrim(display_text), '\\s+', ' ', 'g')) AS canonical_text
  FROM published_products
), folded AS (
  SELECT
    normalized.*,
    regexp_replace(
      regexp_replace(replace(public.unaccent(canonical_text), 'đ', 'd'), '[^[:alnum:]一-龥]+', ' ', 'g'),
      '\\s+', ' ', 'g'
    ) AS folded_text
  FROM normalized
)
INSERT INTO product_search_documents (
  id, store_id, product_id, locale, display_text, canonical_text, folded_text,
  brand_id, main_category_id, category_ids, filter_values,
  minimum_sale_price_vnd, published_at, source_version, updated_at
)
SELECT
  gen_random_uuid(), store_id, product_id, locale, display_text, canonical_text, folded_text,
  brand_id, main_category_id, category_ids, filter_values,
  minimum_sale_price_vnd, published_at, source_version, now()
FROM folded
WHERE btrim(folded_text) <> ''
ON CONFLICT (store_id, product_id, locale) DO UPDATE SET
  display_text = EXCLUDED.display_text,
  canonical_text = EXCLUDED.canonical_text,
  folded_text = EXCLUDED.folded_text,
  brand_id = EXCLUDED.brand_id,
  main_category_id = EXCLUDED.main_category_id,
  category_ids = EXCLUDED.category_ids,
  filter_values = EXCLUDED.filter_values,
  minimum_sale_price_vnd = EXCLUDED.minimum_sale_price_vnd,
  published_at = EXCLUDED.published_at,
  source_version = EXCLUDED.source_version,
  updated_at = EXCLUDED.updated_at;

-- RLS and immutable store ownership cover every M3 table, including derived
-- search tables and join tables. The runtime role never receives BYPASSRLS.
DO $m3_security$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'warehouses','warehouse_localizations','inventory_balances','inventory_operations',
    'inventory_reservations','inventory_reservation_items','inventory_movements',
    'product_search_documents','member_search_history','search_query_stats',
    'promotions','promotion_versions','promotion_version_localizations','promotion_targets',
    'coupons','member_coupons','carts','cart_items'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION app_security.reject_store_change()', table_name || '_store_immutable', table_name);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON %I USING (store_id = app_security.current_store_id()) WITH CHECK (store_id = app_security.current_store_id())', table_name || '_tenant_isolation', table_name);
  END LOOP;
END
$m3_security$;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  "warehouses", "warehouse_localizations", "inventory_balances", "inventory_operations",
  "inventory_reservations", "inventory_reservation_items", "inventory_movements",
  "product_search_documents", "member_search_history", "search_query_stats",
  "promotions", "promotion_versions", "promotion_version_localizations", "promotion_targets",
  "coupons", "member_coupons", "carts", "cart_items"
TO zalo_shop_runtime;
REVOKE UPDATE, DELETE ON TABLE "inventory_operations", "inventory_movements" FROM zalo_shop_runtime;

-- Catalog only: production roles are intentionally not granted these entries.
-- The local/test seed performs the explicit store-admin assignment.
INSERT INTO "permissions" ("code", "scope", "description") VALUES
  ('store.inventory.read', 'STORE', 'Read current store inventory'),
  ('store.inventory.manage', 'STORE', 'Manage current store warehouses'),
  ('store.inventory.adjust', 'STORE', 'Adjust current store inventory'),
  ('store.promotions.read', 'STORE', 'Read current store promotions'),
  ('store.promotions.manage', 'STORE', 'Manage promotion drafts'),
  ('store.promotions.publish', 'STORE', 'Publish current store promotions')
ON CONFLICT ("code") DO UPDATE SET
  "scope" = EXCLUDED."scope",
  "description" = EXCLUDED."description";
