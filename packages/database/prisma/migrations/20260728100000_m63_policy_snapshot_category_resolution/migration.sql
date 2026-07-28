-- M6.3-A: keep the database snapshot guard aligned with checkout policy
-- resolution: product override, nearest main-category ancestor, then store default.

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

  WITH RECURSIVE item AS (
    SELECT product_id, category_id
    FROM public.order_items
    WHERE store_id = NEW.store_id AND order_id = NEW.order_id AND id = NEW.order_item_id
  ), category_path AS (
    SELECT category.id, category.parent_id, 0 AS depth, ARRAY[category.id] AS visited
    FROM public.categories category
    JOIN item ON item.category_id = category.id
    WHERE category.store_id = NEW.store_id
    UNION ALL
    SELECT parent.id, parent.parent_id, child.depth + 1, child.visited || parent.id
    FROM category_path child
    JOIN public.categories parent
      ON parent.store_id = NEW.store_id AND parent.id = child.parent_id
    WHERE child.depth < 127 AND NOT parent.id = ANY(child.visited)
  ), candidates AS (
    SELECT assignment.policy_id, assignment.policy_version_id, 1 AS priority, 0 AS depth
    FROM public.after_sale_active_policy_assignments assignment
    JOIN item ON item.product_id = assignment.product_id
    WHERE assignment.store_id = NEW.store_id AND assignment.target_type = 'PRODUCT'
    UNION ALL
    SELECT assignment.policy_id, assignment.policy_version_id, 2 AS priority, path.depth
    FROM public.after_sale_active_policy_assignments assignment
    JOIN category_path path ON path.id = assignment.category_id
    WHERE assignment.store_id = NEW.store_id AND assignment.target_type = 'CATEGORY'
    UNION ALL
    SELECT assignment.policy_id, assignment.policy_version_id, 3 AS priority, 0 AS depth
    FROM public.after_sale_active_policy_assignments assignment
    WHERE assignment.store_id = NEW.store_id AND assignment.target_type = 'STORE_DEFAULT'
  )
  SELECT candidate.policy_id, candidate.policy_version_id
  INTO resolved_policy_id, resolved_version_id
  FROM candidates candidate
  ORDER BY candidate.priority, candidate.depth
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
