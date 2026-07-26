import { describe, expect, it } from 'vitest';

import { DeterministicPaymentTestProvider, ProviderIntegrationError } from './index';

const baseInput = {
  amountVnd: 120_000,
  attemptId: '31000000-0000-4000-8000-000000000001',
  currency: 'VND' as const,
  description: 'Thanh toan ZS-1',
  expiresAt: new Date(Date.now() + 300_000),
  items: [{ amountVnd: 120_000, name: 'Serum', quantity: 1, skuCode: 'SERUM-1' }],
  orderId: '32000000-0000-4000-8000-000000000001',
  publicOrderNumber: 'ZS-1',
  storeId: '10000000-0000-4000-8000-000000000001',
};

describe('deterministic M5.4 payment test provider', () => {
  it('hard fails outside test and rejects short secrets', () => {
    expect(
      () =>
        new DeterministicPaymentTestProvider({
          nodeEnvironment: 'development',
          secret: 'x'.repeat(32),
        }),
    ).toThrow(ProviderIntegrationError);
    expect(
      () => new DeterministicPaymentTestProvider({ nodeEnvironment: 'test', secret: 'short' }),
    ).toThrow(ProviderIntegrationError);
  });

  it('returns the same provider identity and launch payload for a retried attempt', async () => {
    const provider = new DeterministicPaymentTestProvider({
      nodeEnvironment: 'test',
      secret: 'm54-test-provider-secret'.padEnd(40, 'x'),
    });
    const first = await provider.createPayment(baseInput);
    const second = await provider.createPayment(baseInput);
    expect(second).toEqual(first);
    expect(first.providerOrderId).toMatch(/^t\./u);
    await expect(
      provider.queryPayment({
        providerOrderId: first.providerOrderId,
        storeId: baseInput.storeId,
      }),
    ).resolves.toMatchObject({
      amountVnd: baseInput.amountVnd,
      attemptId: baseInput.attemptId,
      orderId: baseInput.orderId,
      status: 'PENDING',
      storeId: baseInput.storeId,
    });
  });

  it.each(['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'] as const)(
    'produces the configured %s fact without network access',
    async (status) => {
      const provider = new DeterministicPaymentTestProvider({
        nodeEnvironment: 'test',
        secret: 'm54-test-provider-secret'.padEnd(40, 'x'),
        status,
      });
      const created = await provider.createPayment(baseInput);
      const fact = await provider.queryPayment({
        providerOrderId: created.providerOrderId,
        storeId: baseInput.storeId,
      });
      expect(fact.status).toBe(status);
      expect(fact.providerTransactionId === undefined).toBe(status !== 'SUCCEEDED');
    },
  );

  it('can model a tampered authenticated fact for command-boundary tests', async () => {
    const provider = new DeterministicPaymentTestProvider({
      factOverrides: { amountVnd: baseInput.amountVnd - 1 },
      nodeEnvironment: 'test',
      secret: 'm54-test-provider-secret'.padEnd(40, 'x'),
      status: 'SUCCEEDED',
    });
    const created = await provider.createPayment(baseInput);
    await expect(
      provider.queryPayment({
        providerOrderId: created.providerOrderId,
        storeId: baseInput.storeId,
      }),
    ).resolves.toMatchObject({ amountVnd: baseInput.amountVnd - 1 });
  });
});
