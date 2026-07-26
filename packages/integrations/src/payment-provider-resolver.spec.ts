import { describe, expect, it, vi } from 'vitest';

import {
  ConfiguredPaymentProviderResolver,
  ProviderIntegrationError,
  type PaymentProviderChannelConfig,
} from './index';

const channel: PaymentProviderChannelConfig = {
  checkoutAppId: '123456789',
  id: '40000000-0000-4000-8000-000000000001',
  keyVersion: 'v1',
  methodCode: 'ZALOPAY_SANDBOX',
  privateKeySecretRef: 'env:ZALO_CHECKOUT_BEAUTY_PRIVATE_KEY',
  providerCode: 'ZALO_CHECKOUT_ZALOPAY',
  providerEnvironment: 'SANDBOX',
  storeId: '10000000-0000-4000-8000-000000000001',
  version: 1,
};

describe('configured payment provider resolver', () => {
  it('keeps disabled mode closed and never falls back to a test provider', () => {
    const resolver = new ConfiguredPaymentProviderResolver({
      mode: 'disabled',
      nodeEnvironment: 'production',
      secretResolver: { resolve: vi.fn() },
    });
    expect(() => resolver.resolve(channel)).toThrow(ProviderIntegrationError);
    expect(
      () =>
        new ConfiguredPaymentProviderResolver({
          mode: 'test',
          nodeEnvironment: 'production',
          secretResolver: { resolve: vi.fn() },
          testSecret: 'x'.repeat(32),
        }),
    ).toThrow(ProviderIntegrationError);
  });

  it('binds and caches a real adapter by channel version and key version', () => {
    const resolver = new ConfiguredPaymentProviderResolver({
      mode: 'zalo-checkout',
      nodeEnvironment: 'production',
      secretResolver: { resolve: vi.fn().mockResolvedValue('private-key') },
    });
    const first = resolver.resolve(channel);
    expect(resolver.resolve(channel)).toBe(first);
    expect(resolver.resolve({ ...channel, keyVersion: 'v2', version: 2 })).not.toBe(first);
    expect(resolver.resolve({ ...channel, checkoutAppId: '987654321' })).not.toBe(first);
  });

  it('rejects a method/environment mismatch before resolving a secret', () => {
    const resolve = vi.fn();
    const resolver = new ConfiguredPaymentProviderResolver({
      mode: 'zalo-checkout',
      nodeEnvironment: 'development',
      secretResolver: { resolve },
    });
    expect(() => resolver.resolve({ ...channel, methodCode: 'ZALOPAY' })).toThrow(
      ProviderIntegrationError,
    );
    expect(resolve).not.toHaveBeenCalled();
  });
});
