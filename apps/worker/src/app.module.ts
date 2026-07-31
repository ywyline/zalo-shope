import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { parseRuntimeConfig, type RuntimeConfig } from '@zalo-shop/config';
import { createRuntimePrismaClient } from '@zalo-shop/database';
import {
  ClamAvAfterSaleEvidenceScanner,
  ConfiguredPaymentProviderResolver,
  ConfiguredShippingProviderResolver,
  EnvironmentSecretReferenceResolver,
  createAfterSaleEvidenceStorageProvider,
  type AfterSaleEvidenceObjectStorageProvider,
  type AfterSaleEvidenceScanner,
  type PaymentProviderResolver,
  type ShippingProviderResolver,
} from '@zalo-shop/integrations';
import { createHttpLogger, createLogger } from '@zalo-shop/logger';
import { checkInfrastructure } from '@zalo-shop/platform';

import { HealthController, INFRASTRUCTURE_CHECKER, RUNTIME_CONFIG } from './health.controller';
import { AfterSaleEvidenceDeadLetterService } from './after-sales-evidence/after-sale-evidence-dead-letter.service';
import { AfterSaleEvidenceDeletionDeadLetterService } from './after-sales-evidence/after-sale-evidence-deletion-dead-letter.service';
import {
  AfterSaleEvidenceDeleteRequestedHandler,
  AfterSaleEvidenceExpireRequestedHandler,
} from './after-sales-evidence/after-sale-evidence-deletion.handler';
import { AfterSaleEvidenceScanRequestedHandler } from './after-sales-evidence/after-sale-evidence-scan.handler';
import { AfterSaleEvidenceStorageLifecycleService } from './after-sales-evidence/after-sale-evidence-storage-lifecycle.service';
import { AfterSaleReturnExpirationService } from './after-sales/after-sale-return-expiration.service';
import { InventoryExpirationService } from './inventory/inventory-expiration.service';
import { OrderReconciliationService } from './orders/order-reconciliation.service';
import { OutboxMessageDispatcher } from './reliable-messaging/outbox-message-handler';
import { ReliableOutboxService } from './reliable-messaging/reliable-outbox.service';
import { TestOnlyOutboxHandler } from './reliable-messaging/test-only-outbox-handler';
import { PaymentCreateRequestedHandler } from './payments/payment-create-requested.handler';
import { PaymentReconciliationRequestedHandler } from './payments/payment-reconciliation-requested.handler';
import {
  RefundCreateRequestedHandler,
  RefundQueryRequestedHandler,
} from './payments/refund-requested.handlers';
import { ShipmentCreateRequestedHandler } from './shipments/shipment-create-requested.handler';
import { ShipmentProviderOperationHandler } from './shipments/shipment-provider-operation.handler';
import { SHIPMENT_CANCEL_EVENT_TYPE, SHIPMENT_QUERY_EVENT_TYPE } from '@zalo-shop/database';
import {
  OUTBOX_MESSAGE_HANDLERS,
  WORKER_AFTER_SALE_EVIDENCE_SCANNER,
  WORKER_AFTER_SALE_EVIDENCE_STORAGE,
  WORKER_DATABASE_CLIENT,
  WORKER_PAYMENT_PROVIDER,
  WORKER_SHIPPING_PROVIDER_RESOLVER,
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

function createShippingProviderResolver(config: RuntimeConfig): ShippingProviderResolver {
  return new ConfiguredShippingProviderResolver({
    mode: config.SHIPPING_PROVIDER,
    requestTimeoutMs: config.GHN_REQUEST_TIMEOUT_MS,
    responseLimitBytes: config.GHN_RESPONSE_LIMIT_BYTES,
    secretResolver: new EnvironmentSecretReferenceResolver(),
  });
}

function createEvidenceStorage(
  config: RuntimeConfig,
): AfterSaleEvidenceObjectStorageProvider | null {
  if (
    config.EVIDENCE_SCANNER_PROVIDER !== 'clamav' &&
    !config.AFTER_SALE_EVIDENCE_DELETION_WORKER_ENABLED
  ) {
    return null;
  }
  return createAfterSaleEvidenceStorageProvider(config);
}

function createEvidenceScanner(config: RuntimeConfig): AfterSaleEvidenceScanner | null {
  if (config.EVIDENCE_SCANNER_PROVIDER !== 'clamav') return null;
  if (
    config.EVIDENCE_SCANNER_HOST === undefined ||
    config.EVIDENCE_SCANNER_SIGNATURE_MAX_AGE_SECONDS === undefined
  ) {
    throw new Error('Evidence scanner configuration is incomplete');
  }
  return new ClamAvAfterSaleEvidenceScanner({
    host: config.EVIDENCE_SCANNER_HOST,
    port: config.EVIDENCE_SCANNER_PORT,
    responseLimitBytes: config.EVIDENCE_SCANNER_RESPONSE_LIMIT_BYTES,
    signatureMaxAgeMs: config.EVIDENCE_SCANNER_SIGNATURE_MAX_AGE_SECONDS * 1_000,
    timeoutMs: config.EVIDENCE_SCANNER_REQUEST_TIMEOUT_MS,
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
      inject: [RUNTIME_CONFIG],
      provide: WORKER_AFTER_SALE_EVIDENCE_STORAGE,
      useFactory: createEvidenceStorage,
    },
    {
      inject: [RUNTIME_CONFIG],
      provide: WORKER_AFTER_SALE_EVIDENCE_SCANNER,
      useFactory: createEvidenceScanner,
    },
    {
      provide: WORKER_SHIPPING_PROVIDER_RESOLVER,
      useFactory: () => createShippingProviderResolver(runtimeConfig),
    },
    {
      inject: [
        RUNTIME_CONFIG,
        WORKER_DATABASE_CLIENT,
        WORKER_AFTER_SALE_EVIDENCE_STORAGE,
        WORKER_AFTER_SALE_EVIDENCE_SCANNER,
        WORKER_PAYMENT_PROVIDER,
        WORKER_SHIPPING_PROVIDER_RESOLVER,
      ],
      provide: OUTBOX_MESSAGE_HANDLERS,
      useFactory: (
        config: RuntimeConfig,
        database: ReturnType<typeof createRuntimePrismaClient>,
        evidenceStorage: AfterSaleEvidenceObjectStorageProvider | null,
        evidenceScanner: AfterSaleEvidenceScanner | null,
        paymentProviderResolver: PaymentProviderResolver,
        shippingProviderResolver: ShippingProviderResolver,
      ) => [
        ...(config.NODE_ENV === 'test' ? [new TestOnlyOutboxHandler(config.NODE_ENV)] : []),
        ...(config.EVIDENCE_SCANNER_PROVIDER === 'clamav'
          ? [
              new AfterSaleEvidenceScanRequestedHandler(
                database,
                evidenceStorage ?? missingEvidenceDependency(),
                evidenceScanner ?? missingEvidenceDependency(),
                config,
              ),
            ]
          : []),
        ...(config.AFTER_SALE_EVIDENCE_DELETION_WORKER_ENABLED
          ? [
              new AfterSaleEvidenceExpireRequestedHandler(database, config),
              new AfterSaleEvidenceDeleteRequestedHandler(
                database,
                evidenceStorage ?? missingEvidenceDependency(),
                config,
              ),
            ]
          : []),
        ...(config.PAYMENT_PROVIDER === 'disabled'
          ? []
          : [
              new PaymentCreateRequestedHandler(
                database,
                paymentProviderResolver,
                config.PAYMENT_RECONCILIATION_ENABLED,
              ),
              new PaymentReconciliationRequestedHandler(database, paymentProviderResolver),
              new RefundCreateRequestedHandler(database, paymentProviderResolver),
              new RefundQueryRequestedHandler(database, paymentProviderResolver),
            ]),
        ...(config.SHIPPING_PROVIDER === 'disabled'
          ? []
          : [
              new ShipmentCreateRequestedHandler(database, shippingProviderResolver, config),
              new ShipmentProviderOperationHandler(
                SHIPMENT_CANCEL_EVENT_TYPE,
                database,
                shippingProviderResolver,
              ),
              new ShipmentProviderOperationHandler(
                SHIPMENT_QUERY_EVENT_TYPE,
                database,
                shippingProviderResolver,
              ),
            ]),
      ],
    },
    InventoryExpirationService,
    ...(runtimeConfig.AFTER_SALE_RETURN_EXPIRATION_WORKER_ENABLED
      ? [AfterSaleReturnExpirationService]
      : []),
    OrderReconciliationService,
    AfterSaleEvidenceStorageLifecycleService,
    OutboxMessageDispatcher,
    ReliableOutboxService,
    ...(runtimeConfig.EVIDENCE_SCANNER_PROVIDER === 'clamav'
      ? [AfterSaleEvidenceDeadLetterService]
      : []),
    ...(runtimeConfig.AFTER_SALE_EVIDENCE_DELETION_WORKER_ENABLED
      ? [AfterSaleEvidenceDeletionDeadLetterService]
      : []),
  ],
})
export class AppModule implements NestModule {
  public configure(consumer: MiddlewareConsumer): void {
    consumer.apply(createHttpLogger(logger)).forRoutes('*');
  }
}

function missingEvidenceDependency(): never {
  throw new Error('Evidence scanner dependency is unavailable');
}

export function getWorkerRuntimeConfig(): RuntimeConfig {
  return runtimeConfig;
}
