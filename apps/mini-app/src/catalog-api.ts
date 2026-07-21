export type Locale = 'en' | 'vi' | 'zh';

export type CatalogMedia = {
  alt_text: string;
  expires_at: string;
  height: number | null;
  url: string;
  width: number | null;
};

export type Brand = {
  code: string;
  introduction: string | null;
  logo: CatalogMedia | null;
  name: string;
  recommended: boolean;
  requested_locale: Locale;
  resolved_locale: Locale;
};

export type Category = {
  children: Category[];
  code: string;
  depth: 1 | 2;
  description: string | null;
  media: CatalogMedia | null;
  name: string;
  requested_locale: Locale;
  resolved_locale: Locale;
};

export type ProductSummary = {
  available?: boolean;
  available_quantity?: number;
  brand: Brand;
  code: string;
  main_category: Category;
  market_price_range_vnd: { maximum: number; minimum: number } | null;
  name: string;
  price_range_vnd: { maximum: number; minimum: number };
  primary_media: CatalogMedia | null;
  promotion_summary?: { code: string; label: string } | null;
  requested_locale: Locale;
  resolved_locale: Locale;
  selling_points: string | null;
  subtitle: string | null;
};

export type ProductDetail = ProductSummary & {
  attributes: Array<{
    code: string;
    label: string;
    purpose: string;
    unit: string | null;
    value: boolean | number | string | null;
  }>;
  description_document: unknown;
  gallery: CatalogMedia[];
  skus: Array<{
    available?: boolean;
    available_quantity?: number;
    code: string;
    market_price_vnd: number | null;
    media: CatalogMedia | null;
    option_values: Array<{
      attribute_code: string;
      attribute_label: string;
      option_code: string;
      option_label: string;
    }>;
    sale_price_vnd: number;
  }>;
  usage_instructions: string | null;
};

export type HomeTarget =
  | { code: string; type: 'BRAND' | 'CATEGORY' | 'PAGE' | 'PRODUCT' }
  | { type: 'EXTERNAL'; url: string }
  | null;

export type HomeModule = {
  background_config: { color?: string | null; overlay?: number | null };
  button_label: string | null;
  content_config: { eyebrow?: string; layout?: 'CAROUSEL' | 'GRID' | 'STACK' };
  id: string;
  items: Array<Brand | Category | ProductSummary>;
  media: CatalogMedia[];
  module_type: 'BANNER' | 'BRAND_GRID' | 'CATEGORY_GRID' | 'HERO' | 'PRODUCT_GRID' | 'RICH_TEXT';
  requested_locale: Locale;
  resolved_locale: Locale;
  summary: string | null;
  target: HomeTarget;
  title: string | null;
};

export type HomePage = {
  modules: HomeModule[];
  requested_locale: Locale;
  resolved_locale: Locale;
  store: {
    code: string;
    industry: 'BEAUTY' | 'FASHION';
    name: string;
    short_description: string | null;
    theme: {
      color_tokens: Record<string, unknown>;
      radius_tokens: Record<string, unknown>;
      typography_tokens: Record<string, unknown>;
      version: number;
    } | null;
  };
  version: number;
};

export type CursorPage<T> = { items: T[]; next_cursor: string | null };

const runtimeEnvironment = import.meta.env as unknown as Record<string, string | undefined>;
export const API_BASE = runtimeEnvironment.VITE_API_BASE_URL ?? '/api';
export const STORE_CODE = runtimeEnvironment.VITE_STORE_CODE ?? 'beauty-local';

export class CatalogRequestError extends Error {
  public constructor(public readonly status: number) {
    super(`Catalog request failed with status ${status}`);
    this.name = 'CatalogRequestError';
  }
}

export async function catalogRequest<T>(
  path: string,
  locale: Locale,
  signal?: AbortSignal,
): Promise<T> {
  const separator = path.includes('?') ? '&' : '?';
  const response = await fetch(
    `${API_BASE}/v1/catalog/${path}${separator}locale=${encodeURIComponent(locale)}`,
    {
      headers: { 'X-Store-Code': STORE_CODE },
      ...(signal ? { signal } : {}),
    },
  );
  if (!response.ok) throw new CatalogRequestError(response.status);
  return (await response.json()) as T;
}
