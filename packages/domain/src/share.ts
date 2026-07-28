import type { Locale } from './index';

export const SHARE_TARGET_TYPES = [
  'STORE',
  'BRAND',
  'CATEGORY',
  'PRODUCT',
  'PROMOTION',
  'COUPON',
] as const;

export type ShareTargetType = (typeof SHARE_TARGET_TYPES)[number];

export class ShareInvariantError extends Error {
  public constructor(
    public readonly code:
      | 'SHARE_TARGET_INVALID'
      | 'SHARE_TARGET_STORE_MISMATCH'
      | 'SHARE_TARGET_NOT_PUBLISHED'
      | 'SHARE_LOCALE_UNAVAILABLE',
  ) {
    super(code);
    this.name = 'ShareInvariantError';
  }
}

const codePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const shortCodePattern = /^[A-Za-z0-9_-]{20,128}$/;
const supportedShareLocales = new Set<string>(['vi', 'zh', 'en']);

function assertRuntimeLocale(locale: string): void {
  if (!supportedShareLocales.has(locale)) throw new ShareInvariantError('SHARE_TARGET_INVALID');
}

function parseFixedHttpsOrigin(origin: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new ShareInvariantError('SHARE_TARGET_INVALID');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    (parsed.pathname !== '/' && parsed.pathname !== '')
  ) {
    throw new ShareInvariantError('SHARE_TARGET_INVALID');
  }
  return parsed;
}

export function assertShareTargetAccessible(input: {
  published: boolean;
  requestStoreId: string;
  targetStoreId: string;
}): void {
  if (
    input.requestStoreId.length === 0 ||
    input.targetStoreId.length === 0 ||
    input.requestStoreId !== input.targetStoreId
  ) {
    throw new ShareInvariantError('SHARE_TARGET_STORE_MISMATCH');
  }
  if (!input.published) throw new ShareInvariantError('SHARE_TARGET_NOT_PUBLISHED');
}

export function resolveShareLocale(requested: Locale, available: readonly Locale[]): Locale {
  assertRuntimeLocale(requested);
  available.forEach(assertRuntimeLocale);
  if (!available.includes('vi')) throw new ShareInvariantError('SHARE_LOCALE_UNAVAILABLE');
  if (available.includes(requested)) return requested;
  return 'vi';
}

export function buildMiniAppSharePath(input: {
  locale: Locale;
  targetCode?: string;
  targetType: ShareTargetType;
}): string {
  assertRuntimeLocale(input.locale);
  const code = input.targetCode?.trim().toLowerCase();
  if (input.targetType === 'STORE') {
    if (code !== undefined) throw new ShareInvariantError('SHARE_TARGET_INVALID');
    return `/?locale=${input.locale}`;
  }
  if (!code || code.length > 64 || !codePattern.test(code)) {
    throw new ShareInvariantError('SHARE_TARGET_INVALID');
  }
  const routes: Record<ShareTargetType, string> = {
    STORE: '/',
    BRAND: '/brands',
    CATEGORY: '/categories',
    PRODUCT: '/products',
    PROMOTION: '/promotions',
    COUPON: '/coupons',
  };
  return `${routes[input.targetType]}/${code}?locale=${input.locale}`;
}

export function buildBrowserShareUrl(input: { publicOrigin: string; shortCode: string }): string {
  if (!shortCodePattern.test(input.shortCode)) {
    throw new ShareInvariantError('SHARE_TARGET_INVALID');
  }
  return new URL(`/s/${input.shortCode}`, parseFixedHttpsOrigin(input.publicOrigin)).toString();
}

export function buildShareImageUrl(input: {
  payloadHash: string;
  publicAssetOrigin: string;
  storeCode: string;
}): string {
  const payloadHash = input.payloadHash.trim().toLowerCase();
  const storeCode = input.storeCode.trim().toLowerCase();
  if (
    !/^[a-f0-9]{64}$/.test(payloadHash) ||
    !codePattern.test(storeCode) ||
    storeCode.length > 64
  ) {
    throw new ShareInvariantError('SHARE_TARGET_INVALID');
  }
  return new URL(
    `/share-cards/${storeCode}/${payloadHash}.webp`,
    parseFixedHttpsOrigin(input.publicAssetOrigin),
  ).toString();
}
