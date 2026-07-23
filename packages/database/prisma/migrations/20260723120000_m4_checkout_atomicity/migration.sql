-- M4 checkout atomicity: coupon redemption and order optimistic versioning.

ALTER TYPE "member_coupon_status" ADD VALUE IF NOT EXISTS 'USED';

ALTER TABLE "member_coupons"
  ADD COLUMN "used_at" TIMESTAMPTZ(6),
  ADD COLUMN "used_order_id" UUID;

ALTER TABLE "orders"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT "orders_version_check" CHECK ("version" >= 1);

CREATE UNIQUE INDEX "member_coupons_store_id_used_order_id_key"
  ON "member_coupons"("store_id", "used_order_id");

ALTER TABLE "member_coupons"
  ADD CONSTRAINT "member_coupons_store_id_used_order_id_fkey"
  FOREIGN KEY ("store_id", "used_order_id")
  REFERENCES "orders"("store_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
