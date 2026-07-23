import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  parseHttpBaselineConfig,
  parseRelativeTarget,
  parseTargetEnvironment,
  stagingGuardUrl,
  verifyStagingGuard,
} from './http-baseline';
import {
  cleanupProbeObject,
  createProbeObjectKey,
  isAllowedCacheEvidenceHeader,
  parseStoragePreflightConfig,
  probeObjectOwnership,
  verifyDeleted,
} from './storage-preflight';

const originalEnvironment = { ...process.env };
const deletionOptions = { requestTimeoutMs: 100, retryDelayMs: 0, timeoutMs: 0 };

function restoreEnvironment(): void {
  for (const name of Object.keys(process.env)) {
    if (!(name in originalEnvironment)) delete process.env[name];
  }
  Object.assign(process.env, originalEnvironment);
}

function storageReadTarget() {
  return {
    createReadUrl: vi.fn().mockResolvedValue({
      expiresAt: new Date(Date.now() + 60_000),
      url: 'https://objects.staging.invalid/signed-probe',
    }),
  };
}

afterEach(() => {
  restoreEnvironment();
  vi.unstubAllGlobals();
});

describe('HTTP readiness safety policy', () => {
  it('always rejects an explicitly production-labelled target', () => {
    process.env.READINESS_TARGET_ENV = 'production';
    expect(() => parseTargetEnvironment()).toThrow('Production performance targets are forbidden');
  });

  it('rejects a self-declared staging origin that is absent from the reviewed policy', () => {
    const origin = `https://${randomUUID()}.invalid`;
    Object.assign(process.env, {
      READINESS_ALLOW_REMOTE_STAGING: 'true',
      READINESS_EXPECTED_HTTP_ORIGIN: origin,
      READINESS_HTTP_BASE_URL: origin,
      READINESS_STAGING_GUARD_EXPECTED_ID: 'reviewed-change',
      READINESS_TARGET_ENV: 'staging',
    });

    expect(() =>
      parseHttpBaselineConfig({
        httpStagingOrigins: new Set(),
        policySha256: 'a'.repeat(64),
        repositoryCommit: 'b'.repeat(40),
      }),
    ).toThrow('The HTTP origin is not in the reviewed staging target policy');
  });

  it('uses a fixed same-origin guard and accepts only a safe locale query', () => {
    const baseUrl = new URL('https://api.staging.invalid');
    expect(stagingGuardUrl(baseUrl).href).toBe(
      'https://api.staging.invalid/.well-known/zalo-shop-http-readiness.json',
    );

    process.env.READINESS_HTTP_PATH = '/v1/catalog/home?locale=vi';
    expect(parseRelativeTarget(baseUrl).href).toBe(
      'https://api.staging.invalid/v1/catalog/home?locale=vi',
    );
    process.env.READINESS_HTTP_PATH = '/v1/catalog/home?token=secret';
    expect(() => parseRelativeTarget(baseUrl)).toThrow('only accepts one');
  });

  it('requires the target guard to attest the reviewed repository commit', async () => {
    const origin = 'https://api.staging.invalid';
    Object.assign(process.env, {
      READINESS_ALLOW_REMOTE_STAGING: 'true',
      READINESS_EXPECTED_HTTP_ORIGIN: origin,
      READINESS_HTTP_BASE_URL: origin,
      READINESS_STAGING_GUARD_EXPECTED_ID: 'reviewed-change',
      READINESS_TARGET_ENV: 'staging',
    });
    const config = parseHttpBaselineConfig({
      httpStagingOrigins: new Set([origin]),
      policySha256: 'a'.repeat(64),
      repositoryCommit: 'b'.repeat(40),
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          allowed_origins: [origin],
          environment: 'staging',
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          git_commit: 'c'.repeat(40),
          guard_id: 'reviewed-change',
          purpose: 'http-readiness',
          schema_version: 1,
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(verifyStagingGuard(config)).rejects.toThrow('does not authorize this target');
    expect(fetchMock).toHaveBeenCalledWith(
      new URL(`${origin}/.well-known/zalo-shop-http-readiness.json`),
      expect.objectContaining({ method: 'GET', redirect: 'error' }),
    );
  });
});

describe('storage readiness safety policy', () => {
  it('always rejects an explicitly production-labelled target', () => {
    Object.assign(process.env, {
      NODE_ENV: 'production',
      READINESS_STORAGE_PREFLIGHT: 'true',
      READINESS_TARGET_ENV: 'production',
    });
    expect(() => parseStoragePreflightConfig()).toThrow('Production storage targets are forbidden');
  });

  it('never archives arbitrary sensitive CDN response headers as cache evidence', () => {
    expect(isAllowedCacheEvidenceHeader('x-cache')).toBe(true);
    expect(isAllowedCacheEvidenceHeader('cf-cache-status')).toBe(true);
    expect(isAllowedCacheEvidenceHeader('set-cookie')).toBe(false);
    expect(isAllowedCacheEvidenceHeader('authorization')).toBe(false);
  });

  it('generates a new object key even when the operator repeats a run id', () => {
    const prefix = 'staging/10000000-0000-4000-8000-000000000001/readiness/';
    const first = createProbeObjectKey(prefix, 'repeat-run');
    const second = createProbeObjectKey(prefix, 'repeat-run');
    expect(first).toMatch(
      /^staging\/10000000-0000-4000-8000-000000000001\/readiness\/repeat-run-[0-9a-f-]{36}\/probe\.bin$/u,
    );
    expect(second).not.toBe(first);
  });

  it('accepts only an explicit 404 as deletion evidence', async () => {
    const storage = storageReadTarget();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    await expect(verifyDeleted(storage, 'probe.bin', deletionOptions)).resolves.toBe(true);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 403 })));
    await expect(verifyDeleted(storage, 'probe.bin', deletionOptions)).resolves.toBe(false);

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network unavailable')));
    await expect(verifyDeleted(storage, 'probe.bin', deletionOptions)).resolves.toBe(false);
  });

  it('deletes only content that can be proven to belong to this probe', async () => {
    const storage = storageReadTarget();
    const ownBody = Buffer.from('unique readiness body');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(ownBody, { status: 200 })));
    await expect(probeObjectOwnership(storage, 'probe.bin', ownBody)).resolves.toBe('owned');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('someone else', { status: 200 })),
    );
    await expect(probeObjectOwnership(storage, 'probe.bin', ownBody)).resolves.toBe('foreign');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 403 })));
    await expect(probeObjectOwnership(storage, 'probe.bin', ownBody)).resolves.toBe('unknown');
  });

  it('preserves an object that was replaced after this probe uploaded', async () => {
    const storage = {
      ...storageReadTarget(),
      removeObject: vi.fn().mockResolvedValue(undefined),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('replacement content', { status: 200 })),
    );

    await expect(
      cleanupProbeObject(storage, 'probe.bin', Buffer.from('our original content'), true),
    ).resolves.toEqual({ passed: false, status: 'foreign-object-preserved' });
    expect(storage.removeObject).not.toHaveBeenCalled();
  });
});
