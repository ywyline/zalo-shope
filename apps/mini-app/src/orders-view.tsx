import React, { useCallback, useEffect, useState } from 'react';
import { formatVnd, translate, type MessageKey } from '@zalo-shop/i18n';
import { Link, useParams } from 'react-router-dom';

import type { Locale } from './catalog-api';
import {
  cancelOrder,
  getOrder,
  listOrders,
  type OrderDetail,
  type OrderSummary,
} from './commerce-api';
import { useMemberSession } from './member-session';

function message(locale: Locale, key: MessageKey): string {
  return translate(locale, key);
}

const statusKeys: Record<string, MessageKey> = {
  CANCELLED: 'order.status.cancelled',
  CLOSED: 'order.status.closed',
  COMPLETED: 'order.status.completed',
  CONFIRMED: 'order.status.confirmed',
  DELIVERED: 'order.status.delivered',
  PENDING_CONFIRMATION: 'order.status.pendingConfirmation',
  PENDING_FULFILLMENT: 'order.status.pendingFulfillment',
  PENDING_PAYMENT: 'order.status.pendingPayment',
  SHIPPED: 'order.status.shipped',
};

function status(locale: Locale, value: string): string {
  const key = statusKeys[value];
  return key ? message(locale, key) : value;
}

function OrderCard({ locale, order }: { locale: Locale; order: OrderSummary }): JSX.Element {
  return (
    <Link className="order-card" to={`/orders/${order.id}`}>
      <div>
        <small>{message(locale, 'order.number')}</small>
        <strong>{order.order_number}</strong>
      </div>
      <span className={`order-status status-${order.status.toLowerCase()}`}>
        {status(locale, order.status)}
      </span>
      <div className="order-card-footer">
        <span>
          {new Intl.DateTimeFormat(
            locale === 'zh' ? 'zh-CN' : locale === 'en' ? 'en-US' : 'vi-VN',
          ).format(new Date(order.created_at))}
        </span>
        <strong>{formatVnd(order.payable_vnd, locale)}</strong>
      </div>
    </Link>
  );
}

export function OrdersView({ locale }: { locale: Locale }): JSX.Element {
  const session = useMemberSession();
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [state, setState] = useState<'error' | 'loading' | 'ready'>('loading');
  const load = useCallback(async (): Promise<void> => {
    if (!session.accessToken) return;
    setState('loading');
    try {
      setOrders((await listOrders(session.accessToken)).items);
      setState('ready');
    } catch {
      setState('error');
    }
  }, [session.accessToken]);
  useEffect(() => void load(), [load]);
  return (
    <div className="page-view commerce-page">
      <header className="page-intro compact-intro">
        <p className="section-kicker">Orders</p>
        <h1>{message(locale, 'order.listTitle')}</h1>
      </header>
      {state === 'loading' && <p className="commerce-state">{message(locale, 'order.loading')}</p>}
      {state === 'error' && (
        <button className="commerce-state" onClick={() => void load()} type="button">
          {message(locale, 'order.error')} · {message(locale, 'app.retry')}
        </button>
      )}
      {state === 'ready' && orders.length === 0 && (
        <div className="commerce-state">
          <p>{message(locale, 'order.empty')}</p>
          <Link className="button-primary" to="/products">
            {message(locale, 'catalog.explore')}
          </Link>
        </div>
      )}
      <section className="order-list">
        {orders.map((order) => (
          <OrderCard key={order.id} locale={locale} order={order} />
        ))}
      </section>
    </div>
  );
}

export function OrderDetailView({ locale }: { locale: Locale }): JSX.Element {
  const { orderId = '' } = useParams();
  const session = useMemberSession();
  const [order, setOrder] = useState<OrderDetail>();
  const [state, setState] = useState<'error' | 'loading' | 'ready'>('loading');
  const [reason, setReason] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const load = useCallback(async (): Promise<void> => {
    if (!session.accessToken || !orderId) return;
    setState('loading');
    try {
      setOrder(await getOrder(session.accessToken, orderId));
      setState('ready');
    } catch {
      setState('error');
    }
  }, [orderId, session.accessToken]);
  useEffect(() => void load(), [load]);

  const cancel = async (): Promise<void> => {
    if (!session.accessToken || !order || reason.trim().length < 2) return;
    setCancelling(true);
    try {
      await cancelOrder(session.accessToken, order.id, reason.trim());
      await load();
    } finally {
      setCancelling(false);
    }
  };
  if (state === 'loading')
    return <p className="commerce-state">{message(locale, 'order.loading')}</p>;
  if (state === 'error' || !order)
    return <p className="commerce-state error">{message(locale, 'order.error')}</p>;
  return (
    <div className="page-view commerce-page order-detail-page">
      <header className="page-intro compact-intro">
        <p className="section-kicker">{message(locale, 'order.detail')}</p>
        <h1>{order.order_number}</h1>
        <span className="order-status">{status(locale, order.status)}</span>
      </header>
      <section className="checkout-section order-address">
        <h2>{message(locale, 'address.title')}</h2>
        {order.address && (
          <p>
            <strong>{order.address.recipient_name}</strong> · {order.address.masked_phone}
            <br />
            {order.address.detail}, {order.address.ward_name}, {order.address.district_name},{' '}
            {order.address.province_name}
          </p>
        )}
      </section>
      <section className="checkout-summary">
        {order.items.map((item) => (
          <div key={item.sku_code}>
            <span>
              {item.sku_code} × {item.quantity}
            </span>
            <strong>{formatVnd(item.payable_vnd, locale)}</strong>
          </div>
        ))}
        <div className="checkout-total">
          <span>{message(locale, 'checkout.total')}</span>
          <strong>{formatVnd(order.payable_vnd, locale)}</strong>
        </div>
      </section>
      <section className="order-timeline">
        <h2>{message(locale, 'order.timeline')}</h2>
        {order.transitions.map((item) => (
          <div key={`${item.created_at}-${item.event}`}>
            <span />
            <p>
              <strong>{status(locale, item.to_status)}</strong>
              <small>
                {new Intl.DateTimeFormat(
                  locale === 'zh' ? 'zh-CN' : locale === 'en' ? 'en-US' : 'vi-VN',
                  { dateStyle: 'medium', timeStyle: 'short' },
                ).format(new Date(item.created_at))}
              </small>
            </p>
          </div>
        ))}
      </section>
      {order.status === 'PENDING_CONFIRMATION' && (
        <section className="cancel-order-panel">
          <label>
            {message(locale, 'order.cancelReason')}
            <textarea
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
              value={reason}
            />
          </label>
          <button
            className="button-danger"
            disabled={cancelling || reason.trim().length < 2}
            onClick={() => void cancel()}
            type="button"
          >
            {message(locale, 'order.cancel')}
          </button>
        </section>
      )}
    </div>
  );
}

export function OrderResultView({ locale }: { locale: Locale }): JSX.Element {
  const { orderId = '' } = useParams();
  return (
    <div className="page-view order-result-view">
      <span className="result-mark" aria-hidden="true">
        ✓
      </span>
      <p className="section-kicker">COD</p>
      <h1>{message(locale, 'order.resultTitle')}</h1>
      <p>{message(locale, 'order.resultBody')}</p>
      <div className="result-actions">
        <Link className="button-primary" to={`/orders/${orderId}`}>
          {message(locale, 'order.viewOrder')}
        </Link>
        <Link className="button-quiet" to="/products">
          {message(locale, 'order.continueShopping')}
        </Link>
      </div>
    </div>
  );
}
