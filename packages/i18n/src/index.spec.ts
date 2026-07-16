import { describe, expect, it } from 'vitest';

import {
  formatVietnamAddress,
  formatVietnamDate,
  formatVnd,
  normalizeVietnamPhone,
  translate,
} from './index';

describe('translations', () => {
  it('uses Vietnamese as the fallback for missing translations', () => {
    expect(translate('en', 'app.title')).toBe('Zalo multi-store foundation');
    expect(translate('zh', 'store.empty')).toBe('暂无可用商城。');
  });
});

describe('Vietnam localization', () => {
  it('formats only integer VND', () => {
    expect(formatVnd(1_250_000, 'vi')).toMatch(/1[.\s]250[.\s]000/);
    expect(() => formatVnd(10.5)).toThrow('safe integer');
  });

  it('formats dates in the Ho Chi Minh timezone', () => {
    expect(formatVietnamDate('2026-07-17T00:30:00.000Z', 'en')).toContain('07');
    expect(formatVietnamDate('2026-07-17T00:30:00.000Z', 'en')).toContain('07:30');
  });

  it.each([
    ['0912 345 678', '+84912345678'],
    ['84912345678', '+84912345678'],
    ['+84 912-345-678', '+84912345678'],
  ])('normalizes %s to E.164', (input, expected) => {
    expect(normalizeVietnamPhone(input)).toBe(expected);
  });

  it('rejects invalid Vietnam mobile numbers', () => {
    expect(() => normalizeVietnamPhone('0123456789')).toThrow('Invalid Vietnam mobile number');
  });

  it('formats a three-level Vietnam address', () => {
    expect(
      formatVietnamAddress({
        detail: '12 Nguyễn Huệ',
        district: 'Quận 1',
        province: 'TP. Hồ Chí Minh',
        ward: 'Phường Bến Nghé',
      }),
    ).toBe('12 Nguyễn Huệ, Phường Bến Nghé, Quận 1, TP. Hồ Chí Minh, Việt Nam');
  });
});
