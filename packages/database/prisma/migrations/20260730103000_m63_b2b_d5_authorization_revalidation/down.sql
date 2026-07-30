-- LOCAL/TEST ONLY. Production and any database that has issued protected URLs
-- require a reviewed forward repair. This reverses only the D5 authorization
-- revalidation boundary and restores migration 44's local/test entry point.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.audit_logs
    WHERE action = 'after-sale.evidence.protected_read.issued'
  ) THEN
    RAISE EXCEPTION 'D5 authorization revalidation rollback requires no issued protected-read audit facts'
      USING ERRCODE = '55000';
  END IF;
END
$$;

REVOKE EXECUTE ON FUNCTION app_security.lock_m63_b2b_protected_evidence_read_authorized(
  uuid, uuid, timestamptz
) FROM zalo_shop_runtime;
DROP FUNCTION app_security.lock_m63_b2b_protected_evidence_read_authorized(uuid, uuid, timestamptz);
GRANT EXECUTE ON FUNCTION app_security.lock_m63_b2b_protected_evidence_read(
  uuid, uuid, timestamptz
) TO zalo_shop_runtime;

DROP POLICY store_role_permissions_m63_d5_guard_no_write ON public.store_role_permissions;
DROP POLICY admin_store_roles_m63_d5_guard_no_write ON public.admin_store_roles;
DROP POLICY member_sessions_m63_d5_guard_no_write ON public.member_sessions;
DROP POLICY members_m63_d5_guard_no_write ON public.members;
DROP POLICY stores_m63_d5_guard_no_write ON public.stores;

DROP POLICY platform_role_permissions_m63_d5_guard_no_write ON public.platform_role_permissions;
DROP POLICY platform_role_permissions_m63_d5_preserve_access ON public.platform_role_permissions;
ALTER TABLE public.platform_role_permissions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.platform_role_permissions DISABLE ROW LEVEL SECURITY;
DROP POLICY admin_platform_roles_m63_d5_guard_no_write ON public.admin_platform_roles;
DROP POLICY admin_platform_roles_m63_d5_preserve_access ON public.admin_platform_roles;
ALTER TABLE public.admin_platform_roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.admin_platform_roles DISABLE ROW LEVEL SECURITY;
DROP POLICY admin_sessions_m63_d5_guard_no_write ON public.admin_sessions;
DROP POLICY admin_sessions_m63_d5_preserve_access ON public.admin_sessions;
ALTER TABLE public.admin_sessions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.admin_sessions DISABLE ROW LEVEL SECURITY;
DROP POLICY admin_users_m63_d5_guard_no_write ON public.admin_users;
DROP POLICY admin_users_m63_d5_preserve_access ON public.admin_users;
ALTER TABLE public.admin_users NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.admin_users DISABLE ROW LEVEL SECURITY;

REVOKE SELECT (platform_role_id, permission_code), UPDATE (permission_code)
  ON public.platform_role_permissions FROM zalo_shop_evidence_read_guard;
REVOKE SELECT (admin_user_id, platform_role_id), UPDATE (platform_role_id)
  ON public.admin_platform_roles FROM zalo_shop_evidence_read_guard;
REVOKE SELECT (store_id, role_id, permission_code), UPDATE (permission_code)
  ON public.store_role_permissions FROM zalo_shop_evidence_read_guard;
REVOKE SELECT (store_id, admin_user_id, role_id), UPDATE (role_id)
  ON public.admin_store_roles FROM zalo_shop_evidence_read_guard;
REVOKE SELECT (id, admin_user_id, expires_at, revoked_at), UPDATE (id)
  ON public.admin_sessions FROM zalo_shop_evidence_read_guard;
REVOKE SELECT (id, store_id, member_id, expires_at, revoked_at), UPDATE (id)
  ON public.member_sessions FROM zalo_shop_evidence_read_guard;
REVOKE SELECT (id, status), UPDATE (id)
  ON public.stores, public.members, public.admin_users FROM zalo_shop_evidence_read_guard;
REVOKE USAGE ON TYPE public."RecordStatus", public."MemberStatus", public."AdminStatus"
  FROM zalo_shop_evidence_read_guard;

COMMIT;
