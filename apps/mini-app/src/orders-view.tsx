import React, { useCallback, useEffect, useState } from 'react';
import { formatVnd, translate, type MessageKey } from '@zalo-shop/i18n';
import { Link, useParams } from 'react-router-dom';

import type { Locale } from './catalog-api';
import {
  cancelOrder,
  getOrder,
  getOrderShipment,
  listOrders,
  type OrderDetail,
  type OrderSummary,
  type Shipment,
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

const shipmentStatusKeys: Record<string, MessageKey> = {
  CANCELLED: 'shipment.status.cancelled',
  CREATION_PENDING: 'shipment.status.creationPending',
  DELIVERED: 'shipment.status.delivered',
  EXCEPTION: 'shipment.status.exception',
  IN_TRANSIT: 'shipment.status.inTransit',
  OUT_FOR_DELIVERY: 'shipment.status.outForDelivery',
  PENDING_PICKUP: 'shipment.status.pendingPickup',
  REFUSED: 'shipment.status.refused',
  RETURNED: 'shipment.status.returned',
  RETURNING: 'shipment.status.returning',
  REVIEW_REQUIRED: 'shipment.status.reviewRequired',
};

const refundStatusKeys: Record<string, MessageKey> = {
  CANCELLED: 'refund.status.cancelled',
  FAILED: 'refund.status.failed',
  PROCESSING: 'refund.status.processing',
  REQUESTED: 'refund.status.requested',
  REVIEW_REQUIRED: 'refund.status.reviewRequired',
  SUCCEEDED: 'refund.status.succeeded',
};

function refundStatus(locale: Locale, value: string): string {
  const key = refundStatusKeys[value];
  return key ? message(locale, key) : message(locale, 'refund.status.reviewRequired');
}

const trackingMessageKeys: Record<string, MessageKey> = {
  'shipment.tracking.cancelled': 'shipment.tracking.cancelled',
  'shipment.tracking.creation_pending': 'shipment.tracking.creation_pending',
  'shipment.tracking.delivered': 'shipment.tracking.delivered',
  'shipment.tracking.exception': 'shipment.tracking.exception',
  'shipment.tracking.in_transit': 'shipment.tracking.in_transit',
  'shipment.tracking.out_for_delivery': 'shipment.tracking.out_for_delivery',
  'shipment.tracking.pending_pickup': 'shipment.tracking.pending_pickup',
  'shipment.tracking.refused': 'shipment.tracking.refused',
  'shipment.tracking.returned': 'shipment.tracking.returned',
  'shipment.tracking.returning': 'shipment.tracking.returning',
  'shipment.tracking.review_required': 'shipment.tracking.review_required',
};

function shipmentStatus(locale: Locale, value: string): string {
  const key = shipmentStatusKeys[value];
  return key ? message(locale, key) : message(locale, 'shipment.status.reviewRequired');
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
  const [shipment, setShipment] = useState<Shipment | null>(null);
  const [shipmentState, setShipmentState] = useState<'error' | 'loading' | 'ready'>('loading');
  const [reason, setReason] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const load = useCallback(async (): Promise<void> => {
    if (!session.accessToken || !orderId) return;
    setState('loading');
    setShipmentState('loading');
    try {
      setOrder(await getOrder(session.accessToken, orderId));
      setState('ready');
      try {
        setShipment((await getOrderShipment(session.accessToken, orderId)).shipment);
        setShipmentState('ready');
      } catch {
        setShipmentState('error');
      }
    } catch {
      setState('error');
      setShipmentState('error');
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
      {order.payment_method === 'ONLINE' && order.status === 'PENDING_PAYMENT' && (
        <section className="payment-resume-panel">
          <div>
            <h2>{message(locale, 'payment.resumeTitle')}</h2>
            <p>{message(locale, 'payment.resumeBody')}</p>
          </div>
          {order.payment_attempt_id ? (
            <Link className="button-primary" to={`/payments/${order.payment_attempt_id}`}>
              {message(locale, 'payment.resume')}
            </Link>
          ) : (
            <span className="form-error">{message(locale, 'payment.loadError')}</span>
          )}
        </section>
      )}
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
      <section className="refund-status-panel" aria-live="polite">
        <h2>{message(locale, 'refund.title')}</h2>
        {order.refunds.length === 0 ? (
          <p className="refund-empty">{message(locale, 'refund.empty')}</p>
        ) : (
          <div className="refund-list">
            {order.refunds.map((refund) => (
              <article className="refund-row" key={refund.public_number}>
                <div>
                  <small>{message(locale, 'refund.number')}</small>
                  <strong>{refund.public_number}</strong>
                </div>
                <div>
                  <small>{message(locale, 'refund.amount')}</small>
                  <strong>{formatVnd(refund.amount_vnd, locale)}</strong>
                </div>
                <span className={`order-status status-${refund.status.toLowerCase()}`}>
                  {refundStatus(locale, refund.status)}
                </span>
                <time dateTime={refund.updated_at}>
                  {new Intl.DateTimeFormat(
                    locale === 'zh' ? 'zh-CN' : locale === 'en' ? 'en-US' : 'vi-VN',
                    { dateStyle: 'medium', timeStyle: 'short' },
                  ).format(new Date(refund.updated_at))}
                </time>
              </article>
            ))}
          </div>
        )}
      </section>
      <section className="shipment-tracking" aria-live="polite">
        <div className="shipment-heading">
          <div>
            <h2>{message(locale, 'shipment.title')}</h2>
            {shipment && (
              <small>
                {message(locale, 'shipment.publicNumber')} · {shipment.public_number}
              </small>
            )}
          </div>
          {shipment && (
            <span className={`order-status status-${shipment.status.toLowerCase()}`}>
              {shipmentStatus(locale, shipment.status)}
            </span>
          )}
        </div>
        {shipmentState === 'loading' && (
          <p className="shipment-state">{message(locale, 'shipment.loading')}</p>
        )}
        {shipmentState === 'error' && (
          <button className="shipment-state" onClick={() => void load()} type="button">
            {message(locale, 'shipment.error')} · {message(locale, 'shipment.retry')}
          </button>
        )}
        {shipmentState === 'ready' && !shipment && (
          <p className="shipment-state">{message(locale, 'shipment.empty')}</p>
        )}
        {shipmentState === 'ready' && shipment && (
          <div className="shipment-events">
            {shipment.tracking_events.length === 0 ? (
              <div className="shipment-event current">
                <span />
                <p>
                  <strong>{shipmentStatus(locale, shipment.status)}</strong>
                  <small>
                    {new Intl.DateTimeFormat(
                      locale === 'zh' ? 'zh-CN' : locale === 'en' ? 'en-US' : 'vi-VN',
                      { dateStyle: 'medium', timeStyle: 'short' },
                    ).format(new Date(shipment.updated_at))}
                  </small>
                </p>
              </div>
            ) : (
              shipment.tracking_events.map((event, index) => {
                const key = trackingMessageKeys[event.message_key];
                return (
                  <div
                    className={
                      index === shipment.tracking_events.length - 1
                        ? 'shipment-event current'
                        : 'shipment-event'
                    }
                    key={`${event.occurred_at}-${event.status}`}
                  >
                    <span />
                    <p>
                      <strong>
                        {key ? message(locale, key) : shipmentStatus(locale, event.status)}
                      </strong>
                      {event.location_masked && <em>{event.location_masked}</em>}
                      <small>
                        {new Intl.DateTimeFormat(
                          locale === 'zh' ? 'zh-CN' : locale === 'en' ? 'en-US' : 'vi-VN',
                          { dateStyle: 'medium', timeStyle: 'short' },
                        ).format(new Date(event.occurred_at))}
                      </small>
                    </p>
                  </div>
                );
              })
            )}
          </div>
        )}
      </section>
      {(order.status === 'PENDING_CONFIRMATION' || order.status === 'PENDING_PAYMENT') && (
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
