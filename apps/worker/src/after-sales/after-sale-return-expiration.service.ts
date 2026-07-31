import { randomUUID } from 'node:crypto';

import {
  Inject,
  Injectable,
  type OnApplicationShutdown,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { RuntimeConfig } from '@zalo-shop/config';
import { expireDueAfterSales, type PrismaClient } from '@zalo-shop/database';
import { createAfterSaleSystemContext } from '@zalo-shop/domain';
import { createLogger } from '@zalo-shop/logger';

import { RUNTIME_CONFIG } from '../health.controller';
import { WORKER_DATABASE_CLIENT } from '../worker.tokens';

const RETURN_EXPIRATION_SYSTEM_ACTOR_ID = '00000000-0000-4000-8000-000000000007';

type StoreRegistryEntry = { id: string };

@Injectable()
export class AfterSaleReturnExpirationService
  implements OnApplicationShutdown, OnModuleDestroy, OnModuleInit
{
  private activeRun?: Promise<void>;
  private readonly logger;
  private stopping = false;
  private timer?: ReturnType<typeof setInterval>;

  public constructor(
    @Inject(WORKER_DATABASE_CLIENT) private readonly database: PrismaClient,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
  ) {
    this.logger = createLogger('after-sale-return-expiration-worker', config.LOG_LEVEL);
  }

  public async onModuleInit(): Promise<void> {
    if (!this.config.AFTER_SALE_RETURN_EXPIRATION_WORKER_ENABLED) return;
    await this.database.$connect();
    void this.runOnce();
    this.timer = setInterval(
      () => void this.runOnce(),
      this.config.AFTER_SALE_RETURN_EXPIRATION_INTERVAL_MS,
    );
    this.timer.unref();
  }

  public async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.activeRun;
  }

  public async onApplicationShutdown(): Promise<void> {
    if (this.config.AFTER_SALE_RETURN_EXPIRATION_WORKER_ENABLED) {
      await this.database.$disconnect();
    }
  }

  public async runOnce(): Promise<void> {
    if (
      !this.config.AFTER_SALE_RETURN_EXPIRATION_WORKER_ENABLED ||
      this.stopping ||
      this.activeRun
    ) {
      return;
    }
    const run = this.processBatch();
    this.activeRun = run;
    try {
      await run;
    } finally {
      if (this.activeRun === run) this.activeRun = undefined;
    }
  }

  private async processBatch(): Promise<void> {
    try {
      const stores = await this.database.$queryRaw<StoreRegistryEntry[]>`
        SELECT id FROM app_security.list_active_stores()
      `;
      for (const store of stores) {
        if (this.stopping) break;
        try {
          const result = await expireDueAfterSales(
            this.database,
            createAfterSaleSystemContext({
              actorId: RETURN_EXPIRATION_SYSTEM_ACTOR_ID,
              correlationId: randomUUID(),
              storeId: store.id,
            }),
            this.config.AFTER_SALE_RETURN_EXPIRATION_BATCH_SIZE,
          );
          if (result.scanned > 0) {
            this.logger.info({ ...result, storeId: store.id }, 'Processed due after-sale returns');
          }
        } catch (error) {
          this.logger.error(
            { error: error instanceof Error ? error.message : 'unknown', storeId: store.id },
            'After-sale return expiration failed for store',
          );
        }
      }
    } catch (error) {
      this.logger.error(
        { error: error instanceof Error ? error.message : 'unknown' },
        'After-sale return expiration store scan failed',
      );
    }
  }
}
