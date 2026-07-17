-- Forward fix: the generic trigger runs on tables whose status columns use
-- different PostgreSQL enum types. Compare their textual values so a branch
-- for one table never attempts to cast another table's status literals.
CREATE OR REPLACE FUNCTION "app_security"."reject_finalized_catalog_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'attribute_template_versions' THEN
    IF CAST(OLD.status AS text) = 'ACTIVE' THEN
      RAISE EXCEPTION 'activated attribute template versions are immutable' USING ERRCODE = '42501';
    END IF;
  ELSIF TG_TABLE_NAME = 'compliance_records' THEN
    IF CAST(OLD.status AS text) IN ('APPROVED', 'REJECTED', 'SUPERSEDED') THEN
      RAISE EXCEPTION 'reviewed compliance records are immutable' USING ERRCODE = '42501';
    END IF;
  ELSIF TG_TABLE_NAME IN ('product_versions', 'page_versions') THEN
    IF CAST(OLD.publication_status AS text) IN ('PUBLISHED', 'WITHDRAWN') THEN
      RAISE EXCEPTION 'published versions are immutable' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION "app_security"."reject_finalized_catalog_mutation"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app_security"."reject_finalized_catalog_mutation"() TO zalo_shop_runtime;
