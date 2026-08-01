-- P0-M6-008 Slice A: complete return inspection and exactly-once sellable restoration.
-- Production enablement, exchange outbound fulfillment and external providers remain out of scope.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.after_sale_inspections)
     OR EXISTS (SELECT 1 FROM public.after_sale_inventory_actions)
     OR EXISTS (
       SELECT 1 FROM public.after_sale_transitions
       WHERE event IN ('ACCEPT_INSPECTION','REJECT_INSPECTION')
     )
     OR EXISTS (
       SELECT 1 FROM public.after_sale_operations
       WHERE operation = 'ADMIN_INSPECT_RETURN'
     )
     OR EXISTS (
       SELECT 1 FROM public.audit_logs
       WHERE action = 'after-sale.return.inspected'
     )
  THEN
    RAISE EXCEPTION 'P0-M6-008 cannot preserve pre-command inspection or restoration facts'
      USING ERRCODE = '55000';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION "app_security"."assert_p0_m6_008_admin_authorization"(
  p_requires_inventory boolean
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE authorization_found boolean;
DECLARE required_count integer := CASE WHEN p_requires_inventory THEN 2 ELSE 1 END;
BEGIN
  IF p_requires_inventory IS NULL
     OR pg_catalog.current_setting('app.actor_type', true) IS DISTINCT FROM 'admin'
     OR pg_catalog.current_setting('app.admin_authorization_scope', true) IS DISTINCT FROM 'STORE'
  THEN
    RAISE EXCEPTION 'return inspection authorization is invalid' USING ERRCODE = '42501';
  END IF;

  WITH locked_authorization AS MATERIALIZED (
    SELECT role_permission.permission_code
    FROM public.stores store
    JOIN public.admin_users admin ON admin.id = app_security.current_actor_id()
    JOIN public.admin_sessions session
      ON session.id = NULLIF(pg_catalog.current_setting('app.access_session_id', true), '')::uuid
      AND session.admin_user_id = admin.id
    JOIN public.admin_store_roles assignment
      ON assignment.store_id = store.id AND assignment.admin_user_id = admin.id
    JOIN public.store_role_permissions role_permission
      ON role_permission.store_id = assignment.store_id
      AND role_permission.role_id = assignment.role_id
    WHERE store.id = app_security.current_store_id()
      AND store.status = 'ACTIVE'
      AND admin.status = 'ACTIVE'
      AND session.revoked_at IS NULL
      AND session.expires_at > pg_catalog.clock_timestamp()
      AND session.mfa_verified_at >= pg_catalog.clock_timestamp() - INTERVAL '10 minutes'
      AND NULLIF(pg_catalog.current_setting('app.access_token_expires_at', true), '')::timestamptz
        > pg_catalog.clock_timestamp()
      AND role_permission.permission_code IN (
        'store.after-sales.inspect',
        'store.inventory.adjust'
      )
      AND (p_requires_inventory OR role_permission.permission_code = 'store.after-sales.inspect')
    ORDER BY assignment.role_id, role_permission.permission_code
    FOR SHARE OF store, admin, session, assignment, role_permission
  )
  SELECT pg_catalog.count(DISTINCT permission_code) = required_count
  INTO authorization_found
  FROM locked_authorization;

  IF authorization_found IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'return inspection authorization is no longer valid'
      USING ERRCODE = '42501';
  END IF;
END
$$;

-- Extend the latest B5 operation link with one exact M6.4 command/event pair.
CREATE OR REPLACE FUNCTION "app_security"."validate_m63_b3_operation_link"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE operation_record record;
DECLARE expected_operation text;
BEGIN
  expected_operation := CASE
    WHEN NEW.event = 'SUBMIT' AND NEW.actor_type = 'MEMBER' THEN 'MEMBER_CREATE'
    WHEN NEW.event = 'SUBMIT' AND NEW.actor_type = 'ADMIN' THEN 'MERCHANT_REFUND_CREATE'
    WHEN NEW.event = 'CANCEL' AND NEW.actor_type = 'MEMBER' THEN 'MEMBER_CANCEL'
    WHEN NEW.event IN ('APPROVE','REJECT') AND NEW.actor_type = 'ADMIN' THEN 'ADMIN_REVIEW'
    WHEN NEW.event IN ('RESUME_REVIEW','REJECT_REVIEW','LEGACY_APPROVE','LEGACY_REJECT')
      AND NEW.actor_type = 'ADMIN' THEN 'ADMIN_RESOLVE_REVIEW'
    WHEN NEW.event = 'START_RETURN' AND NEW.actor_type = 'MEMBER' THEN 'MEMBER_SUBMIT_RETURN'
    WHEN NEW.event IN ('RETURN_SHIPPED','RETURN_RECEIVED') AND NEW.actor_type = 'ADMIN'
      THEN 'ADMIN_RECORD_RETURN_FACT'
    WHEN NEW.event IN ('ACCEPT_INSPECTION','REJECT_INSPECTION') AND NEW.actor_type = 'ADMIN'
      THEN 'ADMIN_INSPECT_RETURN'
    ELSE NULL
  END;
  IF expected_operation IS NULL THEN
    IF NEW.operation_id IS NOT NULL THEN
      RAISE EXCEPTION 'operation links are reserved for approved command events'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.operation_id IS NULL THEN
    RAISE EXCEPTION 'after-sale command transition requires an operation link'
      USING ERRCODE = '42501';
  END IF;
  SELECT operation, status INTO operation_record
  FROM public.after_sale_operations operation_row
  WHERE operation_row.store_id = NEW.store_id
    AND operation_row.id = NEW.operation_id
    AND operation_row.after_sale_id = NEW.after_sale_id
  FOR UPDATE;
  IF NOT FOUND OR operation_record.status <> 'PENDING'
     OR operation_record.operation IS DISTINCT FROM expected_operation
  THEN
    RAISE EXCEPTION 'transition operation link is outside the approved command contract'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION "app_security"."validate_p0_m6_008_operation_completion"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.operation <> 'ADMIN_INSPECT_RETURN' THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF SESSION_USER <> 'zalo_shop_runtime' OR NEW.status <> 'PENDING'
       OR NEW.result_summary IS NOT NULL OR NEW.error_code IS NOT NULL
       OR NEW.attempt_count <> 0 OR NEW.version <> 1
    THEN
      RAISE EXCEPTION 'inspection operation must begin pending in the runtime command'
        USING ERRCODE = '42501';
    END IF;
  ELSIF OLD.status <> 'PENDING' OR NEW.status <> 'COMPLETED'
     OR NEW.error_code IS NOT NULL OR NEW.result_summary IS NULL
     OR NEW.attempt_count <> 1 OR NEW.version <> OLD.version + 1
     OR NEW.store_id IS DISTINCT FROM OLD.store_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.after_sale_id IS DISTINCT FROM OLD.after_sale_id
     OR NEW.operation IS DISTINCT FROM OLD.operation
     OR NEW.idempotency_key_hash IS DISTINCT FROM OLD.idempotency_key_hash
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'inspection operation must complete once with an immutable result'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "after_sale_operations_p0_m6_008_completion_guard"
  BEFORE INSERT OR UPDATE ON "after_sale_operations"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_p0_m6_008_operation_completion"();

CREATE OR REPLACE FUNCTION "app_security"."validate_p0_m6_008_command_atomicity"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE operation_record record;
DECLARE sale record;
DECLARE inspection_count integer;
DECLARE transition_count integer;
DECLARE audit_count integer;
DECLARE restored_items jsonb;
DECLARE requires_inventory boolean;
BEGIN
  IF TG_TABLE_NAME = 'after_sale_operations' THEN
    IF NEW.operation <> 'ADMIN_INSPECT_RETURN' THEN RETURN NULL; END IF;
    SELECT * INTO operation_record FROM public.after_sale_operations operation_row
    WHERE operation_row.store_id = NEW.store_id AND operation_row.id = NEW.id;
  ELSE
    IF NEW.operation_id IS NULL THEN RETURN NULL; END IF;
    SELECT * INTO operation_record FROM public.after_sale_operations operation_row
    WHERE operation_row.store_id = NEW.store_id
      AND operation_row.id = NEW.operation_id
      AND operation_row.after_sale_id = NEW.after_sale_id;
    IF NOT FOUND OR operation_record.operation <> 'ADMIN_INSPECT_RETURN' THEN RETURN NULL; END IF;
  END IF;

  SELECT * INTO sale FROM public.after_sales current_sale
  WHERE current_sale.store_id = operation_record.store_id
    AND current_sale.id = operation_record.after_sale_id;
  SELECT pg_catalog.count(*)::integer INTO inspection_count
  FROM public.after_sale_inspections inspection
  WHERE inspection.store_id = operation_record.store_id
    AND inspection.after_sale_id = operation_record.after_sale_id
    AND inspection.inspection_version =
      (operation_record.result_summary->>'inspection_version')::integer;
  SELECT pg_catalog.count(*)::integer INTO transition_count
  FROM public.after_sale_transitions transition
  WHERE transition.store_id = operation_record.store_id
    AND transition.after_sale_id = operation_record.after_sale_id
    AND transition.operation_id = operation_record.id
    AND transition.event IN ('ACCEPT_INSPECTION','REJECT_INSPECTION');
  SELECT pg_catalog.count(*)::integer INTO audit_count
  FROM public.audit_logs audit
  WHERE audit.store_id = operation_record.store_id
    AND audit.target_type = 'after_sale'
    AND audit.target_id = operation_record.after_sale_id::text
    AND audit.action = 'after-sale.return.inspected'
    AND audit.after_data->>'operation_id' = operation_record.id::text;
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'order_item_id', item.order_item_id,
      'quantity', action.quantity
    ) ORDER BY item.order_item_id), '[]'::jsonb)
  INTO restored_items
  FROM public.after_sale_inventory_actions action
  JOIN public.after_sale_items item
    ON item.store_id = action.store_id AND item.id = action.after_sale_item_id
  WHERE action.store_id = operation_record.store_id
    AND action.after_sale_id = operation_record.after_sale_id
    AND action.inspection_version =
      (operation_record.result_summary->>'inspection_version')::integer;
  requires_inventory := pg_catalog.jsonb_array_length(restored_items) > 0;

  IF operation_record.status <> 'COMPLETED'
     OR pg_catalog.jsonb_typeof(operation_record.result_summary) <> 'object'
     OR sale.id IS NULL OR inspection_count <> 1 OR transition_count <> 1 OR audit_count <> 1
     OR operation_record.result_summary->>'after_sale_id' <> sale.id::text
     OR operation_record.result_summary->>'operation_id' <> operation_record.id::text
     OR operation_record.result_summary->>'public_case_number' <> sale.public_case_number
     OR operation_record.result_summary->>'status' <> sale.status::text
     OR operation_record.result_summary->>'version' <> sale.version::text
     OR operation_record.result_summary->'restored_items' IS DISTINCT FROM restored_items
     OR EXISTS (
       SELECT 1 FROM public.after_sale_items item
       WHERE item.store_id = operation_record.store_id
         AND item.after_sale_id = operation_record.after_sale_id
         AND item.restockable_quantity > 0
         AND NOT EXISTS (
           SELECT 1 FROM public.after_sale_inventory_actions action
           WHERE action.store_id = item.store_id
             AND action.after_sale_item_id = item.id
             AND action.inspection_version = item.inspection_version
             AND action.quantity = item.restockable_quantity
             AND action.disposition = 'RESTOCK_SELLABLE'
             AND action.action_type = 'RESTOCK_SELLABLE'
         )
     )
  THEN
    RAISE EXCEPTION 'inspection, restoration, transition, operation and audit must commit atomically'
      USING ERRCODE = '23514';
  END IF;
  PERFORM app_security.assert_p0_m6_008_admin_authorization(requires_inventory);
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "after_sale_operations_p0_m6_008_atomic_guard"
  AFTER INSERT OR UPDATE ON "after_sale_operations"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_p0_m6_008_command_atomicity"();
CREATE CONSTRAINT TRIGGER "after_sale_transitions_p0_m6_008_atomic_guard"
  AFTER INSERT ON "after_sale_transitions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_p0_m6_008_command_atomicity"();

CREATE OR REPLACE FUNCTION "app_security"."inspect_p0_m6_008_after_sale_return"(
  p_after_sale_id uuid,
  p_operation_id uuid,
  p_idempotency_key_hash text,
  p_request_hash text,
  p_expected_version integer,
  p_expected_inspection_version integer,
  p_items jsonb,
  p_reason text,
  p_source_ip inet DEFAULT NULL
)
RETURNS TABLE (
  after_sale_id uuid,
  operation_id uuid,
  public_case_number varchar,
  status public.after_sale_status,
  version integer,
  inspection_version integer,
  restored_items jsonb,
  replayed boolean
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE actor_id uuid := app_security.current_actor_id();
DECLARE scoped_store_id uuid := app_security.current_store_id();
DECLARE correlation_id text := NULLIF(pg_catalog.current_setting('app.correlation_id', true), '');
DECLARE sale record;
DECLARE existing record;
DECLARE item_json jsonb;
DECLARE allocation_json jsonb;
DECLARE inspection_id uuid := pg_catalog.gen_random_uuid();
DECLARE next_inspection_version integer;
DECLARE latest_inspection_version integer;
DECLARE invalid_coverage boolean;
DECLARE requires_inventory boolean;
DECLARE action_item record;
DECLARE original_reservation_id uuid;
DECLARE warehouse_count integer;
DECLARE original_warehouse_id uuid;
DECLARE consumed_quantity integer;
DECLARE balance record;
DECLARE inventory_operation_id uuid;
DECLARE inventory_movement_id uuid;
DECLARE result_restored_items jsonb;
DECLARE target_status public.after_sale_status;
DECLARE target_event text;
BEGIN
  IF pg_catalog.current_setting('app.actor_type', true) IS DISTINCT FROM 'admin'
     OR actor_id IS NULL OR scoped_store_id IS NULL OR correlation_id IS NULL
     OR p_after_sale_id IS NULL OR p_operation_id IS NULL
     OR p_expected_version IS NULL OR p_expected_version < 1
     OR p_expected_inspection_version IS NULL OR p_expected_inspection_version < 0
     OR p_idempotency_key_hash IS NULL OR p_idempotency_key_hash !~ '^[0-9a-f]{64}$'
     OR p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$'
     OR p_reason IS NULL OR char_length(pg_catalog.btrim(p_reason)) NOT BETWEEN 10 AND 500
     OR p_items IS NULL OR pg_catalog.jsonb_typeof(p_items) <> 'array'
     OR pg_catalog.jsonb_array_length(p_items) NOT BETWEEN 1 AND 20
  THEN
    RAISE EXCEPTION 'return inspection requires a complete command context'
      USING ERRCODE = '42501';
  END IF;

  FOR item_json IN SELECT value FROM pg_catalog.jsonb_array_elements(p_items)
  LOOP
    IF pg_catalog.jsonb_typeof(item_json) <> 'object'
       OR item_json - ARRAY['order_item_id','dispositions'] <> '{}'::jsonb
       OR item_json->>'order_item_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       OR pg_catalog.jsonb_typeof(item_json->'dispositions') <> 'array'
       OR pg_catalog.jsonb_array_length(item_json->'dispositions') NOT BETWEEN 1 AND 4
    THEN
      RAISE EXCEPTION 'return inspection item shape is invalid' USING ERRCODE = '23514';
    END IF;
    FOR allocation_json IN
      SELECT value FROM pg_catalog.jsonb_array_elements(item_json->'dispositions')
    LOOP
      IF pg_catalog.jsonb_typeof(allocation_json) <> 'object'
         OR allocation_json - ARRAY['disposition','quantity'] <> '{}'::jsonb
         OR allocation_json->>'disposition' NOT IN (
           'RESTOCK_SELLABLE','QUARANTINE','SCRAP','RETURN_TO_MEMBER'
         )
         OR pg_catalog.jsonb_typeof(allocation_json->'quantity') <> 'number'
         OR allocation_json->>'quantity' !~ '^[1-9][0-9]{0,3}$'
         OR (allocation_json->>'quantity')::integer > 1000
      THEN
        RAISE EXCEPTION 'return inspection allocation shape is invalid' USING ERRCODE = '23514';
      END IF;
    END LOOP;
    IF (
      SELECT pg_catalog.count(*) <> pg_catalog.count(DISTINCT allocation->>'disposition')
      FROM pg_catalog.jsonb_array_elements(item_json->'dispositions') allocation
    ) THEN
      RAISE EXCEPTION 'return inspection dispositions must be unique' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  IF (
    SELECT pg_catalog.count(*) <> pg_catalog.count(DISTINCT item->>'order_item_id')
    FROM pg_catalog.jsonb_array_elements(p_items) item
  ) THEN
    RAISE EXCEPTION 'return inspection order items must be unique' USING ERRCODE = '23514';
  END IF;

  requires_inventory := EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_items) item
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(item->'dispositions') allocation
    WHERE allocation->>'disposition' = 'RESTOCK_SELLABLE'
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'p0-m6-008:' || scoped_store_id::text || ':ADMIN_INSPECT_RETURN:' ||
      p_idempotency_key_hash, 0));
  PERFORM app_security.assert_p0_m6_008_admin_authorization(requires_inventory);

  SELECT operation_row.* INTO existing
  FROM public.after_sale_operations operation_row
  WHERE operation_row.store_id = scoped_store_id
    AND operation_row.operation = 'ADMIN_INSPECT_RETURN'
    AND operation_row.idempotency_key_hash = p_idempotency_key_hash
  FOR UPDATE;
  IF FOUND THEN
    IF existing.after_sale_id IS DISTINCT FROM p_after_sale_id
       OR existing.request_hash IS DISTINCT FROM p_request_hash
       OR existing.status <> 'COMPLETED'
       OR pg_catalog.jsonb_typeof(existing.result_summary) <> 'object'
       OR existing.result_summary->>'after_sale_id' <> p_after_sale_id::text
       OR existing.result_summary->>'operation_id' <> existing.id::text
       OR existing.result_summary->>'status' NOT IN ('REFUND_PENDING','EXCHANGE_PENDING','REJECTED')
       OR existing.result_summary->>'version' !~ '^[1-9][0-9]{0,8}$'
       OR existing.result_summary->>'inspection_version' !~ '^[1-9][0-9]{0,8}$'
       OR pg_catalog.jsonb_typeof(existing.result_summary->'restored_items') <> 'array'
    THEN
      RAISE EXCEPTION 'return inspection idempotency replay is invalid' USING ERRCODE = '23505';
    END IF;
    PERFORM app_security.assert_p0_m6_008_admin_authorization(
      pg_catalog.jsonb_array_length(existing.result_summary->'restored_items') > 0
    );
    RETURN QUERY SELECT existing.after_sale_id, existing.id,
      (existing.result_summary->>'public_case_number')::varchar,
      (existing.result_summary->>'status')::public.after_sale_status,
      (existing.result_summary->>'version')::integer,
      (existing.result_summary->>'inspection_version')::integer,
      existing.result_summary->'restored_items', true;
    RETURN;
  END IF;

  SELECT current_sale.* INTO sale
  FROM public.after_sales current_sale
  WHERE current_sale.store_id = scoped_store_id AND current_sale.id = p_after_sale_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return inspection target was not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT COALESCE(pg_catalog.max(inspection.inspection_version), 0)
  INTO latest_inspection_version
  FROM public.after_sale_inspections inspection
  WHERE inspection.store_id = scoped_store_id AND inspection.after_sale_id = sale.id;
  IF sale.status <> 'INSPECTION_PENDING'
     OR sale.type NOT IN ('RETURN_REFUND','EXCHANGE')
     OR sale.version <> p_expected_version
     OR latest_inspection_version <> p_expected_inspection_version
     OR EXISTS (
       SELECT 1 FROM public.after_sale_items item
       WHERE item.store_id = scoped_store_id AND item.after_sale_id = sale.id
         AND item.approved_quantity > 0
         AND item.inspection_version <> p_expected_inspection_version
     )
  THEN
    RAISE EXCEPTION 'return inspection state or expected version does not match'
      USING ERRCODE = '40001';
  END IF;

  WITH requested AS (
    SELECT (item->>'order_item_id')::uuid AS order_item_id,
      pg_catalog.sum((allocation->>'quantity')::integer)::integer AS quantity
    FROM pg_catalog.jsonb_array_elements(p_items) item
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(item->'dispositions') allocation
    GROUP BY (item->>'order_item_id')::uuid
  )
  SELECT EXISTS (
    SELECT 1 FROM public.after_sale_items item
    LEFT JOIN requested ON requested.order_item_id = item.order_item_id
    WHERE item.store_id = scoped_store_id AND item.after_sale_id = sale.id
      AND item.approved_quantity > 0
      AND (requested.order_item_id IS NULL OR requested.quantity <> item.approved_quantity)
  ) OR EXISTS (
    SELECT 1 FROM requested
    LEFT JOIN public.after_sale_items item
      ON item.store_id = scoped_store_id AND item.after_sale_id = sale.id
      AND item.order_item_id = requested.order_item_id
    WHERE item.id IS NULL OR item.approved_quantity <= 0
      OR requested.quantity <> item.approved_quantity
  )
  INTO invalid_coverage;
  IF invalid_coverage THEN
    RAISE EXCEPTION 'return inspection must exactly cover every approved item'
      USING ERRCODE = '23514';
  END IF;

  -- The last authorization check precedes the first business fact. The share locks
  -- taken by the authorization function keep revocation from racing the commit.
  PERFORM app_security.assert_p0_m6_008_admin_authorization(requires_inventory);
  next_inspection_version := p_expected_inspection_version + 1;
  INSERT INTO public.after_sale_operations
    (id, store_id, after_sale_id, operation, idempotency_key_hash, request_hash, updated_at)
  VALUES (p_operation_id, scoped_store_id, sale.id, 'ADMIN_INSPECT_RETURN',
    p_idempotency_key_hash, p_request_hash, pg_catalog.clock_timestamp());
  INSERT INTO public.after_sale_inspections
    (id, store_id, after_sale_id, inspection_version, admin_id, reason)
  VALUES (inspection_id, scoped_store_id, sale.id, next_inspection_version,
    actor_id, pg_catalog.btrim(p_reason));
  INSERT INTO public.after_sale_inspection_allocations
    (id, store_id, inspection_id, after_sale_id, after_sale_item_id, disposition, quantity)
  SELECT pg_catalog.gen_random_uuid(), scoped_store_id, inspection_id, sale.id, item.id,
    (allocation->>'disposition')::public.after_sale_inspection_disposition,
    (allocation->>'quantity')::integer
  FROM pg_catalog.jsonb_array_elements(p_items) requested_item
  CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(requested_item->'dispositions') allocation
  JOIN public.after_sale_items item
    ON item.store_id = scoped_store_id AND item.after_sale_id = sale.id
    AND item.order_item_id = (requested_item->>'order_item_id')::uuid;

  SET CONSTRAINTS "after_sale_inspections_complete_guard" IMMEDIATE;
  SET CONSTRAINTS "after_sale_inspection_allocations_complete_guard" IMMEDIATE;

  FOR action_item IN
    SELECT item.id, item.order_id, item.order_item_id, item.sku_id,
      item.restockable_quantity, orders.reservation_id
    FROM public.after_sale_items item
    JOIN public.orders orders ON orders.store_id = item.store_id AND orders.id = item.order_id
    WHERE item.store_id = scoped_store_id AND item.after_sale_id = sale.id
      AND item.restockable_quantity > 0
    ORDER BY item.id
    FOR UPDATE OF item, orders
  LOOP
    original_reservation_id := action_item.reservation_id;
    PERFORM 1 FROM public.inventory_reservations reservation
    WHERE reservation.store_id = scoped_store_id AND reservation.id = original_reservation_id
      AND reservation.source_type = 'ORDER' AND reservation.source_id = action_item.order_id
      AND reservation.status = 'CONSUMED'
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'sellable restoration requires the consumed original reservation'
        USING ERRCODE = '23514';
    END IF;
    SELECT pg_catalog.count(DISTINCT reservation_item.warehouse_id)::integer,
      pg_catalog.min(reservation_item.warehouse_id::text)::uuid,
      COALESCE(pg_catalog.sum(reservation_item.quantity), 0)::integer
    INTO warehouse_count, original_warehouse_id, consumed_quantity
    FROM public.inventory_reservation_items reservation_item
    WHERE reservation_item.store_id = scoped_store_id
      AND reservation_item.reservation_id = original_reservation_id
      AND reservation_item.sku_id = action_item.sku_id;
    IF warehouse_count <> 1 OR original_warehouse_id IS NULL
       OR consumed_quantity < action_item.restockable_quantity
    THEN
      RAISE EXCEPTION 'sellable restoration requires one authoritative original warehouse'
        USING ERRCODE = '23514';
    END IF;

    SELECT inventory_balance.id, inventory_balance.on_hand, inventory_balance.reserved,
      inventory_balance.version
    INTO balance
    FROM public.inventory_balances inventory_balance
    WHERE inventory_balance.store_id = scoped_store_id
      AND inventory_balance.warehouse_id = original_warehouse_id
      AND inventory_balance.sku_id = action_item.sku_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'sellable restoration inventory balance was not found'
        USING ERRCODE = '23514';
    END IF;

    inventory_operation_id := pg_catalog.gen_random_uuid();
    inventory_movement_id := pg_catalog.gen_random_uuid();
    INSERT INTO public.inventory_operations
      (id, store_id, operation_key, request_hash, operation_type, result_snapshot,
        admin_id, source_type, source_id)
    VALUES (
      inventory_operation_id,
      scoped_store_id,
      'after-sale-restore:' || action_item.id::text || ':' || next_inspection_version::text,
      p_request_hash,
      'RESTORE',
      pg_catalog.jsonb_build_object(
        'operation_id', inventory_operation_id,
        'source_type', 'AFTER_SALE_RESTORE',
        'source_id', action_item.id,
        'items', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'warehouse_id', original_warehouse_id,
          'sku_id', action_item.sku_id,
          'quantity', action_item.restockable_quantity
        ))
      ),
      actor_id,
      'AFTER_SALE_RESTORE',
      action_item.id
    );
    UPDATE public.inventory_balances inventory_balance
    SET on_hand = balance.on_hand + action_item.restockable_quantity,
        version = balance.version + 1,
        updated_at = pg_catalog.clock_timestamp()
    WHERE inventory_balance.store_id = scoped_store_id
      AND inventory_balance.id = balance.id
      AND inventory_balance.version = balance.version;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'sellable restoration inventory version changed'
        USING ERRCODE = '40001';
    END IF;
    INSERT INTO public.inventory_movements
      (id, store_id, balance_id, operation_id, reservation_item_id, movement_type,
        on_hand_before, on_hand_after, on_hand_delta, reserved_before, reserved_after,
        reserved_delta, reason_code, note)
    VALUES (
      inventory_movement_id, scoped_store_id, balance.id, inventory_operation_id, NULL, 'RESTORE',
      balance.on_hand, balance.on_hand + action_item.restockable_quantity,
      action_item.restockable_quantity, balance.reserved, balance.reserved, 0,
      'AFTER_SALE_RESTORE', NULL
    );
    INSERT INTO public.after_sale_inventory_actions
      (id, store_id, after_sale_id, after_sale_item_id, order_id, inspection_version,
        warehouse_id, sku_id, disposition, action_type, quantity, inventory_operation_id)
    VALUES (
      pg_catalog.gen_random_uuid(), scoped_store_id, sale.id, action_item.id,
      action_item.order_id, next_inspection_version, original_warehouse_id, action_item.sku_id,
      'RESTOCK_SELLABLE', 'RESTOCK_SELLABLE', action_item.restockable_quantity,
      inventory_operation_id
    );
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM public.after_sale_items item
    WHERE item.store_id = scoped_store_id AND item.after_sale_id = sale.id
      AND item.accepted_quantity > 0
  ) THEN
    target_event := 'ACCEPT_INSPECTION';
    target_status := CASE sale.type
      WHEN 'RETURN_REFUND' THEN 'REFUND_PENDING'::public.after_sale_status
      ELSE 'EXCHANGE_PENDING'::public.after_sale_status END;
  ELSE
    target_event := 'REJECT_INSPECTION';
    target_status := 'REJECTED';
  END IF;
  INSERT INTO public.after_sale_transitions
    (store_id, after_sale_id, operation_id, from_status, to_status, event,
      actor_type, actor_id, reason, correlation_id)
  VALUES (scoped_store_id, sale.id, p_operation_id, 'INSPECTION_PENDING', target_status,
    target_event, 'ADMIN', actor_id, pg_catalog.btrim(p_reason), correlation_id);
  SELECT current_sale.* INTO sale FROM public.after_sales current_sale
  WHERE current_sale.store_id = scoped_store_id AND current_sale.id = p_after_sale_id;
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'order_item_id', item.order_item_id,
      'quantity', action.quantity
    ) ORDER BY item.order_item_id), '[]'::jsonb)
  INTO result_restored_items
  FROM public.after_sale_inventory_actions action
  JOIN public.after_sale_items item
    ON item.store_id = action.store_id AND item.id = action.after_sale_item_id
  WHERE action.store_id = scoped_store_id AND action.after_sale_id = sale.id
    AND action.inspection_version = next_inspection_version;

  UPDATE public.after_sale_operations operation_row
  SET status = 'COMPLETED',
      result_summary = pg_catalog.jsonb_build_object(
        'after_sale_id', sale.id,
        'operation_id', p_operation_id,
        'public_case_number', sale.public_case_number,
        'status', sale.status,
        'version', sale.version,
        'inspection_version', next_inspection_version,
        'restored_items', result_restored_items
      ),
      attempt_count = 1,
      version = operation_row.version + 1,
      updated_at = pg_catalog.clock_timestamp()
  WHERE operation_row.store_id = scoped_store_id AND operation_row.id = p_operation_id;
  INSERT INTO public.audit_logs
    (store_id, actor_type, actor_id, action, target_type, target_id,
      before_data, after_data, reason, correlation_id, source_ip)
  VALUES (scoped_store_id, 'ADMIN', actor_id, 'after-sale.return.inspected',
    'after_sale', sale.id::text,
    pg_catalog.jsonb_build_object(
      'status', 'INSPECTION_PENDING',
      'version', p_expected_version,
      'inspection_version', p_expected_inspection_version
    ),
    pg_catalog.jsonb_build_object(
      'after_sale_id', sale.id,
      'operation_id', p_operation_id,
      'status', sale.status,
      'version', sale.version,
      'inspection_version', next_inspection_version,
      'restored_items', result_restored_items
    ),
    pg_catalog.btrim(p_reason), correlation_id, p_source_ip);

  RETURN QUERY SELECT sale.id, p_operation_id, sale.public_case_number, sale.status,
    sale.version, next_inspection_version, result_restored_items, false;
END
$$;

REVOKE ALL ON FUNCTION
  "app_security"."assert_p0_m6_008_admin_authorization"(boolean),
  "app_security"."validate_p0_m6_008_operation_completion"(),
  "app_security"."validate_p0_m6_008_command_atomicity"(),
  "app_security"."inspect_p0_m6_008_after_sale_return"(
    uuid,uuid,text,text,integer,integer,jsonb,text,inet
  )
FROM PUBLIC;
REVOKE ALL ON FUNCTION
  "app_security"."assert_p0_m6_008_admin_authorization"(boolean),
  "app_security"."validate_p0_m6_008_operation_completion"(),
  "app_security"."validate_p0_m6_008_command_atomicity"()
FROM zalo_shop_runtime;
GRANT EXECUTE ON FUNCTION
  "app_security"."inspect_p0_m6_008_after_sale_return"(
    uuid,uuid,text,text,integer,integer,jsonb,text,inet
  )
TO zalo_shop_runtime;
