import { API_BASE, STORE_CODE, type Locale } from './catalog-api';

export type SearchProduct = {
  available: boolean;
  available_quantity: number;
  brand_code: string;
  main_category_code: string;
  minimum_sale_price_vnd: number;
  name: string;
  primary_media_url: string | null;
  product_code: string;
  promotion_summary: { code: string; label: string } | null;
  published_at: string;
};

export type SearchProductPage = {
  items: SearchProduct[];
  next_cursor: string | null;
  normalized_query: string | null;
};

export type SearchFacets = {
  attributes: Array<{
    code: string;
    label: string;
    options: Array<{ code: string; count: number; label: string }>;
  }>;
  brands: Array<{ code: string; count: number; name: string }>;
  categories: Array<{ code: string; count: number; depth: number; name: string }>;
  price_range_vnd: { maximum: number; minimum: number } | null;
};

export type SearchSuggestion = {
  kind: 'PRODUCT' | 'QUERY';
  product_code: string | null;
  text: string;
};

export type SearchHistory = {
  items: Array<{ last_searched_at: string; locale: Locale; query: string }>;
};

export class SearchRequestError extends Error {
  public constructor(public readonly status: number) {
    super(`Search request failed with status ${status}`);
    this.name = 'SearchRequestError';
  }
}

async function request<T>(
  path: string,
  locale: Locale,
  options: {
    accessToken?: string;
    includeLocale?: boolean;
    method?: 'DELETE' | 'GET';
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const separator = path.includes('?') ? '&' : '?';
  const target =
    options.includeLocale === false
      ? `${API_BASE}${path}`
      : `${API_BASE}${path}${separator}locale=${encodeURIComponent(locale)}`;
  const response = await fetch(target, {
    headers: {
      'X-Store-Code': STORE_CODE,
      ...(options.accessToken ? { Authorization: `Bearer ${options.accessToken}` } : {}),
    },
    method: options.method ?? 'GET',
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) throw new SearchRequestError(response.status);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function searchProducts(
  parameters: URLSearchParams,
  locale: Locale,
  accessToken?: string,
  signal?: AbortSignal,
): Promise<SearchProductPage> {
  return request(`/v1/search/products?${parameters.toString()}`, locale, {
    ...(accessToken ? { accessToken } : {}),
    ...(signal ? { signal } : {}),
  });
}

export function searchSuggestions(
  query: string,
  locale: Locale,
  signal?: AbortSignal,
): Promise<{ items: SearchSuggestion[] }> {
  return request(
    `/v1/search/suggestions?q=${encodeURIComponent(query)}&limit=8`,
    locale,
    signal ? { signal } : {},
  );
}

export function searchFacets(locale: Locale, signal?: AbortSignal): Promise<SearchFacets> {
  return request('/v1/search/facets', locale, signal ? { signal } : {});
}

export function searchHistory(locale: Locale, accessToken: string): Promise<SearchHistory> {
  return request('/v1/members/me/search-history?limit=20', locale, {
    accessToken,
    includeLocale: false,
  });
}

export function clearSearchHistory(locale: Locale, accessToken: string): Promise<void> {
  return request('/v1/members/me/search-history', locale, {
    accessToken,
    includeLocale: false,
    method: 'DELETE',
  });
}
