import React, { useEffect, useState, type FormEvent } from 'react';

type Locale = 'en' | 'vi' | 'zh';
type Store = { code: string; default_locale: Locale; id: string };
type Request = <T>(path: string, options?: RequestInit) => Promise<T>;
type Policy = {
  cod_enabled: boolean;
  cod_max_amount_vnd: number | null;
  enabled: boolean;
  flat_shipping_fee_vnd: number;
  free_shipping_threshold_vnd: number | null;
  remote_province_codes: string[];
  remote_surcharge_vnd: number;
  store_id: string;
  updated_at: string;
  version: number;
};

const copy = {
  vi: {
    cod: 'COD',
    codMax: 'Giới hạn số tiền COD',
    enabled: 'Bật giao hàng',
    error: 'Không thể tải hoặc lưu chính sách.',
    free: 'Ngưỡng miễn phí',
    loading: 'Đang tải…',
    provinces: 'Mã tỉnh vùng xa',
    save: 'Lưu chính sách',
    shipping: 'Phí vận chuyển cố định',
    surcharge: 'Phụ phí vùng xa',
    title: 'Giao hàng & COD',
    updated: 'Phiên bản',
  },
  zh: {
    cod: 'COD',
    codMax: 'COD 金额上限',
    enabled: '启用配送',
    error: '配送策略加载或保存失败。',
    free: '免邮门槛',
    loading: '正在加载…',
    provinces: '偏远省份编码',
    save: '保存策略',
    shipping: '固定运费',
    surcharge: '偏远附加费',
    title: '配送与 COD',
    updated: '版本',
  },
  en: {
    cod: 'COD',
    codMax: 'COD amount limit',
    enabled: 'Delivery enabled',
    error: 'The delivery policy could not be loaded or saved.',
    free: 'Free-shipping threshold',
    loading: 'Loading…',
    provinces: 'Remote province codes',
    save: 'Save policy',
    shipping: 'Flat shipping fee',
    surcharge: 'Remote surcharge',
    title: 'Delivery & COD',
    updated: 'Version',
  },
} as const;

export function DeliveryWorkbench({
  headers,
  locale,
  request,
  store,
}: {
  headers: () => Record<string, string>;
  locale: Locale;
  request: Request;
  store: Store;
}): JSX.Element {
  const t = copy[locale];
  const query = `?store_id=${encodeURIComponent(store.id)}`;
  const [policy, setPolicy] = useState<Policy>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  const load = async (): Promise<void> => {
    setBusy(true);
    setError(false);
    try {
      setPolicy(await request<Policy>(`/v1/admin/delivery-policy${query}`, { headers: headers() }));
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
  }, [store.id]);

  const update = (key: keyof Policy, value: string | string[] | boolean | number | null): void => {
    setPolicy((current) => (current ? { ...current, [key]: value } : current));
  };
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!policy) return;
    setBusy(true);
    setError(false);
    try {
      setPolicy(
        await request<Policy>(`/v1/admin/delivery-policy${query}`, {
          body: JSON.stringify({
            cod_enabled: policy.cod_enabled,
            cod_max_amount_vnd: policy.cod_max_amount_vnd,
            enabled: policy.enabled,
            expected_version: policy.version,
            flat_shipping_fee_vnd: policy.flat_shipping_fee_vnd,
            free_shipping_threshold_vnd: policy.free_shipping_threshold_vnd,
            remote_province_codes: policy.remote_province_codes,
            remote_surcharge_vnd: policy.remote_surcharge_vnd,
          }),
          headers: { ...headers(), 'Content-Type': 'application/json' },
          method: 'PATCH',
        }),
      );
    } catch {
      setError(true);
      await load();
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="data-section delivery-workbench">
      <div className="section-heading">
        <div>
          <p className="eyebrow">M4</p>
          <h2>{t.title}</h2>
        </div>
        <span>
          {t.updated} {policy?.version ?? '—'}
        </span>
      </div>
      {error && <p className="dashboard-error">{t.error}</p>}
      {!policy ? (
        <p className="empty-state">{busy ? t.loading : t.error}</p>
      ) : (
        <form className="delivery-form" onSubmit={(event) => void save(event)}>
          <label className="toggle-field">
            <input
              checked={policy.enabled}
              onChange={(event) => update('enabled', event.target.checked)}
              type="checkbox"
            />{' '}
            {t.enabled}
          </label>
          <label className="toggle-field">
            <input
              checked={policy.cod_enabled}
              onChange={(event) => update('cod_enabled', event.target.checked)}
              type="checkbox"
            />{' '}
            {t.cod}
          </label>
          <label>
            {t.codMax}
            <input
              min="1"
              onChange={(event) =>
                update('cod_max_amount_vnd', event.target.value ? Number(event.target.value) : null)
              }
              type="number"
              value={policy.cod_max_amount_vnd ?? ''}
            />
          </label>
          <label>
            {t.shipping}
            <input
              min="0"
              onChange={(event) => update('flat_shipping_fee_vnd', Number(event.target.value))}
              type="number"
              value={policy.flat_shipping_fee_vnd}
            />
          </label>
          <label>
            {t.free}
            <input
              min="0"
              onChange={(event) =>
                update(
                  'free_shipping_threshold_vnd',
                  event.target.value ? Number(event.target.value) : null,
                )
              }
              type="number"
              value={policy.free_shipping_threshold_vnd ?? ''}
            />
          </label>
          <label>
            {t.surcharge}
            <input
              min="0"
              onChange={(event) => update('remote_surcharge_vnd', Number(event.target.value))}
              type="number"
              value={policy.remote_surcharge_vnd}
            />
          </label>
          <label>
            {t.provinces}
            <input
              onChange={(event) =>
                update(
                  'remote_province_codes',
                  event.target.value
                    .split(',')
                    .map((code) => code.trim())
                    .filter(Boolean),
                )
              }
              value={policy.remote_province_codes.join(', ')}
            />
          </label>
          <button className="primary" disabled={busy} type="submit">
            {busy ? t.loading : t.save}
          </button>
        </form>
      )}
    </section>
  );
}
