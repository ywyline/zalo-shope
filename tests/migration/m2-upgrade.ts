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
    fail(`${context} did not return SQLSTATE ${expectedSqlState}`);
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

async function preflightOwner(client: PrismaClientType): Promise<void> {
  const records = await client.$queryRawUnsafe<OwnerPreflightRecord[]>(`
    SELECT
      current_database() AS database_name,
      current_user AS user_name,
      current_setting('server_version_num')::integer AS server_version_num,
      COALESCE((SELECT rolsuper OR rolcreatedb FROM pg_roles WHERE rolname = current_user), false)
        AS can_create_database,
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
  if (!record.can_create_database || !record.runtime_role_exists) {
    fail('local migration owner or runtime role provisioning is incomplete');
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
  const ownerDatabaseUrl = validateOwnerUrl();
  const allMigrationNames = await migrationDirectories();
  if (M2_MIGRATIONS.some((migrationName, index) => allMigrationNames[index] !== migrationName)) {
    fail('the tracked migration prefix no longer matches the approved M2 boundary');
  }
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
    const [d0MigrationSql, d0DownSql] = await Promise.all([
      readFile(d0MigrationPath, 'utf8'),
      readFile(d0DownPath, 'utf8'),
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

    runPrisma(['migrate', 'deploy', '--schema', fullSchemaPath], scratchDatabaseUrl);
    await assertMigrationState(scratchClient, allMigrationNames);
    await assertM63B1ReadIndexes(scratchClient);
    await assertM63B2ReadIndexes(scratchClient);
    await assertM63B2bD0Indexes(scratchClient);
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
    const afterRepeatFingerprint = await fixtureFingerprint(scratchClient, fingerprintSql);
    if (afterRepeatFingerprint !== beforeUpgradeFingerprint) {
      fail('M1/M2 fixture fingerprint changed during repeated deployment');
    }

    runPrisma(
      ['db', 'execute', '--file', ASSERTIONS_SQL_PATH, '--schema', fullSchemaPath],
      scratchDatabaseUrl,
    );

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

    console.log(
      `[m2-upgrade] verified ${String(allMigrationNames.length)} migrations, fresh deploy, M5/M6 down/forward repair and rollback guards`,
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
