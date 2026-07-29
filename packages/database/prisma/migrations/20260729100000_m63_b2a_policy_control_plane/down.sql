-- LOCAL/TEST ONLY. Remove the B2a keyset pagination indexes. No business facts
-- or row-level security policies are mutated.

DROP INDEX "after_sale_policy_versions_store_policy_published_id_idx";
DROP INDEX "after_sale_policies_store_id_updated_at_id_idx";
