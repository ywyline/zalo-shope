-- M4 forward guard: address region codes must reference the same store's
-- server-maintained administrative-area catalog.
ALTER TABLE "addresses"
  ADD CONSTRAINT "addresses_store_id_province_code_fkey"
    FOREIGN KEY ("store_id", "province_code")
    REFERENCES "administrative_areas"("store_id", "code") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "addresses_store_id_district_code_fkey"
    FOREIGN KEY ("store_id", "district_code")
    REFERENCES "administrative_areas"("store_id", "code") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "addresses_store_id_ward_code_fkey"
    FOREIGN KEY ("store_id", "ward_code")
    REFERENCES "administrative_areas"("store_id", "code") ON DELETE RESTRICT ON UPDATE CASCADE;
