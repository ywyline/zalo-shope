import { PrismaClient } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import type {
  AfterSaleEvidenceSystemContext,
  AfterSaleSystemContext,
  StoreContext,
} from '@zalo-shop/domain';

export * from '@prisma/client';

export type StoreTransaction = Prisma.TransactionClient;
export type StoreTransactionOptions = {
  isolationLevel?: Prisma.TransactionIsolationLevel;
  maxWait?: number;
  timeout?: number;
};

export function createRuntimePrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({
    datasourceUrl: databaseUrl,
  });
}

export async function withStoreTransaction<T>(
  client: PrismaClient,
  context: StoreContext,
  callback: (transaction: StoreTransaction) => Promise<T>,
  options?: StoreTransactionOptions,
): Promise<T> {
  return client.$transaction(async (transaction) => {
    await transaction.$executeRaw`
        SELECT
          set_config('app.store_id', ${context.storeId}, true),
          set_config('app.actor_id', ${context.actor.id}, true),
          set_config('app.actor_type', ${context.actor.type}, true),
          set_config('app.correlation_id', ${context.correlationId}, true),
          set_config('app.access_session_id', ${context.accessSessionId ?? ''}, true),
          set_config('app.access_token_expires_at', ${context.accessTokenExpiresAt ?? ''}, true),
          set_config(
            'app.admin_authorization_scope',
            ${context.adminAuthorizationScope ?? ''},
            true
          )
      `;
    return callback(transaction);
  }, options);
}

export async function withAfterSaleSystemTransaction<T>(
  client: PrismaClient,
  context: AfterSaleSystemContext,
  callback: (transaction: StoreTransaction) => Promise<T>,
  options?: StoreTransactionOptions,
): Promise<T> {
  return client.$transaction(async (transaction) => {
    await transaction.$executeRaw`
      SELECT
        set_config('app.store_id', ${context.storeId}, true),
        set_config('app.actor_id', ${context.actor.id}, true),
        set_config('app.actor_type', ${context.actor.type}, true),
        set_config('app.correlation_id', ${context.correlationId}, true),
        set_config('app.system_scope', ${context.systemScope}, true)
    `;
    return callback(transaction);
  }, options);
}

export async function withAfterSaleEvidenceSystemTransaction<T>(
  client: PrismaClient,
  context: AfterSaleEvidenceSystemContext,
  callback: (transaction: StoreTransaction) => Promise<T>,
  options?: StoreTransactionOptions,
): Promise<T> {
  return client.$transaction(async (transaction) => {
    await transaction.$executeRaw`
      SELECT
        set_config('app.store_id', ${context.storeId}, true),
        set_config('app.actor_id', ${context.actor.id}, true),
        set_config('app.actor_type', ${context.actor.type}, true),
        set_config('app.correlation_id', ${context.correlationId}, true),
        set_config('app.system_scope', ${context.systemScope}, true)
    `;
    return callback(transaction);
  }, options);
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
export * from './after-sale-policy-primitives';
export * from './after-sale-policy-management-primitives';
export * from './after-sale-evidence-primitives';
export * from './after-sale-command-primitives';
export * from './after-sale-review-primitives';
export * from './after-sale-return-primitives';
export * from './after-sale-refund-events';
export * from './after-sale-refund-primitives';
export * from './after-sale-cod-refund-primitives';
export * from './order-primitives';
export * from './payment-primitives';
export * from './payment-callback-primitives';
export * from './refund-primitives';
export * from './shipping-primitives';
export * from './shipping-callback-primitives';
export * from './financial-reconciliation-primitives';
export * from './cod-reconciliation-primitives';
export * from './financial-reconciliation-review-primitives';
export * from './search-projection';
export * from './reliable-messaging';
