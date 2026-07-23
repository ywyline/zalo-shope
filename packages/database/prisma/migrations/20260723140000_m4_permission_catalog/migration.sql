-- Register M4 permission codes without assigning them to any production role.
-- Local/test store-admin assignment remains an explicit seed concern.
INSERT INTO "permissions" ("code", "scope", "description") VALUES
  ('store.orders.read', 'STORE', 'Read current store orders'),
  ('store.orders.manage', 'STORE', 'Manage current store orders and COD'),
  ('store.delivery.read', 'STORE', 'Read current store delivery policy'),
  ('store.delivery.manage', 'STORE', 'Manage current store delivery policy')
ON CONFLICT ("code") DO UPDATE SET
  "scope" = EXCLUDED."scope",
  "description" = EXCLUDED."description";
