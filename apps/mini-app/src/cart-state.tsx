import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  CartRequestError,
  deleteCartItem,
  getCart,
  setCartItem,
  updateCartItem,
  type Cart,
  type SetCartItemInput,
  type UpdateCartItemInput,
} from './cart-api';
import type { Locale } from './catalog-api';
import { useMemberSession } from './member-session';

export type CartStatus = 'error' | 'loading' | 'ready' | 'signed_out';

type CartState = {
  cart?: Cart;
  error?: CartRequestError;
  refresh(): Promise<boolean>;
  removeItem(itemId: string, expectedVersion: number): Promise<void>;
  setItem(skuCode: string, input: SetCartItemInput): Promise<Cart>;
  status: CartStatus;
  updateItem(itemId: string, input: UpdateCartItemInput): Promise<Cart>;
};

const CartContext = createContext<CartState | undefined>(undefined);

export function CartProvider({
  children,
  locale,
}: {
  children: React.ReactNode;
  locale: Locale;
}): JSX.Element {
  const session = useMemberSession();
  const [cart, setCart] = useState<Cart>();
  const [status, setStatus] = useState<CartStatus>('loading');
  const [error, setError] = useState<CartRequestError>();
  const requestGeneration = useRef(0);
  const activeLocale = useRef(locale);
  activeLocale.current = locale;

  const commitCart = useCallback((next: Cart, responseLocale: Locale): void => {
    if (responseLocale !== activeLocale.current) return;
    setCart((current) => (current && current.version > next.version ? current : next));
  }, []);

  const refresh = useCallback(async (): Promise<boolean> => {
    const token = session.accessToken;
    if (!token || session.status !== 'ready') {
      setCart(undefined);
      setError(undefined);
      setStatus(session.status === 'error' ? 'signed_out' : 'loading');
      return false;
    }
    const generation = ++requestGeneration.current;
    setStatus('loading');
    setError(undefined);
    try {
      const next = await getCart(token, locale);
      if (generation !== requestGeneration.current) return false;
      commitCart(next, locale);
      setStatus('ready');
      return true;
    } catch (caught: unknown) {
      if (generation !== requestGeneration.current) return false;
      const nextError =
        caught instanceof CartRequestError ? caught : new CartRequestError(0, undefined);
      setError(nextError);
      setStatus(nextError.status === 401 ? 'signed_out' : 'error');
      if (nextError.status === 401) session.invalidate();
      return false;
    }
  }, [commitCart, locale, session]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setItem = useCallback(
    async (skuCode: string, input: SetCartItemInput): Promise<Cart> => {
      if (!session.accessToken || session.status !== 'ready') {
        throw new CartRequestError(401, 'AUTHENTICATION_REQUIRED');
      }
      try {
        const next = await setCartItem(session.accessToken, locale, skuCode, input);
        commitCart(next, locale);
        setStatus('ready');
        setError(undefined);
        return next;
      } catch (caught: unknown) {
        const nextError =
          caught instanceof CartRequestError ? caught : new CartRequestError(0, undefined);
        setError(nextError);
        if (nextError.status === 401) {
          setStatus('signed_out');
          session.invalidate();
        } else {
          setStatus((current) => (current === 'loading' ? 'error' : current));
        }
        throw nextError;
      }
    },
    [commitCart, locale, session],
  );

  const updateItem = useCallback(
    async (itemId: string, input: UpdateCartItemInput): Promise<Cart> => {
      if (!session.accessToken || session.status !== 'ready') {
        throw new CartRequestError(401, 'AUTHENTICATION_REQUIRED');
      }
      try {
        const next = await updateCartItem(session.accessToken, locale, itemId, input);
        commitCart(next, locale);
        setStatus('ready');
        setError(undefined);
        return next;
      } catch (caught: unknown) {
        const nextError =
          caught instanceof CartRequestError ? caught : new CartRequestError(0, undefined);
        if (nextError.status === 409) await refresh();
        else {
          setError(nextError);
          if (nextError.status === 401) {
            setStatus('signed_out');
            session.invalidate();
          } else {
            setStatus((current) => (current === 'loading' ? 'error' : current));
          }
        }
        throw nextError;
      }
    },
    [commitCart, locale, refresh, session],
  );

  const removeItem = useCallback(
    async (itemId: string, expectedVersion: number): Promise<void> => {
      if (!session.accessToken || session.status !== 'ready') {
        throw new CartRequestError(401, 'AUTHENTICATION_REQUIRED');
      }
      try {
        await deleteCartItem(session.accessToken, locale, itemId, expectedVersion);
        if (!(await refresh())) throw new CartRequestError(0, 'REFRESH_FAILED');
      } catch (caught: unknown) {
        const nextError =
          caught instanceof CartRequestError ? caught : new CartRequestError(0, undefined);
        if (nextError.status === 409) await refresh();
        else {
          setError(nextError);
          if (nextError.status === 401) {
            setStatus('signed_out');
            session.invalidate();
          } else {
            setStatus((current) => (current === 'loading' ? 'error' : current));
          }
        }
        throw nextError;
      }
    },
    [locale, refresh, session],
  );

  const value = useMemo<CartState>(
    () => ({ cart, error, refresh, removeItem, setItem, status, updateItem }),
    [cart, error, refresh, removeItem, setItem, status, updateItem],
  );
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartState {
  const value = useContext(CartContext);
  if (!value) throw new Error('CartProvider is required');
  return value;
}
