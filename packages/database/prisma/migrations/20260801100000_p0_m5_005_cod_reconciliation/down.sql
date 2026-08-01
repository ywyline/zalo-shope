-- Local/test rollback only. Shipping reconciliation facts are immutable and require forward repair.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "financial_reconciliation_batches" WHERE "source" = 'SHIPPING_PROVIDER'
  ) THEN
    RAISE EXCEPTION 'P0-M5-005 COD reconciliation rollback is unsafe after shipping facts exist'
      USING ERRCODE = '55000';
  END IF;
END
$$;

DROP INDEX "financial_reconciliation_lines_shipment_idx";
DROP INDEX "financial_reconciliation_batches_shipping_channel_reference_key";
ALTER TABLE "financial_reconciliation_lines"
  DROP CONSTRAINT "financial_reconciliation_lines_shipment_fkey",
  DROP CONSTRAINT "financial_reconciliation_lines_values_check";
ALTER TABLE "financial_reconciliation_batches"
  DROP CONSTRAINT "financial_reconciliation_batches_shipping_channel_fkey",
  DROP CONSTRAINT "financial_reconciliation_batches_source_channel_check",
  DROP CONSTRAINT "financial_reconciliation_batches_values_check";

ALTER TYPE "financial_reconciliation_source" RENAME TO "financial_reconciliation_source_slice_b";
ALTER TYPE "financial_reconciliation_line_type" RENAME TO "financial_reconciliation_line_type_slice_b";
ALTER TYPE "financial_reconciliation_line_status" RENAME TO "financial_reconciliation_line_status_slice_b";
CREATE TYPE "financial_reconciliation_source" AS ENUM ('PAYMENT_PROVIDER');
CREATE TYPE "financial_reconciliation_line_type" AS ENUM ('PAYMENT', 'REFUND');
CREATE TYPE "financial_reconciliation_line_status" AS ENUM (
  'MATCHED', 'AMOUNT_MISMATCH', 'REFERENCE_NOT_FOUND', 'FACT_NOT_FINAL', 'DUPLICATE_REFERENCE'
);
ALTER TABLE "financial_reconciliation_batches"
  ALTER COLUMN "source" DROP DEFAULT,
  ALTER COLUMN "source" TYPE "financial_reconciliation_source"
    USING "source"::text::"financial_reconciliation_source",
  ALTER COLUMN "source" SET DEFAULT 'PAYMENT_PROVIDER';
ALTER TABLE "financial_reconciliation_lines"
  ALTER COLUMN "type" TYPE "financial_reconciliation_line_type"
    USING "type"::text::"financial_reconciliation_line_type",
  ALTER COLUMN "status" TYPE "financial_reconciliation_line_status"
    USING "status"::text::"financial_reconciliation_line_status";
DROP TYPE "financial_reconciliation_source_slice_b";
DROP TYPE "financial_reconciliation_line_type_slice_b";
DROP TYPE "financial_reconciliation_line_status_slice_b";

ALTER TABLE "financial_reconciliation_lines"
  DROP COLUMN "shipment_id",
  DROP COLUMN "local_expected_fee_amount_vnd",
  DROP COLUMN "fee_difference_vnd";
ALTER TABLE "financial_reconciliation_batches"
  DROP COLUMN "shipping_channel_id",
  DROP COLUMN "local_expected_fee_amount_vnd",
  DROP COLUMN "fee_difference_vnd",
  ALTER COLUMN "payment_channel_id" SET NOT NULL;

ALTER TABLE "financial_reconciliation_batches"
  ADD CONSTRAINT "financial_reconciliation_batches_values_check" CHECK (
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
    AND ("status" = 'MATCHED' AND "exception_count" = 0 OR "status" = 'REVIEW_REQUIRED' AND "exception_count" > 0)
  );

ALTER TABLE "financial_reconciliation_lines"
  ADD CONSTRAINT "financial_reconciliation_lines_values_check" CHECK (
    "line_number" BETWEEN 1 AND 500
    AND "record_reference_digest" ~ '^[0-9a-f]{64}$'
    AND "provider_reference_digest" ~ '^[0-9a-f]{64}$'
    AND length(btrim("record_reference_masked")) BETWEEN 1 AND 160
    AND length(btrim("provider_reference_masked")) BETWEEN 1 AND 160
    AND "gross_amount_vnd" > 0
    AND "fee_amount_vnd" >= 0
    AND (("type" = 'PAYMENT' AND "gross_amount_vnd" >= "fee_amount_vnd"
          AND "net_amount_vnd" = "gross_amount_vnd" - "fee_amount_vnd")
      OR ("type" = 'REFUND' AND "net_amount_vnd" = -("gross_amount_vnd" + "fee_amount_vnd")))
    AND (("status" IN ('REFERENCE_NOT_FOUND', 'DUPLICATE_REFERENCE')
          AND "payment_attempt_id" IS NULL AND "refund_id" IS NULL
          AND "local_expected_amount_vnd" IS NULL AND "difference_vnd" IS NULL)
      OR ("type" = 'PAYMENT' AND "status" IN ('MATCHED', 'AMOUNT_MISMATCH', 'FACT_NOT_FINAL')
          AND "payment_attempt_id" IS NOT NULL AND "refund_id" IS NULL
          AND "local_expected_amount_vnd" > 0 AND "difference_vnd" IS NOT NULL)
      OR ("type" = 'REFUND' AND "status" IN ('MATCHED', 'AMOUNT_MISMATCH', 'FACT_NOT_FINAL')
          AND "refund_id" IS NOT NULL AND "payment_attempt_id" IS NULL
          AND "local_expected_amount_vnd" > 0 AND "difference_vnd" IS NOT NULL))
    AND (("local_expected_amount_vnd" IS NULL AND "difference_vnd" IS NULL)
      OR "difference_vnd" = "gross_amount_vnd" - "local_expected_amount_vnd")
    AND ("status" <> 'MATCHED' OR "difference_vnd" = 0)
    AND ("status" <> 'AMOUNT_MISMATCH' OR "difference_vnd" <> 0)
  );

CREATE OR REPLACE FUNCTION "app_security"."assert_financial_reconciliation_batch_integrity"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_store_id uuid := (to_jsonb(NEW)->>'store_id')::uuid;
  target_batch_id uuid := COALESCE((to_jsonb(NEW)->>'batch_id')::uuid, (to_jsonb(NEW)->>'id')::uuid);
  batch_fact record;
  summary record;
BEGIN
  SELECT batch.* INTO batch_fact
  FROM public.financial_reconciliation_batches AS batch
  WHERE batch.store_id = target_store_id AND batch.id = target_batch_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'financial reconciliation batch is missing' USING ERRCODE = '23503';
  END IF;

  SELECT count(*) AS record_count,
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
    RAISE EXCEPTION 'financial reconciliation batch summary does not match its lines' USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.financial_reconciliation_lines AS line
    WHERE line.store_id = target_store_id AND line.batch_id = target_batch_id
      AND ((line.payment_attempt_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.payment_attempts payment
        WHERE payment.store_id = line.store_id AND payment.id = line.payment_attempt_id
          AND payment.channel_id = batch_fact.payment_channel_id))
      OR (line.refund_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.refunds refund JOIN public.payment_attempts payment
          ON payment.store_id = refund.store_id AND payment.id = refund.payment_attempt_id
        WHERE refund.store_id = line.store_id AND refund.id = line.refund_id
          AND payment.channel_id = batch_fact.payment_channel_id)))
  ) THEN
    RAISE EXCEPTION 'financial reconciliation line belongs to another payment channel' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION "app_security"."assert_financial_reconciliation_batch_integrity"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app_security"."assert_financial_reconciliation_batch_integrity"() TO zalo_shop_runtime;
