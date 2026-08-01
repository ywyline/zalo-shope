-- P0-M5-005 Slice B: trusted COD receivables and GHN remittance facts.
-- This is a local/test normalized boundary; no provider statement is fetched here.

ALTER TABLE "financial_reconciliation_batches"
  DROP CONSTRAINT "financial_reconciliation_batches_values_check";
ALTER TABLE "financial_reconciliation_lines"
  DROP CONSTRAINT "financial_reconciliation_lines_values_check";

ALTER TYPE "financial_reconciliation_source" RENAME TO "financial_reconciliation_source_old";
ALTER TYPE "financial_reconciliation_line_type" RENAME TO "financial_reconciliation_line_type_old";
ALTER TYPE "financial_reconciliation_line_status" RENAME TO "financial_reconciliation_line_status_old";
CREATE TYPE "financial_reconciliation_source" AS ENUM ('PAYMENT_PROVIDER', 'SHIPPING_PROVIDER');
CREATE TYPE "financial_reconciliation_line_type" AS ENUM ('PAYMENT', 'REFUND', 'COD_REMITTANCE');
CREATE TYPE "financial_reconciliation_line_status" AS ENUM (
  'MATCHED', 'AMOUNT_MISMATCH', 'FEE_MISMATCH', 'REFERENCE_NOT_FOUND',
  'FACT_NOT_FINAL', 'COD_NOT_RECEIVABLE', 'EXPECTED_FEE_NOT_FOUND', 'DUPLICATE_REFERENCE'
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
DROP TYPE "financial_reconciliation_source_old";
DROP TYPE "financial_reconciliation_line_type_old";
DROP TYPE "financial_reconciliation_line_status_old";

ALTER TABLE "financial_reconciliation_batches"
  ALTER COLUMN "payment_channel_id" DROP NOT NULL,
  ADD COLUMN "shipping_channel_id" UUID,
  ADD COLUMN "local_expected_fee_amount_vnd" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "fee_difference_vnd" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "financial_reconciliation_lines"
  ADD COLUMN "shipment_id" UUID,
  ADD COLUMN "local_expected_fee_amount_vnd" BIGINT,
  ADD COLUMN "fee_difference_vnd" BIGINT;

ALTER TABLE "financial_reconciliation_batches"
  ADD CONSTRAINT "financial_reconciliation_batches_source_channel_check" CHECK (
    ("source" = 'PAYMENT_PROVIDER' AND "payment_channel_id" IS NOT NULL AND "shipping_channel_id" IS NULL)
    OR ("source" = 'SHIPPING_PROVIDER' AND "payment_channel_id" IS NULL AND "shipping_channel_id" IS NOT NULL)
  ),
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
    AND "local_expected_fee_amount_vnd" >= 0
    AND ("status" = 'MATCHED' AND "exception_count" = 0 OR "status" = 'REVIEW_REQUIRED' AND "exception_count" > 0)
    AND "version" = 1
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
    AND (
      ("type" = 'PAYMENT' AND "gross_amount_vnd" >= "fee_amount_vnd"
        AND "net_amount_vnd" = "gross_amount_vnd" - "fee_amount_vnd")
      OR ("type" = 'REFUND'
        AND "net_amount_vnd" = -("gross_amount_vnd" + "fee_amount_vnd"))
      OR ("type" = 'COD_REMITTANCE'
        AND "net_amount_vnd" = "gross_amount_vnd" - "fee_amount_vnd")
    )
    AND (
      ("status" IN ('REFERENCE_NOT_FOUND', 'DUPLICATE_REFERENCE')
        AND "payment_attempt_id" IS NULL AND "refund_id" IS NULL AND "shipment_id" IS NULL
        AND "local_expected_amount_vnd" IS NULL AND "difference_vnd" IS NULL
        AND "local_expected_fee_amount_vnd" IS NULL AND "fee_difference_vnd" IS NULL)
      OR
      ("type" IN ('PAYMENT', 'REFUND') AND "status" IN ('MATCHED', 'AMOUNT_MISMATCH', 'FACT_NOT_FINAL')
        AND (("type" = 'PAYMENT' AND "payment_attempt_id" IS NOT NULL AND "refund_id" IS NULL)
          OR ("type" = 'REFUND' AND "refund_id" IS NOT NULL AND "payment_attempt_id" IS NULL))
        AND "shipment_id" IS NULL AND "local_expected_amount_vnd" > 0
        AND "difference_vnd" IS NOT NULL AND "local_expected_fee_amount_vnd" IS NULL
        AND "fee_difference_vnd" IS NULL)
      OR
      ("type" = 'COD_REMITTANCE' AND "status" IN ('MATCHED', 'AMOUNT_MISMATCH', 'FEE_MISMATCH', 'FACT_NOT_FINAL', 'COD_NOT_RECEIVABLE', 'EXPECTED_FEE_NOT_FOUND')
        AND "shipment_id" IS NOT NULL AND "payment_attempt_id" IS NULL AND "refund_id" IS NULL
        AND "local_expected_amount_vnd" IS NOT NULL AND "difference_vnd" IS NOT NULL
        AND (("status" IN ('EXPECTED_FEE_NOT_FOUND', 'FACT_NOT_FINAL', 'COD_NOT_RECEIVABLE')
              AND "local_expected_fee_amount_vnd" IS NULL AND "fee_difference_vnd" IS NULL)
          OR ("status" IN ('MATCHED', 'AMOUNT_MISMATCH', 'FEE_MISMATCH')
              AND "local_expected_fee_amount_vnd" IS NOT NULL AND "fee_difference_vnd" IS NOT NULL)))
    )
    AND ("status" <> 'MATCHED' OR ("difference_vnd" = 0 AND "fee_difference_vnd" = 0))
    AND ("status" <> 'FEE_MISMATCH' OR ("difference_vnd" = 0 AND "fee_difference_vnd" <> 0))
    AND ("status" <> 'AMOUNT_MISMATCH' OR "difference_vnd" <> 0)
  );

CREATE UNIQUE INDEX "financial_reconciliation_batches_shipping_channel_reference_key"
  ON "financial_reconciliation_batches"("store_id", "shipping_channel_id", "batch_reference_digest");
CREATE INDEX "financial_reconciliation_lines_shipment_idx"
  ON "financial_reconciliation_lines"("store_id", "shipment_id");

ALTER TABLE "financial_reconciliation_batches"
  ADD CONSTRAINT "financial_reconciliation_batches_shipping_channel_fkey"
    FOREIGN KEY ("store_id", "shipping_channel_id")
    REFERENCES "store_shipping_channels"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "financial_reconciliation_lines"
  ADD CONSTRAINT "financial_reconciliation_lines_shipment_fkey"
    FOREIGN KEY ("store_id", "shipment_id")
    REFERENCES "shipments"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

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
    COALESCE(sum(line.difference_vnd), 0) AS difference_vnd,
    COALESCE(sum(line.local_expected_fee_amount_vnd), 0) AS local_expected_fee_amount_vnd,
    COALESCE(sum(line.fee_difference_vnd), 0) AS fee_difference_vnd
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
    OR summary.local_expected_fee_amount_vnd <> batch_fact.local_expected_fee_amount_vnd
    OR summary.fee_difference_vnd <> batch_fact.fee_difference_vnd
  THEN
    RAISE EXCEPTION 'financial reconciliation batch summary does not match its lines' USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.financial_reconciliation_lines AS line
    WHERE line.store_id = target_store_id AND line.batch_id = target_batch_id
      AND (
        (batch_fact.source = 'PAYMENT_PROVIDER' AND batch_fact.payment_channel_id IS NOT NULL AND (
          (line.payment_attempt_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM public.payment_attempts payment
            WHERE payment.store_id = line.store_id AND payment.id = line.payment_attempt_id
              AND payment.channel_id = batch_fact.payment_channel_id))
          OR (line.refund_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM public.refunds refund JOIN public.payment_attempts payment
              ON payment.store_id = refund.store_id AND payment.id = refund.payment_attempt_id
            WHERE refund.store_id = line.store_id AND refund.id = line.refund_id
              AND payment.channel_id = batch_fact.payment_channel_id))
        ))
        OR (batch_fact.source = 'SHIPPING_PROVIDER' AND batch_fact.shipping_channel_id IS NOT NULL AND (
          line.shipment_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM public.shipments shipment
            WHERE shipment.store_id = line.store_id AND shipment.id = line.shipment_id
              AND shipment.channel_id = batch_fact.shipping_channel_id
              AND shipment.purpose = 'ORDER_OUTBOUND'
              AND shipment.order_id IS NOT NULL)
        ))
      )
  ) THEN
    RAISE EXCEPTION 'financial reconciliation line belongs to another channel' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION "app_security"."assert_financial_reconciliation_batch_integrity"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app_security"."assert_financial_reconciliation_batch_integrity"() TO zalo_shop_runtime;
