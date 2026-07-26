-- LOCAL/TEST ONLY. This removes callback routing code but does not delete payment facts.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "provider_callbacks" LIMIT 1) THEN
    RAISE EXCEPTION 'M5.5 callback resolver rollback is unsafe after callback facts exist'
      USING ERRCODE = '55000';
  END IF;
END
$$;

DROP FUNCTION IF EXISTS "app_security"."resolve_payment_callback_channel"(text, text);
DROP INDEX IF EXISTS "store_payment_channels_checkout_app_id_method_code_key";
