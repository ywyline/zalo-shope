import { BadRequestException } from '@nestjs/common';
import type { RuntimeConfig } from '@zalo-shop/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemberRuntimeCursor } from './member-runtime-cursor';

const storeId = '10000000-0000-4000-8000-000000000001';
const memberId = '20000000-0000-4000-8000-000000000001';
const sortId = '30000000-0000-4000-8000-000000000001';
const currentKey = Buffer.alloc(32, 19).toString('base64url');
const previousKey = Buffer.alloc(32, 23).toString('base64url');
const baseConfig = {
  AFTER_SALE_CURSOR_HMAC_KEYS: currentKey,
  AFTER_SALE_CURSOR_TTL_SECONDS: 900,
} as RuntimeConfig;

function scope() {
  return {
    locale: 'vi' as const,
    memberId,
    resource: 'FAVORITES' as const,
    sortId,
    sortKey: '2026-08-01T09:10:11.123456Z',
    storeId,
  };
}

describe('MemberRuntimeCursor', () => {
  beforeEach(() => vi.setSystemTime(new Date('2026-08-01T09:15:00.000Z')));
  afterEach(() => vi.useRealTimers());

  it('round-trips a member, store, resource and locale scoped cursor', () => {
    const cursor = new MemberRuntimeCursor(baseConfig);
    const token = cursor.encode(scope());
    expect(cursor.decode(token, scope())).toEqual({
      sortId,
      sortKey: '2026-08-01T09:10:11.123456Z',
    });
  });

  it('rejects tampering, expiry and every cross-scope replay with the same error', () => {
    const cursor = new MemberRuntimeCursor({
      ...baseConfig,
      AFTER_SALE_CURSOR_TTL_SECONDS: 60,
    });
    const token = cursor.encode(scope());
    expect(() => cursor.decode(`${token.slice(0, -1)}A`, scope())).toThrow(BadRequestException);
    expect(() => cursor.decode(token, { ...scope(), memberId: sortId })).toThrow(
      BadRequestException,
    );
    expect(() => cursor.decode(token, { ...scope(), storeId: sortId })).toThrow(
      BadRequestException,
    );
    expect(() => cursor.decode(token, { ...scope(), resource: 'PRODUCT_HISTORY' })).toThrow(
      BadRequestException,
    );
    expect(() => cursor.decode(token, { ...scope(), locale: 'en' })).toThrow(BadRequestException);
    vi.setSystemTime(new Date('2026-08-01T09:16:01.000Z'));
    expect(() => cursor.decode(token, scope())).toThrow(BadRequestException);
  });

  it('supports bounded HMAC key rotation and rejects non-canonical timestamps', () => {
    const old = new MemberRuntimeCursor({
      ...baseConfig,
      AFTER_SALE_CURSOR_HMAC_KEYS: previousKey,
    });
    const token = old.encode(scope());
    const rotating = new MemberRuntimeCursor({
      ...baseConfig,
      AFTER_SALE_CURSOR_HMAC_KEYS: `${currentKey},${previousKey}`,
    });
    expect(rotating.decode(token, scope())?.sortId).toBe(sortId);
    expect(() => rotating.encode({ ...scope(), sortKey: '2026-08-01T09:10:11.123Z' })).toThrow(
      BadRequestException,
    );
  });
});
