-- M6.2 forward-only capacity correction. Pending requests reserve requested
-- quantity; after a decision, only the approved quantity remains occupied.

CREATE OR REPLACE FUNCTION "app_security"."enforce_m62_after_sale_item_capacity"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE ordered_quantity integer;
DECLARE order_item_payable bigint;
DECLARE current_status public.after_sale_status;
DECLARE current_legacy_review boolean;
DECLARE current_review_resume_status public.after_sale_status;
DECLARE occupied_quantity bigint;
DECLARE occupied_vnd bigint;
BEGIN
  SELECT item.quantity, item.payable_vnd
  INTO ordered_quantity, order_item_payable
  FROM public.order_items item
  WHERE item.store_id = NEW.store_id
    AND item.order_id = NEW.order_id
    AND item.id = NEW.order_item_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'after-sale item order line does not exist' USING ERRCODE = '23503';
  END IF;

  SELECT sale.status, sale.legacy_policy_review, sale.review_resume_status
  INTO current_status, current_legacy_review, current_review_resume_status
  FROM public.after_sales sale
  WHERE sale.store_id = NEW.store_id
    AND sale.id = NEW.after_sale_id
    AND sale.order_id = NEW.order_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'after-sale item aggregate does not exist' USING ERRCODE = '23503';
  END IF;

  SELECT
    COALESCE(sum(CASE
      WHEN sale.status = 'PENDING_REVIEW'
        OR (sale.status = 'REVIEW_REQUIRED'
          AND sale.legacy_policy_review
          AND sale.review_resume_status IS NULL)
      THEN item.requested_quantity
      ELSE item.approved_quantity
    END), 0),
    COALESCE(sum(item.approved_item_vnd), 0)
  INTO occupied_quantity, occupied_vnd
  FROM public.after_sale_items item
  JOIN public.after_sales sale
    ON sale.store_id = item.store_id AND sale.id = item.after_sale_id
  WHERE item.store_id = NEW.store_id
    AND item.order_item_id = NEW.order_item_id
    AND item.id <> NEW.id
    AND (
      sale.status NOT IN ('REJECTED','CANCELLED')
      OR EXISTS (
        SELECT 1 FROM public.after_sale_inspections inspection
        WHERE inspection.store_id = sale.store_id
          AND inspection.after_sale_id = sale.id
      )
      OR EXISTS (
        SELECT 1 FROM public.after_sale_settlements settlement
        WHERE settlement.store_id = sale.store_id
          AND settlement.after_sale_id = sale.id
      )
      OR EXISTS (
        SELECT 1 FROM public.after_sale_inventory_actions action
        WHERE action.store_id = sale.store_id
          AND action.after_sale_id = sale.id
      )
      OR EXISTS (
        SELECT 1 FROM public.exchange_fulfillments exchange
        WHERE exchange.store_id = sale.store_id
          AND exchange.after_sale_id = sale.id
      )
    );

  occupied_quantity := occupied_quantity + CASE
    WHEN current_status = 'PENDING_REVIEW'
      OR (current_status = 'REVIEW_REQUIRED'
        AND current_legacy_review
        AND current_review_resume_status IS NULL)
    THEN NEW.requested_quantity
    ELSE NEW.approved_quantity
  END;
  occupied_vnd := occupied_vnd + NEW.approved_item_vnd;
  IF occupied_quantity > ordered_quantity OR occupied_vnd > order_item_payable THEN
    RAISE EXCEPTION 'after-sale quantity or amount exceeds remaining order-item entitlement'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION "app_security"."enforce_m62_after_sale_item_capacity"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "app_security"."enforce_m62_after_sale_item_capacity"()
FROM zalo_shop_runtime;

DROP POLICY "privacy_request_transitions_admin_insert" ON "privacy_request_transitions";
CREATE POLICY "privacy_request_transitions_admin_insert" ON "privacy_request_transitions"
  FOR INSERT WITH CHECK (
    "store_id" = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'admin'
    AND "actor_type" = 'ADMIN'
    AND "actor_id" = app_security.current_actor_id()
    AND EXISTS (
      SELECT 1 FROM public.admin_users admin
      WHERE admin.id = app_security.current_actor_id()
    )
  );

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_privacy_transition"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE current_status public.privacy_request_status;
DECLARE actor_context text;
BEGIN
  actor_context := pg_catalog.current_setting('app.actor_type', true);
  IF NEW.store_id IS DISTINCT FROM app_security.current_store_id() THEN
    RAISE EXCEPTION 'privacy transition store does not match the current context'
      USING ERRCODE = '42501';
  END IF;
  IF actor_context = 'member' THEN
    IF NEW.event <> 'CANCEL'
       OR NEW.actor_type <> 'MEMBER'
       OR NEW.actor_id IS DISTINCT FROM app_security.current_actor_id()
       OR NEW.member_id IS DISTINCT FROM app_security.current_actor_id()
    THEN
      RAISE EXCEPTION 'member may only append an owned privacy cancellation'
        USING ERRCODE = '42501';
    END IF;
  ELSIF actor_context = 'admin' THEN
    IF NEW.actor_type <> 'ADMIN'
       OR NEW.actor_id IS DISTINCT FROM app_security.current_actor_id()
       OR NOT EXISTS (
         SELECT 1 FROM public.admin_users admin
         WHERE admin.id = app_security.current_actor_id()
       )
    THEN
      RAISE EXCEPTION 'privacy transition actor is not the current administrator'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'privacy transitions require an authenticated member or administrator'
      USING ERRCODE = '42501';
  END IF;

  SELECT request.status INTO current_status
  FROM public.privacy_requests request
  WHERE request.store_id = NEW.store_id
    AND request.id = NEW.privacy_request_id
    AND request.member_id = NEW.member_id
  FOR UPDATE;
  IF NOT FOUND OR current_status <> NEW.from_status OR NOT (
    (NEW.from_status = 'SUBMITTED' AND NEW.event = 'START_REVIEW' AND NEW.to_status = 'UNDER_REVIEW')
    OR (NEW.from_status IN ('SUBMITTED','UNDER_REVIEW') AND NEW.event = 'REQUEST_ACTION' AND NEW.to_status = 'ACTION_REQUIRED')
    OR (NEW.from_status = 'ACTION_REQUIRED' AND NEW.event = 'PROVIDE_ACTION' AND NEW.to_status = 'SUBMITTED')
    OR (NEW.from_status = 'UNDER_REVIEW' AND NEW.event = 'START_FULFILLMENT' AND NEW.to_status = 'IN_PROGRESS')
    OR (NEW.from_status IN ('UNDER_REVIEW','IN_PROGRESS') AND NEW.event = 'REJECT' AND NEW.to_status = 'REJECTED')
    OR (NEW.from_status = 'IN_PROGRESS' AND NEW.event = 'COMPLETE' AND NEW.to_status = 'COMPLETED')
    OR (NEW.from_status IN ('SUBMITTED','ACTION_REQUIRED') AND NEW.event = 'CANCEL' AND NEW.to_status = 'CANCELLED')
  ) THEN
    RAISE EXCEPTION 'invalid privacy request transition event or current state'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION "app_security"."validate_m62_privacy_transition"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "app_security"."validate_m62_privacy_transition"()
FROM zalo_shop_runtime;

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_policy_actor"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF pg_catalog.current_setting('app.actor_type', true) <> 'admin'
     OR NEW.store_id IS DISTINCT FROM app_security.current_store_id()
     OR NEW.updated_by IS DISTINCT FROM app_security.current_actor_id()
     OR NOT EXISTS (
       SELECT 1 FROM public.admin_users admin
       WHERE admin.id = app_security.current_actor_id()
     )
     OR (TG_OP = 'INSERT' AND NEW.created_by IS DISTINCT FROM app_security.current_actor_id())
     OR (TG_OP = 'UPDATE' AND NEW.created_by IS DISTINCT FROM OLD.created_by)
  THEN
    RAISE EXCEPTION 'after-sale policy audit actors must match the current administrator'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "after_sale_policies_actor_guard"
  BEFORE INSERT OR UPDATE ON "after_sale_policies"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_policy_actor"();

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_policy_version_actor"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF pg_catalog.current_setting('app.actor_type', true) <> 'admin'
     OR NEW.store_id IS DISTINCT FROM app_security.current_store_id()
     OR NEW.published_by IS DISTINCT FROM app_security.current_actor_id()
     OR NOT EXISTS (
       SELECT 1 FROM public.admin_users admin
       WHERE admin.id = app_security.current_actor_id()
     )
  THEN
    RAISE EXCEPTION 'after-sale policy version publisher must match the current administrator'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "after_sale_policy_versions_actor_guard"
  BEFORE INSERT ON "after_sale_policy_versions"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_policy_version_actor"();

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_policy_settings_actor"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE readiness_changed boolean;
BEGIN
  readiness_changed := TG_OP = 'INSERT'
    OR NEW.readiness_checked_at IS DISTINCT FROM OLD.readiness_checked_at
    OR NEW.readiness_ready_at IS DISTINCT FROM OLD.readiness_ready_at
    OR NEW.readiness_hash IS DISTINCT FROM OLD.readiness_hash
    OR NEW.readiness_checked_by IS DISTINCT FROM OLD.readiness_checked_by;
  IF pg_catalog.current_setting('app.actor_type', true) <> 'admin'
     OR NEW.store_id IS DISTINCT FROM app_security.current_store_id()
     OR NEW.updated_by IS DISTINCT FROM app_security.current_actor_id()
     OR NOT EXISTS (
       SELECT 1 FROM public.admin_users admin
       WHERE admin.id = app_security.current_actor_id()
     )
     OR (readiness_changed AND (
       ((NEW.readiness_checked_at IS NOT NULL
          OR NEW.readiness_ready_at IS NOT NULL
          OR NEW.readiness_hash IS NOT NULL)
        AND NEW.readiness_checked_by IS DISTINCT FROM app_security.current_actor_id())
       OR ((NEW.readiness_checked_at IS NULL
          AND NEW.readiness_ready_at IS NULL
          AND NEW.readiness_hash IS NULL)
        AND NEW.readiness_checked_by IS NOT NULL)
     ))
  THEN
    RAISE EXCEPTION 'after-sale policy settings audit actors must match the current administrator'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "store_after_sale_settings_actor_guard"
  BEFORE INSERT OR UPDATE ON "store_after_sale_settings"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_policy_settings_actor"();

REVOKE ALL ON FUNCTION
  "app_security"."validate_m62_policy_actor"(),
  "app_security"."validate_m62_policy_version_actor"(),
  "app_security"."validate_m62_policy_settings_actor"()
FROM PUBLIC;
REVOKE ALL ON FUNCTION
  "app_security"."validate_m62_policy_actor"(),
  "app_security"."validate_m62_policy_version_actor"(),
  "app_security"."validate_m62_policy_settings_actor"()
FROM zalo_shop_runtime;

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_order_allocation"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE sale_record record;
DECLARE order_record record;
BEGIN
  IF pg_catalog.current_setting('app.actor_type', true) <> 'admin'
     OR NEW.store_id IS DISTINCT FROM app_security.current_store_id()
     OR NOT EXISTS (
       SELECT 1 FROM public.admin_users admin
       WHERE admin.id = app_security.current_actor_id()
     )
  THEN
    RAISE EXCEPTION 'after-sale order allocation requires the current administrator'
      USING ERRCODE = '42501';
  END IF;

  SELECT sale.status, sale.legacy_policy_review, sale.review_resume_status,
    sale.approved_shipping_vnd, sale.approved_other_vnd
  INTO sale_record
  FROM public.after_sales sale
  WHERE sale.store_id = NEW.store_id
    AND sale.id = NEW.after_sale_id
    AND sale.order_id = NEW.order_id
  FOR UPDATE;
  IF NOT FOUND
     OR NOT (sale_record.status = 'PENDING_REVIEW'
       OR (sale_record.status = 'REVIEW_REQUIRED'
         AND sale_record.legacy_policy_review
         AND sale_record.review_resume_status IS NULL))
     OR NEW.shipping_fee_vnd + NEW.remote_surcharge_vnd
       <> sale_record.approved_shipping_vnd
     OR NEW.other_vnd <> sale_record.approved_other_vnd
  THEN
    RAISE EXCEPTION 'order allocation must exactly match the pending after-sale approval'
      USING ERRCODE = '23514';
  END IF;

  SELECT orders.shipping_fee_vnd, orders.remote_surcharge_vnd,
    orders.shipping_discount_vnd
  INTO order_record
  FROM public.orders orders
  WHERE orders.store_id = NEW.store_id AND orders.id = NEW.order_id
  FOR UPDATE;
  IF NOT FOUND
     OR NEW.shipping_fee_vnd > order_record.shipping_fee_vnd
     OR NEW.remote_surcharge_vnd > order_record.remote_surcharge_vnd
     OR NEW.shipping_fee_vnd + NEW.remote_surcharge_vnd
       > pg_catalog.greatest(
         order_record.shipping_fee_vnd + order_record.remote_surcharge_vnd
           - order_record.shipping_discount_vnd,
         0
       )
  THEN
    RAISE EXCEPTION 'order allocation exceeds the paid shipping entitlement'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "after_sale_order_allocations_integrity_guard"
  BEFORE INSERT ON "after_sale_order_allocations"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_order_allocation"();

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_order_approval_capacity"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE sale_record record;
DECLARE allocation_record record;
DECLARE allocation_found boolean;
DECLARE order_payable bigint;
DECLARE occupied_total bigint;
BEGIN
  IF NEW.event NOT IN ('APPROVE','LEGACY_APPROVE') THEN
    RETURN NEW;
  END IF;

  SELECT sale.order_id, sale.requested_shipping_vnd, sale.requested_other_vnd,
    sale.approved_shipping_vnd, sale.approved_other_vnd, sale.approved_total_vnd
  INTO sale_record
  FROM public.after_sales sale
  WHERE sale.store_id = NEW.store_id AND sale.id = NEW.after_sale_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'after-sale approval aggregate does not exist' USING ERRCODE = '23503';
  END IF;

  SELECT orders.payable_vnd INTO order_payable
  FROM public.orders orders
  WHERE orders.store_id = NEW.store_id AND orders.id = sale_record.order_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'after-sale approval order does not exist' USING ERRCODE = '23503';
  END IF;

  SELECT allocation.shipping_fee_vnd, allocation.remote_surcharge_vnd,
    allocation.other_vnd
  INTO allocation_record
  FROM public.after_sale_order_allocations allocation
  WHERE allocation.store_id = NEW.store_id
    AND allocation.after_sale_id = NEW.after_sale_id;
  allocation_found := FOUND;
  IF sale_record.approved_shipping_vnd > sale_record.requested_shipping_vnd
     OR sale_record.approved_other_vnd > sale_record.requested_other_vnd
     OR ((sale_record.approved_shipping_vnd > 0 OR sale_record.approved_other_vnd > 0) AND (
       NOT allocation_found
       OR allocation_record.shipping_fee_vnd + allocation_record.remote_surcharge_vnd
         <> sale_record.approved_shipping_vnd
       OR allocation_record.other_vnd <> sale_record.approved_other_vnd
     ))
     OR (sale_record.approved_shipping_vnd = 0
       AND sale_record.approved_other_vnd = 0
       AND allocation_found)
  THEN
    RAISE EXCEPTION 'approved order-level amounts require one exact immutable allocation'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(pg_catalog.sum(other_sale.approved_total_vnd), 0)
  INTO occupied_total
  FROM public.after_sales other_sale
  WHERE other_sale.store_id = NEW.store_id
    AND other_sale.order_id = sale_record.order_id
    AND other_sale.id <> NEW.after_sale_id
    AND (
      other_sale.status NOT IN ('REJECTED','CANCELLED')
      OR EXISTS (
        SELECT 1 FROM public.after_sale_inspections inspection
        WHERE inspection.store_id = other_sale.store_id
          AND inspection.after_sale_id = other_sale.id
      )
      OR EXISTS (
        SELECT 1 FROM public.after_sale_settlements settlement
        WHERE settlement.store_id = other_sale.store_id
          AND settlement.after_sale_id = other_sale.id
      )
      OR EXISTS (
        SELECT 1 FROM public.after_sale_inventory_actions action
        WHERE action.store_id = other_sale.store_id
          AND action.after_sale_id = other_sale.id
      )
      OR EXISTS (
        SELECT 1 FROM public.exchange_fulfillments fulfillment
        WHERE fulfillment.store_id = other_sale.store_id
          AND fulfillment.after_sale_id = other_sale.id
      )
    );
  IF occupied_total + sale_record.approved_total_vnd > order_payable THEN
    RAISE EXCEPTION 'after-sale approvals exceed the remaining order entitlement'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "after_sale_transitions_order_capacity_guard"
  BEFORE INSERT ON "after_sale_transitions"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_order_approval_capacity"();

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_order_allocation_final_state"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE sale_record record;
BEGIN
  SELECT sale.approved_shipping_vnd, sale.approved_other_vnd
  INTO sale_record
  FROM public.after_sales sale
  WHERE sale.store_id = NEW.store_id
    AND sale.id = NEW.after_sale_id
    AND sale.order_id = NEW.order_id
  FOR UPDATE;
  IF NOT FOUND
     OR NEW.shipping_fee_vnd + NEW.remote_surcharge_vnd
       <> sale_record.approved_shipping_vnd
     OR NEW.other_vnd <> sale_record.approved_other_vnd
     OR NOT EXISTS (
       SELECT 1 FROM public.after_sale_transitions transition
       WHERE transition.store_id = NEW.store_id
         AND transition.after_sale_id = NEW.after_sale_id
         AND transition.event IN ('APPROVE','LEGACY_APPROVE')
         AND transition.to_status = 'APPROVED'
     )
  THEN
    RAISE EXCEPTION 'order allocation must commit with its authoritative approval transition'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER "after_sale_order_allocations_final_guard"
  AFTER INSERT ON "after_sale_order_allocations"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_order_allocation_final_state"();

REVOKE ALL ON FUNCTION
  "app_security"."validate_m62_order_allocation"(),
  "app_security"."validate_m62_order_approval_capacity"(),
  "app_security"."validate_m62_order_allocation_final_state"()
FROM PUBLIC;
REVOKE ALL ON FUNCTION
  "app_security"."validate_m62_order_allocation"(),
  "app_security"."validate_m62_order_approval_capacity"(),
  "app_security"."validate_m62_order_allocation_final_state"()
FROM zalo_shop_runtime;
