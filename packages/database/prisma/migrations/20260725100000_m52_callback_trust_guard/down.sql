-- LOCAL/TEST ONLY. Refuse rollback after callback facts exist.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "provider_callbacks" LIMIT 1) THEN
    RAISE EXCEPTION 'M5 callback trust rollback is unsafe after callback facts exist'
      USING ERRCODE = '55000';
  END IF;
END
$$;

ALTER TABLE "provider_callbacks"
  DROP CONSTRAINT IF EXISTS "provider_callbacks_channel_trust_check";
