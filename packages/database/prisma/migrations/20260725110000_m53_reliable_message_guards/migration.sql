-- M5.3 keeps scheduling state internally consistent and makes store identity in
-- outbox payloads a database invariant. This is a forward-only hardening of the
-- M5.2 tables; no external provider facts are created.
ALTER TABLE "outbox_messages" DROP CONSTRAINT "outbox_messages_values_check";

ALTER TABLE "outbox_messages"
  ADD CONSTRAINT "outbox_messages_values_check" CHECK (
    "event_version" >= 1
    AND "version" >= 1
    AND "attempt_count" >= 0
    AND "max_attempts" BETWEEN 1 AND 100
    AND "attempt_count" <= "max_attempts"
    AND btrim("aggregate_type") <> ''
    AND btrim("event_type") <> ''
    AND btrim("idempotency_key") <> ''
    AND jsonb_typeof("payload") = 'object'
    AND jsonb_typeof("payload" -> 'store_id') = 'string'
    AND "payload" ->> 'store_id' = "store_id"::text
    AND (
      ("status" = 'PENDING' AND "lease_owner" IS NULL AND "lease_expires_at" IS NULL
        AND "completed_at" IS NULL)
      OR ("status" = 'PROCESSING' AND "lease_owner" IS NOT NULL
        AND "lease_expires_at" IS NOT NULL AND "completed_at" IS NULL)
      OR ("status" IN ('COMPLETED', 'DEAD_LETTER') AND "lease_owner" IS NULL
        AND "lease_expires_at" IS NULL AND "completed_at" IS NOT NULL)
    )
  );

ALTER TABLE "inbox_messages" DROP CONSTRAINT "inbox_messages_values_check";

ALTER TABLE "inbox_messages"
  ADD CONSTRAINT "inbox_messages_values_check" CHECK (
    "version" >= 1
    AND btrim("source") <> ''
    AND btrim("external_message_key") <> ''
    AND "payload_digest" ~ '^[0-9a-f]{64}$'
    AND (
      ("status" = 'RECEIVED' AND "processing_started_at" IS NULL
        AND "completed_at" IS NULL AND "error_code" IS NULL)
      OR ("status" = 'PROCESSING' AND "processing_started_at" IS NOT NULL
        AND "completed_at" IS NULL AND "error_code" IS NULL)
      OR ("status" = 'RETRY_PENDING' AND "processing_started_at" IS NOT NULL
        AND "completed_at" IS NULL AND "error_code" IS NOT NULL)
      OR ("status" = 'COMPLETED' AND "processing_started_at" IS NOT NULL
        AND "completed_at" IS NOT NULL AND "error_code" IS NULL)
      OR ("status" IN ('REJECTED', 'DEAD_LETTER') AND "processing_started_at" IS NOT NULL
        AND "completed_at" IS NOT NULL AND "error_code" IS NOT NULL)
    )
  );
