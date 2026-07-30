-- LOCAL/TEST ONLY. Production and any database that has issued protected URLs must
-- retain this function and use a reviewed forward repair if it needs to change.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.audit_logs
    WHERE action = 'after-sale.evidence.protected_read.issued'
  ) THEN
    RAISE EXCEPTION 'D5 protected-read rollback requires no issued protected-read audit facts'
      USING ERRCODE = '55000';
  END IF;
END
$$;

REVOKE EXECUTE ON FUNCTION app_security.lock_m63_b2b_protected_evidence_read(uuid, uuid, timestamptz)
  FROM zalo_shop_runtime;
DROP FUNCTION app_security.lock_m63_b2b_protected_evidence_read(uuid, uuid, timestamptz);
DROP POLICY after_sale_evidence_files_protected_read_lock_guard
  ON public.after_sale_evidence_files;
DROP POLICY IF EXISTS after_sale_evidence_files_protected_read_lock_guard_no_write
  ON public.after_sale_evidence_files;
REVOKE SELECT (
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
  FROM zalo_shop_evidence_read_guard;
REVOKE EXECUTE ON FUNCTION app_security.current_store_id(), app_security.current_actor_id()
  FROM zalo_shop_evidence_read_guard;
REVOKE USAGE ON TYPE public.after_sale_evidence_status FROM zalo_shop_evidence_read_guard;
REVOKE USAGE ON SCHEMA public, app_security FROM zalo_shop_evidence_read_guard;

COMMIT;
