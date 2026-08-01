-- M6.3-B5 default-disabled return submission and audited logistics facts.
-- Inspection, inventory, external providers, refunds and production rollout remain out of scope.

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

-- The M6.2 generic admin guard incorrectly applied the member handover deadline to a later
-- trusted logistics verification. Keep all other events on the frozen guard and validate only
-- the two B5 facts in this narrower replacement.
DROP TRIGGER "after_sale_transitions_state_guard" ON "after_sale_transitions";
CREATE TRIGGER "after_sale_transitions_state_guard"
  BEFORE INSERT ON "after_sale_transitions"
  FOR EACH ROW
  WHEN (
    NEW.actor_type = 'ADMIN'
    AND NEW.event NOT IN ('SUBMIT','RETURN_SHIPPED','RETURN_RECEIVED')
  )
  EXECUTE FUNCTION "app_security"."validate_m62_after_sale_transition"();

CREATE OR REPLACE FUNCTION "app_security"."validate_m63_b5_admin_return_transition"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE sale record;
DECLARE graph_match boolean := false;
BEGIN
  IF pg_catalog.current_setting('app.actor_type', true) IS DISTINCT FROM 'admin'
     OR NEW.store_id IS DISTINCT FROM app_security.current_store_id()
     OR NEW.actor_type <> 'ADMIN'
     OR NEW.actor_id IS DISTINCT FROM app_security.current_actor_id()
     OR NEW.correlation_id IS DISTINCT FROM
       NULLIF(pg_catalog.current_setting('app.correlation_id', true), '')
     OR NEW.event NOT IN ('RETURN_SHIPPED','RETURN_RECEIVED')
  THEN
    RAISE EXCEPTION 'B5 return transition is outside the audited admin scope'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO sale
  FROM public.after_sales current_sale
  WHERE current_sale.store_id = NEW.store_id AND current_sale.id = NEW.after_sale_id
  FOR UPDATE;
  IF NOT FOUND OR NEW.from_status IS NULL OR NEW.from_status <> sale.status THEN
    RAISE EXCEPTION 'B5 return transition must start from the locked aggregate status'
      USING ERRCODE = '23514';
  END IF;

  graph_match := sale.type IN ('RETURN_REFUND','EXCHANGE') AND (
    (NEW.event = 'RETURN_SHIPPED'
      AND NEW.from_status = 'RETURN_PENDING' AND NEW.to_status = 'RETURN_IN_TRANSIT'
      AND EXISTS (
        SELECT 1 FROM public.after_sale_return_shipments shipment
        WHERE shipment.store_id = sale.store_id AND shipment.after_sale_id = sale.id
          AND shipment.status IN ('IN_TRANSIT','DELIVERED')
      ))
    OR
    (NEW.event = 'RETURN_RECEIVED'
      AND NEW.from_status = 'RETURN_IN_TRANSIT' AND NEW.to_status = 'INSPECTION_PENDING'
      AND EXISTS (
        SELECT 1 FROM public.after_sale_return_shipments shipment
        WHERE shipment.store_id = sale.store_id AND shipment.after_sale_id = sale.id
          AND shipment.status = 'DELIVERED' AND shipment.received_at IS NOT NULL
      ))
  );
  IF NOT graph_match THEN
    RAISE EXCEPTION 'B5 return transition lacks a matching trusted shipment fact'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "after_sale_transitions_b5_return_state_guard"
  BEFORE INSERT ON "after_sale_transitions"
  FOR EACH ROW
  WHEN (NEW.actor_type = 'ADMIN' AND NEW.event IN ('RETURN_SHIPPED','RETURN_RECEIVED'))
  EXECUTE FUNCTION "app_security"."validate_m63_b5_admin_return_transition"();

CREATE OR REPLACE FUNCTION "app_security"."validate_m63_b5_operation_completion"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.operation NOT IN ('MEMBER_SUBMIT_RETURN','ADMIN_RECORD_RETURN_FACT') THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF SESSION_USER <> 'zalo_shop_runtime' OR NEW.status <> 'PENDING'
       OR NEW.result_summary IS NOT NULL OR NEW.error_code IS NOT NULL
       OR NEW.attempt_count <> 0 OR NEW.version <> 1
    THEN
      RAISE EXCEPTION 'B5 operation must begin pending in the runtime command'
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
    RAISE EXCEPTION 'B5 operation must complete once with an immutable result'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "after_sale_operations_b5_completion_guard"
  BEFORE INSERT OR UPDATE ON "after_sale_operations"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m63_b5_operation_completion"();

CREATE OR REPLACE FUNCTION "app_security"."validate_m63_b5_command_atomicity"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE operation_record record;
DECLARE linked_count bigint;
DECLARE audit_count bigint;
DECLARE shipment record;
DECLARE sale record;
DECLARE expected_transition_count integer;
DECLARE expected_action text;
BEGIN
  IF TG_TABLE_NAME = 'after_sale_operations' THEN
    IF NEW.operation NOT IN ('MEMBER_SUBMIT_RETURN','ADMIN_RECORD_RETURN_FACT') THEN RETURN NULL; END IF;
    SELECT * INTO operation_record FROM public.after_sale_operations operation_row
    WHERE operation_row.store_id = NEW.store_id AND operation_row.id = NEW.id;
  ELSE
    IF NEW.operation_id IS NULL THEN RETURN NULL; END IF;
    SELECT * INTO operation_record FROM public.after_sale_operations operation_row
    WHERE operation_row.store_id = NEW.store_id
      AND operation_row.id = NEW.operation_id
      AND operation_row.after_sale_id = NEW.after_sale_id;
    IF NOT FOUND OR operation_record.operation NOT IN (
      'MEMBER_SUBMIT_RETURN','ADMIN_RECORD_RETURN_FACT'
    ) THEN RETURN NULL; END IF;
  END IF;

  IF operation_record.status <> 'COMPLETED'
     OR pg_catalog.jsonb_typeof(operation_record.result_summary) <> 'object'
     OR operation_record.result_summary->>'transition_count' !~ '^[1-2]$'
  THEN
    RAISE EXCEPTION 'B5 command result is incomplete' USING ERRCODE = '23514';
  END IF;
  expected_transition_count := (operation_record.result_summary->>'transition_count')::integer;
  expected_action := CASE operation_record.operation
    WHEN 'MEMBER_SUBMIT_RETURN' THEN 'after-sale.return.submitted'
    ELSE 'after-sale.return.fact-recorded' END;

  SELECT pg_catalog.count(*) INTO linked_count
  FROM public.after_sale_transitions transition
  WHERE transition.store_id = operation_record.store_id
    AND transition.after_sale_id = operation_record.after_sale_id
    AND transition.operation_id = operation_record.id;
  SELECT pg_catalog.count(*) INTO audit_count
  FROM public.audit_logs audit
  WHERE audit.store_id = operation_record.store_id
    AND audit.target_type = 'after_sale'
    AND audit.target_id = operation_record.after_sale_id::text
    AND audit.action = expected_action
    AND audit.after_data->>'operation_id' = operation_record.id::text;
  SELECT * INTO shipment FROM public.after_sale_return_shipments return_shipment
  WHERE return_shipment.store_id = operation_record.store_id
    AND return_shipment.after_sale_id = operation_record.after_sale_id;
  SELECT * INTO sale FROM public.after_sales current_sale
  WHERE current_sale.store_id = operation_record.store_id
    AND current_sale.id = operation_record.after_sale_id;

  IF linked_count <> expected_transition_count OR audit_count <> 1
     OR shipment.id IS NULL OR sale.id IS NULL
     OR operation_record.result_summary->>'after_sale_id' <> sale.id::text
     OR operation_record.result_summary->>'operation_id' <> operation_record.id::text
     OR operation_record.result_summary->>'status' <> sale.status::text
     OR operation_record.result_summary->>'version' <> sale.version::text
     OR operation_record.result_summary->>'return_shipment_status' <> shipment.status::text
     OR operation_record.result_summary->>'return_shipment_version' <> shipment.version::text
  THEN
    RAISE EXCEPTION 'B5 return, operation, transition and audit must commit atomically'
      USING ERRCODE = '23514';
  END IF;
  PERFORM app_security.assert_m63_b3_command_authorization();
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "after_sale_operations_b5_atomic_guard"
  AFTER INSERT OR UPDATE ON "after_sale_operations"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m63_b5_command_atomicity"();
CREATE CONSTRAINT TRIGGER "after_sale_transitions_b5_atomic_guard"
  AFTER INSERT ON "after_sale_transitions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m63_b5_command_atomicity"();

CREATE OR REPLACE FUNCTION "app_security"."submit_m63_b5_member_return"(
  p_after_sale_id uuid,
  p_operation_id uuid,
  p_idempotency_key_hash text,
  p_request_hash text,
  p_expected_version integer,
  p_carrier_name text,
  p_tracking_number_digest text,
  p_tracking_number_masked text,
  p_source_ip inet DEFAULT NULL
)
RETURNS TABLE (
  after_sale_id uuid,
  operation_id uuid,
  public_case_number varchar,
  status public.after_sale_status,
  version integer,
  return_shipment_status public.after_sale_return_shipment_status,
  return_shipment_version integer,
  replayed boolean
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE actor_id uuid := app_security.current_actor_id();
DECLARE scoped_store_id uuid := app_security.current_store_id();
DECLARE correlation_id text := NULLIF(pg_catalog.current_setting('app.correlation_id', true), '');
DECLARE existing record;
DECLARE sale record;
DECLARE shipment record;
DECLARE target_order_id uuid;
BEGIN
  IF pg_catalog.current_setting('app.actor_type', true) IS DISTINCT FROM 'member'
     OR actor_id IS NULL OR scoped_store_id IS NULL OR correlation_id IS NULL
     OR p_after_sale_id IS NULL OR p_operation_id IS NULL
     OR p_expected_version IS NULL OR p_expected_version < 1
     OR p_idempotency_key_hash !~ '^[0-9a-f]{64}$'
     OR p_request_hash !~ '^[0-9a-f]{64}$'
     OR p_tracking_number_digest !~ '^[0-9a-f]{64}$'
     OR pg_catalog.length(p_carrier_name) NOT BETWEEN 2 AND 160
     OR pg_catalog.length(p_tracking_number_masked) NOT BETWEEN 2 AND 160
  THEN
    RAISE EXCEPTION 'B5 return submission requires a complete member command context'
      USING ERRCODE = '42501';
  END IF;
  PERFORM app_security.assert_m63_b3_command_authorization();
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'm63-b5:' || scoped_store_id::text || ':MEMBER_SUBMIT_RETURN:' || p_idempotency_key_hash, 0));

  SELECT operation_row.* INTO existing
  FROM public.after_sale_operations operation_row
  WHERE operation_row.store_id = scoped_store_id
    AND operation_row.operation = 'MEMBER_SUBMIT_RETURN'
    AND operation_row.idempotency_key_hash = p_idempotency_key_hash
  FOR UPDATE;
  IF FOUND THEN
    IF existing.after_sale_id IS DISTINCT FROM p_after_sale_id
       OR existing.request_hash IS DISTINCT FROM p_request_hash
       OR existing.status <> 'COMPLETED'
       OR pg_catalog.jsonb_typeof(existing.result_summary) <> 'object'
    THEN RAISE EXCEPTION 'B5 return idempotency key conflict' USING ERRCODE = '23505'; END IF;
    SELECT * INTO sale FROM public.after_sales current_sale
    WHERE current_sale.store_id = scoped_store_id
      AND current_sale.id = existing.after_sale_id AND current_sale.member_id = actor_id;
    SELECT * INTO shipment FROM public.after_sale_return_shipments return_shipment
    WHERE return_shipment.store_id = scoped_store_id
      AND return_shipment.after_sale_id = existing.after_sale_id
      AND return_shipment.member_id = actor_id;
    IF sale.id IS NULL OR shipment.id IS NULL
       OR existing.result_summary->>'after_sale_id' <> sale.id::text
       OR existing.result_summary->>'operation_id' <> existing.id::text
       OR existing.result_summary->>'public_case_number' <> sale.public_case_number
       OR existing.result_summary->>'status' <> sale.status::text
       OR existing.result_summary->>'version' <> sale.version::text
       OR existing.result_summary->>'return_shipment_status' <> shipment.status::text
       OR existing.result_summary->>'return_shipment_version' <> shipment.version::text
    THEN RAISE EXCEPTION 'B5 return replay result is invalid' USING ERRCODE = '23514'; END IF;
    PERFORM app_security.assert_m63_b3_command_authorization();
    RETURN QUERY SELECT sale.id, existing.id, sale.public_case_number, sale.status, sale.version,
      shipment.status, shipment.version, true;
    RETURN;
  END IF;

  SELECT current_sale.order_id INTO target_order_id
  FROM public.after_sales current_sale
  WHERE current_sale.store_id = scoped_store_id
    AND current_sale.id = p_after_sale_id AND current_sale.member_id = actor_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'B5 return target not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'm62-refund:' || scoped_store_id::text || ':' || target_order_id::text, 0));
  PERFORM 1 FROM public.orders current_order
  WHERE current_order.store_id = scoped_store_id AND current_order.id = target_order_id
    AND current_order.member_id = actor_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'B5 return order not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO sale FROM public.after_sales current_sale
  WHERE current_sale.store_id = scoped_store_id
    AND current_sale.id = p_after_sale_id AND current_sale.member_id = actor_id
  FOR UPDATE;
  IF NOT FOUND OR sale.order_id IS DISTINCT FROM target_order_id THEN
    RAISE EXCEPTION 'B5 return target not found' USING ERRCODE = 'P0002';
  END IF;
  IF sale.return_deadline_at IS NULL OR pg_catalog.clock_timestamp() >= sale.return_deadline_at THEN
    RAISE EXCEPTION 'B5 return window is closed' USING ERRCODE = 'P6301';
  END IF;
  IF sale.version <> p_expected_version THEN
    RAISE EXCEPTION 'B5 return expected version does not match' USING ERRCODE = '40001';
  END IF;
  IF sale.status <> 'APPROVED' OR sale.type NOT IN ('RETURN_REFUND','EXCHANGE')
     OR sale.approved_total_vnd <= 0
     OR NOT EXISTS (SELECT 1 FROM public.after_sale_items item
       WHERE item.store_id = scoped_store_id AND item.after_sale_id = sale.id
         AND item.approved_quantity > 0)
     OR EXISTS (SELECT 1 FROM public.after_sale_return_shipments return_shipment
       WHERE return_shipment.store_id = scoped_store_id AND return_shipment.after_sale_id = sale.id)
  THEN RAISE EXCEPTION 'after-sale is not eligible for return submission' USING ERRCODE = '23514'; END IF;

  INSERT INTO public.after_sale_operations
    (id, store_id, after_sale_id, operation, idempotency_key_hash, request_hash, updated_at)
  VALUES (p_operation_id, scoped_store_id, sale.id, 'MEMBER_SUBMIT_RETURN',
    p_idempotency_key_hash, p_request_hash, pg_catalog.clock_timestamp());
  INSERT INTO public.after_sale_return_shipments
    (store_id, after_sale_id, order_id, member_id, carrier_name, tracking_number_digest,
      tracking_number_masked, submitted_by, updated_at)
  VALUES (scoped_store_id, sale.id, sale.order_id, sale.member_id, p_carrier_name,
    p_tracking_number_digest, p_tracking_number_masked, actor_id, pg_catalog.clock_timestamp())
  RETURNING * INTO shipment;
  INSERT INTO public.after_sale_transitions
    (store_id, after_sale_id, operation_id, from_status, to_status, event,
      actor_type, actor_id, reason, correlation_id)
  VALUES (scoped_store_id, sale.id, p_operation_id, 'APPROVED', 'RETURN_PENDING', 'START_RETURN',
    'MEMBER', actor_id, NULL, correlation_id);
  SELECT * INTO sale FROM public.after_sales current_sale
  WHERE current_sale.store_id = scoped_store_id AND current_sale.id = p_after_sale_id;

  UPDATE public.after_sale_operations operation_row
  SET status = 'COMPLETED',
      result_summary = pg_catalog.jsonb_build_object(
        'after_sale_id', sale.id,
        'operation_id', p_operation_id,
        'public_case_number', sale.public_case_number,
        'status', sale.status,
        'version', sale.version,
        'return_shipment_status', shipment.status,
        'return_shipment_version', shipment.version,
        'transition_count', 1
      ),
      attempt_count = 1,
      version = operation_row.version + 1,
      updated_at = pg_catalog.clock_timestamp()
  WHERE operation_row.store_id = scoped_store_id AND operation_row.id = p_operation_id;
  INSERT INTO public.audit_logs
    (store_id, actor_type, actor_id, action, target_type, target_id,
      before_data, after_data, reason, correlation_id, source_ip)
  VALUES (scoped_store_id, 'MEMBER', actor_id, 'after-sale.return.submitted',
    'after_sale', sale.id::text,
    pg_catalog.jsonb_build_object('status','APPROVED','version',p_expected_version),
    pg_catalog.jsonb_build_object(
      'after_sale_id', sale.id,
      'operation_id', p_operation_id,
      'return_shipment_id', shipment.id,
      'return_shipment_status', shipment.status,
      'return_shipment_version', shipment.version,
      'status', sale.status,
      'version', sale.version
    ), NULL, correlation_id, p_source_ip);
  PERFORM app_security.assert_m63_b3_command_authorization();
  RETURN QUERY SELECT sale.id, p_operation_id, sale.public_case_number, sale.status, sale.version,
    shipment.status, shipment.version, false;
END
$$;

CREATE OR REPLACE FUNCTION "app_security"."record_m63_b5_return_fact"(
  p_after_sale_id uuid,
  p_operation_id uuid,
  p_idempotency_key_hash text,
  p_request_hash text,
  p_expected_version integer,
  p_expected_return_shipment_version integer,
  p_status text,
  p_reason text,
  p_source_ip inet DEFAULT NULL
)
RETURNS TABLE (
  after_sale_id uuid,
  operation_id uuid,
  public_case_number varchar,
  status public.after_sale_status,
  version integer,
  return_shipment_status public.after_sale_return_shipment_status,
  return_shipment_version integer,
  replayed boolean
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE actor_id uuid := app_security.current_actor_id();
DECLARE scoped_store_id uuid := app_security.current_store_id();
DECLARE correlation_id text := NULLIF(pg_catalog.current_setting('app.correlation_id', true), '');
DECLARE existing record;
DECLARE sale record;
DECLARE shipment record;
DECLARE target_order_id uuid;
DECLARE transition_count integer := 0;
DECLARE transition_created_at timestamptz;
DECLARE before_sale_status public.after_sale_status;
DECLARE before_shipment_status public.after_sale_return_shipment_status;
BEGIN
  IF pg_catalog.current_setting('app.actor_type', true) IS DISTINCT FROM 'admin'
     OR actor_id IS NULL OR scoped_store_id IS NULL OR correlation_id IS NULL
     OR p_after_sale_id IS NULL OR p_operation_id IS NULL
     OR p_expected_version IS NULL OR p_expected_version < 1
     OR p_expected_return_shipment_version IS NULL OR p_expected_return_shipment_version < 1
     OR p_status NOT IN ('IN_TRANSIT','DELIVERED')
     OR p_idempotency_key_hash !~ '^[0-9a-f]{64}$'
     OR p_request_hash !~ '^[0-9a-f]{64}$'
     OR p_reason IS NULL OR pg_catalog.length(pg_catalog.btrim(p_reason)) NOT BETWEEN 10 AND 500
  THEN
    RAISE EXCEPTION 'B5 trusted return fact requires a complete admin command context'
      USING ERRCODE = '42501';
  END IF;
  PERFORM app_security.assert_m63_b3_command_authorization();
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'm63-b5:' || scoped_store_id::text || ':ADMIN_RECORD_RETURN_FACT:' || p_idempotency_key_hash, 0));

  SELECT operation_row.* INTO existing
  FROM public.after_sale_operations operation_row
  WHERE operation_row.store_id = scoped_store_id
    AND operation_row.operation = 'ADMIN_RECORD_RETURN_FACT'
    AND operation_row.idempotency_key_hash = p_idempotency_key_hash
  FOR UPDATE;
  IF FOUND THEN
    IF existing.after_sale_id IS DISTINCT FROM p_after_sale_id
       OR existing.request_hash IS DISTINCT FROM p_request_hash
       OR existing.status <> 'COMPLETED'
       OR pg_catalog.jsonb_typeof(existing.result_summary) <> 'object'
    THEN RAISE EXCEPTION 'B5 return fact idempotency key conflict' USING ERRCODE = '23505'; END IF;
    SELECT * INTO sale FROM public.after_sales current_sale
    WHERE current_sale.store_id = scoped_store_id AND current_sale.id = existing.after_sale_id;
    SELECT * INTO shipment FROM public.after_sale_return_shipments return_shipment
    WHERE return_shipment.store_id = scoped_store_id
      AND return_shipment.after_sale_id = existing.after_sale_id;
    IF sale.id IS NULL OR shipment.id IS NULL
       OR existing.result_summary->>'after_sale_id' <> sale.id::text
       OR existing.result_summary->>'operation_id' <> existing.id::text
       OR existing.result_summary->>'public_case_number' <> sale.public_case_number
       OR existing.result_summary->>'status' <> sale.status::text
       OR existing.result_summary->>'version' <> sale.version::text
       OR existing.result_summary->>'return_shipment_status' <> shipment.status::text
       OR existing.result_summary->>'return_shipment_version' <> shipment.version::text
    THEN RAISE EXCEPTION 'B5 return fact replay result is invalid' USING ERRCODE = '23514'; END IF;
    PERFORM app_security.assert_m63_b3_command_authorization();
    RETURN QUERY SELECT sale.id, existing.id, sale.public_case_number, sale.status, sale.version,
      shipment.status, shipment.version, true;
    RETURN;
  END IF;

  SELECT current_sale.order_id INTO target_order_id
  FROM public.after_sales current_sale
  WHERE current_sale.store_id = scoped_store_id AND current_sale.id = p_after_sale_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'B5 return fact target not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'm62-refund:' || scoped_store_id::text || ':' || target_order_id::text, 0));
  PERFORM 1 FROM public.orders current_order
  WHERE current_order.store_id = scoped_store_id AND current_order.id = target_order_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'B5 return fact order not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO sale FROM public.after_sales current_sale
  WHERE current_sale.store_id = scoped_store_id AND current_sale.id = p_after_sale_id
  FOR UPDATE;
  IF NOT FOUND OR sale.order_id IS DISTINCT FROM target_order_id THEN
    RAISE EXCEPTION 'B5 return fact target not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO shipment FROM public.after_sale_return_shipments return_shipment
  WHERE return_shipment.store_id = scoped_store_id
    AND return_shipment.after_sale_id = p_after_sale_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'B5 return shipment not found' USING ERRCODE = 'P0002'; END IF;
  IF sale.version <> p_expected_version THEN
    RAISE EXCEPTION 'B5 return aggregate expected version does not match' USING ERRCODE = '40001';
  END IF;
  IF shipment.version <> p_expected_return_shipment_version THEN
    RAISE EXCEPTION 'B5 return shipment expected version does not match' USING ERRCODE = '40001';
  END IF;
  IF sale.type NOT IN ('RETURN_REFUND','EXCHANGE')
     OR NOT (
       (p_status = 'IN_TRANSIT' AND sale.status = 'RETURN_PENDING' AND shipment.status = 'SUBMITTED')
       OR (p_status = 'DELIVERED' AND (
         (sale.status = 'RETURN_PENDING' AND shipment.status = 'SUBMITTED')
         OR (sale.status = 'RETURN_IN_TRANSIT' AND shipment.status = 'IN_TRANSIT')
       ))
     )
  THEN RAISE EXCEPTION 'B5 trusted return fact conflicts with current state' USING ERRCODE = '23514'; END IF;

  before_sale_status := sale.status;
  before_shipment_status := shipment.status;
  INSERT INTO public.after_sale_operations
    (id, store_id, after_sale_id, operation, idempotency_key_hash, request_hash, updated_at)
  VALUES (p_operation_id, scoped_store_id, sale.id, 'ADMIN_RECORD_RETURN_FACT',
    p_idempotency_key_hash, p_request_hash, pg_catalog.clock_timestamp());
  UPDATE public.after_sale_return_shipments return_shipment
  SET status = p_status::public.after_sale_return_shipment_status,
      received_at = CASE WHEN p_status = 'DELIVERED' THEN pg_catalog.clock_timestamp() ELSE NULL END,
      version = return_shipment.version + 1,
      updated_at = pg_catalog.clock_timestamp()
  WHERE return_shipment.store_id = scoped_store_id AND return_shipment.id = shipment.id
  RETURNING * INTO shipment;

  IF sale.status = 'RETURN_PENDING' THEN
    transition_created_at := pg_catalog.clock_timestamp();
    INSERT INTO public.after_sale_transitions
      (store_id, after_sale_id, operation_id, from_status, to_status, event,
        actor_type, actor_id, reason, correlation_id, created_at)
    VALUES (scoped_store_id, sale.id, p_operation_id, 'RETURN_PENDING', 'RETURN_IN_TRANSIT',
      'RETURN_SHIPPED', 'ADMIN', actor_id, pg_catalog.btrim(p_reason), correlation_id,
      transition_created_at);
    transition_count := transition_count + 1;
    SELECT * INTO sale FROM public.after_sales current_sale
    WHERE current_sale.store_id = scoped_store_id AND current_sale.id = p_after_sale_id;
  END IF;
  IF p_status = 'DELIVERED' THEN
    INSERT INTO public.after_sale_transitions
      (store_id, after_sale_id, operation_id, from_status, to_status, event,
        actor_type, actor_id, reason, correlation_id, created_at)
    VALUES (scoped_store_id, sale.id, p_operation_id, 'RETURN_IN_TRANSIT', 'INSPECTION_PENDING',
      'RETURN_RECEIVED', 'ADMIN', actor_id, pg_catalog.btrim(p_reason), correlation_id,
      CASE WHEN before_sale_status = 'RETURN_PENDING'
        THEN GREATEST(
          pg_catalog.clock_timestamp(), transition_created_at + INTERVAL '1 microsecond'
        )
        ELSE pg_catalog.clock_timestamp()
      END);
    transition_count := transition_count + 1;
    SELECT * INTO sale FROM public.after_sales current_sale
    WHERE current_sale.store_id = scoped_store_id AND current_sale.id = p_after_sale_id;
  END IF;

  UPDATE public.after_sale_operations operation_row
  SET status = 'COMPLETED',
      result_summary = pg_catalog.jsonb_build_object(
        'after_sale_id', sale.id,
        'operation_id', p_operation_id,
        'public_case_number', sale.public_case_number,
        'status', sale.status,
        'version', sale.version,
        'return_shipment_status', shipment.status,
        'return_shipment_version', shipment.version,
        'transition_count', transition_count
      ),
      attempt_count = 1,
      version = operation_row.version + 1,
      updated_at = pg_catalog.clock_timestamp()
  WHERE operation_row.store_id = scoped_store_id AND operation_row.id = p_operation_id;
  INSERT INTO public.audit_logs
    (store_id, actor_type, actor_id, action, target_type, target_id,
      before_data, after_data, reason, correlation_id, source_ip)
  VALUES (scoped_store_id, 'ADMIN', actor_id, 'after-sale.return.fact-recorded',
    'after_sale', sale.id::text,
    pg_catalog.jsonb_build_object(
      'return_shipment_status', before_shipment_status,
      'return_shipment_version', p_expected_return_shipment_version,
      'status', before_sale_status,
      'version', p_expected_version
    ),
    pg_catalog.jsonb_build_object(
      'after_sale_id', sale.id,
      'operation_id', p_operation_id,
      'return_shipment_id', shipment.id,
      'return_shipment_status', shipment.status,
      'return_shipment_version', shipment.version,
      'status', sale.status,
      'version', sale.version
    ), pg_catalog.btrim(p_reason), correlation_id, p_source_ip);
  PERFORM app_security.assert_m63_b3_command_authorization();
  RETURN QUERY SELECT sale.id, p_operation_id, sale.public_case_number, sale.status, sale.version,
    shipment.status, shipment.version, false;
END
$$;

-- B5 commands replace the broad runtime table writes with the two audited functions above.
REVOKE INSERT ON "after_sale_return_shipments" FROM zalo_shop_runtime;
REVOKE UPDATE ("status","received_at","version","updated_at")
  ON "after_sale_return_shipments" FROM zalo_shop_runtime;

REVOKE ALL ON FUNCTION
  "app_security"."validate_m63_b5_admin_return_transition"(),
  "app_security"."validate_m63_b5_operation_completion"(),
  "app_security"."validate_m63_b5_command_atomicity"(),
  "app_security"."submit_m63_b5_member_return"(uuid,uuid,text,text,integer,text,text,text,inet),
  "app_security"."record_m63_b5_return_fact"(uuid,uuid,text,text,integer,integer,text,text,inet)
FROM PUBLIC;
REVOKE ALL ON FUNCTION
  "app_security"."validate_m63_b5_admin_return_transition"(),
  "app_security"."validate_m63_b5_operation_completion"(),
  "app_security"."validate_m63_b5_command_atomicity"()
FROM zalo_shop_runtime;
GRANT EXECUTE ON FUNCTION
  "app_security"."submit_m63_b5_member_return"(uuid,uuid,text,text,integer,text,text,text,inet),
  "app_security"."record_m63_b5_return_fact"(uuid,uuid,text,text,integer,integer,text,text,inet)
TO zalo_shop_runtime;
