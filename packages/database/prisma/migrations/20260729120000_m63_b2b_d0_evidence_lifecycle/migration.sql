-- M6.3-B2b-D0 deliberately requires an empty evidence runtime. B2b routes have
-- never been enabled; failing here is safer than guessing lifecycle facts for
-- objects that may already exist outside the database.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.after_sale_evidence_files LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.after_sale_evidence_transitions LIMIT 1)
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
    RAISE EXCEPTION 'M6.3-B2b-D0 requires an empty evidence runtime; run the reviewed forward repair first'
      USING ERRCODE = '55000';
  END IF;
END
$$;

CREATE TYPE public.after_sale_evidence_object_role AS ENUM (
  'ORIGINAL', 'DERIVATIVE', 'SCAN_TEMPORARY'
);

ALTER TABLE public.after_sale_evidence_files
  ADD COLUMN upload_deadline_at timestamptz(6),
  ADD COLUMN confirmed_at timestamptz(6),
  ADD COLUMN scan_requested_at timestamptz(6),
  ADD COLUMN scan_completed_at timestamptz(6),
  ADD COLUMN scan_generation integer NOT NULL DEFAULT 0,
  ADD COLUMN scanner_engine varchar(64),
  ADD COLUMN scanner_engine_version varchar(64),
  ADD COLUMN scanner_signature_version varchar(128),
  ADD COLUMN ordinary_access_deadline_at timestamptz(6),
  ADD COLUMN delete_exhausted_at timestamptz(6);

ALTER TABLE public.after_sale_evidence_transitions
  ADD COLUMN correlation_id varchar(128) NOT NULL,
  ADD COLUMN evidence_version integer NOT NULL,
  ADD COLUMN scan_generation integer NOT NULL,
  ADD CONSTRAINT after_sale_evidence_transitions_b2b_version_check CHECK (
    evidence_version > 0 AND scan_generation >= 0
  );

-- Align the inherited M6.2 evidence relations with Prisma's default update
-- action. This is metadata-only in practice because referenced identifiers are
-- immutable, but keeping the database contract exact prevents future drift.
ALTER TABLE public.after_sale_evidence_files
  DROP CONSTRAINT after_sale_evidence_files_store_id_fkey,
  DROP CONSTRAINT after_sale_evidence_files_member_fkey,
  DROP CONSTRAINT after_sale_evidence_files_case_member_fkey,
  DROP CONSTRAINT after_sale_evidence_files_held_by_fkey,
  ADD CONSTRAINT after_sale_evidence_files_store_id_fkey
    FOREIGN KEY (store_id) REFERENCES public.stores(id)
      ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT after_sale_evidence_files_member_fkey
    FOREIGN KEY (store_id, member_id) REFERENCES public.members(store_id, id)
      ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT after_sale_evidence_files_case_member_fkey
    FOREIGN KEY (store_id, after_sale_id, member_id)
    REFERENCES public.after_sales(store_id, id, member_id)
      ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT after_sale_evidence_files_held_by_fkey
    FOREIGN KEY (held_by) REFERENCES public.admin_users(id)
      ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE public.after_sale_evidence_transitions
  DROP CONSTRAINT after_sale_evidence_transitions_store_id_fkey,
  DROP CONSTRAINT after_sale_evidence_transitions_file_fkey,
  ADD CONSTRAINT after_sale_evidence_transitions_store_id_fkey
    FOREIGN KEY (store_id) REFERENCES public.stores(id)
      ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT after_sale_evidence_transitions_file_fkey
    FOREIGN KEY (store_id, evidence_file_id)
    REFERENCES public.after_sale_evidence_files(store_id, id)
      ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE public.after_sale_evidence_objects (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL,
  evidence_file_id uuid NOT NULL,
  object_role public.after_sale_evidence_object_role NOT NULL,
  object_key text,
  object_key_hash char(64) NOT NULL,
  deleted_at timestamptz(6),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(6) NOT NULL,
  CONSTRAINT after_sale_evidence_objects_pkey PRIMARY KEY (id),
  CONSTRAINT after_sale_evidence_objects_store_id_fkey
    FOREIGN KEY (store_id) REFERENCES public.stores(id)
      ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT after_sale_evidence_objects_file_fkey
    FOREIGN KEY (store_id, evidence_file_id)
    REFERENCES public.after_sale_evidence_files(store_id, id)
      ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT after_sale_evidence_objects_key_hash_check
    CHECK (object_key_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT after_sale_evidence_objects_lifecycle_check CHECK (
    version > 0
    AND (
      (object_key IS NOT NULL AND deleted_at IS NULL)
      OR (object_key IS NULL AND deleted_at IS NOT NULL)
    )
  )
);

CREATE UNIQUE INDEX after_sale_evidence_objects_store_id_id_key
  ON public.after_sale_evidence_objects(store_id, id);
CREATE UNIQUE INDEX after_sale_evidence_objects_object_key_key
  ON public.after_sale_evidence_objects(object_key);
CREATE UNIQUE INDEX after_sale_evidence_objects_object_key_hash_key
  ON public.after_sale_evidence_objects(object_key_hash);
CREATE INDEX after_sale_evidence_objects_store_id_evidence_file_id_objec_idx
  ON public.after_sale_evidence_objects(store_id, evidence_file_id, object_role, id);
CREATE UNIQUE INDEX after_sale_evidence_objects_one_original_idx
  ON public.after_sale_evidence_objects(store_id, evidence_file_id)
  WHERE object_role = 'ORIGINAL';
CREATE UNIQUE INDEX after_sale_evidence_objects_one_scan_temporary_idx
  ON public.after_sale_evidence_objects(store_id, evidence_file_id)
  WHERE object_role = 'SCAN_TEMPORARY' AND deleted_at IS NULL;

DROP INDEX public.after_sale_evidence_files_status_next_delete_attempt_at_idx;
CREATE INDEX after_sale_evidence_files_store_id_member_id_status_id_idx
  ON public.after_sale_evidence_files(store_id, member_id, status, id);
CREATE INDEX after_sale_evidence_files_store_id_status_next_delete_attem_idx
  ON public.after_sale_evidence_files(store_id, status, next_delete_attempt_at, id);

ALTER TABLE public.after_sale_evidence_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.after_sale_evidence_objects FORCE ROW LEVEL SECURITY;

CREATE POLICY after_sale_evidence_objects_member_insert
  ON public.after_sale_evidence_objects FOR INSERT
  WITH CHECK (
    store_id = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'member'
    AND object_role = 'ORIGINAL'
    AND EXISTS (
      SELECT 1
      FROM public.after_sale_evidence_files evidence
      WHERE evidence.store_id = after_sale_evidence_objects.store_id
        AND evidence.id = after_sale_evidence_objects.evidence_file_id
        AND evidence.member_id = app_security.current_actor_id()
        AND evidence.status = 'PENDING'
        AND evidence.confirmed_at IS NULL
        AND evidence.object_key = after_sale_evidence_objects.object_key
    )
  );

CREATE POLICY after_sale_evidence_objects_system_scope
  ON public.after_sale_evidence_objects
  USING (
    store_id = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'system'
    AND pg_catalog.current_setting('app.system_scope', true) = 'after-sale-evidence-lifecycle'
    AND app_security.current_actor_id() = '00000000-0000-4000-8000-000000000006'::uuid
  )
  WITH CHECK (
    store_id = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'system'
    AND pg_catalog.current_setting('app.system_scope', true) = 'after-sale-evidence-lifecycle'
    AND app_security.current_actor_id() = '00000000-0000-4000-8000-000000000006'::uuid
  );

REVOKE ALL ON public.after_sale_evidence_objects FROM PUBLIC;
REVOKE ALL ON public.after_sale_evidence_objects FROM zalo_shop_runtime;
GRANT SELECT, INSERT ON public.after_sale_evidence_objects TO zalo_shop_runtime;
GRANT UPDATE (object_key, deleted_at, version, updated_at)
  ON public.after_sale_evidence_objects TO zalo_shop_runtime;

CREATE OR REPLACE FUNCTION app_security.validate_m63_b2b_evidence_object()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE evidence record;
DECLARE expected_key text;
BEGIN
  SELECT id, store_id, member_id, status, confirmed_at, object_key, legal_hold_active
  INTO evidence
  FROM public.after_sale_evidence_files
  WHERE store_id = NEW.store_id AND id = NEW.evidence_file_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'evidence object requires an owned evidence row' USING ERRCODE = '23503';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.object_key IS NULL OR NEW.deleted_at IS NOT NULL OR NEW.version <> 1
       OR NEW.updated_at < NEW.created_at
       OR NEW.object_key_hash <> encode(digest(NEW.object_key, 'sha256'), 'hex')
    THEN
      RAISE EXCEPTION 'evidence object initial shape is invalid' USING ERRCODE = '23514';
    END IF;
    IF NEW.object_role = 'ORIGINAL' THEN
      expected_key := substring(NEW.object_key FROM
        '^([a-z][a-z0-9-]{1,31})/[0-9a-f-]{36}/staged/[0-9a-f-]{36}/original$');
      IF expected_key IS NULL
         OR split_part(NEW.object_key, '/', 2) <> NEW.store_id::text
         OR split_part(NEW.object_key, '/', 4) <> NEW.evidence_file_id::text
         OR pg_catalog.current_setting('app.actor_type', true) IS DISTINCT FROM 'member'
         OR app_security.current_actor_id() IS DISTINCT FROM evidence.member_id
         OR evidence.status IS DISTINCT FROM 'PENDING'
         OR evidence.confirmed_at IS NOT NULL
         OR evidence.object_key IS DISTINCT FROM NEW.object_key
      THEN
        RAISE EXCEPTION 'original evidence object is outside its owner-bound staged scope'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      expected_key := CASE NEW.object_role
        WHEN 'DERIVATIVE' THEN substring(NEW.object_key FROM
          '^([a-z][a-z0-9-]{1,31})/[0-9a-f-]{36}/derived/[0-9a-f-]{36}/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')
        WHEN 'SCAN_TEMPORARY' THEN substring(NEW.object_key FROM
          '^([a-z][a-z0-9-]{1,31})/[0-9a-f-]{36}/scan/[0-9a-f-]{36}/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')
      END;
      IF pg_catalog.current_setting('app.actor_type', true) IS DISTINCT FROM 'system'
         OR pg_catalog.current_setting('app.system_scope', true)
            IS DISTINCT FROM 'after-sale-evidence-lifecycle'
         OR app_security.current_actor_id()
            IS DISTINCT FROM '00000000-0000-4000-8000-000000000006'::uuid
         OR evidence.status = 'DELETED'
         OR expected_key IS NULL
         OR split_part(NEW.object_key, '/', 2) <> NEW.store_id::text
         OR split_part(NEW.object_key, '/', 4) <> NEW.evidence_file_id::text
      THEN
        RAISE EXCEPTION 'derived evidence object is outside its SYSTEM-bound namespace'
          USING ERRCODE = '42501';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF pg_catalog.current_setting('app.actor_type', true) IS DISTINCT FROM 'system'
     OR pg_catalog.current_setting('app.system_scope', true)
        IS DISTINCT FROM 'after-sale-evidence-lifecycle'
     OR app_security.current_actor_id()
        IS DISTINCT FROM '00000000-0000-4000-8000-000000000006'::uuid
     OR evidence.status IS DISTINCT FROM 'DELETION_PENDING'
     OR evidence.legal_hold_active
     OR OLD.object_key IS NULL OR NEW.object_key IS NOT NULL
     OR NEW.deleted_at IS NULL OR NEW.version <> OLD.version + 1
     OR NEW.store_id <> OLD.store_id OR NEW.id <> OLD.id
     OR NEW.evidence_file_id <> OLD.evidence_file_id
     OR NEW.object_role <> OLD.object_role
     OR NEW.object_key_hash <> OLD.object_key_hash
     OR NEW.created_at <> OLD.created_at
     OR NEW.updated_at < OLD.updated_at OR NEW.updated_at < NEW.deleted_at
  THEN
    RAISE EXCEPTION 'evidence object update must be a due SYSTEM deletion fact'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER after_sale_evidence_objects_lifecycle_guard
  BEFORE INSERT OR UPDATE ON public.after_sale_evidence_objects
  FOR EACH ROW EXECUTE FUNCTION app_security.validate_m63_b2b_evidence_object();

REVOKE ALL ON FUNCTION app_security.validate_m63_b2b_evidence_object() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_security.validate_m63_b2b_evidence_object()
  FROM zalo_shop_runtime;

DROP POLICY after_sale_evidence_files_select_scope
  ON public.after_sale_evidence_files;
DROP POLICY after_sale_evidence_files_admin_insert
  ON public.after_sale_evidence_files;
DROP POLICY after_sale_evidence_files_member_insert
  ON public.after_sale_evidence_files;
DROP POLICY after_sale_evidence_files_admin_update
  ON public.after_sale_evidence_files;
DROP POLICY after_sale_evidence_files_member_claim
  ON public.after_sale_evidence_files;

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
      OR (
        pg_catalog.current_setting('app.actor_type', true) = 'system'
        AND pg_catalog.current_setting('app.system_scope', true)
          = 'after-sale-evidence-lifecycle'
        AND app_security.current_actor_id()
          = '00000000-0000-4000-8000-000000000006'::uuid
      )
    )
  );

CREATE POLICY after_sale_evidence_files_member_insert
  ON public.after_sale_evidence_files FOR INSERT
  WITH CHECK (
    store_id = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'member'
    AND member_id = app_security.current_actor_id()
    AND after_sale_id IS NULL AND status = 'PENDING'
    AND object_key IS NOT NULL
    AND derivative_object_keys IS NULL AND scan_temporary_object_key IS NULL
    AND scan_result_code IS NULL AND upload_deadline_at > pg_catalog.clock_timestamp()
    AND confirmed_at IS NULL AND scan_requested_at IS NULL
    AND scan_completed_at IS NULL AND scan_generation = 0
    AND scanner_engine IS NULL AND scanner_engine_version IS NULL
    AND scanner_signature_version IS NULL
    AND claim_deadline_at IS NULL AND claimed_at IS NULL
    AND ordinary_access_deadline_at IS NULL AND retention_deadline_at IS NULL
    AND NOT legal_hold_active AND held_at IS NULL AND held_by IS NULL
    AND hold_reason IS NULL AND delete_attempt_count = 0
    AND next_delete_attempt_at IS NULL AND delete_error_code IS NULL
    AND delete_exhausted_at IS NULL AND deleted_at IS NULL AND version = 1
  );

CREATE POLICY after_sale_evidence_files_member_confirm
  ON public.after_sale_evidence_files FOR UPDATE
  USING (
    store_id = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'member'
    AND member_id = app_security.current_actor_id()
    AND after_sale_id IS NULL AND status = 'PENDING'
    AND confirmed_at IS NULL AND upload_deadline_at > pg_catalog.clock_timestamp()
  )
  WITH CHECK (
    store_id = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'member'
    AND member_id = app_security.current_actor_id()
    AND after_sale_id IS NULL AND status = 'PENDING'
    AND confirmed_at IS NOT NULL AND scan_requested_at = confirmed_at
  );

CREATE POLICY after_sale_evidence_files_member_claim
  ON public.after_sale_evidence_files FOR UPDATE
  USING (
    store_id = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'member'
    AND member_id = app_security.current_actor_id()
    AND after_sale_id IS NULL AND status = 'READY_UNCLAIMED'
    AND claim_deadline_at > pg_catalog.clock_timestamp()
    AND NOT legal_hold_active
  )
  WITH CHECK (
    store_id = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'member'
    AND member_id = app_security.current_actor_id()
    AND after_sale_id IS NOT NULL AND status = 'READY'
    AND NOT legal_hold_active
    AND EXISTS (
      SELECT 1 FROM public.after_sales owned_case
      WHERE owned_case.store_id = after_sale_evidence_files.store_id
        AND owned_case.id = after_sale_evidence_files.after_sale_id
        AND owned_case.member_id = app_security.current_actor_id()
    )
  );

CREATE POLICY after_sale_evidence_files_admin_hold
  ON public.after_sale_evidence_files FOR UPDATE
  USING (
    store_id = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'admin'
  )
  WITH CHECK (
    store_id = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'admin'
  );

CREATE POLICY after_sale_evidence_files_system_lifecycle
  ON public.after_sale_evidence_files FOR UPDATE
  USING (
    store_id = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'system'
    AND pg_catalog.current_setting('app.system_scope', true)
      = 'after-sale-evidence-lifecycle'
    AND app_security.current_actor_id()
      = '00000000-0000-4000-8000-000000000006'::uuid
  )
  WITH CHECK (
    store_id = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'system'
    AND pg_catalog.current_setting('app.system_scope', true)
      = 'after-sale-evidence-lifecycle'
    AND app_security.current_actor_id()
      = '00000000-0000-4000-8000-000000000006'::uuid
  );

GRANT UPDATE (
  original_filename, upload_deadline_at, confirmed_at, scan_requested_at, scan_completed_at,
  scan_generation, scanner_engine, scanner_engine_version,
  scanner_signature_version, ordinary_access_deadline_at, delete_exhausted_at
) ON public.after_sale_evidence_files TO zalo_shop_runtime;

DROP TRIGGER after_sale_evidence_files_initial_shape_guard
  ON public.after_sale_evidence_files;
DROP TRIGGER after_sale_evidence_files_member_claim_guard
  ON public.after_sale_evidence_files;
DROP TRIGGER after_sale_evidence_files_lifecycle_guard
  ON public.after_sale_evidence_files;

CREATE OR REPLACE FUNCTION app_security.validate_m63_b2b_evidence_initial_shape()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE expected_key text;
BEGIN
  expected_key := substring(NEW.object_key FROM
    '^([a-z][a-z0-9-]{1,31})/[0-9a-f-]{36}/staged/[0-9a-f-]{36}/original$');
  IF NEW.after_sale_id IS NOT NULL OR NEW.status <> 'PENDING'
     OR NEW.object_key IS NULL OR expected_key IS NULL
     OR split_part(NEW.object_key, '/', 2) <> NEW.store_id::text
     OR split_part(NEW.object_key, '/', 4) <> NEW.id::text
     OR NEW.derivative_object_keys IS NOT NULL
     OR NEW.scan_temporary_object_key IS NOT NULL
     OR NEW.scan_result_code IS NOT NULL
     OR NEW.upload_deadline_at IS NULL
     OR NEW.upload_deadline_at <= pg_catalog.clock_timestamp()
     OR NEW.confirmed_at IS NOT NULL OR NEW.scan_requested_at IS NOT NULL
     OR NEW.scan_completed_at IS NOT NULL OR NEW.scan_generation <> 0
     OR NEW.scanner_engine IS NOT NULL OR NEW.scanner_engine_version IS NOT NULL
     OR NEW.scanner_signature_version IS NOT NULL
     OR NEW.claim_deadline_at IS NOT NULL OR NEW.claimed_at IS NOT NULL
     OR NEW.ordinary_access_deadline_at IS NOT NULL
     OR NEW.retention_deadline_at IS NOT NULL
     OR NEW.legal_hold_active OR NEW.held_at IS NOT NULL OR NEW.held_by IS NOT NULL
     OR NEW.hold_reason IS NOT NULL OR NEW.delete_attempt_count <> 0
     OR NEW.next_delete_attempt_at IS NOT NULL OR NEW.delete_error_code IS NOT NULL
     OR NEW.delete_exhausted_at IS NOT NULL OR NEW.deleted_at IS NOT NULL
     OR NEW.version <> 1
     OR pg_catalog.current_setting('app.actor_type', true) IS DISTINCT FROM 'member'
     OR NEW.member_id IS DISTINCT FROM app_security.current_actor_id()
  THEN
    RAISE EXCEPTION 'evidence must be initialized in its owner-bound staged namespace'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER after_sale_evidence_files_initial_shape_guard
  BEFORE INSERT ON public.after_sale_evidence_files
  FOR EACH ROW EXECUTE FUNCTION app_security.validate_m63_b2b_evidence_initial_shape();

CREATE OR REPLACE FUNCTION app_security.validate_m63_b2b_evidence_lifecycle()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE actor text := pg_catalog.current_setting('app.actor_type', true);
DECLARE scope text := pg_catalog.current_setting('app.system_scope', true);
DECLARE effective_deadline timestamptz;
BEGIN
  effective_deadline := CASE OLD.status
    WHEN 'PENDING' THEN OLD.upload_deadline_at
    WHEN 'READY_UNCLAIMED' THEN OLD.claim_deadline_at
    WHEN 'READY' THEN OLD.retention_deadline_at
    WHEN 'FAILED' THEN OLD.claim_deadline_at
    WHEN 'QUARANTINED' THEN COALESCE(
      OLD.retention_deadline_at, OLD.claim_deadline_at
    )
    WHEN 'DELETION_PENDING' THEN COALESCE(
      OLD.retention_deadline_at, OLD.claim_deadline_at, OLD.upload_deadline_at
    )
    WHEN 'DELETE_FAILED' THEN OLD.next_delete_attempt_at
    ELSE NULL
  END;

  IF OLD.status = 'DELETED' THEN
    RAISE EXCEPTION 'deleted evidence metadata is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at
     OR NEW.store_id <> OLD.store_id OR NEW.id <> OLD.id
     OR NEW.member_id <> OLD.member_id OR NEW.upload_session_id <> OLD.upload_session_id
     OR NEW.mime_type <> OLD.mime_type OR NEW.byte_size <> OLD.byte_size
     OR NEW.checksum_sha256 <> OLD.checksum_sha256
  THEN
    RAISE EXCEPTION 'evidence update identity or version is invalid' USING ERRCODE = '23514';
  END IF;

  IF NEW.status = OLD.status THEN
    IF actor = 'member'
       AND OLD.status = 'PENDING' AND OLD.after_sale_id IS NULL
       AND OLD.member_id = app_security.current_actor_id()
       AND OLD.confirmed_at IS NULL AND OLD.upload_deadline_at > pg_catalog.clock_timestamp()
       AND NEW.confirmed_at IS NOT NULL AND NEW.scan_requested_at = NEW.confirmed_at
       AND NEW.confirmed_at < OLD.upload_deadline_at
       AND NEW.confirmed_at <= pg_catalog.clock_timestamp()
       AND NEW.updated_at = NEW.confirmed_at
       AND NEW.scan_generation = OLD.scan_generation + 1
       AND (pg_catalog.to_jsonb(NEW)
         - ARRAY['confirmed_at','scan_requested_at','scan_generation','version','updated_at'])
         IS NOT DISTINCT FROM
         (pg_catalog.to_jsonb(OLD)
         - ARRAY['confirmed_at','scan_requested_at','scan_generation','version','updated_at'])
    THEN
      RETURN NEW;
    END IF;
    IF actor = 'system'
       AND scope = 'after-sale-evidence-lifecycle'
       AND app_security.current_actor_id()
         = '00000000-0000-4000-8000-000000000006'::uuid
       AND OLD.status = 'PENDING' AND OLD.after_sale_id IS NULL
       AND OLD.confirmed_at IS NOT NULL AND OLD.scan_requested_at IS NOT NULL
       AND OLD.scan_completed_at IS NULL AND OLD.scan_result_code IS NULL
       AND NEW.scan_requested_at > OLD.scan_requested_at
       AND NEW.scan_requested_at <= pg_catalog.clock_timestamp()
       AND NEW.updated_at = NEW.scan_requested_at
       AND NEW.scan_generation = OLD.scan_generation + 1
       AND (pg_catalog.to_jsonb(NEW)
         - ARRAY['scan_requested_at','scan_generation','version','updated_at'])
         IS NOT DISTINCT FROM
         (pg_catalog.to_jsonb(OLD)
         - ARRAY['scan_requested_at','scan_generation','version','updated_at'])
    THEN
      RETURN NEW;
    END IF;
    IF actor = 'admin'
       AND (pg_catalog.to_jsonb(NEW)
         - ARRAY['legal_hold_active','held_at','held_by','hold_reason','version','updated_at'])
         IS NOT DISTINCT FROM
         (pg_catalog.to_jsonb(OLD)
         - ARRAY['legal_hold_active','held_at','held_by','hold_reason','version','updated_at'])
       AND (
         (NOT OLD.legal_hold_active AND NEW.legal_hold_active
           AND NEW.held_at IS NOT NULL AND NEW.held_by = app_security.current_actor_id()
           AND NEW.hold_reason IS NOT NULL AND pg_catalog.btrim(NEW.hold_reason) <> '')
         OR (OLD.legal_hold_active AND NOT NEW.legal_hold_active
           AND NEW.held_at IS NULL AND NEW.held_by IS NULL AND NEW.hold_reason IS NULL)
       )
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'same-state evidence update is outside confirm or legal-hold scope'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status::text, NEW.status::text) IN (VALUES
      ('PENDING','READY_UNCLAIMED'),('PENDING','FAILED'),
      ('PENDING','QUARANTINED'),('PENDING','DELETION_PENDING'),
      ('READY_UNCLAIMED','READY'),('READY_UNCLAIMED','QUARANTINED'),
      ('READY_UNCLAIMED','DELETION_PENDING'),('READY','QUARANTINED'),
      ('READY','DELETION_PENDING'),('FAILED','DELETION_PENDING'),
      ('QUARANTINED','DELETION_PENDING'),('DELETION_PENDING','DELETED'),
      ('DELETION_PENDING','DELETE_FAILED'),('DELETE_FAILED','DELETION_PENDING')
    )
  ) THEN
    RAISE EXCEPTION 'invalid evidence status transition' USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'READY_UNCLAIMED' AND NEW.status = 'READY' THEN
    IF actor <> 'member'
       OR OLD.member_id <> app_security.current_actor_id()
       OR OLD.claim_deadline_at IS NULL
       OR pg_catalog.clock_timestamp() >= OLD.claim_deadline_at
       OR OLD.after_sale_id IS NOT NULL OR NEW.after_sale_id IS NULL
       OR NEW.claimed_at IS NULL OR NEW.ordinary_access_deadline_at IS NULL
       OR NEW.retention_deadline_at IS NULL
       OR NEW.ordinary_access_deadline_at <= NEW.claimed_at
       OR NEW.retention_deadline_at <= NEW.ordinary_access_deadline_at
       OR NEW.legal_hold_active
       OR (pg_catalog.to_jsonb(NEW)
         - ARRAY['after_sale_id','status','claimed_at','ordinary_access_deadline_at',
                 'retention_deadline_at','version','updated_at'])
         IS DISTINCT FROM
         (pg_catalog.to_jsonb(OLD)
         - ARRAY['after_sale_id','status','claimed_at','ordinary_access_deadline_at',
                 'retention_deadline_at','version','updated_at'])
    THEN
      RAISE EXCEPTION 'evidence claim is outside its owner-bound window'
        USING ERRCODE = '23514';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'm63b2-after-sale-evidence:' || NEW.store_id::text || ':' || NEW.after_sale_id::text,
      0
    ));
    IF (
      SELECT pg_catalog.count(*)
      FROM public.after_sale_evidence_files claimed
      WHERE claimed.store_id = NEW.store_id
        AND claimed.after_sale_id = NEW.after_sale_id
        AND claimed.id <> NEW.id
    ) >= 6
    THEN
      RAISE EXCEPTION 'an after-sale case cannot claim more than six evidence files'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF actor IS DISTINCT FROM 'system'
     OR scope IS DISTINCT FROM 'after-sale-evidence-lifecycle'
     OR app_security.current_actor_id()
        IS DISTINCT FROM '00000000-0000-4000-8000-000000000006'::uuid
  THEN
    RAISE EXCEPTION 'evidence lifecycle transition requires its dedicated SYSTEM scope'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.status = 'PENDING' AND NEW.status IN ('READY_UNCLAIMED','FAILED','QUARANTINED') THEN
    IF OLD.confirmed_at IS NULL OR OLD.scan_requested_at IS NULL
       OR NEW.scan_completed_at IS NULL OR NEW.scan_result_code IS NULL
       OR NEW.scan_completed_at < OLD.scan_requested_at
       OR NEW.scan_completed_at > pg_catalog.clock_timestamp()
       OR NEW.updated_at <> NEW.scan_completed_at
       OR NEW.scan_result_code !~ '^[A-Z][A-Z0-9_]{1,63}$'
       OR NEW.claim_deadline_at IS NULL
       OR NEW.claim_deadline_at <= NEW.scan_completed_at
       OR (NEW.status = 'READY_UNCLAIMED' AND (
         NEW.scan_result_code <> 'CLEAN' OR NEW.scanner_engine IS NULL
         OR NEW.scanner_engine_version IS NULL OR NEW.scanner_signature_version IS NULL
       ))
       OR (NEW.status <> 'READY_UNCLAIMED' AND NEW.scan_result_code = 'CLEAN')
       OR NEW.after_sale_id IS NOT NULL OR NEW.claimed_at IS NOT NULL
       OR NEW.ordinary_access_deadline_at IS NOT NULL
       OR NEW.retention_deadline_at IS NOT NULL
       OR (pg_catalog.to_jsonb(NEW)
         - ARRAY['status','scan_result_code','scan_completed_at','scanner_engine',
                 'scanner_engine_version','scanner_signature_version','claim_deadline_at',
                 'version','updated_at'])
         IS DISTINCT FROM
         (pg_catalog.to_jsonb(OLD)
         - ARRAY['status','scan_result_code','scan_completed_at','scanner_engine',
                 'scanner_engine_version','scanner_signature_version','claim_deadline_at',
                 'version','updated_at'])
    THEN
      RAISE EXCEPTION 'scan result evidence shape is invalid' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = 'QUARANTINED' AND OLD.status IN ('READY_UNCLAIMED','READY') THEN
    IF NEW.scan_result_code IS NULL OR NEW.scan_result_code = 'CLEAN'
       OR NEW.scan_result_code !~ '^[A-Z][A-Z0-9_]{1,63}$'
       OR NEW.scan_completed_at IS NULL
       OR NEW.scan_completed_at < COALESCE(OLD.scan_completed_at, OLD.scan_requested_at)
       OR NEW.scan_completed_at > pg_catalog.clock_timestamp()
       OR NEW.updated_at <> NEW.scan_completed_at
       OR (pg_catalog.to_jsonb(NEW)
         - ARRAY['status','scan_result_code','scan_completed_at','scanner_engine',
                 'scanner_engine_version','scanner_signature_version','version','updated_at'])
         IS DISTINCT FROM
         (pg_catalog.to_jsonb(OLD)
         - ARRAY['status','scan_result_code','scan_completed_at','scanner_engine',
                 'scanner_engine_version','scanner_signature_version','version','updated_at'])
    THEN
      RAISE EXCEPTION 'late malicious evidence result is invalid' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = 'DELETION_PENDING' THEN
    IF NEW.legal_hold_active OR effective_deadline IS NULL
       OR pg_catalog.clock_timestamp() < effective_deadline
       OR (pg_catalog.to_jsonb(NEW) - ARRAY['status','next_delete_attempt_at',
             'delete_error_code','delete_exhausted_at','version','updated_at'])
          IS DISTINCT FROM
          (pg_catalog.to_jsonb(OLD) - ARRAY['status','next_delete_attempt_at',
             'delete_error_code','delete_exhausted_at','version','updated_at'])
       OR (OLD.status = 'DELETE_FAILED' AND (
         NEW.next_delete_attempt_at IS NOT NULL OR NEW.delete_error_code IS NOT NULL
         OR NEW.delete_exhausted_at IS NOT NULL
       ))
    THEN
      RAISE EXCEPTION 'evidence deletion is not due' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'DELETION_PENDING' AND NEW.status = 'DELETE_FAILED' THEN
    IF NEW.legal_hold_active
       OR NEW.delete_attempt_count <> OLD.delete_attempt_count + 1
       OR NEW.delete_attempt_count > 8
       OR NEW.delete_error_code IS NULL
       OR NEW.delete_error_code !~ '^[A-Z][A-Z0-9_]{1,63}$'
       OR (NEW.delete_attempt_count < 8 AND (
         NEW.next_delete_attempt_at IS NULL
         OR NEW.next_delete_attempt_at < NEW.updated_at + interval '60 seconds'
         OR NEW.next_delete_attempt_at > NEW.updated_at + interval '6 hours'
         OR NEW.delete_exhausted_at IS NOT NULL
       ))
       OR (NEW.delete_attempt_count = 8 AND (
         NEW.next_delete_attempt_at IS NOT NULL
         OR NEW.delete_exhausted_at IS DISTINCT FROM NEW.updated_at
       ))
       OR (pg_catalog.to_jsonb(NEW)
         - ARRAY['status','delete_attempt_count','next_delete_attempt_at',
                 'delete_error_code','delete_exhausted_at','version','updated_at'])
         IS DISTINCT FROM
         (pg_catalog.to_jsonb(OLD)
         - ARRAY['status','delete_attempt_count','next_delete_attempt_at',
                 'delete_error_code','delete_exhausted_at','version','updated_at'])
    THEN
      RAISE EXCEPTION 'failed evidence deletion retry shape is invalid'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'DELETION_PENDING' AND NEW.status = 'DELETED' THEN
    IF NEW.legal_hold_active OR effective_deadline IS NULL
       OR pg_catalog.clock_timestamp() < effective_deadline
       OR NEW.deleted_at IS NULL OR NEW.object_key IS NOT NULL
       OR NEW.derivative_object_keys IS NOT NULL OR NEW.scan_temporary_object_key IS NOT NULL
       OR NEW.original_filename IS NOT NULL OR NEW.scan_result_code IS NOT NULL
       OR NEW.scanner_engine IS NOT NULL OR NEW.scanner_engine_version IS NOT NULL
       OR NEW.scanner_signature_version IS NOT NULL
       OR NEW.next_delete_attempt_at IS NOT NULL OR NEW.delete_error_code IS NOT NULL
       OR NEW.delete_exhausted_at IS NOT NULL
       OR EXISTS (
         SELECT 1 FROM public.after_sale_evidence_objects object
         WHERE object.store_id = NEW.store_id AND object.evidence_file_id = NEW.id
           AND object.object_key IS NOT NULL
       )
       OR (pg_catalog.to_jsonb(NEW)
         - ARRAY['object_key','derivative_object_keys','scan_temporary_object_key',
                 'original_filename','scan_result_code','scanner_engine',
                 'scanner_engine_version','scanner_signature_version','status',
                 'next_delete_attempt_at','delete_error_code','delete_exhausted_at',
                 'deleted_at','version','updated_at'])
         IS DISTINCT FROM
         (pg_catalog.to_jsonb(OLD)
         - ARRAY['object_key','derivative_object_keys','scan_temporary_object_key',
                 'original_filename','scan_result_code','scanner_engine',
                 'scanner_engine_version','scanner_signature_version','status',
                 'next_delete_attempt_at','delete_error_code','delete_exhausted_at',
                 'deleted_at','version','updated_at'])
    THEN
      RAISE EXCEPTION 'evidence deletion completion is invalid' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'evidence lifecycle transition is not implemented by B2b-D0'
    USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER after_sale_evidence_files_lifecycle_guard
  BEFORE UPDATE ON public.after_sale_evidence_files
  FOR EACH ROW EXECUTE FUNCTION app_security.validate_m63_b2b_evidence_lifecycle();

REVOKE ALL ON FUNCTION app_security.validate_m63_b2b_evidence_initial_shape() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_security.validate_m63_b2b_evidence_lifecycle() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_security.validate_m63_b2b_evidence_initial_shape()
  FROM zalo_shop_runtime;
REVOKE ALL ON FUNCTION app_security.validate_m63_b2b_evidence_lifecycle()
  FROM zalo_shop_runtime;

DROP TRIGGER after_sale_evidence_files_append_transition
  ON public.after_sale_evidence_files;

CREATE OR REPLACE FUNCTION app_security.append_m62_evidence_transition()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE transition_event text;
DECLARE transition_actor public."AuditActorType";
DECLARE correlation text := NULLIF(
  pg_catalog.current_setting('app.correlation_id', true), ''
);
DECLARE initial_scan_request boolean;
DECLARE system_rescan_request boolean;
BEGIN
  initial_scan_request := NEW.status = OLD.status
    AND OLD.status = 'PENDING'
    AND OLD.confirmed_at IS NULL AND NEW.confirmed_at IS NOT NULL
    AND NEW.scan_requested_at = NEW.confirmed_at
    AND NEW.scan_generation = OLD.scan_generation + 1;
  system_rescan_request := NEW.status = OLD.status
    AND OLD.status = 'PENDING'
    AND OLD.confirmed_at IS NOT NULL
    AND NEW.confirmed_at IS NOT DISTINCT FROM OLD.confirmed_at
    AND NEW.scan_requested_at > OLD.scan_requested_at
    AND NEW.scan_generation = OLD.scan_generation + 1;
  IF NEW.status = OLD.status AND NOT (initial_scan_request OR system_rescan_request) THEN
    RETURN NULL;
  END IF;
  IF correlation IS NULL THEN
    RAISE EXCEPTION 'evidence transition requires a correlation id' USING ERRCODE = '23514';
  END IF;
  transition_event := CASE
    WHEN initial_scan_request OR system_rescan_request THEN 'SCAN_REQUESTED'
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
    WHEN 'system' THEN 'SYSTEM'::public."AuditActorType"
  END;
  IF transition_event IS NULL OR transition_actor IS NULL
     OR (transition_event = 'CLAIM' AND transition_actor <> 'MEMBER')
     OR (transition_event = 'SCAN_REQUESTED' AND NOT (
       (initial_scan_request AND transition_actor = 'MEMBER')
       OR (system_rescan_request AND transition_actor = 'SYSTEM')
     ))
     OR (transition_event NOT IN ('CLAIM','SCAN_REQUESTED')
       AND transition_actor <> 'SYSTEM')
     OR (transition_actor = 'SYSTEM' AND (
       pg_catalog.current_setting('app.system_scope', true)
         IS DISTINCT FROM 'after-sale-evidence-lifecycle'
       OR app_security.current_actor_id()
         IS DISTINCT FROM '00000000-0000-4000-8000-000000000006'::uuid
     ))
  THEN
    RAISE EXCEPTION 'evidence transition actor or event is outside its allowlist'
      USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.after_sale_evidence_transitions (
    store_id, evidence_file_id, from_status, to_status, event,
    actor_type, actor_id, error_code, correlation_id, evidence_version,
    scan_generation
  ) VALUES (
    NEW.store_id, NEW.id, OLD.status, NEW.status, transition_event,
    transition_actor, app_security.current_actor_id(),
    CASE
      WHEN NEW.status IN ('FAILED','QUARANTINED') THEN NEW.scan_result_code
      WHEN NEW.status = 'DELETE_FAILED' THEN NEW.delete_error_code
      ELSE NULL
    END,
    correlation, NEW.version, NEW.scan_generation
  );
  RETURN NULL;
END
$$;

CREATE TRIGGER after_sale_evidence_files_append_transition
  AFTER UPDATE OF status, confirmed_at, scan_requested_at, scan_generation
  ON public.after_sale_evidence_files
  FOR EACH ROW WHEN (
    OLD.status IS DISTINCT FROM NEW.status
    OR OLD.confirmed_at IS DISTINCT FROM NEW.confirmed_at
    OR OLD.scan_requested_at IS DISTINCT FROM NEW.scan_requested_at
    OR OLD.scan_generation IS DISTINCT FROM NEW.scan_generation
  )
  EXECUTE FUNCTION app_security.append_m62_evidence_transition();

REVOKE ALL ON FUNCTION app_security.append_m62_evidence_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_security.append_m62_evidence_transition()
  FROM zalo_shop_runtime;

CREATE OR REPLACE FUNCTION app_security.validate_m63_b2b_original_binding()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE evidence_id uuid;
DECLARE target_store_id uuid;
DECLARE evidence record;
DECLARE active_object_count integer;
DECLARE active_original_count integer;
BEGIN
  IF TG_TABLE_NAME = 'after_sale_evidence_files' THEN
    evidence_id := NEW.id;
    target_store_id := NEW.store_id;
  ELSIF TG_OP = 'DELETE' THEN
    evidence_id := OLD.evidence_file_id;
    target_store_id := OLD.store_id;
  ELSE
    evidence_id := NEW.evidence_file_id;
    target_store_id := NEW.store_id;
  END IF;
  SELECT status, object_key INTO evidence
  FROM public.after_sale_evidence_files
  WHERE store_id = target_store_id AND id = evidence_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT pg_catalog.count(*)::integer INTO active_object_count
  FROM public.after_sale_evidence_objects object
  WHERE object.store_id = target_store_id
    AND object.evidence_file_id = evidence_id
    AND object.object_key IS NOT NULL;
  SELECT pg_catalog.count(*)::integer INTO active_original_count
  FROM public.after_sale_evidence_objects object
  WHERE object.store_id = target_store_id
    AND object.evidence_file_id = evidence_id
    AND object.object_role = 'ORIGINAL'
    AND object.object_key IS NOT NULL
    AND object.object_key IS NOT DISTINCT FROM evidence.object_key;
  IF evidence.status = 'DELETED' THEN
    IF evidence.object_key IS NOT NULL OR active_object_count <> 0 THEN
      RAISE EXCEPTION 'deleted evidence cannot retain any active object'
        USING ERRCODE = '23514';
    END IF;
  ELSIF evidence.object_key IS NULL OR active_original_count <> 1 THEN
    RAISE EXCEPTION 'evidence requires exactly one matching active original object'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER after_sale_evidence_files_original_binding_guard
  AFTER INSERT OR UPDATE ON public.after_sale_evidence_files
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app_security.validate_m63_b2b_original_binding();

CREATE CONSTRAINT TRIGGER after_sale_evidence_objects_original_binding_guard
  AFTER INSERT OR UPDATE OR DELETE ON public.after_sale_evidence_objects
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app_security.validate_m63_b2b_original_binding();

REVOKE ALL ON FUNCTION app_security.validate_m63_b2b_original_binding() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_security.validate_m63_b2b_original_binding()
  FROM zalo_shop_runtime;

ALTER TABLE public.after_sale_evidence_files
  ADD CONSTRAINT after_sale_evidence_files_b2b_shape_check CHECK (
    scan_generation >= 0
    AND delete_attempt_count BETWEEN 0 AND 8
    AND (confirmed_at IS NULL) = (scan_requested_at IS NULL)
    AND (confirmed_at IS NULL OR scan_generation > 0)
    AND (scan_completed_at IS NULL OR confirmed_at IS NOT NULL)
    AND (
      ordinary_access_deadline_at IS NULL
      OR (claimed_at IS NOT NULL
        AND ordinary_access_deadline_at > claimed_at
        AND retention_deadline_at > ordinary_access_deadline_at)
    )
    AND (
      (delete_attempt_count < 8 AND delete_exhausted_at IS NULL)
      OR (delete_attempt_count = 8 AND status = 'DELETE_FAILED'
        AND next_delete_attempt_at IS NULL AND delete_exhausted_at IS NOT NULL)
    )
  );

CREATE OR REPLACE FUNCTION app_security.validate_m63_b2b_evidence_outbox()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE actor text := pg_catalog.current_setting('app.actor_type', true);
DECLARE evidence record;
DECLARE expected_available_at timestamptz;
DECLARE member_context boolean;
DECLARE system_context boolean;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (
       OLD.aggregate_type = 'AFTER_SALE_EVIDENCE'
       OR OLD.event_type LIKE 'after-sale.evidence.%'
       OR NEW.aggregate_type = 'AFTER_SALE_EVIDENCE'
       OR NEW.event_type LIKE 'after-sale.evidence.%'
     )
     AND (
       NEW.id IS DISTINCT FROM OLD.id
       OR NEW.store_id IS DISTINCT FROM OLD.store_id
       OR NEW.aggregate_type IS DISTINCT FROM OLD.aggregate_type
       OR NEW.aggregate_id IS DISTINCT FROM OLD.aggregate_id
       OR NEW.event_type IS DISTINCT FROM OLD.event_type
       OR NEW.event_version IS DISTINCT FROM OLD.event_version
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.payload IS DISTINCT FROM OLD.payload
       OR NEW.max_attempts IS DISTINCT FROM OLD.max_attempts
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
     )
  THEN
    RAISE EXCEPTION 'evidence outbox immutable identity cannot be changed'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.event_type NOT IN (
       'after-sale.evidence.scan.requested',
       'after-sale.evidence.expire.requested',
       'after-sale.evidence.delete.requested'
     )
  THEN
    IF NEW.aggregate_type = 'AFTER_SALE_EVIDENCE'
       OR NEW.event_type LIKE 'after-sale.evidence.%'
    THEN
      RAISE EXCEPTION 'unknown evidence outbox event is not allowed'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (TG_OP = 'INSERT'
       AND NEW.store_id IS DISTINCT FROM app_security.current_store_id())
     OR NEW.aggregate_type <> 'AFTER_SALE_EVIDENCE'
     OR NEW.event_version <> 1
     OR NOT (NEW.payload ?& ARRAY['store_id','evidence_id','expected_version'])
     OR NEW.payload - ARRAY['store_id','evidence_id','expected_version']::text[]
        <> '{}'::jsonb
     OR pg_catalog.jsonb_typeof(NEW.payload->'store_id') IS DISTINCT FROM 'string'
     OR pg_catalog.jsonb_typeof(NEW.payload->'evidence_id') IS DISTINCT FROM 'string'
     OR pg_catalog.jsonb_typeof(NEW.payload->'expected_version') IS DISTINCT FROM 'number'
     OR NEW.payload->>'store_id' IS DISTINCT FROM NEW.store_id::text
     OR NEW.payload->>'evidence_id' IS DISTINCT FROM NEW.aggregate_id::text
     OR COALESCE(NEW.payload->>'expected_version', '') !~ '^[1-9][0-9]*$'
  THEN
    RAISE EXCEPTION 'evidence outbox identity or payload is outside its strict contract'
      USING ERRCODE = '23514';
  END IF;

  SELECT status, member_id, upload_deadline_at, confirmed_at, scan_requested_at,
    claim_deadline_at, retention_deadline_at, next_delete_attempt_at, updated_at, version
  INTO evidence
  FROM public.after_sale_evidence_files
  WHERE store_id = NEW.store_id AND id = NEW.aggregate_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'evidence outbox requires an accessible parent'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    member_context := COALESCE(actor = 'member'
      AND app_security.current_actor_id() = evidence.member_id, false);
    system_context := COALESCE(actor = 'system'
      AND pg_catalog.current_setting('app.system_scope', true)
        = 'after-sale-evidence-lifecycle'
      AND app_security.current_actor_id()
        = '00000000-0000-4000-8000-000000000006'::uuid, false);
    expected_available_at := CASE NEW.event_type
      WHEN 'after-sale.evidence.scan.requested' THEN
        CASE WHEN evidence.status = 'PENDING' AND evidence.confirmed_at IS NOT NULL
          THEN evidence.scan_requested_at END
      WHEN 'after-sale.evidence.expire.requested' THEN
        CASE evidence.status
          WHEN 'PENDING' THEN evidence.upload_deadline_at
          WHEN 'READY' THEN evidence.retention_deadline_at
          WHEN 'READY_UNCLAIMED' THEN evidence.claim_deadline_at
          WHEN 'FAILED' THEN evidence.claim_deadline_at
          WHEN 'QUARANTINED' THEN COALESCE(
            evidence.retention_deadline_at, evidence.claim_deadline_at
          )
        END
      WHEN 'after-sale.evidence.delete.requested' THEN
        CASE evidence.status
          WHEN 'DELETION_PENDING' THEN evidence.updated_at
          WHEN 'DELETE_FAILED' THEN evidence.next_delete_attempt_at
        END
    END;
    IF NEW.payload->>'expected_version' IS DISTINCT FROM evidence.version::text
       OR NEW.idempotency_key IS DISTINCT FROM
          NEW.event_type || ':' || NEW.aggregate_id::text || ':' || evidence.version::text
       OR expected_available_at IS NULL
       OR NEW.available_at < expected_available_at
       OR NEW.available_at >= expected_available_at + interval '1 second'
       OR (NEW.event_type = 'after-sale.evidence.delete.requested' AND NOT system_context)
       OR (NEW.event_type <> 'after-sale.evidence.delete.requested'
         AND NOT (member_context OR system_context))
    THEN
      RAISE EXCEPTION 'evidence outbox scheduling or actor is outside its strict contract'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER outbox_messages_evidence_contract_guard
  BEFORE INSERT OR UPDATE ON public.outbox_messages
  FOR EACH ROW EXECUTE FUNCTION app_security.validate_m63_b2b_evidence_outbox();

CREATE OR REPLACE FUNCTION app_security.validate_m63_b2b_evidence_queue_commit()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE expected_event text;
DECLARE expected_available_at timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    expected_event := 'after-sale.evidence.expire.requested';
    expected_available_at := NEW.upload_deadline_at;
  ELSIF OLD.confirmed_at IS NULL AND NEW.confirmed_at IS NOT NULL THEN
    expected_event := 'after-sale.evidence.scan.requested';
    expected_available_at := NEW.scan_requested_at;
  ELSIF OLD.status = NEW.status AND OLD.status = 'PENDING'
        AND OLD.confirmed_at IS NOT NULL
        AND NEW.confirmed_at IS NOT DISTINCT FROM OLD.confirmed_at
        AND NEW.scan_generation = OLD.scan_generation + 1
        AND NEW.scan_requested_at IS DISTINCT FROM OLD.scan_requested_at THEN
    expected_event := 'after-sale.evidence.scan.requested';
    expected_available_at := NEW.scan_requested_at;
  ELSIF OLD.status IS DISTINCT FROM NEW.status
        AND NEW.status IN ('READY_UNCLAIMED','FAILED','QUARANTINED','READY') THEN
    expected_event := 'after-sale.evidence.expire.requested';
    expected_available_at := CASE NEW.status
      WHEN 'READY' THEN NEW.retention_deadline_at
      WHEN 'QUARANTINED' THEN COALESCE(NEW.retention_deadline_at, NEW.claim_deadline_at)
      ELSE NEW.claim_deadline_at
    END;
  ELSIF OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'DELETION_PENDING'
        AND OLD.status <> 'DELETE_FAILED' THEN
    expected_event := 'after-sale.evidence.delete.requested';
    expected_available_at := NEW.updated_at;
  ELSIF OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'DELETE_FAILED'
        AND NEW.next_delete_attempt_at IS NOT NULL THEN
    expected_event := 'after-sale.evidence.delete.requested';
    expected_available_at := NEW.next_delete_attempt_at;
  ELSE
    RETURN NULL;
  END IF;
  IF expected_available_at IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.outbox_messages message
    WHERE message.store_id = NEW.store_id
      AND message.aggregate_type = 'AFTER_SALE_EVIDENCE'
      AND message.aggregate_id = NEW.id
      AND message.event_type = expected_event
      AND message.event_version = 1
      AND message.idempotency_key =
        expected_event || ':' || NEW.id::text || ':' || NEW.version::text
      AND message.payload->>'expected_version' = NEW.version::text
      AND message.available_at >= expected_available_at
      AND message.available_at < expected_available_at + interval '1 second'
  ) THEN
    RAISE EXCEPTION 'evidence lifecycle change and its reliable message must commit together'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER after_sale_evidence_files_queue_commit_guard
  AFTER INSERT OR UPDATE ON public.after_sale_evidence_files
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app_security.validate_m63_b2b_evidence_queue_commit();

REVOKE ALL ON FUNCTION app_security.validate_m63_b2b_evidence_outbox() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_security.validate_m63_b2b_evidence_queue_commit() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_security.validate_m63_b2b_evidence_outbox()
  FROM zalo_shop_runtime;
REVOKE ALL ON FUNCTION app_security.validate_m63_b2b_evidence_queue_commit()
  FROM zalo_shop_runtime;
