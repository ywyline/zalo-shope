import { PrismaClient } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import type { StoreContext } from '@zalo-shop/domain';

export * from '@prisma/client';

export type StoreTransaction = Prisma.TransactionClient;

export function createRuntimePrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({
    datasourceUrl: databaseUrl,
  });
}

export async function withStoreTransaction<T>(
  client: PrismaClient,
  context: StoreContext,
  callback: (transaction: StoreTransaction) => Promise<T>,
): Promise<T> {
  return client.$transaction(async (transaction) => {
    await transaction.$executeRaw`
      SELECT
        set_config('app.store_id', ${context.storeId}, true),
        set_config('app.actor_id', ${context.actor.id}, true),
        set_config('app.actor_type', ${context.actor.type}, true),
        set_config('app.correlation_id', ${context.correlationId}, true)
    `;
    return callback(transaction);
  });
}

export async function withPlatformAuditTransaction<T>(
  client: PrismaClient,
  actorId: string,
  correlationId: string,
  callback: (transaction: StoreTransaction) => Promise<T>,
): Promise<T> {
  return client.$transaction(async (transaction) => {
    await transaction.$executeRaw`
      SELECT
        set_config('app.actor_id', ${actorId}, true),
        set_config('app.actor_type', 'admin', true),
        set_config('app.correlation_id', ${correlationId}, true),
        set_config('app.platform_authorized', 'true', true)
    `;
    return callback(transaction);
  });
}

export async function withAdminAssignmentDiscoveryTransaction<T>(
  client: PrismaClient,
  adminId: string,
  callback: (transaction: StoreTransaction) => Promise<T>,
): Promise<T> {
  return client.$transaction(async (transaction) => {
    await transaction.$executeRaw`
      SELECT
        set_config('app.actor_id', ${adminId}, true),
        set_config('app.actor_type', 'admin', true)
    `;
    return callback(transaction);
  });
}

export * from './inventory-primitives';
