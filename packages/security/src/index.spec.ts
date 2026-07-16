import { describe, expect, it } from 'vitest';

import {
  createOpaqueToken,
  decryptSensitive,
  encryptSensitive,
  generateTotp,
  hashPassword,
  hashSensitive,
  SecurityValidationError,
  signJwt,
  verifyJwt,
  verifyPassword,
  verifyTotp,
} from './index';

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const JWT_SECRET = 'test-jwt-secret-that-is-at-least-32-characters';

describe('password security', () => {
  it('hashes with a random salt and verifies without leaking comparisons', async () => {
    const first = await hashPassword('correct horse battery staple');
    const second = await hashPassword('correct horse battery staple');
    expect(first).not.toBe(second);
    await expect(verifyPassword('correct horse battery staple', first)).resolves.toBe(true);
    await expect(verifyPassword('wrong password value', first)).resolves.toBe(false);
    await expect(verifyPassword('correct horse battery staple', 'bad-hash')).resolves.toBe(false);
  });

  it('rejects short passwords', async () => {
    await expect(hashPassword('too-short')).rejects.toThrow(SecurityValidationError);
  });
});

describe('PII protection', () => {
  it('encrypts with unique nonces and detects tampering', () => {
    const first = encryptSensitive('+84912345678', ENCRYPTION_KEY);
    const second = encryptSensitive('+84912345678', ENCRYPTION_KEY);
    expect(first).not.toBe(second);
    expect(decryptSensitive(first, ENCRYPTION_KEY)).toBe('+84912345678');
    expect(() => decryptSensitive(`${first.slice(0, -1)}x`, ENCRYPTION_KEY)).toThrow();
  });

  it('creates deterministic keyed lookup hashes', () => {
    expect(hashSensitive('+84912345678', JWT_SECRET)).toBe(
      hashSensitive('+84912345678', JWT_SECRET),
    );
  });
});

describe('tokens', () => {
  it('validates signature, issuer, audience and expiration', () => {
    const payload = {
      aud: 'zalo-shop-test',
      exp: 2_000,
      iat: 1_000,
      iss: 'zalo-shop',
      jti: 'token-1',
      sub: 'member-1',
    };
    const token = signJwt(payload, JWT_SECRET);
    expect(
      verifyJwt(token, {
        audience: 'zalo-shop-test',
        issuer: 'zalo-shop',
        now: 1_500,
        secret: JWT_SECRET,
      }).sub,
    ).toBe('member-1');
    expect(() =>
      verifyJwt(token, {
        audience: 'wrong',
        issuer: 'zalo-shop',
        now: 1_500,
        secret: JWT_SECRET,
      }),
    ).toThrow();
    expect(() =>
      verifyJwt(token, {
        audience: 'zalo-shop-test',
        issuer: 'zalo-shop',
        now: 2_000,
        secret: JWT_SECRET,
      }),
    ).toThrow();
  });

  it('creates 256-bit opaque tokens', () => {
    expect(Buffer.from(createOpaqueToken(), 'base64url')).toHaveLength(32);
  });
});

describe('TOTP', () => {
  it('matches the RFC 6238 SHA-1 vector and verifies only within the window', () => {
    const rfcSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(generateTotp(rfcSecret, { digits: 8, time: 59_000 })).toBe('94287082');
    const token = generateTotp(rfcSecret, { time: 1_700_000_000_000 });
    expect(verifyTotp(token, rfcSecret, { time: 1_700_000_000_000 })).toBe(true);
    expect(verifyTotp(token, rfcSecret, { time: 1_700_000_120_000 })).toBe(false);
  });
});
