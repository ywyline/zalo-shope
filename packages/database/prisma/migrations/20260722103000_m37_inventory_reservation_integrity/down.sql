-- LOCAL/TEST ONLY. Once any M3 business facts exist, repair forward.
SELECT "app_security"."assert_m37_inventory_integrity_rollback_safe"();

DROP TRIGGER IF EXISTS "inventory_reservation_items_append_only"
  ON "inventory_reservation_items";
DROP TRIGGER IF EXISTS "inventory_reservations_fact_guard" ON "inventory_reservations";
DROP TRIGGER IF EXISTS "inventory_reservations_terminal_facts_guard"
  ON "inventory_reservations";
DROP TRIGGER IF EXISTS "inventory_reservation_items_active_insert_guard"
  ON "inventory_reservation_items";
DROP TRIGGER IF EXISTS "inventory_movements_terminal_operation_insert_guard"
  ON "inventory_movements";
DROP TRIGGER IF EXISTS "inventory_movements_terminal_binding_guard"
  ON "inventory_movements";
DROP FUNCTION IF EXISTS "app_security"."reject_inventory_reservation_mutation"();
DROP FUNCTION IF EXISTS "app_security"."reject_terminal_reservation_fact_append"();
DROP FUNCTION IF EXISTS "app_security"."assert_terminal_operation_movement_binding"();
DROP FUNCTION IF EXISTS "app_security"."assert_inventory_reservation_terminal_facts"();
DROP FUNCTION IF EXISTS
  "app_security"."assert_inventory_reservation_terminal_facts_for"(
    uuid, uuid, inventory_reservation_status, uuid, boolean
  );
DROP FUNCTION IF EXISTS
  "app_security"."assert_inventory_reservation_definition_for"(uuid, uuid);
DROP FUNCTION IF EXISTS "app_security"."assert_m37_inventory_integrity_rollback_safe"();
DROP INDEX IF EXISTS "inventory_reservations_expiration_retry_idx";
DROP INDEX IF EXISTS "inventory_movements_operation_reservation_item_key";
DROP INDEX IF EXISTS "inventory_reservations_terminal_operation_key";
ALTER TABLE "inventory_reservations"
  DROP CONSTRAINT IF EXISTS "inventory_reservations_expiration_failure_check",
  DROP COLUMN IF EXISTS "last_expiration_error_code",
  DROP COLUMN IF EXISTS "last_expiration_failed_at",
  DROP COLUMN IF EXISTS "expiration_failure_count";
GRANT UPDATE, DELETE ON TABLE "inventory_reservation_items" TO zalo_shop_runtime;
