WITH fixture_stores(store_id) AS (
  VALUES
    ('f2000000-0000-4000-8000-000000000001'::uuid),
    ('f2000000-0000-4000-8000-000000000002'::uuid)
), fingerprint_rows(table_name, row_data) AS (
  SELECT 'stores', to_jsonb(source)
  FROM (SELECT * FROM stores WHERE id IN (SELECT store_id FROM fixture_stores)) source
  UNION ALL
  SELECT 'store_localizations', to_jsonb(source)
  FROM (
    SELECT * FROM store_localizations WHERE store_id IN (SELECT store_id FROM fixture_stores)
  ) source
  UNION ALL
  SELECT 'store_roles', to_jsonb(source)
  FROM (SELECT * FROM store_roles WHERE store_id IN (SELECT store_id FROM fixture_stores)) source
  UNION ALL
  SELECT 'store_role_permissions', to_jsonb(source)
  FROM (
    SELECT * FROM store_role_permissions WHERE store_id IN (SELECT store_id FROM fixture_stores)
  ) source
  UNION ALL
  SELECT 'members', to_jsonb(source)
  FROM (SELECT * FROM members WHERE store_id IN (SELECT store_id FROM fixture_stores)) source
  UNION ALL
  SELECT 'brands', to_jsonb(source)
  FROM (SELECT * FROM brands WHERE store_id IN (SELECT store_id FROM fixture_stores)) source
  UNION ALL
  SELECT 'brand_localizations', to_jsonb(source)
  FROM (
    SELECT * FROM brand_localizations WHERE store_id IN (SELECT store_id FROM fixture_stores)
  ) source
  UNION ALL
  SELECT 'categories', to_jsonb(source)
  FROM (SELECT * FROM categories WHERE store_id IN (SELECT store_id FROM fixture_stores)) source
  UNION ALL
  SELECT 'category_localizations', to_jsonb(source)
  FROM (
    SELECT * FROM category_localizations WHERE store_id IN (SELECT store_id FROM fixture_stores)
  ) source
  UNION ALL
  SELECT 'attribute_templates', to_jsonb(source)
  FROM (
    SELECT * FROM attribute_templates WHERE store_id IN (SELECT store_id FROM fixture_stores)
  ) source
  UNION ALL
  SELECT 'attribute_template_versions', to_jsonb(source)
  FROM (
    SELECT * FROM attribute_template_versions
    WHERE store_id IN (SELECT store_id FROM fixture_stores)
  ) source
  UNION ALL
  SELECT 'attribute_definitions', to_jsonb(source)
  FROM (
    SELECT * FROM attribute_definitions WHERE store_id IN (SELECT store_id FROM fixture_stores)
  ) source
  UNION ALL
  SELECT 'attribute_options', to_jsonb(source)
  FROM (
    SELECT * FROM attribute_options WHERE store_id IN (SELECT store_id FROM fixture_stores)
  ) source
  UNION ALL
  SELECT 'category_attribute_templates', to_jsonb(source)
  FROM (
    SELECT * FROM category_attribute_templates
    WHERE store_id IN (SELECT store_id FROM fixture_stores)
  ) source
  UNION ALL
  SELECT 'products', to_jsonb(source)
  FROM (SELECT * FROM products WHERE store_id IN (SELECT store_id FROM fixture_stores)) source
  UNION ALL
  SELECT 'product_secondary_categories', to_jsonb(source)
  FROM (
    SELECT * FROM product_secondary_categories
    WHERE store_id IN (SELECT store_id FROM fixture_stores)
  ) source
  UNION ALL
  SELECT 'product_localizations', to_jsonb(source)
  FROM (
    SELECT * FROM product_localizations WHERE store_id IN (SELECT store_id FROM fixture_stores)
  ) source
  UNION ALL
  SELECT 'product_attribute_values', to_jsonb(source)
  FROM (
    SELECT * FROM product_attribute_values WHERE store_id IN (SELECT store_id FROM fixture_stores)
  ) source
  UNION ALL
  SELECT 'skus', to_jsonb(source)
  FROM (SELECT * FROM skus WHERE store_id IN (SELECT store_id FROM fixture_stores)) source
  UNION ALL
  SELECT 'sku_option_values', to_jsonb(source)
  FROM (
    SELECT * FROM sku_option_values WHERE store_id IN (SELECT store_id FROM fixture_stores)
  ) source
  UNION ALL
  SELECT 'product_versions', to_jsonb(source)
  FROM (
    SELECT * FROM product_versions WHERE store_id IN (SELECT store_id FROM fixture_stores)
  ) source
)
SELECT encode(
  digest(
    COALESCE(
      jsonb_agg(
        jsonb_build_object('table', table_name, 'row', row_data)
        ORDER BY table_name, row_data::text
      ),
      '[]'::jsonb
    )::text,
    'sha256'
  ),
  'hex'
) AS fingerprint
FROM fingerprint_rows;
