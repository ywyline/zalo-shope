-- Cover the fixed M6.3-B1 administrator list order for both filtered and
-- unfiltered reads. This is a read-performance index only; it does not change
-- after-sale facts, constraints, RLS or runtime write permissions.
CREATE INDEX "after_sales_store_id_updated_at_id_idx"
  ON "after_sales"("store_id", "updated_at" DESC, "id" DESC);
