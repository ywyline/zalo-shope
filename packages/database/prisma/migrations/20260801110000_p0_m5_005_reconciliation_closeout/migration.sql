-- P0-M5-005 Slice C: immutable maker-checker closeout records.
-- Review records attest to an immutable batch; they do not mutate financial facts.

CREATE TYPE "financial_reconciliation_review_decision" AS ENUM (
  'CLOSED_ACCEPTED', 'CLOSED_ESCALATED'
);

CREATE TABLE "financial_reconciliation_reviews" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "store_id" UUID NOT NULL,
  "batch_id" UUID NOT NULL,
  "decision" "financial_reconciliation_review_decision" NOT NULL,
  "expected_batch_version" INTEGER NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "idempotency_key_hash" CHAR(64) NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "reviewed_by" UUID NOT NULL,
  "correlation_id" VARCHAR(128) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "financial_reconciliation_reviews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "financial_reconciliation_reviews_values_check" CHECK (
    "expected_batch_version" = 1
    AND "idempotency_key_hash" ~ '^[0-9a-f]{64}$'
    AND "request_hash" ~ '^[0-9a-f]{64}$'
    AND length(btrim("reason")) BETWEEN 10 AND 500
    AND length(btrim("correlation_id")) BETWEEN 1 AND 128
  )
);

CREATE UNIQUE INDEX "financial_reconciliation_reviews_store_id_key"
  ON "financial_reconciliation_reviews"("store_id", "id");
CREATE UNIQUE INDEX "financial_reconciliation_reviews_batch_key"
  ON "financial_reconciliation_reviews"("store_id", "batch_id");
CREATE UNIQUE INDEX "financial_reconciliation_reviews_idempotency_key"
  ON "financial_reconciliation_reviews"("store_id", "idempotency_key_hash");
CREATE INDEX "financial_reconciliation_reviews_created_at_idx"
  ON "financial_reconciliation_reviews"("store_id", "created_at" DESC, "id" DESC);

ALTER TABLE "financial_reconciliation_reviews"
  ADD CONSTRAINT "financial_reconciliation_reviews_store_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "financial_reconciliation_reviews_batch_fkey"
    FOREIGN KEY ("store_id", "batch_id")
    REFERENCES "financial_reconciliation_batches"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "financial_reconciliation_reviews_reviewer_fkey"
    FOREIGN KEY ("reviewed_by") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "app_security"."assert_financial_reconciliation_review_integrity"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  batch_fact record;
BEGIN
  SELECT batch.* INTO batch_fact
  FROM public.financial_reconciliation_batches AS batch
  WHERE batch.store_id = NEW.store_id AND batch.id = NEW.batch_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'financial reconciliation batch is missing' USING ERRCODE = '23503';
  END IF;
  IF batch_fact.status <> 'REVIEW_REQUIRED'
    OR batch_fact.exception_count <= 0
    OR batch_fact.version <> NEW.expected_batch_version
  THEN
    RAISE EXCEPTION 'financial reconciliation batch is not reviewable at the expected version'
      USING ERRCODE = '23514';
  END IF;
  IF batch_fact.created_by = NEW.reviewed_by THEN
    RAISE EXCEPTION 'financial reconciliation maker cannot close its own batch'
      USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION "app_security"."assert_financial_reconciliation_review_integrity"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app_security"."assert_financial_reconciliation_review_integrity"()
  TO zalo_shop_runtime;

CREATE TRIGGER "financial_reconciliation_reviews_append_only"
  BEFORE UPDATE OR DELETE ON "financial_reconciliation_reviews"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_financial_reconciliation_mutation"();
CREATE CONSTRAINT TRIGGER "financial_reconciliation_reviews_integrity_guard"
  AFTER INSERT ON "financial_reconciliation_reviews"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "app_security"."assert_financial_reconciliation_review_integrity"();

ALTER TABLE "financial_reconciliation_reviews" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "financial_reconciliation_reviews" FORCE ROW LEVEL SECURITY;
CREATE POLICY "financial_reconciliation_reviews_tenant_isolation"
  ON "financial_reconciliation_reviews"
  USING ("store_id" = app_security.current_store_id())
  WITH CHECK ("store_id" = app_security.current_store_id());

GRANT SELECT, INSERT ON TABLE "financial_reconciliation_reviews" TO zalo_shop_runtime;
REVOKE UPDATE, DELETE ON TABLE "financial_reconciliation_reviews" FROM zalo_shop_runtime;
