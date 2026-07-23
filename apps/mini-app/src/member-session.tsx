import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { API_BASE, STORE_CODE } from './catalog-api';
import {
  establishZaloSession,
  ZaloSessionError,
  type ZaloSessionFailureCode,
} from './zalo-session-client';

type SessionStatus = 'error' | 'loading' | 'ready';

const runtimeEnvironment = import.meta.env as unknown as Record<string, string | undefined>;
const testBridgeEnabled = runtimeEnvironment.VITE_ZALO_TEST_BRIDGE === 'true';

type ZaloShopE2eBridge = { getAccessToken(): Promise<string> | string };

declare global {
  interface Window {
    __ZALO_SHOP_E2E_BRIDGE__?: ZaloShopE2eBridge;
  }
}

type MemberSession = {
  accessToken?: string;
  connect(): Promise<boolean>;
  failureCode?: ZaloSessionFailureCode;
  invalidate(): void;
  status: SessionStatus;
  zaloAccessToken?: string;
};

const SessionContext = createContext<MemberSession | undefined>(undefined);

function isZaloRuntime(): boolean {
  const hostname = window.location.hostname.toLowerCase();
  if (
    testBridgeEnabled &&
    (hostname === 'localhost' || hostname === '127.0.0.1') &&
    window.__ZALO_SHOP_E2E_BRIDGE__
  ) {
    return true;
  }
  return (
    /zalo/i.test(window.navigator.userAgent) ||
    'zmpGlobal' in window ||
    hostname === 'zalo.me' ||
    hostname.endsWith('.zalo.me') ||
    hostname === 'zdn.vn' ||
    hostname.endsWith('.zdn.vn')
  );
}

async function getZaloAccessToken(): Promise<unknown> {
  const hostname = window.location.hostname.toLowerCase();
  if (testBridgeEnabled && (hostname === 'localhost' || hostname === '127.0.0.1')) {
    const bridge = window.__ZALO_SHOP_E2E_BRIDGE__;
    if (!bridge) throw new Error('The test Zalo bridge is unavailable');
    return bridge.getAccessToken();
  }
  const { getAccessToken } = await import('zmp-sdk');
  return getAccessToken();
}

export function MemberSessionProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const started = useRef(false);
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [accessToken, setAccessToken] = useState<string>();
  const [zaloAccessToken, setZaloAccessToken] = useState<string>();
  const [failureCode, setFailureCode] = useState<ZaloSessionFailureCode>();

  const invalidate = useCallback((): void => {
    setAccessToken(undefined);
    setZaloAccessToken(undefined);
    setFailureCode(undefined);
    setStatus('error');
  }, []);

  const connect = useCallback(async (): Promise<boolean> => {
    setStatus('loading');
    setFailureCode(undefined);
    try {
      const session = await establishZaloSession({
        apiBase: API_BASE,
        fetcher: (input, init) => fetch(input, init),
        getAccessToken: getZaloAccessToken,
        runtimeAvailable: isZaloRuntime(),
        storeCode: STORE_CODE,
      });
      setAccessToken(session.accessToken);
      setZaloAccessToken(session.zaloAccessToken);
      setStatus('ready');
      return true;
    } catch (error) {
      setAccessToken(undefined);
      setZaloAccessToken(undefined);
      setFailureCode(error instanceof ZaloSessionError ? error.code : 'ZALO_TOKEN_REJECTED');
      setStatus('error');
      return false;
    }
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void connect();
  }, [connect]);

  const value = useMemo(
    () => ({ accessToken, connect, failureCode, invalidate, status, zaloAccessToken }),
    [accessToken, connect, failureCode, invalidate, status, zaloAccessToken],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useMemberSession(): MemberSession {
  const session = useContext(SessionContext);
  if (!session) throw new Error('MemberSessionProvider is required');
  return session;
}
