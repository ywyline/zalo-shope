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
import { isZaloHostRuntime, localTestBridge } from './zalo-test-bridge';

type SessionStatus = 'error' | 'loading' | 'ready';

type MemberSession = {
  accessToken?: string;
  connect(): Promise<boolean>;
  failureCode?: ZaloSessionFailureCode;
  invalidate(): void;
  status: SessionStatus;
  zaloAccessToken?: string;
};

const SessionContext = createContext<MemberSession | undefined>(undefined);

async function getZaloAccessToken(): Promise<unknown> {
  const bridge = localTestBridge();
  if (bridge) return bridge.getAccessToken();
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
        runtimeAvailable: isZaloHostRuntime(),
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
