import { ghnOrigin } from './ghn-contract';
import { GHN_SHIPPING_PROVIDER_CODE, GhnShippingProvider } from './ghn-shipping-provider';
import { ProviderIntegrationError } from './provider-contract';
import type { ShippingProvider } from './shipping-provider';
import type { SecretReferenceResolver } from './zalo-checkout-payment-provider';

export type ShippingProviderChannelConfig = Readonly<{
  id: string;
  keyVersion: string;
  originAllowlistKey: string;
  providerCode: string;
  providerEnvironment: 'SANDBOX' | 'PRODUCTION';
  shopId: string;
  storeId: string;
  tokenSecretRef: string;
  version: number;
}>;

export interface ShippingProviderResolver {
  resolve(channel: ShippingProviderChannelConfig): ShippingProvider;
}

export type ConfiguredShippingProviderResolverOptions = Readonly<{
  fetch?: typeof fetch;
  mode: 'disabled' | 'ghn';
  requestTimeoutMs?: number;
  responseLimitBytes?: number;
  secretResolver: SecretReferenceResolver;
}>;

export class ConfiguredShippingProviderResolver implements ShippingProviderResolver {
  readonly #providers = new Map<string, ShippingProvider>();

  public constructor(private readonly options: ConfiguredShippingProviderResolverOptions) {}

  public resolve(channel: ShippingProviderChannelConfig): ShippingProvider {
    if (this.options.mode === 'disabled') {
      throw new ProviderIntegrationError('CONFIGURATION', false, 'Shipping provider is disabled');
    }
    const expectedOriginKey =
      channel.providerEnvironment === 'SANDBOX' ? 'GHN_SANDBOX' : 'GHN_PRODUCTION';
    if (
      channel.providerCode !== GHN_SHIPPING_PROVIDER_CODE ||
      channel.originAllowlistKey !== expectedOriginKey ||
      !channel.id ||
      !channel.storeId ||
      !channel.keyVersion ||
      channel.version < 1 ||
      ghnOrigin(channel.providerEnvironment).length === 0
    ) {
      throw new ProviderIntegrationError('CONFIGURATION', false, 'Shipping channel is invalid');
    }
    const key = JSON.stringify([
      channel.id,
      channel.storeId,
      channel.providerEnvironment,
      channel.shopId,
      channel.tokenSecretRef,
      channel.keyVersion,
      channel.version,
    ]);
    const current = this.#providers.get(key);
    if (current) return current;
    const provider = new GhnShippingProvider({
      environment: channel.providerEnvironment,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      ...(this.options.requestTimeoutMs ? { requestTimeoutMs: this.options.requestTimeoutMs } : {}),
      ...(this.options.responseLimitBytes
        ? { responseLimitBytes: this.options.responseLimitBytes }
        : {}),
      resolveSecret: this.options.secretResolver,
      shopId: channel.shopId,
      storeId: channel.storeId,
      tokenSecretRef: channel.tokenSecretRef,
    });
    this.#providers.set(key, provider);
    return provider;
  }
}
