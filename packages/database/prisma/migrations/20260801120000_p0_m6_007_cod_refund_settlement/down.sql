-- Local/test rollback only. Trusted COD refund facts require forward repair.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.after_sale_cod_refund_confirmations)
     OR EXISTS (SELECT 1 FROM public.after_sale_cod_refund_receipts)
     OR EXISTS (
       SELECT 1 FROM public.after_sale_settlements WHERE method = 'COD_OFFLINE'
     )
     OR EXISTS (
       SELECT 1 FROM public.audit_logs
       WHERE action IN (
         'after-sale.cod-refund.requested',
         'after-sale.cod-refund.receipt-recorded',
         'after-sale.cod-refund.confirmed'
       )
     )
     OR EXISTS (
       SELECT 1
       FROM public.after_sale_transitions requested
       JOIN public.after_sale_transitions succeeded
         ON succeeded.store_id = requested.store_id
        AND succeeded.after_sale_id = requested.after_sale_id
        AND succeeded.actor_type = requested.actor_type
        AND succeeded.actor_id = requested.actor_id
        AND succeeded.correlation_id = requested.correlation_id
        AND succeeded.created_at = requested.created_at + INTERVAL '1 millisecond'
       WHERE requested.event = 'REFUND_REQUESTED'
         AND requested.from_status = 'REFUND_PENDING'
         AND requested.to_status = 'REFUND_PROCESSING'
         AND requested.actor_type = 'ADMIN'
         AND requested.operation_id IS NULL
         AND succeeded.event = 'REFUND_SUCCEEDED'
         AND succeeded.from_status = 'REFUND_PROCESSING'
         AND succeeded.to_status = 'REFUNDED'
         AND succeeded.operation_id IS NULL
     )
  THEN
    RAISE EXCEPTION 'P0-M6-007 rollback is unsafe after COD refund facts exist'
      USING ERRCODE = '55000';
  END IF;
END
$$;

-- Restore the exact B3 ONLINE-only payment guard after the fact-free local/test rollback.
DO $p0_m6_007$
DECLARE current_definition text;
DECLARE online_guard text := $p0_m6_007_online_guard$
  IF NOT FOUND
     OR order_record.status NOT IN ('DELIVERED','COMPLETED')
     OR order_record.currency <> 'VND'
     OR order_record.payment_method <> 'ONLINE'
     OR order_record.payment_status NOT IN ('SUCCEEDED','PARTIALLY_REFUNDED')
  THEN
    RAISE EXCEPTION 'B3 command facts are not eligible for submission'
      USING ERRCODE = '23514';
  END IF;

  PERFORM 1 FROM public.payment_attempts attempt
  WHERE attempt.store_id = sale.store_id AND attempt.order_id = sale.order_id
  ORDER BY attempt.id
  FOR SHARE;
  IF 1 <> (
    SELECT pg_catalog.count(*)
    FROM public.payment_attempts attempt
    WHERE attempt.store_id = sale.store_id
      AND attempt.order_id = sale.order_id
      AND attempt.status = 'SUCCEEDED'
      AND attempt.currency = 'VND'
      AND attempt.amount_vnd = order_record.payable_vnd
      AND attempt.succeeded_at IS NOT NULL
      AND NULLIF(pg_catalog.btrim(attempt.provider_transaction_id), '') IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'B3 command facts are not eligible for submission'
      USING ERRCODE = '23514';
  END IF;
$p0_m6_007_online_guard$;
DECLARE cod_guard text := $p0_m6_007_cod_guard$
  IF NOT FOUND
     OR order_record.status NOT IN ('DELIVERED','COMPLETED')
     OR order_record.currency <> 'VND'
     OR order_record.payment_method NOT IN ('ONLINE','COD')
  THEN
    RAISE EXCEPTION 'B3 command facts are not eligible for submission'
      USING ERRCODE = '23514';
  END IF;

  IF order_record.payment_method = 'ONLINE' THEN
    IF order_record.payment_status NOT IN ('SUCCEEDED','PARTIALLY_REFUNDED') THEN
      RAISE EXCEPTION 'B3 command facts are not eligible for submission'
        USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM public.payment_attempts attempt
    WHERE attempt.store_id = sale.store_id AND attempt.order_id = sale.order_id
    ORDER BY attempt.id
    FOR SHARE;
    IF 1 <> (
      SELECT pg_catalog.count(*)
      FROM public.payment_attempts attempt
      WHERE attempt.store_id = sale.store_id
        AND attempt.order_id = sale.order_id
        AND attempt.status = 'SUCCEEDED'
        AND attempt.currency = 'VND'
        AND attempt.amount_vnd = order_record.payable_vnd
        AND attempt.succeeded_at IS NOT NULL
        AND NULLIF(pg_catalog.btrim(attempt.provider_transaction_id), '') IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'B3 command facts are not eligible for submission'
        USING ERRCODE = '23514';
    END IF;
  ELSIF 1 <> (
    SELECT pg_catalog.count(*)
    FROM public.financial_reconciliation_lines line
    JOIN public.financial_reconciliation_batches batch
      ON batch.store_id = line.store_id AND batch.id = line.batch_id
    JOIN public.shipments shipment
      ON shipment.store_id = line.store_id AND shipment.id = line.shipment_id
    WHERE line.store_id = sale.store_id
      AND shipment.order_id = sale.order_id
      AND shipment.purpose = 'ORDER_OUTBOUND'
      AND shipment.status = 'DELIVERED'
      AND shipment.delivered_at IS NOT NULL
      AND shipment.cod_amount_vnd = order_record.payable_vnd
      AND batch.source = 'SHIPPING_PROVIDER'
      AND batch.shipping_channel_id = shipment.channel_id
      AND line.type = 'COD_REMITTANCE'
      AND line.status = 'MATCHED'
      AND line.gross_amount_vnd = order_record.payable_vnd
      AND line.local_expected_amount_vnd = order_record.payable_vnd
      AND line.difference_vnd = 0
  ) THEN
    RAISE EXCEPTION 'B3 command facts are not eligible for submission'
      USING ERRCODE = '23514';
  END IF;
$p0_m6_007_cod_guard$;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'app_security.validate_m63_b3_command_facts(uuid)'::pg_catalog.regprocedure
  ) INTO current_definition;
  IF pg_catalog.strpos(current_definition, cod_guard) = 0
     OR pg_catalog.strpos(current_definition, online_guard) <> 0
  THEN
    RAISE EXCEPTION 'P0-M6-007 cannot restore the unknown B3 payment guard baseline'
      USING ERRCODE = '55000';
  END IF;
  EXECUTE pg_catalog.replace(current_definition, cod_guard, online_guard);
END
$p0_m6_007$;

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_settlement_lifecycle"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE refund_status text;
DECLARE sale_record record;
BEGIN
  SELECT sale.status, sale.review_resume_status
  INTO sale_record
  FROM public.after_sales sale
  WHERE sale.store_id = NEW.store_id AND sale.id = NEW.after_sale_id
    AND sale.order_id = NEW.order_id
  FOR UPDATE;
  IF NOT FOUND
     OR sale_record.status NOT IN ('REFUND_PENDING','REFUND_PROCESSING','REVIEW_REQUIRED')
     OR (sale_record.status = 'REVIEW_REQUIRED'
       AND (sale_record.review_resume_status IS NULL
         OR sale_record.review_resume_status NOT IN ('REFUND_PENDING','REFUND_PROCESSING')))
  THEN
    RAISE EXCEPTION 'settlement requires the locked after-sale refund aggregate state'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF pg_catalog.current_setting('app.actor_type', true) <> 'admin'
       OR NEW.requested_by <> app_security.current_actor_id()
       OR NEW.status <> 'PENDING' OR NEW.version <> 1
       OR NEW.confirmed_by IS NOT NULL OR NEW.confirmed_at IS NOT NULL
       OR NEW.completed_at IS NOT NULL
       OR (NEW.method = 'ONLINE_ORIGINAL'
         AND (NEW.transfer_reference_digest IS NOT NULL OR NEW.transfer_evidence_ciphertext IS NOT NULL))
       OR (NEW.method = 'COD_OFFLINE'
         AND (NEW.transfer_reference_digest IS NULL
           OR NEW.transfer_reference_digest !~ '^[0-9a-f]{64}$'
           OR NEW.transfer_evidence_ciphertext IS NULL))
       OR (NEW.method = 'NO_PAYOUT'
         AND (NEW.transfer_reference_digest IS NOT NULL OR NEW.transfer_evidence_ciphertext IS NOT NULL))
    THEN
      RAISE EXCEPTION 'settlement must be actor-bound and created pending without completion facts'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF pg_catalog.current_setting('app.actor_type', true) <> 'admin' THEN
    RAISE EXCEPTION 'settlement transitions require an administrator' USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('SUCCEEDED','FAILED','CANCELLED') THEN
    RAISE EXCEPTION 'terminal settlement is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = OLD.status OR NEW.version <> OLD.version + 1
     OR NEW.updated_at < OLD.updated_at
     OR (pg_catalog.to_jsonb(NEW) - ARRAY['status','confirmed_by','confirmed_at','completed_at','version','updated_at'])
        IS DISTINCT FROM
        (pg_catalog.to_jsonb(OLD) - ARRAY['status','confirmed_by','confirmed_at','completed_at','version','updated_at'])
  THEN
    RAISE EXCEPTION 'invalid settlement update shape' USING ERRCODE = '23514';
  END IF;

  IF NEW.method = 'ONLINE_ORIGINAL' THEN
    IF NEW.confirmed_by IS NOT NULL OR NEW.confirmed_at IS NOT NULL THEN
      RAISE EXCEPTION 'online settlement cannot contain COD confirmation facts'
        USING ERRCODE = '23514';
    END IF;
    SELECT refund.status::text INTO refund_status
    FROM public.after_sale_refunds link
    JOIN public.refunds refund ON refund.store_id = link.store_id AND refund.id = link.refund_id
    WHERE link.store_id = NEW.store_id AND link.settlement_id = NEW.id
      AND link.after_sale_id = NEW.after_sale_id AND link.order_id = NEW.order_id
      AND link.payment_attempt_id = NEW.payment_attempt_id AND link.amount_vnd = NEW.amount_vnd;
    IF NOT FOUND OR NOT (
      (refund_status IN ('REQUESTED','PROCESSING') AND NEW.status = 'PROCESSING')
      OR (refund_status = 'SUCCEEDED' AND NEW.status = 'SUCCEEDED')
      OR (refund_status = 'FAILED' AND NEW.status = 'FAILED')
      OR (refund_status = 'CANCELLED' AND NEW.status = 'CANCELLED')
      OR (refund_status = 'REVIEW_REQUIRED' AND NEW.status = 'REVIEW_REQUIRED')
    ) THEN
      RAISE EXCEPTION 'online settlement must project its exact linked M5 refund status'
        USING ERRCODE = '23514';
    END IF;
    IF refund_status <> 'REQUESTED' AND NOT EXISTS (
      SELECT 1 FROM public.after_sale_refunds link
      JOIN public.refund_transitions transition ON transition.store_id = link.store_id
        AND transition.refund_id = link.refund_id
      WHERE link.store_id = NEW.store_id AND link.settlement_id = NEW.id
        AND transition.to_status::text = refund_status
    ) THEN
      RAISE EXCEPTION 'online settlement requires an append-only M5 refund transition fact'
        USING ERRCODE = '23514';
    END IF;
    IF (NEW.status = 'SUCCEEDED' AND NEW.completed_at IS NULL)
       OR (NEW.status <> 'SUCCEEDED' AND NEW.completed_at IS NOT NULL)
    THEN
      RAISE EXCEPTION 'online settlement completion timestamp does not match its status'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.method = 'COD_OFFLINE' THEN
    IF NEW.status NOT IN ('SUCCEEDED','FAILED','CANCELLED','REVIEW_REQUIRED') THEN
      RAISE EXCEPTION 'COD settlement has no direct transition to the requested status'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'SUCCEEDED' AND (
      OLD.status NOT IN ('PENDING','REVIEW_REQUIRED')
      OR OLD.confirmed_by IS NOT NULL
      OR NEW.confirmed_by IS NULL
      OR NEW.confirmed_by IS DISTINCT FROM app_security.current_actor_id()
      OR NEW.confirmed_by IS NOT DISTINCT FROM NEW.requested_by
      OR NEW.confirmed_at IS NULL OR NEW.completed_at IS NULL
      OR NEW.transfer_reference_digest IS NULL
      OR NEW.transfer_reference_digest !~ '^[0-9a-f]{64}$'
      OR NEW.transfer_evidence_ciphertext IS NULL
    ) THEN
      RAISE EXCEPTION 'COD settlement success requires a distinct current confirmer and evidence'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.status IN ('FAILED','CANCELLED','REVIEW_REQUIRED')
       AND (NEW.confirmed_by IS NOT NULL OR NEW.confirmed_at IS NOT NULL OR NEW.completed_at IS NOT NULL)
    THEN
      RAISE EXCEPTION 'non-successful COD settlement cannot claim confirmation completion'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.status <> 'REVIEW_REQUIRED' OR NEW.confirmed_by IS NOT NULL
       OR NEW.confirmed_at IS NOT NULL OR NEW.completed_at IS NOT NULL
    THEN
      RAISE EXCEPTION 'NO_PAYOUT settlement has no authoritative success path'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TABLE "after_sale_cod_refund_confirmations";
DROP TABLE "after_sale_cod_refund_receipts";
DROP INDEX "after_sale_settlements_cod_receipt_identity_key";

DROP FUNCTION "app_security"."validate_p0_m6_007_confirmation_atomicity"();
DROP FUNCTION "app_security"."validate_p0_m6_007_confirmation"();
DROP FUNCTION "app_security"."validate_p0_m6_007_receipt_atomicity"();
DROP FUNCTION "app_security"."validate_p0_m6_007_receipt"();
DROP FUNCTION "app_security"."assert_p0_m6_007_admin_authorization"(text);
