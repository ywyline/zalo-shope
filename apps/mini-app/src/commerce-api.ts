import { API_BASE, STORE_CODE, type Locale } from './catalog-api';

export class CommerceRequestError extends Error {
  public constructor(
    public readonly status: number,
    public readonly reasonCode?: string,
  ) {
    super(reasonCode ?? `HTTP_${status}`);
    this.name = 'CommerceRequestError';
  }
}

export type Address = {
  created_at: string;
  detail: string;
  district_code: string;
  district_name: string;
  id: string;
  is_default: boolean;
  label: string | null;
  masked_phone: string;
  province_code: string;
  province_name: string;
  recipient_name: string;
  status: 'ACTIVE' | 'DISABLED';
  updated_at: string;
  version: number;
  ward_code: string;
  ward_name: string;
};

export type AddressInput = {
  detail: string;
  district_code: string;
  is_default: boolean;
  label?: string;
  phone: string;
  province_code: string;
  recipient_name: string;
  ward_code: string;
};

export type AdministrativeArea = {
  code: string;
  level: 'PROVINCE' | 'DISTRICT' | 'WARD';
  name: string;
  parent_code: string | null;
  source_version: string;
};

export type CheckoutItem = { quantity: number; sku_code: string };
export type PaymentMethod = 'COD' | 'ONLINE';
export type CheckoutQuote = {
  base_subtotal_vnd: number;
  cod_policy: { enabled: boolean; max_amount_vnd: number | null };
  discount_vnd: number;
  lines: Array<{ payable_vnd: number; quantity: number; sku_code: string }>;
  merchandise_payable_vnd: number;
  order_payable_vnd: number;
  quote_hash: string;
  remote_surcharge_vnd: number;
  shipping_discount_vnd: number;
  shipping_fee_vnd: number;
};

export type OrderSummary = {
  created_at: string;
  id: string;
  items: Array<{ payable_vnd: number; quantity: number; sku_code: string }>;
  order_number: string;
  payable_vnd: number;
  payment_attempt_id?: string;
  payment_method: PaymentMethod;
  payment_status: string;
  status: string;
  version?: number;
};

export type OrderDetail = OrderSummary & {
  address: Omit<
    Address,
    'created_at' | 'id' | 'is_default' | 'label' | 'status' | 'updated_at' | 'version'
  > | null;
  cancellation_reason: string | null;
  payment_attempt_id: string | null;
  refunds: Array<{
    amount_vnd: number;
    public_number: string;
    requested_at: string;
    status: string;
    updated_at: string;
  }>;
  transitions: Array<{
    created_at: string;
    event: string;
    from_status: string | null;
    reason: string | null;
    to_status: string;
  }>;
};

export type PaymentAttemptStatus =
  | 'CANCELLED'
  | 'CREATED'
  | 'EXPIRED'
  | 'FAILED'
  | 'PROVIDER_PENDING'
  | 'REVIEW_REQUIRED'
  | 'SUCCEEDED';

export type PaymentAttempt = {
  amount_vnd: number;
  created_at: string;
  currency: 'VND';
  expires_at: string;
  id: string;
  launch_ready: boolean;
  order_id: string;
  payment_number: string;
  provider_order_bound: boolean;
  status: PaymentAttemptStatus;
  transitions: Array<{
    created_at: string;
    event: string;
    from_status: PaymentAttemptStatus | null;
    to_status: PaymentAttemptStatus;
  }>;
  version: number;
};

export type PaymentLaunch = {
  expires_at: string;
  kind: 'ZALO_CHECKOUT_CREATE_ORDER';
  launch_token: string;
  payload: {
    amount: number;
    desc: string;
    extradata: string;
    item: Array<{ amount: number; id: string }>;
    mac: string;
    method: string;
  };
  payment_id: string;
};

export type Shipment = {
  created_at: string;
  delivered_at: string | null;
  public_number: string;
  status: string;
  tracking_events: Array<{
    location_masked: string | null;
    message_key: string;
    occurred_at: string;
    status: string;
  }>;
  updated_at: string;
};

type Options = {
  accessToken: string;
  body?: unknown;
  idempotencyKey?: string;
  method?: 'DELETE' | 'GET' | 'PATCH' | 'POST';
  signal?: AbortSignal;
};

async function request<T>(path: string, options: Options): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.accessToken}`,
    'X-Store-Code': STORE_CODE,
  };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      headers,
      method: options.method ?? 'GET',
      signal: options.signal,
    });
  } catch {
    throw new CommerceRequestError(0, 'NETWORK_ERROR');
  }
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as {
      code?: string;
      details?: { reason_code?: string };
    };
    throw new CommerceRequestError(response.status, error.details?.reason_code ?? error.code);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function listAddresses(accessToken: string, signal?: AbortSignal): Promise<Address[]> {
  return request('/v1/member/addresses', { accessToken, signal });
}

export function listAdministrativeAreas(
  accessToken: string,
  level: AdministrativeArea['level'],
  parentCode?: string,
  signal?: AbortSignal,
): Promise<{ items: AdministrativeArea[] }> {
  const query = new URLSearchParams({ level });
  if (parentCode) query.set('parent_code', parentCode);
  return request(`/v1/member/administrative-areas?${query.toString()}`, {
    accessToken,
    signal,
  });
}

export function createAddress(accessToken: string, input: AddressInput): Promise<Address> {
  return request('/v1/member/addresses', { accessToken, body: input, method: 'POST' });
}

export function updateAddress(
  accessToken: string,
  addressId: string,
  input: Partial<AddressInput> & { expected_version: number },
): Promise<Address> {
  return request(`/v1/member/addresses/${encodeURIComponent(addressId)}`, {
    accessToken,
    body: input,
    method: 'PATCH',
  });
}

export function deleteAddress(accessToken: string, addressId: string): Promise<void> {
  return request(`/v1/member/addresses/${encodeURIComponent(addressId)}`, {
    accessToken,
    method: 'DELETE',
  });
}

export function quoteCheckout(
  accessToken: string,
  locale: Locale,
  input: {
    address_id: string;
    coupon_code: string | null;
    items: CheckoutItem[];
    payment_method: PaymentMethod;
  },
  signal?: AbortSignal,
): Promise<CheckoutQuote> {
  return request('/v1/checkout/quote', {
    accessToken,
    body: { ...input, locale },
    method: 'POST',
    signal,
  });
}

export function createOrder(
  accessToken: string,
  locale: Locale,
  input: {
    address_id: string;
    coupon_code: string | null;
    items: CheckoutItem[];
    payment_method: PaymentMethod;
    quote_hash: string;
  },
  idempotencyKey: string,
): Promise<OrderSummary> {
  return request('/v1/checkout/orders', {
    accessToken,
    body: { ...input, locale },
    idempotencyKey,
    method: 'POST',
  });
}

export function getPayment(
  accessToken: string,
  paymentId: string,
  signal?: AbortSignal,
): Promise<PaymentAttempt> {
  return request(`/v1/payments/${encodeURIComponent(paymentId)}`, { accessToken, signal });
}

export function getPaymentLaunch(
  accessToken: string,
  paymentId: string,
  signal?: AbortSignal,
): Promise<PaymentLaunch> {
  return request(`/v1/payments/${encodeURIComponent(paymentId)}/launch`, {
    accessToken,
    signal,
  });
}

export function bindPaymentProviderOrder(
  accessToken: string,
  orderId: string,
  paymentId: string,
  input: { launch_token: string; provider_order_id: string },
  idempotencyKey: string,
): Promise<PaymentAttempt> {
  return request(
    `/v1/orders/${encodeURIComponent(orderId)}/payments/${encodeURIComponent(paymentId)}/provider-order`,
    {
      accessToken,
      body: input,
      idempotencyKey,
      method: 'POST',
    },
  );
}

export function queryPayment(accessToken: string, paymentId: string): Promise<PaymentAttempt> {
  return request(`/v1/payments/${encodeURIComponent(paymentId)}/query`, {
    accessToken,
    method: 'POST',
  });
}

export function retryPayment(
  accessToken: string,
  orderId: string,
  idempotencyKey: string,
): Promise<PaymentAttempt> {
  return request(`/v1/orders/${encodeURIComponent(orderId)}/payments`, {
    accessToken,
    body: {},
    idempotencyKey,
    method: 'POST',
  });
}

export function listOrders(accessToken: string, signal?: AbortSignal) {
  return request<{ items: OrderSummary[]; next_cursor: string | null }>('/v1/orders?limit=50', {
    accessToken,
    signal,
  });
}

export function getOrder(accessToken: string, orderId: string, signal?: AbortSignal) {
  return request<OrderDetail>(`/v1/orders/${encodeURIComponent(orderId)}`, {
    accessToken,
    signal,
  });
}

export function getOrderShipment(accessToken: string, orderId: string, signal?: AbortSignal) {
  return request<{ shipment: Shipment | null }>(
    `/v1/orders/${encodeURIComponent(orderId)}/shipment`,
    { accessToken, signal },
  );
}

export function cancelOrder(accessToken: string, orderId: string, reason: string) {
  return request<OrderSummary>(`/v1/orders/${encodeURIComponent(orderId)}/cancel`, {
    accessToken,
    body: { reason },
    method: 'POST',
  });
}
