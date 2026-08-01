import React, { useCallback, useEffect, useState } from 'react';
import { translate, type MessageKey } from '@zalo-shop/i18n';
import { Link } from 'react-router-dom';

import type { Locale } from './catalog-api';
import { IdentityPanel } from './identity-panel';
import {
  cancelPrivacyRequest,
  clearMemberProductHistory,
  createPrivacyRequest,
  deleteMemberFavorite,
  deleteMemberProductHistory,
  getMemberSummary,
  listMemberConsents,
  listMemberFavorites,
  listMemberProductHistory,
  listPrivacyRequests,
  withdrawMemberConsent,
  type MemberCommerceSummary,
  type MemberConsent,
  type MemberProduct,
  type MemberProductPage,
  type PrivacyRequest,
  type PrivacyRequestPage,
  type PrivacyRequestType,
} from './member-runtime-api';
import { useMemberSession } from './member-session';

type Loadable<T> = { data: T; status: 'ready' } | { status: 'error' } | { status: 'loading' };

const localeTag: Record<Locale, string> = {
  en: 'en-US',
  vi: 'vi-VN',
  zh: 'zh-CN',
};

function t(locale: Locale, key: MessageKey): string {
  return translate(locale, key);
}

function MemberHeader({ locale, title }: { locale: Locale; title: string }): JSX.Element {
  return (
    <header className="member-page-header">
      <Link aria-label={t(locale, 'catalog.back')} className="back-link" to="/profile">
        ←
      </Link>
      <div>
        <p className="section-kicker">{t(locale, 'member.account')}</p>
        <h1>{title}</h1>
      </div>
    </header>
  );
}

function MemberState({
  locale,
  onRetry,
  status,
}: {
  locale: Locale;
  onRetry?: () => void;
  status: 'empty' | 'error' | 'loading';
}): JSX.Element {
  return (
    <div className={`member-state ${status}`} role={status === 'error' ? 'alert' : 'status'}>
      <span aria-hidden="true">{status === 'loading' ? '…' : status === 'empty' ? '○' : '!'}</span>
      <strong>{t(locale, `member.${status}` as MessageKey)}</strong>
      {status === 'error' && onRetry && (
        <button onClick={onRetry} type="button">
          {t(locale, 'member.retry')}
        </button>
      )}
    </div>
  );
}

export function MemberCenterView({ locale }: { locale: Locale }): JSX.Element {
  const session = useMemberSession();
  const [state, setState] = useState<Loadable<MemberCommerceSummary>>({ status: 'loading' });
  const load = useCallback((): void => {
    if (!session.accessToken) return;
    setState({ status: 'loading' });
    void getMemberSummary(session.accessToken)
      .then((data) => setState({ data, status: 'ready' }))
      .catch(() => setState({ status: 'error' }));
  }, [session.accessToken]);

  useEffect(load, [load]);

  if (session.status !== 'ready' || !session.accessToken) {
    return (
      <div className="page-view">
        <IdentityPanel locale={locale} />
      </div>
    );
  }

  const links: Array<[string, string, MessageKey, number | undefined]> = [
    ['/orders', '▤', 'catalog.orders', undefined],
    [
      '/profile/favorites',
      '♡',
      'member.favorites',
      state.status === 'ready' ? state.data.favorite_count : undefined,
    ],
    [
      '/profile/history',
      '◷',
      'member.history',
      state.status === 'ready' ? state.data.product_history_count : undefined,
    ],
    [
      '/addresses',
      '⌖',
      'member.addresses',
      state.status === 'ready' ? state.data.address_count : undefined,
    ],
    ['/profile/privacy', '◎', 'member.privacy', undefined],
  ];

  return (
    <div className="member-center page-view">
      <header className="member-center-intro">
        <p className="section-kicker">{t(locale, 'member.account')}</p>
        <h1>{t(locale, 'member.title')}</h1>
        <p>{t(locale, 'member.subtitle')}</p>
      </header>
      {state.status === 'loading' && <MemberState locale={locale} status="loading" />}
      {state.status === 'error' && <MemberState locale={locale} onRetry={load} status="error" />}
      <nav className="member-menu" aria-label={t(locale, 'member.title')}>
        {links.map(([to, icon, key, count]) => (
          <Link key={to} to={to}>
            <span aria-hidden="true">{icon}</span>
            <strong>{t(locale, key)}</strong>
            {count !== undefined && <b>{count}</b>}
            <i aria-hidden="true">›</i>
          </Link>
        ))}
      </nav>
      <IdentityPanel locale={locale} />
    </div>
  );
}

function MemberProductRow({
  item,
  locale,
  onRemove,
  removing,
}: {
  item: MemberProduct;
  locale: Locale;
  onRemove: () => void;
  removing: boolean;
}): JSX.Element {
  const media = item.primary_media_url ? (
    <img alt={item.name} height="112" loading="lazy" src={item.primary_media_url} width="96" />
  ) : (
    <span className="member-product-placeholder" aria-hidden="true">
      ◇
    </span>
  );
  return (
    <article className={`member-product${item.available ? '' : ' unavailable'}`}>
      {item.available ? (
        <Link to={`/products/${item.product_code}`}>{media}</Link>
      ) : (
        <span className="member-product-media">{media}</span>
      )}
      <div>
        <strong>{item.name}</strong>
        <small>{item.product_code}</small>
        <time dateTime={item.last_interaction_at}>
          {new Intl.DateTimeFormat(localeTag[locale], {
            dateStyle: 'medium',
            timeStyle: 'short',
          }).format(new Date(item.last_interaction_at))}
        </time>
        {!item.available && <em>{t(locale, 'member.unavailable')}</em>}
      </div>
      <button
        aria-label={`${t(locale, 'member.remove')} ${item.name}`}
        disabled={removing}
        onClick={onRemove}
        title={t(locale, 'member.remove')}
        type="button"
      >
        ×
      </button>
    </article>
  );
}

export function MemberProductsView({
  kind,
  locale,
}: {
  kind: 'favorites' | 'history';
  locale: Locale;
}): JSX.Element {
  const session = useMemberSession();
  const hasSession = session.status === 'ready' && Boolean(session.accessToken);
  const [state, setState] = useState<Loadable<MemberProductPage>>({ status: 'loading' });
  const [removing, setRemoving] = useState<string>();
  const [clearing, setClearing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  const load = useCallback((): void => {
    if (!session.accessToken) return;
    setState({ status: 'loading' });
    const request =
      kind === 'favorites'
        ? listMemberFavorites(session.accessToken, locale)
        : listMemberProductHistory(session.accessToken, locale);
    void request
      .then((data) => setState({ data, status: 'ready' }))
      .catch(() => setState({ status: 'error' }));
  }, [kind, locale, session.accessToken]);
  useEffect(load, [load]);

  const loadMore = async (): Promise<void> => {
    if (!session.accessToken || state.status !== 'ready' || !state.data.next_cursor) return;
    setLoadingMore(true);
    setFeedback(undefined);
    try {
      const page =
        kind === 'favorites'
          ? await listMemberFavorites(session.accessToken, locale, state.data.next_cursor)
          : await listMemberProductHistory(session.accessToken, locale, state.data.next_cursor);
      setState((current) =>
        current.status === 'ready'
          ? {
              data: {
                items: [...current.data.items, ...page.items],
                next_cursor: page.next_cursor,
              },
              status: 'ready',
            }
          : current,
      );
    } catch {
      setFeedback(t(locale, 'member.actionError'));
    } finally {
      setLoadingMore(false);
    }
  };

  const remove = async (item: MemberProduct): Promise<void> => {
    if (!session.accessToken) return;
    setRemoving(item.product_code);
    setFeedback(undefined);
    try {
      if (kind === 'favorites') {
        await deleteMemberFavorite(session.accessToken, item.product_code);
      } else {
        await deleteMemberProductHistory(session.accessToken, item.product_code);
      }
      setState((current) =>
        current.status === 'ready'
          ? {
              data: {
                ...current.data,
                items: current.data.items.filter(
                  ({ product_code }) => product_code !== item.product_code,
                ),
              },
              status: 'ready',
            }
          : current,
      );
      setFeedback(t(locale, 'member.removed'));
    } catch {
      setFeedback(t(locale, 'member.actionError'));
    } finally {
      setRemoving(undefined);
    }
  };

  const clearHistory = async (): Promise<void> => {
    if (!session.accessToken || !window.confirm(t(locale, 'member.clearConfirm'))) return;
    setClearing(true);
    setFeedback(undefined);
    try {
      await clearMemberProductHistory(session.accessToken);
      setState({ data: { items: [], next_cursor: null }, status: 'ready' });
      setFeedback(t(locale, 'member.cleared'));
    } catch {
      setFeedback(t(locale, 'member.actionError'));
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="member-page page-view">
      <MemberHeader
        locale={locale}
        title={t(locale, kind === 'favorites' ? 'member.favorites' : 'member.history')}
      />
      {hasSession &&
        kind === 'history' &&
        state.status === 'ready' &&
        state.data.items.length > 0 && (
          <button className="member-clear" disabled={clearing} onClick={() => void clearHistory()}>
            {clearing ? t(locale, 'member.clearing') : t(locale, 'member.clear')}
          </button>
        )}
      {!hasSession && <IdentityPanel locale={locale} />}
      {hasSession && state.status === 'loading' && <MemberState locale={locale} status="loading" />}
      {hasSession && state.status === 'error' && (
        <MemberState locale={locale} onRetry={load} status="error" />
      )}
      {hasSession && state.status === 'ready' && state.data.items.length === 0 && (
        <MemberState locale={locale} status="empty" />
      )}
      {hasSession && state.status === 'ready' && state.data.items.length > 0 && (
        <div className="member-product-list">
          {state.data.items.map((item) => (
            <MemberProductRow
              item={item}
              key={item.product_code}
              locale={locale}
              onRemove={() => void remove(item)}
              removing={removing === item.product_code}
            />
          ))}
        </div>
      )}
      {hasSession && state.status === 'ready' && state.data.next_cursor && (
        <button
          className="member-load-more"
          disabled={loadingMore}
          onClick={() => void loadMore()}
          type="button"
        >
          {loadingMore ? t(locale, 'member.loadingMore') : t(locale, 'member.loadMore')}
        </button>
      )}
      {feedback && (
        <p className="member-feedback" role="status">
          {feedback}
        </p>
      )}
    </div>
  );
}

const privacyTypes: PrivacyRequestType[] = [
  'ACCESS',
  'CORRECTION',
  'DELETION',
  'ANONYMIZATION',
  'ACCOUNT_CLOSURE',
];

export function MemberPrivacyView({ locale }: { locale: Locale }): JSX.Element {
  const session = useMemberSession();
  const hasSession = session.status === 'ready' && Boolean(session.accessToken);
  const [requests, setRequests] = useState<Loadable<PrivacyRequestPage>>({ status: 'loading' });
  const [consents, setConsents] = useState<MemberConsent[]>([]);
  const [requestType, setRequestType] = useState<PrivacyRequestType>('ACCESS');
  const [description, setDescription] = useState('');
  const [pending, setPending] = useState<string>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  const load = useCallback((): void => {
    if (!session.accessToken) return;
    setRequests({ status: 'loading' });
    void Promise.all([
      listPrivacyRequests(session.accessToken),
      listMemberConsents(session.accessToken),
    ])
      .then(([privacy, currentConsents]) => {
        setRequests({ data: privacy, status: 'ready' });
        setConsents(currentConsents.items);
      })
      .catch(() => setRequests({ status: 'error' }));
  }, [session.accessToken]);
  useEffect(load, [load]);

  const loadMore = async (): Promise<void> => {
    if (!session.accessToken || requests.status !== 'ready' || !requests.data.next_cursor) return;
    setLoadingMore(true);
    setFeedback(undefined);
    try {
      const page = await listPrivacyRequests(session.accessToken, requests.data.next_cursor);
      setRequests((current) =>
        current.status === 'ready'
          ? {
              data: {
                items: [...current.data.items, ...page.items],
                next_cursor: page.next_cursor,
              },
              status: 'ready',
            }
          : current,
      );
    } catch {
      setFeedback(t(locale, 'member.actionError'));
    } finally {
      setLoadingMore(false);
    }
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!session.accessToken || description.trim().length < 10) {
      setFeedback(t(locale, 'member.privacyDescriptionRequired'));
      return;
    }
    setPending('create');
    setFeedback(undefined);
    try {
      await createPrivacyRequest(session.accessToken, {
        description: description.trim(),
        requestType,
      });
      setDescription('');
      setFeedback(t(locale, 'member.privacySubmitted'));
      load();
    } catch {
      setFeedback(t(locale, 'member.actionError'));
    } finally {
      setPending(undefined);
    }
  };

  const cancel = async (item: PrivacyRequest): Promise<void> => {
    if (!session.accessToken || !window.confirm(t(locale, 'member.privacyCancelConfirm'))) return;
    setPending(item.public_number);
    setFeedback(undefined);
    try {
      await cancelPrivacyRequest(session.accessToken, item);
      setFeedback(t(locale, 'member.privacyCancelled'));
      load();
    } catch {
      setFeedback(t(locale, 'member.actionError'));
    } finally {
      setPending(undefined);
    }
  };

  const withdraw = async (consent: MemberConsent): Promise<void> => {
    if (!session.accessToken || !window.confirm(t(locale, 'member.consentWithdrawConfirm'))) return;
    setPending(`consent-${consent.purpose}`);
    setFeedback(undefined);
    try {
      await withdrawMemberConsent(session.accessToken, consent);
      setFeedback(t(locale, 'member.consentWithdrawn'));
      load();
    } catch {
      setFeedback(t(locale, 'member.actionError'));
    } finally {
      setPending(undefined);
    }
  };

  return (
    <div className="member-page page-view">
      <MemberHeader locale={locale} title={t(locale, 'member.privacy')} />
      {!hasSession && <IdentityPanel locale={locale} />}
      {hasSession && requests.status === 'loading' && (
        <MemberState locale={locale} status="loading" />
      )}
      {hasSession && requests.status === 'error' && (
        <MemberState locale={locale} onRetry={load} status="error" />
      )}
      {hasSession && requests.status === 'ready' && (
        <>
          <section className="member-consents" aria-labelledby="member-consent-title">
            <div className="member-section-title">
              <div>
                <p className="section-kicker">{t(locale, 'member.latestFacts')}</p>
                <h2 id="member-consent-title">{t(locale, 'member.consents')}</h2>
              </div>
            </div>
            {consents.length === 0 ? (
              <p className="member-empty-copy">{t(locale, 'member.consentEmpty')}</p>
            ) : (
              <div className="consent-list">
                {consents.map((consent) => (
                  <article key={consent.purpose}>
                    <div>
                      <strong>
                        {t(locale, `member.consent.${consent.purpose}` as MessageKey)}
                      </strong>
                      <small>
                        {t(locale, `member.consentStatus.${consent.status}` as MessageKey)} ·{' '}
                        {consent.policy_version}
                      </small>
                    </div>
                    {consent.status === 'GRANTED' && (
                      <button
                        disabled={pending === `consent-${consent.purpose}`}
                        onClick={() => void withdraw(consent)}
                        type="button"
                      >
                        {t(locale, 'member.consentWithdraw')}
                      </button>
                    )}
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="privacy-create" aria-labelledby="privacy-create-title">
            <div className="member-section-title">
              <div>
                <p className="section-kicker">{t(locale, 'member.privacyIntake')}</p>
                <h2 id="privacy-create-title">{t(locale, 'member.privacyNew')}</h2>
              </div>
            </div>
            <form onSubmit={(event) => void submit(event)}>
              <label>
                {t(locale, 'member.privacyType')}
                <select
                  onChange={(event) => setRequestType(event.target.value as PrivacyRequestType)}
                  value={requestType}
                >
                  {privacyTypes.map((type) => (
                    <option key={type} value={type}>
                      {t(locale, `member.privacyType.${type}` as MessageKey)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t(locale, 'member.privacyDescription')}
                <textarea
                  maxLength={1_000}
                  minLength={10}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder={t(locale, 'member.privacyPlaceholder')}
                  rows={4}
                  value={description}
                />
              </label>
              <button className="button-primary" disabled={pending === 'create'} type="submit">
                {pending === 'create' ? t(locale, 'member.submitting') : t(locale, 'member.submit')}
              </button>
            </form>
          </section>

          <section className="privacy-list" aria-labelledby="privacy-list-title">
            <div className="member-section-title">
              <div>
                <p className="section-kicker">{t(locale, 'member.latestFacts')}</p>
                <h2 id="privacy-list-title">{t(locale, 'member.privacyRequests')}</h2>
              </div>
            </div>
            {requests.data.items.length === 0 ? (
              <p className="member-empty-copy">{t(locale, 'member.privacyEmpty')}</p>
            ) : (
              <div className="privacy-request-list">
                {requests.data.items.map((item) => (
                  <article key={item.public_number}>
                    <header>
                      <div>
                        <strong>
                          {t(locale, `member.privacyType.${item.request_type}` as MessageKey)}
                        </strong>
                        <small>{item.public_number}</small>
                      </div>
                      <span data-status={item.status}>
                        {t(locale, `member.privacyStatus.${item.status}` as MessageKey)}
                      </span>
                    </header>
                    <p>{item.description}</p>
                    <footer>
                      <time dateTime={item.updated_at}>
                        {new Intl.DateTimeFormat(localeTag[locale], {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        }).format(new Date(item.updated_at))}
                      </time>
                      {(item.status === 'SUBMITTED' || item.status === 'ACTION_REQUIRED') && (
                        <button
                          disabled={pending === item.public_number}
                          onClick={() => void cancel(item)}
                          type="button"
                        >
                          {t(locale, 'member.cancel')}
                        </button>
                      )}
                    </footer>
                  </article>
                ))}
              </div>
            )}
            {requests.data.next_cursor && (
              <button
                className="member-load-more"
                disabled={loadingMore}
                onClick={() => void loadMore()}
                type="button"
              >
                {loadingMore ? t(locale, 'member.loadingMore') : t(locale, 'member.loadMore')}
              </button>
            )}
          </section>
        </>
      )}
      {feedback && (
        <p className="member-feedback" role="status">
          {feedback}
        </p>
      )}
    </div>
  );
}
