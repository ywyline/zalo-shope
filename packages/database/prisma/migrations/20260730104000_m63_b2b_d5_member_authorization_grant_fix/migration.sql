-- D5 forward repair: the authorization-aware lock function verifies that a
-- member belongs to the current store. PostgreSQL requires SELECT on every
-- column used by that predicate, including members.store_id.
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
    RAISE EXCEPTION 'M6.3-B2b-D5 member authorization repair requires the restricted guard role'
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
END
$$;

GRANT SELECT (store_id) ON public.members TO zalo_shop_evidence_read_guard;

COMMIT;
