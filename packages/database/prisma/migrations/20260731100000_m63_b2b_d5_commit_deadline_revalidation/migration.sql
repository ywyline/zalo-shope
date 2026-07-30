-- D5 forward repair: bind the signed URL to the locked bearer/session
-- authorization deadlines and retain a finalization margin after the evidence
-- lock. This prevents a URL from remaining valid if authorization expires
-- between the security-definer return and transaction commit.
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
    RAISE EXCEPTION 'M6.3-B2b-D5 commit deadline revalidation requires the restricted guard role'
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
    RAISE EXCEPTION 'M6.3-B2b-D5 migration executor must be a PostgreSQL superuser to replace the isolated guard function'
      USING ERRCODE = '55000';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION app_security.lock_m63_b2b_protected_evidence_read_authorized(
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
DECLARE locked_evidence_id uuid;
DECLARE locked_evidence_store_id uuid;
DECLARE locked_evidence_member_id uuid;
DECLARE locked_evidence_after_sale_id uuid;
DECLARE locked_evidence_object_key text;
DECLARE locked_evidence_status public.after_sale_evidence_status;
DECLARE locked_evidence_legal_hold_active boolean;
DECLARE locked_evidence_ordinary_access_deadline_at timestamptz;
DECLARE locked_evidence_version integer;
DECLARE post_lock_now timestamptz;
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
     OR target_url_expires_at > caller_token_expires_at
     OR target_url_expires_at > locked_session_expires_at
  THEN
    RETURN;
  END IF;

  SELECT locked.id,
         locked.store_id,
         locked.member_id,
         locked.after_sale_id,
         locked.object_key,
         locked.status,
         locked.legal_hold_active,
         locked.ordinary_access_deadline_at,
         locked.version
  INTO locked_evidence_id,
       locked_evidence_store_id,
       locked_evidence_member_id,
       locked_evidence_after_sale_id,
       locked_evidence_object_key,
       locked_evidence_status,
       locked_evidence_legal_hold_active,
       locked_evidence_ordinary_access_deadline_at,
       locked_evidence_version
  FROM app_security.lock_m63_b2b_protected_evidence_read(
    target_evidence_id,
    target_after_sale_id,
    target_url_expires_at
  ) AS locked;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  post_lock_now := pg_catalog.clock_timestamp();
  IF post_lock_now >= caller_token_expires_at
     OR post_lock_now >= locked_session_expires_at
     OR post_lock_now + INTERVAL '1 second' >= target_url_expires_at
     OR post_lock_now >= locked_evidence_ordinary_access_deadline_at
     OR target_url_expires_at > caller_token_expires_at
     OR target_url_expires_at > locked_session_expires_at
  THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT locked_evidence_id,
         locked_evidence_store_id,
         locked_evidence_member_id,
         locked_evidence_after_sale_id,
         locked_evidence_object_key,
         locked_evidence_status,
         locked_evidence_legal_hold_active,
         locked_evidence_ordinary_access_deadline_at,
         locked_evidence_version;
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

COMMIT;
