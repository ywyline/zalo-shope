-- LOCAL/TEST ONLY. Refuse rollback after any M6 business fact exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "store_after_sale_settings" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "after_sale_policies" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "after_sale_policy_versions" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "after_sale_policy_localizations" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "after_sale_policy_draft_products" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "after_sale_policy_version_assignments" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "after_sale_active_policy_assignments" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "order_item_after_sale_policy_snapshots" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "after_sales" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "after_sale_items" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "after_sale_transitions" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "after_sale_operations" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "after_sale_legacy_decisions" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "after_sale_order_allocations" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "after_sale_inspections" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "after_sale_inspection_allocations" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "after_sale_evidence_files" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "after_sale_evidence_transitions" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "after_sale_settlements" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "after_sale_refunds" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "after_sale_inventory_actions" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "after_sale_return_shipments" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "exchange_fulfillments" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "member_favorites" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "member_product_views" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "privacy_requests" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "privacy_request_transitions" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "share_links" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "share_link_localizations" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "share_interactions" LIMIT 1)
  THEN
    RAISE EXCEPTION 'M6.2 permission rollback is unsafe after business facts exist'
      USING ERRCODE = '55000';
  END IF;
END
$$;

DELETE FROM "store_role_permissions" WHERE "permission_code" IN (
  'store.after-sales.read', 'store.after-sales.review',
  'store.after-sales.inspect', 'store.after-sales.exchange',
  'store.after-sales.evidence.read',
  'store.after-sales.policy.read', 'store.after-sales.policy.manage',
  'store.after-sales.policy.publish', 'store.after-sales.policy.disable',
  'store.after-sales.policy.enforce',
  'store.after-sales.cod-refunds.request', 'store.after-sales.cod-refunds.confirm'
);
DELETE FROM "platform_role_permissions" WHERE "permission_code" IN (
  'store.after-sales.read', 'store.after-sales.review',
  'store.after-sales.inspect', 'store.after-sales.exchange',
  'store.after-sales.evidence.read',
  'store.after-sales.policy.read', 'store.after-sales.policy.manage',
  'store.after-sales.policy.publish', 'store.after-sales.policy.disable',
  'store.after-sales.policy.enforce',
  'store.after-sales.cod-refunds.request', 'store.after-sales.cod-refunds.confirm'
);
DELETE FROM "permissions" WHERE "code" IN (
  'store.after-sales.read', 'store.after-sales.review',
  'store.after-sales.inspect', 'store.after-sales.exchange',
  'store.after-sales.evidence.read',
  'store.after-sales.policy.read', 'store.after-sales.policy.manage',
  'store.after-sales.policy.publish', 'store.after-sales.policy.disable',
  'store.after-sales.policy.enforce',
  'store.after-sales.cod-refunds.request', 'store.after-sales.cod-refunds.confirm'
);
