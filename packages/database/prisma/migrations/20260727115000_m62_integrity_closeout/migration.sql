-- M6.2 forward-only integrity closeout.  Earlier migrations are intentionally
-- left unchanged so deployed checksums remain stable.

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_after_sale_initial_shape"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT (
       (NOT NEW.legacy_policy_review AND NEW.status = 'PENDING_REVIEW')
       OR (NEW.legacy_policy_review AND NEW.status = 'REVIEW_REQUIRED')
     )
     OR NEW.version <> 1
     OR NEW.review_resume_status IS NOT NULL
     OR NEW.review_reason IS NOT NULL
     OR NEW.return_deadline_at IS NOT NULL
     OR NEW.return_expired_at IS NOT NULL
     OR NEW.approved_item_vnd <> 0
     OR NEW.approved_shipping_vnd <> 0
     OR NEW.approved_other_vnd <> 0
     OR NEW.approved_total_vnd <> 0
     OR NEW.reviewed_by IS NOT NULL
     OR NEW.reviewed_at IS NOT NULL
     OR NEW.completed_at IS NOT NULL
     OR (pg_catalog.current_setting('app.actor_type', true) = 'member'
         AND (NEW.type = 'MERCHANT_REFUND'
              OR NEW.source <> 'MEMBER'
              OR NEW.member_id <> app_security.current_actor_id()
              OR NEW.initiated_by <> app_security.current_actor_id()))
     OR (pg_catalog.current_setting('app.actor_type', true) = 'admin'
         AND (NEW.source <> 'ADMIN' OR NEW.initiated_by <> app_security.current_actor_id()))
  THEN
    RAISE EXCEPTION 'after-sale must start pending review, or explicit legacy review when no policy snapshot exists'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "after_sales_initial_shape_guard"
  BEFORE INSERT ON "after_sales"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_after_sale_initial_shape"();

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_after_sale_item_initial_shape"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE case_record record;
DECLARE actor_context text;
BEGIN
  SELECT sale.type, sale.status, sale.legacy_policy_review, sale.member_id
  INTO case_record
  FROM public.after_sales sale
  WHERE sale.store_id = NEW.store_id AND sale.id = NEW.after_sale_id
    AND sale.order_id = NEW.order_id
  FOR UPDATE;
  actor_context := pg_catalog.current_setting('app.actor_type', true);
  IF NOT FOUND
     OR NOT (case_record.status = 'PENDING_REVIEW'
       OR (case_record.status = 'REVIEW_REQUIRED' AND case_record.legacy_policy_review))
     OR NEW.approved_quantity <> 0
     OR NEW.received_quantity <> 0
     OR NEW.accepted_quantity <> 0
     OR NEW.rejected_quantity <> 0
     OR NEW.restockable_quantity <> 0
     OR NEW.restored_quantity <> 0
     OR NEW.approved_item_vnd <> 0
     OR NEW.condition IS NOT NULL
     OR NEW.disposition IS NOT NULL
     OR NEW.inspection_version <> 0
     OR NEW.inspected_by IS NOT NULL
     OR NEW.replacement_quantity <> 0
     OR (case_record.type <> 'EXCHANGE' AND NEW.replacement_sku_id IS NOT NULL)
  THEN
    RAISE EXCEPTION 'after-sale item must be created without approval or fulfillment facts'
      USING ERRCODE = '23514';
  END IF;
  IF actor_context = 'member' THEN
    IF case_record.member_id <> app_security.current_actor_id() THEN
      RAISE EXCEPTION 'member may only add an item to the owned pending after-sale'
        USING ERRCODE = '42501';
    END IF;
  ELSIF actor_context = 'admin' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.admin_users admin
      WHERE admin.id = app_security.current_actor_id()
    ) THEN
      RAISE EXCEPTION 'after-sale item actor is not a current administrator'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'after-sale item creation requires an authenticated member or administrator'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "after_sale_items_initial_shape_guard"
  BEFORE INSERT ON "after_sale_items"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_after_sale_item_initial_shape"();

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_legacy_decision"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE sale_record record;
DECLARE sale_found boolean;
BEGIN
  SELECT sale.status, sale.review_resume_status, sale.legacy_policy_review
  INTO sale_record
  FROM public.after_sales sale
  WHERE sale.store_id = NEW.store_id AND sale.id = NEW.after_sale_id
  FOR UPDATE;
  sale_found := FOUND;
  IF pg_catalog.current_setting('app.actor_type', true) <> 'admin'
     OR NEW.store_id IS DISTINCT FROM app_security.current_store_id()
     OR NEW.admin_id IS DISTINCT FROM app_security.current_actor_id()
     OR NOT EXISTS (
       SELECT 1 FROM public.admin_users admin
       WHERE admin.id = NEW.admin_id
     )
  THEN
    RAISE EXCEPTION 'legacy after-sale decision actor is not the current administrator'
      USING ERRCODE = '42501';
  END IF;
  IF NOT sale_found
     OR NOT sale_record.legacy_policy_review
     OR sale_record.status <> 'REVIEW_REQUIRED'
     OR sale_record.review_resume_status IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM public.after_sale_legacy_decisions decision
       WHERE decision.store_id = NEW.store_id
         AND decision.after_sale_id = NEW.after_sale_id
     )
     OR EXISTS (
       SELECT 1 FROM public.after_sale_settlements settlement
       WHERE settlement.store_id = NEW.store_id
         AND settlement.after_sale_id = NEW.after_sale_id
     )
     OR EXISTS (
       SELECT 1 FROM public.after_sale_return_shipments return_shipment
       WHERE return_shipment.store_id = NEW.store_id
         AND return_shipment.after_sale_id = NEW.after_sale_id
     )
     OR EXISTS (
       SELECT 1 FROM public.shipments shipment
       WHERE shipment.store_id = NEW.store_id
         AND shipment.after_sale_id = NEW.after_sale_id
         AND shipment.purpose <> 'ORDER_OUTBOUND'
     )
     OR EXISTS (
       SELECT 1 FROM public.after_sale_inspections inspection
       WHERE inspection.store_id = NEW.store_id
         AND inspection.after_sale_id = NEW.after_sale_id
     )
     OR EXISTS (
       SELECT 1 FROM public.after_sale_inventory_actions action
       WHERE action.store_id = NEW.store_id
         AND action.after_sale_id = NEW.after_sale_id
     )
     OR EXISTS (
       SELECT 1 FROM public.exchange_fulfillments fulfillment
       WHERE fulfillment.store_id = NEW.store_id
         AND fulfillment.after_sale_id = NEW.after_sale_id
     )
  THEN
    RAISE EXCEPTION 'legacy after-sale decision requires the untouched initial legacy review state'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "after_sale_legacy_decisions_initial_guard"
  BEFORE INSERT ON "after_sale_legacy_decisions"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_legacy_decision"();

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_after_sale_item_approval"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE sale_type public.after_sale_type;
DECLARE sale_status public.after_sale_status;
DECLARE is_legacy boolean;
BEGIN
  SELECT sale.type, sale.status, sale.legacy_policy_review
  INTO sale_type, sale_status, is_legacy
  FROM public.after_sales sale
  WHERE sale.store_id = NEW.store_id AND sale.id = NEW.after_sale_id
  FOR UPDATE;
  IF pg_catalog.current_setting('app.actor_type', true) <> 'admin'
     OR NOT FOUND
     OR NOT ((sale_status = 'PENDING_REVIEW' AND NOT is_legacy)
       OR (sale_status = 'REVIEW_REQUIRED' AND is_legacy))
     OR ((NEW.approved_quantity = 0) IS DISTINCT FROM (NEW.approved_item_vnd = 0))
     OR (sale_type = 'EXCHANGE' AND (
       NEW.replacement_quantity <> NEW.approved_quantity
       OR (NEW.approved_quantity > 0 AND (
         NEW.replacement_sku_id IS NULL OR NEW.replacement_sku_id = NEW.sku_id))))
     OR (sale_type <> 'EXCHANGE' AND (
       NEW.replacement_sku_id IS NOT NULL OR NEW.replacement_quantity <> 0))
  THEN
    RAISE EXCEPTION 'after-sale item approval must be an atomic admin decision for the pending case'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "after_sale_items_approval_guard"
  BEFORE UPDATE OF "approved_quantity", "approved_item_vnd", "replacement_quantity"
  ON "after_sale_items"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_after_sale_item_approval"();
GRANT UPDATE ("replacement_quantity") ON "after_sale_items" TO zalo_shop_runtime;

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_after_sale_operation_initial_shape"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.status <> 'PENDING' OR NEW.result_summary IS NOT NULL
     OR NEW.error_code IS NOT NULL OR NEW.attempt_count <> 0 OR NEW.version <> 1
  THEN
    RAISE EXCEPTION 'after-sale operation must be created pending without a result'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "after_sale_operations_initial_shape_guard"
  BEFORE INSERT ON "after_sale_operations"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_after_sale_operation_initial_shape"();

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_after_sale_approval_fields"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE approved_line_total bigint;
BEGIN
  SELECT COALESCE(pg_catalog.sum(item.approved_item_vnd), 0)
  INTO approved_line_total
  FROM public.after_sale_items item
  WHERE item.store_id = NEW.store_id AND item.after_sale_id = NEW.id;
  IF pg_catalog.current_setting('app.actor_type', true) <> 'admin'
     OR NOT ((OLD.status = 'PENDING_REVIEW' AND NEW.status = 'PENDING_REVIEW'
         AND NOT OLD.legacy_policy_review AND NOT NEW.legacy_policy_review)
       OR (OLD.status = 'REVIEW_REQUIRED' AND NEW.status = 'REVIEW_REQUIRED'
         AND OLD.legacy_policy_review AND NEW.legacy_policy_review))
     OR NEW.approved_item_vnd <> approved_line_total
     OR (NEW.type IN ('RETURN_REFUND','EXCHANGE') AND NEW.approved_total_vnd > 0
       AND (NEW.return_deadline_at IS NULL OR NEW.return_deadline_at <= pg_catalog.clock_timestamp()))
     OR (NEW.type IN ('REFUND_ONLY','MERCHANT_REFUND') AND NEW.return_deadline_at IS NOT NULL)
  THEN
    RAISE EXCEPTION 'after-sale approval amounts and return deadline require a pending admin decision'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "after_sales_approval_fields_guard"
  BEFORE UPDATE OF "approved_item_vnd", "approved_shipping_vnd", "approved_other_vnd",
    "approved_total_vnd", "return_deadline_at"
  ON "after_sales"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_after_sale_approval_fields"();

DROP TRIGGER "after_sales_member_cancel_guard" ON "after_sales";
DROP TRIGGER "after_sale_transitions_apply_member_cancel" ON "after_sale_transitions";
DROP POLICY "after_sales_member_cancel" ON "after_sales";
DROP FUNCTION "app_security"."apply_m62_member_after_sale_cancel"();
DROP FUNCTION "app_security"."validate_m62_member_after_sale_cancel"();

CREATE POLICY "after_sales_transition_projection" ON "after_sales"
  FOR UPDATE
  USING (
    "store_id" = app_security.current_store_id()
    AND CURRENT_USER <> SESSION_USER
  )
  WITH CHECK (
    "store_id" = app_security.current_store_id()
    AND CURRENT_USER <> SESSION_USER
  );

REVOKE UPDATE ("status","review_resume_status","return_expired_at","version","reviewed_by","reviewed_at","completed_at")
ON "after_sales" FROM zalo_shop_runtime;

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_after_sale_transition"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE sale record;
DECLARE graph_match boolean := false;
BEGIN
  SELECT * INTO sale
  FROM public.after_sales current_sale
  WHERE current_sale.store_id = NEW.store_id AND current_sale.id = NEW.after_sale_id
  FOR UPDATE;
  IF NOT FOUND OR NEW.from_status IS NULL OR NEW.from_status <> sale.status THEN
    RAISE EXCEPTION 'after-sale transition must start from the locked current status'
      USING ERRCODE = '23514';
  END IF;

  IF sale.legacy_policy_review AND sale.status = 'REVIEW_REQUIRED'
     AND sale.review_resume_status IS NULL
     AND NEW.event NOT IN ('LEGACY_APPROVE','LEGACY_REJECT')
  THEN
    RAISE EXCEPTION 'initial legacy review requires its exact one-time legacy decision'
      USING ERRCODE = '23514';
  END IF;

  IF pg_catalog.current_setting('app.actor_type', true) = 'member' THEN
    IF NEW.event <> 'CANCEL' OR NEW.actor_type <> 'MEMBER'
       OR NEW.actor_id <> app_security.current_actor_id()
       OR sale.member_id <> app_security.current_actor_id()
    THEN
      RAISE EXCEPTION 'member may only append an owned cancellation'
        USING ERRCODE = '42501';
    END IF;
  ELSIF pg_catalog.current_setting('app.actor_type', true) = 'admin' THEN
    IF NEW.actor_type <> 'ADMIN' OR NEW.actor_id <> app_security.current_actor_id()
       OR NOT EXISTS (SELECT 1 FROM public.admin_users admin WHERE admin.id = NEW.actor_id)
    THEN
      RAISE EXCEPTION 'after-sale transition actor is not the current administrator'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'after-sale transitions require an authenticated member or administrator'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.from_status = 'REVIEW_REQUIRED' THEN
    graph_match := (
      NEW.event = 'RESUME_REVIEW' AND NEW.to_status = sale.review_resume_status
      AND (
        (sale.type IN ('REFUND_ONLY','MERCHANT_REFUND') AND NEW.to_status IN ('APPROVED','REFUND_PENDING','REFUND_PROCESSING'))
        OR (sale.type = 'RETURN_REFUND' AND NEW.to_status IN ('APPROVED','RETURN_PENDING','RETURN_IN_TRANSIT','INSPECTION_PENDING','REFUND_PENDING','REFUND_PROCESSING'))
        OR (sale.type = 'EXCHANGE' AND NEW.to_status IN ('APPROVED','RETURN_PENDING','RETURN_IN_TRANSIT','INSPECTION_PENDING','EXCHANGE_PENDING','EXCHANGE_IN_TRANSIT','REFUND_PENDING','REFUND_PROCESSING'))
      )
    ) OR (
      NEW.event = 'REJECT_REVIEW' AND NEW.to_status = 'REJECTED'
      AND sale.review_resume_status IN ('APPROVED','RETURN_PENDING')
      AND NOT EXISTS (SELECT 1 FROM public.after_sale_settlements settlement WHERE settlement.store_id = sale.store_id AND settlement.after_sale_id = sale.id)
      AND NOT EXISTS (SELECT 1 FROM public.after_sale_return_shipments return_shipment WHERE return_shipment.store_id = sale.store_id AND return_shipment.after_sale_id = sale.id)
      AND NOT EXISTS (SELECT 1 FROM public.shipments shipment WHERE shipment.store_id = sale.store_id AND shipment.after_sale_id = sale.id AND shipment.purpose = 'AFTER_SALE_RETURN')
      AND NOT EXISTS (SELECT 1 FROM public.after_sale_inspections inspection WHERE inspection.store_id = sale.store_id AND inspection.after_sale_id = sale.id)
      AND NOT EXISTS (SELECT 1 FROM public.after_sale_inventory_actions action WHERE action.store_id = sale.store_id AND action.after_sale_id = sale.id)
      AND NOT EXISTS (SELECT 1 FROM public.exchange_fulfillments fulfillment WHERE fulfillment.store_id = sale.store_id AND fulfillment.after_sale_id = sale.id AND (fulfillment.reservation_id IS NOT NULL OR fulfillment.outbound_shipment_id IS NOT NULL))
    ) OR (
      sale.legacy_policy_review AND sale.review_resume_status IS NULL
      AND NEW.event IN ('LEGACY_APPROVE','LEGACY_REJECT')
      AND ((NEW.event = 'LEGACY_APPROVE' AND NEW.to_status = 'APPROVED')
        OR (NEW.event = 'LEGACY_REJECT' AND NEW.to_status = 'REJECTED'))
      AND 1 = (
        SELECT pg_catalog.count(*) FROM public.after_sale_legacy_decisions decision
        WHERE decision.store_id = sale.store_id AND decision.after_sale_id = sale.id
          AND decision.admin_id = NEW.actor_id
          AND decision.decision::text = CASE NEW.event WHEN 'LEGACY_APPROVE' THEN 'APPROVE' ELSE 'REJECT' END
      )
      AND NOT EXISTS (SELECT 1 FROM public.after_sale_settlements settlement WHERE settlement.store_id = sale.store_id AND settlement.after_sale_id = sale.id)
      AND NOT EXISTS (SELECT 1 FROM public.after_sale_return_shipments return_shipment WHERE return_shipment.store_id = sale.store_id AND return_shipment.after_sale_id = sale.id)
      AND NOT EXISTS (SELECT 1 FROM public.shipments shipment WHERE shipment.store_id = sale.store_id AND shipment.after_sale_id = sale.id AND shipment.purpose <> 'ORDER_OUTBOUND')
      AND NOT EXISTS (SELECT 1 FROM public.after_sale_inspections inspection WHERE inspection.store_id = sale.store_id AND inspection.after_sale_id = sale.id)
      AND NOT EXISTS (SELECT 1 FROM public.after_sale_inventory_actions action WHERE action.store_id = sale.store_id AND action.after_sale_id = sale.id)
      AND NOT EXISTS (SELECT 1 FROM public.exchange_fulfillments fulfillment WHERE fulfillment.store_id = sale.store_id AND fulfillment.after_sale_id = sale.id)
    );
  ELSE
    graph_match := (sale.type::text, NEW.from_status::text, NEW.event, NEW.to_status::text) IN (VALUES
      ('REFUND_ONLY','PENDING_REVIEW','APPROVE','APPROVED'),
      ('REFUND_ONLY','PENDING_REVIEW','REJECT','REJECTED'),
      ('REFUND_ONLY','PENDING_REVIEW','CANCEL','CANCELLED'),
      ('REFUND_ONLY','APPROVED','QUEUE_REFUND','REFUND_PENDING'),
      ('REFUND_ONLY','APPROVED','REQUIRE_REVIEW','REVIEW_REQUIRED'),
      ('REFUND_ONLY','REFUND_PENDING','REFUND_REQUESTED','REFUND_PROCESSING'),
      ('REFUND_ONLY','REFUND_PENDING','REQUIRE_REVIEW','REVIEW_REQUIRED'),
      ('REFUND_ONLY','REFUND_PROCESSING','REFUND_SUCCEEDED','REFUNDED'),
      ('REFUND_ONLY','REFUND_PROCESSING','REFUND_FAILED','REFUND_PENDING'),
      ('REFUND_ONLY','REFUND_PROCESSING','REFUND_CANCELLED','REFUND_PENDING'),
      ('REFUND_ONLY','REFUND_PROCESSING','REQUIRE_REVIEW','REVIEW_REQUIRED'),
      ('REFUND_ONLY','REFUNDED','COMPLETE','COMPLETED'),
      ('MERCHANT_REFUND','PENDING_REVIEW','APPROVE','APPROVED'),
      ('MERCHANT_REFUND','PENDING_REVIEW','REJECT','REJECTED'),
      ('MERCHANT_REFUND','APPROVED','QUEUE_REFUND','REFUND_PENDING'),
      ('MERCHANT_REFUND','APPROVED','REQUIRE_REVIEW','REVIEW_REQUIRED'),
      ('MERCHANT_REFUND','REFUND_PENDING','REFUND_REQUESTED','REFUND_PROCESSING'),
      ('MERCHANT_REFUND','REFUND_PENDING','REQUIRE_REVIEW','REVIEW_REQUIRED'),
      ('MERCHANT_REFUND','REFUND_PROCESSING','REFUND_SUCCEEDED','REFUNDED'),
      ('MERCHANT_REFUND','REFUND_PROCESSING','REFUND_FAILED','REFUND_PENDING'),
      ('MERCHANT_REFUND','REFUND_PROCESSING','REFUND_CANCELLED','REFUND_PENDING'),
      ('MERCHANT_REFUND','REFUND_PROCESSING','REQUIRE_REVIEW','REVIEW_REQUIRED'),
      ('MERCHANT_REFUND','REFUNDED','COMPLETE','COMPLETED'),
      ('RETURN_REFUND','PENDING_REVIEW','APPROVE','APPROVED'),
      ('RETURN_REFUND','PENDING_REVIEW','REJECT','REJECTED'),
      ('RETURN_REFUND','PENDING_REVIEW','CANCEL','CANCELLED'),
      ('RETURN_REFUND','APPROVED','START_RETURN','RETURN_PENDING'),
      ('RETURN_REFUND','APPROVED','RETURN_EXPIRED','REJECTED'),
      ('RETURN_REFUND','APPROVED','REQUIRE_REVIEW','REVIEW_REQUIRED'),
      ('RETURN_REFUND','RETURN_PENDING','RETURN_SHIPPED','RETURN_IN_TRANSIT'),
      ('RETURN_REFUND','RETURN_PENDING','REQUIRE_REVIEW','REVIEW_REQUIRED'),
      ('RETURN_REFUND','RETURN_IN_TRANSIT','RETURN_RECEIVED','INSPECTION_PENDING'),
      ('RETURN_REFUND','RETURN_IN_TRANSIT','REQUIRE_REVIEW','REVIEW_REQUIRED'),
      ('RETURN_REFUND','INSPECTION_PENDING','ACCEPT_INSPECTION','REFUND_PENDING'),
      ('RETURN_REFUND','INSPECTION_PENDING','REJECT_INSPECTION','REJECTED'),
      ('RETURN_REFUND','INSPECTION_PENDING','REQUIRE_REVIEW','REVIEW_REQUIRED'),
      ('RETURN_REFUND','REFUND_PENDING','REFUND_REQUESTED','REFUND_PROCESSING'),
      ('RETURN_REFUND','REFUND_PENDING','REQUIRE_REVIEW','REVIEW_REQUIRED'),
      ('RETURN_REFUND','REFUND_PROCESSING','REFUND_SUCCEEDED','REFUNDED'),
      ('RETURN_REFUND','REFUND_PROCESSING','REFUND_FAILED','REFUND_PENDING'),
      ('RETURN_REFUND','REFUND_PROCESSING','REFUND_CANCELLED','REFUND_PENDING'),
      ('RETURN_REFUND','REFUND_PROCESSING','REQUIRE_REVIEW','REVIEW_REQUIRED'),
      ('RETURN_REFUND','REFUNDED','COMPLETE','COMPLETED'),
      ('EXCHANGE','PENDING_REVIEW','APPROVE','APPROVED'),
      ('EXCHANGE','PENDING_REVIEW','REJECT','REJECTED'),
      ('EXCHANGE','PENDING_REVIEW','CANCEL','CANCELLED'),
      ('EXCHANGE','APPROVED','START_RETURN','RETURN_PENDING'),
      ('EXCHANGE','APPROVED','RETURN_EXPIRED','REJECTED'),
      ('EXCHANGE','APPROVED','REQUIRE_REVIEW','REVIEW_REQUIRED'),
      ('EXCHANGE','RETURN_PENDING','RETURN_SHIPPED','RETURN_IN_TRANSIT'),
      ('EXCHANGE','RETURN_PENDING','REQUIRE_REVIEW','REVIEW_REQUIRED'),
      ('EXCHANGE','RETURN_IN_TRANSIT','RETURN_RECEIVED','INSPECTION_PENDING'),
      ('EXCHANGE','RETURN_IN_TRANSIT','REQUIRE_REVIEW','REVIEW_REQUIRED'),
      ('EXCHANGE','INSPECTION_PENDING','ACCEPT_INSPECTION','EXCHANGE_PENDING'),
      ('EXCHANGE','INSPECTION_PENDING','REJECT_INSPECTION','REJECTED'),
      ('EXCHANGE','INSPECTION_PENDING','REQUIRE_REVIEW','REVIEW_REQUIRED'),
      ('EXCHANGE','EXCHANGE_PENDING','CONVERT_EXCHANGE_TO_REFUND','REFUND_PENDING'),
      ('EXCHANGE','EXCHANGE_PENDING','EXCHANGE_SHIPPED','EXCHANGE_IN_TRANSIT'),
      ('EXCHANGE','EXCHANGE_PENDING','REQUIRE_REVIEW','REVIEW_REQUIRED'),
      ('EXCHANGE','EXCHANGE_IN_TRANSIT','EXCHANGE_DELIVERED','COMPLETED'),
      ('EXCHANGE','EXCHANGE_IN_TRANSIT','REQUIRE_REVIEW','REVIEW_REQUIRED'),
      ('EXCHANGE','REFUND_PENDING','REFUND_REQUESTED','REFUND_PROCESSING'),
      ('EXCHANGE','REFUND_PENDING','REQUIRE_REVIEW','REVIEW_REQUIRED'),
      ('EXCHANGE','REFUND_PROCESSING','REFUND_SUCCEEDED','REFUNDED'),
      ('EXCHANGE','REFUND_PROCESSING','REFUND_FAILED','REFUND_PENDING'),
      ('EXCHANGE','REFUND_PROCESSING','REFUND_CANCELLED','REFUND_PENDING'),
      ('EXCHANGE','REFUND_PROCESSING','REQUIRE_REVIEW','REVIEW_REQUIRED'),
      ('EXCHANGE','REFUNDED','COMPLETE','COMPLETED')
    );
  END IF;
  IF NOT graph_match THEN
    RAISE EXCEPTION 'invalid after-sale transition for current type and status'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.event IN ('START_RETURN','RETURN_SHIPPED')
     AND (sale.return_deadline_at IS NULL OR pg_catalog.clock_timestamp() >= sale.return_deadline_at)
  THEN RAISE EXCEPTION 'after-sale return window is closed' USING ERRCODE = '23514'; END IF;
  IF NEW.event IN ('APPROVE','LEGACY_APPROVE') AND (
    sale.approved_total_vnd <= 0
    OR sale.approved_item_vnd <> (
      SELECT COALESCE(pg_catalog.sum(item.approved_item_vnd), 0)
      FROM public.after_sale_items item
      WHERE item.store_id = sale.store_id AND item.after_sale_id = sale.id
    )
    OR EXISTS (
      SELECT 1 FROM public.after_sale_items item
      WHERE item.store_id = sale.store_id AND item.after_sale_id = sale.id
        AND ((item.approved_quantity = 0) IS DISTINCT FROM (item.approved_item_vnd = 0))
    )
    OR (sale.type = 'EXCHANGE' AND (
      NOT EXISTS (
        SELECT 1 FROM public.after_sale_items item
        WHERE item.store_id = sale.store_id AND item.after_sale_id = sale.id
          AND item.approved_quantity > 0
      )
      OR EXISTS (
        SELECT 1 FROM public.after_sale_items item
        WHERE item.store_id = sale.store_id AND item.after_sale_id = sale.id
          AND (item.replacement_quantity <> item.approved_quantity
            OR (item.approved_quantity > 0 AND (
              item.replacement_sku_id IS NULL OR item.replacement_sku_id = item.sku_id)))
      )
    ))
    OR (sale.type IN ('RETURN_REFUND','EXCHANGE')
      AND (sale.return_deadline_at IS NULL OR sale.return_deadline_at <= pg_catalog.clock_timestamp()))
  ) THEN RAISE EXCEPTION 'approved after-sale requires frozen line amounts and return terms' USING ERRCODE = '23514'; END IF;
  IF NEW.event = 'RETURN_EXPIRED' AND (
    sale.return_deadline_at IS NULL OR pg_catalog.clock_timestamp() < sale.return_deadline_at
    OR EXISTS (SELECT 1 FROM public.after_sale_return_shipments shipment WHERE shipment.store_id = sale.store_id AND shipment.after_sale_id = sale.id)
    OR EXISTS (SELECT 1 FROM public.shipments shipment WHERE shipment.store_id = sale.store_id AND shipment.after_sale_id = sale.id AND shipment.purpose = 'AFTER_SALE_RETURN')
    OR EXISTS (SELECT 1 FROM public.after_sale_settlements settlement WHERE settlement.store_id = sale.store_id AND settlement.after_sale_id = sale.id)
    OR EXISTS (SELECT 1 FROM public.after_sale_inspections inspection WHERE inspection.store_id = sale.store_id AND inspection.after_sale_id = sale.id)
    OR EXISTS (SELECT 1 FROM public.after_sale_inventory_actions action WHERE action.store_id = sale.store_id AND action.after_sale_id = sale.id)
    OR EXISTS (SELECT 1 FROM public.exchange_fulfillments fulfillment WHERE fulfillment.store_id = sale.store_id AND fulfillment.after_sale_id = sale.id)
  ) THEN RAISE EXCEPTION 'return expiration has conflicting facts' USING ERRCODE = '23514'; END IF;
  IF NEW.event = 'CONVERT_EXCHANGE_TO_REFUND' AND EXISTS (
    SELECT 1 FROM public.exchange_fulfillments fulfillment
    WHERE fulfillment.store_id = sale.store_id AND fulfillment.after_sale_id = sale.id
      AND (fulfillment.reservation_id IS NOT NULL OR fulfillment.outbound_shipment_id IS NOT NULL)
  ) THEN RAISE EXCEPTION 'exchange with inventory or shipment facts cannot convert to refund' USING ERRCODE = '23514'; END IF;
  IF NEW.event = 'CONVERT_EXCHANGE_TO_REFUND' AND EXISTS (
    SELECT 1 FROM public.shipments shipment
    WHERE shipment.store_id = sale.store_id AND shipment.after_sale_id = sale.id
      AND shipment.purpose = 'EXCHANGE_OUTBOUND'
  ) THEN RAISE EXCEPTION 'exchange with an outbound shipment cannot convert to refund' USING ERRCODE = '23514'; END IF;
  IF NEW.event = 'RETURN_SHIPPED' AND NOT EXISTS (
    SELECT 1 FROM public.after_sale_return_shipments shipment
    WHERE shipment.store_id = sale.store_id AND shipment.after_sale_id = sale.id
      AND shipment.status IN ('IN_TRANSIT','DELIVERED')
  ) THEN RAISE EXCEPTION 'return shipment fact is required' USING ERRCODE = '23514'; END IF;
  IF NEW.event = 'RETURN_RECEIVED' AND NOT EXISTS (
    SELECT 1 FROM public.after_sale_return_shipments shipment
    WHERE shipment.store_id = sale.store_id AND shipment.after_sale_id = sale.id
      AND shipment.status = 'DELIVERED' AND shipment.received_at IS NOT NULL
  ) THEN RAISE EXCEPTION 'authoritative return receipt is required' USING ERRCODE = '23514'; END IF;
  IF NEW.event IN ('ACCEPT_INSPECTION','REJECT_INSPECTION') AND NOT EXISTS (
    SELECT 1 FROM public.after_sale_items item
    WHERE item.store_id = sale.store_id AND item.after_sale_id = sale.id
      AND item.approved_quantity > 0 AND item.inspection_version > 0
      AND item.received_quantity = item.approved_quantity
  ) THEN RAISE EXCEPTION 'complete inspection projection is required' USING ERRCODE = '23514'; END IF;
  IF NEW.event = 'ACCEPT_INSPECTION' AND NOT EXISTS (
    SELECT 1 FROM public.after_sale_items item WHERE item.store_id = sale.store_id
      AND item.after_sale_id = sale.id AND item.accepted_quantity > 0
  ) THEN RAISE EXCEPTION 'accepted inspection quantity is required' USING ERRCODE = '23514'; END IF;
  IF NEW.event = 'REJECT_INSPECTION' AND EXISTS (
    SELECT 1 FROM public.after_sale_items item WHERE item.store_id = sale.store_id
      AND item.after_sale_id = sale.id AND item.accepted_quantity > 0
  ) THEN RAISE EXCEPTION 'rejected inspection cannot contain accepted quantity' USING ERRCODE = '23514'; END IF;
  IF NEW.event = 'REFUND_REQUESTED' AND NOT EXISTS (
    SELECT 1 FROM public.after_sale_settlements settlement
    WHERE settlement.store_id = sale.store_id AND settlement.after_sale_id = sale.id
      AND settlement.status IN ('PENDING','PROCESSING','SUCCEEDED','REVIEW_REQUIRED')
  ) THEN RAISE EXCEPTION 'active settlement fact is required' USING ERRCODE = '23514'; END IF;
  IF NEW.event = 'REFUND_SUCCEEDED' AND sale.approved_total_vnd <> (
    SELECT COALESCE(pg_catalog.sum(settlement.amount_vnd), 0)
    FROM public.after_sale_settlements settlement
    WHERE settlement.store_id = sale.store_id AND settlement.after_sale_id = sale.id
      AND settlement.status = 'SUCCEEDED'
  ) THEN RAISE EXCEPTION 'successful settlements must equal the approved total' USING ERRCODE = '23514'; END IF;
  IF NEW.event = 'REFUND_FAILED' AND NOT EXISTS (
    SELECT 1 FROM public.after_sale_settlements settlement WHERE settlement.store_id = sale.store_id
      AND settlement.after_sale_id = sale.id AND settlement.status = 'FAILED'
  ) THEN RAISE EXCEPTION 'failed settlement fact is required' USING ERRCODE = '23514'; END IF;
  IF NEW.event = 'REFUND_CANCELLED' AND NOT EXISTS (
    SELECT 1 FROM public.after_sale_settlements settlement WHERE settlement.store_id = sale.store_id
      AND settlement.after_sale_id = sale.id AND settlement.status = 'CANCELLED'
  ) THEN RAISE EXCEPTION 'cancelled settlement fact is required' USING ERRCODE = '23514'; END IF;
  IF NEW.event = 'EXCHANGE_SHIPPED' AND NOT EXISTS (
    SELECT 1 FROM public.exchange_fulfillments fulfillment
    JOIN public.shipments shipment ON shipment.store_id = fulfillment.store_id
      AND shipment.id = fulfillment.outbound_shipment_id
    WHERE fulfillment.store_id = sale.store_id AND fulfillment.after_sale_id = sale.id
      AND fulfillment.status IN ('IN_TRANSIT','DELIVERED')
      AND shipment.purpose = 'EXCHANGE_OUTBOUND'
  ) THEN RAISE EXCEPTION 'exchange outbound shipment fact is required' USING ERRCODE = '23514'; END IF;
  IF NEW.event = 'EXCHANGE_DELIVERED' AND NOT EXISTS (
    SELECT 1 FROM public.exchange_fulfillments fulfillment
    JOIN public.shipments shipment ON shipment.store_id = fulfillment.store_id
      AND shipment.id = fulfillment.outbound_shipment_id
    WHERE fulfillment.store_id = sale.store_id AND fulfillment.after_sale_id = sale.id
      AND fulfillment.status = 'DELIVERED' AND shipment.status = 'DELIVERED'
  ) THEN RAISE EXCEPTION 'delivered exchange fact is required' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION "app_security"."apply_m62_after_sale_transition"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE affected_rows integer;
BEGIN
  UPDATE public.after_sales
  SET status = NEW.to_status,
      review_resume_status = CASE WHEN NEW.event = 'REQUIRE_REVIEW' THEN NEW.from_status
        WHEN NEW.from_status = 'REVIEW_REQUIRED' THEN NULL ELSE review_resume_status END,
      return_expired_at = CASE WHEN NEW.event = 'RETURN_EXPIRED' THEN pg_catalog.clock_timestamp() ELSE return_expired_at END,
      reviewed_by = CASE WHEN NEW.event IN ('APPROVE','REJECT','LEGACY_APPROVE','LEGACY_REJECT') THEN NEW.actor_id ELSE reviewed_by END,
      reviewed_at = CASE WHEN NEW.event IN ('APPROVE','REJECT','LEGACY_APPROVE','LEGACY_REJECT') THEN pg_catalog.clock_timestamp() ELSE reviewed_at END,
      completed_at = CASE WHEN NEW.to_status IN ('REJECTED','CANCELLED','COMPLETED') THEN pg_catalog.clock_timestamp() ELSE completed_at END,
      version = version + 1,
      updated_at = pg_catalog.clock_timestamp()
  WHERE store_id = NEW.store_id AND id = NEW.after_sale_id AND status = NEW.from_status;
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows <> 1 THEN
    RAISE EXCEPTION 'after-sale transition failed to project exactly one header'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_after_sale_header_projection"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF OLD.status IN ('REJECTED','CANCELLED','COMPLETED') THEN
    RAISE EXCEPTION 'terminal after-sale header is immutable' USING ERRCODE = '42501';
  END IF;
  IF (NEW.status IS DISTINCT FROM OLD.status
      OR NEW.version IS DISTINCT FROM OLD.version
      OR NEW.review_resume_status IS DISTINCT FROM OLD.review_resume_status
      OR NEW.return_expired_at IS DISTINCT FROM OLD.return_expired_at
      OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
      OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
      OR NEW.completed_at IS DISTINCT FROM OLD.completed_at)
     AND pg_catalog.pg_trigger_depth() <= 1
  THEN
    RAISE EXCEPTION 'after-sale state fields require append-only transition projection'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "after_sale_transitions_state_guard"
  BEFORE INSERT ON "after_sale_transitions"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_after_sale_transition"();
CREATE TRIGGER "after_sale_transitions_apply_state"
  AFTER INSERT ON "after_sale_transitions"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."apply_m62_after_sale_transition"();
CREATE TRIGGER "after_sales_transition_only_guard"
  BEFORE UPDATE ON "after_sales"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_after_sale_header_projection"();

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_inspection_allocation_identity"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE inspection_record record;
BEGIN
  SELECT inspection.after_sale_id, inspection.inspection_version
  INTO inspection_record
  FROM public.after_sale_inspections inspection
  WHERE inspection.store_id = NEW.store_id AND inspection.id = NEW.inspection_id
  FOR UPDATE;
  IF NOT FOUND OR inspection_record.after_sale_id <> NEW.after_sale_id
     OR NEW.disposition = 'PENDING'
     OR NOT EXISTS (
       SELECT 1 FROM public.after_sale_items item
       WHERE item.store_id = NEW.store_id AND item.id = NEW.after_sale_item_id
         AND item.after_sale_id = NEW.after_sale_id AND item.approved_quantity > 0
     )
  THEN
    RAISE EXCEPTION 'inspection allocation identity is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_inspection_header"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF pg_catalog.current_setting('app.actor_type', true) <> 'admin'
     OR NEW.admin_id <> app_security.current_actor_id()
     OR NOT EXISTS (
       SELECT 1 FROM public.after_sales sale
       WHERE sale.store_id = NEW.store_id AND sale.id = NEW.after_sale_id
         AND sale.status = 'INSPECTION_PENDING'
     )
  THEN
    RAISE EXCEPTION 'inspection must be actor-bound to the current administrator and case state'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION "app_security"."project_m62_complete_inspection"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE target_store uuid;
DECLARE target_inspection uuid;
DECLARE target_case uuid;
DECLARE target_version integer;
DECLARE target_admin uuid;
BEGIN
  target_store := NEW.store_id;
  IF TG_TABLE_NAME = 'after_sale_inspections' THEN
    target_inspection := NEW.id;
    target_case := NEW.after_sale_id;
  ELSE
    target_inspection := NEW.inspection_id;
    target_case := NEW.after_sale_id;
  END IF;

  SELECT inspection.inspection_version, inspection.admin_id
  INTO target_version, target_admin
  FROM public.after_sale_inspections inspection
  WHERE inspection.store_id = target_store AND inspection.id = target_inspection
    AND inspection.after_sale_id = target_case
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'inspection header is missing' USING ERRCODE = '23503';
  END IF;
  IF target_version <> 1 + COALESCE((
    SELECT pg_catalog.max(prior.inspection_version)
    FROM public.after_sale_inspections prior
    WHERE prior.store_id = target_store AND prior.after_sale_id = target_case
      AND prior.id <> target_inspection
  ), 0) THEN
    RAISE EXCEPTION 'inspection versions must be contiguous' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.after_sale_items item
    WHERE item.store_id = target_store AND item.after_sale_id = target_case
      AND item.approved_quantity > 0
      AND item.approved_quantity <> COALESCE((
        SELECT pg_catalog.sum(allocation.quantity)::integer
        FROM public.after_sale_inspection_allocations allocation
        WHERE allocation.store_id = target_store
          AND allocation.inspection_id = target_inspection
          AND allocation.after_sale_item_id = item.id
      ), 0)
  ) OR EXISTS (
    SELECT 1 FROM public.after_sale_inspection_allocations allocation
    JOIN public.after_sale_items item ON item.store_id = allocation.store_id
      AND item.id = allocation.after_sale_item_id
    WHERE allocation.store_id = target_store AND allocation.inspection_id = target_inspection
      AND (item.after_sale_id <> target_case OR item.approved_quantity <= 0)
  ) THEN
    RAISE EXCEPTION 'inspection must exactly cover every approved after-sale item'
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.after_sale_items item
  SET received_quantity = summary.total_quantity,
      accepted_quantity = summary.accepted_quantity,
      rejected_quantity = summary.rejected_quantity,
      restockable_quantity = summary.restockable_quantity,
      disposition = summary.single_disposition,
      inspection_version = target_version,
      inspected_by = target_admin,
      updated_at = pg_catalog.clock_timestamp()
  FROM (
    SELECT allocation.after_sale_item_id,
      pg_catalog.sum(allocation.quantity)::integer AS total_quantity,
      COALESCE((pg_catalog.sum(allocation.quantity) FILTER (WHERE allocation.disposition <> 'RETURN_TO_MEMBER')), 0)::integer AS accepted_quantity,
      COALESCE(pg_catalog.sum(allocation.quantity) FILTER (WHERE allocation.disposition = 'RETURN_TO_MEMBER'), 0)::integer AS rejected_quantity,
      COALESCE(pg_catalog.sum(allocation.quantity) FILTER (WHERE allocation.disposition = 'RESTOCK_SELLABLE'), 0)::integer AS restockable_quantity,
      CASE WHEN pg_catalog.count(DISTINCT allocation.disposition) = 1 THEN pg_catalog.min(allocation.disposition::text)::public.after_sale_inspection_disposition ELSE NULL END AS single_disposition
    FROM public.after_sale_inspection_allocations allocation
    WHERE allocation.store_id = target_store AND allocation.inspection_id = target_inspection
    GROUP BY allocation.after_sale_item_id
  ) summary
  WHERE item.store_id = target_store AND item.id = summary.after_sale_item_id;
  RETURN NULL;
END
$$;
CREATE POLICY "after_sale_items_inspection_projection" ON "after_sale_items"
  FOR UPDATE
  USING ("store_id" = app_security.current_store_id() AND CURRENT_USER <> SESSION_USER)
  WITH CHECK ("store_id" = app_security.current_store_id() AND CURRENT_USER <> SESSION_USER);
REVOKE UPDATE ("received_quantity","accepted_quantity","rejected_quantity","restockable_quantity",
  "condition","disposition","inspection_version","inspected_by")
ON "after_sale_items" FROM zalo_shop_runtime;
CREATE TRIGGER "after_sale_inspection_allocations_identity_guard"
  BEFORE INSERT ON "after_sale_inspection_allocations"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_inspection_allocation_identity"();
CREATE TRIGGER "after_sale_inspections_actor_guard"
  BEFORE INSERT ON "after_sale_inspections"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_inspection_header"();
CREATE CONSTRAINT TRIGGER "after_sale_inspections_complete_guard"
  AFTER INSERT ON "after_sale_inspections"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "app_security"."project_m62_complete_inspection"();
CREATE CONSTRAINT TRIGGER "after_sale_inspection_allocations_complete_guard"
  AFTER INSERT ON "after_sale_inspection_allocations"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "app_security"."project_m62_complete_inspection"();

CREATE UNIQUE INDEX "after_sale_refunds_store_id_settlement_id_key"
  ON "after_sale_refunds"("store_id", "settlement_id");

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_settlement_lifecycle"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE refund_status text;
DECLARE sale_record record;
BEGIN
  SELECT sale.status, sale.review_resume_status
  INTO sale_record
  FROM public.after_sales sale
  WHERE sale.store_id = NEW.store_id AND sale.id = NEW.after_sale_id
    AND sale.order_id = NEW.order_id
  FOR UPDATE;
  IF NOT FOUND
     OR sale_record.status NOT IN ('REFUND_PENDING','REFUND_PROCESSING','REVIEW_REQUIRED')
     OR (sale_record.status = 'REVIEW_REQUIRED'
       AND (sale_record.review_resume_status IS NULL
         OR sale_record.review_resume_status NOT IN ('REFUND_PENDING','REFUND_PROCESSING')))
  THEN
    RAISE EXCEPTION 'settlement requires the locked after-sale refund aggregate state'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF pg_catalog.current_setting('app.actor_type', true) <> 'admin'
       OR NEW.requested_by <> app_security.current_actor_id()
       OR NEW.status <> 'PENDING' OR NEW.version <> 1
       OR NEW.confirmed_by IS NOT NULL OR NEW.confirmed_at IS NOT NULL
       OR NEW.completed_at IS NOT NULL
       OR (NEW.method = 'ONLINE_ORIGINAL'
         AND (NEW.transfer_reference_digest IS NOT NULL OR NEW.transfer_evidence_ciphertext IS NOT NULL))
       OR (NEW.method = 'COD_OFFLINE'
         AND (NEW.transfer_reference_digest IS NULL
           OR NEW.transfer_reference_digest !~ '^[0-9a-f]{64}$'
           OR NEW.transfer_evidence_ciphertext IS NULL))
       OR (NEW.method = 'NO_PAYOUT'
         AND (NEW.transfer_reference_digest IS NOT NULL OR NEW.transfer_evidence_ciphertext IS NOT NULL))
    THEN
      RAISE EXCEPTION 'settlement must be actor-bound and created pending without completion facts'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF pg_catalog.current_setting('app.actor_type', true) <> 'admin' THEN
    RAISE EXCEPTION 'settlement transitions require an administrator' USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('SUCCEEDED','FAILED','CANCELLED') THEN
    RAISE EXCEPTION 'terminal settlement is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = OLD.status OR NEW.version <> OLD.version + 1
     OR NEW.updated_at < OLD.updated_at
     OR (pg_catalog.to_jsonb(NEW) - ARRAY['status','confirmed_by','confirmed_at','completed_at','version','updated_at'])
        IS DISTINCT FROM
        (pg_catalog.to_jsonb(OLD) - ARRAY['status','confirmed_by','confirmed_at','completed_at','version','updated_at'])
  THEN
    RAISE EXCEPTION 'invalid settlement update shape' USING ERRCODE = '23514';
  END IF;

  IF NEW.method = 'ONLINE_ORIGINAL' THEN
    IF NEW.confirmed_by IS NOT NULL OR NEW.confirmed_at IS NOT NULL THEN
      RAISE EXCEPTION 'online settlement cannot contain COD confirmation facts'
        USING ERRCODE = '23514';
    END IF;
    SELECT refund.status::text INTO refund_status
    FROM public.after_sale_refunds link
    JOIN public.refunds refund ON refund.store_id = link.store_id AND refund.id = link.refund_id
    WHERE link.store_id = NEW.store_id AND link.settlement_id = NEW.id
      AND link.after_sale_id = NEW.after_sale_id AND link.order_id = NEW.order_id
      AND link.payment_attempt_id = NEW.payment_attempt_id AND link.amount_vnd = NEW.amount_vnd;
    IF NOT FOUND OR NOT (
      (refund_status IN ('REQUESTED','PROCESSING') AND NEW.status = 'PROCESSING')
      OR (refund_status = 'SUCCEEDED' AND NEW.status = 'SUCCEEDED')
      OR (refund_status = 'FAILED' AND NEW.status = 'FAILED')
      OR (refund_status = 'CANCELLED' AND NEW.status = 'CANCELLED')
      OR (refund_status = 'REVIEW_REQUIRED' AND NEW.status = 'REVIEW_REQUIRED')
    ) THEN
      RAISE EXCEPTION 'online settlement must project its exact linked M5 refund status'
        USING ERRCODE = '23514';
    END IF;
    IF refund_status <> 'REQUESTED' AND NOT EXISTS (
      SELECT 1 FROM public.after_sale_refunds link
      JOIN public.refund_transitions transition ON transition.store_id = link.store_id
        AND transition.refund_id = link.refund_id
      WHERE link.store_id = NEW.store_id AND link.settlement_id = NEW.id
        AND transition.to_status::text = refund_status
    ) THEN
      RAISE EXCEPTION 'online settlement requires an append-only M5 refund transition fact'
        USING ERRCODE = '23514';
    END IF;
    IF (NEW.status = 'SUCCEEDED' AND NEW.completed_at IS NULL)
       OR (NEW.status <> 'SUCCEEDED' AND NEW.completed_at IS NOT NULL)
    THEN
      RAISE EXCEPTION 'online settlement completion timestamp does not match its status'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.method = 'COD_OFFLINE' THEN
    IF NEW.status NOT IN ('SUCCEEDED','FAILED','CANCELLED','REVIEW_REQUIRED') THEN
      RAISE EXCEPTION 'COD settlement has no direct transition to the requested status'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'SUCCEEDED' AND (
      OLD.status NOT IN ('PENDING','REVIEW_REQUIRED')
      OR OLD.confirmed_by IS NOT NULL
      OR NEW.confirmed_by IS NULL
      OR NEW.confirmed_by IS DISTINCT FROM app_security.current_actor_id()
      OR NEW.confirmed_by IS NOT DISTINCT FROM NEW.requested_by
      OR NEW.confirmed_at IS NULL OR NEW.completed_at IS NULL
      OR NEW.transfer_reference_digest IS NULL
      OR NEW.transfer_reference_digest !~ '^[0-9a-f]{64}$'
      OR NEW.transfer_evidence_ciphertext IS NULL
    ) THEN
      RAISE EXCEPTION 'COD settlement success requires a distinct current confirmer and evidence'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.status IN ('FAILED','CANCELLED','REVIEW_REQUIRED')
       AND (NEW.confirmed_by IS NOT NULL OR NEW.confirmed_at IS NOT NULL OR NEW.completed_at IS NOT NULL)
    THEN
      RAISE EXCEPTION 'non-successful COD settlement cannot claim confirmation completion'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.status <> 'REVIEW_REQUIRED' OR NEW.confirmed_by IS NOT NULL
       OR NEW.confirmed_at IS NOT NULL OR NEW.completed_at IS NOT NULL
    THEN
      RAISE EXCEPTION 'NO_PAYOUT settlement has no authoritative success path'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "after_sale_settlements_lifecycle_guard"
  BEFORE INSERT OR UPDATE ON "after_sale_settlements"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_settlement_lifecycle"();

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_inventory_action"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE item_record record;
DECLARE latest_version integer;
DECLARE restock_capacity integer;
DECLARE consumed_capacity integer;
DECLARE restored_total integer;
DECLARE movement_count integer;
DECLARE operation_snapshot jsonb;
DECLARE target_balance uuid;
BEGIN
  IF pg_catalog.current_setting('app.actor_type', true) <> 'admin' THEN
    RAISE EXCEPTION 'inventory restoration is an internal administrative fact'
      USING ERRCODE = '42501';
  END IF;
  SELECT item.order_id, item.order_item_id, item.sku_id, order_item.quantity,
    orders.reservation_id AS order_reservation_id
  INTO item_record
  FROM public.after_sale_items item
  JOIN public.order_items order_item ON order_item.store_id = item.store_id
    AND order_item.order_id = item.order_id AND order_item.id = item.order_item_id
  JOIN public.orders orders ON orders.store_id = item.store_id AND orders.id = item.order_id
  WHERE item.store_id = NEW.store_id AND item.id = NEW.after_sale_item_id
    AND item.after_sale_id = NEW.after_sale_id
  FOR UPDATE OF item, order_item, orders;
  IF NOT FOUND OR item_record.order_id <> NEW.order_id OR item_record.sku_id <> NEW.sku_id THEN
    RAISE EXCEPTION 'after-sale inventory action identity is invalid' USING ERRCODE = '23514';
  END IF;
  SELECT pg_catalog.max(inspection.inspection_version) INTO latest_version
  FROM public.after_sale_inspections inspection
  WHERE inspection.store_id = NEW.store_id AND inspection.after_sale_id = NEW.after_sale_id;
  IF latest_version IS NULL OR NEW.inspection_version <> latest_version THEN
    RAISE EXCEPTION 'inventory restore must bind the latest inspection version'
      USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(pg_catalog.sum(allocation.quantity), 0)::integer INTO restock_capacity
  FROM public.after_sale_inspections inspection
  JOIN public.after_sale_inspection_allocations allocation
    ON allocation.store_id = inspection.store_id AND allocation.inspection_id = inspection.id
  WHERE inspection.store_id = NEW.store_id AND inspection.after_sale_id = NEW.after_sale_id
    AND inspection.inspection_version = latest_version
    AND allocation.after_sale_item_id = NEW.after_sale_item_id
    AND allocation.disposition = 'RESTOCK_SELLABLE';
  IF NEW.disposition <> 'RESTOCK_SELLABLE' OR NEW.action_type <> 'RESTOCK_SELLABLE'
     OR NEW.quantity > restock_capacity
  THEN
    RAISE EXCEPTION 'inventory restore exceeds the latest sellable allocation'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(pg_catalog.sum(reservation_item.quantity), 0)::integer
  INTO consumed_capacity
  FROM public.inventory_reservations reservation
  JOIN public.inventory_reservation_items reservation_item
    ON reservation_item.store_id = reservation.store_id
   AND reservation_item.reservation_id = reservation.id
  WHERE reservation.store_id = NEW.store_id
    AND reservation.id = item_record.order_reservation_id
    AND reservation.source_type = 'ORDER' AND reservation.source_id = NEW.order_id
    AND reservation.status = 'CONSUMED' AND reservation_item.sku_id = NEW.sku_id;
  IF consumed_capacity <= 0 THEN
    RAISE EXCEPTION 'inventory restore requires consumed stock from the original order'
      USING ERRCODE = '23514';
  END IF;

  SELECT operation.result_snapshot INTO operation_snapshot
  FROM public.inventory_operations operation
  WHERE operation.store_id = NEW.store_id AND operation.id = NEW.inventory_operation_id
    AND operation.operation_type = 'RESTORE'
    AND operation.source_type = 'AFTER_SALE_RESTORE'
    AND operation.source_id = NEW.after_sale_item_id;
  IF NOT FOUND
     OR pg_catalog.jsonb_typeof(operation_snapshot) <> 'object'
     OR pg_catalog.jsonb_typeof(operation_snapshot->'items') <> 'array'
     OR pg_catalog.jsonb_array_length(operation_snapshot->'items') <> 1
     OR operation_snapshot->>'operation_id' IS DISTINCT FROM NEW.inventory_operation_id::text
     OR operation_snapshot->>'source_type' IS DISTINCT FROM 'AFTER_SALE_RESTORE'
     OR operation_snapshot->>'source_id' IS DISTINCT FROM NEW.after_sale_item_id::text
     OR operation_snapshot->'items'->0->>'warehouse_id' IS DISTINCT FROM NEW.warehouse_id::text
     OR operation_snapshot->'items'->0->>'sku_id' IS DISTINCT FROM NEW.sku_id::text
     OR (operation_snapshot->'items'->0->>'quantity')::integer IS DISTINCT FROM NEW.quantity
  THEN
    RAISE EXCEPTION 'inventory restore operation snapshot is not the exact action tuple'
      USING ERRCODE = '23514';
  END IF;

  SELECT pg_catalog.count(*)::integer, pg_catalog.min(movement.balance_id::text)::uuid
  INTO movement_count, target_balance
  FROM public.inventory_movements movement
  JOIN public.inventory_balances balance ON balance.store_id = movement.store_id
    AND balance.id = movement.balance_id
  WHERE movement.store_id = NEW.store_id AND movement.operation_id = NEW.inventory_operation_id
    AND movement.movement_type = 'RESTORE' AND movement.on_hand_delta = NEW.quantity
    AND movement.reserved_delta = 0 AND movement.on_hand_after = movement.on_hand_before + NEW.quantity
    AND movement.reserved_after = movement.reserved_before
    AND balance.warehouse_id = NEW.warehouse_id AND balance.sku_id = NEW.sku_id;
  IF movement_count <> 1 OR (
    SELECT pg_catalog.count(*) FROM public.inventory_movements movement
    WHERE movement.store_id = NEW.store_id AND movement.operation_id = NEW.inventory_operation_id
  ) <> 1 THEN
    RAISE EXCEPTION 'inventory restore requires one exact movement' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM public.inventory_balances balance
  WHERE balance.store_id = NEW.store_id AND balance.id = target_balance FOR UPDATE;

  SELECT COALESCE(pg_catalog.sum(action.quantity), 0)::integer INTO restored_total
  FROM public.after_sale_inventory_actions action
  WHERE action.store_id = NEW.store_id AND action.after_sale_item_id = NEW.after_sale_item_id
    AND action.id <> NEW.id;
  IF restored_total + NEW.quantity > restock_capacity
     OR restored_total + NEW.quantity > item_record.quantity
     OR restored_total + NEW.quantity > consumed_capacity
  THEN
    RAISE EXCEPTION 'cumulative inventory restoration exceeds authoritative capacity'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DROP POLICY "after_sale_evidence_files_member_insert" ON "after_sale_evidence_files";
CREATE POLICY "after_sale_evidence_files_member_insert" ON "after_sale_evidence_files"
  FOR INSERT WITH CHECK (
    "store_id" = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'member'
    AND "member_id" = app_security.current_actor_id()
    AND "after_sale_id" IS NULL AND "status" = 'PENDING'
    AND "object_key" IS NULL AND "derivative_object_keys" IS NULL
    AND "scan_temporary_object_key" IS NULL AND "scan_result_code" IS NULL
    AND "claim_deadline_at" IS NULL AND "claimed_at" IS NULL
    AND "retention_deadline_at" IS NULL AND NOT "legal_hold_active"
    AND "held_at" IS NULL AND "held_by" IS NULL AND "hold_reason" IS NULL
    AND "delete_attempt_count" = 0 AND "next_delete_attempt_at" IS NULL
    AND "delete_error_code" IS NULL AND "deleted_at" IS NULL AND "version" = 1
  );

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_evidence_initial_shape"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.after_sale_id IS NOT NULL OR NEW.status <> 'PENDING' OR NEW.object_key IS NOT NULL
    OR NEW.derivative_object_keys IS NOT NULL OR NEW.scan_temporary_object_key IS NOT NULL
    OR NEW.scan_result_code IS NOT NULL OR NEW.claim_deadline_at IS NOT NULL
    OR NEW.claimed_at IS NOT NULL OR NEW.retention_deadline_at IS NOT NULL
    OR NEW.legal_hold_active OR NEW.delete_attempt_count <> 0
    OR NEW.next_delete_attempt_at IS NOT NULL OR NEW.delete_error_code IS NOT NULL
    OR NEW.deleted_at IS NOT NULL OR NEW.version <> 1
    OR (pg_catalog.current_setting('app.actor_type', true) = 'member'
      AND NEW.member_id <> app_security.current_actor_id())
  THEN
    RAISE EXCEPTION 'evidence must be created as empty pending upload metadata'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "after_sale_evidence_files_initial_shape_guard"
  BEFORE INSERT ON "after_sale_evidence_files"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_evidence_initial_shape"();
GRANT UPDATE ("legal_hold_active","held_at","held_by","hold_reason")
ON "after_sale_evidence_files" TO zalo_shop_runtime;

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_evidence_lifecycle"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE effective_deadline timestamptz;
BEGIN
  effective_deadline := COALESCE(NEW.retention_deadline_at, NEW.claim_deadline_at);
  IF OLD.status = 'DELETED' THEN
    RAISE EXCEPTION 'deleted evidence metadata is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at
     OR NEW.store_id <> OLD.store_id OR NEW.id <> OLD.id
     OR NEW.member_id <> OLD.member_id OR NEW.upload_session_id <> OLD.upload_session_id
     OR NEW.mime_type <> OLD.mime_type OR NEW.byte_size <> OLD.byte_size
     OR NEW.checksum_sha256 <> OLD.checksum_sha256
  THEN
    RAISE EXCEPTION 'evidence update identity or version is invalid' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status::text, NEW.status::text) IN (VALUES
      ('PENDING','READY_UNCLAIMED'),('PENDING','FAILED'),('PENDING','QUARANTINED'),('PENDING','DELETION_PENDING'),
      ('READY_UNCLAIMED','READY'),('READY_UNCLAIMED','QUARANTINED'),('READY_UNCLAIMED','DELETION_PENDING'),
      ('READY','QUARANTINED'),('READY','DELETION_PENDING'),
      ('FAILED','DELETION_PENDING'),('QUARANTINED','DELETION_PENDING'),
      ('DELETION_PENDING','DELETED'),('DELETION_PENDING','DELETE_FAILED'),
      ('DELETE_FAILED','DELETION_PENDING')
    )
  ) THEN
    RAISE EXCEPTION 'invalid evidence status transition' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND (
    (OLD.status = 'PENDING' AND NEW.status IN ('READY_UNCLAIMED','FAILED','QUARANTINED') AND
      (pg_catalog.to_jsonb(NEW) - ARRAY['object_key','derivative_object_keys','scan_temporary_object_key','scan_result_code','claim_deadline_at','status','version','updated_at'])
      IS DISTINCT FROM
      (pg_catalog.to_jsonb(OLD) - ARRAY['object_key','derivative_object_keys','scan_temporary_object_key','scan_result_code','claim_deadline_at','status','version','updated_at']))
    OR (OLD.status = 'READY_UNCLAIMED' AND NEW.status = 'READY' AND
      (pg_catalog.to_jsonb(NEW) - ARRAY['after_sale_id','status','claimed_at','retention_deadline_at','version','updated_at'])
      IS DISTINCT FROM
      (pg_catalog.to_jsonb(OLD) - ARRAY['after_sale_id','status','claimed_at','retention_deadline_at','version','updated_at']))
    OR (NEW.status = 'QUARANTINED' AND OLD.status <> 'PENDING' AND
      (pg_catalog.to_jsonb(NEW) - ARRAY['status','scan_result_code','version','updated_at'])
      IS DISTINCT FROM
      (pg_catalog.to_jsonb(OLD) - ARRAY['status','scan_result_code','version','updated_at']))
    OR (NEW.status = 'DELETION_PENDING' AND OLD.status <> 'DELETE_FAILED' AND
      (pg_catalog.to_jsonb(NEW) - ARRAY['status','version','updated_at'])
      IS DISTINCT FROM
      (pg_catalog.to_jsonb(OLD) - ARRAY['status','version','updated_at']))
    OR (OLD.status = 'DELETE_FAILED' AND NEW.status = 'DELETION_PENDING' AND
      (pg_catalog.to_jsonb(NEW) - ARRAY['status','next_delete_attempt_at','delete_error_code','version','updated_at'])
      IS DISTINCT FROM
      (pg_catalog.to_jsonb(OLD) - ARRAY['status','next_delete_attempt_at','delete_error_code','version','updated_at']))
    OR (NEW.status = 'DELETE_FAILED' AND
      (pg_catalog.to_jsonb(NEW) - ARRAY['status','delete_attempt_count','next_delete_attempt_at','delete_error_code','version','updated_at'])
      IS DISTINCT FROM
      (pg_catalog.to_jsonb(OLD) - ARRAY['status','delete_attempt_count','next_delete_attempt_at','delete_error_code','version','updated_at']))
    OR (NEW.status = 'DELETED' AND
      (pg_catalog.to_jsonb(NEW) - ARRAY['object_key','derivative_object_keys','scan_temporary_object_key','scan_result_code','status','next_delete_attempt_at','delete_error_code','deleted_at','version','updated_at'])
      IS DISTINCT FROM
      (pg_catalog.to_jsonb(OLD) - ARRAY['object_key','derivative_object_keys','scan_temporary_object_key','scan_result_code','status','next_delete_attempt_at','delete_error_code','deleted_at','version','updated_at']))
  ) THEN
    RAISE EXCEPTION 'evidence transition contains fields outside its bounded event'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = OLD.status AND NOT (
    (OLD.status = 'PENDING'
      AND NEW.legal_hold_active = OLD.legal_hold_active
      AND NEW.held_at IS NOT DISTINCT FROM OLD.held_at
      AND NEW.held_by IS NOT DISTINCT FROM OLD.held_by
      AND NEW.hold_reason IS NOT DISTINCT FROM OLD.hold_reason
      AND (pg_catalog.to_jsonb(NEW) - ARRAY['object_key','derivative_object_keys','scan_temporary_object_key','claim_deadline_at','version','updated_at'])
         IS NOT DISTINCT FROM
         (pg_catalog.to_jsonb(OLD) - ARRAY['object_key','derivative_object_keys','scan_temporary_object_key','claim_deadline_at','version','updated_at'])
      AND (NEW.claim_deadline_at IS NOT DISTINCT FROM OLD.claim_deadline_at
        OR (OLD.claim_deadline_at IS NULL AND NEW.claim_deadline_at > pg_catalog.clock_timestamp())))
    OR (pg_catalog.current_setting('app.actor_type', true) = 'admin'
      AND (pg_catalog.to_jsonb(NEW) - ARRAY['legal_hold_active','held_at','held_by','hold_reason','version','updated_at'])
         IS NOT DISTINCT FROM
         (pg_catalog.to_jsonb(OLD) - ARRAY['legal_hold_active','held_at','held_by','hold_reason','version','updated_at'])
      AND ((NOT OLD.legal_hold_active AND NEW.legal_hold_active
          AND NEW.held_at IS NOT NULL AND NEW.held_by = app_security.current_actor_id()
          AND NEW.hold_reason IS NOT NULL AND pg_catalog.btrim(NEW.hold_reason) <> '')
        OR (OLD.legal_hold_active AND NOT NEW.legal_hold_active
          AND NEW.held_at IS NULL AND NEW.held_by IS NULL AND NEW.hold_reason IS NULL)))
  ) THEN
    RAISE EXCEPTION 'same-state evidence update may only stage immutable object metadata'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'PENDING' AND NEW.status = 'READY_UNCLAIMED' AND (
    NEW.object_key IS NULL OR NEW.scan_result_code IS DISTINCT FROM 'CLEAN'
    OR NEW.claim_deadline_at IS NULL OR NEW.claim_deadline_at <= pg_catalog.clock_timestamp()
    OR NEW.after_sale_id IS NOT NULL OR NEW.claimed_at IS NOT NULL
    OR NEW.retention_deadline_at IS NOT NULL
  ) THEN RAISE EXCEPTION 'scan-passed evidence shape is invalid' USING ERRCODE = '23514'; END IF;
  IF OLD.status = 'PENDING' AND NEW.status IN ('FAILED','QUARANTINED')
     AND (NEW.scan_result_code IS NULL OR NEW.claim_deadline_at IS NULL)
  THEN RAISE EXCEPTION 'failed or quarantined evidence requires scan result and cleanup deadline' USING ERRCODE = '23514'; END IF;
  IF OLD.status = 'READY_UNCLAIMED' AND NEW.status = 'READY' AND (
    OLD.claim_deadline_at IS NULL OR pg_catalog.clock_timestamp() >= OLD.claim_deadline_at
    OR OLD.after_sale_id IS NOT NULL OR NEW.after_sale_id IS NULL
    OR NEW.claimed_at IS NULL OR NEW.retention_deadline_at IS NULL
    OR NEW.retention_deadline_at <= NEW.claimed_at OR NEW.legal_hold_active
  ) THEN RAISE EXCEPTION 'evidence claim is outside its owner-bound window' USING ERRCODE = '23514'; END IF;
  IF NEW.status = 'DELETION_PENDING' AND OLD.status <> 'DELETION_PENDING' AND (
    NEW.legal_hold_active OR effective_deadline IS NULL
    OR pg_catalog.clock_timestamp() < effective_deadline
  ) THEN RAISE EXCEPTION 'evidence retention deadline is still active' USING ERRCODE = '23514'; END IF;
  IF OLD.status = 'DELETION_PENDING' AND NEW.status = 'DELETE_FAILED' AND (
    NEW.delete_attempt_count <> OLD.delete_attempt_count + 1
    OR NEW.delete_error_code IS NULL OR NEW.next_delete_attempt_at IS NULL
    OR NEW.next_delete_attempt_at <= pg_catalog.clock_timestamp()
  ) THEN RAISE EXCEPTION 'failed evidence deletion retry shape is invalid' USING ERRCODE = '23514'; END IF;
  IF OLD.status = 'DELETE_FAILED' AND NEW.status = 'DELETION_PENDING' AND (
    NEW.legal_hold_active OR effective_deadline IS NULL
    OR pg_catalog.clock_timestamp() < effective_deadline
    OR OLD.next_delete_attempt_at IS NULL
    OR pg_catalog.clock_timestamp() < OLD.next_delete_attempt_at
    OR NEW.delete_error_code IS NOT NULL OR NEW.next_delete_attempt_at IS NOT NULL
  ) THEN RAISE EXCEPTION 'evidence deletion retry is not due' USING ERRCODE = '23514'; END IF;
  IF NEW.status = 'DELETED' AND (
    OLD.status <> 'DELETION_PENDING' OR NEW.legal_hold_active
    OR effective_deadline IS NULL OR pg_catalog.clock_timestamp() < effective_deadline
    OR NEW.deleted_at IS NULL OR NEW.object_key IS NOT NULL
    OR NEW.derivative_object_keys IS NOT NULL OR NEW.scan_temporary_object_key IS NOT NULL
    OR NEW.scan_result_code IS NOT NULL OR NEW.next_delete_attempt_at IS NOT NULL
    OR NEW.delete_error_code IS NOT NULL
  ) THEN RAISE EXCEPTION 'evidence deletion completion is invalid' USING ERRCODE = '23514'; END IF;
  IF OLD.object_key IS DISTINCT FROM NEW.object_key AND NOT (
    (OLD.status = 'PENDING' AND OLD.object_key IS NULL AND NEW.object_key IS NOT NULL)
    OR (NEW.status = 'DELETED' AND NEW.object_key IS NULL)
  ) THEN RAISE EXCEPTION 'evidence object identity is immutable' USING ERRCODE = '42501'; END IF;
  IF NEW.status <> 'DELETED' AND NEW.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'evidence deleted_at requires DELETED status' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION "app_security"."append_m62_evidence_transition"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE transition_event text;
DECLARE transition_actor public."AuditActorType";
BEGIN
  IF NEW.status = OLD.status THEN RETURN NULL; END IF;
  transition_event := CASE
    WHEN OLD.status = 'PENDING' AND NEW.status = 'READY_UNCLAIMED' THEN 'SCAN_PASSED'
    WHEN OLD.status = 'PENDING' AND NEW.status = 'FAILED' THEN 'SCAN_FAILED'
    WHEN NEW.status = 'QUARANTINED' THEN 'QUARANTINE'
    WHEN OLD.status = 'READY_UNCLAIMED' AND NEW.status = 'READY' THEN 'CLAIM'
    WHEN NEW.status = 'DELETION_PENDING' AND OLD.status = 'DELETE_FAILED' THEN 'RETRY_DELETE'
    WHEN NEW.status = 'DELETION_PENDING' THEN 'EXPIRE'
    WHEN NEW.status = 'DELETED' THEN 'DELETE_SUCCEEDED'
    WHEN NEW.status = 'DELETE_FAILED' THEN 'DELETE_FAILED'
  END;
  transition_actor := CASE pg_catalog.current_setting('app.actor_type', true)
    WHEN 'member' THEN 'MEMBER'::public."AuditActorType"
    ELSE 'ADMIN'::public."AuditActorType" END;
  INSERT INTO public.after_sale_evidence_transitions
    (store_id, evidence_file_id, from_status, to_status, event, actor_type, actor_id, error_code)
  VALUES (NEW.store_id, NEW.id, OLD.status, NEW.status, transition_event,
    transition_actor, app_security.current_actor_id(), NEW.delete_error_code);
  RETURN NULL;
END
$$;
CREATE TRIGGER "after_sale_evidence_files_append_transition"
  AFTER UPDATE OF "status" ON "after_sale_evidence_files"
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION "app_security"."append_m62_evidence_transition"();
REVOKE INSERT ON "after_sale_evidence_transitions" FROM zalo_shop_runtime;
CREATE POLICY "after_sale_evidence_transitions_projection_insert"
  ON "after_sale_evidence_transitions" FOR INSERT
  WITH CHECK ("store_id" = app_security.current_store_id() AND CURRENT_USER <> SESSION_USER);

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_shipment_purpose"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE case_record record;
BEGIN
  IF NEW.purpose = 'ORDER_OUTBOUND' THEN
    IF NEW.after_sale_id IS NOT NULL THEN
      RAISE EXCEPTION 'order outbound shipment cannot reference an after-sale case'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT sale.type, sale.status
  INTO case_record
  FROM public.after_sales sale
  WHERE sale.store_id = NEW.store_id AND sale.id = NEW.after_sale_id
    AND sale.order_id = NEW.order_id
  FOR UPDATE;
  IF NOT FOUND
     OR (NEW.purpose = 'EXCHANGE_OUTBOUND' AND case_record.type <> 'EXCHANGE')
     OR (NEW.purpose = 'AFTER_SALE_RETURN'
       AND case_record.type NOT IN ('RETURN_REFUND','EXCHANGE'))
  THEN
    RAISE EXCEPTION 'shipment purpose is incompatible with the after-sale case'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND (
    (NEW.purpose = 'AFTER_SALE_RETURN'
      AND case_record.status NOT IN ('APPROVED','RETURN_PENDING'))
    OR (NEW.purpose = 'EXCHANGE_OUTBOUND'
      AND case_record.status <> 'EXCHANGE_PENDING')
  ) THEN
    RAISE EXCEPTION 'after-sale shipment cannot be created in the current aggregate state'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_exchange_fulfillment"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE item_record record;
DECLARE reservation_status text;
DECLARE shipment_status text;
DECLARE aggregate_status public.after_sale_status;
BEGIN
  IF pg_catalog.current_setting('app.actor_type', true) <> 'admin' THEN
    RAISE EXCEPTION 'exchange fulfillment is an internal administrative fact'
      USING ERRCODE = '42501';
  END IF;
  SELECT item.order_id, item.product_id, item.sku_id,
    item.replacement_sku_id, item.replacement_quantity,
    sale.type AS sale_type, sale.status AS sale_status,
    sale.review_resume_status
  INTO item_record
  FROM public.after_sale_items item
  JOIN public.after_sales sale ON sale.store_id = item.store_id
    AND sale.id = item.after_sale_id AND sale.order_id = item.order_id
  WHERE item.store_id = NEW.store_id AND item.id = NEW.after_sale_item_id
    AND item.after_sale_id = NEW.after_sale_id
  FOR UPDATE OF item, sale;
  IF NOT FOUND OR item_record.order_id <> NEW.order_id
     OR item_record.sale_type <> 'EXCHANGE'
     OR item_record.product_id <> NEW.product_id
     OR item_record.replacement_sku_id IS NULL
     OR item_record.replacement_sku_id <> NEW.replacement_sku_id
     OR item_record.replacement_sku_id = item_record.sku_id
     OR item_record.replacement_quantity <= 0
  THEN
    RAISE EXCEPTION 'exchange fulfillment must match its approved after-sale item'
      USING ERRCODE = '23514';
  END IF;
  aggregate_status := CASE WHEN item_record.sale_status = 'REVIEW_REQUIRED'
    THEN item_record.review_resume_status ELSE item_record.sale_status END;
  IF item_record.sale_status NOT IN ('EXCHANGE_PENDING','EXCHANGE_IN_TRANSIT','REVIEW_REQUIRED')
     OR aggregate_status IS NULL
     OR aggregate_status NOT IN ('EXCHANGE_PENDING','EXCHANGE_IN_TRANSIT')
  THEN
    RAISE EXCEPTION 'exchange fulfillment is outside the locked after-sale exchange state'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING' OR NEW.version <> 1
       OR NEW.reservation_id IS NOT NULL OR NEW.outbound_shipment_id IS NOT NULL
       OR NEW.reserved_at IS NOT NULL OR NEW.shipped_at IS NOT NULL OR NEW.delivered_at IS NOT NULL
       OR item_record.sale_status <> 'EXCHANGE_PENDING'
    THEN
      RAISE EXCEPTION 'exchange fulfillment must be created pending without side effects'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('DELIVERED','CANCELLED') OR NEW.version <> OLD.version + 1
     OR NEW.status = OLD.status OR NEW.updated_at < OLD.updated_at
     OR (pg_catalog.to_jsonb(NEW) - ARRAY['reservation_id','outbound_shipment_id','status','version','reserved_at','shipped_at','delivered_at','updated_at'])
        IS DISTINCT FROM
        (pg_catalog.to_jsonb(OLD) - ARRAY['reservation_id','outbound_shipment_id','status','version','reserved_at','shipped_at','delivered_at','updated_at'])
  THEN
    RAISE EXCEPTION 'invalid exchange fulfillment transition shape' USING ERRCODE = '23514';
  END IF;
  IF NOT ((OLD.status::text, NEW.status::text) IN (VALUES
    ('PENDING','RESERVED'),('PENDING','CANCELLED'),('PENDING','REVIEW_REQUIRED'),
    ('RESERVED','IN_TRANSIT'),('RESERVED','CANCELLED'),('RESERVED','REVIEW_REQUIRED'),
    ('IN_TRANSIT','DELIVERED'),('IN_TRANSIT','REVIEW_REQUIRED'),
    ('REVIEW_REQUIRED','PENDING'),('REVIEW_REQUIRED','RESERVED'),
    ('REVIEW_REQUIRED','IN_TRANSIT'),('REVIEW_REQUIRED','CANCELLED')
  )) THEN
    RAISE EXCEPTION 'invalid exchange fulfillment status graph' USING ERRCODE = '23514';
  END IF;
  IF (NEW.status IN ('PENDING','RESERVED','CANCELLED')
      AND aggregate_status <> 'EXCHANGE_PENDING')
     OR (NEW.status = 'IN_TRANSIT'
      AND aggregate_status NOT IN ('EXCHANGE_PENDING','EXCHANGE_IN_TRANSIT'))
     OR (NEW.status = 'DELIVERED' AND aggregate_status <> 'EXCHANGE_IN_TRANSIT')
  THEN
    RAISE EXCEPTION 'exchange fulfillment transition does not match its after-sale aggregate state'
      USING ERRCODE = '23514';
  END IF;
  IF (OLD.reservation_id IS NOT NULL AND NEW.reservation_id IS DISTINCT FROM OLD.reservation_id)
     OR (OLD.outbound_shipment_id IS NOT NULL AND NEW.outbound_shipment_id IS DISTINCT FROM OLD.outbound_shipment_id)
     OR (OLD.reserved_at IS NOT NULL AND NEW.reserved_at IS DISTINCT FROM OLD.reserved_at)
     OR (OLD.shipped_at IS NOT NULL AND NEW.shipped_at IS DISTINCT FROM OLD.shipped_at)
  THEN
    RAISE EXCEPTION 'exchange fulfillment facts cannot be replaced or cleared'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'REVIEW_REQUIRED' AND (
    NEW.reservation_id IS DISTINCT FROM OLD.reservation_id
    OR NEW.outbound_shipment_id IS DISTINCT FROM OLD.outbound_shipment_id
    OR NEW.reserved_at IS DISTINCT FROM OLD.reserved_at
    OR NEW.shipped_at IS DISTINCT FROM OLD.shipped_at
    OR NEW.delivered_at IS DISTINCT FROM OLD.delivered_at
  ) THEN
    RAISE EXCEPTION 'review transition cannot alter exchange fulfillment facts'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.reservation_id IS NOT NULL THEN
    SELECT reservation.status::text INTO reservation_status
    FROM public.inventory_reservations reservation
    WHERE reservation.store_id = NEW.store_id AND reservation.id = NEW.reservation_id
      AND reservation.source_type = 'AFTER_SALE_EXCHANGE'
      AND reservation.source_id = NEW.after_sale_id
      AND EXISTS (
        SELECT 1 FROM public.inventory_reservation_items reservation_item
        WHERE reservation_item.store_id = reservation.store_id
          AND reservation_item.reservation_id = reservation.id
          AND reservation_item.warehouse_id = NEW.warehouse_id
          AND reservation_item.sku_id = NEW.replacement_sku_id
          AND reservation_item.quantity = item_record.replacement_quantity
      );
    IF NOT FOUND THEN RAISE EXCEPTION 'exchange reservation tuple is invalid' USING ERRCODE = '23514'; END IF;
  END IF;
  IF NEW.outbound_shipment_id IS NOT NULL THEN
    SELECT shipment.status::text INTO shipment_status
    FROM public.shipments shipment
    WHERE shipment.store_id = NEW.store_id AND shipment.id = NEW.outbound_shipment_id
      AND shipment.order_id = NEW.order_id AND shipment.after_sale_id = NEW.after_sale_id
      AND shipment.purpose = 'EXCHANGE_OUTBOUND';
    IF NOT FOUND THEN RAISE EXCEPTION 'exchange outbound shipment is invalid' USING ERRCODE = '23514'; END IF;
  END IF;
  IF NEW.status = 'PENDING' AND (
    NEW.reservation_id IS NOT NULL OR NEW.outbound_shipment_id IS NOT NULL
    OR NEW.reserved_at IS NOT NULL OR NEW.shipped_at IS NOT NULL OR NEW.delivered_at IS NOT NULL
  ) THEN RAISE EXCEPTION 'pending exchange cannot retain fulfillment side effects' USING ERRCODE = '23514'; END IF;
  IF NEW.status = 'RESERVED' AND (
    OLD.status NOT IN ('PENDING','REVIEW_REQUIRED') OR reservation_status IS DISTINCT FROM 'ACTIVE'
    OR NEW.reservation_id IS NULL
    OR NEW.reserved_at IS NULL OR NEW.outbound_shipment_id IS NOT NULL
    OR NEW.shipped_at IS NOT NULL OR NEW.delivered_at IS NOT NULL
  ) THEN RAISE EXCEPTION 'RESERVED exchange requires an active reservation' USING ERRCODE = '23514'; END IF;
  IF NEW.status = 'IN_TRANSIT' AND (
    OLD.status NOT IN ('RESERVED','REVIEW_REQUIRED')
    OR NEW.reservation_id IS NULL OR reservation_status IS NULL
    OR reservation_status NOT IN ('ACTIVE','CONSUMED') OR NEW.outbound_shipment_id IS NULL
    OR shipment_status IS NULL
    OR shipment_status NOT IN ('PENDING_PICKUP','IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERED')
    OR NEW.reserved_at IS NULL OR NEW.shipped_at IS NULL OR NEW.delivered_at IS NOT NULL
  ) THEN RAISE EXCEPTION 'IN_TRANSIT exchange requires reservation and outbound shipment facts' USING ERRCODE = '23514'; END IF;
  IF NEW.status = 'DELIVERED' AND (
    OLD.status <> 'IN_TRANSIT' OR NEW.outbound_shipment_id IS NULL
    OR shipment_status IS NULL OR shipment_status <> 'DELIVERED'
    OR NEW.shipped_at IS NULL OR NEW.delivered_at IS NULL OR NEW.delivered_at < NEW.shipped_at
  ) THEN RAISE EXCEPTION 'DELIVERED exchange requires authoritative shipment delivery' USING ERRCODE = '23514'; END IF;
  IF NEW.status = 'CANCELLED' AND (
    OLD.status NOT IN ('PENDING','RESERVED','REVIEW_REQUIRED')
    OR NEW.outbound_shipment_id IS NOT NULL
    OR (NEW.reservation_id IS NOT NULL
      AND (reservation_status IS NULL OR reservation_status NOT IN ('RELEASED','EXPIRED')))
    OR NEW.shipped_at IS NOT NULL OR NEW.delivered_at IS NOT NULL
  ) THEN RAISE EXCEPTION 'cancelled exchange must have no outbound side effect and released capacity' USING ERRCODE = '23514'; END IF;
  IF NEW.status = 'REVIEW_REQUIRED' AND OLD.status NOT IN ('PENDING','RESERVED','IN_TRANSIT') THEN
    RAISE EXCEPTION 'invalid exchange review transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER "exchange_fulfillments_integrity_guard" ON "exchange_fulfillments";
CREATE TRIGGER "exchange_fulfillments_integrity_guard"
  BEFORE INSERT OR UPDATE ON "exchange_fulfillments"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_exchange_fulfillment"();

ALTER FUNCTION "app_security"."validate_m62_return_submission"()
  SECURITY DEFINER;
ALTER FUNCTION "app_security"."validate_m62_return_submission"()
  SET search_path TO pg_catalog, public, pg_temp;
REVOKE ALL ON FUNCTION "app_security"."validate_m62_return_submission"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "app_security"."validate_m62_return_submission"() FROM zalo_shop_runtime;

DROP POLICY "after_sale_return_shipments_actor_scope" ON "after_sale_return_shipments";
CREATE POLICY "after_sale_return_shipments_select_scope" ON "after_sale_return_shipments"
  FOR SELECT USING (
    "store_id" = app_security.current_store_id()
    AND (pg_catalog.current_setting('app.actor_type', true) = 'admin'
      OR (pg_catalog.current_setting('app.actor_type', true) = 'member'
        AND "member_id" = app_security.current_actor_id()))
  );
CREATE POLICY "after_sale_return_shipments_insert_scope" ON "after_sale_return_shipments"
  FOR INSERT WITH CHECK (
    "store_id" = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'member'
    AND "member_id" = app_security.current_actor_id()
    AND "submitted_by" = app_security.current_actor_id()
    AND "status" = 'SUBMITTED' AND "received_at" IS NULL AND "version" = 1
  );
CREATE POLICY "after_sale_return_shipments_admin_update" ON "after_sale_return_shipments"
  FOR UPDATE
  USING ("store_id" = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'admin')
  WITH CHECK ("store_id" = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'admin');

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_return_shipment_lifecycle"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF pg_catalog.current_setting('app.actor_type', true) <> 'member'
       OR NEW.member_id <> app_security.current_actor_id()
       OR NEW.submitted_by <> app_security.current_actor_id()
       OR NEW.status <> 'SUBMITTED' OR NEW.received_at IS NOT NULL OR NEW.version <> 1
    THEN
      RAISE EXCEPTION 'member return shipment must be an owner-bound SUBMITTED fact'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF pg_catalog.current_setting('app.actor_type', true) <> 'admin'
     OR OLD.status IN ('DELIVERED','REJECTED')
     OR NEW.status = OLD.status OR NEW.version <> OLD.version + 1
     OR NEW.updated_at < OLD.updated_at
     OR NOT ((OLD.status::text, NEW.status::text) IN (VALUES
       ('SUBMITTED','IN_TRANSIT'),('SUBMITTED','DELIVERED'),('SUBMITTED','REJECTED'),('SUBMITTED','UNKNOWN'),
       ('IN_TRANSIT','DELIVERED'),('IN_TRANSIT','REJECTED'),('IN_TRANSIT','UNKNOWN'),
       ('UNKNOWN','IN_TRANSIT'),('UNKNOWN','DELIVERED'),('UNKNOWN','REJECTED')
     ))
     OR (pg_catalog.to_jsonb(NEW) - ARRAY['status','received_at','version','updated_at'])
        IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - ARRAY['status','received_at','version','updated_at'])
     OR (NEW.status = 'DELIVERED' AND NEW.received_at IS NULL)
     OR (NEW.status <> 'DELIVERED' AND NEW.received_at IS NOT NULL)
  THEN
    RAISE EXCEPTION 'return shipment update requires an authoritative admin transition'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "after_sale_return_shipments_lifecycle_guard"
  BEFORE INSERT OR UPDATE ON "after_sale_return_shipments"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_return_shipment_lifecycle"();

REVOKE INSERT ON "share_links", "share_link_localizations", "share_interactions"
FROM zalo_shop_runtime;

REVOKE ALL ON FUNCTION
  "app_security"."validate_m62_after_sale_initial_shape"(),
  "app_security"."validate_m62_after_sale_item_initial_shape"(),
  "app_security"."validate_m62_legacy_decision"(),
  "app_security"."validate_m62_after_sale_item_approval"(),
  "app_security"."validate_m62_after_sale_operation_initial_shape"(),
  "app_security"."validate_m62_after_sale_approval_fields"(),
  "app_security"."validate_m62_after_sale_transition"(),
  "app_security"."apply_m62_after_sale_transition"(),
  "app_security"."validate_m62_after_sale_header_projection"(),
  "app_security"."validate_m62_inspection_allocation_identity"(),
  "app_security"."validate_m62_inspection_header"(),
  "app_security"."project_m62_complete_inspection"(),
  "app_security"."validate_m62_settlement_lifecycle"(),
  "app_security"."validate_m62_inventory_action"(),
  "app_security"."validate_m62_evidence_initial_shape"(),
  "app_security"."validate_m62_evidence_lifecycle"(),
  "app_security"."append_m62_evidence_transition"(),
  "app_security"."validate_m62_shipment_purpose"(),
  "app_security"."validate_m62_exchange_fulfillment"(),
  "app_security"."validate_m62_return_shipment_lifecycle"()
FROM PUBLIC;
REVOKE ALL ON FUNCTION
  "app_security"."validate_m62_after_sale_initial_shape"(),
  "app_security"."validate_m62_after_sale_item_initial_shape"(),
  "app_security"."validate_m62_legacy_decision"(),
  "app_security"."validate_m62_after_sale_item_approval"(),
  "app_security"."validate_m62_after_sale_operation_initial_shape"(),
  "app_security"."validate_m62_after_sale_approval_fields"(),
  "app_security"."validate_m62_after_sale_transition"(),
  "app_security"."apply_m62_after_sale_transition"(),
  "app_security"."validate_m62_after_sale_header_projection"(),
  "app_security"."validate_m62_inspection_allocation_identity"(),
  "app_security"."validate_m62_inspection_header"(),
  "app_security"."project_m62_complete_inspection"(),
  "app_security"."validate_m62_settlement_lifecycle"(),
  "app_security"."validate_m62_inventory_action"(),
  "app_security"."validate_m62_evidence_initial_shape"(),
  "app_security"."validate_m62_evidence_lifecycle"(),
  "app_security"."append_m62_evidence_transition"(),
  "app_security"."validate_m62_shipment_purpose"(),
  "app_security"."validate_m62_exchange_fulfillment"(),
  "app_security"."validate_m62_return_shipment_lifecycle"()
FROM zalo_shop_runtime;
