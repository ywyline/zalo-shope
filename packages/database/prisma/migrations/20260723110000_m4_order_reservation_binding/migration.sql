ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "reservation_id" UUID;
CREATE UNIQUE INDEX IF NOT EXISTS "orders_store_id_reservation_id_key" ON "orders"("store_id", "reservation_id");
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_store_id_reservation_id_fkey'
  ) THEN
    ALTER TABLE "orders"
      ADD CONSTRAINT "orders_store_id_reservation_id_fkey"
      FOREIGN KEY ("store_id", "reservation_id")
      REFERENCES "inventory_reservations"("store_id", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;
