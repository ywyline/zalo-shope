-- Register M6.2 permission codes without assigning them to any production role.
-- Local/test store-admin assignment remains an explicit seed concern.
INSERT INTO "permissions" ("code", "scope", "description") VALUES
  ('store.after-sales.read', 'STORE', 'Read current store after-sales cases'),
  ('store.after-sales.review', 'STORE', 'Review current store after-sales cases'),
  ('store.after-sales.inspect', 'STORE', 'Inspect current store after-sales returns'),
  ('store.after-sales.exchange', 'STORE', 'Manage current store after-sales exchanges'),
  ('store.after-sales.evidence.read', 'STORE', 'Read current store after-sales evidence'),
  ('store.after-sales.policy.read', 'STORE', 'Read current store after-sales policies'),
  ('store.after-sales.policy.manage', 'STORE', 'Manage current store after-sales policy drafts'),
  ('store.after-sales.policy.publish', 'STORE', 'Publish current store after-sales policy versions'),
  ('store.after-sales.policy.disable', 'STORE', 'Disable current store after-sales policies'),
  ('store.after-sales.policy.enforce', 'STORE', 'Enforce current store after-sales policy snapshots'),
  ('store.after-sales.cod-refunds.request', 'STORE', 'Request current store COD after-sales refunds'),
  ('store.after-sales.cod-refunds.confirm', 'STORE', 'Confirm current store COD after-sales refunds')
ON CONFLICT ("code") DO UPDATE SET
  "scope" = EXCLUDED."scope",
  "description" = EXCLUDED."description";
