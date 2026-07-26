import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { parseRuntimeConfig, type RuntimeConfig } from '@zalo-shop/config';
import { createRuntimePrismaClient } from '@zalo-shop/database';
import {
  ConfiguredPaymentProviderResolver,
  EnvironmentSecretReferenceResolver,
  type PaymentProviderResolver,
} from '@zalo-shop/integrations';
import { createHttpLogger, createLogger } from '@zalo-shop/logger';
import { checkInfrastructure } from '@zalo-shop/platform';

import { HealthController, INFRASTRUCTURE_CHECKER, RUNTIME_CONFIG } from './health.controller';
import { InventoryExpirationService } from './inventory/inventory-expiration.service';
import { OrderReconciliationService } from './orders/order-reconciliation.service';
import { OutboxMessageDispatcher } from './reliable-messaging/outbox-message-handler';
import { ReliableOutboxService } from './reliable-messaging/reliable-outbox.service';
import { TestOnlyOutboxHandler } from './reliable-messaging/test-only-outbox-handler';
import { PaymentCreateRequestedHandler } from './payments/payment-create-requested.handler';
import { PaymentReconciliationRequestedHandler } from './payments/payment-reconciliation-requested.handler';
import {
  OUTBOX_MESSAGE_HANDLERS,
  WORKER_DATABASE_CLIENT,
  WORKER_PAYMENT_PROVIDER,
} from './worker.tokens';

const runtimeConfig = parseRuntimeConfig();
const logger = createLogger('worker', runtimeConfig.LOG_LEVEL);

function createPaymentProviderResolver(config: RuntimeConfig): PaymentProviderResolver {
  return new ConfiguredPaymentProviderResolver({
    mode: config.PAYMENT_PROVIDER,
    nodeEnvironment: config.NODE_ENV,
    requestTimeoutMs: config.ZALO_CHECKOUT_REQUEST_TIMEOUT_MS,
    responseLimitBytes: config.ZALO_CHECKOUT_RESPONSE_LIMIT_BYTES,
    secretResolver: new EnvironmentSecretReferenceResolver(),
    ...(config.PAYMENT_TEST_PROVIDER_SECRET
      ? { testSecret: config.PAYMENT_TEST_PROVIDER_SECRET }
      : {}),
  });
}

@Module({
  controllers: [HealthController],
  providers: [
    { provide: RUNTIME_CONFIG, useValue: runtimeConfig },
    { provide: INFRASTRUCTURE_CHECKER, useValue: checkInfrastructure },
    {
      provide: WORKER_DATABASE_CLIENT,
      useFactory: () => createRuntimePrismaClient(runtimeConfig.DATABASE_RUNTIME_URL),
    },
    {
      provide: WORKER_PAYMENT_PROVIDER,
      useFactory: () => createPaymentProviderResolver(runtimeConfig),
    },
    {
      inject: [RUNTIME_CONFIG, WORKER_DATABASE_CLIENT, WORKER_PAYMENT_PROVIDER],
      provide: OUTBOX_MESSAGE_HANDLERS,
      useFactory: (
        config: RuntimeConfig,
        database: ReturnType<typeof createRuntimePrismaClient>,
        paymentProviderResolver: PaymentProviderResolver,
      ) => [
        ...(config.NODE_ENV === 'test' ? [new TestOnlyOutboxHandler(config.NODE_ENV)] : []),
        ...(config.PAYMENT_PROVIDER === 'disabled'
          ? []
          : [
              new PaymentCreateRequestedHandler(
                database,
                paymentProviderResolver,
                config.PAYMENT_RECONCILIATION_ENABLED,
              ),
              new PaymentReconciliationRequestedHandler(database, paymentProviderResolver),
            ]),
      ],
    },
    InventoryExpirationService,
    OrderReconciliationService,
    OutboxMessageDispatcher,
    ReliableOutboxService,
  ],
})
export class AppModule implements NestModule {
  public configure(consumer: MiddlewareConsumer): void {
    consumer.apply(createHttpLogger(logger)).forRoutes('*');
  }
}

export function getWorkerRuntimeConfig(): RuntimeConfig {
  return runtimeConfig;
}
