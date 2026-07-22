-- LOCAL/TEST ONLY. Once any M3 business facts exist, repair forward.
SELECT "app_security"."assert_m37_coupon_integrity_rollback_safe"();

DROP TRIGGER IF EXISTS "member_coupons_claim_count_guard" ON "member_coupons";
DROP TRIGGER IF EXISTS "coupons_claim_count_guard" ON "coupons";
DROP TRIGGER IF EXISTS "member_coupons_claim_append_only" ON "member_coupons";
DROP TRIGGER IF EXISTS "coupons_claim_append_only" ON "coupons";
DROP FUNCTION IF EXISTS "app_security"."assert_coupon_claim_count"();
DROP FUNCTION IF EXISTS "app_security"."assert_coupon_claim_count_for"(uuid, uuid);
DROP FUNCTION IF EXISTS "app_security"."assert_m37_coupon_integrity_rollback_safe"();
GRANT UPDATE, DELETE ON TABLE "member_coupons" TO zalo_shop_runtime;
GRANT DELETE ON TABLE "coupons" TO zalo_shop_runtime;
