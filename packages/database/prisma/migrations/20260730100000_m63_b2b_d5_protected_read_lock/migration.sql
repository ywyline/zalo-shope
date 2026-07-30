-- D5 needs a final row lock after S3 signing. PostgreSQL evaluates SELECT FOR SHARE
-- through the UPDATE policy, while D0 intentionally limits a member UPDATE policy to
-- the unclaimed -> claimed transition. Do not weaken that policy: a narrow definer
-- function runs as a non-login, non-bypass guard role and validates the caller's
-- transaction-local scope before taking the lock.
BEGIN;

DO $$
DECLARE guard_role pg_catalog.pg_roles%ROWTYPE;
DECLARE guard_role_id oid;
BEGIN
  -- The guard must have no role relationship so no non-superuser can transfer
  -- ownership of a security-definer function to it. Fail before mutating
  -- cluster state rather than relying on PostgreSQL's later ownership error.
  IF NOT COALESCE((SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user), false) THEN
    RAISE EXCEPTION 'M6.3-B2b-D5 migration executor must be a PostgreSQL superuser to transfer the definer function to the isolated guard role'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO guard_role
  FROM pg_catalog.pg_roles
  WHERE rolname = 'zalo_shop_evidence_read_guard';
  IF NOT FOUND THEN
    CREATE ROLE zalo_shop_evidence_read_guard
      NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    RETURN;
  END IF;
  IF guard_role.rolcanlogin OR guard_role.rolinherit OR guard_role.rolsuper
     OR guard_role.rolcreatedb OR guard_role.rolcreaterole OR guard_role.rolreplication
     OR guard_role.rolbypassrls
  THEN
    RAISE EXCEPTION 'M6.3-B2b-D5 evidence read guard role has unsafe attributes'
      USING ERRCODE = '55000';
  END IF;
  guard_role_id := guard_role.oid;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.roleid = guard_role_id OR membership.member = guard_role_id
  ) THEN
    RAISE EXCEPTION 'M6.3-B2b-D5 evidence read guard role has unexpected role relationships'
      USING ERRCODE = '55000';
  END IF;
END
$$;

-- A cluster-level role can pre-exist because another database already deployed D5.
-- Reuse it only when this database has not attached any direct privilege or ownership
-- to that role. Effective PUBLIC privileges are handled by the fixed function body;
-- CREATE on either schema in its search path is always forbidden.
DO $$
DECLARE guard_role_id oid;
BEGIN
  SELECT oid INTO STRICT guard_role_id
  FROM pg_catalog.pg_roles
  WHERE rolname = 'zalo_shop_evidence_read_guard';

  IF pg_catalog.has_schema_privilege(
       'zalo_shop_evidence_read_guard', 'public', 'CREATE'
     )
     OR pg_catalog.has_schema_privilege(
       'zalo_shop_evidence_read_guard', 'app_security', 'CREATE'
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_namespace
       WHERE nspowner = guard_role_id
       UNION ALL
       SELECT 1
       FROM pg_catalog.pg_class
       WHERE relowner = guard_role_id
       UNION ALL
       SELECT 1
       FROM pg_catalog.pg_proc
       WHERE proowner = guard_role_id
       UNION ALL
       SELECT 1
       FROM pg_catalog.pg_type
       WHERE typowner = guard_role_id
       UNION ALL
       SELECT 1
       FROM pg_catalog.pg_largeobject_metadata
       WHERE lomowner = guard_role_id
       UNION ALL
       SELECT 1
       FROM pg_catalog.pg_default_acl
       WHERE defaclrole = guard_role_id
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_namespace AS object_record
       CROSS JOIN LATERAL pg_catalog.aclexplode(object_record.nspacl) AS privilege
       WHERE privilege.grantee = guard_role_id
       UNION ALL
       SELECT 1
       FROM pg_catalog.pg_class AS object_record
       CROSS JOIN LATERAL pg_catalog.aclexplode(object_record.relacl) AS privilege
       WHERE privilege.grantee = guard_role_id
       UNION ALL
       SELECT 1
       FROM pg_catalog.pg_attribute AS object_record
       CROSS JOIN LATERAL pg_catalog.aclexplode(object_record.attacl) AS privilege
       WHERE privilege.grantee = guard_role_id
       UNION ALL
       SELECT 1
       FROM pg_catalog.pg_proc AS object_record
       CROSS JOIN LATERAL pg_catalog.aclexplode(object_record.proacl) AS privilege
       WHERE privilege.grantee = guard_role_id
       UNION ALL
       SELECT 1
       FROM pg_catalog.pg_type AS object_record
       CROSS JOIN LATERAL pg_catalog.aclexplode(object_record.typacl) AS privilege
       WHERE privilege.grantee = guard_role_id
       UNION ALL
       SELECT 1
       FROM pg_catalog.pg_database AS object_record
       CROSS JOIN LATERAL pg_catalog.aclexplode(object_record.datacl) AS privilege
       WHERE object_record.datname = pg_catalog.current_database()
         AND privilege.grantee = guard_role_id
       UNION ALL
       SELECT 1
       FROM pg_catalog.pg_default_acl AS object_record
       CROSS JOIN LATERAL pg_catalog.aclexplode(object_record.defaclacl) AS privilege
       WHERE privilege.grantee = guard_role_id
     )
  THEN
    RAISE EXCEPTION 'M6.3-B2b-D5 evidence read guard role has unexpected current-database privileges or ownership'
      USING ERRCODE = '55000';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public, app_security TO zalo_shop_evidence_read_guard;
GRANT USAGE ON TYPE public.after_sale_evidence_status TO zalo_shop_evidence_read_guard;
GRANT EXECUTE ON FUNCTION app_security.current_store_id(), app_security.current_actor_id()
  TO zalo_shop_evidence_read_guard;
GRANT SELECT (
  id,
  store_id,
  member_id,
  after_sale_id,
  object_key,
  status,
  legal_hold_active,
  ordinary_access_deadline_at,
  version
), UPDATE (id) ON public.after_sale_evidence_files
  TO zalo_shop_evidence_read_guard;

CREATE POLICY after_sale_evidence_files_protected_read_lock_guard
  ON public.after_sale_evidence_files AS PERMISSIVE FOR UPDATE
  TO zalo_shop_evidence_read_guard
  USING (
    store_id = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) IN ('admin', 'member')
    AND (
      pg_catalog.current_setting('app.actor_type', true) = 'admin'
      OR member_id = app_security.current_actor_id()
    )
  )
  WITH CHECK (false);

-- Existing D0 admin policies are permissive. This restrictive policy keeps the
-- guard lock-only even when another UPDATE policy would otherwise allow a row write.
CREATE POLICY after_sale_evidence_files_protected_read_lock_guard_no_write
  ON public.after_sale_evidence_files AS RESTRICTIVE FOR UPDATE
  TO zalo_shop_evidence_read_guard
  USING (
    store_id = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) IN ('admin', 'member')
  )
  WITH CHECK (false);

CREATE FUNCTION app_security.lock_m63_b2b_protected_evidence_read(
  target_evidence_id uuid,
  target_after_sale_id uuid,
  target_url_expires_at timestamptz
)
RETURNS TABLE (
  id uuid,
  store_id uuid,
  member_id uuid,
  after_sale_id uuid,
  object_key text,
  status public.after_sale_evidence_status,
  legal_hold_active boolean,
  ordinary_access_deadline_at timestamptz,
  version integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET row_security = on
AS $$
DECLARE caller_actor_id uuid;
DECLARE caller_actor_text text := NULLIF(pg_catalog.current_setting('app.actor_id', true), '');
DECLARE caller_store_id uuid;
DECLARE caller_store_text text := NULLIF(pg_catalog.current_setting('app.store_id', true), '');
DECLARE caller_type text := pg_catalog.current_setting('app.actor_type', true);
BEGIN
  -- The caller's store/actor GUCs are set only by withStoreTransaction. A missing or
  -- unsupported principal returns no row, preserving D5's non-enumerating behavior.
  IF target_evidence_id IS NULL
     OR target_after_sale_id IS NULL
     OR target_url_expires_at IS NULL
     OR caller_store_text IS NULL
     OR caller_actor_text IS NULL
     OR caller_type NOT IN ('admin', 'member')
  THEN
    RETURN;
  END IF;

  BEGIN
    caller_actor_id := caller_actor_text::uuid;
    caller_store_id := caller_store_text::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN;
  END;

  RETURN QUERY
  SELECT evidence.id,
         evidence.store_id,
         evidence.member_id,
         evidence.after_sale_id,
         evidence.object_key,
         evidence.status,
         evidence.legal_hold_active,
         evidence.ordinary_access_deadline_at,
         evidence.version
  FROM public.after_sale_evidence_files AS evidence
  WHERE evidence.store_id = caller_store_id
    AND evidence.id = target_evidence_id
    AND evidence.after_sale_id = target_after_sale_id
    AND evidence.status = 'READY'
    AND evidence.object_key IS NOT NULL
    AND evidence.ordinary_access_deadline_at IS NOT NULL
    AND pg_catalog.clock_timestamp() < target_url_expires_at
    AND target_url_expires_at < evidence.ordinary_access_deadline_at
    AND (
      caller_type = 'admin'
      OR (caller_type = 'member' AND evidence.member_id = caller_actor_id)
    )
  FOR SHARE;
END
$$;

REVOKE ALL ON FUNCTION app_security.lock_m63_b2b_protected_evidence_read(uuid, uuid, timestamptz)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_security.lock_m63_b2b_protected_evidence_read(uuid, uuid, timestamptz)
  TO zalo_shop_runtime;
ALTER FUNCTION app_security.lock_m63_b2b_protected_evidence_read(uuid, uuid, timestamptz)
  OWNER TO zalo_shop_evidence_read_guard;

COMMIT;
