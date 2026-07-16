import 'dotenv/config';
import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { createLogger, NestPinoLogger } from '@zalo-shop/logger';

import { AppModule, getApiRuntimeConfig } from './app.module';

async function bootstrap(): Promise<void> {
  const config = getApiRuntimeConfig();
  const structuredLogger = createLogger('api', config.LOG_LEVEL);
  const app = await NestFactory.create(AppModule, {
    logger: new NestPinoLogger(structuredLogger),
  });

  app.enableShutdownHooks();
  await app.listen(config.API_PORT, config.API_HOST);
  structuredLogger.info({ host: config.API_HOST, port: config.API_PORT }, 'API listening');
}

void bootstrap();
