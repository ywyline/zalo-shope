DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.after_sale_operations
    WHERE operation IN ('ADMIN_REVIEW','ADMIN_RESOLVE_REVIEW')
  ) OR EXISTS (
    SELECT 1 FROM public.audit_logs
    WHERE action IN (
      'after-sale.review.approved','after-sale.review.rejected',
      'after-sale.review.resolved','after-sale.return.expired'
    )
  ) THEN
    RAISE EXCEPTION 'M6.3-B4 rollback requires empty review and expiration facts'
      USING ERRCODE = '55000';
  END IF;
END
$$;

DROP TRIGGER "after_sale_transitions_b4_atomic_guard" ON "after_sale_transitions";
DROP TRIGGER "after_sale_operations_b4_atomic_guard" ON "after_sale_operations";
DROP TRIGGER "after_sale_operations_b4_completion_guard" ON "after_sale_operations";
DROP FUNCTION "app_security"."expire_m63_b4_due_after_sales"(integer);
DROP FUNCTION "app_security"."resolve_m63_b4_after_sale_review"(
  uuid,uuid,text,text,integer,text,text,text,text,integer,text,inet
);
DROP FUNCTION "app_security"."review_m63_b4_after_sale"(
  uuid,uuid,text,text,integer,text,jsonb,text,inet
);
DROP FUNCTION "app_security"."validate_m63_b4_command_atomicity"();
DROP FUNCTION "app_security"."validate_m63_b4_operation_completion"();
DROP INDEX "after_sales_return_expiration_idx";

CREATE OR REPLACE FUNCTION "app_security"."validate_m63_b3_operation_link"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE operation_record record;
BEGIN
  IF NEW.event <> 'SUBMIT'
     AND NOT (NEW.event = 'CANCEL' AND NEW.actor_type = 'MEMBER')
  THEN
    IF NEW.operation_id IS NOT NULL THEN
      RAISE EXCEPTION 'operation links are reserved for approved command events'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.operation_id IS NULL THEN
    RAISE EXCEPTION 'B3 command transition requires an operation link'
      USING ERRCODE = '42501';
  END IF;
  SELECT operation, status INTO operation_record
  FROM public.after_sale_operations operation_row
  WHERE operation_row.store_id = NEW.store_id
    AND operation_row.id = NEW.operation_id
    AND operation_row.after_sale_id = NEW.after_sale_id
  FOR UPDATE;
  IF NOT FOUND OR operation_record.status <> 'PENDING'
     OR (NEW.event = 'SUBMIT'
       AND operation_record.operation NOT IN ('MEMBER_CREATE','MERCHANT_REFUND_CREATE'))
     OR (NEW.event = 'CANCEL' AND operation_record.operation <> 'MEMBER_CANCEL')
  THEN
    RAISE EXCEPTION 'transition operation link is outside the B3 command contract'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
