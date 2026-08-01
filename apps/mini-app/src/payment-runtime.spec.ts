import { describe, expect, it, vi } from 'vitest';

import { CheckoutRuntimeError, runCheckoutFlow, type CheckoutRuntimePort } from './payment-runtime';
import type { PaymentLaunch } from './commerce-api';

function launch(overrides: Partial<PaymentLaunch> = {}): PaymentLaunch {
  return {
    expires_at: '2026-08-01T12:10:00.000Z',
    kind: 'ZALO_CHECKOUT_CREATE_ORDER',
    launch_token: 'x'.repeat(32),
    payment_id: '00000000-0000-4000-8000-000000000001',
    payload: {
      amount: 120_000,
      desc: 'Order payment',
      extradata: 'x'.repeat(32),
      item: [{ amount: 120_000, id: 'sku-1' }],
      mac: 'signed-mac',
      method: 'ZALOPAY_SANDBOX',
    },
    ...overrides,
  };
}

function runtime() {
  let listener: ((data: unknown) => void) | undefined;
  const port: CheckoutRuntimePort = {
    checkTransaction: vi.fn().mockResolvedValue({ resultCode: 1 }),
    createOrder: vi.fn().mockResolvedValue({ orderId: 'checkout-order-1' }),
    offPaymentDone: vi.fn((candidate) => {
      if (listener === candidate) listener = undefined;
    }),
    onPaymentDone: vi.fn((candidate) => {
      listener = candidate;
    }),
  };
  return { emitPaymentDone: () => listener?.({}), port };
}

describe('runCheckoutFlow', () => {
  it('subscribes before launch, binds the provider order and never infers success from PaymentDone', async () => {
    const sdk = runtime();
    const order: string[] = [];
    vi.mocked(sdk.port.onPaymentDone).mockImplementation((listener) => {
      order.push('listen');
      queueMicrotask(() => listener({ completedOrCancelled: true }));
    });
    vi.mocked(sdk.port.createOrder).mockImplementation(() => {
      order.push('launch');
      return Promise.resolve({ orderId: 'checkout-order-1' });
    });
    const bind = vi.fn(() => {
      order.push('bind');
      return Promise.resolve();
    });

    await expect(
      runCheckoutFlow({
        launch: launch(),
        now: Date.parse('2026-08-01T12:00:00.000Z'),
        onProviderOrder: bind,
        runtime: sdk.port,
        timeoutMs: 100,
      }),
    ).resolves.toEqual({
      completion: 'PAYMENT_DONE',
      providerOrderId: 'checkout-order-1',
      transactionCheck: 'CHECKED',
    });
    expect(order).toEqual(['listen', 'launch', 'bind']);
    expect(bind).toHaveBeenCalledWith('checkout-order-1');
    expect(sdk.port.checkTransaction).toHaveBeenCalledWith({ orderId: 'checkout-order-1' });
    expect(sdk.port.offPaymentDone).toHaveBeenCalledOnce();
  });

  it('keeps the flow recoverable when advisory checkTransaction fails', async () => {
    const sdk = runtime();
    vi.mocked(sdk.port.onPaymentDone).mockImplementation((listener) =>
      queueMicrotask(() => listener({ completedOrCancelled: true })),
    );
    vi.mocked(sdk.port.checkTransaction).mockRejectedValue(new Error('untrusted SDK detail'));

    await expect(
      runCheckoutFlow({
        launch: launch(),
        now: Date.parse('2026-08-01T12:00:00.000Z'),
        onProviderOrder: () => Promise.resolve(),
        runtime: sdk.port,
        timeoutMs: 100,
      }),
    ).resolves.toMatchObject({ completion: 'PAYMENT_DONE', transactionCheck: 'UNAVAILABLE' });
  });

  it('accepts a zero-payable merchandise line when the server-owned order total is positive', async () => {
    const sdk = runtime();
    vi.mocked(sdk.port.onPaymentDone).mockImplementation((listener) =>
      queueMicrotask(() => listener({ completedOrCancelled: true })),
    );
    const zeroLine = launch();
    zeroLine.payload.item[0]!.amount = 0;

    await expect(
      runCheckoutFlow({
        launch: zeroLine,
        now: Date.parse('2026-08-01T12:00:00.000Z'),
        onProviderOrder: () => Promise.resolve(),
        runtime: sdk.port,
        timeoutMs: 100,
      }),
    ).resolves.toMatchObject({ completion: 'PAYMENT_DONE' });
  });

  it('returns an uncertain timeout after binding instead of reporting payment failure', async () => {
    vi.useFakeTimers();
    const sdk = runtime();
    const flow = runCheckoutFlow({
      launch: launch(),
      now: Date.parse('2026-08-01T12:00:00.000Z'),
      onProviderOrder: () => Promise.resolve(),
      runtime: sdk.port,
      timeoutMs: 25,
    });
    await vi.advanceTimersByTimeAsync(25);
    await expect(flow).resolves.toMatchObject({
      completion: 'TIMED_OUT',
      transactionCheck: 'UNAVAILABLE',
    });
    expect(sdk.port.checkTransaction).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('rejects expired, mismatched and empty provider-order payloads without binding', async () => {
    const sdk = runtime();
    const bind = vi.fn();
    await expect(
      runCheckoutFlow({
        launch: launch(),
        now: Date.parse('2026-08-01T12:10:00.000Z'),
        onProviderOrder: bind,
        runtime: sdk.port,
      }),
    ).rejects.toMatchObject({ code: 'CHECKOUT_LAUNCH_INVALID' });
    await expect(
      runCheckoutFlow({
        launch: launch({ launch_token: 'y'.repeat(32) }),
        now: Date.parse('2026-08-01T12:00:00.000Z'),
        onProviderOrder: bind,
        runtime: sdk.port,
      }),
    ).rejects.toMatchObject({ code: 'CHECKOUT_LAUNCH_INVALID' });
    vi.mocked(sdk.port.createOrder).mockResolvedValue({ orderId: ' ' });
    await expect(
      runCheckoutFlow({
        launch: launch(),
        now: Date.parse('2026-08-01T12:00:00.000Z'),
        onProviderOrder: bind,
        runtime: sdk.port,
      }),
    ).rejects.toMatchObject({ code: 'CHECKOUT_PROVIDER_ORDER_INVALID' });
    expect(bind).not.toHaveBeenCalled();
  });

  it('aborts and removes the exact registered listener', async () => {
    const sdk = runtime();
    const controller = new AbortController();
    const flow = runCheckoutFlow({
      launch: launch(),
      now: Date.parse('2026-08-01T12:00:00.000Z'),
      onProviderOrder: () => Promise.resolve(),
      runtime: sdk.port,
      signal: controller.signal,
      timeoutMs: 1_000,
    });
    await Promise.resolve();
    controller.abort();
    await expect(flow).rejects.toEqual(new CheckoutRuntimeError('CHECKOUT_ABORTED'));
    expect(sdk.port.offPaymentDone).toHaveBeenCalledWith(
      vi.mocked(sdk.port.onPaymentDone).mock.calls[0]![0],
    );
  });
});
