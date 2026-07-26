import { ProviderIntegrationError } from './provider-contract';
import type { SecretReferenceResolver } from './zalo-checkout-payment-provider';

const INTEGRATION_ENV_REFERENCE = /^env:((?:ZALO_CHECKOUT|GHN)_[A-Z0-9_]{1,96})$/u;

export class EnvironmentSecretReferenceResolver implements SecretReferenceResolver {
  public constructor(
    private readonly environment: Readonly<Record<string, string | undefined>> = process.env,
  ) {}

  public async resolve(reference: string): Promise<string> {
    await Promise.resolve();
    const match = INTEGRATION_ENV_REFERENCE.exec(reference);
    if (!match) {
      throw new ProviderIntegrationError('CONFIGURATION', false, 'Secret reference is not allowed');
    }
    const value = this.environment[match[1]!];
    if (!value) {
      throw new ProviderIntegrationError('CONFIGURATION', false, 'Secret reference is unavailable');
    }
    return value;
  }
}
