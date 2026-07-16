import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { parseRuntimeConfig, type RuntimeConfig } from '@zalo-shop/config';
import { createHttpLogger, createLogger } from '@zalo-shop/logger';
import { checkInfrastructure } from '@zalo-shop/platform';

import { HealthController, INFRASTRUCTURE_CHECKER, RUNTIME_CONFIG } from './health.controller';

const runtimeConfig = parseRuntimeConfig();
const logger = createLogger('worker', runtimeConfig.LOG_LEVEL);

@Module({
  controllers: [HealthController],
  providers: [
    { provide: RUNTIME_CONFIG, useValue: runtimeConfig },
    { provide: INFRASTRUCTURE_CHECKER, useValue: checkInfrastructure },
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
