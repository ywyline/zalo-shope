DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.after_sale_inspections)
     OR EXISTS (SELECT 1 FROM public.after_sale_inventory_actions)
     OR EXISTS (
       SELECT 1 FROM public.after_sale_transitions
       WHERE event IN ('ACCEPT_INSPECTION','REJECT_INSPECTION')
     )
     OR EXISTS (
       SELECT 1 FROM public.after_sale_operations
       WHERE operation = 'ADMIN_INSPECT_RETURN'
     )
     OR EXISTS (
       SELECT 1 FROM public.audit_logs
       WHERE action = 'after-sale.return.inspected'
     )
  THEN
    RAISE EXCEPTION 'P0-M6-008 facts exist; return inspection rollback is forbidden'
      USING ERRCODE = '55000';
  END IF;
END
$$;

DROP TRIGGER "after_sale_transitions_p0_m6_008_atomic_guard" ON "after_sale_transitions";
DROP TRIGGER "after_sale_operations_p0_m6_008_atomic_guard" ON "after_sale_operations";
DROP TRIGGER "after_sale_operations_p0_m6_008_completion_guard" ON "after_sale_operations";
DROP FUNCTION "app_security"."inspect_p0_m6_008_after_sale_return"(
  uuid,uuid,text,text,integer,integer,jsonb,text,inet
);
DROP FUNCTION "app_security"."validate_p0_m6_008_command_atomicity"();
DROP FUNCTION "app_security"."validate_p0_m6_008_operation_completion"();
DROP FUNCTION "app_security"."assert_p0_m6_008_admin_authorization"(boolean);

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
    WHEN NEW.event = 'START_RETURN' AND NEW.actor_type = 'MEMBER' THEN 'MEMBER_SUBMIT_RETURN'
    WHEN NEW.event IN ('RETURN_SHIPPED','RETURN_RECEIVED') AND NEW.actor_type = 'ADMIN'
      THEN 'ADMIN_RECORD_RETURN_FACT'
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
