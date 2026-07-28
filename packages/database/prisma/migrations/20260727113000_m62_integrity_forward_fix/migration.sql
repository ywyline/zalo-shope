-- M6.2 review-driven forward fix: close snapshot, settlement, evidence,
-- privacy, inventory and exchange integrity gaps before runtime work begins.

ALTER TABLE "after_sale_policy_versions" ALTER COLUMN "allowed_types" SET NOT NULL;

ALTER TABLE "order_item_after_sale_policy_snapshots"
  DROP CONSTRAINT "order_item_after_sale_policy_snapshots_version_fkey",
  ADD CONSTRAINT "order_item_after_sale_policy_snapshots_version_policy_fkey"
    FOREIGN KEY ("store_id", "policy_version_id", "policy_id")
    REFERENCES "after_sale_policy_versions"("store_id", "id", "policy_id")
    ON DELETE RESTRICT;

ALTER TABLE "store_after_sale_settings"
  ADD CONSTRAINT "store_after_sale_settings_readiness_actor_fkey" FOREIGN KEY ("readiness_checked_by") REFERENCES "admin_users"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "store_after_sale_settings_updated_actor_fkey" FOREIGN KEY ("updated_by") REFERENCES "admin_users"("id") ON DELETE RESTRICT;
ALTER TABLE "after_sales"
  ADD CONSTRAINT "after_sales_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "admin_users"("id") ON DELETE RESTRICT;
ALTER TABLE "after_sale_items"
  ADD CONSTRAINT "after_sale_items_inspected_by_fkey" FOREIGN KEY ("inspected_by") REFERENCES "admin_users"("id") ON DELETE RESTRICT;
ALTER TABLE "after_sale_evidence_files"
  ADD CONSTRAINT "after_sale_evidence_files_held_by_fkey" FOREIGN KEY ("held_by") REFERENCES "admin_users"("id") ON DELETE RESTRICT;
ALTER TABLE "after_sale_settlements"
  ADD CONSTRAINT "after_sale_settlements_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "admin_users"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_settlements_confirmed_by_fkey" FOREIGN KEY ("confirmed_by") REFERENCES "admin_users"("id") ON DELETE RESTRICT;
ALTER TABLE "after_sale_return_shipments"
  ADD CONSTRAINT "after_sale_return_shipments_submitter_fkey" FOREIGN KEY ("store_id", "submitted_by") REFERENCES "members"("store_id", "id") ON DELETE RESTRICT;

ALTER TABLE "after_sale_settlements"
  ADD CONSTRAINT "after_sale_settlements_cod_confirmation_check" CHECK (
    "method" <> 'COD_OFFLINE'
    OR "status" IN ('PENDING','FAILED','REVIEW_REQUIRED','CANCELLED')
    OR (
      "confirmed_by" IS NOT NULL AND "confirmed_at" IS NOT NULL
      AND "transfer_reference_digest" ~ '^[0-9a-f]{64}$'
      AND "transfer_evidence_ciphertext" IS NOT NULL
      AND ("status" <> 'SUCCEEDED' OR "completed_at" IS NOT NULL)
    )
  );

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_policy_snapshot"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE version_record record;
DECLARE policy_code text;
DECLARE resolved_policy_id uuid;
DECLARE resolved_version_id uuid;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('m62-policy:' || NEW.store_id::text, 0)
  );
  SELECT version_number, payload, payload_hash
  INTO version_record
  FROM public.after_sale_policy_versions
  WHERE store_id = NEW.store_id AND id = NEW.policy_version_id AND policy_id = NEW.policy_id;
  SELECT code INTO policy_code
  FROM public.after_sale_policies
  WHERE store_id = NEW.store_id AND id = NEW.policy_id;
  SELECT candidate.policy_id, candidate.policy_version_id
  INTO resolved_policy_id, resolved_version_id
  FROM (
    SELECT assignment.policy_id, assignment.policy_version_id, 1 AS priority
    FROM public.after_sale_active_policy_assignments assignment
    JOIN public.order_items item
      ON item.store_id = NEW.store_id AND item.order_id = NEW.order_id
     AND item.id = NEW.order_item_id
    WHERE assignment.store_id = NEW.store_id
      AND assignment.target_type = 'PRODUCT'
      AND assignment.product_id = item.product_id
    UNION ALL
    SELECT assignment.policy_id, assignment.policy_version_id, 2 AS priority
    FROM public.after_sale_active_policy_assignments assignment
    JOIN public.order_items item
      ON item.store_id = NEW.store_id AND item.order_id = NEW.order_id
     AND item.id = NEW.order_item_id
    WHERE assignment.store_id = NEW.store_id
      AND assignment.target_type = 'CATEGORY'
      AND assignment.category_id = item.category_id
    UNION ALL
    SELECT assignment.policy_id, assignment.policy_version_id, 3 AS priority
    FROM public.after_sale_active_policy_assignments assignment
    WHERE assignment.store_id = NEW.store_id
      AND assignment.target_type = 'STORE_DEFAULT'
  ) candidate
  ORDER BY candidate.priority
  LIMIT 1;
  IF version_record IS NULL OR policy_code IS NULL
     OR resolved_policy_id IS DISTINCT FROM NEW.policy_id
     OR resolved_version_id IS DISTINCT FROM NEW.policy_version_id
     OR version_record.version_number <> NEW.policy_version_number
     OR policy_code <> NEW.policy_code
     OR version_record.payload_hash <> NEW.payload_hash
     OR version_record.payload <> NEW.payload
  THEN
    RAISE EXCEPTION 'order-item after-sale snapshot must exactly match its immutable policy version'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "order_item_after_sale_policy_snapshots_integrity_guard"
  BEFORE INSERT ON "order_item_after_sale_policy_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_policy_snapshot"();

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_active_policy_assignment"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE assignment_record record;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('m62-policy:' || NEW.store_id::text, 0)
  );
  SELECT policy_id, policy_version_id, target_type, product_id, category_id
  INTO assignment_record
  FROM public.after_sale_policy_version_assignments
  WHERE store_id = NEW.store_id AND id = NEW.assignment_id;
  IF assignment_record IS NULL
     OR assignment_record.policy_id IS DISTINCT FROM NEW.policy_id
     OR assignment_record.policy_version_id IS DISTINCT FROM NEW.policy_version_id
     OR assignment_record.target_type IS DISTINCT FROM NEW.target_type
     OR assignment_record.product_id IS DISTINCT FROM NEW.product_id
     OR assignment_record.category_id IS DISTINCT FROM NEW.category_id
     OR NOT EXISTS (
       SELECT 1 FROM public.after_sale_policies policy
       WHERE policy.store_id = NEW.store_id AND policy.id = NEW.policy_id
         AND policy.status = 'ACTIVE' AND policy.current_version_id = NEW.policy_version_id
     )
  THEN
    RAISE EXCEPTION 'active after-sale assignment must project its immutable active version assignment'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_policy_enforcement"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('m62-policy:' || NEW.store_id::text, 0)
  );
  IF NEW.enforce_policy_snapshots AND (
    NEW.default_policy_id IS NULL OR NEW.current_version_id IS NULL OR NEW.readiness_ready_at IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM public.after_sale_active_policy_assignments assignment
      JOIN public.after_sale_policies policy
        ON policy.store_id = assignment.store_id AND policy.id = assignment.policy_id
      WHERE assignment.store_id = NEW.store_id
        AND assignment.target_type = 'STORE_DEFAULT'
        AND assignment.policy_id = NEW.default_policy_id
        AND assignment.policy_version_id = NEW.current_version_id
        AND policy.status = 'ACTIVE'
        AND policy.current_version_id = NEW.current_version_id
    )
  ) THEN
    RAISE EXCEPTION 'after-sale policy snapshot enforcement is not ready'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_policy_projection_final_state"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE scoped_store_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    scoped_store_id := OLD.store_id;
  ELSE
    scoped_store_id := NEW.store_id;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('m62-policy:' || scoped_store_id::text, 0)
  );

  IF EXISTS (
    SELECT 1
    FROM public.after_sale_active_policy_assignments active
    LEFT JOIN public.after_sale_policy_version_assignments immutable
      ON immutable.store_id = active.store_id AND immutable.id = active.assignment_id
    LEFT JOIN public.after_sale_policies policy
      ON policy.store_id = active.store_id AND policy.id = active.policy_id
    WHERE active.store_id = scoped_store_id
      AND (
        immutable.id IS NULL
        OR immutable.policy_id IS DISTINCT FROM active.policy_id
        OR immutable.policy_version_id IS DISTINCT FROM active.policy_version_id
        OR immutable.target_type IS DISTINCT FROM active.target_type
        OR immutable.product_id IS DISTINCT FROM active.product_id
        OR immutable.category_id IS DISTINCT FROM active.category_id
        OR policy.id IS NULL OR policy.status <> 'ACTIVE'
        OR policy.current_version_id IS DISTINCT FROM active.policy_version_id
      )
  ) THEN
    RAISE EXCEPTION 'active after-sale policy projection is stale or invalid'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.store_after_sale_settings settings
    WHERE settings.store_id = scoped_store_id AND settings.enforce_policy_snapshots
      AND (
        settings.default_policy_id IS NULL OR settings.current_version_id IS NULL
        OR settings.readiness_ready_at IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM public.after_sale_active_policy_assignments active
          JOIN public.after_sale_policies policy
            ON policy.store_id = active.store_id AND policy.id = active.policy_id
          WHERE active.store_id = settings.store_id
            AND active.target_type = 'STORE_DEFAULT'
            AND active.policy_id = settings.default_policy_id
            AND active.policy_version_id = settings.current_version_id
            AND policy.status = 'ACTIVE'
            AND policy.current_version_id = settings.current_version_id
        )
      )
  ) THEN
    RAISE EXCEPTION 'enforced after-sale policy projection cannot lose its active default'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "after_sale_policies_projection_final_guard"
  AFTER INSERT OR UPDATE OR DELETE ON "after_sale_policies"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_policy_projection_final_state"();
CREATE CONSTRAINT TRIGGER "after_sale_active_assignments_projection_final_guard"
  AFTER INSERT OR UPDATE OR DELETE ON "after_sale_active_policy_assignments"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_policy_projection_final_state"();

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_after_sale_actor"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF (NEW.source = 'MEMBER' AND NEW.initiated_by <> NEW.member_id)
     OR (NEW.source = 'ADMIN' AND NOT EXISTS (SELECT 1 FROM public.admin_users admin WHERE admin.id = NEW.initiated_by))
  THEN
    RAISE EXCEPTION 'after-sale initiator does not match its source' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "after_sales_actor_guard"
  BEFORE INSERT ON "after_sales"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_after_sale_actor"();

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_after_sale_item_identity"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.order_items item
    WHERE item.store_id = NEW.store_id AND item.order_id = NEW.order_id AND item.id = NEW.order_item_id
      AND item.sku_id = NEW.sku_id AND item.product_id = NEW.product_id
      AND item.brand_id = NEW.brand_id AND item.category_id = NEW.category_id
      AND item.sku_code = NEW.sku_code AND item.product_name = NEW.product_name
      AND item.option_snapshot = NEW.option_snapshot AND item.unit_price_vnd = NEW.unit_price_vnd
      AND NEW.requested_quantity <= item.quantity
  ) THEN
    RAISE EXCEPTION 'after-sale item snapshot must match the immutable order item'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "after_sale_items_identity_guard"
  BEFORE INSERT ON "after_sale_items"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_after_sale_item_identity"();

CREATE OR REPLACE FUNCTION "app_security"."enforce_m62_settlement_capacity"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE case_approved bigint;
DECLARE case_occupied bigint;
DECLARE order_payable bigint;
DECLARE order_payment_method text;
DECLARE m5_occupied bigint;
DECLARE cod_occupied bigint;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'm62-refund:' || NEW.store_id::text || ':' || NEW.order_id::text,
      0
    )
  );
  SELECT orders.payable_vnd, orders.payment_method::text
  INTO order_payable, order_payment_method
  FROM public.orders orders
  WHERE orders.store_id = NEW.store_id AND orders.id = NEW.order_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'after-sale settlement order does not exist' USING ERRCODE = '23503';
  END IF;
  SELECT sale.approved_total_vnd
  INTO case_approved
  FROM public.after_sales sale
  WHERE sale.store_id = NEW.store_id AND sale.id = NEW.after_sale_id
    AND sale.order_id = NEW.order_id
  FOR UPDATE;
  IF NOT FOUND OR NEW.amount_vnd > case_approved THEN
    RAISE EXCEPTION 'after-sale settlement exceeds approved amount' USING ERRCODE = '23514';
  END IF;
  IF (NEW.method = 'ONLINE_ORIGINAL' AND order_payment_method <> 'ONLINE')
     OR (NEW.method = 'COD_OFFLINE' AND order_payment_method <> 'COD')
  THEN
    RAISE EXCEPTION 'after-sale settlement method does not match the order payment method'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.method = 'ONLINE_ORIGINAL' AND NOT EXISTS (
    SELECT 1 FROM public.payment_attempts attempt
    WHERE attempt.store_id = NEW.store_id AND attempt.id = NEW.payment_attempt_id
      AND attempt.order_id = NEW.order_id AND attempt.status = 'SUCCEEDED'
      AND attempt.amount_vnd >= NEW.amount_vnd
  ) THEN
    RAISE EXCEPTION 'online after-sale settlement requires a successful matching payment'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(sum(amount_vnd), 0) INTO case_occupied
  FROM public.after_sale_settlements
  WHERE store_id = NEW.store_id AND after_sale_id = NEW.after_sale_id AND id <> NEW.id
    AND status IN ('PENDING','PROCESSING','SUCCEEDED','REVIEW_REQUIRED');
  IF NEW.status IN ('PENDING','PROCESSING','SUCCEEDED','REVIEW_REQUIRED') THEN
    case_occupied := case_occupied + NEW.amount_vnd;
  END IF;
  IF case_occupied > case_approved THEN
    RAISE EXCEPTION 'after-sale cumulative settlement capacity exceeded' USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(sum(amount_vnd), 0) INTO m5_occupied
  FROM public.refunds
  WHERE store_id = NEW.store_id AND order_id = NEW.order_id
    AND status IN ('REQUESTED','PROCESSING','SUCCEEDED','REVIEW_REQUIRED');
  SELECT COALESCE(sum(amount_vnd), 0) INTO cod_occupied
  FROM public.after_sale_settlements
  WHERE store_id = NEW.store_id AND order_id = NEW.order_id AND method = 'COD_OFFLINE'
    AND status IN ('PENDING','PROCESSING','SUCCEEDED','REVIEW_REQUIRED') AND id <> NEW.id;
  IF NEW.method = 'COD_OFFLINE' AND NEW.status IN ('PENDING','PROCESSING','SUCCEEDED','REVIEW_REQUIRED') THEN
    cod_occupied := cod_occupied + NEW.amount_vnd;
  END IF;
  IF m5_occupied + cod_occupied > order_payable THEN
    RAISE EXCEPTION 'order refund and COD settlement capacity exceeded' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

-- M5 refunds and M6 COD settlements reserve the same order-level capacity and
-- therefore take the same advisory/order/payment locks in that order.
CREATE OR REPLACE FUNCTION "app_security"."enforce_refund_capacity"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE captured_amount bigint;
DECLARE captured_order uuid;
DECLARE captured_status public.payment_attempt_status;
DECLARE order_payable bigint;
DECLARE order_payment_method text;
DECLARE payment_reserved bigint;
DECLARE order_refund_reserved bigint;
DECLARE cod_reserved bigint;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'm62-refund:' || NEW.store_id::text || ':' || NEW.order_id::text,
      0
    )
  );
  SELECT orders.payable_vnd, orders.payment_method::text
  INTO order_payable, order_payment_method
  FROM public.orders orders
  WHERE orders.store_id = NEW.store_id AND orders.id = NEW.order_id
  FOR UPDATE;
  SELECT attempt.amount_vnd, attempt.order_id, attempt.status
  INTO captured_amount, captured_order, captured_status
  FROM public.payment_attempts attempt
  WHERE attempt.store_id = NEW.store_id AND attempt.id = NEW.payment_attempt_id
  FOR UPDATE;
  IF NOT FOUND OR captured_order <> NEW.order_id OR captured_status <> 'SUCCEEDED'
     OR order_payment_method <> 'ONLINE'
  THEN
    RAISE EXCEPTION 'refund requires a successful matching online payment attempt'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status IN ('REQUESTED','PROCESSING','SUCCEEDED','REVIEW_REQUIRED') THEN
    SELECT COALESCE(sum(refund.amount_vnd), 0)
    INTO payment_reserved
    FROM public.refunds refund
    WHERE refund.store_id = NEW.store_id
      AND refund.payment_attempt_id = NEW.payment_attempt_id
      AND refund.id <> NEW.id
      AND refund.status IN ('REQUESTED','PROCESSING','SUCCEEDED','REVIEW_REQUIRED');
    IF payment_reserved + NEW.amount_vnd > captured_amount THEN
      RAISE EXCEPTION 'refund amount exceeds captured payment amount'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT COALESCE(sum(refund.amount_vnd), 0)
  INTO order_refund_reserved
  FROM public.refunds refund
  WHERE refund.store_id = NEW.store_id AND refund.order_id = NEW.order_id
    AND refund.id <> NEW.id
    AND refund.status IN ('REQUESTED','PROCESSING','SUCCEEDED','REVIEW_REQUIRED');
  IF NEW.status IN ('REQUESTED','PROCESSING','SUCCEEDED','REVIEW_REQUIRED') THEN
    order_refund_reserved := order_refund_reserved + NEW.amount_vnd;
  END IF;
  SELECT COALESCE(sum(settlement.amount_vnd), 0)
  INTO cod_reserved
  FROM public.after_sale_settlements settlement
  WHERE settlement.store_id = NEW.store_id AND settlement.order_id = NEW.order_id
    AND settlement.method = 'COD_OFFLINE'
    AND settlement.status IN ('PENDING','PROCESSING','SUCCEEDED','REVIEW_REQUIRED');
  IF order_refund_reserved + cod_reserved > order_payable THEN
    RAISE EXCEPTION 'order refund and COD settlement capacity exceeded'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

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

CREATE OR REPLACE FUNCTION "app_security"."sync_m62_restored_quantity"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  UPDATE public.after_sale_items
  SET restored_quantity = (
    SELECT COALESCE(sum(quantity), 0)::integer
    FROM public.after_sale_inventory_actions action
    WHERE action.store_id = NEW.store_id AND action.after_sale_item_id = NEW.after_sale_item_id
  ), updated_at = now()
  WHERE store_id = NEW.store_id AND id = NEW.after_sale_item_id;
  RETURN NULL;
END
$$;
CREATE TRIGGER "after_sale_inventory_actions_quantity_projection"
  AFTER INSERT ON "after_sale_inventory_actions"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."sync_m62_restored_quantity"();

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_restored_quantity"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE action_total integer;
BEGIN
  SELECT COALESCE(sum(quantity), 0)::integer INTO action_total
  FROM public.after_sale_inventory_actions
  WHERE store_id = NEW.store_id AND after_sale_item_id = NEW.id;
  IF NEW.restored_quantity <> action_total THEN
    RAISE EXCEPTION 'restored quantity must equal append-only inventory actions'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "after_sale_items_restored_quantity_guard"
  BEFORE UPDATE OF "restored_quantity" ON "after_sale_items"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_restored_quantity"();

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

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_return_submitter"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.submitted_by <> NEW.member_id THEN
    RAISE EXCEPTION 'after-sale return shipment submitter must be the owning member'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "after_sale_return_shipments_submitter_guard"
  BEFORE INSERT ON "after_sale_return_shipments"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_return_submitter"();

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

DROP TRIGGER "after_sale_evidence_files_lifecycle_guard" ON "after_sale_evidence_files";
CREATE TRIGGER "after_sale_evidence_files_lifecycle_guard"
  BEFORE UPDATE ON "after_sale_evidence_files"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_evidence_lifecycle"();
GRANT UPDATE ("object_key") ON "after_sale_evidence_files" TO zalo_shop_runtime;

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_privacy_request_insert"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.status <> 'SUBMITTED' OR NEW.version <> 1 THEN
    RAISE EXCEPTION 'privacy request must begin in SUBMITTED version 1'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "privacy_requests_initial_state_guard"
  BEFORE INSERT ON "privacy_requests"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_privacy_request_insert"();

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_privacy_transition"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE current_status public.privacy_request_status;
BEGIN
  SELECT status INTO current_status
  FROM public.privacy_requests
  WHERE store_id = NEW.store_id AND id = NEW.privacy_request_id AND member_id = NEW.member_id
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

CREATE OR REPLACE FUNCTION "app_security"."apply_m62_privacy_transition"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  UPDATE public.privacy_requests
  SET status = NEW.to_status, version = version + 1, updated_at = now()
  WHERE store_id = NEW.store_id AND id = NEW.privacy_request_id AND member_id = NEW.member_id;
  RETURN NULL;
END
$$;
CREATE TRIGGER "privacy_request_transitions_apply_state"
  AFTER INSERT ON "privacy_request_transitions"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."apply_m62_privacy_transition"();

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_privacy_header_update"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF (OLD.status IS DISTINCT FROM NEW.status OR OLD.version IS DISTINCT FROM NEW.version)
     AND pg_catalog.pg_trigger_depth() <= 1
  THEN
    RAISE EXCEPTION 'privacy request state changes require an append-only transition'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "privacy_requests_transition_only_guard"
  BEFORE UPDATE OF "status", "version" ON "privacy_requests"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_privacy_header_update"();

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
CREATE TRIGGER "shipments_after_sale_purpose_guard"
  BEFORE INSERT OR UPDATE OF "purpose", "after_sale_id", "order_id", "store_id"
  ON "shipments"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_shipment_purpose"();

-- Replace permissive all-command policies with command-specific policies. The
-- application still performs RBAC, while RLS prevents a member context from
-- writing internal financial, inspection, inventory or exchange facts.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'store_after_sale_settings','after_sale_policies','after_sale_policy_versions',
    'after_sale_policy_localizations','after_sale_policy_draft_products',
    'after_sale_policy_version_assignments','after_sale_active_policy_assignments'
  ] LOOP
    EXECUTE format('DROP POLICY %I ON %I', table_name || '_tenant_isolation', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT USING (store_id = app_security.current_store_id())',
      table_name || '_store_read', table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL USING (store_id = app_security.current_store_id() AND current_setting(''app.actor_type'', true) = ''admin'') WITH CHECK (store_id = app_security.current_store_id() AND current_setting(''app.actor_type'', true) = ''admin'')',
      table_name || '_admin_write', table_name
    );
  END LOOP;
END
$$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'after_sale_items','after_sale_transitions','after_sale_operations'
  ] LOOP
    EXECUTE format('DROP POLICY %I ON %I', table_name || '_actor_scope', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (store_id = app_security.current_store_id() AND (current_setting(''app.actor_type'', true) = ''admin'' OR (current_setting(''app.actor_type'', true) = ''member'' AND EXISTS (SELECT 1 FROM public.after_sales owned_case WHERE owned_case.store_id = %I.store_id AND owned_case.id = %I.after_sale_id AND owned_case.member_id = app_security.current_actor_id())))) WITH CHECK (store_id = app_security.current_store_id() AND (current_setting(''app.actor_type'', true) = ''admin'' OR (current_setting(''app.actor_type'', true) = ''member'' AND EXISTS (SELECT 1 FROM public.after_sales owned_case WHERE owned_case.store_id = %I.store_id AND owned_case.id = %I.after_sale_id AND owned_case.member_id = app_security.current_actor_id()))))',
      table_name || '_actor_scope', table_name, table_name, table_name, table_name, table_name
    );
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY[
    'after_sale_legacy_decisions','after_sale_order_allocations','after_sale_inspections',
    'after_sale_inspection_allocations','after_sale_settlements','after_sale_refunds',
    'after_sale_inventory_actions','exchange_fulfillments'
  ] LOOP
    EXECUTE format('DROP POLICY %I ON %I', table_name || '_actor_scope', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT USING (store_id = app_security.current_store_id() AND (current_setting(''app.actor_type'', true) = ''admin'' OR (current_setting(''app.actor_type'', true) = ''member'' AND EXISTS (SELECT 1 FROM public.after_sales owned_case WHERE owned_case.store_id = %I.store_id AND owned_case.id = %I.after_sale_id AND owned_case.member_id = app_security.current_actor_id()))))',
      table_name || '_actor_scope', table_name, table_name, table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL USING (store_id = app_security.current_store_id() AND current_setting(''app.actor_type'', true) = ''admin'') WITH CHECK (store_id = app_security.current_store_id() AND current_setting(''app.actor_type'', true) = ''admin'')',
      table_name || '_admin_write', table_name
    );
  END LOOP;
END
$$;

DROP POLICY "after_sale_evidence_transitions_actor_scope" ON "after_sale_evidence_transitions";
CREATE POLICY "after_sale_evidence_transitions_actor_scope" ON "after_sale_evidence_transitions"
  USING ("store_id" = app_security.current_store_id() AND current_setting('app.actor_type', true) = 'admin')
  WITH CHECK ("store_id" = app_security.current_store_id() AND current_setting('app.actor_type', true) = 'admin');

DROP POLICY "privacy_requests_member_owner" ON "privacy_requests";
DROP POLICY "privacy_request_transitions_member_owner" ON "privacy_request_transitions";
CREATE POLICY "privacy_requests_actor_scope" ON "privacy_requests"
  USING ("store_id" = app_security.current_store_id() AND (
    current_setting('app.actor_type', true) = 'admin'
    OR (current_setting('app.actor_type', true) = 'member' AND "member_id" = app_security.current_actor_id())
  ))
  WITH CHECK ("store_id" = app_security.current_store_id() AND (
    current_setting('app.actor_type', true) = 'admin'
    OR (current_setting('app.actor_type', true) = 'member' AND "member_id" = app_security.current_actor_id())
  ));
CREATE POLICY "privacy_request_transitions_actor_scope" ON "privacy_request_transitions"
  USING ("store_id" = app_security.current_store_id() AND (
    current_setting('app.actor_type', true) = 'admin'
    OR (current_setting('app.actor_type', true) = 'member' AND "member_id" = app_security.current_actor_id())
  ))
  WITH CHECK ("store_id" = app_security.current_store_id() AND (
    current_setting('app.actor_type', true) = 'admin'
    OR (current_setting('app.actor_type', true) = 'member' AND "member_id" = app_security.current_actor_id())
  ));

-- Pin every M6 guard, including guards not otherwise replaced here. Explicitly
-- listing pg_temp last prevents temporary objects from shadowing public tables.
ALTER FUNCTION "app_security"."require_m62_order_item_policy_snapshot"() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION "app_security"."require_m62_policy_version_localization"() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION "app_security"."enforce_m62_after_sale_item_capacity"() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION "app_security"."validate_m62_after_sale_refund_link"() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION "app_security"."validate_m62_return_submission"() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION "app_security"."require_m62_share_vi_localization"() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION "app_security"."reject_m62_append_only_mutation"() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION "app_security"."reject_m62_store_identity_change"() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION "app_security"."assert_m62_rollback_safe"() SET search_path TO pg_catalog, public, pg_temp;

REVOKE ALL ON FUNCTION
  "app_security"."validate_m62_policy_snapshot"(),
  "app_security"."validate_m62_after_sale_actor"(),
  "app_security"."validate_m62_after_sale_item_identity"(),
  "app_security"."sync_m62_restored_quantity"(),
  "app_security"."validate_m62_restored_quantity"(),
  "app_security"."validate_m62_return_submitter"(),
  "app_security"."validate_m62_privacy_request_insert"(),
  "app_security"."apply_m62_privacy_transition"(),
  "app_security"."validate_m62_policy_projection_final_state"(),
  "app_security"."validate_m62_privacy_header_update"(),
  "app_security"."validate_m62_shipment_purpose"()
FROM PUBLIC;
