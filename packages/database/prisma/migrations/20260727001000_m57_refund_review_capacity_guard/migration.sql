-- Ambiguous provider outcomes must keep their amount reserved until an audited review resolves them.
CREATE OR REPLACE FUNCTION "app_security"."enforce_refund_capacity"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE captured_amount bigint;
DECLARE captured_order uuid;
DECLARE captured_status "payment_attempt_status";
DECLARE reserved_amount bigint;
BEGIN
  SELECT attempt."amount_vnd", attempt."order_id", attempt."status"
    INTO captured_amount, captured_order, captured_status
  FROM "payment_attempts" AS attempt
  WHERE attempt."store_id" = NEW."store_id"
    AND attempt."id" = NEW."payment_attempt_id"
  FOR UPDATE;

  IF NOT FOUND OR captured_order <> NEW."order_id" OR captured_status <> 'SUCCEEDED' THEN
    RAISE EXCEPTION 'refund requires a successful matching payment attempt'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."status" IN ('REQUESTED', 'PROCESSING', 'SUCCEEDED', 'REVIEW_REQUIRED') THEN
    SELECT COALESCE(sum(refund."amount_vnd"), 0)
      INTO reserved_amount
    FROM "refunds" AS refund
    WHERE refund."store_id" = NEW."store_id"
      AND refund."payment_attempt_id" = NEW."payment_attempt_id"
      AND refund."id" <> NEW."id"
      AND refund."status" IN ('REQUESTED', 'PROCESSING', 'SUCCEEDED', 'REVIEW_REQUIRED');

    IF reserved_amount + NEW."amount_vnd" > captured_amount THEN
      RAISE EXCEPTION 'refund amount exceeds captured payment amount'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
