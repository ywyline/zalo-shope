-- LOCAL/TEST ONLY. Production and any database containing D0 evidence facts
-- require a reviewed forward repair. Application rollback must leave this
-- database foundation in place until every object and message is reconciled.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.after_sale_evidence_files LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.after_sale_evidence_transitions LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.after_sale_evidence_objects LIMIT 1)
     OR EXISTS (
       SELECT 1 FROM public.outbox_messages
       WHERE aggregate_type = 'AFTER_SALE_EVIDENCE'
          OR event_type LIKE 'after-sale.evidence.%'
       LIMIT 1
     )
     OR EXISTS (
       SELECT 1 FROM public.idempotency_records
       WHERE operation LIKE 'after-sale-evidence-%'
       LIMIT 1
     )
  THEN
    RAISE EXCEPTION 'M6.3-B2b-D0 rollback requires an empty local/test evidence runtime'
      USING ERRCODE = '55000';
  END IF;
END
$$;

DROP TRIGGER outbox_messages_evidence_contract_guard
  ON public.outbox_messages;
DROP TRIGGER after_sale_evidence_files_queue_commit_guard
  ON public.after_sale_evidence_files;
DROP TRIGGER after_sale_evidence_files_original_binding_guard
  ON public.after_sale_evidence_files;
DROP TRIGGER after_sale_evidence_objects_original_binding_guard
  ON public.after_sale_evidence_objects;
DROP TRIGGER after_sale_evidence_objects_lifecycle_guard
  ON public.after_sale_evidence_objects;
DROP TRIGGER after_sale_evidence_files_initial_shape_guard
  ON public.after_sale_evidence_files;
DROP TRIGGER after_sale_evidence_files_lifecycle_guard
  ON public.after_sale_evidence_files;
DROP TRIGGER after_sale_evidence_files_append_transition
  ON public.after_sale_evidence_files;

DROP POLICY after_sale_evidence_objects_member_insert
  ON public.after_sale_evidence_objects;
DROP POLICY after_sale_evidence_objects_system_scope
  ON public.after_sale_evidence_objects;
DROP POLICY after_sale_evidence_files_select_scope
  ON public.after_sale_evidence_files;
DROP POLICY after_sale_evidence_files_member_insert
  ON public.after_sale_evidence_files;
DROP POLICY after_sale_evidence_files_member_confirm
  ON public.after_sale_evidence_files;
DROP POLICY after_sale_evidence_files_member_claim
  ON public.after_sale_evidence_files;
DROP POLICY after_sale_evidence_files_admin_hold
  ON public.after_sale_evidence_files;
DROP POLICY after_sale_evidence_files_system_lifecycle
  ON public.after_sale_evidence_files;

ALTER TABLE public.after_sale_evidence_files
  DROP CONSTRAINT after_sale_evidence_files_b2b_shape_check;

ALTER TABLE public.after_sale_evidence_transitions
  DROP CONSTRAINT after_sale_evidence_transitions_b2b_version_check;

REVOKE UPDATE (original_filename)
  ON public.after_sale_evidence_files FROM zalo_shop_runtime;

DROP FUNCTION app_security.validate_m63_b2b_evidence_queue_commit();
DROP FUNCTION app_security.validate_m63_b2b_evidence_outbox();
DROP FUNCTION app_security.validate_m63_b2b_original_binding();
DROP FUNCTION app_security.validate_m63_b2b_evidence_lifecycle();
DROP FUNCTION app_security.validate_m63_b2b_evidence_initial_shape();
DROP FUNCTION app_security.validate_m63_b2b_evidence_object();

DROP TABLE public.after_sale_evidence_objects;
DROP TYPE public.after_sale_evidence_object_role;

DROP INDEX IF EXISTS public.after_sale_evidence_files_store_id_member_id_status_id_idx;
DROP INDEX IF EXISTS public.after_sale_evidence_files_store_id_status_next_delete_attem_idx;
CREATE INDEX after_sale_evidence_files_status_next_delete_attempt_at_idx
  ON public.after_sale_evidence_files(status, next_delete_attempt_at);

ALTER TABLE public.after_sale_evidence_transitions
  DROP COLUMN correlation_id,
  DROP COLUMN evidence_version,
  DROP COLUMN scan_generation;

ALTER TABLE public.after_sale_evidence_files
  DROP COLUMN upload_deadline_at,
  DROP COLUMN confirmed_at,
  DROP COLUMN scan_requested_at,
  DROP COLUMN scan_completed_at,
  DROP COLUMN scan_generation,
  DROP COLUMN scanner_engine,
  DROP COLUMN scanner_engine_version,
  DROP COLUMN scanner_signature_version,
  DROP COLUMN ordinary_access_deadline_at,
  DROP COLUMN delete_exhausted_at;

-- Restore the exact M6.2 foreign-key update actions.
ALTER TABLE public.after_sale_evidence_files
  DROP CONSTRAINT after_sale_evidence_files_store_id_fkey,
  DROP CONSTRAINT after_sale_evidence_files_member_fkey,
  DROP CONSTRAINT after_sale_evidence_files_case_member_fkey,
  DROP CONSTRAINT after_sale_evidence_files_held_by_fkey,
  ADD CONSTRAINT after_sale_evidence_files_store_id_fkey
    FOREIGN KEY (store_id) REFERENCES public.stores(id) ON DELETE RESTRICT,
  ADD CONSTRAINT after_sale_evidence_files_member_fkey
    FOREIGN KEY (store_id, member_id) REFERENCES public.members(store_id, id)
      ON DELETE RESTRICT,
  ADD CONSTRAINT after_sale_evidence_files_case_member_fkey
    FOREIGN KEY (store_id, after_sale_id, member_id)
    REFERENCES public.after_sales(store_id, id, member_id) ON DELETE RESTRICT,
  ADD CONSTRAINT after_sale_evidence_files_held_by_fkey
    FOREIGN KEY (held_by) REFERENCES public.admin_users(id) ON DELETE RESTRICT;

ALTER TABLE public.after_sale_evidence_transitions
  DROP CONSTRAINT after_sale_evidence_transitions_store_id_fkey,
  DROP CONSTRAINT after_sale_evidence_transitions_file_fkey,
  ADD CONSTRAINT after_sale_evidence_transitions_store_id_fkey
    FOREIGN KEY (store_id) REFERENCES public.stores(id) ON DELETE RESTRICT,
  ADD CONSTRAINT after_sale_evidence_transitions_file_fkey
    FOREIGN KEY (store_id, evidence_file_id)
    REFERENCES public.after_sale_evidence_files(store_id, id) ON DELETE RESTRICT;

-- Restore the exact M6.2 runtime policies replaced by D0.
CREATE POLICY after_sale_evidence_files_select_scope
  ON public.after_sale_evidence_files FOR SELECT
  USING (
    store_id = app_security.current_store_id()
    AND (
      pg_catalog.current_setting('app.actor_type', true) = 'admin'
      OR (
        pg_catalog.current_setting('app.actor_type', true) = 'member'
        AND member_id = app_security.current_actor_id()
      )
    )
  );

CREATE POLICY after_sale_evidence_files_admin_insert
  ON public.after_sale_evidence_files FOR INSERT
  WITH CHECK (
    store_id = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'admin'
  );

CREATE POLICY after_sale_evidence_files_member_insert
  ON public.after_sale_evidence_files FOR INSERT
  WITH CHECK (
    store_id = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'member'
    AND member_id = app_security.current_actor_id()
    AND after_sale_id IS NULL AND status = 'PENDING'
    AND object_key IS NULL AND derivative_object_keys IS NULL
    AND scan_temporary_object_key IS NULL AND scan_result_code IS NULL
    AND claim_deadline_at IS NULL AND claimed_at IS NULL
    AND retention_deadline_at IS NULL AND NOT legal_hold_active
    AND held_at IS NULL AND held_by IS NULL AND hold_reason IS NULL
    AND delete_attempt_count = 0 AND next_delete_attempt_at IS NULL
    AND delete_error_code IS NULL AND deleted_at IS NULL AND version = 1
  );

CREATE POLICY after_sale_evidence_files_admin_update
  ON public.after_sale_evidence_files FOR UPDATE
  USING (
    store_id = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'admin'
  )
  WITH CHECK (
    store_id = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'admin'
  );

CREATE POLICY after_sale_evidence_files_member_claim
  ON public.after_sale_evidence_files FOR UPDATE
  USING (
    store_id = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'member'
    AND member_id = app_security.current_actor_id()
    AND after_sale_id IS NULL
    AND status = 'READY_UNCLAIMED'
    AND claim_deadline_at IS NOT NULL
    AND pg_catalog.clock_timestamp() < claim_deadline_at
    AND NOT legal_hold_active
  )
  WITH CHECK (
    store_id = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'member'
    AND member_id = app_security.current_actor_id()
    AND after_sale_id IS NOT NULL
    AND status = 'READY'
    AND NOT legal_hold_active
    AND EXISTS (
      SELECT 1 FROM public.after_sales AS owned_case
      WHERE owned_case.store_id = after_sale_evidence_files.store_id
        AND owned_case.id = after_sale_evidence_files.after_sale_id
        AND owned_case.member_id = app_security.current_actor_id()
    )
  );

-- D0 replaced this M6.2 function in place to add SYSTEM/correlation facts.
CREATE OR REPLACE FUNCTION app_security.append_m62_evidence_transition()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE transition_event text;
DECLARE transition_actor public."AuditActorType";
BEGIN
  IF NEW.status = OLD.status THEN RETURN NULL; END IF;
  transition_event := CASE
    WHEN OLD.status = 'PENDING' AND NEW.status = 'READY_UNCLAIMED' THEN 'SCAN_PASSED'
    WHEN OLD.status = 'PENDING' AND NEW.status = 'FAILED' THEN 'SCAN_FAILED'
    WHEN NEW.status = 'QUARANTINED' THEN 'QUARANTINE'
    WHEN OLD.status = 'READY_UNCLAIMED' AND NEW.status = 'READY' THEN 'CLAIM'
    WHEN NEW.status = 'DELETION_PENDING' AND OLD.status = 'DELETE_FAILED' THEN 'RETRY_DELETE'
    WHEN NEW.status = 'DELETION_PENDING' THEN 'EXPIRE'
    WHEN NEW.status = 'DELETED' THEN 'DELETE_SUCCEEDED'
    WHEN NEW.status = 'DELETE_FAILED' THEN 'DELETE_FAILED'
  END;
  transition_actor := CASE pg_catalog.current_setting('app.actor_type', true)
    WHEN 'member' THEN 'MEMBER'::public."AuditActorType"
    ELSE 'ADMIN'::public."AuditActorType" END;
  INSERT INTO public.after_sale_evidence_transitions
    (store_id, evidence_file_id, from_status, to_status, event, actor_type, actor_id, error_code)
  VALUES (NEW.store_id, NEW.id, OLD.status, NEW.status, transition_event,
    transition_actor, app_security.current_actor_id(), NEW.delete_error_code);
  RETURN NULL;
END
$$;

CREATE TRIGGER after_sale_evidence_files_initial_shape_guard
  BEFORE INSERT ON public.after_sale_evidence_files
  FOR EACH ROW EXECUTE FUNCTION app_security.validate_m62_evidence_initial_shape();
CREATE TRIGGER after_sale_evidence_files_member_claim_guard
  BEFORE UPDATE ON public.after_sale_evidence_files
  FOR EACH ROW EXECUTE FUNCTION app_security.validate_m62_member_evidence_claim();
CREATE TRIGGER after_sale_evidence_files_lifecycle_guard
  BEFORE UPDATE ON public.after_sale_evidence_files
  FOR EACH ROW EXECUTE FUNCTION app_security.validate_m62_evidence_lifecycle();
CREATE TRIGGER after_sale_evidence_files_append_transition
  AFTER UPDATE OF status ON public.after_sale_evidence_files
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION app_security.append_m62_evidence_transition();

REVOKE ALL ON FUNCTION app_security.validate_m62_evidence_initial_shape() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_security.validate_m62_evidence_initial_shape()
  FROM zalo_shop_runtime;
REVOKE ALL ON FUNCTION app_security.validate_m62_member_evidence_claim() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_security.validate_m62_member_evidence_claim()
  FROM zalo_shop_runtime;
REVOKE ALL ON FUNCTION app_security.validate_m62_evidence_lifecycle() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_security.validate_m62_evidence_lifecycle()
  FROM zalo_shop_runtime;
REVOKE ALL ON FUNCTION app_security.append_m62_evidence_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_security.append_m62_evidence_transition()
  FROM zalo_shop_runtime;

COMMIT;
