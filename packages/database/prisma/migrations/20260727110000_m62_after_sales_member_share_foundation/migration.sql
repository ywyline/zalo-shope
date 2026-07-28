-- CreateEnum
CREATE TYPE "after_sale_type" AS ENUM ('REFUND_ONLY', 'RETURN_REFUND', 'EXCHANGE', 'MERCHANT_REFUND');

-- CreateEnum
CREATE TYPE "after_sale_status" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'REJECTED', 'CANCELLED', 'RETURN_PENDING', 'RETURN_IN_TRANSIT', 'INSPECTION_PENDING', 'REFUND_PENDING', 'REFUND_PROCESSING', 'REFUNDED', 'EXCHANGE_PENDING', 'EXCHANGE_IN_TRANSIT', 'REVIEW_REQUIRED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "after_sale_source" AS ENUM ('MEMBER', 'ADMIN');

-- CreateEnum
CREATE TYPE "after_sale_policy_status" AS ENUM ('DRAFT', 'ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "after_sale_policy_target_type" AS ENUM ('PRODUCT', 'CATEGORY', 'STORE_DEFAULT');

-- CreateEnum
CREATE TYPE "return_shipping_payer" AS ENUM ('BUYER', 'MERCHANT', 'CONDITIONAL');

-- CreateEnum
CREATE TYPE "after_sale_inspection_disposition" AS ENUM ('PENDING', 'RESTOCK_SELLABLE', 'QUARANTINE', 'SCRAP', 'RETURN_TO_MEMBER');

-- CreateEnum
CREATE TYPE "after_sale_operation_status" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'REVIEW_REQUIRED');

-- CreateEnum
CREATE TYPE "after_sale_evidence_status" AS ENUM ('PENDING', 'READY_UNCLAIMED', 'READY', 'FAILED', 'QUARANTINED', 'DELETION_PENDING', 'DELETED', 'DELETE_FAILED');

-- CreateEnum
CREATE TYPE "after_sale_settlement_method" AS ENUM ('ONLINE_ORIGINAL', 'COD_OFFLINE', 'NO_PAYOUT');

-- CreateEnum
CREATE TYPE "after_sale_settlement_status" AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'REVIEW_REQUIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "after_sale_inventory_action_type" AS ENUM ('RESTOCK_SELLABLE', 'QUARANTINE', 'SCRAP', 'RETURN_TO_MEMBER');

-- CreateEnum
CREATE TYPE "after_sale_return_shipment_status" AS ENUM ('SUBMITTED', 'IN_TRANSIT', 'DELIVERED', 'REJECTED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "exchange_fulfillment_status" AS ENUM ('PENDING', 'RESERVED', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED', 'REVIEW_REQUIRED');

-- CreateEnum
CREATE TYPE "after_sale_legacy_decision_type" AS ENUM ('APPROVE', 'REJECT');

-- CreateEnum
CREATE TYPE "privacy_request_type" AS ENUM ('ACCESS', 'CORRECTION', 'DELETION', 'ANONYMIZATION', 'ACCOUNT_CLOSURE');

-- CreateEnum
CREATE TYPE "privacy_request_status" AS ENUM ('SUBMITTED', 'UNDER_REVIEW', 'ACTION_REQUIRED', 'IN_PROGRESS', 'COMPLETED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "share_target_type" AS ENUM ('STORE', 'BRAND', 'CATEGORY', 'PRODUCT', 'PROMOTION', 'COUPON');

-- CreateEnum
CREATE TYPE "share_interaction_event" AS ENUM ('INITIATED', 'COMPLETED', 'CANCELLED', 'OPENED', 'FALLBACK_OPENED');

-- CreateEnum
CREATE TYPE "shipment_purpose" AS ENUM ('ORDER_OUTBOUND', 'AFTER_SALE_RETURN', 'EXCHANGE_OUTBOUND');

-- AlterTable
ALTER TABLE "shipments" ADD COLUMN     "after_sale_id" UUID,
ADD COLUMN     "purpose" "shipment_purpose" NOT NULL DEFAULT 'ORDER_OUTBOUND';

-- CreateTable
CREATE TABLE "store_after_sale_settings" (
    "store_id" UUID NOT NULL,
    "enforce_policy_snapshots" BOOLEAN NOT NULL DEFAULT false,
    "default_policy_id" UUID,
    "current_version_id" UUID,
    "readiness_checked_at" TIMESTAMPTZ(6),
    "readiness_ready_at" TIMESTAMPTZ(6),
    "readiness_hash" CHAR(64),
    "readiness_checked_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "store_after_sale_settings_pkey" PRIMARY KEY ("store_id")
);

-- CreateTable
CREATE TABLE "after_sale_policies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "status" "after_sale_policy_status" NOT NULL DEFAULT 'DRAFT',
    "category_id" UUID,
    "current_version_id" UUID,
    "draft_payload" JSONB NOT NULL,
    "draft_hash" CHAR(64) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "after_sale_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "after_sale_policy_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "policy_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "effective_at" TIMESTAMPTZ(6) NOT NULL,
    "request_window_days" INTEGER NOT NULL,
    "return_window_days" INTEGER NOT NULL,
    "allowed_types" "after_sale_type"[],
    "return_shipping_payer" "return_shipping_payer" NOT NULL,
    "unopened_required" BOOLEAN NOT NULL,
    "hygiene_restricted" BOOLEAN NOT NULL,
    "damaged_exception" BOOLEAN NOT NULL,
    "wrong_item_exception" BOOLEAN NOT NULL,
    "defect_exception" BOOLEAN NOT NULL,
    "exchange_same_product_only" BOOLEAN NOT NULL DEFAULT true,
    "exchange_attribute_code" VARCHAR(64),
    "condition_rules" JSONB NOT NULL,
    "payload" JSONB NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "published_by" UUID NOT NULL,
    "published_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "after_sale_policy_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "after_sale_policy_localizations" (
    "store_id" UUID NOT NULL,
    "policy_version_id" UUID NOT NULL,
    "locale" "Locale" NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "summary" VARCHAR(1000) NOT NULL,
    "buyer_instructions" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "after_sale_policy_localizations_pkey" PRIMARY KEY ("store_id","policy_version_id","locale")
);

-- CreateTable
CREATE TABLE "after_sale_policy_draft_products" (
    "store_id" UUID NOT NULL,
    "policy_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "after_sale_policy_draft_products_pkey" PRIMARY KEY ("store_id","policy_id","product_id")
);

-- CreateTable
CREATE TABLE "after_sale_policy_version_assignments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "policy_id" UUID NOT NULL,
    "policy_version_id" UUID NOT NULL,
    "target_type" "after_sale_policy_target_type" NOT NULL,
    "product_id" UUID,
    "category_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "after_sale_policy_version_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "after_sale_active_policy_assignments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "target_type" "after_sale_policy_target_type" NOT NULL,
    "product_id" UUID,
    "category_id" UUID,
    "policy_id" UUID NOT NULL,
    "policy_version_id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "after_sale_active_policy_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_item_after_sale_policy_snapshots" (
    "store_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "policy_id" UUID NOT NULL,
    "policy_version_id" UUID NOT NULL,
    "policy_code" VARCHAR(64) NOT NULL,
    "policy_version_number" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "captured_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_item_after_sale_policy_snapshots_pkey" PRIMARY KEY ("store_id","order_item_id")
);

-- CreateTable
CREATE TABLE "after_sales" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "public_case_number" VARCHAR(64) NOT NULL,
    "type" "after_sale_type" NOT NULL,
    "status" "after_sale_status" NOT NULL DEFAULT 'PENDING_REVIEW',
    "source" "after_sale_source" NOT NULL,
    "reason_code" VARCHAR(64) NOT NULL,
    "reason_detail_ciphertext" TEXT,
    "review_resume_status" "after_sale_status",
    "review_reason" VARCHAR(500),
    "policy_snapshot" JSONB,
    "policy_hash" CHAR(64),
    "legacy_policy_review" BOOLEAN NOT NULL DEFAULT false,
    "return_deadline_at" TIMESTAMPTZ(6),
    "return_expired_at" TIMESTAMPTZ(6),
    "requested_item_vnd" BIGINT NOT NULL DEFAULT 0,
    "requested_shipping_vnd" BIGINT NOT NULL DEFAULT 0,
    "requested_other_vnd" BIGINT NOT NULL DEFAULT 0,
    "requested_total_vnd" BIGINT NOT NULL DEFAULT 0,
    "approved_item_vnd" BIGINT NOT NULL DEFAULT 0,
    "approved_shipping_vnd" BIGINT NOT NULL DEFAULT 0,
    "approved_other_vnd" BIGINT NOT NULL DEFAULT 0,
    "approved_total_vnd" BIGINT NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL DEFAULT 'VND',
    "version" INTEGER NOT NULL DEFAULT 1,
    "idempotency_key_hash" CHAR(64) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "initiated_by" UUID NOT NULL,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "correlation_id" VARCHAR(128) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "after_sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "after_sale_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "after_sale_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "requested_quantity" INTEGER NOT NULL,
    "approved_quantity" INTEGER NOT NULL DEFAULT 0,
    "received_quantity" INTEGER NOT NULL DEFAULT 0,
    "accepted_quantity" INTEGER NOT NULL DEFAULT 0,
    "rejected_quantity" INTEGER NOT NULL DEFAULT 0,
    "restockable_quantity" INTEGER NOT NULL DEFAULT 0,
    "restored_quantity" INTEGER NOT NULL DEFAULT 0,
    "requested_item_vnd" BIGINT NOT NULL,
    "approved_item_vnd" BIGINT NOT NULL DEFAULT 0,
    "sku_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "sku_code" VARCHAR(64) NOT NULL,
    "product_name" VARCHAR(240) NOT NULL,
    "option_snapshot" JSONB NOT NULL,
    "unit_price_vnd" BIGINT NOT NULL,
    "condition" VARCHAR(64),
    "disposition" "after_sale_inspection_disposition",
    "inspection_version" INTEGER NOT NULL DEFAULT 0,
    "inspected_by" UUID,
    "replacement_sku_id" UUID,
    "replacement_quantity" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "after_sale_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "after_sale_transitions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "after_sale_id" UUID NOT NULL,
    "from_status" "after_sale_status",
    "to_status" "after_sale_status" NOT NULL,
    "event" VARCHAR(64) NOT NULL,
    "actor_type" "AuditActorType" NOT NULL,
    "actor_id" UUID NOT NULL,
    "reason" VARCHAR(500),
    "correlation_id" VARCHAR(128) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "after_sale_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "after_sale_operations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "after_sale_id" UUID NOT NULL,
    "operation" VARCHAR(64) NOT NULL,
    "idempotency_key_hash" CHAR(64) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "status" "after_sale_operation_status" NOT NULL DEFAULT 'PENDING',
    "result_summary" JSONB,
    "error_code" VARCHAR(64),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "after_sale_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "after_sale_legacy_decisions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "after_sale_id" UUID NOT NULL,
    "decision" "after_sale_legacy_decision_type" NOT NULL,
    "admin_id" UUID NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "policy_basis_ciphertext" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "decided_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "after_sale_legacy_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "after_sale_order_allocations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "after_sale_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "shipping_fee_vnd" BIGINT NOT NULL DEFAULT 0,
    "remote_surcharge_vnd" BIGINT NOT NULL DEFAULT 0,
    "other_vnd" BIGINT NOT NULL DEFAULT 0,
    "allocated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "after_sale_order_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "after_sale_inspections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "after_sale_id" UUID NOT NULL,
    "inspection_version" INTEGER NOT NULL,
    "admin_id" UUID NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "after_sale_inspections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "after_sale_inspection_allocations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "inspection_id" UUID NOT NULL,
    "after_sale_id" UUID NOT NULL,
    "after_sale_item_id" UUID NOT NULL,
    "disposition" "after_sale_inspection_disposition" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "after_sale_inspection_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "after_sale_evidence_files" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "upload_session_id" UUID NOT NULL,
    "after_sale_id" UUID,
    "object_key" TEXT,
    "derivative_object_keys" JSONB,
    "scan_temporary_object_key" TEXT,
    "mime_type" VARCHAR(64) NOT NULL,
    "byte_size" BIGINT NOT NULL,
    "checksum_sha256" CHAR(64) NOT NULL,
    "original_filename" VARCHAR(255),
    "status" "after_sale_evidence_status" NOT NULL DEFAULT 'PENDING',
    "scan_result_code" VARCHAR(64),
    "claim_deadline_at" TIMESTAMPTZ(6),
    "claimed_at" TIMESTAMPTZ(6),
    "retention_deadline_at" TIMESTAMPTZ(6),
    "legal_hold_active" BOOLEAN NOT NULL DEFAULT false,
    "held_at" TIMESTAMPTZ(6),
    "held_by" UUID,
    "hold_reason" VARCHAR(500),
    "delete_attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_delete_attempt_at" TIMESTAMPTZ(6),
    "delete_error_code" VARCHAR(64),
    "deleted_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "after_sale_evidence_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "after_sale_evidence_transitions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "evidence_file_id" UUID NOT NULL,
    "from_status" "after_sale_evidence_status",
    "to_status" "after_sale_evidence_status" NOT NULL,
    "event" VARCHAR(64) NOT NULL,
    "actor_type" "AuditActorType" NOT NULL,
    "actor_id" UUID NOT NULL,
    "error_code" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "after_sale_evidence_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "after_sale_settlements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "after_sale_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "payment_attempt_id" UUID,
    "public_settlement_number" VARCHAR(64) NOT NULL,
    "method" "after_sale_settlement_method" NOT NULL,
    "status" "after_sale_settlement_status" NOT NULL DEFAULT 'PENDING',
    "amount_vnd" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'VND',
    "idempotency_key_hash" CHAR(64) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "requested_by" UUID NOT NULL,
    "confirmed_by" UUID,
    "transfer_reference_digest" CHAR(64),
    "transfer_evidence_ciphertext" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "after_sale_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "after_sale_refunds" (
    "store_id" UUID NOT NULL,
    "settlement_id" UUID NOT NULL,
    "after_sale_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "payment_attempt_id" UUID NOT NULL,
    "refund_id" UUID NOT NULL,
    "amount_vnd" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "after_sale_refunds_pkey" PRIMARY KEY ("store_id","settlement_id","refund_id")
);

-- CreateTable
CREATE TABLE "after_sale_inventory_actions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "after_sale_id" UUID NOT NULL,
    "after_sale_item_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "inspection_version" INTEGER NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "disposition" "after_sale_inspection_disposition" NOT NULL,
    "action_type" "after_sale_inventory_action_type" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "inventory_operation_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "after_sale_inventory_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "after_sale_return_shipments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "after_sale_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "carrier_name" VARCHAR(160) NOT NULL,
    "tracking_number_digest" CHAR(64) NOT NULL,
    "tracking_number_masked" VARCHAR(64) NOT NULL,
    "status" "after_sale_return_shipment_status" NOT NULL DEFAULT 'SUBMITTED',
    "submitted_by" UUID NOT NULL,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "received_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "after_sale_return_shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_fulfillments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "after_sale_id" UUID NOT NULL,
    "after_sale_item_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "replacement_sku_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "reservation_id" UUID,
    "outbound_shipment_id" UUID,
    "status" "exchange_fulfillment_status" NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "reserved_at" TIMESTAMPTZ(6),
    "shipped_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "exchange_fulfillments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_favorites" (
    "store_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_favorites_pkey" PRIMARY KEY ("store_id","member_id","product_id")
);

-- CreateTable
CREATE TABLE "member_product_views" (
    "store_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "first_viewed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_viewed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_product_views_pkey" PRIMARY KEY ("store_id","member_id","product_id")
);

-- CreateTable
CREATE TABLE "privacy_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "public_number" VARCHAR(64) NOT NULL,
    "type" "privacy_request_type" NOT NULL,
    "status" "privacy_request_status" NOT NULL DEFAULT 'SUBMITTED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "description_ciphertext" TEXT NOT NULL,
    "idempotency_key_hash" CHAR(64) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "privacy_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "privacy_request_transitions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "privacy_request_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "from_status" "privacy_request_status",
    "to_status" "privacy_request_status" NOT NULL,
    "event" VARCHAR(64) NOT NULL,
    "actor_type" "AuditActorType" NOT NULL,
    "actor_id" UUID NOT NULL,
    "reason" VARCHAR(500),
    "correlation_id" VARCHAR(128) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "privacy_request_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "share_links" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "short_code" VARCHAR(128) NOT NULL,
    "target_type" "share_target_type" NOT NULL,
    "locale" "Locale" NOT NULL,
    "source_code" VARCHAR(64),
    "brand_id" UUID,
    "category_id" UUID,
    "product_id" UUID,
    "promotion_id" UUID,
    "coupon_id" UUID,
    "verified_campaign_id" VARCHAR(128),
    "verified_promotion_id" UUID,
    "created_by_member_id" UUID,
    "mini_app_path" VARCHAR(512) NOT NULL,
    "attribution_token_digest" CHAR(64),
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "share_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "share_link_localizations" (
    "store_id" UUID NOT NULL,
    "share_link_id" UUID NOT NULL,
    "locale" "Locale" NOT NULL,
    "title" VARCHAR(240) NOT NULL,
    "summary" VARCHAR(500) NOT NULL,
    "published_image_object_key" TEXT NOT NULL,
    "source_media_id" UUID,
    "target_version" INTEGER NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "share_link_localizations_pkey" PRIMARY KEY ("store_id","share_link_id","locale")
);

-- CreateTable
CREATE TABLE "share_interactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "share_link_id" UUID NOT NULL,
    "member_id" UUID,
    "event" "share_interaction_event" NOT NULL,
    "source" VARCHAR(64) NOT NULL,
    "device_category" VARCHAR(32),
    "outcome_token_digest" CHAR(64),
    "outcome_expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "share_interactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "after_sale_policies_store_id_status_code_idx" ON "after_sale_policies"("store_id", "status", "code");

-- CreateIndex
CREATE UNIQUE INDEX "after_sale_policies_store_id_id_key" ON "after_sale_policies"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "after_sale_policies_store_id_code_key" ON "after_sale_policies"("store_id", "code");

-- CreateIndex
CREATE INDEX "after_sale_policy_versions_store_id_policy_id_published_at_idx" ON "after_sale_policy_versions"("store_id", "policy_id", "published_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "after_sale_policy_versions_store_id_id_key" ON "after_sale_policy_versions"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "after_sale_policy_versions_store_id_id_policy_id_key" ON "after_sale_policy_versions"("store_id", "id", "policy_id");

-- CreateIndex
CREATE UNIQUE INDEX "after_sale_policy_versions_store_id_policy_id_version_numbe_key" ON "after_sale_policy_versions"("store_id", "policy_id", "version_number");

-- CreateIndex
CREATE INDEX "after_sale_policy_version_assignments_store_id_policy_versi_idx" ON "after_sale_policy_version_assignments"("store_id", "policy_version_id", "target_type");

-- CreateIndex
CREATE UNIQUE INDEX "after_sale_policy_version_assignments_store_id_id_key" ON "after_sale_policy_version_assignments"("store_id", "id");

-- CreateIndex
CREATE INDEX "after_sale_active_policy_assignments_store_id_policy_id_idx" ON "after_sale_active_policy_assignments"("store_id", "policy_id");

-- CreateIndex
CREATE UNIQUE INDEX "after_sale_active_policy_assignments_store_id_id_key" ON "after_sale_active_policy_assignments"("store_id", "id");

-- CreateIndex
CREATE INDEX "order_item_after_sale_policy_snapshots_store_id_order_id_idx" ON "order_item_after_sale_policy_snapshots"("store_id", "order_id");

-- CreateIndex
CREATE UNIQUE INDEX "after_sales_public_case_number_key" ON "after_sales"("public_case_number");

-- CreateIndex
CREATE INDEX "after_sales_store_id_member_id_created_at_id_idx" ON "after_sales"("store_id", "member_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "after_sales_store_id_status_updated_at_id_idx" ON "after_sales"("store_id", "status", "updated_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "after_sales_store_id_id_key" ON "after_sales"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "after_sales_store_id_id_order_id_key" ON "after_sales"("store_id", "id", "order_id");

-- CreateIndex
CREATE UNIQUE INDEX "after_sales_store_id_id_member_id_key" ON "after_sales"("store_id", "id", "member_id");

-- CreateIndex
CREATE UNIQUE INDEX "after_sales_store_id_id_order_id_member_id_key" ON "after_sales"("store_id", "id", "order_id", "member_id");

-- CreateIndex
CREATE UNIQUE INDEX "after_sales_store_id_idempotency_key_hash_key" ON "after_sales"("store_id", "idempotency_key_hash");

-- CreateIndex
CREATE INDEX "after_sale_items_store_id_order_id_order_item_id_idx" ON "after_sale_items"("store_id", "order_id", "order_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "after_sale_items_store_id_id_key" ON "after_sale_items"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "after_sale_items_store_id_id_after_sale_id_key" ON "after_sale_items"("store_id", "id", "after_sale_id");

-- CreateIndex
CREATE UNIQUE INDEX "after_sale_items_store_id_after_sale_id_order_item_id_key" ON "after_sale_items"("store_id", "after_sale_id", "order_item_id");

-- CreateIndex
CREATE INDEX "after_sale_transitions_store_id_after_sale_id_created_at_id_idx" ON "after_sale_transitions"("store_id", "after_sale_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "after_sale_transitions_store_id_id_key" ON "after_sale_transitions"("store_id", "id");

-- CreateIndex
CREATE INDEX "after_sale_operations_store_id_after_sale_id_created_at_idx" ON "after_sale_operations"("store_id", "after_sale_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "after_sale_operations_store_id_id_key" ON "after_sale_operations"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "after_sale_operations_store_id_operation_idempotency_key_ha_key" ON "after_sale_operations"("store_id", "operation", "idempotency_key_hash");

-- CreateIndex
CREATE UNIQUE INDEX "after_sale_legacy_decisions_store_id_id_key" ON "after_sale_legacy_decisions"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "after_sale_legacy_decisions_store_id_after_sale_id_key" ON "after_sale_legacy_decisions"("store_id", "after_sale_id");

-- CreateIndex
CREATE UNIQUE INDEX "after_sale_order_allocations_store_id_id_key" ON "after_sale_order_allocations"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "after_sale_order_allocations_store_id_order_id_key" ON "after_sale_order_allocations"("store_id", "order_id");

-- CreateIndex
CREATE UNIQUE INDEX "after_sale_order_allocations_store_id_after_sale_id_order_i_key" ON "after_sale_order_allocations"("store_id", "after_sale_id", "order_id");

-- CreateIndex
CREATE UNIQUE INDEX "after_sale_inspections_store_id_id_key" ON "after_sale_inspections"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "after_sale_inspections_store_id_id_after_sale_id_key" ON "after_sale_inspections"("store_id", "id", "after_sale_id");

-- CreateIndex
CREATE UNIQUE INDEX "after_sale_inspections_store_id_after_sale_id_inspection_ve_key" ON "after_sale_inspections"("store_id", "after_sale_id", "inspection_version");

-- CreateIndex
CREATE INDEX "after_sale_inspection_allocations_store_id_after_sale_id_af_idx" ON "after_sale_inspection_allocations"("store_id", "after_sale_id", "after_sale_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "after_sale_inspection_allocations_store_id_id_key" ON "after_sale_inspection_allocations"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "after_sale_inspection_allocations_store_id_inspection_id_af_key" ON "after_sale_inspection_allocations"("store_id", "inspection_id", "after_sale_item_id", "disposition");

-- CreateIndex
CREATE UNIQUE INDEX "after_sale_evidence_files_object_key_key" ON "after_sale_evidence_files"("object_key");

-- CreateIndex
CREATE INDEX "after_sale_evidence_files_store_id_member_id_upload_session_idx" ON "after_sale_evidence_files"("store_id", "member_id", "upload_session_id");

-- CreateIndex
CREATE INDEX "after_sale_evidence_files_store_id_after_sale_id_created_at_idx" ON "after_sale_evidence_files"("store_id", "after_sale_id", "created_at");

-- CreateIndex
CREATE INDEX "after_sale_evidence_files_status_next_delete_attempt_at_idx" ON "after_sale_evidence_files"("status", "next_delete_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "after_sale_evidence_files_store_id_id_key" ON "after_sale_evidence_files"("store_id", "id");

-- CreateIndex
CREATE INDEX "after_sale_evidence_transitions_store_id_evidence_file_id_c_idx" ON "after_sale_evidence_transitions"("store_id", "evidence_file_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "after_sale_evidence_transitions_store_id_id_key" ON "after_sale_evidence_transitions"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "after_sale_settlements_public_settlement_number_key" ON "after_sale_settlements"("public_settlement_number");

-- CreateIndex
CREATE INDEX "after_sale_settlements_store_id_after_sale_id_status_idx" ON "after_sale_settlements"("store_id", "after_sale_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "after_sale_settlements_store_id_id_key" ON "after_sale_settlements"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "after_sale_settlements_store_id_id_after_sale_id_order_id_p_key" ON "after_sale_settlements"("store_id", "id", "after_sale_id", "order_id", "payment_attempt_id", "amount_vnd");

-- CreateIndex
CREATE UNIQUE INDEX "after_sale_settlements_store_id_method_idempotency_key_hash_key" ON "after_sale_settlements"("store_id", "method", "idempotency_key_hash");

-- CreateIndex
CREATE INDEX "after_sale_refunds_store_id_after_sale_id_idx" ON "after_sale_refunds"("store_id", "after_sale_id");

-- CreateIndex
CREATE UNIQUE INDEX "after_sale_refunds_store_id_refund_id_key" ON "after_sale_refunds"("store_id", "refund_id");

-- CreateIndex
CREATE INDEX "after_sale_inventory_actions_store_id_after_sale_id_idx" ON "after_sale_inventory_actions"("store_id", "after_sale_id");

-- CreateIndex
CREATE UNIQUE INDEX "after_sale_inventory_actions_store_id_id_key" ON "after_sale_inventory_actions"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "after_sale_inventory_actions_store_id_after_sale_item_id_in_key" ON "after_sale_inventory_actions"("store_id", "after_sale_item_id", "inspection_version", "action_type");

-- CreateIndex
CREATE UNIQUE INDEX "after_sale_inventory_actions_store_id_inventory_operation_i_key" ON "after_sale_inventory_actions"("store_id", "inventory_operation_id");

-- CreateIndex
CREATE INDEX "after_sale_return_shipments_store_id_status_updated_at_idx" ON "after_sale_return_shipments"("store_id", "status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "after_sale_return_shipments_store_id_id_key" ON "after_sale_return_shipments"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "after_sale_return_shipments_store_id_after_sale_id_tracking_key" ON "after_sale_return_shipments"("store_id", "after_sale_id", "tracking_number_digest");

-- CreateIndex
CREATE INDEX "exchange_fulfillments_store_id_after_sale_id_status_idx" ON "exchange_fulfillments"("store_id", "after_sale_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "exchange_fulfillments_store_id_id_key" ON "exchange_fulfillments"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "exchange_fulfillments_store_id_after_sale_item_id_key" ON "exchange_fulfillments"("store_id", "after_sale_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "exchange_fulfillments_store_id_reservation_id_key" ON "exchange_fulfillments"("store_id", "reservation_id");

-- CreateIndex
CREATE UNIQUE INDEX "exchange_fulfillments_store_id_outbound_shipment_id_key" ON "exchange_fulfillments"("store_id", "outbound_shipment_id");

-- CreateIndex
CREATE INDEX "member_favorites_store_id_member_id_created_at_product_id_idx" ON "member_favorites"("store_id", "member_id", "created_at" DESC, "product_id");

-- CreateIndex
CREATE INDEX "member_product_views_store_id_member_id_last_viewed_at_prod_idx" ON "member_product_views"("store_id", "member_id", "last_viewed_at" DESC, "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "privacy_requests_public_number_key" ON "privacy_requests"("public_number");

-- CreateIndex
CREATE INDEX "privacy_requests_store_id_member_id_created_at_id_idx" ON "privacy_requests"("store_id", "member_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "privacy_requests_store_id_id_key" ON "privacy_requests"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "privacy_requests_store_id_id_member_id_key" ON "privacy_requests"("store_id", "id", "member_id");

-- CreateIndex
CREATE UNIQUE INDEX "privacy_requests_store_id_member_id_idempotency_key_hash_key" ON "privacy_requests"("store_id", "member_id", "idempotency_key_hash");

-- CreateIndex
CREATE INDEX "privacy_request_transitions_store_id_privacy_request_id_cre_idx" ON "privacy_request_transitions"("store_id", "privacy_request_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "privacy_request_transitions_store_id_id_key" ON "privacy_request_transitions"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "share_links_short_code_key" ON "share_links"("short_code");

-- CreateIndex
CREATE INDEX "share_links_store_id_target_type_created_at_idx" ON "share_links"("store_id", "target_type", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "share_links_store_id_id_key" ON "share_links"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "share_interactions_outcome_token_digest_key" ON "share_interactions"("outcome_token_digest");

-- CreateIndex
CREATE INDEX "share_interactions_store_id_share_link_id_created_at_id_idx" ON "share_interactions"("store_id", "share_link_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "share_interactions_store_id_id_key" ON "share_interactions"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_store_id_id_member_id_key" ON "orders"("store_id", "id", "member_id");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_store_id_id_payment_attempt_id_order_id_amount_vnd_key" ON "refunds"("store_id", "id", "payment_attempt_id", "order_id", "amount_vnd");

-- CreateIndex
CREATE UNIQUE INDEX "skus_store_id_id_product_id_key" ON "skus"("store_id", "id", "product_id");

-- Tenant ownership and composite references. Every reference to tenant-owned data
-- carries store_id so an incorrect application predicate cannot splice stores.
ALTER TABLE "store_after_sale_settings"
  ADD CONSTRAINT "store_after_sale_settings_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "store_after_sale_settings_default_policy_fkey" FOREIGN KEY ("store_id", "default_policy_id") REFERENCES "after_sale_policies"("store_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "store_after_sale_settings_current_version_fkey" FOREIGN KEY ("store_id", "current_version_id", "default_policy_id") REFERENCES "after_sale_policy_versions"("store_id", "id", "policy_id") ON DELETE RESTRICT;

ALTER TABLE "after_sale_policies"
  ADD CONSTRAINT "after_sale_policies_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_policies_category_fkey" FOREIGN KEY ("store_id", "category_id") REFERENCES "categories"("store_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_policies_current_version_fkey" FOREIGN KEY ("store_id", "current_version_id", "id") REFERENCES "after_sale_policy_versions"("store_id", "id", "policy_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_policies_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "admin_users"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_policies_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "admin_users"("id") ON DELETE RESTRICT;

ALTER TABLE "after_sale_policy_versions"
  ADD CONSTRAINT "after_sale_policy_versions_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_policy_versions_policy_fkey" FOREIGN KEY ("store_id", "policy_id") REFERENCES "after_sale_policies"("store_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_policy_versions_published_by_fkey" FOREIGN KEY ("published_by") REFERENCES "admin_users"("id") ON DELETE RESTRICT;

ALTER TABLE "after_sale_policy_localizations"
  ADD CONSTRAINT "after_sale_policy_localizations_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_policy_localizations_version_fkey" FOREIGN KEY ("store_id", "policy_version_id") REFERENCES "after_sale_policy_versions"("store_id", "id") ON DELETE RESTRICT;

ALTER TABLE "after_sale_policy_draft_products"
  ADD CONSTRAINT "after_sale_policy_draft_products_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_policy_draft_products_policy_fkey" FOREIGN KEY ("store_id", "policy_id") REFERENCES "after_sale_policies"("store_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_policy_draft_products_product_fkey" FOREIGN KEY ("store_id", "product_id") REFERENCES "products"("store_id", "id") ON DELETE RESTRICT;

ALTER TABLE "after_sale_policy_version_assignments"
  ADD CONSTRAINT "after_sale_policy_version_assignments_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_policy_version_assignments_version_fkey" FOREIGN KEY ("store_id", "policy_version_id", "policy_id") REFERENCES "after_sale_policy_versions"("store_id", "id", "policy_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_policy_version_assignments_product_fkey" FOREIGN KEY ("store_id", "product_id") REFERENCES "products"("store_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_policy_version_assignments_category_fkey" FOREIGN KEY ("store_id", "category_id") REFERENCES "categories"("store_id", "id") ON DELETE RESTRICT;

ALTER TABLE "after_sale_active_policy_assignments"
  ADD CONSTRAINT "after_sale_active_policy_assignments_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_active_policy_assignments_policy_fkey" FOREIGN KEY ("store_id", "policy_id") REFERENCES "after_sale_policies"("store_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_active_policy_assignments_version_fkey" FOREIGN KEY ("store_id", "policy_version_id", "policy_id") REFERENCES "after_sale_policy_versions"("store_id", "id", "policy_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_active_policy_assignments_assignment_fkey" FOREIGN KEY ("store_id", "assignment_id") REFERENCES "after_sale_policy_version_assignments"("store_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_active_policy_assignments_product_fkey" FOREIGN KEY ("store_id", "product_id") REFERENCES "products"("store_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_active_policy_assignments_category_fkey" FOREIGN KEY ("store_id", "category_id") REFERENCES "categories"("store_id", "id") ON DELETE RESTRICT;

ALTER TABLE "order_item_after_sale_policy_snapshots"
  ADD CONSTRAINT "order_item_after_sale_policy_snapshots_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "order_item_after_sale_policy_snapshots_order_item_fkey" FOREIGN KEY ("store_id", "order_id", "order_item_id") REFERENCES "order_items"("store_id", "order_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "order_item_after_sale_policy_snapshots_policy_fkey" FOREIGN KEY ("store_id", "policy_id") REFERENCES "after_sale_policies"("store_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "order_item_after_sale_policy_snapshots_version_fkey" FOREIGN KEY ("store_id", "policy_version_id") REFERENCES "after_sale_policy_versions"("store_id", "id") ON DELETE RESTRICT;

ALTER TABLE "after_sales"
  ADD CONSTRAINT "after_sales_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sales_order_owner_fkey" FOREIGN KEY ("store_id", "order_id", "member_id") REFERENCES "orders"("store_id", "id", "member_id") ON DELETE RESTRICT;

ALTER TABLE "after_sale_items"
  ADD CONSTRAINT "after_sale_items_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_items_case_order_fkey" FOREIGN KEY ("store_id", "after_sale_id", "order_id") REFERENCES "after_sales"("store_id", "id", "order_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_items_order_item_fkey" FOREIGN KEY ("store_id", "order_id", "order_item_id") REFERENCES "order_items"("store_id", "order_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_items_sku_fkey" FOREIGN KEY ("store_id", "sku_id") REFERENCES "skus"("store_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_items_product_fkey" FOREIGN KEY ("store_id", "product_id") REFERENCES "products"("store_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_items_brand_fkey" FOREIGN KEY ("store_id", "brand_id") REFERENCES "brands"("store_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_items_category_fkey" FOREIGN KEY ("store_id", "category_id") REFERENCES "categories"("store_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_items_replacement_sku_fkey" FOREIGN KEY ("store_id", "replacement_sku_id", "product_id") REFERENCES "skus"("store_id", "id", "product_id") ON DELETE RESTRICT;

ALTER TABLE "after_sale_transitions"
  ADD CONSTRAINT "after_sale_transitions_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_transitions_case_fkey" FOREIGN KEY ("store_id", "after_sale_id") REFERENCES "after_sales"("store_id", "id") ON DELETE RESTRICT;
ALTER TABLE "after_sale_operations"
  ADD CONSTRAINT "after_sale_operations_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_operations_case_fkey" FOREIGN KEY ("store_id", "after_sale_id") REFERENCES "after_sales"("store_id", "id") ON DELETE RESTRICT;
ALTER TABLE "after_sale_legacy_decisions"
  ADD CONSTRAINT "after_sale_legacy_decisions_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_legacy_decisions_case_fkey" FOREIGN KEY ("store_id", "after_sale_id") REFERENCES "after_sales"("store_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_legacy_decisions_admin_fkey" FOREIGN KEY ("admin_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT;
ALTER TABLE "after_sale_order_allocations"
  ADD CONSTRAINT "after_sale_order_allocations_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_order_allocations_case_order_fkey" FOREIGN KEY ("store_id", "after_sale_id", "order_id") REFERENCES "after_sales"("store_id", "id", "order_id") ON DELETE RESTRICT;
ALTER TABLE "after_sale_inspections"
  ADD CONSTRAINT "after_sale_inspections_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_inspections_case_fkey" FOREIGN KEY ("store_id", "after_sale_id") REFERENCES "after_sales"("store_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_inspections_admin_fkey" FOREIGN KEY ("admin_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT;
ALTER TABLE "after_sale_inspection_allocations"
  ADD CONSTRAINT "after_sale_inspection_allocations_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_inspection_allocations_inspection_fkey" FOREIGN KEY ("store_id", "inspection_id", "after_sale_id") REFERENCES "after_sale_inspections"("store_id", "id", "after_sale_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_inspection_allocations_item_fkey" FOREIGN KEY ("store_id", "after_sale_item_id", "after_sale_id") REFERENCES "after_sale_items"("store_id", "id", "after_sale_id") ON DELETE RESTRICT;

ALTER TABLE "after_sale_evidence_files"
  ADD CONSTRAINT "after_sale_evidence_files_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_evidence_files_member_fkey" FOREIGN KEY ("store_id", "member_id") REFERENCES "members"("store_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_evidence_files_case_member_fkey" FOREIGN KEY ("store_id", "after_sale_id", "member_id") REFERENCES "after_sales"("store_id", "id", "member_id") ON DELETE RESTRICT;
ALTER TABLE "after_sale_evidence_transitions"
  ADD CONSTRAINT "after_sale_evidence_transitions_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_evidence_transitions_file_fkey" FOREIGN KEY ("store_id", "evidence_file_id") REFERENCES "after_sale_evidence_files"("store_id", "id") ON DELETE RESTRICT;

ALTER TABLE "after_sale_settlements"
  ADD CONSTRAINT "after_sale_settlements_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_settlements_case_order_fkey" FOREIGN KEY ("store_id", "after_sale_id", "order_id") REFERENCES "after_sales"("store_id", "id", "order_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_settlements_payment_fkey" FOREIGN KEY ("store_id", "payment_attempt_id", "order_id") REFERENCES "payment_attempts"("store_id", "id", "order_id") ON DELETE RESTRICT;
ALTER TABLE "after_sale_refunds"
  ADD CONSTRAINT "after_sale_refunds_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_refunds_settlement_fkey" FOREIGN KEY ("store_id", "settlement_id", "after_sale_id", "order_id", "payment_attempt_id", "amount_vnd") REFERENCES "after_sale_settlements"("store_id", "id", "after_sale_id", "order_id", "payment_attempt_id", "amount_vnd") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_refunds_refund_fkey" FOREIGN KEY ("store_id", "refund_id", "payment_attempt_id", "order_id", "amount_vnd") REFERENCES "refunds"("store_id", "id", "payment_attempt_id", "order_id", "amount_vnd") ON DELETE RESTRICT;

ALTER TABLE "after_sale_inventory_actions"
  ADD CONSTRAINT "after_sale_inventory_actions_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_inventory_actions_item_fkey" FOREIGN KEY ("store_id", "after_sale_item_id", "after_sale_id") REFERENCES "after_sale_items"("store_id", "id", "after_sale_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_inventory_actions_warehouse_fkey" FOREIGN KEY ("store_id", "warehouse_id") REFERENCES "warehouses"("store_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_inventory_actions_sku_fkey" FOREIGN KEY ("store_id", "sku_id") REFERENCES "skus"("store_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_inventory_actions_operation_fkey" FOREIGN KEY ("store_id", "inventory_operation_id") REFERENCES "inventory_operations"("store_id", "id") ON DELETE RESTRICT;
ALTER TABLE "after_sale_return_shipments"
  ADD CONSTRAINT "after_sale_return_shipments_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "after_sale_return_shipments_case_owner_fkey" FOREIGN KEY ("store_id", "after_sale_id", "order_id", "member_id") REFERENCES "after_sales"("store_id", "id", "order_id", "member_id") ON DELETE RESTRICT;
ALTER TABLE "exchange_fulfillments"
  ADD CONSTRAINT "exchange_fulfillments_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "exchange_fulfillments_item_fkey" FOREIGN KEY ("store_id", "after_sale_item_id", "after_sale_id") REFERENCES "after_sale_items"("store_id", "id", "after_sale_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "exchange_fulfillments_replacement_sku_fkey" FOREIGN KEY ("store_id", "replacement_sku_id", "product_id") REFERENCES "skus"("store_id", "id", "product_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "exchange_fulfillments_warehouse_fkey" FOREIGN KEY ("store_id", "warehouse_id") REFERENCES "warehouses"("store_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "exchange_fulfillments_reservation_fkey" FOREIGN KEY ("store_id", "reservation_id") REFERENCES "inventory_reservations"("store_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "exchange_fulfillments_shipment_fkey" FOREIGN KEY ("store_id", "outbound_shipment_id", "order_id") REFERENCES "shipments"("store_id", "id", "order_id") ON DELETE RESTRICT;

ALTER TABLE "member_favorites"
  ADD CONSTRAINT "member_favorites_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "member_favorites_member_fkey" FOREIGN KEY ("store_id", "member_id") REFERENCES "members"("store_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "member_favorites_product_fkey" FOREIGN KEY ("store_id", "product_id") REFERENCES "products"("store_id", "id") ON DELETE RESTRICT;
ALTER TABLE "member_product_views"
  ADD CONSTRAINT "member_product_views_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "member_product_views_member_fkey" FOREIGN KEY ("store_id", "member_id") REFERENCES "members"("store_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "member_product_views_product_fkey" FOREIGN KEY ("store_id", "product_id") REFERENCES "products"("store_id", "id") ON DELETE RESTRICT;
ALTER TABLE "privacy_requests"
  ADD CONSTRAINT "privacy_requests_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "privacy_requests_member_fkey" FOREIGN KEY ("store_id", "member_id") REFERENCES "members"("store_id", "id") ON DELETE RESTRICT;
ALTER TABLE "privacy_request_transitions"
  ADD CONSTRAINT "privacy_request_transitions_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "privacy_request_transitions_request_owner_fkey" FOREIGN KEY ("store_id", "privacy_request_id", "member_id") REFERENCES "privacy_requests"("store_id", "id", "member_id") ON DELETE RESTRICT;

ALTER TABLE "share_links"
  ADD CONSTRAINT "share_links_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "share_links_brand_fkey" FOREIGN KEY ("store_id", "brand_id") REFERENCES "brands"("store_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "share_links_category_fkey" FOREIGN KEY ("store_id", "category_id") REFERENCES "categories"("store_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "share_links_product_fkey" FOREIGN KEY ("store_id", "product_id") REFERENCES "products"("store_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "share_links_promotion_fkey" FOREIGN KEY ("store_id", "promotion_id") REFERENCES "promotions"("store_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "share_links_coupon_fkey" FOREIGN KEY ("store_id", "coupon_id") REFERENCES "coupons"("store_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "share_links_verified_promotion_fkey" FOREIGN KEY ("store_id", "verified_promotion_id") REFERENCES "promotions"("store_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "share_links_member_fkey" FOREIGN KEY ("store_id", "created_by_member_id") REFERENCES "members"("store_id", "id") ON DELETE RESTRICT;
ALTER TABLE "share_link_localizations"
  ADD CONSTRAINT "share_link_localizations_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "share_link_localizations_link_fkey" FOREIGN KEY ("store_id", "share_link_id") REFERENCES "share_links"("store_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "share_link_localizations_media_fkey" FOREIGN KEY ("store_id", "source_media_id") REFERENCES "media_assets"("store_id", "id") ON DELETE RESTRICT;
ALTER TABLE "share_interactions"
  ADD CONSTRAINT "share_interactions_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "share_interactions_link_fkey" FOREIGN KEY ("store_id", "share_link_id") REFERENCES "share_links"("store_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "share_interactions_member_fkey" FOREIGN KEY ("store_id", "member_id") REFERENCES "members"("store_id", "id") ON DELETE RESTRICT;

ALTER TABLE "shipments"
  ADD CONSTRAINT "shipments_after_sale_fkey" FOREIGN KEY ("store_id", "after_sale_id", "order_id") REFERENCES "after_sales"("store_id", "id", "order_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "shipments_purpose_shape_check" CHECK (
    ("purpose" = 'ORDER_OUTBOUND' AND "after_sale_id" IS NULL)
    OR ("purpose" IN ('AFTER_SALE_RETURN', 'EXCHANGE_OUTBOUND') AND "after_sale_id" IS NOT NULL)
  );

-- Structural checks that Prisma cannot express.
ALTER TABLE "store_after_sale_settings" ADD CONSTRAINT "store_after_sale_settings_values_check" CHECK (
  "version" >= 1 AND ("readiness_hash" IS NULL OR "readiness_hash" ~ '^[0-9a-f]{64}$')
  AND (NOT "enforce_policy_snapshots" OR ("default_policy_id" IS NOT NULL AND "current_version_id" IS NOT NULL AND "readiness_ready_at" IS NOT NULL))
);
ALTER TABLE "after_sale_policies" ADD CONSTRAINT "after_sale_policies_values_check" CHECK (
  "code" ~ '^[a-z0-9]+([_-][a-z0-9]+)*$' AND "draft_hash" ~ '^[0-9a-f]{64}$'
  AND jsonb_typeof("draft_payload") = 'object' AND "version" >= 1
  AND (("status" = 'DRAFT' AND "current_version_id" IS NULL) OR ("status" <> 'DRAFT' AND "current_version_id" IS NOT NULL))
);
ALTER TABLE "after_sale_policy_versions" ADD CONSTRAINT "after_sale_policy_versions_values_check" CHECK (
  "version_number" >= 1 AND "request_window_days" BETWEEN 0 AND 365 AND "return_window_days" BETWEEN 1 AND 60
  AND cardinality("allowed_types") BETWEEN 1 AND 4 AND "exchange_same_product_only"
  AND jsonb_typeof("condition_rules") = 'object' AND jsonb_typeof("payload") = 'object'
  AND "payload_hash" ~ '^[0-9a-f]{64}$'
);
ALTER TABLE "after_sale_policy_version_assignments" ADD CONSTRAINT "after_sale_policy_version_assignments_target_check" CHECK (
  ("target_type" = 'PRODUCT' AND "product_id" IS NOT NULL AND "category_id" IS NULL)
  OR ("target_type" = 'CATEGORY' AND "category_id" IS NOT NULL AND "product_id" IS NULL)
  OR ("target_type" = 'STORE_DEFAULT' AND "product_id" IS NULL AND "category_id" IS NULL)
);
ALTER TABLE "after_sale_active_policy_assignments" ADD CONSTRAINT "after_sale_active_policy_assignments_target_check" CHECK (
  ("target_type" = 'PRODUCT' AND "product_id" IS NOT NULL AND "category_id" IS NULL)
  OR ("target_type" = 'CATEGORY' AND "category_id" IS NOT NULL AND "product_id" IS NULL)
  OR ("target_type" = 'STORE_DEFAULT' AND "product_id" IS NULL AND "category_id" IS NULL)
);
CREATE UNIQUE INDEX "after_sale_policy_version_assignments_target_key" ON "after_sale_policy_version_assignments"(
  "store_id", "policy_version_id", "target_type", COALESCE("product_id", "category_id", '00000000-0000-0000-0000-000000000000'::uuid)
);
CREATE UNIQUE INDEX "after_sale_active_policy_assignments_product_key" ON "after_sale_active_policy_assignments"("store_id", "product_id") WHERE "target_type" = 'PRODUCT';
CREATE UNIQUE INDEX "after_sale_active_policy_assignments_category_key" ON "after_sale_active_policy_assignments"("store_id", "category_id") WHERE "target_type" = 'CATEGORY';
CREATE UNIQUE INDEX "after_sale_active_policy_assignments_default_key" ON "after_sale_active_policy_assignments"("store_id") WHERE "target_type" = 'STORE_DEFAULT';

ALTER TABLE "order_item_after_sale_policy_snapshots" ADD CONSTRAINT "order_item_after_sale_policy_snapshots_values_check" CHECK (
  "policy_version_number" >= 1 AND jsonb_typeof("payload") = 'object' AND "payload_hash" ~ '^[0-9a-f]{64}$'
);
ALTER TABLE "after_sales" ADD CONSTRAINT "after_sales_values_check" CHECK (
  "public_case_number" ~ '^ASC-[A-Z0-9]{16,32}$' AND "version" >= 1 AND "currency" = 'VND'
  AND "idempotency_key_hash" ~ '^[0-9a-f]{64}$' AND "request_hash" ~ '^[0-9a-f]{64}$'
  AND "requested_item_vnd" BETWEEN 0 AND 9007199254740991 AND "requested_shipping_vnd" BETWEEN 0 AND 9007199254740991
  AND "requested_other_vnd" BETWEEN 0 AND 9007199254740991 AND "requested_total_vnd" = "requested_item_vnd" + "requested_shipping_vnd" + "requested_other_vnd"
  AND "approved_item_vnd" BETWEEN 0 AND 9007199254740991 AND "approved_shipping_vnd" BETWEEN 0 AND 9007199254740991
  AND "approved_other_vnd" BETWEEN 0 AND 9007199254740991 AND "approved_total_vnd" = "approved_item_vnd" + "approved_shipping_vnd" + "approved_other_vnd"
  AND "approved_total_vnd" <= "requested_total_vnd"
  AND (("legacy_policy_review" AND "policy_snapshot" IS NULL AND "policy_hash" IS NULL) OR (NOT "legacy_policy_review" AND "policy_snapshot" IS NOT NULL AND "policy_hash" ~ '^[0-9a-f]{64}$'))
);
ALTER TABLE "after_sale_items" ADD CONSTRAINT "after_sale_items_values_check" CHECK (
  "requested_quantity" > 0 AND "approved_quantity" BETWEEN 0 AND "requested_quantity"
  AND "received_quantity" BETWEEN 0 AND "approved_quantity" AND "accepted_quantity" + "rejected_quantity" = "received_quantity"
  AND "restockable_quantity" BETWEEN 0 AND "accepted_quantity" AND "restored_quantity" BETWEEN 0 AND "restockable_quantity"
  AND "requested_item_vnd" BETWEEN 0 AND 9007199254740991 AND "approved_item_vnd" BETWEEN 0 AND "requested_item_vnd"
  AND (("replacement_sku_id" IS NULL AND "replacement_quantity" = 0) OR ("replacement_sku_id" IS NOT NULL AND "replacement_quantity" = "approved_quantity"))
);
ALTER TABLE "after_sale_order_allocations" ADD CONSTRAINT "after_sale_order_allocations_values_check" CHECK (
  "shipping_fee_vnd" BETWEEN 0 AND 9007199254740991 AND "remote_surcharge_vnd" BETWEEN 0 AND 9007199254740991 AND "other_vnd" BETWEEN 0 AND 9007199254740991
  AND "shipping_fee_vnd" + "remote_surcharge_vnd" + "other_vnd" > 0
);
ALTER TABLE "after_sale_inspections" ADD CONSTRAINT "after_sale_inspections_values_check" CHECK ("inspection_version" >= 1 AND btrim("reason") <> '');
ALTER TABLE "after_sale_inspection_allocations" ADD CONSTRAINT "after_sale_inspection_allocations_values_check" CHECK ("quantity" > 0 AND "disposition" <> 'PENDING');
ALTER TABLE "after_sale_evidence_files" ADD CONSTRAINT "after_sale_evidence_files_values_check" CHECK (
  "mime_type" IN ('image/jpeg','image/png','image/webp','video/mp4') AND "byte_size" > 0 AND "byte_size" <= 52428800
  AND ("mime_type" = 'video/mp4' OR "byte_size" <= 10485760) AND "checksum_sha256" ~ '^[0-9a-f]{64}$'
  AND "delete_attempt_count" >= 0 AND "version" >= 1
  AND ((NOT "legal_hold_active" AND "held_at" IS NULL AND "held_by" IS NULL AND "hold_reason" IS NULL) OR ("legal_hold_active" AND "held_at" IS NOT NULL AND "held_by" IS NOT NULL AND "hold_reason" IS NOT NULL))
);
ALTER TABLE "after_sale_settlements" ADD CONSTRAINT "after_sale_settlements_values_check" CHECK (
  "public_settlement_number" ~ '^AST-[A-Z0-9]{16,32}$' AND "amount_vnd" BETWEEN 1 AND 9007199254740991 AND "currency" = 'VND'
  AND "version" >= 1 AND "idempotency_key_hash" ~ '^[0-9a-f]{64}$' AND "request_hash" ~ '^[0-9a-f]{64}$'
  AND (("method" = 'ONLINE_ORIGINAL' AND "payment_attempt_id" IS NOT NULL AND "transfer_reference_digest" IS NULL AND "transfer_evidence_ciphertext" IS NULL)
    OR ("method" = 'COD_OFFLINE' AND "payment_attempt_id" IS NULL)
    OR ("method" = 'NO_PAYOUT' AND "payment_attempt_id" IS NULL AND "amount_vnd" > 0))
  AND ("confirmed_by" IS NULL OR "confirmed_by" <> "requested_by")
);
CREATE UNIQUE INDEX "after_sale_settlements_one_active_per_case_method_key" ON "after_sale_settlements"("store_id", "after_sale_id", "method") WHERE "status" IN ('PENDING','PROCESSING','REVIEW_REQUIRED');
ALTER TABLE "after_sale_inventory_actions" ADD CONSTRAINT "after_sale_inventory_actions_values_check" CHECK (
  "inspection_version" >= 1 AND "quantity" > 0 AND "disposition" = 'RESTOCK_SELLABLE' AND "action_type" = 'RESTOCK_SELLABLE'
);
ALTER TABLE "after_sale_return_shipments" ADD CONSTRAINT "after_sale_return_shipments_values_check" CHECK (
  "tracking_number_digest" ~ '^[0-9a-f]{64}$' AND btrim("tracking_number_masked") <> '' AND "version" >= 1
);
ALTER TABLE "exchange_fulfillments" ADD CONSTRAINT "exchange_fulfillments_values_check" CHECK ("version" >= 1);
ALTER TABLE "member_product_views" ADD CONSTRAINT "member_product_views_time_check" CHECK ("last_viewed_at" >= "first_viewed_at");
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_values_check" CHECK (
  "public_number" ~ '^PRV-[A-Z0-9]{16,32}$' AND "version" >= 1 AND "idempotency_key_hash" ~ '^[0-9a-f]{64}$' AND "request_hash" ~ '^[0-9a-f]{64}$'
);
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_target_check" CHECK (
  ("target_type" = 'STORE' AND num_nonnulls("brand_id","category_id","product_id","promotion_id","coupon_id") = 0)
  OR ("target_type" = 'BRAND' AND "brand_id" IS NOT NULL AND num_nonnulls("category_id","product_id","promotion_id","coupon_id") = 0)
  OR ("target_type" = 'CATEGORY' AND "category_id" IS NOT NULL AND num_nonnulls("brand_id","product_id","promotion_id","coupon_id") = 0)
  OR ("target_type" = 'PRODUCT' AND "product_id" IS NOT NULL AND num_nonnulls("brand_id","category_id","promotion_id","coupon_id") = 0)
  OR ("target_type" = 'PROMOTION' AND "promotion_id" IS NOT NULL AND num_nonnulls("brand_id","category_id","product_id","coupon_id") = 0)
  OR ("target_type" = 'COUPON' AND "coupon_id" IS NOT NULL AND num_nonnulls("brand_id","category_id","product_id","promotion_id") = 0)
);
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_values_check" CHECK ("short_code" ~ '^[A-Za-z0-9_-]{20,128}$' AND "mini_app_path" LIKE '/%');
ALTER TABLE "share_link_localizations" ADD CONSTRAINT "share_link_localizations_values_check" CHECK ("target_version" >= 1 AND "payload_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "share_interactions" ADD CONSTRAINT "share_interactions_token_check" CHECK (
  ("outcome_token_digest" IS NULL AND "outcome_expires_at" IS NULL) OR ("outcome_token_digest" ~ '^[0-9a-f]{64}$' AND "outcome_expires_at" IS NOT NULL)
);

DROP INDEX "shipments_one_active_per_order_key";
CREATE UNIQUE INDEX "shipments_one_active_per_order_key" ON "shipments"("store_id", "order_id")
  WHERE "purpose" = 'ORDER_OUTBOUND' AND "status" NOT IN ('DELIVERED', 'RETURNED', 'CANCELLED');
CREATE UNIQUE INDEX "shipments_one_active_after_sale_purpose_key" ON "shipments"("store_id", "after_sale_id", "purpose")
  WHERE "purpose" <> 'ORDER_OUTBOUND' AND "status" NOT IN ('DELIVERED', 'RETURNED', 'CANCELLED');

-- Immutable facts remain protected even for the migration owner.
CREATE OR REPLACE FUNCTION "app_security"."reject_m62_append_only_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '42501';
END
$$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'after_sale_policy_versions','after_sale_policy_localizations','after_sale_policy_version_assignments',
    'order_item_after_sale_policy_snapshots','after_sale_transitions','after_sale_legacy_decisions',
    'after_sale_inspections','after_sale_inspection_allocations','after_sale_evidence_transitions',
    'after_sale_refunds','after_sale_order_allocations','after_sale_inventory_actions',
    'privacy_request_transitions','share_link_localizations','share_interactions'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_security.reject_m62_append_only_mutation()', table_name || '_append_only', table_name);
  END LOOP;
END
$$;

CREATE OR REPLACE FUNCTION "app_security"."reject_m62_store_identity_change"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.store_id <> OLD.store_id THEN
    RAISE EXCEPTION 'store identity is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'store_after_sale_settings','after_sale_policies','after_sale_policy_draft_products',
    'after_sale_active_policy_assignments','after_sales','after_sale_items','after_sale_operations',
    'after_sale_evidence_files','after_sale_settlements','after_sale_return_shipments',
    'exchange_fulfillments','member_favorites','member_product_views','privacy_requests','share_links'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION app_security.reject_m62_store_identity_change()', table_name || '_store_immutable', table_name);
  END LOOP;
END
$$;

-- FORCE RLS on every M6 table. Member-private policies are owner-bound and are
-- deliberately not combined with a permissive store-only policy.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'store_after_sale_settings','after_sale_policies','after_sale_policy_versions','after_sale_policy_localizations',
    'after_sale_policy_draft_products','after_sale_policy_version_assignments','after_sale_active_policy_assignments',
    'order_item_after_sale_policy_snapshots','share_links','share_link_localizations','share_interactions'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON %I USING (store_id = app_security.current_store_id()) WITH CHECK (store_id = app_security.current_store_id())', table_name || '_tenant_isolation', table_name);
  END LOOP;
END
$$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'after_sales','after_sale_items','after_sale_transitions','after_sale_operations','after_sale_legacy_decisions',
    'after_sale_order_allocations','after_sale_inspections','after_sale_inspection_allocations',
    'after_sale_settlements','after_sale_refunds','after_sale_inventory_actions','exchange_fulfillments'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    IF table_name = 'after_sales' THEN
      EXECUTE format('CREATE POLICY %I ON %I USING (store_id = app_security.current_store_id() AND (current_setting(''app.actor_type'', true) = ''admin'' OR (current_setting(''app.actor_type'', true) = ''member'' AND member_id = app_security.current_actor_id()))) WITH CHECK (store_id = app_security.current_store_id() AND (current_setting(''app.actor_type'', true) = ''admin'' OR (current_setting(''app.actor_type'', true) = ''member'' AND member_id = app_security.current_actor_id())))', table_name || '_actor_scope', table_name);
    ELSE
      EXECUTE format('CREATE POLICY %I ON %I USING (store_id = app_security.current_store_id() AND (current_setting(''app.actor_type'', true) = ''admin'' OR EXISTS (SELECT 1 FROM after_sales owned_case WHERE owned_case.store_id = %I.store_id AND owned_case.id = %I.after_sale_id AND owned_case.member_id = app_security.current_actor_id()))) WITH CHECK (store_id = app_security.current_store_id() AND (current_setting(''app.actor_type'', true) = ''admin'' OR EXISTS (SELECT 1 FROM after_sales owned_case WHERE owned_case.store_id = %I.store_id AND owned_case.id = %I.after_sale_id AND owned_case.member_id = app_security.current_actor_id())))', table_name || '_actor_scope', table_name, table_name, table_name, table_name, table_name);
    END IF;
  END LOOP;
END
$$;

ALTER TABLE "after_sale_evidence_files" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "after_sale_evidence_files" FORCE ROW LEVEL SECURITY;
CREATE POLICY "after_sale_evidence_files_actor_scope" ON "after_sale_evidence_files"
  USING ("store_id" = app_security.current_store_id() AND (current_setting('app.actor_type', true) = 'admin' OR (current_setting('app.actor_type', true) = 'member' AND "member_id" = app_security.current_actor_id())))
  WITH CHECK ("store_id" = app_security.current_store_id() AND (current_setting('app.actor_type', true) = 'admin' OR (current_setting('app.actor_type', true) = 'member' AND "member_id" = app_security.current_actor_id())));
ALTER TABLE "after_sale_evidence_transitions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "after_sale_evidence_transitions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "after_sale_evidence_transitions_actor_scope" ON "after_sale_evidence_transitions"
  USING ("store_id" = app_security.current_store_id() AND (current_setting('app.actor_type', true) = 'admin' OR EXISTS (SELECT 1 FROM after_sale_evidence_files evidence WHERE evidence.store_id = after_sale_evidence_transitions.store_id AND evidence.id = after_sale_evidence_transitions.evidence_file_id AND evidence.member_id = app_security.current_actor_id())))
  WITH CHECK ("store_id" = app_security.current_store_id() AND (current_setting('app.actor_type', true) = 'admin' OR EXISTS (SELECT 1 FROM after_sale_evidence_files evidence WHERE evidence.store_id = after_sale_evidence_transitions.store_id AND evidence.id = after_sale_evidence_transitions.evidence_file_id AND evidence.member_id = app_security.current_actor_id())));
ALTER TABLE "after_sale_return_shipments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "after_sale_return_shipments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "after_sale_return_shipments_actor_scope" ON "after_sale_return_shipments"
  USING ("store_id" = app_security.current_store_id() AND (current_setting('app.actor_type', true) = 'admin' OR (current_setting('app.actor_type', true) = 'member' AND "member_id" = app_security.current_actor_id())))
  WITH CHECK ("store_id" = app_security.current_store_id() AND (current_setting('app.actor_type', true) = 'admin' OR (current_setting('app.actor_type', true) = 'member' AND "member_id" = app_security.current_actor_id())));

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['member_favorites','member_product_views','privacy_requests','privacy_request_transitions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON %I USING (store_id = app_security.current_store_id() AND current_setting(''app.actor_type'', true) = ''member'' AND member_id = app_security.current_actor_id()) WITH CHECK (store_id = app_security.current_store_id() AND current_setting(''app.actor_type'', true) = ''member'' AND member_id = app_security.current_actor_id())', table_name || '_member_owner', table_name);
  END LOOP;
END
$$;

-- Runtime receives no broad UPDATE. Mutable workflow columns are granted explicitly.
GRANT SELECT, INSERT ON TABLE
  "store_after_sale_settings","after_sale_policies","after_sale_policy_versions","after_sale_policy_localizations",
  "after_sale_policy_draft_products","after_sale_policy_version_assignments","after_sale_active_policy_assignments",
  "order_item_after_sale_policy_snapshots","after_sales","after_sale_items","after_sale_transitions","after_sale_operations",
  "after_sale_legacy_decisions","after_sale_order_allocations","after_sale_inspections","after_sale_inspection_allocations",
  "after_sale_evidence_files","after_sale_evidence_transitions","after_sale_settlements","after_sale_refunds",
  "after_sale_inventory_actions","after_sale_return_shipments","exchange_fulfillments","member_favorites","member_product_views",
  "privacy_requests","privacy_request_transitions","share_links","share_link_localizations","share_interactions"
TO zalo_shop_runtime;
GRANT DELETE ON TABLE "after_sale_policy_draft_products","after_sale_active_policy_assignments","member_favorites","member_product_views" TO zalo_shop_runtime;
GRANT UPDATE ("enforce_policy_snapshots","default_policy_id","current_version_id","readiness_checked_at","readiness_ready_at","readiness_hash","readiness_checked_by","version","updated_at","updated_by") ON "store_after_sale_settings" TO zalo_shop_runtime;
GRANT UPDATE ("status","category_id","current_version_id","draft_payload","draft_hash","version","updated_by","updated_at") ON "after_sale_policies" TO zalo_shop_runtime;
GRANT UPDATE ("policy_id","policy_version_id","assignment_id","updated_at") ON "after_sale_active_policy_assignments" TO zalo_shop_runtime;
GRANT UPDATE ("status","review_resume_status","review_reason","return_deadline_at","return_expired_at","approved_item_vnd","approved_shipping_vnd","approved_other_vnd","approved_total_vnd","version","reviewed_by","reviewed_at","completed_at","updated_at") ON "after_sales" TO zalo_shop_runtime;
GRANT UPDATE ("approved_quantity","received_quantity","accepted_quantity","rejected_quantity","restockable_quantity","restored_quantity","approved_item_vnd","condition","disposition","inspection_version","inspected_by","updated_at") ON "after_sale_items" TO zalo_shop_runtime;
GRANT UPDATE ("status","result_summary","error_code","attempt_count","version","updated_at") ON "after_sale_operations" TO zalo_shop_runtime;
GRANT UPDATE ("after_sale_id","object_key","derivative_object_keys","scan_temporary_object_key","status","scan_result_code","claim_deadline_at","claimed_at","retention_deadline_at","delete_attempt_count","next_delete_attempt_at","delete_error_code","deleted_at","version","updated_at") ON "after_sale_evidence_files" TO zalo_shop_runtime;
GRANT UPDATE ("status","confirmed_by","transfer_reference_digest","transfer_evidence_ciphertext","version","confirmed_at","completed_at","updated_at") ON "after_sale_settlements" TO zalo_shop_runtime;
GRANT UPDATE ("status","received_at","version","updated_at") ON "after_sale_return_shipments" TO zalo_shop_runtime;
GRANT UPDATE ("reservation_id","outbound_shipment_id","status","version","reserved_at","shipped_at","delivered_at","updated_at") ON "exchange_fulfillments" TO zalo_shop_runtime;
GRANT UPDATE ("last_viewed_at") ON "member_product_views" TO zalo_shop_runtime;
GRANT UPDATE ("status","version","updated_at") ON "privacy_requests" TO zalo_shop_runtime;
REVOKE DELETE ON TABLE
  "store_after_sale_settings","after_sale_policies","after_sale_policy_versions","after_sale_policy_localizations",
  "after_sale_policy_draft_products","after_sale_policy_version_assignments","after_sale_active_policy_assignments",
  "order_item_after_sale_policy_snapshots","after_sales","after_sale_items","after_sale_transitions","after_sale_operations",
  "after_sale_legacy_decisions","after_sale_order_allocations","after_sale_inspections","after_sale_inspection_allocations",
  "after_sale_evidence_files","after_sale_evidence_transitions","after_sale_settlements","after_sale_refunds",
  "after_sale_inventory_actions","after_sale_return_shipments","exchange_fulfillments","member_favorites","member_product_views",
  "privacy_requests","privacy_request_transitions","share_links","share_link_localizations","share_interactions"
FROM zalo_shop_runtime;
GRANT DELETE ON TABLE "after_sale_policy_draft_products","after_sale_active_policy_assignments","member_favorites","member_product_views" TO zalo_shop_runtime;

REVOKE ALL ON FUNCTION "app_security"."reject_m62_append_only_mutation"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "app_security"."reject_m62_store_identity_change"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app_security"."reject_m62_append_only_mutation"(), "app_security"."reject_m62_store_identity_change"() TO zalo_shop_runtime;

CREATE OR REPLACE FUNCTION "app_security"."assert_m62_rollback_safe"()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "store_after_sale_settings" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "after_sale_policies" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "order_item_after_sale_policy_snapshots" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "after_sales" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "after_sale_evidence_files" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "after_sale_settlements" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "after_sale_inventory_actions" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "member_favorites" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "member_product_views" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "privacy_requests" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "share_links" LIMIT 1)
  THEN
    RAISE EXCEPTION 'M6.2 foundation rollback is unsafe after business facts exist' USING ERRCODE = '55000';
  END IF;
END
$$;
REVOKE ALL ON FUNCTION "app_security"."assert_m62_rollback_safe"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "app_security"."assert_m62_rollback_safe"() FROM zalo_shop_runtime;
