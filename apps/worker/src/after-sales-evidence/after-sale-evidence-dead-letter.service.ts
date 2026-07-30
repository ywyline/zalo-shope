import { randomUUID } from 'node:crypto';

import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { RuntimeConfig } from '@zalo-shop/config';
import {
  listAfterSaleEvidenceScanDeadLetterCandidates,
  reconcileAfterSaleEvidenceScanDeadLetter,
  type PrismaClient,
} from '@zalo-shop/database';
import { createAfterSaleEvidenceSystemContext } from '@zalo-shop/domain';
import { createLogger } from '@zalo-shop/logger';

import { RUNTIME_CONFIG } from '../health.controller';
import { WORKER_DATABASE_CLIENT } from '../worker.tokens';

type StoreRegistryEntry = Readonly<{ id: string }>;

@Injectable()
export class AfterSaleEvidenceDeadLetterService implements OnModuleDestroy, OnModuleInit {
  private activeRun?: Promise<void>;
  private readonly logger;
  private stopping = false;
  private timer?: ReturnType<typeof setInterval>;

  public constructor(
    @Inject(WORKER_DATABASE_CLIENT) private readonly database: PrismaClient,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
  ) {
    this.logger = createLogger('evidence-scan-dead-letter-reconciler', config.LOG_LEVEL);
  }

  public onModuleInit(): void {
    if (this.config.EVIDENCE_SCANNER_PROVIDER !== 'clamav') return;
    void this.runOnce();
    this.timer = setInterval(
      () => void this.runOnce(),
      this.config.EVIDENCE_SCANNER_DEAD_LETTER_INTERVAL_MS,
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
    if (this.stopping || this.activeRun || this.config.EVIDENCE_SCANNER_PROVIDER !== 'clamav') {
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
        { errorCode: 'EVIDENCE_SCAN_DEAD_LETTER_POLL_FAILED' },
        'Evidence scan dead-letter poll failed',
      );
    }
  }

  private async runStore(storeId: string): Promise<void> {
    const context = createAfterSaleEvidenceSystemContext({
      correlationId: randomUUID(),
      storeId,
    });
    try {
      const candidates = await listAfterSaleEvidenceScanDeadLetterCandidates(
        this.database,
        context,
        { batchSize: this.config.EVIDENCE_SCANNER_DEAD_LETTER_BATCH_SIZE },
      );
      let reconciled = 0;
      for (const candidate of candidates) {
        if (this.stopping) break;
        try {
          await reconcileAfterSaleEvidenceScanDeadLetter(this.database, context, {
            messageId: candidate.messageId,
            scanFailedRetentionSeconds: this.requiredRetentionSeconds(),
          });
          reconciled += 1;
        } catch {
          this.logger.warn(
            { errorCode: 'EVIDENCE_SCAN_DEAD_LETTER_RECONCILE_FAILED', storeId },
            'Evidence scan dead-letter reconciliation failed',
          );
        }
      }
      if (reconciled > 0) {
        this.logger.info({ reconciled, storeId }, 'Evidence scan dead letters reconciled');
      }
    } catch {
      this.logger.error(
        { errorCode: 'EVIDENCE_SCAN_DEAD_LETTER_STORE_POLL_FAILED', storeId },
        'Evidence scan dead-letter store poll failed',
      );
    }
  }

  private requiredRetentionSeconds(): number {
    const value = this.config.AFTER_SALE_EVIDENCE_FAILED_RETENTION_SECONDS;
    if (value === undefined) throw new Error('Evidence scan retention is unavailable');
    return value;
  }
}
