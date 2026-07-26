import { describe, expect, it, vi } from 'vitest';

import {
  ConfiguredShippingProviderResolver,
  ProviderIntegrationError,
  type ShippingProviderChannelConfig,
} from './index';

const channel: ShippingProviderChannelConfig = {
  id: '40000000-0000-4000-8000-000000000002',
  keyVersion: 'v1',
  originAllowlistKey: 'GHN_SANDBOX',
  providerCode: 'GHN',
  providerEnvironment: 'SANDBOX',
  shopId: '123456',
  storeId: '10000000-0000-4000-8000-000000000001',
  tokenSecretRef: 'env:GHN_BEAUTY_TOKEN',
  version: 1,
};

describe('configured shipping provider resolver', () => {
  it('keeps disabled mode closed', () => {
    const resolver = new ConfiguredShippingProviderResolver({
      mode: 'disabled',
      secretResolver: { resolve: vi.fn() },
    });
    expect(() => resolver.resolve(channel)).toThrow(ProviderIntegrationError);
  });

  it('binds and caches GHN by channel and key version', () => {
    const resolver = new ConfiguredShippingProviderResolver({
      mode: 'ghn',
      secretResolver: { resolve: vi.fn().mockResolvedValue('token-value') },
    });
    const first = resolver.resolve(channel);
    expect(resolver.resolve(channel)).toBe(first);
    expect(resolver.resolve({ ...channel, keyVersion: 'v2', version: 2 })).not.toBe(first);
  });

  it('rejects an environment/origin mismatch without resolving a secret', () => {
    const resolve = vi.fn();
    const resolver = new ConfiguredShippingProviderResolver({
      mode: 'ghn',
      secretResolver: { resolve },
    });
    expect(() => resolver.resolve({ ...channel, originAllowlistKey: 'GHN_PRODUCTION' })).toThrow(
      ProviderIntegrationError,
    );
    expect(resolve).not.toHaveBeenCalled();
  });
});
