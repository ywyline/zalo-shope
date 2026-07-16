import 'dotenv/config';
import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { createLogger, NestPinoLogger } from '@zalo-shop/logger';

import { AppModule, getWorkerRuntimeConfig } from './app.module';

async function bootstrap(): Promise<void> {
  const config = getWorkerRuntimeConfig();
  const structuredLogger = createLogger('worker', config.LOG_LEVEL);
  const app = await NestFactory.create(AppModule, {
    logger: new NestPinoLogger(structuredLogger),
  });

  app.enableShutdownHooks();
  await app.listen(config.WORKER_PORT, config.WORKER_HOST);
  structuredLogger.info(
    { host: config.WORKER_HOST, port: config.WORKER_PORT },
    'Worker health endpoint listening',
  );
}

void bootstrap();
