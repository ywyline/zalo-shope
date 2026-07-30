-- D5 forward repair: the first snapshot is intentionally outside the S3 signing
-- call, so final authorization facts must be rechecked and held through the
-- evidence lock/audit commit. Keep the original lock function present for
-- local/test rollback, but revoke its runtime entry point in favor of this
-- authorization-aware boundary.
BEGIN;

DO $$
DECLARE guard_role pg_catalog.pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO guard_role
  FROM pg_catalog.pg_roles
  WHERE rolname = 'zalo_shop_evidence_read_guard';
  IF NOT FOUND OR guard_role.rolcanlogin OR guard_role.rolinherit OR guard_role.rolsuper
     OR guard_role.rolcreatedb OR guard_role.rolcreaterole OR guard_role.rolreplication
     OR guard_role.rolbypassrls
  THEN
    RAISE EXCEPTION 'M6.3-B2b-D5 authorization revalidation requires the restricted guard role'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.roleid = guard_role.oid OR membership.member = guard_role.oid
  ) THEN
    RAISE EXCEPTION 'M6.3-B2b-D5 guard role must not have role relationships'
      USING ERRCODE = '55000';
  END IF;
  IF NOT COALESCE((SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user), false) THEN
    RAISE EXCEPTION 'M6.3-B2b-D5 migration executor must be a PostgreSQL superuser to transfer the definer function to the isolated guard role'
      USING ERRCODE = '55000';
  END IF;
END
$$;

GRANT USAGE ON TYPE public."RecordStatus", public."MemberStatus", public."AdminStatus"
  TO zalo_shop_evidence_read_guard;
GRANT SELECT (id, status), UPDATE (id) ON public.stores, public.members, public.admin_users
  TO zalo_shop_evidence_read_guard;
GRANT SELECT (id, store_id, member_id, expires_at, revoked_at), UPDATE (id)
  ON public.member_sessions TO zalo_shop_evidence_read_guard;
GRANT SELECT (id, admin_user_id, expires_at, revoked_at), UPDATE (id)
  ON public.admin_sessions TO zalo_shop_evidence_read_guard;
GRANT SELECT (store_id, admin_user_id, role_id), UPDATE (role_id)
  ON public.admin_store_roles TO zalo_shop_evidence_read_guard;
GRANT SELECT (store_id, role_id, permission_code), UPDATE (permission_code)
  ON public.store_role_permissions TO zalo_shop_evidence_read_guard;
GRANT SELECT (admin_user_id, platform_role_id), UPDATE (platform_role_id)
  ON public.admin_platform_roles TO zalo_shop_evidence_read_guard;
GRANT SELECT (platform_role_id, permission_code), UPDATE (permission_code)
  ON public.platform_role_permissions TO zalo_shop_evidence_read_guard;

-- Store-scoped tables already have forced RLS. These restrictive policies let the
-- guard acquire a row lock through its intentionally tiny UPDATE(column) grant,
-- while making every actual UPDATE fail its WITH CHECK condition.
CREATE POLICY stores_m63_d5_guard_no_write
  ON public.stores AS RESTRICTIVE FOR UPDATE TO zalo_shop_evidence_read_guard
  USING (id = app_security.current_store_id()) WITH CHECK (false);
CREATE POLICY members_m63_d5_guard_no_write
  ON public.members AS RESTRICTIVE FOR UPDATE TO zalo_shop_evidence_read_guard
  USING (store_id = app_security.current_store_id() AND id = app_security.current_actor_id())
  WITH CHECK (false);
CREATE POLICY member_sessions_m63_d5_guard_no_write
  ON public.member_sessions AS RESTRICTIVE FOR UPDATE TO zalo_shop_evidence_read_guard
  USING (store_id = app_security.current_store_id() AND member_id = app_security.current_actor_id())
  WITH CHECK (false);
CREATE POLICY admin_store_roles_m63_d5_guard_no_write
  ON public.admin_store_roles AS RESTRICTIVE FOR UPDATE TO zalo_shop_evidence_read_guard
  USING (store_id = app_security.current_store_id() AND admin_user_id = app_security.current_actor_id())
  WITH CHECK (false);
CREATE POLICY store_role_permissions_m63_d5_guard_no_write
  ON public.store_role_permissions AS RESTRICTIVE FOR UPDATE TO zalo_shop_evidence_read_guard
  USING (store_id = app_security.current_store_id()) WITH CHECK (false);

-- The platform authorization tables were deliberately outside tenant RLS. A
-- permissive PUBLIC policy preserves their existing ACL behavior when RLS is
-- enabled; the guard-only restrictive policy blocks writes while allowing
-- SELECT FOR SHARE to serialize a revocation with D5's final authorization.
ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_users FORCE ROW LEVEL SECURITY;
CREATE POLICY admin_users_m63_d5_preserve_access
  ON public.admin_users AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY admin_users_m63_d5_guard_no_write
  ON public.admin_users AS RESTRICTIVE FOR UPDATE TO zalo_shop_evidence_read_guard
  USING (true) WITH CHECK (false);

ALTER TABLE public.admin_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY admin_sessions_m63_d5_preserve_access
  ON public.admin_sessions AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY admin_sessions_m63_d5_guard_no_write
  ON public.admin_sessions AS RESTRICTIVE FOR UPDATE TO zalo_shop_evidence_read_guard
  USING (true) WITH CHECK (false);

ALTER TABLE public.admin_platform_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_platform_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY admin_platform_roles_m63_d5_preserve_access
  ON public.admin_platform_roles AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY admin_platform_roles_m63_d5_guard_no_write
  ON public.admin_platform_roles AS RESTRICTIVE FOR UPDATE TO zalo_shop_evidence_read_guard
  USING (true) WITH CHECK (false);

ALTER TABLE public.platform_role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_role_permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_role_permissions_m63_d5_preserve_access
  ON public.platform_role_permissions AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY platform_role_permissions_m63_d5_guard_no_write
  ON public.platform_role_permissions AS RESTRICTIVE FOR UPDATE TO zalo_shop_evidence_read_guard
  USING (true) WITH CHECK (false);

CREATE FUNCTION app_security.lock_m63_b2b_protected_evidence_read_authorized(
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
DECLARE caller_scope text := pg_catalog.current_setting('app.admin_authorization_scope', true);
DECLARE caller_session_id uuid;
DECLARE caller_session_text text := NULLIF(pg_catalog.current_setting('app.access_session_id', true), '');
DECLARE caller_store_id uuid;
DECLARE caller_store_text text := NULLIF(pg_catalog.current_setting('app.store_id', true), '');
DECLARE caller_token_expires_at timestamptz;
DECLARE caller_token_expires_text text := NULLIF(
  pg_catalog.current_setting('app.access_token_expires_at', true), ''
);
DECLARE caller_type text := pg_catalog.current_setting('app.actor_type', true);
DECLARE locked_id uuid;
DECLARE locked_session_expires_at timestamptz;
BEGIN
  IF target_evidence_id IS NULL
     OR target_after_sale_id IS NULL
     OR target_url_expires_at IS NULL
     OR caller_store_text IS NULL
     OR caller_actor_text IS NULL
     OR caller_session_text IS NULL
     OR caller_token_expires_text IS NULL
     OR caller_type NOT IN ('admin', 'member')
  THEN
    RETURN;
  END IF;

  BEGIN
    caller_actor_id := caller_actor_text::uuid;
    caller_session_id := caller_session_text::uuid;
    caller_store_id := caller_store_text::uuid;
    caller_token_expires_at := caller_token_expires_text::timestamptz;
  EXCEPTION
    WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN
      RETURN;
  END;

  IF pg_catalog.clock_timestamp() >= caller_token_expires_at THEN
    RETURN;
  END IF;

  SELECT store.id INTO locked_id
  FROM public.stores AS store
  WHERE store.id = caller_store_id AND store.status = 'ACTIVE'
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF caller_type = 'member' THEN
    SELECT member.id INTO locked_id
    FROM public.members AS member
    WHERE member.id = caller_actor_id
      AND member.store_id = caller_store_id
      AND member.status = 'ACTIVE'
    FOR SHARE;
    IF NOT FOUND THEN
      RETURN;
    END IF;

    SELECT session.expires_at INTO locked_session_expires_at
    FROM public.member_sessions AS session
    WHERE session.id = caller_session_id
      AND session.store_id = caller_store_id
      AND session.member_id = caller_actor_id
      AND session.revoked_at IS NULL
      AND session.expires_at > pg_catalog.clock_timestamp()
    FOR SHARE;
    IF NOT FOUND THEN
      RETURN;
    END IF;
  ELSE
    SELECT admin.id INTO locked_id
    FROM public.admin_users AS admin
    WHERE admin.id = caller_actor_id AND admin.status = 'ACTIVE'
    FOR SHARE;
    IF NOT FOUND THEN
      RETURN;
    END IF;

    SELECT session.expires_at INTO locked_session_expires_at
    FROM public.admin_sessions AS session
    WHERE session.id = caller_session_id
      AND session.admin_user_id = caller_actor_id
      AND session.revoked_at IS NULL
      AND session.expires_at > pg_catalog.clock_timestamp()
    FOR SHARE;
    IF NOT FOUND THEN
      RETURN;
    END IF;

    IF caller_scope = 'STORE' THEN
      SELECT assignment.role_id INTO locked_id
      FROM public.admin_store_roles AS assignment
      JOIN public.store_role_permissions AS role_permission
        ON role_permission.store_id = assignment.store_id
       AND role_permission.role_id = assignment.role_id
      WHERE assignment.store_id = caller_store_id
        AND assignment.admin_user_id = caller_actor_id
        AND role_permission.permission_code = 'store.after-sales.evidence.read'
      ORDER BY assignment.role_id
      LIMIT 1
      FOR SHARE OF assignment, role_permission;
      IF NOT FOUND THEN
        RETURN;
      END IF;
    ELSIF caller_scope = 'CROSS_STORE' THEN
      SELECT assignment.platform_role_id INTO locked_id
      FROM public.admin_platform_roles AS assignment
      JOIN public.platform_role_permissions AS role_permission
        ON role_permission.platform_role_id = assignment.platform_role_id
      WHERE assignment.admin_user_id = caller_actor_id
        AND role_permission.permission_code = 'platform.stores.cross_access'
      ORDER BY assignment.platform_role_id
      LIMIT 1
      FOR SHARE OF assignment, role_permission;
      IF NOT FOUND THEN
        RETURN;
      END IF;
    ELSE
      RETURN;
    END IF;
  END IF;

  IF pg_catalog.clock_timestamp() >= caller_token_expires_at
     OR pg_catalog.clock_timestamp() >= locked_session_expires_at
  THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT locked.id,
         locked.store_id,
         locked.member_id,
         locked.after_sale_id,
         locked.object_key,
         locked.status,
         locked.legal_hold_active,
         locked.ordinary_access_deadline_at,
         locked.version
  FROM app_security.lock_m63_b2b_protected_evidence_read(
    target_evidence_id,
    target_after_sale_id,
    target_url_expires_at
  ) AS locked;
END
$$;

REVOKE ALL ON FUNCTION app_security.lock_m63_b2b_protected_evidence_read_authorized(
  uuid, uuid, timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_security.lock_m63_b2b_protected_evidence_read_authorized(
  uuid, uuid, timestamptz
) TO zalo_shop_runtime;
ALTER FUNCTION app_security.lock_m63_b2b_protected_evidence_read_authorized(
  uuid, uuid, timestamptz
) OWNER TO zalo_shop_evidence_read_guard;

REVOKE EXECUTE ON FUNCTION app_security.lock_m63_b2b_protected_evidence_read(
  uuid, uuid, timestamptz
) FROM zalo_shop_runtime;

COMMIT;
