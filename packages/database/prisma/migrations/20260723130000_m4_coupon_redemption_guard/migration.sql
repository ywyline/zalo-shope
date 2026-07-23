-- M4 coupon redemption is the only legal mutation of an M3 member-coupon fact.

CREATE OR REPLACE FUNCTION "app_security"."enforce_member_coupon_redemption"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF (NEW.id, NEW.store_id, NEW.coupon_id, NEW.member_id, NEW.claimed_at,
      NEW.expires_at, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.store_id, OLD.coupon_id, OLD.member_id, OLD.claimed_at,
      OLD.expires_at, OLD.created_at)
  THEN
    RAISE EXCEPTION 'member coupon identity and claim facts are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status <> 'CLAIMED'::member_coupon_status
     OR NEW.status <> 'USED'::member_coupon_status
     OR OLD.used_at IS NOT NULL
     OR OLD.used_order_id IS NOT NULL
     OR NEW.used_at IS NULL
     OR NEW.used_order_id IS NULL
     OR NEW.updated_at < OLD.updated_at
  THEN
    RAISE EXCEPTION 'member coupon only supports one CLAIMED to USED redemption'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS "member_coupons_claim_append_only" ON "member_coupons";
DROP TRIGGER IF EXISTS "member_coupons_claim_redemption_guard" ON "member_coupons";
CREATE TRIGGER "member_coupons_claim_redemption_guard"
  BEFORE UPDATE ON "member_coupons"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."enforce_member_coupon_redemption"();

CREATE TRIGGER "member_coupons_claim_append_only"
  BEFORE DELETE ON "member_coupons"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_m3_fact_mutation"();

REVOKE UPDATE ON TABLE "member_coupons" FROM zalo_shop_runtime;
GRANT UPDATE (status, used_at, used_order_id, updated_at)
  ON TABLE "member_coupons" TO zalo_shop_runtime;

REVOKE ALL ON FUNCTION "app_security"."enforce_member_coupon_redemption"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app_security"."enforce_member_coupon_redemption"()
  TO zalo_shop_runtime;
