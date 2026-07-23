import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';

import '@zalo-shop/design-tokens/theme.css';
import './styles.css';
import { CatalogWorkbench } from './catalog-workbench';
import { ContentEditor } from './content-editor';
import { DeliveryWorkbench } from './delivery-workbench';
import { InventoryWorkbench } from './inventory-workbench';
import { OrderWorkbench } from './order-workbench';
import { PromotionWorkbench } from './promotion-workbench';

type Locale = 'en' | 'vi' | 'zh';
type Phase = 'dashboard' | 'mfa' | 'password';
type Tab =
  | 'audit'
  | 'catalog'
  | 'content'
  | 'delivery'
  | 'inventory'
  | 'orders'
  | 'overview'
  | 'promotions'
  | 'roles';
type Store = { code: string; default_locale: Locale; id: string };
type Role = { code: string; id: string; name: string; permissions?: Array<unknown> };
type Audit = { action: string; actorId: string; createdAt: string; id: string; reason?: string };

const runtimeEnvironment = import.meta.env as unknown as Record<string, string | undefined>;
const API_BASE = runtimeEnvironment.VITE_API_BASE_URL ?? '/api';
const labels = {
  vi: {
    audit: 'Nhật ký',
    catalog: 'Sản phẩm & tuân thủ',
    create: 'Tạo vai trò',
    content: 'Trang & nội dung',
    delivery: 'Giao hàng & COD',
    email: 'Email quản trị',
    empty: 'Chưa có dữ liệu trong phạm vi này.',
    errorAuth: 'Thông tin đăng nhập hoặc mã xác thực không hợp lệ.',
    errorDenied: 'Bạn không có quyền trong phạm vi này. Truy cập chéo cửa hàng cần lý do hợp lệ.',
    errorGeneric: 'Không thể hoàn tất yêu cầu. Vui lòng thử lại.',
    inventory: 'Kho & tồn kho',
    loading: 'Đang tải dữ liệu an toàn…',
    login: 'Đăng nhập an toàn',
    mfa: 'Mã xác thực 6 số',
    next: 'Tiếp tục',
    overview: 'Tổng quan',
    orders: 'Đơn hàng & COD',
    password: 'Mật khẩu',
    promotions: 'Khuyến mãi & giá',
    reason: 'Lý do truy cập chéo cửa hàng',
    retry: 'Thử lại',
    roleCode: 'Mã vai trò',
    roleName: 'Tên vai trò',
    roles: 'Vai trò & quyền',
    selectStore: 'Chọn cửa hàng',
    signOut: 'Đăng xuất',
    subtitle: 'Quản trị nhiều cửa hàng với phạm vi rõ ràng và nhật ký đầy đủ.',
    title: 'Trung tâm vận hành',
    verify: 'Xác minh MFA',
  },
  zh: {
    audit: '审计日志',
    catalog: '商品与合规',
    create: '创建角色',
    content: '页面与装修',
    delivery: '配送与 COD',
    email: '管理员邮箱',
    empty: '当前范围暂无数据。',
    errorAuth: '登录信息或验证码无效。',
    errorDenied: '你无权访问当前范围；跨商城访问必须填写有效原因。',
    errorGeneric: '请求未能完成，请重试。',
    inventory: '仓库与库存',
    loading: '正在安全加载数据…',
    login: '安全登录',
    mfa: '6 位验证码',
    next: '继续',
    overview: '概览',
    orders: '订单与 COD',
    password: '密码',
    promotions: '促销与价格',
    reason: '跨商城访问原因',
    retry: '重试',
    roleCode: '角色编码',
    roleName: '角色名称',
    roles: '角色与权限',
    selectStore: '选择商城',
    signOut: '退出',
    subtitle: '以明确权限范围和完整审计管理多个商城。',
    title: '运营中心',
    verify: '验证 MFA',
  },
  en: {
    audit: 'Audit log',
    catalog: 'Catalog & compliance',
    create: 'Create role',
    content: 'Pages & content',
    delivery: 'Delivery & COD',
    email: 'Admin email',
    empty: 'No data exists in this scope yet.',
    errorAuth: 'The credentials or verification code are invalid.',
    errorDenied: 'You cannot access this scope. Cross-store access requires a valid reason.',
    errorGeneric: 'The request could not be completed. Please retry.',
    inventory: 'Warehouses & inventory',
    loading: 'Loading securely…',
    login: 'Secure sign in',
    mfa: '6-digit code',
    next: 'Continue',
    overview: 'Overview',
    orders: 'Orders & COD',
    password: 'Password',
    promotions: 'Promotions & pricing',
    reason: 'Cross-store access reason',
    retry: 'Retry',
    roleCode: 'Role code',
    roleName: 'Role name',
    roles: 'Roles & permissions',
    selectStore: 'Select store',
    signOut: 'Sign out',
    subtitle: 'Operate multiple stores with explicit scope and complete audit trails.',
    title: 'Operations center',
    verify: 'Verify MFA',
  },
} as const;

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, options);
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as {
      code?: string;
      details?: { reason_code?: string };
    };
    throw new Error(error.details?.reason_code ?? error.code ?? `HTTP_${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function downloadApi(path: string, options: RequestInit = {}): Promise<Blob> {
  const response = await fetch(`${API_BASE}${path}`, options);
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as {
      code?: string;
      details?: { reason_code?: string };
    };
    throw new Error(error.details?.reason_code ?? error.code ?? `HTTP_${response.status}`);
  }
  return response.blob();
}

function AdminApp(): JSX.Element {
  const [locale, setLocale] = useState<Locale>('vi');
  const [phase, setPhase] = useState<Phase>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfa, setMfa] = useState('');
  const [challenge, setChallenge] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [stores, setStores] = useState<Store[]>([]);
  const [store, setStore] = useState<Store>();
  const [reason, setReason] = useState('');
  const [tab, setTab] = useState<Tab>('overview');
  const [roles, setRoles] = useState<Role[]>([]);
  const [audits, setAudits] = useState<Audit[]>([]);
  const [roleCode, setRoleCode] = useState('');
  const [roleName, setRoleName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const t = labels[locale];

  const authenticatedHeaders = (selected?: Store, token = accessToken): Record<string, string> => ({
    Authorization: `Bearer ${token}`,
    ...(selected ? { 'X-Store-Code': selected.code } : {}),
    ...(reason.trim() ? { 'X-Access-Reason': reason.trim() } : {}),
  });

  const passwordLogin = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const response = await api<{ challenge_token: string }>('/v1/auth/admin/password', {
        body: JSON.stringify({ email, password }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      setChallenge(response.challenge_token);
      setPhase('mfa');
    } catch {
      setError('AUTHENTICATION_FAILED');
    } finally {
      setBusy(false);
    }
  };

  const loadStores = async (token: string): Promise<Store[]> => {
    const result = await api<Store[]>('/v1/admin/stores', {
      headers: { Authorization: `Bearer ${token}` },
    });
    setStores(result);
    setStore(result[0]);
    return result;
  };

  const verifyMfa = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const session = await api<{ access_token: string }>('/v1/auth/admin/mfa/verify', {
        body: JSON.stringify({ challenge_token: challenge, token: mfa }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      setAccessToken(session.access_token);
      const availableStores = await loadStores(session.access_token);
      setPhase('dashboard');
      await loadScope(availableStores[0], session.access_token);
    } catch {
      setError('AUTHENTICATION_FAILED');
    } finally {
      setBusy(false);
    }
  };

  const loadScope = async (selected = store, token = accessToken): Promise<void> => {
    if (!selected) return;
    setBusy(true);
    setError(undefined);
    try {
      const query = `store_id=${encodeURIComponent(selected.id)}`;
      const [nextRoles, nextAudits] = await Promise.all([
        api<Role[]>(`/v1/admin/rbac/roles?${query}`, {
          headers: authenticatedHeaders(selected, token),
        }),
        api<Audit[]>(`/v1/admin/audit-logs?${query}&limit=30`, {
          headers: authenticatedHeaders(selected, token),
        }),
      ]);
      setRoles(nextRoles);
      setAudits(nextAudits);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'INTERNAL_ERROR');
    } finally {
      setBusy(false);
    }
  };

  const createRole = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!store) return;
    setBusy(true);
    setError(undefined);
    try {
      await api(`/v1/admin/rbac/roles?store_id=${encodeURIComponent(store.id)}`, {
        body: JSON.stringify({ code: roleCode, name: roleName }),
        headers: { ...authenticatedHeaders(store), 'Content-Type': 'application/json' },
        method: 'POST',
      });
      setRoleCode('');
      setRoleName('');
      await loadScope(store);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'INTERNAL_ERROR');
      setBusy(false);
    }
  };

  const errorMessage =
    error === 'AUTHENTICATION_FAILED'
      ? t.errorAuth
      : error === 'AUTHORIZATION_DENIED'
        ? t.errorDenied
        : t.errorGeneric;

  if (phase !== 'dashboard') {
    return (
      <main className="login-shell">
        <section className="login-panel">
          <div className="login-copy">
            <div className="admin-mark">Z</div>
            <p className="eyebrow">Zalo Shop Admin</p>
            <h1>{t.title}</h1>
            <p>{t.subtitle}</p>
            <div className="security-note">
              <span>✓</span> RBAC · MFA · Audit
            </div>
          </div>
          <div className="login-form-wrap">
            <div className="top-locale">
              <select
                aria-label="Language"
                onChange={(event) => setLocale(event.target.value as Locale)}
                value={locale}
              >
                <option value="vi">Tiếng Việt</option>
                <option value="zh">中文</option>
                <option value="en">English</option>
              </select>
            </div>
            <form
              onSubmit={(event) =>
                void (phase === 'password' ? passwordLogin(event) : verifyMfa(event))
              }
            >
              <p className="step">{phase === 'password' ? '01 / 02' : '02 / 02'}</p>
              <h2>{phase === 'password' ? t.login : t.verify}</h2>
              {phase === 'password' ? (
                <>
                  <label>
                    {t.email}
                    <input
                      autoComplete="username"
                      onChange={(event) => setEmail(event.target.value)}
                      required
                      type="email"
                      value={email}
                    />
                  </label>
                  <label>
                    {t.password}
                    <input
                      autoComplete="current-password"
                      minLength={12}
                      onChange={(event) => setPassword(event.target.value)}
                      required
                      type="password"
                      value={password}
                    />
                  </label>
                </>
              ) : (
                <label>
                  {t.mfa}
                  <input
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    maxLength={6}
                    onChange={(event) => setMfa(event.target.value.replace(/\D/g, ''))}
                    pattern="[0-9]{6}"
                    required
                    value={mfa}
                  />
                </label>
              )}{' '}
              {error && (
                <p className="form-error" role="alert">
                  {errorMessage}
                </p>
              )}
              <button className="primary" disabled={busy} type="submit">
                {busy ? t.loading : phase === 'password' ? t.next : t.verify}
              </button>
            </form>
          </div>
        </section>
      </main>
    );
  }

  return (
    <div className="admin-shell">
      <aside className="sidebar">
        <div className="side-brand">
          <span>Z</span>
          <div>
            <strong>Zalo Shop</strong>
            <small>Operations</small>
          </div>
        </div>
        <nav aria-label="Primary">
          <button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>
            ⌂ <span>{t.overview}</span>
          </button>
          <button className={tab === 'content' ? 'active' : ''} onClick={() => setTab('content')}>
            ◫ <span>{t.content}</span>
          </button>
          <button className={tab === 'catalog' ? 'active' : ''} onClick={() => setTab('catalog')}>
            ◇ <span>{t.catalog}</span>
          </button>
          <button
            className={tab === 'inventory' ? 'active' : ''}
            onClick={() => setTab('inventory')}
          >
            ▦ <span>{t.inventory}</span>
          </button>
          <button
            className={tab === 'promotions' ? 'active' : ''}
            onClick={() => setTab('promotions')}
          >
            % <span>{t.promotions}</span>
          </button>
          <button className={tab === 'orders' ? 'active' : ''} onClick={() => setTab('orders')}>
            ≣ <span>{t.orders}</span>
          </button>
          <button className={tab === 'delivery' ? 'active' : ''} onClick={() => setTab('delivery')}>
            ⇢ <span>{t.delivery}</span>
          </button>
          <button
            className={tab === 'roles' ? 'active' : ''}
            onClick={() => {
              setTab('roles');
              void loadScope();
            }}
          >
            ♙ <span>{t.roles}</span>
          </button>
          <button
            className={tab === 'audit' ? 'active' : ''}
            onClick={() => {
              setTab('audit');
              void loadScope();
            }}
          >
            ◷ <span>{t.audit}</span>
          </button>
        </nav>
        <button
          className="signout"
          onClick={() => {
            setAccessToken('');
            setPhase('password');
          }}
        >
          ↗ <span>{t.signOut}</span>
        </button>
      </aside>
      <main className="workspace">
        <header className="workspace-header">
          <div>
            <p className="eyebrow">Zalo Shop Admin</p>
            <h1>{t.title}</h1>
          </div>
          <select
            aria-label="Language"
            onChange={(event) => setLocale(event.target.value as Locale)}
            value={locale}
          >
            <option value="vi">VI</option>
            <option value="zh">中文</option>
            <option value="en">EN</option>
          </select>
        </header>
        <section className="scope-bar">
          <label>
            {t.selectStore}
            <select
              onChange={(event) => {
                const next = stores.find((item) => item.id === event.target.value);
                setStore(next);
                setRoles([]);
                setAudits([]);
                if (
                  tab !== 'content' &&
                  tab !== 'catalog' &&
                  tab !== 'inventory' &&
                  tab !== 'promotions' &&
                  tab !== 'orders' &&
                  tab !== 'delivery'
                ) {
                  void loadScope(next);
                }
              }}
              value={store?.id ?? ''}
            >
              {stores.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.code}
                </option>
              ))}
            </select>
          </label>
          <label className="reason-field">
            {t.reason}
            <input
              onChange={(event) => setReason(event.target.value)}
              placeholder="Incident / support ticket"
              value={reason}
            />
          </label>
          <button className="secondary" disabled={!store || busy} onClick={() => void loadScope()}>
            {busy ? t.loading : t.retry}
          </button>
        </section>
        {error && (
          <div className="dashboard-error" role="alert">
            <strong>{errorMessage}</strong>
            <span>{error === 'AUTHORIZATION_DENIED' ? t.reason : t.retry}</span>
          </div>
        )}
        {tab === 'overview' && (
          <section className="overview-grid">
            <article className="hero-card">
              <p className="eyebrow">M1 Foundation</p>
              <h2>{store?.code ?? t.empty}</h2>
              <p>{t.subtitle}</p>
              <dl>
                <div>
                  <dt>Locale</dt>
                  <dd>{store?.default_locale ?? '—'}</dd>
                </div>
                <div>
                  <dt>Isolation</dt>
                  <dd>store_id + RLS</dd>
                </div>
                <div>
                  <dt>Session</dt>
                  <dd>MFA verified</dd>
                </div>
              </dl>
            </article>
            <article className="quiet-card">
              <h3>{t.roles}</h3>
              <strong>{roles.length || '—'}</strong>
              <p>{roles.length ? `${roles.length} scoped roles` : t.empty}</p>
            </article>
            <article className="quiet-card">
              <h3>{t.audit}</h3>
              <strong>{audits.length || '—'}</strong>
              <p>{audits.length ? `${audits.length} immutable events` : t.empty}</p>
            </article>
          </section>
        )}
        {tab === 'content' && store && (
          <ContentEditor
            headers={() => authenticatedHeaders(store)}
            key={store.id}
            locale={locale}
            request={api}
            store={store}
          />
        )}
        {tab === 'catalog' && store && (
          <CatalogWorkbench
            download={downloadApi}
            headers={() => authenticatedHeaders(store)}
            key={store.id}
            locale={locale}
            request={api}
            store={store}
          />
        )}
        {tab === 'inventory' && store && (
          <InventoryWorkbench
            headers={() => authenticatedHeaders(store)}
            key={store.id}
            locale={locale}
            request={api}
            store={store}
          />
        )}
        {tab === 'promotions' && store && (
          <PromotionWorkbench
            headers={() => authenticatedHeaders(store)}
            key={store.id}
            locale={locale}
            request={api}
            store={store}
          />
        )}
        {tab === 'orders' && store && (
          <OrderWorkbench
            headers={() => authenticatedHeaders(store)}
            key={store.id}
            locale={locale}
            request={api}
            store={store}
          />
        )}
        {tab === 'delivery' && store && (
          <DeliveryWorkbench
            headers={() => authenticatedHeaders(store)}
            key={store.id}
            locale={locale}
            request={api}
            store={store}
          />
        )}
        {tab === 'roles' && (
          <section className="data-section">
            <div className="section-heading">
              <div>
                <p className="eyebrow">RBAC</p>
                <h2>{t.roles}</h2>
              </div>
            </div>
            <form className="role-form" onSubmit={(event) => void createRole(event)}>
              <label>
                {t.roleCode}
                <input
                  onChange={(event) => setRoleCode(event.target.value)}
                  pattern="[a-z][a-z0-9\-]{1,63}"
                  required
                  value={roleCode}
                />
              </label>
              <label>
                {t.roleName}
                <input
                  onChange={(event) => setRoleName(event.target.value)}
                  required
                  value={roleName}
                />
              </label>
              <button className="primary" disabled={busy} type="submit">
                {t.create}
              </button>
            </form>
            {busy ? (
              <p className="empty-state">{t.loading}</p>
            ) : roles.length ? (
              <div className="role-list">
                {roles.map((role) => (
                  <article key={role.id}>
                    <span>{role.code.slice(0, 2).toUpperCase()}</span>
                    <div>
                      <h3>{role.name}</h3>
                      <p>{role.code}</p>
                    </div>
                    <strong>{role.permissions?.length ?? 0}</strong>
                  </article>
                ))}
              </div>
            ) : (
              <p className="empty-state">{t.empty}</p>
            )}
          </section>
        )}
        {tab === 'audit' && (
          <section className="data-section">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Immutable events</p>
                <h2>{t.audit}</h2>
              </div>
            </div>
            {busy ? (
              <p className="empty-state">{t.loading}</p>
            ) : audits.length ? (
              <div className="audit-list">
                {audits.map((item) => (
                  <article key={item.id}>
                    <span className="audit-dot" />
                    <div>
                      <h3>{item.action}</h3>
                      <p>
                        {item.actorId} ·{' '}
                        {new Intl.DateTimeFormat(
                          locale === 'zh' ? 'zh-CN' : locale === 'en' ? 'en-US' : 'vi-VN',
                          { dateStyle: 'medium', timeStyle: 'short' },
                        ).format(new Date(item.createdAt))}
                      </p>
                      {item.reason && <small>{item.reason}</small>}
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <p className="empty-state">{t.empty}</p>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

const rootElement = document.querySelector('#root');
if (!rootElement) throw new Error('Root element was not found');
createRoot(rootElement).render(
  <StrictMode>
    <AdminApp />
  </StrictMode>,
);
