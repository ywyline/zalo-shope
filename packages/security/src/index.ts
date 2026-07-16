import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 64;

function derivePasswordKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      SCRYPT_KEY_LENGTH,
      { N: SCRYPT_N, p: SCRYPT_P, r: SCRYPT_R },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      },
    );
  });
}

export class SecurityValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SecurityValidationError';
  }
}

function encodeBase64Url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12 || Buffer.byteLength(password, 'utf8') > 1_024) {
    throw new SecurityValidationError('Password length is invalid');
  }
  const salt = randomBytes(16);
  const derived = await derivePasswordKey(password, salt);
  return [
    'scrypt',
    'v1',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    encodeBase64Url(salt),
    encodeBase64Url(derived),
  ].join('$');
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  const [algorithm, version, n, r, p, saltValue, expectedValue, ...rest] = encodedHash.split('$');
  if (
    algorithm !== 'scrypt' ||
    version !== 'v1' ||
    n !== String(SCRYPT_N) ||
    r !== String(SCRYPT_R) ||
    p !== String(SCRYPT_P) ||
    !saltValue ||
    !expectedValue ||
    rest.length > 0
  ) {
    return false;
  }
  const expected = decodeBase64Url(expectedValue);
  if (expected.length !== SCRYPT_KEY_LENGTH) return false;
  const actual = await derivePasswordKey(password, decodeBase64Url(saltValue));
  return timingSafeEqual(actual, expected);
}

function decodeEncryptionKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32) {
    throw new SecurityValidationError('PII encryption key must decode to 32 bytes');
  }
  return key;
}

export function encryptSensitive(plaintext: string, base64Key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', decodeEncryptionKey(base64Key), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', encodeBase64Url(iv), encodeBase64Url(tag), encodeBase64Url(ciphertext)].join('.');
}

export function decryptSensitive(encoded: string, base64Key: string): string {
  const [version, ivValue, tagValue, ciphertextValue, ...rest] = encoded.split('.');
  if (version !== 'v1' || !ivValue || !tagValue || !ciphertextValue || rest.length > 0) {
    throw new SecurityValidationError('Encrypted value is malformed');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    decodeEncryptionKey(base64Key),
    decodeBase64Url(ivValue),
  );
  decipher.setAuthTag(decodeBase64Url(tagValue));
  return Buffer.concat([
    decipher.update(decodeBase64Url(ciphertextValue)),
    decipher.final(),
  ]).toString('utf8');
}

export function hashSensitive(value: string, key: string): string {
  if (key.length < 32) throw new SecurityValidationError('Hash key is too short');
  return createHmac('sha256', key).update(value, 'utf8').digest('base64url');
}

export function createOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export type JwtPayload = Readonly<{
  aud: string;
  exp: number;
  iat: number;
  iss: string;
  jti: string;
  sub: string;
  [key: string]: unknown;
}>;

export function signJwt(payload: JwtPayload, secret: string): string {
  if (secret.length < 32) throw new SecurityValidationError('JWT secret is too short');
  const header = encodeBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = encodeBase64Url(JSON.stringify(payload));
  const signature = createHmac('sha256', secret).update(`${header}.${body}`).digest();
  return `${header}.${body}.${encodeBase64Url(signature)}`;
}

export function verifyJwt(
  token: string,
  input: { audience: string; issuer: string; now?: number; secret: string },
): JwtPayload {
  const [headerValue, bodyValue, signatureValue, ...rest] = token.split('.');
  if (!headerValue || !bodyValue || !signatureValue || rest.length > 0) {
    throw new SecurityValidationError('JWT is malformed');
  }
  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(decodeBase64Url(headerValue).toString('utf8')) as unknown;
    payload = JSON.parse(decodeBase64Url(bodyValue).toString('utf8')) as unknown;
  } catch {
    throw new SecurityValidationError('JWT is malformed');
  }
  if (
    typeof header !== 'object' ||
    header === null ||
    (header as Record<string, unknown>).alg !== 'HS256' ||
    (header as Record<string, unknown>).typ !== 'JWT'
  ) {
    throw new SecurityValidationError('JWT algorithm is invalid');
  }
  const expected = createHmac('sha256', input.secret)
    .update(`${headerValue}.${bodyValue}`)
    .digest();
  const actual = decodeBase64Url(signatureValue);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new SecurityValidationError('JWT signature is invalid');
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new SecurityValidationError('JWT payload is invalid');
  }
  const claims = payload as Record<string, unknown>;
  const now = input.now ?? Math.floor(Date.now() / 1_000);
  if (
    claims.iss !== input.issuer ||
    claims.aud !== input.audience ||
    typeof claims.exp !== 'number' ||
    claims.exp <= now ||
    typeof claims.iat !== 'number' ||
    claims.iat > now + 60 ||
    typeof claims.sub !== 'string' ||
    typeof claims.jti !== 'string'
  ) {
    throw new SecurityValidationError('JWT claims are invalid');
  }
  return claims as JwtPayload;
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeBase32(value: string): Buffer {
  const normalized = value.toUpperCase().replace(/=+$/g, '').replace(/\s/g, '');
  let bits = '';
  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) throw new SecurityValidationError('TOTP secret is invalid');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  if (bytes.length < 10) throw new SecurityValidationError('TOTP secret is too short');
  return Buffer.from(bytes);
}

export function generateTotp(
  secretBase32: string,
  input: { digits?: number; period?: number; time?: number } = {},
): string {
  const digits = input.digits ?? 6;
  const period = input.period ?? 30;
  const time = input.time ?? Date.now();
  if (digits < 6 || digits > 8 || period < 15) {
    throw new SecurityValidationError('TOTP parameters are invalid');
  }
  const counter = Math.floor(time / 1_000 / period);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', decodeBase32(secretBase32)).update(counterBuffer).digest();
  const offset = digest.at(-1)! & 0x0f;
  const binary = (digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(binary).padStart(digits, '0');
}

export function verifyTotp(
  token: string,
  secretBase32: string,
  input: { period?: number; time?: number; window?: number } = {},
): boolean {
  if (!/^\d{6}$/.test(token)) return false;
  const period = input.period ?? 30;
  const time = input.time ?? Date.now();
  const window = input.window ?? 1;
  for (let offset = -window; offset <= window; offset += 1) {
    const candidate = generateTotp(secretBase32, { period, time: time + offset * period * 1_000 });
    if (timingSafeEqual(Buffer.from(candidate), Buffer.from(token))) return true;
  }
  return false;
}
