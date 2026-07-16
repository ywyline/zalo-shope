-- CreateEnum
CREATE TYPE "Locale" AS ENUM ('vi', 'zh', 'en');

-- CreateEnum
CREATE TYPE "StoreIndustry" AS ENUM ('BEAUTY', 'FASHION');

-- CreateEnum
CREATE TYPE "RecordStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "DeploymentEnvironment" AS ENUM ('TEST', 'STAGING', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "PermissionScope" AS ENUM ('PLATFORM', 'STORE');

-- CreateEnum
CREATE TYPE "AdminStatus" AS ENUM ('ACTIVE', 'LOCKED', 'DISABLED');

-- CreateEnum
CREATE TYPE "MemberStatus" AS ENUM ('ACTIVE', 'DISABLED', 'ANONYMIZED');

-- CreateEnum
CREATE TYPE "IdentityProvider" AS ENUM ('ZALO');

-- CreateEnum
CREATE TYPE "ConsentPurpose" AS ENUM ('PROFILE', 'PHONE', 'LOCATION', 'TERMS', 'PRIVACY');

-- CreateEnum
CREATE TYPE "ConsentStatus" AS ENUM ('GRANTED', 'DENIED', 'REVOKED');

-- CreateEnum
CREATE TYPE "ConsentSource" AS ENUM ('ZALO', 'MANUAL');

-- CreateEnum
CREATE TYPE "ContactSource" AS ENUM ('ZALO', 'MANUAL');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('ADMIN', 'MEMBER', 'SYSTEM');

-- CreateTable
CREATE TABLE "stores" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(64) NOT NULL,
    "industry" "StoreIndustry" NOT NULL,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "default_locale" "Locale" NOT NULL DEFAULT 'vi',
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
    "currency" CHAR(3) NOT NULL DEFAULT 'VND',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "stores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_localizations" (
    "store_id" UUID NOT NULL,
    "locale" "Locale" NOT NULL,
    "display_name" VARCHAR(160) NOT NULL,
    "short_description" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "store_localizations_pkey" PRIMARY KEY ("store_id","locale")
);

-- CreateTable
CREATE TABLE "store_themes" (
    "store_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "color_tokens" JSONB NOT NULL,
    "typography_tokens" JSONB NOT NULL,
    "radius_tokens" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "store_themes_pkey" PRIMARY KEY ("store_id")
);

-- CreateTable
CREATE TABLE "store_zalo_apps" (
    "store_id" UUID NOT NULL,
    "environment" "DeploymentEnvironment" NOT NULL,
    "parent_app_id" VARCHAR(128),
    "mini_app_id" VARCHAR(128),
    "oa_id" VARCHAR(128),
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "store_zalo_apps_pkey" PRIMARY KEY ("store_id","environment")
);

-- CreateTable
CREATE TABLE "admin_users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" VARCHAR(320) NOT NULL,
    "email_normalized" VARCHAR(320) NOT NULL,
    "display_name" VARCHAR(160) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "mfa_secret_ciphertext" TEXT,
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "status" "AdminStatus" NOT NULL DEFAULT 'ACTIVE',
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "code" VARCHAR(128) NOT NULL,
    "scope" "PermissionScope" NOT NULL,
    "description" VARCHAR(500) NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "platform_roles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "platform_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_role_permissions" (
    "platform_role_id" UUID NOT NULL,
    "permission_code" VARCHAR(128) NOT NULL,

    CONSTRAINT "platform_role_permissions_pkey" PRIMARY KEY ("platform_role_id","permission_code")
);

-- CreateTable
CREATE TABLE "admin_platform_roles" (
    "admin_user_id" UUID NOT NULL,
    "platform_role_id" UUID NOT NULL,
    "granted_by" UUID NOT NULL,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_platform_roles_pkey" PRIMARY KEY ("admin_user_id","platform_role_id")
);

-- CreateTable
CREATE TABLE "store_roles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "store_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_role_permissions" (
    "store_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "permission_code" VARCHAR(128) NOT NULL,

    CONSTRAINT "store_role_permissions_pkey" PRIMARY KEY ("store_id","role_id","permission_code")
);

-- CreateTable
CREATE TABLE "admin_store_roles" (
    "store_id" UUID NOT NULL,
    "admin_user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "granted_by" UUID NOT NULL,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_store_roles_pkey" PRIMARY KEY ("store_id","admin_user_id","role_id")
);

-- CreateTable
CREATE TABLE "members" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "status" "MemberStatus" NOT NULL DEFAULT 'ACTIVE',
    "preferred_locale" "Locale" NOT NULL DEFAULT 'vi',
    "display_name" VARCHAR(160),
    "avatar_url" TEXT,
    "last_seen_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_external_identities" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "provider" "IdentityProvider" NOT NULL,
    "provider_app_id" VARCHAR(128) NOT NULL,
    "provider_subject_id" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "member_external_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_phone_contacts" (
    "store_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "phone_hash" VARCHAR(128) NOT NULL,
    "phone_ciphertext" TEXT NOT NULL,
    "source" "ContactSource" NOT NULL,
    "verified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "member_phone_contacts_pkey" PRIMARY KEY ("store_id","member_id")
);

-- CreateTable
CREATE TABLE "consents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "purpose" "ConsentPurpose" NOT NULL,
    "status" "ConsentStatus" NOT NULL,
    "policy_version" VARCHAR(64) NOT NULL,
    "source" "ConsentSource" NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "evidence" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "admin_user_id" UUID NOT NULL,
    "token_family_id" UUID NOT NULL,
    "refresh_token_hash" VARCHAR(128) NOT NULL,
    "mfa_verified_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "ip_hash" VARCHAR(128),
    "user_agent_hash" VARCHAR(128),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "admin_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "token_family_id" UUID NOT NULL,
    "refresh_token_hash" VARCHAR(128) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "zalo_token_expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "member_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID,
    "actor_type" "AuditActorType" NOT NULL,
    "actor_id" UUID NOT NULL,
    "action" VARCHAR(160) NOT NULL,
    "target_type" VARCHAR(160) NOT NULL,
    "target_id" VARCHAR(255),
    "before_data" JSONB,
    "after_data" JSONB,
    "reason" VARCHAR(500),
    "correlation_id" VARCHAR(128) NOT NULL,
    "source_ip" INET,
    "user_agent" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stores_code_key" ON "stores"("code");

-- CreateIndex
CREATE UNIQUE INDEX "store_zalo_apps_environment_mini_app_id_key" ON "store_zalo_apps"("environment", "mini_app_id");

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_email_normalized_key" ON "admin_users"("email_normalized");

-- CreateIndex
CREATE UNIQUE INDEX "platform_roles_code_key" ON "platform_roles"("code");

-- CreateIndex
CREATE UNIQUE INDEX "store_roles_store_id_id_key" ON "store_roles"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "store_roles_store_id_code_key" ON "store_roles"("store_id", "code");

-- CreateIndex
CREATE INDEX "members_store_id_status_idx" ON "members"("store_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "members_store_id_id_key" ON "members"("store_id", "id");

-- CreateIndex
CREATE INDEX "member_external_identities_store_id_member_id_idx" ON "member_external_identities"("store_id", "member_id");

-- CreateIndex
CREATE UNIQUE INDEX "member_external_identities_store_id_provider_provider_app_i_key" ON "member_external_identities"("store_id", "provider", "provider_app_id", "provider_subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "member_phone_contacts_store_id_phone_hash_key" ON "member_phone_contacts"("store_id", "phone_hash");

-- CreateIndex
CREATE INDEX "consents_store_id_member_id_purpose_occurred_at_idx" ON "consents"("store_id", "member_id", "purpose", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "consents_store_id_event_id_key" ON "consents"("store_id", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "admin_sessions_refresh_token_hash_key" ON "admin_sessions"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "admin_sessions_admin_user_id_expires_at_idx" ON "admin_sessions"("admin_user_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "member_sessions_refresh_token_hash_key" ON "member_sessions"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "member_sessions_store_id_member_id_expires_at_idx" ON "member_sessions"("store_id", "member_id", "expires_at");

-- CreateIndex
CREATE INDEX "audit_logs_store_id_created_at_idx" ON "audit_logs"("store_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_actor_type_actor_id_created_at_idx" ON "audit_logs"("actor_type", "actor_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "store_localizations" ADD CONSTRAINT "store_localizations_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_themes" ADD CONSTRAINT "store_themes_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_zalo_apps" ADD CONSTRAINT "store_zalo_apps_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_role_permissions" ADD CONSTRAINT "platform_role_permissions_platform_role_id_fkey" FOREIGN KEY ("platform_role_id") REFERENCES "platform_roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_role_permissions" ADD CONSTRAINT "platform_role_permissions_permission_code_fkey" FOREIGN KEY ("permission_code") REFERENCES "permissions"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_platform_roles" ADD CONSTRAINT "admin_platform_roles_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_platform_roles" ADD CONSTRAINT "admin_platform_roles_platform_role_id_fkey" FOREIGN KEY ("platform_role_id") REFERENCES "platform_roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_platform_roles" ADD CONSTRAINT "admin_platform_roles_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_roles" ADD CONSTRAINT "store_roles_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_role_permissions" ADD CONSTRAINT "store_role_permissions_store_id_role_id_fkey" FOREIGN KEY ("store_id", "role_id") REFERENCES "store_roles"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_role_permissions" ADD CONSTRAINT "store_role_permissions_permission_code_fkey" FOREIGN KEY ("permission_code") REFERENCES "permissions"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_store_roles" ADD CONSTRAINT "admin_store_roles_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_store_roles" ADD CONSTRAINT "admin_store_roles_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_store_roles" ADD CONSTRAINT "admin_store_roles_store_id_role_id_fkey" FOREIGN KEY ("store_id", "role_id") REFERENCES "store_roles"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_store_roles" ADD CONSTRAINT "admin_store_roles_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "members" ADD CONSTRAINT "members_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_external_identities" ADD CONSTRAINT "member_external_identities_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_external_identities" ADD CONSTRAINT "member_external_identities_store_id_member_id_fkey" FOREIGN KEY ("store_id", "member_id") REFERENCES "members"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_phone_contacts" ADD CONSTRAINT "member_phone_contacts_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_phone_contacts" ADD CONSTRAINT "member_phone_contacts_store_id_member_id_fkey" FOREIGN KEY ("store_id", "member_id") REFERENCES "members"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consents" ADD CONSTRAINT "consents_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consents" ADD CONSTRAINT "consents_store_id_member_id_fkey" FOREIGN KEY ("store_id", "member_id") REFERENCES "members"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_sessions" ADD CONSTRAINT "member_sessions_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_sessions" ADD CONSTRAINT "member_sessions_store_id_member_id_fkey" FOREIGN KEY ("store_id", "member_id") REFERENCES "members"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- M1 invariants that Prisma cannot express.
ALTER TABLE "stores"
  ADD CONSTRAINT "stores_currency_vnd_check" CHECK ("currency" = 'VND'),
  ADD CONSTRAINT "stores_timezone_vietnam_check" CHECK ("timezone" = 'Asia/Ho_Chi_Minh');

ALTER TABLE "consents"
  ADD CONSTRAINT "consents_revocation_check" CHECK (
    ("status" = 'REVOKED' AND "revoked_at" IS NOT NULL)
    OR ("status" <> 'REVOKED' AND "revoked_at" IS NULL)
  );

ALTER TABLE "admin_sessions"
  ADD CONSTRAINT "admin_sessions_expiry_check" CHECK ("expires_at" > "created_at");

ALTER TABLE "member_sessions"
  ADD CONSTRAINT "member_sessions_expiry_check" CHECK ("expires_at" > "created_at");

CREATE SCHEMA IF NOT EXISTS "app_security";
REVOKE ALL ON SCHEMA "app_security" FROM PUBLIC;

CREATE OR REPLACE FUNCTION "app_security"."current_store_id"()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT NULLIF(current_setting('app.store_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION "app_security"."current_actor_id"()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT NULLIF(current_setting('app.actor_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION "app_security"."platform_authorized"()
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(NULLIF(current_setting('app.platform_authorized', true), '')::boolean, false)
$$;

CREATE OR REPLACE FUNCTION "app_security"."reject_store_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.store_id IS DISTINCT FROM NEW.store_id THEN
    RAISE EXCEPTION 'store_id is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "app_security"."reject_audit_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit logs are append-only' USING ERRCODE = '42501';
END;
$$;

CREATE OR REPLACE FUNCTION "app_security"."enforce_permission_scope"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  actual_scope "PermissionScope";
  expected_scope "PermissionScope";
BEGIN
  SELECT "scope" INTO actual_scope FROM "permissions" WHERE "code" = NEW.permission_code;
  expected_scope := CASE TG_TABLE_NAME
    WHEN 'platform_role_permissions' THEN 'PLATFORM'::"PermissionScope"
    ELSE 'STORE'::"PermissionScope"
  END;
  IF actual_scope IS DISTINCT FROM expected_scope THEN
    RAISE EXCEPTION 'permission scope mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "platform_role_permissions_scope_guard"
BEFORE INSERT OR UPDATE ON "platform_role_permissions"
FOR EACH ROW EXECUTE FUNCTION "app_security"."enforce_permission_scope"();

CREATE TRIGGER "store_role_permissions_scope_guard"
BEFORE INSERT OR UPDATE ON "store_role_permissions"
FOR EACH ROW EXECUTE FUNCTION "app_security"."enforce_permission_scope"();

CREATE TRIGGER "audit_logs_append_only"
BEFORE UPDATE OR DELETE ON "audit_logs"
FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_audit_mutation"();

CREATE TRIGGER "store_localizations_store_immutable" BEFORE UPDATE ON "store_localizations" FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_store_change"();
CREATE TRIGGER "store_themes_store_immutable" BEFORE UPDATE ON "store_themes" FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_store_change"();
CREATE TRIGGER "store_zalo_apps_store_immutable" BEFORE UPDATE ON "store_zalo_apps" FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_store_change"();
CREATE TRIGGER "store_roles_store_immutable" BEFORE UPDATE ON "store_roles" FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_store_change"();
CREATE TRIGGER "store_role_permissions_store_immutable" BEFORE UPDATE ON "store_role_permissions" FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_store_change"();
CREATE TRIGGER "admin_store_roles_store_immutable" BEFORE UPDATE ON "admin_store_roles" FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_store_change"();
CREATE TRIGGER "members_store_immutable" BEFORE UPDATE ON "members" FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_store_change"();
CREATE TRIGGER "member_external_identities_store_immutable" BEFORE UPDATE ON "member_external_identities" FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_store_change"();
CREATE TRIGGER "member_phone_contacts_store_immutable" BEFORE UPDATE ON "member_phone_contacts" FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_store_change"();
CREATE TRIGGER "consents_store_immutable" BEFORE UPDATE ON "consents" FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_store_change"();
CREATE TRIGGER "member_sessions_store_immutable" BEFORE UPDATE ON "member_sessions" FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_store_change"();
CREATE TRIGGER "audit_logs_store_immutable" BEFORE UPDATE ON "audit_logs" FOR EACH ROW EXECUTE FUNCTION "app_security"."reject_store_change"();

ALTER TABLE "stores" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stores" FORCE ROW LEVEL SECURITY;
CREATE POLICY "stores_tenant_isolation" ON "stores"
  USING ("id" = "app_security"."current_store_id"())
  WITH CHECK ("id" = "app_security"."current_store_id"());

ALTER TABLE "store_localizations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "store_localizations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "store_localizations_tenant_isolation" ON "store_localizations"
  USING ("store_id" = "app_security"."current_store_id"())
  WITH CHECK ("store_id" = "app_security"."current_store_id"());

ALTER TABLE "store_themes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "store_themes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "store_themes_tenant_isolation" ON "store_themes"
  USING ("store_id" = "app_security"."current_store_id"())
  WITH CHECK ("store_id" = "app_security"."current_store_id"());

ALTER TABLE "store_zalo_apps" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "store_zalo_apps" FORCE ROW LEVEL SECURITY;
CREATE POLICY "store_zalo_apps_tenant_isolation" ON "store_zalo_apps"
  USING ("store_id" = "app_security"."current_store_id"())
  WITH CHECK ("store_id" = "app_security"."current_store_id"());

ALTER TABLE "store_roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "store_roles" FORCE ROW LEVEL SECURITY;
CREATE POLICY "store_roles_tenant_isolation" ON "store_roles"
  USING ("store_id" = "app_security"."current_store_id"())
  WITH CHECK ("store_id" = "app_security"."current_store_id"());

ALTER TABLE "store_role_permissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "store_role_permissions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "store_role_permissions_tenant_isolation" ON "store_role_permissions"
  USING ("store_id" = "app_security"."current_store_id"())
  WITH CHECK ("store_id" = "app_security"."current_store_id"());

ALTER TABLE "admin_store_roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "admin_store_roles" FORCE ROW LEVEL SECURITY;
CREATE POLICY "admin_store_roles_tenant_isolation" ON "admin_store_roles"
  USING ("store_id" = "app_security"."current_store_id"())
  WITH CHECK ("store_id" = "app_security"."current_store_id"());
CREATE POLICY "admin_store_roles_assignment_discovery" ON "admin_store_roles"
  FOR SELECT USING (
    "admin_user_id" = "app_security"."current_actor_id"()
    AND current_setting('app.actor_type', true) = 'admin'
  );

ALTER TABLE "members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "members" FORCE ROW LEVEL SECURITY;
CREATE POLICY "members_tenant_isolation" ON "members"
  USING ("store_id" = "app_security"."current_store_id"())
  WITH CHECK ("store_id" = "app_security"."current_store_id"());

ALTER TABLE "member_external_identities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "member_external_identities" FORCE ROW LEVEL SECURITY;
CREATE POLICY "member_external_identities_tenant_isolation" ON "member_external_identities"
  USING ("store_id" = "app_security"."current_store_id"())
  WITH CHECK ("store_id" = "app_security"."current_store_id"());

ALTER TABLE "member_phone_contacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "member_phone_contacts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "member_phone_contacts_tenant_isolation" ON "member_phone_contacts"
  USING ("store_id" = "app_security"."current_store_id"())
  WITH CHECK ("store_id" = "app_security"."current_store_id"());

ALTER TABLE "consents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "consents" FORCE ROW LEVEL SECURITY;
CREATE POLICY "consents_tenant_isolation" ON "consents"
  USING ("store_id" = "app_security"."current_store_id"())
  WITH CHECK ("store_id" = "app_security"."current_store_id"());

ALTER TABLE "member_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "member_sessions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "member_sessions_tenant_isolation" ON "member_sessions"
  USING ("store_id" = "app_security"."current_store_id"())
  WITH CHECK ("store_id" = "app_security"."current_store_id"());

ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "audit_logs_tenant_select" ON "audit_logs"
  FOR SELECT USING ("store_id" = "app_security"."current_store_id"());
CREATE POLICY "audit_logs_tenant_insert" ON "audit_logs"
  FOR INSERT WITH CHECK ("store_id" = "app_security"."current_store_id"());
CREATE POLICY "audit_logs_platform_select" ON "audit_logs"
  FOR SELECT USING ("store_id" IS NULL AND "app_security"."platform_authorized"());
CREATE POLICY "audit_logs_platform_insert" ON "audit_logs"
  FOR INSERT WITH CHECK (
    "store_id" IS NULL
    AND "app_security"."platform_authorized"()
    AND "actor_id" = "app_security"."current_actor_id"()
  );

-- The fixed local role is provisioned before migrations. Production may replace
-- it with an environment-specific role and apply equivalent grants.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zalo_shop_runtime') THEN
    CREATE ROLE zalo_shop_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

ALTER ROLE zalo_shop_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT USAGE ON SCHEMA "public", "app_security" TO zalo_shop_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA "app_security" TO zalo_shop_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "public" TO zalo_shop_runtime;
REVOKE UPDATE, DELETE ON TABLE "audit_logs" FROM zalo_shop_runtime;

-- Public store resolution returns only routing-safe fields. The API still has to
-- verify the Zalo app identity before issuing a member StoreContext.
CREATE OR REPLACE FUNCTION "app_security"."resolve_active_store"(requested_code text)
RETURNS TABLE (id uuid, code varchar, default_locale "Locale")
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT s.id, s.code, s.default_locale
  FROM stores s
  WHERE s.code = requested_code AND s.status = 'ACTIVE'
$$;

REVOKE ALL ON FUNCTION "app_security"."resolve_active_store"(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app_security"."resolve_active_store"(text) TO zalo_shop_runtime;
