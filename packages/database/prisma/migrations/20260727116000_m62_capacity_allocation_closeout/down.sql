-- LOCAL/TEST ONLY. Restore the preceding conservative capacity calculation
-- only when no M6 business facts exist. Production uses forward repair.
SELECT "app_security"."assert_m62_rollback_safe"();

DROP TRIGGER "after_sale_policies_actor_guard" ON "after_sale_policies";
DROP TRIGGER "after_sale_policy_versions_actor_guard" ON "after_sale_policy_versions";
DROP TRIGGER "store_after_sale_settings_actor_guard" ON "store_after_sale_settings";
DROP TRIGGER "after_sale_order_allocations_integrity_guard" ON "after_sale_order_allocations";
DROP TRIGGER "after_sale_order_allocations_final_guard" ON "after_sale_order_allocations";
DROP TRIGGER "after_sale_transitions_order_capacity_guard" ON "after_sale_transitions";
DROP FUNCTION "app_security"."validate_m62_policy_actor"();
DROP FUNCTION "app_security"."validate_m62_policy_version_actor"();
DROP FUNCTION "app_security"."validate_m62_policy_settings_actor"();
DROP FUNCTION "app_security"."validate_m62_order_allocation"();
DROP FUNCTION "app_security"."validate_m62_order_approval_capacity"();
DROP FUNCTION "app_security"."validate_m62_order_allocation_final_state"();

CREATE OR REPLACE FUNCTION "app_security"."enforce_m62_after_sale_item_capacity"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE ordered_quantity integer;
DECLARE order_item_payable bigint;
DECLARE occupied_quantity bigint;
DECLARE occupied_vnd bigint;
BEGIN
  SELECT quantity, payable_vnd INTO ordered_quantity, order_item_payable
  FROM public.order_items
  WHERE store_id = NEW.store_id AND order_id = NEW.order_id AND id = NEW.order_item_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'after-sale item order line does not exist' USING ERRCODE = '23503';
  END IF;

  SELECT
    COALESCE(sum(CASE WHEN item.approved_quantity > 0
      THEN item.approved_quantity ELSE item.requested_quantity END), 0),
    COALESCE(sum(item.approved_item_vnd), 0)
  INTO occupied_quantity, occupied_vnd
  FROM public.after_sale_items item
  JOIN public.after_sales sale
    ON sale.store_id = item.store_id AND sale.id = item.after_sale_id
  WHERE item.store_id = NEW.store_id AND item.order_item_id = NEW.order_item_id
    AND item.id <> NEW.id
    AND (
      sale.status NOT IN ('REJECTED','CANCELLED')
      OR EXISTS (
        SELECT 1 FROM public.after_sale_inspections inspection
        WHERE inspection.store_id = sale.store_id AND inspection.after_sale_id = sale.id
      )
      OR EXISTS (
        SELECT 1 FROM public.after_sale_settlements settlement
        WHERE settlement.store_id = sale.store_id AND settlement.after_sale_id = sale.id
      )
      OR EXISTS (
        SELECT 1 FROM public.after_sale_inventory_actions action
        WHERE action.store_id = sale.store_id AND action.after_sale_id = sale.id
      )
      OR EXISTS (
        SELECT 1 FROM public.exchange_fulfillments exchange
        WHERE exchange.store_id = sale.store_id AND exchange.after_sale_id = sale.id
      )
    );

  occupied_quantity := occupied_quantity + CASE WHEN NEW.approved_quantity > 0
    THEN NEW.approved_quantity ELSE NEW.requested_quantity END;
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
  );

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_privacy_transition"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE current_status public.privacy_request_status;
BEGIN
  SELECT status INTO current_status
  FROM public.privacy_requests
  WHERE store_id = NEW.store_id
    AND id = NEW.privacy_request_id
    AND member_id = NEW.member_id
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
