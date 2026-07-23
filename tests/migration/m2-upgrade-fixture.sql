DO $fixture_guard$
BEGIN
  IF current_database() !~ '^zalo_shop_m2_upgrade_[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'M2 upgrade fixture refuses database %', current_database()
      USING ERRCODE = '55000';
  END IF;
  IF to_regclass('public.products') IS NULL OR to_regclass('public.product_versions') IS NULL THEN
    RAISE EXCEPTION 'M2 upgrade fixture requires the complete M2 schema'
      USING ERRCODE = '55000';
  END IF;
  IF to_regclass('public.warehouses') IS NOT NULL THEN
    RAISE EXCEPTION 'M2 upgrade fixture must run before all M3 migrations'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM stores) OR EXISTS (SELECT 1 FROM products) THEN
    RAISE EXCEPTION 'M2 upgrade fixture requires an empty scratch database'
      USING ERRCODE = '55000';
  END IF;
END
$fixture_guard$;

INSERT INTO stores (
  id, code, industry, status, default_locale, timezone, currency, created_at, updated_at
) VALUES
  (
    'f2000000-0000-4000-8000-000000000001', 'm2-upgrade-beauty', 'BEAUTY', 'ACTIVE',
    'vi', 'Asia/Ho_Chi_Minh', 'VND', '2026-07-17 00:00:00+00', '2026-07-17 00:00:00+00'
  ),
  (
    'f2000000-0000-4000-8000-000000000002', 'm2-upgrade-fashion', 'FASHION', 'ACTIVE',
    'vi', 'Asia/Ho_Chi_Minh', 'VND', '2026-07-17 00:00:00+00', '2026-07-17 00:00:00+00'
  );

INSERT INTO store_localizations (
  store_id, locale, display_name, short_description, created_at, updated_at
)
SELECT
  source.store_id,
  localized.locale,
  localized.display_name,
  localized.short_description,
  '2026-07-17 00:00:00+00',
  '2026-07-17 00:00:00+00'
FROM (
  VALUES
    (
      'f2000000-0000-4000-8000-000000000001'::uuid,
      'Mỹ phẩm nâng cấp M2', 'M2 升级美妆商城', 'M2 Upgrade Beauty',
      'Dữ liệu kiểm thử nâng cấp', '升级测试数据', 'Upgrade test data'
    ),
    (
      'f2000000-0000-4000-8000-000000000002'::uuid,
      'Thời trang nâng cấp M2', 'M2 升级服装商城', 'M2 Upgrade Fashion',
      'Dữ liệu kiểm thử nâng cấp', '升级测试数据', 'Upgrade test data'
    )
) AS source(
  store_id, name_vi, name_zh, name_en, description_vi, description_zh, description_en
)
CROSS JOIN LATERAL (
  VALUES
    ('vi'::"Locale", source.name_vi, source.description_vi),
    ('zh'::"Locale", source.name_zh, source.description_zh),
    ('en'::"Locale", source.name_en, source.description_en)
) AS localized(locale, display_name, short_description);

INSERT INTO permissions (code, scope, description)
VALUES ('store.catalog.read', 'STORE', 'Read current store catalog');

INSERT INTO store_roles (id, store_id, code, name, is_system, created_at, updated_at) VALUES
  (
    'f2010000-0000-4000-8000-000000000001',
    'f2000000-0000-4000-8000-000000000001',
    'fixture-reader', 'Đọc danh mục', false,
    '2026-07-17 00:05:00+00', '2026-07-17 00:05:00+00'
  ),
  (
    'f2010000-0000-4000-8000-000000000002',
    'f2000000-0000-4000-8000-000000000002',
    'fixture-reader', 'Đọc danh mục', false,
    '2026-07-17 00:05:00+00', '2026-07-17 00:05:00+00'
  );

INSERT INTO store_role_permissions (store_id, role_id, permission_code) VALUES
  (
    'f2000000-0000-4000-8000-000000000001',
    'f2010000-0000-4000-8000-000000000001',
    'store.catalog.read'
  ),
  (
    'f2000000-0000-4000-8000-000000000002',
    'f2010000-0000-4000-8000-000000000002',
    'store.catalog.read'
  );

INSERT INTO members (
  id, store_id, status, preferred_locale, display_name, created_at, updated_at
) VALUES
  (
    'f2020000-0000-4000-8000-000000000001',
    'f2000000-0000-4000-8000-000000000001',
    'ACTIVE', 'vi', 'Thành viên mỹ phẩm',
    '2026-07-17 00:10:00+00', '2026-07-17 00:10:00+00'
  ),
  (
    'f2020000-0000-4000-8000-000000000002',
    'f2000000-0000-4000-8000-000000000002',
    'ACTIVE', 'vi', 'Thành viên thời trang',
    '2026-07-17 00:10:00+00', '2026-07-17 00:10:00+00'
  );

INSERT INTO brands (
  id, store_id, code, status, country_code, recommended, sort_order, version,
  created_at, updated_at
) VALUES
  (
    'f2100000-0000-4000-8000-000000000001',
    'f2000000-0000-4000-8000-000000000001',
    'shared-brand', 'ACTIVE', 'VN', true, 10, 3,
    '2026-07-17 01:00:00+00', '2026-07-17 01:00:00+00'
  ),
  (
    'f2100000-0000-4000-8000-000000000002',
    'f2000000-0000-4000-8000-000000000002',
    'shared-brand', 'ACTIVE', 'VN', true, 10, 3,
    '2026-07-17 01:00:00+00', '2026-07-17 01:00:00+00'
  );

INSERT INTO brand_localizations (
  store_id, brand_id, locale, name, introduction, created_at, updated_at
)
SELECT
  source.store_id,
  source.brand_id,
  localized.locale,
  localized.name,
  localized.introduction,
  '2026-07-17 01:00:00+00',
  '2026-07-17 01:00:00+00'
FROM (
  VALUES
    (
      'f2000000-0000-4000-8000-000000000001'::uuid,
      'f2100000-0000-4000-8000-000000000001'::uuid,
      'Nhãn hiệu Đẹp', '美丽品牌', 'Beautiful Brand'
    ),
    (
      'f2000000-0000-4000-8000-000000000002'::uuid,
      'f2100000-0000-4000-8000-000000000002'::uuid,
      'Nhãn hiệu Đẹp', '时尚品牌', 'Fashion Brand'
    )
) AS source(store_id, brand_id, name_vi, name_zh, name_en)
CROSS JOIN LATERAL (
  VALUES
    ('vi'::"Locale", source.name_vi, 'Giới thiệu bằng tiếng Việt'),
    ('zh'::"Locale", source.name_zh, '中文品牌介绍'),
    ('en'::"Locale", source.name_en, 'English brand introduction')
) AS localized(locale, name, introduction);

INSERT INTO categories (
  id, store_id, parent_id, code, depth, status, sort_order, version, created_at, updated_at
) VALUES
  (
    'f2200000-0000-4000-8000-000000000001',
    'f2000000-0000-4000-8000-000000000001',
    NULL, 'catalog', 1, 'ACTIVE', 1, 2,
    '2026-07-17 01:10:00+00', '2026-07-17 01:10:00+00'
  ),
  (
    'f2210000-0000-4000-8000-000000000001',
    'f2000000-0000-4000-8000-000000000001',
    'f2200000-0000-4000-8000-000000000001', 'primary-category', 2,
    'ACTIVE', 1, 2, '2026-07-17 01:10:00+00', '2026-07-17 01:10:00+00'
  ),
  (
    'f2220000-0000-4000-8000-000000000001',
    'f2000000-0000-4000-8000-000000000001',
    'f2200000-0000-4000-8000-000000000001', 'secondary-category', 2,
    'ACTIVE', 2, 2, '2026-07-17 01:10:00+00', '2026-07-17 01:10:00+00'
  ),
  (
    'f2200000-0000-4000-8000-000000000002',
    'f2000000-0000-4000-8000-000000000002',
    NULL, 'catalog', 1, 'ACTIVE', 1, 2,
    '2026-07-17 01:10:00+00', '2026-07-17 01:10:00+00'
  ),
  (
    'f2210000-0000-4000-8000-000000000002',
    'f2000000-0000-4000-8000-000000000002',
    'f2200000-0000-4000-8000-000000000002', 'primary-category', 2,
    'ACTIVE', 1, 2, '2026-07-17 01:10:00+00', '2026-07-17 01:10:00+00'
  ),
  (
    'f2220000-0000-4000-8000-000000000002',
    'f2000000-0000-4000-8000-000000000002',
    'f2200000-0000-4000-8000-000000000002', 'secondary-category', 2,
    'ACTIVE', 2, 2, '2026-07-17 01:10:00+00', '2026-07-17 01:10:00+00'
  );

INSERT INTO category_localizations (
  store_id, category_id, locale, name, description, created_at, updated_at
)
SELECT
  source.store_id,
  source.category_id,
  localized.locale,
  localized.name,
  localized.description,
  '2026-07-17 01:10:00+00',
  '2026-07-17 01:10:00+00'
FROM (
  VALUES
    (
      'f2000000-0000-4000-8000-000000000001'::uuid,
      'f2200000-0000-4000-8000-000000000001'::uuid,
      'Mỹ phẩm', '美妆', 'Beauty'
    ),
    (
      'f2000000-0000-4000-8000-000000000001'::uuid,
      'f2210000-0000-4000-8000-000000000001'::uuid,
      'Son dưỡng', '润唇膏', 'Lip care'
    ),
    (
      'f2000000-0000-4000-8000-000000000001'::uuid,
      'f2220000-0000-4000-8000-000000000001'::uuid,
      'Chăm sóc dịu nhẹ', '温和护理', 'Gentle care'
    ),
    (
      'f2000000-0000-4000-8000-000000000002'::uuid,
      'f2200000-0000-4000-8000-000000000002'::uuid,
      'Thời trang', '服装', 'Fashion'
    ),
    (
      'f2000000-0000-4000-8000-000000000002'::uuid,
      'f2210000-0000-4000-8000-000000000002'::uuid,
      'Áo sơ mi', '衬衫', 'Shirts'
    ),
    (
      'f2000000-0000-4000-8000-000000000002'::uuid,
      'f2220000-0000-4000-8000-000000000002'::uuid,
      'Vải tự nhiên', '天然面料', 'Natural fabric'
    )
) AS source(store_id, category_id, name_vi, name_zh, name_en)
CROSS JOIN LATERAL (
  VALUES
    ('vi'::"Locale", source.name_vi, 'Mô tả tiếng Việt'),
    ('zh'::"Locale", source.name_zh, '中文类目说明'),
    ('en'::"Locale", source.name_en, 'English category description')
) AS localized(locale, name, description);

INSERT INTO attribute_templates (
  id, store_id, code, industry, status, current_version, version, created_at, updated_at
) VALUES
  (
    'f2300000-0000-4000-8000-000000000001',
    'f2000000-0000-4000-8000-000000000001',
    'shared-template', 'BEAUTY', 'ACTIVE', 1, 2,
    '2026-07-17 01:20:00+00', '2026-07-17 01:20:00+00'
  ),
  (
    'f2300000-0000-4000-8000-000000000002',
    'f2000000-0000-4000-8000-000000000002',
    'shared-template', 'FASHION', 'ACTIVE', 1, 2,
    '2026-07-17 01:20:00+00', '2026-07-17 01:20:00+00'
  );

INSERT INTO attribute_template_versions (
  id, store_id, template_id, version, name, status, created_at
) VALUES
  (
    'f2310000-0000-4000-8000-000000000001',
    'f2000000-0000-4000-8000-000000000001',
    'f2300000-0000-4000-8000-000000000001',
    1, 'Thuộc tính mỹ phẩm', 'DRAFT', '2026-07-17 01:20:00+00'
  ),
  (
    'f2310000-0000-4000-8000-000000000002',
    'f2000000-0000-4000-8000-000000000002',
    'f2300000-0000-4000-8000-000000000002',
    1, 'Thuộc tính thời trang', 'DRAFT', '2026-07-17 01:20:00+00'
  );

INSERT INTO attribute_definitions (
  id, store_id, template_version_id, code, data_type, purpose, required, multiple,
  filterable, sort_order, validation_rules, label_vi, label_zh, label_en, created_at
) VALUES
  (
    'f2320000-0000-4000-8000-000000000001',
    'f2000000-0000-4000-8000-000000000001',
    'f2310000-0000-4000-8000-000000000001',
    'color', 'OPTION', 'SPECIFICATION', true, false, true, 1, '{}',
    'Màu', '颜色', 'Color', '2026-07-17 01:20:00+00'
  ),
  (
    'f2340000-0000-4000-8000-000000000001',
    'f2000000-0000-4000-8000-000000000001',
    'f2310000-0000-4000-8000-000000000001',
    'profile', 'TEXT', 'FILTER', true, false, true, 2, '{}',
    'Loại da', '肤质', 'Skin profile', '2026-07-17 01:20:00+00'
  ),
  (
    'f2320000-0000-4000-8000-000000000002',
    'f2000000-0000-4000-8000-000000000002',
    'f2310000-0000-4000-8000-000000000002',
    'color', 'OPTION', 'SPECIFICATION', true, false, true, 1, '{}',
    'Màu', '颜色', 'Color', '2026-07-17 01:20:00+00'
  ),
  (
    'f2340000-0000-4000-8000-000000000002',
    'f2000000-0000-4000-8000-000000000002',
    'f2310000-0000-4000-8000-000000000002',
    'profile', 'TEXT', 'FILTER', true, false, true, 2, '{}',
    'Chất liệu', '材质', 'Material', '2026-07-17 01:20:00+00'
  );

INSERT INTO attribute_options (
  id, store_id, attribute_definition_id, code, label_vi, label_zh, label_en,
  sort_order, status, created_at
) VALUES
  (
    'f2330000-0000-4000-8000-000000000001',
    'f2000000-0000-4000-8000-000000000001',
    'f2320000-0000-4000-8000-000000000001',
    'primary', 'San hô', '珊瑚色', 'Coral', 1, 'ACTIVE', '2026-07-17 01:20:00+00'
  ),
  (
    'f2331000-0000-4000-8000-000000000001',
    'f2000000-0000-4000-8000-000000000001',
    'f2320000-0000-4000-8000-000000000001',
    'secondary', 'Hồng', '粉色', 'Pink', 2, 'ACTIVE', '2026-07-17 01:20:00+00'
  ),
  (
    'f2330000-0000-4000-8000-000000000002',
    'f2000000-0000-4000-8000-000000000002',
    'f2320000-0000-4000-8000-000000000002',
    'primary', 'Đen', '黑色', 'Black', 1, 'ACTIVE', '2026-07-17 01:20:00+00'
  ),
  (
    'f2331000-0000-4000-8000-000000000002',
    'f2000000-0000-4000-8000-000000000002',
    'f2320000-0000-4000-8000-000000000002',
    'secondary', 'Trắng', '白色', 'White', 2, 'ACTIVE', '2026-07-17 01:20:00+00'
  );

INSERT INTO category_attribute_templates (
  store_id, category_id, template_version_id, is_primary, created_at
) VALUES
  (
    'f2000000-0000-4000-8000-000000000001',
    'f2210000-0000-4000-8000-000000000001',
    'f2310000-0000-4000-8000-000000000001', true, '2026-07-17 01:20:00+00'
  ),
  (
    'f2000000-0000-4000-8000-000000000002',
    'f2210000-0000-4000-8000-000000000002',
    'f2310000-0000-4000-8000-000000000002', true, '2026-07-17 01:20:00+00'
  );

UPDATE attribute_template_versions
SET status = 'ACTIVE', activated_at = '2026-07-17 01:30:00+00'
WHERE id IN (
  'f2310000-0000-4000-8000-000000000001',
  'f2310000-0000-4000-8000-000000000002'
);

INSERT INTO products (
  id, store_id, code, brand_id, main_category_id, attribute_template_version_id,
  status, enabled, published_at, version, created_at, updated_at
) VALUES
  (
    'f2400000-0000-4000-8000-000000000001',
    'f2000000-0000-4000-8000-000000000001', 'shared-product',
    'f2100000-0000-4000-8000-000000000001',
    'f2210000-0000-4000-8000-000000000001',
    'f2310000-0000-4000-8000-000000000001',
    'PUBLISHED', true, '2026-07-17 08:00:00+00', 7,
    '2026-07-17 02:00:00+00', '2026-07-17 08:00:00+00'
  ),
  (
    'f2410000-0000-4000-8000-000000000001',
    'f2000000-0000-4000-8000-000000000001', 'draft-product',
    'f2100000-0000-4000-8000-000000000001',
    'f2210000-0000-4000-8000-000000000001',
    'f2310000-0000-4000-8000-000000000001',
    'DRAFT', true, NULL, 2,
    '2026-07-17 02:00:00+00', '2026-07-17 02:00:00+00'
  ),
  (
    'f2400000-0000-4000-8000-000000000002',
    'f2000000-0000-4000-8000-000000000002', 'shared-product',
    'f2100000-0000-4000-8000-000000000002',
    'f2210000-0000-4000-8000-000000000002',
    'f2310000-0000-4000-8000-000000000002',
    'PUBLISHED', true, '2026-07-17 08:05:00+00', 7,
    '2026-07-17 02:00:00+00', '2026-07-17 08:05:00+00'
  ),
  (
    'f2410000-0000-4000-8000-000000000002',
    'f2000000-0000-4000-8000-000000000002', 'draft-product',
    'f2100000-0000-4000-8000-000000000002',
    'f2210000-0000-4000-8000-000000000002',
    'f2310000-0000-4000-8000-000000000002',
    'DRAFT', true, NULL, 2,
    '2026-07-17 02:00:00+00', '2026-07-17 02:00:00+00'
  );

INSERT INTO product_secondary_categories (store_id, product_id, category_id) VALUES
  (
    'f2000000-0000-4000-8000-000000000001',
    'f2400000-0000-4000-8000-000000000001',
    'f2220000-0000-4000-8000-000000000001'
  ),
  (
    'f2000000-0000-4000-8000-000000000002',
    'f2400000-0000-4000-8000-000000000002',
    'f2220000-0000-4000-8000-000000000002'
  );

INSERT INTO product_localizations (
  store_id, product_id, locale, name, subtitle, selling_points, description_document,
  created_at, updated_at
)
SELECT
  source.store_id,
  source.product_id,
  localized.locale,
  localized.name,
  localized.subtitle,
  localized.selling_points,
  '{"type":"doc","fixture":"m2-upgrade-v1"}'::jsonb,
  '2026-07-17 02:00:00+00',
  '2026-07-17 02:00:00+00'
FROM (
  VALUES
    (
      'f2000000-0000-4000-8000-000000000001'::uuid,
      'f2400000-0000-4000-8000-000000000001'::uuid,
      'Son dưỡng ĐẸP', '润唇膏', 'Beautiful Lip Balm'
    ),
    (
      'f2000000-0000-4000-8000-000000000001'::uuid,
      'f2410000-0000-4000-8000-000000000001'::uuid,
      'Bản nháp mỹ phẩm', '美妆草稿', 'Beauty Draft'
    ),
    (
      'f2000000-0000-4000-8000-000000000002'::uuid,
      'f2400000-0000-4000-8000-000000000002'::uuid,
      'Áo sơ mi ĐẸP', '漂亮衬衫', 'Beautiful Shirt'
    ),
    (
      'f2000000-0000-4000-8000-000000000002'::uuid,
      'f2410000-0000-4000-8000-000000000002'::uuid,
      'Bản nháp thời trang', '服装草稿', 'Fashion Draft'
    )
) AS source(store_id, product_id, name_vi, name_zh, name_en)
CROSS JOIN LATERAL (
  VALUES
    ('vi'::"Locale", source.name_vi, 'Phiên bản tiếng Việt', 'Dịu nhẹ và bền đẹp'),
    ('zh'::"Locale", source.name_zh, '中文版本', '清晰的中文卖点'),
    ('en'::"Locale", source.name_en, 'English edition', 'Clear English selling points')
) AS localized(locale, name, subtitle, selling_points);

INSERT INTO product_attribute_values (
  id, store_id, product_id, attribute_definition_id, locale, text_value, created_at
) VALUES
  (
    'f2420000-0000-4000-8000-000000000001',
    'f2000000-0000-4000-8000-000000000001',
    'f2400000-0000-4000-8000-000000000001',
    'f2340000-0000-4000-8000-000000000001',
    'vi', 'Da nhạy cảm', '2026-07-17 02:10:00+00'
  ),
  (
    'f2420000-0000-4000-8000-000000000002',
    'f2000000-0000-4000-8000-000000000002',
    'f2400000-0000-4000-8000-000000000002',
    'f2340000-0000-4000-8000-000000000002',
    'vi', 'Vải lanh', '2026-07-17 02:10:00+00'
  );

INSERT INTO skus (
  id, store_id, product_id, code, sale_price_vnd, market_price_vnd, weight_grams,
  option_combination_key, option_combination_hash, status, version, created_at, updated_at
)
SELECT
  source.id,
  source.store_id,
  source.product_id,
  source.code,
  source.sale_price_vnd,
  source.market_price_vnd,
  source.weight_grams,
  source.combination,
  encode(digest(source.combination, 'sha256'), 'hex'),
  source.status,
  4,
  '2026-07-17 02:20:00+00',
  '2026-07-17 02:20:00+00'
FROM (
  VALUES
    (
      'f2500000-0000-4000-8000-000000000001'::uuid,
      'f2000000-0000-4000-8000-000000000001'::uuid,
      'f2400000-0000-4000-8000-000000000001'::uuid,
      'shared-sku-active', 99000::bigint, 129000::bigint, 50, 'color=primary',
      'ACTIVE'::"RecordStatus"
    ),
    (
      'f2510000-0000-4000-8000-000000000001'::uuid,
      'f2000000-0000-4000-8000-000000000001'::uuid,
      'f2400000-0000-4000-8000-000000000001'::uuid,
      'shared-sku-disabled', 1::bigint, NULL::bigint, 50, 'color=secondary',
      'DISABLED'::"RecordStatus"
    ),
    (
      'f2520000-0000-4000-8000-000000000001'::uuid,
      'f2000000-0000-4000-8000-000000000001'::uuid,
      'f2410000-0000-4000-8000-000000000001'::uuid,
      'draft-sku', 88000::bigint, NULL::bigint, 50, 'color=primary',
      'ACTIVE'::"RecordStatus"
    ),
    (
      'f2500000-0000-4000-8000-000000000002'::uuid,
      'f2000000-0000-4000-8000-000000000002'::uuid,
      'f2400000-0000-4000-8000-000000000002'::uuid,
      'shared-sku-active', 159000::bigint, 199000::bigint, 220, 'color=primary',
      'ACTIVE'::"RecordStatus"
    ),
    (
      'f2510000-0000-4000-8000-000000000002'::uuid,
      'f2000000-0000-4000-8000-000000000002'::uuid,
      'f2400000-0000-4000-8000-000000000002'::uuid,
      'shared-sku-disabled', 2::bigint, NULL::bigint, 220, 'color=secondary',
      'DISABLED'::"RecordStatus"
    ),
    (
      'f2520000-0000-4000-8000-000000000002'::uuid,
      'f2000000-0000-4000-8000-000000000002'::uuid,
      'f2410000-0000-4000-8000-000000000002'::uuid,
      'draft-sku', 129000::bigint, NULL::bigint, 220, 'color=primary',
      'ACTIVE'::"RecordStatus"
    )
) AS source(
  id, store_id, product_id, code, sale_price_vnd, market_price_vnd, weight_grams,
  combination, status
);

INSERT INTO sku_option_values (store_id, sku_id, attribute_definition_id, option_id) VALUES
  (
    'f2000000-0000-4000-8000-000000000001',
    'f2500000-0000-4000-8000-000000000001',
    'f2320000-0000-4000-8000-000000000001',
    'f2330000-0000-4000-8000-000000000001'
  ),
  (
    'f2000000-0000-4000-8000-000000000001',
    'f2510000-0000-4000-8000-000000000001',
    'f2320000-0000-4000-8000-000000000001',
    'f2331000-0000-4000-8000-000000000001'
  ),
  (
    'f2000000-0000-4000-8000-000000000001',
    'f2520000-0000-4000-8000-000000000001',
    'f2320000-0000-4000-8000-000000000001',
    'f2330000-0000-4000-8000-000000000001'
  ),
  (
    'f2000000-0000-4000-8000-000000000002',
    'f2500000-0000-4000-8000-000000000002',
    'f2320000-0000-4000-8000-000000000002',
    'f2330000-0000-4000-8000-000000000002'
  ),
  (
    'f2000000-0000-4000-8000-000000000002',
    'f2510000-0000-4000-8000-000000000002',
    'f2320000-0000-4000-8000-000000000002',
    'f2331000-0000-4000-8000-000000000002'
  ),
  (
    'f2000000-0000-4000-8000-000000000002',
    'f2520000-0000-4000-8000-000000000002',
    'f2320000-0000-4000-8000-000000000002',
    'f2330000-0000-4000-8000-000000000002'
  );

UPDATE skus
SET version = 4, updated_at = '2026-07-17 02:20:00+00'
WHERE store_id IN (
  'f2000000-0000-4000-8000-000000000001',
  'f2000000-0000-4000-8000-000000000002'
);

INSERT INTO product_versions (
  id, store_id, product_id, version, publication_status, snapshot, content_hash,
  created_at, created_by, published_at, published_by, withdrawn_at, withdrawn_by
)
SELECT
  source.id,
  source.store_id,
  source.product_id,
  source.version,
  source.publication_status,
  source.snapshot,
  encode(digest(source.hash_seed, 'sha256'), 'hex'),
  source.created_at,
  'f2ff0000-0000-4000-8000-000000000001',
  source.published_at,
  CASE WHEN source.published_at IS NULL THEN NULL ELSE 'f2ff0000-0000-4000-8000-000000000001'::uuid END,
  source.withdrawn_at,
  CASE WHEN source.withdrawn_at IS NULL THEN NULL ELSE 'f2ff0000-0000-4000-8000-000000000001'::uuid END
FROM (
  VALUES
    (
      'f2600000-0000-4000-8000-000000000001'::uuid,
      'f2000000-0000-4000-8000-000000000001'::uuid,
      'f2400000-0000-4000-8000-000000000001'::uuid,
      2, 'WITHDRAWN'::"PublicationStatus",
      '{"fixture":"m2-upgrade-v1","store":"beauty","version":2}'::jsonb,
      'beauty-product-version-2', '2026-07-17 06:00:00+00'::timestamptz,
      '2026-07-17 06:05:00+00'::timestamptz, '2026-07-17 07:00:00+00'::timestamptz
    ),
    (
      'f2610000-0000-4000-8000-000000000001'::uuid,
      'f2000000-0000-4000-8000-000000000001'::uuid,
      'f2400000-0000-4000-8000-000000000001'::uuid,
      3, 'PUBLISHED'::"PublicationStatus",
      '{"fixture":"m2-upgrade-v1","store":"beauty","version":3}'::jsonb,
      'beauty-product-version-3', '2026-07-17 08:00:00+00'::timestamptz,
      '2026-07-17 08:00:00+00'::timestamptz, NULL::timestamptz
    ),
    (
      'f2620000-0000-4000-8000-000000000001'::uuid,
      'f2000000-0000-4000-8000-000000000001'::uuid,
      'f2410000-0000-4000-8000-000000000001'::uuid,
      1, 'DRAFT'::"PublicationStatus",
      '{"fixture":"m2-upgrade-v1","store":"beauty","draft":true}'::jsonb,
      'beauty-draft-version-1', '2026-07-17 02:00:00+00'::timestamptz,
      NULL::timestamptz, NULL::timestamptz
    ),
    (
      'f2600000-0000-4000-8000-000000000002'::uuid,
      'f2000000-0000-4000-8000-000000000002'::uuid,
      'f2400000-0000-4000-8000-000000000002'::uuid,
      2, 'WITHDRAWN'::"PublicationStatus",
      '{"fixture":"m2-upgrade-v1","store":"fashion","version":2}'::jsonb,
      'fashion-product-version-2', '2026-07-17 06:00:00+00'::timestamptz,
      '2026-07-17 06:05:00+00'::timestamptz, '2026-07-17 07:00:00+00'::timestamptz
    ),
    (
      'f2610000-0000-4000-8000-000000000002'::uuid,
      'f2000000-0000-4000-8000-000000000002'::uuid,
      'f2400000-0000-4000-8000-000000000002'::uuid,
      3, 'PUBLISHED'::"PublicationStatus",
      '{"fixture":"m2-upgrade-v1","store":"fashion","version":3}'::jsonb,
      'fashion-product-version-3', '2026-07-17 08:05:00+00'::timestamptz,
      '2026-07-17 08:05:00+00'::timestamptz, NULL::timestamptz
    ),
    (
      'f2620000-0000-4000-8000-000000000002'::uuid,
      'f2000000-0000-4000-8000-000000000002'::uuid,
      'f2410000-0000-4000-8000-000000000002'::uuid,
      1, 'DRAFT'::"PublicationStatus",
      '{"fixture":"m2-upgrade-v1","store":"fashion","draft":true}'::jsonb,
      'fashion-draft-version-1', '2026-07-17 02:00:00+00'::timestamptz,
      NULL::timestamptz, NULL::timestamptz
    )
) AS source(
  id, store_id, product_id, version, publication_status, snapshot, hash_seed,
  created_at, published_at, withdrawn_at
);
