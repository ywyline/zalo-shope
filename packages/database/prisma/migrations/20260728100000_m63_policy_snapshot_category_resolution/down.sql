-- Local/test-only rollback. Existing category policy projections or immutable
-- snapshots may rely on ancestor resolution and must not be silently weakened.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "order_item_after_sale_policy_snapshots" LIMIT 1)
     OR EXISTS (
       SELECT 1 FROM "after_sale_active_policy_assignments"
       WHERE "target_type" = 'CATEGORY'
       LIMIT 1
     )
  THEN
    RAISE EXCEPTION 'M6.3 policy snapshot category-resolution rollback requires no dependent facts'
      USING ERRCODE = '55000';
  END IF;
END
$$;
CREATE OR REPLACE FUNCTION "app_security"."validate_m62_policy_snapshot"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE version_record record;
DECLARE policy_code text;
DECLARE resolved_policy_id uuid;
DECLARE resolved_version_id uuid;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('m62-policy:' || NEW.store_id::text, 0)
  );
  SELECT version_number, payload, payload_hash
  INTO version_record
  FROM public.after_sale_policy_versions
  WHERE store_id = NEW.store_id AND id = NEW.policy_version_id AND policy_id = NEW.policy_id;
  SELECT code INTO policy_code
  FROM public.after_sale_policies
  WHERE store_id = NEW.store_id AND id = NEW.policy_id;
  SELECT candidate.policy_id, candidate.policy_version_id
  INTO resolved_policy_id, resolved_version_id
  FROM (
    SELECT assignment.policy_id, assignment.policy_version_id, 1 AS priority
    FROM public.after_sale_active_policy_assignments assignment
    JOIN public.order_items item
      ON item.store_id = NEW.store_id AND item.order_id = NEW.order_id
     AND item.id = NEW.order_item_id
    WHERE assignment.store_id = NEW.store_id
      AND assignment.target_type = 'PRODUCT'
      AND assignment.product_id = item.product_id
    UNION ALL
    SELECT assignment.policy_id, assignment.policy_version_id, 2 AS priority
    FROM public.after_sale_active_policy_assignments assignment
    JOIN public.order_items item
      ON item.store_id = NEW.store_id AND item.order_id = NEW.order_id
     AND item.id = NEW.order_item_id
    WHERE assignment.store_id = NEW.store_id
      AND assignment.target_type = 'CATEGORY'
      AND assignment.category_id = item.category_id
    UNION ALL
    SELECT assignment.policy_id, assignment.policy_version_id, 3 AS priority
    FROM public.after_sale_active_policy_assignments assignment
    WHERE assignment.store_id = NEW.store_id
      AND assignment.target_type = 'STORE_DEFAULT'
  ) candidate
  ORDER BY candidate.priority
  LIMIT 1;
  IF version_record IS NULL OR policy_code IS NULL
     OR resolved_policy_id IS DISTINCT FROM NEW.policy_id
     OR resolved_version_id IS DISTINCT FROM NEW.policy_version_id
     OR version_record.version_number <> NEW.policy_version_number
     OR policy_code <> NEW.policy_code
     OR version_record.payload_hash <> NEW.payload_hash
     OR version_record.payload <> NEW.payload
  THEN
    RAISE EXCEPTION 'order-item after-sale snapshot must exactly match its immutable policy version'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
