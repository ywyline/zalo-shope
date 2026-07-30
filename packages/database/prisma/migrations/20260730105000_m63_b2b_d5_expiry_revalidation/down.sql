-- LOCAL/TEST reverse sequence only. Fail before altering any earlier D5
-- grant/function state when an issued protected-read audit makes rollback
-- unsafe. This is a forward security repair: retain the stricter function
-- until migration 45's local/test rollback removes the D5 boundary.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.audit_logs
    WHERE action = 'after-sale.evidence.protected_read.issued'
  ) THEN
    RAISE EXCEPTION 'D5 expiry revalidation rollback requires no issued protected-read audit facts'
      USING ERRCODE = '55000';
  END IF;
END
$$;

COMMIT;
