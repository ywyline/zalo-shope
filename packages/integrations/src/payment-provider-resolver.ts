import { DeterministicPaymentTestProvider } from './deterministic-payment-test-provider';
import type { PaymentProvider } from './payment-provider';
import { ProviderIntegrationError } from './provider-contract';
import {
  type SecretReferenceResolver,
  ZALO_CHECKOUT_PAYMENT_PROVIDER_CODE,
  ZaloCheckoutPaymentProvider,
} from './zalo-checkout-payment-provider';
import { zaloPayCheckoutMethod } from './zalo-checkout-contract';

export type PaymentProviderChannelConfig = Readonly<{
  checkoutAppId: string;
  id: string;
  keyVersion: string;
  methodCode: string;
  privateKeySecretRef: string;
  providerCode: string;
  providerEnvironment: 'SANDBOX' | 'PRODUCTION';
  storeId: string;
  version: number;
}>;

export interface PaymentProviderResolver {
  resolve(channel: PaymentProviderChannelConfig): PaymentProvider;
}

type ConfiguredPaymentProviderResolverOptions = Readonly<{
  fetch?: typeof fetch;
  mode: 'disabled' | 'test' | 'zalo-checkout';
  nodeEnvironment: 'development' | 'test' | 'production';
  requestTimeoutMs?: number;
  responseLimitBytes?: number;
  secretResolver: SecretReferenceResolver;
  testSecret?: string;
}>;

export class ConfiguredPaymentProviderResolver implements PaymentProviderResolver {
  readonly #providers = new Map<string, PaymentProvider>();

  public constructor(private readonly options: ConfiguredPaymentProviderResolverOptions) {
    if (options.mode === 'test' && options.nodeEnvironment !== 'test') {
      throw new ProviderIntegrationError(
        'CONFIGURATION',
        false,
        'Test payment provider is test-only',
      );
    }
    if (options.mode === 'test' && !options.testSecret) {
      throw new ProviderIntegrationError(
        'CONFIGURATION',
        false,
        'Test payment provider secret is required',
      );
    }
  }

  public resolve(channel: PaymentProviderChannelConfig): PaymentProvider {
    if (this.options.mode === 'disabled') {
      throw new ProviderIntegrationError('CONFIGURATION', false, 'Payment provider is disabled');
    }
    if (
      channel.providerCode !== ZALO_CHECKOUT_PAYMENT_PROVIDER_CODE ||
      channel.methodCode !== zaloPayCheckoutMethod(channel.providerEnvironment) ||
      !channel.id ||
      !channel.storeId ||
      channel.version < 1 ||
      !channel.keyVersion
    ) {
      throw new ProviderIntegrationError('CONFIGURATION', false, 'Payment channel is invalid');
    }
    const cacheKey = [
      this.options.mode,
      channel.id,
      channel.storeId,
      channel.checkoutAppId,
      channel.methodCode,
      channel.providerEnvironment,
      channel.version,
      channel.keyVersion,
      channel.privateKeySecretRef,
    ].join(':');
    const cached = this.#providers.get(cacheKey);
    if (cached) return cached;
    const provider =
      this.options.mode === 'test'
        ? new DeterministicPaymentTestProvider({
            nodeEnvironment: this.options.nodeEnvironment,
            secret: this.options.testSecret!,
          })
        : new ZaloCheckoutPaymentProvider({
            appId: channel.checkoutAppId,
            environment: channel.providerEnvironment,
            ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
            privateKeySecretRef: channel.privateKeySecretRef,
            ...(this.options.requestTimeoutMs
              ? { requestTimeoutMs: this.options.requestTimeoutMs }
              : {}),
            resolveSecret: this.options.secretResolver,
            ...(this.options.responseLimitBytes
              ? { responseLimitBytes: this.options.responseLimitBytes }
              : {}),
            storeId: channel.storeId,
          });
    this.#providers.set(cacheKey, provider);
    return provider;
  }
}
