import { BadRequestException } from '@nestjs/common';
import type { RuntimeConfig } from '@zalo-shop/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AfterSalesCursor, hashAfterSaleCursorFilters } from './after-sales-cursor';

const storeId = '10000000-0000-4000-8000-000000000001';
const memberId = '20000000-0000-4000-8000-000000000001';
const sortId = '30000000-0000-4000-8000-000000000001';
const currentKey = Buffer.alloc(32, 7).toString('base64url');
const previousKey = Buffer.alloc(32, 8).toString('base64url');
const baseConfig = {
  AFTER_SALE_CURSOR_HMAC_KEYS: currentKey,
  AFTER_SALE_CURSOR_TTL_SECONDS: 900,
} as RuntimeConfig;

function scope(filtersHash = hashAfterSaleCursorFilters({ status: null, type: null })) {
  return {
    filters_hash: filtersHash,
    resource: 'MEMBER_AFTER_SALES' as const,
    sort_id: sortId,
    sort_key: '2026-07-28T08:00:00.000731Z',
    store_id: storeId,
    subject_id: memberId,
    subject_type: 'MEMBER' as const,
  };
}

describe('AfterSalesCursor', () => {
  beforeEach(() => vi.setSystemTime(new Date('2026-07-28T08:05:00.000Z')));
  afterEach(() => vi.useRealTimers());

  it('round-trips a scoped cursor and canonicalizes filters', () => {
    const cursor = new AfterSalesCursor(baseConfig);
    expect(hashAfterSaleCursorFilters({ type: null, status: 'APPROVED' })).toBe(
      hashAfterSaleCursorFilters({ status: 'APPROVED', type: null }),
    );
    const token = cursor.encode(scope());
    expect(token).toMatch(/^c1_[A-Za-z0-9_-]+$/u);
    expect(cursor.decode(token, scope())).toEqual({
      sortId,
      sortKey: '2026-07-28T08:00:00.000731Z',
    });
  });

  it('preserves all six database microseconds and rejects non-canonical timestamps', () => {
    const cursor = new AfterSalesCursor(baseConfig);
    const token = cursor.encode(scope());
    expect(cursor.decode(token, scope()).sortKey).toBe('2026-07-28T08:00:00.000731Z');
    for (const sortKey of [
      '2026-07-28T08:00:00.000Z',
      '2026-02-30T08:00:00.000731Z',
      '2026-07-28T08:00:00.000731+00:00',
    ]) {
      expect(() => cursor.encode({ ...scope(), sort_key: sortKey })).toThrow(BadRequestException);
    }
  });

  it('rejects tampering, expiry and cross-scope reuse with the same stable error', () => {
    const cursor = new AfterSalesCursor({
      ...baseConfig,
      AFTER_SALE_CURSOR_TTL_SECONDS: 60,
    });
    const token = cursor.encode(scope());
    const invalid = [
      `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`,
      token,
      token,
      token,
    ];
    expect(() => cursor.decode(invalid[0]!, scope())).toThrow(BadRequestException);
    expect(() => cursor.decode(invalid[1]!, { ...scope(), store_id: sortId })).toThrow(
      BadRequestException,
    );
    expect(() =>
      cursor.decode(invalid[2]!, {
        ...scope(),
        filters_hash: hashAfterSaleCursorFilters({ status: 'APPROVED', type: null }),
      }),
    ).toThrow(BadRequestException);
    expect(() =>
      cursor.decode(invalid[2]!, {
        ...scope(),
        resource: 'ADMIN_AFTER_SALES',
        subject_type: 'ADMIN',
      }),
    ).toThrow(BadRequestException);
    expect(() =>
      cursor.decode(invalid[2]!, {
        ...scope(),
        subject_id: sortId,
      }),
    ).toThrow(BadRequestException);
    vi.setSystemTime(new Date('2026-07-28T08:06:01.000Z'));
    expect(() => cursor.decode(invalid[3]!, scope())).toThrow(BadRequestException);
  });

  it('signs with the active key and verifies cursors during bounded key rotation', () => {
    const oldSigner = new AfterSalesCursor({
      ...baseConfig,
      AFTER_SALE_CURSOR_HMAC_KEYS: previousKey,
    });
    const oldToken = oldSigner.encode(scope());
    const rotating = new AfterSalesCursor({
      ...baseConfig,
      AFTER_SALE_CURSOR_HMAC_KEYS: `${currentKey},${previousKey}`,
    });
    expect(rotating.decode(oldToken, scope()).sortId).toBe(sortId);
    const newToken = rotating.encode(scope());
    expect(() => oldSigner.decode(newToken, scope())).toThrow(BadRequestException);
  });
});
