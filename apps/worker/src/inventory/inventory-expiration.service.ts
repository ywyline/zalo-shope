import { randomUUID } from 'node:crypto';

import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { RuntimeConfig } from '@zalo-shop/config';
import { expireDueReservations, type PrismaClient } from '@zalo-shop/database';
import { createStoreContext } from '@zalo-shop/domain';
import { createLogger } from '@zalo-shop/logger';

import { RUNTIME_CONFIG } from '../health.controller';

export const WORKER_DATABASE_CLIENT = Symbol('WORKER_DATABASE_CLIENT');
const INVENTORY_WORKER_ACTOR_ID = '00000000-0000-4000-8000-000000000003';

type StoreRegistryEntry = {
  code: string;
  default_locale: 'en' | 'vi' | 'zh';
  id: string;
};

@Injectable()
export class InventoryExpirationService implements OnModuleDestroy, OnModuleInit {
  private readonly logger;
  private running = false;
  private timer?: ReturnType<typeof setInterval>;

  public constructor(
    @Inject(WORKER_DATABASE_CLIENT) private readonly database: PrismaClient,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
  ) {
    this.logger = createLogger('inventory-expiration-worker', config.LOG_LEVEL);
  }

  public async onModuleInit(): Promise<void> {
    await this.database.$connect();
    void this.runOnce();
    this.timer = setInterval(
      () => void this.runOnce(),
      this.config.INVENTORY_EXPIRATION_INTERVAL_MS,
    );
    this.timer.unref();
  }

  public async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.database.$disconnect();
  }

  public async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const stores = await this.database.$queryRaw<StoreRegistryEntry[]>`
        SELECT * FROM app_security.list_active_stores()
      `;
      for (const store of stores) {
        const context = createStoreContext({
          actor: { id: INVENTORY_WORKER_ACTOR_ID, type: 'admin' },
          correlationId: randomUUID(),
          locale: store.default_locale,
          storeCode: store.code,
          storeId: store.id,
        });
        try {
          const result = await expireDueReservations(
            this.database,
            context,
            this.config.INVENTORY_EXPIRATION_BATCH_SIZE,
          );
          if (result.scanned > 0) {
            const context = {
              expired: result.expired,
              failed: result.failed,
              scanned: result.scanned,
              storeId: store.id,
            };
            if (result.failed > 0) {
              this.logger.warn(context, 'Inventory reservation expiry batch completed with errors');
            } else {
              this.logger.info(context, 'Expired due inventory reservations');
            }
          }
        } catch (error) {
          this.logger.error(
            { error: error instanceof Error ? error.message : 'unknown', storeId: store.id },
            'Inventory reservation expiry failed for store',
          );
        }
      }
    } catch (error) {
      this.logger.error(
        { error: error instanceof Error ? error.message : 'unknown' },
        'Inventory reservation expiry scan failed',
      );
    } finally {
      this.running = false;
    }
  }
}
