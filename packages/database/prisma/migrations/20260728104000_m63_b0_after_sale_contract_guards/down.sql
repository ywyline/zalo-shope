-- LOCAL/TEST ONLY. Production and any database containing after-sale runtime
-- facts require a forward repair. Default OFF settings rows alone are safe.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.after_sales LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.after_sale_evidence_files LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.after_sale_settlements LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.after_sale_refunds LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.after_sale_inventory_actions LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.after_sale_return_shipments LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.exchange_fulfillments LIMIT 1)
  THEN
    RAISE EXCEPTION 'M6.3-B0 rollback requires an empty local/test after-sale runtime scope'
      USING ERRCODE = '55000';
  END IF;
END
$$;

DROP POLICY IF EXISTS "after_sale_transitions_system_insert" ON "after_sale_transitions";
DROP POLICY IF EXISTS "after_sale_transitions_member_start_return_insert" ON "after_sale_transitions";
DROP TRIGGER IF EXISTS "after_sale_return_shipments_b0_atomic_guard"
  ON "after_sale_return_shipments";
DROP TRIGGER IF EXISTS "after_sale_transitions_system_state_guard" ON "after_sale_transitions";
DROP TRIGGER IF EXISTS "after_sale_transitions_member_state_guard" ON "after_sale_transitions";
DROP TRIGGER IF EXISTS "after_sale_transitions_b0_contract_guard" ON "after_sale_transitions";
DROP TRIGGER IF EXISTS "after_sale_items_b0_line_amount_guard" ON "after_sale_items";
DROP TRIGGER IF EXISTS "after_sale_items_policy_identity_guard" ON "after_sale_items";
DROP TRIGGER IF EXISTS "after_sales_policy_identity_guard" ON "after_sales";

DROP INDEX IF EXISTS "after_sale_return_shipments_store_id_after_sale_id_key";

DROP TRIGGER "after_sale_transitions_state_guard" ON "after_sale_transitions";
CREATE TRIGGER "after_sale_transitions_state_guard"
  BEFORE INSERT ON "after_sale_transitions"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_m62_after_sale_transition"();

DROP FUNCTION IF EXISTS "app_security"."validate_m63_b0_system_transition"();
DROP FUNCTION IF EXISTS "app_security"."validate_m63_b0_member_transition"();
DROP FUNCTION IF EXISTS "app_security"."validate_m63_b0_return_submission_atomicity"();
DROP FUNCTION IF EXISTS "app_security"."validate_m63_b0_transition_contract"();
DROP FUNCTION IF EXISTS "app_security"."validate_m63_b0_after_sale_line_amount"();
DROP FUNCTION IF EXISTS "app_security"."validate_m63_b0_after_sale_item_policy"();
DROP FUNCTION IF EXISTS "app_security"."validate_m63_b0_after_sale_policy_identity"();

DROP INDEX "after_sales_policy_identity_idx";
ALTER TABLE "after_sales"
  DROP CONSTRAINT "after_sales_policy_identity_check",
  DROP CONSTRAINT "after_sales_policy_version_fkey",
  DROP CONSTRAINT "after_sales_policy_fkey",
  DROP COLUMN "policy_version_id",
  DROP COLUMN "policy_id";
