import { createHash, randomUUID } from 'node:crypto';

import { S3MediaStorageProvider, type S3MediaStorageConfig } from '@zalo-shop/integrations';

import {
  type EvidenceReservation,
  finalizeEvidence,
  recordFailedEvidence,
  reserveEvidence,
} from './evidence';

type StoragePreflightConfig = Readonly<{
  bucket: string;
  cdn?: Readonly<{
    baseUrl: URL;
    expectedCacheHeader?: Readonly<{ name: string; value: string }>;
    propagationSeconds: number;
  }>;
  endpoint: URL;
  guard: Readonly<{ expectedId: string; objectKey: string }>;
  objectPrefix: string;
  runId: string;
  storage: S3MediaStorageConfig;
  storeId: string;
}>;

class PreflightError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PreflightError';
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);
const CACHE_EVIDENCE_HEADERS = new Set([
  'age',
  'cf-cache-status',
  'x-cache',
  'x-cache-status',
  'x-proxy-cache',
  'x-vercel-cache',
]);

export function isAllowedCacheEvidenceHeader(name: string): boolean {
  return CACHE_EVIDENCE_HEADERS.has(name.toLowerCase());
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new PreflightError(`${name} is required`);
  return value;
}

function parseRunId(): string {
  const configured = process.env.READINESS_RUN_ID?.trim();
  if (configured) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(configured)) {
      throw new PreflightError('READINESS_RUN_ID contains unsupported characters');
    }
    return configured;
  }
  return `${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`;
}

function integerEnvironment(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new PreflightError(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new PreflightError(`${name} is outside its safe range`);
  }
  return value;
}

function parseHttpsUrl(value: string, fieldName: string, allowPath: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PreflightError(`${fieldName} must be an absolute URL`);
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (!allowPath && url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new PreflightError(`${fieldName} must be a credential-free HTTPS URL`);
  }
  if (LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new PreflightError(`${fieldName} must not target loopback in a staging preflight`);
  }
  return url;
}

function normalizeEndpoint(url: URL): string {
  const normalized = new URL(url);
  normalized.pathname = normalized.pathname.replace(/\/+$/, '') || '/';
  return normalized.href;
}

function parseObjectKey(value: string, fieldName: string): string {
  if (
    value.length > 512 ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('\\') ||
    value.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new PreflightError(`${fieldName} is not a safe object key`);
  }
  return value;
}

export function parseStoragePreflightConfig(): StoragePreflightConfig {
  if (process.env.READINESS_STORAGE_PREFLIGHT !== 'true') {
    throw new PreflightError('Staging storage preflight requires explicit opt-in');
  }
  if (process.env.READINESS_TARGET_ENV === 'production') {
    throw new PreflightError('Production storage targets are forbidden');
  }
  if (process.env.READINESS_TARGET_ENV !== 'staging') {
    throw new PreflightError('Storage preflight is restricted to staging');
  }
  if (process.env.NODE_ENV !== 'production') {
    throw new PreflightError('Staging storage preflight requires production runtime validation');
  }

  const endpoint = parseHttpsUrl(requiredEnvironment('S3_ENDPOINT'), 'S3_ENDPOINT', true);
  const expectedEndpoint = parseHttpsUrl(
    requiredEnvironment('READINESS_EXPECTED_S3_ENDPOINT'),
    'READINESS_EXPECTED_S3_ENDPOINT',
    true,
  );
  if (normalizeEndpoint(endpoint) !== normalizeEndpoint(expectedEndpoint)) {
    throw new PreflightError('S3_ENDPOINT does not match the explicit staging endpoint');
  }

  const bucket = requiredEnvironment('S3_BUCKET');
  if (
    bucket !== requiredEnvironment('READINESS_EXPECTED_S3_BUCKET') ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
    bucket.includes('..')
  ) {
    throw new PreflightError('S3_BUCKET does not match a safe explicit staging bucket');
  }
  const storeId = requiredEnvironment('READINESS_STORAGE_STORE_ID').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(storeId)) {
    throw new PreflightError('READINESS_STORAGE_STORE_ID must be a version 4 UUID');
  }
  const objectPrefix = `staging/${storeId}/readiness/`;
  const guardObjectKey = parseObjectKey(
    requiredEnvironment('READINESS_STORAGE_GUARD_OBJECT_KEY'),
    'READINESS_STORAGE_GUARD_OBJECT_KEY',
  );
  if (guardObjectKey.startsWith(objectPrefix)) {
    throw new PreflightError('The staging guard must be outside the writable readiness prefix');
  }

  const forcePathStyle = requiredEnvironment('S3_FORCE_PATH_STYLE');
  if (forcePathStyle !== 'true' && forcePathStyle !== 'false') {
    throw new PreflightError('S3_FORCE_PATH_STYLE must be true or false');
  }
  const sessionToken = process.env.S3_SESSION_TOKEN?.trim();
  const storage: S3MediaStorageConfig = {
    S3_ACCESS_KEY: requiredEnvironment('S3_ACCESS_KEY'),
    S3_BUCKET: bucket,
    S3_ENDPOINT: endpoint.href,
    S3_FORCE_PATH_STYLE: forcePathStyle === 'true',
    S3_REGION: requiredEnvironment('S3_REGION'),
    S3_SECRET_KEY: requiredEnvironment('S3_SECRET_KEY'),
    ...(sessionToken ? { S3_SESSION_TOKEN: sessionToken } : {}),
  };

  const cdnBase = process.env.READINESS_CDN_BASE_URL?.trim();
  let cdn: StoragePreflightConfig['cdn'];
  if (cdnBase) {
    const baseUrl = parseHttpsUrl(cdnBase, 'READINESS_CDN_BASE_URL', true);
    const expectedOrigin = parseHttpsUrl(
      requiredEnvironment('READINESS_EXPECTED_CDN_ORIGIN'),
      'READINESS_EXPECTED_CDN_ORIGIN',
      false,
    ).origin;
    if (baseUrl.origin !== expectedOrigin) {
      throw new PreflightError('The CDN origin does not match the explicit staging target');
    }
    const cacheHeaderName = process.env.READINESS_CDN_EXPECTED_CACHE_HEADER?.trim().toLowerCase();
    const cacheHeaderValue = process.env.READINESS_CDN_EXPECTED_CACHE_VALUE?.trim();
    if ((cacheHeaderName && !cacheHeaderValue) || (!cacheHeaderName && cacheHeaderValue)) {
      throw new PreflightError('Both expected CDN cache header fields must be provided together');
    }
    if (cacheHeaderName && !isAllowedCacheEvidenceHeader(cacheHeaderName)) {
      throw new PreflightError(
        'READINESS_CDN_EXPECTED_CACHE_HEADER is not an approved cache header',
      );
    }
    cdn = {
      baseUrl,
      ...(cacheHeaderName && cacheHeaderValue
        ? { expectedCacheHeader: { name: cacheHeaderName, value: cacheHeaderValue } }
        : {}),
      propagationSeconds: integerEnvironment('READINESS_CDN_PROPAGATION_SECONDS', 30, 0, 120),
    };
  }

  return {
    bucket,
    ...(cdn ? { cdn } : {}),
    endpoint,
    guard: {
      expectedId: requiredEnvironment('READINESS_STORAGE_GUARD_EXPECTED_ID'),
      objectKey: guardObjectKey,
    },
    objectPrefix,
    runId: parseRunId(),
    storage,
    storeId,
  };
}

async function responseBytes(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new PreflightError('A storage response exceeded the permitted evidence size');
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return Buffer.concat(chunks.map((value) => Buffer.from(value)));
      received += chunk.value.byteLength;
      if (received > maximumBytes) {
        await reader.cancel();
        throw new PreflightError('A storage response exceeded the permitted evidence size');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
}

async function signedRead(
  storage: S3MediaStorageProvider,
  objectKey: string,
  maximumBytes: number,
): Promise<{ bytes: Uint8Array; response: Response }> {
  const target = await storage.createReadUrl(objectKey);
  let response: Response;
  try {
    response = await fetch(target.url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new PreflightError('A signed storage read failed');
  }
  if (response.status !== 200) throw new PreflightError('A signed storage read was rejected');
  return { bytes: await responseBytes(response, maximumBytes), response };
}

async function verifyGuard(
  config: StoragePreflightConfig,
  storage: S3MediaStorageProvider,
): Promise<void> {
  const result = await signedRead(storage, config.guard.objectKey, 16 * 1_024);
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(result.bytes).toString('utf8')) as unknown;
  } catch {
    throw new PreflightError('The staging storage guard is invalid');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PreflightError('The staging storage guard is invalid');
  }
  const guard = value as Record<string, unknown>;
  const expiration =
    typeof guard.expires_at === 'string' ? Date.parse(guard.expires_at) : Number.NaN;
  const now = Date.now();
  if (
    guard.schema_version !== 1 ||
    guard.environment !== 'staging' ||
    guard.purpose !== 'storage-readiness' ||
    guard.guard_id !== config.guard.expectedId ||
    guard.bucket !== config.bucket ||
    guard.endpoint !== normalizeEndpoint(config.endpoint) ||
    guard.store_id !== config.storeId ||
    guard.allowed_prefix !== config.objectPrefix ||
    !Number.isFinite(expiration) ||
    expiration <= now ||
    expiration > now + 24 * 60 * 60 * 1_000 ||
    (config.cdn && guard.cdn_origin !== config.cdn.baseUrl.origin)
  ) {
    throw new PreflightError('The staging storage guard does not authorize this target');
  }
}

function objectUrl(baseUrl: URL, objectKey: string): URL {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, '');
  const encodedKey = objectKey.split('/').map(encodeURIComponent).join('/');
  url.pathname = `${basePath}/${encodedKey}`;
  return url;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function readCdn(
  url: URL,
  expectedBody: Uint8Array,
  propagationSeconds: number,
): Promise<Response> {
  const deadline = Date.now() + propagationSeconds * 1_000;
  for (;;) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 200) {
        const bytes = await responseBytes(response, 1024 * 1024);
        if (Buffer.from(bytes).equals(Buffer.from(expectedBody))) return response;
        throw new PreflightError('The CDN returned content that did not match storage');
      }
    } catch (error) {
      if (error instanceof PreflightError) throw error;
    }
    if (Date.now() >= deadline)
      throw new PreflightError('The CDN did not expose the probe in time');
    await delay(1_000);
  }
}

type DeletionVerificationOptions = Readonly<{
  requestTimeoutMs: number;
  retryDelayMs: number;
  timeoutMs: number;
}>;

const DEFAULT_DELETION_OPTIONS: DeletionVerificationOptions = {
  requestTimeoutMs: 5_000,
  retryDelayMs: 500,
  timeoutMs: 10_000,
};

export async function verifyDeleted(
  storage: Pick<S3MediaStorageProvider, 'createReadUrl'>,
  objectKey: string,
  options: DeletionVerificationOptions = DEFAULT_DELETION_OPTIONS,
): Promise<boolean> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    try {
      const target = await storage.createReadUrl(objectKey);
      const response = await fetch(target.url, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(options.requestTimeoutMs),
      });
      await responseBytes(response, 1024 * 1024);
      if (response.status === 404) return true;
    } catch {
      // Authentication, authorization, and transport errors do not prove deletion.
    }
    if (Date.now() >= deadline) return false;
    await delay(options.retryDelayMs);
  }
}

type ObjectOwnership = 'absent' | 'foreign' | 'owned' | 'unknown';

export async function probeObjectOwnership(
  storage: Pick<S3MediaStorageProvider, 'createReadUrl'>,
  objectKey: string,
  expectedBody: Uint8Array,
): Promise<ObjectOwnership> {
  try {
    const target = await storage.createReadUrl(objectKey);
    const response = await fetch(target.url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    });
    const bytes = await responseBytes(response, 1024 * 1024);
    if (response.status === 404) return 'absent';
    if (response.status !== 200) return 'unknown';
    return Buffer.from(bytes).equals(Buffer.from(expectedBody)) ? 'owned' : 'foreign';
  } catch {
    return 'unknown';
  }
}

export function createProbeObjectKey(objectPrefix: string, runId: string): string {
  return `${objectPrefix}${runId}-${randomUUID()}/probe.bin`;
}

type CleanupResult = Readonly<{ passed: boolean; status: string }>;

export async function cleanupProbeObject(
  storage: Pick<S3MediaStorageProvider, 'createReadUrl' | 'removeObject'>,
  objectKey: string,
  expectedBody: Uint8Array,
  uploadAttempted: boolean,
): Promise<CleanupResult> {
  if (!uploadAttempted) return { passed: true, status: 'not-created' };

  const ownership = await probeObjectOwnership(storage, objectKey, expectedBody);
  if (ownership !== 'owned') {
    return {
      passed: ownership === 'absent',
      status:
        ownership === 'absent'
          ? 'confirmed-absent'
          : ownership === 'foreign'
            ? 'foreign-object-preserved'
            : 'ownership-unknown',
    };
  }

  try {
    await storage.removeObject(objectKey);
    const deleted = await verifyDeleted(storage, objectKey);
    return { passed: deleted, status: deleted ? 'deleted' : 'deletion-unverified' };
  } catch {
    return { passed: false, status: 'delete-failed' };
  }
}

function safeHeader(response: Response, name: string): string | null {
  const value = response.headers.get(name);
  return value ? value.slice(0, 128) : null;
}

async function executeStoragePreflight(
  config: StoragePreflightConfig,
  evidence: EvidenceReservation,
): Promise<void> {
  const storage = new S3MediaStorageProvider(config.storage);

  // This is the only network operation allowed before the immutable staging guard is verified.
  await verifyGuard(config, storage);

  const objectKey = createProbeObjectKey(config.objectPrefix, config.runId);
  const body = Buffer.from(`zalo-shop-storage-readiness:${randomUUID()}`, 'utf8');
  const checksumSha256 = createHash('sha256').update(body).digest('hex');
  let stage = 'create_upload_target';
  let operationPassed = false;
  let cleanupPassed = false;
  let cleanupStatus = 'not-attempted';
  let headChecksumPresent = false;
  let uploadAttempted = false;
  let cdnEvidence: null | Readonly<{
    cache_control: string | null;
    cache_header: string | null;
    cache_status: string | null;
    mode: 'delivery' | 'expected-cache-header';
  }> = null;

  try {
    const upload = await storage.createUploadTarget({
      byteSize: body.byteLength,
      checksumSha256,
      contentType: 'application/octet-stream',
      createOnly: true,
      objectKey,
    });
    stage = 'upload';
    uploadAttempted = true;
    const uploadResponse = await fetch(upload.url, {
      body,
      headers: upload.headers,
      method: 'PUT',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    await responseBytes(uploadResponse, 64 * 1_024);
    if (uploadResponse.status === 409 || uploadResponse.status === 412) {
      throw new PreflightError('The unique staging object already exists; deletion was refused');
    }
    if (uploadResponse.status < 200 || uploadResponse.status >= 300) {
      throw new PreflightError('The staging upload was rejected');
    }

    stage = 'inspect';
    const metadata = await storage.inspectObject(objectKey);
    headChecksumPresent = metadata.checksumSha256 !== undefined;
    if (
      metadata.byteSize !== body.byteLength ||
      metadata.contentType !== 'application/octet-stream' ||
      (metadata.checksumSha256 !== undefined && metadata.checksumSha256 !== checksumSha256)
    ) {
      throw new PreflightError('The staging object metadata did not match the upload');
    }

    stage = 'signed_read';
    const read = await signedRead(storage, objectKey, 1024 * 1024);
    if (!Buffer.from(read.bytes).equals(body)) {
      throw new PreflightError('The signed storage read did not match the upload');
    }

    if (config.cdn) {
      stage = 'cdn_delivery';
      const cdnUrl = objectUrl(config.cdn.baseUrl, objectKey);
      await readCdn(cdnUrl, body, config.cdn.propagationSeconds);
      const secondResponse = await readCdn(cdnUrl, body, 0);
      const expected = config.cdn.expectedCacheHeader;
      const cacheHeader = expected ? safeHeader(secondResponse, expected.name) : null;
      if (expected && cacheHeader?.toLowerCase().includes(expected.value.toLowerCase()) !== true) {
        throw new PreflightError('The CDN response did not contain the expected cache evidence');
      }
      cdnEvidence = {
        cache_control: safeHeader(secondResponse, 'cache-control'),
        cache_header: cacheHeader,
        cache_status:
          safeHeader(secondResponse, 'x-cache') ??
          safeHeader(secondResponse, 'cf-cache-status') ??
          safeHeader(secondResponse, 'age'),
        mode: expected ? 'expected-cache-header' : 'delivery',
      };
    }
    operationPassed = true;
  } catch (error) {
    if (error instanceof PreflightError) {
      console.error(`Storage readiness failed at ${stage}: ${error.message}`);
    } else {
      console.error(`Storage readiness failed at ${stage} without exposing provider details`);
    }
  } finally {
    const cleanup = await cleanupProbeObject(storage, objectKey, body, uploadAttempted);
    cleanupPassed = cleanup.passed;
    cleanupStatus = cleanup.status;
  }

  const passed = operationPassed && cleanupPassed;
  const report = {
    bucket: config.bucket,
    cdn: config.cdn
      ? {
          evidence: cdnEvidence,
          origin: config.cdn.baseUrl.origin,
          status: cdnEvidence ? 'passed' : 'failed',
        }
      : { evidence: null, origin: null, status: 'not_run' },
    cleanup_verified: cleanupPassed,
    cleanup_status: cleanupStatus,
    endpoint: normalizeEndpoint(config.endpoint),
    environment: 'staging',
    finished_at: new Date().toISOString(),
    git_commit: process.env.GITHUB_SHA?.trim() || null,
    guard_id: config.guard.expectedId,
    head_checksum_present: headChecksumPresent,
    object_prefix: config.objectPrefix,
    object_key: objectKey,
    operation_stage: stage,
    passed,
    run_id: config.runId,
    store_id: config.storeId,
  };
  await finalizeEvidence(evidence, report);
  console.log(
    `Storage readiness ${passed ? 'passed' : 'failed'}; evidence: ${evidence.outputPath}`,
  );
  if (!passed) process.exitCode = 1;
}

async function run(): Promise<void> {
  const config = parseStoragePreflightConfig();
  const evidence = await reserveEvidence('storage', config.runId, 'staging');
  try {
    await executeStoragePreflight(config, evidence);
  } catch (error) {
    const failure =
      error instanceof PreflightError
        ? error.message
        : 'Storage readiness failed without exposing provider details';
    try {
      await recordFailedEvidence(evidence, failure);
    } catch (evidenceError) {
      throw new AggregateError(
        [error, evidenceError],
        'Storage readiness and evidence writing failed',
      );
    }
    throw error;
  }
}

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  void run().catch((error: unknown) => {
    console.error(
      error instanceof PreflightError
        ? `Storage readiness refused: ${error.message}`
        : 'Storage readiness failed without exposing provider details',
    );
    process.exitCode = 1;
  });
}
