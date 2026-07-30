import { randomUUID } from 'node:crypto';

import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { RuntimeConfig } from '@zalo-shop/config';
import {
  listAfterSaleEvidenceLifecycleDeadLetterCandidates,
  reconcileAfterSaleEvidenceLifecycleDeadLetter,
  type PrismaClient,
} from '@zalo-shop/database';
import { createAfterSaleEvidenceSystemContext } from '@zalo-shop/domain';
import { createLogger } from '@zalo-shop/logger';

import { RUNTIME_CONFIG } from '../health.controller';
import { WORKER_DATABASE_CLIENT } from '../worker.tokens';

type StoreRegistryEntry = Readonly<{ id: string }>;

@Injectable()
export class AfterSaleEvidenceDeletionDeadLetterService implements OnModuleDestroy, OnModuleInit {
  private activeRun?: Promise<void>;
  private readonly logger;
  private stopping = false;
  private timer?: ReturnType<typeof setInterval>;

  public constructor(
    @Inject(WORKER_DATABASE_CLIENT) private readonly database: PrismaClient,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
  ) {
    this.logger = createLogger('evidence-lifecycle-dead-letter-reconciler', config.LOG_LEVEL);
  }

  public onModuleInit(): void {
    if (!this.config.AFTER_SALE_EVIDENCE_DELETION_WORKER_ENABLED) return;
    void this.runOnce();
    this.timer = setInterval(
      () => void this.runOnce(),
      this.config.AFTER_SALE_EVIDENCE_LIFECYCLE_DEAD_LETTER_INTERVAL_MS,
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

  public async runOnce(): Promise<void> {
    if (
      this.stopping ||
      this.activeRun ||
      !this.config.AFTER_SALE_EVIDENCE_DELETION_WORKER_ENABLED
    ) {
      return;
    }
    const activeRun = this.processBatch();
    this.activeRun = activeRun;
    try {
      await activeRun;
    } finally {
      if (this.activeRun === activeRun) this.activeRun = undefined;
    }
  }

  private async processBatch(): Promise<void> {
    try {
      const stores = await this.database.$queryRaw<StoreRegistryEntry[]>`
        SELECT id FROM app_security.list_active_stores()
      `;
      for (const store of stores) {
        if (this.stopping) break;
        await this.runStore(store.id);
      }
    } catch {
      this.logger.error(
        { errorCode: 'EVIDENCE_LIFECYCLE_DEAD_LETTER_POLL_FAILED' },
        'Evidence lifecycle dead-letter poll failed',
      );
    }
  }

  private async runStore(storeId: string): Promise<void> {
    const context = createAfterSaleEvidenceSystemContext({
      correlationId: randomUUID(),
      storeId,
    });
    try {
      const candidates = await listAfterSaleEvidenceLifecycleDeadLetterCandidates(
        this.database,
        context,
        { batchSize: this.config.AFTER_SALE_EVIDENCE_LIFECYCLE_DEAD_LETTER_BATCH_SIZE },
      );
      const deletionConfig = this.requiredConfig();
      let reconciled = 0;
      for (const candidate of candidates) {
        if (this.stopping) break;
        try {
          const result = await reconcileAfterSaleEvidenceLifecycleDeadLetter(
            this.database,
            context,
            {
              ...deletionConfig,
              messageId: candidate.messageId,
            },
          );
          if (
            result.outcome === 'DELETE_RETRY_SCHEDULED' &&
            result.evidence.deleteAttemptCount === 5
          ) {
            this.logger.warn(
              { deleteAttempt: 5, errorCode: 'EVIDENCE_DELETE_WARNING', storeId },
              'Evidence deletion warning condition reached during dead-letter reconciliation',
            );
          }
          if (result.outcome === 'DELETE_EXHAUSTED') {
            this.logger.error(
              { deleteAttempt: 8, errorCode: 'EVIDENCE_DELETE_RETRY_EXHAUSTED', storeId },
              'Evidence deletion retries exhausted during dead-letter reconciliation',
            );
          }
          reconciled += 1;
        } catch {
          this.logger.warn(
            { errorCode: 'EVIDENCE_LIFECYCLE_DEAD_LETTER_RECONCILE_FAILED', storeId },
            'Evidence lifecycle dead-letter reconciliation failed',
          );
        }
      }
      if (reconciled > 0) {
        this.logger.info({ reconciled, storeId }, 'Evidence lifecycle dead letters reconciled');
      }
    } catch {
      this.logger.error(
        { errorCode: 'EVIDENCE_LIFECYCLE_DEAD_LETTER_STORE_POLL_FAILED', storeId },
        'Evidence lifecycle dead-letter store poll failed',
      );
    }
  }

  private requiredConfig(): Readonly<{
    deletionBaseDelayMs: number;
    deletionMaxAttempts: number;
    deletionMaxDelayMs: number;
  }> {
    const {
      AFTER_SALE_EVIDENCE_DELETE_MAX_ATTEMPTS: deletionMaxAttempts,
      AFTER_SALE_EVIDENCE_DELETE_RETRY_BASE_DELAY_MS: deletionBaseDelayMs,
      AFTER_SALE_EVIDENCE_DELETE_RETRY_MAX_DELAY_MS: deletionMaxDelayMs,
    } = this.config;
    if (
      deletionBaseDelayMs === undefined ||
      deletionMaxAttempts === undefined ||
      deletionMaxDelayMs === undefined
    ) {
      throw new Error('Evidence deletion retry configuration is unavailable');
    }
    return { deletionBaseDelayMs, deletionMaxAttempts, deletionMaxDelayMs };
  }
}
