-- M6.3-B3 repository/local-test command boundary. This migration does not
-- authorize production rollout, provider integration, storage, or TTL policy.

-- B3 makes allowed_reason_codes mandatory and uses all three reason-code
-- arrays while resolving immutable policy snapshots. Never guess or rewrite
-- historical policy JSON: stop before the first schema change when any stored
-- payload cannot satisfy that additive contract.
DO $m63_b3_policy_payload_preflight$
BEGIN
  IF EXISTS (
    WITH historical_policy_payloads(payload) AS (
      SELECT policy.draft_payload
      FROM public.after_sale_policies AS policy
      UNION ALL
      SELECT version.payload
      FROM public.after_sale_policy_versions AS version
      UNION ALL
      SELECT snapshot.payload
      FROM public.order_item_after_sale_policy_snapshots AS snapshot
      UNION ALL
      SELECT sale.policy_snapshot
      FROM public.after_sales AS sale
      WHERE sale.policy_snapshot IS NOT NULL
    ), payload_rules AS (
      SELECT payload, payload -> 'condition_rules' AS rules
      FROM historical_policy_payloads
    )
    SELECT 1
    FROM payload_rules
    WHERE pg_catalog.jsonb_typeof(payload) IS DISTINCT FROM 'object'
       OR pg_catalog.jsonb_typeof(rules) IS DISTINCT FROM 'object'
       OR pg_catalog.jsonb_typeof(rules -> 'allowed_reason_codes')
            IS DISTINCT FROM 'array'
       OR pg_catalog.jsonb_typeof(rules -> 'evidence_required_reason_codes')
            IS DISTINCT FROM 'array'
       OR pg_catalog.jsonb_typeof(rules -> 'opened_package_exception_reason_codes')
            IS DISTINCT FROM 'array'
       OR CASE
            WHEN pg_catalog.jsonb_typeof(rules -> 'allowed_reason_codes') = 'array'
            THEN pg_catalog.jsonb_array_length(rules -> 'allowed_reason_codes')
              NOT BETWEEN 1 AND 64
            ELSE false
          END
       OR CASE
            WHEN pg_catalog.jsonb_typeof(rules -> 'evidence_required_reason_codes') = 'array'
            THEN pg_catalog.jsonb_array_length(rules -> 'evidence_required_reason_codes') > 64
            ELSE false
          END
       OR CASE
            WHEN pg_catalog.jsonb_typeof(
              rules -> 'opened_package_exception_reason_codes'
            ) = 'array'
            THEN pg_catalog.jsonb_array_length(
              rules -> 'opened_package_exception_reason_codes'
            ) > 64
            ELSE false
          END
       OR CASE
            WHEN pg_catalog.jsonb_typeof(rules -> 'allowed_reason_codes') = 'array'
            THEN EXISTS (
              SELECT 1
              FROM pg_catalog.jsonb_array_elements(
                rules -> 'allowed_reason_codes'
              ) AS reason(value)
              WHERE pg_catalog.jsonb_typeof(reason.value) IS DISTINCT FROM 'string'
                 OR pg_catalog.char_length(reason.value #>> '{}') NOT BETWEEN 1 AND 64
                 OR (reason.value #>> '{}') !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
            ) OR (
              SELECT pg_catalog.count(*) <> pg_catalog.count(DISTINCT reason.value)
              FROM pg_catalog.jsonb_array_elements(
                rules -> 'allowed_reason_codes'
              ) AS reason(value)
            )
            ELSE false
          END
       OR CASE
            WHEN pg_catalog.jsonb_typeof(
              rules -> 'evidence_required_reason_codes'
            ) = 'array'
            THEN EXISTS (
              SELECT 1
              FROM pg_catalog.jsonb_array_elements(
                rules -> 'evidence_required_reason_codes'
              ) AS reason(value)
              WHERE pg_catalog.jsonb_typeof(reason.value) IS DISTINCT FROM 'string'
                 OR pg_catalog.char_length(reason.value #>> '{}') NOT BETWEEN 1 AND 64
                 OR (reason.value #>> '{}') !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
            ) OR (
              SELECT pg_catalog.count(*) <> pg_catalog.count(DISTINCT reason.value)
              FROM pg_catalog.jsonb_array_elements(
                rules -> 'evidence_required_reason_codes'
              ) AS reason(value)
            )
            ELSE false
          END
       OR CASE
            WHEN pg_catalog.jsonb_typeof(
              rules -> 'opened_package_exception_reason_codes'
            ) = 'array'
            THEN EXISTS (
              SELECT 1
              FROM pg_catalog.jsonb_array_elements(
                rules -> 'opened_package_exception_reason_codes'
              ) AS reason(value)
              WHERE pg_catalog.jsonb_typeof(reason.value) IS DISTINCT FROM 'string'
                 OR pg_catalog.char_length(reason.value #>> '{}') NOT BETWEEN 1 AND 64
                 OR (reason.value #>> '{}') !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
            ) OR (
              SELECT pg_catalog.count(*) <> pg_catalog.count(DISTINCT reason.value)
              FROM pg_catalog.jsonb_array_elements(
                rules -> 'opened_package_exception_reason_codes'
              ) AS reason(value)
            )
            ELSE false
          END
       OR CASE
            WHEN pg_catalog.jsonb_typeof(rules -> 'allowed_reason_codes') = 'array'
             AND pg_catalog.jsonb_typeof(
               rules -> 'evidence_required_reason_codes'
             ) = 'array'
            THEN EXISTS (
              SELECT 1
              FROM pg_catalog.jsonb_array_elements(
                rules -> 'evidence_required_reason_codes'
              ) AS required_reason(value)
              WHERE NOT EXISTS (
                SELECT 1
                FROM pg_catalog.jsonb_array_elements(
                  rules -> 'allowed_reason_codes'
                ) AS allowed_reason(value)
                WHERE allowed_reason.value = required_reason.value
              )
            )
            ELSE false
          END
       OR CASE
            WHEN pg_catalog.jsonb_typeof(rules -> 'allowed_reason_codes') = 'array'
             AND pg_catalog.jsonb_typeof(
               rules -> 'opened_package_exception_reason_codes'
             ) = 'array'
            THEN EXISTS (
              SELECT 1
              FROM pg_catalog.jsonb_array_elements(
                rules -> 'opened_package_exception_reason_codes'
              ) AS exception_reason(value)
              WHERE NOT EXISTS (
                SELECT 1
                FROM pg_catalog.jsonb_array_elements(
                  rules -> 'allowed_reason_codes'
                ) AS allowed_reason(value)
                WHERE allowed_reason.value = exception_reason.value
              )
            )
            ELSE false
          END
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'M6.3-B3 historical policy payload preflight failed'
      USING ERRCODE = '55000';
  END IF;
END
$m63_b3_policy_payload_preflight$;

ALTER TABLE "after_sale_transitions"
  ADD COLUMN "operation_id" UUID;

ALTER TABLE "after_sale_operations"
  ADD CONSTRAINT "after_sale_operations_store_id_id_after_sale_id_key"
  UNIQUE ("store_id", "id", "after_sale_id");

ALTER TABLE "after_sale_transitions"
  ADD CONSTRAINT "after_sale_transitions_operation_fkey"
  FOREIGN KEY ("store_id", "operation_id", "after_sale_id")
  REFERENCES "after_sale_operations"("store_id", "id", "after_sale_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "after_sale_transitions_one_submit_per_case_key"
  ON "after_sale_transitions"("store_id", "after_sale_id")
  WHERE "event" = 'SUBMIT';

-- Approval preparation historically mutates item/header/allocation facts
-- before appending its transition. Acquire the shared order lock in the first
-- affected row trigger. A non-blocking attempt is required here because the
-- target row is already locked before a BEFORE ROW trigger runs: if B3 owns
-- the advisory lock and is waiting for that row, aborting with 40001 releases
-- the row and lets the caller retry without a row<->advisory deadlock.
CREATE OR REPLACE FUNCTION
  "app_security"."guard_m63_b3_approval_mutation_order_scope"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE approval_order_id uuid;
BEGIN
  IF pg_catalog.current_setting('app.actor_type', true) IS DISTINCT FROM 'admin'
     OR NEW.store_id IS DISTINCT FROM app_security.current_store_id()
     OR NOT EXISTS (
       SELECT 1 FROM public.admin_users admin
       WHERE admin.id = app_security.current_actor_id()
     )
  THEN
    RAISE EXCEPTION 'after-sale approval requires the current administrator'
      USING ERRCODE = '42501';
  END IF;

  IF TG_TABLE_SCHEMA <> 'public' THEN
    RAISE EXCEPTION 'M6.3-B3 approval lock guard is attached outside public'
      USING ERRCODE = '55000';
  ELSIF TG_TABLE_NAME IN (
    'after_sale_items', 'after_sales', 'after_sale_order_allocations'
  ) THEN
    approval_order_id := NEW.order_id;
  ELSIF TG_TABLE_NAME = 'after_sale_legacy_decisions' THEN
    SELECT sale.order_id INTO approval_order_id
    FROM public.after_sales AS sale
    WHERE sale.store_id = NEW.store_id AND sale.id = NEW.after_sale_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'after-sale approval aggregate does not exist'
        USING ERRCODE = '23503';
    END IF;
  ELSE
    RAISE EXCEPTION 'M6.3-B3 approval lock guard has an unsupported attachment'
      USING ERRCODE = '55000';
  END IF;

  IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
    'm62-refund:' || NEW.store_id::text || ':' || approval_order_id::text, 0
  )) THEN
    RAISE EXCEPTION 'after-sale approval order scope is concurrently locked'
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "after_sale_items_a_b3_approval_order_lock_guard"
  BEFORE UPDATE OF "approved_quantity", "approved_item_vnd",
    "replacement_quantity", "replacement_sku_id"
  ON "after_sale_items"
  FOR EACH ROW
  WHEN (
    OLD.approved_quantity IS DISTINCT FROM NEW.approved_quantity
    OR OLD.approved_item_vnd IS DISTINCT FROM NEW.approved_item_vnd
    OR OLD.replacement_quantity IS DISTINCT FROM NEW.replacement_quantity
    OR OLD.replacement_sku_id IS DISTINCT FROM NEW.replacement_sku_id
  )
  EXECUTE FUNCTION
    "app_security"."guard_m63_b3_approval_mutation_order_scope"();

CREATE TRIGGER "after_sales_a_b3_approval_order_lock_guard"
  BEFORE UPDATE OF "approved_item_vnd", "approved_shipping_vnd",
    "approved_other_vnd", "approved_total_vnd", "return_deadline_at"
  ON "after_sales"
  FOR EACH ROW
  WHEN (
    OLD.approved_item_vnd IS DISTINCT FROM NEW.approved_item_vnd
    OR OLD.approved_shipping_vnd IS DISTINCT FROM NEW.approved_shipping_vnd
    OR OLD.approved_other_vnd IS DISTINCT FROM NEW.approved_other_vnd
    OR OLD.approved_total_vnd IS DISTINCT FROM NEW.approved_total_vnd
    OR OLD.return_deadline_at IS DISTINCT FROM NEW.return_deadline_at
  )
  EXECUTE FUNCTION
    "app_security"."guard_m63_b3_approval_mutation_order_scope"();

CREATE TRIGGER "after_sale_order_allocations_a_b3_approval_order_lock_guard"
  BEFORE INSERT ON "after_sale_order_allocations"
  FOR EACH ROW EXECUTE FUNCTION
    "app_security"."guard_m63_b3_approval_mutation_order_scope"();

CREATE TRIGGER "after_sale_legacy_decisions_a_b3_approval_order_lock_guard"
  BEFORE INSERT ON "after_sale_legacy_decisions"
  FOR EACH ROW
  WHEN (NEW.decision = 'APPROVE')
  EXECUTE FUNCTION
    "app_security"."guard_m63_b3_approval_mutation_order_scope"();

REVOKE ALL ON FUNCTION
  "app_security"."guard_m63_b3_approval_mutation_order_scope"()
  FROM PUBLIC, zalo_shop_runtime;

-- A transition-only approval has not locked an aggregate row yet. Its trigger
-- is deliberately named before the B0 contract guard, so the blocking order
-- lock is safe. Full approval flows already hold it reentrantly through the
-- mutation guards above.
CREATE OR REPLACE FUNCTION "app_security"."lock_m63_b3_approval_order_scope"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE approval_order_id uuid;
BEGIN
  IF NEW.event NOT IN ('APPROVE','LEGACY_APPROVE') THEN RETURN NEW; END IF;
  IF pg_catalog.current_setting('app.actor_type', true) IS DISTINCT FROM 'admin'
     OR NEW.store_id IS DISTINCT FROM app_security.current_store_id()
     OR NOT EXISTS (
       SELECT 1 FROM public.admin_users admin
       WHERE admin.id = app_security.current_actor_id()
     )
  THEN
    RAISE EXCEPTION 'after-sale approval requires the current administrator'
      USING ERRCODE = '42501';
  END IF;
  SELECT sale.order_id INTO approval_order_id
  FROM public.after_sales sale
  WHERE sale.store_id = NEW.store_id AND sale.id = NEW.after_sale_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'after-sale approval aggregate does not exist' USING ERRCODE = '23503';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'm62-refund:' || NEW.store_id::text || ':' || approval_order_id::text, 0));
  RETURN NEW;
END
$$;
CREATE TRIGGER "after_sale_transitions_a_b3_approval_order_lock_guard"
  BEFORE INSERT ON "after_sale_transitions"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."lock_m63_b3_approval_order_scope"();
REVOKE ALL ON FUNCTION "app_security"."lock_m63_b3_approval_order_scope"()
  FROM PUBLIC, zalo_shop_runtime;

CREATE OR REPLACE FUNCTION "app_security"."assert_m63_b3_command_authorization"()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET row_security = on
AS $$
DECLARE caller_actor_id uuid;
DECLARE actor_text text := NULLIF(pg_catalog.current_setting('app.actor_id', true), '');
DECLARE actor_type text := pg_catalog.current_setting('app.actor_type', true);
DECLARE authorization_scope text := pg_catalog.current_setting(
  'app.admin_authorization_scope', true
);
DECLARE correlation_id text := NULLIF(
  pg_catalog.current_setting('app.correlation_id', true), ''
);
DECLARE locked_id uuid;
DECLARE locked_mfa_verified_at timestamptz;
DECLARE locked_session_expires_at timestamptz;
DECLARE caller_session_id uuid;
DECLARE session_text text := NULLIF(
  pg_catalog.current_setting('app.access_session_id', true), ''
);
DECLARE caller_store_id uuid;
DECLARE store_text text := NULLIF(pg_catalog.current_setting('app.store_id', true), '');
DECLARE token_expires_at timestamptz;
DECLARE token_expires_text text := NULLIF(
  pg_catalog.current_setting('app.access_token_expires_at', true), ''
);
DECLARE validation_time timestamptz;
BEGIN
  IF actor_text IS NULL OR actor_type NOT IN ('member','admin')
     OR correlation_id IS NULL OR session_text IS NULL OR store_text IS NULL
     OR token_expires_text IS NULL
  THEN
    RAISE EXCEPTION 'B3 command authorization is no longer valid'
      USING ERRCODE = '42501';
  END IF;

  BEGIN
    caller_actor_id := actor_text::uuid;
    caller_session_id := session_text::uuid;
    caller_store_id := store_text::uuid;
    token_expires_at := token_expires_text::timestamptz;
  EXCEPTION
    WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN
      RAISE EXCEPTION 'B3 command authorization is no longer valid'
        USING ERRCODE = '42501';
  END;

  validation_time := pg_catalog.clock_timestamp();
  IF validation_time >= token_expires_at THEN
    RAISE EXCEPTION 'B3 command authorization is no longer valid'
      USING ERRCODE = '42501';
  END IF;

  SELECT store.id INTO locked_id
  FROM public.stores store
  WHERE store.id = caller_store_id AND store.status = 'ACTIVE'
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'B3 command authorization is no longer valid'
      USING ERRCODE = '42501';
  END IF;

  IF actor_type = 'member' THEN
    SELECT member.id INTO locked_id
    FROM public.members member
    WHERE member.store_id = caller_store_id
      AND member.id = caller_actor_id
      AND member.status = 'ACTIVE'
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'B3 command authorization is no longer valid'
        USING ERRCODE = '42501';
    END IF;

    SELECT session.expires_at INTO locked_session_expires_at
    FROM public.member_sessions session
    WHERE session.store_id = caller_store_id
      AND session.id = caller_session_id
      AND session.member_id = caller_actor_id
      AND session.revoked_at IS NULL
      AND session.expires_at > validation_time
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'B3 command authorization is no longer valid'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    SELECT admin.id INTO locked_id
    FROM public.admin_users admin
    WHERE admin.id = caller_actor_id AND admin.status = 'ACTIVE'
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'B3 command authorization is no longer valid'
        USING ERRCODE = '42501';
    END IF;

    SELECT session.expires_at, session.mfa_verified_at
    INTO locked_session_expires_at, locked_mfa_verified_at
    FROM public.admin_sessions session
    WHERE session.id = caller_session_id
      AND session.admin_user_id = caller_actor_id
      AND session.revoked_at IS NULL
      AND session.expires_at > validation_time
      AND session.mfa_verified_at >= validation_time - INTERVAL '10 minutes'
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'B3 command authorization is no longer valid'
        USING ERRCODE = '42501';
    END IF;

    -- B3 merchant-refund writes require a direct role in the target store.
    -- The existing CROSS_STORE context proves platform traversal only and
    -- cannot represent the required conjunction with target-store review.
    IF authorization_scope IS DISTINCT FROM 'STORE' THEN
      RAISE EXCEPTION 'B3 command authorization is no longer valid'
        USING ERRCODE = '42501';
    END IF;

    SELECT assignment.role_id INTO locked_id
    FROM public.admin_store_roles assignment
    JOIN public.store_role_permissions role_permission
      ON role_permission.store_id = assignment.store_id
     AND role_permission.role_id = assignment.role_id
    WHERE assignment.store_id = caller_store_id
      AND assignment.admin_user_id = caller_actor_id
      AND role_permission.permission_code = 'store.after-sales.review'
    ORDER BY assignment.role_id
    LIMIT 1
    FOR SHARE OF assignment, role_permission;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'B3 command authorization is no longer valid'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  validation_time := pg_catalog.clock_timestamp();
  IF validation_time >= token_expires_at
     OR validation_time >= locked_session_expires_at
     OR (actor_type = 'admin'
       AND locked_mfa_verified_at < validation_time - INTERVAL '10 minutes')
  THEN
    RAISE EXCEPTION 'B3 command authorization is no longer valid'
      USING ERRCODE = '42501';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION "app_security"."validate_m63_b3_command_facts"(
  p_after_sale_id uuid
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET row_security = on
AS $$
DECLARE active_refund_vnd bigint;
DECLARE occupied_after_sale_vnd bigint;
DECLARE occupied_after_sale_shipping_vnd bigint;
DECLARE occupied_after_sale_other_vnd bigint;
DECLARE order_record record;
DECLARE sale record;
DECLARE initial_order_id uuid;
DECLARE scoped_store_id uuid := app_security.current_store_id();
DECLARE submitted_item_count bigint;
DECLARE submitted_item_vnd bigint;
DECLARE submitted_shipping_vnd bigint;
DECLARE submitted_other_vnd bigint;
DECLARE paid_shipping_vnd bigint;
BEGIN
  SELECT current_sale.order_id INTO initial_order_id
  FROM public.after_sales current_sale
  WHERE current_sale.store_id = scoped_store_id AND current_sale.id = p_after_sale_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'B3 command facts are not eligible for submission'
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'm62-refund:' || scoped_store_id::text || ':' || initial_order_id::text, 0));
  SELECT * INTO sale
  FROM public.after_sales current_sale
  WHERE current_sale.store_id = scoped_store_id AND current_sale.id = p_after_sale_id
  FOR UPDATE;
  IF NOT FOUND OR sale.order_id IS DISTINCT FROM initial_order_id THEN
    RAISE EXCEPTION 'B3 command facts are not eligible for submission'
      USING ERRCODE = '23514';
  END IF;
  SELECT current_order.* INTO order_record
  FROM public.orders current_order
  WHERE current_order.store_id = sale.store_id
    AND current_order.id = sale.order_id
    AND current_order.member_id = sale.member_id
  FOR UPDATE;
  IF NOT FOUND
     OR order_record.status NOT IN ('DELIVERED','COMPLETED')
     OR order_record.currency <> 'VND'
     OR order_record.payment_method <> 'ONLINE'
     OR order_record.payment_status NOT IN ('SUCCEEDED','PARTIALLY_REFUNDED')
  THEN
    RAISE EXCEPTION 'B3 command facts are not eligible for submission'
      USING ERRCODE = '23514';
  END IF;

  PERFORM 1 FROM public.payment_attempts attempt
  WHERE attempt.store_id = sale.store_id AND attempt.order_id = sale.order_id
  ORDER BY attempt.id
  FOR SHARE;
  IF 1 <> (
    SELECT pg_catalog.count(*)
    FROM public.payment_attempts attempt
    WHERE attempt.store_id = sale.store_id
      AND attempt.order_id = sale.order_id
      AND attempt.status = 'SUCCEEDED'
      AND attempt.currency = 'VND'
      AND attempt.amount_vnd = order_record.payable_vnd
      AND attempt.succeeded_at IS NOT NULL
      AND NULLIF(pg_catalog.btrim(attempt.provider_transaction_id), '') IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'B3 command facts are not eligible for submission'
      USING ERRCODE = '23514';
  END IF;

  SELECT pg_catalog.count(*), COALESCE(pg_catalog.sum(item.requested_item_vnd), 0)
  INTO submitted_item_count, submitted_item_vnd
  FROM public.after_sale_items item
  WHERE item.store_id = sale.store_id AND item.after_sale_id = sale.id;
  submitted_shipping_vnd := sale.requested_shipping_vnd;
  submitted_other_vnd := sale.requested_other_vnd;
  paid_shipping_vnd := GREATEST(
    order_record.shipping_fee_vnd + order_record.remote_surcharge_vnd
      - order_record.shipping_discount_vnd,
    0::bigint
  );
  IF submitted_item_count < 1
     OR submitted_item_vnd < 0
     OR submitted_item_vnd <> sale.requested_item_vnd
     OR submitted_shipping_vnd < 0
     OR submitted_other_vnd <> 0
     OR submitted_shipping_vnd > paid_shipping_vnd
     OR sale.requested_total_vnd <> submitted_item_vnd + submitted_shipping_vnd + submitted_other_vnd
     OR sale.approved_item_vnd <> 0
     OR sale.approved_shipping_vnd <> 0
     OR sale.approved_other_vnd <> 0
     OR sale.approved_total_vnd <> 0
     OR sale.review_resume_status IS NOT NULL
     OR sale.review_reason IS NOT NULL
     OR sale.return_deadline_at IS NOT NULL
     OR sale.return_expired_at IS NOT NULL
     OR sale.reviewed_by IS NOT NULL
     OR sale.reviewed_at IS NOT NULL
     OR sale.completed_at IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM public.after_sale_items item
       WHERE item.store_id = sale.store_id AND item.after_sale_id = sale.id
         AND (item.approved_quantity <> 0 OR item.received_quantity <> 0
           OR item.accepted_quantity <> 0 OR item.rejected_quantity <> 0
           OR item.restockable_quantity <> 0 OR item.restored_quantity <> 0
           OR item.approved_item_vnd <> 0 OR item.inspection_version <> 0
           OR item.condition IS NOT NULL OR item.disposition IS NOT NULL
           OR item.inspected_by IS NOT NULL)
     )
  THEN
    RAISE EXCEPTION 'B3 command facts are not eligible for submission'
      USING ERRCODE = '23514';
  END IF;

  -- A provider refund already linked to an after-sale settlement represents
  -- the same entitlement as that aggregate and must not be counted twice.
  -- Lock linked rows first, then the remaining direct refunds, matching the
  -- repository primitive's order under the shared per-order advisory lock.
  PERFORM 1
  FROM public.after_sale_refunds linked
  JOIN public.refunds refund
    ON refund.store_id = linked.store_id AND refund.id = linked.refund_id
  WHERE refund.store_id = sale.store_id AND refund.order_id = sale.order_id
  ORDER BY linked.refund_id
  FOR SHARE OF linked, refund;
  PERFORM 1
  FROM public.refunds refund
  WHERE refund.store_id = sale.store_id
    AND refund.order_id = sale.order_id
    AND NOT EXISTS (
      SELECT 1 FROM public.after_sale_refunds linked
      WHERE linked.store_id = refund.store_id AND linked.refund_id = refund.id
    )
  ORDER BY refund.id
  FOR SHARE OF refund;
  SELECT COALESCE(pg_catalog.sum(refund.amount_vnd), 0)
  INTO active_refund_vnd
  FROM public.refunds refund
  WHERE refund.store_id = sale.store_id
    AND refund.order_id = sale.order_id
    AND refund.status IN ('REQUESTED','PROCESSING','SUCCEEDED','REVIEW_REQUIRED')
    AND NOT EXISTS (
      SELECT 1 FROM public.after_sale_refunds linked
      WHERE linked.store_id = refund.store_id AND linked.refund_id = refund.id
    );

  PERFORM 1
  FROM public.after_sale_items item
  JOIN public.after_sales existing_sale
    ON existing_sale.store_id = item.store_id AND existing_sale.id = item.after_sale_id
  WHERE existing_sale.store_id = sale.store_id
    AND existing_sale.order_id = sale.order_id
    AND existing_sale.id <> sale.id
  ORDER BY existing_sale.id, item.id
  FOR SHARE OF existing_sale, item;
  SELECT COALESCE(pg_catalog.sum(CASE
    WHEN existing_sale.status = 'PENDING_REVIEW'
      OR (existing_sale.status = 'REVIEW_REQUIRED'
        AND existing_sale.legacy_policy_review
        AND existing_sale.review_resume_status IS NULL)
    THEN item.requested_item_vnd ELSE item.approved_item_vnd END), 0)
  INTO occupied_after_sale_vnd
  FROM public.after_sale_items item
  JOIN public.after_sales existing_sale
    ON existing_sale.store_id = item.store_id AND existing_sale.id = item.after_sale_id
  WHERE existing_sale.store_id = sale.store_id
    AND existing_sale.order_id = sale.order_id
    AND existing_sale.id <> sale.id
    AND (
      existing_sale.status NOT IN ('REJECTED','CANCELLED')
      OR EXISTS (SELECT 1 FROM public.after_sale_inspections inspection
        WHERE inspection.store_id = existing_sale.store_id
          AND inspection.after_sale_id = existing_sale.id)
      OR EXISTS (SELECT 1 FROM public.after_sale_settlements settlement
        WHERE settlement.store_id = existing_sale.store_id
          AND settlement.after_sale_id = existing_sale.id)
      OR EXISTS (SELECT 1 FROM public.after_sale_inventory_actions inventory_action
        WHERE inventory_action.store_id = existing_sale.store_id
          AND inventory_action.after_sale_id = existing_sale.id)
      OR EXISTS (SELECT 1 FROM public.exchange_fulfillments fulfillment
        WHERE fulfillment.store_id = existing_sale.store_id
          AND fulfillment.after_sale_id = existing_sale.id)
    );
  SELECT COALESCE(pg_catalog.sum(CASE
      WHEN existing_sale.status = 'PENDING_REVIEW'
        OR (existing_sale.status = 'REVIEW_REQUIRED'
          AND existing_sale.legacy_policy_review
          AND existing_sale.review_resume_status IS NULL)
      THEN existing_sale.requested_shipping_vnd
      ELSE existing_sale.approved_shipping_vnd
    END), 0),
    COALESCE(pg_catalog.sum(CASE
      WHEN existing_sale.status = 'PENDING_REVIEW'
        OR (existing_sale.status = 'REVIEW_REQUIRED'
          AND existing_sale.legacy_policy_review
          AND existing_sale.review_resume_status IS NULL)
      THEN existing_sale.requested_other_vnd
      ELSE existing_sale.approved_other_vnd
    END), 0)
  INTO occupied_after_sale_shipping_vnd, occupied_after_sale_other_vnd
  FROM public.after_sales existing_sale
  WHERE existing_sale.store_id = sale.store_id
    AND existing_sale.order_id = sale.order_id
    AND existing_sale.id <> sale.id
    AND (
      existing_sale.status NOT IN ('REJECTED','CANCELLED')
      OR EXISTS (SELECT 1 FROM public.after_sale_inspections inspection
        WHERE inspection.store_id = existing_sale.store_id
          AND inspection.after_sale_id = existing_sale.id)
      OR EXISTS (SELECT 1 FROM public.after_sale_settlements settlement
        WHERE settlement.store_id = existing_sale.store_id
          AND settlement.after_sale_id = existing_sale.id)
      OR EXISTS (SELECT 1 FROM public.after_sale_inventory_actions inventory_action
        WHERE inventory_action.store_id = existing_sale.store_id
          AND inventory_action.after_sale_id = existing_sale.id)
      OR EXISTS (SELECT 1 FROM public.exchange_fulfillments fulfillment
        WHERE fulfillment.store_id = existing_sale.store_id
          AND fulfillment.after_sale_id = existing_sale.id)
    );
  IF active_refund_vnd + occupied_after_sale_vnd + occupied_after_sale_shipping_vnd
       + occupied_after_sale_other_vnd
       + sale.requested_total_vnd
       > order_record.payable_vnd
  THEN
    RAISE EXCEPTION 'B3 command facts are not eligible for submission'
      USING ERRCODE = '23514';
  END IF;

  IF sale.legacy_policy_review THEN
    IF sale.policy_snapshot IS NOT NULL OR sale.policy_hash IS NOT NULL
       OR sale.policy_id IS NOT NULL OR sale.policy_version_id IS NOT NULL
       OR sale.source <> 'MEMBER'
       OR sale.type NOT IN ('REFUND_ONLY','RETURN_REFUND','EXCHANGE')
       OR sale.requested_shipping_vnd <> 0
       OR EXISTS (
         SELECT 1
         FROM public.after_sale_items item
         JOIN public.order_item_after_sale_policy_snapshots snapshot
           ON snapshot.store_id = item.store_id
          AND snapshot.order_id = item.order_id
          AND snapshot.order_item_id = item.order_item_id
         WHERE item.store_id = sale.store_id AND item.after_sale_id = sale.id
       )
    THEN
      RAISE EXCEPTION 'B3 command facts are not eligible for submission'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF jsonb_typeof(sale.policy_snapshot) <> 'object'
       OR NOT COALESCE(sale.policy_snapshot->'allowed_types' ? sale.type::text, false)
       OR NOT COALESCE(sale.policy_snapshot#>'{condition_rules,allowed_reason_codes}'
         ? sale.reason_code, false)
       OR COALESCE((sale.policy_snapshot->>'hygiene_restricted')::boolean, true)
       OR COALESCE((sale.policy_snapshot->>'unopened_required')::boolean, true)
       OR COALESCE(sale.policy_snapshot->>'return_shipping_payer', '')
         NOT IN ('BUYER','MERCHANT','CONDITIONAL')
       OR sale.policy_snapshot->>'return_shipping_payer' = 'CONDITIONAL'
       OR (
         sale.type IN ('RETURN_REFUND','EXCHANGE')
         AND sale.policy_snapshot->>'return_shipping_payer' = 'MERCHANT'
         AND (
           (paid_shipping_vnd = 0 AND sale.requested_shipping_vnd <> 0)
           OR (paid_shipping_vnd > 0 AND (
             occupied_after_sale_shipping_vnd <> 0
             OR sale.requested_shipping_vnd <> paid_shipping_vnd
           ))
         )
       )
       OR (
         NOT (
           sale.type IN ('RETURN_REFUND','EXCHANGE')
           AND sale.policy_snapshot->>'return_shipping_payer' = 'MERCHANT'
         )
         AND sale.requested_shipping_vnd <> 0
       )
       OR EXISTS (
         SELECT 1
         FROM public.after_sale_items item
         JOIN public.order_items order_item
           ON order_item.store_id = item.store_id
          AND order_item.order_id = item.order_id
          AND order_item.id = item.order_item_id
         LEFT JOIN LATERAL (
           SELECT pg_catalog.count(*) AS shipment_count,
             pg_catalog.count(DISTINCT shipment.id) AS distinct_shipment_count,
             COALESCE(pg_catalog.sum(shipment_item.quantity), 0) AS delivered_quantity,
             COALESCE(pg_catalog.bool_and(
               shipment.status = 'DELIVERED' AND shipment.delivered_at IS NOT NULL
             ), false) AS delivery_complete,
             pg_catalog.max(shipment.delivered_at) AS delivered_at
           FROM public.shipment_items shipment_item
           JOIN public.shipments shipment
             ON shipment.store_id = shipment_item.store_id
            AND shipment.id = shipment_item.shipment_id
            AND shipment.order_id = shipment_item.order_id
           WHERE shipment_item.store_id = item.store_id
             AND shipment_item.order_id = item.order_id
             AND shipment_item.order_item_id = item.order_item_id
             AND shipment.purpose = 'ORDER_OUTBOUND'
         ) delivery ON true
         WHERE item.store_id = sale.store_id AND item.after_sale_id = sale.id
           AND (delivery.shipment_count = 0
             OR delivery.shipment_count <> delivery.distinct_shipment_count
             OR delivery.delivered_quantity <> order_item.quantity
             OR NOT delivery.delivery_complete
             OR pg_catalog.clock_timestamp() >= (
               ((delivery.delivered_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
                 + ((sale.policy_snapshot->>'request_window_days')::integer + 1))::timestamp
                 AT TIME ZONE 'Asia/Ho_Chi_Minh'
             ))
       )
    THEN
      RAISE EXCEPTION 'B3 command facts are not eligible for submission'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF sale.type = 'EXCHANGE' THEN
    IF sale.legacy_policy_review
       OR NULLIF(pg_catalog.btrim(sale.policy_snapshot->>'exchange_attribute_code'), '') IS NULL
       OR EXISTS (
         SELECT 1
         FROM public.after_sale_items item
         JOIN public.order_items original_item
           ON original_item.store_id = item.store_id
          AND original_item.order_id = item.order_id
          AND original_item.id = item.order_item_id
         LEFT JOIN public.skus replacement
           ON replacement.store_id = item.store_id AND replacement.id = item.replacement_sku_id
         WHERE item.store_id = sale.store_id AND item.after_sale_id = sale.id
           AND (item.replacement_sku_id IS NULL
             OR replacement.id IS NULL OR replacement.status <> 'ACTIVE'
             OR replacement.product_id <> original_item.product_id
             OR replacement.id = original_item.sku_id
             OR replacement.sale_price_vnd <> original_item.unit_price_vnd
             OR jsonb_typeof(original_item.option_snapshot) <> 'array'
             OR jsonb_array_length(original_item.option_snapshot) = 0
             OR EXISTS (
               SELECT 1
               FROM jsonb_array_elements(original_item.option_snapshot) original_option
               LEFT JOIN public.attribute_definitions definition
                 ON definition.store_id = item.store_id
                AND definition.id = COALESCE(
                  original_option->>'attributeDefinitionId',
                  original_option->>'attribute_definition_id'
                )::uuid
               LEFT JOIN public.sku_option_values replacement_option
                 ON replacement_option.store_id = item.store_id
                AND replacement_option.sku_id = replacement.id
                AND replacement_option.attribute_definition_id = definition.id
               WHERE definition.id IS NULL OR replacement_option.sku_id IS NULL
                 OR (definition.code = sale.policy_snapshot->>'exchange_attribute_code'
                   AND replacement_option.option_id::text = COALESCE(
                     original_option->>'optionId', original_option->>'option_id'))
                 OR (definition.code <> sale.policy_snapshot->>'exchange_attribute_code'
                   AND replacement_option.option_id::text <> COALESCE(
                     original_option->>'optionId', original_option->>'option_id'))
             )
             OR EXISTS (
               SELECT 1 FROM public.sku_option_values replacement_option
               WHERE replacement_option.store_id = item.store_id
                 AND replacement_option.sku_id = replacement.id
                 AND NOT EXISTS (
                   SELECT 1 FROM jsonb_array_elements(original_item.option_snapshot)
                     original_option
                   WHERE COALESCE(original_option->>'attributeDefinitionId',
                     original_option->>'attribute_definition_id') =
                       replacement_option.attribute_definition_id::text
                 )
             )
             OR NOT EXISTS (
               SELECT 1
               FROM jsonb_array_elements(original_item.option_snapshot) original_option
               JOIN public.attribute_definitions definition
                 ON definition.store_id = item.store_id
                AND definition.id = COALESCE(
                  original_option->>'attributeDefinitionId',
                  original_option->>'attribute_definition_id'
                )::uuid
               WHERE definition.code = sale.policy_snapshot->>'exchange_attribute_code'
             ))
       )
    THEN
      RAISE EXCEPTION 'B3 command facts are not eligible for submission'
        USING ERRCODE = '23514';
    END IF;
  ELSIF EXISTS (
    SELECT 1 FROM public.after_sale_items item
    WHERE item.store_id = sale.store_id AND item.after_sale_id = sale.id
      AND item.replacement_sku_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'B3 command facts are not eligible for submission'
      USING ERRCODE = '23514';
  END IF;
END
$$;

-- SUBMIT creates history for an already-initialized PENDING_REVIEW header. It
-- is therefore validated separately and must not project the header to itself.
DROP TRIGGER "after_sale_transitions_b0_contract_guard" ON "after_sale_transitions";
CREATE TRIGGER "after_sale_transitions_b0_contract_guard"
  BEFORE INSERT ON "after_sale_transitions"
  FOR EACH ROW
  WHEN (NEW.event <> 'SUBMIT')
  EXECUTE FUNCTION "app_security"."validate_m63_b0_transition_contract"();

DROP TRIGGER "after_sale_transitions_state_guard" ON "after_sale_transitions";
CREATE TRIGGER "after_sale_transitions_state_guard"
  BEFORE INSERT ON "after_sale_transitions"
  FOR EACH ROW
  WHEN (NEW.actor_type = 'ADMIN' AND NEW.event <> 'SUBMIT')
  EXECUTE FUNCTION "app_security"."validate_m62_after_sale_transition"();

DROP TRIGGER "after_sale_transitions_member_state_guard" ON "after_sale_transitions";
CREATE TRIGGER "after_sale_transitions_member_state_guard"
  BEFORE INSERT ON "after_sale_transitions"
  FOR EACH ROW
  WHEN (NEW.actor_type = 'MEMBER' AND NEW.event <> 'SUBMIT')
  EXECUTE FUNCTION "app_security"."validate_m63_b0_member_transition"();

DROP TRIGGER "after_sale_transitions_apply_state" ON "after_sale_transitions";
CREATE TRIGGER "after_sale_transitions_apply_state"
  AFTER INSERT ON "after_sale_transitions"
  FOR EACH ROW
  WHEN (NEW.event <> 'SUBMIT')
  EXECUTE FUNCTION "app_security"."apply_m62_after_sale_transition"();

CREATE OR REPLACE FUNCTION "app_security"."validate_m63_b3_submit_transition"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE actor_context text := pg_catalog.current_setting('app.actor_type', true);
DECLARE sale record;
DECLARE operation_record record;
BEGIN
  IF NEW.event <> 'SUBMIT' THEN
    RETURN NEW;
  END IF;
  IF NEW.operation_id IS NULL
     OR NEW.from_status IS NOT NULL
     OR NEW.to_status NOT IN ('PENDING_REVIEW','REVIEW_REQUIRED')
     OR NEW.store_id IS DISTINCT FROM app_security.current_store_id()
     OR NEW.actor_id IS DISTINCT FROM app_security.current_actor_id()
     OR NEW.correlation_id IS DISTINCT FROM
       NULLIF(pg_catalog.current_setting('app.correlation_id', true), '')
     OR actor_context NOT IN ('member','admin')
     OR NEW.actor_type::text IS DISTINCT FROM pg_catalog.upper(actor_context)
  THEN
    RAISE EXCEPTION 'SUBMIT is outside the current actor or creation contract'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO sale
  FROM public.after_sales current_sale
  WHERE current_sale.store_id = NEW.store_id
    AND current_sale.id = NEW.after_sale_id
  FOR UPDATE;
  IF NOT FOUND
     OR sale.version <> 1
     OR NOT (
       (NOT sale.legacy_policy_review
         AND sale.status = 'PENDING_REVIEW' AND NEW.to_status = 'PENDING_REVIEW')
       OR (sale.legacy_policy_review
         AND sale.status = 'REVIEW_REQUIRED' AND NEW.to_status = 'REVIEW_REQUIRED')
     )
     OR sale.initiated_by IS DISTINCT FROM NEW.actor_id
     OR (actor_context = 'member' AND (
       NEW.actor_type <> 'MEMBER'
       OR sale.source <> 'MEMBER'
       OR sale.member_id IS DISTINCT FROM NEW.actor_id
       OR sale.type NOT IN ('REFUND_ONLY','RETURN_REFUND','EXCHANGE')
     ))
     OR (actor_context = 'admin' AND (
       NEW.actor_type <> 'ADMIN'
       OR sale.source <> 'ADMIN'
       OR sale.type <> 'MERCHANT_REFUND'
       OR NOT EXISTS (SELECT 1 FROM public.admin_users admin WHERE admin.id = NEW.actor_id)
     ))
  THEN
    RAISE EXCEPTION 'SUBMIT does not match an eligible initial after-sale header'
      USING ERRCODE = '23514';
  END IF;

  SELECT operation, status, idempotency_key_hash, request_hash
  INTO operation_record
  FROM public.after_sale_operations operation_row
  WHERE operation_row.store_id = NEW.store_id
    AND operation_row.id = NEW.operation_id
    AND operation_row.after_sale_id = NEW.after_sale_id
  FOR UPDATE;
  IF NOT FOUND
     OR operation_record.status <> 'PENDING'
     OR operation_record.operation IS DISTINCT FROM (CASE actor_context
       WHEN 'member' THEN 'MEMBER_CREATE' ELSE 'MERCHANT_REFUND_CREATE' END)
     OR operation_record.idempotency_key_hash IS DISTINCT FROM sale.idempotency_key_hash
     OR operation_record.request_hash IS DISTINCT FROM sale.request_hash
  THEN
    RAISE EXCEPTION 'SUBMIT requires its exact pending creation operation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "after_sale_transitions_b3_submit_guard"
  BEFORE INSERT ON "after_sale_transitions"
  FOR EACH ROW
  WHEN (NEW.event = 'SUBMIT')
  EXECUTE FUNCTION "app_security"."validate_m63_b3_submit_transition"();

CREATE OR REPLACE FUNCTION "app_security"."validate_m63_b3_operation_link"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE operation_record record;
BEGIN
  IF NEW.event <> 'SUBMIT'
     AND NOT (NEW.event = 'CANCEL' AND NEW.actor_type = 'MEMBER')
  THEN
    IF NEW.operation_id IS NOT NULL THEN
      RAISE EXCEPTION 'operation links are reserved for approved command events'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.operation_id IS NULL THEN
    IF NEW.event = 'CANCEL' AND NEW.actor_type = 'MEMBER' THEN
      RAISE EXCEPTION 'member cancellation requires the narrow B3 command primitive'
        USING ERRCODE = '42501';
    END IF;
    RAISE EXCEPTION 'B3 command transition requires an operation link' USING ERRCODE = '23514';
  END IF;
  SELECT operation, status
  INTO operation_record
  FROM public.after_sale_operations operation_row
  WHERE operation_row.store_id = NEW.store_id
    AND operation_row.id = NEW.operation_id
    AND operation_row.after_sale_id = NEW.after_sale_id
  FOR UPDATE;
  IF NOT FOUND OR operation_record.status <> 'PENDING'
     OR (NEW.event = 'SUBMIT'
       AND operation_record.operation NOT IN ('MEMBER_CREATE','MERCHANT_REFUND_CREATE'))
     OR (NEW.event = 'CANCEL' AND NEW.actor_type = 'MEMBER'
       AND operation_record.operation <> 'MEMBER_CANCEL')
  THEN
    RAISE EXCEPTION 'transition operation link is outside the B3 command contract'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "after_sale_transitions_b3_operation_link_guard"
  BEFORE INSERT ON "after_sale_transitions"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m63_b3_operation_link"();

CREATE OR REPLACE FUNCTION "app_security"."validate_m63_b3_operation_completion"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.operation NOT IN ('MEMBER_CREATE','MERCHANT_REFUND_CREATE','MEMBER_CANCEL') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND (
       SESSION_USER <> 'zalo_shop_runtime'
       OR NEW.status <> 'PENDING'
       OR NEW.result_summary IS NOT NULL
       OR NEW.error_code IS NOT NULL
       OR NEW.attempt_count <> 0
       OR NEW.version <> 1
     )
  THEN
    RAISE EXCEPTION 'B3 operation must begin pending and be created by the runtime'
      USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' AND (
       SESSION_USER <> 'zalo_shop_runtime'
       OR OLD.status <> 'PENDING'
       OR NEW.status <> 'COMPLETED'
       OR NEW.result_summary IS NULL
       OR NEW.error_code IS NOT NULL
       OR NEW.attempt_count <> 1
       OR NEW.version <> OLD.version + 1
       OR NEW.store_id IS DISTINCT FROM OLD.store_id
       OR NEW.id IS DISTINCT FROM OLD.id
       OR NEW.after_sale_id IS DISTINCT FROM OLD.after_sale_id
       OR NEW.operation IS DISTINCT FROM OLD.operation
       OR NEW.idempotency_key_hash IS DISTINCT FROM OLD.idempotency_key_hash
       OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
     )
  THEN
    RAISE EXCEPTION 'B3 operation may only be completed by its narrow command primitive'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "after_sale_operations_b3_completion_guard"
  BEFORE INSERT OR UPDATE ON "after_sale_operations"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m63_b3_operation_completion"();

CREATE OR REPLACE FUNCTION "app_security"."validate_m63_b3_command_atomicity"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE current_status public.after_sale_operation_status;
DECLARE expected_event text;
DECLARE linked_count bigint;
BEGIN
  IF TG_TABLE_NAME = 'after_sale_operations' THEN
    IF NEW.operation NOT IN ('MEMBER_CREATE','MERCHANT_REFUND_CREATE','MEMBER_CANCEL') THEN
      RETURN NULL;
    END IF;
    PERFORM app_security.assert_m63_b3_command_authorization();
    SELECT operation_row.status
    INTO current_status
    FROM public.after_sale_operations operation_row
    WHERE operation_row.store_id = NEW.store_id AND operation_row.id = NEW.id;
    expected_event := CASE WHEN NEW.operation = 'MEMBER_CANCEL' THEN 'CANCEL' ELSE 'SUBMIT' END;
    SELECT pg_catalog.count(*) INTO linked_count
    FROM public.after_sale_transitions transition
    WHERE transition.store_id = NEW.store_id
      AND transition.after_sale_id = NEW.after_sale_id
      AND transition.operation_id = NEW.id
      AND transition.event = expected_event;
  ELSE
     IF NEW.event <> 'SUBMIT'
       AND NOT (NEW.event = 'CANCEL' AND NEW.actor_type = 'MEMBER')
    THEN
      RETURN NULL;
    END IF;
    SELECT operation_row.status
    INTO current_status
    FROM public.after_sale_operations operation_row
    WHERE operation_row.store_id = NEW.store_id
      AND operation_row.id = NEW.operation_id
      AND operation_row.after_sale_id = NEW.after_sale_id;
    SELECT pg_catalog.count(*) INTO linked_count
    FROM public.after_sale_transitions transition
    WHERE transition.store_id = NEW.store_id
      AND transition.after_sale_id = NEW.after_sale_id
      AND transition.operation_id = NEW.operation_id
      AND transition.event = NEW.event;
  END IF;
  IF current_status IS DISTINCT FROM 'COMPLETED' OR linked_count <> 1 THEN
    RAISE EXCEPTION 'B3 operation and transition must commit as one completed command'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "after_sale_operations_b3_atomic_guard"
  AFTER INSERT OR UPDATE ON "after_sale_operations"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m63_b3_command_atomicity"();
CREATE CONSTRAINT TRIGGER "after_sale_transitions_b3_atomic_guard"
  AFTER INSERT ON "after_sale_transitions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m63_b3_command_atomicity"();

CREATE OR REPLACE FUNCTION "app_security"."validate_m63_b3_runtime_case_commit"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE expected_operation text;
DECLARE expected_action text;
DECLARE evidence_required boolean;
BEGIN
  -- Historical migrations and owner-only fixtures stay outside the runtime
  -- command boundary. Runtime headers must never commit as bare aggregates.
  IF SESSION_USER <> 'zalo_shop_runtime' THEN RETURN NULL; END IF;
  expected_operation := CASE NEW.source
    WHEN 'MEMBER' THEN 'MEMBER_CREATE' ELSE 'MERCHANT_REFUND_CREATE' END;
  expected_action := CASE NEW.source
    WHEN 'MEMBER' THEN 'after-sale.member.submitted'
    ELSE 'after-sale.merchant-refund.submitted' END;
  evidence_required := COALESCE(
    (NEW.policy_snapshot #>> '{condition_rules,evidence_required}')::boolean, false)
    OR COALESCE(
      NEW.policy_snapshot #> '{condition_rules,evidence_required_reason_codes}'
        @> pg_catalog.jsonb_build_array(NEW.reason_code),
      false
    );
  IF NOT EXISTS (
       SELECT 1 FROM public.after_sale_items item
       WHERE item.store_id = NEW.store_id AND item.after_sale_id = NEW.id
     )
     OR 1 <> (
       SELECT pg_catalog.count(*)
       FROM public.after_sale_transitions transition
       JOIN public.after_sale_operations operation_row
         ON operation_row.store_id = transition.store_id
        AND operation_row.id = transition.operation_id
        AND operation_row.after_sale_id = transition.after_sale_id
       WHERE transition.store_id = NEW.store_id
         AND transition.after_sale_id = NEW.id
         AND transition.event = 'SUBMIT'
         AND transition.from_status IS NULL
         AND transition.to_status = NEW.status
         AND operation_row.operation = expected_operation
         AND operation_row.status = 'COMPLETED'
         AND operation_row.idempotency_key_hash = NEW.idempotency_key_hash
         AND operation_row.request_hash = NEW.request_hash
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.audit_logs audit
       JOIN public.after_sale_operations operation_row
         ON operation_row.store_id = audit.store_id
        AND operation_row.after_sale_id = NEW.id
        AND operation_row.id::text = audit.after_data->>'operation_id'
       WHERE audit.store_id = NEW.store_id
         AND audit.action = expected_action
         AND audit.target_type = 'after_sale'
         AND audit.target_id = NEW.id::text
         AND audit.actor_id = NEW.initiated_by
         AND audit.correlation_id = NEW.correlation_id
     )
     OR (evidence_required AND NOT EXISTS (
       SELECT 1 FROM public.after_sale_evidence_files evidence
       WHERE evidence.store_id = NEW.store_id
         AND evidence.after_sale_id = NEW.id
         AND evidence.member_id = NEW.member_id
         AND evidence.status = 'READY'
     ))
  THEN
    RAISE EXCEPTION 'runtime after-sale header requires its complete B3 command facts'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "after_sales_b3_runtime_commit_guard"
  AFTER INSERT ON "after_sales"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m63_b3_runtime_case_commit"();

CREATE OR REPLACE FUNCTION "app_security"."finalize_m63_b3_after_sale_submit"(
  p_after_sale_id uuid,
  p_operation_id uuid,
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
DECLARE actor_context text := pg_catalog.current_setting('app.actor_type', true);
DECLARE actor_id uuid := app_security.current_actor_id();
DECLARE scoped_store_id uuid := app_security.current_store_id();
DECLARE correlation_id text := NULLIF(pg_catalog.current_setting('app.correlation_id', true), '');
DECLARE sale record;
DECLARE existing record;
DECLARE operation_name text;
BEGIN
  IF p_after_sale_id IS NULL OR p_operation_id IS NULL OR correlation_id IS NULL
     OR actor_context NOT IN ('member','admin') OR actor_id IS NULL OR scoped_store_id IS NULL
  THEN
    RAISE EXCEPTION 'after-sale submission requires a complete scoped context'
      USING ERRCODE = '42501';
  END IF;
  PERFORM app_security.assert_m63_b3_command_authorization();
  SELECT * INTO sale
  FROM public.after_sales current_sale
  WHERE current_sale.store_id = scoped_store_id AND current_sale.id = p_after_sale_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'after-sale submission target was not found' USING ERRCODE = 'P0002';
  END IF;
  operation_name := CASE actor_context
    WHEN 'member' THEN 'MEMBER_CREATE' ELSE 'MERCHANT_REFUND_CREATE' END;
  IF sale.initiated_by IS DISTINCT FROM actor_id
     OR (actor_context = 'member' AND (
         sale.source <> 'MEMBER' OR sale.member_id IS DISTINCT FROM actor_id
       ))
     OR (actor_context = 'admin' AND (
        sale.source <> 'ADMIN' OR sale.type <> 'MERCHANT_REFUND'
      ))
  THEN
    RAISE EXCEPTION 'after-sale submission target was not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'm63-b3:' || scoped_store_id::text || ':' || operation_name || ':' || sale.idempotency_key_hash, 0));

  SELECT operation_row.* INTO existing
  FROM public.after_sale_operations operation_row
  WHERE operation_row.store_id = scoped_store_id
    AND operation_row.operation = operation_name
    AND operation_row.idempotency_key_hash = sale.idempotency_key_hash
  FOR UPDATE;
  IF FOUND THEN
    IF existing.after_sale_id IS DISTINCT FROM sale.id
       OR existing.request_hash IS DISTINCT FROM sale.request_hash
    THEN
      RAISE EXCEPTION 'after-sale idempotency key was reused with another request'
        USING ERRCODE = '23505';
    END IF;
    IF existing.status <> 'COMPLETED' THEN
      RAISE EXCEPTION 'after-sale creation operation is not complete'
        USING ERRCODE = '23514';
    END IF;
    IF existing.result_summary IS NULL
       OR pg_catalog.jsonb_typeof(existing.result_summary) <> 'object'
       OR existing.result_summary->>'after_sale_id' <> sale.id::text
       OR existing.result_summary->>'operation_id' <> existing.id::text
       OR existing.result_summary->>'public_case_number' <> sale.public_case_number
       OR existing.result_summary->>'status' NOT IN ('PENDING_REVIEW','REVIEW_REQUIRED')
       OR existing.result_summary->>'version' <> '1'
    THEN
      RAISE EXCEPTION 'after-sale creation replay result is invalid' USING ERRCODE = '23514';
    END IF;
    -- Revalidate after any advisory/operation-row wait. Replay has no deferred
    -- write trigger that could otherwise catch token, session, MFA or RBAC
    -- expiry immediately before returning the stored acknowledgement.
    PERFORM app_security.assert_m63_b3_command_authorization();
    RETURN QUERY SELECT sale.id, existing.id, sale.public_case_number,
      (existing.result_summary->>'status')::public.after_sale_status, 1, true;
    RETURN;
  END IF;

  PERFORM app_security.validate_m63_b3_command_facts(p_after_sale_id);

  SELECT * INTO sale
  FROM public.after_sales current_sale
  WHERE current_sale.store_id = scoped_store_id AND current_sale.id = p_after_sale_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'after-sale submission target was not found' USING ERRCODE = 'P0002';
  END IF;

  IF sale.version <> 1
     OR sale.status <> (CASE WHEN sale.legacy_policy_review
       THEN 'REVIEW_REQUIRED'::public.after_sale_status
       ELSE 'PENDING_REVIEW'::public.after_sale_status END)
     OR sale.initiated_by IS DISTINCT FROM actor_id
     OR EXISTS (SELECT 1 FROM public.after_sale_transitions transition
       WHERE transition.store_id = scoped_store_id AND transition.after_sale_id = sale.id)
     OR (actor_context = 'member' AND (
       sale.source <> 'MEMBER' OR sale.member_id IS DISTINCT FROM actor_id
       OR sale.type NOT IN ('REFUND_ONLY','RETURN_REFUND','EXCHANGE')
     ))
     OR (actor_context = 'admin' AND (
       sale.source <> 'ADMIN' OR sale.type <> 'MERCHANT_REFUND'
       OR NOT EXISTS (SELECT 1 FROM public.admin_users admin WHERE admin.id = actor_id)
     ))
  THEN
    RAISE EXCEPTION 'after-sale header is not eligible for submission'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.after_sale_operations
    (id, store_id, after_sale_id, operation, idempotency_key_hash, request_hash, updated_at)
  VALUES (p_operation_id, scoped_store_id, sale.id, operation_name,
    sale.idempotency_key_hash, sale.request_hash, pg_catalog.clock_timestamp());

  INSERT INTO public.after_sale_transitions
    (store_id, after_sale_id, operation_id, from_status, to_status, event,
      actor_type, actor_id, reason, correlation_id)
  VALUES (scoped_store_id, sale.id, p_operation_id, NULL, sale.status, 'SUBMIT',
    pg_catalog.upper(actor_context)::public."AuditActorType", actor_id, NULL, correlation_id);

  UPDATE public.after_sale_operations operation_row
  SET status = 'COMPLETED',
      result_summary = pg_catalog.jsonb_build_object(
        'after_sale_id', sale.id,
        'operation_id', p_operation_id,
        'public_case_number', sale.public_case_number,
        'status', sale.status,
        'version', 1
      ),
      attempt_count = 1,
      version = operation_row.version + 1,
      updated_at = pg_catalog.clock_timestamp()
  WHERE operation_row.store_id = scoped_store_id AND operation_row.id = p_operation_id;

  INSERT INTO public.audit_logs
    (store_id, actor_type, actor_id, action, target_type, target_id,
      before_data, after_data, reason, correlation_id, source_ip)
  VALUES (scoped_store_id, pg_catalog.upper(actor_context)::public."AuditActorType", actor_id,
    CASE actor_context WHEN 'member' THEN 'after-sale.member.submitted'
      ELSE 'after-sale.merchant-refund.submitted' END,
    'after_sale', sale.id::text, NULL,
    pg_catalog.jsonb_build_object(
      'after_sale_id', sale.id,
      'operation_id', p_operation_id,
      'order_id', sale.order_id,
      'status', sale.status,
      'type', sale.type,
      'version', 1
    ), NULL, correlation_id, p_source_ip);

  RETURN QUERY SELECT sale.id, p_operation_id, sale.public_case_number,
    sale.status, 1, false;
END
$$;

CREATE OR REPLACE FUNCTION "app_security"."cancel_m63_b3_member_after_sale"(
  p_after_sale_id uuid,
  p_operation_id uuid,
  p_idempotency_key_hash text,
  p_request_hash text,
  p_expected_version integer,
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
DECLARE actor_context text := pg_catalog.current_setting('app.actor_type', true);
DECLARE actor_id uuid := app_security.current_actor_id();
DECLARE scoped_store_id uuid := app_security.current_store_id();
DECLARE correlation_id text := NULLIF(pg_catalog.current_setting('app.correlation_id', true), '');
DECLARE sale record;
DECLARE existing record;
DECLARE target_order_id uuid;
BEGIN
  IF actor_context IS DISTINCT FROM 'member' OR actor_id IS NULL OR scoped_store_id IS NULL
     OR correlation_id IS NULL OR p_after_sale_id IS NULL OR p_operation_id IS NULL
     OR p_expected_version IS NULL OR p_expected_version < 1
     OR p_idempotency_key_hash IS NULL
     OR p_idempotency_key_hash !~ '^[0-9a-f]{64}$'
     OR p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'after-sale cancellation requires a complete member command context'
      USING ERRCODE = '42501';
  END IF;
  PERFORM app_security.assert_m63_b3_command_authorization();

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'm63-b3:' || scoped_store_id::text || ':MEMBER_CANCEL:' || p_idempotency_key_hash, 0));
  SELECT operation_row.* INTO existing
  FROM public.after_sale_operations operation_row
  WHERE operation_row.store_id = scoped_store_id
    AND operation_row.operation = 'MEMBER_CANCEL'
    AND operation_row.idempotency_key_hash = p_idempotency_key_hash
  FOR UPDATE;
  IF FOUND THEN
    IF existing.after_sale_id IS DISTINCT FROM p_after_sale_id
       OR existing.request_hash IS DISTINCT FROM p_request_hash
    THEN
      RAISE EXCEPTION 'after-sale idempotency key was reused with another request'
        USING ERRCODE = '23505';
    END IF;
    SELECT * INTO sale FROM public.after_sales current_sale
    WHERE current_sale.store_id = scoped_store_id
      AND current_sale.id = existing.after_sale_id
      AND current_sale.member_id = actor_id;
    IF NOT FOUND OR existing.status <> 'COMPLETED' THEN
      RAISE EXCEPTION 'after-sale cancellation replay is outside the member scope'
        USING ERRCODE = '42501';
    END IF;
    IF existing.result_summary IS NULL
       OR pg_catalog.jsonb_typeof(existing.result_summary) <> 'object'
       OR existing.result_summary->>'after_sale_id' <> sale.id::text
       OR existing.result_summary->>'operation_id' <> existing.id::text
       OR existing.result_summary->>'public_case_number' <> sale.public_case_number
       OR existing.result_summary->>'status' <> 'CANCELLED'
       OR existing.result_summary->>'version' !~ '^[1-9][0-9]{0,8}$'
    THEN
      RAISE EXCEPTION 'after-sale cancellation replay result is invalid' USING ERRCODE = '23514';
    END IF;
    -- Cancellation replay is read-only, so repeat the final authorization
    -- check after all potentially blocking locks and before returning.
    PERFORM app_security.assert_m63_b3_command_authorization();
    RETURN QUERY SELECT sale.id, existing.id, sale.public_case_number,
      (existing.result_summary->>'status')::public.after_sale_status,
      (existing.result_summary->>'version')::integer, true;
    RETURN;
  END IF;

  SELECT current_sale.order_id INTO target_order_id
  FROM public.after_sales current_sale
  WHERE current_sale.store_id = scoped_store_id
    AND current_sale.id = p_after_sale_id
    AND current_sale.member_id = actor_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'after-sale cancellation target was not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'm62-refund:' || scoped_store_id::text || ':' || target_order_id::text, 0));
  PERFORM 1 FROM public.orders current_order
  WHERE current_order.store_id = scoped_store_id AND current_order.id = target_order_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'after-sale cancellation order was not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT current_sale.* INTO sale
  FROM public.after_sales current_sale
  WHERE current_sale.store_id = scoped_store_id
    AND current_sale.id = p_after_sale_id
    AND current_sale.member_id = actor_id
  FOR UPDATE;
  IF NOT FOUND OR sale.order_id IS DISTINCT FROM target_order_id THEN
    RAISE EXCEPTION 'after-sale cancellation target was not found' USING ERRCODE = 'P0002';
  END IF;

  IF sale.version <> p_expected_version THEN
    RAISE EXCEPTION 'after-sale expected version does not match'
      USING ERRCODE = '40001';
  END IF;
  IF sale.status <> 'PENDING_REVIEW' OR sale.legacy_policy_review
     OR sale.source <> 'MEMBER'
     OR sale.type NOT IN ('REFUND_ONLY','RETURN_REFUND','EXCHANGE')
     OR sale.reviewed_by IS NOT NULL OR sale.reviewed_at IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.after_sale_transitions transition
       WHERE transition.store_id = scoped_store_id AND transition.after_sale_id = sale.id
         AND transition.event <> 'SUBMIT')
     OR EXISTS (SELECT 1 FROM public.after_sale_settlements settlement
       WHERE settlement.store_id = scoped_store_id AND settlement.after_sale_id = sale.id)
     OR EXISTS (SELECT 1 FROM public.after_sale_return_shipments return_shipment
       WHERE return_shipment.store_id = scoped_store_id AND return_shipment.after_sale_id = sale.id)
     OR EXISTS (SELECT 1 FROM public.shipments shipment
       WHERE shipment.store_id = scoped_store_id AND shipment.after_sale_id = sale.id
         AND shipment.purpose <> 'ORDER_OUTBOUND')
     OR EXISTS (SELECT 1 FROM public.after_sale_inspections inspection
       WHERE inspection.store_id = scoped_store_id AND inspection.after_sale_id = sale.id)
     OR EXISTS (SELECT 1 FROM public.after_sale_inventory_actions inventory_action
       WHERE inventory_action.store_id = scoped_store_id AND inventory_action.after_sale_id = sale.id)
     OR EXISTS (SELECT 1 FROM public.exchange_fulfillments fulfillment
       WHERE fulfillment.store_id = scoped_store_id AND fulfillment.after_sale_id = sale.id)
  THEN
    RAISE EXCEPTION 'after-sale is not in a cancellable state' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.after_sale_operations
    (id, store_id, after_sale_id, operation, idempotency_key_hash, request_hash, updated_at)
  VALUES (p_operation_id, scoped_store_id, sale.id, 'MEMBER_CANCEL',
    p_idempotency_key_hash, p_request_hash, pg_catalog.clock_timestamp());

  INSERT INTO public.after_sale_transitions
    (store_id, after_sale_id, operation_id, from_status, to_status, event,
      actor_type, actor_id, reason, correlation_id)
  VALUES (scoped_store_id, sale.id, p_operation_id, 'PENDING_REVIEW', 'CANCELLED', 'CANCEL',
    'MEMBER', actor_id, NULL, correlation_id);

  SELECT * INTO sale
  FROM public.after_sales current_sale
  WHERE current_sale.store_id = scoped_store_id AND current_sale.id = p_after_sale_id;

  UPDATE public.after_sale_operations operation_row
  SET status = 'COMPLETED',
      result_summary = pg_catalog.jsonb_build_object(
        'after_sale_id', sale.id,
        'operation_id', p_operation_id,
        'public_case_number', sale.public_case_number,
        'status', sale.status,
        'version', sale.version
      ),
      attempt_count = 1,
      version = operation_row.version + 1,
      updated_at = pg_catalog.clock_timestamp()
  WHERE operation_row.store_id = scoped_store_id AND operation_row.id = p_operation_id;

  INSERT INTO public.audit_logs
    (store_id, actor_type, actor_id, action, target_type, target_id,
      before_data, after_data, reason, correlation_id, source_ip)
  VALUES (scoped_store_id, 'MEMBER', actor_id, 'after-sale.member.cancelled',
    'after_sale', sale.id::text,
    pg_catalog.jsonb_build_object('status', 'PENDING_REVIEW', 'version', p_expected_version),
    pg_catalog.jsonb_build_object(
      'after_sale_id', sale.id,
      'operation_id', p_operation_id,
      'status', sale.status,
      'version', sale.version
    ), NULL, correlation_id, p_source_ip);

  RETURN QUERY SELECT sale.id, p_operation_id, sale.public_case_number,
    sale.status, sale.version, false;
END
$$;

-- Direct member operation creation and cancellation insertion are replaced by
-- the command functions above. START_RETURN remains governed by its B0 policy.
DROP POLICY "after_sale_operations_insert_scope" ON "after_sale_operations";
DROP POLICY "after_sale_transitions_member_cancel_insert" ON "after_sale_transitions";
REVOKE INSERT ON "after_sale_operations" FROM zalo_shop_runtime;

REVOKE ALL ON FUNCTION
  "app_security"."assert_m63_b3_command_authorization"(),
  "app_security"."validate_m63_b3_command_facts"(uuid),
  "app_security"."validate_m63_b3_submit_transition"(),
  "app_security"."validate_m63_b3_operation_link"(),
  "app_security"."validate_m63_b3_operation_completion"(),
  "app_security"."validate_m63_b3_command_atomicity"(),
  "app_security"."validate_m63_b3_runtime_case_commit"(),
  "app_security"."finalize_m63_b3_after_sale_submit"(uuid, uuid, inet),
  "app_security"."cancel_m63_b3_member_after_sale"(uuid, uuid, text, text, integer, inet)
FROM PUBLIC;
REVOKE ALL ON FUNCTION
  "app_security"."assert_m63_b3_command_authorization"(),
  "app_security"."validate_m63_b3_command_facts"(uuid),
  "app_security"."validate_m63_b3_submit_transition"(),
  "app_security"."validate_m63_b3_operation_link"(),
  "app_security"."validate_m63_b3_operation_completion"(),
  "app_security"."validate_m63_b3_command_atomicity"(),
  "app_security"."validate_m63_b3_runtime_case_commit"()
FROM zalo_shop_runtime;
GRANT EXECUTE ON FUNCTION
  "app_security"."finalize_m63_b3_after_sale_submit"(uuid, uuid, inet),
  "app_security"."cancel_m63_b3_member_after_sale"(uuid, uuid, text, text, integer, inet)
TO zalo_shop_runtime;
