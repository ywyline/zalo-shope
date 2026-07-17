-- LOCAL/TEST ONLY. Do not run after real media, compliance reviews, product
-- versions, or page versions exist. Production rollback is forward-fix only.
DROP FUNCTION IF EXISTS "app_security"."reject_finalized_catalog_mutation"() CASCADE;
DROP FUNCTION IF EXISTS "app_security"."reject_immutable_catalog_child"() CASCADE;
DROP FUNCTION IF EXISTS "app_security"."reject_main_category_duplication"() CASCADE;
DROP FUNCTION IF EXISTS "app_security"."refresh_sku_option_combination"() CASCADE;

DROP TABLE IF EXISTS "page_module_media" CASCADE;
DROP TABLE IF EXISTS "page_module_localizations" CASCADE;
DROP TABLE IF EXISTS "page_modules" CASCADE;
ALTER TABLE IF EXISTS "pages" DROP CONSTRAINT IF EXISTS "pages_published_version_fkey";
DROP TABLE IF EXISTS "page_versions" CASCADE;
DROP TABLE IF EXISTS "pages" CASCADE;
DROP TABLE IF EXISTS "product_versions" CASCADE;
DROP TABLE IF EXISTS "compliance_record_media" CASCADE;
DROP TABLE IF EXISTS "compliance_records" CASCADE;
DROP TABLE IF EXISTS "compliance_requirements" CASCADE;
DROP TABLE IF EXISTS "sku_media" CASCADE;
DROP TABLE IF EXISTS "product_media" CASCADE;
DROP TABLE IF EXISTS "category_media" CASCADE;
DROP TABLE IF EXISTS "brand_media" CASCADE;
DROP TABLE IF EXISTS "media_assets" CASCADE;
DROP TABLE IF EXISTS "sku_option_values" CASCADE;
DROP TABLE IF EXISTS "skus" CASCADE;
DROP TABLE IF EXISTS "product_attribute_values" CASCADE;
DROP TABLE IF EXISTS "product_localizations" CASCADE;
DROP TABLE IF EXISTS "product_secondary_categories" CASCADE;
DROP TABLE IF EXISTS "products" CASCADE;
DROP TABLE IF EXISTS "category_attribute_templates" CASCADE;
DROP TABLE IF EXISTS "attribute_options" CASCADE;
DROP TABLE IF EXISTS "attribute_definitions" CASCADE;
DROP TABLE IF EXISTS "attribute_template_versions" CASCADE;
DROP TABLE IF EXISTS "attribute_templates" CASCADE;
DROP TABLE IF EXISTS "category_localizations" CASCADE;
DROP TABLE IF EXISTS "categories" CASCADE;
DROP TABLE IF EXISTS "brand_localizations" CASCADE;
DROP TABLE IF EXISTS "brands" CASCADE;

DROP TYPE IF EXISTS "PageTargetType";
DROP TYPE IF EXISTS "PageModuleType";
DROP TYPE IF EXISTS "PageStatus";
DROP TYPE IF EXISTS "PublicationStatus";
DROP TYPE IF EXISTS "ComplianceStatus";
DROP TYPE IF EXISTS "MediaPurpose";
DROP TYPE IF EXISTS "MediaStatus";
DROP TYPE IF EXISTS "AttributePurpose";
DROP TYPE IF EXISTS "AttributeDataType";
DROP TYPE IF EXISTS "AttributeTemplateStatus";
DROP TYPE IF EXISTS "ProductStatus";
