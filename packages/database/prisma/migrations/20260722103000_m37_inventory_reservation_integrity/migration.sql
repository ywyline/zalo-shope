-- M3.7: reservation line quantities are immutable inventory facts.
-- Terminal release/consume calculations read these rows, so changing or
-- deleting one after reservation would break the reserved-balance invariant.

ALTER TABLE "inventory_reservations"
  ADD COLUMN "expiration_failure_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "last_expiration_failed_at" TIMESTAMPTZ(6),
  ADD COLUMN "last_expiration_error_code" VARCHAR(64),
  ADD CONSTRAINT "inventory_reservations_expiration_failure_check" CHECK (
    (
      "expiration_failure_count" = 0
      AND "last_expiration_failed_at" IS NULL
      AND "last_expiration_error_code" IS NULL
    )
    OR (
      "expiration_failure_count" > 0
      AND "last_expiration_failed_at" IS NOT NULL
      AND "last_expiration_error_code" IS NOT NULL
    )
  );

CREATE INDEX "inventory_reservations_expiration_retry_idx"
  ON "inventory_reservations"(
    "store_id", "status", "last_expiration_failed_at" ASC NULLS FIRST, "expires_at", "id"
  );

CREATE OR REPLACE FUNCTION "app_security"."reject_inventory_reservation_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'inventory reservation lifecycle is immutable'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.store_id IS DISTINCT FROM OLD.store_id
     OR NEW.reservation_key IS DISTINCT FROM OLD.reservation_key
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.source_type IS DISTINCT FROM OLD.source_type
     OR NEW.source_id IS DISTINCT FROM OLD.source_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'inventory reservation facts are immutable'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'ACTIVE'
     AND (NEW.terminal_operation_id IS DISTINCT FROM OLD.terminal_operation_id
       OR NEW.terminal_at IS DISTINCT FROM OLD.terminal_at)
  THEN
    RAISE EXCEPTION 'active inventory reservation terminal fields are immutable'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.status <> 'ACTIVE'
     AND (NEW.terminal_operation_id IS NULL OR NEW.terminal_at IS NULL)
  THEN
    RAISE EXCEPTION 'terminal inventory reservation requires terminal metadata'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS "inventory_reservation_items_append_only"
  ON "inventory_reservation_items";
CREATE TRIGGER "inventory_reservation_items_append_only"
  BEFORE UPDATE OR DELETE ON "inventory_reservation_items"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_m3_fact_mutation"();

DROP TRIGGER IF EXISTS "inventory_reservations_fact_guard" ON "inventory_reservations";
CREATE TRIGGER "inventory_reservations_fact_guard"
  BEFORE UPDATE OR DELETE ON "inventory_reservations"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_inventory_reservation_mutation"();

REVOKE UPDATE, DELETE ON TABLE "inventory_reservation_items" FROM zalo_shop_runtime;
REVOKE ALL ON FUNCTION "app_security"."reject_inventory_reservation_mutation"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app_security"."reject_inventory_reservation_mutation"()
  TO zalo_shop_runtime;

CREATE UNIQUE INDEX "inventory_reservations_terminal_operation_key"
  ON "inventory_reservations"("store_id", "terminal_operation_id")
  WHERE "terminal_operation_id" IS NOT NULL;

CREATE UNIQUE INDEX "inventory_movements_operation_reservation_item_key"
  ON "inventory_movements"("store_id", "operation_id", "reservation_item_id")
  WHERE "reservation_item_id" IS NOT NULL;

CREATE OR REPLACE FUNCTION "app_security"."assert_inventory_reservation_definition_for"(
  target_store uuid,
  target_reservation uuid
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actual_count bigint;
  expected_count bigint;
  matched_count bigint;
  reserve_operation uuid;
  reserve_snapshot jsonb;
BEGIN
  SELECT operation.id, operation.result_snapshot
    INTO reserve_operation, reserve_snapshot
    FROM public.inventory_reservations AS reservation
    JOIN public.inventory_operations AS operation
      ON operation.store_id = reservation.store_id
     AND operation.operation_key = reservation.reservation_key
     AND operation.operation_type = 'RESERVE'
   WHERE reservation.store_id = target_store
     AND reservation.id = target_reservation;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'inventory reservation has no immutable reserve operation definition'
      USING ERRCODE = '23514';
  END IF;
  IF jsonb_typeof(reserve_snapshot -> 'items') IS DISTINCT FROM 'array'
     OR NOT reserve_snapshot @> jsonb_build_object(
       'operation_id', reserve_operation::text,
       'reservation_id', target_reservation::text,
       'status', 'ACTIVE'
     )
  THEN
    RAISE EXCEPTION 'inventory reservation operation definition is invalid'
      USING ERRCODE = '23514';
  END IF;

  expected_count := jsonb_array_length(reserve_snapshot -> 'items');
  IF expected_count = 0 THEN
    RAISE EXCEPTION 'inventory reservation definition requires line facts'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*)
    INTO actual_count
    FROM public.inventory_reservation_items AS item
   WHERE item.store_id = target_store
     AND item.reservation_id = target_reservation;

  SELECT count(*)
    INTO matched_count
    FROM public.inventory_reservation_items AS item
    JOIN LATERAL jsonb_array_elements(reserve_snapshot -> 'items') AS definition(value)
      ON jsonb_typeof(definition.value) = 'object'
     AND definition.value ->> 'warehouse_id' = item.warehouse_id::text
     AND definition.value ->> 'sku_id' = item.sku_id::text
     AND (definition.value ->> 'quantity') ~ '^[1-9][0-9]{0,9}$'
     AND (definition.value ->> 'quantity')::bigint = item.quantity
   WHERE item.store_id = target_store
     AND item.reservation_id = target_reservation;

  IF actual_count <> expected_count OR matched_count <> expected_count THEN
    RAISE EXCEPTION 'inventory reservation lines do not match the immutable definition'
      USING ERRCODE = '23514';
  END IF;
  RETURN expected_count;
END
$$;

CREATE OR REPLACE FUNCTION "app_security"."assert_inventory_reservation_terminal_facts_for"(
  target_store uuid,
  target_reservation uuid,
  target_status inventory_reservation_status,
  target_operation uuid,
  require_current_balance boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  expected_movement inventory_movement_type;
  expected_operation inventory_operation_type;
  expected_reason text;
  expected_item_count bigint;
  matched_count bigint;
  movement_count bigint;
  operation_snapshot jsonb;
  operation_type inventory_operation_type;
BEGIN
  SELECT
    CASE target_status
      WHEN 'RELEASED' THEN 'RELEASE'::inventory_operation_type
      WHEN 'CONSUMED' THEN 'CONSUME'::inventory_operation_type
      WHEN 'EXPIRED' THEN 'EXPIRE'::inventory_operation_type
      ELSE NULL
    END,
    CASE target_status
      WHEN 'CONSUMED' THEN 'CONSUME'::inventory_movement_type
      WHEN 'RELEASED' THEN 'RELEASE'::inventory_movement_type
      WHEN 'EXPIRED' THEN 'RELEASE'::inventory_movement_type
      ELSE NULL
    END,
    CASE target_status
      WHEN 'RELEASED' THEN 'RESERVATION_RELEASED'
      WHEN 'CONSUMED' THEN 'RESERVATION_CONSUMED'
      WHEN 'EXPIRED' THEN 'RESERVATION_EXPIRED'
      ELSE NULL
    END
  INTO expected_operation, expected_movement, expected_reason;

  IF expected_operation IS NULL OR expected_movement IS NULL THEN
    RAISE EXCEPTION 'unsupported inventory reservation terminal status %', target_status
      USING ERRCODE = '23514';
  END IF;

  expected_item_count := app_security.assert_inventory_reservation_definition_for(
    target_store,
    target_reservation
  );

  SELECT operation.operation_type, operation.result_snapshot
    INTO operation_type, operation_snapshot
    FROM public.inventory_operations AS operation
   WHERE operation.store_id = target_store AND operation.id = target_operation;
  IF NOT FOUND OR operation_type <> expected_operation THEN
    RAISE EXCEPTION 'inventory reservation terminal operation type is invalid'
      USING ERRCODE = '23514';
  END IF;
  IF NOT (
    operation_snapshot @> jsonb_build_object(
      'operation_id', target_operation::text,
      'reservation_id', target_reservation::text,
      'status', target_status::text
    )
  ) THEN
    RAISE EXCEPTION 'inventory reservation terminal operation snapshot is invalid'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*)
    INTO movement_count
    FROM public.inventory_movements
   WHERE store_id = target_store AND operation_id = target_operation;

  SELECT count(*)
    INTO matched_count
    FROM public.inventory_reservation_items AS item
    JOIN public.inventory_movements AS movement
      ON movement.store_id = item.store_id
     AND movement.reservation_item_id = item.id
     AND movement.operation_id = target_operation
    JOIN public.inventory_balances AS balance
      ON balance.store_id = movement.store_id
     AND balance.id = movement.balance_id
     AND balance.warehouse_id = item.warehouse_id
     AND balance.sku_id = item.sku_id
   WHERE item.store_id = target_store
     AND item.reservation_id = target_reservation
     AND movement.movement_type = expected_movement
     AND movement.reason_code = expected_reason
     AND movement.reserved_delta = -item.quantity
     AND (
       (target_status = 'CONSUMED' AND movement.on_hand_delta = -item.quantity)
       OR (target_status <> 'CONSUMED' AND movement.on_hand_delta = 0)
     )
     AND (
       NOT require_current_balance
       OR (
         balance.on_hand = movement.on_hand_after
         AND balance.reserved = movement.reserved_after
       )
     );

  IF movement_count <> expected_item_count OR matched_count <> expected_item_count THEN
    RAISE EXCEPTION 'inventory reservation terminal movements do not conserve line facts'
      USING ERRCODE = '23514';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION "app_security"."assert_inventory_reservation_terminal_facts"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM app_security.assert_inventory_reservation_definition_for(NEW.store_id, NEW.id);
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'inventory reservations must be created active'
        USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
  END IF;
  IF NEW.status <> 'ACTIVE' THEN
    PERFORM app_security.assert_inventory_reservation_terminal_facts_for(
      NEW.store_id,
      NEW.id,
      NEW.status,
      NEW.terminal_operation_id,
      true
    );
  END IF;
  RETURN NULL;
END
$$;

DO $m37_inventory_terminal_preflight$
DECLARE
  reservation record;
BEGIN
  FOR reservation IN
    SELECT store_id, id, status, terminal_operation_id
      FROM public.inventory_reservations
  LOOP
    PERFORM app_security.assert_inventory_reservation_definition_for(
      reservation.store_id,
      reservation.id
    );
    IF reservation.status <> 'ACTIVE' THEN
      PERFORM app_security.assert_inventory_reservation_terminal_facts_for(
        reservation.store_id,
        reservation.id,
        reservation.status,
        reservation.terminal_operation_id,
        false
      );
    END IF;
  END LOOP;
END
$m37_inventory_terminal_preflight$;

DROP TRIGGER IF EXISTS "inventory_reservations_terminal_facts_guard"
  ON "inventory_reservations";
CREATE CONSTRAINT TRIGGER "inventory_reservations_terminal_facts_guard"
  AFTER INSERT OR UPDATE ON "inventory_reservations"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION
    "app_security"."assert_inventory_reservation_terminal_facts"();

REVOKE ALL ON FUNCTION
  "app_security"."assert_inventory_reservation_definition_for"(uuid, uuid),
  "app_security"."assert_inventory_reservation_terminal_facts_for"(
    uuid, uuid, inventory_reservation_status, uuid, boolean
  ),
  "app_security"."assert_inventory_reservation_terminal_facts"()
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  "app_security"."assert_inventory_reservation_terminal_facts"()
TO zalo_shop_runtime;

CREATE OR REPLACE FUNCTION "app_security"."reject_terminal_reservation_fact_append"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  parent_status inventory_reservation_status;
  reservation_key text;
  reserve_operation uuid;
  reserve_snapshot jsonb;
BEGIN
  IF TG_TABLE_NAME = 'inventory_reservation_items' THEN
    SELECT reservation.status, reservation.reservation_key
      INTO parent_status, reservation_key
      FROM public.inventory_reservations AS reservation
     WHERE reservation.store_id = NEW.store_id
       AND reservation.id = NEW.reservation_id
     FOR SHARE;
    IF NOT FOUND OR parent_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'terminal inventory reservation cannot accept new line facts'
        USING ERRCODE = '42501';
    END IF;

    SELECT operation.id, operation.result_snapshot
      INTO reserve_operation, reserve_snapshot
      FROM public.inventory_operations AS operation
     WHERE operation.store_id = NEW.store_id
       AND operation.operation_key = reservation_key
       AND operation.operation_type = 'RESERVE';
    IF NOT FOUND
       OR jsonb_typeof(reserve_snapshot -> 'items') IS DISTINCT FROM 'array'
       OR NOT reserve_snapshot @> jsonb_build_object(
         'operation_id', reserve_operation::text,
         'reservation_id', NEW.reservation_id::text,
         'status', 'ACTIVE'
       )
       OR NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(reserve_snapshot -> 'items') AS definition(value)
          WHERE jsonb_typeof(definition.value) = 'object'
            AND definition.value ->> 'warehouse_id' = NEW.warehouse_id::text
            AND definition.value ->> 'sku_id' = NEW.sku_id::text
            AND (definition.value ->> 'quantity') ~ '^[1-9][0-9]{0,9}$'
            AND (definition.value ->> 'quantity')::bigint = NEW.quantity
       )
    THEN
      RAISE EXCEPTION 'inventory reservation line is outside its immutable definition'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'inventory_movements' THEN
    PERFORM 1
      FROM public.inventory_reservations AS reservation
     WHERE reservation.store_id = NEW.store_id
       AND reservation.terminal_operation_id = NEW.operation_id
     FOR SHARE;
    IF FOUND THEN
      RAISE EXCEPTION 'terminal inventory operation cannot accept new movement facts'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'inventory append guard attached to unsupported table %', TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$$;

DROP TRIGGER IF EXISTS "inventory_reservation_items_active_insert_guard"
  ON "inventory_reservation_items";
CREATE TRIGGER "inventory_reservation_items_active_insert_guard"
  BEFORE INSERT ON "inventory_reservation_items"
  FOR EACH ROW EXECUTE FUNCTION
    "app_security"."reject_terminal_reservation_fact_append"();

DROP TRIGGER IF EXISTS "inventory_movements_terminal_operation_insert_guard"
  ON "inventory_movements";
CREATE TRIGGER "inventory_movements_terminal_operation_insert_guard"
  BEFORE INSERT ON "inventory_movements"
  FOR EACH ROW EXECUTE FUNCTION
    "app_security"."reject_terminal_reservation_fact_append"();

REVOKE ALL ON FUNCTION
  "app_security"."reject_terminal_reservation_fact_append"()
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  "app_security"."reject_terminal_reservation_fact_append"()
TO zalo_shop_runtime;

CREATE OR REPLACE FUNCTION "app_security"."assert_terminal_operation_movement_binding"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  bound_reservation uuid;
  expected_status inventory_reservation_status;
  operation_snapshot jsonb;
  operation_type inventory_operation_type;
  reservation_text text;
BEGIN
  SELECT operation.operation_type, operation.result_snapshot
    INTO operation_type, operation_snapshot
    FROM public.inventory_operations AS operation
   WHERE operation.store_id = NEW.store_id
     AND operation.id = NEW.operation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'inventory movement operation is not visible to its transaction snapshot'
      USING ERRCODE = '23514';
  END IF;

  expected_status := CASE operation_type
    WHEN 'RELEASE' THEN 'RELEASED'::inventory_reservation_status
    WHEN 'CONSUME' THEN 'CONSUMED'::inventory_reservation_status
    WHEN 'EXPIRE' THEN 'EXPIRED'::inventory_reservation_status
    ELSE NULL
  END;
  IF expected_status IS NULL THEN
    RETURN NULL;
  END IF;

  reservation_text := operation_snapshot ->> 'reservation_id';
  IF reservation_text IS NULL THEN
    RAISE EXCEPTION 'terminal inventory operation snapshot has no reservation binding'
      USING ERRCODE = '23514';
  END IF;
  BEGIN
    bound_reservation := reservation_text::uuid;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'terminal inventory operation snapshot reservation is invalid'
        USING ERRCODE = '23514';
  END;
  IF NOT operation_snapshot @> jsonb_build_object(
    'operation_id', NEW.operation_id::text,
    'reservation_id', bound_reservation::text,
    'status', expected_status::text
  ) THEN
    RAISE EXCEPTION 'terminal inventory operation snapshot binding is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.reservation_item_id IS NULL OR NOT EXISTS (
    SELECT 1
      FROM public.inventory_reservation_items AS item
     WHERE item.store_id = NEW.store_id
       AND item.id = NEW.reservation_item_id
       AND item.reservation_id = bound_reservation
  ) THEN
    RAISE EXCEPTION 'terminal inventory operation movement belongs to another reservation'
      USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS "inventory_movements_terminal_binding_guard"
  ON "inventory_movements";
CREATE CONSTRAINT TRIGGER "inventory_movements_terminal_binding_guard"
  AFTER INSERT ON "inventory_movements"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION
    "app_security"."assert_terminal_operation_movement_binding"();

REVOKE ALL ON FUNCTION
  "app_security"."assert_terminal_operation_movement_binding"()
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  "app_security"."assert_terminal_operation_movement_binding"()
TO zalo_shop_runtime;

CREATE OR REPLACE FUNCTION "app_security"."assert_m37_inventory_integrity_rollback_safe"()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.inventory_operations)
     OR EXISTS (SELECT 1 FROM public.inventory_movements)
     OR EXISTS (SELECT 1 FROM public.inventory_reservations)
     OR EXISTS (SELECT 1 FROM public.inventory_reservation_items)
     OR EXISTS (
       SELECT 1 FROM public.inventory_balances WHERE on_hand <> 0 OR reserved <> 0
     )
     OR EXISTS (SELECT 1 FROM public.promotion_operations)
     OR EXISTS (SELECT 1 FROM public.promotion_versions WHERE status = 'PUBLISHED')
     OR EXISTS (SELECT 1 FROM public.coupons)
     OR EXISTS (SELECT 1 FROM public.member_coupons)
     OR EXISTS (SELECT 1 FROM public.carts)
  THEN
    RAISE EXCEPTION 'M3 facts exist; inventory integrity rollback is forbidden'
      USING ERRCODE = '55000';
  END IF;
END
$$;

REVOKE ALL ON FUNCTION
  "app_security"."assert_m37_inventory_integrity_rollback_safe"()
FROM PUBLIC;
