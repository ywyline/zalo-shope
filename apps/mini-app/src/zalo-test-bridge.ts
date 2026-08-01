export type CheckoutBridgeResult = Readonly<{
  messageToken?: string;
  orderId: string;
  transId?: string;
}>;

export type ZaloShopE2eBridge = Readonly<{
  checkoutCheckTransaction?(data: Readonly<{ orderId: string }>): unknown;
  checkoutCreateOrder?(payload: Readonly<Record<string, unknown>>): Promise<CheckoutBridgeResult>;
  checkoutOffPaymentDone?(listener: (data: unknown) => void): void;
  checkoutOnPaymentDone?(listener: (data: unknown) => void): void;
  getAccessToken(): Promise<string> | string;
}>;

declare global {
  interface Window {
    __ZALO_SHOP_E2E_BRIDGE__?: ZaloShopE2eBridge;
  }
}

const runtimeEnvironment = import.meta.env as unknown as Record<string, string | undefined>;

export function localTestBridge(): ZaloShopE2eBridge | undefined {
  const hostname = window.location.hostname.toLowerCase();
  if (
    runtimeEnvironment.VITE_ZALO_TEST_BRIDGE !== 'true' ||
    (hostname !== 'localhost' && hostname !== '127.0.0.1')
  ) {
    return undefined;
  }
  return window.__ZALO_SHOP_E2E_BRIDGE__;
}

export function isZaloHostRuntime(): boolean {
  if (localTestBridge()) return true;
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
