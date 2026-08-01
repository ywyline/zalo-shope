import { vi } from 'vitest';

const databaseMocks = vi.hoisted(() => ({ sync: vi.fn() }));

vi.mock('@zalo-shop/database', async () => {
  const actual: Record<string, unknown> = await vi.importActual('@zalo-shop/database');
  return { ...actual, syncAfterSaleRefund: databaseMocks.sync };
});

import type { OutboxMessageRecord } from '@zalo-shop/database';
import { beforeEach, describe, expect, it } from 'vitest';

import { AfterSaleRefundSyncHandler } from './after-sale-refund-sync.handler';

const storeId = '10000000-0000-4000-8000-000000000001';
const refundId = '41000000-0000-4000-8000-000000000001';

function message(input: Partial<OutboxMessageRecord> = {}): OutboxMessageRecord {
  return {
    aggregateId: refundId,
    aggregateType: 'REFUND',
    attemptCount: 1,
    availableAt: new Date('2026-07-31T00:00:00.000Z'),
    completedAt: null,
    eventType: 'after-sale.refund.sync',
    eventVersion: 1,
    id: '42000000-0000-4000-8000-000000000001',
    idempotencyKey: `after-sale.refund.sync:${refundId}:3`,
    lastErrorCode: null,
    leaseExpiresAt: new Date('2026-07-31T00:01:00.000Z'),
    leaseOwner: 'worker-test',
    maxAttempts: 8,
    payload: { refund_id: refundId, refund_version: 3, store_id: storeId },
    status: 'PROCESSING',
    storeId,
    version: 2,
    ...input,
  };
}

describe('AfterSaleRefundSyncHandler', () => {
  beforeEach(() => databaseMocks.sync.mockReset().mockResolvedValue(undefined));

  it('binds the exact store, refund and version identity to the sync primitive', async () => {
    const handler = new AfterSaleRefundSyncHandler({} as never);

    await expect(handler.handle(message())).resolves.toBeUndefined();
    expect(databaseMocks.sync).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actor: expect.objectContaining({ type: 'admin' }),
        storeId,
      }),
      { refundId, refundVersion: 3 },
    );
  });

  it.each([
    { refund_id: refundId, refund_version: 3, store_id: 'other' },
    { refund_id: refundId, refund_version: 0, store_id: storeId },
    { extra: true, refund_id: refundId, refund_version: 3, store_id: storeId },
  ])('rejects malformed or widened payloads permanently', async (invalidPayload) => {
    const handler = new AfterSaleRefundSyncHandler({} as never);

    await expect(handler.handle(message({ payload: invalidPayload }))).rejects.toMatchObject({
      code: 'AFTER_SALE_REFUND_SYNC_PAYLOAD_INVALID',
      disposition: 'PERMANENT',
    });
    expect(databaseMocks.sync).not.toHaveBeenCalled();
  });
});
