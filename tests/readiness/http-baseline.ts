import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import path from 'node:path';

import {
  type EvidenceReservation,
  finalizeEvidence,
  recordFailedEvidence,
  reserveEvidence,
} from './evidence';

type TargetEnvironment = 'local' | 'staging';
type RequestOutcome = 'response_too_large' | 'success' | 'transport_error' | 'unexpected_status';

type RequestSample = Readonly<{
  latencyMs: number;
  outcome: RequestOutcome;
  status?: number;
}>;

type ThresholdResult = Readonly<{
  actual: number | null;
  limit: number;
  metric: 'error_rate_percent' | 'p95_ms' | 'p99_ms' | 'successful_rps';
  passed: boolean;
}>;

type HttpBaselineConfig = Readonly<{
  baseUrl: URL;
  concurrency: number;
  durationSeconds: number;
  environment: TargetEnvironment;
  expectedStatus: number;
  guard?: Readonly<{
    expectedId: string;
    policySha256: string;
    repositoryCommit: string;
    url: URL;
  }>;
  maxErrorRatePercent: number;
  maxP95Ms?: number;
  maxP99Ms?: number;
  maxRequests: number;
  maxResponseBytes: number;
  minSuccessfulRps?: number;
  profile: 'baseline' | 'smoke';
  requestTimeoutMs: number;
  runId: string;
  storeCode?: string;
  targetUrl: URL;
  warmupRequests: number;
}>;

class ReadinessError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ReadinessError';
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);
const READINESS_LOCALES = new Set(['en', 'vi', 'zh']);
const STAGING_GUARD_PATH = '/.well-known/zalo-shop-http-readiness.json';
const TARGET_POLICY_REPOSITORY_PATH = 'config/readiness-targets.json';
const TARGET_POLICY_PATH = path.resolve('config', 'readiness-targets.json');

export type ReviewedTargetPolicy = Readonly<{
  httpStagingOrigins: ReadonlySet<string>;
  policySha256: string;
  repositoryCommit: string;
}>;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new ReadinessError(`${name} is required`);
  return value;
}

function integerEnvironment(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new ReadinessError(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ReadinessError(`${name} is outside its safe range`);
  }
  return value;
}

function optionalNumberEnvironment(
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ReadinessError(`${name} is outside its safe range`);
  }
  return value;
}

function parseBaseUrl(value: string, fieldName: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ReadinessError(`${fieldName} must be an absolute URL`);
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new ReadinessError(`${fieldName} must be a credential-free HTTP origin`);
  }
  return url;
}

function gitOutput(args: readonly string[]): string {
  const result = spawnSync('git', [...args], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new ReadinessError('The reviewed readiness target policy requires a Git checkout');
  }
  return result.stdout.trim();
}

export function reviewedTargetPolicy(): ReviewedTargetPolicy {
  const trackedPath = gitOutput([
    'ls-files',
    '--error-unmatch',
    '--',
    TARGET_POLICY_REPOSITORY_PATH,
  ]);
  const worktreeStatus = gitOutput([
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '--',
    TARGET_POLICY_REPOSITORY_PATH,
  ]);
  const repositoryCommit = gitOutput(['rev-parse', '--verify', 'HEAD']);
  if (
    trackedPath !== TARGET_POLICY_REPOSITORY_PATH ||
    worktreeStatus !== '' ||
    !/^[0-9a-f]{40,64}$/u.test(repositoryCommit)
  ) {
    throw new ReadinessError('The staging target policy must exactly match the tracked HEAD file');
  }

  let rawPolicy: string;
  let parsed: unknown;
  try {
    rawPolicy = readFileSync(TARGET_POLICY_PATH, 'utf8');
    parsed = JSON.parse(rawPolicy) as unknown;
  } catch {
    throw new ReadinessError('The reviewed readiness target policy could not be read');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ReadinessError('The reviewed readiness target policy is invalid');
  }
  const policy = parsed as Record<string, unknown>;
  if (
    policy.schema_version !== 1 ||
    !Array.isArray(policy.http_staging_origins) ||
    policy.http_staging_origins.length > 50
  ) {
    throw new ReadinessError('The reviewed readiness target policy is invalid');
  }
  const origins = new Set<string>();
  for (const value of policy.http_staging_origins) {
    if (typeof value !== 'string') {
      throw new ReadinessError('The reviewed readiness target policy is invalid');
    }
    const url = parseBaseUrl(value, 'http_staging_origins');
    if (url.protocol !== 'https:' || origins.has(url.origin)) {
      throw new ReadinessError('The reviewed readiness target policy is invalid');
    }
    origins.add(url.origin);
  }
  return {
    httpStagingOrigins: origins,
    policySha256: createHash('sha256').update(rawPolicy).digest('hex'),
    repositoryCommit,
  };
}

export function parseTargetEnvironment(): TargetEnvironment {
  const value = process.env.READINESS_TARGET_ENV?.trim() || 'local';
  if (value === 'production') {
    throw new ReadinessError('Production performance targets are forbidden');
  }
  if (value !== 'local' && value !== 'staging') {
    throw new ReadinessError('READINESS_TARGET_ENV must be local or staging');
  }
  return value;
}

function parseProfile(): 'baseline' | 'smoke' {
  const value = process.env.READINESS_HTTP_PROFILE?.trim() || 'smoke';
  if (value !== 'baseline' && value !== 'smoke') {
    throw new ReadinessError('READINESS_HTTP_PROFILE must be smoke or baseline');
  }
  return value;
}

function parseRunId(): string {
  const configured = process.env.READINESS_RUN_ID?.trim();
  if (configured) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(configured)) {
      throw new ReadinessError('READINESS_RUN_ID contains unsupported characters');
    }
    return configured;
  }
  return `${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`;
}

export function parseRelativeTarget(baseUrl: URL): URL {
  const relativePath = process.env.READINESS_HTTP_PATH?.trim() || '/health/live';
  if (
    !relativePath.startsWith('/') ||
    relativePath.startsWith('//') ||
    relativePath.includes('#')
  ) {
    throw new ReadinessError('READINESS_HTTP_PATH must be a same-origin relative path');
  }
  let target: URL;
  try {
    target = new URL(relativePath, baseUrl);
  } catch {
    throw new ReadinessError('READINESS_HTTP_PATH is invalid');
  }
  if (target.origin !== baseUrl.origin || target.pathname.includes('..')) {
    throw new ReadinessError('READINESS_HTTP_PATH must remain on the configured origin');
  }
  const queryEntries = [...target.searchParams.entries()];
  if (
    queryEntries.length > 1 ||
    queryEntries.some(([name, value]) => name !== 'locale' || !READINESS_LOCALES.has(value))
  ) {
    throw new ReadinessError('READINESS_HTTP_PATH only accepts one vi, zh, or en locale query');
  }
  return target;
}

export function stagingGuardUrl(baseUrl: URL): URL {
  return new URL(STAGING_GUARD_PATH, baseUrl);
}

export function parseHttpBaselineConfig(suppliedPolicy?: ReviewedTargetPolicy): HttpBaselineConfig {
  const environment = parseTargetEnvironment();
  const profile = parseProfile();
  const defaultBaseUrl = environment === 'local' ? 'http://127.0.0.1:3000' : undefined;
  const baseUrl = parseBaseUrl(
    process.env.READINESS_HTTP_BASE_URL?.trim() ||
      defaultBaseUrl ||
      requiredEnvironment('READINESS_HTTP_BASE_URL'),
    'READINESS_HTTP_BASE_URL',
  );

  let guard: HttpBaselineConfig['guard'];
  if (environment === 'local') {
    if (!LOOPBACK_HOSTS.has(baseUrl.hostname.toLowerCase())) {
      throw new ReadinessError('Local performance targets must use a loopback host');
    }
  } else {
    if (process.env.READINESS_ALLOW_REMOTE_STAGING !== 'true') {
      throw new ReadinessError('Remote staging performance requires explicit opt-in');
    }
    if (baseUrl.protocol !== 'https:') {
      throw new ReadinessError('Remote staging performance requires HTTPS');
    }
    const expectedOrigin = parseBaseUrl(
      requiredEnvironment('READINESS_EXPECTED_HTTP_ORIGIN'),
      'READINESS_EXPECTED_HTTP_ORIGIN',
    ).origin;
    if (baseUrl.origin !== expectedOrigin) {
      throw new ReadinessError('The performance origin does not match the explicit staging target');
    }
    const policy = suppliedPolicy ?? reviewedTargetPolicy();
    if (!policy.httpStagingOrigins.has(baseUrl.origin)) {
      throw new ReadinessError('The HTTP origin is not in the reviewed staging target policy');
    }
    guard = {
      expectedId: requiredEnvironment('READINESS_STAGING_GUARD_EXPECTED_ID'),
      policySha256: policy.policySha256,
      repositoryCommit: policy.repositoryCommit,
      url: stagingGuardUrl(baseUrl),
    };
  }

  const storeCode = process.env.READINESS_HTTP_STORE_CODE?.trim();
  if (storeCode && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(storeCode)) {
    throw new ReadinessError('READINESS_HTTP_STORE_CODE is invalid');
  }

  const staging = environment === 'staging';
  const defaultDuration = profile === 'smoke' ? 10 : 60;
  const defaultConcurrency = profile === 'smoke' ? 2 : 10;
  return {
    baseUrl,
    concurrency: integerEnvironment(
      'READINESS_HTTP_CONCURRENCY',
      defaultConcurrency,
      1,
      staging ? 25 : 100,
    ),
    durationSeconds: integerEnvironment(
      'READINESS_HTTP_DURATION_SECONDS',
      defaultDuration,
      1,
      staging ? 300 : 600,
    ),
    environment,
    expectedStatus: integerEnvironment('READINESS_HTTP_EXPECTED_STATUS', 200, 100, 599),
    ...(guard ? { guard } : {}),
    maxErrorRatePercent:
      optionalNumberEnvironment('READINESS_HTTP_MAX_ERROR_RATE_PERCENT', 0, 100) ?? 0,
    ...(optionalNumberEnvironment('READINESS_HTTP_MAX_P95_MS', 1, 120_000) === undefined
      ? {}
      : {
          maxP95Ms: optionalNumberEnvironment('READINESS_HTTP_MAX_P95_MS', 1, 120_000),
        }),
    ...(optionalNumberEnvironment('READINESS_HTTP_MAX_P99_MS', 1, 120_000) === undefined
      ? {}
      : {
          maxP99Ms: optionalNumberEnvironment('READINESS_HTTP_MAX_P99_MS', 1, 120_000),
        }),
    maxRequests: integerEnvironment(
      'READINESS_HTTP_MAX_REQUESTS',
      10_000,
      1,
      staging ? 25_000 : 100_000,
    ),
    maxResponseBytes: integerEnvironment(
      'READINESS_HTTP_MAX_RESPONSE_BYTES',
      5 * 1_024 * 1_024,
      1_024,
      25 * 1_024 * 1_024,
    ),
    ...(optionalNumberEnvironment('READINESS_HTTP_MIN_SUCCESSFUL_RPS', 0, 1_000_000) === undefined
      ? {}
      : {
          minSuccessfulRps: optionalNumberEnvironment(
            'READINESS_HTTP_MIN_SUCCESSFUL_RPS',
            0,
            1_000_000,
          ),
        }),
    profile,
    requestTimeoutMs: integerEnvironment('READINESS_HTTP_REQUEST_TIMEOUT_MS', 5_000, 100, 120_000),
    runId: parseRunId(),
    ...(storeCode ? { storeCode } : {}),
    targetUrl: parseRelativeTarget(baseUrl),
    warmupRequests: integerEnvironment(
      'READINESS_HTTP_WARMUP_REQUESTS',
      profile === 'smoke' ? 2 : 5,
      1,
      100,
    ),
  };
}

async function consumeBody(response: Response, maximumBytes: number): Promise<boolean> {
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) return false;
  if (!response.body) return true;
  const reader = response.body.getReader();
  let received = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return true;
      received += chunk.value.byteLength;
      if (received > maximumBytes) {
        await reader.cancel();
        return false;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function readBody(response: Response, maximumBytes: number): Promise<Uint8Array | null> {
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) return null;
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
        return null;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
}

export async function verifyStagingGuard(config: HttpBaselineConfig): Promise<void> {
  if (!config.guard) return;
  let response: Response;
  try {
    response = await fetch(config.guard.url, {
      headers: { accept: 'application/json' },
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new ReadinessError('The staging HTTP guard could not be read');
  }
  if (response.status !== 200) throw new ReadinessError('The staging HTTP guard was rejected');
  const bodyBytes = await readBody(response, 16 * 1_024);
  if (!bodyBytes) throw new ReadinessError('The staging HTTP guard is too large');
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bodyBytes).toString('utf8')) as unknown;
  } catch {
    throw new ReadinessError('The staging HTTP guard is invalid');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ReadinessError('The staging HTTP guard is invalid');
  }
  const guard = value as Record<string, unknown>;
  const allowedOrigins = guard.allowed_origins;
  const expiration =
    typeof guard.expires_at === 'string' ? Date.parse(guard.expires_at) : Number.NaN;
  const now = Date.now();
  if (
    guard.schema_version !== 1 ||
    guard.environment !== 'staging' ||
    guard.purpose !== 'http-readiness' ||
    guard.guard_id !== config.guard.expectedId ||
    guard.git_commit !== config.guard.repositoryCommit ||
    !Array.isArray(allowedOrigins) ||
    !allowedOrigins.every((origin) => typeof origin === 'string') ||
    !allowedOrigins.includes(config.baseUrl.origin) ||
    !Number.isFinite(expiration) ||
    expiration <= now ||
    expiration > now + 24 * 60 * 60 * 1_000
  ) {
    throw new ReadinessError('The staging HTTP guard does not authorize this target');
  }
}

async function issueRequest(config: HttpBaselineConfig): Promise<RequestSample> {
  const startedAt = performance.now();
  try {
    const response = await fetch(config.targetUrl, {
      headers: {
        accept: 'application/json',
        ...(config.storeCode ? { 'x-store-code': config.storeCode } : {}),
      },
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
    const bodyAccepted = await consumeBody(response, config.maxResponseBytes);
    const latencyMs = performance.now() - startedAt;
    if (!bodyAccepted) return { latencyMs, outcome: 'response_too_large', status: response.status };
    return {
      latencyMs,
      outcome: response.status === config.expectedStatus ? 'success' : 'unexpected_status',
      status: response.status,
    };
  } catch {
    return { latencyMs: performance.now() - startedAt, outcome: 'transport_error' };
  }
}

function percentile(values: readonly number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? null;
}

function rounded(value: number | null): number | null {
  return value === null ? null : Math.round(value * 100) / 100;
}

function thresholdResults(input: {
  config: HttpBaselineConfig;
  errorRatePercent: number;
  p95Ms: number | null;
  p99Ms: number | null;
  successfulRps: number;
}): ThresholdResult[] {
  const results: ThresholdResult[] = [
    {
      actual: rounded(input.errorRatePercent),
      limit: input.config.maxErrorRatePercent,
      metric: 'error_rate_percent',
      passed: input.errorRatePercent <= input.config.maxErrorRatePercent,
    },
  ];
  if (input.config.maxP95Ms !== undefined) {
    results.push({
      actual: rounded(input.p95Ms),
      limit: input.config.maxP95Ms,
      metric: 'p95_ms',
      passed: input.p95Ms !== null && input.p95Ms <= input.config.maxP95Ms,
    });
  }
  if (input.config.maxP99Ms !== undefined) {
    results.push({
      actual: rounded(input.p99Ms),
      limit: input.config.maxP99Ms,
      metric: 'p99_ms',
      passed: input.p99Ms !== null && input.p99Ms <= input.config.maxP99Ms,
    });
  }
  if (input.config.minSuccessfulRps !== undefined) {
    results.push({
      actual: rounded(input.successfulRps),
      limit: input.config.minSuccessfulRps,
      metric: 'successful_rps',
      passed: input.successfulRps >= input.config.minSuccessfulRps,
    });
  }
  return results;
}

async function executeHttpBaseline(
  config: HttpBaselineConfig,
  evidence: EvidenceReservation,
): Promise<void> {
  await verifyStagingGuard(config);

  for (let index = 0; index < config.warmupRequests; index += 1) {
    const sample = await issueRequest(config);
    if (sample.outcome !== 'success') {
      throw new ReadinessError('HTTP warm-up failed; no baseline load was sent');
    }
  }

  const startedAt = new Date();
  const started = performance.now();
  const deadline = started + config.durationSeconds * 1_000;
  const samples: RequestSample[] = [];
  let issued = 0;

  async function worker(): Promise<void> {
    for (;;) {
      if (performance.now() >= deadline || issued >= config.maxRequests) return;
      issued += 1;
      samples.push(await issueRequest(config));
    }
  }

  await Promise.all(Array.from({ length: config.concurrency }, () => worker()));
  const elapsedSeconds = Math.max((performance.now() - started) / 1_000, 0.001);
  const successful = samples.filter((sample) => sample.outcome === 'success');
  const errors = samples.length - successful.length;
  const latencies = successful.map((sample) => sample.latencyMs);
  const p50Ms = percentile(latencies, 0.5);
  const p95Ms = percentile(latencies, 0.95);
  const p99Ms = percentile(latencies, 0.99);
  const errorRatePercent = samples.length === 0 ? 100 : (errors / samples.length) * 100;
  const successfulRps = successful.length / elapsedSeconds;
  const statusCounts = Object.fromEntries(
    [...new Set(samples.flatMap((sample) => (sample.status === undefined ? [] : [sample.status])))]
      .sort((left, right) => left - right)
      .map((status) => [
        String(status),
        samples.filter((sample) => sample.status === status).length,
      ]),
  );
  const outcomeCounts = Object.fromEntries(
    (['success', 'unexpected_status', 'transport_error', 'response_too_large'] as const).map(
      (outcome) => [outcome, samples.filter((sample) => sample.outcome === outcome).length],
    ),
  );
  const thresholds = thresholdResults({
    config,
    errorRatePercent,
    p95Ms,
    p99Ms,
    successfulRps,
  });
  const passed = samples.length > 0 && thresholds.every((threshold) => threshold.passed);
  const report = {
    classification:
      config.maxP95Ms === undefined &&
      config.maxP99Ms === undefined &&
      config.minSuccessfulRps === undefined
        ? 'baseline'
        : 'threshold-check',
    environment: config.environment,
    finished_at: new Date().toISOString(),
    git_commit: config.guard?.repositoryCommit ?? process.env.GITHUB_SHA?.trim() ?? null,
    guard_id: config.guard?.expectedId ?? null,
    inputs: {
      concurrency: config.concurrency,
      duration_seconds: config.durationSeconds,
      expected_status: config.expectedStatus,
      max_requests: config.maxRequests,
      profile: config.profile,
      request_timeout_ms: config.requestTimeoutMs,
      store_code: config.storeCode ?? null,
      target: config.targetUrl.href,
      warmup_requests: config.warmupRequests,
    },
    metrics: {
      elapsed_seconds: rounded(elapsedSeconds),
      error_count: errors,
      error_rate_percent: rounded(errorRatePercent),
      mean_ms: rounded(
        latencies.length === 0
          ? null
          : latencies.reduce((total, latency) => total + latency, 0) / latencies.length,
      ),
      outcome_counts: outcomeCounts,
      p50_ms: rounded(p50Ms),
      p95_ms: rounded(p95Ms),
      p99_ms: rounded(p99Ms),
      request_count: samples.length,
      status_counts: statusCounts,
      successful_rps: rounded(successfulRps),
      total_rps: rounded(samples.length / elapsedSeconds),
    },
    node_version: process.version,
    passed,
    policy_sha256: config.guard?.policySha256 ?? null,
    run_id: config.runId,
    started_at: startedAt.toISOString(),
    thresholds,
  };

  await finalizeEvidence(evidence, report);
  console.log(
    `HTTP readiness ${passed ? 'passed' : 'failed'}: ${samples.length} requests, p95=${rounded(p95Ms) ?? 'n/a'}ms, errors=${rounded(errorRatePercent)}%`,
  );
  console.log(`Evidence: ${evidence.outputPath}`);
  if (!passed) process.exitCode = 1;
}

async function run(): Promise<void> {
  const config = parseHttpBaselineConfig();
  const evidence = await reserveEvidence('http', config.runId, config.environment);
  try {
    await executeHttpBaseline(config, evidence);
  } catch (error) {
    const failure =
      error instanceof ReadinessError
        ? error.message
        : 'HTTP readiness failed without exposing the underlying response';
    try {
      await recordFailedEvidence(evidence, failure);
    } catch (evidenceError) {
      throw new AggregateError(
        [error, evidenceError],
        'HTTP readiness and evidence writing failed',
      );
    }
    throw error;
  }
}

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  void run().catch((error: unknown) => {
    console.error(
      error instanceof ReadinessError
        ? `HTTP readiness refused: ${error.message}`
        : 'HTTP readiness failed without exposing the underlying response',
    );
    process.exitCode = 1;
  });
}
