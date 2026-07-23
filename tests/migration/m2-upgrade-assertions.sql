DO $upgrade_assertions$
DECLARE
  m3_tables text[] := ARRAY[
    'warehouses', 'warehouse_localizations', 'inventory_balances',
    'inventory_operations', 'inventory_reservations', 'inventory_reservation_items',
    'inventory_movements', 'product_search_documents', 'member_search_history',
    'search_query_stats', 'promotions', 'promotion_versions',
    'promotion_version_localizations', 'promotion_targets', 'coupons',
    'member_coupons', 'carts', 'cart_items', 'promotion_operations'
  ];
  public_restricted_functions regprocedure[] := ARRAY[
    'app_security.reject_m3_fact_mutation()'::regprocedure,
    'app_security.enforce_m3_state_transition()'::regprocedure,
    'app_security.assert_coupon_claim_count_for(uuid,uuid)'::regprocedure,
    'app_security.assert_coupon_claim_count()'::regprocedure,
    'app_security.assert_m37_coupon_integrity_rollback_safe()'::regprocedure,
    'app_security.reject_inventory_reservation_mutation()'::regprocedure,
    'app_security.assert_inventory_reservation_definition_for(uuid,uuid)'::regprocedure,
    'app_security.assert_inventory_reservation_terminal_facts_for(uuid,uuid,inventory_reservation_status,uuid,boolean)'::regprocedure,
    'app_security.assert_inventory_reservation_terminal_facts()'::regprocedure,
    'app_security.reject_terminal_reservation_fact_append()'::regprocedure,
    'app_security.assert_terminal_operation_movement_binding()'::regprocedure,
    'app_security.assert_m37_inventory_integrity_rollback_safe()'::regprocedure
  ];
  runtime_forbidden_functions regprocedure[] := ARRAY[
    'app_security.assert_coupon_claim_count_for(uuid,uuid)'::regprocedure,
    'app_security.assert_m37_coupon_integrity_rollback_safe()'::regprocedure,
    'app_security.assert_inventory_reservation_definition_for(uuid,uuid)'::regprocedure,
    'app_security.assert_inventory_reservation_terminal_facts_for(uuid,uuid,inventory_reservation_status,uuid,boolean)'::regprocedure,
    'app_security.assert_m37_inventory_integrity_rollback_safe()'::regprocedure
  ];
  runtime_trigger_functions regprocedure[] := ARRAY[
    'app_security.reject_m3_fact_mutation()'::regprocedure,
    'app_security.enforce_m3_state_transition()'::regprocedure,
    'app_security.assert_coupon_claim_count()'::regprocedure,
    'app_security.reject_inventory_reservation_mutation()'::regprocedure,
    'app_security.assert_inventory_reservation_terminal_facts()'::regprocedure,
    'app_security.reject_terminal_reservation_fact_append()'::regprocedure,
    'app_security.assert_terminal_operation_movement_binding()'::regprocedure
  ];
  actual_count bigint;
BEGIN
  IF current_database() !~ '^zalo_shop_m2_upgrade_[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'M2 upgrade assertions refuse database %', current_database()
      USING ERRCODE = '55000';
  END IF;
  IF to_regclass('public.warehouses') IS NULL
     OR to_regclass('public.promotion_operations') IS NULL
  THEN
    RAISE EXCEPTION 'M2 upgrade assertions require the complete current schema'
      USING ERRCODE = '55000';
  END IF;

  SELECT count(*) INTO actual_count
  FROM stores
  WHERE id IN (
    'f2000000-0000-4000-8000-000000000001',
    'f2000000-0000-4000-8000-000000000002'
  );
  IF actual_count <> 2 THEN
    RAISE EXCEPTION 'fixture stores were not preserved';
  END IF;

  IF (SELECT count(*) FROM products WHERE code = 'shared-product') <> 2
     OR (SELECT count(DISTINCT store_id) FROM products WHERE code = 'shared-product') <> 2
     OR (SELECT count(*) FROM products WHERE code = 'draft-product' AND status = 'DRAFT') <> 2
  THEN
    RAISE EXCEPTION 'same-code store isolation or draft products changed during upgrade';
  END IF;

  IF (SELECT count(*) FROM skus WHERE code = 'shared-sku-active' AND status = 'ACTIVE') <> 2
     OR (SELECT count(*) FROM skus WHERE code = 'shared-sku-disabled' AND status = 'DISABLED') <> 2
     OR (SELECT count(*) FROM skus WHERE code = 'draft-sku' AND status = 'ACTIVE') <> 2
  THEN
    RAISE EXCEPTION 'active, disabled, or draft SKU fixtures changed during upgrade';
  END IF;

  SELECT count(*) INTO actual_count FROM product_search_documents;
  IF actual_count <> 6 THEN
    RAISE EXCEPTION 'expected six trilingual search projections, found %', actual_count;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM product_search_documents document
    JOIN products product
      ON product.store_id = document.store_id AND product.id = document.product_id
    WHERE product.status <> 'PUBLISHED' OR product.code = 'draft-product'
  ) THEN
    RAISE EXCEPTION 'draft or unpublished products entered the M3 search projection';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM product_search_documents document
    JOIN products product
      ON product.store_id = document.store_id AND product.id = document.product_id
    WHERE document.store_id <> product.store_id
       OR document.brand_id <> product.brand_id
       OR document.main_category_id <> product.main_category_id
  ) THEN
    RAISE EXCEPTION 'search projection contains a cross-store catalog relation';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        (
          'f2000000-0000-4000-8000-000000000001'::uuid,
          'f2400000-0000-4000-8000-000000000001'::uuid,
          'f2210000-0000-4000-8000-000000000001'::uuid,
          'f2220000-0000-4000-8000-000000000001'::uuid,
          99000::bigint,
          'Da nhạy cảm'
        ),
        (
          'f2000000-0000-4000-8000-000000000002'::uuid,
          'f2400000-0000-4000-8000-000000000002'::uuid,
          'f2210000-0000-4000-8000-000000000002'::uuid,
          'f2220000-0000-4000-8000-000000000002'::uuid,
          159000::bigint,
          'Vải lanh'
        )
    ) AS expected(store_id, product_id, main_category_id, secondary_category_id, price_vnd, profile)
    LEFT JOIN product_search_documents document
      ON document.store_id = expected.store_id AND document.product_id = expected.product_id
    WHERE document.id IS NULL
       OR document.minimum_sale_price_vnd <> expected.price_vnd
       OR document.source_version <> 3
       OR cardinality(document.category_ids) <> 2
       OR NOT document.category_ids @> ARRAY[
         expected.main_category_id,
         expected.secondary_category_id
       ]::uuid[]
       OR document.filter_values -> 'profile' <> jsonb_build_array(expected.profile)
       OR document.search_vector IS NULL
       OR length(document.search_vector::text) = 0
  ) THEN
    RAISE EXCEPTION 'search price, categories, filters, version, or vector are incorrect';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM product_search_documents
    WHERE store_id = 'f2000000-0000-4000-8000-000000000001'
      AND locale = 'vi'
      AND position('son dưỡng đẹp' IN canonical_text) > 0
      AND position('son duong dep' IN folded_text) > 0
  ) THEN
    RAISE EXCEPTION 'Vietnamese beauty text was not normalized and folded correctly';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM product_search_documents
    WHERE store_id = 'f2000000-0000-4000-8000-000000000002'
      AND locale = 'vi'
      AND position('áo sơ mi đẹp' IN canonical_text) > 0
      AND position('ao so mi dep' IN folded_text) > 0
  ) THEN
    RAISE EXCEPTION 'Vietnamese fashion text was not normalized and folded correctly';
  END IF;

  SELECT sum(fact_count) INTO actual_count
  FROM (
    SELECT count(*) AS fact_count FROM warehouses
    UNION ALL SELECT count(*) FROM warehouse_localizations
    UNION ALL SELECT count(*) FROM inventory_balances
    UNION ALL SELECT count(*) FROM inventory_operations
    UNION ALL SELECT count(*) FROM inventory_reservations
    UNION ALL SELECT count(*) FROM inventory_reservation_items
    UNION ALL SELECT count(*) FROM inventory_movements
    UNION ALL SELECT count(*) FROM member_search_history
    UNION ALL SELECT count(*) FROM search_query_stats
    UNION ALL SELECT count(*) FROM promotions
    UNION ALL SELECT count(*) FROM promotion_versions
    UNION ALL SELECT count(*) FROM promotion_version_localizations
    UNION ALL SELECT count(*) FROM promotion_targets
    UNION ALL SELECT count(*) FROM coupons
    UNION ALL SELECT count(*) FROM member_coupons
    UNION ALL SELECT count(*) FROM carts
    UNION ALL SELECT count(*) FROM cart_items
    UNION ALL SELECT count(*) FROM promotion_operations
  ) facts;
  IF actual_count <> 0 THEN
    RAISE EXCEPTION 'M3 upgrade fabricated non-search commerce facts: %', actual_count;
  END IF;

  IF (
    SELECT count(*) FROM pg_extension WHERE extname IN ('pgcrypto', 'unaccent', 'pg_trgm')
  ) <> 3 THEN
    RAISE EXCEPTION 'required PostgreSQL extensions are incomplete after upgrade';
  END IF;

  IF (
    SELECT count(*)
    FROM permissions
    WHERE code IN (
      'store.inventory.read', 'store.inventory.manage', 'store.inventory.adjust',
      'store.promotions.read', 'store.promotions.manage', 'store.promotions.publish'
    )
  ) <> 6 THEN
    RAISE EXCEPTION 'M3 permission catalog entries are incomplete';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM store_role_permissions
    WHERE store_id IN (
      'f2000000-0000-4000-8000-000000000001',
      'f2000000-0000-4000-8000-000000000002'
    )
      AND permission_code IN (
        'store.inventory.read', 'store.inventory.manage', 'store.inventory.adjust',
        'store.promotions.read', 'store.promotions.manage', 'store.promotions.publish'
      )
  ) THEN
    RAISE EXCEPTION 'M3 migration implicitly granted production-style store permissions';
  END IF;
  IF (
    SELECT count(*)
    FROM store_role_permissions
    WHERE store_id IN (
      'f2000000-0000-4000-8000-000000000001',
      'f2000000-0000-4000-8000-000000000002'
    )
      AND permission_code = 'store.catalog.read'
  ) <> 2 THEN
    RAISE EXCEPTION 'existing M2 role grants were not preserved';
  END IF;

  IF (
    SELECT count(*)
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public' AND relation.relname = ANY(m3_tables)
  ) <> cardinality(m3_tables) THEN
    RAISE EXCEPTION 'one or more expected M3 tables are missing';
  END IF;
  IF (
    SELECT count(*)
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = ANY(m3_tables)
      AND relation.relrowsecurity
      AND relation.relforcerowsecurity
  ) <> cardinality(m3_tables) THEN
    RAISE EXCEPTION 'one or more M3 tables do not force RLS';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'zalo_shop_runtime' AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'runtime role has elevated RLS privileges';
  END IF;

  IF has_table_privilege('zalo_shop_runtime', 'inventory_operations', 'UPDATE')
     OR has_table_privilege('zalo_shop_runtime', 'inventory_operations', 'DELETE')
     OR has_table_privilege('zalo_shop_runtime', 'inventory_movements', 'UPDATE')
     OR has_table_privilege('zalo_shop_runtime', 'inventory_movements', 'DELETE')
     OR has_table_privilege('zalo_shop_runtime', 'inventory_reservation_items', 'UPDATE')
     OR has_table_privilege('zalo_shop_runtime', 'inventory_reservation_items', 'DELETE')
     OR has_table_privilege('zalo_shop_runtime', 'promotion_operations', 'UPDATE')
     OR has_table_privilege('zalo_shop_runtime', 'promotion_operations', 'DELETE')
     OR has_table_privilege('zalo_shop_runtime', 'member_coupons', 'UPDATE')
     OR has_table_privilege('zalo_shop_runtime', 'member_coupons', 'DELETE')
     OR has_table_privilege('zalo_shop_runtime', 'coupons', 'DELETE')
  THEN
    RAISE EXCEPTION 'runtime role can mutate an append-only M3 fact';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(public_restricted_functions) AS target(function_oid)
    JOIN pg_proc function_definition
      ON function_definition.oid = target.function_oid::oid
    CROSS JOIN LATERAL aclexplode(
      COALESCE(
        function_definition.proacl,
        acldefault('f', function_definition.proowner)
      )
    ) AS privilege
    WHERE privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'PUBLIC can execute a protected M3 inventory or coupon function';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM unnest(runtime_forbidden_functions) AS target(function_oid)
    WHERE has_function_privilege(
      'zalo_shop_runtime', target.function_oid::oid, 'EXECUTE'
    )
  ) THEN
    RAISE EXCEPTION 'runtime role can directly execute a protected M3 helper';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM unnest(runtime_trigger_functions) AS target(function_oid)
    WHERE NOT has_function_privilege(
      'zalo_shop_runtime', target.function_oid::oid, 'EXECUTE'
    )
  ) THEN
    RAISE EXCEPTION 'runtime role cannot execute a required M3 trigger function';
  END IF;
END
$upgrade_assertions$;

SET ROLE zalo_shop_runtime;

DO $runtime_without_context$
BEGIN
  IF (SELECT count(*) FROM product_search_documents) <> 0 THEN
    RAISE EXCEPTION 'runtime role can read search documents without store context';
  END IF;
END
$runtime_without_context$;

SELECT set_config('app.store_id', 'f2000000-0000-4000-8000-000000000001', false);

DO $runtime_with_context$
DECLARE
  cross_store_write_blocked boolean := false;
BEGIN
  IF (SELECT count(*) FROM product_search_documents) <> 3 THEN
    RAISE EXCEPTION 'beauty store context did not expose exactly three localized documents';
  END IF;
  IF EXISTS (
    SELECT 1 FROM product_search_documents
    WHERE store_id <> 'f2000000-0000-4000-8000-000000000001'
  ) THEN
    RAISE EXCEPTION 'runtime store context leaked another store search document';
  END IF;

  BEGIN
    INSERT INTO search_query_stats (
      store_id, locale, folded_query, display_query, search_count, result_click_count
    ) VALUES (
      'f2000000-0000-4000-8000-000000000002', 'vi',
      'cross store probe', 'cross store probe', 1, 0
    );
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN
    cross_store_write_blocked := true;
  END;
  IF NOT cross_store_write_blocked THEN
    RAISE EXCEPTION 'runtime RLS accepted a cross-store write';
  END IF;
END
$runtime_with_context$;

RESET ROLE;
RESET app.store_id;
