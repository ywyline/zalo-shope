-- LOCAL/TEST ONLY. A redeemed coupon is an immutable order fact and blocks rollback.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "member_coupons" WHERE "status" = 'USED' LIMIT 1) THEN
    RAISE EXCEPTION 'M4 coupon redemption guard rollback is unsafe after coupon redemption'
      USING ERRCODE = '55000';
  END IF;
END
$$;

REVOKE UPDATE (status, used_at, used_order_id, updated_at)
  ON TABLE "member_coupons" FROM zalo_shop_runtime;

DROP TRIGGER IF EXISTS "member_coupons_claim_redemption_guard" ON "member_coupons";
DROP TRIGGER IF EXISTS "member_coupons_claim_append_only" ON "member_coupons";
CREATE TRIGGER "member_coupons_claim_append_only"
  BEFORE UPDATE OR DELETE ON "member_coupons"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_m3_fact_mutation"();

DROP FUNCTION IF EXISTS "app_security"."enforce_member_coupon_redemption"();
