-- LOCAL/TEST ONLY. Do not run after real M3 facts exist. Production rollback is forward-fix only.
DO $m3_down_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM inventory_operations)
    OR EXISTS (SELECT 1 FROM inventory_movements)
    OR EXISTS (SELECT 1 FROM inventory_reservations)
    OR EXISTS (SELECT 1 FROM inventory_balances WHERE on_hand <> 0 OR reserved <> 0)
    OR EXISTS (SELECT 1 FROM promotion_versions WHERE status = 'PUBLISHED')
    OR EXISTS (SELECT 1 FROM member_coupons)
    OR EXISTS (SELECT 1 FROM carts)
  THEN
    RAISE EXCEPTION 'M3 facts exist; rollback is forbidden, use a forward-fix migration' USING ERRCODE = '55000';
  END IF;
END
$m3_down_guard$;

DELETE FROM "store_role_permissions" WHERE "permission_code" IN (
  'store.inventory.read', 'store.inventory.manage', 'store.inventory.adjust',
  'store.promotions.read', 'store.promotions.manage', 'store.promotions.publish'
);
DELETE FROM "permissions" WHERE "code" IN (
  'store.inventory.read', 'store.inventory.manage', 'store.inventory.adjust',
  'store.promotions.read', 'store.promotions.manage', 'store.promotions.publish'
);

DROP FUNCTION IF EXISTS "app_security"."reject_m3_fact_mutation"() CASCADE;
DROP FUNCTION IF EXISTS "app_security"."enforce_m3_state_transition"() CASCADE;
DROP FUNCTION IF EXISTS "app_security"."validate_promotion_version"() CASCADE;
DROP FUNCTION IF EXISTS "app_security"."reject_published_promotion_child_mutation"() CASCADE;
DROP FUNCTION IF EXISTS "app_security"."validate_promotion_active_version"() CASCADE;
DROP FUNCTION IF EXISTS "app_security"."validate_coupon_promotion_version"() CASCADE;

DROP TABLE IF EXISTS "cart_items" CASCADE;
DROP TABLE IF EXISTS "carts" CASCADE;
DROP TABLE IF EXISTS "member_coupons" CASCADE;
DROP TABLE IF EXISTS "coupons" CASCADE;
DROP TABLE IF EXISTS "promotion_targets" CASCADE;
DROP TABLE IF EXISTS "promotion_version_localizations" CASCADE;
ALTER TABLE IF EXISTS "promotions" DROP CONSTRAINT IF EXISTS "promotions_store_id_active_version_id_fkey";
DROP TABLE IF EXISTS "promotion_versions" CASCADE;
DROP TABLE IF EXISTS "promotions" CASCADE;
DROP TABLE IF EXISTS "search_query_stats" CASCADE;
DROP TABLE IF EXISTS "member_search_history" CASCADE;
DROP TABLE IF EXISTS "product_search_documents" CASCADE;
DROP TABLE IF EXISTS "inventory_movements" CASCADE;
DROP TABLE IF EXISTS "inventory_reservation_items" CASCADE;
DROP TABLE IF EXISTS "inventory_reservations" CASCADE;
DROP TABLE IF EXISTS "inventory_operations" CASCADE;
DROP TABLE IF EXISTS "inventory_balances" CASCADE;
DROP TABLE IF EXISTS "warehouse_localizations" CASCADE;
DROP TABLE IF EXISTS "warehouses" CASCADE;

DROP TYPE IF EXISTS "cart_status";
DROP TYPE IF EXISTS "member_coupon_status";
DROP TYPE IF EXISTS "coupon_status";
DROP TYPE IF EXISTS "promotion_target_type";
DROP TYPE IF EXISTS "promotion_benefit_method";
DROP TYPE IF EXISTS "pricing_bucket";
DROP TYPE IF EXISTS "promotion_version_status";
DROP TYPE IF EXISTS "promotion_status";
DROP TYPE IF EXISTS "inventory_reservation_status";
DROP TYPE IF EXISTS "inventory_operation_type";
DROP TYPE IF EXISTS "inventory_movement_type";

-- unaccent and pg_trgm may have predated M3 and can be shared; do not drop them.
