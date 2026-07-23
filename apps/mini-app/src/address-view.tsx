import React, { useCallback, useEffect, useState } from 'react';
import { translate, type MessageKey } from '@zalo-shop/i18n';

import type { Locale } from './catalog-api';
import {
  createAddress,
  deleteAddress,
  listAdministrativeAreas,
  listAddresses,
  updateAddress,
  type Address,
  type AdministrativeArea,
  type AddressInput,
} from './commerce-api';
import { useMemberSession } from './member-session';

const emptyForm: AddressInput = {
  detail: '',
  district_code: '',
  is_default: false,
  label: '',
  phone: '',
  province_code: '',
  recipient_name: '',
  ward_code: '',
};

function message(locale: Locale, key: MessageKey): string {
  return translate(locale, key);
}

function AddressForm({
  address,
  locale,
  onCancel,
  onSaved,
}: {
  address?: Address;
  locale: Locale;
  onCancel: () => void;
  onSaved: (address: Address) => void;
}): JSX.Element {
  const session = useMemberSession();
  const [form, setForm] = useState<AddressInput>(() =>
    address
      ? {
          detail: address.detail,
          district_code: address.district_code,
          is_default: address.is_default,
          label: address.label ?? '',
          phone: '',
          province_code: address.province_code,
          recipient_name: address.recipient_name,
          ward_code: address.ward_code,
        }
      : emptyForm,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const [regionError, setRegionError] = useState(false);
  const [regionRetry, setRegionRetry] = useState(0);
  const [provinces, setProvinces] = useState<AdministrativeArea[]>([]);
  const [districts, setDistricts] = useState<AdministrativeArea[]>([]);
  const [wards, setWards] = useState<AdministrativeArea[]>([]);
  const set = (key: keyof AddressInput, value: string | boolean): void =>
    setForm((current) => ({ ...current, [key]: value }));

  useEffect(() => {
    if (!session.accessToken) return;
    const controller = new AbortController();
    setRegionError(false);
    void listAdministrativeAreas(session.accessToken, 'PROVINCE', undefined, controller.signal)
      .then((response) => setProvinces(response.items))
      .catch(() => {
        if (!controller.signal.aborted) setRegionError(true);
      });
    return () => controller.abort();
  }, [regionRetry, session.accessToken]);

  useEffect(() => {
    if (!session.accessToken || !form.province_code) {
      setDistricts([]);
      return;
    }
    const controller = new AbortController();
    setRegionError(false);
    void listAdministrativeAreas(
      session.accessToken,
      'DISTRICT',
      form.province_code,
      controller.signal,
    )
      .then((response) => setDistricts(response.items))
      .catch(() => {
        if (!controller.signal.aborted) setRegionError(true);
      });
    return () => controller.abort();
  }, [form.province_code, regionRetry, session.accessToken]);

  useEffect(() => {
    if (!session.accessToken || !form.district_code) {
      setWards([]);
      return;
    }
    const controller = new AbortController();
    setRegionError(false);
    void listAdministrativeAreas(session.accessToken, 'WARD', form.district_code, controller.signal)
      .then((response) => setWards(response.items))
      .catch(() => {
        if (!controller.signal.aborted) setRegionError(true);
      });
    return () => controller.abort();
  }, [form.district_code, regionRetry, session.accessToken]);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!session.accessToken) return;
    setSaving(true);
    setError(false);
    try {
      const saved = address
        ? await updateAddress(session.accessToken, address.id, {
            detail: form.detail,
            district_code: form.district_code,
            expected_version: address.version,
            is_default: form.is_default,
            label: form.label,
            ...(form.phone.trim() ? { phone: form.phone } : {}),
            province_code: form.province_code,
            recipient_name: form.recipient_name,
            ward_code: form.ward_code,
          })
        : await createAddress(session.accessToken, form);
      onSaved(saved);
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  };

  const identityFields: Array<[keyof AddressInput, MessageKey, 'tel' | 'text']> = [
    ['recipient_name', 'address.recipient', 'text'],
    ['phone', 'address.phone', 'tel'],
  ];
  const detailFields: Array<[keyof AddressInput, MessageKey, 'tel' | 'text']> = [
    ['detail', 'address.detail', 'text'],
    ['label', 'address.label', 'text'],
  ];
  return (
    <form className="address-form" onSubmit={(event) => void submit(event)}>
      <div className="address-form-grid">
        {identityFields.map(([key, label, type]) => (
          <label className={key === 'detail' ? 'wide' : ''} key={key}>
            {message(locale, label)}
            <input
              autoComplete={key === 'phone' ? 'tel' : key === 'recipient_name' ? 'name' : undefined}
              inputMode={type === 'tel' ? 'tel' : undefined}
              onChange={(event) => set(key, event.target.value)}
              required={key !== 'label' && (!address || key !== 'phone')}
              type={type}
              value={String(form[key])}
            />
          </label>
        ))}
        <label>
          {message(locale, 'address.province')}
          <select
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                district_code: '',
                province_code: event.target.value,
                ward_code: '',
              }))
            }
            required
            value={form.province_code}
          >
            <option value="">{message(locale, 'address.select')}</option>
            {provinces.map((area) => (
              <option key={area.code} value={area.code}>
                {area.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {message(locale, 'address.district')}
          <select
            disabled={!form.province_code}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                district_code: event.target.value,
                ward_code: '',
              }))
            }
            required
            value={form.district_code}
          >
            <option value="">{message(locale, 'address.select')}</option>
            {districts.map((area) => (
              <option key={area.code} value={area.code}>
                {area.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {message(locale, 'address.ward')}
          <select
            disabled={!form.district_code}
            onChange={(event) => set('ward_code', event.target.value)}
            required
            value={form.ward_code}
          >
            <option value="">{message(locale, 'address.select')}</option>
            {wards.map((area) => (
              <option key={area.code} value={area.code}>
                {area.name}
              </option>
            ))}
          </select>
        </label>
        {detailFields.map(([key, label, type]) => (
          <label className={key === 'detail' ? 'wide' : ''} key={key}>
            {message(locale, label)}
            <input
              onChange={(event) => set(key, event.target.value)}
              required={key !== 'label'}
              type={type}
              value={String(form[key])}
            />
          </label>
        ))}
      </div>
      {regionError && (
        <button
          className="commerce-state"
          onClick={() => setRegionRetry((value) => value + 1)}
          type="button"
        >
          {message(locale, 'address.error')} · {message(locale, 'app.retry')}
        </button>
      )}
      <label className="check-row">
        <input
          checked={form.is_default}
          onChange={(event) => set('is_default', event.target.checked)}
          type="checkbox"
        />
        {message(locale, 'address.default')}
      </label>
      {error && (
        <p className="form-error" role="alert">
          {message(locale, 'address.error')}
        </p>
      )}
      <div className="form-actions">
        <button className="button-quiet" onClick={onCancel} type="button">
          {message(locale, 'address.cancel')}
        </button>
        <button className="button-primary" disabled={saving} type="submit">
          {message(locale, saving ? 'address.saving' : 'address.save')}
        </button>
      </div>
    </form>
  );
}

export function AddressView({ locale }: { locale: Locale }): JSX.Element {
  const session = useMemberSession();
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [status, setStatus] = useState<'error' | 'loading' | 'ready'>('loading');
  const [editing, setEditing] = useState<Address | 'new'>();

  const load = useCallback(async (): Promise<void> => {
    if (!session.accessToken) return;
    setStatus('loading');
    try {
      setAddresses(await listAddresses(session.accessToken));
      setStatus('ready');
    } catch {
      setStatus('error');
    }
  }, [session.accessToken]);

  useEffect(() => void load(), [load]);
  return (
    <div className="page-view commerce-page">
      <header className="page-intro compact-intro">
        <p className="section-kicker">Delivery</p>
        <h1>{message(locale, 'address.title')}</h1>
        <button className="button-primary" onClick={() => setEditing('new')} type="button">
          + {message(locale, 'address.new')}
        </button>
      </header>
      {editing && (
        <AddressForm
          address={editing === 'new' ? undefined : editing}
          locale={locale}
          onCancel={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            void load();
          }}
        />
      )}
      {status === 'loading' && <p className="commerce-state">{message(locale, 'app.loading')}</p>}
      {status === 'error' && (
        <button className="commerce-state" onClick={() => void load()} type="button">
          {message(locale, 'address.error')} · {message(locale, 'app.retry')}
        </button>
      )}
      {status === 'ready' && addresses.length === 0 && !editing && (
        <p className="commerce-state">{message(locale, 'address.empty')}</p>
      )}
      <section className="address-list" aria-label={message(locale, 'address.title')}>
        {addresses.map((address) => (
          <article
            className={address.is_default ? 'address-row default' : 'address-row'}
            key={address.id}
          >
            <div>
              <p>
                <strong>{address.recipient_name}</strong> <span>{address.masked_phone}</span>
              </p>
              <p>
                {address.detail}, {address.ward_name}, {address.district_name},{' '}
                {address.province_name}
              </p>
              {address.is_default && <small>{message(locale, 'address.default')}</small>}
            </div>
            <div className="row-actions">
              {!address.is_default && (
                <button
                  aria-label={message(locale, 'address.default')}
                  onClick={() => {
                    if (!session.accessToken) return;
                    void updateAddress(session.accessToken, address.id, {
                      expected_version: address.version,
                      is_default: true,
                    }).then(load);
                  }}
                  type="button"
                >
                  ☆
                </button>
              )}
              <button onClick={() => setEditing(address)} type="button">
                ✎
              </button>
              <button
                aria-label={message(locale, 'address.delete')}
                onClick={() => {
                  if (!session.accessToken) return;
                  void deleteAddress(session.accessToken, address.id).then(load);
                }}
                type="button"
              >
                ×
              </button>
            </div>
          </article>
        ))}
      </section>
    </div>
  );
}
