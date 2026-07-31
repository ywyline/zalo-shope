-- Local/test only. Any committed B3 fact makes rollback unsafe.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.after_sale_transitions WHERE event = 'SUBMIT' LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.after_sale_operations
       WHERE operation IN ('MEMBER_CREATE','MERCHANT_REFUND_CREATE','MEMBER_CANCEL') LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.audit_logs
       WHERE action IN ('after-sale.member.submitted','after-sale.merchant-refund.submitted',
         'after-sale.member.cancelled') LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.outbox_messages
       WHERE event_type IN ('after-sale.submitted','after-sale.cancelled') LIMIT 1)
  THEN
    RAISE EXCEPTION 'M6.3-B3 rollback is unsafe after command facts exist'
      USING ERRCODE = '55000';
  END IF;
END
$$;

REVOKE ALL ON FUNCTION
  "app_security"."finalize_m63_b3_after_sale_submit"(uuid, uuid, inet),
  "app_security"."cancel_m63_b3_member_after_sale"(uuid, uuid, text, text, integer, inet)
FROM zalo_shop_runtime;

DROP TRIGGER IF EXISTS "after_sale_operations_b3_atomic_guard" ON "after_sale_operations";
DROP TRIGGER IF EXISTS "after_sale_transitions_b3_atomic_guard" ON "after_sale_transitions";
DROP TRIGGER IF EXISTS "after_sales_b3_runtime_commit_guard" ON "after_sales";
DROP TRIGGER IF EXISTS "after_sale_operations_b3_completion_guard" ON "after_sale_operations";
DROP TRIGGER IF EXISTS "after_sale_transitions_b3_operation_link_guard" ON "after_sale_transitions";
DROP TRIGGER IF EXISTS "after_sale_transitions_b3_submit_guard" ON "after_sale_transitions";
DROP TRIGGER IF EXISTS "after_sale_transitions_a_b3_approval_order_lock_guard"
  ON "after_sale_transitions";
DROP TRIGGER IF EXISTS "after_sale_items_a_b3_approval_order_lock_guard"
  ON "after_sale_items";
DROP TRIGGER IF EXISTS "after_sales_a_b3_approval_order_lock_guard"
  ON "after_sales";
DROP TRIGGER IF EXISTS "after_sale_order_allocations_a_b3_approval_order_lock_guard"
  ON "after_sale_order_allocations";
DROP TRIGGER IF EXISTS "after_sale_legacy_decisions_a_b3_approval_order_lock_guard"
  ON "after_sale_legacy_decisions";

DROP FUNCTION "app_security"."finalize_m63_b3_after_sale_submit"(uuid, uuid, inet);
DROP FUNCTION "app_security"."cancel_m63_b3_member_after_sale"(uuid, uuid, text, text, integer, inet);
DROP FUNCTION "app_security"."validate_m63_b3_command_atomicity"();
DROP FUNCTION IF EXISTS "app_security"."validate_m63_b3_runtime_case_commit"();
DROP FUNCTION "app_security"."validate_m63_b3_operation_completion"();
DROP FUNCTION "app_security"."validate_m63_b3_operation_link"();
DROP FUNCTION "app_security"."validate_m63_b3_submit_transition"();
DROP FUNCTION "app_security"."validate_m63_b3_command_facts"(uuid);
DROP FUNCTION "app_security"."assert_m63_b3_command_authorization"();
DROP FUNCTION "app_security"."lock_m63_b3_approval_order_scope"();
DROP FUNCTION "app_security"."guard_m63_b3_approval_mutation_order_scope"();

DROP TRIGGER "after_sale_transitions_b0_contract_guard" ON "after_sale_transitions";
CREATE TRIGGER "after_sale_transitions_b0_contract_guard"
  BEFORE INSERT ON "after_sale_transitions"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m63_b0_transition_contract"();

DROP TRIGGER "after_sale_transitions_state_guard" ON "after_sale_transitions";
CREATE TRIGGER "after_sale_transitions_state_guard"
  BEFORE INSERT ON "after_sale_transitions"
  FOR EACH ROW
  WHEN (NEW.actor_type = 'ADMIN')
  EXECUTE FUNCTION "app_security"."validate_m62_after_sale_transition"();

DROP TRIGGER "after_sale_transitions_member_state_guard" ON "after_sale_transitions";
CREATE TRIGGER "after_sale_transitions_member_state_guard"
  BEFORE INSERT ON "after_sale_transitions"
  FOR EACH ROW
  WHEN (NEW.actor_type = 'MEMBER')
  EXECUTE FUNCTION "app_security"."validate_m63_b0_member_transition"();

DROP TRIGGER "after_sale_transitions_apply_state" ON "after_sale_transitions";
CREATE TRIGGER "after_sale_transitions_apply_state"
  AFTER INSERT ON "after_sale_transitions"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."apply_m62_after_sale_transition"();

CREATE POLICY "after_sale_operations_insert_scope" ON "after_sale_operations"
  FOR INSERT WITH CHECK (
    "store_id" = app_security.current_store_id()
    AND (
      pg_catalog.current_setting('app.actor_type', true) = 'admin'
      OR (
        pg_catalog.current_setting('app.actor_type', true) = 'member'
        AND EXISTS (
          SELECT 1 FROM public.after_sales AS owned_case
          WHERE owned_case.store_id = after_sale_operations.store_id
            AND owned_case.id = after_sale_operations.after_sale_id
            AND owned_case.member_id = app_security.current_actor_id()
        )
      )
    )
  );
CREATE POLICY "after_sale_transitions_member_cancel_insert" ON "after_sale_transitions"
  FOR INSERT WITH CHECK (
    "store_id" = app_security.current_store_id()
    AND pg_catalog.current_setting('app.actor_type', true) = 'member'
    AND "from_status" = 'PENDING_REVIEW'
    AND "to_status" = 'CANCELLED'
    AND "event" = 'CANCEL'
    AND "actor_type" = 'MEMBER'
    AND "actor_id" = app_security.current_actor_id()
    AND EXISTS (
      SELECT 1 FROM public.after_sales AS owned_case
      WHERE owned_case.store_id = after_sale_transitions.store_id
        AND owned_case.id = after_sale_transitions.after_sale_id
        AND owned_case.member_id = app_security.current_actor_id()
        AND owned_case.status = 'PENDING_REVIEW'
    )
  );
GRANT INSERT ON "after_sale_operations" TO zalo_shop_runtime;

DROP INDEX "after_sale_transitions_one_submit_per_case_key";
ALTER TABLE "after_sale_transitions" DROP CONSTRAINT "after_sale_transitions_operation_fkey";
ALTER TABLE "after_sale_operations"
  DROP CONSTRAINT "after_sale_operations_store_id_id_after_sale_id_key";
ALTER TABLE "after_sale_transitions" DROP COLUMN "operation_id";
