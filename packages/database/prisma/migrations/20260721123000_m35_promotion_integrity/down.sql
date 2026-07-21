-- LOCAL/TEST ONLY. Keep this forward fix once promotion or coupon facts exist.
DO $m35_integrity_down_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM promotion_versions WHERE status = 'PUBLISHED')
    OR EXISTS (SELECT 1 FROM coupons WHERE status <> 'DRAFT' OR claimed_count <> 0)
  THEN
    RAISE EXCEPTION 'M3.5 promotion facts exist; integrity rollback is forbidden' USING ERRCODE = '55000';
  END IF;
END
$m35_integrity_down_guard$;

CREATE OR REPLACE FUNCTION "app_security"."reject_published_promotion_child_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_store uuid;
DECLARE target_version uuid;
DECLARE parent_status promotion_version_status;
BEGIN
  target_store := CASE WHEN TG_OP = 'DELETE' THEN OLD.store_id ELSE NEW.store_id END;
  target_version := CASE
    WHEN TG_OP = 'DELETE' THEN OLD.promotion_version_id
    ELSE NEW.promotion_version_id
  END;
  SELECT status INTO parent_status FROM promotion_versions
  WHERE store_id = target_store AND id = target_version;
  IF parent_status = 'PUBLISHED' THEN
    RAISE EXCEPTION 'published promotion version content is immutable' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER "coupons_state_guard" ON "coupons";
CREATE TRIGGER "coupons_state_guard" BEFORE UPDATE ON "coupons"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."enforce_m3_state_transition"();

DROP FUNCTION "app_security"."enforce_coupon_update"();
