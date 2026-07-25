DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "outbox_messages" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "inbox_messages" LIMIT 1) THEN
    RAISE EXCEPTION 'M5.3 reliable-message guard rollback is unsafe after message facts exist'
      USING ERRCODE = '55000';
  END IF;
END
$$;

ALTER TABLE "outbox_messages" DROP CONSTRAINT "outbox_messages_values_check";

ALTER TABLE "outbox_messages"
  ADD CONSTRAINT "outbox_messages_values_check" CHECK (
    "event_version" >= 1
    AND "version" >= 1
    AND "attempt_count" >= 0
    AND "max_attempts" BETWEEN 1 AND 100
    AND "attempt_count" <= "max_attempts"
    AND btrim("idempotency_key") <> ''
    AND jsonb_typeof("payload") = 'object'
    AND (("lease_owner" IS NULL) = ("lease_expires_at" IS NULL))
    AND (
      "status" <> 'PROCESSING'
      OR ("lease_owner" IS NOT NULL AND "lease_expires_at" IS NOT NULL)
    )
    AND ("status" <> 'COMPLETED' OR "completed_at" IS NOT NULL)
  );

ALTER TABLE "inbox_messages" DROP CONSTRAINT "inbox_messages_values_check";

ALTER TABLE "inbox_messages"
  ADD CONSTRAINT "inbox_messages_values_check" CHECK (
    "version" >= 1
    AND btrim("source") <> ''
    AND btrim("external_message_key") <> ''
    AND "payload_digest" ~ '^[0-9a-f]{64}$'
    AND ("status" <> 'PROCESSING' OR "processing_started_at" IS NOT NULL)
    AND ("status" NOT IN ('COMPLETED', 'REJECTED') OR "completed_at" IS NOT NULL)
  );
