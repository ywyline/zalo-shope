-- P0-M6-007: trusted COD receipt admission and maker-checker refund settlement.
-- Existing COD settlement rows cannot be assigned trustworthy historical receipt facts.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.after_sale_settlements WHERE method = 'COD_OFFLINE'
  ) THEN
    RAISE EXCEPTION 'P0-M6-007 requires an empty COD settlement baseline'
      USING ERRCODE = '55000';
  END IF;
END
$$;

-- Extend the existing B3 final database authorization from ONLINE-only proof
-- to the exact immutable COD remittance fact admitted by B7. Fail closed if
-- the reviewed B3 baseline has drifted instead of rewriting an unknown body.
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
  IF pg_catalog.strpos(current_definition, online_guard) = 0
     OR pg_catalog.strpos(current_definition, cod_guard) <> 0
  THEN
    RAISE EXCEPTION 'P0-M6-007 cannot extend the unknown B3 payment guard baseline'
      USING ERRCODE = '55000';
  END IF;
  EXECUTE pg_catalog.replace(current_definition, online_guard, cod_guard);
END
$p0_m6_007$;

CREATE UNIQUE INDEX "after_sale_settlements_cod_receipt_identity_key"
  ON "after_sale_settlements"("store_id", "id", "after_sale_id", "order_id", "amount_vnd");

CREATE TABLE "after_sale_cod_refund_receipts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "store_id" UUID NOT NULL,
  "settlement_id" UUID NOT NULL,
  "after_sale_id" UUID NOT NULL,
  "order_id" UUID NOT NULL,
  "amount_vnd" BIGINT NOT NULL,
  "currency" CHAR(3) NOT NULL DEFAULT 'VND',
  "transfer_reference_digest" CHAR(64) NOT NULL,
  "transfer_reference_masked" VARCHAR(160) NOT NULL,
  "evidence_digest" CHAR(64) NOT NULL,
  "evidence_ciphertext" TEXT NOT NULL,
  "transferred_at" TIMESTAMPTZ(6) NOT NULL,
  "expected_settlement_version" INTEGER NOT NULL,
  "recorded_by" UUID NOT NULL,
  "idempotency_key_hash" CHAR(64) NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "correlation_id" VARCHAR(128) NOT NULL,
  "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "after_sale_cod_refund_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "after_sale_cod_refund_receipts_values_check" CHECK (
    "amount_vnd" > 0
    AND "amount_vnd" <= 9007199254740991
    AND "currency" = 'VND'
    AND "expected_settlement_version" > 0
    AND "transfer_reference_digest" ~ '^[0-9a-f]{64}$'
    AND "evidence_digest" ~ '^[0-9a-f]{64}$'
    AND "idempotency_key_hash" ~ '^[0-9a-f]{64}$'
    AND "request_hash" ~ '^[0-9a-f]{64}$'
    AND length(btrim("transfer_reference_masked")) BETWEEN 2 AND 160
    AND length(btrim("evidence_ciphertext")) > 0
    AND length(btrim("correlation_id")) BETWEEN 1 AND 128
  )
);

CREATE UNIQUE INDEX "after_sale_cod_refund_receipts_store_id_key"
  ON "after_sale_cod_refund_receipts"("store_id", "id");
CREATE UNIQUE INDEX "after_sale_cod_refund_receipts_settlement_key"
  ON "after_sale_cod_refund_receipts"("store_id", "settlement_id");
CREATE UNIQUE INDEX "after_sale_cod_refund_receipts_settlement_identity_key"
  ON "after_sale_cod_refund_receipts"(
    "store_id", "settlement_id", "after_sale_id", "order_id", "amount_vnd"
  );
CREATE UNIQUE INDEX "after_sale_cod_refund_receipts_reference_key"
  ON "after_sale_cod_refund_receipts"("store_id", "transfer_reference_digest");
CREATE UNIQUE INDEX "after_sale_cod_refund_receipts_idempotency_key"
  ON "after_sale_cod_refund_receipts"("store_id", "idempotency_key_hash");
CREATE INDEX "after_sale_cod_refund_receipts_case_recorded_idx"
  ON "after_sale_cod_refund_receipts"("store_id", "after_sale_id", "recorded_at" DESC, "id" DESC);

ALTER TABLE "after_sale_cod_refund_receipts"
  ADD CONSTRAINT "after_sale_cod_refund_receipts_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_cod_refund_receipts_case_order_fkey"
    FOREIGN KEY ("store_id", "after_sale_id", "order_id")
    REFERENCES "after_sales"("store_id", "id", "order_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_cod_refund_receipts_settlement_fkey"
    FOREIGN KEY ("store_id", "settlement_id", "after_sale_id", "order_id", "amount_vnd")
    REFERENCES "after_sale_settlements"("store_id", "id", "after_sale_id", "order_id", "amount_vnd")
    ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_cod_refund_receipts_recorded_by_fkey"
    FOREIGN KEY ("recorded_by") REFERENCES "admin_users"("id") ON DELETE RESTRICT;

CREATE TABLE "after_sale_cod_refund_confirmations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "store_id" UUID NOT NULL,
  "settlement_id" UUID NOT NULL,
  "after_sale_id" UUID NOT NULL,
  "order_id" UUID NOT NULL,
  "amount_vnd" BIGINT NOT NULL,
  "expected_after_sale_version" INTEGER NOT NULL,
  "expected_settlement_version" INTEGER NOT NULL,
  "result_after_sale_version" INTEGER NOT NULL,
  "result_settlement_version" INTEGER NOT NULL,
  "result_status" "after_sale_status" NOT NULL,
  "confirmed_by" UUID NOT NULL,
  "idempotency_key_hash" CHAR(64) NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "correlation_id" VARCHAR(128) NOT NULL,
  "confirmed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "after_sale_cod_refund_confirmations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "after_sale_cod_refund_confirmations_values_check" CHECK (
    "amount_vnd" > 0
    AND "amount_vnd" <= 9007199254740991
    AND "expected_after_sale_version" > 0
    AND "expected_settlement_version" > 0
    AND "result_after_sale_version" = "expected_after_sale_version" + 2
    AND "result_settlement_version" = "expected_settlement_version" + 1
    AND "result_status" = 'REFUNDED'
    AND "idempotency_key_hash" ~ '^[0-9a-f]{64}$'
    AND "request_hash" ~ '^[0-9a-f]{64}$'
    AND length(btrim("correlation_id")) BETWEEN 1 AND 128
  )
);

CREATE UNIQUE INDEX "after_sale_cod_refund_confirmations_store_id_key"
  ON "after_sale_cod_refund_confirmations"("store_id", "id");
CREATE UNIQUE INDEX "after_sale_cod_refund_confirmations_settlement_key"
  ON "after_sale_cod_refund_confirmations"("store_id", "settlement_id");
CREATE UNIQUE INDEX "after_sale_cod_refund_confirmations_settlement_identity_key"
  ON "after_sale_cod_refund_confirmations"(
    "store_id", "settlement_id", "after_sale_id", "order_id", "amount_vnd"
  );
CREATE UNIQUE INDEX "after_sale_cod_refund_confirmations_idempotency_key"
  ON "after_sale_cod_refund_confirmations"("store_id", "idempotency_key_hash");
CREATE INDEX "after_sale_cod_refund_confirmations_case_confirmed_idx"
  ON "after_sale_cod_refund_confirmations"("store_id", "after_sale_id", "confirmed_at" DESC, "id" DESC);

ALTER TABLE "after_sale_cod_refund_confirmations"
  ADD CONSTRAINT "after_sale_cod_refund_confirmations_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_cod_refund_confirmations_case_order_fkey"
    FOREIGN KEY ("store_id", "after_sale_id", "order_id")
    REFERENCES "after_sales"("store_id", "id", "order_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_cod_refund_confirmations_settlement_fkey"
    FOREIGN KEY ("store_id", "settlement_id", "after_sale_id", "order_id", "amount_vnd")
    REFERENCES "after_sale_settlements"("store_id", "id", "after_sale_id", "order_id", "amount_vnd")
    ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_cod_refund_confirmations_confirmed_by_fkey"
    FOREIGN KEY ("confirmed_by") REFERENCES "admin_users"("id") ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION "app_security"."assert_p0_m6_007_admin_authorization"(
  p_permission_code text
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE authorization_found boolean;
BEGIN
  IF p_permission_code NOT IN (
    'store.after-sales.cod-refunds.request',
    'store.after-sales.cod-refunds.confirm'
  ) OR pg_catalog.current_setting('app.actor_type', true) IS DISTINCT FROM 'admin'
     OR pg_catalog.current_setting('app.admin_authorization_scope', true) IS DISTINCT FROM 'STORE'
  THEN
    RAISE EXCEPTION 'COD refund authorization is invalid' USING ERRCODE = '42501';
  END IF;

  WITH locked_authorization AS MATERIALIZED (
    SELECT role_permission.permission_code
    FROM public.stores store
    JOIN public.admin_users admin ON admin.id = app_security.current_actor_id()
    JOIN public.admin_sessions session
      ON session.id = NULLIF(pg_catalog.current_setting('app.access_session_id', true), '')::uuid
      AND session.admin_user_id = admin.id
    JOIN public.admin_store_roles assignment
      ON assignment.store_id = store.id AND assignment.admin_user_id = admin.id
    JOIN public.store_role_permissions role_permission
      ON role_permission.store_id = assignment.store_id
      AND role_permission.role_id = assignment.role_id
    WHERE store.id = app_security.current_store_id()
      AND store.status = 'ACTIVE'
      AND admin.status = 'ACTIVE'
      AND session.revoked_at IS NULL
      AND session.expires_at > pg_catalog.clock_timestamp()
      AND session.mfa_verified_at >= pg_catalog.clock_timestamp() - INTERVAL '10 minutes'
      AND NULLIF(pg_catalog.current_setting('app.access_token_expires_at', true), '')::timestamptz
        > pg_catalog.clock_timestamp()
      AND role_permission.permission_code IN (
        'store.after-sales.read',
        p_permission_code
      )
    ORDER BY assignment.role_id, role_permission.permission_code
    FOR SHARE OF store, admin, session, assignment, role_permission
  )
  SELECT pg_catalog.count(DISTINCT permission_code) = 2 INTO authorization_found
  FROM locked_authorization;

  IF authorization_found IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'COD refund authorization is no longer valid' USING ERRCODE = '42501';
  END IF;
END
$$;

REVOKE ALL ON FUNCTION "app_security"."assert_p0_m6_007_admin_authorization"(text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app_security"."assert_p0_m6_007_admin_authorization"(text)
  TO zalo_shop_runtime;

CREATE OR REPLACE FUNCTION "app_security"."validate_p0_m6_007_receipt"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE settlement_record record;
BEGIN
  PERFORM app_security.assert_p0_m6_007_admin_authorization(
    'store.after-sales.cod-refunds.request'
  );
  IF NEW.store_id IS DISTINCT FROM app_security.current_store_id()
     OR NEW.recorded_by IS DISTINCT FROM app_security.current_actor_id()
     OR NEW.correlation_id IS DISTINCT FROM
       NULLIF(pg_catalog.current_setting('app.correlation_id', true), '')
  THEN
    RAISE EXCEPTION 'COD refund receipt is outside the current actor scope'
      USING ERRCODE = '42501';
  END IF;

  SELECT settlement.* INTO settlement_record
  FROM public.after_sale_settlements settlement
  WHERE settlement.store_id = NEW.store_id AND settlement.id = NEW.settlement_id
    AND settlement.after_sale_id = NEW.after_sale_id
    AND settlement.order_id = NEW.order_id
    AND settlement.amount_vnd = NEW.amount_vnd
  FOR UPDATE;
  IF NOT FOUND
     OR settlement_record.method <> 'COD_OFFLINE'
     OR settlement_record.status NOT IN ('PENDING','REVIEW_REQUIRED')
     OR settlement_record.version <> NEW.expected_settlement_version
     OR settlement_record.requested_by <> NEW.recorded_by
     OR settlement_record.confirmed_by IS NOT NULL
     OR settlement_record.transfer_reference_digest IS NOT NULL
     OR settlement_record.transfer_evidence_ciphertext IS NOT NULL
     OR NEW.currency <> settlement_record.currency
     OR NEW.transferred_at < settlement_record.requested_at
     OR NEW.transferred_at > pg_catalog.clock_timestamp() + INTERVAL '5 minutes'
  THEN
    RAISE EXCEPTION 'COD refund receipt does not match a pending requested settlement'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "after_sale_cod_refund_receipts_insert_guard"
  BEFORE INSERT ON "after_sale_cod_refund_receipts"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_p0_m6_007_receipt"();
CREATE TRIGGER "after_sale_cod_refund_receipts_append_only"
  BEFORE UPDATE OR DELETE ON "after_sale_cod_refund_receipts"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_m62_append_only_mutation"();

CREATE OR REPLACE FUNCTION "app_security"."validate_p0_m6_007_receipt_atomicity"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE audit_count bigint;
BEGIN
  SELECT pg_catalog.count(*) INTO audit_count
  FROM public.audit_logs audit
  WHERE audit.store_id = NEW.store_id
    AND audit.actor_type = 'ADMIN'
    AND audit.actor_id = NEW.recorded_by
    AND audit.target_type = 'after_sale'
    AND audit.target_id = NEW.after_sale_id::text
    AND audit.action = 'after-sale.cod-refund.receipt-recorded'
    AND audit.correlation_id = NEW.correlation_id
    AND audit.after_data->>'receipt_identity_digest' = pg_catalog.encode(
      public.digest(pg_catalog.convert_to(NEW.id::text, 'UTF8'), 'sha256'), 'hex'
    )
    AND audit.after_data->>'settlement_id' = NEW.settlement_id::text;
  IF audit_count <> 1 THEN
    RAISE EXCEPTION 'COD refund receipt and audit must commit atomically'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "after_sale_cod_refund_receipts_atomic_guard"
  AFTER INSERT ON "after_sale_cod_refund_receipts"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_p0_m6_007_receipt_atomicity"();

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_settlement_lifecycle"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE refund_status text;
DECLARE sale_record record;
DECLARE receipt_record record;
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
       OR NEW.transfer_reference_digest IS NOT NULL
       OR NEW.transfer_evidence_ciphertext IS NOT NULL
    THEN
      RAISE EXCEPTION 'settlement must be actor-bound and created pending without completion facts'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.method = 'COD_OFFLINE' THEN
      PERFORM app_security.assert_p0_m6_007_admin_authorization(
        'store.after-sales.cod-refunds.request'
      );
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
     OR (pg_catalog.to_jsonb(NEW) - ARRAY[
          'status','confirmed_by','confirmed_at','completed_at',
          'transfer_reference_digest','transfer_evidence_ciphertext','version','updated_at'
        ]) IS DISTINCT FROM
        (pg_catalog.to_jsonb(OLD) - ARRAY[
          'status','confirmed_by','confirmed_at','completed_at',
          'transfer_reference_digest','transfer_evidence_ciphertext','version','updated_at'
        ])
  THEN
    RAISE EXCEPTION 'invalid settlement update shape' USING ERRCODE = '23514';
  END IF;

  IF NEW.method = 'ONLINE_ORIGINAL' THEN
    IF NEW.confirmed_by IS NOT NULL OR NEW.confirmed_at IS NOT NULL
       OR NEW.transfer_reference_digest IS NOT NULL
       OR NEW.transfer_evidence_ciphertext IS NOT NULL
    THEN
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
    IF NEW.status = 'SUCCEEDED' THEN
      PERFORM app_security.assert_p0_m6_007_admin_authorization(
        'store.after-sales.cod-refunds.confirm'
      );
      SELECT receipt.* INTO receipt_record
      FROM public.after_sale_cod_refund_receipts receipt
      WHERE receipt.store_id = NEW.store_id AND receipt.settlement_id = NEW.id
        AND receipt.after_sale_id = NEW.after_sale_id
        AND receipt.order_id = NEW.order_id AND receipt.amount_vnd = NEW.amount_vnd
      ;
      IF OLD.status NOT IN ('PENDING','REVIEW_REQUIRED')
         OR OLD.confirmed_by IS NOT NULL
         OR OLD.transfer_reference_digest IS NOT NULL
         OR OLD.transfer_evidence_ciphertext IS NOT NULL
         OR NEW.confirmed_by IS NULL
         OR NEW.confirmed_by IS DISTINCT FROM app_security.current_actor_id()
         OR NEW.confirmed_by IS NOT DISTINCT FROM NEW.requested_by
         OR NEW.confirmed_at IS NULL OR NEW.completed_at IS NULL
         OR NOT FOUND
         OR receipt_record.recorded_by IS DISTINCT FROM NEW.requested_by
         OR NEW.transfer_reference_digest IS DISTINCT FROM receipt_record.transfer_reference_digest
         OR NEW.transfer_evidence_ciphertext IS DISTINCT FROM receipt_record.evidence_ciphertext
      THEN
        RAISE EXCEPTION 'COD settlement success requires a distinct confirmer and exact receipt'
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.confirmed_by IS NOT NULL OR NEW.confirmed_at IS NOT NULL
       OR NEW.completed_at IS NOT NULL OR NEW.transfer_reference_digest IS NOT NULL
       OR NEW.transfer_evidence_ciphertext IS NOT NULL
    THEN
      RAISE EXCEPTION 'non-successful COD settlement cannot claim confirmation completion'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.status <> 'REVIEW_REQUIRED' OR NEW.confirmed_by IS NOT NULL
       OR NEW.confirmed_at IS NOT NULL OR NEW.completed_at IS NOT NULL
       OR NEW.transfer_reference_digest IS NOT NULL
       OR NEW.transfer_evidence_ciphertext IS NOT NULL
    THEN
      RAISE EXCEPTION 'NO_PAYOUT settlement has no authoritative success path'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION "app_security"."validate_p0_m6_007_confirmation"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE settlement_record record;
DECLARE receipt_record record;
DECLARE sale_record record;
BEGIN
  PERFORM app_security.assert_p0_m6_007_admin_authorization(
    'store.after-sales.cod-refunds.confirm'
  );
  IF NEW.store_id IS DISTINCT FROM app_security.current_store_id()
     OR NEW.confirmed_by IS DISTINCT FROM app_security.current_actor_id()
     OR NEW.correlation_id IS DISTINCT FROM
       NULLIF(pg_catalog.current_setting('app.correlation_id', true), '')
  THEN
    RAISE EXCEPTION 'COD refund confirmation is outside the current actor scope'
      USING ERRCODE = '42501';
  END IF;

  SELECT settlement.* INTO settlement_record
  FROM public.after_sale_settlements settlement
  WHERE settlement.store_id = NEW.store_id AND settlement.id = NEW.settlement_id
    AND settlement.after_sale_id = NEW.after_sale_id
    AND settlement.order_id = NEW.order_id AND settlement.amount_vnd = NEW.amount_vnd
  FOR SHARE;
  SELECT receipt.* INTO receipt_record
  FROM public.after_sale_cod_refund_receipts receipt
  WHERE receipt.store_id = NEW.store_id AND receipt.settlement_id = NEW.settlement_id
    AND receipt.after_sale_id = NEW.after_sale_id
    AND receipt.order_id = NEW.order_id AND receipt.amount_vnd = NEW.amount_vnd
  FOR SHARE;
  SELECT sale.status, sale.version INTO sale_record
  FROM public.after_sales sale
  WHERE sale.store_id = NEW.store_id AND sale.id = NEW.after_sale_id
    AND sale.order_id = NEW.order_id
  FOR SHARE;

  IF settlement_record.id IS NULL OR receipt_record.id IS NULL OR sale_record.status IS NULL
     OR settlement_record.method <> 'COD_OFFLINE'
     OR settlement_record.status <> 'SUCCEEDED'
     OR settlement_record.version <> NEW.result_settlement_version
     OR settlement_record.version <> NEW.expected_settlement_version + 1
     OR settlement_record.confirmed_by IS DISTINCT FROM NEW.confirmed_by
     OR settlement_record.confirmed_by IS NOT DISTINCT FROM settlement_record.requested_by
     OR settlement_record.confirmed_at IS DISTINCT FROM NEW.confirmed_at
     OR settlement_record.completed_at IS DISTINCT FROM NEW.confirmed_at
     OR settlement_record.transfer_reference_digest IS DISTINCT FROM receipt_record.transfer_reference_digest
     OR settlement_record.transfer_evidence_ciphertext IS DISTINCT FROM receipt_record.evidence_ciphertext
     OR receipt_record.recorded_by IS DISTINCT FROM settlement_record.requested_by
     OR sale_record.status <> 'REFUNDED'
     OR sale_record.version <> NEW.result_after_sale_version
     OR sale_record.version <> NEW.expected_after_sale_version + 2
  THEN
    RAISE EXCEPTION 'COD refund confirmation does not match settlement, receipt and case facts'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "after_sale_cod_refund_confirmations_insert_guard"
  BEFORE INSERT ON "after_sale_cod_refund_confirmations"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_p0_m6_007_confirmation"();
CREATE TRIGGER "after_sale_cod_refund_confirmations_append_only"
  BEFORE UPDATE OR DELETE ON "after_sale_cod_refund_confirmations"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_m62_append_only_mutation"();

CREATE OR REPLACE FUNCTION "app_security"."validate_p0_m6_007_confirmation_atomicity"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE audit_count bigint;
DECLARE transition_count bigint;
BEGIN
  SELECT pg_catalog.count(*) INTO transition_count
  FROM public.after_sale_transitions transition
  WHERE transition.store_id = NEW.store_id
    AND transition.after_sale_id = NEW.after_sale_id
    AND transition.actor_type = 'ADMIN'
    AND transition.actor_id = NEW.confirmed_by
    AND transition.correlation_id = NEW.correlation_id
    AND transition.operation_id IS NULL
    AND (
      (transition.event = 'REFUND_REQUESTED'
        AND transition.from_status = 'REFUND_PENDING'
        AND transition.to_status = 'REFUND_PROCESSING'
        AND transition.created_at = NEW.confirmed_at)
      OR (transition.event = 'REFUND_SUCCEEDED'
        AND transition.from_status = 'REFUND_PROCESSING'
        AND transition.to_status = 'REFUNDED'
        AND transition.created_at = NEW.confirmed_at + INTERVAL '1 millisecond')
    );
  SELECT pg_catalog.count(*) INTO audit_count
  FROM public.audit_logs audit
  WHERE audit.store_id = NEW.store_id
    AND audit.actor_type = 'ADMIN'
    AND audit.actor_id = NEW.confirmed_by
    AND audit.target_type = 'after_sale'
    AND audit.target_id = NEW.after_sale_id::text
    AND audit.action = 'after-sale.cod-refund.confirmed'
    AND audit.correlation_id = NEW.correlation_id
    AND audit.after_data->>'confirmation_identity_digest' = pg_catalog.encode(
      public.digest(pg_catalog.convert_to(NEW.id::text, 'UTF8'), 'sha256'), 'hex'
    )
    AND audit.after_data->>'settlement_id' = NEW.settlement_id::text;
  IF transition_count <> 2 OR audit_count <> 1 THEN
    RAISE EXCEPTION 'COD refund confirmation, transitions and audit must commit atomically'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "after_sale_cod_refund_confirmations_atomic_guard"
  AFTER INSERT ON "after_sale_cod_refund_confirmations"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_p0_m6_007_confirmation_atomicity"();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'after_sale_cod_refund_receipts', 'after_sale_cod_refund_confirmations'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (store_id = app_security.current_store_id() AND (current_setting(''app.actor_type'', true) = ''admin'' OR EXISTS (SELECT 1 FROM after_sales owned_case WHERE owned_case.store_id = %I.store_id AND owned_case.id = %I.after_sale_id AND owned_case.member_id = app_security.current_actor_id()))) WITH CHECK (store_id = app_security.current_store_id() AND current_setting(''app.actor_type'', true) = ''admin'')',
      table_name || '_actor_scope', table_name, table_name, table_name
    );
  END LOOP;
END
$$;

GRANT SELECT, INSERT ON TABLE
  "after_sale_cod_refund_receipts", "after_sale_cod_refund_confirmations"
TO zalo_shop_runtime;
REVOKE UPDATE, DELETE ON TABLE
  "after_sale_cod_refund_receipts", "after_sale_cod_refund_confirmations"
FROM zalo_shop_runtime;

REVOKE ALL ON FUNCTION
  "app_security"."validate_p0_m6_007_receipt"(),
  "app_security"."validate_p0_m6_007_receipt_atomicity"(),
  "app_security"."validate_p0_m6_007_confirmation"(),
  "app_security"."validate_p0_m6_007_confirmation_atomicity"()
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  "app_security"."validate_p0_m6_007_receipt"(),
  "app_security"."validate_p0_m6_007_receipt_atomicity"(),
  "app_security"."validate_p0_m6_007_confirmation"(),
  "app_security"."validate_p0_m6_007_confirmation_atomicity"()
TO zalo_shop_runtime;
