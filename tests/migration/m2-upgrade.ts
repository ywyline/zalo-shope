import { createHash, randomBytes } from 'node:crypto';
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

type MigrationRecord = {
  applied_steps_count: number;
  checksum: string;
  finished_at: Date | null;
  logs: string | null;
  migration_name: string;
  rolled_back_at: Date | null;
};

type FingerprintRecord = { fingerprint: string };

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

async function createM2MigrationTree(tempDirectory: string): Promise<string> {
  const tempMigrationsRoot = join(tempDirectory, 'migrations');
  await mkdir(tempMigrationsRoot, { recursive: true });
  await copyFile(join(PRISMA_ROOT, 'schema.prisma'), join(tempDirectory, 'schema.prisma'));
  await copyFile(
    join(MIGRATIONS_ROOT, 'migration_lock.toml'),
    join(tempMigrationsRoot, 'migration_lock.toml'),
  );
  for (const migrationName of M2_MIGRATIONS) {
    await cp(join(MIGRATIONS_ROOT, migrationName), join(tempMigrationsRoot, migrationName), {
      recursive: true,
    });
  }
  return join(tempDirectory, 'schema.prisma');
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
    const m2SchemaPath = await createM2MigrationTree(tempDirectory);

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

    const fullSchemaPath = join(PRISMA_ROOT, 'schema.prisma');
    runPrisma(['migrate', 'deploy', '--schema', fullSchemaPath], scratchDatabaseUrl);
    await assertMigrationState(scratchClient, allMigrationNames);
    const afterUpgradeFingerprint = await fixtureFingerprint(scratchClient, fingerprintSql);
    if (afterUpgradeFingerprint !== beforeUpgradeFingerprint) {
      fail('M1/M2 fixture fingerprint changed during the M3 upgrade');
    }

    runPrisma(['migrate', 'deploy', '--schema', fullSchemaPath], scratchDatabaseUrl);
    await assertMigrationState(scratchClient, allMigrationNames);
    const afterRepeatFingerprint = await fixtureFingerprint(scratchClient, fingerprintSql);
    if (afterRepeatFingerprint !== beforeUpgradeFingerprint) {
      fail('M1/M2 fixture fingerprint changed during repeated deployment');
    }

    runPrisma(
      ['db', 'execute', '--file', ASSERTIONS_SQL_PATH, '--schema', fullSchemaPath],
      scratchDatabaseUrl,
    );
    console.log(
      `[m2-upgrade] verified ${String(allMigrationNames.length)} migrations and preserved the M2 fingerprint`,
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
