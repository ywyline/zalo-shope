-- LOCAL/TEST ONLY. Production and environments with M6 facts require forward repair.
SELECT "app_security"."assert_m62_rollback_safe"();

ALTER TABLE "shipments" DROP CONSTRAINT "shipments_after_sale_fkey";
ALTER TABLE "shipments" DROP CONSTRAINT "shipments_purpose_shape_check";
DROP INDEX "shipments_one_active_after_sale_purpose_key";
DROP INDEX "shipments_one_active_per_order_key";
CREATE UNIQUE INDEX "shipments_one_active_per_order_key"
  ON "shipments"("store_id", "order_id")
  WHERE "status" NOT IN ('DELIVERED', 'RETURNED', 'CANCELLED');
ALTER TABLE "shipments" DROP COLUMN "after_sale_id", DROP COLUMN "purpose";

DROP TABLE
  "share_interactions",
  "share_link_localizations",
  "share_links",
  "privacy_request_transitions",
  "privacy_requests",
  "member_product_views",
  "member_favorites",
  "exchange_fulfillments",
  "after_sale_return_shipments",
  "after_sale_inventory_actions",
  "after_sale_refunds",
  "after_sale_settlements",
  "after_sale_evidence_transitions",
  "after_sale_evidence_files",
  "after_sale_inspection_allocations",
  "after_sale_inspections",
  "after_sale_order_allocations",
  "after_sale_legacy_decisions",
  "after_sale_operations",
  "after_sale_transitions",
  "after_sale_items",
  "after_sales",
  "order_item_after_sale_policy_snapshots",
  "after_sale_active_policy_assignments",
  "after_sale_policy_version_assignments",
  "after_sale_policy_draft_products",
  "after_sale_policy_localizations",
  "store_after_sale_settings",
  "after_sale_policy_versions",
  "after_sale_policies";

DROP FUNCTION "app_security"."reject_m62_append_only_mutation"();
DROP FUNCTION "app_security"."reject_m62_store_identity_change"();
DROP FUNCTION "app_security"."assert_m62_rollback_safe"();

DROP INDEX "orders_store_id_id_member_id_key";
DROP INDEX "refunds_store_id_id_payment_attempt_id_order_id_amount_vnd_key";
DROP INDEX "skus_store_id_id_product_id_key";

DROP TYPE "shipment_purpose";
DROP TYPE "share_interaction_event";
DROP TYPE "share_target_type";
DROP TYPE "privacy_request_status";
DROP TYPE "privacy_request_type";
DROP TYPE "after_sale_legacy_decision_type";
DROP TYPE "exchange_fulfillment_status";
DROP TYPE "after_sale_return_shipment_status";
DROP TYPE "after_sale_inventory_action_type";
DROP TYPE "after_sale_settlement_status";
DROP TYPE "after_sale_settlement_method";
DROP TYPE "after_sale_evidence_status";
DROP TYPE "after_sale_operation_status";
DROP TYPE "after_sale_inspection_disposition";
DROP TYPE "return_shipping_payer";
DROP TYPE "after_sale_policy_target_type";
DROP TYPE "after_sale_policy_status";
DROP TYPE "after_sale_source";
DROP TYPE "after_sale_status";
DROP TYPE "after_sale_type";
