-- M5.2 permission catalog. Production role assignment remains an explicit reviewed action.
INSERT INTO "permissions" ("code", "scope", "description") VALUES
  ('store.payments.read', 'STORE', 'Read current store payment attempts and transitions'),
  ('store.payments.reconcile', 'STORE', 'Query and reconcile current store payments'),
  ('store.refunds.read', 'STORE', 'Read current store refunds and refundable balances'),
  ('store.refunds.create', 'STORE', 'Create reviewed current store refunds'),
  ('store.shipments.read', 'STORE', 'Read current store shipments and tracking events'),
  ('store.shipments.create', 'STORE', 'Quote and create current store shipments'),
  ('store.shipments.cancel', 'STORE', 'Request cancellation of current store shipments'),
  ('store.shipments.label.read', 'STORE', 'Read short-lived current store shipment labels'),
  ('store.shipments.reconcile', 'STORE', 'Synchronize and reconcile current store shipments'),
  ('store.integrations.read', 'STORE', 'Read redacted current store integration configuration'),
  ('store.integrations.manage', 'STORE', 'Manage current store integration secret references'),
  ('store.integration-jobs.retry', 'STORE', 'Retry reviewed current store integration jobs')
ON CONFLICT ("code") DO UPDATE SET
  "scope" = EXCLUDED."scope",
  "description" = EXCLUDED."description";
