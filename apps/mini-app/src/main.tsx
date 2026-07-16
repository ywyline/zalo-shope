import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getAccessToken, getPhoneNumber } from 'zmp-sdk';

import '@zalo-shop/design-tokens/theme.css';
import './styles.css';

type Locale = 'en' | 'vi' | 'zh';
type StartupState = 'error' | 'loading' | 'ready';

const runtimeEnvironment = import.meta.env as unknown as Record<string, string | undefined>;
const API_BASE = runtimeEnvironment.VITE_API_BASE_URL ?? '/api';
const STORE_CODE = runtimeEnvironment.VITE_STORE_CODE ?? 'beauty-local';

const copy = {
  vi: {
    brand: 'Zalo Shop · Nền tảng mua sắm',
    consent: 'Tôi đồng ý lưu số điện thoại theo Chính sách quyền riêng tư phiên bản phone-v1.',
    error: 'Không thể xác minh danh tính Zalo. Hãy mở Mini App trong Zalo và thử lại.',
    eyebrow: 'Không gian mua sắm riêng của bạn',
    intro:
      'Danh tính của bạn được xác minh an toàn theo từng cửa hàng. Chúng tôi chỉ xin quyền khi thực sự cần.',
    language: 'Ngôn ngữ',
    loading: 'Đang kết nối an toàn…',
    manual: 'Nhập số điện thoại',
    manualHint:
      'Bạn có thể tiếp tục bằng cách nhập số Việt Nam. Số được mã hóa và không hiển thị đầy đủ.',
    manualRequired: 'Vui lòng nhập số điện thoại và xác nhận đồng ý.',
    phone: 'Số điện thoại Việt Nam',
    phoneDenied: 'Bạn chưa cấp quyền số điện thoại. Không sao — hãy dùng cách nhập thủ công.',
    phoneError: 'Không thể lưu số điện thoại lúc này. Vui lòng thử lại.',
    phoneSaved: 'Đã lưu an toàn:',
    phoneTitle: 'Thêm số điện thoại',
    ready: 'Đã kết nối với Zalo',
    readyBody:
      'Nền tảng danh tính đã sẵn sàng. Các tính năng mua sắm sẽ được mở ở giai đoạn tiếp theo.',
    requestPhone: 'Dùng số từ Zalo',
    retry: 'Thử lại',
    save: 'Lưu số điện thoại',
    saving: 'Đang lưu…',
    signedOutManual: 'Cần xác minh Zalo trước khi lưu số điện thoại.',
  },
  zh: {
    brand: 'Zalo Shop · 商城底座',
    consent: '我同意按 phone-v1 隐私政策保存手机号。',
    error: '无法验证 Zalo 身份。请在 Zalo 内打开 Mini App 后重试。',
    eyebrow: '属于你的独立购物空间',
    intro: '身份按商城安全验证；只有在确有需要时才请求权限。',
    language: '语言',
    loading: '正在安全连接…',
    manual: '手工输入手机号',
    manualHint: '你可以输入越南手机号继续。号码会加密保存，不会完整展示。',
    manualRequired: '请输入手机号并确认同意。',
    phone: '越南手机号',
    phoneDenied: '你尚未授权手机号。没关系，可以使用手工输入。',
    phoneError: '当前无法保存手机号，请重试。',
    phoneSaved: '已安全保存：',
    phoneTitle: '添加手机号',
    ready: '已连接 Zalo',
    readyBody: '身份基础已就绪；购物功能将在后续阶段开放。',
    requestPhone: '使用 Zalo 手机号',
    retry: '重试',
    save: '保存手机号',
    saving: '正在保存…',
    signedOutManual: '保存手机号前需要先完成 Zalo 身份验证。',
  },
  en: {
    brand: 'Zalo Shop · Commerce foundation',
    consent: 'I agree to save my phone number under privacy policy phone-v1.',
    error: 'Zalo identity could not be verified. Open this Mini App in Zalo and retry.',
    eyebrow: 'Your private shopping space',
    intro:
      'Your identity is verified securely per store. We ask for access only when it is needed.',
    language: 'Language',
    loading: 'Connecting securely…',
    manual: 'Enter phone manually',
    manualHint:
      'You can continue with a Vietnamese number. It is encrypted and never shown in full.',
    manualRequired: 'Enter a phone number and confirm consent.',
    phone: 'Vietnamese phone number',
    phoneDenied: 'Phone access was not granted. That is okay — use manual entry instead.',
    phoneError: 'The phone number could not be saved. Please retry.',
    phoneSaved: 'Saved securely:',
    phoneTitle: 'Add a phone number',
    ready: 'Connected to Zalo',
    readyBody: 'The identity foundation is ready. Shopping features arrive in a later milestone.',
    requestPhone: 'Use Zalo phone number',
    retry: 'Retry',
    save: 'Save phone number',
    saving: 'Saving…',
    signedOutManual: 'Verify your Zalo identity before saving a phone number.',
  },
} as const;

function MiniApp(): JSX.Element {
  const started = useRef(false);
  const [locale, setLocale] = useState<Locale>('vi');
  const [startup, setStartup] = useState<StartupState>('loading');
  const [accessToken, setAccessToken] = useState<string>();
  const [zaloToken, setZaloToken] = useState<string>();
  const [manualOpen, setManualOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const [consent, setConsent] = useState(false);
  const [phoneStatus, setPhoneStatus] = useState<'denied' | 'idle' | 'saving'>('idle');
  const [feedback, setFeedback] = useState<string>();
  const t = copy[locale];

  const startIdentity = async (): Promise<void> => {
    setStartup('loading');
    setFeedback(undefined);
    try {
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
      setFeedback(t.signedOutManual);
      return;
    }
    setPhoneStatus('saving');
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
      setFeedback(`${t.phoneSaved} ${result.masked_phone ?? ''}`.trim());
      setManualOpen(false);
    } catch {
      setFeedback(t.phoneError);
    } finally {
      setPhoneStatus('idle');
    }
  };

  const requestZaloPhone = async (): Promise<void> => {
    try {
      const result = await getPhoneNumber();
      if (!result.token) throw new Error('Phone permission was denied');
      await savePhone({ phoneToken: result.token });
    } catch {
      setPhoneStatus('denied');
      setManualOpen(true);
      setFeedback(t.phoneDenied);
    }
  };

  const submitManual = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!consent || phone.trim().length < 9) {
      setFeedback(t.manualRequired);
      return;
    }
    void savePhone({ phone: phone.trim() });
  };

  return (
    <main className="mini-shell">
      <header className="mini-header">
        <a className="mini-brand" href="#main-card" aria-label={t.brand}>
          <span aria-hidden="true">Z</span>
          {t.brand}
        </a>
        <div className="locale-switch" role="group" aria-label={t.language}>
          {(['vi', 'zh', 'en'] as const).map((item) => (
            <button
              aria-pressed={locale === item}
              className={locale === item ? 'active' : ''}
              key={item}
              onClick={() => setLocale(item)}
              type="button"
            >
              {item.toUpperCase()}
            </button>
          ))}
        </div>
      </header>

      <section className="identity-card" id="main-card" aria-labelledby="mini-title">
        <div className="petal" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <p className="eyebrow">{t.eyebrow}</p>
        <h1 id="mini-title">{startup === 'ready' ? t.ready : t.brand}</h1>
        <p className="intro">{startup === 'ready' ? t.readyBody : t.intro}</p>

        {startup === 'loading' && (
          <div className="state-panel loading" role="status">
            <span className="spinner" aria-hidden="true" /> {t.loading}
          </div>
        )}
        {startup === 'error' && (
          <div className="state-panel error" role="alert">
            <span className="state-icon" aria-hidden="true">
              !
            </span>
            <div>
              <strong>{t.error}</strong>
              <small>Zalo SDK / API</small>
            </div>
            <button className="secondary" onClick={() => void startIdentity()} type="button">
              {t.retry}
            </button>
          </div>
        )}
        {startup === 'ready' && (
          <div className="state-panel success" role="status">
            <span className="state-icon" aria-hidden="true">
              ✓
            </span>
            <div>
              <strong>{t.ready}</strong>
              <small>{STORE_CODE}</small>
            </div>
          </div>
        )}

        <div className="phone-actions">
          <button
            className="primary"
            disabled={startup !== 'ready'}
            onClick={() => void requestZaloPhone()}
            type="button"
          >
            {t.requestPhone}
          </button>
          <button
            className="text-button"
            onClick={() => setManualOpen((value) => !value)}
            type="button"
          >
            {t.manual}
          </button>
        </div>

        {manualOpen && (
          <form className="manual-form" onSubmit={submitManual}>
            <div>
              <h2>{t.phoneTitle}</h2>
              <p>{t.manualHint}</p>
            </div>
            <label>
              {t.phone}
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
              <span>{t.consent}</span>
            </label>
            <button className="primary" disabled={phoneStatus === 'saving'} type="submit">
              {phoneStatus === 'saving' ? t.saving : t.save}
            </button>
          </form>
        )}

        {feedback && (
          <p className={phoneStatus === 'denied' ? 'feedback warning' : 'feedback'} role="status">
            {feedback}
          </p>
        )}
      </section>
    </main>
  );
}

const rootElement = document.querySelector('#root');
if (!rootElement) throw new Error('Root element was not found');

createRoot(rootElement).render(
  <StrictMode>
    <MiniApp />
  </StrictMode>,
);
