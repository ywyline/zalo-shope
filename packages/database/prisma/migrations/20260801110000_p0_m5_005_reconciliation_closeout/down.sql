-- Local/test rollback only. Review closeout facts are immutable and require forward repair.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "financial_reconciliation_reviews") THEN
    RAISE EXCEPTION 'P0-M5-005 review closeout rollback is unsafe after review facts exist'
      USING ERRCODE = '55000';
  END IF;
END
$$;

DROP TABLE "financial_reconciliation_reviews";
DROP TYPE "financial_reconciliation_review_decision";
DROP FUNCTION "app_security"."assert_financial_reconciliation_review_integrity"();
