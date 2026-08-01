import type { PaymentLaunch } from './commerce-api';
import { isZaloHostRuntime, localTestBridge } from './zalo-test-bridge';

export type CheckoutRuntimeFailureCode =
  | 'CHECKOUT_ABORTED'
  | 'CHECKOUT_LAUNCH_INVALID'
  | 'CHECKOUT_LAUNCH_REJECTED'
  | 'CHECKOUT_PROVIDER_ORDER_INVALID'
  | 'CHECKOUT_RUNTIME_UNAVAILABLE';

export class CheckoutRuntimeError extends Error {
  public constructor(public readonly code: CheckoutRuntimeFailureCode) {
    super(code);
    this.name = 'CheckoutRuntimeError';
  }
}

export type CheckoutPayload = Readonly<{
  amount: number;
  desc: string;
  extradata: string;
  item: readonly Readonly<{ amount: number; id: string }>[];
  mac: string;
  method: string;
}>;

export type CheckoutRuntimePort = Readonly<{
  checkTransaction(data: Readonly<{ orderId: string }>): Promise<unknown>;
  createOrder(payload: CheckoutPayload): Promise<Readonly<{ orderId: string }>>;
  offPaymentDone(listener: (data: unknown) => void): void;
  onPaymentDone(listener: (data: unknown) => void): void;
}>;

export type CheckoutFlowResult = Readonly<{
  completion: 'PAYMENT_DONE' | 'TIMED_OUT';
  providerOrderId: string;
  transactionCheck: 'CHECKED' | 'UNAVAILABLE';
}>;

function validPayload(
  launch: PaymentLaunch,
  now: number,
): launch is PaymentLaunch & {
  payload: CheckoutPayload;
} {
  const payload = launch.payload;
  return (
    launch.kind === 'ZALO_CHECKOUT_CREATE_ORDER' &&
    Date.parse(launch.expires_at) > now &&
    Number.isSafeInteger(payload.amount) &&
    payload.amount > 0 &&
    typeof payload.desc === 'string' &&
    payload.desc.length > 0 &&
    typeof payload.extradata === 'string' &&
    payload.extradata === launch.launch_token &&
    payload.extradata.length >= 32 &&
    Array.isArray(payload.item) &&
    payload.item.length > 0 &&
    payload.item.every(
      (item) =>
        Number.isSafeInteger(item.amount) &&
        item.amount >= 0 &&
        typeof item.id === 'string' &&
        item.id.length > 0,
    ) &&
    typeof payload.mac === 'string' &&
    payload.mac.length > 0 &&
    typeof payload.method === 'string' &&
    payload.method.length > 0
  );
}

function abortError(): CheckoutRuntimeError {
  return new CheckoutRuntimeError('CHECKOUT_ABORTED');
}

export async function runCheckoutFlow(
  input: Readonly<{
    launch: PaymentLaunch;
    now?: number;
    onProviderOrder(providerOrderId: string): Promise<void>;
    runtime: CheckoutRuntimePort;
    signal?: AbortSignal;
    timeoutMs?: number;
  }>,
): Promise<CheckoutFlowResult> {
  if (!validPayload(input.launch, input.now ?? Date.now())) {
    throw new CheckoutRuntimeError('CHECKOUT_LAUNCH_INVALID');
  }
  if (input.signal?.aborted) throw abortError();

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  let settled = false;
  let settleDone: (() => void) | undefined;
  const paymentDone = new Promise<'ABORTED' | 'PAYMENT_DONE' | 'TIMED_OUT'>((resolve) => {
    const finish = (result: 'ABORTED' | 'PAYMENT_DONE' | 'TIMED_OUT'): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    settleDone = () => finish('PAYMENT_DONE');
    timeout = setTimeout(() => finish('TIMED_OUT'), input.timeoutMs ?? 5 * 60_000);
    abortListener = () => finish('ABORTED');
    input.signal?.addEventListener('abort', abortListener, { once: true });
  });
  const paymentDoneListener = (): void => settleDone?.();
  input.runtime.onPaymentDone(paymentDoneListener);

  try {
    let created: Readonly<{ orderId: string }>;
    try {
      created = await input.runtime.createOrder(input.launch.payload);
    } catch {
      throw new CheckoutRuntimeError('CHECKOUT_LAUNCH_REJECTED');
    }
    const providerOrderId = created.orderId?.trim();
    if (!providerOrderId || providerOrderId.length > 160) {
      throw new CheckoutRuntimeError('CHECKOUT_PROVIDER_ORDER_INVALID');
    }
    await input.onProviderOrder(providerOrderId);
    const completion = await paymentDone;
    if (completion === 'ABORTED') throw abortError();
    let transactionCheck: CheckoutFlowResult['transactionCheck'] = 'UNAVAILABLE';
    if (completion === 'PAYMENT_DONE') {
      try {
        await input.runtime.checkTransaction({ orderId: providerOrderId });
        transactionCheck = 'CHECKED';
      } catch {
        // checkTransaction is advisory; server query/callback facts remain authoritative.
      }
    }
    return { completion, providerOrderId, transactionCheck };
  } finally {
    if (timeout) clearTimeout(timeout);
    if (abortListener) input.signal?.removeEventListener('abort', abortListener);
    input.runtime.offPaymentDone(paymentDoneListener);
  }
}

export async function loadCheckoutRuntime(): Promise<CheckoutRuntimePort> {
  const bridge = localTestBridge();
  if (bridge) {
    if (
      !bridge.checkoutCheckTransaction ||
      !bridge.checkoutCreateOrder ||
      !bridge.checkoutOffPaymentDone ||
      !bridge.checkoutOnPaymentDone
    ) {
      throw new CheckoutRuntimeError('CHECKOUT_RUNTIME_UNAVAILABLE');
    }
    return {
      checkTransaction: (data) => Promise.resolve(bridge.checkoutCheckTransaction!(data)),
      createOrder: (payload) => bridge.checkoutCreateOrder!(payload),
      offPaymentDone: (listener) => bridge.checkoutOffPaymentDone!(listener),
      onPaymentDone: (listener) => bridge.checkoutOnPaymentDone!(listener),
    };
  }
  if (!isZaloHostRuntime()) {
    throw new CheckoutRuntimeError('CHECKOUT_RUNTIME_UNAVAILABLE');
  }
  const sdk = await import('zmp-sdk');
  return {
    checkTransaction: (data) => sdk.CheckoutSDK.checkTransaction({ data }),
    createOrder: (payload) => sdk.CheckoutSDK.createOrder({ ...payload, item: [...payload.item] }),
    offPaymentDone: (listener) => sdk.events.off(sdk.Events.PaymentDone, listener),
    onPaymentDone: (listener) => sdk.events.on(sdk.Events.PaymentDone, listener),
  };
}
