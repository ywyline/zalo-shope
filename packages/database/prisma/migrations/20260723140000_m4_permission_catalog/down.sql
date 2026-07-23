-- LOCAL/TEST ONLY. Refuse rollback after M4 business facts exist.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "orders" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "addresses" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "order_items" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "order_snapshots" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "order_transitions" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "idempotency_records" LIMIT 1)
  THEN
    RAISE EXCEPTION 'M4 permission rollback is unsafe after business facts exist'
      USING ERRCODE = '55000';
  END IF;
END
$$;

DELETE FROM "store_role_permissions" WHERE "permission_code" IN (
  'store.orders.read', 'store.orders.manage',
  'store.delivery.read', 'store.delivery.manage'
);
DELETE FROM "platform_role_permissions" WHERE "permission_code" IN (
  'store.orders.read', 'store.orders.manage',
  'store.delivery.read', 'store.delivery.manage'
);
DELETE FROM "permissions" WHERE "code" IN (
  'store.orders.read', 'store.orders.manage',
  'store.delivery.read', 'store.delivery.manage'
);
