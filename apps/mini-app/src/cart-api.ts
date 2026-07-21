import { API_BASE, STORE_CODE, type Locale } from './catalog-api';

export type CartIssueCode =
  | 'OUT_OF_STOCK'
  | 'PRICE_CHANGED'
  | 'PRODUCT_UNAVAILABLE'
  | 'PROMOTION_CHANGED'
  | 'SKU_UNAVAILABLE'
  | 'STOCK_INSUFFICIENT';

export type CartIssue = {
  blocking: boolean;
  code: CartIssueCode;
};

export type CartItem = {
  added_unit_price_vnd: number;
  available_quantity: number;
  current_subtotal_vnd: number;
  current_unit_price_vnd: number;
  id: string;
  issues: CartIssue[];
  quantity: number;
  selected: boolean;
  sku_code: string;
  version: number;
  // Display details are optional so the API remains compatible with the
  // frozen M3 contract. The server must never use these fields for pricing.
  product?: {
    available_skus?: Array<{
      code: string;
      option_values: Array<{ option_label: string }>;
    }>;
    code: string;
    name: string;
    primary_media?: { alt_text: string; url: string } | null;
  };
  sku?: {
    code: string;
    option_values: Array<{ option_label: string }>;
    media?: { alt_text: string; url: string } | null;
  };
};

export type CartQuote = {
  base_subtotal_vnd: number;
  discount_vnd: number;
  merchandise_payable_vnd: number;
  order_payable_vnd: null;
};

export type Cart = {
  blocking: boolean;
  id: string;
  items: CartItem[];
  quote: CartQuote | null;
  version: number;
};

export type SetCartItemInput = { quantity: number; selected?: boolean };
export type UpdateCartItemInput = {
  expected_version: number;
  quantity?: number;
  replacement_sku_code?: string;
  selected?: boolean;
};

export class CartRequestError extends Error {
  public constructor(
    public readonly status: number,
    public readonly reasonCode?: string,
  ) {
    super(`Cart request failed with status ${status}`);
    this.name = 'CartRequestError';
  }
}

type RequestOptions = {
  accessToken: string;
  body?: unknown;
  locale: Locale;
  method?: 'DELETE' | 'GET' | 'PATCH' | 'PUT';
  signal?: AbortSignal;
};

async function request<T>(path: string, options: RequestOptions): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.accessToken}`,
    'X-Store-Code': STORE_CODE,
  };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const separator = path.includes('?') ? '&' : '?';
  let response: Response;
  try {
    response = await fetch(
      `${API_BASE}/v1/cart${path}${separator}locale=${encodeURIComponent(options.locale)}`,
      {
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        headers,
        method: options.method ?? 'GET',
        signal: options.signal,
      },
    );
  } catch {
    throw new CartRequestError(0, 'NETWORK_ERROR');
  }
  if (!response.ok) {
    let reasonCode: string | undefined;
    try {
      const error = (await response.json()) as { details?: { reason_code?: unknown } };
      if (typeof error.details?.reason_code === 'string') reasonCode = error.details.reason_code;
    } catch {
      // The API error envelope is intentionally best-effort for the client.
    }
    throw new CartRequestError(response.status, reasonCode);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function getCart(accessToken: string, locale: Locale, signal?: AbortSignal): Promise<Cart> {
  return request<Cart>('', { accessToken, locale, signal });
}

export function setCartItem(
  accessToken: string,
  locale: Locale,
  skuCode: string,
  input: SetCartItemInput,
): Promise<Cart> {
  return request<Cart>(`/items/by-sku/${encodeURIComponent(skuCode)}`, {
    accessToken,
    body: input,
    locale,
    method: 'PUT',
  });
}

export function updateCartItem(
  accessToken: string,
  locale: Locale,
  itemId: string,
  input: UpdateCartItemInput,
): Promise<Cart> {
  return request<Cart>(`/items/${encodeURIComponent(itemId)}`, {
    accessToken,
    body: input,
    locale,
    method: 'PATCH',
  });
}

export function deleteCartItem(
  accessToken: string,
  locale: Locale,
  itemId: string,
  expectedVersion: number,
): Promise<void> {
  return request<void>(
    `/items/${encodeURIComponent(itemId)}?expected_version=${encodeURIComponent(expectedVersion)}`,
    { accessToken, locale, method: 'DELETE' },
  );
}
