-- M5.5 callback routing must resolve exactly one store before tenant RLS context exists.
CREATE UNIQUE INDEX "store_payment_channels_checkout_app_id_method_code_key"
  ON "store_payment_channels"("checkout_app_id", "method_code");

CREATE OR REPLACE FUNCTION "app_security"."resolve_payment_callback_channel"(
  requested_app_id text,
  requested_method_code text
)
RETURNS TABLE (
  store_id uuid,
  store_code varchar,
  default_locale "Locale",
  channel_id uuid,
  checkout_app_id varchar,
  method_code varchar,
  provider_code "payment_provider_code",
  provider_environment "integration_environment",
  private_key_secret_ref varchar,
  key_version varchar,
  channel_version integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    channel.store_id,
    store.code,
    store.default_locale,
    channel.id,
    channel.checkout_app_id,
    channel.method_code,
    channel.provider_code,
    channel.provider_environment,
    channel.private_key_secret_ref,
    channel.key_version,
    channel.version
  FROM public.store_payment_channels AS channel
  JOIN public.stores AS store ON store.id = channel.store_id
  WHERE channel.checkout_app_id = requested_app_id
    AND channel.method_code = requested_method_code
    AND channel.provider_code = 'ZALO_CHECKOUT_ZALOPAY'
    AND store.status = 'ACTIVE'
$$;

REVOKE ALL ON FUNCTION "app_security"."resolve_payment_callback_channel"(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app_security"."resolve_payment_callback_channel"(text, text)
  TO zalo_shop_runtime;
