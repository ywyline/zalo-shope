import React, { useEffect, useRef, useState } from 'react';
import { translate, type MessageKey } from '@zalo-shop/i18n';

import { API_BASE, STORE_CODE, type Locale } from './catalog-api';

function isZaloRuntime(): boolean {
  const hostname = window.location.hostname.toLowerCase();
  return (
    /zalo/i.test(window.navigator.userAgent) ||
    'zmpGlobal' in window ||
    hostname === 'zalo.me' ||
    hostname.endsWith('.zalo.me') ||
    hostname === 'zdn.vn' ||
    hostname.endsWith('.zdn.vn')
  );
}

export function IdentityPanel({ locale }: { locale: Locale }): JSX.Element {
  const started = useRef(false);
  const [startup, setStartup] = useState<'error' | 'loading' | 'ready'>('loading');
  const [accessToken, setAccessToken] = useState<string>();
  const [zaloToken, setZaloToken] = useState<string>();
  const [manualOpen, setManualOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const [consent, setConsent] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  const t = (key: MessageKey): string => translate(locale, key);

  const startIdentity = async (): Promise<void> => {
    setStartup('loading');
    setFeedback(undefined);
    try {
      if (!isZaloRuntime()) throw new Error('Zalo runtime is unavailable');
      const { getAccessToken } = await import('zmp-sdk');
      const token = String(await getAccessToken());
      if (!token) throw new Error('Zalo access token is unavailable');
      const response = await fetch(`${API_BASE}/v1/auth/zalo/exchange`, {
        headers: { 'X-Store-Code': STORE_CODE, 'X-Zalo-Access-Token': token },
        method: 'POST',
      });
      if (!response.ok) throw new Error('Identity exchange failed');
      const session = (await response.json()) as { access_token?: string };
      if (!session.access_token) throw new Error('Identity response is invalid');
      setAccessToken(session.access_token);
      setZaloToken(token);
      setStartup('ready');
    } catch {
      setAccessToken(undefined);
      setZaloToken(undefined);
      setStartup('error');
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void startIdentity();
  }, []);

  const savePhone = async (input: { phone?: string; phoneToken?: string }): Promise<void> => {
    if (!accessToken) {
      setFeedback(t('identity.signedOut'));
      return;
    }
    setSaving(true);
    setFeedback(undefined);
    const isZalo = input.phoneToken !== undefined;
    try {
      const response = await fetch(
        `${API_BASE}/v1/members/me/phone/${isZalo ? 'zalo' : 'manual'}`,
        {
          body: JSON.stringify({
            consent_event_id: crypto.randomUUID(),
            ...(isZalo ? { phone_token: input.phoneToken } : { phone: input.phone }),
            policy_version: 'phone-v1',
          }),
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'X-Store-Code': STORE_CODE,
            ...(isZalo && zaloToken ? { 'X-Zalo-Access-Token': zaloToken } : {}),
          },
          method: 'PUT',
        },
      );
      if (!response.ok) throw new Error('Phone update failed');
      const result = (await response.json()) as { masked_phone?: string };
      setFeedback(`${t('identity.phoneSaved')} ${result.masked_phone ?? ''}`.trim());
      setManualOpen(false);
    } catch {
      setFeedback(t('identity.phoneError'));
    } finally {
      setSaving(false);
    }
  };

  const requestZaloPhone = async (): Promise<void> => {
    try {
      const { getPhoneNumber } = await import('zmp-sdk');
      const result = await getPhoneNumber();
      if (!result.token) throw new Error('Phone permission was denied');
      await savePhone({ phoneToken: result.token });
    } catch {
      setManualOpen(true);
      setFeedback(t('identity.phoneDenied'));
    }
  };

  const submitManual = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!consent || phone.trim().length < 9) {
      setFeedback(t('identity.manualRequired'));
      return;
    }
    void savePhone({ phone: phone.trim() });
  };

  return (
    <section className="identity-panel" aria-labelledby="identity-title">
      <div className="identity-mark" aria-hidden="true">
        Z
      </div>
      <p className="section-kicker">Zalo identity</p>
      <h1 id="identity-title">{t('catalog.profile')}</h1>
      <p>{t('identity.intro')}</p>

      {startup === 'loading' && (
        <div className="status-card loading" role="status">
          <span className="spinner" aria-hidden="true" /> {t('identity.loading')}
        </div>
      )}
      {startup === 'error' && (
        <div className="status-card error" role="alert">
          <span aria-hidden="true">!</span>
          <strong>{t('identity.error')}</strong>
          <button onClick={() => void startIdentity()} type="button">
            {t('app.retry')}
          </button>
        </div>
      )}
      {startup === 'ready' && (
        <div className="status-card success" role="status">
          <span aria-hidden="true">✓</span>
          <strong>{t('identity.ready')}</strong>
        </div>
      )}

      <div className="identity-actions">
        <button
          className="button-primary"
          disabled={startup !== 'ready'}
          onClick={() => void requestZaloPhone()}
          type="button"
        >
          {t('identity.requestPhone')}
        </button>
        <button
          className="button-quiet"
          onClick={() => setManualOpen((value) => !value)}
          type="button"
        >
          {t('identity.manual')}
        </button>
      </div>

      {manualOpen && (
        <form className="manual-form" onSubmit={submitManual}>
          <div>
            <h2>{t('identity.phoneTitle')}</h2>
            <p>{t('identity.manualHint')}</p>
          </div>
          <label>
            {t('identity.phone')}
            <input
              autoComplete="tel"
              inputMode="tel"
              onChange={(event) => setPhone(event.target.value)}
              placeholder="0912 345 678"
              value={phone}
            />
          </label>
          <label className="consent">
            <input
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
              type="checkbox"
            />
            <span>{t('identity.consent')}</span>
          </label>
          <button className="button-primary" disabled={saving} type="submit">
            {saving ? t('identity.saving') : t('identity.save')}
          </button>
        </form>
      )}
      {feedback && (
        <p className="feedback" role="status">
          {feedback}
        </p>
      )}
    </section>
  );
}
