-- M3.7: keep coupon claimed_count bound to the append-only member claim facts.
-- The service performs both writes in one transaction; this deferred trigger
-- prevents a runtime caller from fabricating or deleting claim counters.

CREATE OR REPLACE FUNCTION "app_security"."assert_coupon_claim_count_for"(
  target_store uuid,
  target_coupon uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  claimed_count integer;
  fact_count bigint;
BEGIN
  SELECT c.claimed_count
    INTO claimed_count
    FROM public.coupons AS c
   WHERE c.store_id = target_store AND c.id = target_coupon;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT count(*)
    INTO fact_count
    FROM public.member_coupons AS mc
   WHERE mc.store_id = target_store AND mc.coupon_id = target_coupon;

  IF claimed_count::bigint <> fact_count THEN
    RAISE EXCEPTION 'coupon claim count invariant violated'
      USING ERRCODE = '23514';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION "app_security"."assert_coupon_claim_count"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_TABLE_NAME = 'coupons' THEN
    PERFORM app_security.assert_coupon_claim_count_for(NEW.store_id, NEW.id);
  ELSIF TG_TABLE_NAME = 'member_coupons' AND TG_OP = 'DELETE' THEN
    PERFORM app_security.assert_coupon_claim_count_for(OLD.store_id, OLD.coupon_id);
  ELSIF TG_TABLE_NAME = 'member_coupons' AND TG_OP = 'INSERT' THEN
    PERFORM app_security.assert_coupon_claim_count_for(NEW.store_id, NEW.coupon_id);
  ELSIF TG_TABLE_NAME = 'member_coupons' AND TG_OP = 'UPDATE' THEN
    PERFORM app_security.assert_coupon_claim_count_for(OLD.store_id, OLD.coupon_id);
    IF (NEW.store_id, NEW.coupon_id) IS DISTINCT FROM (OLD.store_id, OLD.coupon_id) THEN
      PERFORM app_security.assert_coupon_claim_count_for(NEW.store_id, NEW.coupon_id);
    END IF;
  ELSE
    RAISE EXCEPTION 'coupon claim count guard attached to unsupported table %', TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END
$$;

DO $m37_coupon_claim_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.coupons AS c
    LEFT JOIN (
      SELECT store_id, coupon_id, count(*) AS fact_count
      FROM public.member_coupons
      GROUP BY store_id, coupon_id
    ) AS facts
      ON facts.store_id = c.store_id AND facts.coupon_id = c.id
    WHERE c.claimed_count::bigint <> COALESCE(facts.fact_count, 0)
  ) THEN
    RAISE EXCEPTION 'existing coupon claim counts are inconsistent'
      USING ERRCODE = '23514';
  END IF;
END
$m37_coupon_claim_preflight$;

DROP TRIGGER IF EXISTS "coupons_claim_count_guard" ON "coupons";
CREATE CONSTRAINT TRIGGER "coupons_claim_count_guard"
AFTER INSERT OR UPDATE ON "coupons"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "app_security"."assert_coupon_claim_count"();

DROP TRIGGER IF EXISTS "member_coupons_claim_count_guard" ON "member_coupons";
CREATE CONSTRAINT TRIGGER "member_coupons_claim_count_guard"
AFTER INSERT OR UPDATE OR DELETE ON "member_coupons"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "app_security"."assert_coupon_claim_count"();

REVOKE ALL ON FUNCTION "app_security"."assert_coupon_claim_count_for"(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION "app_security"."assert_coupon_claim_count"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  "app_security"."assert_coupon_claim_count"()
TO zalo_shop_runtime;

DROP TRIGGER IF EXISTS "member_coupons_claim_append_only" ON "member_coupons";
CREATE TRIGGER "member_coupons_claim_append_only"
  BEFORE UPDATE OR DELETE ON "member_coupons"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_m3_fact_mutation"();
REVOKE UPDATE, DELETE ON TABLE "member_coupons" FROM zalo_shop_runtime;

DROP TRIGGER IF EXISTS "coupons_claim_append_only" ON "coupons";
CREATE TRIGGER "coupons_claim_append_only"
  BEFORE DELETE ON "coupons"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_m3_fact_mutation"();
REVOKE DELETE ON TABLE "coupons" FROM zalo_shop_runtime;

CREATE OR REPLACE FUNCTION "app_security"."assert_m37_coupon_integrity_rollback_safe"()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.inventory_operations)
     OR EXISTS (SELECT 1 FROM public.inventory_movements)
     OR EXISTS (SELECT 1 FROM public.inventory_reservations)
     OR EXISTS (SELECT 1 FROM public.inventory_reservation_items)
     OR EXISTS (
       SELECT 1 FROM public.inventory_balances WHERE on_hand <> 0 OR reserved <> 0
     )
     OR EXISTS (SELECT 1 FROM public.promotion_operations)
     OR EXISTS (SELECT 1 FROM public.promotion_versions WHERE status = 'PUBLISHED')
     OR EXISTS (SELECT 1 FROM public.coupons)
     OR EXISTS (SELECT 1 FROM public.member_coupons)
     OR EXISTS (SELECT 1 FROM public.carts)
  THEN
    RAISE EXCEPTION 'M3 facts exist; coupon integrity rollback is forbidden'
      USING ERRCODE = '55000';
  END IF;
END
$$;

REVOKE ALL ON FUNCTION
  "app_security"."assert_m37_coupon_integrity_rollback_safe"()
FROM PUBLIC;
