import { API_BASE, STORE_CODE, type Locale } from './catalog-api';

export type MemberProduct = {
  available: boolean;
  last_interaction_at: string;
  name: string;
  primary_media_url: string | null;
  product_code: string;
};

export type MemberProductPage = {
  items: MemberProduct[];
  next_cursor: string | null;
};

export type MemberCommerceSummary = {
  address_count: number;
  favorite_count: number;
  order_status_counts: Record<string, number>;
  product_history_count: number;
  usable_coupon_count: number;
};

export type MemberConsent = {
  occurred_at: string;
  policy_version: string;
  purpose: 'LOCATION' | 'PHONE' | 'PRIVACY' | 'PROFILE' | 'TERMS';
  source: 'MANUAL' | 'ZALO';
  status: 'DENIED' | 'GRANTED' | 'REVOKED';
};

export type PrivacyRequestType =
  'ACCESS' | 'ACCOUNT_CLOSURE' | 'ANONYMIZATION' | 'CORRECTION' | 'DELETION';

export type PrivacyRequest = {
  created_at: string;
  description: string;
  public_number: string;
  request_type: PrivacyRequestType;
  status:
    | 'ACTION_REQUIRED'
    | 'CANCELLED'
    | 'COMPLETED'
    | 'IN_PROGRESS'
    | 'REJECTED'
    | 'SUBMITTED'
    | 'UNDER_REVIEW';
  updated_at: string;
  version: number;
};

export type PrivacyRequestPage = {
  items: PrivacyRequest[];
  next_cursor: string | null;
};

export class MemberRuntimeRequestError extends Error {
  public constructor(public readonly status: number) {
    super(`Member runtime request failed with status ${status}`);
    this.name = 'MemberRuntimeRequestError';
  }
}

async function memberRequest<T>(
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${API_BASE}/v1/members/me/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'X-Store-Code': STORE_CODE,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
  });
  if (!response.ok) throw new MemberRuntimeRequestError(response.status);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function getMemberSummary(accessToken: string): Promise<MemberCommerceSummary> {
  return memberRequest(accessToken, 'commerce-summary');
}

export function listMemberFavorites(
  accessToken: string,
  locale: Locale,
  cursor?: string,
): Promise<MemberProductPage> {
  const query = new URLSearchParams({ limit: '100', locale });
  if (cursor) query.set('cursor', cursor);
  return memberRequest(accessToken, `favorites?${query.toString()}`);
}

export function getMemberFavoriteStatus(
  accessToken: string,
  productCode: string,
): Promise<{ favorited: boolean }> {
  return memberRequest(accessToken, `favorites/${encodeURIComponent(productCode)}`);
}

export function putMemberFavorite(accessToken: string, productCode: string): Promise<void> {
  return memberRequest(accessToken, `favorites/${encodeURIComponent(productCode)}`, {
    method: 'PUT',
  });
}

export function deleteMemberFavorite(accessToken: string, productCode: string): Promise<void> {
  return memberRequest(accessToken, `favorites/${encodeURIComponent(productCode)}`, {
    method: 'DELETE',
  });
}

export function listMemberProductHistory(
  accessToken: string,
  locale: Locale,
  cursor?: string,
): Promise<MemberProductPage> {
  const query = new URLSearchParams({ limit: '100', locale });
  if (cursor) query.set('cursor', cursor);
  return memberRequest(accessToken, `product-history?${query.toString()}`);
}

export function touchMemberProductHistory(accessToken: string, productCode: string): Promise<void> {
  return memberRequest(accessToken, `product-history/${encodeURIComponent(productCode)}`, {
    body: '{}',
    method: 'PUT',
  });
}

export function deleteMemberProductHistory(
  accessToken: string,
  productCode: string,
): Promise<void> {
  return memberRequest(accessToken, `product-history/${encodeURIComponent(productCode)}`, {
    method: 'DELETE',
  });
}

export function clearMemberProductHistory(accessToken: string): Promise<void> {
  return memberRequest(accessToken, 'product-history', {
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    method: 'DELETE',
  });
}

export function listMemberConsents(accessToken: string): Promise<{ items: MemberConsent[] }> {
  return memberRequest(accessToken, 'consents');
}

export function withdrawMemberConsent(accessToken: string, consent: MemberConsent): Promise<void> {
  return memberRequest(accessToken, 'consents', {
    body: JSON.stringify({
      event_id: crypto.randomUUID(),
      policy_version: consent.policy_version,
      purpose: consent.purpose,
      source: 'MANUAL',
      status: 'REVOKED',
    }),
    method: 'POST',
  });
}

export function listPrivacyRequests(
  accessToken: string,
  cursor?: string,
): Promise<PrivacyRequestPage> {
  const query = new URLSearchParams({ limit: '100' });
  if (cursor) query.set('cursor', cursor);
  return memberRequest(accessToken, `privacy-requests?${query.toString()}`);
}

const confirmationCode: Record<PrivacyRequestType, string> = {
  ACCESS: 'SUBMIT_DATA_ACCESS_REQUEST',
  ACCOUNT_CLOSURE: 'SUBMIT_ACCOUNT_CLOSURE_REQUEST',
  ANONYMIZATION: 'SUBMIT_DATA_ANONYMIZATION_REQUEST',
  CORRECTION: 'SUBMIT_DATA_CORRECTION_REQUEST',
  DELETION: 'SUBMIT_DATA_DELETION_REQUEST',
};

export function createPrivacyRequest(
  accessToken: string,
  input: { description: string; requestType: PrivacyRequestType },
): Promise<PrivacyRequest> {
  return memberRequest(accessToken, 'privacy-requests', {
    body: JSON.stringify({
      confirmation_code: confirmationCode[input.requestType],
      description: input.description,
      request_type: input.requestType,
    }),
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    method: 'POST',
  });
}

export function cancelPrivacyRequest(
  accessToken: string,
  privacyRequest: PrivacyRequest,
): Promise<PrivacyRequest> {
  return memberRequest(
    accessToken,
    `privacy-requests/${encodeURIComponent(privacyRequest.public_number)}/cancel`,
    {
      body: JSON.stringify({
        confirmation_code: 'CANCEL_PRIVACY_REQUEST',
        expected_version: privacyRequest.version,
        reason: 'MEMBER_CANCELLED_BEFORE_FULFILLMENT',
      }),
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      method: 'POST',
    },
  );
}
