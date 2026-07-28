import {
  Module,
  ServiceUnavailableException,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { parseRuntimeConfig, type RuntimeConfig } from '@zalo-shop/config';
import { createRuntimePrismaClient } from '@zalo-shop/database';
import {
  ConfiguredPaymentProviderResolver,
  ConfiguredShippingProviderResolver,
  DeterministicZaloTestProvider,
  EnvironmentSecretReferenceResolver,
  S3MediaStorageProvider,
  ZaloOpenApiIdentityProvider,
  type ZaloIdentityProvider,
  type PaymentProviderResolver,
  type ShippingProviderResolver,
} from '@zalo-shop/integrations';
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
import {
  DATABASE_CLIENT,
  MEDIA_STORAGE_PROVIDER,
  ZALO_IDENTITY_PROVIDER,
} from './auth/auth.tokens';
import { AdminController } from './admin/admin.controller';
import { AdminService } from './admin/admin.service';
import { CatalogAdminController } from './catalog-admin/catalog-admin.controller';
import { CatalogAdminService } from './catalog-admin/catalog-admin.service';
import {
  ComplianceAdminController,
  MediaAdminController,
  ProductAdminController,
} from './catalog-admin/product-admin.controller';
import { ProductAdminService } from './catalog-admin/product-admin.service';
import { ContentAdminController } from './content-admin/content-admin.controller';
import { ContentAdminService } from './content-admin/content-admin.service';
import { StoreController } from './store.controller';
import { CatalogController } from './catalog/catalog.controller';
import { CatalogService } from './catalog/catalog.service';
import { InventoryAdminController } from './inventory-admin/inventory-admin.controller';
import { InventoryAdminService } from './inventory-admin/inventory-admin.service';
import { SearchController, SearchHistoryController } from './search/search.controller';
import { SearchRateLimiter } from './search/search-rate-limiter';
import { SearchService } from './search/search.service';
import { PromotionsAdminController } from './promotions-admin/promotions-admin.controller';
import { PromotionsAdminService } from './promotions-admin/promotions-admin.service';
import { MemberCouponController } from './pricing/member-coupon.controller';
import { MemberCouponService } from './pricing/member-coupon.service';
import { PricingController } from './pricing/pricing.controller';
import { PricingService } from './pricing/pricing.service';
import { CartController } from './cart/cart.controller';
import { CartService } from './cart/cart.service';
import { AddressController } from './address/address.controller';
import { AdministrativeAreaController } from './address/administrative-area.controller';
import { AddressService } from './address/address.service';
import { CheckoutController } from './checkout/checkout.controller';
import { CheckoutService } from './checkout/checkout.service';
import { OrdersController } from './orders/orders.controller';
import { OrdersService } from './orders/orders.service';
import { OrdersAdminController } from './orders-admin/orders-admin.controller';
import { DeliveryAdminController } from './delivery-admin/delivery-admin.controller';
import { DeliveryAdminService } from './delivery-admin/delivery-admin.service';
import { PaymentsController } from './payments/payments.controller';
import { PaymentsService } from './payments/payments.service';
import { PAYMENT_PROVIDER } from './payments/payment.tokens';
import { PaymentWebhookController } from './payments/payment-webhook.controller';
import {
  PaymentWebhookRateLimiter,
  PaymentWebhookService,
} from './payments/payment-webhook.service';
import { ShippingWebhookController } from './shipping/shipping-webhook.controller';
import {
  ShippingWebhookRateLimiter,
  ShippingWebhookService,
} from './shipping/shipping-webhook.service';
import { ShippingController } from './shipping/shipping.controller';
import { ShippingService } from './shipping/shipping.service';
import { SHIPPING_PROVIDER } from './shipping/shipping.tokens';
import { PaymentsAdminController } from './payments-admin/payments-admin.controller';
import { PaymentsAdminService } from './payments-admin/payments-admin.service';
import { AfterSalesPolicyController } from './after-sales-policy/after-sales-policy.controller';
import { AfterSalesPolicyService } from './after-sales-policy/after-sales-policy.service';
import {
  AfterSalesAdminController,
  AfterSalesController,
} from './after-sales/after-sales.controller';
import { AfterSalesCursor } from './after-sales/after-sales-cursor';
import { AfterSalesProjector } from './after-sales/after-sales-projector';
import { AfterSalesRateLimiter } from './after-sales/after-sales-rate-limiter';
import { AfterSalesService } from './after-sales/after-sales.service';

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
  if (config.ZALO_IDENTITY_PROVIDER === 'open-api') {
    return new ZaloOpenApiIdentityProvider({
      appSecret: config.ZALO_APP_SECRET!,
      miniAppId: config.ZALO_MINI_APP_ID!,
      parentAppId: config.ZALO_APP_ID!,
      requestTimeoutMs: config.ZALO_OPEN_API_TIMEOUT_MS,
      tokenMetadataTtlSeconds: config.ZALO_TOKEN_METADATA_TTL_SECONDS,
    });
  }
  if (config.ZALO_IDENTITY_PROVIDER === 'test') {
    return new DeterministicZaloTestProvider({
      audience: 'zalo-shop-test-provider',
      issuer: 'zalo-shop-test-provider',
      secret: config.ZALO_TEST_TOKEN_SECRET!,
    });
  }
  return new DisabledZaloIdentityProvider();
}

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

@Module({
  controllers: [
    HealthController,
    AuthController,
    MemberController,
    AdminController,
    CatalogAdminController,
    ProductAdminController,
    MediaAdminController,
    ComplianceAdminController,
    ContentAdminController,
    CatalogController,
    StoreController,
    InventoryAdminController,
    SearchController,
    SearchHistoryController,
    PromotionsAdminController,
    MemberCouponController,
    PricingController,
    CartController,
    AddressController,
    AdministrativeAreaController,
    CheckoutController,
    OrdersController,
    OrdersAdminController,
    DeliveryAdminController,
    PaymentsController,
    PaymentWebhookController,
    ShippingWebhookController,
    ShippingController,
    PaymentsAdminController,
    AfterSalesPolicyController,
    AfterSalesController,
    AfterSalesAdminController,
  ],
  providers: [
    AdminService,
    CatalogAdminService,
    ProductAdminService,
    ContentAdminService,
    CatalogService,
    AuthService,
    InventoryAdminService,
    SearchService,
    SearchRateLimiter,
    PromotionsAdminService,
    MemberCouponService,
    PricingService,
    CartService,
    AddressService,
    CheckoutService,
    OrdersService,
    DeliveryAdminService,
    PaymentsService,
    PaymentWebhookRateLimiter,
    PaymentWebhookService,
    ShippingWebhookRateLimiter,
    ShippingWebhookService,
    ShippingService,
    PaymentsAdminService,
    AfterSalesPolicyService,
    AfterSalesCursor,
    AfterSalesProjector,
    AfterSalesRateLimiter,
    AfterSalesService,
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
      provide: MEDIA_STORAGE_PROVIDER,
      useFactory: () => new S3MediaStorageProvider(runtimeConfig),
    },
    {
      provide: PAYMENT_PROVIDER,
      useFactory: () => createPaymentProviderResolver(runtimeConfig),
    },
    {
      provide: SHIPPING_PROVIDER,
      useFactory: () => createShippingProviderResolver(runtimeConfig),
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
