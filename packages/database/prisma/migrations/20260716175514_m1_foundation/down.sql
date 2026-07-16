DROP FUNCTION IF EXISTS "app_security"."resolve_active_store"(text);

DROP TABLE IF EXISTS "audit_logs" CASCADE;
DROP TABLE IF EXISTS "member_sessions" CASCADE;
DROP TABLE IF EXISTS "admin_sessions" CASCADE;
DROP TABLE IF EXISTS "consents" CASCADE;
DROP TABLE IF EXISTS "member_phone_contacts" CASCADE;
DROP TABLE IF EXISTS "member_external_identities" CASCADE;
DROP TABLE IF EXISTS "members" CASCADE;
DROP TABLE IF EXISTS "admin_store_roles" CASCADE;
DROP TABLE IF EXISTS "store_role_permissions" CASCADE;
DROP TABLE IF EXISTS "store_roles" CASCADE;
DROP TABLE IF EXISTS "admin_platform_roles" CASCADE;
DROP TABLE IF EXISTS "platform_role_permissions" CASCADE;
DROP TABLE IF EXISTS "platform_roles" CASCADE;
DROP TABLE IF EXISTS "permissions" CASCADE;
DROP TABLE IF EXISTS "admin_users" CASCADE;
DROP TABLE IF EXISTS "store_zalo_apps" CASCADE;
DROP TABLE IF EXISTS "store_themes" CASCADE;
DROP TABLE IF EXISTS "store_localizations" CASCADE;
DROP TABLE IF EXISTS "stores" CASCADE;

DROP SCHEMA IF EXISTS "app_security" CASCADE;

DROP TYPE IF EXISTS "AuditActorType";
DROP TYPE IF EXISTS "ContactSource";
DROP TYPE IF EXISTS "ConsentSource";
DROP TYPE IF EXISTS "ConsentStatus";
DROP TYPE IF EXISTS "ConsentPurpose";
DROP TYPE IF EXISTS "IdentityProvider";
DROP TYPE IF EXISTS "MemberStatus";
DROP TYPE IF EXISTS "AdminStatus";
DROP TYPE IF EXISTS "PermissionScope";
DROP TYPE IF EXISTS "DeploymentEnvironment";
DROP TYPE IF EXISTS "RecordStatus";
DROP TYPE IF EXISTS "StoreIndustry";
DROP TYPE IF EXISTS "Locale";
