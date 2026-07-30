-- LOCAL/TEST ONLY. Fail before revoking the function's required member scope
-- column when an issued protected-read audit makes the D5 reverse sequence
-- unsafe. Otherwise apply migration 45's local/test rollback immediately.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.audit_logs
    WHERE action = 'after-sale.evidence.protected_read.issued'
  ) THEN
    RAISE EXCEPTION 'D5 member authorization grant rollback requires no issued protected-read audit facts'
      USING ERRCODE = '55000';
  END IF;
END
$$;

REVOKE SELECT (store_id) ON public.members FROM zalo_shop_evidence_read_guard;

COMMIT;
