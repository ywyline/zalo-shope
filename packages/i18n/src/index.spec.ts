import { describe, expect, it } from 'vitest';

import {
  formatVietnamAddress,
  formatVietnamDate,
  formatVnd,
  normalizeChinaPhone,
  normalizeSupportedPhone,
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

  it.each([
    ['138 1234 5678', '+8613812345678'],
    ['8613812345678', '+8613812345678'],
    ['+86 138-1234-5678', '+8613812345678'],
  ])('normalizes mainland China mobile number %s to E.164', (input, expected) => {
    expect(normalizeChinaPhone(input)).toBe(expected);
    expect(normalizeSupportedPhone(input)).toBe(expected);
  });

  it.each(['+12025550123', '+447911123456', '12812345678', 'not-a-phone'])(
    'rejects unsupported or invalid member phone %s',
    (input) => {
      expect(() => normalizeSupportedPhone(input)).toThrow('Invalid supported mobile number');
    },
  );

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
