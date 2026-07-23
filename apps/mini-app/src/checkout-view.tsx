import React, { useEffect, useMemo, useRef, useState } from 'react';
import { formatVnd, translate, type MessageKey } from '@zalo-shop/i18n';
import { Link, useNavigate } from 'react-router-dom';

import type { Locale } from './catalog-api';
import { useCart } from './cart-state';
import {
  createOrder,
  listAddresses,
  quoteCheckout,
  type Address,
  type CheckoutQuote,
} from './commerce-api';
import { useMemberSession } from './member-session';

function message(locale: Locale, key: MessageKey): string {
  return translate(locale, key);
}

export function CheckoutView({ locale }: { locale: Locale }): JSX.Element {
  const session = useMemberSession();
  const cart = useCart();
  const navigate = useNavigate();
  const idempotencyKey = useRef(crypto.randomUUID());
  const placingRef = useRef(false);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [addressId, setAddressId] = useState('');
  const [couponDraft, setCouponDraft] = useState('');
  const [couponCode, setCouponCode] = useState<string | null>(null);
  const [quote, setQuote] = useState<CheckoutQuote>();
  const [status, setStatus] = useState<'error' | 'loading' | 'ready'>('loading');
  const [placing, setPlacing] = useState(false);
  const [orderError, setOrderError] = useState(false);
  const items = useMemo(
    () =>
      cart.cart?.items
        .filter((item) => item.selected && !item.issues.some((issue) => issue.blocking))
        .map((item) => ({ quantity: item.quantity, sku_code: item.sku_code })) ?? [],
    [cart.cart],
  );

  useEffect(() => {
    if (!session.accessToken) return;
    const controller = new AbortController();
    listAddresses(session.accessToken, controller.signal)
      .then((result) => {
        setAddresses(result);
        setAddressId(
          (current) => current || result.find((item) => item.is_default)?.id || result[0]?.id || '',
        );
      })
      .catch(() => setStatus('error'));
    return () => controller.abort();
  }, [session.accessToken]);

  useEffect(() => {
    if (!session.accessToken || !addressId || items.length === 0) {
      setStatus('ready');
      setQuote(undefined);
      return;
    }
    const controller = new AbortController();
    setStatus('loading');
    quoteCheckout(
      session.accessToken,
      locale,
      { address_id: addressId, coupon_code: couponCode, items },
      controller.signal,
    )
      .then((result) => {
        setQuote(result);
        setStatus('ready');
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus('error');
      });
    return () => controller.abort();
  }, [addressId, couponCode, items, locale, session.accessToken]);

  const selectedAddress = addresses.find((item) => item.id === addressId);
  const place = async (): Promise<void> => {
    if (!session.accessToken || !quote || !addressId || placingRef.current) return;
    placingRef.current = true;
    setPlacing(true);
    setOrderError(false);
    try {
      const order = await createOrder(
        session.accessToken,
        locale,
        {
          address_id: addressId,
          coupon_code: couponCode,
          items,
          quote_hash: quote.quote_hash,
        },
        idempotencyKey.current,
      );
      await cart.refresh();
      navigate(`/order-result/${order.id}`, { replace: true, state: order });
    } catch {
      setOrderError(true);
    } finally {
      placingRef.current = false;
      setPlacing(false);
    }
  };

  if (session.status !== 'ready') {
    return <p className="commerce-state">{message(locale, 'cart.signInTitle')}</p>;
  }
  return (
    <div className="page-view commerce-page checkout-page">
      <header className="page-intro compact-intro">
        <p className="section-kicker">Checkout</p>
        <h1>{message(locale, 'checkout.title')}</h1>
      </header>

      <section className="checkout-section">
        <div className="section-heading compact-heading">
          <h2>{message(locale, 'address.title')}</h2>
          <Link to="/addresses">{message(locale, 'checkout.changeAddress')}</Link>
        </div>
        {addresses.length === 0 ? (
          <Link className="address-empty-action" to="/addresses">
            + {message(locale, 'address.new')}
          </Link>
        ) : (
          <div className="address-choice-list">
            {addresses.map((address) => (
              <label
                className={address.id === addressId ? 'address-choice active' : 'address-choice'}
                key={address.id}
              >
                <input
                  checked={address.id === addressId}
                  name="delivery-address"
                  onChange={() => setAddressId(address.id)}
                  type="radio"
                />
                <span>
                  <strong>{address.recipient_name}</strong> · {address.masked_phone}
                  <small>
                    {address.detail}, {address.ward_name}, {address.district_name},{' '}
                    {address.province_name}
                  </small>
                </span>
              </label>
            ))}
          </div>
        )}
      </section>

      <section className="checkout-section">
        <h2>{message(locale, 'checkout.payment')}</h2>
        <div
          className="payment-segments"
          role="group"
          aria-label={message(locale, 'checkout.payment')}
        >
          <button aria-pressed="true" className="active" type="button">
            {message(locale, 'checkout.cod')}
          </button>
          <button disabled type="button">
            {message(locale, 'checkout.onlineUnavailable')}
          </button>
        </div>
      </section>

      <section className="checkout-section">
        <label>
          {message(locale, 'checkout.coupon')}
          <span className="coupon-control">
            <input onChange={(event) => setCouponDraft(event.target.value)} value={couponDraft} />
            <button
              className="button-quiet"
              onClick={() => setCouponCode(couponDraft.trim() || null)}
              type="button"
            >
              {message(locale, 'search.apply')}
            </button>
          </span>
        </label>
      </section>

      {status === 'loading' && <p className="commerce-state">{message(locale, 'app.loading')}</p>}
      {status === 'error' && (
        <p className="commerce-state error" role="alert">
          {message(locale, 'checkout.quoteError')}
        </p>
      )}
      {quote && selectedAddress && status === 'ready' && (
        <section className="checkout-summary">
          {quote.lines.map((line) => (
            <div key={line.sku_code}>
              <span>
                {line.sku_code} × {line.quantity}
              </span>
              <strong>{formatVnd(line.payable_vnd, locale)}</strong>
            </div>
          ))}
          <div>
            <span>{message(locale, 'checkout.discount')}</span>
            <strong>−{formatVnd(quote.discount_vnd + quote.shipping_discount_vnd, locale)}</strong>
          </div>
          <div>
            <span>{message(locale, 'checkout.shipping')}</span>
            <strong>{formatVnd(quote.shipping_fee_vnd, locale)}</strong>
          </div>
          {quote.remote_surcharge_vnd > 0 && (
            <div>
              <span>{message(locale, 'checkout.remoteSurcharge')}</span>
              <strong>{formatVnd(quote.remote_surcharge_vnd, locale)}</strong>
            </div>
          )}
          <div className="checkout-total">
            <span>{message(locale, 'checkout.total')}</span>
            <strong>{formatVnd(quote.order_payable_vnd, locale)}</strong>
          </div>
        </section>
      )}
      {orderError && (
        <p className="form-error" role="alert">
          {message(locale, 'checkout.orderError')}
        </p>
      )}
      <div className="checkout-dock">
        <strong>{formatVnd(quote?.order_payable_vnd ?? 0, locale)}</strong>
        <button
          className="button-primary"
          disabled={!quote || !selectedAddress || placing || items.length === 0}
          onClick={() => void place()}
          type="button"
        >
          {message(locale, placing ? 'checkout.placing' : 'checkout.placeOrder')}
        </button>
      </div>
    </div>
  );
}
