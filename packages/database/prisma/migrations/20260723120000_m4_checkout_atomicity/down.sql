-- LOCAL/TEST ONLY. Refuse rollback after a coupon has been consumed by an order.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "member_coupons" WHERE "status" = 'USED' LIMIT 1) THEN
    RAISE EXCEPTION 'M4 checkout atomicity rollback is unsafe after coupon redemption' USING ERRCODE = '55000';
  END IF;
END
$$;

ALTER TABLE "member_coupons"
  DROP CONSTRAINT IF EXISTS "member_coupons_store_id_used_order_id_fkey";
DROP INDEX IF EXISTS "member_coupons_store_id_used_order_id_key";
ALTER TABLE "member_coupons" DROP COLUMN IF EXISTS "used_order_id", DROP COLUMN IF EXISTS "used_at";

ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_version_check";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "version";

ALTER TYPE "member_coupon_status" RENAME TO "member_coupon_status_m4_old";
CREATE TYPE "member_coupon_status" AS ENUM ('CLAIMED', 'EXPIRED', 'DISABLED');
ALTER TABLE "member_coupons" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "member_coupons"
  ALTER COLUMN "status" TYPE "member_coupon_status"
  USING ("status"::text::"member_coupon_status");
ALTER TABLE "member_coupons" ALTER COLUMN "status" SET DEFAULT 'CLAIMED';
DROP TYPE "member_coupon_status_m4_old";
