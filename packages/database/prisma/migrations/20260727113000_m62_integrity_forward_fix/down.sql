-- LOCAL/TEST ONLY. The complete M6 rollback sequence subsequently removes the
-- replaced guard functions with the integrity/foundation migrations.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "store_after_sale_settings" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "after_sale_policies" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "order_item_after_sale_policy_snapshots" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "after_sales" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "after_sale_evidence_files" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "after_sale_settlements" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "after_sale_inventory_actions" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "member_favorites" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "member_product_views" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "privacy_requests" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "share_links" LIMIT 1)
  THEN
    RAISE EXCEPTION 'M6.2 integrity forward-fix rollback is unsafe after business facts exist'
      USING ERRCODE = '55000';
  END IF;
END
$$;

DROP TRIGGER "after_sale_policies_projection_final_guard" ON "after_sale_policies";
DROP TRIGGER "after_sale_active_assignments_projection_final_guard" ON "after_sale_active_policy_assignments";
DROP TRIGGER "shipments_after_sale_purpose_guard" ON "shipments";
DROP TRIGGER "privacy_requests_transition_only_guard" ON "privacy_requests";
DROP TRIGGER "privacy_request_transitions_apply_state" ON "privacy_request_transitions";
DROP TRIGGER "privacy_requests_initial_state_guard" ON "privacy_requests";
DROP TRIGGER "after_sale_return_shipments_submitter_guard" ON "after_sale_return_shipments";
DROP TRIGGER "after_sale_items_restored_quantity_guard" ON "after_sale_items";
DROP TRIGGER "after_sale_inventory_actions_quantity_projection" ON "after_sale_inventory_actions";
DROP TRIGGER "after_sale_items_identity_guard" ON "after_sale_items";
DROP TRIGGER "after_sales_actor_guard" ON "after_sales";
DROP TRIGGER "order_item_after_sale_policy_snapshots_integrity_guard" ON "order_item_after_sale_policy_snapshots";

DROP TRIGGER "after_sale_evidence_files_lifecycle_guard" ON "after_sale_evidence_files";
CREATE TRIGGER "after_sale_evidence_files_lifecycle_guard"
  BEFORE UPDATE OF "status", "legal_hold_active", "retention_deadline_at", "claim_deadline_at"
  ON "after_sale_evidence_files"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_evidence_lifecycle"();
REVOKE UPDATE ("object_key") ON "after_sale_evidence_files" FROM zalo_shop_runtime;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'store_after_sale_settings','after_sale_policies','after_sale_policy_versions',
    'after_sale_policy_localizations','after_sale_policy_draft_products',
    'after_sale_policy_version_assignments','after_sale_active_policy_assignments'
  ] LOOP
    EXECUTE format('DROP POLICY %I ON %I', table_name || '_admin_write', table_name);
    EXECUTE format('DROP POLICY %I ON %I', table_name || '_store_read', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (store_id = app_security.current_store_id()) WITH CHECK (store_id = app_security.current_store_id())',
      table_name || '_tenant_isolation', table_name
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
      'CREATE POLICY %I ON %I USING (store_id = app_security.current_store_id() AND (current_setting(''app.actor_type'', true) = ''admin'' OR EXISTS (SELECT 1 FROM public.after_sales owned_case WHERE owned_case.store_id = %I.store_id AND owned_case.id = %I.after_sale_id AND owned_case.member_id = app_security.current_actor_id()))) WITH CHECK (store_id = app_security.current_store_id() AND (current_setting(''app.actor_type'', true) = ''admin'' OR EXISTS (SELECT 1 FROM public.after_sales owned_case WHERE owned_case.store_id = %I.store_id AND owned_case.id = %I.after_sale_id AND owned_case.member_id = app_security.current_actor_id())))',
      table_name || '_actor_scope', table_name, table_name, table_name, table_name, table_name
    );
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY[
    'after_sale_legacy_decisions','after_sale_order_allocations','after_sale_inspections',
    'after_sale_inspection_allocations','after_sale_settlements','after_sale_refunds',
    'after_sale_inventory_actions','exchange_fulfillments'
  ] LOOP
    EXECUTE format('DROP POLICY %I ON %I', table_name || '_admin_write', table_name);
    EXECUTE format('DROP POLICY %I ON %I', table_name || '_actor_scope', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (store_id = app_security.current_store_id() AND (current_setting(''app.actor_type'', true) = ''admin'' OR EXISTS (SELECT 1 FROM public.after_sales owned_case WHERE owned_case.store_id = %I.store_id AND owned_case.id = %I.after_sale_id AND owned_case.member_id = app_security.current_actor_id()))) WITH CHECK (store_id = app_security.current_store_id() AND (current_setting(''app.actor_type'', true) = ''admin'' OR EXISTS (SELECT 1 FROM public.after_sales owned_case WHERE owned_case.store_id = %I.store_id AND owned_case.id = %I.after_sale_id AND owned_case.member_id = app_security.current_actor_id())))',
      table_name || '_actor_scope', table_name, table_name, table_name, table_name, table_name
    );
  END LOOP;
END
$$;

DROP POLICY "after_sale_evidence_transitions_actor_scope" ON "after_sale_evidence_transitions";
CREATE POLICY "after_sale_evidence_transitions_actor_scope" ON "after_sale_evidence_transitions"
  USING ("store_id" = app_security.current_store_id() AND (
    current_setting('app.actor_type', true) = 'admin'
    OR EXISTS (
      SELECT 1 FROM public.after_sale_evidence_files evidence
      WHERE evidence.store_id = after_sale_evidence_transitions.store_id
        AND evidence.id = after_sale_evidence_transitions.evidence_file_id
        AND evidence.member_id = app_security.current_actor_id()
    )
  ))
  WITH CHECK ("store_id" = app_security.current_store_id() AND (
    current_setting('app.actor_type', true) = 'admin'
    OR EXISTS (
      SELECT 1 FROM public.after_sale_evidence_files evidence
      WHERE evidence.store_id = after_sale_evidence_transitions.store_id
        AND evidence.id = after_sale_evidence_transitions.evidence_file_id
        AND evidence.member_id = app_security.current_actor_id()
    )
  ));

DROP POLICY "privacy_requests_actor_scope" ON "privacy_requests";
DROP POLICY "privacy_request_transitions_actor_scope" ON "privacy_request_transitions";
CREATE POLICY "privacy_requests_member_owner" ON "privacy_requests"
  USING (store_id = app_security.current_store_id() AND current_setting('app.actor_type', true) = 'member' AND member_id = app_security.current_actor_id())
  WITH CHECK (store_id = app_security.current_store_id() AND current_setting('app.actor_type', true) = 'member' AND member_id = app_security.current_actor_id());
CREATE POLICY "privacy_request_transitions_member_owner" ON "privacy_request_transitions"
  USING (store_id = app_security.current_store_id() AND current_setting('app.actor_type', true) = 'member' AND member_id = app_security.current_actor_id())
  WITH CHECK (store_id = app_security.current_store_id() AND current_setting('app.actor_type', true) = 'member' AND member_id = app_security.current_actor_id());

-- Restore the M5.7 refund-only capacity function before the complete M6 down
-- sequence removes after_sale_settlements.
CREATE OR REPLACE FUNCTION "app_security"."enforce_refund_capacity"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE captured_amount bigint;
DECLARE captured_order uuid;
DECLARE captured_status "payment_attempt_status";
DECLARE reserved_amount bigint;
BEGIN
  SELECT attempt."amount_vnd", attempt."order_id", attempt."status"
    INTO captured_amount, captured_order, captured_status
  FROM "payment_attempts" AS attempt
  WHERE attempt."store_id" = NEW."store_id"
    AND attempt."id" = NEW."payment_attempt_id"
  FOR UPDATE;
  IF NOT FOUND OR captured_order <> NEW."order_id" OR captured_status <> 'SUCCEEDED' THEN
    RAISE EXCEPTION 'refund requires a successful matching payment attempt'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."status" IN ('REQUESTED', 'PROCESSING', 'SUCCEEDED', 'REVIEW_REQUIRED') THEN
    SELECT COALESCE(sum(refund."amount_vnd"), 0)
      INTO reserved_amount
    FROM "refunds" AS refund
    WHERE refund."store_id" = NEW."store_id"
      AND refund."payment_attempt_id" = NEW."payment_attempt_id"
      AND refund."id" <> NEW."id"
      AND refund."status" IN ('REQUESTED', 'PROCESSING', 'SUCCEEDED', 'REVIEW_REQUIRED');
    IF reserved_amount + NEW."amount_vnd" > captured_amount THEN
      RAISE EXCEPTION 'refund amount exceeds captured payment amount'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

ALTER FUNCTION "app_security"."require_m62_order_item_policy_snapshot"() RESET search_path;
ALTER FUNCTION "app_security"."require_m62_policy_version_localization"() RESET search_path;
ALTER FUNCTION "app_security"."enforce_m62_after_sale_item_capacity"() RESET search_path;
ALTER FUNCTION "app_security"."validate_m62_after_sale_refund_link"() RESET search_path;
ALTER FUNCTION "app_security"."validate_m62_return_submission"() RESET search_path;
ALTER FUNCTION "app_security"."require_m62_share_vi_localization"() RESET search_path;
ALTER FUNCTION "app_security"."reject_m62_append_only_mutation"() RESET search_path;
ALTER FUNCTION "app_security"."reject_m62_store_identity_change"() RESET search_path;
ALTER FUNCTION "app_security"."assert_m62_rollback_safe"() RESET search_path;

DROP FUNCTION "app_security"."apply_m62_privacy_transition"();
DROP FUNCTION "app_security"."validate_m62_privacy_header_update"();
DROP FUNCTION "app_security"."validate_m62_privacy_request_insert"();
DROP FUNCTION "app_security"."validate_m62_shipment_purpose"();
DROP FUNCTION "app_security"."validate_m62_policy_projection_final_state"();
DROP FUNCTION "app_security"."validate_m62_return_submitter"();
DROP FUNCTION "app_security"."validate_m62_restored_quantity"();
DROP FUNCTION "app_security"."sync_m62_restored_quantity"();
DROP FUNCTION "app_security"."validate_m62_after_sale_item_identity"();
DROP FUNCTION "app_security"."validate_m62_after_sale_actor"();
DROP FUNCTION "app_security"."validate_m62_policy_snapshot"();

ALTER TABLE "after_sale_return_shipments" DROP CONSTRAINT "after_sale_return_shipments_submitter_fkey";
ALTER TABLE "after_sale_settlements"
  DROP CONSTRAINT "after_sale_settlements_cod_confirmation_check",
  DROP CONSTRAINT "after_sale_settlements_confirmed_by_fkey",
  DROP CONSTRAINT "after_sale_settlements_requested_by_fkey";
ALTER TABLE "after_sale_evidence_files" DROP CONSTRAINT "after_sale_evidence_files_held_by_fkey";
ALTER TABLE "after_sale_items" DROP CONSTRAINT "after_sale_items_inspected_by_fkey";
ALTER TABLE "after_sales" DROP CONSTRAINT "after_sales_reviewed_by_fkey";
ALTER TABLE "store_after_sale_settings"
  DROP CONSTRAINT "store_after_sale_settings_updated_actor_fkey",
  DROP CONSTRAINT "store_after_sale_settings_readiness_actor_fkey";

ALTER TABLE "order_item_after_sale_policy_snapshots"
  DROP CONSTRAINT "order_item_after_sale_policy_snapshots_version_policy_fkey",
  ADD CONSTRAINT "order_item_after_sale_policy_snapshots_version_fkey"
    FOREIGN KEY ("store_id", "policy_version_id")
    REFERENCES "after_sale_policy_versions"("store_id", "id")
    ON DELETE RESTRICT;
ALTER TABLE "after_sale_policy_versions" ALTER COLUMN "allowed_types" DROP NOT NULL;
