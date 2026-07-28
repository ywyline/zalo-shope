-- Tighten the shared runtime role so a member context can only perform the
-- member-owned writes required by the frozen M6 contract. Workers use an
-- admin context and remain subject to tenant RLS and the existing guards.

-- The item snapshot validator must inspect the immutable order row without
-- granting the runtime role general order-item reads.
ALTER FUNCTION "app_security"."validate_m62_after_sale_item_identity"()
  SECURITY DEFINER;
ALTER FUNCTION "app_security"."enforce_m62_after_sale_item_capacity"()
  SECURITY DEFINER;

DROP POLICY "after_sales_actor_scope" ON "after_sales";
CREATE POLICY "after_sales_select_scope" ON "after_sales"
  FOR SELECT USING (
    "store_id" = app_security.current_store_id()
    AND (
      pg_catalog.current_setting('app.actor_type', true) = 'admin'
      OR (
        pg_catalog.current_setting('app.actor_type', true) = 'member'
        AND "member_id" = app_security.current_actor_id()
      )
    )
  );
CREATE POLICY "after_sales_insert_scope" ON "after_sales"
  FOR INSERT WITH CHECK (
    "store_id" = app_security.current_store_id()
    AND (
      pg_catalog.current_setting('app.actor_type', true) = 'admin'
      OR (
        pg_catalog.current_setting('app.actor_type', true) = 'member'
        AND "member_id" = app_security.current_actor_id()
        AND "source" = 'MEMBER'
        AND "initiated_by" = app_security.current_actor_id()
      )
    )
  );
CREATE POLICY "after_sales_admin_update" ON "after_sales"
  FOR UPDATE
  USING (
    "store_id" = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'admin'
  )
  WITH CHECK (
    "store_id" = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'admin'
  );
CREATE POLICY "after_sales_member_cancel" ON "after_sales"
  FOR UPDATE
  USING (
    "store_id" = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'member'
    AND "member_id" = app_security.current_actor_id()
    AND "status" = 'PENDING_REVIEW'
  )
  WITH CHECK (
    "store_id" = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'member'
    AND CURRENT_USER <> SESSION_USER
    AND "member_id" = app_security.current_actor_id()
    AND "status" = 'CANCELLED'
  );

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_member_after_sale_cancel"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF pg_catalog.current_setting('app.actor_type', true) = 'member' THEN
    IF CURRENT_USER = SESSION_USER
       OR OLD.store_id <> app_security.current_store_id()
       OR OLD.member_id <> app_security.current_actor_id()
       OR OLD.status <> 'PENDING_REVIEW'
       OR NEW.status <> 'CANCELLED'
       OR NEW.version <> OLD.version + 1
       OR NEW.completed_at IS NULL
       OR NEW.updated_at < OLD.updated_at
       OR (
         pg_catalog.to_jsonb(NEW)
           - ARRAY['status','version','completed_at','updated_at']
       ) IS DISTINCT FROM (
         pg_catalog.to_jsonb(OLD)
           - ARRAY['status','version','completed_at','updated_at']
       )
    THEN
      RAISE EXCEPTION 'member after-sale update must be a bounded pending cancellation'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "after_sales_member_cancel_guard"
  BEFORE UPDATE ON "after_sales"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_member_after_sale_cancel"();

DROP POLICY "after_sale_items_actor_scope" ON "after_sale_items";
CREATE POLICY "after_sale_items_select_scope" ON "after_sale_items"
  FOR SELECT USING (
    "store_id" = app_security.current_store_id()
    AND (
      pg_catalog.current_setting('app.actor_type', true) = 'admin'
      OR (
        pg_catalog.current_setting('app.actor_type', true) = 'member'
        AND EXISTS (
          SELECT 1 FROM public.after_sales AS owned_case
          WHERE owned_case.store_id = after_sale_items.store_id
            AND owned_case.id = after_sale_items.after_sale_id
            AND owned_case.member_id = app_security.current_actor_id()
        )
      )
    )
  );
CREATE POLICY "after_sale_items_insert_scope" ON "after_sale_items"
  FOR INSERT WITH CHECK (
    "store_id" = app_security.current_store_id()
    AND (
      pg_catalog.current_setting('app.actor_type', true) = 'admin'
      OR (
        pg_catalog.current_setting('app.actor_type', true) = 'member'
        AND EXISTS (
          SELECT 1 FROM public.after_sales AS owned_case
          WHERE owned_case.store_id = after_sale_items.store_id
            AND owned_case.id = after_sale_items.after_sale_id
            AND owned_case.member_id = app_security.current_actor_id()
        )
      )
    )
  );
CREATE POLICY "after_sale_items_admin_update" ON "after_sale_items"
  FOR UPDATE
  USING (
    "store_id" = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'admin'
  )
  WITH CHECK (
    "store_id" = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'admin'
  );

DROP POLICY "after_sale_operations_actor_scope" ON "after_sale_operations";
CREATE POLICY "after_sale_operations_select_scope" ON "after_sale_operations"
  FOR SELECT USING (
    "store_id" = app_security.current_store_id()
    AND (
      pg_catalog.current_setting('app.actor_type', true) = 'admin'
      OR (
        pg_catalog.current_setting('app.actor_type', true) = 'member'
        AND EXISTS (
          SELECT 1 FROM public.after_sales AS owned_case
          WHERE owned_case.store_id = after_sale_operations.store_id
            AND owned_case.id = after_sale_operations.after_sale_id
            AND owned_case.member_id = app_security.current_actor_id()
        )
      )
    )
  );
CREATE POLICY "after_sale_operations_insert_scope" ON "after_sale_operations"
  FOR INSERT WITH CHECK (
    "store_id" = app_security.current_store_id()
    AND (
      pg_catalog.current_setting('app.actor_type', true) = 'admin'
      OR (
        pg_catalog.current_setting('app.actor_type', true) = 'member'
        AND EXISTS (
          SELECT 1 FROM public.after_sales AS owned_case
          WHERE owned_case.store_id = after_sale_operations.store_id
            AND owned_case.id = after_sale_operations.after_sale_id
            AND owned_case.member_id = app_security.current_actor_id()
        )
      )
    )
  );
CREATE POLICY "after_sale_operations_admin_update" ON "after_sale_operations"
  FOR UPDATE
  USING (
    "store_id" = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'admin'
  )
  WITH CHECK (
    "store_id" = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'admin'
  );

DROP POLICY "after_sale_transitions_actor_scope" ON "after_sale_transitions";
CREATE POLICY "after_sale_transitions_select_scope" ON "after_sale_transitions"
  FOR SELECT USING (
    "store_id" = app_security.current_store_id()
    AND (
      pg_catalog.current_setting('app.actor_type', true) = 'admin'
      OR (
        pg_catalog.current_setting('app.actor_type', true) = 'member'
        AND EXISTS (
          SELECT 1 FROM public.after_sales AS owned_case
          WHERE owned_case.store_id = after_sale_transitions.store_id
            AND owned_case.id = after_sale_transitions.after_sale_id
            AND owned_case.member_id = app_security.current_actor_id()
        )
      )
    )
  );
CREATE POLICY "after_sale_transitions_admin_insert" ON "after_sale_transitions"
  FOR INSERT WITH CHECK (
    "store_id" = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'admin'
  );
CREATE POLICY "after_sale_transitions_member_cancel_insert" ON "after_sale_transitions"
  FOR INSERT WITH CHECK (
    "store_id" = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'member'
    AND "from_status" = 'PENDING_REVIEW'
    AND "to_status" = 'CANCELLED'
    AND "event" = 'CANCEL'
    AND "actor_type" = 'MEMBER'
    AND "actor_id" = app_security.current_actor_id()
    AND EXISTS (
      SELECT 1 FROM public.after_sales AS owned_case
      WHERE owned_case.store_id = after_sale_transitions.store_id
        AND owned_case.id = after_sale_transitions.after_sale_id
        AND owned_case.member_id = app_security.current_actor_id()
        AND owned_case.status = 'PENDING_REVIEW'
    )
  );

CREATE OR REPLACE FUNCTION "app_security"."apply_m62_member_after_sale_cancel"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE affected_rows integer;
BEGIN
  IF pg_catalog.current_setting('app.actor_type', true) = 'member' THEN
    UPDATE public.after_sales
    SET status = 'CANCELLED',
        version = version + 1,
        completed_at = pg_catalog.now(),
        updated_at = pg_catalog.now()
    WHERE store_id = NEW.store_id
      AND id = NEW.after_sale_id
      AND member_id = app_security.current_actor_id()
      AND status = 'PENDING_REVIEW';
    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    IF affected_rows <> 1 THEN
      RAISE EXCEPTION 'member cancellation failed to project exactly one pending after-sale'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "after_sale_transitions_apply_member_cancel"
  AFTER INSERT ON "after_sale_transitions"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."apply_m62_member_after_sale_cancel"();

DROP POLICY "after_sale_evidence_files_actor_scope" ON "after_sale_evidence_files";
CREATE POLICY "after_sale_evidence_files_select_scope" ON "after_sale_evidence_files"
  FOR SELECT USING (
    "store_id" = app_security.current_store_id()
    AND (
      pg_catalog.current_setting('app.actor_type', true) = 'admin'
      OR (
        pg_catalog.current_setting('app.actor_type', true) = 'member'
        AND "member_id" = app_security.current_actor_id()
      )
    )
  );
CREATE POLICY "after_sale_evidence_files_admin_insert" ON "after_sale_evidence_files"
  FOR INSERT WITH CHECK (
    "store_id" = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'admin'
  );
CREATE POLICY "after_sale_evidence_files_member_insert" ON "after_sale_evidence_files"
  FOR INSERT WITH CHECK (
    "store_id" = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'member'
    AND "member_id" = app_security.current_actor_id()
    AND "after_sale_id" IS NULL
    AND "status" = 'PENDING'
    AND "scan_result_code" IS NULL
    AND "claim_deadline_at" IS NULL
    AND "claimed_at" IS NULL
    AND "retention_deadline_at" IS NULL
    AND NOT "legal_hold_active"
    AND "held_at" IS NULL
    AND "held_by" IS NULL
    AND "hold_reason" IS NULL
    AND "delete_attempt_count" = 0
    AND "next_delete_attempt_at" IS NULL
    AND "delete_error_code" IS NULL
    AND "deleted_at" IS NULL
    AND "version" = 1
  );
CREATE POLICY "after_sale_evidence_files_admin_update" ON "after_sale_evidence_files"
  FOR UPDATE
  USING (
    "store_id" = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'admin'
  )
  WITH CHECK (
    "store_id" = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'admin'
  );
CREATE POLICY "after_sale_evidence_files_member_claim" ON "after_sale_evidence_files"
  FOR UPDATE
  USING (
    "store_id" = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'member'
    AND "member_id" = app_security.current_actor_id()
    AND "after_sale_id" IS NULL
    AND "status" = 'READY_UNCLAIMED'
    AND "claim_deadline_at" IS NOT NULL
    AND pg_catalog.clock_timestamp() < "claim_deadline_at"
    AND NOT "legal_hold_active"
  )
  WITH CHECK (
    "store_id" = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'member'
    AND "member_id" = app_security.current_actor_id()
    AND "after_sale_id" IS NOT NULL
    AND "status" = 'READY'
    AND NOT "legal_hold_active"
    AND EXISTS (
      SELECT 1 FROM public.after_sales AS owned_case
      WHERE owned_case.store_id = after_sale_evidence_files.store_id
        AND owned_case.id = after_sale_evidence_files.after_sale_id
        AND owned_case.member_id = app_security.current_actor_id()
    )
  );

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_member_evidence_claim"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF pg_catalog.current_setting('app.actor_type', true) = 'member' THEN
    IF OLD.store_id <> app_security.current_store_id()
       OR OLD.member_id <> app_security.current_actor_id()
       OR OLD.status <> 'READY_UNCLAIMED'
       OR OLD.after_sale_id IS NOT NULL
       OR OLD.claim_deadline_at IS NULL
       OR pg_catalog.clock_timestamp() >= OLD.claim_deadline_at
       OR OLD.legal_hold_active
       OR NEW.status <> 'READY'
       OR NEW.after_sale_id IS NULL
       OR NEW.claimed_at IS NULL
       OR NEW.retention_deadline_at IS NULL
       OR NEW.retention_deadline_at <= NEW.claimed_at
       OR NEW.version <> OLD.version + 1
       OR NEW.updated_at < OLD.updated_at
       OR (
         pg_catalog.to_jsonb(NEW)
           - ARRAY['after_sale_id','status','claimed_at','retention_deadline_at','version','updated_at']
       ) IS DISTINCT FROM (
         pg_catalog.to_jsonb(OLD)
           - ARRAY['after_sale_id','status','claimed_at','retention_deadline_at','version','updated_at']
       )
       OR NOT EXISTS (
         SELECT 1 FROM public.after_sales AS owned_case
         WHERE owned_case.store_id = NEW.store_id
           AND owned_case.id = NEW.after_sale_id
           AND owned_case.member_id = app_security.current_actor_id()
       )
    THEN
      RAISE EXCEPTION 'member evidence update must be a bounded claim for an owned after-sale'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "after_sale_evidence_files_member_claim_guard"
  BEFORE UPDATE ON "after_sale_evidence_files"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_member_evidence_claim"();

-- Privacy headers are projections. The broad USING clause permits the
-- transition validator to lock the current row. WITH CHECK requires the
-- append-only transition count and projected version to agree.
DROP POLICY "privacy_requests_actor_scope" ON "privacy_requests";
CREATE POLICY "privacy_requests_select_scope" ON "privacy_requests"
  FOR SELECT USING (
    "store_id" = app_security.current_store_id()
    AND (
      pg_catalog.current_setting('app.actor_type', true) = 'admin'
      OR (
        pg_catalog.current_setting('app.actor_type', true) = 'member'
        AND "member_id" = app_security.current_actor_id()
      )
    )
  );
CREATE POLICY "privacy_requests_insert_scope" ON "privacy_requests"
  FOR INSERT WITH CHECK (
    "store_id" = app_security.current_store_id()
    AND (
      pg_catalog.current_setting('app.actor_type', true) = 'admin'
      OR (
        pg_catalog.current_setting('app.actor_type', true) = 'member'
        AND "member_id" = app_security.current_actor_id()
      )
    )
  );
CREATE POLICY "privacy_requests_transition_projection" ON "privacy_requests"
  FOR UPDATE
  USING (
    "store_id" = app_security.current_store_id()
    AND (
      pg_catalog.current_setting('app.actor_type', true) = 'admin'
      OR (
        pg_catalog.current_setting('app.actor_type', true) = 'member'
        AND "member_id" = app_security.current_actor_id()
      )
    )
  )
  WITH CHECK (
    "store_id" = app_security.current_store_id()
    AND "version" = 1 + (
      SELECT pg_catalog.count(*)::integer
      FROM public.privacy_request_transitions AS transition
      WHERE transition.store_id = privacy_requests.store_id
        AND transition.privacy_request_id = privacy_requests.id
        AND transition.member_id = privacy_requests.member_id
    )
    AND EXISTS (
      SELECT 1 FROM public.privacy_request_transitions AS transition
      WHERE transition.store_id = privacy_requests.store_id
        AND transition.privacy_request_id = privacy_requests.id
        AND transition.member_id = privacy_requests.member_id
        AND transition.to_status = privacy_requests.status
    )
  );

REVOKE UPDATE ("status","version","updated_at")
ON "privacy_requests" FROM zalo_shop_runtime;

DROP POLICY "privacy_request_transitions_actor_scope" ON "privacy_request_transitions";
CREATE POLICY "privacy_request_transitions_select_scope" ON "privacy_request_transitions"
  FOR SELECT USING (
    "store_id" = app_security.current_store_id()
    AND (
      pg_catalog.current_setting('app.actor_type', true) = 'admin'
      OR (
        pg_catalog.current_setting('app.actor_type', true) = 'member'
        AND "member_id" = app_security.current_actor_id()
      )
    )
  );
CREATE POLICY "privacy_request_transitions_admin_insert" ON "privacy_request_transitions"
  FOR INSERT WITH CHECK (
    "store_id" = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'admin'
  );
CREATE POLICY "privacy_request_transitions_member_cancel_insert" ON "privacy_request_transitions"
  FOR INSERT WITH CHECK (
    "store_id" = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'member'
    AND "member_id" = app_security.current_actor_id()
    AND "from_status" IN ('SUBMITTED','ACTION_REQUIRED')
    AND "to_status" = 'CANCELLED'
    AND "event" = 'CANCEL'
    AND "actor_type" = 'MEMBER'
    AND "actor_id" = app_security.current_actor_id()
    AND EXISTS (
      SELECT 1 FROM public.privacy_requests AS owned_request
      WHERE owned_request.store_id = privacy_request_transitions.store_id
        AND owned_request.id = privacy_request_transitions.privacy_request_id
        AND owned_request.member_id = app_security.current_actor_id()
        AND owned_request.status = privacy_request_transitions.from_status
    )
  );

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_privacy_transition"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE current_status public.privacy_request_status;
BEGIN
  SELECT status INTO current_status
  FROM public.privacy_requests
  WHERE store_id = NEW.store_id
    AND id = NEW.privacy_request_id
    AND member_id = NEW.member_id
  FOR UPDATE;
  IF NOT FOUND OR current_status <> NEW.from_status OR NOT (
    (NEW.from_status = 'SUBMITTED' AND NEW.event = 'START_REVIEW' AND NEW.to_status = 'UNDER_REVIEW')
    OR (NEW.from_status IN ('SUBMITTED','UNDER_REVIEW') AND NEW.event = 'REQUEST_ACTION' AND NEW.to_status = 'ACTION_REQUIRED')
    OR (NEW.from_status = 'ACTION_REQUIRED' AND NEW.event = 'PROVIDE_ACTION' AND NEW.to_status = 'SUBMITTED')
    OR (NEW.from_status = 'UNDER_REVIEW' AND NEW.event = 'START_FULFILLMENT' AND NEW.to_status = 'IN_PROGRESS')
    OR (NEW.from_status IN ('UNDER_REVIEW','IN_PROGRESS') AND NEW.event = 'REJECT' AND NEW.to_status = 'REJECTED')
    OR (NEW.from_status = 'IN_PROGRESS' AND NEW.event = 'COMPLETE' AND NEW.to_status = 'COMPLETED')
    OR (NEW.from_status IN ('SUBMITTED','ACTION_REQUIRED') AND NEW.event = 'CANCEL' AND NEW.to_status = 'CANCELLED')
  ) THEN
    RAISE EXCEPTION 'invalid privacy request transition event or current state'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION "app_security"."apply_m62_privacy_transition"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE affected_rows integer;
BEGIN
  UPDATE public.privacy_requests
  SET status = NEW.to_status, version = version + 1, updated_at = pg_catalog.now()
  WHERE store_id = NEW.store_id
    AND id = NEW.privacy_request_id
    AND member_id = NEW.member_id
    AND status = NEW.from_status;
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows <> 1 THEN
    RAISE EXCEPTION 'privacy transition failed to project exactly one current header'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_privacy_header_update"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF pg_catalog.pg_trigger_depth() <= 1
     OR NEW.version <> OLD.version + 1
     OR NEW.updated_at < OLD.updated_at
     OR (
       pg_catalog.to_jsonb(NEW) - ARRAY['status','version','updated_at']
     ) IS DISTINCT FROM (
       pg_catalog.to_jsonb(OLD) - ARRAY['status','version','updated_at']
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.privacy_request_transitions AS transition
       WHERE transition.store_id = NEW.store_id
         AND transition.privacy_request_id = NEW.id
         AND transition.member_id = NEW.member_id
         AND transition.from_status = OLD.status
         AND transition.to_status = NEW.status
     )
     OR NEW.version <> 1 + (
       SELECT pg_catalog.count(*)::integer
       FROM public.privacy_request_transitions AS transition
       WHERE transition.store_id = NEW.store_id
         AND transition.privacy_request_id = NEW.id
         AND transition.member_id = NEW.member_id
     )
  THEN
    RAISE EXCEPTION 'privacy request state changes require the transition projection trigger'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION
  "app_security"."validate_m62_member_after_sale_cancel"(),
  "app_security"."apply_m62_member_after_sale_cancel"(),
  "app_security"."validate_m62_after_sale_item_identity"(),
  "app_security"."enforce_m62_after_sale_item_capacity"(),
  "app_security"."validate_m62_member_evidence_claim"(),
  "app_security"."validate_m62_privacy_transition"(),
  "app_security"."apply_m62_privacy_transition"(),
  "app_security"."validate_m62_privacy_header_update"()
FROM PUBLIC;
REVOKE ALL ON FUNCTION
  "app_security"."validate_m62_member_after_sale_cancel"(),
  "app_security"."apply_m62_member_after_sale_cancel"(),
  "app_security"."validate_m62_after_sale_item_identity"(),
  "app_security"."enforce_m62_after_sale_item_capacity"(),
  "app_security"."validate_m62_member_evidence_claim"(),
  "app_security"."validate_m62_privacy_transition"(),
  "app_security"."apply_m62_privacy_transition"(),
  "app_security"."validate_m62_privacy_header_update"()
FROM zalo_shop_runtime;
