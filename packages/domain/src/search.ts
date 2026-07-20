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

const SENSITIVE_SEARCH_PATTERNS = [
  /(?:bearer|token|secret|password|mật\s*khẩu|密码)\s*[:=]/iu,
  /\b(?:\+?84|0)(?:3[2-9]|5[25689]|7[06-9]|8[1-689]|9[0-46-9])\d{7}\b/u,
  /\b[A-Za-z0-9_-]{32,}\b/u,
] as const;

function normalize(input: string, maximumLength?: number): NormalizedSearchText {
  if (typeof input !== 'string') throw new SearchRuleError('QUERY_TYPE_INVALID');

  const display = input.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (display.length === 0) throw new SearchRuleError('QUERY_EMPTY');
  if (maximumLength !== undefined && [...display].length > maximumLength) {
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

/** Normalizes a user query and enforces the public query-length contract. */
export function normalizeSearchText(input: string): NormalizedSearchText {
  return normalize(input, MAX_SEARCH_QUERY_LENGTH);
}

/**
 * Produces the forms stored by the M3 search projection. Product documents
 * legitimately combine several bounded catalog fields and can exceed a query's
 * 100-code-point input limit.
 */
export function normalizeSearchDocumentText(input: string): NormalizedSearchText {
  return normalize(input);
}

/** Search remains available, but sensitive-looking text must not enter history or aggregates. */
export function canPersistSearchTelemetry(input: string): boolean {
  return !SENSITIVE_SEARCH_PATTERNS.some((pattern) => pattern.test(input));
}
