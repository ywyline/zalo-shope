import {
  Module,
  ServiceUnavailableException,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { parseRuntimeConfig, type RuntimeConfig } from '@zalo-shop/config';
import { createRuntimePrismaClient } from '@zalo-shop/database';
import { DeterministicZaloTestProvider, type ZaloIdentityProvider } from '@zalo-shop/integrations';
import { createHttpLogger, createLogger } from '@zalo-shop/logger';
import { checkInfrastructure } from '@zalo-shop/platform';

import {
  HealthController,
  INFRASTRUCTURE_CHECKER,
  RUNTIME_CONFIG,
  type InfrastructureChecker,
} from './health.controller';
import { AuthController, MemberController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { DATABASE_CLIENT, ZALO_IDENTITY_PROVIDER } from './auth/auth.tokens';
import { AdminController } from './admin/admin.controller';
import { AdminService } from './admin/admin.service';
import { CatalogAdminController } from './catalog-admin/catalog-admin.controller';
import { CatalogAdminService } from './catalog-admin/catalog-admin.service';
import { StoreController } from './store.controller';

const runtimeConfig = parseRuntimeConfig();
const logger = createLogger('api', runtimeConfig.LOG_LEVEL);

class DisabledZaloIdentityProvider implements ZaloIdentityProvider {
  public decodePhoneToken(): Promise<{ phoneE164: string }> {
    throw new ServiceUnavailableException('Zalo identity provider is not configured');
  }

  public verifyAccessToken(): Promise<never> {
    throw new ServiceUnavailableException('Zalo identity provider is not configured');
  }
}

function createZaloProvider(config: RuntimeConfig): ZaloIdentityProvider {
  if (config.ZALO_IDENTITY_PROVIDER === 'test') {
    return new DeterministicZaloTestProvider({
      audience: 'zalo-shop-test-provider',
      issuer: 'zalo-shop-test-provider',
      secret: config.ZALO_TEST_TOKEN_SECRET!,
    });
  }
  return new DisabledZaloIdentityProvider();
}

@Module({
  controllers: [
    HealthController,
    AuthController,
    MemberController,
    AdminController,
    CatalogAdminController,
    StoreController,
  ],
  providers: [
    AdminService,
    CatalogAdminService,
    AuthService,
    { provide: RUNTIME_CONFIG, useValue: runtimeConfig },
    {
      provide: DATABASE_CLIENT,
      useFactory: () => createRuntimePrismaClient(runtimeConfig.DATABASE_RUNTIME_URL),
    },
    {
      provide: ZALO_IDENTITY_PROVIDER,
      useFactory: () => createZaloProvider(runtimeConfig),
    },
    {
      provide: INFRASTRUCTURE_CHECKER,
      useValue: checkInfrastructure satisfies InfrastructureChecker,
    },
  ],
})
export class AppModule implements NestModule {
  public configure(consumer: MiddlewareConsumer): void {
    consumer.apply(createHttpLogger(logger)).forRoutes('*');
  }
}

export function getApiRuntimeConfig(): RuntimeConfig {
  return runtimeConfig;
}
