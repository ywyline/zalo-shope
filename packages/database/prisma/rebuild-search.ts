import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { createStoreContext } from '@zalo-shop/domain';

import {
  createRuntimePrismaClient,
  rebuildStoreSearchProjection,
  withStoreTransaction,
} from '../src';

const databaseUrl = process.env.DATABASE_RUNTIME_URL;
const storeCode = process.env.SEARCH_REBUILD_STORE_CODE?.trim();
const actorId = process.env.SEARCH_REBUILD_ACTOR_ID?.trim();

if (!databaseUrl || !storeCode || !actorId) {
  throw new Error(
    'DATABASE_RUNTIME_URL, SEARCH_REBUILD_STORE_CODE and SEARCH_REBUILD_ACTOR_ID are required',
  );
}
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(actorId)) {
  throw new Error('SEARCH_REBUILD_ACTOR_ID must be a UUID');
}

const database = createRuntimePrismaClient(databaseUrl);

async function main(): Promise<void> {
  const stores = await database.$queryRaw<
    Array<{ code: string; default_locale: 'en' | 'vi' | 'zh'; id: string }>
  >`
    SELECT * FROM app_security.resolve_active_store(${storeCode})
  `;
  const store = stores[0];
  if (!store) throw new Error('Active store was not found');
  const correlationId = randomUUID();
  const context = createStoreContext({
    accessReason: 'search projection rebuild',
    actor: { id: actorId!, type: 'admin' },
    correlationId,
    locale: store.default_locale,
    storeCode: store.code,
    storeId: store.id,
  });
  const result = await withStoreTransaction(database, context, async (transaction) => {
    const beforeCount = await transaction.productSearchDocument.count({
      where: { storeId: store.id },
    });
    const rebuilt = await rebuildStoreSearchProjection(transaction, store.id);
    await transaction.auditLog.create({
      data: {
        action: 'search.projection.rebuilt',
        actorId: actorId!,
        actorType: 'ADMIN',
        afterData: rebuilt,
        beforeData: { document_count: beforeCount },
        correlationId,
        reason: 'Explicit per-store recovery command',
        storeId: store.id,
        targetId: store.id,
        targetType: 'search_projection',
      },
    });
    return rebuilt;
  });
  process.stdout.write(
    `${JSON.stringify({ correlation_id: correlationId, store: store.code, ...result })}\n`,
  );
}

void main().finally(() => database.$disconnect());
