-- Close promotion publication races and freeze coupon rule facts after activation.

CREATE OR REPLACE FUNCTION "app_security"."reject_published_promotion_child_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status promotion_version_status;
DECLARE target_store uuid;
DECLARE target_version uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    FOR parent_status IN
      SELECT pv.status
      FROM promotion_versions pv
      WHERE (pv.store_id = OLD.store_id AND pv.id = OLD.promotion_version_id)
         OR (pv.store_id = NEW.store_id AND pv.id = NEW.promotion_version_id)
      ORDER BY pv.store_id, pv.id
      FOR SHARE
    LOOP
      IF parent_status = 'PUBLISHED' THEN
        RAISE EXCEPTION 'published promotion version content is immutable' USING ERRCODE = '42501';
      END IF;
    END LOOP;
    RETURN NEW;
  END IF;

  target_store := CASE WHEN TG_OP = 'DELETE' THEN OLD.store_id ELSE NEW.store_id END;
  target_version := CASE
    WHEN TG_OP = 'DELETE' THEN OLD.promotion_version_id
    ELSE NEW.promotion_version_id
  END;
  SELECT pv.status INTO parent_status
  FROM promotion_versions pv
  WHERE pv.store_id = target_store AND pv.id = target_version
  FOR SHARE;
  IF parent_status = 'PUBLISHED' THEN
    RAISE EXCEPTION 'published promotion version content is immutable' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION "app_security"."enforce_coupon_update"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rule_facts_changed boolean;
BEGIN
  rule_facts_changed :=
    NEW.code IS DISTINCT FROM OLD.code
    OR NEW.promotion_version_id IS DISTINCT FROM OLD.promotion_version_id
    OR NEW.total_claim_limit IS DISTINCT FROM OLD.total_claim_limit
    OR NEW.per_member_claim_limit IS DISTINCT FROM OLD.per_member_claim_limit
    OR NEW.new_customer_only IS DISTINCT FROM OLD.new_customer_only
    OR NEW.created_at IS DISTINCT FROM OLD.created_at;

  IF OLD.status = 'DRAFT' AND NEW.status = 'DRAFT' THEN
    IF NEW.claimed_count <> OLD.claimed_count OR NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'coupon draft updates require one version increment' USING ERRCODE = '23514';
    END IF;
    IF NEW.code IS DISTINCT FROM OLD.code OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'coupon identity is immutable' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'ACTIVE'
     AND NEW.status = OLD.status
     AND NEW.claimed_count = OLD.claimed_count + 1
     AND NEW.version = OLD.version
     AND NOT rule_facts_changed
  THEN
    RETURN NEW;
  END IF;

  IF (
       (OLD.status = 'DRAFT' AND NEW.status = 'ACTIVE')
       OR (OLD.status = 'ACTIVE' AND NEW.status IN ('PAUSED', 'ENDED'))
       OR (OLD.status = 'PAUSED' AND NEW.status IN ('ACTIVE', 'ENDED'))
     )
     AND NEW.claimed_count = OLD.claimed_count
     AND NEW.version = OLD.version + 1
     AND NOT rule_facts_changed
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'invalid coupon update or status transition' USING ERRCODE = '23514';
END
$$;

DROP TRIGGER "coupons_state_guard" ON "coupons";
CREATE TRIGGER "coupons_state_guard" BEFORE UPDATE ON "coupons"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."enforce_coupon_update"();

REVOKE ALL ON FUNCTION "app_security"."enforce_coupon_update"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app_security"."enforce_coupon_update"() TO zalo_shop_runtime;
