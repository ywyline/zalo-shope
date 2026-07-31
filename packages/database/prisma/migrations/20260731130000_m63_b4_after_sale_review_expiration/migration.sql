-- M6.3-B4 default-disabled repository/local-test review and return expiration.
-- Production enablement, refund, return logistics, inspection and inventory remain out of scope.

CREATE INDEX "after_sales_return_expiration_idx"
  ON "after_sales"("store_id", "status", "return_deadline_at", "id");

-- B3 originally reserved operation links for its three commands. B4 extends the same
-- append-only link without allowing arbitrary operation/event combinations.
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

CREATE OR REPLACE FUNCTION "app_security"."validate_m63_b4_operation_completion"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.operation NOT IN ('ADMIN_REVIEW','ADMIN_RESOLVE_REVIEW') THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF SESSION_USER <> 'zalo_shop_runtime' OR NEW.status <> 'PENDING'
       OR NEW.result_summary IS NOT NULL OR NEW.error_code IS NOT NULL
       OR NEW.attempt_count <> 0 OR NEW.version <> 1
    THEN
      RAISE EXCEPTION 'B4 operation must begin pending in the runtime command'
        USING ERRCODE = '42501';
    END IF;
  ELSIF OLD.status <> 'PENDING' OR NEW.status <> 'COMPLETED'
     OR NEW.error_code IS NOT NULL OR NEW.result_summary IS NULL
     OR NEW.attempt_count <> 1 OR NEW.version <> OLD.version + 1
  THEN
    RAISE EXCEPTION 'B4 operation must complete once with an immutable result'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "after_sale_operations_b4_completion_guard"
  BEFORE INSERT OR UPDATE ON "after_sale_operations"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m63_b4_operation_completion"();

CREATE OR REPLACE FUNCTION "app_security"."validate_m63_b4_command_atomicity"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE current_status public.after_sale_operation_status;
DECLARE operation_name text;
DECLARE operation_id uuid;
DECLARE after_sale_id uuid;
DECLARE linked_count bigint;
DECLARE audit_count bigint;
BEGIN
  IF TG_TABLE_NAME = 'after_sale_operations' THEN
    IF NEW.operation NOT IN ('ADMIN_REVIEW','ADMIN_RESOLVE_REVIEW') THEN RETURN NULL; END IF;
    operation_name := NEW.operation;
    operation_id := NEW.id;
    after_sale_id := NEW.after_sale_id;
  ELSE
    IF NEW.event NOT IN (
      'APPROVE','REJECT','RESUME_REVIEW','REJECT_REVIEW','LEGACY_APPROVE','LEGACY_REJECT'
    ) OR NEW.operation_id IS NULL THEN RETURN NULL; END IF;
    SELECT operation_row.operation INTO operation_name
    FROM public.after_sale_operations operation_row
    WHERE operation_row.store_id = NEW.store_id AND operation_row.id = NEW.operation_id;
    IF operation_name NOT IN ('ADMIN_REVIEW','ADMIN_RESOLVE_REVIEW') THEN RETURN NULL; END IF;
    operation_id := NEW.operation_id;
    after_sale_id := NEW.after_sale_id;
  END IF;
  SELECT operation_row.status INTO current_status
  FROM public.after_sale_operations operation_row
  WHERE operation_row.store_id = NEW.store_id
    AND operation_row.id = operation_id
    AND operation_row.after_sale_id = after_sale_id;
  SELECT pg_catalog.count(*) INTO linked_count
  FROM public.after_sale_transitions transition
  WHERE transition.store_id = NEW.store_id
    AND transition.after_sale_id = after_sale_id
    AND transition.operation_id = operation_id;
  SELECT pg_catalog.count(*) INTO audit_count
  FROM public.audit_logs audit
  WHERE audit.store_id = NEW.store_id
    AND audit.target_type = 'after_sale'
    AND audit.target_id = after_sale_id::text
    AND audit.after_data->>'operation_id' = operation_id::text
    AND audit.action LIKE 'after-sale.review.%';
  IF current_status IS DISTINCT FROM 'COMPLETED' OR linked_count <> 1 OR audit_count <> 1 THEN
    RAISE EXCEPTION 'B4 operation, transition and audit must commit atomically'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "after_sale_operations_b4_atomic_guard"
  AFTER INSERT OR UPDATE ON "after_sale_operations"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m63_b4_command_atomicity"();
CREATE CONSTRAINT TRIGGER "after_sale_transitions_b4_atomic_guard"
  AFTER INSERT ON "after_sale_transitions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m63_b4_command_atomicity"();

CREATE OR REPLACE FUNCTION "app_security"."review_m63_b4_after_sale"(
  p_after_sale_id uuid,
  p_operation_id uuid,
  p_idempotency_key_hash text,
  p_request_hash text,
  p_expected_version integer,
  p_decision text,
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
DECLARE target_order_id uuid;
DECLARE approved_item_total bigint;
DECLARE approved_shipping bigint;
DECLARE approved_other bigint;
DECLARE return_window_days integer;
DECLARE return_deadline timestamptz;
DECLARE paid_shipping_fee bigint;
DECLARE paid_remote_surcharge bigint;
BEGIN
  IF pg_catalog.current_setting('app.actor_type', true) IS DISTINCT FROM 'admin'
     OR actor_id IS NULL OR scoped_store_id IS NULL OR correlation_id IS NULL
     OR p_after_sale_id IS NULL OR p_operation_id IS NULL
     OR p_expected_version IS NULL OR p_expected_version < 1
     OR p_decision NOT IN ('APPROVE','REJECT')
     OR p_idempotency_key_hash !~ '^[0-9a-f]{64}$'
     OR p_request_hash !~ '^[0-9a-f]{64}$'
     OR p_reason IS NULL OR pg_catalog.length(pg_catalog.btrim(p_reason)) NOT BETWEEN 10 AND 500
  THEN
    RAISE EXCEPTION 'B4 review requires a complete admin command context'
      USING ERRCODE = '42501';
  END IF;
  PERFORM app_security.assert_m63_b3_command_authorization();
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'm63-b4:' || scoped_store_id::text || ':ADMIN_REVIEW:' || p_idempotency_key_hash, 0));

  SELECT operation_row.* INTO existing
  FROM public.after_sale_operations operation_row
  WHERE operation_row.store_id = scoped_store_id
    AND operation_row.operation = 'ADMIN_REVIEW'
    AND operation_row.idempotency_key_hash = p_idempotency_key_hash
  FOR UPDATE;
  IF FOUND THEN
    IF existing.after_sale_id IS DISTINCT FROM p_after_sale_id
       OR existing.request_hash IS DISTINCT FROM p_request_hash
       OR existing.status <> 'COMPLETED'
       OR pg_catalog.jsonb_typeof(existing.result_summary) <> 'object'
    THEN
      RAISE EXCEPTION 'after-sale review idempotency key conflict' USING ERRCODE = '23505';
    END IF;
    SELECT * INTO sale FROM public.after_sales current_sale
    WHERE current_sale.store_id = scoped_store_id AND current_sale.id = p_after_sale_id;
    IF NOT FOUND
       OR existing.result_summary->>'after_sale_id' <> sale.id::text
       OR existing.result_summary->>'operation_id' <> existing.id::text
       OR existing.result_summary->>'public_case_number' <> sale.public_case_number
       OR existing.result_summary->>'version' !~ '^[1-9][0-9]{0,8}$'
    THEN RAISE EXCEPTION 'after-sale review replay result is invalid' USING ERRCODE = '23514'; END IF;
    PERFORM app_security.assert_m63_b3_command_authorization();
    RETURN QUERY SELECT sale.id, existing.id, sale.public_case_number,
      (existing.result_summary->>'status')::public.after_sale_status,
      (existing.result_summary->>'version')::integer, true;
    RETURN;
  END IF;

  SELECT current_sale.order_id INTO target_order_id
  FROM public.after_sales current_sale
  WHERE current_sale.store_id = scoped_store_id AND current_sale.id = p_after_sale_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'after-sale review target not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'm62-refund:' || scoped_store_id::text || ':' || target_order_id::text, 0));
  PERFORM 1 FROM public.orders current_order
  WHERE current_order.store_id = scoped_store_id AND current_order.id = target_order_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'after-sale order not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO sale FROM public.after_sales current_sale
  WHERE current_sale.store_id = scoped_store_id AND current_sale.id = p_after_sale_id
  FOR UPDATE;
  IF NOT FOUND OR sale.order_id IS DISTINCT FROM target_order_id THEN
    RAISE EXCEPTION 'after-sale review target not found' USING ERRCODE = 'P0002';
  END IF;
  IF sale.version <> p_expected_version THEN
    RAISE EXCEPTION 'after-sale expected version does not match' USING ERRCODE = '40001';
  END IF;
  IF sale.status <> 'PENDING_REVIEW' OR sale.legacy_policy_review
     OR (sale.type = 'MERCHANT_REFUND' AND sale.source = 'ADMIN'
       AND sale.initiated_by = actor_id)
  THEN
    IF sale.type = 'MERCHANT_REFUND' AND sale.initiated_by = actor_id THEN
      RAISE EXCEPTION 'merchant refund requires a different reviewing administrator'
        USING ERRCODE = '42501';
    END IF;
    RAISE EXCEPTION 'after-sale is not eligible for initial review' USING ERRCODE = '23514';
  END IF;

  IF p_decision = 'APPROVE' THEN
    IF pg_catalog.jsonb_typeof(p_items) <> 'array' OR pg_catalog.jsonb_array_length(p_items) < 1
       OR pg_catalog.jsonb_array_length(p_items) > 20
       OR EXISTS (
         SELECT 1 FROM pg_catalog.jsonb_array_elements(p_items) entry
         WHERE pg_catalog.jsonb_typeof(entry) <> 'object'
           OR NOT entry ? 'order_item_id' OR NOT entry ? 'approved_quantity'
           OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(entry)) <> 2
           OR entry->>'order_item_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
           OR entry->>'approved_quantity' !~ '^(0|[1-9][0-9]{0,3})$'
       )
    THEN RAISE EXCEPTION 'approved item decisions are invalid' USING ERRCODE = '23514'; END IF;
    PERFORM 1 FROM public.after_sale_items item
    JOIN public.order_items order_item
      ON order_item.store_id = item.store_id AND order_item.order_id = item.order_id
     AND order_item.id = item.order_item_id
    WHERE item.store_id = scoped_store_id AND item.after_sale_id = sale.id
    ORDER BY item.order_item_id
    FOR UPDATE OF item, order_item;
    IF (SELECT pg_catalog.count(*) FROM public.after_sale_items item
        WHERE item.store_id = scoped_store_id AND item.after_sale_id = sale.id)
       <> pg_catalog.jsonb_array_length(p_items)
       OR (SELECT pg_catalog.count(DISTINCT entry->>'order_item_id')
           FROM pg_catalog.jsonb_array_elements(p_items) entry)
          <> pg_catalog.jsonb_array_length(p_items)
       OR EXISTS (
         SELECT 1 FROM pg_catalog.jsonb_array_elements(p_items) entry
         LEFT JOIN public.after_sale_items item
           ON item.store_id = scoped_store_id AND item.after_sale_id = sale.id
          AND item.order_item_id = (entry->>'order_item_id')::uuid
         WHERE item.id IS NULL OR (entry->>'approved_quantity')::integer > item.requested_quantity
       )
       OR NOT EXISTS (
         SELECT 1 FROM pg_catalog.jsonb_array_elements(p_items) entry
         WHERE (entry->>'approved_quantity')::integer > 0
       )
    THEN RAISE EXCEPTION 'approved items must exactly cover requested lines' USING ERRCODE = '23514'; END IF;

    WITH decisions AS (
      SELECT (entry->>'order_item_id')::uuid AS order_item_id,
        (entry->>'approved_quantity')::integer AS approved_quantity
      FROM pg_catalog.jsonb_array_elements(p_items) entry
    )
    UPDATE public.after_sale_items item
    SET approved_quantity = decision.approved_quantity,
        approved_item_vnd = CASE
          WHEN decision.approved_quantity = 0 THEN 0
          WHEN decision.approved_quantity = item.requested_quantity THEN item.requested_item_vnd
          ELSE pg_catalog.floor(item.requested_item_vnd::numeric
            * decision.approved_quantity::numeric / item.requested_quantity::numeric)::bigint
        END,
        replacement_quantity = CASE WHEN sale.type = 'EXCHANGE'
          THEN decision.approved_quantity ELSE 0 END,
        updated_at = pg_catalog.clock_timestamp()
    FROM decisions decision
    WHERE item.store_id = scoped_store_id AND item.after_sale_id = sale.id
      AND item.order_item_id = decision.order_item_id;

    SELECT COALESCE(pg_catalog.sum(item.approved_item_vnd), 0) INTO approved_item_total
    FROM public.after_sale_items item
    WHERE item.store_id = scoped_store_id AND item.after_sale_id = sale.id;
    approved_shipping := sale.requested_shipping_vnd;
    approved_other := sale.requested_other_vnd;
    IF sale.type IN ('RETURN_REFUND','EXCHANGE') THEN
      IF sale.policy_snapshot->>'return_window_days' !~ '^[1-9][0-9]?$'
      THEN RAISE EXCEPTION 'frozen return window is invalid' USING ERRCODE = '23514'; END IF;
      return_window_days := (sale.policy_snapshot->>'return_window_days')::integer;
      IF return_window_days NOT BETWEEN 1 AND 60
      THEN RAISE EXCEPTION 'frozen return window is invalid' USING ERRCODE = '23514'; END IF;
      return_deadline := (
        ((pg_catalog.clock_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
          + return_window_days + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
      );
    ELSE
      return_deadline := NULL;
    END IF;
    UPDATE public.after_sales current_sale
    SET approved_item_vnd = approved_item_total,
        approved_shipping_vnd = approved_shipping,
        approved_other_vnd = approved_other,
        approved_total_vnd = approved_item_total + approved_shipping + approved_other,
        return_deadline_at = return_deadline,
        review_reason = pg_catalog.btrim(p_reason),
        updated_at = pg_catalog.clock_timestamp()
    WHERE current_sale.store_id = scoped_store_id AND current_sale.id = sale.id;
    IF approved_shipping + approved_other > 0 THEN
      SELECT LEAST(GREATEST(current_order.shipping_fee_vnd - current_order.shipping_discount_vnd, 0), approved_shipping),
        approved_shipping - LEAST(GREATEST(current_order.shipping_fee_vnd - current_order.shipping_discount_vnd, 0), approved_shipping)
      INTO paid_shipping_fee, paid_remote_surcharge
      FROM public.orders current_order
      WHERE current_order.store_id = scoped_store_id AND current_order.id = sale.order_id;
      INSERT INTO public.after_sale_order_allocations
        (store_id, after_sale_id, order_id, shipping_fee_vnd, remote_surcharge_vnd, other_vnd)
      VALUES (scoped_store_id, sale.id, sale.order_id, paid_shipping_fee,
        paid_remote_surcharge, approved_other);
    END IF;
  ELSE
    IF p_items IS DISTINCT FROM '[]'::jsonb THEN
      RAISE EXCEPTION 'rejection cannot contain approved items' USING ERRCODE = '23514';
    END IF;
    UPDATE public.after_sales current_sale
    SET review_reason = pg_catalog.btrim(p_reason), updated_at = pg_catalog.clock_timestamp()
    WHERE current_sale.store_id = scoped_store_id AND current_sale.id = sale.id;
  END IF;

  INSERT INTO public.after_sale_operations
    (id, store_id, after_sale_id, operation, idempotency_key_hash, request_hash, updated_at)
  VALUES (p_operation_id, scoped_store_id, sale.id, 'ADMIN_REVIEW',
    p_idempotency_key_hash, p_request_hash, pg_catalog.clock_timestamp());
  PERFORM app_security.assert_m63_b3_command_authorization();
  INSERT INTO public.after_sale_transitions
    (store_id, after_sale_id, operation_id, from_status, to_status, event,
      actor_type, actor_id, reason, correlation_id)
  VALUES (scoped_store_id, sale.id, p_operation_id, 'PENDING_REVIEW',
    CASE p_decision WHEN 'APPROVE' THEN 'APPROVED'::public.after_sale_status
      ELSE 'REJECTED'::public.after_sale_status END,
    p_decision, 'ADMIN', actor_id, pg_catalog.btrim(p_reason), correlation_id);
  SELECT * INTO sale FROM public.after_sales current_sale
  WHERE current_sale.store_id = scoped_store_id AND current_sale.id = p_after_sale_id;
  UPDATE public.after_sale_operations operation_row
  SET status = 'COMPLETED', result_summary = pg_catalog.jsonb_build_object(
      'after_sale_id', sale.id, 'operation_id', p_operation_id,
      'public_case_number', sale.public_case_number, 'status', sale.status,
      'version', sale.version), attempt_count = 1, version = operation_row.version + 1,
      updated_at = pg_catalog.clock_timestamp()
  WHERE operation_row.store_id = scoped_store_id AND operation_row.id = p_operation_id;
  INSERT INTO public.audit_logs
    (store_id, actor_type, actor_id, action, target_type, target_id,
      before_data, after_data, reason, correlation_id, source_ip)
  VALUES (scoped_store_id, 'ADMIN', actor_id,
    CASE p_decision WHEN 'APPROVE' THEN 'after-sale.review.approved'
      ELSE 'after-sale.review.rejected' END,
    'after_sale', sale.id::text,
    pg_catalog.jsonb_build_object('status','PENDING_REVIEW','version',p_expected_version),
    pg_catalog.jsonb_build_object('operation_id',p_operation_id,'status',sale.status,
      'version',sale.version,'approved_total_vnd',sale.approved_total_vnd),
    pg_catalog.btrim(p_reason), correlation_id, p_source_ip);
  RETURN QUERY SELECT sale.id, p_operation_id, sale.public_case_number,
    sale.status, sale.version, false;
END
$$;

CREATE OR REPLACE FUNCTION "app_security"."resolve_m63_b4_after_sale_review"(
  p_after_sale_id uuid,
  p_operation_id uuid,
  p_idempotency_key_hash text,
  p_request_hash text,
  p_expected_version integer,
  p_decision text,
  p_reason text,
  p_policy_basis_ciphertext text DEFAULT NULL,
  p_policy_basis_hash text DEFAULT NULL,
  p_return_window_days integer DEFAULT NULL,
  p_return_shipping_payer text DEFAULT NULL,
  p_source_ip inet DEFAULT NULL
)
RETURNS TABLE (
  after_sale_id uuid,
  operation_id uuid,
  public_case_number varchar,
  status public.after_sale_status,
  version integer,
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
DECLARE target_order_id uuid;
DECLARE target_status public.after_sale_status;
DECLARE transition_event text;
DECLARE legacy_payload jsonb;
DECLARE legacy_payload_hash text;
DECLARE return_deadline timestamptz;
BEGIN
  IF pg_catalog.current_setting('app.actor_type', true) IS DISTINCT FROM 'admin'
     OR actor_id IS NULL OR scoped_store_id IS NULL OR correlation_id IS NULL
     OR p_after_sale_id IS NULL OR p_operation_id IS NULL OR p_expected_version < 1
     OR p_decision NOT IN ('RESUME','REJECT','LEGACY_APPROVE','LEGACY_REJECT')
     OR p_idempotency_key_hash !~ '^[0-9a-f]{64}$' OR p_request_hash !~ '^[0-9a-f]{64}$'
     OR p_reason IS NULL OR pg_catalog.length(pg_catalog.btrim(p_reason)) NOT BETWEEN 10 AND 500
  THEN RAISE EXCEPTION 'B4 review resolution requires a complete admin context'
    USING ERRCODE = '42501'; END IF;
  PERFORM app_security.assert_m63_b3_command_authorization();
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'm63-b4:' || scoped_store_id::text || ':ADMIN_RESOLVE_REVIEW:' || p_idempotency_key_hash, 0));
  SELECT operation_row.* INTO existing FROM public.after_sale_operations operation_row
  WHERE operation_row.store_id = scoped_store_id
    AND operation_row.operation = 'ADMIN_RESOLVE_REVIEW'
    AND operation_row.idempotency_key_hash = p_idempotency_key_hash
  FOR UPDATE;
  IF FOUND THEN
    IF existing.after_sale_id IS DISTINCT FROM p_after_sale_id
       OR existing.request_hash IS DISTINCT FROM p_request_hash
       OR existing.status <> 'COMPLETED'
       OR pg_catalog.jsonb_typeof(existing.result_summary) <> 'object'
    THEN RAISE EXCEPTION 'review resolution idempotency conflict' USING ERRCODE = '23505'; END IF;
    SELECT * INTO sale FROM public.after_sales current_sale
    WHERE current_sale.store_id = scoped_store_id AND current_sale.id = p_after_sale_id;
    IF NOT FOUND OR existing.result_summary->>'after_sale_id' <> sale.id::text
       OR existing.result_summary->>'operation_id' <> existing.id::text
       OR existing.result_summary->>'version' !~ '^[1-9][0-9]{0,8}$'
    THEN RAISE EXCEPTION 'review resolution replay is invalid' USING ERRCODE = '23514'; END IF;
    PERFORM app_security.assert_m63_b3_command_authorization();
    RETURN QUERY SELECT sale.id, existing.id, sale.public_case_number,
      (existing.result_summary->>'status')::public.after_sale_status,
      (existing.result_summary->>'version')::integer, true;
    RETURN;
  END IF;
  SELECT current_sale.order_id INTO target_order_id FROM public.after_sales current_sale
  WHERE current_sale.store_id = scoped_store_id AND current_sale.id = p_after_sale_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'review resolution target not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'm62-refund:' || scoped_store_id::text || ':' || target_order_id::text, 0));
  PERFORM 1 FROM public.orders current_order
  WHERE current_order.store_id = scoped_store_id AND current_order.id = target_order_id FOR UPDATE;
  SELECT * INTO sale FROM public.after_sales current_sale
  WHERE current_sale.store_id = scoped_store_id AND current_sale.id = p_after_sale_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'review resolution target not found' USING ERRCODE = 'P0002'; END IF;
  IF sale.version <> p_expected_version THEN
    RAISE EXCEPTION 'after-sale expected version does not match' USING ERRCODE = '40001';
  END IF;
  IF sale.status <> 'REVIEW_REQUIRED' THEN
    RAISE EXCEPTION 'after-sale is not awaiting manual review' USING ERRCODE = '23514';
  END IF;

  IF p_decision IN ('LEGACY_APPROVE','LEGACY_REJECT') THEN
    IF NOT sale.legacy_policy_review OR sale.review_resume_status IS NOT NULL
       OR p_policy_basis_ciphertext IS NULL OR p_policy_basis_hash !~ '^[0-9a-f]{64}$'
       OR pg_catalog.length(p_policy_basis_ciphertext) > 10000
       OR EXISTS (SELECT 1 FROM public.after_sale_legacy_decisions decision
         WHERE decision.store_id = scoped_store_id AND decision.after_sale_id = sale.id)
    THEN RAISE EXCEPTION 'legacy review decision is invalid' USING ERRCODE = '23514'; END IF;
    IF p_decision = 'LEGACY_APPROVE' THEN
      IF sale.type IN ('RETURN_REFUND','EXCHANGE') THEN
        IF p_return_window_days NOT BETWEEN 1 AND 60
           OR p_return_shipping_payer NOT IN ('BUYER','MERCHANT','CONDITIONAL')
        THEN RAISE EXCEPTION 'legacy return terms are invalid' USING ERRCODE = '23514'; END IF;
        return_deadline := (((pg_catalog.clock_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
          + p_return_window_days + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh');
      ELSIF p_return_window_days IS NOT NULL OR p_return_shipping_payer IS NOT NULL THEN
        RAISE EXCEPTION 'non-return legacy decision cannot contain return terms'
          USING ERRCODE = '23514';
      END IF;
      PERFORM 1 FROM public.after_sale_items item
      JOIN public.order_items order_item ON order_item.store_id = item.store_id
        AND order_item.order_id = item.order_id AND order_item.id = item.order_item_id
      WHERE item.store_id = scoped_store_id AND item.after_sale_id = sale.id
      ORDER BY item.order_item_id FOR UPDATE OF item, order_item;
      UPDATE public.after_sale_items item
      SET approved_quantity = item.requested_quantity,
          approved_item_vnd = item.requested_item_vnd,
          replacement_quantity = CASE WHEN sale.type = 'EXCHANGE'
            THEN item.requested_quantity ELSE 0 END,
          updated_at = pg_catalog.clock_timestamp()
      WHERE item.store_id = scoped_store_id AND item.after_sale_id = sale.id;
      UPDATE public.after_sales current_sale
      SET approved_item_vnd = current_sale.requested_item_vnd,
          approved_shipping_vnd = current_sale.requested_shipping_vnd,
          approved_other_vnd = current_sale.requested_other_vnd,
          approved_total_vnd = current_sale.requested_total_vnd,
          return_deadline_at = return_deadline,
          review_reason = pg_catalog.btrim(p_reason), updated_at = pg_catalog.clock_timestamp()
      WHERE current_sale.store_id = scoped_store_id AND current_sale.id = sale.id;
      target_status := 'APPROVED'; transition_event := 'LEGACY_APPROVE';
    ELSE
      IF p_return_window_days IS NOT NULL OR p_return_shipping_payer IS NOT NULL THEN
        RAISE EXCEPTION 'legacy rejection cannot contain return terms' USING ERRCODE = '23514';
      END IF;
      UPDATE public.after_sales current_sale SET review_reason = pg_catalog.btrim(p_reason),
        updated_at = pg_catalog.clock_timestamp()
      WHERE current_sale.store_id = scoped_store_id AND current_sale.id = sale.id;
      target_status := 'REJECTED'; transition_event := 'LEGACY_REJECT';
    END IF;
    legacy_payload := pg_catalog.jsonb_build_object(
      'policy_basis_hash', p_policy_basis_hash,
      'return_shipping_payer', p_return_shipping_payer,
      'return_window_days', p_return_window_days
    );
    legacy_payload_hash := pg_catalog.encode(
      public.digest(pg_catalog.convert_to(legacy_payload::text, 'UTF8'), 'sha256'), 'hex');
    INSERT INTO public.after_sale_legacy_decisions
      (store_id, after_sale_id, decision, admin_id, reason,
        policy_basis_ciphertext, payload, payload_hash)
    VALUES (scoped_store_id, sale.id,
      CASE p_decision WHEN 'LEGACY_APPROVE' THEN 'APPROVE'::public.after_sale_legacy_decision_type
        ELSE 'REJECT'::public.after_sale_legacy_decision_type END,
      actor_id, pg_catalog.btrim(p_reason), p_policy_basis_ciphertext,
      legacy_payload, legacy_payload_hash);
  ELSE
    IF sale.legacy_policy_review OR p_policy_basis_ciphertext IS NOT NULL
       OR p_policy_basis_hash IS NOT NULL OR p_return_window_days IS NOT NULL
       OR p_return_shipping_payer IS NOT NULL OR sale.review_resume_status IS NULL
    THEN RAISE EXCEPTION 'ordinary manual review resolution is invalid' USING ERRCODE = '23514'; END IF;
    target_status := CASE p_decision WHEN 'RESUME' THEN sale.review_resume_status
      ELSE 'REJECTED'::public.after_sale_status END;
    transition_event := CASE p_decision WHEN 'RESUME' THEN 'RESUME_REVIEW'
      ELSE 'REJECT_REVIEW' END;
    UPDATE public.after_sales current_sale SET review_reason = pg_catalog.btrim(p_reason),
      updated_at = pg_catalog.clock_timestamp()
    WHERE current_sale.store_id = scoped_store_id AND current_sale.id = sale.id;
  END IF;

  INSERT INTO public.after_sale_operations
    (id, store_id, after_sale_id, operation, idempotency_key_hash, request_hash, updated_at)
  VALUES (p_operation_id, scoped_store_id, sale.id, 'ADMIN_RESOLVE_REVIEW',
    p_idempotency_key_hash, p_request_hash, pg_catalog.clock_timestamp());
  PERFORM app_security.assert_m63_b3_command_authorization();
  INSERT INTO public.after_sale_transitions
    (store_id, after_sale_id, operation_id, from_status, to_status, event,
      actor_type, actor_id, reason, correlation_id)
  VALUES (scoped_store_id, sale.id, p_operation_id, 'REVIEW_REQUIRED', target_status,
    transition_event, 'ADMIN', actor_id, pg_catalog.btrim(p_reason), correlation_id);
  SELECT * INTO sale FROM public.after_sales current_sale
  WHERE current_sale.store_id = scoped_store_id AND current_sale.id = p_after_sale_id;
  UPDATE public.after_sale_operations operation_row
  SET status = 'COMPLETED', result_summary = pg_catalog.jsonb_build_object(
      'after_sale_id',sale.id,'operation_id',p_operation_id,
      'public_case_number',sale.public_case_number,'status',sale.status,'version',sale.version),
      attempt_count = 1, version = operation_row.version + 1,
      updated_at = pg_catalog.clock_timestamp()
  WHERE operation_row.store_id = scoped_store_id AND operation_row.id = p_operation_id;
  INSERT INTO public.audit_logs
    (store_id, actor_type, actor_id, action, target_type, target_id,
      before_data, after_data, reason, correlation_id, source_ip)
  VALUES (scoped_store_id, 'ADMIN', actor_id, 'after-sale.review.resolved',
    'after_sale', sale.id::text,
    pg_catalog.jsonb_build_object('status','REVIEW_REQUIRED','version',p_expected_version),
    pg_catalog.jsonb_build_object('operation_id',p_operation_id,'decision',p_decision,
      'status',sale.status,'version',sale.version),
    pg_catalog.btrim(p_reason), correlation_id, p_source_ip);
  RETURN QUERY SELECT sale.id, p_operation_id, sale.public_case_number,
    sale.status, sale.version, false;
END
$$;

CREATE OR REPLACE FUNCTION "app_security"."expire_m63_b4_due_after_sales"(p_batch_size integer)
RETURNS TABLE (scanned integer, expired integer, skipped integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE actor_id uuid := app_security.current_actor_id();
DECLARE scoped_store_id uuid := app_security.current_store_id();
DECLARE correlation_id text := NULLIF(pg_catalog.current_setting('app.correlation_id', true), '');
DECLARE candidate record;
BEGIN
  scanned := 0; expired := 0; skipped := 0;
  IF pg_catalog.current_setting('app.actor_type', true) IS DISTINCT FROM 'system'
     OR pg_catalog.current_setting('app.system_scope', true)
       IS DISTINCT FROM 'after-sale-transition'
     OR actor_id IS NULL OR scoped_store_id IS NULL OR correlation_id IS NULL
     OR p_batch_size NOT BETWEEN 1 AND 500
  THEN RAISE EXCEPTION 'return expiration requires the dedicated SYSTEM scope'
    USING ERRCODE = '42501'; END IF;
  FOR candidate IN
    SELECT sale.id, sale.version FROM public.after_sales sale
    WHERE sale.store_id = scoped_store_id AND sale.status = 'APPROVED'
      AND sale.type IN ('RETURN_REFUND','EXCHANGE')
      AND sale.return_deadline_at IS NOT NULL
      AND sale.return_deadline_at <= pg_catalog.clock_timestamp()
    ORDER BY sale.return_deadline_at, sale.id
    FOR UPDATE SKIP LOCKED LIMIT p_batch_size
  LOOP
    scanned := scanned + 1;
    INSERT INTO public.after_sale_transitions
      (store_id, after_sale_id, from_status, to_status, event,
        actor_type, actor_id, reason, correlation_id)
    VALUES (scoped_store_id, candidate.id, 'APPROVED', 'REJECTED', 'RETURN_EXPIRED',
      'SYSTEM', actor_id, NULL, correlation_id);
    INSERT INTO public.audit_logs
      (store_id, actor_type, actor_id, action, target_type, target_id,
        before_data, after_data, reason, correlation_id)
    VALUES (scoped_store_id, 'SYSTEM', actor_id, 'after-sale.return.expired',
      'after_sale', candidate.id::text,
      pg_catalog.jsonb_build_object('status','APPROVED','version',candidate.version),
      pg_catalog.jsonb_build_object('status','REJECTED','version',candidate.version + 1),
      NULL, correlation_id);
    expired := expired + 1;
  END LOOP;
  RETURN NEXT;
END
$$;

REVOKE ALL ON FUNCTION
  "app_security"."validate_m63_b4_operation_completion"(),
  "app_security"."validate_m63_b4_command_atomicity"(),
  "app_security"."review_m63_b4_after_sale"(uuid,uuid,text,text,integer,text,jsonb,text,inet),
  "app_security"."resolve_m63_b4_after_sale_review"(uuid,uuid,text,text,integer,text,text,text,text,integer,text,inet),
  "app_security"."expire_m63_b4_due_after_sales"(integer)
FROM PUBLIC;
REVOKE ALL ON FUNCTION
  "app_security"."validate_m63_b4_operation_completion"(),
  "app_security"."validate_m63_b4_command_atomicity"()
FROM zalo_shop_runtime;
GRANT EXECUTE ON FUNCTION
  "app_security"."review_m63_b4_after_sale"(uuid,uuid,text,text,integer,text,jsonb,text,inet),
  "app_security"."resolve_m63_b4_after_sale_review"(uuid,uuid,text,text,integer,text,text,text,text,integer,text,inet),
  "app_security"."expire_m63_b4_due_after_sales"(integer)
TO zalo_shop_runtime;
