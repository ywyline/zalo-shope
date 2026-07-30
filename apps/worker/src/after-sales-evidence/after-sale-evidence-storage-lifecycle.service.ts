import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { AfterSaleEvidenceObjectStorageProvider } from '@zalo-shop/integrations';

import { WORKER_AFTER_SALE_EVIDENCE_STORAGE } from '../worker.tokens';

@Injectable()
export class AfterSaleEvidenceStorageLifecycleService implements OnApplicationShutdown {
  public constructor(
    @Inject(WORKER_AFTER_SALE_EVIDENCE_STORAGE)
    private readonly storage: AfterSaleEvidenceObjectStorageProvider | null,
  ) {}

  public onApplicationShutdown(): void {
    this.storage?.destroy();
  }
}
