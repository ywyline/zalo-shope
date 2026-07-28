-- This down migration is limited to local/test rollback. Removing this
-- performance-only index does not mutate or invalidate any business fact, so
-- unlike structural M6 rollbacks it does not require an empty-fact guard.
DROP INDEX "after_sales_store_id_updated_at_id_idx";
