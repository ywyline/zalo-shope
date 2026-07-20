export const MAX_SEARCH_QUERY_LENGTH = 100;

export type SearchRuleErrorCode =
  'QUERY_EMPTY' | 'QUERY_NO_SEARCHABLE_TEXT' | 'QUERY_TOO_LONG' | 'QUERY_TYPE_INVALID';

export class SearchRuleError extends Error {
  public constructor(public readonly code: SearchRuleErrorCode) {
    super(code);
    this.name = 'SearchRuleError';
  }
}

export type NormalizedSearchText = Readonly<{
  canonical: string;
  display: string;
  folded: string;
  tokens: readonly string[];
}>;

/**
 * Produces the forms stored by the M3 search projection. `display` keeps the
 * normalized user text, `canonical` lowercases it for exact matching, and
 * `folded` additionally supports accent-insensitive matching without losing
 * Chinese or English text.
 */
export function normalizeSearchText(input: string): NormalizedSearchText {
  if (typeof input !== 'string') throw new SearchRuleError('QUERY_TYPE_INVALID');

  const display = input.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (display.length === 0) throw new SearchRuleError('QUERY_EMPTY');
  if ([...display].length > MAX_SEARCH_QUERY_LENGTH) {
    throw new SearchRuleError('QUERY_TOO_LONG');
  }

  const canonical = display.toLocaleLowerCase('vi-VN');

  const folded = canonical
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/đ/gu, 'd')
    .replace(/Đ/gu, 'D')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');

  if (folded.length === 0) throw new SearchRuleError('QUERY_NO_SEARCHABLE_TEXT');

  return Object.freeze({
    canonical,
    display,
    folded,
    tokens: Object.freeze(folded.split(' ')),
  });
}
