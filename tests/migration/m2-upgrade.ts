import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import type { createRuntimePrismaClient } from '@zalo-shop/database';

const REPOSITORY_ROOT = resolve(__dirname, '../..');
const DATABASE_PACKAGE_ROOT = join(REPOSITORY_ROOT, 'packages', 'database');
const PRISMA_ROOT = join(DATABASE_PACKAGE_ROOT, 'prisma');
const MIGRATIONS_ROOT = join(PRISMA_ROOT, 'migrations');
const TMP_ROOT = join(REPOSITORY_ROOT, 'tmp');
const FIXTURE_SQL_PATH = join(__dirname, 'm2-upgrade-fixture.sql');
const FINGERPRINT_SQL_PATH = join(__dirname, 'm2-upgrade-fingerprint.sql');
const ASSERTIONS_SQL_PATH = join(__dirname, 'm2-upgrade-assertions.sql');
const SCRATCH_DATABASE_PATTERN = /^zalo_shop_m2_upgrade_[0-9a-f]{12}$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const REQUIRE_FROM_DATABASE_PACKAGE = createRequire(join(DATABASE_PACKAGE_ROOT, 'package.json'));
type PrismaClientType = ReturnType<typeof createRuntimePrismaClient>;
const PrismaClient = (
  REQUIRE_FROM_DATABASE_PACKAGE('@prisma/client') as {
    PrismaClient: new (options?: { datasourceUrl?: string }) => PrismaClientType;
  }
).PrismaClient;

const M2_MIGRATIONS = [
  '20260716175514_m1_foundation',
  '20260716182000_m1_store_registry_access',
  '20260717141931_m2_catalog_content',
  '20260717151500_m23_finalized_status_text',
] as const;

const M5_MIGRATIONS = [
  '20260725090000_m52_payment_shipping_foundation',
  '20260725093000_m52_permission_catalog',
  '20260725100000_m52_callback_trust_guard',
  '20260725103000_m52_payment_amount_and_permissions_guard',
  '20260725110000_m53_reliable_message_guards',
  '20260726120000_m55_payment_callback_channel_resolver',
  '20260726130000_m56_shipping_fulfillment_facts',
  '20260727001000_m57_refund_review_capacity_guard',
] as const;

const D5_MIGRATIONS = [
  '20260730100000_m63_b2b_d5_protected_read_lock',
  '20260730103000_m63_b2b_d5_authorization_revalidation',
  '20260730104000_m63_b2b_d5_member_authorization_grant_fix',
  '20260730105000_m63_b2b_d5_expiry_revalidation',
  '20260731100000_m63_b2b_d5_commit_deadline_revalidation',
] as const;

const B3_MIGRATION_NAME = '20260731110000_m63_b3_after_sale_commands' as const;

const B4_MIGRATIONS = [
  '20260731130000_m63_b4_after_sale_review_expiration',
  '20260731131000_m63_b4_atomicity_name_fix',
] as const;

const B5_MIGRATION_NAME = '20260731150000_m63_b5_after_sale_return_trust' as const;
const P0_M5_005_MIGRATION_NAME = '20260801090000_p0_m5_005_financial_reconciliation' as const;
const P0_M5_005_COD_MIGRATION_NAME = '20260801100000_p0_m5_005_cod_reconciliation' as const;
const P0_M5_005_CLOSURE_MIGRATION_NAME =
  '20260801110000_p0_m5_005_reconciliation_closeout' as const;
const P0_M6_007_MIGRATION_NAME = '20260801120000_p0_m6_007_cod_refund_settlement' as const;
const P0_M6_008_MIGRATION_NAME = '20260801130000_p0_m6_008_return_inspection_inventory' as const;

const M6_MIGRATIONS = [
  '20260727110000_m62_after_sales_member_share_foundation',
  '20260727111000_m62_permission_catalog',
  '20260727112000_m62_integrity_and_snapshot_guards',
  '20260727113000_m62_integrity_forward_fix',
  '20260727114000_m62_runtime_member_scope',
  '20260727115000_m62_integrity_closeout',
  '20260727116000_m62_capacity_allocation_closeout',
  '20260727117000_m62_capacity_allocation_runtime_fix',
  '20260727118000_m62_capacity_allocation_expression_fix',
  '20260727119000_m62_order_lock_order_closeout',
  '20260727120000_m62_capacity_scope_and_approval_occupancy_fix',
  '20260728100000_m63_policy_snapshot_category_resolution',
  '20260728101000_m63_policy_settings_rows',
  '20260728102000_m63_policy_settings_lock',
  '20260728103000_m63_policy_settings_provisioning',
  '20260728104000_m63_b0_after_sale_contract_guards',
  '20260728110000_m63_b1_after_sale_admin_read_index',
  '20260729100000_m63_b2a_policy_control_plane',
  '20260729120000_m63_b2b_d0_evidence_lifecycle',
  ...D5_MIGRATIONS,
  B3_MIGRATION_NAME,
  ...B4_MIGRATIONS,
  B5_MIGRATION_NAME,
] as const;

type MigrationRecord = {
  applied_steps_count: number;
  checksum: string;
  finished_at: Date | null;
  logs: string | null;
  migration_name: string;
  rolled_back_at: Date | null;
};

type FingerprintRecord = { fingerprint: string };

type IndexShapeRecord = {
  access_method: string;
  has_predicate: boolean;
  index_keys: string[];
  is_ready: boolean;
  is_unique: boolean;
  is_valid: boolean;
  key_attribute_count: number;
  total_attribute_count: number;
};

type OwnerPreflightRecord = {
  can_create_database: boolean;
  database_name: string;
  is_superuser: boolean;
  runtime_role_exists: boolean;
  server_version_num: number;
  user_name: string;
};

type DatabaseNameRecord = { database_name: string };
type DatabaseCatalogRecord = DatabaseNameRecord & { owner_name: string };

function fail(message: string): never {
  throw new Error(`[m2-upgrade] ${message}`);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('[m2-upgrade] unknown non-Error failure');
}

function isDatabaseAlreadyExistsError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & { code?: unknown; meta?: unknown };
  if (candidate.code === '42P04') return true;
  if (typeof candidate.meta === 'object' && candidate.meta !== null) {
    const metadata = candidate.meta as Record<string, unknown>;
    if (metadata.code === '42P04') return true;
  }
  return /\b42P04\b/u.test(error.message) && /already exists/iu.test(error.message);
}

function validateScratchDatabaseName(databaseName: string): void {
  if (!SCRATCH_DATABASE_PATTERN.test(databaseName)) {
    fail(`refusing unsafe scratch database name: ${databaseName}`);
  }
}

function assertPathWithin(parentPath: string, targetPath: string): void {
  const relativePath = relative(resolve(parentPath), resolve(targetPath));
  if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    fail(`refusing recursive cleanup outside the intended directory: ${targetPath}`);
  }
}

async function assertSafeTemporaryDirectory(targetPath: string): Promise<void> {
  const [repositoryRealPath, temporaryRootRealPath, targetRealPath, temporaryRootStat, targetStat] =
    await Promise.all([
      realpath(REPOSITORY_ROOT),
      realpath(TMP_ROOT),
      realpath(targetPath),
      lstat(TMP_ROOT),
      lstat(targetPath),
    ]);
  if (temporaryRootStat.isSymbolicLink() || targetStat.isSymbolicLink()) {
    fail('refusing a temporary migration path that uses a symlink or junction');
  }
  assertPathWithin(repositoryRealPath, temporaryRootRealPath);
  assertPathWithin(temporaryRootRealPath, targetRealPath);
  if (!basename(targetRealPath).startsWith('m2-upgrade-')) {
    fail('temporary migration directory has an unexpected real path');
  }
}

function captureCommand(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    fail(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout.trim();
}

function validateComposePostgres(expectedPort: string): void {
  const runningServices = captureCommand('docker', [
    'compose',
    'ps',
    '--status',
    'running',
    '--services',
  ])
    .split(/\r?\n/u)
    .filter(Boolean);
  if (!runningServices.includes('postgres')) {
    fail('the repository Docker Compose postgres service must be running');
  }

  const publishedAddress = captureCommand('docker', ['compose', 'port', 'postgres', '5432']);
  const portMatch = /:(\d+)\s*$/u.exec(publishedAddress);
  if (!portMatch || portMatch[1] !== expectedPort) {
    fail(`DATABASE_URL port does not match the running Compose postgres service`);
  }
}

function validateOwnerUrl(): URL {
  if (process.env.NODE_ENV !== 'test') {
    fail('NODE_ENV must be test before any scratch resource is created');
  }

  const rawDatabaseUrl = process.env.DATABASE_URL;
  if (!rawDatabaseUrl) fail('DATABASE_URL is required');

  let databaseUrl: URL;
  try {
    databaseUrl = new URL(rawDatabaseUrl);
  } catch {
    fail('DATABASE_URL must be a valid PostgreSQL URL');
  }

  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)) {
    fail('DATABASE_URL must use the postgres or postgresql protocol');
  }
  if (!LOOPBACK_HOSTS.has(databaseUrl.hostname)) {
    fail('DATABASE_URL must target a loopback host');
  }
  if (databaseUrl.username !== 'zalo_shop') {
    fail('DATABASE_URL must use the repository local migration-owner user');
  }
  if (decodeURIComponent(databaseUrl.pathname.replace(/^\//u, '')) !== 'zalo_shop') {
    fail('DATABASE_URL must target the repository local base database');
  }
  if (databaseUrl.searchParams.get('schema') !== 'public') {
    fail('DATABASE_URL must explicitly target the public schema');
  }

  const port = databaseUrl.port || '5432';
  validateComposePostgres(port);
  return databaseUrl;
}

function prismaCliPath(): string {
  return REQUIRE_FROM_DATABASE_PACKAGE.resolve('prisma/build/index.js');
}

function runPrisma(args: string[], databaseUrl: URL): void {
  const result = spawnSync(process.execPath, [prismaCliPath(), ...args], {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl.toString() },
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`Prisma command failed with exit code ${String(result.status)}`);
  }
}

function runPrismaExpectFailure(args: string[], databaseUrl: URL, expectedMessage: string): void {
  const result = spawnSync(process.execPath, [prismaCliPath(), ...args], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: databaseUrl.toString() },
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status === 0) {
    fail(`Prisma command unexpectedly succeeded: ${args.join(' ')}`);
  }
  const detail = `${result.stderr}\n${result.stdout}`;
  if (!detail.includes(expectedMessage)) {
    fail(`Prisma failure did not contain the expected rollback guard`);
  }
}

async function expectSqlState(
  promise: Promise<unknown>,
  expectedSqlState: string,
  context: string,
): Promise<void> {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  if (!failure) fail(`${context} unexpectedly succeeded`);
  const candidate = failure as { code?: unknown; meta?: unknown };
  const metadata =
    typeof candidate.meta === 'object' && candidate.meta !== null
      ? (candidate.meta as Record<string, unknown>)
      : undefined;
  if (candidate.code !== 'P2010' || metadata?.code !== expectedSqlState) {
    fail(
      `${context} did not return SQLSTATE ${expectedSqlState}: ${JSON.stringify({
        code: candidate.code,
        meta: candidate.meta,
      })}`,
    );
  }
}

async function migrationDirectories(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_ROOT, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory() && /^\d{14}_[a-z0-9_]+$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (directories.length === 0) fail('no Prisma migration directories were found');
  for (const directory of directories) {
    const migrationSql = join(MIGRATIONS_ROOT, directory, 'migration.sql');
    if (!(await stat(migrationSql)).isFile()) {
      fail(`migration is missing migration.sql: ${directory}`);
    }
  }
  return directories;
}

async function assertD5MigrationTransactionBoundaries(): Promise<void> {
  for (const migrationName of D5_MIGRATIONS) {
    const sql = await readFile(join(MIGRATIONS_ROOT, migrationName, 'migration.sql'), 'utf8');
    const lines = sql.replace(/^\uFEFF/u, '').split(/\r?\n/u);
    const substantiveLines = lines
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('--'));
    const beginCount = lines.filter((line) => line.trim() === 'BEGIN;').length;
    const commitCount = lines.filter((line) => line.trim() === 'COMMIT;').length;
    if (
      substantiveLines[0] !== 'BEGIN;' ||
      substantiveLines.at(-1) !== 'COMMIT;' ||
      beginCount !== 1 ||
      commitCount !== 1
    ) {
      fail(
        `M6.3-B2b-D5 migration must have one explicit top-level BEGIN and end with one COMMIT: ${migrationName}`,
      );
    }
  }
}

function injectD5PreCommitFailure(sql: string, migrationName: string): string {
  const commitOffset = sql.lastIndexOf('COMMIT;');
  if (commitOffset < 0 || sql.slice(commitOffset + 'COMMIT;'.length).trim().length !== 0) {
    fail(`cannot inject a D5 pre-commit failure into migration: ${migrationName}`);
  }
  const injectedFailure = `DO $d5_atomicity_injection$\nBEGIN\n  RAISE EXCEPTION 'M6.3-B2b-D5 injected pre-commit failure' USING ERRCODE = '55000';\nEND\n$d5_atomicity_injection$;\n\n`;
  return `${sql.slice(0, commitOffset)}${injectedFailure}${sql.slice(commitOffset)}`;
}

async function createMigrationTree(
  tempDirectory: string,
  treeName: string,
  migrationNames: readonly string[],
): Promise<string> {
  const treeRoot = join(tempDirectory, treeName);
  const tempMigrationsRoot = join(treeRoot, 'migrations');
  await mkdir(tempMigrationsRoot, { recursive: true });
  await copyFile(join(PRISMA_ROOT, 'schema.prisma'), join(treeRoot, 'schema.prisma'));
  await copyFile(
    join(MIGRATIONS_ROOT, 'migration_lock.toml'),
    join(tempMigrationsRoot, 'migration_lock.toml'),
  );
  for (const migrationName of migrationNames) {
    await cp(join(MIGRATIONS_ROOT, migrationName), join(tempMigrationsRoot, migrationName), {
      recursive: true,
    });
  }
  return join(treeRoot, 'schema.prisma');
}

async function expectedMigrationChecksums(
  migrationNames: readonly string[],
): Promise<Map<string, string>> {
  const checksums = new Map<string, string>();
  for (const migrationName of migrationNames) {
    const sql = await readFile(join(MIGRATIONS_ROOT, migrationName, 'migration.sql'));
    checksums.set(migrationName, createHash('sha256').update(sql).digest('hex'));
  }
  return checksums;
}

async function assertMigrationState(
  client: PrismaClientType,
  expectedNames: readonly string[],
): Promise<void> {
  const records = await client.$queryRawUnsafe<MigrationRecord[]>(`
    SELECT migration_name, checksum, finished_at, rolled_back_at, logs, applied_steps_count
    FROM "_prisma_migrations"
    ORDER BY migration_name
  `);
  if (records.length !== expectedNames.length) {
    fail(
      `expected ${String(expectedNames.length)} successful migrations, found ${String(records.length)}`,
    );
  }

  const expectedChecksums = await expectedMigrationChecksums(expectedNames);
  for (const [index, expectedName] of expectedNames.entries()) {
    const record = records[index];
    if (!record || record.migration_name !== expectedName) {
      fail(`migration history differs at position ${String(index + 1)}`);
    }
    if (
      !record.finished_at ||
      record.rolled_back_at !== null ||
      (record.logs !== null && record.logs !== '') ||
      record.applied_steps_count !== 1
    ) {
      fail(`migration is not recorded as one clean deploy step: ${expectedName}`);
    }
    if (record.checksum !== expectedChecksums.get(expectedName)) {
      fail(`migration checksum does not match the tracked SQL: ${expectedName}`);
    }
  }
}

async function fixtureFingerprint(
  client: PrismaClientType,
  fingerprintSql: string,
): Promise<string> {
  const records = await client.$queryRawUnsafe<FingerprintRecord[]>(fingerprintSql);
  const fingerprint = records[0]?.fingerprint;
  if (!fingerprint || !/^[a-f0-9]{64}$/u.test(fingerprint)) {
    fail('fixture fingerprint query did not return a SHA-256 digest');
  }
  return fingerprint;
}

async function assertIndexShape(
  client: PrismaClientType,
  input: Readonly<{
    expectedKeys: readonly string[];
    expectedUnique: boolean;
    indexName: string;
    shouldExist?: boolean;
    tableName: string;
  }>,
): Promise<void> {
  const records = await client.$queryRaw<IndexShapeRecord[]>`
    SELECT
      access_method.amname::text AS access_method,
      index_record.indpred IS NOT NULL AS has_predicate,
      index_record.indisready AS is_ready,
      index_record.indisunique AS is_unique,
      index_record.indisvalid AS is_valid,
      index_record.indnkeyatts AS key_attribute_count,
      index_record.indnatts AS total_attribute_count,
      ARRAY(
        SELECT
          pg_catalog.pg_get_indexdef(
            index_record.indexrelid,
            key_option.key_number::integer,
            true
          ) || CASE
            WHEN (key_option.option_bits::integer & 1) = 1 THEN ' DESC'
            ELSE ''
          END
        FROM pg_catalog.unnest(index_record.indoption::smallint[])
          WITH ORDINALITY AS key_option(option_bits, key_number)
        ORDER BY key_option.key_number
      ) AS index_keys
    FROM pg_catalog.pg_index index_record
    JOIN pg_catalog.pg_class index_relation
      ON index_relation.oid = index_record.indexrelid
    JOIN pg_catalog.pg_am access_method
      ON access_method.oid = index_relation.relam
    JOIN pg_catalog.pg_class table_relation
      ON table_relation.oid = index_record.indrelid
    JOIN pg_catalog.pg_namespace namespace
      ON namespace.oid = table_relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND table_relation.relname = ${input.tableName}
      AND index_relation.relname = ${input.indexName}
  `;
  const shouldExist = input.shouldExist ?? true;
  if (!shouldExist) {
    if (records.length !== 0) fail(`index still exists after rollback: ${input.indexName}`);
    return;
  }
  const record = records[0];
  if (
    records.length !== 1 ||
    !record ||
    record.access_method !== 'btree' ||
    record.has_predicate ||
    !record.is_ready ||
    !record.is_valid ||
    record.is_unique !== input.expectedUnique ||
    record.key_attribute_count !== input.expectedKeys.length ||
    record.total_attribute_count !== record.key_attribute_count ||
    record.index_keys.length !== input.expectedKeys.length ||
    record.index_keys.some((key, index) => key !== input.expectedKeys[index])
  ) {
    fail(
      `index shape differs from the approved migration: ${input.indexName}; ` +
        `expected keys=${JSON.stringify(input.expectedKeys)}, unique=${String(input.expectedUnique)}, ` +
        `btree=true, predicate=false, include=false; received=${JSON.stringify(record ?? null)}`,
    );
  }
}

async function assertM63B1ReadIndexes(client: PrismaClientType): Promise<void> {
  await assertIndexShape(client, {
    expectedKeys: ['store_id', 'updated_at DESC', 'id DESC'],
    expectedUnique: false,
    indexName: 'after_sales_store_id_updated_at_id_idx',
    tableName: 'after_sales',
  });
  await assertIndexShape(client, {
    expectedKeys: ['store_id', 'settlement_id'],
    expectedUnique: true,
    indexName: 'after_sale_refunds_store_id_settlement_id_key',
    tableName: 'after_sale_refunds',
  });
}

async function assertM63B2ReadIndexes(client: PrismaClientType): Promise<void> {
  await assertIndexShape(client, {
    expectedKeys: ['store_id', 'updated_at DESC', 'id DESC'],
    expectedUnique: false,
    indexName: 'after_sale_policies_store_id_updated_at_id_idx',
    tableName: 'after_sale_policies',
  });
  await assertIndexShape(client, {
    expectedKeys: ['store_id', 'policy_id', 'published_at DESC', 'id DESC'],
    expectedUnique: false,
    indexName: 'after_sale_policy_versions_store_policy_published_id_idx',
    tableName: 'after_sale_policy_versions',
  });
}

async function assertM63B2bD0Indexes(client: PrismaClientType): Promise<void> {
  await assertIndexShape(client, {
    expectedKeys: ['store_id', 'member_id', 'status', 'id'],
    expectedUnique: false,
    indexName: 'after_sale_evidence_files_store_id_member_id_status_id_idx',
    tableName: 'after_sale_evidence_files',
  });
  await assertIndexShape(client, {
    expectedKeys: ['store_id', 'status', 'next_delete_attempt_at', 'id'],
    expectedUnique: false,
    indexName: 'after_sale_evidence_files_store_id_status_next_delete_attem_idx',
    tableName: 'after_sale_evidence_files',
  });
  await assertIndexShape(client, {
    expectedKeys: ['object_key'],
    expectedUnique: true,
    indexName: 'after_sale_evidence_objects_object_key_key',
    tableName: 'after_sale_evidence_objects',
  });
  await assertIndexShape(client, {
    expectedKeys: ['store_id', 'evidence_file_id', 'object_role', 'id'],
    expectedUnique: false,
    indexName: 'after_sale_evidence_objects_store_id_evidence_file_id_objec_idx',
    tableName: 'after_sale_evidence_objects',
  });
}

type B3FunctionCatalogRecord = {
  function_name: string;
  identity_arguments: string;
  public_can_execute: boolean;
  runtime_can_execute: boolean;
  security_definer: boolean;
  safe_search_path: boolean;
  row_security_on: boolean;
};

type B3TriggerCatalogRecord = {
  function_name: string;
  function_identity_arguments: string;
  is_constraint: boolean;
  is_deferrable: boolean;
  is_initially_deferred: boolean;
  is_enabled: boolean;
  table_name: string;
  trigger_name: string;
};

type B3ConstraintCatalogRecord = {
  constraint_name: string;
  constraint_type: string;
  definition: string;
  is_validated: boolean;
  referenced_columns: string[] | null;
  referenced_table: string | null;
  source_columns: string[];
  source_table: string;
  delete_action: string;
  update_action: string;
};

type B3IndexCatalogRecord = {
  index_keys: string[];
  is_ready: boolean;
  is_unique: boolean;
  is_valid: boolean;
  key_attribute_count: number;
  predicate: string | null;
  total_attribute_count: number;
};

async function assertM63B3CommandBoundary(client: PrismaClientType): Promise<string> {
  const functionRows = await client.$queryRaw<B3FunctionCatalogRecord[]>`
    SELECT
      function_definition.proname AS function_name,
      pg_catalog.oidvectortypes(function_definition.proargtypes) AS identity_arguments,
      EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(
            function_definition.proacl,
            pg_catalog.acldefault('f', function_definition.proowner)
          )
        ) AS privilege
        WHERE privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'
      ) AS public_can_execute,
      pg_catalog.has_function_privilege(
        'zalo_shop_runtime', function_definition.oid, 'EXECUTE'
      ) AS runtime_can_execute,
      function_definition.prosecdef AS security_definer,
      'search_path=pg_catalog, public, pg_temp' = ANY(function_definition.proconfig)
        AS safe_search_path,
      'row_security=on' = ANY(function_definition.proconfig) AS row_security_on
    FROM pg_catalog.pg_proc AS function_definition
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = function_definition.pronamespace
    WHERE namespace.nspname = 'app_security'
      AND function_definition.proname IN (
        'guard_m63_b3_approval_mutation_order_scope',
        'lock_m63_b3_approval_order_scope',
        'assert_m63_b3_command_authorization',
        'validate_m63_b3_command_facts',
        'validate_m63_b3_submit_transition',
        'validate_m63_b3_operation_link',
        'validate_m63_b3_operation_completion',
        'validate_m63_b3_command_atomicity',
        'validate_m63_b3_runtime_case_commit',
        'finalize_m63_b3_after_sale_submit',
        'cancel_m63_b3_member_after_sale'
      )
    ORDER BY function_definition.proname, identity_arguments
  `;
  const expectedFunctions = new Map<
    string,
    { runtimeCanExecute: boolean; securityDefiner: boolean; rowSecurityOn: boolean }
  >([
    [
      'guard_m63_b3_approval_mutation_order_scope()',
      { runtimeCanExecute: false, securityDefiner: true, rowSecurityOn: false },
    ],
    [
      'lock_m63_b3_approval_order_scope()',
      { runtimeCanExecute: false, securityDefiner: true, rowSecurityOn: false },
    ],
    [
      'assert_m63_b3_command_authorization()',
      { runtimeCanExecute: false, securityDefiner: true, rowSecurityOn: true },
    ],
    [
      'validate_m63_b3_command_facts(uuid)',
      { runtimeCanExecute: false, securityDefiner: true, rowSecurityOn: true },
    ],
    [
      'validate_m63_b3_submit_transition()',
      { runtimeCanExecute: false, securityDefiner: true, rowSecurityOn: false },
    ],
    [
      'validate_m63_b3_operation_link()',
      { runtimeCanExecute: false, securityDefiner: true, rowSecurityOn: false },
    ],
    [
      'validate_m63_b3_operation_completion()',
      { runtimeCanExecute: false, securityDefiner: false, rowSecurityOn: false },
    ],
    [
      'validate_m63_b3_command_atomicity()',
      { runtimeCanExecute: false, securityDefiner: true, rowSecurityOn: false },
    ],
    [
      'validate_m63_b3_runtime_case_commit()',
      { runtimeCanExecute: false, securityDefiner: true, rowSecurityOn: false },
    ],
    [
      'finalize_m63_b3_after_sale_submit(uuid, uuid, inet)',
      { runtimeCanExecute: true, securityDefiner: true, rowSecurityOn: false },
    ],
    [
      'cancel_m63_b3_member_after_sale(uuid, uuid, text, text, integer, inet)',
      { runtimeCanExecute: true, securityDefiner: true, rowSecurityOn: false },
    ],
  ]);
  if (functionRows.length !== expectedFunctions.size) {
    fail(`M6.3-B3 function catalog is incomplete: ${JSON.stringify(functionRows)}`);
  }
  for (const row of functionRows) {
    const key = `${row.function_name}(${row.identity_arguments})`;
    const expected = expectedFunctions.get(key);
    if (
      !expected ||
      row.public_can_execute ||
      row.runtime_can_execute !== expected.runtimeCanExecute ||
      row.security_definer !== expected.securityDefiner ||
      !row.safe_search_path ||
      row.row_security_on !== expected.rowSecurityOn
    ) {
      fail(`M6.3-B3 function grants or configuration differ: ${JSON.stringify(row)}`);
    }
  }

  const triggerRows = await client.$queryRaw<B3TriggerCatalogRecord[]>`
    SELECT
      relation.relname AS table_name,
      trigger_definition.tgname AS trigger_name,
      function_definition.proname AS function_name,
      pg_catalog.oidvectortypes(function_definition.proargtypes)
        AS function_identity_arguments,
      trigger_definition.tgconstraint <> 0 AS is_constraint,
      trigger_definition.tgdeferrable AS is_deferrable,
      trigger_definition.tginitdeferred AS is_initially_deferred,
      trigger_definition.tgenabled = 'O' AS is_enabled
    FROM pg_catalog.pg_trigger AS trigger_definition
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = trigger_definition.tgrelid
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_proc AS function_definition
      ON function_definition.oid = trigger_definition.tgfoid
    WHERE NOT trigger_definition.tgisinternal
      AND namespace.nspname = 'public'
      AND trigger_definition.tgname IN (
        'after_sale_items_a_b3_approval_order_lock_guard',
        'after_sales_a_b3_approval_order_lock_guard',
        'after_sale_order_allocations_a_b3_approval_order_lock_guard',
        'after_sale_legacy_decisions_a_b3_approval_order_lock_guard',
        'after_sale_transitions_a_b3_approval_order_lock_guard',
        'after_sale_transitions_b3_submit_guard',
        'after_sale_transitions_b3_operation_link_guard',
        'after_sale_operations_b3_completion_guard',
        'after_sale_operations_b3_atomic_guard',
        'after_sale_transitions_b3_atomic_guard',
        'after_sales_b3_runtime_commit_guard'
      )
    ORDER BY relation.relname, trigger_definition.tgname
  `;
  const expectedTriggers = new Map<
    string,
    {
      functionName: string;
      isConstraint: boolean;
      isDeferrable: boolean;
      isInitiallyDeferred: boolean;
    }
  >([
    [
      'after_sale_items:after_sale_items_a_b3_approval_order_lock_guard',
      {
        functionName: 'guard_m63_b3_approval_mutation_order_scope',
        isConstraint: false,
        isDeferrable: false,
        isInitiallyDeferred: false,
      },
    ],
    [
      'after_sales:after_sales_a_b3_approval_order_lock_guard',
      {
        functionName: 'guard_m63_b3_approval_mutation_order_scope',
        isConstraint: false,
        isDeferrable: false,
        isInitiallyDeferred: false,
      },
    ],
    [
      'after_sale_order_allocations:after_sale_order_allocations_a_b3_approval_order_lock_guard',
      {
        functionName: 'guard_m63_b3_approval_mutation_order_scope',
        isConstraint: false,
        isDeferrable: false,
        isInitiallyDeferred: false,
      },
    ],
    [
      'after_sale_legacy_decisions:after_sale_legacy_decisions_a_b3_approval_order_lock_guard',
      {
        functionName: 'guard_m63_b3_approval_mutation_order_scope',
        isConstraint: false,
        isDeferrable: false,
        isInitiallyDeferred: false,
      },
    ],
    [
      'after_sale_transitions:after_sale_transitions_a_b3_approval_order_lock_guard',
      {
        functionName: 'lock_m63_b3_approval_order_scope',
        isConstraint: false,
        isDeferrable: false,
        isInitiallyDeferred: false,
      },
    ],
    [
      'after_sale_transitions:after_sale_transitions_b3_submit_guard',
      {
        functionName: 'validate_m63_b3_submit_transition',
        isConstraint: false,
        isDeferrable: false,
        isInitiallyDeferred: false,
      },
    ],
    [
      'after_sale_transitions:after_sale_transitions_b3_operation_link_guard',
      {
        functionName: 'validate_m63_b3_operation_link',
        isConstraint: false,
        isDeferrable: false,
        isInitiallyDeferred: false,
      },
    ],
    [
      'after_sale_operations:after_sale_operations_b3_completion_guard',
      {
        functionName: 'validate_m63_b3_operation_completion',
        isConstraint: false,
        isDeferrable: false,
        isInitiallyDeferred: false,
      },
    ],
    [
      'after_sale_operations:after_sale_operations_b3_atomic_guard',
      {
        functionName: 'validate_m63_b3_command_atomicity',
        isConstraint: true,
        isDeferrable: true,
        isInitiallyDeferred: true,
      },
    ],
    [
      'after_sale_transitions:after_sale_transitions_b3_atomic_guard',
      {
        functionName: 'validate_m63_b3_command_atomicity',
        isConstraint: true,
        isDeferrable: true,
        isInitiallyDeferred: true,
      },
    ],
    [
      'after_sales:after_sales_b3_runtime_commit_guard',
      {
        functionName: 'validate_m63_b3_runtime_case_commit',
        isConstraint: true,
        isDeferrable: true,
        isInitiallyDeferred: true,
      },
    ],
  ]);
  if (triggerRows.length !== expectedTriggers.size) {
    fail(`M6.3-B3 trigger catalog is incomplete: ${JSON.stringify(triggerRows)}`);
  }
  for (const row of triggerRows) {
    const expected = expectedTriggers.get(`${row.table_name}:${row.trigger_name}`);
    if (
      !expected ||
      row.function_name !== expected.functionName ||
      row.function_identity_arguments !== '' ||
      row.is_constraint !== expected.isConstraint ||
      row.is_deferrable !== expected.isDeferrable ||
      row.is_initially_deferred !== expected.isInitiallyDeferred ||
      !row.is_enabled
    ) {
      fail(`M6.3-B3 trigger shape differs: ${JSON.stringify(row)}`);
    }
  }

  const constraintRows = await client.$queryRaw<B3ConstraintCatalogRecord[]>`
    SELECT
      constraint_definition.conname AS constraint_name,
      constraint_definition.contype AS constraint_type,
      pg_catalog.pg_get_constraintdef(constraint_definition.oid, true) AS definition,
      constraint_definition.convalidated AS is_validated,
      source_relation.relname AS source_table,
      referenced_relation.relname AS referenced_table,
      constraint_definition.confdeltype AS delete_action,
      constraint_definition.confupdtype AS update_action,
      ARRAY(
        SELECT source_attribute.attname
        FROM pg_catalog.unnest(constraint_definition.conkey) WITH ORDINALITY
          AS source_key(attnum, ordinal)
        JOIN pg_catalog.pg_attribute AS source_attribute
          ON source_attribute.attrelid = constraint_definition.conrelid
         AND source_attribute.attnum = source_key.attnum
        ORDER BY source_key.ordinal
      ) AS source_columns,
      CASE WHEN constraint_definition.confrelid = 0 THEN NULL ELSE ARRAY(
        SELECT referenced_attribute.attname
        FROM pg_catalog.unnest(constraint_definition.confkey) WITH ORDINALITY
          AS referenced_key(attnum, ordinal)
        JOIN pg_catalog.pg_attribute AS referenced_attribute
          ON referenced_attribute.attrelid = constraint_definition.confrelid
         AND referenced_attribute.attnum = referenced_key.attnum
        ORDER BY referenced_key.ordinal
      ) END AS referenced_columns
    FROM pg_catalog.pg_constraint AS constraint_definition
    JOIN pg_catalog.pg_class AS source_relation
      ON source_relation.oid = constraint_definition.conrelid
    JOIN pg_catalog.pg_namespace AS source_namespace
      ON source_namespace.oid = source_relation.relnamespace
    LEFT JOIN pg_catalog.pg_class AS referenced_relation
      ON referenced_relation.oid = constraint_definition.confrelid
    WHERE source_namespace.nspname = 'public'
      AND constraint_definition.conname IN (
        'after_sale_operations_store_id_id_after_sale_id_key',
        'after_sale_transitions_operation_fkey'
      )
    ORDER BY constraint_definition.conname
  `;
  const uniqueConstraint = constraintRows.find(
    (row) => row.constraint_name === 'after_sale_operations_store_id_id_after_sale_id_key',
  );
  const operationForeignKey = constraintRows.find(
    (row) => row.constraint_name === 'after_sale_transitions_operation_fkey',
  );
  if (
    constraintRows.length !== 2 ||
    !uniqueConstraint ||
    uniqueConstraint.constraint_type !== 'u' ||
    !uniqueConstraint.is_validated ||
    uniqueConstraint.source_table !== 'after_sale_operations' ||
    uniqueConstraint.source_columns.join(',') !== 'store_id,id,after_sale_id' ||
    !operationForeignKey ||
    operationForeignKey.constraint_type !== 'f' ||
    !operationForeignKey.is_validated ||
    operationForeignKey.source_table !== 'after_sale_transitions' ||
    operationForeignKey.source_columns.join(',') !== 'store_id,operation_id,after_sale_id' ||
    operationForeignKey.referenced_table !== 'after_sale_operations' ||
    operationForeignKey.referenced_columns?.join(',') !== 'store_id,id,after_sale_id' ||
    operationForeignKey.delete_action !== 'r' ||
    operationForeignKey.update_action !== 'c'
  ) {
    fail(`M6.3-B3 composite constraint catalog differs: ${JSON.stringify(constraintRows)}`);
  }

  const indexRows = await client.$queryRaw<B3IndexCatalogRecord[]>`
    SELECT
      index_record.indisready AS is_ready,
      index_record.indisunique AS is_unique,
      index_record.indisvalid AS is_valid,
      index_record.indnkeyatts AS key_attribute_count,
      index_record.indnatts AS total_attribute_count,
      ARRAY(
        SELECT pg_catalog.pg_get_indexdef(
          index_record.indexrelid, key_option.key_number::integer, true
        )
        FROM pg_catalog.unnest(index_record.indkey::smallint[])
          WITH ORDINALITY AS key_option(attribute_number, key_number)
        ORDER BY key_option.key_number
      ) AS index_keys,
      pg_catalog.pg_get_expr(index_record.indpred, index_record.indrelid, true) AS predicate
    FROM pg_catalog.pg_index AS index_record
    JOIN pg_catalog.pg_class AS index_relation
      ON index_relation.oid = index_record.indexrelid
    JOIN pg_catalog.pg_class AS table_relation
      ON table_relation.oid = index_record.indrelid
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = table_relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND table_relation.relname = 'after_sale_transitions'
      AND index_relation.relname = 'after_sale_transitions_one_submit_per_case_key'
  `;
  const submitIndex = indexRows[0];
  if (
    indexRows.length !== 1 ||
    !submitIndex ||
    !submitIndex.is_ready ||
    !submitIndex.is_unique ||
    !submitIndex.is_valid ||
    submitIndex.key_attribute_count !== 2 ||
    submitIndex.total_attribute_count !== 2 ||
    submitIndex.index_keys.join(',') !== 'store_id,after_sale_id' ||
    !submitIndex.predicate ||
    !submitIndex.predicate.includes('event') ||
    !submitIndex.predicate.includes('SUBMIT')
  ) {
    fail(`M6.3-B3 submit uniqueness index differs: ${JSON.stringify(submitIndex ?? null)}`);
  }

  const [operationIdColumn] = await client.$queryRaw<
    Array<{ is_nullable: string; udt_name: string }>
  >`
    SELECT is_nullable, udt_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'after_sale_transitions'
      AND column_name = 'operation_id'
  `;
  const [runtimeOperationInsert] = await client.$queryRaw<Array<{ can_insert: boolean }>>`
    SELECT pg_catalog.has_table_privilege(
      'zalo_shop_runtime', 'public.after_sale_operations', 'INSERT'
    ) AS can_insert
  `;
  if (
    !operationIdColumn ||
    operationIdColumn.udt_name !== 'uuid' ||
    operationIdColumn.is_nullable !== 'YES' ||
    runtimeOperationInsert?.can_insert
  ) {
    fail(
      `M6.3-B3 operation link column or runtime grant differs: ${JSON.stringify({
        operationIdColumn,
        runtimeOperationInsert,
      })}`,
    );
  }

  return createHash('sha256')
    .update(
      JSON.stringify({
        functionRows,
        triggerRows,
        constraintRows,
        indexRows,
        operationIdColumn,
        runtimeOperationInsert,
      }),
    )
    .digest('hex');
}

async function assertM63B3DownBoundary(client: PrismaClientType): Promise<void> {
  const [catalogState] = await client.$queryRaw<
    Array<{
      b3_constraints: bigint;
      b3_functions: bigint;
      b3_indexes: bigint;
      b3_triggers: bigint;
      operation_id_column: bigint;
      operations_insert_grant: boolean;
      operations_insert_policy: bigint;
      transitions_cancel_policy: bigint;
    }>
  >`
    SELECT
      (SELECT count(*) FROM pg_catalog.pg_constraint
       WHERE conname IN (
         'after_sale_operations_store_id_id_after_sale_id_key',
         'after_sale_transitions_operation_fkey'
       )) AS b3_constraints,
      (SELECT count(*)
       FROM pg_catalog.pg_proc function_definition
       JOIN pg_catalog.pg_namespace namespace
         ON namespace.oid = function_definition.pronamespace
       WHERE namespace.nspname = 'app_security'
         AND function_definition.proname LIKE '%m63_b3%') AS b3_functions,
      (SELECT count(*)
       FROM pg_catalog.pg_class index_relation
       JOIN pg_catalog.pg_index index_record ON index_record.indexrelid = index_relation.oid
       WHERE index_relation.relname = 'after_sale_transitions_one_submit_per_case_key') AS b3_indexes,
      (SELECT count(*)
       FROM pg_catalog.pg_trigger trigger_definition
       WHERE NOT trigger_definition.tgisinternal
         AND trigger_definition.tgname LIKE '%b3%') AS b3_triggers,
      (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'after_sale_transitions'
         AND column_name = 'operation_id') AS operation_id_column,
      pg_catalog.has_table_privilege(
        'zalo_shop_runtime', 'public.after_sale_operations', 'INSERT'
      ) AS operations_insert_grant,
      (SELECT count(*) FROM pg_catalog.pg_policy policy_definition
       JOIN pg_catalog.pg_class relation ON relation.oid = policy_definition.polrelid
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public' AND relation.relname = 'after_sale_operations'
         AND policy_definition.polname = 'after_sale_operations_insert_scope') AS operations_insert_policy,
      (SELECT count(*) FROM pg_catalog.pg_policy policy_definition
       JOIN pg_catalog.pg_class relation ON relation.oid = policy_definition.polrelid
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public' AND relation.relname = 'after_sale_transitions'
         AND policy_definition.polname = 'after_sale_transitions_member_cancel_insert') AS transitions_cancel_policy
  `;
  if (
    catalogState?.b3_constraints !== 0n ||
    catalogState.b3_functions !== 0n ||
    catalogState.b3_indexes !== 0n ||
    catalogState.b3_triggers !== 0n ||
    catalogState.operation_id_column !== 0n ||
    !catalogState.operations_insert_grant ||
    catalogState.operations_insert_policy !== 1n ||
    catalogState.transitions_cancel_policy !== 1n
  ) {
    fail(
      `M6.3-B3 down.sql did not restore the pre-B3 catalog: ${JSON.stringify({
        b3_constraints: String(catalogState?.b3_constraints),
        b3_functions: String(catalogState?.b3_functions),
        b3_indexes: String(catalogState?.b3_indexes),
        b3_triggers: String(catalogState?.b3_triggers),
        operation_id_column: String(catalogState?.operation_id_column),
        operations_insert_grant: catalogState?.operations_insert_grant,
        operations_insert_policy: String(catalogState?.operations_insert_policy),
        transitions_cancel_policy: String(catalogState?.transitions_cancel_policy),
      })}`,
    );
  }
}

type B4FunctionCatalogRecord = B3FunctionCatalogRecord & { definition: string };

async function assertM63B4ReviewBoundary(client: PrismaClientType): Promise<string> {
  const functionRows = await client.$queryRaw<B4FunctionCatalogRecord[]>`
    SELECT
      function_definition.proname AS function_name,
      pg_catalog.oidvectortypes(function_definition.proargtypes) AS identity_arguments,
      pg_catalog.pg_get_functiondef(function_definition.oid) AS definition,
      EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(
            function_definition.proacl,
            pg_catalog.acldefault('f', function_definition.proowner)
          )
        ) AS privilege
        WHERE privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'
      ) AS public_can_execute,
      pg_catalog.has_function_privilege(
        'zalo_shop_runtime', function_definition.oid, 'EXECUTE'
      ) AS runtime_can_execute,
      function_definition.prosecdef AS security_definer,
      'search_path=pg_catalog, public, pg_temp' = ANY(function_definition.proconfig)
        AS safe_search_path,
      'row_security=on' = ANY(function_definition.proconfig) AS row_security_on
    FROM pg_catalog.pg_proc AS function_definition
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = function_definition.pronamespace
    WHERE namespace.nspname = 'app_security'
      AND function_definition.proname IN (
        'validate_m63_b4_operation_completion',
        'validate_m63_b4_command_atomicity',
        'review_m63_b4_after_sale',
        'resolve_m63_b4_after_sale_review',
        'expire_m63_b4_due_after_sales'
      )
    ORDER BY function_definition.proname, identity_arguments
  `;
  const expectedFunctions = new Map<
    string,
    { runtimeCanExecute: boolean; securityDefiner: boolean }
  >([
    [
      'validate_m63_b4_operation_completion()',
      { runtimeCanExecute: false, securityDefiner: false },
    ],
    ['validate_m63_b4_command_atomicity()', { runtimeCanExecute: false, securityDefiner: true }],
    [
      'review_m63_b4_after_sale(uuid, uuid, text, text, integer, text, jsonb, text, inet)',
      { runtimeCanExecute: true, securityDefiner: true },
    ],
    [
      'resolve_m63_b4_after_sale_review(uuid, uuid, text, text, integer, text, text, text, text, integer, text, inet)',
      { runtimeCanExecute: true, securityDefiner: true },
    ],
    ['expire_m63_b4_due_after_sales(integer)', { runtimeCanExecute: true, securityDefiner: true }],
  ]);
  if (functionRows.length !== expectedFunctions.size) {
    fail(`M6.3-B4 function catalog is incomplete: ${JSON.stringify(functionRows)}`);
  }
  for (const row of functionRows) {
    const key = `${row.function_name}(${row.identity_arguments})`;
    const expected = expectedFunctions.get(key);
    if (
      !expected ||
      row.public_can_execute ||
      row.runtime_can_execute !== expected.runtimeCanExecute ||
      row.security_definer !== expected.securityDefiner ||
      !row.safe_search_path ||
      row.row_security_on
    ) {
      fail(`M6.3-B4 function grants or configuration differ: ${JSON.stringify(row)}`);
    }
  }
  const atomicityFunction = functionRows.find(
    (row) => row.function_name === 'validate_m63_b4_command_atomicity',
  );
  if (
    !atomicityFunction?.definition.includes('target_operation_id') ||
    !atomicityFunction.definition.includes('target_after_sale_id') ||
    atomicityFunction.definition.includes('DECLARE after_sale_id uuid')
  ) {
    fail('M6.3-B4 atomicity function does not include the approved forward ambiguity fix');
  }

  const triggerRows = await client.$queryRaw<B3TriggerCatalogRecord[]>`
    SELECT
      relation.relname AS table_name,
      trigger_definition.tgname AS trigger_name,
      function_definition.proname AS function_name,
      pg_catalog.oidvectortypes(function_definition.proargtypes)
        AS function_identity_arguments,
      trigger_definition.tgconstraint <> 0 AS is_constraint,
      trigger_definition.tgdeferrable AS is_deferrable,
      trigger_definition.tginitdeferred AS is_initially_deferred,
      trigger_definition.tgenabled = 'O' AS is_enabled
    FROM pg_catalog.pg_trigger AS trigger_definition
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = trigger_definition.tgrelid
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_proc AS function_definition
      ON function_definition.oid = trigger_definition.tgfoid
    WHERE NOT trigger_definition.tgisinternal
      AND namespace.nspname = 'public'
      AND trigger_definition.tgname IN (
        'after_sale_operations_b4_completion_guard',
        'after_sale_operations_b4_atomic_guard',
        'after_sale_transitions_b4_atomic_guard'
      )
    ORDER BY relation.relname, trigger_definition.tgname
  `;
  const expectedTriggers = new Map<
    string,
    {
      functionName: string;
      isConstraint: boolean;
      isDeferrable: boolean;
      isInitiallyDeferred: boolean;
    }
  >([
    [
      'after_sale_operations:after_sale_operations_b4_completion_guard',
      {
        functionName: 'validate_m63_b4_operation_completion',
        isConstraint: false,
        isDeferrable: false,
        isInitiallyDeferred: false,
      },
    ],
    [
      'after_sale_operations:after_sale_operations_b4_atomic_guard',
      {
        functionName: 'validate_m63_b4_command_atomicity',
        isConstraint: true,
        isDeferrable: true,
        isInitiallyDeferred: true,
      },
    ],
    [
      'after_sale_transitions:after_sale_transitions_b4_atomic_guard',
      {
        functionName: 'validate_m63_b4_command_atomicity',
        isConstraint: true,
        isDeferrable: true,
        isInitiallyDeferred: true,
      },
    ],
  ]);
  if (triggerRows.length !== expectedTriggers.size) {
    fail(`M6.3-B4 trigger catalog is incomplete: ${JSON.stringify(triggerRows)}`);
  }
  for (const row of triggerRows) {
    const expected = expectedTriggers.get(`${row.table_name}:${row.trigger_name}`);
    if (
      !expected ||
      row.function_name !== expected.functionName ||
      row.function_identity_arguments !== '' ||
      row.is_constraint !== expected.isConstraint ||
      row.is_deferrable !== expected.isDeferrable ||
      row.is_initially_deferred !== expected.isInitiallyDeferred ||
      !row.is_enabled
    ) {
      fail(`M6.3-B4 trigger shape differs: ${JSON.stringify(row)}`);
    }
  }

  await assertIndexShape(client, {
    expectedKeys: ['store_id', 'status', 'return_deadline_at', 'id'],
    expectedUnique: false,
    indexName: 'after_sales_return_expiration_idx',
    tableName: 'after_sales',
  });

  const [operationLinkFunction] = await client.$queryRaw<Array<{ definition: string }>>`
    SELECT pg_catalog.pg_get_functiondef(function_definition.oid) AS definition
    FROM pg_catalog.pg_proc AS function_definition
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = function_definition.pronamespace
    WHERE namespace.nspname = 'app_security'
      AND function_definition.proname = 'validate_m63_b3_operation_link'
      AND function_definition.proargtypes = ''::oidvector
  `;
  if (
    !operationLinkFunction?.definition.includes('ADMIN_REVIEW') ||
    !operationLinkFunction.definition.includes('ADMIN_RESOLVE_REVIEW')
  ) {
    fail('M6.3-B4 did not extend the operation-link guard to the approved review commands');
  }

  return createHash('sha256')
    .update(JSON.stringify({ functionRows, triggerRows, operationLinkFunction }))
    .digest('hex');
}

async function assertM63B4DownBoundary(client: PrismaClientType): Promise<void> {
  const [catalogState] = await client.$queryRaw<
    Array<{ b4_functions: bigint; b4_indexes: bigint; b4_triggers: bigint }>
  >`
    SELECT
      (SELECT count(*)
       FROM pg_catalog.pg_proc function_definition
       JOIN pg_catalog.pg_namespace namespace
         ON namespace.oid = function_definition.pronamespace
       WHERE namespace.nspname = 'app_security'
         AND function_definition.proname LIKE '%m63_b4%') AS b4_functions,
      (SELECT count(*)
       FROM pg_catalog.pg_class index_relation
       JOIN pg_catalog.pg_namespace namespace
         ON namespace.oid = index_relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND index_relation.relname = 'after_sales_return_expiration_idx') AS b4_indexes,
      (SELECT count(*)
       FROM pg_catalog.pg_trigger trigger_definition
       WHERE NOT trigger_definition.tgisinternal
         AND trigger_definition.tgname LIKE '%b4%') AS b4_triggers
  `;
  if (
    catalogState?.b4_functions !== 0n ||
    catalogState.b4_indexes !== 0n ||
    catalogState.b4_triggers !== 0n
  ) {
    fail(
      `M6.3-B4 down.sql did not restore the pre-B4 catalog: ${JSON.stringify({
        b4_functions: String(catalogState?.b4_functions),
        b4_indexes: String(catalogState?.b4_indexes),
        b4_triggers: String(catalogState?.b4_triggers),
      })}`,
    );
  }
}

type B5FunctionCatalogRecord = B3FunctionCatalogRecord & { definition: string };

async function assertM63B5ReturnBoundary(client: PrismaClientType): Promise<string> {
  const functionRows = await client.$queryRaw<B5FunctionCatalogRecord[]>`
    SELECT
      function_definition.proname AS function_name,
      pg_catalog.oidvectortypes(function_definition.proargtypes) AS identity_arguments,
      pg_catalog.pg_get_functiondef(function_definition.oid) AS definition,
      EXISTS (
        SELECT 1 FROM pg_catalog.aclexplode(
          COALESCE(function_definition.proacl,
            pg_catalog.acldefault('f', function_definition.proowner))
        ) AS privilege
        WHERE privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'
      ) AS public_can_execute,
      pg_catalog.has_function_privilege(
        'zalo_shop_runtime', function_definition.oid, 'EXECUTE'
      ) AS runtime_can_execute,
      function_definition.prosecdef AS security_definer,
      'search_path=pg_catalog, public, pg_temp' = ANY(function_definition.proconfig)
        AS safe_search_path,
      'row_security=on' = ANY(function_definition.proconfig) AS row_security_on
    FROM pg_catalog.pg_proc AS function_definition
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = function_definition.pronamespace
    WHERE namespace.nspname = 'app_security'
      AND function_definition.proname IN (
        'validate_m63_b5_admin_return_transition',
        'validate_m63_b5_operation_completion',
        'validate_m63_b5_command_atomicity',
        'submit_m63_b5_member_return',
        'record_m63_b5_return_fact'
      )
    ORDER BY function_definition.proname, identity_arguments
  `;
  const expectedFunctions = new Map<
    string,
    { runtimeCanExecute: boolean; securityDefiner: boolean }
  >([
    [
      'validate_m63_b5_admin_return_transition()',
      { runtimeCanExecute: false, securityDefiner: true },
    ],
    [
      'validate_m63_b5_operation_completion()',
      { runtimeCanExecute: false, securityDefiner: false },
    ],
    ['validate_m63_b5_command_atomicity()', { runtimeCanExecute: false, securityDefiner: true }],
    [
      'submit_m63_b5_member_return(uuid, uuid, text, text, integer, text, text, text, inet)',
      { runtimeCanExecute: true, securityDefiner: true },
    ],
    [
      'record_m63_b5_return_fact(uuid, uuid, text, text, integer, integer, text, text, inet)',
      { runtimeCanExecute: true, securityDefiner: true },
    ],
  ]);
  if (functionRows.length !== expectedFunctions.size) {
    fail(`M6.3-B5 function catalog is incomplete: ${JSON.stringify(functionRows)}`);
  }
  for (const row of functionRows) {
    const expected = expectedFunctions.get(`${row.function_name}(${row.identity_arguments})`);
    if (
      !expected ||
      row.public_can_execute ||
      row.runtime_can_execute !== expected.runtimeCanExecute ||
      row.security_definer !== expected.securityDefiner ||
      !row.safe_search_path ||
      row.row_security_on
    ) {
      fail(`M6.3-B5 function grants or configuration differ: ${JSON.stringify(row)}`);
    }
  }
  const factFunction = functionRows.find(
    (row) => row.function_name === 'record_m63_b5_return_fact',
  );
  if (!factFunction?.definition.includes('transition_created_at')) {
    fail('M6.3-B5 direct delivery transition timestamps are not strictly ordered');
  }

  const triggerRows = await client.$queryRaw<B3TriggerCatalogRecord[]>`
    SELECT
      relation.relname AS table_name,
      trigger_definition.tgname AS trigger_name,
      function_definition.proname AS function_name,
      pg_catalog.oidvectortypes(function_definition.proargtypes)
        AS function_identity_arguments,
      trigger_definition.tgconstraint <> 0 AS is_constraint,
      trigger_definition.tgdeferrable AS is_deferrable,
      trigger_definition.tginitdeferred AS is_initially_deferred,
      trigger_definition.tgenabled = 'O' AS is_enabled
    FROM pg_catalog.pg_trigger AS trigger_definition
    JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger_definition.tgrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_proc AS function_definition ON function_definition.oid = trigger_definition.tgfoid
    WHERE NOT trigger_definition.tgisinternal
      AND namespace.nspname = 'public'
      AND trigger_definition.tgname IN (
        'after_sale_operations_b5_completion_guard',
        'after_sale_operations_b5_atomic_guard',
        'after_sale_transitions_b5_atomic_guard',
        'after_sale_transitions_b5_return_state_guard'
      )
    ORDER BY relation.relname, trigger_definition.tgname
  `;
  const expectedTriggers = new Map<string, { functionName: string; isConstraint: boolean }>([
    [
      'after_sale_operations:after_sale_operations_b5_completion_guard',
      { functionName: 'validate_m63_b5_operation_completion', isConstraint: false },
    ],
    [
      'after_sale_operations:after_sale_operations_b5_atomic_guard',
      { functionName: 'validate_m63_b5_command_atomicity', isConstraint: true },
    ],
    [
      'after_sale_transitions:after_sale_transitions_b5_atomic_guard',
      { functionName: 'validate_m63_b5_command_atomicity', isConstraint: true },
    ],
    [
      'after_sale_transitions:after_sale_transitions_b5_return_state_guard',
      { functionName: 'validate_m63_b5_admin_return_transition', isConstraint: false },
    ],
  ]);
  if (triggerRows.length !== expectedTriggers.size) {
    fail(`M6.3-B5 trigger catalog is incomplete: ${JSON.stringify(triggerRows)}`);
  }
  for (const row of triggerRows) {
    const expected = expectedTriggers.get(`${row.table_name}:${row.trigger_name}`);
    if (
      !expected ||
      row.function_name !== expected.functionName ||
      row.function_identity_arguments !== '' ||
      row.is_constraint !== expected.isConstraint ||
      (expected.isConstraint && (!row.is_deferrable || !row.is_initially_deferred)) ||
      !row.is_enabled
    ) {
      fail(`M6.3-B5 trigger shape differs: ${JSON.stringify(row)}`);
    }
  }

  const [privileges] = await client.$queryRaw<
    Array<{ return_insert: boolean; return_update: boolean; state_guard_definition: string }>
  >`
    SELECT
      pg_catalog.has_table_privilege(
        'zalo_shop_runtime', 'public.after_sale_return_shipments', 'INSERT'
      ) AS return_insert,
      pg_catalog.has_column_privilege(
        'zalo_shop_runtime', 'public.after_sale_return_shipments', 'status', 'UPDATE'
      ) AND pg_catalog.has_column_privilege(
        'zalo_shop_runtime', 'public.after_sale_return_shipments', 'received_at', 'UPDATE'
      ) AND pg_catalog.has_column_privilege(
        'zalo_shop_runtime', 'public.after_sale_return_shipments', 'version', 'UPDATE'
      ) AND pg_catalog.has_column_privilege(
        'zalo_shop_runtime', 'public.after_sale_return_shipments', 'updated_at', 'UPDATE'
      ) AS return_update,
      pg_catalog.pg_get_triggerdef(trigger_definition.oid) AS state_guard_definition
    FROM pg_catalog.pg_trigger AS trigger_definition
    JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger_definition.tgrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = 'after_sale_transitions'
      AND trigger_definition.tgname = 'after_sale_transitions_state_guard'
  `;
  if (
    privileges?.return_insert ||
    privileges?.return_update ||
    !privileges?.state_guard_definition.includes("'SUBMIT'")
  ) {
    fail(`M6.3-B5 runtime privileges or generic state guard differ: ${JSON.stringify(privileges)}`);
  }
  const [operationLink] = await client.$queryRaw<Array<{ definition: string }>>`
    SELECT pg_catalog.pg_get_functiondef(function_definition.oid) AS definition
    FROM pg_catalog.pg_proc AS function_definition
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = function_definition.pronamespace
    WHERE namespace.nspname = 'app_security'
      AND function_definition.proname = 'validate_m63_b3_operation_link'
      AND function_definition.proargtypes = ''::oidvector
  `;
  if (
    !operationLink?.definition.includes('START_RETURN') ||
    !operationLink.definition.includes('ADMIN_RECORD_RETURN_FACT')
  ) {
    fail('M6.3-B5 operation-link catalog does not include return commands');
  }
  return createHash('sha256')
    .update(JSON.stringify({ functionRows, triggerRows, privileges, operationLink }))
    .digest('hex');
}

async function assertP0M6007CodRefundBoundary(
  client: PrismaClientType,
  shouldExist: boolean,
): Promise<string> {
  const [state] = await client.$queryRaw<
    Array<{
      b3_cod_guard: boolean;
      composite_foreign_keys: bigint;
      confirmation_table: string | null;
      deferred_triggers: bigint;
      functions: bigint;
      identity_index: bigint;
      policies: bigint;
      public_executable_functions: bigint;
      receipt_table: string | null;
      rls_tables: bigint;
      runtime_executable_functions: bigint;
      runtime_forbidden_grants: bigint;
      runtime_table_grants: bigint;
      safe_search_path_functions: bigint;
      security_definer_functions: bigint;
      settlement_receipt_guard: boolean;
      triggers: bigint;
    }>
  >`
    SELECT
      to_regclass('public.after_sale_cod_refund_receipts')::text AS receipt_table,
      to_regclass('public.after_sale_cod_refund_confirmations')::text AS confirmation_table,
      (SELECT count(*)
       FROM pg_catalog.pg_class relation
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND relation.relname IN (
           'after_sale_cod_refund_receipts', 'after_sale_cod_refund_confirmations'
         )
         AND relation.relrowsecurity
         AND relation.relforcerowsecurity) AS rls_tables,
      (SELECT count(*) FROM pg_catalog.pg_policies policy
       WHERE policy.schemaname = 'public'
         AND policy.tablename IN (
           'after_sale_cod_refund_receipts', 'after_sale_cod_refund_confirmations'
         )) AS policies,
      (SELECT count(*) FROM pg_catalog.pg_proc function_definition
       JOIN pg_catalog.pg_namespace namespace
         ON namespace.oid = function_definition.pronamespace
       WHERE namespace.nspname = 'app_security'
         AND function_definition.proname IN (
           'assert_p0_m6_007_admin_authorization',
           'validate_p0_m6_007_receipt',
           'validate_p0_m6_007_receipt_atomicity',
           'validate_p0_m6_007_confirmation',
           'validate_p0_m6_007_confirmation_atomicity'
         )) AS functions,
      (SELECT count(*) FROM pg_catalog.pg_proc function_definition
       JOIN pg_catalog.pg_namespace namespace
         ON namespace.oid = function_definition.pronamespace
       WHERE namespace.nspname = 'app_security'
         AND function_definition.proname IN (
           'assert_p0_m6_007_admin_authorization',
           'validate_p0_m6_007_receipt',
           'validate_p0_m6_007_receipt_atomicity',
           'validate_p0_m6_007_confirmation',
           'validate_p0_m6_007_confirmation_atomicity'
         )
         AND function_definition.prosecdef) AS security_definer_functions,
      (SELECT count(*) FROM pg_catalog.pg_proc function_definition
       JOIN pg_catalog.pg_namespace namespace
         ON namespace.oid = function_definition.pronamespace
       WHERE namespace.nspname = 'app_security'
         AND function_definition.proname IN (
           'assert_p0_m6_007_admin_authorization',
           'validate_p0_m6_007_receipt',
           'validate_p0_m6_007_receipt_atomicity',
           'validate_p0_m6_007_confirmation',
           'validate_p0_m6_007_confirmation_atomicity'
         )
         AND 'search_path=pg_catalog, public, pg_temp' = ANY(function_definition.proconfig))
        AS safe_search_path_functions,
      (SELECT count(*) FROM pg_catalog.pg_proc function_definition
       JOIN pg_catalog.pg_namespace namespace
         ON namespace.oid = function_definition.pronamespace
       WHERE namespace.nspname = 'app_security'
         AND function_definition.proname IN (
           'assert_p0_m6_007_admin_authorization',
           'validate_p0_m6_007_receipt',
           'validate_p0_m6_007_receipt_atomicity',
           'validate_p0_m6_007_confirmation',
           'validate_p0_m6_007_confirmation_atomicity'
         )
         AND pg_catalog.has_function_privilege(
           'zalo_shop_runtime', function_definition.oid, 'EXECUTE'
         )) AS runtime_executable_functions,
      (SELECT count(*) FROM pg_catalog.pg_proc function_definition
       JOIN pg_catalog.pg_namespace namespace
         ON namespace.oid = function_definition.pronamespace
       WHERE namespace.nspname = 'app_security'
         AND function_definition.proname IN (
           'assert_p0_m6_007_admin_authorization',
           'validate_p0_m6_007_receipt',
           'validate_p0_m6_007_receipt_atomicity',
           'validate_p0_m6_007_confirmation',
           'validate_p0_m6_007_confirmation_atomicity'
         )
         AND EXISTS (
           SELECT 1
           FROM pg_catalog.aclexplode(
             COALESCE(
               function_definition.proacl,
               pg_catalog.acldefault('f', function_definition.proowner)
             )
           ) AS privilege
           WHERE privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'
         ))
        AS public_executable_functions,
      (SELECT count(*) FROM pg_catalog.pg_trigger trigger_definition
       WHERE NOT trigger_definition.tgisinternal
         AND trigger_definition.tgname IN (
           'after_sale_cod_refund_receipts_insert_guard',
           'after_sale_cod_refund_receipts_append_only',
           'after_sale_cod_refund_receipts_atomic_guard',
           'after_sale_cod_refund_confirmations_insert_guard',
           'after_sale_cod_refund_confirmations_append_only',
           'after_sale_cod_refund_confirmations_atomic_guard'
         )) AS triggers,
      (SELECT count(*) FROM pg_catalog.pg_trigger trigger_definition
       WHERE NOT trigger_definition.tgisinternal
         AND trigger_definition.tgname IN (
           'after_sale_cod_refund_receipts_atomic_guard',
           'after_sale_cod_refund_confirmations_atomic_guard'
         )
         AND trigger_definition.tgconstraint <> 0
         AND trigger_definition.tgdeferrable
         AND trigger_definition.tginitdeferred) AS deferred_triggers,
      (SELECT count(*) FROM pg_catalog.pg_constraint constraint_definition
       WHERE constraint_definition.conname IN (
         'after_sale_cod_refund_receipts_case_order_fkey',
         'after_sale_cod_refund_receipts_settlement_fkey',
         'after_sale_cod_refund_confirmations_case_order_fkey',
         'after_sale_cod_refund_confirmations_settlement_fkey'
       )
         AND constraint_definition.contype = 'f'
         AND constraint_definition.convalidated) AS composite_foreign_keys,
      (SELECT count(*) FROM pg_catalog.pg_indexes
       WHERE schemaname = 'public'
         AND indexname = 'after_sale_settlements_cod_receipt_identity_key') AS identity_index,
      (SELECT count(*) FROM information_schema.role_table_grants
       WHERE grantee = 'zalo_shop_runtime'
         AND table_schema = 'public'
         AND table_name IN (
           'after_sale_cod_refund_receipts', 'after_sale_cod_refund_confirmations'
         )
         AND privilege_type IN ('SELECT', 'INSERT')) AS runtime_table_grants,
      (SELECT count(*) FROM information_schema.role_table_grants
       WHERE grantee = 'zalo_shop_runtime'
         AND table_schema = 'public'
         AND table_name IN (
           'after_sale_cod_refund_receipts', 'after_sale_cod_refund_confirmations'
         )
         AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')) AS runtime_forbidden_grants,
      COALESCE((SELECT
        pg_catalog.pg_get_functiondef(function_definition.oid) LIKE '%COD_REMITTANCE%'
        AND pg_catalog.pg_get_functiondef(function_definition.oid)
          LIKE '%financial_reconciliation_lines%'
       FROM pg_catalog.pg_proc function_definition
       JOIN pg_catalog.pg_namespace namespace
         ON namespace.oid = function_definition.pronamespace
       WHERE namespace.nspname = 'app_security'
         AND function_definition.proname = 'validate_m63_b3_command_facts'
         AND function_definition.proargtypes = '2950'::oidvector), false) AS b3_cod_guard,
      COALESCE((SELECT
        pg_catalog.pg_get_functiondef(function_definition.oid)
          LIKE '%after_sale_cod_refund_receipts%'
        AND pg_catalog.pg_get_functiondef(function_definition.oid)
          LIKE '%assert_p0_m6_007_admin_authorization%'
       FROM pg_catalog.pg_proc function_definition
       JOIN pg_catalog.pg_namespace namespace
         ON namespace.oid = function_definition.pronamespace
       WHERE namespace.nspname = 'app_security'
         AND function_definition.proname = 'validate_m62_settlement_lifecycle'
         AND function_definition.proargtypes = ''::oidvector), false)
        AS settlement_receipt_guard
  `;
  const valid = shouldExist
    ? state?.receipt_table === 'after_sale_cod_refund_receipts' &&
      state.confirmation_table === 'after_sale_cod_refund_confirmations' &&
      state.rls_tables === 2n &&
      state.policies === 2n &&
      state.functions === 5n &&
      state.security_definer_functions === 5n &&
      state.safe_search_path_functions === 5n &&
      state.runtime_executable_functions === 5n &&
      state.public_executable_functions === 0n &&
      state.triggers === 6n &&
      state.deferred_triggers === 2n &&
      state.composite_foreign_keys === 4n &&
      state.identity_index === 1n &&
      state.runtime_table_grants === 4n &&
      state.runtime_forbidden_grants === 0n &&
      state.b3_cod_guard &&
      state.settlement_receipt_guard
    : state?.receipt_table === null &&
      state.confirmation_table === null &&
      state.rls_tables === 0n &&
      state.policies === 0n &&
      state.functions === 0n &&
      state.security_definer_functions === 0n &&
      state.safe_search_path_functions === 0n &&
      state.runtime_executable_functions === 0n &&
      state.public_executable_functions === 0n &&
      state.triggers === 0n &&
      state.deferred_triggers === 0n &&
      state.composite_foreign_keys === 0n &&
      state.identity_index === 0n &&
      state.runtime_table_grants === 0n &&
      state.runtime_forbidden_grants === 0n &&
      !state.b3_cod_guard &&
      !state.settlement_receipt_guard;
  if (!valid) {
    fail(
      `P0-M6-007 COD refund catalog differs: ${JSON.stringify({
        ...state,
        composite_foreign_keys: String(state?.composite_foreign_keys),
        deferred_triggers: String(state?.deferred_triggers),
        functions: String(state?.functions),
        identity_index: String(state?.identity_index),
        policies: String(state?.policies),
        public_executable_functions: String(state?.public_executable_functions),
        rls_tables: String(state?.rls_tables),
        runtime_executable_functions: String(state?.runtime_executable_functions),
        runtime_forbidden_grants: String(state?.runtime_forbidden_grants),
        runtime_table_grants: String(state?.runtime_table_grants),
        safe_search_path_functions: String(state?.safe_search_path_functions),
        security_definer_functions: String(state?.security_definer_functions),
        shouldExist,
        triggers: String(state?.triggers),
      })}`,
    );
  }
  return createHash('sha256')
    .update(
      JSON.stringify(state, (_key: string, value: unknown): unknown =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    )
    .digest('hex');
}

async function assertP0M6008ReturnInspectionBoundary(
  client: PrismaClientType,
  shouldExist: boolean,
): Promise<string> {
  const [state] = await client.$queryRaw<
    Array<{
      deferred_triggers: bigint;
      functions: bigint;
      inspection_contract: boolean;
      operation_link: boolean;
      owner_functions: bigint;
      public_executable_functions: bigint;
      runtime_executable_functions: bigint;
      safe_search_path_functions: bigint;
      security_definer_functions: bigint;
      triggers: bigint;
    }>
  >`
    SELECT
      (SELECT count(*) FROM pg_catalog.pg_proc function_definition
       JOIN pg_catalog.pg_namespace namespace
         ON namespace.oid = function_definition.pronamespace
       WHERE namespace.nspname = 'app_security'
         AND function_definition.proname LIKE '%p0_m6_008%') AS functions,
      (SELECT count(*) FROM pg_catalog.pg_proc function_definition
       JOIN pg_catalog.pg_namespace namespace
         ON namespace.oid = function_definition.pronamespace
       JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = function_definition.proowner
       WHERE namespace.nspname = 'app_security'
         AND function_definition.proname LIKE '%p0_m6_008%'
         AND owner_role.rolname = 'zalo_shop') AS owner_functions,
      (SELECT count(*) FROM pg_catalog.pg_proc function_definition
       JOIN pg_catalog.pg_namespace namespace
         ON namespace.oid = function_definition.pronamespace
       WHERE namespace.nspname = 'app_security'
         AND function_definition.proname LIKE '%p0_m6_008%'
         AND function_definition.prosecdef) AS security_definer_functions,
      (SELECT count(*) FROM pg_catalog.pg_proc function_definition
       JOIN pg_catalog.pg_namespace namespace
         ON namespace.oid = function_definition.pronamespace
       WHERE namespace.nspname = 'app_security'
         AND function_definition.proname LIKE '%p0_m6_008%'
         AND 'search_path=pg_catalog, public, pg_temp' = ANY(function_definition.proconfig))
        AS safe_search_path_functions,
      (SELECT count(*) FROM pg_catalog.pg_proc function_definition
       JOIN pg_catalog.pg_namespace namespace
         ON namespace.oid = function_definition.pronamespace
       WHERE namespace.nspname = 'app_security'
         AND function_definition.proname LIKE '%p0_m6_008%'
         AND pg_catalog.has_function_privilege(
           'zalo_shop_runtime', function_definition.oid, 'EXECUTE'
         )) AS runtime_executable_functions,
      (SELECT count(*) FROM pg_catalog.pg_proc function_definition
       JOIN pg_catalog.pg_namespace namespace
         ON namespace.oid = function_definition.pronamespace
       WHERE namespace.nspname = 'app_security'
         AND function_definition.proname LIKE '%p0_m6_008%'
         AND pg_catalog.has_function_privilege('public', function_definition.oid, 'EXECUTE'))
        AS public_executable_functions,
      (SELECT count(*) FROM pg_catalog.pg_trigger trigger_definition
       WHERE NOT trigger_definition.tgisinternal
         AND trigger_definition.tgname LIKE '%p0_m6_008%') AS triggers,
      (SELECT count(*) FROM pg_catalog.pg_trigger trigger_definition
       WHERE NOT trigger_definition.tgisinternal
         AND trigger_definition.tgname LIKE '%p0_m6_008%'
         AND trigger_definition.tgconstraint <> 0
         AND trigger_definition.tgdeferrable
         AND trigger_definition.tginitdeferred) AS deferred_triggers,
      COALESCE((SELECT
        pg_catalog.pg_get_functiondef(function_definition.oid) LIKE '%ACCEPT_INSPECTION%'
        AND pg_catalog.pg_get_functiondef(function_definition.oid) LIKE '%REJECT_INSPECTION%'
        AND pg_catalog.pg_get_functiondef(function_definition.oid) LIKE '%ADMIN_INSPECT_RETURN%'
       FROM pg_catalog.pg_proc function_definition
       JOIN pg_catalog.pg_namespace namespace
         ON namespace.oid = function_definition.pronamespace
       WHERE namespace.nspname = 'app_security'
         AND function_definition.proname = 'validate_m63_b3_operation_link'
         AND function_definition.proargtypes = ''::oidvector), false) AS operation_link,
      COALESCE((SELECT
        pg_catalog.pg_get_functiondef(function_definition.oid) LIKE '%RESTOCK_SELLABLE%'
        AND pg_catalog.pg_get_functiondef(function_definition.oid) LIKE '%AFTER_SALE_RESTORE%'
        AND pg_catalog.pg_get_functiondef(function_definition.oid)
          LIKE '%assert_p0_m6_008_admin_authorization%'
       FROM pg_catalog.pg_proc function_definition
       JOIN pg_catalog.pg_namespace namespace
         ON namespace.oid = function_definition.pronamespace
       WHERE namespace.nspname = 'app_security'
         AND function_definition.proname = 'inspect_p0_m6_008_after_sale_return'
         AND function_definition.proargtypes =
           '2950 2950 25 25 23 23 3802 25 869'::oidvector), false) AS inspection_contract
  `;
  const valid = shouldExist
    ? state?.functions === 4n &&
      state.owner_functions === 4n &&
      state.security_definer_functions === 3n &&
      state.safe_search_path_functions === 4n &&
      state.runtime_executable_functions === 1n &&
      state.public_executable_functions === 0n &&
      state.triggers === 3n &&
      state.deferred_triggers === 2n &&
      state.operation_link &&
      state.inspection_contract
    : state?.functions === 0n &&
      state.owner_functions === 0n &&
      state.security_definer_functions === 0n &&
      state.safe_search_path_functions === 0n &&
      state.runtime_executable_functions === 0n &&
      state.public_executable_functions === 0n &&
      state.triggers === 0n &&
      state.deferred_triggers === 0n &&
      !state.operation_link &&
      !state.inspection_contract;
  if (!valid) {
    fail(
      `P0-M6-008 return inspection catalog differs: ${JSON.stringify({
        ...state,
        deferred_triggers: String(state?.deferred_triggers),
        functions: String(state?.functions),
        owner_functions: String(state?.owner_functions),
        public_executable_functions: String(state?.public_executable_functions),
        runtime_executable_functions: String(state?.runtime_executable_functions),
        safe_search_path_functions: String(state?.safe_search_path_functions),
        security_definer_functions: String(state?.security_definer_functions),
        shouldExist,
        triggers: String(state?.triggers),
      })}`,
    );
  }
  return createHash('sha256')
    .update(
      JSON.stringify(state, (_key: string, value: unknown): unknown =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    )
    .digest('hex');
}

async function assertFinancialReconciliationBoundary(
  client: PrismaClientType,
  shouldExist: boolean,
): Promise<void> {
  const [state] = await client.$queryRaw<
    Array<{
      batch_table: string | null;
      enum_types: bigint;
      functions: bigint;
      line_table: string | null;
      permissions: bigint;
      rls_tables: bigint;
      runtime_privileges: bigint;
      triggers: bigint;
    }>
  >`
    SELECT
      to_regclass('public.financial_reconciliation_batches')::text AS batch_table,
      to_regclass('public.financial_reconciliation_lines')::text AS line_table,
      (SELECT count(*)
       FROM pg_catalog.pg_class relation
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND relation.relname IN (
           'financial_reconciliation_batches', 'financial_reconciliation_lines'
         )
         AND relation.relrowsecurity
         AND relation.relforcerowsecurity) AS rls_tables,
      (SELECT count(*) FROM permissions
       WHERE code IN ('store.finance.read', 'store.finance.reconcile')) AS permissions,
      (SELECT count(*)
       FROM pg_catalog.pg_type enum_type
       WHERE enum_type.typtype = 'e'
         AND enum_type.typname IN (
           'financial_reconciliation_source',
           'financial_reconciliation_batch_status',
           'financial_reconciliation_line_type',
           'financial_reconciliation_line_status'
         )) AS enum_types,
      (SELECT count(*)
       FROM pg_catalog.pg_proc function_definition
       JOIN pg_catalog.pg_namespace namespace
         ON namespace.oid = function_definition.pronamespace
       WHERE namespace.nspname = 'app_security'
         AND function_definition.proname IN (
           'reject_financial_reconciliation_mutation',
           'assert_financial_reconciliation_batch_integrity'
         )) AS functions,
      (SELECT count(*)
       FROM pg_catalog.pg_trigger trigger_definition
       WHERE NOT trigger_definition.tgisinternal
         AND trigger_definition.tgname IN (
           'financial_reconciliation_batches_append_only',
           'financial_reconciliation_lines_append_only',
           'financial_reconciliation_batches_integrity_guard',
           'financial_reconciliation_lines_integrity_guard'
         )) AS triggers,
      (SELECT count(*)
       FROM information_schema.role_table_grants
       WHERE grantee = 'zalo_shop_runtime'
         AND table_schema = 'public'
         AND table_name IN (
           'financial_reconciliation_batches', 'financial_reconciliation_lines'
         )
         AND privilege_type IN ('SELECT', 'INSERT')) AS runtime_privileges
  `;
  const valid = shouldExist
    ? state?.batch_table === 'financial_reconciliation_batches' &&
      state.line_table === 'financial_reconciliation_lines' &&
      state.rls_tables === 2n &&
      state.permissions === 2n &&
      state.enum_types === 4n &&
      state.functions === 2n &&
      state.triggers === 4n &&
      state.runtime_privileges === 4n
    : state?.batch_table === null &&
      state.line_table === null &&
      state.rls_tables === 0n &&
      state.permissions === 0n &&
      state.enum_types === 0n &&
      state.functions === 0n &&
      state.triggers === 0n &&
      state.runtime_privileges === 0n;
  if (!valid) {
    fail(
      `P0-M5-005 financial reconciliation catalog differs: ${JSON.stringify({
        batch_table: state?.batch_table,
        enum_types: String(state?.enum_types),
        functions: String(state?.functions),
        line_table: state?.line_table,
        permissions: String(state?.permissions),
        rls_tables: String(state?.rls_tables),
        runtime_privileges: String(state?.runtime_privileges),
        shouldExist,
        triggers: String(state?.triggers),
      })}`,
    );
  }
}

async function assertCodReconciliationBoundary(
  client: PrismaClientType,
  shouldExist: boolean,
): Promise<void> {
  const [state] = await client.$queryRaw<
    Array<{
      columns: bigint;
      constraints: bigint;
      enum_values: bigint;
      function_has_shipping_guard: boolean;
      indexes: bigint;
    }>
  >`
    SELECT
      (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND (
         (table_name = 'financial_reconciliation_batches' AND column_name IN (
           'shipping_channel_id', 'local_expected_fee_amount_vnd', 'fee_difference_vnd'
         )) OR
         (table_name = 'financial_reconciliation_lines' AND column_name IN (
           'shipment_id', 'local_expected_fee_amount_vnd', 'fee_difference_vnd'
         ))
       )) AS columns,
      (SELECT count(*) FROM pg_catalog.pg_constraint
       WHERE conname IN (
         'financial_reconciliation_batches_source_channel_check',
         'financial_reconciliation_batches_shipping_channel_fkey',
         'financial_reconciliation_lines_shipment_fkey'
       )) AS constraints,
      (SELECT count(*) FROM pg_catalog.pg_enum enum_value
       JOIN pg_catalog.pg_type enum_type ON enum_type.oid = enum_value.enumtypid
       WHERE (enum_type.typname = 'financial_reconciliation_source' AND enum_value.enumlabel = 'SHIPPING_PROVIDER')
          OR (enum_type.typname = 'financial_reconciliation_line_type' AND enum_value.enumlabel = 'COD_REMITTANCE')
          OR (enum_type.typname = 'financial_reconciliation_line_status' AND enum_value.enumlabel IN (
            'FEE_MISMATCH', 'COD_NOT_RECEIVABLE', 'EXPECTED_FEE_NOT_FOUND'
          ))) AS enum_values,
      COALESCE((SELECT pg_catalog.pg_get_functiondef(function_definition.oid) LIKE '%shipping_channel_id%'
       FROM pg_catalog.pg_proc function_definition
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = function_definition.pronamespace
       WHERE namespace.nspname = 'app_security'
         AND function_definition.proname = 'assert_financial_reconciliation_batch_integrity'), false)
        AS function_has_shipping_guard,
      (SELECT count(*) FROM pg_catalog.pg_indexes
       WHERE schemaname = 'public' AND indexname IN (
         'financial_reconciliation_batches_shipping_channel_reference_key',
         'financial_reconciliation_lines_shipment_idx'
       )) AS indexes
  `;
  const valid = shouldExist
    ? state?.columns === 6n &&
      state.constraints === 3n &&
      state.enum_values === 5n &&
      state.function_has_shipping_guard &&
      state.indexes === 2n
    : state?.columns === 0n &&
      state.constraints === 0n &&
      state.enum_values === 0n &&
      !state.function_has_shipping_guard &&
      state.indexes === 0n;
  if (!valid) {
    fail(
      `P0-M5-005 COD reconciliation catalog differs: ${JSON.stringify({
        columns: String(state?.columns),
        constraints: String(state?.constraints),
        enum_values: String(state?.enum_values),
        function_has_shipping_guard: state?.function_has_shipping_guard,
        indexes: String(state?.indexes),
        shouldExist,
      })}`,
    );
  }
}

async function assertFinancialReconciliationReviewBoundary(
  client: PrismaClientType,
  shouldExist: boolean,
): Promise<void> {
  const [state] = await client.$queryRaw<
    Array<{
      enum_types: bigint;
      function_count: bigint;
      grants: bigint;
      policies: bigint;
      review_table: string | null;
      rls_tables: bigint;
      triggers: bigint;
    }>
  >`
    SELECT
      to_regclass('public.financial_reconciliation_reviews')::text AS review_table,
      (SELECT count(*)
       FROM pg_catalog.pg_class relation
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND relation.relname = 'financial_reconciliation_reviews'
         AND relation.relrowsecurity
         AND relation.relforcerowsecurity) AS rls_tables,
      (SELECT count(*) FROM pg_catalog.pg_type enum_type
       WHERE enum_type.typtype = 'e'
         AND enum_type.typname = 'financial_reconciliation_review_decision') AS enum_types,
      (SELECT count(*) FROM pg_catalog.pg_proc function_definition
       JOIN pg_catalog.pg_namespace namespace
         ON namespace.oid = function_definition.pronamespace
       WHERE namespace.nspname = 'app_security'
         AND function_definition.proname = 'assert_financial_reconciliation_review_integrity')
        AS function_count,
      (SELECT count(*) FROM pg_catalog.pg_trigger trigger_definition
       WHERE NOT trigger_definition.tgisinternal
         AND trigger_definition.tgname IN (
           'financial_reconciliation_reviews_append_only',
           'financial_reconciliation_reviews_integrity_guard'
         )) AS triggers,
      (SELECT count(*) FROM pg_catalog.pg_policies policy
       WHERE policy.schemaname = 'public'
         AND policy.tablename = 'financial_reconciliation_reviews') AS policies,
      (SELECT count(*) FROM information_schema.role_table_grants
       WHERE grantee = 'zalo_shop_runtime'
         AND table_schema = 'public'
         AND table_name = 'financial_reconciliation_reviews'
         AND privilege_type IN ('SELECT', 'INSERT')) AS grants
  `;
  const valid = shouldExist
    ? state?.review_table === 'financial_reconciliation_reviews' &&
      state.rls_tables === 1n &&
      state.enum_types === 1n &&
      state.function_count === 1n &&
      state.triggers === 2n &&
      state.policies === 1n &&
      state.grants === 2n
    : state?.review_table === null &&
      state.rls_tables === 0n &&
      state.enum_types === 0n &&
      state.function_count === 0n &&
      state.triggers === 0n &&
      state.policies === 0n &&
      state.grants === 0n;
  if (!valid) {
    fail(
      `P0-M5-005 review closeout catalog differs: ${JSON.stringify({
        enum_types: String(state?.enum_types),
        function_count: String(state?.function_count),
        grants: String(state?.grants),
        policies: String(state?.policies),
        review_table: state?.review_table,
        rls_tables: String(state?.rls_tables),
        shouldExist,
        triggers: String(state?.triggers),
      })}`,
    );
  }
}

async function assertM63B5DownBoundary(client: PrismaClientType): Promise<void> {
  const [catalogState] = await client.$queryRaw<
    Array<{
      b5_functions: bigint;
      b5_triggers: bigint;
      return_insert: boolean;
      return_update: boolean;
    }>
  >`
    SELECT
      (SELECT count(*) FROM pg_catalog.pg_proc function_definition
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = function_definition.pronamespace
       WHERE namespace.nspname = 'app_security'
         AND function_definition.proname LIKE '%m63_b5%') AS b5_functions,
      (SELECT count(*) FROM pg_catalog.pg_trigger trigger_definition
       WHERE NOT trigger_definition.tgisinternal
         AND trigger_definition.tgname LIKE '%b5%') AS b5_triggers,
      pg_catalog.has_table_privilege(
        'zalo_shop_runtime', 'public.after_sale_return_shipments', 'INSERT'
      ) AS return_insert,
      pg_catalog.has_column_privilege(
        'zalo_shop_runtime', 'public.after_sale_return_shipments', 'status', 'UPDATE'
      ) AND pg_catalog.has_column_privilege(
        'zalo_shop_runtime', 'public.after_sale_return_shipments', 'received_at', 'UPDATE'
      ) AND pg_catalog.has_column_privilege(
        'zalo_shop_runtime', 'public.after_sale_return_shipments', 'version', 'UPDATE'
      ) AND pg_catalog.has_column_privilege(
        'zalo_shop_runtime', 'public.after_sale_return_shipments', 'updated_at', 'UPDATE'
      ) AS return_update
  `;
  if (
    catalogState?.b5_functions !== 0n ||
    catalogState.b5_triggers !== 0n ||
    !catalogState.return_insert ||
    !catalogState.return_update
  ) {
    fail(
      `M6.3-B5 down.sql did not restore the pre-B5 catalog: ${JSON.stringify({
        b5_functions: String(catalogState?.b5_functions),
        b5_triggers: String(catalogState?.b5_triggers),
        return_insert: catalogState?.return_insert,
        return_update: catalogState?.return_update,
      })}`,
    );
  }
}

type B3HistoricalPolicyFixtureIds = Readonly<{
  afterSaleId: string;
  orderItemId: string;
  policyId: string;
  policyVersionId: string;
  storeId: string;
}>;

type B3HistoricalPolicyFixtureRecord = {
  after_sale_count: string;
  case_payload: unknown;
  case_payload_hash: string | null;
  draft_payload: unknown;
  draft_payload_hash: string | null;
  order_item_count: string;
  policy_count: string;
  policy_version_count: string;
  snapshot_count: string;
  snapshot_payload: unknown;
  snapshot_payload_hash: string | null;
  version_payload: unknown;
  version_payload_hash: string | null;
};

type MigrationHistorySnapshotRecord = MigrationRecord & {
  id: string;
  started_at: Date;
};

async function migrationHistoryFingerprint(client: PrismaClientType): Promise<string> {
  const records = await client.$queryRaw<MigrationHistorySnapshotRecord[]>`
    SELECT
      id, checksum, finished_at, migration_name, logs, rolled_back_at,
      started_at, applied_steps_count
    FROM "_prisma_migrations"
    ORDER BY started_at, id
  `;
  return createHash('sha256').update(JSON.stringify(records)).digest('hex');
}

async function b3HistoricalPolicyFixtureFingerprint(
  client: PrismaClientType,
  fixture: B3HistoricalPolicyFixtureIds,
): Promise<string> {
  const [record] = await client.$queryRaw<B3HistoricalPolicyFixtureRecord[]>`
    SELECT
      (SELECT count(*)::text FROM after_sale_policies
       WHERE store_id = ${fixture.storeId}::uuid AND id = ${fixture.policyId}::uuid)
        AS policy_count,
      (SELECT draft_payload FROM after_sale_policies
       WHERE store_id = ${fixture.storeId}::uuid AND id = ${fixture.policyId}::uuid)
        AS draft_payload,
      (SELECT draft_hash FROM after_sale_policies
       WHERE store_id = ${fixture.storeId}::uuid AND id = ${fixture.policyId}::uuid)
        AS draft_payload_hash,
      (SELECT count(*)::text FROM after_sale_policy_versions
       WHERE store_id = ${fixture.storeId}::uuid AND id = ${fixture.policyVersionId}::uuid)
        AS policy_version_count,
      (SELECT payload FROM after_sale_policy_versions
       WHERE store_id = ${fixture.storeId}::uuid AND id = ${fixture.policyVersionId}::uuid)
        AS version_payload,
      (SELECT payload_hash FROM after_sale_policy_versions
       WHERE store_id = ${fixture.storeId}::uuid AND id = ${fixture.policyVersionId}::uuid)
        AS version_payload_hash,
      (SELECT count(*)::text FROM order_items
       WHERE store_id = ${fixture.storeId}::uuid AND id = ${fixture.orderItemId}::uuid)
        AS order_item_count,
      (SELECT count(*)::text FROM order_item_after_sale_policy_snapshots
       WHERE store_id = ${fixture.storeId}::uuid AND order_item_id = ${fixture.orderItemId}::uuid)
        AS snapshot_count,
      (SELECT payload FROM order_item_after_sale_policy_snapshots
       WHERE store_id = ${fixture.storeId}::uuid AND order_item_id = ${fixture.orderItemId}::uuid)
        AS snapshot_payload,
      (SELECT payload_hash FROM order_item_after_sale_policy_snapshots
       WHERE store_id = ${fixture.storeId}::uuid AND order_item_id = ${fixture.orderItemId}::uuid)
        AS snapshot_payload_hash,
      (SELECT count(*)::text FROM after_sales
       WHERE store_id = ${fixture.storeId}::uuid AND id = ${fixture.afterSaleId}::uuid)
        AS after_sale_count,
      (SELECT policy_snapshot FROM after_sales
       WHERE store_id = ${fixture.storeId}::uuid AND id = ${fixture.afterSaleId}::uuid)
        AS case_payload,
      (SELECT policy_hash FROM after_sales
       WHERE store_id = ${fixture.storeId}::uuid AND id = ${fixture.afterSaleId}::uuid)
        AS case_payload_hash
  `;
  if (
    !record ||
    record.policy_count !== '1' ||
    record.policy_version_count !== '1' ||
    record.order_item_count !== '1' ||
    record.snapshot_count !== '1' ||
    record.after_sale_count !== '1'
  ) {
    fail('M6.3-B3 historical policy preflight fixture is incomplete');
  }
  return createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

async function assertB3HistoricalPolicyPreflightFailure(
  client: PrismaClientType,
  databaseUrl: URL,
  schemaPath: string,
  migrationPath: string,
  fixture: B3HistoricalPolicyFixtureIds,
  context: string,
): Promise<void> {
  const fixtureFingerprintBefore = await b3HistoricalPolicyFixtureFingerprint(client, fixture);
  const migrationHistoryBefore = await migrationHistoryFingerprint(client);
  const migrationSql = await readFile(migrationPath, 'utf8');
  const preflightStart = migrationSql.indexOf('DO $m63_b3_policy_payload_preflight$');
  const preflightTerminator = '$m63_b3_policy_payload_preflight$;';
  const preflightEnd = migrationSql.indexOf(preflightTerminator, preflightStart);
  if (preflightStart < 0 || preflightEnd <= preflightStart) {
    fail('the M6.3-B3 historical policy preflight statement could not be isolated');
  }
  const preflightSql = migrationSql.slice(
    preflightStart,
    preflightEnd + preflightTerminator.length,
  );
  await expectSqlState(
    client.$executeRawUnsafe(preflightSql),
    '55000',
    `M6.3-B3 ${context} historical policy preflight`,
  );
  runPrismaExpectFailure(
    ['db', 'execute', '--file', migrationPath, '--schema', schemaPath],
    databaseUrl,
    'M6.3-B3 historical policy payload preflight failed',
  );
  const fixtureFingerprintAfter = await b3HistoricalPolicyFixtureFingerprint(client, fixture);
  const migrationHistoryAfter = await migrationHistoryFingerprint(client);
  if (fixtureFingerprintAfter !== fixtureFingerprintBefore) {
    fail(`M6.3-B3 ${context} preflight failure changed its historical fixture`);
  }
  if (migrationHistoryAfter !== migrationHistoryBefore) {
    fail(`M6.3-B3 ${context} preflight failure changed _prisma_migrations`);
  }
  await assertM63B3DownBoundary(client);
}

async function assertM63B2bD5ProtectedReadLock(client: PrismaClientType): Promise<void> {
  const records = await client.$queryRaw<
    Array<{
      authorization_function_exists: boolean;
      authorization_function_has_safe_configuration: boolean;
      authorization_function_has_post_lock_expiry_revalidation: boolean;
      authorization_function_is_security_definer: boolean;
      authorization_function_owner_is_guard: boolean;
      authorization_runtime_can_execute: boolean;
      authorization_public_cannot_execute: boolean;
      authorization_guard_auth_column_privileges_are_exact: boolean;
      authorization_auth_tables_are_forced_rls: boolean;
      authorization_guard_write_policies_are_exact: boolean;
      authorization_global_preserve_access_policies_are_exact: boolean;
      guard_evidence_column_privileges_are_exact: boolean;
      guard_has_no_role_relationships: boolean;
      guard_role_is_restricted: boolean;
      legacy_runtime_cannot_execute: boolean;
      protected_read_function_exists: boolean;
      protected_read_function_has_safe_configuration: boolean;
      protected_read_function_is_security_definer: boolean;
      protected_read_function_owner_is_guard: boolean;
      public_cannot_execute_protected_read_function: boolean;
      protected_read_lock_policies_are_exact: boolean;
    }>
  >`
    WITH guard_role AS (
      SELECT oid, rolbypassrls, rolcanlogin, rolinherit, rolsuper, rolcreatedb,
        rolcreaterole, rolreplication
      FROM pg_catalog.pg_roles
      WHERE rolname = 'zalo_shop_evidence_read_guard'
    ), legacy_function AS (
      SELECT function_definition.oid, function_definition.proacl,
        function_definition.proconfig, function_definition.proowner,
        function_definition.prosecdef
      FROM pg_catalog.pg_proc AS function_definition
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = function_definition.pronamespace
      WHERE namespace.nspname = 'app_security'
        AND function_definition.proname = 'lock_m63_b2b_protected_evidence_read'
        AND function_definition.proargtypes =
          ARRAY['uuid'::regtype, 'uuid'::regtype, 'timestamptz'::regtype]::oidvector
    ), authorization_function AS (
      SELECT function_definition.oid, function_definition.proacl,
        function_definition.proconfig, function_definition.proowner,
        function_definition.prosecdef,
        pg_catalog.pg_get_functiondef(function_definition.oid) AS definition
      FROM pg_catalog.pg_proc AS function_definition
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = function_definition.pronamespace
      WHERE namespace.nspname = 'app_security'
        AND function_definition.proname = 'lock_m63_b2b_protected_evidence_read_authorized'
        AND function_definition.proargtypes =
          ARRAY['uuid'::regtype, 'uuid'::regtype, 'timestamptz'::regtype]::oidvector
    ), evidence_guard_required_columns AS (
      SELECT * FROM (VALUES
        ('id', 'SELECT'),
        ('store_id', 'SELECT'),
        ('member_id', 'SELECT'),
        ('after_sale_id', 'SELECT'),
        ('object_key', 'SELECT'),
        ('status', 'SELECT'),
        ('legal_hold_active', 'SELECT'),
        ('ordinary_access_deadline_at', 'SELECT'),
        ('version', 'SELECT'),
        ('id', 'UPDATE')
      ) AS required_column(column_name, privilege_type)
    ), authorization_guard_required_columns AS (
      SELECT * FROM (VALUES
        ('stores', 'id', 'SELECT'),
        ('stores', 'status', 'SELECT'),
        ('members', 'id', 'SELECT'),
        ('members', 'store_id', 'SELECT'),
        ('members', 'status', 'SELECT'),
        ('admin_users', 'id', 'SELECT'),
        ('admin_users', 'status', 'SELECT'),
        ('member_sessions', 'id', 'SELECT'),
        ('member_sessions', 'store_id', 'SELECT'),
        ('member_sessions', 'member_id', 'SELECT'),
        ('member_sessions', 'expires_at', 'SELECT'),
        ('member_sessions', 'revoked_at', 'SELECT'),
        ('admin_sessions', 'id', 'SELECT'),
        ('admin_sessions', 'admin_user_id', 'SELECT'),
        ('admin_sessions', 'expires_at', 'SELECT'),
        ('admin_sessions', 'revoked_at', 'SELECT'),
        ('admin_store_roles', 'store_id', 'SELECT'),
        ('admin_store_roles', 'admin_user_id', 'SELECT'),
        ('admin_store_roles', 'role_id', 'SELECT'),
        ('store_role_permissions', 'store_id', 'SELECT'),
        ('store_role_permissions', 'role_id', 'SELECT'),
        ('store_role_permissions', 'permission_code', 'SELECT'),
        ('admin_platform_roles', 'admin_user_id', 'SELECT'),
        ('admin_platform_roles', 'platform_role_id', 'SELECT'),
        ('platform_role_permissions', 'platform_role_id', 'SELECT'),
        ('platform_role_permissions', 'permission_code', 'SELECT'),
        ('stores', 'id', 'UPDATE'),
        ('members', 'id', 'UPDATE'),
        ('admin_users', 'id', 'UPDATE'),
        ('member_sessions', 'id', 'UPDATE'),
        ('admin_sessions', 'id', 'UPDATE'),
        ('admin_store_roles', 'role_id', 'UPDATE'),
        ('store_role_permissions', 'permission_code', 'UPDATE'),
        ('admin_platform_roles', 'platform_role_id', 'UPDATE'),
        ('platform_role_permissions', 'permission_code', 'UPDATE')
      ) AS required_column(relname, column_name, privilege_type)
    ), authorization_tables AS (
      SELECT DISTINCT relname FROM authorization_guard_required_columns
    ), authorization_global_tables AS (
      SELECT unnest(ARRAY[
        'admin_users', 'admin_sessions', 'admin_platform_roles',
        'platform_role_permissions'
      ]) AS relname
    )
    SELECT
      (
        SELECT NOT rolcanlogin AND NOT rolinherit AND NOT rolbypassrls
          AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication
        FROM guard_role
      ) IS TRUE AS guard_role_is_restricted,
      NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_auth_members AS membership
        JOIN guard_role ON membership.roleid = guard_role.oid OR membership.member = guard_role.oid
      ) AS guard_has_no_role_relationships,
      EXISTS (SELECT 1 FROM legacy_function) AS protected_read_function_exists,
      (
        SELECT prosecdef
        FROM legacy_function
      ) IS TRUE AS protected_read_function_is_security_definer,
      (
        SELECT legacy_function.proowner = guard_role.oid
        FROM legacy_function CROSS JOIN guard_role
      ) IS TRUE AS protected_read_function_owner_is_guard,
      (
        SELECT
          'search_path=pg_catalog, public, pg_temp' = ANY(proconfig)
          AND 'row_security=on' = ANY(proconfig)
        FROM legacy_function
      ) IS TRUE AS protected_read_function_has_safe_configuration,
      NOT EXISTS (
        SELECT 1
        FROM legacy_function
        CROSS JOIN LATERAL aclexplode(
          COALESCE(legacy_function.proacl, acldefault('f', legacy_function.proowner))
        ) AS privilege
        WHERE privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'
      ) AS public_cannot_execute_protected_read_function,
      (
        SELECT NOT has_function_privilege('zalo_shop_runtime', legacy_function.oid, 'EXECUTE')
        FROM legacy_function
      ) IS TRUE AS legacy_runtime_cannot_execute,
      EXISTS (SELECT 1 FROM authorization_function) AS authorization_function_exists,
      (
        SELECT prosecdef
        FROM authorization_function
      ) IS TRUE AS authorization_function_is_security_definer,
      (
        SELECT authorization_function.proowner = guard_role.oid
        FROM authorization_function CROSS JOIN guard_role
      ) IS TRUE AS authorization_function_owner_is_guard,
      (
        SELECT
          'search_path=pg_catalog, public, pg_temp' = ANY(proconfig)
          AND 'row_security=on' = ANY(proconfig)
        FROM authorization_function
      ) IS TRUE AS authorization_function_has_safe_configuration,
      (
        SELECT
          pg_catalog.strpos(
            definition,
            'FROM app_security.lock_m63_b2b_protected_evidence_read('
          ) > 0
          AND pg_catalog.strpos(
            definition,
            'post_lock_now := pg_catalog.clock_timestamp();'
          ) > pg_catalog.strpos(
            definition,
            'FROM app_security.lock_m63_b2b_protected_evidence_read('
          )
          AND pg_catalog.strpos(
            definition,
            'post_lock_now >= caller_token_expires_at'
          ) > pg_catalog.strpos(
            definition,
            'FROM app_security.lock_m63_b2b_protected_evidence_read('
          )
          AND pg_catalog.strpos(
            definition,
            'post_lock_now >= locked_session_expires_at'
          ) > pg_catalog.strpos(
            definition,
            'FROM app_security.lock_m63_b2b_protected_evidence_read('
          )
          AND pg_catalog.strpos(
            definition,
            'post_lock_now + INTERVAL ''1 second'' >= target_url_expires_at'
          ) > pg_catalog.strpos(
            definition,
            'FROM app_security.lock_m63_b2b_protected_evidence_read('
          )
          AND pg_catalog.strpos(
            definition,
            'post_lock_now >= locked_evidence_ordinary_access_deadline_at'
          ) > pg_catalog.strpos(
            definition,
            'FROM app_security.lock_m63_b2b_protected_evidence_read('
          )
          AND pg_catalog.strpos(
            definition,
            'target_url_expires_at > caller_token_expires_at'
          ) > 0
          AND pg_catalog.strpos(
            definition,
            'target_url_expires_at > locked_session_expires_at'
          ) > 0
        FROM authorization_function
      ) IS TRUE AS authorization_function_has_post_lock_expiry_revalidation,
      NOT EXISTS (
        SELECT 1
        FROM authorization_function
        CROSS JOIN LATERAL aclexplode(
          COALESCE(authorization_function.proacl, acldefault('f', authorization_function.proowner))
        ) AS privilege
        WHERE privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'
      ) AS authorization_public_cannot_execute,
      (
        SELECT has_function_privilege('zalo_shop_runtime', authorization_function.oid, 'EXECUTE')
        FROM authorization_function
      ) IS TRUE AS authorization_runtime_can_execute,
      (
        SELECT count(*) = 35
          AND bool_and(
            has_column_privilege(
              'zalo_shop_evidence_read_guard',
              'public.' || required_column.relname,
              required_column.column_name,
              required_column.privilege_type
            )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM pg_catalog.pg_class AS class
            JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = class.relnamespace
            JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid = class.oid
            WHERE namespace.nspname = 'public'
              AND class.relname IN (SELECT relname FROM authorization_tables)
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped
              AND (
                has_column_privilege(
                  'zalo_shop_evidence_read_guard', class.oid, attribute.attname, 'SELECT'
                )
                OR has_column_privilege(
                  'zalo_shop_evidence_read_guard', class.oid, attribute.attname, 'UPDATE'
                )
              )
              AND EXISTS (
                SELECT 1
                FROM (VALUES ('SELECT'), ('UPDATE')) AS effective_privilege(privilege_type)
                WHERE has_column_privilege(
                  'zalo_shop_evidence_read_guard',
                  class.oid,
                  attribute.attname,
                  effective_privilege.privilege_type
                )
                  AND NOT EXISTS (
                    SELECT 1
                    FROM authorization_guard_required_columns AS required_column
                    WHERE required_column.relname = class.relname
                      AND required_column.column_name = attribute.attname
                      AND required_column.privilege_type = effective_privilege.privilege_type
                  )
              )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM authorization_tables
            WHERE has_table_privilege(
              'zalo_shop_evidence_read_guard', 'public.' || authorization_tables.relname, 'SELECT'
            )
              OR has_table_privilege(
                'zalo_shop_evidence_read_guard', 'public.' || authorization_tables.relname, 'UPDATE'
              )
          )
        FROM authorization_guard_required_columns AS required_column
      ) IS TRUE AS authorization_guard_auth_column_privileges_are_exact,
      (
        SELECT count(*) = 9 AND bool_and(class.relrowsecurity AND class.relforcerowsecurity)
        FROM pg_catalog.pg_class AS class
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = class.relnamespace
        WHERE namespace.nspname = 'public'
          AND class.relname IN (SELECT relname FROM authorization_tables)
      ) IS TRUE AS authorization_auth_tables_are_forced_rls,
      (
        SELECT count(*) = 9
          AND bool_and(
            policy_definition.polcmd = 'w'
            AND policy_definition.polroles = ARRAY[guard_role.oid]::oid[]
            AND NOT policy_definition.polpermissive
            AND pg_catalog.pg_get_expr(
              policy_definition.polwithcheck, policy_definition.polrelid
            ) = 'false'
          )
        FROM pg_catalog.pg_policy AS policy_definition
        CROSS JOIN guard_role
        JOIN pg_catalog.pg_class AS relation ON relation.oid = policy_definition.polrelid
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname IN (SELECT relname FROM authorization_tables)
          AND policy_definition.polname = relation.relname || '_m63_d5_guard_no_write'
      ) IS TRUE AS authorization_guard_write_policies_are_exact,
      (
        SELECT count(*) = 4
          AND bool_and(
            policy_definition.polcmd = '*'
            AND policy_definition.polroles = ARRAY[0]::oid[]
            AND policy_definition.polpermissive
            AND pg_catalog.pg_get_expr(
              policy_definition.polqual, policy_definition.polrelid
            ) = 'true'
            AND pg_catalog.pg_get_expr(
              policy_definition.polwithcheck, policy_definition.polrelid
            ) = 'true'
          )
        FROM pg_catalog.pg_policy AS policy_definition
        JOIN pg_catalog.pg_class AS relation ON relation.oid = policy_definition.polrelid
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname IN (SELECT relname FROM authorization_global_tables)
          AND policy_definition.polname = relation.relname || '_m63_d5_preserve_access'
      ) IS TRUE AS authorization_global_preserve_access_policies_are_exact,
      (
        SELECT count(*) = 10
          AND bool_and(
            has_column_privilege(
              'zalo_shop_evidence_read_guard',
              'public.after_sale_evidence_files',
              required_column.column_name,
              required_column.privilege_type
            )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM pg_catalog.pg_attribute AS attribute
            CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES'))
              AS effective_privilege(privilege_type)
            WHERE attribute.attrelid = 'public.after_sale_evidence_files'::regclass
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped
              AND has_column_privilege(
                'zalo_shop_evidence_read_guard',
                attribute.attrelid,
                attribute.attname,
                effective_privilege.privilege_type
              )
              AND NOT EXISTS (
                SELECT 1
                FROM evidence_guard_required_columns AS expected_privilege
                WHERE expected_privilege.column_name = attribute.attname
                  AND expected_privilege.privilege_type = effective_privilege.privilege_type
              )
          )
          AND NOT has_table_privilege(
            'zalo_shop_evidence_read_guard', 'public.after_sale_evidence_files', 'SELECT'
          )
          AND NOT has_table_privilege(
            'zalo_shop_evidence_read_guard', 'public.after_sale_evidence_files', 'INSERT'
          )
          AND NOT has_table_privilege(
            'zalo_shop_evidence_read_guard', 'public.after_sale_evidence_files', 'UPDATE'
          )
          AND NOT has_table_privilege(
            'zalo_shop_evidence_read_guard', 'public.after_sale_evidence_files', 'DELETE'
          )
          AND NOT has_table_privilege(
            'zalo_shop_evidence_read_guard', 'public.after_sale_evidence_files', 'TRUNCATE'
          )
          AND NOT has_table_privilege(
            'zalo_shop_evidence_read_guard', 'public.after_sale_evidence_files', 'REFERENCES'
          )
          AND NOT has_table_privilege(
            'zalo_shop_evidence_read_guard', 'public.after_sale_evidence_files', 'TRIGGER'
          )
        FROM evidence_guard_required_columns AS required_column
      ) IS TRUE AS guard_evidence_column_privileges_are_exact,
      (
        SELECT count(*) = 2
          AND bool_and(
            policy_definition.polcmd = 'w'
            AND policy_definition.polroles = ARRAY[guard_role.oid]::oid[]
            AND pg_catalog.pg_get_expr(
              policy_definition.polwithcheck, policy_definition.polrelid
            ) = 'false'
          )
          AND bool_or(
            policy_definition.polname = 'after_sale_evidence_files_protected_read_lock_guard'
            AND policy_definition.polpermissive
          )
          AND bool_or(
            policy_definition.polname = 'after_sale_evidence_files_protected_read_lock_guard_no_write'
            AND NOT policy_definition.polpermissive
          )
        FROM pg_catalog.pg_policy AS policy_definition
        CROSS JOIN guard_role
        JOIN pg_catalog.pg_class AS relation ON relation.oid = policy_definition.polrelid
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname = 'after_sale_evidence_files'
          AND policy_definition.polname IN (
            'after_sale_evidence_files_protected_read_lock_guard',
            'after_sale_evidence_files_protected_read_lock_guard_no_write'
        )
      ) IS TRUE AS protected_read_lock_policies_are_exact
  `;
  const record = records[0];
  if (
    records.length !== 1 ||
    !record ||
    !record.guard_role_is_restricted ||
    !record.guard_has_no_role_relationships ||
    !record.protected_read_function_exists ||
    !record.protected_read_function_is_security_definer ||
    !record.protected_read_function_owner_is_guard ||
    !record.protected_read_function_has_safe_configuration ||
    !record.public_cannot_execute_protected_read_function ||
    !record.legacy_runtime_cannot_execute ||
    !record.authorization_function_exists ||
    !record.authorization_function_is_security_definer ||
    !record.authorization_function_owner_is_guard ||
    !record.authorization_function_has_safe_configuration ||
    !record.authorization_function_has_post_lock_expiry_revalidation ||
    !record.authorization_public_cannot_execute ||
    !record.authorization_runtime_can_execute ||
    !record.authorization_guard_auth_column_privileges_are_exact ||
    !record.authorization_auth_tables_are_forced_rls ||
    !record.authorization_guard_write_policies_are_exact ||
    !record.authorization_global_preserve_access_policies_are_exact ||
    !record.guard_evidence_column_privileges_are_exact ||
    !record.protected_read_lock_policies_are_exact
  ) {
    fail(
      `M6.3-B2b-D5 protected-read lock metadata differs from the approved boundary: ${JSON.stringify(record ?? null)}`,
    );
  }
}

async function d5SecurityCatalogFingerprint(client: PrismaClientType): Promise<string> {
  const records = await client.$queryRaw<Array<{ catalog_state: string }>>`
    WITH guard_role AS (
      SELECT oid, rolname, rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole,
        rolreplication, rolbypassrls, rolconnlimit, rolvaliduntil, rolconfig
      FROM pg_catalog.pg_roles
      WHERE rolname = 'zalo_shop_evidence_read_guard'
    ), d5_functions AS (
      SELECT namespace.nspname AS schema_name,
        function_definition.proname AS function_name,
        pg_catalog.pg_get_function_identity_arguments(function_definition.oid)
          AS identity_arguments,
        owner_role.rolname AS owner_name,
        function_definition.prosecdef AS security_definer,
        function_definition.proleakproof AS leakproof,
        function_definition.provolatile AS volatility,
        function_definition.proparallel AS parallel_safety,
        function_definition.proconfig AS configuration,
        pg_catalog.pg_get_functiondef(function_definition.oid) AS definition
      FROM pg_catalog.pg_proc AS function_definition
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = function_definition.pronamespace
      JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = function_definition.proowner
      WHERE namespace.nspname = 'app_security'
        AND function_definition.proname IN (
          'lock_m63_b2b_protected_evidence_read',
          'lock_m63_b2b_protected_evidence_read_authorized'
        )
    ), d5_function_acl AS (
      SELECT namespace.nspname AS schema_name,
        function_definition.proname AS function_name,
        pg_catalog.pg_get_function_identity_arguments(function_definition.oid)
          AS identity_arguments,
        CASE WHEN privilege.grantee = 0 THEN 'PUBLIC' ELSE grantee_role.rolname END AS grantee,
        grantor_role.rolname AS grantor,
        privilege.privilege_type,
        privilege.is_grantable
      FROM pg_catalog.pg_proc AS function_definition
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = function_definition.pronamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_definition.proacl,
          pg_catalog.acldefault('f', function_definition.proowner)
        )
      ) AS privilege
      LEFT JOIN pg_catalog.pg_roles AS grantee_role ON grantee_role.oid = privilege.grantee
      LEFT JOIN pg_catalog.pg_roles AS grantor_role ON grantor_role.oid = privilege.grantor
      WHERE namespace.nspname = 'app_security'
        AND function_definition.proname IN (
          'lock_m63_b2b_protected_evidence_read',
          'lock_m63_b2b_protected_evidence_read_authorized'
        )
    ), relevant_relations AS (
      SELECT relation.oid, namespace.nspname AS schema_name, relation.relname,
        relation.relrowsecurity, relation.relforcerowsecurity
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname IN (
          'after_sale_evidence_files', 'stores', 'members', 'admin_users',
          'member_sessions', 'admin_sessions', 'admin_store_roles',
          'store_role_permissions', 'admin_platform_roles', 'platform_role_permissions'
        )
    ), relevant_policies AS (
      SELECT relation.schema_name, relation.relname,
        policy_definition.polname AS policy_name,
        policy_definition.polcmd AS command,
        policy_definition.polpermissive AS permissive,
        ARRAY(
          SELECT CASE WHEN policy_role.role_oid = 0 THEN 'PUBLIC' ELSE role.rolname END
          FROM pg_catalog.unnest(policy_definition.polroles) AS policy_role(role_oid)
          LEFT JOIN pg_catalog.pg_roles AS role ON role.oid = policy_role.role_oid
          ORDER BY 1
        ) AS roles,
        pg_catalog.pg_get_expr(policy_definition.polqual, policy_definition.polrelid)
          AS using_expression,
        pg_catalog.pg_get_expr(policy_definition.polwithcheck, policy_definition.polrelid)
          AS check_expression
      FROM pg_catalog.pg_policy AS policy_definition
      JOIN relevant_relations AS relation ON relation.oid = policy_definition.polrelid
    ), guard_relation_acl AS (
      SELECT namespace.nspname AS schema_name, relation.relname, relation.relkind,
        grantor_role.rolname AS grantor, privilege.privilege_type, privilege.is_grantable
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN guard_role
      CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS privilege
      LEFT JOIN pg_catalog.pg_roles AS grantor_role ON grantor_role.oid = privilege.grantor
      WHERE privilege.grantee = guard_role.oid
    ), guard_column_acl AS (
      SELECT namespace.nspname AS schema_name, relation.relname,
        attribute.attname AS column_name, grantor_role.rolname AS grantor,
        privilege.privilege_type, privilege.is_grantable
      FROM pg_catalog.pg_attribute AS attribute
      JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN guard_role
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
      LEFT JOIN pg_catalog.pg_roles AS grantor_role ON grantor_role.oid = privilege.grantor
      WHERE attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND privilege.grantee = guard_role.oid
    ), guard_schema_acl AS (
      SELECT namespace.nspname AS schema_name, grantor_role.rolname AS grantor,
        privilege.privilege_type, privilege.is_grantable
      FROM pg_catalog.pg_namespace AS namespace
      CROSS JOIN guard_role
      CROSS JOIN LATERAL pg_catalog.aclexplode(namespace.nspacl) AS privilege
      LEFT JOIN pg_catalog.pg_roles AS grantor_role ON grantor_role.oid = privilege.grantor
      WHERE privilege.grantee = guard_role.oid
    ), guard_type_acl AS (
      SELECT namespace.nspname AS schema_name, type_definition.typname AS type_name,
        grantor_role.rolname AS grantor, privilege.privilege_type, privilege.is_grantable
      FROM pg_catalog.pg_type AS type_definition
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = type_definition.typnamespace
      CROSS JOIN guard_role
      CROSS JOIN LATERAL pg_catalog.aclexplode(type_definition.typacl) AS privilege
      LEFT JOIN pg_catalog.pg_roles AS grantor_role ON grantor_role.oid = privilege.grantor
      WHERE privilege.grantee = guard_role.oid
    ), guard_memberships AS (
      SELECT granted_role.rolname AS granted_role, member_role.rolname AS member_role,
        grantor_role.rolname AS grantor, membership.admin_option,
        membership.inherit_option, membership.set_option
      FROM pg_catalog.pg_auth_members AS membership
      JOIN pg_catalog.pg_roles AS granted_role ON granted_role.oid = membership.roleid
      JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = membership.member
      LEFT JOIN pg_catalog.pg_roles AS grantor_role ON grantor_role.oid = membership.grantor
      CROSS JOIN guard_role
      WHERE membership.roleid = guard_role.oid OR membership.member = guard_role.oid
    )
    SELECT pg_catalog.jsonb_build_object(
      'role', COALESCE(
        (SELECT pg_catalog.to_jsonb(role_record) FROM guard_role AS role_record),
        'null'::jsonb
      ),
      'memberships', COALESCE(
        (SELECT pg_catalog.jsonb_agg(
          pg_catalog.to_jsonb(membership_record)
          ORDER BY membership_record.granted_role, membership_record.member_role
        ) FROM guard_memberships AS membership_record),
        '[]'::jsonb
      ),
      'functions', COALESCE(
        (SELECT pg_catalog.jsonb_agg(
          pg_catalog.to_jsonb(function_record)
          ORDER BY function_record.schema_name, function_record.function_name,
            function_record.identity_arguments
        ) FROM d5_functions AS function_record),
        '[]'::jsonb
      ),
      'function_acl', COALESCE(
        (SELECT pg_catalog.jsonb_agg(
          pg_catalog.to_jsonb(acl_record)
          ORDER BY acl_record.schema_name, acl_record.function_name,
            acl_record.identity_arguments, acl_record.grantee, acl_record.privilege_type
        ) FROM d5_function_acl AS acl_record),
        '[]'::jsonb
      ),
      'relation_security', COALESCE(
        (SELECT pg_catalog.jsonb_agg(
          pg_catalog.to_jsonb(relation_record)
          ORDER BY relation_record.schema_name, relation_record.relname
        ) FROM relevant_relations AS relation_record),
        '[]'::jsonb
      ),
      'policies', COALESCE(
        (SELECT pg_catalog.jsonb_agg(
          pg_catalog.to_jsonb(policy_record)
          ORDER BY policy_record.schema_name, policy_record.relname, policy_record.policy_name
        ) FROM relevant_policies AS policy_record),
        '[]'::jsonb
      ),
      'guard_relation_acl', COALESCE(
        (SELECT pg_catalog.jsonb_agg(
          pg_catalog.to_jsonb(acl_record)
          ORDER BY acl_record.schema_name, acl_record.relname, acl_record.privilege_type
        ) FROM guard_relation_acl AS acl_record),
        '[]'::jsonb
      ),
      'guard_column_acl', COALESCE(
        (SELECT pg_catalog.jsonb_agg(
          pg_catalog.to_jsonb(acl_record)
          ORDER BY acl_record.schema_name, acl_record.relname, acl_record.column_name,
            acl_record.privilege_type
        ) FROM guard_column_acl AS acl_record),
        '[]'::jsonb
      ),
      'guard_schema_acl', COALESCE(
        (SELECT pg_catalog.jsonb_agg(
          pg_catalog.to_jsonb(acl_record)
          ORDER BY acl_record.schema_name, acl_record.privilege_type
        ) FROM guard_schema_acl AS acl_record),
        '[]'::jsonb
      ),
      'guard_type_acl', COALESCE(
        (SELECT pg_catalog.jsonb_agg(
          pg_catalog.to_jsonb(acl_record)
          ORDER BY acl_record.schema_name, acl_record.type_name, acl_record.privilege_type
        ) FROM guard_type_acl AS acl_record),
        '[]'::jsonb
      )
    )::text AS catalog_state
  `;
  const state = records[0]?.catalog_state;
  if (records.length !== 1 || !state) {
    fail('could not fingerprint the M6.3-B2b-D5 security catalog');
  }
  return createHash('sha256').update(state).digest('hex');
}

async function exerciseD5MigrationAtomicity(
  client: PrismaClientType,
  scratchDatabaseUrl: URL,
  schemaPath: string,
  tempDirectory: string,
): Promise<void> {
  await assertSafeTemporaryDirectory(tempDirectory);
  const fullyDeployedFingerprint = await d5SecurityCatalogFingerprint(client);

  for (const migrationName of [...D5_MIGRATIONS].reverse()) {
    runPrisma(
      [
        'db',
        'execute',
        '--file',
        join(MIGRATIONS_ROOT, migrationName, 'down.sql'),
        '--schema',
        schemaPath,
      ],
      scratchDatabaseUrl,
    );
  }
  const fullyReversedFingerprint = await d5SecurityCatalogFingerprint(client);
  if (fullyReversedFingerprint === fullyDeployedFingerprint) {
    fail('M6.3-B2b-D5 reverse exercise did not change the security catalog');
  }

  await client.$executeRaw`
    GRANT SELECT (checksum_sha256)
    ON public.after_sale_evidence_files
    TO zalo_shop_evidence_read_guard
  `;
  const unexpectedGuardPrivilegeFingerprint = await d5SecurityCatalogFingerprint(client);
  if (unexpectedGuardPrivilegeFingerprint === fullyReversedFingerprint) {
    fail('M6.3-B2b-D5 guard privilege injection did not change the security catalog');
  }
  runPrismaExpectFailure(
    [
      'db',
      'execute',
      '--file',
      join(MIGRATIONS_ROOT, D5_MIGRATIONS[0], 'migration.sql'),
      '--schema',
      schemaPath,
    ],
    scratchDatabaseUrl,
    'M6.3-B2b-D5 evidence read guard role has unexpected current-database privileges or ownership',
  );
  const afterUnexpectedGuardPrivilegeFailureFingerprint =
    await d5SecurityCatalogFingerprint(client);
  if (afterUnexpectedGuardPrivilegeFailureFingerprint !== unexpectedGuardPrivilegeFingerprint) {
    fail('M6.3-B2b-D5 guard privilege fail-fast changed the security catalog');
  }
  await client.$executeRaw`
    REVOKE SELECT (checksum_sha256)
    ON public.after_sale_evidence_files
    FROM zalo_shop_evidence_read_guard
  `;
  const afterUnexpectedGuardPrivilegeCleanupFingerprint =
    await d5SecurityCatalogFingerprint(client);
  if (afterUnexpectedGuardPrivilegeCleanupFingerprint !== fullyReversedFingerprint) {
    fail('M6.3-B2b-D5 guard privilege fail-fast cleanup did not restore the security catalog');
  }

  for (const migrationName of D5_MIGRATIONS) {
    const beforeFailureFingerprint = await d5SecurityCatalogFingerprint(client);
    const migrationSql = await readFile(
      join(MIGRATIONS_ROOT, migrationName, 'migration.sql'),
      'utf8',
    );
    const injectedPath = join(tempDirectory, `d5-atomicity-${migrationName}.sql`);
    assertPathWithin(tempDirectory, injectedPath);
    await writeFile(injectedPath, injectD5PreCommitFailure(migrationSql, migrationName), {
      encoding: 'utf8',
      flag: 'wx',
    });
    runPrismaExpectFailure(
      ['db', 'execute', '--file', injectedPath, '--schema', schemaPath],
      scratchDatabaseUrl,
      'M6.3-B2b-D5 injected pre-commit failure',
    );
    const afterFailureFingerprint = await d5SecurityCatalogFingerprint(client);
    if (afterFailureFingerprint !== beforeFailureFingerprint) {
      fail(`M6.3-B2b-D5 failed migration changed the security catalog: ${migrationName}`);
    }
    runPrisma(
      [
        'db',
        'execute',
        '--file',
        join(MIGRATIONS_ROOT, migrationName, 'migration.sql'),
        '--schema',
        schemaPath,
      ],
      scratchDatabaseUrl,
    );
  }

  await assertM63B2bD5ProtectedReadLock(client);
  const restoredFingerprint = await d5SecurityCatalogFingerprint(client);
  if (restoredFingerprint !== fullyDeployedFingerprint) {
    fail('M6.3-B2b-D5 down/injected-failure/up exercise did not restore the security catalog');
  }
}

async function preflightOwner(client: PrismaClientType): Promise<void> {
  const records = await client.$queryRawUnsafe<OwnerPreflightRecord[]>(`
    SELECT
      current_database() AS database_name,
      current_user AS user_name,
      current_setting('server_version_num')::integer AS server_version_num,
      COALESCE((SELECT rolsuper OR rolcreatedb FROM pg_roles WHERE rolname = current_user), false)
        AS can_create_database,
      COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false)
        AS is_superuser,
      EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zalo_shop_runtime') AS runtime_role_exists
  `);
  const record = records[0];
  if (!record) fail('could not inspect the local PostgreSQL owner connection');
  if (record.database_name !== 'postgres' || record.user_name !== 'zalo_shop') {
    fail('owner preflight connected to an unexpected database or user');
  }
  if (record.server_version_num < 170_000) {
    fail('PostgreSQL 17 or newer is required');
  }
  if (!record.can_create_database || !record.runtime_role_exists || !record.is_superuser) {
    fail(
      'local migration owner must be a PostgreSQL superuser because D5 transfers a definer function to an isolated no-membership guard role',
    );
  }
}

async function assertScratchConnection(
  client: PrismaClientType,
  databaseName: string,
): Promise<void> {
  const records = await client.$queryRawUnsafe<DatabaseNameRecord[]>(
    'SELECT current_database() AS database_name',
  );
  if (records[0]?.database_name !== databaseName) {
    fail('scratch client connected to an unexpected database');
  }
}

async function scratchDatabaseCatalog(
  client: PrismaClientType,
  databaseName: string,
): Promise<DatabaseCatalogRecord[]> {
  validateScratchDatabaseName(databaseName);
  const records = await client.$queryRawUnsafe<DatabaseCatalogRecord[]>(`
    SELECT database.datname AS database_name, owner.rolname AS owner_name
    FROM pg_database AS database
    JOIN pg_roles AS owner ON owner.oid = database.datdba
    WHERE database.datname = '${databaseName}'
  `);
  if (records.length > 1 || (records[0] && records[0].database_name !== databaseName)) {
    fail('scratch database catalog lookup returned an unexpected target');
  }
  return records;
}

async function dropScratchDatabase(client: PrismaClientType, databaseName: string): Promise<void> {
  validateScratchDatabaseName(databaseName);
  const existing = await scratchDatabaseCatalog(client, databaseName);
  if (existing.length === 0) return;
  if (existing[0]?.owner_name !== 'zalo_shop') {
    fail('refusing to remove a scratch-name database owned by another role');
  }
  await client.$executeRawUnsafe(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${databaseName}' AND pid <> pg_backend_pid()`,
  );
  validateScratchDatabaseName(databaseName);
  await client.$executeRawUnsafe(`DROP DATABASE "${databaseName}"`);
}

async function run(): Promise<void> {
  const allMigrationNames = await migrationDirectories();
  await assertD5MigrationTransactionBoundaries();
  const ownerDatabaseUrl = validateOwnerUrl();
  if (M2_MIGRATIONS.some((migrationName, index) => allMigrationNames[index] !== migrationName)) {
    fail('the tracked migration prefix no longer matches the approved M2 boundary');
  }
  if (allMigrationNames.at(-1) !== P0_M6_008_MIGRATION_NAME) {
    fail('the approved P0-M6-008 return inspection migration must be the current tail');
  }
  const p0M6007BoundaryMigrationNames = allMigrationNames.slice(0, -2);
  const p0M6008BoundaryMigrationNames = allMigrationNames.slice(0, -1);
  const m5BoundaryIndex = allMigrationNames.indexOf(M5_MIGRATIONS.at(-1) ?? '');
  if (m5BoundaryIndex < 0) fail('the approved M5 boundary migration was not found');
  const m5BoundaryMigrationNames = allMigrationNames.slice(0, m5BoundaryIndex + 1);
  const d0MigrationName = '20260729120000_m63_b2b_d0_evidence_lifecycle';
  const d0BoundaryIndex = allMigrationNames.indexOf(d0MigrationName);
  if (
    d0BoundaryIndex < 1 ||
    allMigrationNames[d0BoundaryIndex - 1] !== '20260729100000_m63_b2a_policy_control_plane'
  ) {
    fail('the approved M6.3-B2a to B2b-D0 migration boundary was not found');
  }
  const m63B2aBoundaryMigrationNames = allMigrationNames.slice(0, d0BoundaryIndex);
  const b3MigrationIndex = allMigrationNames.indexOf(B3_MIGRATION_NAME);
  const b3BoundaryMigrationNames = allMigrationNames.slice(0, b3MigrationIndex);
  if (b3BoundaryMigrationNames.at(-1) !== D5_MIGRATIONS.at(-1)) {
    fail('the approved M6.3-B2b-D5 to B3 migration boundary was not found');
  }
  if (
    b3MigrationIndex < 0 ||
    allMigrationNames[b3MigrationIndex + 1] !== B4_MIGRATIONS[0] ||
    allMigrationNames[b3MigrationIndex + 2] !== B4_MIGRATIONS[1] ||
    allMigrationNames[b3MigrationIndex + 3] !== B5_MIGRATION_NAME ||
    allMigrationNames[b3MigrationIndex + 4] !== P0_M5_005_MIGRATION_NAME ||
    allMigrationNames[b3MigrationIndex + 5] !== P0_M5_005_COD_MIGRATION_NAME ||
    allMigrationNames[b3MigrationIndex + 6] !== P0_M5_005_CLOSURE_MIGRATION_NAME ||
    allMigrationNames[b3MigrationIndex + 7] !== P0_M6_007_MIGRATION_NAME ||
    allMigrationNames[b3MigrationIndex + 8] !== P0_M6_008_MIGRATION_NAME
  ) {
    fail('the approved M6.3-B3 to M6.4 migration boundary was not found');
  }

  const adminDatabaseUrl = new URL(ownerDatabaseUrl);
  adminDatabaseUrl.pathname = '/postgres';
  const scratchDatabaseName = `zalo_shop_m2_upgrade_${randomBytes(6).toString('hex')}`;
  validateScratchDatabaseName(scratchDatabaseName);
  const scratchDatabaseUrl = new URL(ownerDatabaseUrl);
  scratchDatabaseUrl.pathname = `/${scratchDatabaseName}`;

  const adminClient = new PrismaClient({ datasourceUrl: adminDatabaseUrl.toString() });
  let scratchClient: PrismaClientType | undefined;
  let tempDirectory: string | undefined;
  let scratchCreateAttempted = false;
  let scratchNameCollision = false;
  let primaryError: Error | undefined;
  const cleanupErrors: Error[] = [];

  try {
    await adminClient.$connect();
    await preflightOwner(adminClient);
    if ((await scratchDatabaseCatalog(adminClient, scratchDatabaseName)).length !== 0) {
      fail('generated scratch database name already exists; refusing to create or remove it');
    }

    await mkdir(TMP_ROOT, { recursive: true });
    tempDirectory = await mkdtemp(join(TMP_ROOT, 'm2-upgrade-'));
    assertPathWithin(TMP_ROOT, tempDirectory);
    await assertSafeTemporaryDirectory(tempDirectory);
    const m2SchemaPath = await createMigrationTree(tempDirectory, 'm2-boundary', M2_MIGRATIONS);
    const m5SchemaPath = await createMigrationTree(
      tempDirectory,
      'm5-boundary',
      m5BoundaryMigrationNames,
    );
    const m63B2aSchemaPath = await createMigrationTree(
      tempDirectory,
      'm63-b2a-boundary',
      m63B2aBoundaryMigrationNames,
    );
    const b3BoundarySchemaPath = await createMigrationTree(
      tempDirectory,
      'm63-b3-boundary',
      b3BoundaryMigrationNames,
    );
    const p0M6007BoundarySchemaPath = await createMigrationTree(
      tempDirectory,
      'p0-m6-007-boundary',
      p0M6007BoundaryMigrationNames,
    );
    const p0M6008BoundarySchemaPath = await createMigrationTree(
      tempDirectory,
      'p0-m6-008-boundary',
      p0M6008BoundaryMigrationNames,
    );

    validateScratchDatabaseName(scratchDatabaseName);
    scratchCreateAttempted = true;
    try {
      await adminClient.$executeRawUnsafe(`CREATE DATABASE "${scratchDatabaseName}"`);
    } catch (error) {
      scratchNameCollision = isDatabaseAlreadyExistsError(error);
      throw error;
    }
    console.log(`[m2-upgrade] created isolated scratch database ${scratchDatabaseName}`);

    runPrisma(['migrate', 'deploy', '--schema', m2SchemaPath], scratchDatabaseUrl);
    scratchClient = new PrismaClient({ datasourceUrl: scratchDatabaseUrl.toString() });
    await scratchClient.$connect();
    await assertScratchConnection(scratchClient, scratchDatabaseName);
    await assertMigrationState(scratchClient, M2_MIGRATIONS);

    runPrisma(
      ['db', 'execute', '--file', FIXTURE_SQL_PATH, '--schema', m2SchemaPath],
      scratchDatabaseUrl,
    );
    const fingerprintSql = await readFile(FINGERPRINT_SQL_PATH, 'utf8');
    const beforeUpgradeFingerprint = await fixtureFingerprint(scratchClient, fingerprintSql);

    runPrisma(['migrate', 'deploy', '--schema', m5SchemaPath], scratchDatabaseUrl);
    await assertMigrationState(scratchClient, m5BoundaryMigrationNames);
    const m5HistoricalFacts = await scratchClient.$transaction(async (transaction) => {
      const storeId = 'f2000000-0000-4000-8000-000000000001';
      await transaction.$executeRaw`
        SELECT set_config('app.store_id', ${storeId}, true)
      `;
      const admin = await transaction.adminUser.create({
        data: {
          displayName: 'M5 upgrade fixture admin',
          email: 'm5-upgrade-fixture@example.test',
          emailNormalized: 'm5-upgrade-fixture@example.test',
          id: 'f2030000-0000-4000-8000-000000000099',
          passwordHash: 'test-fixture-not-used',
        },
      });
      const order = await transaction.order.create({
        data: {
          baseSubtotalVnd: 100_000,
          couponDiscountVnd: 0,
          currency: 'VND',
          itemDiscountVnd: 0,
          memberId: 'f2020000-0000-4000-8000-000000000001',
          orderDiscountVnd: 0,
          orderNumber: 'M5-UPGRADE-HISTORY',
          payableVnd: 100_000,
          paymentMethod: 'ONLINE',
          paymentStatus: 'SUCCEEDED',
          quoteHash: createHash('sha256').update('m5-upgrade-history-quote').digest('hex'),
          remoteSurchargeVnd: 0,
          shippingDiscountVnd: 0,
          shippingFeeVnd: 0,
          status: 'PENDING_FULFILLMENT',
          storeId,
        },
      });
      const warehouse = await transaction.warehouse.create({
        data: { code: 'm5-upgrade-history', enabled: true, storeId },
      });
      await transaction.$executeRaw`
        INSERT INTO store_zalo_apps (
          store_id, environment, mini_app_id, enabled, created_at, updated_at
        ) VALUES (${storeId}::uuid, 'TEST', 'm5-upgrade-history-app', false, now(), now())
      `;
      await transaction.$executeRaw`
        INSERT INTO store_payment_channels (
          store_id, deployment_environment, provider_environment, provider_code,
          method_code, checkout_app_id, merchant_reference, private_key_secret_ref,
          secret_fingerprint, key_version, status, payment_window_seconds, updated_at
        ) VALUES (
          ${storeId}::uuid, 'TEST', 'SANDBOX', 'ZALO_CHECKOUT_ZALOPAY',
          'ZALOPAY_SANDBOX', 'm5-upgrade-history-app', 'm5-upgrade-history',
          'test://m5-upgrade-history/private-key', ${'a'.repeat(64)}, 'test-v1',
          'DISABLED', 900, now()
        )
      `;
      await transaction.$executeRaw`
        INSERT INTO store_shipping_channels (
          store_id, provider_environment, provider_code, shop_id, token_secret_ref,
          secret_fingerprint, key_version, status, origin_allowlist_key, updated_at
        ) VALUES (
          ${storeId}::uuid, 'SANDBOX', 'GHN', 'm5-upgrade-history-shop',
          'test://m5-upgrade-history/token', ${'b'.repeat(64)}, 'test-v1',
          'DISABLED', 'GHN_SANDBOX', now()
        )
      `;
      const paymentChannel = await transaction.storePaymentChannel.findFirstOrThrow({
        where: { checkoutAppId: 'm5-upgrade-history-app' },
      });
      const shippingChannel = await transaction.storeShippingChannel.findFirstOrThrow({
        where: { shopId: 'm5-upgrade-history-shop' },
      });
      const payment = await transaction.paymentAttempt.create({
        data: {
          amountVnd: 100_000,
          attemptSequence: 1,
          channelId: paymentChannel.id,
          correlationId: 'm5-upgrade-history-payment',
          createIdempotencyKeyHash: createHash('sha256')
            .update('m5-upgrade-history-payment-key')
            .digest('hex'),
          expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
          orderId: order.id,
          providerOrderId: 'm5-upgrade-history-provider-order',
          providerTransactionId: 'm5-upgrade-history-provider-transaction',
          publicPaymentNumber: 'PAY-M5-UPGRADE-HISTORY',
          status: 'SUCCEEDED',
          storeId,
          succeededAt: new Date(),
        },
      });
      const refund = await transaction.refund.create({
        data: {
          amountVnd: 20_000,
          idempotencyKeyHash: createHash('sha256')
            .update('m5-upgrade-history-refund-key')
            .digest('hex'),
          orderId: order.id,
          paymentAttemptId: payment.id,
          publicRefundNumber: 'RFD-M5-UPGRADE-HISTORY',
          reason: 'Preserve a real M5 refund while upgrading to M6',
          requestedBy: admin.id,
          status: 'REQUESTED',
          storeId,
        },
      });
      const shipmentId = randomUUID();
      await transaction.$executeRaw`
        INSERT INTO shipments (
          id, store_id, order_id, warehouse_id, channel_id, public_shipment_number,
          status, client_order_code, service_code, cod_amount_vnd,
          address_snapshot_ciphertext, parcel_snapshot, updated_at
        ) VALUES (
          ${shipmentId}::uuid, ${storeId}::uuid, ${order.id}::uuid, ${warehouse.id}::uuid,
          ${shippingChannel.id}::uuid, 'SHP-M5-UPGRADE-HISTORY', 'CREATION_PENDING',
          'M5-UPGRADE-HISTORY', 'standard', 0, 'test-ciphertext',
          '{"heightCm":10,"lengthCm":10,"weightGram":500,"widthCm":10}'::jsonb, now()
        )
      `;
      return {
        adminId: admin.id,
        orderId: order.id,
        paymentChannelId: paymentChannel.id,
        paymentId: payment.id,
        refundId: refund.id,
        shipmentId,
        shippingChannelId: shippingChannel.id,
        storeId,
        warehouseId: warehouse.id,
      };
    });

    const fullSchemaPath = join(PRISMA_ROOT, 'schema.prisma');
    const d0MigrationPath = join(MIGRATIONS_ROOT, d0MigrationName, 'migration.sql');
    const d0DownPath = join(MIGRATIONS_ROOT, d0MigrationName, 'down.sql');
    const b3MigrationPath = join(MIGRATIONS_ROOT, B3_MIGRATION_NAME, 'migration.sql');
    const b3DownPath = join(MIGRATIONS_ROOT, B3_MIGRATION_NAME, 'down.sql');
    const b4DownPath = join(MIGRATIONS_ROOT, B4_MIGRATIONS[0], 'down.sql');
    const b5DownPath = join(MIGRATIONS_ROOT, B5_MIGRATION_NAME, 'down.sql');
    const p0M6007MigrationPath = join(MIGRATIONS_ROOT, P0_M6_007_MIGRATION_NAME, 'migration.sql');
    const p0M6007DownPath = join(MIGRATIONS_ROOT, P0_M6_007_MIGRATION_NAME, 'down.sql');
    const p0M6008MigrationPath = join(MIGRATIONS_ROOT, P0_M6_008_MIGRATION_NAME, 'migration.sql');
    const p0M6008DownPath = join(MIGRATIONS_ROOT, P0_M6_008_MIGRATION_NAME, 'down.sql');
    const [
      d0MigrationSql,
      d0DownSql,
      b3DownSql,
      b4DownSql,
      b5DownSql,
      p0M6007MigrationSql,
      p0M6007DownSql,
      p0M6008MigrationSql,
      p0M6008DownSql,
    ] = await Promise.all([
      readFile(d0MigrationPath, 'utf8'),
      readFile(d0DownPath, 'utf8'),
      readFile(b3DownPath, 'utf8'),
      readFile(b4DownPath, 'utf8'),
      readFile(b5DownPath, 'utf8'),
      readFile(p0M6007MigrationPath, 'utf8'),
      readFile(p0M6007DownPath, 'utf8'),
      readFile(p0M6008MigrationPath, 'utf8'),
      readFile(p0M6008DownPath, 'utf8'),
    ]);
    const d0ForwardGuardStart = d0MigrationSql.indexOf('DO $$');
    const d0ForwardGuardEnd = d0MigrationSql.indexOf(
      'CREATE TYPE public.after_sale_evidence_object_role',
    );
    const d0DownGuardStart = d0DownSql.indexOf('DO $$');
    const d0DownGuardEnd = d0DownSql.indexOf(
      'DROP TRIGGER outbox_messages_evidence_contract_guard',
    );
    if (
      d0ForwardGuardStart < 0 ||
      d0ForwardGuardEnd <= d0ForwardGuardStart ||
      d0DownGuardStart < 0 ||
      d0DownGuardEnd <= d0DownGuardStart
    ) {
      fail('the M6.3-B2b-D0 migration guard boundaries could not be isolated');
    }
    const d0ForwardGuardSql = d0MigrationSql.slice(d0ForwardGuardStart, d0ForwardGuardEnd).trim();
    const d0DownGuardSql = d0DownSql.slice(d0DownGuardStart, d0DownGuardEnd).trim();
    const b3DownGuardStart = b3DownSql.indexOf('DO $$');
    const b3DownGuardEnd = b3DownSql.indexOf('REVOKE ALL ON FUNCTION');
    if (b3DownGuardStart < 0 || b3DownGuardEnd <= b3DownGuardStart) {
      fail('the M6.3-B3 down migration guard boundaries could not be isolated');
    }
    const b3DownGuardSql = b3DownSql.slice(b3DownGuardStart, b3DownGuardEnd).trim();
    const b4DownGuardStart = b4DownSql.indexOf('DO $$');
    const b4DownGuardEnd = b4DownSql.indexOf('DROP TRIGGER');
    if (b4DownGuardStart < 0 || b4DownGuardEnd <= b4DownGuardStart) {
      fail('the M6.3-B4 down migration guard boundaries could not be isolated');
    }
    const b4DownGuardSql = b4DownSql.slice(b4DownGuardStart, b4DownGuardEnd).trim();
    const b5DownGuardStart = b5DownSql.indexOf('DO $$');
    const b5DownGuardEnd = b5DownSql.indexOf('GRANT INSERT');
    if (b5DownGuardStart < 0 || b5DownGuardEnd <= b5DownGuardStart) {
      fail('the M6.3-B5 down migration guard boundaries could not be isolated');
    }
    const b5DownGuardSql = b5DownSql.slice(b5DownGuardStart, b5DownGuardEnd).trim();
    const p0M6007ForwardGuardStart = p0M6007MigrationSql.indexOf('DO $$');
    const p0M6007ForwardGuardEnd = p0M6007MigrationSql.indexOf(
      '-- Extend the existing B3 final database authorization',
    );
    const p0M6007DownGuardStart = p0M6007DownSql.indexOf('DO $$');
    const p0M6007DownGuardEnd = p0M6007DownSql.indexOf(
      '-- Restore the exact B3 ONLINE-only payment guard',
    );
    if (
      p0M6007ForwardGuardStart < 0 ||
      p0M6007ForwardGuardEnd <= p0M6007ForwardGuardStart ||
      p0M6007DownGuardStart < 0 ||
      p0M6007DownGuardEnd <= p0M6007DownGuardStart
    ) {
      fail('the P0-M6-007 migration guard boundaries could not be isolated');
    }
    const p0M6007ForwardGuardSql = p0M6007MigrationSql
      .slice(p0M6007ForwardGuardStart, p0M6007ForwardGuardEnd)
      .trim();
    const p0M6007DownGuardSql = p0M6007DownSql
      .slice(p0M6007DownGuardStart, p0M6007DownGuardEnd)
      .trim();
    const p0M6008ForwardGuardStart = p0M6008MigrationSql.indexOf('DO $$');
    const p0M6008ForwardGuardEnd = p0M6008MigrationSql.indexOf('CREATE OR REPLACE FUNCTION');
    const p0M6008DownGuardStart = p0M6008DownSql.indexOf('DO $$');
    const p0M6008DownGuardEnd = p0M6008DownSql.indexOf('DROP TRIGGER');
    if (
      p0M6008ForwardGuardStart < 0 ||
      p0M6008ForwardGuardEnd <= p0M6008ForwardGuardStart ||
      p0M6008DownGuardStart < 0 ||
      p0M6008DownGuardEnd <= p0M6008DownGuardStart
    ) {
      fail('the P0-M6-008 migration guard boundaries could not be isolated');
    }
    const p0M6008ForwardGuardSql = p0M6008MigrationSql
      .slice(p0M6008ForwardGuardStart, p0M6008ForwardGuardEnd)
      .trim();
    const p0M6008DownGuardSql = p0M6008DownSql
      .slice(p0M6008DownGuardStart, p0M6008DownGuardEnd)
      .trim();
    const d0EvidenceId = 'f2e00000-0000-4000-8000-000000000001';
    const d0TransitionId = 'f2e00000-0000-4000-8000-000000000002';
    const d0OutboxId = 'f2e00000-0000-4000-8000-000000000003';
    const d0IdempotencyId = 'f2e00000-0000-4000-8000-000000000004';
    const d0LedgerId = 'f2e00000-0000-4000-8000-000000000005';
    const d0StoreId = 'f2000000-0000-4000-8000-000000000001';
    const d0MemberId = 'f2020000-0000-4000-8000-000000000001';
    const d0ObjectKey = `test/${d0StoreId}/staged/${d0EvidenceId}/original`;

    runPrisma(['migrate', 'deploy', '--schema', m63B2aSchemaPath], scratchDatabaseUrl);
    await assertMigrationState(scratchClient, m63B2aBoundaryMigrationNames);
    const [b2aEvidenceShape] = await scratchClient.$queryRaw<Array<{ ledger_exists: boolean }>>`
      SELECT to_regclass('public.after_sale_evidence_objects') IS NOT NULL AS ledger_exists
    `;
    if (b2aEvidenceShape?.ledger_exists) {
      fail('the D0 evidence ledger unexpectedly exists at the M6.3-B2a boundary');
    }

    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        INSERT INTO after_sale_evidence_files (
          id, store_id, member_id, upload_session_id, object_key, mime_type, byte_size,
          checksum_sha256, original_filename, status, updated_at
        ) VALUES (
          ${d0EvidenceId}::uuid, ${d0StoreId}::uuid, ${d0MemberId}::uuid,
          ${randomUUID()}::uuid, ${d0ObjectKey}, 'image/jpeg', 1024,
          ${createHash('sha256').update('m63-b2b-d0-forward-evidence').digest('hex')},
          'forward-evidence-guard.jpg', 'PENDING', clock_timestamp()
        )
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });
    await expectSqlState(
      scratchClient.$executeRawUnsafe(d0ForwardGuardSql),
      '55000',
      'M6.3-B2b-D0 forward evidence-file guard',
    );
    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        DELETE FROM after_sale_evidence_files
        WHERE store_id = ${d0StoreId}::uuid AND id = ${d0EvidenceId}::uuid
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });

    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      // The B2a transition shape deliberately predates D0's version/generation columns.
      await transaction.$executeRaw`
        INSERT INTO after_sale_evidence_transitions (
          id, store_id, evidence_file_id, from_status, to_status, event, actor_type,
          actor_id, error_code
        ) VALUES (
          ${d0TransitionId}::uuid, ${d0StoreId}::uuid, ${d0EvidenceId}::uuid,
          'PENDING', 'FAILED', 'SCAN_FAILED', 'SYSTEM',
          '00000000-0000-4000-8000-000000000006'::uuid, 'FORWARD_TRANSITION_GUARD'
        )
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });
    await expectSqlState(
      scratchClient.$executeRawUnsafe(d0ForwardGuardSql),
      '55000',
      'M6.3-B2b-D0 forward transition guard',
    );
    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        DELETE FROM after_sale_evidence_transitions
        WHERE store_id = ${d0StoreId}::uuid AND id = ${d0TransitionId}::uuid
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });

    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        INSERT INTO outbox_messages (
          id, store_id, aggregate_type, aggregate_id, event_type, event_version,
          idempotency_key, payload, available_at, max_attempts, updated_at
        ) VALUES (
          ${d0OutboxId}::uuid, ${d0StoreId}::uuid, 'AFTER_SALE_EVIDENCE',
          ${d0EvidenceId}::uuid, 'migration.guard.aggregate-only', 1,
          'm63-b2b-d0-forward-aggregate-only', '{"guard":"aggregate-only"}'::jsonb,
          clock_timestamp(), 3, clock_timestamp()
        )
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });
    await expectSqlState(
      scratchClient.$executeRawUnsafe(d0ForwardGuardSql),
      '55000',
      'M6.3-B2b-D0 forward aggregate-only outbox guard',
    );
    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        DELETE FROM outbox_messages
        WHERE store_id = ${d0StoreId}::uuid AND id = ${d0OutboxId}::uuid
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });

    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        INSERT INTO idempotency_records (
          id, store_id, member_id, operation, idempotency_key, request_hash, response, expires_at
        ) VALUES (
          ${d0IdempotencyId}::uuid, ${d0StoreId}::uuid, ${d0MemberId}::uuid,
          'after-sale-evidence-migration-guard', 'm63-b2b-d0-forward-idempotency',
          ${createHash('sha256').update('m63-b2b-d0-forward-idempotency').digest('hex')},
          '{"guard":"idempotency"}'::jsonb, clock_timestamp() + interval '1 day'
        )
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });
    await expectSqlState(
      scratchClient.$executeRawUnsafe(d0ForwardGuardSql),
      '55000',
      'M6.3-B2b-D0 forward idempotency guard',
    );
    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        DELETE FROM idempotency_records
        WHERE store_id = ${d0StoreId}::uuid AND id = ${d0IdempotencyId}::uuid
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });

    const [cleanB2aEvidenceRuntime] = await scratchClient.$queryRaw<
      Array<{
        evidence_count: bigint;
        idempotency_count: bigint;
        outbox_count: bigint;
        transition_count: bigint;
      }>
    >`
      SELECT
        (SELECT count(*) FROM after_sale_evidence_files) AS evidence_count,
        (SELECT count(*) FROM after_sale_evidence_transitions) AS transition_count,
        (SELECT count(*) FROM outbox_messages
          WHERE aggregate_type = 'AFTER_SALE_EVIDENCE'
             OR event_type LIKE 'after-sale.evidence.%') AS outbox_count,
        (SELECT count(*) FROM idempotency_records
          WHERE operation LIKE 'after-sale-evidence-%') AS idempotency_count
    `;
    if (
      cleanB2aEvidenceRuntime?.evidence_count !== 0n ||
      cleanB2aEvidenceRuntime.transition_count !== 0n ||
      cleanB2aEvidenceRuntime.outbox_count !== 0n ||
      cleanB2aEvidenceRuntime.idempotency_count !== 0n
    ) {
      fail('the M6.3-B2b-D0 forward guard fixtures were not independently cleaned');
    }

    runPrisma(['migrate', 'deploy', '--schema', b3BoundarySchemaPath], scratchDatabaseUrl);
    await assertMigrationState(scratchClient, b3BoundaryMigrationNames);
    await assertM63B3DownBoundary(scratchClient);

    const b3ValidConditionRules = {
      allowed_reason_codes: ['damaged-item', 'wrong-item'],
      evidence_required: false,
      evidence_required_reason_codes: ['damaged-item'],
      opened_package_exception_reason_codes: ['wrong-item'],
    };
    const b3ValidPolicyPayload = {
      allowed_types: ['REFUND_ONLY', 'RETURN_REFUND'],
      category_id: null,
      condition_rules: b3ValidConditionRules,
      damaged_exception: true,
      defect_exception: true,
      exchange_attribute_code: null,
      exchange_same_product_only: true,
      hygiene_restricted: false,
      localizations: [
        {
          buyer_instructions: 'Huong dan kiem tra nang cap B3',
          locale: 'vi',
          name: 'Chinh sach nang cap B3',
          summary: 'Du lieu lich su hop le cho kiem tra nang cap B3',
        },
        {
          buyer_instructions: 'B3 升级检查说明',
          locale: 'zh',
          name: 'B3 升级政策',
          summary: '用于 B3 升级检查的有效历史数据',
        },
        {
          buyer_instructions: 'B3 upgrade check instructions',
          locale: 'en',
          name: 'B3 upgrade policy',
          summary: 'Valid historical data for the B3 upgrade check',
        },
      ],
      product_ids: ['f2400000-0000-4000-8000-000000000001'],
      request_window_days: 30,
      return_shipping_payer: 'MERCHANT',
      return_window_days: 7,
      unopened_required: false,
      wrong_item_exception: true,
    };
    const b3MissingAllowedReasonPayload = {
      ...b3ValidPolicyPayload,
      condition_rules: {
        evidence_required: false,
        evidence_required_reason_codes: [],
        opened_package_exception_reason_codes: [],
      },
    };
    const b3IllegalAllowedReasonPayload = {
      ...b3ValidPolicyPayload,
      condition_rules: {
        ...b3ValidConditionRules,
        allowed_reason_codes: ['damaged-item', 'INVALID_CODE'],
        evidence_required_reason_codes: ['damaged-item'],
        opened_package_exception_reason_codes: [],
      },
    };
    const b3InvalidReasonSubsetPayload = {
      ...b3ValidPolicyPayload,
      condition_rules: {
        ...b3ValidConditionRules,
        allowed_reason_codes: ['damaged-item'],
        evidence_required_reason_codes: ['wrong-item'],
        opened_package_exception_reason_codes: [],
      },
    };
    const b3DuplicateAllowedReasonPayload = {
      ...b3ValidPolicyPayload,
      condition_rules: {
        ...b3ValidConditionRules,
        allowed_reason_codes: ['damaged-item', 'damaged-item'],
        evidence_required_reason_codes: ['damaged-item'],
        opened_package_exception_reason_codes: [],
      },
    };
    const serializeB3PolicyPayload = (payload: unknown) => JSON.stringify(payload);
    const hashB3PolicyPayload = (payload: unknown) =>
      createHash('sha256').update(serializeB3PolicyPayload(payload)).digest('hex');
    const b3ValidPolicyPayloadJson = serializeB3PolicyPayload(b3ValidPolicyPayload);
    const b3ValidPolicyPayloadHash = hashB3PolicyPayload(b3ValidPolicyPayload);
    const b3MissingAllowedReasonPayloadJson = serializeB3PolicyPayload(
      b3MissingAllowedReasonPayload,
    );
    const b3MissingAllowedReasonPayloadHash = hashB3PolicyPayload(b3MissingAllowedReasonPayload);
    const b3IllegalAllowedReasonPayloadJson = serializeB3PolicyPayload(
      b3IllegalAllowedReasonPayload,
    );
    const b3IllegalAllowedReasonPayloadHash = hashB3PolicyPayload(b3IllegalAllowedReasonPayload);
    const b3InvalidReasonSubsetPayloadJson = serializeB3PolicyPayload(b3InvalidReasonSubsetPayload);
    const b3InvalidReasonSubsetPayloadHash = hashB3PolicyPayload(b3InvalidReasonSubsetPayload);
    const b3DuplicateAllowedReasonPayloadJson = serializeB3PolicyPayload(
      b3DuplicateAllowedReasonPayload,
    );
    const b3DuplicateAllowedReasonPayloadHash = hashB3PolicyPayload(
      b3DuplicateAllowedReasonPayload,
    );
    const b3HistoricalPolicyFixture: B3HistoricalPolicyFixtureIds = {
      afterSaleId: randomUUID(),
      orderItemId: randomUUID(),
      policyId: randomUUID(),
      policyVersionId: randomUUID(),
      storeId: m5HistoricalFacts.storeId,
    };

    // Model stored pre-B3 JSON at the migration-owner boundary. Replica mode
    // bypasses runtime immutability triggers while preserving relational and
    // CHECK constraints, and every injected row is removed before down tests.
    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        INSERT INTO order_items (
          id, store_id, order_id, sku_id, product_id, brand_id, category_id,
          sku_code, product_name, brand_name, option_snapshot, unit_price_vnd,
          quantity, subtotal_vnd, payable_vnd
        ) VALUES (
          ${b3HistoricalPolicyFixture.orderItemId}::uuid,
          ${b3HistoricalPolicyFixture.storeId}::uuid,
          ${m5HistoricalFacts.orderId}::uuid,
          'f2500000-0000-4000-8000-000000000001'::uuid,
          'f2400000-0000-4000-8000-000000000001'::uuid,
          'f2100000-0000-4000-8000-000000000001'::uuid,
          'f2210000-0000-4000-8000-000000000001'::uuid,
          'm63-b3-upgrade-fixture', 'M6.3-B3 upgrade product',
          'M6.3-B3 upgrade brand', '{"fixture":"m63-b3-upgrade"}'::jsonb,
          100000, 1, 100000, 100000
        )
      `;
      await transaction.$executeRaw`
        INSERT INTO after_sale_policies (
          id, store_id, code, status, draft_payload, draft_hash,
          created_by, updated_by, updated_at
        ) VALUES (
          ${b3HistoricalPolicyFixture.policyId}::uuid,
          ${b3HistoricalPolicyFixture.storeId}::uuid,
          'm63-b3-upgrade-fixture', 'DRAFT',
          ${b3MissingAllowedReasonPayloadJson}::jsonb,
          ${b3MissingAllowedReasonPayloadHash},
          ${m5HistoricalFacts.adminId}::uuid, ${m5HistoricalFacts.adminId}::uuid,
          clock_timestamp()
        )
      `;
      await transaction.$executeRaw`
        INSERT INTO after_sale_policy_versions (
          id, store_id, policy_id, version_number, effective_at,
          request_window_days, return_window_days, allowed_types,
          return_shipping_payer, unopened_required, hygiene_restricted,
          damaged_exception, wrong_item_exception, defect_exception,
          condition_rules, payload, payload_hash, published_by
        ) VALUES (
          ${b3HistoricalPolicyFixture.policyVersionId}::uuid,
          ${b3HistoricalPolicyFixture.storeId}::uuid,
          ${b3HistoricalPolicyFixture.policyId}::uuid,
          1, clock_timestamp(), 30, 7,
          ARRAY['REFUND_ONLY','RETURN_REFUND']::after_sale_type[],
          'MERCHANT', false, false, true, true, true,
          ${JSON.stringify(b3ValidConditionRules)}::jsonb,
          ${b3ValidPolicyPayloadJson}::jsonb, ${b3ValidPolicyPayloadHash},
          ${m5HistoricalFacts.adminId}::uuid
        )
      `;
      await transaction.$executeRaw`
        INSERT INTO order_item_after_sale_policy_snapshots (
          store_id, order_id, order_item_id, policy_id, policy_version_id,
          policy_code, policy_version_number, payload, payload_hash
        ) VALUES (
          ${b3HistoricalPolicyFixture.storeId}::uuid,
          ${m5HistoricalFacts.orderId}::uuid,
          ${b3HistoricalPolicyFixture.orderItemId}::uuid,
          ${b3HistoricalPolicyFixture.policyId}::uuid,
          ${b3HistoricalPolicyFixture.policyVersionId}::uuid,
          'm63-b3-upgrade-fixture', 1,
          ${b3ValidPolicyPayloadJson}::jsonb, ${b3ValidPolicyPayloadHash}
        )
      `;
      await transaction.$executeRaw`
        INSERT INTO after_sales (
          id, store_id, order_id, member_id, public_case_number, type, status,
          source, reason_code, policy_snapshot, policy_hash, policy_id,
          policy_version_id, legacy_policy_review, idempotency_key_hash,
          request_hash, initiated_by, correlation_id, updated_at
        ) VALUES (
          ${b3HistoricalPolicyFixture.afterSaleId}::uuid,
          ${b3HistoricalPolicyFixture.storeId}::uuid,
          ${m5HistoricalFacts.orderId}::uuid,
          'f2020000-0000-4000-8000-000000000001'::uuid,
          ${`ASC-B3${b3HistoricalPolicyFixture.afterSaleId
            .replaceAll('-', '')
            .slice(0, 16)
            .toUpperCase()}`},
          'REFUND_ONLY', 'PENDING_REVIEW', 'ADMIN', 'damaged-item',
          ${b3ValidPolicyPayloadJson}::jsonb, ${b3ValidPolicyPayloadHash},
          ${b3HistoricalPolicyFixture.policyId}::uuid,
          ${b3HistoricalPolicyFixture.policyVersionId}::uuid, false,
          ${createHash('sha256').update('m63-b3-upgrade-idempotency').digest('hex')},
          ${createHash('sha256').update('m63-b3-upgrade-request').digest('hex')},
          ${m5HistoricalFacts.adminId}::uuid, 'm63-b3-upgrade-preflight',
          clock_timestamp()
        )
      `;
    });

    await assertB3HistoricalPolicyPreflightFailure(
      scratchClient,
      scratchDatabaseUrl,
      fullSchemaPath,
      b3MigrationPath,
      b3HistoricalPolicyFixture,
      'draft payload missing allowed_reason_codes',
    );

    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        UPDATE after_sale_policies
        SET draft_payload = ${b3ValidPolicyPayloadJson}::jsonb,
          draft_hash = ${b3ValidPolicyPayloadHash}, updated_at = clock_timestamp()
        WHERE store_id = ${b3HistoricalPolicyFixture.storeId}::uuid
          AND id = ${b3HistoricalPolicyFixture.policyId}::uuid
      `;
      await transaction.$executeRaw`
        UPDATE after_sale_policy_versions
        SET payload = ${b3IllegalAllowedReasonPayloadJson}::jsonb,
          payload_hash = ${b3IllegalAllowedReasonPayloadHash}
        WHERE store_id = ${b3HistoricalPolicyFixture.storeId}::uuid
          AND id = ${b3HistoricalPolicyFixture.policyVersionId}::uuid
      `;
    });
    await assertB3HistoricalPolicyPreflightFailure(
      scratchClient,
      scratchDatabaseUrl,
      fullSchemaPath,
      b3MigrationPath,
      b3HistoricalPolicyFixture,
      'version payload with an illegal allowed_reason_codes entry',
    );

    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        UPDATE after_sale_policy_versions
        SET payload = ${b3ValidPolicyPayloadJson}::jsonb,
          payload_hash = ${b3ValidPolicyPayloadHash}
        WHERE store_id = ${b3HistoricalPolicyFixture.storeId}::uuid
          AND id = ${b3HistoricalPolicyFixture.policyVersionId}::uuid
      `;
      await transaction.$executeRaw`
        UPDATE order_item_after_sale_policy_snapshots
        SET payload = ${b3InvalidReasonSubsetPayloadJson}::jsonb,
          payload_hash = ${b3InvalidReasonSubsetPayloadHash}
        WHERE store_id = ${b3HistoricalPolicyFixture.storeId}::uuid
          AND order_item_id = ${b3HistoricalPolicyFixture.orderItemId}::uuid
      `;
    });
    await assertB3HistoricalPolicyPreflightFailure(
      scratchClient,
      scratchDatabaseUrl,
      fullSchemaPath,
      b3MigrationPath,
      b3HistoricalPolicyFixture,
      'order-item snapshot with a reason-code subset violation',
    );

    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        UPDATE order_item_after_sale_policy_snapshots
        SET payload = ${b3ValidPolicyPayloadJson}::jsonb,
          payload_hash = ${b3ValidPolicyPayloadHash}
        WHERE store_id = ${b3HistoricalPolicyFixture.storeId}::uuid
          AND order_item_id = ${b3HistoricalPolicyFixture.orderItemId}::uuid
      `;
      await transaction.$executeRaw`
        UPDATE after_sales
        SET policy_snapshot = ${b3DuplicateAllowedReasonPayloadJson}::jsonb,
          policy_hash = ${b3DuplicateAllowedReasonPayloadHash},
          updated_at = clock_timestamp()
        WHERE store_id = ${b3HistoricalPolicyFixture.storeId}::uuid
          AND id = ${b3HistoricalPolicyFixture.afterSaleId}::uuid
      `;
    });
    await assertB3HistoricalPolicyPreflightFailure(
      scratchClient,
      scratchDatabaseUrl,
      fullSchemaPath,
      b3MigrationPath,
      b3HistoricalPolicyFixture,
      'after-sale snapshot with duplicate allowed_reason_codes',
    );

    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        UPDATE after_sales
        SET policy_snapshot = ${b3ValidPolicyPayloadJson}::jsonb,
          policy_hash = ${b3ValidPolicyPayloadHash}, updated_at = clock_timestamp()
        WHERE store_id = ${b3HistoricalPolicyFixture.storeId}::uuid
          AND id = ${b3HistoricalPolicyFixture.afterSaleId}::uuid
      `;
    });

    runPrisma(['migrate', 'deploy', '--schema', p0M6007BoundarySchemaPath], scratchDatabaseUrl);
    await assertMigrationState(scratchClient, p0M6007BoundaryMigrationNames);
    await assertP0M6007CodRefundBoundary(scratchClient, false);
    const p0M6007ForwardSettlementId = randomUUID();
    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        INSERT INTO after_sale_settlements (
          id, store_id, after_sale_id, order_id, public_settlement_number,
          method, status, amount_vnd, currency, idempotency_key_hash, request_hash,
          requested_by, version, requested_at, updated_at
        ) VALUES (
          ${p0M6007ForwardSettlementId}::uuid,
          ${b3HistoricalPolicyFixture.storeId}::uuid,
          ${b3HistoricalPolicyFixture.afterSaleId}::uuid,
          ${m5HistoricalFacts.orderId}::uuid,
          ${`AST-${p0M6007ForwardSettlementId.replaceAll('-', '').slice(0, 24).toUpperCase()}`},
          'COD_OFFLINE', 'PENDING', 1, 'VND',
          ${createHash('sha256').update('p0-m6-007-forward-idempotency').digest('hex')},
          ${createHash('sha256').update('p0-m6-007-forward-request').digest('hex')},
          ${m5HistoricalFacts.adminId}::uuid, 1, clock_timestamp(), clock_timestamp()
        )
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });
    await expectSqlState(
      scratchClient.$executeRawUnsafe(p0M6007ForwardGuardSql),
      '55000',
      'P0-M6-007 forward existing COD settlement guard',
    );
    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        DELETE FROM after_sale_settlements WHERE id = ${p0M6007ForwardSettlementId}::uuid
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });

    runPrisma(['migrate', 'deploy', '--schema', p0M6008BoundarySchemaPath], scratchDatabaseUrl);
    await assertMigrationState(scratchClient, p0M6008BoundaryMigrationNames);
    await assertP0M6007CodRefundBoundary(scratchClient, true);
    await assertP0M6008ReturnInspectionBoundary(scratchClient, false);
    const p0M6008ForwardInspectionId = randomUUID();
    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        INSERT INTO after_sale_inspections (
          id, store_id, after_sale_id, inspection_version, admin_id, reason
        ) VALUES (
          ${p0M6008ForwardInspectionId}::uuid,
          ${b3HistoricalPolicyFixture.storeId}::uuid,
          ${b3HistoricalPolicyFixture.afterSaleId}::uuid, 1,
          ${m5HistoricalFacts.adminId}::uuid,
          'P0-M6-008 forward migration inspection guard'
        )
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });
    await expectSqlState(
      scratchClient.$executeRawUnsafe(p0M6008ForwardGuardSql),
      '55000',
      'P0-M6-008 forward existing inspection fact guard',
    );
    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        DELETE FROM after_sale_inspections WHERE id = ${p0M6008ForwardInspectionId}::uuid
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });
    const p0M6008ForwardAuditId = randomUUID();
    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        INSERT INTO audit_logs (
          id, store_id, actor_type, actor_id, action, target_type, target_id, correlation_id
        ) VALUES (
          ${p0M6008ForwardAuditId}::uuid,
          ${b3HistoricalPolicyFixture.storeId}::uuid,
          'ADMIN', ${m5HistoricalFacts.adminId}::uuid, 'after-sale.return.inspected',
          'after_sale', ${b3HistoricalPolicyFixture.afterSaleId},
          'p0-m6-008-forward-audit'
        )
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });
    await expectSqlState(
      scratchClient.$executeRawUnsafe(p0M6008ForwardGuardSql),
      '55000',
      'P0-M6-008 forward existing inspection audit guard',
    );
    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        DELETE FROM audit_logs WHERE id = ${p0M6008ForwardAuditId}::uuid
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });

    runPrisma(['migrate', 'deploy', '--schema', fullSchemaPath], scratchDatabaseUrl);
    await assertMigrationState(scratchClient, allMigrationNames);
    await assertM63B1ReadIndexes(scratchClient);
    await assertM63B2ReadIndexes(scratchClient);
    await assertM63B2bD0Indexes(scratchClient);
    await assertM63B3CommandBoundary(scratchClient);
    await assertM63B4ReviewBoundary(scratchClient);
    await assertM63B5ReturnBoundary(scratchClient);
    await assertFinancialReconciliationBoundary(scratchClient, true);
    await assertCodReconciliationBoundary(scratchClient, true);
    await assertFinancialReconciliationReviewBoundary(scratchClient, true);
    const p0M6007CatalogFingerprint = await assertP0M6007CodRefundBoundary(scratchClient, true);
    const p0M6008CatalogFingerprint = await assertP0M6008ReturnInspectionBoundary(
      scratchClient,
      true,
    );

    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        DELETE FROM after_sales
        WHERE store_id = ${b3HistoricalPolicyFixture.storeId}::uuid
          AND id = ${b3HistoricalPolicyFixture.afterSaleId}::uuid
      `;
      await transaction.$executeRaw`
        DELETE FROM order_item_after_sale_policy_snapshots
        WHERE store_id = ${b3HistoricalPolicyFixture.storeId}::uuid
          AND order_item_id = ${b3HistoricalPolicyFixture.orderItemId}::uuid
      `;
      await transaction.$executeRaw`
        DELETE FROM after_sale_policy_versions
        WHERE store_id = ${b3HistoricalPolicyFixture.storeId}::uuid
          AND id = ${b3HistoricalPolicyFixture.policyVersionId}::uuid
      `;
      await transaction.$executeRaw`
        DELETE FROM after_sale_policies
        WHERE store_id = ${b3HistoricalPolicyFixture.storeId}::uuid
          AND id = ${b3HistoricalPolicyFixture.policyId}::uuid
      `;
      await transaction.$executeRaw`
        DELETE FROM order_items
        WHERE store_id = ${b3HistoricalPolicyFixture.storeId}::uuid
          AND id = ${b3HistoricalPolicyFixture.orderItemId}::uuid
      `;
    });
    const [cleanB3HistoricalPolicyFixture] = await scratchClient.$queryRaw<
      Array<{ remaining_rows: bigint }>
    >`
      SELECT
        (SELECT count(*) FROM after_sale_policies
          WHERE id = ${b3HistoricalPolicyFixture.policyId}::uuid) +
        (SELECT count(*) FROM after_sale_policy_versions
          WHERE id = ${b3HistoricalPolicyFixture.policyVersionId}::uuid) +
        (SELECT count(*) FROM order_item_after_sale_policy_snapshots
          WHERE order_item_id = ${b3HistoricalPolicyFixture.orderItemId}::uuid) +
        (SELECT count(*) FROM after_sales
          WHERE id = ${b3HistoricalPolicyFixture.afterSaleId}::uuid) +
        (SELECT count(*) FROM order_items
          WHERE id = ${b3HistoricalPolicyFixture.orderItemId}::uuid)
          AS remaining_rows
    `;
    if (cleanB3HistoricalPolicyFixture?.remaining_rows !== 0n) {
      fail('the M6.3-B3 historical policy preflight fixtures were not cleaned');
    }
    const upgradedM5Facts = await scratchClient.$queryRaw<
      Array<{
        after_sale_id: string | null;
        purpose: string;
        refund_amount_vnd: bigint;
        refund_status: string;
        shipment_status: string;
      }>
    >`
      SELECT shipment.after_sale_id, shipment.purpose::text AS purpose,
        shipment.status::text AS shipment_status, refund.amount_vnd AS refund_amount_vnd,
        refund.status::text AS refund_status
      FROM shipments shipment
      JOIN refunds refund ON refund.id = ${m5HistoricalFacts.refundId}::uuid
      WHERE shipment.id = ${m5HistoricalFacts.shipmentId}::uuid
    `;
    if (
      upgradedM5Facts.length !== 1 ||
      upgradedM5Facts[0]?.after_sale_id !== null ||
      upgradedM5Facts[0]?.purpose !== 'ORDER_OUTBOUND' ||
      upgradedM5Facts[0]?.shipment_status !== 'CREATION_PENDING' ||
      upgradedM5Facts[0]?.refund_amount_vnd !== 20_000n ||
      upgradedM5Facts[0]?.refund_status !== 'REQUESTED'
    ) {
      fail('M5 refund or shipment facts changed while upgrading to M6');
    }
    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`
        SELECT set_config('app.store_id', ${m5HistoricalFacts.storeId}, true)
      `;
      // The isolated scratch cleanup must remove its own immutable M5 fixtures
      // before exercising the M5 down boundary.
      await transaction.$executeRawUnsafe(
        'ALTER TABLE "refunds" DISABLE TRIGGER "refunds_no_delete"',
      );
      await transaction.$executeRawUnsafe(
        'ALTER TABLE "shipments" DISABLE TRIGGER "shipments_no_delete"',
      );
      await transaction.$executeRawUnsafe(
        'ALTER TABLE "payment_attempts" DISABLE TRIGGER "payment_attempts_no_delete"',
      );
      await transaction.$executeRawUnsafe(
        'ALTER TABLE "store_payment_channels" DISABLE TRIGGER "store_payment_channels_no_delete"',
      );
      await transaction.$executeRawUnsafe(
        'ALTER TABLE "store_shipping_channels" DISABLE TRIGGER "store_shipping_channels_no_delete"',
      );
      await transaction.$executeRaw`DELETE FROM refunds WHERE id = ${m5HistoricalFacts.refundId}::uuid`;
      await transaction.$executeRaw`DELETE FROM shipments WHERE id = ${m5HistoricalFacts.shipmentId}::uuid`;
      await transaction.$executeRaw`DELETE FROM payment_attempts WHERE id = ${m5HistoricalFacts.paymentId}::uuid`;
      await transaction.$executeRaw`DELETE FROM orders WHERE id = ${m5HistoricalFacts.orderId}::uuid`;
      await transaction.$executeRaw`DELETE FROM store_payment_channels WHERE id = ${m5HistoricalFacts.paymentChannelId}::uuid`;
      await transaction.$executeRaw`DELETE FROM store_shipping_channels WHERE id = ${m5HistoricalFacts.shippingChannelId}::uuid`;
      await transaction.$executeRaw`
        DELETE FROM store_zalo_apps
        WHERE store_id = ${m5HistoricalFacts.storeId}::uuid
          AND environment = 'TEST' AND mini_app_id = 'm5-upgrade-history-app'
      `;
      await transaction.$executeRaw`DELETE FROM warehouses WHERE id = ${m5HistoricalFacts.warehouseId}::uuid`;
      await transaction.$executeRaw`DELETE FROM admin_users WHERE id = ${m5HistoricalFacts.adminId}::uuid`;
      await transaction.$executeRawUnsafe(
        'ALTER TABLE "refunds" ENABLE TRIGGER "refunds_no_delete"',
      );
      await transaction.$executeRawUnsafe(
        'ALTER TABLE "shipments" ENABLE TRIGGER "shipments_no_delete"',
      );
      await transaction.$executeRawUnsafe(
        'ALTER TABLE "payment_attempts" ENABLE TRIGGER "payment_attempts_no_delete"',
      );
      await transaction.$executeRawUnsafe(
        'ALTER TABLE "store_payment_channels" ENABLE TRIGGER "store_payment_channels_no_delete"',
      );
      await transaction.$executeRawUnsafe(
        'ALTER TABLE "store_shipping_channels" ENABLE TRIGGER "store_shipping_channels_no_delete"',
      );
    });
    const afterUpgradeFingerprint = await fixtureFingerprint(scratchClient, fingerprintSql);
    if (afterUpgradeFingerprint !== beforeUpgradeFingerprint) {
      fail('M1/M2 fixture fingerprint changed during the M3 upgrade');
    }

    runPrisma(['migrate', 'deploy', '--schema', fullSchemaPath], scratchDatabaseUrl);
    await assertMigrationState(scratchClient, allMigrationNames);
    await assertM63B1ReadIndexes(scratchClient);
    await assertM63B2ReadIndexes(scratchClient);
    await assertM63B2bD0Indexes(scratchClient);
    const repeatedB3CatalogFingerprint = await assertM63B3CommandBoundary(scratchClient);
    const repeatedB4CatalogFingerprint = await assertM63B4ReviewBoundary(scratchClient);
    const repeatedB5CatalogFingerprint = await assertM63B5ReturnBoundary(scratchClient);
    await assertFinancialReconciliationBoundary(scratchClient, true);
    await assertCodReconciliationBoundary(scratchClient, true);
    await assertFinancialReconciliationReviewBoundary(scratchClient, true);
    const repeatedP0M6007CatalogFingerprint = await assertP0M6007CodRefundBoundary(
      scratchClient,
      true,
    );
    if (repeatedP0M6007CatalogFingerprint !== p0M6007CatalogFingerprint) {
      fail('P0-M6-007 repeated deploy changed the COD refund security catalog');
    }
    const repeatedP0M6008CatalogFingerprint = await assertP0M6008ReturnInspectionBoundary(
      scratchClient,
      true,
    );
    if (repeatedP0M6008CatalogFingerprint !== p0M6008CatalogFingerprint) {
      fail('P0-M6-008 repeated deploy changed the return inspection security catalog');
    }
    await assertM63B2bD5ProtectedReadLock(scratchClient);
    await exerciseD5MigrationAtomicity(
      scratchClient,
      scratchDatabaseUrl,
      fullSchemaPath,
      tempDirectory,
    );
    const afterRepeatFingerprint = await fixtureFingerprint(scratchClient, fingerprintSql);
    if (afterRepeatFingerprint !== beforeUpgradeFingerprint) {
      fail('M1/M2 fixture fingerprint changed during repeated deployment');
    }

    runPrisma(
      ['db', 'execute', '--file', ASSERTIONS_SQL_PATH, '--schema', fullSchemaPath],
      scratchDatabaseUrl,
    );

    const p0M6008GuardStoreId = 'f2000000-0000-4000-8000-000000000001';
    const p0M6008GuardAdminId = 'f2030000-0000-4000-8000-000000000001';
    const p0M6008GuardAfterSaleId = 'f2c80000-0000-4000-8000-000000000001';
    const p0M6008GuardInspectionId = 'f2c80000-0000-4000-8000-000000000002';
    const p0M6008GuardActionId = 'f2c80000-0000-4000-8000-000000000003';
    const p0M6008GuardTransitionId = 'f2c80000-0000-4000-8000-000000000004';
    const p0M6008GuardOperationId = 'f2c80000-0000-4000-8000-000000000005';
    const p0M6008GuardAuditId = 'f2c80000-0000-4000-8000-000000000006';
    const p0M6008Hash = (value: string) => createHash('sha256').update(value).digest('hex');

    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        INSERT INTO after_sale_inspections (
          id, store_id, after_sale_id, inspection_version, admin_id, reason
        ) VALUES (
          ${p0M6008GuardInspectionId}::uuid, ${p0M6008GuardStoreId}::uuid,
          ${p0M6008GuardAfterSaleId}::uuid, 1, ${p0M6008GuardAdminId}::uuid,
          'P0-M6-008 down inspection guard'
        )
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });
    await expectSqlState(
      scratchClient.$executeRawUnsafe(p0M6008DownGuardSql),
      '55000',
      'P0-M6-008 down inspection fact guard',
    );
    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        DELETE FROM after_sale_inspections WHERE id = ${p0M6008GuardInspectionId}::uuid
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });

    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        INSERT INTO after_sale_inventory_actions (
          id, store_id, after_sale_id, after_sale_item_id, order_id,
          inspection_version, warehouse_id, sku_id, disposition, action_type,
          quantity, inventory_operation_id
        ) VALUES (
          ${p0M6008GuardActionId}::uuid, ${p0M6008GuardStoreId}::uuid,
          ${p0M6008GuardAfterSaleId}::uuid,
          'f2c80000-0000-4000-8000-000000000007'::uuid,
          'f2c80000-0000-4000-8000-000000000008'::uuid, 1,
          'f2c80000-0000-4000-8000-000000000009'::uuid,
          'f2c80000-0000-4000-8000-00000000000a'::uuid,
          'RESTOCK_SELLABLE', 'RESTOCK_SELLABLE', 1,
          'f2c80000-0000-4000-8000-00000000000b'::uuid
        )
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });
    await expectSqlState(
      scratchClient.$executeRawUnsafe(p0M6008DownGuardSql),
      '55000',
      'P0-M6-008 down inventory action fact guard',
    );
    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        DELETE FROM after_sale_inventory_actions WHERE id = ${p0M6008GuardActionId}::uuid
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });

    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        INSERT INTO after_sale_transitions (
          id, store_id, after_sale_id, from_status, to_status, event,
          actor_type, actor_id, correlation_id
        ) VALUES (
          ${p0M6008GuardTransitionId}::uuid, ${p0M6008GuardStoreId}::uuid,
          ${p0M6008GuardAfterSaleId}::uuid, 'INSPECTION_PENDING', 'REFUND_PENDING',
          'ACCEPT_INSPECTION', 'ADMIN', ${p0M6008GuardAdminId}::uuid,
          'p0-m6-008-down-transition'
        )
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });
    await expectSqlState(
      scratchClient.$executeRawUnsafe(p0M6008DownGuardSql),
      '55000',
      'P0-M6-008 down transition fact guard',
    );
    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        DELETE FROM after_sale_transitions WHERE id = ${p0M6008GuardTransitionId}::uuid
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });

    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        INSERT INTO after_sale_operations (
          id, store_id, after_sale_id, operation, idempotency_key_hash, request_hash,
          status, result_summary, attempt_count, version, updated_at
        ) VALUES (
          ${p0M6008GuardOperationId}::uuid, ${p0M6008GuardStoreId}::uuid,
          ${p0M6008GuardAfterSaleId}::uuid, 'ADMIN_INSPECT_RETURN',
          ${p0M6008Hash('p0-m6-008-down-operation-idempotency')},
          ${p0M6008Hash('p0-m6-008-down-operation-request')},
          'COMPLETED', '{"migration_guard":true}'::jsonb, 1, 2, clock_timestamp()
        )
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });
    await expectSqlState(
      scratchClient.$executeRawUnsafe(p0M6008DownGuardSql),
      '55000',
      'P0-M6-008 down operation fact guard',
    );
    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        DELETE FROM after_sale_operations WHERE id = ${p0M6008GuardOperationId}::uuid
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });

    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        INSERT INTO audit_logs (
          id, store_id, actor_type, actor_id, action, target_type, target_id, correlation_id
        ) VALUES (
          ${p0M6008GuardAuditId}::uuid, ${p0M6008GuardStoreId}::uuid,
          'ADMIN', ${p0M6008GuardAdminId}::uuid, 'after-sale.return.inspected',
          'after_sale', ${p0M6008GuardAfterSaleId}, 'p0-m6-008-down-audit'
        )
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });
    await expectSqlState(
      scratchClient.$executeRawUnsafe(p0M6008DownGuardSql),
      '55000',
      'P0-M6-008 down audit fact guard',
    );
    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`DELETE FROM audit_logs WHERE id = ${p0M6008GuardAuditId}::uuid`;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });
    const p0M6008CatalogAfterGuards = await assertP0M6008ReturnInspectionBoundary(
      scratchClient,
      true,
    );
    if (p0M6008CatalogAfterGuards !== repeatedP0M6008CatalogFingerprint) {
      fail('P0-M6-008 rollback fail-fast changed the return inspection security catalog');
    }

    runPrisma(
      ['db', 'execute', '--file', p0M6008DownPath, '--schema', fullSchemaPath],
      scratchDatabaseUrl,
    );
    await assertP0M6008ReturnInspectionBoundary(scratchClient, false);
    await scratchClient.$executeRaw`
      DELETE FROM "_prisma_migrations" WHERE migration_name = ${P0_M6_008_MIGRATION_NAME}
    `;
    runPrisma(['migrate', 'deploy', '--schema', fullSchemaPath], scratchDatabaseUrl);
    await assertMigrationState(scratchClient, allMigrationNames);
    const restoredP0M6008CatalogFingerprint = await assertP0M6008ReturnInspectionBoundary(
      scratchClient,
      true,
    );
    if (restoredP0M6008CatalogFingerprint !== repeatedP0M6008CatalogFingerprint) {
      fail('P0-M6-008 down/forward exercise did not restore the inspection security catalog');
    }

    const b5RollbackOperationId = randomUUID();
    const b5RollbackAfterSaleId = randomUUID();
    const b5RollbackOperationRows = await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      return transaction.$executeRaw`
        INSERT INTO after_sale_operations (
          id, store_id, after_sale_id, operation, idempotency_key_hash, request_hash,
          status, result_summary, attempt_count, version, updated_at
        )
        SELECT
          ${b5RollbackOperationId}::uuid, store.id, ${b5RollbackAfterSaleId}::uuid,
          'MEMBER_SUBMIT_RETURN',
          ${createHash('sha256').update('m63-b5-rollback-idempotency').digest('hex')},
          ${createHash('sha256').update('m63-b5-rollback-request').digest('hex')},
          'COMPLETED', '{"migrationGuard":true}'::jsonb, 1, 2, clock_timestamp()
        FROM stores AS store
        ORDER BY store.id
        LIMIT 1
      `;
    });
    if (b5RollbackOperationRows !== 1) {
      fail('M6.3-B5 rollback guard fixture could not create a return operation fact');
    }
    const [b5RollbackFixture] = await scratchClient.$queryRaw<
      Array<{ operation_count: bigint; action_count: bigint }>
    >`
      SELECT
        (SELECT count(*) FROM after_sale_operations
         WHERE id = ${b5RollbackOperationId}::uuid
           AND operation IN ('MEMBER_SUBMIT_RETURN','ADMIN_RECORD_RETURN_FACT')) AS operation_count,
        (SELECT count(*) FROM audit_logs
         WHERE action IN ('after-sale.return.submitted','after-sale.return.fact-recorded')) AS action_count
    `;
    if (b5RollbackFixture?.operation_count !== 1n) {
      fail(
        `M6.3-B5 rollback guard fixture disappeared: ${JSON.stringify({
          operation_count: String(b5RollbackFixture?.operation_count),
          action_count: String(b5RollbackFixture?.action_count),
        })}`,
      );
    }
    await expectSqlState(
      scratchClient.$executeRawUnsafe(b5DownGuardSql),
      '55000',
      'M6.3-B5 down return-operation fact guard',
    );
    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        DELETE FROM after_sale_operations WHERE id = ${b5RollbackOperationId}::uuid
      `;
    });
    runPrisma(
      ['db', 'execute', '--file', p0M6008DownPath, '--schema', fullSchemaPath],
      scratchDatabaseUrl,
    );
    await assertP0M6008ReturnInspectionBoundary(scratchClient, false);
    await scratchClient.$executeRaw`
      DELETE FROM "_prisma_migrations" WHERE migration_name = ${P0_M6_008_MIGRATION_NAME}
    `;
    runPrisma(
      ['db', 'execute', '--file', b5DownPath, '--schema', fullSchemaPath],
      scratchDatabaseUrl,
    );
    await assertM63B5DownBoundary(scratchClient);
    await scratchClient.$executeRaw`
      DELETE FROM "_prisma_migrations" WHERE migration_name = ${B5_MIGRATION_NAME}
    `;
    const b4CatalogAfterB5DownFingerprint = await assertM63B4ReviewBoundary(scratchClient);

    const b4RollbackOperationId = randomUUID();
    const b4RollbackAfterSaleId = randomUUID();
    const b4RollbackOperationRows = await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      return transaction.$executeRaw`
        INSERT INTO after_sale_operations (
          id, store_id, after_sale_id, operation, idempotency_key_hash, request_hash,
          status, result_summary, attempt_count, version, updated_at
        )
        SELECT
          ${b4RollbackOperationId}::uuid, store.id, ${b4RollbackAfterSaleId}::uuid,
          'ADMIN_REVIEW',
          ${createHash('sha256').update('m63-b4-rollback-idempotency').digest('hex')},
          ${createHash('sha256').update('m63-b4-rollback-request').digest('hex')},
          'COMPLETED', '{"migrationGuard":true}'::jsonb, 1, 2, clock_timestamp()
        FROM stores AS store
        ORDER BY store.id
        LIMIT 1
      `;
    });
    if (b4RollbackOperationRows !== 1) {
      fail('M6.3-B4 rollback guard fixture could not create a review operation fact');
    }
    await expectSqlState(
      scratchClient.$executeRawUnsafe(b4DownGuardSql),
      '55000',
      'M6.3-B4 down review-operation fact guard',
    );
    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        DELETE FROM after_sale_operations WHERE id = ${b4RollbackOperationId}::uuid
      `;
    });

    const b4RollbackAuditId = randomUUID();
    const b4RollbackAuditRows = await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      return transaction.$executeRaw`
        INSERT INTO audit_logs (
          id, store_id, actor_type, actor_id, action, target_type, target_id, correlation_id
        )
        SELECT
          ${b4RollbackAuditId}::uuid, store.id, 'SYSTEM'::"AuditActorType",
          '00000000-0000-4000-8000-000000000007'::uuid,
          'after-sale.return.expired', 'after_sale', ${b4RollbackAfterSaleId},
          'm63-b4-rollback-expiration-guard'
        FROM stores AS store
        ORDER BY store.id
        LIMIT 1
      `;
    });
    if (b4RollbackAuditRows !== 1) {
      fail('M6.3-B4 rollback guard fixture could not create an expiration audit fact');
    }
    await expectSqlState(
      scratchClient.$executeRawUnsafe(b4DownGuardSql),
      '55000',
      'M6.3-B4 down expiration-audit fact guard',
    );
    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`DELETE FROM audit_logs WHERE id = ${b4RollbackAuditId}::uuid`;
    });
    const afterB4GuardFingerprint = await assertM63B4ReviewBoundary(scratchClient);
    if (afterB4GuardFingerprint !== b4CatalogAfterB5DownFingerprint) {
      fail('M6.3-B4 rollback fail-fast changed the review security catalog');
    }

    for (const migrationName of [...B4_MIGRATIONS].reverse()) {
      runPrisma(
        [
          'db',
          'execute',
          '--file',
          join(MIGRATIONS_ROOT, migrationName, 'down.sql'),
          '--schema',
          fullSchemaPath,
        ],
        scratchDatabaseUrl,
      );
    }
    await assertM63B4DownBoundary(scratchClient);
    await assertM63B3CommandBoundary(scratchClient);
    await scratchClient.$executeRaw`
      DELETE FROM "_prisma_migrations" WHERE migration_name = ANY(${[...B4_MIGRATIONS]})
    `;
    runPrisma(['migrate', 'deploy', '--schema', fullSchemaPath], scratchDatabaseUrl);
    await assertMigrationState(scratchClient, allMigrationNames);
    const restoredB4CatalogFingerprint = await assertM63B4ReviewBoundary(scratchClient);
    if (restoredB4CatalogFingerprint !== repeatedB4CatalogFingerprint) {
      fail('M6.3-B4 down/forward exercise did not restore the review security catalog');
    }
    const restoredB5CatalogFingerprint = await assertM63B5ReturnBoundary(scratchClient);
    if (restoredB5CatalogFingerprint !== repeatedB5CatalogFingerprint) {
      fail('M6.3-B5 down/forward exercise did not restore the return security catalog');
    }
    const restoredP0M6008AfterB4CatalogFingerprint = await assertP0M6008ReturnInspectionBoundary(
      scratchClient,
      true,
    );
    if (restoredP0M6008AfterB4CatalogFingerprint !== repeatedP0M6008CatalogFingerprint) {
      fail('M6.3-B4 down/forward exercise did not restore the dependent M6.4 catalog');
    }
    const afterB4RoundTripFingerprint = await fixtureFingerprint(scratchClient, fingerprintSql);
    if (afterB4RoundTripFingerprint !== beforeUpgradeFingerprint) {
      fail('M1/M2 fixture fingerprint changed during the M6.3-B4 down/forward exercise');
    }

    const p0M6007GuardStoreId = 'f2000000-0000-4000-8000-000000000001';
    const p0M6007GuardAfterSaleId = 'f2b70000-0000-4000-8000-000000000001';
    const p0M6007GuardOrderId = 'f2b70000-0000-4000-8000-000000000002';
    const p0M6007GuardAdminId = 'f2030000-0000-4000-8000-000000000001';
    const p0M6007GuardSettlementId = 'f2b70000-0000-4000-8000-000000000003';
    const p0M6007GuardReceiptId = 'f2b70000-0000-4000-8000-000000000004';
    const p0M6007GuardConfirmationId = 'f2b70000-0000-4000-8000-000000000005';
    const p0M6007GuardAuditId = 'f2b70000-0000-4000-8000-000000000006';
    const p0M6007GuardRequestedTransitionId = 'f2b70000-0000-4000-8000-000000000007';
    const p0M6007GuardSucceededTransitionId = 'f2b70000-0000-4000-8000-000000000008';
    const p0M6007Hash = (value: string) => createHash('sha256').update(value).digest('hex');

    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        INSERT INTO after_sale_settlements (
          id, store_id, after_sale_id, order_id, public_settlement_number,
          method, status, amount_vnd, currency, idempotency_key_hash, request_hash,
          requested_by, version, requested_at, updated_at
        ) VALUES (
          ${p0M6007GuardSettlementId}::uuid, ${p0M6007GuardStoreId}::uuid,
          ${p0M6007GuardAfterSaleId}::uuid, ${p0M6007GuardOrderId}::uuid,
          'AST-P0M6007DOWNGUARD', 'COD_OFFLINE', 'PENDING', 100000, 'VND',
          ${p0M6007Hash('p0-m6-007-down-settlement-idempotency')},
          ${p0M6007Hash('p0-m6-007-down-settlement-request')},
          ${p0M6007GuardAdminId}::uuid, 1, clock_timestamp(), clock_timestamp()
        )
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });
    await expectSqlState(
      scratchClient.$executeRawUnsafe(p0M6007DownGuardSql),
      '55000',
      'P0-M6-007 down COD settlement fact guard',
    );
    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        DELETE FROM after_sale_settlements WHERE id = ${p0M6007GuardSettlementId}::uuid
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });

    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        INSERT INTO after_sale_cod_refund_receipts (
          id, store_id, settlement_id, after_sale_id, order_id, amount_vnd, currency,
          transfer_reference_digest, transfer_reference_masked, evidence_digest,
          evidence_ciphertext, transferred_at, expected_settlement_version, recorded_by,
          idempotency_key_hash, request_hash, correlation_id, recorded_at
        ) VALUES (
          ${p0M6007GuardReceiptId}::uuid, ${p0M6007GuardStoreId}::uuid,
          ${p0M6007GuardSettlementId}::uuid, ${p0M6007GuardAfterSaleId}::uuid,
          ${p0M6007GuardOrderId}::uuid, 100000, 'VND',
          ${p0M6007Hash('p0-m6-007-down-transfer')}, '***GUARD',
          ${p0M6007Hash('p0-m6-007-down-evidence')}, 'encrypted-guard-evidence',
          clock_timestamp(), 1, ${p0M6007GuardAdminId}::uuid,
          ${p0M6007Hash('p0-m6-007-down-receipt-idempotency')},
          ${p0M6007Hash('p0-m6-007-down-receipt-request')},
          'p0-m6-007-down-receipt', clock_timestamp()
        )
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });
    await expectSqlState(
      scratchClient.$executeRawUnsafe(p0M6007DownGuardSql),
      '55000',
      'P0-M6-007 down receipt fact guard',
    );
    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        DELETE FROM after_sale_cod_refund_receipts WHERE id = ${p0M6007GuardReceiptId}::uuid
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });

    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        INSERT INTO after_sale_cod_refund_confirmations (
          id, store_id, settlement_id, after_sale_id, order_id, amount_vnd,
          expected_after_sale_version, expected_settlement_version,
          result_after_sale_version, result_settlement_version, result_status,
          confirmed_by, idempotency_key_hash, request_hash, correlation_id, confirmed_at
        ) VALUES (
          ${p0M6007GuardConfirmationId}::uuid, ${p0M6007GuardStoreId}::uuid,
          ${p0M6007GuardSettlementId}::uuid, ${p0M6007GuardAfterSaleId}::uuid,
          ${p0M6007GuardOrderId}::uuid, 100000, 2, 1, 4, 2, 'REFUNDED',
          ${p0M6007GuardAdminId}::uuid,
          ${p0M6007Hash('p0-m6-007-down-confirm-idempotency')},
          ${p0M6007Hash('p0-m6-007-down-confirm-request')},
          'p0-m6-007-down-confirm', clock_timestamp()
        )
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });
    await expectSqlState(
      scratchClient.$executeRawUnsafe(p0M6007DownGuardSql),
      '55000',
      'P0-M6-007 down confirmation fact guard',
    );
    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        DELETE FROM after_sale_cod_refund_confirmations
        WHERE id = ${p0M6007GuardConfirmationId}::uuid
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });

    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        INSERT INTO audit_logs (
          id, store_id, actor_type, actor_id, action, target_type, target_id, correlation_id
        ) VALUES (
          ${p0M6007GuardAuditId}::uuid, ${p0M6007GuardStoreId}::uuid,
          'ADMIN', ${p0M6007GuardAdminId}::uuid, 'after-sale.cod-refund.confirmed',
          'after_sale', ${p0M6007GuardAfterSaleId}, 'p0-m6-007-down-audit'
        )
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });
    await expectSqlState(
      scratchClient.$executeRawUnsafe(p0M6007DownGuardSql),
      '55000',
      'P0-M6-007 down audit fact guard',
    );
    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        DELETE FROM audit_logs WHERE id = ${p0M6007GuardAuditId}::uuid
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });

    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        INSERT INTO after_sale_transitions (
          id, store_id, after_sale_id, from_status, to_status, event, actor_type,
          actor_id, correlation_id, created_at
        ) VALUES
          (
            ${p0M6007GuardRequestedTransitionId}::uuid, ${p0M6007GuardStoreId}::uuid,
            ${p0M6007GuardAfterSaleId}::uuid, 'REFUND_PENDING', 'REFUND_PROCESSING',
            'REFUND_REQUESTED', 'ADMIN', ${p0M6007GuardAdminId}::uuid,
            'p0-m6-007-down-transition', '2026-08-01 00:00:00+00'
          ),
          (
            ${p0M6007GuardSucceededTransitionId}::uuid, ${p0M6007GuardStoreId}::uuid,
            ${p0M6007GuardAfterSaleId}::uuid, 'REFUND_PROCESSING', 'REFUNDED',
            'REFUND_SUCCEEDED', 'ADMIN', ${p0M6007GuardAdminId}::uuid,
            'p0-m6-007-down-transition', '2026-08-01 00:00:00.001+00'
          )
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });
    await expectSqlState(
      scratchClient.$executeRawUnsafe(p0M6007DownGuardSql),
      '55000',
      'P0-M6-007 down transition fact guard',
    );
    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        DELETE FROM after_sale_transitions
        WHERE id IN (
          ${p0M6007GuardRequestedTransitionId}::uuid,
          ${p0M6007GuardSucceededTransitionId}::uuid
        )
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });
    const p0M6007CatalogAfterGuards = await assertP0M6007CodRefundBoundary(scratchClient, true);
    if (p0M6007CatalogAfterGuards !== repeatedP0M6007CatalogFingerprint) {
      fail('P0-M6-007 rollback fail-fast changed the COD refund security catalog');
    }

    runPrisma(
      ['db', 'execute', '--file', p0M6008DownPath, '--schema', fullSchemaPath],
      scratchDatabaseUrl,
    );
    await assertP0M6008ReturnInspectionBoundary(scratchClient, false);
    await scratchClient.$executeRaw`
      DELETE FROM "_prisma_migrations" WHERE migration_name = ${P0_M6_008_MIGRATION_NAME}
    `;
    runPrisma(
      ['db', 'execute', '--file', p0M6007DownPath, '--schema', fullSchemaPath],
      scratchDatabaseUrl,
    );
    await assertP0M6007CodRefundBoundary(scratchClient, false);
    await scratchClient.$executeRaw`
      DELETE FROM "_prisma_migrations" WHERE migration_name = ${P0_M6_007_MIGRATION_NAME}
    `;

    // B3 cannot be rolled back while M6.4/B4/B5 functions and triggers still depend on its
    // command boundary. Remove M6.4, B7, B5 and B4, then restore the chain in one deploy.
    runPrisma(
      ['db', 'execute', '--file', b5DownPath, '--schema', fullSchemaPath],
      scratchDatabaseUrl,
    );
    await assertM63B5DownBoundary(scratchClient);
    await scratchClient.$executeRaw`
      DELETE FROM "_prisma_migrations" WHERE migration_name = ${B5_MIGRATION_NAME}
    `;
    for (const migrationName of [...B4_MIGRATIONS].reverse()) {
      runPrisma(
        [
          'db',
          'execute',
          '--file',
          join(MIGRATIONS_ROOT, migrationName, 'down.sql'),
          '--schema',
          fullSchemaPath,
        ],
        scratchDatabaseUrl,
      );
    }
    await assertM63B4DownBoundary(scratchClient);
    await scratchClient.$executeRaw`
      DELETE FROM "_prisma_migrations" WHERE migration_name = ANY(${[...B4_MIGRATIONS]})
    `;

    const b3RollbackOperationId = randomUUID();
    const b3RollbackAfterSaleId = randomUUID();
    const b3RollbackOperationRows = await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      return transaction.$executeRaw`
        INSERT INTO after_sale_operations (
          id, store_id, after_sale_id, operation, idempotency_key_hash, request_hash,
          status, result_summary, attempt_count, version, updated_at
        )
        SELECT
          ${b3RollbackOperationId}::uuid, store.id, ${b3RollbackAfterSaleId}::uuid,
          'MEMBER_CREATE',
          ${createHash('sha256').update('m63-b3-rollback-idempotency').digest('hex')},
          ${createHash('sha256').update('m63-b3-rollback-request').digest('hex')},
          'COMPLETED', '{"migrationGuard":true}'::jsonb, 1, 2, clock_timestamp()
        FROM stores AS store
        ORDER BY store.id
        LIMIT 1
      `;
    });
    if (b3RollbackOperationRows !== 1) {
      fail('M6.3-B3 rollback guard fixture could not create a command operation fact');
    }
    await expectSqlState(
      scratchClient.$executeRawUnsafe(b3DownGuardSql),
      '55000',
      'M6.3-B3 down command-fact guard',
    );
    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        DELETE FROM after_sale_operations WHERE id = ${b3RollbackOperationId}::uuid
      `;
    });
    const afterB3GuardFingerprint = await assertM63B3CommandBoundary(scratchClient);
    if (afterB3GuardFingerprint !== repeatedB3CatalogFingerprint) {
      fail('M6.3-B3 rollback fail-fast changed the command security catalog');
    }

    runPrisma(
      ['db', 'execute', '--file', b3DownPath, '--schema', fullSchemaPath],
      scratchDatabaseUrl,
    );
    await assertM63B3DownBoundary(scratchClient);
    await scratchClient.$executeRaw`
      DELETE FROM "_prisma_migrations" WHERE migration_name = ${B3_MIGRATION_NAME}
    `;
    runPrisma(['migrate', 'deploy', '--schema', fullSchemaPath], scratchDatabaseUrl);
    await assertMigrationState(scratchClient, allMigrationNames);
    const restoredB3CatalogFingerprint = await assertM63B3CommandBoundary(scratchClient);
    if (restoredB3CatalogFingerprint !== repeatedB3CatalogFingerprint) {
      fail('M6.3-B3 down/forward exercise did not restore the command security catalog');
    }
    const restoredB4AfterB3CatalogFingerprint = await assertM63B4ReviewBoundary(scratchClient);
    if (restoredB4AfterB3CatalogFingerprint !== repeatedB4CatalogFingerprint) {
      fail('M6.3-B3 down/forward exercise did not restore the dependent B4 catalog');
    }
    const restoredB5AfterB3CatalogFingerprint = await assertM63B5ReturnBoundary(scratchClient);
    if (restoredB5AfterB3CatalogFingerprint !== repeatedB5CatalogFingerprint) {
      fail('M6.3-B3 down/forward exercise did not restore the dependent B5 catalog');
    }
    const restoredP0M6007AfterB3CatalogFingerprint = await assertP0M6007CodRefundBoundary(
      scratchClient,
      true,
    );
    if (restoredP0M6007AfterB3CatalogFingerprint !== repeatedP0M6007CatalogFingerprint) {
      fail('M6.3-B3 down/forward exercise did not restore the dependent B7 catalog');
    }
    const restoredP0M6008AfterB3CatalogFingerprint = await assertP0M6008ReturnInspectionBoundary(
      scratchClient,
      true,
    );
    if (restoredP0M6008AfterB3CatalogFingerprint !== repeatedP0M6008CatalogFingerprint) {
      fail('M6.3-B3 down/forward exercise did not restore the dependent M6.4 catalog');
    }
    const afterB3RoundTripFingerprint = await fixtureFingerprint(scratchClient, fingerprintSql);
    if (afterB3RoundTripFingerprint !== beforeUpgradeFingerprint) {
      fail('M1/M2 fixture fingerprint changed during the M6.3-B3 down/forward exercise');
    }

    const d5RollbackAuditId = randomUUID();
    const d5RollbackAuditRows = await scratchClient.$executeRaw`
      INSERT INTO audit_logs (
        id, store_id, actor_type, actor_id, action, target_type, correlation_id
      )
      SELECT
        ${d5RollbackAuditId}::uuid,
        store.id,
        'ADMIN'::"AuditActorType",
        '00000000-0000-4000-8000-000000000001'::uuid,
        'after-sale.evidence.protected_read.issued',
        'migration_rollback_guard',
        'm63-b2b-d5-rollback-guard'
      FROM stores AS store
      ORDER BY store.id
      LIMIT 1
    `;
    if (d5RollbackAuditRows !== 1) {
      fail('M6.3-B2b-D5 rollback guard fixture could not create an issued-read audit');
    }
    runPrismaExpectFailure(
      [
        'db',
        'execute',
        '--file',
        join(MIGRATIONS_ROOT, '20260731100000_m63_b2b_d5_commit_deadline_revalidation', 'down.sql'),
        '--schema',
        fullSchemaPath,
      ],
      scratchDatabaseUrl,
      'D5 commit deadline revalidation rollback requires no issued protected-read audit facts',
    );
    runPrismaExpectFailure(
      [
        'db',
        'execute',
        '--file',
        join(MIGRATIONS_ROOT, '20260730105000_m63_b2b_d5_expiry_revalidation', 'down.sql'),
        '--schema',
        fullSchemaPath,
      ],
      scratchDatabaseUrl,
      'D5 expiry revalidation rollback requires no issued protected-read audit facts',
    );
    runPrismaExpectFailure(
      [
        'db',
        'execute',
        '--file',
        join(
          MIGRATIONS_ROOT,
          '20260730104000_m63_b2b_d5_member_authorization_grant_fix',
          'down.sql',
        ),
        '--schema',
        fullSchemaPath,
      ],
      scratchDatabaseUrl,
      'D5 member authorization grant rollback requires no issued protected-read audit facts',
    );
    runPrismaExpectFailure(
      [
        'db',
        'execute',
        '--file',
        join(MIGRATIONS_ROOT, '20260730103000_m63_b2b_d5_authorization_revalidation', 'down.sql'),
        '--schema',
        fullSchemaPath,
      ],
      scratchDatabaseUrl,
      'D5 authorization revalidation rollback requires no issued protected-read audit facts',
    );
    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        DELETE FROM audit_logs WHERE id = ${d5RollbackAuditId}::uuid
      `;
    });

    const financialReconciliationDownPath = join(
      MIGRATIONS_ROOT,
      P0_M5_005_MIGRATION_NAME,
      'down.sql',
    );
    const codReconciliationDownPath = join(
      MIGRATIONS_ROOT,
      P0_M5_005_COD_MIGRATION_NAME,
      'down.sql',
    );
    const reconciliationCloseoutDownPath = join(
      MIGRATIONS_ROOT,
      P0_M5_005_CLOSURE_MIGRATION_NAME,
      'down.sql',
    );
    const codRefundSettlementDownPath = join(MIGRATIONS_ROOT, P0_M6_007_MIGRATION_NAME, 'down.sql');
    runPrisma(
      ['db', 'execute', '--file', p0M6008DownPath, '--schema', fullSchemaPath],
      scratchDatabaseUrl,
    );
    await assertP0M6008ReturnInspectionBoundary(scratchClient, false);
    await scratchClient.$executeRaw`
      DELETE FROM "_prisma_migrations"
      WHERE migration_name = ${P0_M6_008_MIGRATION_NAME}
    `;
    runPrisma(
      ['db', 'execute', '--file', codRefundSettlementDownPath, '--schema', fullSchemaPath],
      scratchDatabaseUrl,
    );
    await assertP0M6007CodRefundBoundary(scratchClient, false);
    await scratchClient.$executeRaw`
      DELETE FROM "_prisma_migrations"
      WHERE migration_name = ${P0_M6_007_MIGRATION_NAME}
    `;
    runPrisma(
      ['db', 'execute', '--file', reconciliationCloseoutDownPath, '--schema', fullSchemaPath],
      scratchDatabaseUrl,
    );
    await assertFinancialReconciliationBoundary(scratchClient, true);
    await assertCodReconciliationBoundary(scratchClient, true);
    await assertFinancialReconciliationReviewBoundary(scratchClient, false);
    await scratchClient.$executeRaw`
      DELETE FROM "_prisma_migrations"
      WHERE migration_name = ${P0_M5_005_CLOSURE_MIGRATION_NAME}
    `;
    runPrisma(
      ['db', 'execute', '--file', codReconciliationDownPath, '--schema', fullSchemaPath],
      scratchDatabaseUrl,
    );
    await assertFinancialReconciliationBoundary(scratchClient, true);
    await assertCodReconciliationBoundary(scratchClient, false);
    await scratchClient.$executeRaw`
      DELETE FROM "_prisma_migrations"
      WHERE migration_name = ${P0_M5_005_COD_MIGRATION_NAME}
    `;
    runPrisma(
      ['db', 'execute', '--file', financialReconciliationDownPath, '--schema', fullSchemaPath],
      scratchDatabaseUrl,
    );
    await assertFinancialReconciliationBoundary(scratchClient, false);
    await scratchClient.$executeRaw`
      DELETE FROM "_prisma_migrations"
      WHERE migration_name = ${P0_M5_005_MIGRATION_NAME}
    `;
    runPrisma(['migrate', 'deploy', '--schema', fullSchemaPath], scratchDatabaseUrl);
    await assertMigrationState(scratchClient, allMigrationNames);
    await assertFinancialReconciliationBoundary(scratchClient, true);
    await assertCodReconciliationBoundary(scratchClient, true);
    await assertFinancialReconciliationReviewBoundary(scratchClient, true);
    const restoredP0M6007AfterFinancialFingerprint = await assertP0M6007CodRefundBoundary(
      scratchClient,
      true,
    );
    if (restoredP0M6007AfterFinancialFingerprint !== repeatedP0M6007CatalogFingerprint) {
      fail('P0-M5-005 down/forward exercise did not restore the dependent B7 catalog');
    }
    const restoredP0M6008AfterFinancialFingerprint = await assertP0M6008ReturnInspectionBoundary(
      scratchClient,
      true,
    );
    if (restoredP0M6008AfterFinancialFingerprint !== repeatedP0M6008CatalogFingerprint) {
      fail('P0-M5-005 down/forward exercise did not restore the dependent M6.4 catalog');
    }
    runPrisma(
      ['db', 'execute', '--file', p0M6008DownPath, '--schema', fullSchemaPath],
      scratchDatabaseUrl,
    );
    await assertP0M6008ReturnInspectionBoundary(scratchClient, false);
    await scratchClient.$executeRaw`
      DELETE FROM "_prisma_migrations"
      WHERE migration_name = ${P0_M6_008_MIGRATION_NAME}
    `;
    runPrisma(
      ['db', 'execute', '--file', codRefundSettlementDownPath, '--schema', fullSchemaPath],
      scratchDatabaseUrl,
    );
    await assertP0M6007CodRefundBoundary(scratchClient, false);
    await scratchClient.$executeRaw`
      DELETE FROM "_prisma_migrations"
      WHERE migration_name = ${P0_M6_007_MIGRATION_NAME}
    `;
    runPrisma(
      ['db', 'execute', '--file', reconciliationCloseoutDownPath, '--schema', fullSchemaPath],
      scratchDatabaseUrl,
    );
    await assertFinancialReconciliationBoundary(scratchClient, true);
    await assertCodReconciliationBoundary(scratchClient, true);
    await assertFinancialReconciliationReviewBoundary(scratchClient, false);
    await scratchClient.$executeRaw`
      DELETE FROM "_prisma_migrations"
      WHERE migration_name = ${P0_M5_005_CLOSURE_MIGRATION_NAME}
    `;
    runPrisma(
      ['db', 'execute', '--file', codReconciliationDownPath, '--schema', fullSchemaPath],
      scratchDatabaseUrl,
    );
    await assertFinancialReconciliationBoundary(scratchClient, true);
    await assertCodReconciliationBoundary(scratchClient, false);
    await scratchClient.$executeRaw`
      DELETE FROM "_prisma_migrations"
      WHERE migration_name = ${P0_M5_005_COD_MIGRATION_NAME}
    `;
    runPrisma(
      ['db', 'execute', '--file', financialReconciliationDownPath, '--schema', fullSchemaPath],
      scratchDatabaseUrl,
    );
    await assertFinancialReconciliationBoundary(scratchClient, false);
    await scratchClient.$executeRaw`
      DELETE FROM "_prisma_migrations"
      WHERE migration_name = ${P0_M5_005_MIGRATION_NAME}
    `;

    for (const migrationName of [...M6_MIGRATIONS].reverse()) {
      runPrisma(
        [
          'db',
          'execute',
          '--file',
          join(MIGRATIONS_ROOT, migrationName, 'down.sql'),
          '--schema',
          fullSchemaPath,
        ],
        scratchDatabaseUrl,
      );
    }
    await assertIndexShape(scratchClient, {
      expectedKeys: ['store_id', 'updated_at DESC', 'id DESC'],
      expectedUnique: false,
      indexName: 'after_sales_store_id_updated_at_id_idx',
      shouldExist: false,
      tableName: 'after_sales',
    });
    await assertIndexShape(scratchClient, {
      expectedKeys: ['store_id', 'updated_at DESC', 'id DESC'],
      expectedUnique: false,
      indexName: 'after_sale_policies_store_id_updated_at_id_idx',
      shouldExist: false,
      tableName: 'after_sale_policies',
    });
    await assertIndexShape(scratchClient, {
      expectedKeys: ['store_id', 'policy_id', 'published_at DESC', 'id DESC'],
      expectedUnique: false,
      indexName: 'after_sale_policy_versions_store_policy_published_id_idx',
      shouldExist: false,
      tableName: 'after_sale_policy_versions',
    });
    const m6DownState = await scratchClient.$queryRaw<
      Array<{
        m6_enum_types: bigint;
        m6_permissions: bigint;
        m6_tables: bigint;
        shipment_m6_columns: bigint;
      }>
    >`
      SELECT
        (SELECT count(*) FROM permissions WHERE code LIKE 'store.after-sales.%')
          AS m6_permissions,
        (SELECT count(*) FROM pg_type
          WHERE typtype = 'e' AND typname = ANY(ARRAY[
            'after_sale_type', 'after_sale_status', 'after_sale_source',
            'after_sale_policy_status', 'after_sale_policy_target_type',
            'return_shipping_payer', 'after_sale_inspection_disposition',
            'after_sale_operation_status', 'after_sale_evidence_status',
            'after_sale_evidence_object_role',
            'after_sale_settlement_method', 'after_sale_settlement_status',
            'after_sale_inventory_action_type', 'after_sale_return_shipment_status',
            'exchange_fulfillment_status', 'after_sale_legacy_decision_type',
            'privacy_request_type', 'privacy_request_status', 'share_target_type',
            'share_interaction_event', 'shipment_purpose'
          ])) AS m6_enum_types,
        (SELECT count(*) FROM pg_class relation
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public' AND relation.relkind IN ('r', 'p')
            AND relation.relname = ANY(ARRAY[
              'store_after_sale_settings', 'after_sale_policies',
              'after_sale_policy_versions', 'after_sale_policy_localizations',
              'after_sale_policy_draft_products', 'after_sale_policy_version_assignments',
              'after_sale_active_policy_assignments',
              'order_item_after_sale_policy_snapshots', 'after_sales', 'after_sale_items',
              'after_sale_transitions', 'after_sale_operations',
              'after_sale_legacy_decisions', 'after_sale_order_allocations',
              'after_sale_inspections', 'after_sale_inspection_allocations',
              'after_sale_evidence_files', 'after_sale_evidence_objects',
              'after_sale_evidence_transitions',
              'after_sale_settlements', 'after_sale_refunds',
              'after_sale_inventory_actions', 'after_sale_return_shipments',
              'exchange_fulfillments', 'member_favorites', 'member_product_views',
              'privacy_requests', 'privacy_request_transitions', 'share_links',
              'share_link_localizations', 'share_interactions'
            ])) AS m6_tables,
        (SELECT count(*) FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'shipments'
            AND column_name IN ('purpose', 'after_sale_id')) AS shipment_m6_columns
    `;
    if (
      m6DownState[0]?.m6_tables !== 0n ||
      m6DownState[0]?.m6_permissions !== 0n ||
      m6DownState[0]?.m6_enum_types !== 0n ||
      m6DownState[0]?.shipment_m6_columns !== 0n
    ) {
      fail('M6.2 down exercise did not restore the M5 schema boundary');
    }

    await scratchClient.$executeRaw`
      DELETE FROM "_prisma_migrations"
      WHERE migration_name = ANY(${[...M6_MIGRATIONS]})
    `;

    for (const migrationName of [...M5_MIGRATIONS].reverse()) {
      runPrisma(
        [
          'db',
          'execute',
          '--file',
          join(MIGRATIONS_ROOT, migrationName, 'down.sql'),
          '--schema',
          fullSchemaPath,
        ],
        scratchDatabaseUrl,
      );
    }
    const downState = await scratchClient.$queryRaw<
      Array<{ m5_permissions: bigint; m5_table: string | null; partial_refund_enum: bigint }>
    >`
      SELECT
        to_regclass('public.payment_attempts')::text AS m5_table,
        (SELECT count(*) FROM permissions WHERE code LIKE 'store.payments.%'
          OR code LIKE 'store.refunds.%' OR code LIKE 'store.shipments.%'
          OR code LIKE 'store.integrations.%' OR code = 'store.integration-jobs.retry') AS m5_permissions,
        (SELECT count(*) FROM pg_enum enum_value
          JOIN pg_type enum_type ON enum_type.oid = enum_value.enumtypid
          WHERE enum_type.typname = 'order_payment_status'
            AND enum_value.enumlabel IN ('PARTIALLY_REFUNDED', 'FULLY_REFUNDED')) AS partial_refund_enum
    `;
    if (
      downState[0]?.m5_table !== null ||
      downState[0]?.m5_permissions !== 0n ||
      downState[0]?.partial_refund_enum !== 0n
    ) {
      fail('M5 down exercise did not restore the M4 schema boundary');
    }

    await scratchClient.$executeRaw`
      DELETE FROM "_prisma_migrations"
      WHERE migration_name = ANY(${[...M5_MIGRATIONS]})
    `;
    runPrisma(['migrate', 'deploy', '--schema', fullSchemaPath], scratchDatabaseUrl);
    await assertMigrationState(scratchClient, allMigrationNames);
    await assertM63B1ReadIndexes(scratchClient);
    await assertM63B2ReadIndexes(scratchClient);
    await assertM63B2bD0Indexes(scratchClient);
    await assertM63B2bD5ProtectedReadLock(scratchClient);
    await assertM63B3CommandBoundary(scratchClient);
    await assertM63B4ReviewBoundary(scratchClient);
    await assertM63B5ReturnBoundary(scratchClient);
    await assertFinancialReconciliationBoundary(scratchClient, true);
    await assertCodReconciliationBoundary(scratchClient, true);
    await assertFinancialReconciliationReviewBoundary(scratchClient, true);
    const restoredP0M6007AfterM5M6Fingerprint = await assertP0M6007CodRefundBoundary(
      scratchClient,
      true,
    );
    if (restoredP0M6007AfterM5M6Fingerprint !== repeatedP0M6007CatalogFingerprint) {
      fail('M5/M6 forward repair did not restore the P0-M6-007 security catalog');
    }
    const restoredP0M6008AfterM5M6Fingerprint = await assertP0M6008ReturnInspectionBoundary(
      scratchClient,
      true,
    );
    if (restoredP0M6008AfterM5M6Fingerprint !== repeatedP0M6008CatalogFingerprint) {
      fail('M5/M6 forward repair did not restore the P0-M6-008 security catalog');
    }
    const afterForwardRepairFingerprint = await fixtureFingerprint(scratchClient, fingerprintSql);
    if (afterForwardRepairFingerprint !== beforeUpgradeFingerprint) {
      fail('M1/M2 fixture fingerprint changed during the M5/M6 forward repair exercise');
    }

    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        INSERT INTO after_sale_evidence_files (
          id, store_id, member_id, upload_session_id, object_key, mime_type, byte_size,
          checksum_sha256, original_filename, status, upload_deadline_at, updated_at
        ) VALUES (
          ${d0EvidenceId}::uuid, ${d0StoreId}::uuid, ${d0MemberId}::uuid,
          ${randomUUID()}::uuid, ${d0ObjectKey}, 'image/jpeg', 1024,
          ${createHash('sha256').update('m63-b2b-d0-down-evidence').digest('hex')},
          'down-evidence-guard.jpg', 'PENDING', clock_timestamp() + interval '15 minutes',
          clock_timestamp()
        )
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });
    await expectSqlState(
      scratchClient.$executeRawUnsafe(d0DownGuardSql),
      '55000',
      'M6.3-B2b-D0 down evidence-file guard',
    );
    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        DELETE FROM after_sale_evidence_files
        WHERE store_id = ${d0StoreId}::uuid AND id = ${d0EvidenceId}::uuid
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });

    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        INSERT INTO after_sale_evidence_objects (
          id, store_id, evidence_file_id, object_role, object_key, object_key_hash, updated_at
        ) VALUES (
          ${d0LedgerId}::uuid, ${d0StoreId}::uuid, ${d0EvidenceId}::uuid, 'ORIGINAL',
          ${d0ObjectKey}, ${createHash('sha256').update(d0ObjectKey).digest('hex')},
          clock_timestamp()
        )
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });
    await expectSqlState(
      scratchClient.$executeRawUnsafe(d0DownGuardSql),
      '55000',
      'M6.3-B2b-D0 down evidence-object ledger guard',
    );
    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        DELETE FROM after_sale_evidence_objects
        WHERE store_id = ${d0StoreId}::uuid AND id = ${d0LedgerId}::uuid
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });

    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        INSERT INTO after_sale_evidence_transitions (
          id, store_id, evidence_file_id, from_status, to_status, event, actor_type,
          actor_id, error_code, correlation_id, evidence_version, scan_generation
        ) VALUES (
          ${d0TransitionId}::uuid, ${d0StoreId}::uuid, ${d0EvidenceId}::uuid,
          'PENDING', 'FAILED', 'SCAN_FAILED', 'SYSTEM',
          '00000000-0000-4000-8000-000000000006'::uuid, 'DOWN_TRANSITION_GUARD',
          'm63-b2b-d0-down-transition', 1, 0
        )
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });
    await expectSqlState(
      scratchClient.$executeRawUnsafe(d0DownGuardSql),
      '55000',
      'M6.3-B2b-D0 down transition guard',
    );
    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        DELETE FROM after_sale_evidence_transitions
        WHERE store_id = ${d0StoreId}::uuid AND id = ${d0TransitionId}::uuid
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });

    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        INSERT INTO outbox_messages (
          id, store_id, aggregate_type, aggregate_id, event_type, event_version,
          idempotency_key, payload, available_at, max_attempts, updated_at
        ) VALUES (
          ${d0OutboxId}::uuid, ${d0StoreId}::uuid, 'AFTER_SALE_EVIDENCE',
          ${d0EvidenceId}::uuid, 'migration.guard.aggregate-only', 1,
          'm63-b2b-d0-down-aggregate-only', '{"guard":"aggregate-only"}'::jsonb,
          clock_timestamp(), 3, clock_timestamp()
        )
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });
    await expectSqlState(
      scratchClient.$executeRawUnsafe(d0DownGuardSql),
      '55000',
      'M6.3-B2b-D0 down aggregate-only outbox guard',
    );
    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        DELETE FROM outbox_messages
        WHERE store_id = ${d0StoreId}::uuid AND id = ${d0OutboxId}::uuid
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });

    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        INSERT INTO idempotency_records (
          id, store_id, member_id, operation, idempotency_key, request_hash, response, expires_at
        ) VALUES (
          ${d0IdempotencyId}::uuid, ${d0StoreId}::uuid, ${d0MemberId}::uuid,
          'after-sale-evidence-migration-guard', 'm63-b2b-d0-down-idempotency',
          ${createHash('sha256').update('m63-b2b-d0-down-idempotency').digest('hex')},
          '{"guard":"idempotency"}'::jsonb, clock_timestamp() + interval '1 day'
        )
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });
    await expectSqlState(
      scratchClient.$executeRawUnsafe(d0DownGuardSql),
      '55000',
      'M6.3-B2b-D0 down idempotency guard',
    );
    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        DELETE FROM idempotency_records
        WHERE store_id = ${d0StoreId}::uuid AND id = ${d0IdempotencyId}::uuid
      `;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });

    const [cleanD0EvidenceRuntime] = await scratchClient.$queryRaw<
      Array<{
        evidence_count: bigint;
        idempotency_count: bigint;
        ledger_count: bigint;
        outbox_count: bigint;
        transition_count: bigint;
      }>
    >`
      SELECT
        (SELECT count(*) FROM after_sale_evidence_files) AS evidence_count,
        (SELECT count(*) FROM after_sale_evidence_objects) AS ledger_count,
        (SELECT count(*) FROM after_sale_evidence_transitions) AS transition_count,
        (SELECT count(*) FROM outbox_messages
          WHERE aggregate_type = 'AFTER_SALE_EVIDENCE'
             OR event_type LIKE 'after-sale.evidence.%') AS outbox_count,
        (SELECT count(*) FROM idempotency_records
          WHERE operation LIKE 'after-sale-evidence-%') AS idempotency_count
    `;
    if (
      cleanD0EvidenceRuntime?.evidence_count !== 0n ||
      cleanD0EvidenceRuntime.ledger_count !== 0n ||
      cleanD0EvidenceRuntime.transition_count !== 0n ||
      cleanD0EvidenceRuntime.outbox_count !== 0n ||
      cleanD0EvidenceRuntime.idempotency_count !== 0n
    ) {
      fail('the M6.3-B2b-D0 down guard fixtures were not independently cleaned');
    }

    runPrisma(
      ['db', 'execute', '--file', d0DownPath, '--schema', fullSchemaPath],
      scratchDatabaseUrl,
    );
    await scratchClient.$executeRaw`
      DELETE FROM "_prisma_migrations"
      WHERE migration_name = ${d0MigrationName}
    `;
    runPrisma(['migrate', 'deploy', '--schema', fullSchemaPath], scratchDatabaseUrl);
    await assertMigrationState(scratchClient, allMigrationNames);
    await assertM63B2bD0Indexes(scratchClient);
    await assertM63B3CommandBoundary(scratchClient);
    await assertM63B4ReviewBoundary(scratchClient);
    await assertM63B5ReturnBoundary(scratchClient);
    await assertFinancialReconciliationBoundary(scratchClient, true);
    await assertCodReconciliationBoundary(scratchClient, true);
    await assertFinancialReconciliationReviewBoundary(scratchClient, true);
    await assertP0M6007CodRefundBoundary(scratchClient, true);
    const [d0RoundTripShape] = await scratchClient.$queryRaw<
      Array<{ ledger_exists: boolean; object_role_exists: boolean }>
    >`
      SELECT
        to_regclass('public.after_sale_evidence_objects') IS NOT NULL AS ledger_exists,
        EXISTS (
          SELECT 1 FROM pg_type type
          JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
          WHERE namespace.nspname = 'public'
            AND type.typname = 'after_sale_evidence_object_role'
        ) AS object_role_exists
    `;
    if (!d0RoundTripShape?.ledger_exists || !d0RoundTripShape.object_role_exists) {
      fail('M6.3-B2b-D0 down/forward exercise did not restore its schema objects');
    }
    const afterD0RoundTripFingerprint = await fixtureFingerprint(scratchClient, fingerprintSql);
    if (afterD0RoundTripFingerprint !== beforeUpgradeFingerprint) {
      fail('M1/M2 fixture fingerprint changed during the D0 down/forward exercise');
    }

    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`
        SELECT
          set_config('app.store_id', 'f2000000-0000-4000-8000-000000000001', true),
          set_config('app.actor_type', 'member', true),
          set_config('app.actor_id', 'f2020000-0000-4000-8000-000000000001', true)
      `;
      await transaction.$executeRaw`
        INSERT INTO member_favorites (store_id, member_id, product_id, created_at)
        VALUES (
          'f2000000-0000-4000-8000-000000000001',
          'f2020000-0000-4000-8000-000000000001',
          'f2400000-0000-4000-8000-000000000001',
          '2026-07-27 02:00:00+00'
        )
      `;
      await transaction.$executeRaw`
        INSERT INTO privacy_requests (
          id, store_id, member_id, public_number, type, description_ciphertext,
          idempotency_key_hash, request_hash, created_at, updated_at
        ) VALUES (
          'f2c00000-0000-4000-8000-000000000001',
          'f2000000-0000-4000-8000-000000000001',
          'f2020000-0000-4000-8000-000000000001',
          'PRV-M62DOWNGUARD0001',
          'ACCESS',
          'encrypted-migration-rollback-fixture',
          repeat('a', 64),
          repeat('b', 64),
          '2026-07-27 02:00:00+00',
          '2026-07-27 02:00:00+00'
        )
      `;
    });
    await scratchClient.$transaction(async (transaction) => {
      const settingsGuardAdminId = 'f2030000-0000-4000-8000-000000000008';
      await transaction.adminUser.create({
        data: {
          displayName: 'M6.3 settings rollback guard admin',
          email: 'm63-settings-rollback-guard@example.test',
          emailNormalized: 'm63-settings-rollback-guard@example.test',
          id: settingsGuardAdminId,
          passwordHash: 'test-fixture-not-used',
        },
      });
      await transaction.$executeRaw`
        SELECT
          set_config('app.store_id', 'f2000000-0000-4000-8000-000000000001', true),
          set_config('app.actor_type', 'admin', true),
          set_config('app.actor_id', ${settingsGuardAdminId}, true),
          set_config('app.correlation_id', 'm63-b0-rollback-guard', true)
      `;
      await transaction.$executeRaw`
        UPDATE store_after_sale_settings
        SET updated_by = ${settingsGuardAdminId}::uuid, version = 2, updated_at = now()
        WHERE store_id = 'f2000000-0000-4000-8000-000000000001'::uuid
      `;
      const legacyGuardOrder = await transaction.order.create({
        data: {
          baseSubtotalVnd: 100_000,
          couponDiscountVnd: 0,
          currency: 'VND',
          itemDiscountVnd: 0,
          memberId: 'f2020000-0000-4000-8000-000000000001',
          orderDiscountVnd: 0,
          orderNumber: 'M63-B0-ROLLBACK-GUARD',
          payableVnd: 100_000,
          paymentMethod: 'ONLINE',
          paymentStatus: 'SUCCEEDED',
          quoteHash: createHash('sha256').update('m63-b0-rollback-guard').digest('hex'),
          remoteSurchargeVnd: 0,
          shippingDiscountVnd: 0,
          shippingFeeVnd: 0,
          status: 'PENDING_FULFILLMENT',
          storeId: 'f2000000-0000-4000-8000-000000000001',
        },
      });
      await transaction.$executeRaw`
        INSERT INTO after_sales (
          id, store_id, order_id, member_id, public_case_number, type, status, source,
          reason_code, legacy_policy_review, idempotency_key_hash, request_hash,
          initiated_by, correlation_id, updated_at
        ) VALUES (
          'f2d00000-0000-4000-8000-000000000001',
          'f2000000-0000-4000-8000-000000000001',
          ${legacyGuardOrder.id}::uuid,
          'f2020000-0000-4000-8000-000000000001',
          'ASC-M63B0ROLLBACK0001',
          'REFUND_ONLY', 'REVIEW_REQUIRED', 'ADMIN', 'm63-b0-legacy-rollback-guard',
          true,
          ${createHash('sha256').update('m63-b0-rollback-key').digest('hex')},
          ${createHash('sha256').update('m63-b0-rollback-request').digest('hex')},
          ${settingsGuardAdminId}::uuid, 'm63-b0-rollback-guard', now()
        )
      `;
    });
    await expectSqlState(
      scratchClient.$executeRaw`SELECT app_security.assert_m62_rollback_safe()`,
      '55000',
      'M6.2 rollback guard',
    );
    runPrismaExpectFailure(
      [
        'db',
        'execute',
        '--file',
        join(MIGRATIONS_ROOT, '20260728104000_m63_b0_after_sale_contract_guards', 'down.sql'),
        '--schema',
        fullSchemaPath,
      ],
      scratchDatabaseUrl,
      'M6.3-B0 rollback requires an empty local/test after-sale runtime scope',
    );
    runPrismaExpectFailure(
      [
        'db',
        'execute',
        '--file',
        join(MIGRATIONS_ROOT, '20260728103000_m63_policy_settings_provisioning', 'down.sql'),
        '--schema',
        fullSchemaPath,
      ],
      scratchDatabaseUrl,
      'M6.3 policy settings-provisioning rollback requires an empty local/test policy scope',
    );
    runPrismaExpectFailure(
      [
        'db',
        'execute',
        '--file',
        join(MIGRATIONS_ROOT, '20260728102000_m63_policy_settings_lock', 'down.sql'),
        '--schema',
        fullSchemaPath,
      ],
      scratchDatabaseUrl,
      'M6.3 policy settings-lock rollback requires an empty local/test policy scope',
    );
    runPrismaExpectFailure(
      [
        'db',
        'execute',
        '--file',
        join(MIGRATIONS_ROOT, '20260728101000_m63_policy_settings_rows', 'down.sql'),
        '--schema',
        fullSchemaPath,
      ],
      scratchDatabaseUrl,
      'M6.3 policy settings-row rollback requires an empty local/test policy scope',
    );
    runPrismaExpectFailure(
      [
        'db',
        'execute',
        '--file',
        join(
          MIGRATIONS_ROOT,
          '20260727120000_m62_capacity_scope_and_approval_occupancy_fix',
          'down.sql',
        ),
        '--schema',
        fullSchemaPath,
      ],
      scratchDatabaseUrl,
      'M6.2 foundation rollback is unsafe after business facts exist',
    );
    runPrismaExpectFailure(
      [
        'db',
        'execute',
        '--file',
        join(MIGRATIONS_ROOT, '20260727119000_m62_order_lock_order_closeout', 'down.sql'),
        '--schema',
        fullSchemaPath,
      ],
      scratchDatabaseUrl,
      'M6.2 foundation rollback is unsafe after business facts exist',
    );
    runPrismaExpectFailure(
      [
        'db',
        'execute',
        '--file',
        join(MIGRATIONS_ROOT, '20260727118000_m62_capacity_allocation_expression_fix', 'down.sql'),
        '--schema',
        fullSchemaPath,
      ],
      scratchDatabaseUrl,
      'M6.2 foundation rollback is unsafe after business facts exist',
    );
    runPrismaExpectFailure(
      [
        'db',
        'execute',
        '--file',
        join(MIGRATIONS_ROOT, '20260727117000_m62_capacity_allocation_runtime_fix', 'down.sql'),
        '--schema',
        fullSchemaPath,
      ],
      scratchDatabaseUrl,
      'M6.2 foundation rollback is unsafe after business facts exist',
    );
    runPrismaExpectFailure(
      [
        'db',
        'execute',
        '--file',
        join(MIGRATIONS_ROOT, '20260727116000_m62_capacity_allocation_closeout', 'down.sql'),
        '--schema',
        fullSchemaPath,
      ],
      scratchDatabaseUrl,
      'M6.2 foundation rollback is unsafe after business facts exist',
    );
    runPrismaExpectFailure(
      [
        'db',
        'execute',
        '--file',
        join(MIGRATIONS_ROOT, '20260727115000_m62_integrity_closeout', 'down.sql'),
        '--schema',
        fullSchemaPath,
      ],
      scratchDatabaseUrl,
      'M6.2 integrity closeout rollback is unsafe after business facts exist',
    );
    runPrismaExpectFailure(
      [
        'db',
        'execute',
        '--file',
        join(MIGRATIONS_ROOT, '20260727114000_m62_runtime_member_scope', 'down.sql'),
        '--schema',
        fullSchemaPath,
      ],
      scratchDatabaseUrl,
      'M6.2 runtime member scope rollback is unsafe after business facts exist',
    );
    runPrismaExpectFailure(
      [
        'db',
        'execute',
        '--file',
        join(MIGRATIONS_ROOT, '20260727113000_m62_integrity_forward_fix', 'down.sql'),
        '--schema',
        fullSchemaPath,
      ],
      scratchDatabaseUrl,
      'M6.2 integrity forward-fix rollback is unsafe after business facts exist',
    );
    runPrismaExpectFailure(
      [
        'db',
        'execute',
        '--file',
        join(MIGRATIONS_ROOT, '20260727112000_m62_integrity_and_snapshot_guards', 'down.sql'),
        '--schema',
        fullSchemaPath,
      ],
      scratchDatabaseUrl,
      'M6.2 integrity rollback is unsafe after business facts exist',
    );
    runPrismaExpectFailure(
      [
        'db',
        'execute',
        '--file',
        join(MIGRATIONS_ROOT, '20260727111000_m62_permission_catalog', 'down.sql'),
        '--schema',
        fullSchemaPath,
      ],
      scratchDatabaseUrl,
      'M6.2 permission rollback is unsafe after business facts exist',
    );
    runPrismaExpectFailure(
      [
        'db',
        'execute',
        '--file',
        join(MIGRATIONS_ROOT, '20260727110000_m62_after_sales_member_share_foundation', 'down.sql'),
        '--schema',
        fullSchemaPath,
      ],
      scratchDatabaseUrl,
      'M6.2 foundation rollback is unsafe after business facts exist',
    );

    await scratchClient.$transaction(async (transaction) => {
      await transaction.$executeRaw`
        SELECT set_config('app.store_id', 'f2000000-0000-4000-8000-000000000001', true)
      `;
      await transaction.$executeRaw`
        INSERT INTO store_shipping_channels (
          store_id, provider_environment, provider_code, shop_id, token_secret_ref,
          secret_fingerprint, key_version, status, origin_allowlist_key, updated_at
        ) VALUES (
          'f2000000-0000-4000-8000-000000000001', 'SANDBOX', 'GHN',
          'm56-down-guard-shop', 'test://m56/down-guard/token',
          ${'e'.repeat(64)}, 'test-v1', 'DISABLED', 'GHN_SANDBOX', now()
        )
      `;
      await transaction.$executeRaw`
        INSERT INTO store_zalo_apps (
          store_id, environment, mini_app_id, enabled, created_at, updated_at
        ) VALUES (
          'f2000000-0000-4000-8000-000000000001', 'TEST',
          'm52-down-guard-app', false, now(), now()
        )
      `;
      await transaction.$executeRaw`
        INSERT INTO store_payment_channels (
          store_id, deployment_environment, provider_environment, provider_code,
          method_code, checkout_app_id, merchant_reference, private_key_secret_ref,
          secret_fingerprint, key_version, status, payment_window_seconds, updated_at
        ) VALUES (
          'f2000000-0000-4000-8000-000000000001', 'TEST', 'SANDBOX',
          'ZALO_CHECKOUT_ZALOPAY', 'ZALOPAY_SANDBOX', 'm52-down-guard-app',
          'm52-test-merchant', 'test://m52/down-guard/private-key',
          ${'d'.repeat(64)}, 'test-v1', 'DISABLED', 900, now()
        )
      `;
      await transaction.$executeRaw`
        INSERT INTO provider_callbacks (
          store_id, channel_kind, channel_id, provider_code, environment,
          external_event_id, event_digest, signature_status, trust, payload_digest
        ) VALUES (
          'f2000000-0000-4000-8000-000000000001', 'PAYMENT',
          (SELECT id FROM store_payment_channels WHERE checkout_app_id = 'm52-down-guard-app'),
          'ZALO_CHECKOUT_ZALOPAY', 'SANDBOX', ${`zc:${'a'.repeat(64)}`},
          ${'b'.repeat(64)}, 'VERIFIED', 'AUTHENTICATED_FACT', ${'c'.repeat(64)}
        )
      `;

      const refundGuardAdmin = await transaction.adminUser.create({
        data: {
          displayName: 'M5.7 rollback guard admin',
          email: 'm57-rollback-guard@example.test',
          emailNormalized: 'm57-rollback-guard@example.test',
          id: 'f2030000-0000-4000-8000-000000000001',
          passwordHash: 'test-fixture-not-used',
        },
      });
      const refundGuardOrder = await transaction.order.create({
        data: {
          baseSubtotalVnd: 100_000,
          couponDiscountVnd: 0,
          currency: 'VND',
          itemDiscountVnd: 0,
          memberId: 'f2020000-0000-4000-8000-000000000001',
          orderDiscountVnd: 0,
          orderNumber: 'M57-ROLLBACK-GUARD',
          payableVnd: 100_000,
          paymentMethod: 'ONLINE',
          paymentStatus: 'SUCCEEDED',
          quoteHash: createHash('sha256').update('m57-rollback-guard-quote').digest('hex'),
          remoteSurchargeVnd: 0,
          shippingDiscountVnd: 0,
          shippingFeeVnd: 0,
          status: 'PENDING_FULFILLMENT',
          storeId: 'f2000000-0000-4000-8000-000000000001',
        },
      });
      const refundGuardChannel = await transaction.storePaymentChannel.findFirstOrThrow({
        where: { checkoutAppId: 'm52-down-guard-app' },
      });
      const refundGuardPayment = await transaction.paymentAttempt.create({
        data: {
          amountVnd: 100_000,
          attemptSequence: 1,
          channelId: refundGuardChannel.id,
          correlationId: 'm57-rollback-guard-payment',
          createIdempotencyKeyHash: createHash('sha256')
            .update('m57-rollback-guard-payment-key')
            .digest('hex'),
          expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
          orderId: refundGuardOrder.id,
          providerOrderId: 'm57-rollback-guard-order',
          providerTransactionId: 'm57-rollback-guard-transaction',
          publicPaymentNumber: 'PAY-M57-ROLLBACK-GUARD',
          status: 'SUCCEEDED',
          storeId: 'f2000000-0000-4000-8000-000000000001',
          succeededAt: new Date(),
        },
      });
      await transaction.refund.create({
        data: {
          amountVnd: 80_000,
          idempotencyKeyHash: createHash('sha256')
            .update('m57-rollback-guard-refund-key')
            .digest('hex'),
          orderId: refundGuardOrder.id,
          paymentAttemptId: refundGuardPayment.id,
          publicRefundNumber: 'RFD-M57-ROLLBACK-GUARD',
          reason: 'Ambiguous refund must block unsafe guard rollback',
          reviewRequiredAt: new Date('2026-07-27T00:05:00.000Z'),
          requestedBy: refundGuardAdmin.id,
          status: 'REVIEW_REQUIRED',
          storeId: 'f2000000-0000-4000-8000-000000000001',
        },
      });
    });
    runPrismaExpectFailure(
      [
        'db',
        'execute',
        '--file',
        join(MIGRATIONS_ROOT, '20260727001000_m57_refund_review_capacity_guard', 'down.sql'),
        '--schema',
        fullSchemaPath,
      ],
      scratchDatabaseUrl,
      'M5.7 refund review-capacity rollback is unsafe after review facts exist',
    );
    runPrismaExpectFailure(
      [
        'db',
        'execute',
        '--file',
        join(MIGRATIONS_ROOT, '20260726130000_m56_shipping_fulfillment_facts', 'down.sql'),
        '--schema',
        fullSchemaPath,
      ],
      scratchDatabaseUrl,
      'M5.6 fulfillment-fact rollback is unsafe after business facts exist',
    );
    runPrismaExpectFailure(
      [
        'db',
        'execute',
        '--file',
        join(MIGRATIONS_ROOT, '20260726120000_m55_payment_callback_channel_resolver', 'down.sql'),
        '--schema',
        fullSchemaPath,
      ],
      scratchDatabaseUrl,
      'M5.5 callback resolver rollback is unsafe after callback facts exist',
    );
    runPrismaExpectFailure(
      [
        'db',
        'execute',
        '--file',
        join(MIGRATIONS_ROOT, '20260725093000_m52_permission_catalog', 'down.sql'),
        '--schema',
        fullSchemaPath,
      ],
      scratchDatabaseUrl,
      'M5 permission rollback is unsafe after channel or business facts exist',
    );

    await scratchClient.$disconnect();
    scratchClient = undefined;
    await dropScratchDatabase(adminClient, scratchDatabaseName);
    validateScratchDatabaseName(scratchDatabaseName);
    await adminClient.$executeRawUnsafe(`CREATE DATABASE "${scratchDatabaseName}"`);
    runPrisma(['migrate', 'deploy', '--schema', fullSchemaPath], scratchDatabaseUrl);
    scratchClient = new PrismaClient({ datasourceUrl: scratchDatabaseUrl.toString() });
    await scratchClient.$connect();
    await assertScratchConnection(scratchClient, scratchDatabaseName);
    await assertMigrationState(scratchClient, allMigrationNames);
    await assertM63B1ReadIndexes(scratchClient);
    await assertM63B2ReadIndexes(scratchClient);
    await assertM63B2bD0Indexes(scratchClient);
    await assertM63B2bD5ProtectedReadLock(scratchClient);
    await assertM63B3CommandBoundary(scratchClient);
    await assertM63B4ReviewBoundary(scratchClient);
    await assertM63B5ReturnBoundary(scratchClient);
    await assertFinancialReconciliationBoundary(scratchClient, true);
    await assertCodReconciliationBoundary(scratchClient, true);
    await assertFinancialReconciliationReviewBoundary(scratchClient, true);
    await assertP0M6007CodRefundBoundary(scratchClient, true);
    await assertP0M6008ReturnInspectionBoundary(scratchClient, true);

    console.log(
      `[m2-upgrade] verified ${String(allMigrationNames.length)} migrations, fresh deploy, M5/M6 down/forward repair, B3 historical policy preflight, B4 review/expiration, B5 return-trust, P0-M5-005 reconciliation, P0-M6-007 COD refund and P0-M6-008 inspection catalog restoration and rollback guards`,
    );
  } catch (error) {
    primaryError = asError(error);
  } finally {
    if (scratchClient) {
      try {
        await scratchClient.$disconnect();
      } catch (error) {
        cleanupErrors.push(asError(error));
      }
    }
    if (scratchCreateAttempted && !scratchNameCollision) {
      try {
        await dropScratchDatabase(adminClient, scratchDatabaseName);
      } catch (error) {
        cleanupErrors.push(asError(error));
      }
    }
    if (tempDirectory) {
      try {
        assertPathWithin(TMP_ROOT, tempDirectory);
        if (!basename(tempDirectory).startsWith('m2-upgrade-')) {
          fail('temporary migration directory has an unexpected name');
        }
        await assertSafeTemporaryDirectory(tempDirectory);
        await rm(tempDirectory, { force: true, recursive: true });
      } catch (error) {
        cleanupErrors.push(asError(error));
      }
    }
    try {
      await adminClient.$disconnect();
    } catch (error) {
      cleanupErrors.push(asError(error));
    }
  }

  if (primaryError && cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      `[m2-upgrade] test failed and cleanup also failed for ${scratchDatabaseName}`,
    );
  }
  if (primaryError) throw primaryError;
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      `[m2-upgrade] cleanup failed for ${scratchDatabaseName}`,
    );
  }
  console.log('[m2-upgrade] scratch database and temporary migration tree were removed');
}

void run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
