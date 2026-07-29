-- M6.3-B2a policy-control-plane keyset pagination indexes.

CREATE INDEX "after_sale_policies_store_id_updated_at_id_idx"
  ON "after_sale_policies"("store_id", "updated_at" DESC, "id" DESC);

CREATE INDEX "after_sale_policy_versions_store_policy_published_id_idx"
  ON "after_sale_policy_versions"(
    "store_id", "policy_id", "published_at" DESC, "id" DESC
  );
