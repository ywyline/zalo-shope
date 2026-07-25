-- M5.2 forward guard: GHN callbacks are never authenticated facts because the
-- reviewed GHN webhook contract does not define a signature.
ALTER TABLE "provider_callbacks"
  ADD CONSTRAINT "provider_callbacks_channel_trust_check" CHECK (
    (
      "channel_kind" = 'SHIPPING'
      AND "provider_code" = 'GHN'
      AND "signature_status" = 'NOT_AVAILABLE'
      AND "trust" = 'UNVERIFIED_HINT'
    )
    OR (
      "channel_kind" = 'PAYMENT'
      AND "provider_code" = 'ZALO_CHECKOUT_ZALOPAY'
      AND (
        ("signature_status" = 'VERIFIED' AND "trust" = 'AUTHENTICATED_FACT')
        OR ("signature_status" = 'INVALID' AND "trust" = 'UNTRUSTED')
      )
    )
  );
