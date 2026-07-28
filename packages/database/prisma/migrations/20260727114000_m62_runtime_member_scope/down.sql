-- LOCAL/TEST ONLY. Restore the exact command policies and privacy projection
-- functions installed by 130 only when no M6 business facts exist.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.after_sales LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.after_sale_items LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.after_sale_transitions LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.after_sale_operations LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.after_sale_evidence_files LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.privacy_requests LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.privacy_request_transitions LIMIT 1)
  THEN
    RAISE EXCEPTION 'M6.2 runtime member scope rollback is unsafe after business facts exist'
      USING ERRCODE = '55000';
  END IF;
END
$$;

DROP TRIGGER "after_sales_member_cancel_guard" ON "after_sales";
DROP TRIGGER "after_sale_transitions_apply_member_cancel" ON "after_sale_transitions";
DROP TRIGGER "after_sale_evidence_files_member_claim_guard" ON "after_sale_evidence_files";

DROP POLICY "after_sales_select_scope" ON "after_sales";
DROP POLICY "after_sales_insert_scope" ON "after_sales";
DROP POLICY "after_sales_admin_update" ON "after_sales";
DROP POLICY "after_sales_member_cancel" ON "after_sales";
CREATE POLICY "after_sales_actor_scope" ON "after_sales"
  USING (
    store_id = app_security.current_store_id()
    AND (
      pg_catalog.current_setting('app.actor_type', true) = 'admin'
      OR (
        pg_catalog.current_setting('app.actor_type', true) = 'member'
        AND member_id = app_security.current_actor_id()
      )
    )
  )
  WITH CHECK (
    store_id = app_security.current_store_id()
    AND (
      pg_catalog.current_setting('app.actor_type', true) = 'admin'
      OR (
        pg_catalog.current_setting('app.actor_type', true) = 'member'
        AND member_id = app_security.current_actor_id()
      )
    )
  );

DROP POLICY "after_sale_items_select_scope" ON "after_sale_items";
DROP POLICY "after_sale_items_insert_scope" ON "after_sale_items";
DROP POLICY "after_sale_items_admin_update" ON "after_sale_items";
CREATE POLICY "after_sale_items_actor_scope" ON "after_sale_items"
  USING (
    store_id = app_security.current_store_id()
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
  )
  WITH CHECK (
    store_id = app_security.current_store_id()
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

DROP POLICY "after_sale_operations_select_scope" ON "after_sale_operations";
DROP POLICY "after_sale_operations_insert_scope" ON "after_sale_operations";
DROP POLICY "after_sale_operations_admin_update" ON "after_sale_operations";
CREATE POLICY "after_sale_operations_actor_scope" ON "after_sale_operations"
  USING (
    store_id = app_security.current_store_id()
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
  )
  WITH CHECK (
    store_id = app_security.current_store_id()
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

DROP POLICY "after_sale_transitions_select_scope" ON "after_sale_transitions";
DROP POLICY "after_sale_transitions_admin_insert" ON "after_sale_transitions";
DROP POLICY "after_sale_transitions_member_cancel_insert" ON "after_sale_transitions";
CREATE POLICY "after_sale_transitions_actor_scope" ON "after_sale_transitions"
  USING (
    store_id = app_security.current_store_id()
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
  )
  WITH CHECK (
    store_id = app_security.current_store_id()
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

DROP POLICY "after_sale_evidence_files_select_scope" ON "after_sale_evidence_files";
DROP POLICY "after_sale_evidence_files_admin_insert" ON "after_sale_evidence_files";
DROP POLICY "after_sale_evidence_files_member_insert" ON "after_sale_evidence_files";
DROP POLICY "after_sale_evidence_files_admin_update" ON "after_sale_evidence_files";
DROP POLICY "after_sale_evidence_files_member_claim" ON "after_sale_evidence_files";
CREATE POLICY "after_sale_evidence_files_actor_scope" ON "after_sale_evidence_files"
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
    AND (
      pg_catalog.current_setting('app.actor_type', true) = 'admin'
      OR (
        pg_catalog.current_setting('app.actor_type', true) = 'member'
        AND "member_id" = app_security.current_actor_id()
      )
    )
  );

DROP POLICY "privacy_requests_select_scope" ON "privacy_requests";
DROP POLICY "privacy_requests_insert_scope" ON "privacy_requests";
DROP POLICY "privacy_requests_transition_projection" ON "privacy_requests";
CREATE POLICY "privacy_requests_actor_scope" ON "privacy_requests"
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
    AND (
      pg_catalog.current_setting('app.actor_type', true) = 'admin'
      OR (
        pg_catalog.current_setting('app.actor_type', true) = 'member'
        AND "member_id" = app_security.current_actor_id()
      )
    )
  );

DROP POLICY "privacy_request_transitions_select_scope" ON "privacy_request_transitions";
DROP POLICY "privacy_request_transitions_admin_insert" ON "privacy_request_transitions";
DROP POLICY "privacy_request_transitions_member_cancel_insert" ON "privacy_request_transitions";
CREATE POLICY "privacy_request_transitions_actor_scope" ON "privacy_request_transitions"
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
    AND (
      pg_catalog.current_setting('app.actor_type', true) = 'admin'
      OR (
        pg_catalog.current_setting('app.actor_type', true) = 'member'
        AND "member_id" = app_security.current_actor_id()
      )
    )
  );

GRANT UPDATE ("status","version","updated_at")
ON "privacy_requests" TO zalo_shop_runtime;

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_privacy_transition"()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE current_status public.privacy_request_status;
BEGIN
  SELECT status INTO current_status
  FROM public.privacy_requests
  WHERE store_id = NEW.store_id AND id = NEW.privacy_request_id AND member_id = NEW.member_id
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
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  UPDATE public.privacy_requests
  SET status = NEW.to_status, version = version + 1, updated_at = now()
  WHERE store_id = NEW.store_id AND id = NEW.privacy_request_id AND member_id = NEW.member_id;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_privacy_header_update"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF (OLD.status IS DISTINCT FROM NEW.status OR OLD.version IS DISTINCT FROM NEW.version)
     AND pg_catalog.pg_trigger_depth() <= 1
  THEN
    RAISE EXCEPTION 'privacy request state changes require an append-only transition'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

DROP FUNCTION "app_security"."validate_m62_member_evidence_claim"();
DROP FUNCTION "app_security"."apply_m62_member_after_sale_cancel"();
DROP FUNCTION "app_security"."validate_m62_member_after_sale_cancel"();

ALTER FUNCTION "app_security"."validate_m62_after_sale_item_identity"()
  SECURITY INVOKER;
ALTER FUNCTION "app_security"."enforce_m62_after_sale_item_capacity"()
  SECURITY INVOKER;

REVOKE ALL ON FUNCTION
  "app_security"."validate_m62_after_sale_item_identity"(),
  "app_security"."enforce_m62_after_sale_item_capacity"(),
  "app_security"."validate_m62_privacy_transition"(),
  "app_security"."apply_m62_privacy_transition"(),
  "app_security"."validate_m62_privacy_header_update"()
FROM PUBLIC;
