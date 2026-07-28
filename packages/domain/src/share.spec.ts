import { describe, expect, it } from 'vitest';

import {
  assertShareTargetAccessible,
  buildBrowserShareUrl,
  buildMiniAppSharePath,
  buildShareImageUrl,
  resolveShareLocale,
} from './share';

describe('M6 share target rules', () => {
  it('builds only fixed Mini App paths from safe public codes', () => {
    expect(buildMiniAppSharePath({ locale: 'vi', targetType: 'STORE' })).toBe('/?locale=vi');
    expect(
      buildMiniAppSharePath({ locale: 'zh', targetCode: 'ao-khoac-01', targetType: 'PRODUCT' }),
    ).toBe('/products/ao-khoac-01?locale=zh');
    expect(() =>
      buildMiniAppSharePath({
        locale: 'en',
        targetCode: '../other-store',
        targetType: 'PRODUCT',
      }),
    ).toThrow('SHARE_TARGET_INVALID');
    expect(() =>
      buildMiniAppSharePath({ locale: 'vi', targetCode: 'unexpected', targetType: 'STORE' }),
    ).toThrow('SHARE_TARGET_INVALID');
    expect(() =>
      buildMiniAppSharePath({
        locale: 'vi&next=https://attacker.example' as 'vi',
        targetCode: 'serum-01',
        targetType: 'PRODUCT',
      }),
    ).toThrow('SHARE_TARGET_INVALID');
  });

  it('builds browser and image URLs only from fixed HTTPS origins', () => {
    const payloadHash = 'a'.repeat(64);
    expect(
      buildBrowserShareUrl({
        publicOrigin: 'https://shop.example.vn',
        shortCode: 'Abcdefghijklmnopqrst',
      }),
    ).toBe('https://shop.example.vn/s/Abcdefghijklmnopqrst');
    expect(
      buildShareImageUrl({
        payloadHash,
        publicAssetOrigin: 'https://cdn.example.vn',
        storeCode: 'beauty',
      }),
    ).toBe(`https://cdn.example.vn/share-cards/beauty/${payloadHash}.webp`);
    expect(
      buildShareImageUrl({
        payloadHash,
        publicAssetOrigin: 'https://cdn.example.vn',
        storeCode: 'fashion',
      }),
    ).toBe(`https://cdn.example.vn/share-cards/fashion/${payloadHash}.webp`);
    expect(() =>
      buildBrowserShareUrl({
        publicOrigin: 'javascript:alert(1)',
        shortCode: 'Abcdefghijklmnopqrst',
      }),
    ).toThrow('SHARE_TARGET_INVALID');
    expect(() =>
      buildShareImageUrl({
        payloadHash: '../other-store',
        publicAssetOrigin: 'https://cdn.example.vn',
        storeCode: 'beauty',
      }),
    ).toThrow('SHARE_TARGET_INVALID');
  });

  it('falls back to Vietnamese and fails closed without it', () => {
    expect(resolveShareLocale('zh', ['vi', 'en'])).toBe('vi');
    expect(resolveShareLocale('en', ['vi', 'en'])).toBe('en');
    expect(() => resolveShareLocale('zh', ['en'])).toThrow('SHARE_LOCALE_UNAVAILABLE');
    expect(() => resolveShareLocale('en', ['en'])).toThrow('SHARE_LOCALE_UNAVAILABLE');
  });

  it('requires the target to belong to the request store and be published', () => {
    expect(() =>
      assertShareTargetAccessible({
        published: true,
        requestStoreId: 'beauty',
        targetStoreId: 'beauty',
      }),
    ).not.toThrow();
    expect(() =>
      assertShareTargetAccessible({
        published: true,
        requestStoreId: 'beauty',
        targetStoreId: 'fashion',
      }),
    ).toThrow('SHARE_TARGET_STORE_MISMATCH');
    expect(() =>
      assertShareTargetAccessible({
        published: false,
        requestStoreId: 'beauty',
        targetStoreId: 'beauty',
      }),
    ).toThrow('SHARE_TARGET_NOT_PUBLISHED');
    expect(() =>
      assertShareTargetAccessible({ published: true, requestStoreId: '', targetStoreId: '' }),
    ).toThrow('SHARE_TARGET_STORE_MISMATCH');
  });
});
