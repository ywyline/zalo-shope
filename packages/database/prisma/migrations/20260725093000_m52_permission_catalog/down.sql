-- LOCAL/TEST ONLY. Refuse rollback after any M5 channel or business fact exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "store_payment_channels" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "store_shipping_channels" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "payment_attempts" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "provider_callbacks" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "refunds" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "shipments" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "tracking_events" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "outbox_messages" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "inbox_messages" LIMIT 1)
  THEN
    RAISE EXCEPTION 'M5 permission rollback is unsafe after channel or business facts exist'
      USING ERRCODE = '55000';
  END IF;
END
$$;

DELETE FROM "store_role_permissions" WHERE "permission_code" IN (
  'store.payments.read', 'store.payments.reconcile',
  'store.refunds.read', 'store.refunds.create',
  'store.shipments.read', 'store.shipments.create', 'store.shipments.cancel',
  'store.shipments.label.read', 'store.shipments.reconcile',
  'store.integrations.read', 'store.integrations.manage',
  'store.integration-jobs.retry'
);
DELETE FROM "platform_role_permissions" WHERE "permission_code" IN (
  'store.payments.read', 'store.payments.reconcile',
  'store.refunds.read', 'store.refunds.create',
  'store.shipments.read', 'store.shipments.create', 'store.shipments.cancel',
  'store.shipments.label.read', 'store.shipments.reconcile',
  'store.integrations.read', 'store.integrations.manage',
  'store.integration-jobs.retry'
);
DELETE FROM "permissions" WHERE "code" IN (
  'store.payments.read', 'store.payments.reconcile',
  'store.refunds.read', 'store.refunds.create',
  'store.shipments.read', 'store.shipments.create', 'store.shipments.cancel',
  'store.shipments.label.read', 'store.shipments.reconcile',
  'store.integrations.read', 'store.integrations.manage',
  'store.integration-jobs.retry'
);
