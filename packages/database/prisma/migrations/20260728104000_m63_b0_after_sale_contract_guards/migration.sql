-- M6.3-B0 forward-only contract repair. This migration does not open any
-- after-sale runtime route; it narrows the database boundary required by the
-- approved B0 decisions.

-- A non-legacy case must name the exact immutable policy/version shared by
-- every selected order line. The columns stay nullable only for explicit
-- legacy review.
ALTER TABLE "after_sales"
  ADD COLUMN "policy_id" UUID,
  ADD COLUMN "policy_version_id" UUID;

-- Preserve already-created, unambiguous M6.2 facts. Any non-legacy case that
-- cannot be proven from every line snapshot fails the migration closed below.
WITH candidate_policy AS (
  SELECT sale.store_id,
    sale.id AS after_sale_id,
    (pg_catalog.array_agg(snapshot.policy_id))[1] AS policy_id,
    (pg_catalog.array_agg(snapshot.policy_version_id))[1] AS policy_version_id,
    pg_catalog.count(*) AS item_count,
    pg_catalog.count(snapshot.order_item_id) AS snapshot_count,
    pg_catalog.count(DISTINCT (snapshot.policy_id, snapshot.policy_version_id)) AS identity_count,
    pg_catalog.bool_and(
      snapshot.payload_hash = sale.policy_hash
      AND snapshot.payload = sale.policy_snapshot
    ) AS header_matches
  FROM public.after_sales sale
  JOIN public.after_sale_items item
    ON item.store_id = sale.store_id AND item.after_sale_id = sale.id
  LEFT JOIN public.order_item_after_sale_policy_snapshots snapshot
    ON snapshot.store_id = item.store_id
   AND snapshot.order_id = item.order_id
   AND snapshot.order_item_id = item.order_item_id
  WHERE NOT sale.legacy_policy_review
  GROUP BY sale.store_id, sale.id
)
UPDATE public.after_sales sale
SET policy_id = candidate.policy_id,
    policy_version_id = candidate.policy_version_id
FROM candidate_policy candidate
WHERE sale.store_id = candidate.store_id
  AND sale.id = candidate.after_sale_id
  AND candidate.item_count > 0
  AND candidate.snapshot_count = candidate.item_count
  AND candidate.identity_count = 1
  AND candidate.header_matches;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.after_sales sale
    LEFT JOIN public.after_sale_policy_versions version
      ON version.store_id = sale.store_id
     AND version.id = sale.policy_version_id
     AND version.policy_id = sale.policy_id
    WHERE (sale.legacy_policy_review AND (
        sale.policy_id IS NOT NULL
        OR sale.policy_version_id IS NOT NULL
        OR sale.policy_snapshot IS NOT NULL
        OR sale.policy_hash IS NOT NULL
      ))
      OR (NOT sale.legacy_policy_review AND (
        sale.policy_id IS NULL
        OR sale.policy_version_id IS NULL
        OR sale.policy_snapshot IS NULL
        OR sale.policy_hash IS NULL
        OR version.id IS NULL
        OR version.payload IS DISTINCT FROM sale.policy_snapshot
        OR version.payload_hash IS DISTINCT FROM sale.policy_hash
      ))
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'M6.3-B0 cannot prove an existing non-legacy after-sale policy identity'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.after_sales sale
    JOIN public.after_sale_items item
      ON item.store_id = sale.store_id AND item.after_sale_id = sale.id
    LEFT JOIN public.order_item_after_sale_policy_snapshots snapshot
      ON snapshot.store_id = item.store_id
     AND snapshot.order_id = item.order_id
     AND snapshot.order_item_id = item.order_item_id
    WHERE sale.legacy_policy_review
    GROUP BY sale.store_id, sale.id
    HAVING NOT (
      pg_catalog.count(snapshot.order_item_id) = 0
      OR (
        pg_catalog.count(snapshot.order_item_id) = pg_catalog.count(*)
        AND pg_catalog.count(DISTINCT (
          snapshot.policy_id,
          snapshot.policy_version_id,
          snapshot.payload,
          snapshot.payload_hash
        )) = 1
      )
    )
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'M6.3-B0 cannot preserve a legacy case with mixed policy facts'
      USING ERRCODE = '55000';
  END IF;
END
$$;

ALTER TABLE "after_sales"
  ADD CONSTRAINT "after_sales_policy_fkey"
    FOREIGN KEY ("store_id", "policy_id")
    REFERENCES "after_sale_policies"("store_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sales_policy_version_fkey"
    FOREIGN KEY ("store_id", "policy_version_id", "policy_id")
    REFERENCES "after_sale_policy_versions"("store_id", "id", "policy_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sales_policy_identity_check" CHECK (
    ("legacy_policy_review"
      AND "policy_id" IS NULL
      AND "policy_version_id" IS NULL
      AND "policy_snapshot" IS NULL
      AND "policy_hash" IS NULL)
    OR
    (NOT "legacy_policy_review"
      AND "policy_id" IS NOT NULL
      AND "policy_version_id" IS NOT NULL
      AND "policy_snapshot" IS NOT NULL
      AND "policy_hash" ~ '^[0-9a-f]{64}$')
  );

CREATE INDEX "after_sales_policy_identity_idx"
  ON "after_sales"("store_id", "policy_id", "policy_version_id");

CREATE OR REPLACE FUNCTION "app_security"."validate_m63_b0_after_sale_policy_identity"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE actor_context text;
BEGIN
  actor_context := NULLIF(pg_catalog.current_setting('app.actor_type', true), '');
  IF NEW.store_id IS DISTINCT FROM app_security.current_store_id()
     OR actor_context IS NULL
     OR actor_context NOT IN ('admin','member')
     OR (actor_context = 'admin' AND NOT EXISTS (
       SELECT 1 FROM public.admin_users admin
       WHERE admin.id = app_security.current_actor_id()
     ))
     OR (TG_OP = 'INSERT' AND actor_context = 'admin' AND (
       NEW.source <> 'ADMIN'
       OR NEW.initiated_by IS DISTINCT FROM app_security.current_actor_id()
     ))
     OR (TG_OP = 'INSERT' AND actor_context = 'member' AND (
       NEW.source <> 'MEMBER'
       OR NEW.member_id IS DISTINCT FROM app_security.current_actor_id()
       OR NEW.initiated_by IS DISTINCT FROM app_security.current_actor_id()
     ))
     OR (TG_OP = 'UPDATE' AND actor_context <> 'admin')
  THEN
    RAISE EXCEPTION 'after-sale policy identity is outside the current actor scope'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'UPDATE'
     AND EXISTS (
       SELECT 1 FROM public.after_sale_items item
       WHERE item.store_id = OLD.store_id AND item.after_sale_id = OLD.id
     )
     AND (
       NEW.legacy_policy_review IS DISTINCT FROM OLD.legacy_policy_review
       OR NEW.policy_id IS DISTINCT FROM OLD.policy_id
       OR NEW.policy_version_id IS DISTINCT FROM OLD.policy_version_id
       OR NEW.policy_snapshot IS DISTINCT FROM OLD.policy_snapshot
       OR NEW.policy_hash IS DISTINCT FROM OLD.policy_hash
     )
  THEN
    RAISE EXCEPTION 'after-sale policy identity is immutable after its first line'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.legacy_policy_review THEN
    IF NEW.policy_id IS NOT NULL
       OR NEW.policy_version_id IS NOT NULL
       OR NEW.policy_snapshot IS NOT NULL
       OR NEW.policy_hash IS NOT NULL
    THEN
      RAISE EXCEPTION 'legacy after-sale policy identity must be empty'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.policy_id IS NULL
     OR NEW.policy_version_id IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM public.after_sale_policy_versions version
       WHERE version.store_id = NEW.store_id
         AND version.id = NEW.policy_version_id
         AND version.policy_id = NEW.policy_id
         AND version.payload = NEW.policy_snapshot
         AND version.payload_hash = NEW.policy_hash
     )
  THEN
    RAISE EXCEPTION 'after-sale policy identity must match one immutable policy version'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.after_sale_items item
    LEFT JOIN public.order_item_after_sale_policy_snapshots snapshot
      ON snapshot.store_id = item.store_id
     AND snapshot.order_id = item.order_id
     AND snapshot.order_item_id = item.order_item_id
    WHERE item.store_id = NEW.store_id
      AND item.after_sale_id = NEW.id
      AND (
        snapshot.order_item_id IS NULL
        OR snapshot.policy_id IS DISTINCT FROM NEW.policy_id
        OR snapshot.policy_version_id IS DISTINCT FROM NEW.policy_version_id
        OR snapshot.payload IS DISTINCT FROM NEW.policy_snapshot
        OR snapshot.payload_hash IS DISTINCT FROM NEW.policy_hash
      )
  ) THEN
    RAISE EXCEPTION 'all existing after-sale lines must match the immutable case policy'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "after_sales_policy_identity_guard"
  BEFORE INSERT OR UPDATE OF "legacy_policy_review", "policy_id", "policy_version_id",
    "policy_snapshot", "policy_hash"
  ON "after_sales"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m63_b0_after_sale_policy_identity"();

CREATE OR REPLACE FUNCTION "app_security"."validate_m63_b0_after_sale_item_policy"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE sale_record record;
DECLARE actor_context text;
BEGIN
  actor_context := NULLIF(pg_catalog.current_setting('app.actor_type', true), '');
  IF NEW.store_id IS DISTINCT FROM app_security.current_store_id()
     OR actor_context IS NULL
     OR actor_context NOT IN ('admin','member')
     OR (actor_context = 'admin' AND NOT EXISTS (
       SELECT 1 FROM public.admin_users admin
       WHERE admin.id = app_security.current_actor_id()
     ))
  THEN
    RAISE EXCEPTION 'after-sale item policy is outside the current actor scope'
      USING ERRCODE = '42501';
  END IF;

  SELECT sale.legacy_policy_review, sale.policy_id, sale.policy_version_id,
    sale.policy_snapshot, sale.policy_hash
  INTO sale_record
  FROM public.after_sales sale
  WHERE sale.store_id = NEW.store_id
    AND sale.id = NEW.after_sale_id
    AND sale.order_id = NEW.order_id
    AND (actor_context = 'admin' OR sale.member_id = app_security.current_actor_id())
  FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'after-sale item policy is outside the current actor scope'
      USING ERRCODE = '42501';
  END IF;
  IF sale_record.legacy_policy_review THEN
    IF EXISTS (
      WITH selected_policy AS (
        SELECT snapshot.order_item_id, snapshot.policy_id, snapshot.policy_version_id,
          snapshot.payload, snapshot.payload_hash
        FROM public.after_sale_items item
        LEFT JOIN public.order_item_after_sale_policy_snapshots snapshot
          ON snapshot.store_id = item.store_id
         AND snapshot.order_id = item.order_id
         AND snapshot.order_item_id = item.order_item_id
        WHERE item.store_id = NEW.store_id AND item.after_sale_id = NEW.after_sale_id
        UNION ALL
        SELECT snapshot.order_item_id, snapshot.policy_id, snapshot.policy_version_id,
          snapshot.payload, snapshot.payload_hash
        FROM (SELECT 1) input
        LEFT JOIN public.order_item_after_sale_policy_snapshots snapshot
          ON snapshot.store_id = NEW.store_id
         AND snapshot.order_id = NEW.order_id
         AND snapshot.order_item_id = NEW.order_item_id
      ), summary AS (
        SELECT pg_catalog.count(*) AS item_count,
          pg_catalog.count(order_item_id) AS snapshot_count,
          pg_catalog.count(DISTINCT (policy_id, policy_version_id, payload, payload_hash))
            AS identity_count
        FROM selected_policy
      )
      SELECT 1 FROM summary
      WHERE NOT (
        snapshot_count = 0
        OR (snapshot_count = item_count AND identity_count = 1)
      )
    ) THEN
      RAISE EXCEPTION 'legacy/manual-review lines cannot mix absent or different policy facts'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.order_item_after_sale_policy_snapshots snapshot
    WHERE snapshot.store_id = NEW.store_id
      AND snapshot.order_id = NEW.order_id
      AND snapshot.order_item_id = NEW.order_item_id
      AND snapshot.policy_id = sale_record.policy_id
      AND snapshot.policy_version_id = sale_record.policy_version_id
      AND snapshot.payload = sale_record.policy_snapshot
      AND snapshot.payload_hash = sale_record.policy_hash
  ) THEN
    RAISE EXCEPTION 'all after-sale lines must share the case policy version and hash'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "after_sale_items_policy_identity_guard"
  BEFORE INSERT OR UPDATE OF "store_id", "after_sale_id", "order_id", "order_item_id"
  ON "after_sale_items"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m63_b0_after_sale_item_policy"();

-- Request allocation uses the remaining order-line entitlement at creation.
-- Review allocation uses the immutable requested quantity/amount so releasing
-- an earlier request cannot retroactively change a later request's VND share.
CREATE OR REPLACE FUNCTION "app_security"."validate_m63_b0_after_sale_line_amount"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE actor_context text;
DECLARE current_status public.after_sale_status;
DECLARE current_legacy_review boolean;
DECLARE current_review_resume_status public.after_sale_status;
DECLARE ordered_quantity integer;
DECLARE order_item_payable bigint;
DECLARE occupied_quantity bigint;
DECLARE occupied_vnd bigint;
DECLARE available_quantity bigint;
DECLARE available_vnd bigint;
DECLARE expected_requested_vnd bigint;
DECLARE expected_approved_vnd bigint;
DECLARE request_allocation_changed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    request_allocation_changed := true;
  ELSE
    request_allocation_changed :=
      NEW.requested_quantity IS DISTINCT FROM OLD.requested_quantity
      OR NEW.requested_item_vnd IS DISTINCT FROM OLD.requested_item_vnd
      OR NEW.order_item_id IS DISTINCT FROM OLD.order_item_id
      OR NEW.order_id IS DISTINCT FROM OLD.order_id
      OR NEW.store_id IS DISTINCT FROM OLD.store_id;
  END IF;
  actor_context := pg_catalog.current_setting('app.actor_type', true);
  IF NEW.store_id IS DISTINCT FROM app_security.current_store_id()
     OR actor_context IS NULL
     OR actor_context NOT IN ('admin','member')
     OR (actor_context = 'admin' AND NOT EXISTS (
       SELECT 1 FROM public.admin_users admin
       WHERE admin.id = app_security.current_actor_id()
     ))
  THEN
    RAISE EXCEPTION 'after-sale line allocation requires the current scoped actor'
      USING ERRCODE = '42501';
  END IF;

  SELECT sale.status, sale.legacy_policy_review, sale.review_resume_status
  INTO current_status, current_legacy_review, current_review_resume_status
  FROM public.after_sales sale
  WHERE sale.store_id = NEW.store_id
    AND sale.id = NEW.after_sale_id
    AND sale.order_id = NEW.order_id
    AND (actor_context = 'admin' OR sale.member_id = app_security.current_actor_id())
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'after-sale line allocation requires the current scoped actor'
      USING ERRCODE = '42501';
  END IF;

  SELECT item.quantity, item.payable_vnd
  INTO ordered_quantity, order_item_payable
  FROM public.order_items item
  WHERE item.store_id = NEW.store_id
    AND item.order_id = NEW.order_id
    AND item.id = NEW.order_item_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'after-sale item order line does not exist' USING ERRCODE = '23503';
  END IF;

  SELECT
    COALESCE(pg_catalog.sum(CASE
      WHEN sale.status = 'PENDING_REVIEW'
        OR (sale.status = 'REVIEW_REQUIRED'
          AND sale.legacy_policy_review
          AND sale.review_resume_status IS NULL)
      THEN item.requested_quantity
      ELSE item.approved_quantity
    END), 0),
    COALESCE(pg_catalog.sum(CASE
      WHEN sale.status = 'PENDING_REVIEW'
        OR (sale.status = 'REVIEW_REQUIRED'
          AND sale.legacy_policy_review
          AND sale.review_resume_status IS NULL)
      THEN item.requested_item_vnd
      ELSE item.approved_item_vnd
    END), 0)
  INTO occupied_quantity, occupied_vnd
  FROM public.after_sale_items item
  JOIN public.after_sales sale
    ON sale.store_id = item.store_id AND sale.id = item.after_sale_id
  WHERE item.store_id = NEW.store_id
    AND item.order_item_id = NEW.order_item_id
    AND item.id <> NEW.id
    AND (
      sale.status NOT IN ('REJECTED','CANCELLED')
      OR EXISTS (SELECT 1 FROM public.after_sale_inspections inspection
        WHERE inspection.store_id = sale.store_id AND inspection.after_sale_id = sale.id)
      OR EXISTS (SELECT 1 FROM public.after_sale_settlements settlement
        WHERE settlement.store_id = sale.store_id AND settlement.after_sale_id = sale.id)
      OR EXISTS (SELECT 1 FROM public.after_sale_inventory_actions action
        WHERE action.store_id = sale.store_id AND action.after_sale_id = sale.id)
      OR EXISTS (SELECT 1 FROM public.exchange_fulfillments exchange
        WHERE exchange.store_id = sale.store_id AND exchange.after_sale_id = sale.id)
    );

  available_quantity := ordered_quantity::bigint - occupied_quantity;
  available_vnd := order_item_payable - occupied_vnd;
  IF available_quantity <= 0
     OR available_vnd < 0
     OR NEW.requested_quantity::bigint > available_quantity
  THEN
    RAISE EXCEPTION 'after-sale quantity or amount exceeds remaining order-item entitlement'
      USING ERRCODE = '23514';
  END IF;

  expected_requested_vnd := CASE
    WHEN NEW.requested_quantity::bigint = available_quantity THEN available_vnd
    ELSE pg_catalog.floor(
      available_vnd::numeric * NEW.requested_quantity::numeric / available_quantity::numeric
    )::bigint
  END;
  expected_approved_vnd := CASE
    WHEN NEW.approved_quantity = 0 THEN 0
    WHEN NEW.approved_quantity = NEW.requested_quantity THEN NEW.requested_item_vnd
    ELSE pg_catalog.floor(
      NEW.requested_item_vnd::numeric * NEW.approved_quantity::numeric
        / NEW.requested_quantity::numeric
    )::bigint
  END;

  IF (request_allocation_changed AND NEW.requested_item_vnd <> expected_requested_vnd)
     OR NEW.approved_quantity > NEW.requested_quantity
     OR NEW.approved_item_vnd <> expected_approved_vnd
  THEN
    RAISE EXCEPTION 'after-sale line VND must use the exact integer remainder allocation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "after_sale_items_b0_line_amount_guard"
  BEFORE INSERT OR UPDATE OF "requested_quantity", "requested_item_vnd",
    "approved_quantity", "approved_item_vnd", "order_item_id", "order_id", "store_id"
  ON "after_sale_items"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m63_b0_after_sale_line_amount"();

CREATE OR REPLACE FUNCTION "app_security"."validate_m63_b0_transition_contract"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE sale_record record;
DECLARE actor_context text;
BEGIN
  actor_context := pg_catalog.current_setting('app.actor_type', true);
  IF NEW.store_id IS DISTINCT FROM app_security.current_store_id()
     OR NEW.actor_id IS DISTINCT FROM app_security.current_actor_id()
     OR actor_context IS NULL
     OR actor_context NOT IN ('admin','member','system')
     OR (actor_context = 'admin' AND (
       NEW.actor_type <> 'ADMIN'
       OR NOT EXISTS (SELECT 1 FROM public.admin_users admin
         WHERE admin.id = app_security.current_actor_id())
     ))
     OR (actor_context = 'member' AND (
       NEW.actor_type <> 'MEMBER'
       OR NEW.event NOT IN ('CANCEL','START_RETURN')
     ))
     OR (actor_context = 'system' AND (
       NEW.actor_type <> 'SYSTEM'
       OR pg_catalog.current_setting('app.system_scope', true)
         IS DISTINCT FROM 'after-sale-transition'
       OR NEW.event NOT IN (
         'RETURN_EXPIRED','REFUND_SUCCEEDED','REFUND_FAILED','REFUND_CANCELLED',
         'REQUIRE_REVIEW','COMPLETE'
       )
     ))
  THEN
    RAISE EXCEPTION 'after-sale transition is outside the current actor scope'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.correlation_id IS DISTINCT FROM
       NULLIF(pg_catalog.current_setting('app.correlation_id', true), '')
  THEN
    RAISE EXCEPTION 'after-sale transition correlation must match the transaction context'
      USING ERRCODE = '42501';
  END IF;
  IF actor_context = 'member' AND NOT EXISTS (
    SELECT 1 FROM public.after_sales sale
    WHERE sale.store_id = NEW.store_id
      AND sale.id = NEW.after_sale_id
      AND sale.member_id = app_security.current_actor_id()
  ) THEN
    RAISE EXCEPTION 'after-sale transition is outside the current actor scope'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.event NOT IN ('APPROVE','LEGACY_APPROVE','START_RETURN') THEN
    RETURN NEW;
  END IF;
  SELECT sale.requested_item_vnd
  INTO sale_record
  FROM public.after_sales sale
  WHERE sale.store_id = NEW.store_id AND sale.id = NEW.after_sale_id
  FOR UPDATE;
  IF NOT FOUND THEN
    -- Preserve the ordinary M6.2 guard's fail-closed actor/store error for an
    -- absent or out-of-scope aggregate. This B0 guard only adds contract facts
    -- after the original authorization boundary can identify the aggregate.
    RETURN NEW;
  END IF;
  IF NEW.event IN ('APPROVE','LEGACY_APPROVE') AND sale_record.requested_item_vnd <> (
    SELECT COALESCE(pg_catalog.sum(item.requested_item_vnd), 0)
    FROM public.after_sale_items item
    WHERE item.store_id = NEW.store_id AND item.after_sale_id = NEW.after_sale_id
  ) THEN
    RAISE EXCEPTION 'after-sale requested item total must equal its exact line allocations'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.event IN ('APPROVE','LEGACY_APPROVE') AND NOT EXISTS (
    SELECT 1 FROM public.after_sale_items item
    WHERE item.store_id = NEW.store_id
      AND item.after_sale_id = NEW.after_sale_id
      AND item.approved_quantity > 0
  ) THEN
    RAISE EXCEPTION 'after-sale approval requires at least one positive item quantity'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.event = 'START_RETURN' AND NOT EXISTS (
    SELECT 1 FROM public.after_sale_return_shipments shipment
    WHERE shipment.store_id = NEW.store_id
      AND shipment.after_sale_id = NEW.after_sale_id
      AND shipment.status IN ('SUBMITTED','IN_TRANSIT','DELIVERED')
  ) THEN
    RAISE EXCEPTION 'a submitted return record is required before return processing starts'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "after_sale_transitions_b0_contract_guard"
  BEFORE INSERT ON "after_sale_transitions"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m63_b0_transition_contract"();

-- Keep ordinary admin validation on the original M6.2 function. MEMBER and
-- SYSTEM rows take disjoint narrow validators. A member may append START_RETURN
-- only after its owned SUBMITTED record exists; that never authorizes an
-- authoritative RETURN_SHIPPED or RETURN_RECEIVED fact.
DROP TRIGGER "after_sale_transitions_state_guard" ON "after_sale_transitions";
CREATE TRIGGER "after_sale_transitions_state_guard"
  BEFORE INSERT ON "after_sale_transitions"
  FOR EACH ROW
  WHEN (NEW.actor_type = 'ADMIN')
  EXECUTE FUNCTION "app_security"."validate_m62_after_sale_transition"();

CREATE OR REPLACE FUNCTION "app_security"."validate_m63_b0_member_transition"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE sale record;
DECLARE graph_match boolean := false;
BEGIN
  IF pg_catalog.current_setting('app.actor_type', true) IS DISTINCT FROM 'member'
     OR NEW.store_id IS DISTINCT FROM app_security.current_store_id()
     OR NEW.actor_type <> 'MEMBER'
     OR NEW.actor_id IS DISTINCT FROM app_security.current_actor_id()
     OR NEW.event NOT IN ('CANCEL','START_RETURN')
  THEN
    RAISE EXCEPTION 'after-sale member transition is outside the owned actor scope'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO sale
  FROM public.after_sales current_sale
  WHERE current_sale.store_id = NEW.store_id
    AND current_sale.id = NEW.after_sale_id
    AND current_sale.member_id = app_security.current_actor_id()
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'after-sale member transition is outside the owned actor scope'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.from_status IS NULL OR NEW.from_status <> sale.status THEN
    RAISE EXCEPTION 'after-sale transition must start from the locked current status'
      USING ERRCODE = '23514';
  END IF;

  graph_match := (
    NEW.event = 'CANCEL'
    AND sale.type IN ('REFUND_ONLY','RETURN_REFUND','EXCHANGE')
    AND NEW.from_status = 'PENDING_REVIEW'
    AND NEW.to_status = 'CANCELLED'
  ) OR (
    NEW.event = 'START_RETURN'
    AND sale.type IN ('RETURN_REFUND','EXCHANGE')
    AND NEW.from_status = 'APPROVED'
    AND NEW.to_status = 'RETURN_PENDING'
    AND sale.return_deadline_at IS NOT NULL
    AND pg_catalog.clock_timestamp() < sale.return_deadline_at
    AND EXISTS (
      SELECT 1 FROM public.after_sale_return_shipments shipment
      WHERE shipment.store_id = sale.store_id
        AND shipment.after_sale_id = sale.id
        AND shipment.status = 'SUBMITTED'
        AND shipment.submitted_by = app_security.current_actor_id()
    )
  );
  IF NOT graph_match THEN
    RAISE EXCEPTION 'invalid member after-sale transition for current type and status'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "after_sale_transitions_member_state_guard"
  BEFORE INSERT ON "after_sale_transitions"
  FOR EACH ROW
  WHEN (NEW.actor_type = 'MEMBER')
  EXECUTE FUNCTION "app_security"."validate_m63_b0_member_transition"();

CREATE POLICY "after_sale_transitions_member_start_return_insert"
  ON "after_sale_transitions"
  FOR INSERT WITH CHECK (
    "store_id" = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'member'
    AND "from_status" = 'APPROVED'
    AND "to_status" = 'RETURN_PENDING'
    AND "event" = 'START_RETURN'
    AND "actor_type" = 'MEMBER'
    AND "actor_id" = app_security.current_actor_id()
  );

CREATE OR REPLACE FUNCTION "app_security"."validate_m63_b0_system_transition"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE sale record;
DECLARE graph_match boolean := false;
BEGIN
  IF pg_catalog.current_setting('app.actor_type', true) IS DISTINCT FROM 'system'
     OR pg_catalog.current_setting('app.system_scope', true)
       IS DISTINCT FROM 'after-sale-transition'
     OR NEW.store_id IS DISTINCT FROM app_security.current_store_id()
     OR NEW.actor_type <> 'SYSTEM'
     OR NEW.actor_id IS DISTINCT FROM app_security.current_actor_id()
     OR NEW.correlation_id IS DISTINCT FROM
       NULLIF(pg_catalog.current_setting('app.correlation_id', true), '')
     OR NEW.event NOT IN (
       'RETURN_EXPIRED','REFUND_SUCCEEDED','REFUND_FAILED','REFUND_CANCELLED',
       'REQUIRE_REVIEW','COMPLETE'
     )
  THEN
    RAISE EXCEPTION 'after-sale SYSTEM transition is outside the dedicated allowlist scope'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO sale
  FROM public.after_sales current_sale
  WHERE current_sale.store_id = NEW.store_id AND current_sale.id = NEW.after_sale_id
  FOR UPDATE;
  IF NOT FOUND OR NEW.from_status IS NULL OR NEW.from_status <> sale.status THEN
    RAISE EXCEPTION 'after-sale transition must start from the locked current status'
      USING ERRCODE = '23514';
  END IF;

  graph_match := (
    NEW.event = 'RETURN_EXPIRED'
    AND sale.type IN ('RETURN_REFUND','EXCHANGE')
    AND NEW.from_status = 'APPROVED'
    AND NEW.to_status = 'REJECTED'
  ) OR (
    NEW.event IN ('REFUND_SUCCEEDED','REFUND_FAILED','REFUND_CANCELLED')
    AND sale.type IN ('REFUND_ONLY','MERCHANT_REFUND','RETURN_REFUND','EXCHANGE')
    AND NEW.from_status = 'REFUND_PROCESSING'
    AND NEW.to_status = CASE NEW.event
      WHEN 'REFUND_SUCCEEDED' THEN 'REFUNDED'::public.after_sale_status
      ELSE 'REFUND_PENDING'::public.after_sale_status
    END
  ) OR (
    NEW.event = 'COMPLETE'
    AND sale.type IN ('REFUND_ONLY','MERCHANT_REFUND','RETURN_REFUND','EXCHANGE')
    AND NEW.from_status = 'REFUNDED'
    AND NEW.to_status = 'COMPLETED'
  ) OR (
    NEW.event = 'REQUIRE_REVIEW'
    AND NEW.to_status = 'REVIEW_REQUIRED'
    AND (
      (sale.type IN ('REFUND_ONLY','MERCHANT_REFUND')
        AND NEW.from_status IN ('APPROVED','REFUND_PENDING','REFUND_PROCESSING'))
      OR (sale.type = 'RETURN_REFUND'
        AND NEW.from_status IN ('APPROVED','RETURN_PENDING','RETURN_IN_TRANSIT',
          'INSPECTION_PENDING','REFUND_PENDING','REFUND_PROCESSING'))
      OR (sale.type = 'EXCHANGE'
        AND NEW.from_status IN ('APPROVED','RETURN_PENDING','RETURN_IN_TRANSIT',
          'INSPECTION_PENDING','EXCHANGE_PENDING','EXCHANGE_IN_TRANSIT',
          'REFUND_PENDING','REFUND_PROCESSING'))
    )
  );
  IF NOT graph_match THEN
    RAISE EXCEPTION 'invalid SYSTEM after-sale transition for current type and status'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.event = 'RETURN_EXPIRED' AND (
    sale.return_deadline_at IS NULL
    OR pg_catalog.clock_timestamp() < sale.return_deadline_at
    OR EXISTS (SELECT 1 FROM public.after_sale_return_shipments shipment
      WHERE shipment.store_id = sale.store_id AND shipment.after_sale_id = sale.id)
    OR EXISTS (SELECT 1 FROM public.shipments shipment
      WHERE shipment.store_id = sale.store_id AND shipment.after_sale_id = sale.id
        AND shipment.purpose = 'AFTER_SALE_RETURN')
    OR EXISTS (SELECT 1 FROM public.after_sale_settlements settlement
      WHERE settlement.store_id = sale.store_id AND settlement.after_sale_id = sale.id)
    OR EXISTS (SELECT 1 FROM public.after_sale_inspections inspection
      WHERE inspection.store_id = sale.store_id AND inspection.after_sale_id = sale.id)
    OR EXISTS (SELECT 1 FROM public.after_sale_inventory_actions action
      WHERE action.store_id = sale.store_id AND action.after_sale_id = sale.id)
    OR EXISTS (SELECT 1 FROM public.exchange_fulfillments fulfillment
      WHERE fulfillment.store_id = sale.store_id AND fulfillment.after_sale_id = sale.id)
  ) THEN
    RAISE EXCEPTION 'return expiration has conflicting facts' USING ERRCODE = '23514';
  END IF;
  IF NEW.event = 'REFUND_SUCCEEDED' AND sale.approved_total_vnd <> (
    SELECT COALESCE(pg_catalog.sum(settlement.amount_vnd), 0)
    FROM public.after_sale_settlements settlement
    WHERE settlement.store_id = sale.store_id
      AND settlement.after_sale_id = sale.id
      AND settlement.status = 'SUCCEEDED'
  ) THEN
    RAISE EXCEPTION 'successful settlements must equal the approved total'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.event = 'REFUND_FAILED' AND NOT EXISTS (
    SELECT 1 FROM public.after_sale_settlements settlement
    WHERE settlement.store_id = sale.store_id
      AND settlement.after_sale_id = sale.id
      AND settlement.status = 'FAILED'
  ) THEN
    RAISE EXCEPTION 'failed settlement fact is required' USING ERRCODE = '23514';
  END IF;
  IF NEW.event = 'REFUND_CANCELLED' AND NOT EXISTS (
    SELECT 1 FROM public.after_sale_settlements settlement
    WHERE settlement.store_id = sale.store_id
      AND settlement.after_sale_id = sale.id
      AND settlement.status = 'CANCELLED'
  ) THEN
    RAISE EXCEPTION 'cancelled settlement fact is required' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "after_sale_transitions_system_state_guard"
  BEFORE INSERT ON "after_sale_transitions"
  FOR EACH ROW
  WHEN (NEW.actor_type = 'SYSTEM')
  EXECUTE FUNCTION "app_security"."validate_m63_b0_system_transition"();

CREATE POLICY "after_sale_transitions_system_insert" ON "after_sale_transitions"
  FOR INSERT WITH CHECK (
    "store_id" = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'system'
    AND pg_catalog.current_setting('app.system_scope', true) = 'after-sale-transition'
    AND "actor_type" = 'SYSTEM'
    AND "actor_id" = app_security.current_actor_id()
    AND "event" IN (
      'RETURN_EXPIRED','REFUND_SUCCEEDED','REFUND_FAILED','REFUND_CANCELLED',
      'REQUIRE_REVIEW','COMPLETE'
    )
  );

-- A buyer-submitted return record and START_RETURN are one aggregate command.
-- The member transition guard requires the SUBMITTED row first; this deferred
-- check then rejects a commit unless START_RETURN moved the aggregate forward.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.after_sale_return_shipments shipment
    GROUP BY shipment.store_id, shipment.after_sale_id
    HAVING pg_catalog.count(*) > 1
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'M6.3-B0 cannot preserve multiple return submissions for one after-sale'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.after_sale_return_shipments shipment
    JOIN public.after_sales sale
      ON sale.store_id = shipment.store_id AND sale.id = shipment.after_sale_id
    WHERE shipment.status = 'SUBMITTED' AND sale.status = 'APPROVED'
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'M6.3-B0 cannot preserve an orphan submitted return record'
      USING ERRCODE = '55000';
  END IF;
END
$$;

CREATE UNIQUE INDEX "after_sale_return_shipments_store_id_after_sale_id_key"
  ON "after_sale_return_shipments"("store_id", "after_sale_id");

CREATE OR REPLACE FUNCTION "app_security"."validate_m63_b0_return_submission_atomicity"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE sale_status public.after_sale_status;
BEGIN
  IF NEW.status <> 'SUBMITTED' THEN
    RETURN NULL;
  END IF;
  SELECT sale.status
  INTO sale_status
  FROM public.after_sales sale
  WHERE sale.store_id = NEW.store_id AND sale.id = NEW.after_sale_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'submitted return aggregate does not exist' USING ERRCODE = '23503';
  END IF;
  IF sale_status = 'APPROVED' THEN
    RAISE EXCEPTION 'submitted return and START_RETURN must commit atomically'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "after_sale_return_shipments_b0_atomic_guard"
  AFTER INSERT OR UPDATE OF "status", "store_id", "after_sale_id"
  ON "after_sale_return_shipments"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m63_b0_return_submission_atomicity"();

REVOKE ALL ON FUNCTION
  "app_security"."validate_m63_b0_after_sale_policy_identity"(),
  "app_security"."validate_m63_b0_after_sale_item_policy"(),
  "app_security"."validate_m63_b0_after_sale_line_amount"(),
  "app_security"."validate_m63_b0_transition_contract"(),
  "app_security"."validate_m63_b0_member_transition"(),
  "app_security"."validate_m63_b0_system_transition"(),
  "app_security"."validate_m63_b0_return_submission_atomicity"()
FROM PUBLIC;
REVOKE ALL ON FUNCTION
  "app_security"."validate_m63_b0_after_sale_policy_identity"(),
  "app_security"."validate_m63_b0_after_sale_item_policy"(),
  "app_security"."validate_m63_b0_after_sale_line_amount"(),
  "app_security"."validate_m63_b0_transition_contract"(),
  "app_security"."validate_m63_b0_member_transition"(),
  "app_security"."validate_m63_b0_system_transition"(),
  "app_security"."validate_m63_b0_return_submission_atomicity"()
FROM zalo_shop_runtime;
