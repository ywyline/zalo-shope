import { createHmac } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import { createStoreContext, type StoreContext } from '@zalo-shop/domain';
import { describe, expect, it, vi } from 'vitest';

import {
  maskAfterSaleTrackingNumber,
  recordAfterSaleReturnFact,
  submitMemberAfterSaleReturn,
} from './after-sale-return-primitives';
import type { StoreTransaction } from './index';

const STORE_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_STORE_ID = '10000000-0000-4000-8000-000000000002';
const MEMBER_ID = '20000000-0000-4000-8000-000000000001';
const ADMIN_ID = '30000000-0000-4000-8000-000000000001';
const AFTER_SALE_ID = '40000000-0000-4000-8000-000000000001';
const OPERATION_ID = '50000000-0000-4000-8000-000000000001';
const SESSION_ID = '60000000-0000-4000-8000-000000000001';
const TRACKING_HASH_KEY = 'm63-b5-test-tracking-hash-key-32-bytes';
const TRACKING_NUMBER = 'GHN-RETURN-000012345678';

function context(
  input: {
    actorId?: string;
    actorType?: 'admin' | 'member';
    storeId?: string;
  } = {},
): StoreContext {
  const actorType = input.actorType ?? 'member';
  return createStoreContext({
    accessSessionExpiresAt: new Date('2099-08-01T12:30:00.000Z'),
    accessSessionId: SESSION_ID,
    accessTokenExpiresAt: new Date('2099-08-01T12:00:00.000Z'),
    ...(actorType === 'admin' ? { adminAuthorizationScope: 'STORE' as const } : {}),
    actor: {
      id: input.actorId ?? (actorType === 'admin' ? ADMIN_ID : MEMBER_ID),
      type: actorType,
    },
    correlationId: 'm63-b5-return-primitive-test',
    locale: 'vi',
    storeCode: 'beauty-local',
    storeId: input.storeId ?? STORE_ID,
  });
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    after_sale_id: AFTER_SALE_ID,
    operation_id: OPERATION_ID,
    public_case_number: 'ASC-M63B5RETURN0001',
    replayed: false,
    return_shipment_status: 'SUBMITTED',
    return_shipment_version: 1,
    status: 'RETURN_PENDING',
    version: 2,
    ...overrides,
  };
}

function clientFor(result = row()) {
  const queryRaw = vi.fn().mockResolvedValue([result]);
  const transaction = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: queryRaw,
  } as unknown as StoreTransaction;
  const transactionCall = vi.fn(async (callback: (value: StoreTransaction) => Promise<unknown>) =>
    callback(transaction),
  );
  return {
    client: { $transaction: transactionCall } as unknown as PrismaClient,
    queryRaw,
    transactionCall,
  };
}

function sqlValues(mock: ReturnType<typeof vi.fn>): readonly unknown[] {
  const query = mock.mock.calls[0]?.[0] as { values?: readonly unknown[] } | undefined;
  expect(query?.values).toBeDefined();
  return query?.values ?? [];
}

async function memberSqlValues(
  input: {
    actorId?: string;
    expectedVersion?: number;
    storeId?: string;
  } = {},
): Promise<readonly unknown[]> {
  const harness = clientFor();
  await submitMemberAfterSaleReturn(
    harness.client,
    context({ actorId: input.actorId, storeId: input.storeId }),
    {
      afterSaleId: AFTER_SALE_ID,
      body: {
        carrier_name: 'GHN',
        expected_version: input.expectedVersion ?? 1,
        tracking_number: TRACKING_NUMBER,
      },
      idempotencyKey: 'm63-b5-member-return-idempotency',
      sourceIp: '127.0.0.1',
      trackingHashKey: TRACKING_HASH_KEY,
    },
  );
  return sqlValues(harness.queryRaw);
}

describe('after-sale return primitives', () => {
  it('passes only a keyed tracking digest and a non-recoverable mask to SQL', async () => {
    const values = await memberSqlValues();
    const expectedDigest = createHmac('sha256', TRACKING_HASH_KEY)
      .update(TRACKING_NUMBER, 'utf8')
      .digest('hex');

    expect(values[5]).toBe('GHN');
    expect(values[6]).toBe(expectedDigest);
    expect(values[7]).toBe(maskAfterSaleTrackingNumber(TRACKING_NUMBER));
    expect(values).not.toContain(TRACKING_NUMBER);
    expect(JSON.stringify(values)).not.toContain(TRACKING_NUMBER);
    expect(String(values[7])).not.toContain('RETURN');
  });

  it('binds the canonical member request hash to actor, store, route and version', async () => {
    const base = await memberSqlValues();
    const actor = await memberSqlValues({
      actorId: '20000000-0000-4000-8000-000000000002',
    });
    const store = await memberSqlValues({ storeId: OTHER_STORE_ID });
    const version = await memberSqlValues({ expectedVersion: 2 });

    expect(base[3]).toMatch(/^[0-9a-f]{64}$/u);
    expect(new Set([base[3], actor[3], store[3], version[3]])).toHaveLength(4);
  });

  it('binds the admin fact hash to both versions and never returns the reason', async () => {
    const harness = clientFor(
      row({
        return_shipment_status: 'DELIVERED',
        return_shipment_version: 3,
        status: 'INSPECTION_PENDING',
        version: 4,
      }),
    );
    const reason = 'Carrier portal confirms delivery to the return warehouse.';
    await expect(
      recordAfterSaleReturnFact(harness.client, context({ actorType: 'admin' }), {
        afterSaleId: AFTER_SALE_ID,
        body: {
          confirmation_code: 'RECORD_RETURN_LOGISTICS_FACT',
          expected_return_shipment_version: 2,
          expected_version: 3,
          reason,
          status: 'DELIVERED',
        },
        idempotencyKey: 'm63-b5-admin-return-fact-idempotency',
        sourceIp: '127.0.0.1',
      }),
    ).resolves.toMatchObject({
      returnShipmentStatus: 'DELIVERED',
      returnShipmentVersion: 3,
      status: 'INSPECTION_PENDING',
      version: 4,
    });

    const values = sqlValues(harness.queryRaw);
    expect(values[3]).toMatch(/^[0-9a-f]{64}$/u);
    expect(values[4]).toBe(3);
    expect(values[5]).toBe(2);
    expect(values[7]).toBe(reason);
    expect(JSON.stringify(row({ status: 'INSPECTION_PENDING' }))).not.toContain(reason);
  });

  it('fails before SQL for an undersized HMAC key or a non-direct admin scope', async () => {
    const harness = clientFor();
    await expect(
      submitMemberAfterSaleReturn(harness.client, context(), {
        afterSaleId: AFTER_SALE_ID,
        body: {
          carrier_name: 'GHN',
          expected_version: 1,
          tracking_number: TRACKING_NUMBER,
        },
        idempotencyKey: 'm63-b5-member-return-idempotency',
        trackingHashKey: 'too-short',
      }),
    ).rejects.toMatchObject({ code: 'AFTER_SALE_INPUT_INVALID' });

    const crossAccessContext = {
      ...context({ actorType: 'admin' }),
      adminAuthorizationScope: 'CROSS_STORE',
    } as StoreContext;
    await expect(
      recordAfterSaleReturnFact(harness.client, crossAccessContext, {
        afterSaleId: AFTER_SALE_ID,
        body: {
          confirmation_code: 'RECORD_RETURN_LOGISTICS_FACT',
          expected_return_shipment_version: 1,
          expected_version: 2,
          reason: 'Carrier portal confirms the return is now in transit.',
          status: 'IN_TRANSIT',
        },
        idempotencyKey: 'm63-b5-admin-return-fact-idempotency',
      }),
    ).rejects.toMatchObject({ code: 'AFTER_SALE_AUTHORIZATION_DENIED' });
    expect(harness.queryRaw).not.toHaveBeenCalled();
  });

  it.each([
    ['carrier name', 'GH\u0000N', TRACKING_NUMBER],
    ['tracking number', 'GHN', `${TRACKING_NUMBER}\u007f`],
  ])(
    'rejects control characters in the %s before SQL',
    async (_field, carrierName, trackingNumber) => {
      const harness = clientFor();
      await expect(
        submitMemberAfterSaleReturn(harness.client, context(), {
          afterSaleId: AFTER_SALE_ID,
          body: {
            carrier_name: carrierName,
            expected_version: 1,
            tracking_number: trackingNumber,
          },
          idempotencyKey: 'm63-b5-member-return-idempotency',
          trackingHashKey: TRACKING_HASH_KEY,
        }),
      ).rejects.toMatchObject({ code: 'AFTER_SALE_INPUT_INVALID' });
      expect(harness.queryRaw).not.toHaveBeenCalled();
    },
  );
});
