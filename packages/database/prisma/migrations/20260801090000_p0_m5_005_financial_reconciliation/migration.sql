-- P0-M5-005 Slice A: immutable, store-scoped payment/refund settlement reconciliation.
-- Provider-specific statement ingestion remains outside this normalized local/test boundary.

CREATE TYPE "financial_reconciliation_source" AS ENUM ('PAYMENT_PROVIDER');
CREATE TYPE "financial_reconciliation_batch_status" AS ENUM ('MATCHED', 'REVIEW_REQUIRED');
CREATE TYPE "financial_reconciliation_line_type" AS ENUM ('PAYMENT', 'REFUND');
CREATE TYPE "financial_reconciliation_line_status" AS ENUM (
  'MATCHED',
  'AMOUNT_MISMATCH',
  'REFERENCE_NOT_FOUND',
  'FACT_NOT_FINAL',
  'DUPLICATE_REFERENCE'
);

CREATE TABLE "financial_reconciliation_batches" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "store_id" UUID NOT NULL,
  "payment_channel_id" UUID NOT NULL,
  "source" "financial_reconciliation_source" NOT NULL DEFAULT 'PAYMENT_PROVIDER',
  "business_date" DATE NOT NULL,
  "currency" CHAR(3) NOT NULL DEFAULT 'VND',
  "batch_reference_digest" CHAR(64) NOT NULL,
  "batch_reference_masked" VARCHAR(160) NOT NULL,
  "input_digest" CHAR(64) NOT NULL,
  "idempotency_key_hash" CHAR(64) NOT NULL,
  "status" "financial_reconciliation_batch_status" NOT NULL,
  "record_count" INTEGER NOT NULL,
  "matched_count" INTEGER NOT NULL,
  "exception_count" INTEGER NOT NULL,
  "gross_amount_vnd" BIGINT NOT NULL,
  "fee_amount_vnd" BIGINT NOT NULL,
  "net_amount_vnd" BIGINT NOT NULL,
  "local_expected_amount_vnd" BIGINT NOT NULL,
  "difference_vnd" BIGINT NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "created_by" UUID NOT NULL,
  "correlation_id" VARCHAR(128) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "financial_reconciliation_batches_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "financial_reconciliation_batches_values_check" CHECK (
    "currency" = 'VND'
    AND "batch_reference_digest" ~ '^[0-9a-f]{64}$'
    AND "input_digest" ~ '^[0-9a-f]{64}$'
    AND "idempotency_key_hash" ~ '^[0-9a-f]{64}$'
    AND length(btrim("batch_reference_masked")) BETWEEN 1 AND 160
    AND length(btrim("reason")) BETWEEN 10 AND 500
    AND length(btrim("correlation_id")) BETWEEN 1 AND 128
    AND "record_count" BETWEEN 1 AND 500
    AND "matched_count" >= 0
    AND "exception_count" >= 0
    AND "record_count" = "matched_count" + "exception_count"
    AND "gross_amount_vnd" > 0
    AND "fee_amount_vnd" >= 0
    AND "local_expected_amount_vnd" >= 0
    AND "version" = 1
    AND (
      ("status" = 'MATCHED' AND "exception_count" = 0)
      OR ("status" = 'REVIEW_REQUIRED' AND "exception_count" > 0)
    )
  )
);

CREATE TABLE "financial_reconciliation_lines" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "store_id" UUID NOT NULL,
  "batch_id" UUID NOT NULL,
  "line_number" INTEGER NOT NULL,
  "type" "financial_reconciliation_line_type" NOT NULL,
  "status" "financial_reconciliation_line_status" NOT NULL,
  "record_reference_digest" CHAR(64) NOT NULL,
  "record_reference_masked" VARCHAR(160) NOT NULL,
  "provider_reference_digest" CHAR(64) NOT NULL,
  "provider_reference_masked" VARCHAR(160) NOT NULL,
  "occurred_at" TIMESTAMPTZ(6) NOT NULL,
  "gross_amount_vnd" BIGINT NOT NULL,
  "fee_amount_vnd" BIGINT NOT NULL,
  "net_amount_vnd" BIGINT NOT NULL,
  "local_expected_amount_vnd" BIGINT,
  "difference_vnd" BIGINT,
  "payment_attempt_id" UUID,
  "refund_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "financial_reconciliation_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "financial_reconciliation_lines_values_check" CHECK (
    "line_number" BETWEEN 1 AND 500
    AND "record_reference_digest" ~ '^[0-9a-f]{64}$'
    AND "provider_reference_digest" ~ '^[0-9a-f]{64}$'
    AND length(btrim("record_reference_masked")) BETWEEN 1 AND 160
    AND length(btrim("provider_reference_masked")) BETWEEN 1 AND 160
    AND "gross_amount_vnd" > 0
    AND "fee_amount_vnd" >= 0
    AND (
      ("type" = 'PAYMENT' AND "gross_amount_vnd" >= "fee_amount_vnd"
        AND "net_amount_vnd" = "gross_amount_vnd" - "fee_amount_vnd")
      OR ("type" = 'REFUND'
        AND "net_amount_vnd" = -("gross_amount_vnd" + "fee_amount_vnd"))
    )
    AND (
      ("status" IN ('REFERENCE_NOT_FOUND', 'DUPLICATE_REFERENCE')
        AND "payment_attempt_id" IS NULL AND "refund_id" IS NULL
        AND "local_expected_amount_vnd" IS NULL AND "difference_vnd" IS NULL)
      OR
      ("type" = 'PAYMENT' AND "status" IN ('MATCHED', 'AMOUNT_MISMATCH', 'FACT_NOT_FINAL')
        AND "payment_attempt_id" IS NOT NULL AND "refund_id" IS NULL
        AND "local_expected_amount_vnd" > 0 AND "difference_vnd" IS NOT NULL)
      OR
      ("type" = 'REFUND' AND "status" IN ('MATCHED', 'AMOUNT_MISMATCH', 'FACT_NOT_FINAL')
        AND "refund_id" IS NOT NULL AND "payment_attempt_id" IS NULL
        AND "local_expected_amount_vnd" > 0 AND "difference_vnd" IS NOT NULL)
    )
    AND (
      ("local_expected_amount_vnd" IS NULL AND "difference_vnd" IS NULL)
      OR "difference_vnd" = "gross_amount_vnd" - "local_expected_amount_vnd"
    )
    AND ("status" <> 'MATCHED' OR "difference_vnd" = 0)
    AND ("status" <> 'AMOUNT_MISMATCH' OR "difference_vnd" <> 0)
  )
);

CREATE UNIQUE INDEX "financial_reconciliation_batches_store_id_id_key"
  ON "financial_reconciliation_batches"("store_id", "id");
CREATE UNIQUE INDEX "financial_reconciliation_batches_channel_reference_key"
  ON "financial_reconciliation_batches"("store_id", "payment_channel_id", "batch_reference_digest");
CREATE UNIQUE INDEX "financial_reconciliation_batches_idempotency_key"
  ON "financial_reconciliation_batches"("store_id", "source", "idempotency_key_hash");
CREATE INDEX "financial_reconciliation_batches_business_date_idx"
  ON "financial_reconciliation_batches"("store_id", "business_date" DESC, "created_at" DESC, "id" DESC);
CREATE INDEX "financial_reconciliation_batches_status_idx"
  ON "financial_reconciliation_batches"("store_id", "status", "business_date" DESC, "id" DESC);

CREATE UNIQUE INDEX "financial_reconciliation_lines_store_id_id_key"
  ON "financial_reconciliation_lines"("store_id", "id");
CREATE UNIQUE INDEX "financial_reconciliation_lines_batch_line_key"
  ON "financial_reconciliation_lines"("store_id", "batch_id", "line_number");
CREATE UNIQUE INDEX "financial_reconciliation_lines_batch_record_key"
  ON "financial_reconciliation_lines"("store_id", "batch_id", "record_reference_digest");
CREATE INDEX "financial_reconciliation_lines_status_idx"
  ON "financial_reconciliation_lines"("store_id", "status", "created_at" DESC, "id" DESC);
CREATE INDEX "financial_reconciliation_lines_payment_idx"
  ON "financial_reconciliation_lines"("store_id", "payment_attempt_id");
CREATE INDEX "financial_reconciliation_lines_refund_idx"
  ON "financial_reconciliation_lines"("store_id", "refund_id");

ALTER TABLE "financial_reconciliation_batches"
  ADD CONSTRAINT "financial_reconciliation_batches_store_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "financial_reconciliation_batches_payment_channel_fkey"
    FOREIGN KEY ("store_id", "payment_channel_id")
    REFERENCES "store_payment_channels"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "financial_reconciliation_batches_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "financial_reconciliation_lines"
  ADD CONSTRAINT "financial_reconciliation_lines_store_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "financial_reconciliation_lines_batch_fkey"
    FOREIGN KEY ("store_id", "batch_id")
    REFERENCES "financial_reconciliation_batches"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "financial_reconciliation_lines_payment_fkey"
    FOREIGN KEY ("store_id", "payment_attempt_id")
    REFERENCES "payment_attempts"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "financial_reconciliation_lines_refund_fkey"
    FOREIGN KEY ("store_id", "refund_id")
    REFERENCES "refunds"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "app_security"."reject_financial_reconciliation_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '42501';
END
$$;

CREATE TRIGGER "financial_reconciliation_batches_append_only"
  BEFORE UPDATE OR DELETE ON "financial_reconciliation_batches"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_financial_reconciliation_mutation"();
CREATE TRIGGER "financial_reconciliation_lines_append_only"
  BEFORE UPDATE OR DELETE ON "financial_reconciliation_lines"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_financial_reconciliation_mutation"();

CREATE OR REPLACE FUNCTION "app_security"."assert_financial_reconciliation_batch_integrity"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_store_id uuid := (to_jsonb(NEW)->>'store_id')::uuid;
  target_batch_id uuid := COALESCE(
    (to_jsonb(NEW)->>'batch_id')::uuid,
    (to_jsonb(NEW)->>'id')::uuid
  );
  batch_fact record;
  summary record;
BEGIN
  SELECT batch.* INTO batch_fact
  FROM public.financial_reconciliation_batches AS batch
  WHERE batch.store_id = target_store_id AND batch.id = target_batch_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'financial reconciliation batch is missing'
      USING ERRCODE = '23503';
  END IF;

  SELECT
    count(*) AS record_count,
    count(*) FILTER (WHERE line.status = 'MATCHED') AS matched_count,
    count(*) FILTER (WHERE line.status <> 'MATCHED') AS exception_count,
    COALESCE(sum(line.gross_amount_vnd), 0) AS gross_amount_vnd,
    COALESCE(sum(line.fee_amount_vnd), 0) AS fee_amount_vnd,
    COALESCE(sum(line.net_amount_vnd), 0) AS net_amount_vnd,
    COALESCE(sum(line.local_expected_amount_vnd), 0) AS local_expected_amount_vnd,
    COALESCE(sum(line.difference_vnd), 0) AS difference_vnd
  INTO summary
  FROM public.financial_reconciliation_lines AS line
  WHERE line.store_id = target_store_id AND line.batch_id = target_batch_id;

  IF summary.record_count <> batch_fact.record_count
     OR summary.matched_count <> batch_fact.matched_count
     OR summary.exception_count <> batch_fact.exception_count
     OR summary.gross_amount_vnd <> batch_fact.gross_amount_vnd
     OR summary.fee_amount_vnd <> batch_fact.fee_amount_vnd
     OR summary.net_amount_vnd <> batch_fact.net_amount_vnd
     OR summary.local_expected_amount_vnd <> batch_fact.local_expected_amount_vnd
     OR summary.difference_vnd <> batch_fact.difference_vnd
  THEN
    RAISE EXCEPTION 'financial reconciliation batch summary does not match its lines'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.financial_reconciliation_lines AS line
    WHERE line.store_id = target_store_id
      AND line.batch_id = target_batch_id
      AND (
        (line.payment_attempt_id IS NOT NULL AND NOT EXISTS (
          SELECT 1
          FROM public.payment_attempts AS payment
          WHERE payment.store_id = line.store_id
            AND payment.id = line.payment_attempt_id
            AND payment.channel_id = batch_fact.payment_channel_id
        ))
        OR
        (line.refund_id IS NOT NULL AND NOT EXISTS (
          SELECT 1
          FROM public.refunds AS refund
          JOIN public.payment_attempts AS payment
            ON payment.store_id = refund.store_id
           AND payment.id = refund.payment_attempt_id
          WHERE refund.store_id = line.store_id
            AND refund.id = line.refund_id
            AND payment.channel_id = batch_fact.payment_channel_id
        ))
      )
  ) THEN
    RAISE EXCEPTION 'financial reconciliation line belongs to another payment channel'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "financial_reconciliation_batches_integrity_guard"
  AFTER INSERT ON "financial_reconciliation_batches"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "app_security"."assert_financial_reconciliation_batch_integrity"();
CREATE CONSTRAINT TRIGGER "financial_reconciliation_lines_integrity_guard"
  AFTER INSERT ON "financial_reconciliation_lines"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "app_security"."assert_financial_reconciliation_batch_integrity"();

ALTER TABLE "financial_reconciliation_batches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "financial_reconciliation_batches" FORCE ROW LEVEL SECURITY;
CREATE POLICY "financial_reconciliation_batches_tenant_isolation"
  ON "financial_reconciliation_batches"
  USING ("store_id" = app_security.current_store_id())
  WITH CHECK ("store_id" = app_security.current_store_id());

ALTER TABLE "financial_reconciliation_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "financial_reconciliation_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY "financial_reconciliation_lines_tenant_isolation"
  ON "financial_reconciliation_lines"
  USING ("store_id" = app_security.current_store_id())
  WITH CHECK ("store_id" = app_security.current_store_id());

INSERT INTO "permissions" ("code", "scope", "description") VALUES
  ('store.finance.read', 'STORE', 'Read current store financial reconciliation batches'),
  ('store.finance.reconcile', 'STORE', 'Import and review current store financial reconciliation facts')
ON CONFLICT ("code") DO UPDATE SET
  "scope" = EXCLUDED."scope",
  "description" = EXCLUDED."description";

REVOKE ALL ON FUNCTION "app_security"."reject_financial_reconciliation_mutation"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "app_security"."assert_financial_reconciliation_batch_integrity"()
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app_security"."reject_financial_reconciliation_mutation"()
  TO zalo_shop_runtime;
GRANT EXECUTE ON FUNCTION "app_security"."assert_financial_reconciliation_batch_integrity"()
  TO zalo_shop_runtime;
GRANT SELECT, INSERT ON TABLE
  "financial_reconciliation_batches", "financial_reconciliation_lines"
  TO zalo_shop_runtime;
REVOKE UPDATE, DELETE ON TABLE
  "financial_reconciliation_batches", "financial_reconciliation_lines"
  FROM zalo_shop_runtime;
