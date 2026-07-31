CREATE OR REPLACE FUNCTION "app_security"."validate_m63_b4_command_atomicity"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE current_status public.after_sale_operation_status;
DECLARE operation_name text;
DECLARE operation_id uuid;
DECLARE after_sale_id uuid;
DECLARE linked_count bigint;
DECLARE audit_count bigint;
BEGIN
  IF TG_TABLE_NAME = 'after_sale_operations' THEN
    IF NEW.operation NOT IN ('ADMIN_REVIEW','ADMIN_RESOLVE_REVIEW') THEN RETURN NULL; END IF;
    operation_name := NEW.operation;
    operation_id := NEW.id;
    after_sale_id := NEW.after_sale_id;
  ELSE
    IF NEW.event NOT IN (
      'APPROVE','REJECT','RESUME_REVIEW','REJECT_REVIEW','LEGACY_APPROVE','LEGACY_REJECT'
    ) OR NEW.operation_id IS NULL THEN RETURN NULL; END IF;
    SELECT operation_row.operation INTO operation_name
    FROM public.after_sale_operations operation_row
    WHERE operation_row.store_id = NEW.store_id AND operation_row.id = NEW.operation_id;
    IF operation_name NOT IN ('ADMIN_REVIEW','ADMIN_RESOLVE_REVIEW') THEN RETURN NULL; END IF;
    operation_id := NEW.operation_id;
    after_sale_id := NEW.after_sale_id;
  END IF;
  SELECT operation_row.status INTO current_status
  FROM public.after_sale_operations operation_row
  WHERE operation_row.store_id = NEW.store_id
    AND operation_row.id = operation_id
    AND operation_row.after_sale_id = after_sale_id;
  SELECT pg_catalog.count(*) INTO linked_count
  FROM public.after_sale_transitions transition
  WHERE transition.store_id = NEW.store_id
    AND transition.after_sale_id = after_sale_id
    AND transition.operation_id = operation_id;
  SELECT pg_catalog.count(*) INTO audit_count
  FROM public.audit_logs audit
  WHERE audit.store_id = NEW.store_id
    AND audit.target_type = 'after_sale'
    AND audit.target_id = after_sale_id::text
    AND audit.after_data->>'operation_id' = operation_id::text
    AND audit.action LIKE 'after-sale.review.%';
  IF current_status IS DISTINCT FROM 'COMPLETED' OR linked_count <> 1 OR audit_count <> 1 THEN
    RAISE EXCEPTION 'B4 operation, transition and audit must commit atomically'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
