import React, { useState } from 'react';
import { formatVnd, translate, type MessageKey } from '@zalo-shop/i18n';
import { Link } from 'react-router-dom';

import { CartRequestError, type CartItem } from './cart-api';
import type { Locale } from './catalog-api';
import { useCart } from './cart-state';
import { useMemberSession } from './member-session';

function message(locale: Locale, key: MessageKey): string {
  return translate(locale, key);
}

function issueLabel(locale: Locale, code: CartItem['issues'][number]['code']): string {
  const key = `cart.issue.${code.toLowerCase()}` as MessageKey;
  return message(locale, key);
}

function CartMedia({ item, productName }: { item: CartItem; productName: string }): JSX.Element {
  const [failed, setFailed] = useState(false);
  const media = item.sku?.media ?? item.product?.primary_media;
  if (!media || failed) {
    return (
      <div className="cart-line-image media-placeholder" role="img" aria-label={productName}>
        <span aria-hidden="true">✦</span>
      </div>
    );
  }
  return (
    <img
      alt={media.alt_text}
      className="cart-line-image"
      decoding="async"
      loading="lazy"
      onError={() => setFailed(true)}
      src={media.url}
    />
  );
}

function CartErrorPanel({ locale, onRetry }: { locale: Locale; onRetry: () => void }): JSX.Element {
  return (
    <div className="catalog-state error" role="alert">
      <span className="state-glyph" aria-hidden="true">
        ↻
      </span>
      <strong>{message(locale, 'cart.error')}</strong>
      <button className="button-quiet" onClick={onRetry} type="button">
        {message(locale, 'cart.retry')}
      </button>
    </div>
  );
}

function SignInPanel({ locale }: { locale: Locale }): JSX.Element {
  const session = useMemberSession();
  const [connecting, setConnecting] = useState(false);
  const [failed, setFailed] = useState(false);
  const connect = async (): Promise<void> => {
    setConnecting(true);
    setFailed(false);
    try {
      if (!(await session.connect())) setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setConnecting(false);
    }
  };
  return (
    <div className="cart-auth-panel" role="status">
      <span className="state-glyph" aria-hidden="true">
        ◇
      </span>
      <h1>{message(locale, 'cart.signInTitle')}</h1>
      <p>{message(locale, failed ? 'cart.signInFailed' : 'cart.signInHint')}</p>
      <button
        className="button-primary"
        disabled={connecting}
        onClick={() => void connect()}
        type="button"
      >
        {connecting ? message(locale, 'cart.signingIn') : message(locale, 'cart.signIn')}
      </button>
    </div>
  );
}

function ItemIssues({ item, locale }: { item: CartItem; locale: Locale }): JSX.Element | null {
  if (item.issues.length === 0) return null;
  return (
    <ul className="cart-issues" aria-label={message(locale, 'cart.itemIssues')}>
      {item.issues.map((issue) => (
        <li className={issue.blocking ? 'blocking' : 'notice'} key={issue.code}>
          {issueLabel(locale, issue.code)}
        </li>
      ))}
    </ul>
  );
}

function CartLine({ item, locale }: { item: CartItem; locale: Locale }): JSX.Element {
  const cart = useCart();
  const removeItem = (itemId: string, expectedVersion: number): Promise<void> =>
    cart.removeItem(itemId, expectedVersion);
  const updateItem = (
    itemId: string,
    input: Parameters<typeof cart.updateItem>[1],
  ): Promise<Awaited<ReturnType<typeof cart.updateItem>>> => cart.updateItem(itemId, input);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<'conflict' | 'generic' | false>(false);
  const productName = item.product?.name ?? item.sku_code;
  const optionLabels = (item.sku?.option_values ?? [])
    .map(({ option_label }) => option_label)
    .filter(Boolean)
    .join(' · ');
  const availableSkus = item.product?.available_skus ?? [];
  const replacementSkus = availableSkus.some(({ code }) => code === item.sku_code)
    ? availableSkus
    : [
        {
          code: item.sku_code,
          option_values: item.sku?.option_values ?? [],
        },
        ...availableSkus,
      ];
  const hasReplacement = replacementSkus.some(({ code }) => code !== item.sku_code);
  const unavailable = item.issues.some((issue) => issue.blocking);

  const run = async (operation: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(false);
    try {
      await operation();
    } catch (caught: unknown) {
      setError(
        caught instanceof CartRequestError && caught.status === 409 ? 'conflict' : 'generic',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className={`cart-line${unavailable ? ' has-blocking-issue' : ''}`}>
      <label className="cart-line-check">
        <input
          aria-label={`${message(locale, 'cart.select')} ${productName}`}
          checked={item.selected}
          disabled={busy}
          onChange={(event) =>
            void run(() =>
              updateItem(item.id, {
                expected_version: item.version,
                selected: event.target.checked,
              }),
            )
          }
          type="checkbox"
        />
      </label>
      <CartMedia item={item} productName={productName} />
      <div className="cart-line-copy">
        {item.product?.code ? (
          <Link
            className="cart-line-name"
            to={`/products/${encodeURIComponent(item.product.code)}`}
          >
            {productName}
          </Link>
        ) : (
          <strong className="cart-line-name">{productName}</strong>
        )}
        <small>{optionLabels || item.sku_code}</small>
        {hasReplacement && (
          <label className="cart-sku-select">
            <span className="sr-only">{message(locale, 'cart.replaceSku')}</span>
            <select
              aria-label={message(locale, 'cart.replaceSku')}
              disabled={busy}
              onChange={(event) =>
                void run(() =>
                  updateItem(item.id, {
                    expected_version: item.version,
                    replacement_sku_code: event.target.value,
                  }),
                )
              }
              value={item.sku_code}
            >
              {replacementSkus.map((sku) => (
                <option key={sku.code} value={sku.code}>
                  {sku.option_values.map(({ option_label }) => option_label).join(' · ') ||
                    sku.code}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="cart-line-prices">
          <strong>{formatVnd(item.current_unit_price_vnd, locale)}</strong>
          {item.added_unit_price_vnd !== item.current_unit_price_vnd && (
            <del>{formatVnd(item.added_unit_price_vnd, locale)}</del>
          )}
        </div>
        <ItemIssues item={item} locale={locale} />
        {error && (
          <small aria-live="polite" className="cart-conflict" role="alert">
            {message(locale, error === 'conflict' ? 'cart.conflict' : 'cart.updateError')}
          </small>
        )}
      </div>
      <div className="cart-line-actions">
        <div className="quantity-control" aria-label={message(locale, 'cart.quantity')}>
          <button
            aria-label={message(locale, 'cart.decrease')}
            disabled={busy || item.quantity <= 1}
            onClick={() =>
              void run(() =>
                updateItem(item.id, {
                  expected_version: item.version,
                  quantity: item.quantity - 1,
                }),
              )
            }
            type="button"
          >
            −
          </button>
          <span aria-live="polite">{item.quantity}</span>
          <button
            aria-label={message(locale, 'cart.increase')}
            disabled={busy || item.quantity >= 99 || item.quantity >= item.available_quantity}
            onClick={() =>
              void run(() =>
                updateItem(item.id, {
                  expected_version: item.version,
                  quantity: item.quantity + 1,
                }),
              )
            }
            type="button"
          >
            +
          </button>
        </div>
        <button
          className="cart-remove"
          disabled={busy}
          onClick={() => void run(() => removeItem(item.id, item.version))}
          type="button"
        >
          {message(locale, 'cart.remove')}
        </button>
      </div>
      <strong className="cart-line-subtotal">{formatVnd(item.current_subtotal_vnd, locale)}</strong>
    </article>
  );
}

export function CartView({ locale }: { locale: Locale }): JSX.Element {
  const session = useMemberSession();
  const cartState = useCart();
  if (session.status === 'loading') {
    return (
      <div className="page-view">
        <header className="page-intro">
          <p className="section-kicker">{message(locale, 'catalog.cart')}</p>
          <h1>{message(locale, 'catalog.cart')}</h1>
        </header>
        <div className="catalog-state loading" role="status">
          <span className="spinner" aria-hidden="true" />
          <strong>{message(locale, 'cart.signingIn')}</strong>
        </div>
      </div>
    );
  }
  if (session.status !== 'ready' || cartState.status === 'signed_out') {
    return (
      <div className="page-view">
        <header className="page-intro">
          <p className="section-kicker">{message(locale, 'catalog.cart')}</p>
          <h1>{message(locale, 'catalog.cart')}</h1>
        </header>
        <SignInPanel locale={locale} />
      </div>
    );
  }
  if (cartState.status === 'loading' && !cartState.cart) {
    return (
      <div className="page-view">
        <header className="page-intro">
          <p className="section-kicker">{message(locale, 'catalog.cart')}</p>
          <h1>{message(locale, 'catalog.cart')}</h1>
        </header>
        <div className="catalog-state loading" role="status">
          <span className="spinner" aria-hidden="true" />
          <strong>{message(locale, 'cart.loading')}</strong>
        </div>
      </div>
    );
  }
  if (cartState.status === 'error' && !cartState.cart) {
    return (
      <div className="page-view">
        <header className="page-intro">
          <p className="section-kicker">{message(locale, 'catalog.cart')}</p>
          <h1>{message(locale, 'catalog.cart')}</h1>
        </header>
        <CartErrorPanel locale={locale} onRetry={() => void cartState.refresh()} />
      </div>
    );
  }
  const cart = cartState.cart;
  if (!cart || cart.items.length === 0) {
    return (
      <div className="page-view">
        <header className="page-intro">
          <p className="section-kicker">{message(locale, 'catalog.cart')}</p>
          <h1>{message(locale, 'catalog.cart')}</h1>
        </header>
        <div className="catalog-state" role="status">
          <span className="state-glyph" aria-hidden="true">
            ◇
          </span>
          <strong>{message(locale, 'cart.empty')}</strong>
          <Link className="button-primary" to="/products">
            {message(locale, 'catalog.explore')}
          </Link>
        </div>
      </div>
    );
  }
  return (
    <div className="page-view cart-page">
      <header className="page-intro">
        <p className="section-kicker">{message(locale, 'catalog.cart')}</p>
        <h1>{message(locale, 'catalog.cart')}</h1>
        <p>{message(locale, 'cart.recalculated')}</p>
      </header>
      {cartState.error && (
        <div className="cart-recovery-banner" role="alert">
          <span>{message(locale, 'cart.updateError')}</span>
          <button className="button-quiet" onClick={() => void cartState.refresh()} type="button">
            {message(locale, 'cart.retry')}
          </button>
        </div>
      )}
      {cart.blocking && (
        <div className="cart-blocking-banner" role="alert">
          {message(locale, 'cart.blocking')}
        </div>
      )}
      <section className="cart-lines" aria-label={message(locale, 'catalog.cart')}>
        {cart.items.map((item) => (
          <CartLine item={item} key={item.id} locale={locale} />
        ))}
      </section>
      <section className="cart-summary" aria-label={message(locale, 'cart.summary')}>
        <div>
          <span>{message(locale, 'cart.subtotal')}</span>
          <strong>{formatVnd(cart.quote?.base_subtotal_vnd ?? 0, locale)}</strong>
        </div>
        <div>
          <span>{message(locale, 'cart.discount')}</span>
          <strong>−{formatVnd(cart.quote?.discount_vnd ?? 0, locale)}</strong>
        </div>
        <div className="cart-total">
          <span>{message(locale, 'cart.merchandiseTotal')}</span>
          <strong>{formatVnd(cart.quote?.merchandise_payable_vnd ?? 0, locale)}</strong>
        </div>
        <p>{message(locale, 'cart.checkoutNext')}</p>
        <button className="button-primary" disabled type="button">
          {message(locale, 'cart.checkoutUnavailable')}
        </button>
      </section>
    </div>
  );
}

export function cartQuantity(cart: { items: CartItem[] } | undefined): number {
  return cart?.items.reduce((total, item) => total + item.quantity, 0) ?? 0;
}
