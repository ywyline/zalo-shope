DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.after_sale_operations operation_row
    WHERE operation_row.operation IN ('MEMBER_SUBMIT_RETURN','ADMIN_RECORD_RETURN_FACT')
  ) OR EXISTS (
    SELECT 1 FROM public.audit_logs audit
    WHERE audit.action IN ('after-sale.return.submitted','after-sale.return.fact-recorded')
  ) THEN
    RAISE EXCEPTION 'cannot roll back M6.3-B5 after return command facts exist'
      USING ERRCODE = '55000';
  END IF;
END
$$;

GRANT INSERT ON "after_sale_return_shipments" TO zalo_shop_runtime;
GRANT UPDATE ("status","received_at","version","updated_at")
  ON "after_sale_return_shipments" TO zalo_shop_runtime;

DROP TRIGGER "after_sale_transitions_b5_atomic_guard" ON "after_sale_transitions";
DROP TRIGGER "after_sale_operations_b5_atomic_guard" ON "after_sale_operations";
DROP TRIGGER "after_sale_operations_b5_completion_guard" ON "after_sale_operations";
DROP TRIGGER "after_sale_transitions_b5_return_state_guard" ON "after_sale_transitions";
DROP TRIGGER "after_sale_transitions_state_guard" ON "after_sale_transitions";
CREATE TRIGGER "after_sale_transitions_state_guard"
  BEFORE INSERT ON "after_sale_transitions"
  FOR EACH ROW
  WHEN (NEW.actor_type = 'ADMIN' AND NEW.event <> 'SUBMIT')
  EXECUTE FUNCTION "app_security"."validate_m62_after_sale_transition"();

DROP FUNCTION "app_security"."record_m63_b5_return_fact"(
  uuid,uuid,text,text,integer,integer,text,text,inet
);
DROP FUNCTION "app_security"."submit_m63_b5_member_return"(
  uuid,uuid,text,text,integer,text,text,text,inet
);
DROP FUNCTION "app_security"."validate_m63_b5_command_atomicity"();
DROP FUNCTION "app_security"."validate_m63_b5_operation_completion"();
DROP FUNCTION "app_security"."validate_m63_b5_admin_return_transition"();

CREATE OR REPLACE FUNCTION "app_security"."validate_m63_b3_operation_link"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE operation_record record;
DECLARE expected_operation text;
BEGIN
  expected_operation := CASE
    WHEN NEW.event = 'SUBMIT' AND NEW.actor_type = 'MEMBER' THEN 'MEMBER_CREATE'
    WHEN NEW.event = 'SUBMIT' AND NEW.actor_type = 'ADMIN' THEN 'MERCHANT_REFUND_CREATE'
    WHEN NEW.event = 'CANCEL' AND NEW.actor_type = 'MEMBER' THEN 'MEMBER_CANCEL'
    WHEN NEW.event IN ('APPROVE','REJECT') AND NEW.actor_type = 'ADMIN' THEN 'ADMIN_REVIEW'
    WHEN NEW.event IN ('RESUME_REVIEW','REJECT_REVIEW','LEGACY_APPROVE','LEGACY_REJECT')
      AND NEW.actor_type = 'ADMIN' THEN 'ADMIN_RESOLVE_REVIEW'
    ELSE NULL
  END;
  IF expected_operation IS NULL THEN
    IF NEW.operation_id IS NOT NULL THEN
      RAISE EXCEPTION 'operation links are reserved for approved command events'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.operation_id IS NULL THEN
    RAISE EXCEPTION 'after-sale command transition requires an operation link'
      USING ERRCODE = '42501';
  END IF;
  SELECT operation, status INTO operation_record
  FROM public.after_sale_operations operation_row
  WHERE operation_row.store_id = NEW.store_id
    AND operation_row.id = NEW.operation_id
    AND operation_row.after_sale_id = NEW.after_sale_id
  FOR UPDATE;
  IF NOT FOUND OR operation_record.status <> 'PENDING'
     OR operation_record.operation IS DISTINCT FROM expected_operation
  THEN
    RAISE EXCEPTION 'transition operation link is outside the approved command contract'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
