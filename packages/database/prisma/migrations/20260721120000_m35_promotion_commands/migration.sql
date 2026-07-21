-- M3.5 promotion command idempotency and explicit new-customer coupon eligibility.
-- This migration is additive and does not grant existing production roles new permissions.

ALTER TABLE "coupons"
  ADD COLUMN "new_customer_only" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "promotion_operations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "store_id" UUID NOT NULL,
  "operation_key" VARCHAR(128) NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "operation_type" VARCHAR(32) NOT NULL,
  "target_type" VARCHAR(32) NOT NULL,
  "target_id" UUID NOT NULL,
  "result_data" JSONB NOT NULL,
  "created_by_admin_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "promotion_operations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "promotion_operations_request_hash_check" CHECK ("request_hash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "promotion_operations_store_id_id_key"
  ON "promotion_operations"("store_id", "id");
CREATE UNIQUE INDEX "promotion_operations_store_id_operation_key_key"
  ON "promotion_operations"("store_id", "operation_key");
CREATE INDEX "promotion_operations_store_id_created_at_id_idx"
  ON "promotion_operations"("store_id", "created_at" DESC, "id" DESC);

ALTER TABLE "promotion_operations"
  ADD CONSTRAINT "promotion_operations_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "promotion_operations_created_by_admin_id_fkey"
    FOREIGN KEY ("created_by_admin_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TRIGGER "promotion_operations_store_immutable"
  BEFORE UPDATE ON "promotion_operations"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_store_change"();
CREATE TRIGGER "promotion_operations_append_only"
  BEFORE UPDATE OR DELETE ON "promotion_operations"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_m3_fact_mutation"();

ALTER TABLE "promotion_operations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "promotion_operations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "promotion_operations_tenant_isolation" ON "promotion_operations"
  USING ("store_id" = "app_security"."current_store_id"())
  WITH CHECK ("store_id" = "app_security"."current_store_id"());

GRANT SELECT, INSERT ON TABLE "promotion_operations" TO zalo_shop_runtime;
REVOKE UPDATE, DELETE ON TABLE "promotion_operations" FROM zalo_shop_runtime;
