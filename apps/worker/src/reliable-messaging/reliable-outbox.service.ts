import { randomUUID } from 'node:crypto';

import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { RuntimeConfig } from '@zalo-shop/config';
import {
  claimOutboxMessages,
  completeOutboxMessage,
  failOutboxMessage,
  type OutboxMessageRecord,
  type PrismaClient,
} from '@zalo-shop/database';
import { createStoreContext, type OutboxFailureDisposition } from '@zalo-shop/domain';
import { createLogger } from '@zalo-shop/logger';

import { RUNTIME_CONFIG } from '../health.controller';
import { WORKER_DATABASE_CLIENT } from '../worker.tokens';
import { OutboxHandlerError, OutboxMessageDispatcher } from './outbox-message-handler';

const OUTBOX_WORKER_ACTOR_ID = '00000000-0000-4000-8000-000000000005';

type StoreRegistryEntry = {
  code: string;
  default_locale: 'en' | 'vi' | 'zh';
  id: string;
};

@Injectable()
export class ReliableOutboxService implements OnModuleDestroy, OnModuleInit {
  private readonly logger;
  private readonly workerId = `outbox-${randomUUID()}`;
  private running = false;
  private timer?: ReturnType<typeof setInterval>;

  public constructor(
    @Inject(WORKER_DATABASE_CLIENT) private readonly database: PrismaClient,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
    @Inject(OutboxMessageDispatcher) private readonly dispatcher: OutboxMessageDispatcher,
  ) {
    this.logger = createLogger('reliable-outbox-worker', config.LOG_LEVEL);
  }

  public onModuleInit(): void {
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.config.OUTBOX_WORKER_INTERVAL_MS);
    this.timer.unref();
  }

  public onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  public async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const stores = await this.database.$queryRaw<StoreRegistryEntry[]>`
        SELECT * FROM app_security.list_active_stores()
      `;
      for (const store of stores) await this.runStore(store);
    } catch {
      this.logger.error({}, 'Reliable outbox scan failed');
    } finally {
      this.running = false;
    }
  }

  private async runStore(store: StoreRegistryEntry): Promise<void> {
    const context = createStoreContext({
      actor: { id: OUTBOX_WORKER_ACTOR_ID, type: 'admin' },
      correlationId: randomUUID(),
      locale: store.default_locale,
      storeCode: store.code,
      storeId: store.id,
    });
    try {
      let claimed = 0;
      while (claimed < this.config.OUTBOX_WORKER_BATCH_SIZE) {
        const messages = await claimOutboxMessages(this.database, context, {
          batchSize: 1,
          leaseDurationMs: this.config.OUTBOX_WORKER_LEASE_MS,
          workerId: this.workerId,
        });
        const message = messages[0];
        if (!message) break;
        claimed += 1;
        await this.processMessage(context, message);
      }
      if (claimed > 0) {
        this.logger.info({ claimed, storeId: store.id }, 'Reliable outbox batch processed');
      }
    } catch {
      this.logger.error({ storeId: store.id }, 'Reliable outbox processing failed for store');
    }
  }

  private async processMessage(
    context: ReturnType<typeof createStoreContext>,
    message: OutboxMessageRecord,
  ): Promise<void> {
    try {
      await this.dispatcher.dispatch(message);
      await completeOutboxMessage(this.database, context, {
        expectedVersion: message.version,
        messageId: message.id,
        workerId: this.workerId,
      });
    } catch (error) {
      const failure = this.failure(error);
      try {
        const result = await failOutboxMessage(this.database, context, {
          baseDelayMs: this.config.OUTBOX_WORKER_RETRY_BASE_DELAY_MS,
          disposition: failure.disposition,
          errorCode: failure.code,
          expectedVersion: message.version,
          maxDelayMs: this.config.OUTBOX_WORKER_RETRY_MAX_DELAY_MS,
          messageId: message.id,
          workerId: this.workerId,
        });
        this.logger.warn(
          {
            disposition: failure.disposition,
            errorCode: result.lastErrorCode,
            status: result.status,
            storeId: context.storeId,
          },
          'Reliable outbox handler did not complete',
        );
      } catch {
        this.logger.warn(
          { errorCode: 'OUTBOX_LEASE_LOST', storeId: context.storeId },
          'Reliable outbox result was not persisted',
        );
      }
    }
  }

  private failure(error: unknown): Readonly<{
    code: string;
    disposition: OutboxFailureDisposition;
  }> {
    if (error instanceof OutboxHandlerError) {
      return { code: error.code, disposition: error.disposition };
    }
    return { code: 'UNEXPECTED_HANDLER_ERROR', disposition: 'RETRYABLE' };
  }
}
