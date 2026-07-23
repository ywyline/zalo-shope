import type { PrismaClient } from '@prisma/client';
import { transitionOrderStatus, type StoreContext } from '@zalo-shop/domain';

import { withStoreTransaction } from './index';

type ReconciliationRow = {
  id: string;
  reservation_status: 'CONSUMED' | 'EXPIRED' | 'RELEASED';
  status: 'PENDING_CONFIRMATION' | 'PENDING_PAYMENT';
};

export type OrderReconciliationResult = Readonly<{
  advanced: number;
  closed: number;
  scanned: number;
}>;

export function reconcileReservationBackedOrders(
  client: PrismaClient,
  context: StoreContext,
  limit = 100,
): Promise<OrderReconciliationResult> {
  const batchSize = Math.max(1, Math.min(500, Math.trunc(limit)));
  return withStoreTransaction(client, context, async (transaction) => {
    const rows = await transaction.$queryRaw<ReconciliationRow[]>`
      SELECT o.id, o.status, r.status AS reservation_status
      FROM orders o
      JOIN inventory_reservations r
        ON r.store_id = o.store_id AND r.id = o.reservation_id
      WHERE o.store_id = ${context.storeId}::uuid
        AND o.status IN ('PENDING_CONFIRMATION', 'PENDING_PAYMENT')
        AND r.status IN ('CONSUMED', 'EXPIRED', 'RELEASED')
      ORDER BY o.created_at, o.id
      FOR UPDATE OF o SKIP LOCKED
      LIMIT ${batchSize}
    `;
    let advanced = 0;
    let closed = 0;
    for (const row of rows) {
      const now = new Date();
      if (row.reservation_status === 'CONSUMED' && row.status === 'PENDING_CONFIRMATION') {
        const confirmedStatus = transitionOrderStatus(row.status, 'CONFIRM_COD');
        const fulfillmentStatus = transitionOrderStatus(confirmedStatus, 'FULFILLMENT_READY');
        const updated = await transaction.order.updateMany({
          data: { confirmedAt: now, status: fulfillmentStatus, version: { increment: 1 } },
          where: { id: row.id, status: row.status, storeId: context.storeId },
        });
        if (updated.count !== 1) continue;
        await transaction.orderTransition.createMany({
          data: [
            {
              actorId: context.actor.id,
              actorType: 'ADMIN',
              correlationId: context.correlationId,
              event: 'RECONCILE_CONSUMED_RESERVATION',
              fromStatus: row.status,
              orderId: row.id,
              reason: 'Reservation was consumed before order confirmation completed',
              storeId: context.storeId,
              toStatus: confirmedStatus,
            },
            {
              actorId: context.actor.id,
              actorType: 'ADMIN',
              correlationId: context.correlationId,
              event: 'FULFILLMENT_READY',
              fromStatus: confirmedStatus,
              orderId: row.id,
              reason: 'Reconciled from consumed reservation fact',
              storeId: context.storeId,
              toStatus: fulfillmentStatus,
            },
          ],
        });
        advanced += 1;
        continue;
      }
      if (row.reservation_status === 'CONSUMED') continue;
      const updated = await transaction.order.updateMany({
        data: {
          cancellationReason: `Inventory reservation ${row.reservation_status.toLowerCase()}`,
          closedAt: now,
          status: 'CLOSED',
          version: { increment: 1 },
        },
        where: { id: row.id, status: row.status, storeId: context.storeId },
      });
      if (updated.count !== 1) continue;
      await transaction.orderTransition.create({
        data: {
          actorId: context.actor.id,
          actorType: 'ADMIN',
          correlationId: context.correlationId,
          event: 'RESERVATION_TERMINATED',
          fromStatus: row.status,
          orderId: row.id,
          reason: `Inventory reservation ${row.reservation_status.toLowerCase()}`,
          storeId: context.storeId,
          toStatus: 'CLOSED',
        },
      });
      closed += 1;
    }
    return { advanced, closed, scanned: rows.length };
  });
}
