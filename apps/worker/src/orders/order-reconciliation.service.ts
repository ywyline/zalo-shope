import { Inject, Injectable } from '@nestjs/common';
import { reconcileReservationBackedOrders, type PrismaClient } from '@zalo-shop/database';
import type { StoreContext } from '@zalo-shop/domain';

import { WORKER_DATABASE_CLIENT } from '../worker.tokens';

@Injectable()
export class OrderReconciliationService {
  public constructor(@Inject(WORKER_DATABASE_CLIENT) private readonly database: PrismaClient) {}

  public runStore(context: StoreContext) {
    return reconcileReservationBackedOrders(this.database, context, 100);
  }
}
