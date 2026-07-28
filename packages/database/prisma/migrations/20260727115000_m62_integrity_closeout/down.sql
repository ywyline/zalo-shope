-- LOCAL/TEST ONLY.  Never weaken M6.2 integrity after business facts exist.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.after_sales LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.after_sale_items LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.after_sale_transitions LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.after_sale_operations LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.after_sale_inspections LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.after_sale_inspection_allocations LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.after_sale_evidence_files LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.after_sale_settlements LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.after_sale_refunds LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.after_sale_inventory_actions LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.after_sale_return_shipments LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.exchange_fulfillments LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.member_favorites LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.member_product_views LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.privacy_requests LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.share_links LIMIT 1)
  THEN
    RAISE EXCEPTION 'M6.2 integrity closeout rollback is unsafe after business facts exist'
      USING ERRCODE = '55000';
  END IF;
END
$$;
SELECT "app_security"."assert_m62_rollback_safe"();

DROP TRIGGER "after_sales_initial_shape_guard" ON "after_sales";
DROP TRIGGER "after_sale_items_initial_shape_guard" ON "after_sale_items";
DROP TRIGGER "after_sale_legacy_decisions_initial_guard" ON "after_sale_legacy_decisions";
DROP TRIGGER "after_sale_items_approval_guard" ON "after_sale_items";
DROP TRIGGER "after_sale_operations_initial_shape_guard" ON "after_sale_operations";
DROP TRIGGER "after_sales_approval_fields_guard" ON "after_sales";
DROP TRIGGER "after_sale_transitions_state_guard" ON "after_sale_transitions";
DROP TRIGGER "after_sale_transitions_apply_state" ON "after_sale_transitions";
DROP TRIGGER "after_sales_transition_only_guard" ON "after_sales";
DROP TRIGGER "after_sale_inspection_allocations_identity_guard" ON "after_sale_inspection_allocations";
DROP TRIGGER "after_sale_inspections_actor_guard" ON "after_sale_inspections";
DROP TRIGGER "after_sale_inspections_complete_guard" ON "after_sale_inspections";
DROP TRIGGER "after_sale_inspection_allocations_complete_guard" ON "after_sale_inspection_allocations";
DROP TRIGGER "after_sale_settlements_lifecycle_guard" ON "after_sale_settlements";
DROP TRIGGER "after_sale_evidence_files_initial_shape_guard" ON "after_sale_evidence_files";
DROP TRIGGER "after_sale_evidence_files_append_transition" ON "after_sale_evidence_files";
DROP TRIGGER "after_sale_return_shipments_lifecycle_guard" ON "after_sale_return_shipments";
DROP TRIGGER "exchange_fulfillments_integrity_guard" ON "exchange_fulfillments";

DROP INDEX "after_sale_refunds_store_id_settlement_id_key";
DROP POLICY "after_sale_evidence_transitions_projection_insert" ON "after_sale_evidence_transitions";
DROP POLICY "after_sale_items_inspection_projection" ON "after_sale_items";

DROP POLICY "after_sales_transition_projection" ON "after_sales";
CREATE POLICY "after_sales_member_cancel" ON "after_sales"
  FOR UPDATE
  USING (
    "store_id" = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'member'
    AND "member_id" = app_security.current_actor_id()
    AND "status" = 'PENDING_REVIEW'
  )
  WITH CHECK (
    "store_id" = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'member'
    AND CURRENT_USER <> SESSION_USER
    AND "member_id" = app_security.current_actor_id()
    AND "status" = 'CANCELLED'
  );
CREATE OR REPLACE FUNCTION "app_security"."validate_m62_member_after_sale_cancel"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF pg_catalog.current_setting('app.actor_type', true) = 'member' THEN
    IF CURRENT_USER = SESSION_USER
       OR OLD.store_id <> app_security.current_store_id()
       OR OLD.member_id <> app_security.current_actor_id()
       OR OLD.status <> 'PENDING_REVIEW'
       OR NEW.status <> 'CANCELLED'
       OR NEW.version <> OLD.version + 1
       OR NEW.completed_at IS NULL
       OR NEW.updated_at < OLD.updated_at
       OR (pg_catalog.to_jsonb(NEW) - ARRAY['status','version','completed_at','updated_at'])
          IS DISTINCT FROM
          (pg_catalog.to_jsonb(OLD) - ARRAY['status','version','completed_at','updated_at'])
    THEN
      RAISE EXCEPTION 'member after-sale update must be a bounded pending cancellation'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE OR REPLACE FUNCTION "app_security"."apply_m62_member_after_sale_cancel"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE affected_rows integer;
BEGIN
  IF pg_catalog.current_setting('app.actor_type', true) = 'member' THEN
    UPDATE public.after_sales
    SET status = 'CANCELLED', version = version + 1,
        completed_at = pg_catalog.now(), updated_at = pg_catalog.now()
    WHERE store_id = NEW.store_id AND id = NEW.after_sale_id
      AND member_id = app_security.current_actor_id() AND status = 'PENDING_REVIEW';
    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    IF affected_rows <> 1 THEN
      RAISE EXCEPTION 'member cancellation failed to project exactly one pending after-sale'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "after_sales_member_cancel_guard"
  BEFORE UPDATE ON "after_sales"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_member_after_sale_cancel"();
CREATE TRIGGER "after_sale_transitions_apply_member_cancel"
  AFTER INSERT ON "after_sale_transitions"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."apply_m62_member_after_sale_cancel"();

GRANT UPDATE ("status","review_resume_status","return_expired_at","version","reviewed_by","reviewed_at","completed_at")
ON "after_sales" TO zalo_shop_runtime;
REVOKE UPDATE ("replacement_quantity") ON "after_sale_items" FROM zalo_shop_runtime;
GRANT UPDATE ("received_quantity","accepted_quantity","rejected_quantity","restockable_quantity",
  "condition","disposition","inspection_version","inspected_by")
ON "after_sale_items" TO zalo_shop_runtime;
REVOKE UPDATE ("legal_hold_active","held_at","held_by","hold_reason")
ON "after_sale_evidence_files" FROM zalo_shop_runtime;

DROP POLICY "after_sale_evidence_files_member_insert" ON "after_sale_evidence_files";
CREATE POLICY "after_sale_evidence_files_member_insert" ON "after_sale_evidence_files"
  FOR INSERT WITH CHECK (
    "store_id" = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'member'
    AND "member_id" = app_security.current_actor_id()
    AND "after_sale_id" IS NULL
    AND "status" = 'PENDING'
    AND "scan_result_code" IS NULL
    AND "claim_deadline_at" IS NULL
    AND "claimed_at" IS NULL
    AND "retention_deadline_at" IS NULL
    AND NOT "legal_hold_active"
    AND "held_at" IS NULL
    AND "held_by" IS NULL
    AND "hold_reason" IS NULL
    AND "delete_attempt_count" = 0
    AND "next_delete_attempt_at" IS NULL
    AND "delete_error_code" IS NULL
    AND "deleted_at" IS NULL
    AND "version" = 1
  );

DROP POLICY "after_sale_return_shipments_select_scope" ON "after_sale_return_shipments";
DROP POLICY "after_sale_return_shipments_insert_scope" ON "after_sale_return_shipments";
DROP POLICY "after_sale_return_shipments_admin_update" ON "after_sale_return_shipments";
CREATE POLICY "after_sale_return_shipments_actor_scope" ON "after_sale_return_shipments"
  USING ("store_id" = app_security.current_store_id()
    AND (pg_catalog.current_setting('app.actor_type', true) = 'admin'
      OR (pg_catalog.current_setting('app.actor_type', true) = 'member'
        AND "member_id" = app_security.current_actor_id())))
  WITH CHECK ("store_id" = app_security.current_store_id()
    AND (pg_catalog.current_setting('app.actor_type', true) = 'admin'
      OR (pg_catalog.current_setting('app.actor_type', true) = 'member'
        AND "member_id" = app_security.current_actor_id())));

GRANT INSERT ON "after_sale_evidence_transitions" TO zalo_shop_runtime;
GRANT INSERT ON "share_links", "share_link_localizations", "share_interactions"
TO zalo_shop_runtime;

ALTER FUNCTION "app_security"."validate_m62_return_submission"()
  SECURITY INVOKER;

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_inventory_action"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE action_total bigint;
DECLARE item_record record;
BEGIN
  SELECT order_id, sku_id, restockable_quantity INTO item_record
  FROM public.after_sale_items
  WHERE store_id = NEW.store_id AND id = NEW.after_sale_item_id AND after_sale_id = NEW.after_sale_id
  FOR UPDATE;
  IF NOT FOUND OR item_record.order_id <> NEW.order_id OR item_record.sku_id <> NEW.sku_id THEN
    RAISE EXCEPTION 'after-sale inventory action identity is invalid' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.inventory_operations operation
    JOIN public.inventory_movements movement
      ON movement.store_id = operation.store_id AND movement.operation_id = operation.id
    JOIN public.inventory_balances balance
      ON balance.store_id = movement.store_id AND balance.id = movement.balance_id
    WHERE operation.store_id = NEW.store_id AND operation.id = NEW.inventory_operation_id
      AND operation.operation_type = 'RESTORE' AND operation.source_type = 'AFTER_SALE_RESTORE'
      AND operation.source_id = NEW.after_sale_item_id
      AND movement.movement_type = 'RESTORE' AND movement.on_hand_delta = NEW.quantity
      AND movement.reserved_delta = 0 AND balance.warehouse_id = NEW.warehouse_id
      AND balance.sku_id = NEW.sku_id
  ) THEN
    RAISE EXCEPTION 'after-sale inventory action requires an exact RESTORE movement'
      USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(sum(quantity), 0) INTO action_total
  FROM public.after_sale_inventory_actions
  WHERE store_id = NEW.store_id AND after_sale_item_id = NEW.after_sale_item_id AND id <> NEW.id;
  IF action_total + NEW.quantity > item_record.restockable_quantity THEN
    RAISE EXCEPTION 'after-sale inventory restore exceeds restockable quantity'
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
BEGIN
  SELECT order_id, product_id, sku_id, replacement_sku_id, replacement_quantity INTO item_record
  FROM public.after_sale_items
  WHERE store_id = NEW.store_id AND id = NEW.after_sale_item_id AND after_sale_id = NEW.after_sale_id
  FOR UPDATE;
  IF NOT FOUND OR item_record.order_id <> NEW.order_id OR item_record.product_id <> NEW.product_id
     OR item_record.replacement_sku_id IS NULL OR item_record.replacement_sku_id <> NEW.replacement_sku_id
     OR item_record.replacement_sku_id = item_record.sku_id OR item_record.replacement_quantity <= 0
  THEN
    RAISE EXCEPTION 'exchange fulfillment must match its approved after-sale item'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.reservation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.inventory_reservations reservation
    JOIN public.inventory_reservation_items reservation_item
      ON reservation_item.store_id = reservation.store_id AND reservation_item.reservation_id = reservation.id
    WHERE reservation.store_id = NEW.store_id AND reservation.id = NEW.reservation_id
      AND reservation.source_type = 'AFTER_SALE_EXCHANGE' AND reservation.source_id = NEW.after_sale_id
      AND reservation.status = 'ACTIVE'
      AND reservation_item.warehouse_id = NEW.warehouse_id
      AND reservation_item.sku_id = NEW.replacement_sku_id
      AND reservation_item.quantity = item_record.replacement_quantity
  ) THEN
    RAISE EXCEPTION 'exchange reservation inventory tuple is invalid' USING ERRCODE = '23514';
  END IF;
  IF NEW.outbound_shipment_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.shipments shipment
    WHERE shipment.store_id = NEW.store_id AND shipment.id = NEW.outbound_shipment_id
      AND shipment.order_id = NEW.order_id AND shipment.after_sale_id = NEW.after_sale_id
      AND shipment.purpose = 'EXCHANGE_OUTBOUND'
  ) THEN
    RAISE EXCEPTION 'exchange outbound shipment purpose is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "exchange_fulfillments_integrity_guard"
  BEFORE INSERT OR UPDATE OF "reservation_id", "outbound_shipment_id", "status"
  ON "exchange_fulfillments"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_exchange_fulfillment"();

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_shipment_purpose"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE case_type public.after_sale_type;
BEGIN
  IF NEW.purpose = 'ORDER_OUTBOUND' THEN
    IF NEW.after_sale_id IS NOT NULL THEN
      RAISE EXCEPTION 'order outbound shipment cannot reference an after-sale case'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT sale.type INTO case_type
  FROM public.after_sales sale
  WHERE sale.store_id = NEW.store_id AND sale.id = NEW.after_sale_id
    AND sale.order_id = NEW.order_id
  FOR SHARE;
  IF NOT FOUND
     OR (NEW.purpose = 'EXCHANGE_OUTBOUND' AND case_type <> 'EXCHANGE')
     OR (NEW.purpose = 'AFTER_SALE_RETURN' AND case_type NOT IN ('RETURN_REFUND','EXCHANGE'))
  THEN
    RAISE EXCEPTION 'shipment purpose is incompatible with the after-sale case'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

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
  IF NEW.status = 'DELETION_PENDING' AND OLD.status IS DISTINCT FROM 'DELETION_PENDING' THEN
    IF NEW.legal_hold_active OR effective_deadline IS NULL OR clock_timestamp() < effective_deadline THEN
      RAISE EXCEPTION 'evidence retention deadline is still active' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.status = 'DELETED' THEN
    IF NEW.legal_hold_active OR OLD.status <> 'DELETION_PENDING'
       OR effective_deadline IS NULL OR clock_timestamp() < effective_deadline
       OR NEW.deleted_at IS NULL OR NEW.object_key IS NOT NULL
       OR NEW.derivative_object_keys IS NOT NULL OR NEW.scan_temporary_object_key IS NOT NULL
       OR NEW.next_delete_attempt_at IS NOT NULL OR NEW.delete_error_code IS NOT NULL
    THEN
      RAISE EXCEPTION 'evidence deletion completion is invalid' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF OLD.object_key IS DISTINCT FROM NEW.object_key AND NOT (
    (OLD.object_key IS NULL AND NEW.object_key IS NOT NULL AND OLD.status = 'PENDING'
      AND NEW.status IN ('PENDING','READY_UNCLAIMED'))
    OR (NEW.status = 'DELETED' AND NEW.object_key IS NULL)
  ) THEN
    RAISE EXCEPTION 'evidence object identity may only be assigned once or cleared on deletion'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.status <> 'DELETED' AND NEW.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'evidence deleted_at requires DELETED status' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DROP FUNCTION "app_security"."validate_m62_after_sale_initial_shape"();
DROP FUNCTION "app_security"."validate_m62_after_sale_item_initial_shape"();
DROP FUNCTION "app_security"."validate_m62_legacy_decision"();
DROP FUNCTION "app_security"."validate_m62_after_sale_item_approval"();
DROP FUNCTION "app_security"."validate_m62_after_sale_operation_initial_shape"();
DROP FUNCTION "app_security"."validate_m62_after_sale_approval_fields"();
DROP FUNCTION "app_security"."validate_m62_after_sale_transition"();
DROP FUNCTION "app_security"."apply_m62_after_sale_transition"();
DROP FUNCTION "app_security"."validate_m62_after_sale_header_projection"();
DROP FUNCTION "app_security"."validate_m62_inspection_allocation_identity"();
DROP FUNCTION "app_security"."validate_m62_inspection_header"();
DROP FUNCTION "app_security"."project_m62_complete_inspection"();
DROP FUNCTION "app_security"."validate_m62_settlement_lifecycle"();
DROP FUNCTION "app_security"."validate_m62_evidence_initial_shape"();
DROP FUNCTION "app_security"."append_m62_evidence_transition"();
DROP FUNCTION "app_security"."validate_m62_return_shipment_lifecycle"();

REVOKE ALL ON FUNCTION
  "app_security"."validate_m62_member_after_sale_cancel"(),
  "app_security"."apply_m62_member_after_sale_cancel"(),
  "app_security"."validate_m62_inventory_action"(),
  "app_security"."validate_m62_exchange_fulfillment"(),
  "app_security"."validate_m62_shipment_purpose"(),
  "app_security"."validate_m62_evidence_lifecycle"()
FROM PUBLIC;
REVOKE ALL ON FUNCTION
  "app_security"."validate_m62_member_after_sale_cancel"(),
  "app_security"."apply_m62_member_after_sale_cancel"(),
  "app_security"."validate_m62_inventory_action"(),
  "app_security"."validate_m62_exchange_fulfillment"(),
  "app_security"."validate_m62_shipment_purpose"(),
  "app_security"."validate_m62_evidence_lifecycle"()
FROM zalo_shop_runtime;
