-- LOCAL/TEST ONLY. Existing financial facts require a forward fix.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "financial_reconciliation_batches" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "financial_reconciliation_lines" LIMIT 1)
  THEN
    RAISE EXCEPTION 'P0-M5-005 reconciliation rollback is unsafe after financial facts exist'
      USING ERRCODE = '55000';
  END IF;
END
$$;

DROP TRIGGER "financial_reconciliation_lines_integrity_guard"
  ON "financial_reconciliation_lines";
DROP TRIGGER "financial_reconciliation_batches_integrity_guard"
  ON "financial_reconciliation_batches";
DROP FUNCTION "app_security"."assert_financial_reconciliation_batch_integrity"();

DROP TABLE "financial_reconciliation_lines";
DROP TABLE "financial_reconciliation_batches";

DELETE FROM "store_role_permissions" WHERE "permission_code" IN (
  'store.finance.read', 'store.finance.reconcile'
);
DELETE FROM "platform_role_permissions" WHERE "permission_code" IN (
  'store.finance.read', 'store.finance.reconcile'
);
DELETE FROM "permissions" WHERE "code" IN (
  'store.finance.read', 'store.finance.reconcile'
);

DROP FUNCTION "app_security"."reject_financial_reconciliation_mutation"();
DROP TYPE "financial_reconciliation_line_status";
DROP TYPE "financial_reconciliation_line_type";
DROP TYPE "financial_reconciliation_batch_status";
DROP TYPE "financial_reconciliation_source";
