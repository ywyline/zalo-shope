import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatVnd, translate, type MessageKey } from '@zalo-shop/i18n';
import { Link, useNavigate, useParams } from 'react-router-dom';

import type { Locale } from './catalog-api';
import {
  bindPaymentProviderOrder,
  getPayment,
  getPaymentLaunch,
  queryPayment,
  retryPayment,
  type PaymentAttempt,
} from './commerce-api';
import { useMemberSession } from './member-session';
import { CheckoutRuntimeError, loadCheckoutRuntime, runCheckoutFlow } from './payment-runtime';

function message(locale: Locale, key: MessageKey): string {
  return translate(locale, key);
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

type PendingBinding = Readonly<{
  idempotencyKey: string;
  launchToken: string;
  providerOrderId: string;
}>;

type PaymentPresentation = Readonly<{
  body: MessageKey;
  mark: string;
  tone: 'attention' | 'error' | 'pending' | 'success';
  title: MessageKey;
}>;

function presentation(attempt: PaymentAttempt): PaymentPresentation {
  switch (attempt.status) {
    case 'SUCCEEDED':
      return {
        body: 'payment.succeededBody',
        mark: '\u2713',
        title: 'payment.succeededTitle',
        tone: 'success',
      };
    case 'FAILED':
      return {
        body: 'payment.failedBody',
        mark: '!',
        title: 'payment.failedTitle',
        tone: 'error',
      };
    case 'CANCELLED':
      return {
        body: 'payment.cancelledBody',
        mark: '!',
        title: 'payment.cancelledTitle',
        tone: 'attention',
      };
    case 'EXPIRED':
      return {
        body: 'payment.expiredBody',
        mark: '!',
        title: 'payment.expiredTitle',
        tone: 'attention',
      };
    case 'REVIEW_REQUIRED':
      return {
        body: 'payment.reviewBody',
        mark: '!',
        title: 'payment.reviewTitle',
        tone: 'attention',
      };
    case 'CREATED':
      return attempt.launch_ready
        ? {
            body: 'payment.readyBody',
            mark: '1',
            title: 'payment.readyTitle',
            tone: 'pending',
          }
        : {
            body: 'payment.preparingBody',
            mark: '1',
            title: 'payment.preparingTitle',
            tone: 'pending',
          };
    case 'PROVIDER_PENDING':
      return attempt.provider_order_bound
        ? {
            body: 'payment.pendingBody',
            mark: '2',
            title: 'payment.pendingTitle',
            tone: 'pending',
          }
        : {
            body: 'payment.readyBody',
            mark: '1',
            title: 'payment.readyTitle',
            tone: 'pending',
          };
  }
}

export function PaymentView({ locale }: { locale: Locale }): JSX.Element {
  const { paymentId = '' } = useParams();
  const session = useMemberSession();
  const navigate = useNavigate();
  const checkoutController = useRef<AbortController>();
  const bindKey = useRef(crypto.randomUUID());
  const retryKey = useRef(crypto.randomUUID());
  const [attempt, setAttempt] = useState<PaymentAttempt>();
  const [loadState, setLoadState] = useState<'error' | 'loading' | 'ready'>('loading');
  const [action, setAction] = useState<'checking' | 'idle' | 'launching' | 'retrying'>('idle');
  const [feedback, setFeedback] = useState<MessageKey>();
  const [pendingBinding, setPendingBinding] = useState<PendingBinding>();

  const refresh = useCallback(async (): Promise<PaymentAttempt | undefined> => {
    if (!session.accessToken || !paymentId) return undefined;
    try {
      const current = await getPayment(session.accessToken, paymentId);
      setAttempt(current);
      setLoadState('ready');
      return current;
    } catch {
      setLoadState('error');
      return undefined;
    }
  }, [paymentId, session.accessToken]);

  useEffect(() => {
    bindKey.current = crypto.randomUUID();
    retryKey.current = crypto.randomUUID();
    setAttempt(undefined);
    setFeedback(undefined);
    setPendingBinding(undefined);
    setLoadState('loading');
    void refresh();
  }, [paymentId, refresh]);

  useEffect(() => {
    if (!attempt || (attempt.status !== 'CREATED' && attempt.status !== 'PROVIDER_PENDING')) return;
    const delayMs = attempt.launch_ready && attempt.provider_order_bound ? 3_000 : 1_500;
    const timer = window.setTimeout(() => void refresh(), delayMs);
    return () => window.clearTimeout(timer);
  }, [attempt, refresh]);

  useEffect(
    () => () => {
      checkoutController.current?.abort();
    },
    [],
  );

  const bind = useCallback(
    async (binding: PendingBinding): Promise<PaymentAttempt> => {
      if (!session.accessToken || !attempt) throw new Error('Payment session is unavailable');
      let lastError: unknown;
      for (let index = 0; index < 3; index += 1) {
        try {
          const current = await bindPaymentProviderOrder(
            session.accessToken,
            attempt.order_id,
            attempt.id,
            {
              launch_token: binding.launchToken,
              provider_order_id: binding.providerOrderId,
            },
            binding.idempotencyKey,
          );
          setAttempt(current);
          setPendingBinding(undefined);
          return current;
        } catch (error) {
          lastError = error;
          if (index < 2) await wait(250 * 2 ** index);
        }
      }
      throw lastError;
    },
    [attempt, session.accessToken],
  );

  const check = useCallback(async (): Promise<void> => {
    if (!session.accessToken || !attempt || action !== 'idle') return;
    setAction('checking');
    setFeedback(undefined);
    try {
      const current = attempt.provider_order_bound
        ? await queryPayment(session.accessToken, attempt.id)
        : await getPayment(session.accessToken, attempt.id);
      setAttempt(current);
    } catch {
      const current = await refresh();
      if (!current) setFeedback('payment.queryError');
    } finally {
      setAction('idle');
    }
  }, [action, attempt, refresh, session.accessToken]);

  const launch = async (): Promise<void> => {
    if (
      !session.accessToken ||
      !attempt ||
      action !== 'idle' ||
      !attempt.launch_ready ||
      attempt.provider_order_bound ||
      pendingBinding
    ) {
      return;
    }
    const controller = new AbortController();
    checkoutController.current = controller;
    setAction('launching');
    setFeedback(undefined);
    try {
      const launchAction = await getPaymentLaunch(
        session.accessToken,
        attempt.id,
        controller.signal,
      );
      const runtime = await loadCheckoutRuntime();
      const result = await runCheckoutFlow({
        launch: launchAction,
        onProviderOrder: async (providerOrderId) => {
          const binding = {
            idempotencyKey: bindKey.current,
            launchToken: launchAction.launch_token,
            providerOrderId,
          };
          setPendingBinding(binding);
          await bind(binding);
        },
        runtime,
        signal: controller.signal,
      });
      if (result.completion === 'TIMED_OUT') setFeedback('payment.checkoutTimedOut');
      try {
        const current = await queryPayment(session.accessToken, attempt.id);
        setAttempt(current);
      } catch {
        await refresh();
      }
    } catch (error) {
      if (error instanceof CheckoutRuntimeError && error.code === 'CHECKOUT_ABORTED') return;
      setFeedback(
        error instanceof CheckoutRuntimeError && error.code === 'CHECKOUT_RUNTIME_UNAVAILABLE'
          ? 'payment.runtimeUnavailable'
          : 'payment.checkoutError',
      );
      await refresh();
    } finally {
      if (checkoutController.current === controller) checkoutController.current = undefined;
      setAction('idle');
    }
  };

  const retryBinding = async (): Promise<void> => {
    if (!pendingBinding || action !== 'idle') return;
    setAction('checking');
    setFeedback(undefined);
    try {
      await bind(pendingBinding);
    } catch {
      setFeedback('payment.bindError');
    } finally {
      setAction('idle');
    }
  };

  const retry = async (): Promise<void> => {
    if (!session.accessToken || !attempt || action !== 'idle') return;
    setAction('retrying');
    setFeedback(undefined);
    try {
      const next = await retryPayment(session.accessToken, attempt.order_id, retryKey.current);
      navigate(`/payments/${next.id}`, { replace: true });
    } catch {
      setFeedback('payment.retryError');
      setAction('idle');
    }
  };

  const details = useMemo(() => (attempt ? presentation(attempt) : undefined), [attempt]);
  if (session.status !== 'ready') {
    return <p className="commerce-state">{message(locale, 'cart.signInTitle')}</p>;
  }
  if (loadState === 'loading') {
    return <p className="commerce-state">{message(locale, 'payment.loading')}</p>;
  }
  if (loadState === 'error' || !attempt || !details) {
    return (
      <button className="commerce-state error" onClick={() => void refresh()} type="button">
        {message(locale, 'payment.loadError')} · {message(locale, 'app.retry')}
      </button>
    );
  }

  const canLaunch =
    (attempt.status === 'CREATED' || attempt.status === 'PROVIDER_PENDING') &&
    attempt.launch_ready &&
    !attempt.provider_order_bound &&
    !pendingBinding;
  const canRetry = attempt.status === 'FAILED' || attempt.status === 'CANCELLED';
  const active = attempt.status === 'CREATED' || attempt.status === 'PROVIDER_PENDING';

  return (
    <div className="page-view commerce-page payment-page">
      <header className={`payment-hero tone-${details.tone}`} aria-live="polite">
        <span className="payment-mark" aria-hidden="true">
          {details.mark}
        </span>
        <p className="section-kicker">ZaloPay</p>
        <h1>{message(locale, details.title)}</h1>
        <p>{message(locale, details.body)}</p>
      </header>

      <section className="payment-facts">
        <div>
          <span>{message(locale, 'payment.number')}</span>
          <strong>{attempt.payment_number}</strong>
        </div>
        <div>
          <span>{message(locale, 'checkout.total')}</span>
          <strong>{formatVnd(attempt.amount_vnd, locale)}</strong>
        </div>
        <div>
          <span>{message(locale, 'payment.expires')}</span>
          <strong>
            {new Intl.DateTimeFormat(
              locale === 'zh' ? 'zh-CN' : locale === 'en' ? 'en-US' : 'vi-VN',
              { dateStyle: 'medium', timeStyle: 'short' },
            ).format(new Date(attempt.expires_at))}
          </strong>
        </div>
      </section>

      <p className="payment-trust-note">{message(locale, 'payment.secureNote')}</p>
      {feedback && (
        <p className="form-error payment-feedback" role="alert">
          {message(locale, feedback)}
        </p>
      )}

      <div className="payment-actions">
        {pendingBinding && (
          <button
            className="button-primary"
            disabled={action !== 'idle'}
            onClick={() => void retryBinding()}
            type="button"
          >
            {message(locale, action === 'checking' ? 'payment.checking' : 'payment.retryBinding')}
          </button>
        )}
        {canLaunch && (
          <button
            className="button-primary"
            disabled={action !== 'idle'}
            onClick={() => void launch()}
            type="button"
          >
            {message(locale, action === 'launching' ? 'payment.opening' : 'payment.payNow')}
          </button>
        )}
        {active && !pendingBinding && (
          <button
            className="button-quiet"
            disabled={action !== 'idle'}
            onClick={() => void check()}
            type="button"
          >
            {message(locale, action === 'checking' ? 'payment.checking' : 'payment.checkStatus')}
          </button>
        )}
        {canRetry && (
          <button
            className="button-primary"
            disabled={action !== 'idle'}
            onClick={() => void retry()}
            type="button"
          >
            {message(locale, action === 'retrying' ? 'payment.retrying' : 'payment.retry')}
          </button>
        )}
        <Link
          className={active || canRetry ? 'button-quiet' : 'button-primary'}
          to={`/orders/${attempt.order_id}`}
        >
          {message(locale, 'order.viewOrder')}
        </Link>
      </div>
    </div>
  );
}
