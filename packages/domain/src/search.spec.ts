import { describe, expect, it } from 'vitest';

import {
  canPersistSearchTelemetry,
  MAX_SEARCH_QUERY_LENGTH,
  normalizeSearchDocumentText,
  normalizeSearchText,
  SearchRuleError,
} from './search';

describe('M3 search normalization', () => {
  it('keeps canonical Vietnamese while producing an accent-insensitive folded form', () => {
    expect(normalizeSearchText('  Son   dưỡng ĐẸP!  ')).toEqual({
      canonical: 'son dưỡng đẹp!',
      display: 'Son dưỡng ĐẸP!',
      folded: 'son duong dep',
      tokens: ['son', 'duong', 'dep'],
    });
  });

  it('normalizes decomposed text and preserves Chinese and English tokens', () => {
    expect(normalizeSearchText('MỸ PHẨM 美妆 Serum').folded).toBe('my pham 美妆 serum');
  });

  it('allows bounded catalog documents to exceed the public query limit', () => {
    expect(normalizeSearchDocumentText(`Serum ${'dưỡng ẩm '.repeat(20)}`).folded).toContain(
      'duong am',
    );
  });

  it('rejects blank and overlong queries by Unicode code point count', () => {
    expect(() => normalizeSearchText(' \n ')).toThrowError(new SearchRuleError('QUERY_EMPTY'));
    expect(() => normalizeSearchText('!!!')).toThrowError(
      new SearchRuleError('QUERY_NO_SEARCHABLE_TEXT'),
    );
    expect(() => normalizeSearchText('a'.repeat(MAX_SEARCH_QUERY_LENGTH + 1))).toThrowError(
      new SearchRuleError('QUERY_TOO_LONG'),
    );
    expect(normalizeSearchText('美'.repeat(MAX_SEARCH_QUERY_LENGTH)).display).toHaveLength(
      MAX_SEARCH_QUERY_LENGTH,
    );
  });

  it('keeps sensitive-looking queries out of history and aggregate telemetry', () => {
    expect(canPersistSearchTelemetry('serum dưỡng ẩm')).toBe(true);
    expect(canPersistSearchTelemetry('0912345678')).toBe(false);
    expect(canPersistSearchTelemetry('token=abc123')).toBe(false);
    expect(canPersistSearchTelemetry('a'.repeat(40))).toBe(false);
  });
});
