CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'UNPUBLISHED', 'DISABLED');

-- CreateEnum
CREATE TYPE "AttributeTemplateStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "AttributeDataType" AS ENUM ('TEXT', 'INTEGER', 'DECIMAL', 'BOOLEAN', 'DATE', 'OPTION');

-- CreateEnum
CREATE TYPE "AttributePurpose" AS ENUM ('SPECIFICATION', 'FILTER', 'DETAIL', 'COMPLIANCE');

-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('PENDING', 'READY', 'FAILED', 'QUARANTINED');

-- CreateEnum
CREATE TYPE "MediaPurpose" AS ENUM ('PRIMARY', 'GALLERY', 'LOGO', 'COVER', 'DOCUMENT');

-- CreateEnum
CREATE TYPE "ComplianceStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "PublicationStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "PageStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'DISABLED');

-- CreateEnum
CREATE TYPE "PageModuleType" AS ENUM ('HERO', 'BANNER', 'PRODUCT_GRID', 'BRAND_GRID', 'CATEGORY_GRID', 'RICH_TEXT');

-- CreateEnum
CREATE TYPE "PageTargetType" AS ENUM ('PRODUCT', 'BRAND', 'CATEGORY', 'PAGE', 'EXTERNAL');

-- CreateTable
CREATE TABLE "brands" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "country_code" CHAR(2),
    "website_url" TEXT,
    "recommended" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brand_localizations" (
    "store_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "locale" "Locale" NOT NULL,
    "name" VARCHAR(240) NOT NULL,
    "introduction" TEXT,
    "share_title" VARCHAR(240),
    "share_summary" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "brand_localizations_pkey" PRIMARY KEY ("store_id","brand_id","locale")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "parent_id" UUID,
    "code" VARCHAR(64) NOT NULL,
    "depth" INTEGER NOT NULL,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "category_localizations" (
    "store_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "locale" "Locale" NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "description" TEXT,
    "share_title" VARCHAR(240),
    "share_summary" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "category_localizations_pkey" PRIMARY KEY ("store_id","category_id","locale")
);

-- CreateTable
CREATE TABLE "attribute_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "industry" "StoreIndustry" NOT NULL,
    "status" "AttributeTemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "current_version" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "attribute_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attribute_template_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "status" "AttributeTemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "activated_at" TIMESTAMPTZ(6),
    "activated_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "attribute_template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attribute_definitions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "template_version_id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "data_type" "AttributeDataType" NOT NULL,
    "purpose" "AttributePurpose" NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "multiple" BOOLEAN NOT NULL DEFAULT false,
    "filterable" BOOLEAN NOT NULL DEFAULT false,
    "unit" VARCHAR(32),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "validation_rules" JSONB NOT NULL DEFAULT '{}',
    "label_vi" VARCHAR(160) NOT NULL,
    "label_zh" VARCHAR(160),
    "label_en" VARCHAR(160),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attribute_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attribute_options" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "attribute_definition_id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "label_vi" VARCHAR(160) NOT NULL,
    "label_zh" VARCHAR(160),
    "label_en" VARCHAR(160),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attribute_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "category_attribute_templates" (
    "store_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "template_version_id" UUID NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "category_attribute_templates_pkey" PRIMARY KEY ("store_id","category_id","template_version_id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "brand_id" UUID NOT NULL,
    "main_category_id" UUID NOT NULL,
    "attribute_template_version_id" UUID,
    "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "scheduled_publish_at" TIMESTAMPTZ(6),
    "published_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_secondary_categories" (
    "store_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,

    CONSTRAINT "product_secondary_categories_pkey" PRIMARY KEY ("store_id","product_id","category_id")
);

-- CreateTable
CREATE TABLE "product_localizations" (
    "store_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "locale" "Locale" NOT NULL,
    "name" VARCHAR(240) NOT NULL,
    "subtitle" VARCHAR(500),
    "selling_points" TEXT,
    "description_document" JSONB NOT NULL DEFAULT '{}',
    "usage_instructions" TEXT,
    "seo_title" VARCHAR(240),
    "seo_description" VARCHAR(500),
    "share_title" VARCHAR(240),
    "share_summary" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "product_localizations_pkey" PRIMARY KEY ("store_id","product_id","locale")
);

-- CreateTable
CREATE TABLE "product_attribute_values" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "attribute_definition_id" UUID NOT NULL,
    "locale" "Locale",
    "text_value" TEXT,
    "integer_value" BIGINT,
    "decimal_value" DECIMAL(24,8),
    "boolean_value" BOOLEAN,
    "date_value" DATE,
    "option_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_attribute_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skus" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "barcode" VARCHAR(64),
    "sale_price_vnd" BIGINT NOT NULL,
    "market_price_vnd" BIGINT,
    "cost_price_vnd" BIGINT,
    "weight_grams" INTEGER,
    "length_millimeters" INTEGER,
    "width_millimeters" INTEGER,
    "height_millimeters" INTEGER,
    "option_combination_key" TEXT NOT NULL,
    "option_combination_hash" CHAR(64) NOT NULL,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "skus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sku_option_values" (
    "store_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "attribute_definition_id" UUID NOT NULL,
    "option_id" UUID NOT NULL,

    CONSTRAINT "sku_option_values_pkey" PRIMARY KEY ("store_id","sku_id","attribute_definition_id")
);

-- CreateTable
CREATE TABLE "media_assets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "object_key" TEXT NOT NULL,
    "mime_type" VARCHAR(160) NOT NULL,
    "byte_size" BIGINT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "checksum_sha256" CHAR(64) NOT NULL,
    "status" "MediaStatus" NOT NULL DEFAULT 'PENDING',
    "original_filename" VARCHAR(255) NOT NULL,
    "alt_text_vi" VARCHAR(500),
    "alt_text_zh" VARCHAR(500),
    "alt_text_en" VARCHAR(500),
    "failure_code" VARCHAR(128),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brand_media" (
    "store_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "media_id" UUID NOT NULL,
    "purpose" "MediaPurpose" NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "brand_media_pkey" PRIMARY KEY ("store_id","brand_id","media_id","purpose")
);

-- CreateTable
CREATE TABLE "category_media" (
    "store_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "media_id" UUID NOT NULL,
    "purpose" "MediaPurpose" NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "category_media_pkey" PRIMARY KEY ("store_id","category_id","media_id","purpose")
);

-- CreateTable
CREATE TABLE "product_media" (
    "store_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "media_id" UUID NOT NULL,
    "purpose" "MediaPurpose" NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "product_media_pkey" PRIMARY KEY ("store_id","product_id","media_id","purpose")
);

-- CreateTable
CREATE TABLE "sku_media" (
    "store_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "media_id" UUID NOT NULL,
    "purpose" "MediaPurpose" NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "sku_media_pkey" PRIMARY KEY ("store_id","sku_id","media_id","purpose")
);

-- CreateTable
CREATE TABLE "compliance_requirements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "industry" "StoreIndustry" NOT NULL,
    "category_id" UUID,
    "document_type" VARCHAR(128) NOT NULL,
    "blocking" BOOLEAN NOT NULL DEFAULT true,
    "validity_days" INTEGER,
    "condition_rules" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "compliance_requirements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "requirement_id" UUID NOT NULL,
    "document_number" VARCHAR(255),
    "issued_at" DATE,
    "expires_at" DATE,
    "status" "ComplianceStatus" NOT NULL DEFAULT 'DRAFT',
    "submitted_by" UUID NOT NULL,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "review_note" TEXT,
    "supersedes_record_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "compliance_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_record_media" (
    "store_id" UUID NOT NULL,
    "compliance_record_id" UUID NOT NULL,
    "media_id" UUID NOT NULL,

    CONSTRAINT "compliance_record_media_pkey" PRIMARY KEY ("store_id","compliance_record_id","media_id")
);

-- CreateTable
CREATE TABLE "product_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "publication_status" "PublicationStatus" NOT NULL DEFAULT 'DRAFT',
    "snapshot" JSONB NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "published_at" TIMESTAMPTZ(6),
    "published_by" UUID,
    "withdrawn_at" TIMESTAMPTZ(6),
    "withdrawn_by" UUID,

    CONSTRAINT "product_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "status" "PageStatus" NOT NULL DEFAULT 'DRAFT',
    "current_published_version_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "page_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "page_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "publication_status" "PublicationStatus" NOT NULL DEFAULT 'DRAFT',
    "published_at" TIMESTAMPTZ(6),
    "published_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,

    CONSTRAINT "page_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "page_modules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "page_version_id" UUID NOT NULL,
    "module_type" "PageModuleType" NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "visible_from" TIMESTAMPTZ(6),
    "visible_to" TIMESTAMPTZ(6),
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "background_config" JSONB NOT NULL DEFAULT '{}',
    "target_type" "PageTargetType",
    "target_id" UUID,
    "target_url" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "page_modules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "page_module_localizations" (
    "store_id" UUID NOT NULL,
    "page_module_id" UUID NOT NULL,
    "locale" "Locale" NOT NULL,
    "title" VARCHAR(240),
    "summary" VARCHAR(500),
    "button_label" VARCHAR(160),
    "content_config" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "page_module_localizations_pkey" PRIMARY KEY ("store_id","page_module_id","locale")
);

-- CreateTable
CREATE TABLE "page_module_media" (
    "store_id" UUID NOT NULL,
    "page_module_id" UUID NOT NULL,
    "media_id" UUID NOT NULL,
    "purpose" "MediaPurpose" NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "page_module_media_pkey" PRIMARY KEY ("store_id","page_module_id","media_id","purpose")
);

-- CreateIndex
CREATE INDEX "brands_store_id_status_sort_order_id_idx" ON "brands"("store_id", "status", "sort_order", "id");

-- CreateIndex
CREATE INDEX "brands_store_id_recommended_status_idx" ON "brands"("store_id", "recommended", "status");

-- CreateIndex
CREATE UNIQUE INDEX "brands_store_id_id_key" ON "brands"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "brands_store_id_code_key" ON "brands"("store_id", "code");

-- CreateIndex
CREATE INDEX "categories_store_id_parent_id_status_sort_order_id_idx" ON "categories"("store_id", "parent_id", "status", "sort_order", "id");

-- CreateIndex
CREATE UNIQUE INDEX "categories_store_id_id_key" ON "categories"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "categories_store_id_code_key" ON "categories"("store_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "attribute_templates_store_id_id_key" ON "attribute_templates"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "attribute_templates_store_id_code_key" ON "attribute_templates"("store_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "attribute_template_versions_store_id_id_key" ON "attribute_template_versions"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "attribute_template_versions_store_id_template_id_version_key" ON "attribute_template_versions"("store_id", "template_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "attribute_definitions_store_id_id_key" ON "attribute_definitions"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "attribute_definitions_store_id_template_version_id_code_key" ON "attribute_definitions"("store_id", "template_version_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "attribute_options_store_id_id_key" ON "attribute_options"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "attribute_options_store_id_attribute_definition_id_code_key" ON "attribute_options"("store_id", "attribute_definition_id", "code");

-- CreateIndex
CREATE INDEX "products_store_id_status_id_idx" ON "products"("store_id", "status", "id");

-- CreateIndex
CREATE INDEX "products_store_id_brand_id_status_id_idx" ON "products"("store_id", "brand_id", "status", "id");

-- CreateIndex
CREATE INDEX "products_store_id_main_category_id_status_id_idx" ON "products"("store_id", "main_category_id", "status", "id");

-- CreateIndex
CREATE INDEX "products_store_id_scheduled_publish_at_idx" ON "products"("store_id", "scheduled_publish_at");

-- CreateIndex
CREATE UNIQUE INDEX "products_store_id_id_key" ON "products"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "products_store_id_code_key" ON "products"("store_id", "code");

-- CreateIndex
CREATE INDEX "product_attribute_values_store_id_product_id_attribute_defi_idx" ON "product_attribute_values"("store_id", "product_id", "attribute_definition_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_attribute_values_store_id_id_key" ON "product_attribute_values"("store_id", "id");

-- CreateIndex
CREATE INDEX "skus_store_id_product_id_status_idx" ON "skus"("store_id", "product_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "skus_store_id_id_key" ON "skus"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "skus_store_id_code_key" ON "skus"("store_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "skus_store_id_product_id_option_combination_hash_key" ON "skus"("store_id", "product_id", "option_combination_hash");

-- CreateIndex
CREATE INDEX "media_assets_store_id_status_created_at_idx" ON "media_assets"("store_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_store_id_id_key" ON "media_assets"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_store_id_object_key_key" ON "media_assets"("store_id", "object_key");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_requirements_store_id_id_key" ON "compliance_requirements"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_requirements_store_id_code_version_key" ON "compliance_requirements"("store_id", "code", "version");

-- CreateIndex
CREATE INDEX "compliance_records_store_id_product_id_requirement_id_submi_idx" ON "compliance_records"("store_id", "product_id", "requirement_id", "submitted_at" DESC);

-- CreateIndex
CREATE INDEX "compliance_records_store_id_status_expires_at_idx" ON "compliance_records"("store_id", "status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_records_store_id_id_key" ON "compliance_records"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_versions_store_id_id_key" ON "product_versions"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_versions_store_id_product_id_version_key" ON "product_versions"("store_id", "product_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "product_versions_store_id_product_id_content_hash_key" ON "product_versions"("store_id", "product_id", "content_hash");

-- CreateIndex
CREATE UNIQUE INDEX "pages_store_id_id_key" ON "pages"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "pages_store_id_code_key" ON "pages"("store_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "page_versions_store_id_id_key" ON "page_versions"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "page_versions_store_id_page_id_version_key" ON "page_versions"("store_id", "page_id", "version");

-- CreateIndex
CREATE INDEX "page_modules_store_id_page_version_id_sort_order_idx" ON "page_modules"("store_id", "page_version_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "page_modules_store_id_id_key" ON "page_modules"("store_id", "id");

-- Reviewed M2 invariants that Prisma cannot express.
ALTER TABLE "categories" ADD CONSTRAINT "categories_shape_check" CHECK (
  ("depth" = 1 AND "parent_id" IS NULL) OR
  ("depth" = 2 AND "parent_id" IS NOT NULL AND "id" <> "parent_id")
);
ALTER TABLE "attribute_templates" ADD CONSTRAINT "attribute_templates_versions_check" CHECK ("current_version" >= 0 AND "version" > 0);
ALTER TABLE "attribute_template_versions" ADD CONSTRAINT "attribute_template_versions_version_check" CHECK ("version" > 0);
ALTER TABLE "attribute_definitions" ADD CONSTRAINT "attribute_definitions_specification_check" CHECK ("purpose" <> 'SPECIFICATION' OR "data_type" = 'OPTION');
ALTER TABLE "products" ADD CONSTRAINT "products_version_check" CHECK ("version" > 0);
ALTER TABLE "product_attribute_values" ADD CONSTRAINT "product_attribute_values_one_value_check" CHECK (
  num_nonnulls("text_value", "integer_value", "decimal_value", "boolean_value", "date_value", "option_id") = 1
);
ALTER TABLE "skus" ADD CONSTRAINT "skus_amounts_check" CHECK (
  "sale_price_vnd" >= 0 AND
  ("market_price_vnd" IS NULL OR "market_price_vnd" >= 0) AND
  ("cost_price_vnd" IS NULL OR "cost_price_vnd" >= 0) AND
  ("weight_grams" IS NULL OR "weight_grams" > 0) AND
  ("length_millimeters" IS NULL OR "length_millimeters" > 0) AND
  ("width_millimeters" IS NULL OR "width_millimeters" > 0) AND
  ("height_millimeters" IS NULL OR "height_millimeters" > 0) AND
  length("option_combination_key") > 0 AND
  "option_combination_hash" ~ '^[a-f0-9]{64}$'
);
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_metadata_check" CHECK (
  "byte_size" > 0 AND
  ("width" IS NULL OR "width" > 0) AND
  ("height" IS NULL OR "height" > 0) AND
  "checksum_sha256" ~ '^[a-f0-9]{64}$' AND
  "object_key" ~ ('^[a-z0-9_-]+/' || "store_id"::text || '/(brand|category|product|sku|page|compliance)/[0-9a-f-]{36}$')
);
ALTER TABLE "compliance_requirements" ADD CONSTRAINT "compliance_requirements_version_check" CHECK ("version" > 0 AND ("validity_days" IS NULL OR "validity_days" > 0));
ALTER TABLE "compliance_records" ADD CONSTRAINT "compliance_records_review_check" CHECK (
  "version" > 0 AND
  ("reviewed_by" IS NULL OR "reviewed_by" <> "submitted_by") AND
  (("status" IN ('APPROVED', 'REJECTED') AND "reviewed_by" IS NOT NULL AND "reviewed_at" IS NOT NULL) OR
   ("status" NOT IN ('APPROVED', 'REJECTED')))
);
ALTER TABLE "product_versions" ADD CONSTRAINT "product_versions_version_check" CHECK ("version" > 0 AND "content_hash" ~ '^[a-f0-9]{64}$');
ALTER TABLE "pages" ADD CONSTRAINT "pages_version_check" CHECK ("version" > 0);
ALTER TABLE "page_versions" ADD CONSTRAINT "page_versions_version_check" CHECK ("version" > 0);
ALTER TABLE "page_modules" ADD CONSTRAINT "page_modules_visibility_check" CHECK ("visible_to" IS NULL OR "visible_from" IS NULL OR "visible_to" > "visible_from");

CREATE UNIQUE INDEX "category_attribute_templates_primary_key" ON "category_attribute_templates"("store_id", "category_id") WHERE "is_primary";
CREATE UNIQUE INDEX "product_media_primary_key" ON "product_media"("store_id", "product_id") WHERE "purpose" = 'PRIMARY';
CREATE UNIQUE INDEX "attribute_options_store_id_id_attribute_definition_id_key" ON "attribute_options"("store_id", "id", "attribute_definition_id");

-- Every M2 relation includes store_id so a foreign identifier from another store
-- cannot be attached even if the caller knows its UUID.
ALTER TABLE "brands" ADD CONSTRAINT "brands_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "brand_localizations" ADD CONSTRAINT "brand_localizations_brand_fkey" FOREIGN KEY ("store_id", "brand_id") REFERENCES "brands"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "categories" ADD CONSTRAINT "categories_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_fkey" FOREIGN KEY ("store_id", "parent_id") REFERENCES "categories"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "category_localizations" ADD CONSTRAINT "category_localizations_category_fkey" FOREIGN KEY ("store_id", "category_id") REFERENCES "categories"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "attribute_templates" ADD CONSTRAINT "attribute_templates_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "attribute_template_versions" ADD CONSTRAINT "attribute_template_versions_template_fkey" FOREIGN KEY ("store_id", "template_id") REFERENCES "attribute_templates"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "attribute_definitions" ADD CONSTRAINT "attribute_definitions_template_version_fkey" FOREIGN KEY ("store_id", "template_version_id") REFERENCES "attribute_template_versions"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "attribute_options" ADD CONSTRAINT "attribute_options_definition_fkey" FOREIGN KEY ("store_id", "attribute_definition_id") REFERENCES "attribute_definitions"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "category_attribute_templates" ADD CONSTRAINT "category_attribute_templates_category_fkey" FOREIGN KEY ("store_id", "category_id") REFERENCES "categories"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "category_attribute_templates" ADD CONSTRAINT "category_attribute_templates_version_fkey" FOREIGN KEY ("store_id", "template_version_id") REFERENCES "attribute_template_versions"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "products" ADD CONSTRAINT "products_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "products" ADD CONSTRAINT "products_brand_fkey" FOREIGN KEY ("store_id", "brand_id") REFERENCES "brands"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "products" ADD CONSTRAINT "products_main_category_fkey" FOREIGN KEY ("store_id", "main_category_id") REFERENCES "categories"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "products" ADD CONSTRAINT "products_template_version_fkey" FOREIGN KEY ("store_id", "attribute_template_version_id") REFERENCES "attribute_template_versions"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_secondary_categories" ADD CONSTRAINT "product_secondary_categories_product_fkey" FOREIGN KEY ("store_id", "product_id") REFERENCES "products"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_secondary_categories" ADD CONSTRAINT "product_secondary_categories_category_fkey" FOREIGN KEY ("store_id", "category_id") REFERENCES "categories"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_localizations" ADD CONSTRAINT "product_localizations_product_fkey" FOREIGN KEY ("store_id", "product_id") REFERENCES "products"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_attribute_values" ADD CONSTRAINT "product_attribute_values_product_fkey" FOREIGN KEY ("store_id", "product_id") REFERENCES "products"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_attribute_values" ADD CONSTRAINT "product_attribute_values_definition_fkey" FOREIGN KEY ("store_id", "attribute_definition_id") REFERENCES "attribute_definitions"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_attribute_values" ADD CONSTRAINT "product_attribute_values_option_fkey" FOREIGN KEY ("store_id", "option_id", "attribute_definition_id") REFERENCES "attribute_options"("store_id", "id", "attribute_definition_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "skus" ADD CONSTRAINT "skus_product_fkey" FOREIGN KEY ("store_id", "product_id") REFERENCES "products"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sku_option_values" ADD CONSTRAINT "sku_option_values_sku_fkey" FOREIGN KEY ("store_id", "sku_id") REFERENCES "skus"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sku_option_values" ADD CONSTRAINT "sku_option_values_definition_fkey" FOREIGN KEY ("store_id", "attribute_definition_id") REFERENCES "attribute_definitions"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sku_option_values" ADD CONSTRAINT "sku_option_values_option_fkey" FOREIGN KEY ("store_id", "option_id", "attribute_definition_id") REFERENCES "attribute_options"("store_id", "id", "attribute_definition_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "brand_media" ADD CONSTRAINT "brand_media_brand_fkey" FOREIGN KEY ("store_id", "brand_id") REFERENCES "brands"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "brand_media" ADD CONSTRAINT "brand_media_media_fkey" FOREIGN KEY ("store_id", "media_id") REFERENCES "media_assets"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "category_media" ADD CONSTRAINT "category_media_category_fkey" FOREIGN KEY ("store_id", "category_id") REFERENCES "categories"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "category_media" ADD CONSTRAINT "category_media_media_fkey" FOREIGN KEY ("store_id", "media_id") REFERENCES "media_assets"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_media" ADD CONSTRAINT "product_media_product_fkey" FOREIGN KEY ("store_id", "product_id") REFERENCES "products"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_media" ADD CONSTRAINT "product_media_media_fkey" FOREIGN KEY ("store_id", "media_id") REFERENCES "media_assets"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sku_media" ADD CONSTRAINT "sku_media_sku_fkey" FOREIGN KEY ("store_id", "sku_id") REFERENCES "skus"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sku_media" ADD CONSTRAINT "sku_media_media_fkey" FOREIGN KEY ("store_id", "media_id") REFERENCES "media_assets"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "compliance_requirements" ADD CONSTRAINT "compliance_requirements_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "compliance_requirements" ADD CONSTRAINT "compliance_requirements_category_fkey" FOREIGN KEY ("store_id", "category_id") REFERENCES "categories"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "compliance_records" ADD CONSTRAINT "compliance_records_product_fkey" FOREIGN KEY ("store_id", "product_id") REFERENCES "products"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "compliance_records" ADD CONSTRAINT "compliance_records_requirement_fkey" FOREIGN KEY ("store_id", "requirement_id") REFERENCES "compliance_requirements"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "compliance_records" ADD CONSTRAINT "compliance_records_supersedes_fkey" FOREIGN KEY ("store_id", "supersedes_record_id") REFERENCES "compliance_records"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "compliance_record_media" ADD CONSTRAINT "compliance_record_media_record_fkey" FOREIGN KEY ("store_id", "compliance_record_id") REFERENCES "compliance_records"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "compliance_record_media" ADD CONSTRAINT "compliance_record_media_media_fkey" FOREIGN KEY ("store_id", "media_id") REFERENCES "media_assets"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_versions" ADD CONSTRAINT "product_versions_product_fkey" FOREIGN KEY ("store_id", "product_id") REFERENCES "products"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pages" ADD CONSTRAINT "pages_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "page_versions" ADD CONSTRAINT "page_versions_page_fkey" FOREIGN KEY ("store_id", "page_id") REFERENCES "pages"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pages" ADD CONSTRAINT "pages_published_version_fkey" FOREIGN KEY ("store_id", "current_published_version_id") REFERENCES "page_versions"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "page_modules" ADD CONSTRAINT "page_modules_version_fkey" FOREIGN KEY ("store_id", "page_version_id") REFERENCES "page_versions"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "page_module_localizations" ADD CONSTRAINT "page_module_localizations_module_fkey" FOREIGN KEY ("store_id", "page_module_id") REFERENCES "page_modules"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "page_module_media" ADD CONSTRAINT "page_module_media_module_fkey" FOREIGN KEY ("store_id", "page_module_id") REFERENCES "page_modules"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "page_module_media" ADD CONSTRAINT "page_module_media_media_fkey" FOREIGN KEY ("store_id", "media_id") REFERENCES "media_assets"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "app_security"."reject_finalized_catalog_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'attribute_template_versions' AND OLD.status = 'ACTIVE' THEN
    RAISE EXCEPTION 'activated attribute template versions are immutable' USING ERRCODE = '42501';
  ELSIF TG_TABLE_NAME = 'compliance_records' AND OLD.status IN ('APPROVED', 'REJECTED', 'SUPERSEDED') THEN
    RAISE EXCEPTION 'reviewed compliance records are immutable' USING ERRCODE = '42501';
  ELSIF TG_TABLE_NAME IN ('product_versions', 'page_versions') AND OLD.publication_status IN ('PUBLISHED', 'WITHDRAWN') THEN
    RAISE EXCEPTION 'published versions are immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "attribute_template_versions_immutable" BEFORE UPDATE OR DELETE ON "attribute_template_versions" FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_finalized_catalog_mutation"();
CREATE TRIGGER "compliance_records_immutable" BEFORE UPDATE OR DELETE ON "compliance_records" FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_finalized_catalog_mutation"();
CREATE TRIGGER "product_versions_immutable" BEFORE UPDATE OR DELETE ON "product_versions" FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_finalized_catalog_mutation"();
CREATE TRIGGER "page_versions_immutable" BEFORE UPDATE OR DELETE ON "page_versions" FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_finalized_catalog_mutation"();

CREATE OR REPLACE FUNCTION "app_security"."reject_immutable_catalog_child"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status text;
BEGIN
  IF TG_TABLE_NAME IN ('attribute_definitions', 'attribute_options') THEN
    IF TG_TABLE_NAME = 'attribute_definitions' THEN
      SELECT status::text INTO parent_status FROM attribute_template_versions
      WHERE store_id = OLD.store_id AND id = OLD.template_version_id;
    ELSE
      SELECT atv.status::text INTO parent_status
      FROM attribute_definitions ad
      JOIN attribute_template_versions atv ON atv.store_id = ad.store_id AND atv.id = ad.template_version_id
      WHERE ad.store_id = OLD.store_id AND ad.id = OLD.attribute_definition_id;
    END IF;
    IF parent_status = 'ACTIVE' THEN
      RAISE EXCEPTION 'activated attribute template content is immutable' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF TG_TABLE_NAME IN ('page_modules') THEN
      SELECT publication_status::text INTO parent_status FROM page_versions
      WHERE store_id = OLD.store_id AND id = OLD.page_version_id;
    ELSE
      SELECT pv.publication_status::text INTO parent_status
      FROM page_modules pm JOIN page_versions pv ON pv.store_id = pm.store_id AND pv.id = pm.page_version_id
      WHERE pm.store_id = OLD.store_id AND pm.id = OLD.page_module_id;
    END IF;
    IF parent_status IN ('PUBLISHED', 'WITHDRAWN') THEN
      RAISE EXCEPTION 'published page version content is immutable' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "attribute_definitions_parent_immutable" BEFORE UPDATE OR DELETE ON "attribute_definitions" FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_immutable_catalog_child"();
CREATE TRIGGER "attribute_options_parent_immutable" BEFORE UPDATE OR DELETE ON "attribute_options" FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_immutable_catalog_child"();
CREATE TRIGGER "page_modules_parent_immutable" BEFORE UPDATE OR DELETE ON "page_modules" FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_immutable_catalog_child"();
CREATE TRIGGER "page_module_localizations_parent_immutable" BEFORE UPDATE OR DELETE ON "page_module_localizations" FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_immutable_catalog_child"();
CREATE TRIGGER "page_module_media_parent_immutable" BEFORE UPDATE OR DELETE ON "page_module_media" FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_immutable_catalog_child"();

CREATE OR REPLACE FUNCTION "app_security"."reject_main_category_duplication"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM products p
    WHERE p.store_id = NEW.store_id AND p.id = NEW.product_id AND p.main_category_id = NEW.category_id
  ) THEN
    RAISE EXCEPTION 'main category cannot also be secondary' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "product_secondary_categories_main_guard" BEFORE INSERT OR UPDATE ON "product_secondary_categories" FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_main_category_duplication"();

CREATE OR REPLACE FUNCTION "app_security"."refresh_sku_option_combination"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_store uuid := COALESCE(NEW.store_id, OLD.store_id);
DECLARE target_sku uuid := COALESCE(NEW.sku_id, OLD.sku_id);
DECLARE combination text;
BEGIN
  IF TG_OP <> 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM attribute_definitions ad
    WHERE ad.store_id = NEW.store_id AND ad.id = NEW.attribute_definition_id AND ad.purpose = 'SPECIFICATION'
  ) THEN
    RAISE EXCEPTION 'SKU options require SPECIFICATION attributes' USING ERRCODE = '23514';
  END IF;
  SELECT string_agg(ad.code || '=' || ao.code, '&' ORDER BY ad.code)
    INTO combination
  FROM sku_option_values sov
  JOIN attribute_definitions ad ON ad.store_id = sov.store_id AND ad.id = sov.attribute_definition_id
  JOIN attribute_options ao ON ao.store_id = sov.store_id AND ao.id = sov.option_id AND ao.attribute_definition_id = sov.attribute_definition_id
  WHERE sov.store_id = target_store AND sov.sku_id = target_sku;
  IF combination IS NOT NULL THEN
    UPDATE skus SET option_combination_key = combination,
      option_combination_hash = encode(digest(combination, 'sha256'), 'hex'),
      updated_at = now(), version = version + 1
    WHERE store_id = target_store AND id = target_sku;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "sku_option_values_refresh_combination" AFTER INSERT OR UPDATE OR DELETE ON "sku_option_values" FOR EACH ROW EXECUTE FUNCTION "app_security"."refresh_sku_option_combination"();

REVOKE ALL ON FUNCTION "app_security"."reject_finalized_catalog_mutation"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "app_security"."reject_immutable_catalog_child"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "app_security"."reject_main_category_duplication"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "app_security"."refresh_sku_option_combination"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app_security"."reject_finalized_catalog_mutation"(), "app_security"."reject_immutable_catalog_child"(), "app_security"."reject_main_category_duplication"(), "app_security"."refresh_sku_option_combination"() TO zalo_shop_runtime;

-- RLS and store ownership immutability are deliberately generated from a fixed
-- table list so newly added M2 tables cannot accidentally inherit owner access.
DO $m2_security$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'brands','brand_localizations','categories','category_localizations',
    'attribute_templates','attribute_template_versions','attribute_definitions','attribute_options','category_attribute_templates',
    'products','product_secondary_categories','product_localizations','product_attribute_values','skus','sku_option_values',
    'media_assets','brand_media','category_media','product_media','sku_media',
    'compliance_requirements','compliance_records','compliance_record_media','product_versions',
    'pages','page_versions','page_modules','page_module_localizations','page_module_media'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION app_security.reject_store_change()', table_name || '_store_immutable', table_name);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON %I USING (store_id = app_security.current_store_id()) WITH CHECK (store_id = app_security.current_store_id())', table_name || '_tenant_isolation', table_name);
  END LOOP;
END
$m2_security$;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  "brands", "brand_localizations", "categories", "category_localizations",
  "attribute_templates", "attribute_template_versions", "attribute_definitions", "attribute_options", "category_attribute_templates",
  "products", "product_secondary_categories", "product_localizations", "product_attribute_values", "skus", "sku_option_values",
  "media_assets", "brand_media", "category_media", "product_media", "sku_media",
  "compliance_requirements", "compliance_records", "compliance_record_media", "product_versions",
  "pages", "page_versions", "page_modules", "page_module_localizations", "page_module_media"
TO zalo_shop_runtime;
