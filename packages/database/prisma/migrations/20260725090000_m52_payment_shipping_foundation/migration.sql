-- M5.2 payment, refund, shipping, callback and reliable-message foundation.
-- Channels remain disabled until the external M5.5/M5.7 acceptance gates are satisfied.

-- CreateEnum
CREATE TYPE "integration_environment" AS ENUM ('SANDBOX', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "integration_channel_status" AS ENUM ('DISABLED', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "payment_provider_code" AS ENUM ('ZALO_CHECKOUT_ZALOPAY');

-- CreateEnum
CREATE TYPE "shipping_provider_code" AS ENUM ('GHN');

-- CreateEnum
CREATE TYPE "payment_attempt_status" AS ENUM ('CREATED', 'PROVIDER_PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED', 'REVIEW_REQUIRED');

-- CreateEnum
CREATE TYPE "refund_status" AS ENUM ('REQUESTED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'REVIEW_REQUIRED');

-- CreateEnum
CREATE TYPE "provider_transition_source" AS ENUM ('MEMBER', 'ADMIN', 'WEBHOOK', 'QUERY', 'RECONCILIATION', 'SYSTEM');

-- CreateEnum
CREATE TYPE "integration_channel_kind" AS ENUM ('PAYMENT', 'SHIPPING');

-- CreateEnum
CREATE TYPE "callback_signature_status" AS ENUM ('VERIFIED', 'INVALID', 'NOT_AVAILABLE');

-- CreateEnum
CREATE TYPE "provider_callback_trust" AS ENUM ('AUTHENTICATED_FACT', 'UNVERIFIED_HINT', 'UNTRUSTED');

-- CreateEnum
CREATE TYPE "provider_callback_processing_status" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'REJECTED', 'RETRY_PENDING', 'DEAD_LETTER');

-- CreateEnum
CREATE TYPE "shipment_status" AS ENUM ('CREATION_PENDING', 'PENDING_PICKUP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'REFUSED', 'RETURNING', 'RETURNED', 'EXCEPTION', 'CANCELLED', 'REVIEW_REQUIRED');

-- CreateEnum
CREATE TYPE "shipping_quote_source" AS ENUM ('PROVIDER', 'FIXED_POLICY');

-- CreateEnum
CREATE TYPE "tracking_event_source" AS ENUM ('QUERY', 'RECONCILIATION', 'ADMIN');

-- CreateEnum
CREATE TYPE "shipping_operation_type" AS ENUM ('QUOTE', 'CREATE', 'CANCEL', 'QUERY_TRACKING', 'FETCH_LABEL', 'RECONCILE');

-- CreateEnum
CREATE TYPE "integration_operation_status" AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'DEAD_LETTER', 'REVIEW_REQUIRED');

-- CreateEnum
CREATE TYPE "outbox_status" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'DEAD_LETTER');

-- CreateEnum
CREATE TYPE "inbox_status" AS ENUM ('RECEIVED', 'PROCESSING', 'COMPLETED', 'REJECTED', 'RETRY_PENDING', 'DEAD_LETTER');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "order_payment_status" ADD VALUE 'PARTIALLY_REFUNDED';
ALTER TYPE "order_payment_status" ADD VALUE 'FULLY_REFUNDED';

-- CreateTable
CREATE TABLE "store_payment_channels" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "deployment_environment" "DeploymentEnvironment" NOT NULL,
    "provider_environment" "integration_environment" NOT NULL,
    "provider_code" "payment_provider_code" NOT NULL,
    "method_code" VARCHAR(64) NOT NULL,
    "checkout_app_id" VARCHAR(128) NOT NULL,
    "merchant_reference" VARCHAR(160),
    "private_key_secret_ref" VARCHAR(512) NOT NULL,
    "secret_fingerprint" CHAR(64) NOT NULL,
    "key_version" VARCHAR(64) NOT NULL,
    "status" "integration_channel_status" NOT NULL DEFAULT 'DISABLED',
    "payment_window_seconds" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "store_payment_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_shipping_channels" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "provider_environment" "integration_environment" NOT NULL,
    "provider_code" "shipping_provider_code" NOT NULL,
    "shop_id" VARCHAR(64) NOT NULL,
    "token_secret_ref" VARCHAR(512) NOT NULL,
    "secret_fingerprint" CHAR(64) NOT NULL,
    "key_version" VARCHAR(64) NOT NULL,
    "status" "integration_channel_status" NOT NULL DEFAULT 'DISABLED',
    "origin_allowlist_key" VARCHAR(64) NOT NULL,
    "default_service_code" VARCHAR(64),
    "webhook_path_token_hash" BYTEA,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "store_shipping_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "public_payment_number" VARCHAR(64) NOT NULL,
    "attempt_sequence" INTEGER NOT NULL,
    "amount_vnd" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'VND',
    "status" "payment_attempt_status" NOT NULL DEFAULT 'CREATED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "launch_nonce_hash" CHAR(64),
    "launch_payload_hash" CHAR(64),
    "provider_order_id" VARCHAR(160),
    "provider_transaction_id" VARCHAR(160),
    "provider_status" VARCHAR(64),
    "provider_occurred_at" TIMESTAMPTZ(6),
    "succeeded_at" TIMESTAMPTZ(6),
    "failed_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "expired_at" TIMESTAMPTZ(6),
    "review_required_at" TIMESTAMPTZ(6),
    "create_idempotency_key_hash" CHAR(64) NOT NULL,
    "correlation_id" VARCHAR(128) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payment_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_transitions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "payment_attempt_id" UUID NOT NULL,
    "from_status" "payment_attempt_status",
    "to_status" "payment_attempt_status" NOT NULL,
    "event" VARCHAR(64) NOT NULL,
    "source" "provider_transition_source" NOT NULL,
    "provider_event_id" VARCHAR(160),
    "actor_type" "AuditActorType",
    "actor_id" UUID,
    "reason" VARCHAR(500),
    "correlation_id" VARCHAR(128) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_callbacks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "channel_kind" "integration_channel_kind" NOT NULL,
    "channel_id" UUID NOT NULL,
    "provider_code" VARCHAR(64) NOT NULL,
    "environment" "integration_environment" NOT NULL,
    "external_event_id" VARCHAR(160),
    "event_digest" CHAR(64) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signature_status" "callback_signature_status" NOT NULL,
    "trust" "provider_callback_trust" NOT NULL,
    "processing_status" "provider_callback_processing_status" NOT NULL DEFAULT 'RECEIVED',
    "payload_ciphertext_ref" VARCHAR(512),
    "payload_digest" CHAR(64) NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6),
    "last_error_code" VARCHAR(64),
    "completed_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "provider_callbacks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "payment_attempt_id" UUID NOT NULL,
    "public_refund_number" VARCHAR(64) NOT NULL,
    "amount_vnd" BIGINT NOT NULL,
    "status" "refund_status" NOT NULL DEFAULT 'REQUESTED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "reason" VARCHAR(500) NOT NULL,
    "requested_by" UUID NOT NULL,
    "provider_refund_id" VARCHAR(160),
    "provider_status" VARCHAR(64),
    "idempotency_key_hash" CHAR(64) NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "succeeded_at" TIMESTAMPTZ(6),
    "failed_at" TIMESTAMPTZ(6),
    "review_required_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refund_transitions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "refund_id" UUID NOT NULL,
    "from_status" "refund_status",
    "to_status" "refund_status" NOT NULL,
    "event" VARCHAR(64) NOT NULL,
    "source" "provider_transition_source" NOT NULL,
    "provider_event_id" VARCHAR(160),
    "actor_type" "AuditActorType",
    "actor_id" UUID,
    "reason" VARCHAR(500),
    "correlation_id" VARCHAR(128) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refund_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipping_quotes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "service_code" VARCHAR(64) NOT NULL,
    "provider_service_id" INTEGER,
    "provider_service_type_id" INTEGER,
    "base_fee_vnd" BIGINT NOT NULL,
    "insurance_fee_vnd" BIGINT NOT NULL DEFAULT 0,
    "cod_fee_vnd" BIGINT NOT NULL DEFAULT 0,
    "remote_fee_vnd" BIGINT NOT NULL DEFAULT 0,
    "other_fee_vnd" BIGINT NOT NULL DEFAULT 0,
    "total_fee_vnd" BIGINT NOT NULL,
    "estimated_delivery_at" TIMESTAMPTZ(6),
    "provider_quote_ref" VARCHAR(160),
    "source" "shipping_quote_source" NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipping_quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "public_shipment_number" VARCHAR(64) NOT NULL,
    "status" "shipment_status" NOT NULL DEFAULT 'CREATION_PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "client_order_code" VARCHAR(64) NOT NULL,
    "provider_shipment_id" VARCHAR(160),
    "service_code" VARCHAR(64) NOT NULL,
    "provider_service_id" INTEGER,
    "provider_service_type_id" INTEGER,
    "cod_amount_vnd" BIGINT NOT NULL DEFAULT 0,
    "address_snapshot_ciphertext" TEXT NOT NULL,
    "parcel_snapshot" JSONB NOT NULL,
    "label_metadata" JSONB,
    "created_operation_id" UUID,
    "cancelled_operation_id" UUID,
    "provider_created_at" TIMESTAMPTZ(6),
    "picked_up_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "returned_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracking_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "provider_event_key" VARCHAR(160) NOT NULL,
    "status" "shipment_status" NOT NULL,
    "provider_status" VARCHAR(64) NOT NULL,
    "reason_code" VARCHAR(64),
    "message_key" VARCHAR(160) NOT NULL,
    "location_masked" VARCHAR(160),
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "tracking_event_source" NOT NULL,
    "payload_ciphertext_ref" VARCHAR(512),

    CONSTRAINT "tracking_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipping_operations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "shipment_id" UUID,
    "channel_id" UUID NOT NULL,
    "operation_type" "shipping_operation_type" NOT NULL,
    "idempotency_key_hash" CHAR(64) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "status" "integration_operation_status" NOT NULL DEFAULT 'PENDING',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6),
    "error_code" VARCHAR(64),
    "correlation_id" VARCHAR(128) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "shipping_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "aggregate_type" VARCHAR(64) NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "event_type" VARCHAR(128) NOT NULL,
    "event_version" INTEGER NOT NULL,
    "idempotency_key" VARCHAR(160) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "outbox_status" NOT NULL DEFAULT 'PENDING',
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_owner" VARCHAR(128),
    "lease_expires_at" TIMESTAMPTZ(6),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 8,
    "last_error_code" VARCHAR(64),
    "completed_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "outbox_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbox_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "source" VARCHAR(64) NOT NULL,
    "channel_id" UUID NOT NULL,
    "environment" "integration_environment" NOT NULL,
    "external_message_key" VARCHAR(160) NOT NULL,
    "payload_digest" CHAR(64) NOT NULL,
    "status" "inbox_status" NOT NULL DEFAULT 'RECEIVED',
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processing_started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "error_code" VARCHAR(64),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "inbox_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "store_payment_channels_store_id_status_provider_environment_idx" ON "store_payment_channels"("store_id", "status", "provider_environment");

-- CreateIndex
CREATE UNIQUE INDEX "store_payment_channels_store_id_id_key" ON "store_payment_channels"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "store_payment_channels_store_id_deployment_environment_prov_key" ON "store_payment_channels"("store_id", "deployment_environment", "provider_code");

-- CreateIndex
CREATE INDEX "store_shipping_channels_store_id_status_provider_environmen_idx" ON "store_shipping_channels"("store_id", "status", "provider_environment");

-- CreateIndex
CREATE UNIQUE INDEX "store_shipping_channels_store_id_id_key" ON "store_shipping_channels"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "store_shipping_channels_store_id_provider_environment_provi_key" ON "store_shipping_channels"("store_id", "provider_environment", "provider_code");

-- CreateIndex
CREATE UNIQUE INDEX "store_shipping_channels_provider_environment_provider_code__key" ON "store_shipping_channels"("provider_environment", "provider_code", "shop_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_public_payment_number_key" ON "payment_attempts"("public_payment_number");

-- CreateIndex
CREATE INDEX "payment_attempts_store_id_order_id_created_at_idx" ON "payment_attempts"("store_id", "order_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "payment_attempts_store_id_status_expires_at_id_idx" ON "payment_attempts"("store_id", "status", "expires_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_store_id_id_key" ON "payment_attempts"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_store_id_id_order_id_key" ON "payment_attempts"("store_id", "id", "order_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_store_id_order_id_attempt_sequence_key" ON "payment_attempts"("store_id", "order_id", "attempt_sequence");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_store_id_order_id_create_idempotency_key_h_key" ON "payment_attempts"("store_id", "order_id", "create_idempotency_key_hash");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_store_id_channel_id_provider_order_id_key" ON "payment_attempts"("store_id", "channel_id", "provider_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_store_id_channel_id_provider_transaction_i_key" ON "payment_attempts"("store_id", "channel_id", "provider_transaction_id");

-- CreateIndex
CREATE INDEX "payment_transitions_store_id_payment_attempt_id_created_at__idx" ON "payment_transitions"("store_id", "payment_attempt_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "payment_transitions_store_id_id_key" ON "payment_transitions"("store_id", "id");

-- CreateIndex
CREATE INDEX "provider_callbacks_store_id_processing_status_next_attempt__idx" ON "provider_callbacks"("store_id", "processing_status", "next_attempt_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "provider_callbacks_store_id_id_key" ON "provider_callbacks"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "provider_callbacks_channel_kind_channel_id_environment_even_key" ON "provider_callbacks"("channel_kind", "channel_id", "environment", "event_digest");

-- CreateIndex
CREATE UNIQUE INDEX "provider_callbacks_channel_kind_channel_id_environment_exte_key" ON "provider_callbacks"("channel_kind", "channel_id", "environment", "external_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_public_refund_number_key" ON "refunds"("public_refund_number");

-- CreateIndex
CREATE INDEX "refunds_store_id_order_id_requested_at_id_idx" ON "refunds"("store_id", "order_id", "requested_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "refunds_store_id_payment_attempt_id_status_idx" ON "refunds"("store_id", "payment_attempt_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_store_id_id_key" ON "refunds"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_store_id_payment_attempt_id_idempotency_key_hash_key" ON "refunds"("store_id", "payment_attempt_id", "idempotency_key_hash");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_store_id_payment_attempt_id_provider_refund_id_key" ON "refunds"("store_id", "payment_attempt_id", "provider_refund_id");

-- CreateIndex
CREATE INDEX "refund_transitions_store_id_refund_id_created_at_id_idx" ON "refund_transitions"("store_id", "refund_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "refund_transitions_store_id_id_key" ON "refund_transitions"("store_id", "id");

-- CreateIndex
CREATE INDEX "shipping_quotes_store_id_order_id_expires_at_idx" ON "shipping_quotes"("store_id", "order_id", "expires_at" DESC);

-- CreateIndex
CREATE INDEX "shipping_quotes_store_id_channel_id_request_hash_expires_at_idx" ON "shipping_quotes"("store_id", "channel_id", "request_hash", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "shipping_quotes_store_id_id_key" ON "shipping_quotes"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_public_shipment_number_key" ON "shipments"("public_shipment_number");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_created_operation_id_key" ON "shipments"("created_operation_id");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_cancelled_operation_id_key" ON "shipments"("cancelled_operation_id");

-- CreateIndex
CREATE INDEX "shipments_store_id_order_id_created_at_idx" ON "shipments"("store_id", "order_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "shipments_store_id_status_updated_at_idx" ON "shipments"("store_id", "status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_store_id_id_key" ON "shipments"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_store_id_id_order_id_key" ON "shipments"("store_id", "id", "order_id");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_store_id_channel_id_client_order_code_key" ON "shipments"("store_id", "channel_id", "client_order_code");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_store_id_channel_id_provider_shipment_id_key" ON "shipments"("store_id", "channel_id", "provider_shipment_id");

-- CreateIndex
CREATE INDEX "shipment_items_store_id_order_id_order_item_id_idx" ON "shipment_items"("store_id", "order_id", "order_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_items_store_id_id_key" ON "shipment_items"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_items_store_id_shipment_id_order_item_id_key" ON "shipment_items"("store_id", "shipment_id", "order_item_id");

-- CreateIndex
CREATE INDEX "tracking_events_store_id_shipment_id_occurred_at_id_idx" ON "tracking_events"("store_id", "shipment_id", "occurred_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tracking_events_store_id_id_key" ON "tracking_events"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tracking_events_store_id_shipment_id_provider_event_key_key" ON "tracking_events"("store_id", "shipment_id", "provider_event_key");

-- CreateIndex
CREATE INDEX "shipping_operations_store_id_order_id_created_at_idx" ON "shipping_operations"("store_id", "order_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "shipping_operations_store_id_status_next_attempt_at_id_idx" ON "shipping_operations"("store_id", "status", "next_attempt_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "shipping_operations_store_id_id_key" ON "shipping_operations"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "shipping_operations_store_id_channel_id_operation_type_idem_key" ON "shipping_operations"("store_id", "channel_id", "operation_type", "idempotency_key_hash");

-- CreateIndex
CREATE INDEX "outbox_messages_store_id_status_available_at_id_idx" ON "outbox_messages"("store_id", "status", "available_at", "id");

-- CreateIndex
CREATE INDEX "outbox_messages_store_id_lease_expires_at_idx" ON "outbox_messages"("store_id", "lease_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_messages_store_id_id_key" ON "outbox_messages"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_messages_store_id_idempotency_key_key" ON "outbox_messages"("store_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "inbox_messages_store_id_status_received_at_id_idx" ON "inbox_messages"("store_id", "status", "received_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inbox_messages_store_id_id_key" ON "inbox_messages"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inbox_messages_source_channel_id_environment_external_messa_key" ON "inbox_messages"("source", "channel_id", "environment", "external_message_key");

-- CreateIndex
CREATE UNIQUE INDEX "order_items_store_id_order_id_id_key" ON "order_items"("store_id", "order_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "store_zalo_apps_store_id_environment_mini_app_id_key" ON "store_zalo_apps"("store_id", "environment", "mini_app_id");

-- AddForeignKey
ALTER TABLE "store_payment_channels" ADD CONSTRAINT "store_payment_channels_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_payment_channels" ADD CONSTRAINT "store_payment_channels_store_id_deployment_environment_che_fkey" FOREIGN KEY ("store_id", "deployment_environment", "checkout_app_id") REFERENCES "store_zalo_apps"("store_id", "environment", "mini_app_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_shipping_channels" ADD CONSTRAINT "store_shipping_channels_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_store_id_order_id_fkey" FOREIGN KEY ("store_id", "order_id") REFERENCES "orders"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_store_id_channel_id_fkey" FOREIGN KEY ("store_id", "channel_id") REFERENCES "store_payment_channels"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transitions" ADD CONSTRAINT "payment_transitions_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transitions" ADD CONSTRAINT "payment_transitions_store_id_payment_attempt_id_fkey" FOREIGN KEY ("store_id", "payment_attempt_id") REFERENCES "payment_attempts"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_callbacks" ADD CONSTRAINT "provider_callbacks_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_store_id_order_id_fkey" FOREIGN KEY ("store_id", "order_id") REFERENCES "orders"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_store_id_payment_attempt_id_order_id_fkey" FOREIGN KEY ("store_id", "payment_attempt_id", "order_id") REFERENCES "payment_attempts"("store_id", "id", "order_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_transitions" ADD CONSTRAINT "refund_transitions_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_transitions" ADD CONSTRAINT "refund_transitions_store_id_refund_id_fkey" FOREIGN KEY ("store_id", "refund_id") REFERENCES "refunds"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipping_quotes" ADD CONSTRAINT "shipping_quotes_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipping_quotes" ADD CONSTRAINT "shipping_quotes_store_id_order_id_fkey" FOREIGN KEY ("store_id", "order_id") REFERENCES "orders"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipping_quotes" ADD CONSTRAINT "shipping_quotes_store_id_channel_id_fkey" FOREIGN KEY ("store_id", "channel_id") REFERENCES "store_shipping_channels"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_store_id_order_id_fkey" FOREIGN KEY ("store_id", "order_id") REFERENCES "orders"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_store_id_warehouse_id_fkey" FOREIGN KEY ("store_id", "warehouse_id") REFERENCES "warehouses"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_store_id_channel_id_fkey" FOREIGN KEY ("store_id", "channel_id") REFERENCES "store_shipping_channels"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_items" ADD CONSTRAINT "shipment_items_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_items" ADD CONSTRAINT "shipment_items_store_id_shipment_id_order_id_fkey" FOREIGN KEY ("store_id", "shipment_id", "order_id") REFERENCES "shipments"("store_id", "id", "order_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_items" ADD CONSTRAINT "shipment_items_store_id_order_id_order_item_id_fkey" FOREIGN KEY ("store_id", "order_id", "order_item_id") REFERENCES "order_items"("store_id", "order_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracking_events" ADD CONSTRAINT "tracking_events_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracking_events" ADD CONSTRAINT "tracking_events_store_id_shipment_id_fkey" FOREIGN KEY ("store_id", "shipment_id") REFERENCES "shipments"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipping_operations" ADD CONSTRAINT "shipping_operations_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipping_operations" ADD CONSTRAINT "shipping_operations_store_id_order_id_fkey" FOREIGN KEY ("store_id", "order_id") REFERENCES "orders"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipping_operations" ADD CONSTRAINT "shipping_operations_store_id_shipment_id_order_id_fkey" FOREIGN KEY ("store_id", "shipment_id", "order_id") REFERENCES "shipments"("store_id", "id", "order_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipping_operations" ADD CONSTRAINT "shipping_operations_store_id_channel_id_fkey" FOREIGN KEY ("store_id", "channel_id") REFERENCES "store_shipping_channels"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbox_messages" ADD CONSTRAINT "inbox_messages_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Cross-table references not directly expressible by Prisma's relation model.
ALTER TABLE "shipments"
  ADD CONSTRAINT "shipments_store_id_created_operation_id_fkey"
    FOREIGN KEY ("store_id", "created_operation_id")
    REFERENCES "shipping_operations"("store_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "shipments_store_id_cancelled_operation_id_fkey"
    FOREIGN KEY ("store_id", "cancelled_operation_id")
    REFERENCES "shipping_operations"("store_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- Channel configuration remains disabled until a separate audited activation command succeeds.
ALTER TABLE "store_payment_channels"
  ADD CONSTRAINT "store_payment_channels_configuration_check" CHECK (
    "version" >= 1
    AND "payment_window_seconds" BETWEEN 60 AND 900
    AND "secret_fingerprint" ~ '^[0-9a-f]{64}$'
    AND "private_key_secret_ref" ~ '^[a-z][a-z0-9+.-]{1,31}:[^[:space:]]+$'
    AND btrim("key_version") <> ''
    AND btrim("checkout_app_id") <> ''
    AND (
      ("provider_environment" = 'SANDBOX' AND "method_code" = 'ZALOPAY_SANDBOX')
      OR ("provider_environment" = 'PRODUCTION' AND "method_code" = 'ZALOPAY')
    )
    AND ("deployment_environment" = 'PRODUCTION' OR "provider_environment" = 'SANDBOX')
    AND ("status" <> 'ACTIVE' OR "merchant_reference" IS NOT NULL)
  );

ALTER TABLE "store_shipping_channels"
  ADD CONSTRAINT "store_shipping_channels_configuration_check" CHECK (
    "version" >= 1
    AND "secret_fingerprint" ~ '^[0-9a-f]{64}$'
    AND "token_secret_ref" ~ '^[a-z][a-z0-9+.-]{1,31}:[^[:space:]]+$'
    AND btrim("key_version") <> ''
    AND btrim("shop_id") <> ''
    AND (
      ("provider_environment" = 'SANDBOX' AND "origin_allowlist_key" = 'GHN_SANDBOX')
      OR ("provider_environment" = 'PRODUCTION' AND "origin_allowlist_key" = 'GHN_PRODUCTION')
    )
    AND ("webhook_path_token_hash" IS NULL OR octet_length("webhook_path_token_hash") = 32)
  );

CREATE UNIQUE INDEX "store_payment_channels_environment_secret_ref_key"
  ON "store_payment_channels"("provider_environment", "private_key_secret_ref");
CREATE UNIQUE INDEX "store_payment_channels_environment_fingerprint_key"
  ON "store_payment_channels"("provider_environment", "secret_fingerprint");
CREATE UNIQUE INDEX "store_shipping_channels_environment_secret_ref_key"
  ON "store_shipping_channels"("provider_environment", "token_secret_ref");
CREATE UNIQUE INDEX "store_shipping_channels_environment_fingerprint_key"
  ON "store_shipping_channels"("provider_environment", "secret_fingerprint");

ALTER TABLE "payment_attempts"
  ADD CONSTRAINT "payment_attempts_values_check" CHECK (
    "version" >= 1
    AND "attempt_sequence" >= 1
    AND "amount_vnd" BETWEEN 1 AND 9007199254740991
    AND "currency" = 'VND'
    AND "expires_at" > "created_at"
    AND "create_idempotency_key_hash" ~ '^[0-9a-f]{64}$'
    AND ("launch_nonce_hash" IS NULL OR "launch_nonce_hash" ~ '^[0-9a-f]{64}$')
    AND ("launch_payload_hash" IS NULL OR "launch_payload_hash" ~ '^[0-9a-f]{64}$')
    AND ("provider_order_id" IS NULL OR btrim("provider_order_id") <> '')
    AND ("provider_transaction_id" IS NULL OR btrim("provider_transaction_id") <> '')
    AND ("status" <> 'PROVIDER_PENDING' OR "provider_order_id" IS NOT NULL)
    AND (
      "status" <> 'SUCCEEDED'
      OR (
        "succeeded_at" IS NOT NULL
        AND "provider_order_id" IS NOT NULL
        AND "provider_transaction_id" IS NOT NULL
      )
    )
    AND ("status" <> 'FAILED' OR "failed_at" IS NOT NULL)
    AND ("status" <> 'CANCELLED' OR "cancelled_at" IS NOT NULL)
    AND ("status" <> 'EXPIRED' OR "expired_at" IS NOT NULL)
    AND ("status" <> 'REVIEW_REQUIRED' OR "review_required_at" IS NOT NULL)
  );

CREATE UNIQUE INDEX "payment_attempts_one_active_per_order_key"
  ON "payment_attempts"("store_id", "order_id")
  WHERE "status" IN ('CREATED', 'PROVIDER_PENDING');

ALTER TABLE "provider_callbacks"
  ADD CONSTRAINT "provider_callbacks_values_check" CHECK (
    "version" >= 1
    AND "attempt_count" >= 0
    AND "event_digest" ~ '^[0-9a-f]{64}$'
    AND "payload_digest" ~ '^[0-9a-f]{64}$'
    AND ("external_event_id" IS NULL OR btrim("external_event_id") <> '')
    AND (
      ("signature_status" = 'VERIFIED' AND "trust" = 'AUTHENTICATED_FACT')
      OR ("signature_status" = 'NOT_AVAILABLE' AND "trust" = 'UNVERIFIED_HINT')
      OR ("signature_status" = 'INVALID' AND "trust" = 'UNTRUSTED')
    )
    AND ("processing_status" <> 'RETRY_PENDING' OR "next_attempt_at" IS NOT NULL)
    AND (
      "processing_status" NOT IN ('PROCESSED', 'REJECTED')
      OR "completed_at" IS NOT NULL
    )
  );

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_values_check" CHECK (
    "version" >= 1
    AND "amount_vnd" BETWEEN 1 AND 9007199254740991
    AND "idempotency_key_hash" ~ '^[0-9a-f]{64}$'
    AND btrim("reason") <> ''
    AND ("provider_refund_id" IS NULL OR btrim("provider_refund_id") <> '')
    AND ("status" <> 'SUCCEEDED' OR "succeeded_at" IS NOT NULL)
    AND ("status" <> 'FAILED' OR "failed_at" IS NOT NULL)
    AND ("status" <> 'REVIEW_REQUIRED' OR "review_required_at" IS NOT NULL)
  );

ALTER TABLE "shipping_quotes"
  ADD CONSTRAINT "shipping_quotes_values_check" CHECK (
    "request_hash" ~ '^[0-9a-f]{64}$'
    AND btrim("service_code") <> ''
    AND "base_fee_vnd" BETWEEN 0 AND 9007199254740991
    AND "insurance_fee_vnd" BETWEEN 0 AND 9007199254740991
    AND "cod_fee_vnd" BETWEEN 0 AND 9007199254740991
    AND "remote_fee_vnd" BETWEEN 0 AND 9007199254740991
    AND "other_fee_vnd" BETWEEN 0 AND 9007199254740991
    AND "total_fee_vnd" = "base_fee_vnd" + "insurance_fee_vnd" + "cod_fee_vnd"
      + "remote_fee_vnd" + "other_fee_vnd"
    AND "expires_at" > "created_at"
  );

ALTER TABLE "shipments"
  ADD CONSTRAINT "shipments_values_check" CHECK (
    "version" >= 1
    AND "cod_amount_vnd" BETWEEN 0 AND 9007199254740991
    AND btrim("client_order_code") <> ''
    AND btrim("service_code") <> ''
    AND jsonb_typeof("parcel_snapshot") = 'object'
    AND ("label_metadata" IS NULL OR jsonb_typeof("label_metadata") = 'object')
    AND ("provider_shipment_id" IS NULL OR btrim("provider_shipment_id") <> '')
    AND ("status" <> 'DELIVERED' OR "delivered_at" IS NOT NULL)
    AND ("status" <> 'RETURNED' OR "returned_at" IS NOT NULL)
    AND ("status" NOT IN ('IN_TRANSIT', 'OUT_FOR_DELIVERY') OR "picked_up_at" IS NOT NULL)
  );

CREATE UNIQUE INDEX "shipments_one_active_per_order_key"
  ON "shipments"("store_id", "order_id")
  WHERE "status" NOT IN ('DELIVERED', 'RETURNED', 'CANCELLED');

ALTER TABLE "shipment_items"
  ADD CONSTRAINT "shipment_items_quantity_check" CHECK ("quantity" > 0);

ALTER TABLE "tracking_events"
  ADD CONSTRAINT "tracking_events_values_check" CHECK (
    btrim("provider_event_key") <> ''
    AND btrim("provider_status") <> ''
    AND "message_key" ~ '^[a-z0-9]+([._-][a-z0-9]+)*$'
  );

ALTER TABLE "shipping_operations"
  ADD CONSTRAINT "shipping_operations_values_check" CHECK (
    "version" >= 1
    AND "attempt_count" >= 0
    AND "idempotency_key_hash" ~ '^[0-9a-f]{64}$'
    AND "request_hash" ~ '^[0-9a-f]{64}$'
    AND ("status" <> 'PROCESSING' OR "next_attempt_at" IS NULL)
  );

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

ALTER TABLE "inbox_messages"
  ADD CONSTRAINT "inbox_messages_values_check" CHECK (
    "version" >= 1
    AND btrim("source") <> ''
    AND btrim("external_message_key") <> ''
    AND "payload_digest" ~ '^[0-9a-f]{64}$'
    AND ("status" <> 'PROCESSING' OR "processing_started_at" IS NOT NULL)
    AND ("status" NOT IN ('COMPLETED', 'REJECTED') OR "completed_at" IS NOT NULL)
  );

-- An ACTIVE payment channel requires the matching Mini App to be enabled.
CREATE OR REPLACE FUNCTION "app_security"."validate_payment_channel_activation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = 'ACTIVE' AND NOT EXISTS (
    SELECT 1
    FROM "store_zalo_apps" AS app
    WHERE app."store_id" = NEW."store_id"
      AND app."environment" = NEW."deployment_environment"
      AND app."mini_app_id" = NEW."checkout_app_id"
      AND app."enabled"
  ) THEN
    RAISE EXCEPTION 'payment channel requires an enabled matching Mini App'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "store_payment_channels_activation_guard"
  BEFORE INSERT OR UPDATE OF "status", "store_id", "deployment_environment", "checkout_app_id"
  ON "store_payment_channels"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_payment_channel_activation"();

-- Polymorphic callback and inbox references are validated against exactly one scoped channel.
CREATE OR REPLACE FUNCTION "app_security"."validate_provider_callback_channel"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE valid_reference boolean;
BEGIN
  IF NEW."channel_kind" = 'PAYMENT' THEN
    SELECT EXISTS (
      SELECT 1 FROM "store_payment_channels" AS channel
      WHERE channel."store_id" = NEW."store_id"
        AND channel."id" = NEW."channel_id"
        AND channel."provider_environment" = NEW."environment"
        AND channel."provider_code"::text = NEW."provider_code"
    ) INTO valid_reference;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM "store_shipping_channels" AS channel
      WHERE channel."store_id" = NEW."store_id"
        AND channel."id" = NEW."channel_id"
        AND channel."provider_environment" = NEW."environment"
        AND channel."provider_code"::text = NEW."provider_code"
    ) INTO valid_reference;
  END IF;
  IF NOT valid_reference THEN
    RAISE EXCEPTION 'provider callback channel reference is invalid'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "provider_callbacks_channel_guard"
  BEFORE INSERT OR UPDATE OF "store_id", "channel_kind", "channel_id", "provider_code", "environment"
  ON "provider_callbacks"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_provider_callback_channel"();

CREATE OR REPLACE FUNCTION "app_security"."validate_inbox_channel"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE valid_reference boolean;
BEGIN
  IF NEW."source" = 'ZALO_CHECKOUT_ZALOPAY' THEN
    SELECT EXISTS (
      SELECT 1 FROM "store_payment_channels" AS channel
      WHERE channel."store_id" = NEW."store_id"
        AND channel."id" = NEW."channel_id"
        AND channel."provider_environment" = NEW."environment"
    ) INTO valid_reference;
  ELSIF NEW."source" = 'GHN' THEN
    SELECT EXISTS (
      SELECT 1 FROM "store_shipping_channels" AS channel
      WHERE channel."store_id" = NEW."store_id"
        AND channel."id" = NEW."channel_id"
        AND channel."provider_environment" = NEW."environment"
    ) INTO valid_reference;
  ELSE
    valid_reference := false;
  END IF;
  IF NOT valid_reference THEN
    RAISE EXCEPTION 'inbox channel reference is invalid' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "inbox_messages_channel_guard"
  BEFORE INSERT OR UPDATE OF "store_id", "source", "channel_id", "environment"
  ON "inbox_messages"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."validate_inbox_channel"();

-- Serialize refund reservations on the successful payment attempt to prevent over-refund.
CREATE OR REPLACE FUNCTION "app_security"."enforce_refund_capacity"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE captured_amount bigint;
DECLARE captured_order uuid;
DECLARE captured_status "payment_attempt_status";
DECLARE reserved_amount bigint;
BEGIN
  SELECT attempt."amount_vnd", attempt."order_id", attempt."status"
    INTO captured_amount, captured_order, captured_status
  FROM "payment_attempts" AS attempt
  WHERE attempt."store_id" = NEW."store_id"
    AND attempt."id" = NEW."payment_attempt_id"
  FOR UPDATE;

  IF NOT FOUND OR captured_order <> NEW."order_id" OR captured_status <> 'SUCCEEDED' THEN
    RAISE EXCEPTION 'refund requires a successful matching payment attempt'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."status" IN ('REQUESTED', 'PROCESSING', 'SUCCEEDED') THEN
    SELECT COALESCE(sum(refund."amount_vnd"), 0)
      INTO reserved_amount
    FROM "refunds" AS refund
    WHERE refund."store_id" = NEW."store_id"
      AND refund."payment_attempt_id" = NEW."payment_attempt_id"
      AND refund."id" <> NEW."id"
      AND refund."status" IN ('REQUESTED', 'PROCESSING', 'SUCCEEDED');

    IF reserved_amount + NEW."amount_vnd" > captured_amount THEN
      RAISE EXCEPTION 'refund amount exceeds captured payment amount'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "refunds_capacity_guard"
  BEFORE INSERT OR UPDATE OF "store_id", "order_id", "payment_attempt_id", "amount_vnd", "status"
  ON "refunds"
  FOR EACH ROW EXECUTE FUNCTION "app_security"."enforce_refund_capacity"();

-- Transition, quote, item and tracking rows are immutable facts.
CREATE OR REPLACE FUNCTION "app_security"."reject_m5_append_only_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '42501';
END
$$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'payment_transitions', 'refund_transitions', 'shipping_quotes',
    'shipment_items', 'tracking_events'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_security.reject_m5_append_only_mutation()',
      table_name || '_append_only', table_name
    );
  END LOOP;
END
$$;

CREATE OR REPLACE FUNCTION "app_security"."reject_m5_fact_delete"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% cannot be deleted', TG_TABLE_NAME USING ERRCODE = '42501';
END
$$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'store_payment_channels', 'store_shipping_channels', 'payment_attempts',
    'provider_callbacks', 'refunds', 'shipments', 'shipping_operations',
    'outbox_messages', 'inbox_messages'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_security.reject_m5_fact_delete()',
      table_name || '_no_delete', table_name
    );
  END LOOP;
END
$$;

-- Every M5 table fails closed without a transaction-local store context.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'store_payment_channels', 'store_shipping_channels', 'payment_attempts',
    'payment_transitions', 'provider_callbacks', 'refunds', 'refund_transitions',
    'shipping_quotes', 'shipments', 'shipment_items', 'tracking_events',
    'shipping_operations', 'outbox_messages', 'inbox_messages'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (store_id = app_security.current_store_id()) WITH CHECK (store_id = app_security.current_store_id())',
      table_name || '_tenant_isolation', table_name
    );
  END LOOP;
END
$$;

REVOKE ALL ON FUNCTION "app_security"."validate_payment_channel_activation"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "app_security"."validate_provider_callback_channel"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "app_security"."validate_inbox_channel"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "app_security"."enforce_refund_capacity"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "app_security"."reject_m5_append_only_mutation"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "app_security"."reject_m5_fact_delete"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  "app_security"."validate_payment_channel_activation"(),
  "app_security"."validate_provider_callback_channel"(),
  "app_security"."validate_inbox_channel"(),
  "app_security"."enforce_refund_capacity"(),
  "app_security"."reject_m5_append_only_mutation"(),
  "app_security"."reject_m5_fact_delete"()
TO zalo_shop_runtime;

GRANT SELECT, INSERT, UPDATE ON TABLE
  "store_payment_channels", "store_shipping_channels", "payment_attempts",
  "refunds", "shipments", "shipping_operations"
TO zalo_shop_runtime;
GRANT SELECT, INSERT ON TABLE
  "payment_transitions", "refund_transitions", "shipping_quotes",
  "shipment_items", "tracking_events"
TO zalo_shop_runtime;
GRANT SELECT, INSERT ON TABLE "provider_callbacks", "outbox_messages", "inbox_messages"
TO zalo_shop_runtime;
GRANT UPDATE (
  "processing_status", "attempt_count", "next_attempt_at", "last_error_code", "completed_at", "version"
) ON "provider_callbacks" TO zalo_shop_runtime;
GRANT UPDATE (
  "status", "available_at", "lease_owner", "lease_expires_at", "attempt_count",
  "last_error_code", "completed_at", "version", "updated_at"
) ON "outbox_messages" TO zalo_shop_runtime;
GRANT UPDATE (
  "status", "processing_started_at", "completed_at", "error_code", "version"
) ON "inbox_messages" TO zalo_shop_runtime;
REVOKE DELETE ON TABLE
  "store_payment_channels", "store_shipping_channels", "payment_attempts",
  "payment_transitions", "provider_callbacks", "refunds", "refund_transitions",
  "shipping_quotes", "shipments", "shipment_items", "tracking_events",
  "shipping_operations", "outbox_messages", "inbox_messages"
FROM zalo_shop_runtime;
