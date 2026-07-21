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

type SessionStatus = 'error' | 'loading' | 'ready';

type MemberSession = {
  accessToken?: string;
  connect(): Promise<boolean>;
  invalidate(): void;
  status: SessionStatus;
  zaloAccessToken?: string;
};

const SessionContext = createContext<MemberSession | undefined>(undefined);

function isZaloRuntime(): boolean {
  const hostname = window.location.hostname.toLowerCase();
  return (
    /zalo/i.test(window.navigator.userAgent) ||
    'zmpGlobal' in window ||
    hostname === 'zalo.me' ||
    hostname.endsWith('.zalo.me') ||
    hostname === 'zdn.vn' ||
    hostname.endsWith('.zdn.vn')
  );
}

export function MemberSessionProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const started = useRef(false);
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [accessToken, setAccessToken] = useState<string>();
  const [zaloAccessToken, setZaloAccessToken] = useState<string>();

  const invalidate = useCallback((): void => {
    setAccessToken(undefined);
    setZaloAccessToken(undefined);
    setStatus('error');
  }, []);

  const connect = useCallback(async (): Promise<boolean> => {
    setStatus('loading');
    try {
      if (!isZaloRuntime()) throw new Error('Zalo runtime is unavailable');
      const { getAccessToken } = await import('zmp-sdk');
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
      setZaloAccessToken(token);
      setStatus('ready');
      return true;
    } catch {
      setAccessToken(undefined);
      setZaloAccessToken(undefined);
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
    () => ({ accessToken, connect, invalidate, status, zaloAccessToken }),
    [accessToken, connect, invalidate, status, zaloAccessToken],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useMemberSession(): MemberSession {
  const session = useContext(SessionContext);
  if (!session) throw new Error('MemberSessionProvider is required');
  return session;
}
