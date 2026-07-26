import { describe, expect, it } from 'vitest';

import { EnvironmentSecretReferenceResolver } from './index';

describe('payment secret reference resolver', () => {
  it('resolves only explicitly prefixed deployment secret variables', async () => {
    const resolver = new EnvironmentSecretReferenceResolver({
      DATABASE_RUNTIME_URL: 'must-not-be-readable',
      ZALO_CHECKOUT_BEAUTY_PRIVATE_KEY: 'checkout-private-key',
    });
    await expect(resolver.resolve('env:ZALO_CHECKOUT_BEAUTY_PRIVATE_KEY')).resolves.toBe(
      'checkout-private-key',
    );
    await expect(resolver.resolve('env:DATABASE_RUNTIME_URL')).rejects.toMatchObject({
      code: 'CONFIGURATION',
    });
    await expect(resolver.resolve('vault:payment/key')).rejects.toMatchObject({
      code: 'CONFIGURATION',
    });
  });
});
