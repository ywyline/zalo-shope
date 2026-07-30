-- LOCAL/TEST reverse sequence only. Keep the stricter forward security repair
-- until migration 45 removes the D5 boundary; never rewrite an issued-read
-- authorization history by restoring a weaker function.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.audit_logs
    WHERE action = 'after-sale.evidence.protected_read.issued'
  ) THEN
    RAISE EXCEPTION 'D5 commit deadline revalidation rollback requires no issued protected-read audit facts'
      USING ERRCODE = '55000';
  END IF;
END
$$;

COMMIT;
