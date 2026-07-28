-- M6.2 cross-row integrity, immutable policy resolution and snapshot enforcement.
ALTER TABLE "store_after_sale_settings" ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;
REVOKE UPDATE ("object_key") ON "after_sale_evidence_files" FROM zalo_shop_runtime;
CREATE UNIQUE INDEX "after_sale_active_policy_assignments_target_key"
  ON "after_sale_active_policy_assignments"(
    "store_id", "target_type",
    COALESCE("product_id", "category_id", '00000000-0000-0000-0000-000000000000'::uuid)
  );

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_active_policy_assignment"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE assignment_record record;
BEGIN
  SELECT policy_id, policy_version_id, target_type, product_id, category_id
  INTO assignment_record
  FROM after_sale_policy_version_assignments
  WHERE store_id = NEW.store_id AND id = NEW.assignment_id;

  IF NOT FOUND
     OR assignment_record.policy_id <> NEW.policy_id
     OR assignment_record.policy_version_id <> NEW.policy_version_id
     OR assignment_record.target_type <> NEW.target_type
     OR assignment_record.product_id IS DISTINCT FROM NEW.product_id
     OR assignment_record.category_id IS DISTINCT FROM NEW.category_id
     OR NOT EXISTS (
       SELECT 1 FROM after_sale_policies policy
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
CREATE TRIGGER "after_sale_active_policy_assignments_integrity_guard"
  BEFORE INSERT OR UPDATE ON "after_sale_active_policy_assignments"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_active_policy_assignment"();

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_policy_enforcement"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.enforce_policy_snapshots AND (
    NEW.default_policy_id IS NULL OR NEW.current_version_id IS NULL OR NEW.readiness_ready_at IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM after_sale_active_policy_assignments assignment
      JOIN after_sale_policies policy
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
CREATE TRIGGER "store_after_sale_settings_enforcement_guard"
  BEFORE INSERT OR UPDATE OF "enforce_policy_snapshots", "default_policy_id", "current_version_id", "readiness_ready_at"
  ON "store_after_sale_settings"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_policy_enforcement"();

CREATE OR REPLACE FUNCTION "app_security"."require_m62_order_item_policy_snapshot"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM store_after_sale_settings settings
    WHERE settings.store_id = NEW.store_id AND settings.enforce_policy_snapshots
  ) AND NOT EXISTS (
    SELECT 1 FROM order_item_after_sale_policy_snapshots snapshot
    WHERE snapshot.store_id = NEW.store_id AND snapshot.order_item_id = NEW.id
      AND snapshot.order_id = NEW.order_id
  ) THEN
    RAISE EXCEPTION 'enforced checkout requires an immutable after-sale policy snapshot'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER "order_items_after_sale_snapshot_required"
  AFTER INSERT ON "order_items"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "app_security"."require_m62_order_item_policy_snapshot"();

CREATE OR REPLACE FUNCTION "app_security"."require_m62_policy_version_localization"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM after_sale_policy_localizations localization
    WHERE localization.store_id = NEW.store_id
      AND localization.policy_version_id = NEW.id
      AND localization.locale = 'vi'
  ) THEN
    RAISE EXCEPTION 'published after-sale policy version requires Vietnamese localization'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER "after_sale_policy_versions_localization_required"
  AFTER INSERT ON "after_sale_policy_versions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "app_security"."require_m62_policy_version_localization"();

CREATE OR REPLACE FUNCTION "app_security"."enforce_m62_after_sale_item_capacity"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ordered_quantity integer;
DECLARE order_item_payable bigint;
DECLARE occupied_quantity bigint;
DECLARE occupied_vnd bigint;
BEGIN
  SELECT quantity, payable_vnd INTO ordered_quantity, order_item_payable
  FROM order_items
  WHERE store_id = NEW.store_id AND order_id = NEW.order_id AND id = NEW.order_item_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'after-sale item order line does not exist' USING ERRCODE = '23503';
  END IF;

  SELECT
    COALESCE(sum(CASE WHEN item.approved_quantity > 0 THEN item.approved_quantity ELSE item.requested_quantity END), 0),
    COALESCE(sum(item.approved_item_vnd), 0)
  INTO occupied_quantity, occupied_vnd
  FROM after_sale_items item
  JOIN after_sales sale ON sale.store_id = item.store_id AND sale.id = item.after_sale_id
  WHERE item.store_id = NEW.store_id AND item.order_item_id = NEW.order_item_id
    AND item.id <> NEW.id
    AND (
      sale.status NOT IN ('REJECTED','CANCELLED')
      OR EXISTS (SELECT 1 FROM after_sale_inspections inspection WHERE inspection.store_id = sale.store_id AND inspection.after_sale_id = sale.id)
      OR EXISTS (SELECT 1 FROM after_sale_settlements settlement WHERE settlement.store_id = sale.store_id AND settlement.after_sale_id = sale.id)
      OR EXISTS (SELECT 1 FROM after_sale_inventory_actions action WHERE action.store_id = sale.store_id AND action.after_sale_id = sale.id)
      OR EXISTS (SELECT 1 FROM exchange_fulfillments exchange WHERE exchange.store_id = sale.store_id AND exchange.after_sale_id = sale.id)
    );

  occupied_quantity := occupied_quantity + CASE WHEN NEW.approved_quantity > 0 THEN NEW.approved_quantity ELSE NEW.requested_quantity END;
  occupied_vnd := occupied_vnd + NEW.approved_item_vnd;
  IF occupied_quantity > ordered_quantity OR occupied_vnd > order_item_payable THEN
    RAISE EXCEPTION 'after-sale quantity or amount exceeds remaining order-item entitlement'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "after_sale_items_capacity_guard"
  BEFORE INSERT OR UPDATE OF "requested_quantity", "approved_quantity", "approved_item_vnd", "order_item_id", "order_id", "store_id"
  ON "after_sale_items"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."enforce_m62_after_sale_item_capacity"();

CREATE OR REPLACE FUNCTION "app_security"."enforce_m62_settlement_capacity"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE case_approved bigint;
DECLARE order_payable bigint;
DECLARE m5_occupied bigint;
DECLARE cod_occupied bigint;
BEGIN
  SELECT sale.approved_total_vnd, orders.payable_vnd
  INTO case_approved, order_payable
  FROM after_sales sale
  JOIN orders ON orders.store_id = sale.store_id AND orders.id = sale.order_id
  WHERE sale.store_id = NEW.store_id AND sale.id = NEW.after_sale_id AND sale.order_id = NEW.order_id
  FOR UPDATE OF sale, orders;
  IF NOT FOUND OR NEW.amount_vnd > case_approved THEN
    RAISE EXCEPTION 'after-sale settlement exceeds approved amount' USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(sum(amount_vnd), 0) INTO m5_occupied
  FROM refunds
  WHERE store_id = NEW.store_id AND order_id = NEW.order_id
    AND status IN ('REQUESTED','PROCESSING','SUCCEEDED','REVIEW_REQUIRED');
  SELECT COALESCE(sum(amount_vnd), 0) INTO cod_occupied
  FROM after_sale_settlements
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
CREATE TRIGGER "after_sale_settlements_capacity_guard"
  BEFORE INSERT OR UPDATE OF "status", "amount_vnd", "after_sale_id", "order_id", "method", "store_id"
  ON "after_sale_settlements"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."enforce_m62_settlement_capacity"();

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_after_sale_refund_link"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM after_sale_settlements settlement
    JOIN refunds refund
      ON refund.store_id = settlement.store_id
     AND refund.id = NEW.refund_id
     AND refund.payment_attempt_id = settlement.payment_attempt_id
     AND refund.order_id = settlement.order_id
     AND refund.amount_vnd = settlement.amount_vnd
    WHERE settlement.store_id = NEW.store_id AND settlement.id = NEW.settlement_id
      AND settlement.after_sale_id = NEW.after_sale_id AND settlement.order_id = NEW.order_id
      AND settlement.method = 'ONLINE_ORIGINAL' AND settlement.amount_vnd = NEW.amount_vnd
  ) THEN
    RAISE EXCEPTION 'after-sale refund link must match one M5 refund and online settlement exactly'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "after_sale_refunds_link_guard"
  BEFORE INSERT ON "after_sale_refunds"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_after_sale_refund_link"();

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_inventory_action"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE action_total bigint;
DECLARE restockable integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM inventory_operations operation
    WHERE operation.store_id = NEW.store_id AND operation.id = NEW.inventory_operation_id
      AND operation.operation_type = 'RESTORE'
      AND operation.source_type = 'AFTER_SALE_RESTORE'
      AND operation.source_id = NEW.after_sale_item_id
  ) THEN
    RAISE EXCEPTION 'after-sale inventory action requires its matching RESTORE operation'
      USING ERRCODE = '23514';
  END IF;
  SELECT restockable_quantity INTO restockable
  FROM after_sale_items
  WHERE store_id = NEW.store_id AND id = NEW.after_sale_item_id
  FOR UPDATE;
  SELECT COALESCE(sum(quantity), 0) INTO action_total
  FROM after_sale_inventory_actions
  WHERE store_id = NEW.store_id AND after_sale_item_id = NEW.after_sale_item_id AND id <> NEW.id;
  IF action_total + NEW.quantity > restockable THEN
    RAISE EXCEPTION 'after-sale inventory restore exceeds restockable quantity'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "after_sale_inventory_actions_integrity_guard"
  BEFORE INSERT ON "after_sale_inventory_actions"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_inventory_action"();

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_exchange_fulfillment"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.reservation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM inventory_reservations reservation
    WHERE reservation.store_id = NEW.store_id AND reservation.id = NEW.reservation_id
      AND reservation.source_type = 'AFTER_SALE_EXCHANGE'
      AND reservation.source_id = NEW.after_sale_id
  ) THEN
    RAISE EXCEPTION 'exchange reservation source is invalid' USING ERRCODE = '23514';
  END IF;
  IF NEW.outbound_shipment_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM shipments shipment
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

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_return_submission"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE case_record record;
BEGIN
  SELECT status, return_deadline_at INTO case_record
  FROM after_sales
  WHERE store_id = NEW.store_id AND id = NEW.after_sale_id AND member_id = NEW.member_id
  FOR UPDATE;
  IF NOT FOUND OR case_record.status NOT IN ('APPROVED','RETURN_PENDING')
     OR case_record.return_deadline_at IS NULL OR clock_timestamp() >= case_record.return_deadline_at
  THEN
    RAISE EXCEPTION 'after-sale return window is closed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "after_sale_return_shipments_deadline_guard"
  BEFORE INSERT ON "after_sale_return_shipments"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_return_submission"();

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_evidence_lifecycle"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.legal_hold_active AND NEW.status IN ('DELETION_PENDING','DELETED') THEN
    RAISE EXCEPTION 'legal hold prevents evidence deletion' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'DELETION_PENDING' THEN
    IF NEW.legal_hold_active OR COALESCE(NEW.retention_deadline_at, NEW.claim_deadline_at) IS NULL
       OR clock_timestamp() < COALESCE(NEW.retention_deadline_at, NEW.claim_deadline_at) THEN
      RAISE EXCEPTION 'evidence retention deadline is still active' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.status = 'DELETED' AND (NEW.legal_hold_active OR OLD.status <> 'DELETION_PENDING') THEN
    RAISE EXCEPTION 'evidence deletion completion is invalid' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'DELETED' THEN
    RAISE EXCEPTION 'deleted evidence metadata is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "after_sale_evidence_files_lifecycle_guard"
  BEFORE UPDATE OF "status", "legal_hold_active", "retention_deadline_at", "claim_deadline_at"
  ON "after_sale_evidence_files"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_evidence_lifecycle"();

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_privacy_transition"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (
    (NEW.from_status = 'SUBMITTED' AND NEW.to_status IN ('UNDER_REVIEW','ACTION_REQUIRED','CANCELLED'))
    OR (NEW.from_status = 'UNDER_REVIEW' AND NEW.to_status IN ('ACTION_REQUIRED','IN_PROGRESS','REJECTED'))
    OR (NEW.from_status = 'ACTION_REQUIRED' AND NEW.to_status IN ('SUBMITTED','CANCELLED'))
    OR (NEW.from_status = 'IN_PROGRESS' AND NEW.to_status IN ('COMPLETED','REJECTED'))
  ) THEN
    RAISE EXCEPTION 'invalid privacy request transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "privacy_request_transitions_state_guard"
  BEFORE INSERT ON "privacy_request_transitions"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_privacy_transition"();

CREATE OR REPLACE FUNCTION "app_security"."require_m62_share_vi_localization"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM share_link_localizations localization
    WHERE localization.store_id = NEW.store_id AND localization.share_link_id = NEW.id AND localization.locale = 'vi'
  ) THEN
    RAISE EXCEPTION 'share link requires Vietnamese localization' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER "share_links_vi_localization_required"
  AFTER INSERT ON "share_links"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "app_security"."require_m62_share_vi_localization"();

CREATE OR REPLACE FUNCTION "app_security"."resolve_m62_share_link"(lookup_short_code text)
RETURNS TABLE(store_id uuid, share_link_id uuid, target_type share_target_type, locale "Locale")
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT link.store_id, link.id, link.target_type, link.locale
  FROM public.share_links link
  WHERE link.short_code = lookup_short_code
    AND (link.expires_at IS NULL OR link.expires_at > clock_timestamp())
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION
  "app_security"."validate_m62_active_policy_assignment"(),
  "app_security"."validate_m62_policy_enforcement"(),
  "app_security"."require_m62_order_item_policy_snapshot"(),
  "app_security"."require_m62_policy_version_localization"(),
  "app_security"."enforce_m62_after_sale_item_capacity"(),
  "app_security"."enforce_m62_settlement_capacity"(),
  "app_security"."validate_m62_after_sale_refund_link"(),
  "app_security"."validate_m62_inventory_action"(),
  "app_security"."validate_m62_exchange_fulfillment"(),
  "app_security"."validate_m62_return_submission"(),
  "app_security"."validate_m62_evidence_lifecycle"(),
  "app_security"."validate_m62_privacy_transition"(),
  "app_security"."require_m62_share_vi_localization"()
FROM PUBLIC;
REVOKE ALL ON FUNCTION "app_security"."resolve_m62_share_link"(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app_security"."resolve_m62_share_link"(text) TO zalo_shop_runtime;
