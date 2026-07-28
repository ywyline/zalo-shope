-- LOCAL/TEST ONLY. Production and environments with M6 facts require forward repair.
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
    RAISE EXCEPTION 'M6.2 integrity rollback is unsafe after business facts exist'
      USING ERRCODE = '55000';
  END IF;
END
$$;

DROP TRIGGER "share_links_vi_localization_required" ON "share_links";
DROP TRIGGER "privacy_request_transitions_state_guard" ON "privacy_request_transitions";
DROP TRIGGER "after_sale_evidence_files_lifecycle_guard" ON "after_sale_evidence_files";
DROP TRIGGER "after_sale_return_shipments_deadline_guard" ON "after_sale_return_shipments";
DROP TRIGGER "exchange_fulfillments_integrity_guard" ON "exchange_fulfillments";
DROP TRIGGER "after_sale_inventory_actions_integrity_guard" ON "after_sale_inventory_actions";
DROP TRIGGER "after_sale_refunds_link_guard" ON "after_sale_refunds";
DROP TRIGGER "after_sale_settlements_capacity_guard" ON "after_sale_settlements";
DROP TRIGGER "after_sale_items_capacity_guard" ON "after_sale_items";
DROP TRIGGER "after_sale_policy_versions_localization_required" ON "after_sale_policy_versions";
DROP TRIGGER "order_items_after_sale_snapshot_required" ON "order_items";
DROP TRIGGER "store_after_sale_settings_enforcement_guard" ON "store_after_sale_settings";
DROP TRIGGER "after_sale_active_policy_assignments_integrity_guard" ON "after_sale_active_policy_assignments";

DROP FUNCTION "app_security"."resolve_m62_share_link"(text);
DROP FUNCTION "app_security"."require_m62_share_vi_localization"();
DROP FUNCTION "app_security"."validate_m62_privacy_transition"();
DROP FUNCTION "app_security"."validate_m62_evidence_lifecycle"();
DROP FUNCTION "app_security"."validate_m62_return_submission"();
DROP FUNCTION "app_security"."validate_m62_exchange_fulfillment"();
DROP FUNCTION "app_security"."validate_m62_inventory_action"();
DROP FUNCTION "app_security"."validate_m62_after_sale_refund_link"();
DROP FUNCTION "app_security"."enforce_m62_settlement_capacity"();
DROP FUNCTION "app_security"."enforce_m62_after_sale_item_capacity"();
DROP FUNCTION "app_security"."require_m62_policy_version_localization"();
DROP FUNCTION "app_security"."require_m62_order_item_policy_snapshot"();
DROP FUNCTION "app_security"."validate_m62_policy_enforcement"();
DROP FUNCTION "app_security"."validate_m62_active_policy_assignment"();

DROP INDEX "after_sale_active_policy_assignments_target_key";
GRANT UPDATE ("object_key") ON "after_sale_evidence_files" TO zalo_shop_runtime;
ALTER TABLE "store_after_sale_settings" ALTER COLUMN "updated_at" DROP DEFAULT;
