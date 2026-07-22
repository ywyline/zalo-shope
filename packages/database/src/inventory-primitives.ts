import { createHash, randomUUID } from 'node:crypto';

import { Prisma, type PrismaClient } from '@prisma/client';
import {
  applyInventoryCommand,
  InventoryRuleError,
  sortInventoryLockTargets,
  transitionInventoryReservation,
  type InventoryMovementType,
  type StoreContext,
} from '@zalo-shop/domain';

import { withStoreTransaction, type StoreTransaction } from './index';

const OPERATION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;

export type InventoryPrimitiveErrorCode =
  | 'AVAILABLE_INSUFFICIENT'
  | 'EXPIRATION_NOT_DUE'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'INVENTORY_TARGET_NOT_FOUND'
  | 'INVENTORY_TARGET_DUPLICATED'
  | 'OPERATION_KEY_INVALID'
  | 'RESERVATION_NOT_FOUND'
  | 'RESERVATION_TRANSITION_INVALID'
  | 'VERSION_CONFLICT';

export class InventoryPrimitiveError extends Error {
  public constructor(public readonly code: InventoryPrimitiveErrorCode) {
    super(code);
    this.name = 'InventoryPrimitiveError';
  }
}

export type InventoryAdjustmentItem = Readonly<{
  delta: number;
  expectedVersion: number;
  note?: string | null;
  reasonCode: string;
  skuId: string;
  warehouseId: string;
}>;

export type InventoryReservationItemInput = Readonly<{
  quantity: number;
  skuId: string;
  warehouseId: string;
}>;

export type InventoryBalanceSnapshot = Readonly<{
  available: number;
  id: string;
  on_hand: number;
  reserved: number;
  sku_code: string;
  sku_id: string;
  updated_at: string;
  version: number;
  warehouse_id: string;
}>;

export type InventoryMovementSnapshot = Readonly<{
  balance_id: string;
  created_at: string;
  id: string;
  movement_type: InventoryMovementType;
  note: string | null;
  on_hand_after: number;
  on_hand_before: number;
  on_hand_delta: number;
  operation_id: string;
  reason_code: string;
  reserved_after: number;
  reserved_before: number;
  reserved_delta: number;
}>;

export type InventoryAdjustmentResult = Readonly<{
  balances: readonly InventoryBalanceSnapshot[];
  movements: readonly InventoryMovementSnapshot[];
  operation_id: string;
}>;

export type InventoryReservationResult = Readonly<{
  expires_at: string;
  items: readonly Readonly<{
    quantity: number;
    sku_id: string;
    warehouse_id: string;
  }>[];
  operation_id: string;
  reservation_id: string;
  status: 'ACTIVE' | 'CONSUMED' | 'EXPIRED' | 'RELEASED';
  terminal_at: string | null;
}>;

export type InventoryExecution<T> = Readonly<{ replayed: boolean; result: T }>;

type LockedBalance = {
  available: number;
  id: string;
  on_hand: number;
  reserved: number;
  sku_code: string;
  sku_id: string;
  updated_at: Date;
  version: number;
  warehouse_id: string;
};

type OperationRow = { request_hash: string; result_snapshot: unknown };

function assertOperationKey(operationKey: string): void {
  if (!OPERATION_KEY_PATTERN.test(operationKey)) {
    throw new InventoryPrimitiveError('OPERATION_KEY_INVALID');
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right, 'en'))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function inventoryRequestHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function mapRuleError(error: unknown): never {
  if (error instanceof InventoryRuleError) {
    if (error.code === 'AVAILABLE_INSUFFICIENT') {
      throw new InventoryPrimitiveError('AVAILABLE_INSUFFICIENT');
    }
    if (error.code === 'VERSION_CONFLICT') {
      throw new InventoryPrimitiveError('VERSION_CONFLICT');
    }
    if (error.code === 'RESERVATION_TRANSITION_INVALID') {
      throw new InventoryPrimitiveError('RESERVATION_TRANSITION_INVALID');
    }
  }
  throw error;
}

async function existingOperation<T>(
  transaction: StoreTransaction,
  storeId: string,
  operationKey: string,
  requestHash: string,
): Promise<T | undefined> {
  const rows = await transaction.$queryRaw<OperationRow[]>`
    SELECT request_hash, result_snapshot
    FROM inventory_operations
    WHERE store_id = ${storeId}::uuid AND operation_key = ${operationKey}
  `;
  const existing = rows[0];
  if (!existing) return undefined;
  if (existing.request_hash !== requestHash) {
    throw new InventoryPrimitiveError('IDEMPOTENCY_KEY_REUSED');
  }
  return existing.result_snapshot as T;
}

function lockTargetSql(targets: readonly Readonly<{ skuId: string; warehouseId: string }>[]) {
  return Prisma.join(
    targets.map((target) => Prisma.sql`(${target.warehouseId}::uuid, ${target.skuId}::uuid)`),
  );
}

async function lockBalances(
  transaction: StoreTransaction,
  storeId: string,
  targets: readonly Readonly<{ skuId: string; warehouseId: string }>[],
): Promise<LockedBalance[]> {
  if (targets.length === 0) return [];
  return transaction.$queryRaw<LockedBalance[]>(Prisma.sql`
    SELECT b.id, b.warehouse_id, b.sku_id, s.code AS sku_code,
      b.on_hand, b.reserved, b.available, b.version, b.updated_at
    FROM inventory_balances b
    JOIN skus s ON s.store_id = b.store_id AND s.id = b.sku_id
    WHERE b.store_id = ${storeId}::uuid
      AND (b.warehouse_id, b.sku_id) IN (${lockTargetSql(targets)})
    ORDER BY b.warehouse_id, b.sku_id
    FOR UPDATE OF b
  `);
}

function balanceSnapshot(
  row: LockedBalance,
  next?: {
    available: number;
    onHand: number;
    reserved: number;
    version: number;
  },
  updatedAt = row.updated_at,
): InventoryBalanceSnapshot {
  const value = next ?? {
    available: row.available,
    onHand: row.on_hand,
    reserved: row.reserved,
    version: row.version,
  };
  return {
    available: value.available,
    id: row.id,
    on_hand: value.onHand,
    reserved: value.reserved,
    sku_code: row.sku_code,
    sku_id: row.sku_id,
    updated_at: updatedAt.toISOString(),
    version: value.version,
    warehouse_id: row.warehouse_id,
  };
}

function targetKey(
  target: { skuId: string; warehouseId: string } | { sku_id: string; warehouse_id: string },
): string {
  const warehouseId = 'warehouseId' in target ? target.warehouseId : target.warehouse_id;
  const skuId = 'skuId' in target ? target.skuId : target.sku_id;
  return `${warehouseId}\u0000${skuId}`;
}

async function replayAfterConflict<T>(
  client: PrismaClient,
  context: StoreContext,
  operationKey: string,
  requestHash: string,
): Promise<T> {
  const replayed = await withStoreTransaction(client, context, (transaction) =>
    existingOperation<T>(transaction, context.storeId, operationKey, requestHash),
  );
  if (replayed === undefined) throw new InventoryPrimitiveError('VERSION_CONFLICT');
  return replayed;
}

function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export async function adjustInventory(
  client: PrismaClient,
  context: StoreContext,
  input: Readonly<{
    audit?: Readonly<{ action: string; targetType: string }>;
    items: readonly InventoryAdjustmentItem[];
    operationKey: string;
    operationType?: 'ADJUST' | 'IMPORT' | 'RESTORE';
  }>,
): Promise<InventoryExecution<InventoryAdjustmentResult>> {
  assertOperationKey(input.operationKey);
  const items = [...input.items].sort(
    (left, right) =>
      left.warehouseId.localeCompare(right.warehouseId, 'en') ||
      left.skuId.localeCompare(right.skuId, 'en'),
  );
  if (items.length === 0 || new Set(items.map(targetKey)).size !== items.length) {
    throw new InventoryPrimitiveError('INVENTORY_TARGET_DUPLICATED');
  }
  const operationType = input.operationType ?? 'ADJUST';
  const requestHash = inventoryRequestHash({ items, operationType });

  try {
    return await withStoreTransaction(client, context, async (transaction) => {
      const replayed = await existingOperation<InventoryAdjustmentResult>(
        transaction,
        context.storeId,
        input.operationKey,
        requestHash,
      );
      if (replayed) return { replayed: true, result: replayed };

      for (const item of items) {
        await transaction.$executeRaw`
          INSERT INTO inventory_balances (store_id, warehouse_id, sku_id, updated_at)
          SELECT ${context.storeId}::uuid, w.id, s.id, now()
          FROM warehouses w
          JOIN skus s ON s.store_id = w.store_id
          WHERE w.store_id = ${context.storeId}::uuid
            AND w.id = ${item.warehouseId}::uuid
            AND s.id = ${item.skuId}::uuid
          ON CONFLICT (store_id, warehouse_id, sku_id) DO NOTHING
        `;
      }

      const targets = items.map(({ skuId, warehouseId }) => ({ skuId, warehouseId }));
      const balances = await lockBalances(transaction, context.storeId, targets);
      if (balances.length !== items.length) {
        throw new InventoryPrimitiveError('INVENTORY_TARGET_NOT_FOUND');
      }
      const replayedAfterLock = await existingOperation<InventoryAdjustmentResult>(
        transaction,
        context.storeId,
        input.operationKey,
        requestHash,
      );
      if (replayedAfterLock) return { replayed: true, result: replayedAfterLock };

      const operationId = randomUUID();
      const createdAt = new Date();
      const projected = items.map((item) => {
        const current = balances.find((balance) => targetKey(balance) === targetKey(item));
        if (!current) throw new InventoryPrimitiveError('INVENTORY_TARGET_NOT_FOUND');
        try {
          const mutation = applyInventoryCommand(
            {
              available: current.available,
              onHand: current.on_hand,
              reserved: current.reserved,
              version: current.version,
            },
            { delta: item.delta, expectedVersion: item.expectedVersion, type: 'ADJUST' },
          );
          const movement: InventoryMovementSnapshot = {
            balance_id: current.id,
            created_at: createdAt.toISOString(),
            id: randomUUID(),
            movement_type: mutation.movement.type,
            note: item.note ?? null,
            on_hand_after: mutation.balance.onHand,
            on_hand_before: current.on_hand,
            on_hand_delta: mutation.movement.onHandDelta,
            operation_id: operationId,
            reason_code: item.reasonCode,
            reserved_after: mutation.balance.reserved,
            reserved_before: current.reserved,
            reserved_delta: mutation.movement.reservedDelta,
          };
          return { current, item, movement, next: mutation.balance };
        } catch (error) {
          mapRuleError(error);
        }
      });
      const result: InventoryAdjustmentResult = {
        balances: projected.map(({ current, next }) => balanceSnapshot(current, next, createdAt)),
        movements: projected.map(({ movement }) => movement),
        operation_id: operationId,
      };

      await transaction.inventoryOperation.create({
        data: {
          adminId: context.actor.type === 'admin' ? context.actor.id : null,
          id: operationId,
          operationKey: input.operationKey,
          operationType,
          requestHash,
          resultSnapshot: json(result),
          storeId: context.storeId,
        },
      });
      for (const { current, item, movement, next } of projected) {
        const updated = await transaction.inventoryBalance.updateMany({
          data: {
            onHand: next.onHand,
            reserved: next.reserved,
            updatedAt: createdAt,
            version: next.version,
          },
          where: { id: current.id, storeId: context.storeId, version: item.expectedVersion },
        });
        if (updated.count !== 1) throw new InventoryPrimitiveError('VERSION_CONFLICT');
        await transaction.inventoryMovement.create({
          data: {
            balanceId: current.id,
            createdAt,
            id: movement.id,
            movementType: movement.movement_type,
            note: movement.note,
            onHandAfter: movement.on_hand_after,
            onHandBefore: movement.on_hand_before,
            onHandDelta: movement.on_hand_delta,
            operationId,
            reasonCode: movement.reason_code,
            reservedAfter: movement.reserved_after,
            reservedBefore: movement.reserved_before,
            reservedDelta: movement.reserved_delta,
            storeId: context.storeId,
          },
        });
      }
      if (input.audit && context.actor.type === 'admin') {
        await transaction.auditLog.create({
          data: {
            action: input.audit.action,
            actorId: context.actor.id,
            actorType: 'ADMIN',
            afterData: json({
              ...result,
              movements: result.movements.map((movement) => ({ ...movement, note: null })),
            }),
            beforeData: json(projected.map(({ current }) => balanceSnapshot(current))),
            correlationId: context.correlationId,
            reason: context.accessReason,
            storeId: context.storeId,
            targetId: operationId,
            targetType: input.audit.targetType,
          },
        });
      }
      return { replayed: false, result };
    });
  } catch (error) {
    if (isUniqueConflict(error)) {
      return {
        replayed: true,
        result: await replayAfterConflict(client, context, input.operationKey, requestHash),
      };
    }
    throw error;
  }
}

export async function reserveInventory(
  client: PrismaClient,
  context: StoreContext,
  input: Readonly<{
    expiresAt: Date;
    items: readonly InventoryReservationItemInput[];
    operationKey: string;
    sourceId?: string;
    sourceType?: string;
  }>,
): Promise<InventoryExecution<InventoryReservationResult>> {
  assertOperationKey(input.operationKey);
  if (input.expiresAt.getTime() <= Date.now()) {
    throw new InventoryPrimitiveError('EXPIRATION_NOT_DUE');
  }
  let targets: readonly Readonly<{ skuId: string; warehouseId: string }>[];
  try {
    targets = sortInventoryLockTargets(input.items);
  } catch (error) {
    throw new InventoryPrimitiveError(
      error instanceof InventoryRuleError && error.code === 'LOCK_TARGET_DUPLICATED'
        ? 'INVENTORY_TARGET_DUPLICATED'
        : 'INVENTORY_TARGET_NOT_FOUND',
    );
  }
  const quantityByTarget = new Map(input.items.map((item) => [targetKey(item), item.quantity]));
  const normalizedItems = targets.map((target) => ({
    quantity: quantityByTarget.get(targetKey(target)) ?? 0,
    skuId: target.skuId,
    warehouseId: target.warehouseId,
  }));
  const requestHash = inventoryRequestHash({
    expiresAt: input.expiresAt.toISOString(),
    items: normalizedItems,
    sourceId: input.sourceId ?? null,
    sourceType: input.sourceType ?? null,
    type: 'RESERVE',
  });

  try {
    return await withStoreTransaction(client, context, async (transaction) => {
      const replayed = await existingOperation<InventoryReservationResult>(
        transaction,
        context.storeId,
        input.operationKey,
        requestHash,
      );
      if (replayed) return { replayed: true, result: replayed };
      const balances = await lockBalances(transaction, context.storeId, targets);
      if (balances.length !== targets.length) {
        throw new InventoryPrimitiveError('INVENTORY_TARGET_NOT_FOUND');
      }
      const replayedAfterLock = await existingOperation<InventoryReservationResult>(
        transaction,
        context.storeId,
        input.operationKey,
        requestHash,
      );
      if (replayedAfterLock) return { replayed: true, result: replayedAfterLock };

      const operationId = randomUUID();
      const reservationId = randomUUID();
      const createdAt = new Date();
      const projected = normalizedItems.map((item) => {
        const current = balances.find((balance) => targetKey(balance) === targetKey(item));
        if (!current) throw new InventoryPrimitiveError('INVENTORY_TARGET_NOT_FOUND');
        try {
          const mutation = applyInventoryCommand(
            {
              available: current.available,
              onHand: current.on_hand,
              reserved: current.reserved,
              version: current.version,
            },
            { expectedVersion: current.version, quantity: item.quantity, type: 'RESERVE' },
          );
          return {
            current,
            item,
            movementId: randomUUID(),
            next: mutation.balance,
            reservationItemId: randomUUID(),
          };
        } catch (error) {
          mapRuleError(error);
        }
      });
      const result: InventoryReservationResult = {
        expires_at: input.expiresAt.toISOString(),
        items: normalizedItems.map((item) => ({
          quantity: item.quantity,
          sku_id: item.skuId,
          warehouse_id: item.warehouseId,
        })),
        operation_id: operationId,
        reservation_id: reservationId,
        status: 'ACTIVE',
        terminal_at: null,
      };
      await transaction.inventoryOperation.create({
        data: {
          id: operationId,
          operationKey: input.operationKey,
          operationType: 'RESERVE',
          requestHash,
          resultSnapshot: json(result),
          sourceId: input.sourceId,
          sourceType: input.sourceType,
          storeId: context.storeId,
        },
      });
      await transaction.inventoryReservation.create({
        data: {
          expiresAt: input.expiresAt,
          id: reservationId,
          reservationKey: input.operationKey,
          sourceId: input.sourceId,
          sourceType: input.sourceType,
          storeId: context.storeId,
        },
      });
      for (const item of projected) {
        await transaction.inventoryReservationItem.create({
          data: {
            id: item.reservationItemId,
            quantity: item.item.quantity,
            reservationId,
            skuId: item.item.skuId,
            storeId: context.storeId,
            warehouseId: item.item.warehouseId,
          },
        });
        await transaction.inventoryBalance.update({
          data: {
            onHand: item.next.onHand,
            reserved: item.next.reserved,
            updatedAt: createdAt,
            version: item.next.version,
          },
          where: { storeId_id: { id: item.current.id, storeId: context.storeId } },
        });
        await transaction.inventoryMovement.create({
          data: {
            balanceId: item.current.id,
            createdAt,
            id: item.movementId,
            movementType: 'RESERVE',
            onHandAfter: item.next.onHand,
            onHandBefore: item.current.on_hand,
            onHandDelta: 0,
            operationId,
            reasonCode: 'RESERVATION_CREATED',
            reservationItemId: item.reservationItemId,
            reservedAfter: item.next.reserved,
            reservedBefore: item.current.reserved,
            reservedDelta: item.item.quantity,
            storeId: context.storeId,
          },
        });
      }
      return { replayed: false, result };
    });
  } catch (error) {
    if (isUniqueConflict(error)) {
      return {
        replayed: true,
        result: await replayAfterConflict(client, context, input.operationKey, requestHash),
      };
    }
    throw error;
  }
}

async function terminalReservation(
  client: PrismaClient,
  context: StoreContext,
  input: Readonly<{
    event: 'CONSUME' | 'EXPIRE' | 'RELEASE';
    operationKey: string;
    reservationId: string;
  }>,
): Promise<InventoryExecution<InventoryReservationResult>> {
  assertOperationKey(input.operationKey);
  const requestHash = inventoryRequestHash(input);
  const targetStatus = transitionInventoryReservation('ACTIVE', input.event);
  try {
    return await withStoreTransaction(client, context, async (transaction) => {
      const replayed = await existingOperation<InventoryReservationResult>(
        transaction,
        context.storeId,
        input.operationKey,
        requestHash,
      );
      if (replayed) return { replayed: true, result: replayed };
      const reservations = await transaction.$queryRaw<
        Array<{
          expires_at: Date;
          status: 'ACTIVE' | 'CONSUMED' | 'EXPIRED' | 'RELEASED';
          terminal_operation_id: string | null;
        }>
      >`
        SELECT status, expires_at, terminal_operation_id
        FROM inventory_reservations
        WHERE store_id = ${context.storeId}::uuid AND id = ${input.reservationId}::uuid
        FOR UPDATE
      `;
      const reservation = reservations[0];
      if (!reservation) throw new InventoryPrimitiveError('RESERVATION_NOT_FOUND');
      if (reservation.status !== 'ACTIVE') {
        if (reservation.status !== targetStatus) {
          throw new InventoryPrimitiveError('RESERVATION_TRANSITION_INVALID');
        }
        if (!reservation.terminal_operation_id) {
          throw new InventoryPrimitiveError('RESERVATION_TRANSITION_INVALID');
        }
        const terminal = await transaction.inventoryOperation.findUnique({
          where: {
            storeId_id: { id: reservation.terminal_operation_id, storeId: context.storeId },
          },
        });
        if (!terminal) throw new InventoryPrimitiveError('RESERVATION_TRANSITION_INVALID');
        const result = terminal.resultSnapshot as unknown as InventoryReservationResult;
        // A same-state retry with a new key has no inventory effect, but the
        // successful key must still be bound to this request. Otherwise that
        // key could later mutate a different reservation in the same store.
        await transaction.inventoryOperation.create({
          data: {
            id: randomUUID(),
            operationKey: input.operationKey,
            operationType: input.event,
            requestHash,
            resultSnapshot: json(result),
            storeId: context.storeId,
          },
        });
        return {
          replayed: true,
          result,
        };
      }
      if (input.event === 'EXPIRE' && reservation.expires_at.getTime() > Date.now()) {
        throw new InventoryPrimitiveError('EXPIRATION_NOT_DUE');
      }
      const reservationItems = await transaction.inventoryReservationItem.findMany({
        orderBy: [{ warehouseId: 'asc' }, { skuId: 'asc' }],
        where: { reservationId: input.reservationId, storeId: context.storeId },
      });
      const targets = reservationItems.map(({ skuId, warehouseId }) => ({ skuId, warehouseId }));
      const balances = await lockBalances(transaction, context.storeId, targets);
      if (balances.length !== targets.length) {
        throw new InventoryPrimitiveError('INVENTORY_TARGET_NOT_FOUND');
      }
      const replayedAfterLock = await existingOperation<InventoryReservationResult>(
        transaction,
        context.storeId,
        input.operationKey,
        requestHash,
      );
      if (replayedAfterLock) return { replayed: true, result: replayedAfterLock };

      const operationId = randomUUID();
      const terminalAt = new Date();
      const projected = reservationItems.map((item) => {
        const current = balances.find((balance) => targetKey(balance) === targetKey(item));
        if (!current) throw new InventoryPrimitiveError('INVENTORY_TARGET_NOT_FOUND');
        try {
          const mutation = applyInventoryCommand(
            {
              available: current.available,
              onHand: current.on_hand,
              reserved: current.reserved,
              version: current.version,
            },
            {
              expectedVersion: current.version,
              quantity: item.quantity,
              type: input.event === 'CONSUME' ? 'CONSUME' : 'RELEASE',
            },
          );
          return { current, item, movementId: randomUUID(), next: mutation.balance };
        } catch (error) {
          mapRuleError(error);
        }
      });
      const result: InventoryReservationResult = {
        expires_at: reservation.expires_at.toISOString(),
        items: reservationItems.map((item) => ({
          quantity: item.quantity,
          sku_id: item.skuId,
          warehouse_id: item.warehouseId,
        })),
        operation_id: operationId,
        reservation_id: input.reservationId,
        status: targetStatus,
        terminal_at: terminalAt.toISOString(),
      };
      await transaction.inventoryOperation.create({
        data: {
          id: operationId,
          operationKey: input.operationKey,
          operationType: input.event,
          requestHash,
          resultSnapshot: json(result),
          storeId: context.storeId,
        },
      });
      for (const item of projected) {
        await transaction.inventoryBalance.update({
          data: {
            onHand: item.next.onHand,
            reserved: item.next.reserved,
            updatedAt: terminalAt,
            version: item.next.version,
          },
          where: { storeId_id: { id: item.current.id, storeId: context.storeId } },
        });
        await transaction.inventoryMovement.create({
          data: {
            balanceId: item.current.id,
            createdAt: terminalAt,
            id: item.movementId,
            movementType: input.event === 'CONSUME' ? 'CONSUME' : 'RELEASE',
            onHandAfter: item.next.onHand,
            onHandBefore: item.current.on_hand,
            onHandDelta: item.next.onHand - item.current.on_hand,
            operationId,
            reasonCode: `RESERVATION_${targetStatus}`,
            reservationItemId: item.item.id,
            reservedAfter: item.next.reserved,
            reservedBefore: item.current.reserved,
            reservedDelta: item.next.reserved - item.current.reserved,
            storeId: context.storeId,
          },
        });
      }
      await transaction.inventoryReservation.update({
        data: { status: targetStatus, terminalAt, terminalOperationId: operationId },
        where: { storeId_id: { id: input.reservationId, storeId: context.storeId } },
      });
      return { replayed: false, result };
    });
  } catch (error) {
    if (isUniqueConflict(error)) {
      return {
        replayed: true,
        result: await replayAfterConflict(client, context, input.operationKey, requestHash),
      };
    }
    throw error;
  }
}

export function releaseReservation(
  client: PrismaClient,
  context: StoreContext,
  reservationId: string,
  operationKey: string,
): Promise<InventoryExecution<InventoryReservationResult>> {
  return terminalReservation(client, context, {
    event: 'RELEASE',
    operationKey,
    reservationId,
  });
}

export function consumeReservation(
  client: PrismaClient,
  context: StoreContext,
  reservationId: string,
  operationKey: string,
): Promise<InventoryExecution<InventoryReservationResult>> {
  return terminalReservation(client, context, {
    event: 'CONSUME',
    operationKey,
    reservationId,
  });
}

export function expireReservation(
  client: PrismaClient,
  context: StoreContext,
  reservationId: string,
  operationKey = `expire:${reservationId}`,
): Promise<InventoryExecution<InventoryReservationResult>> {
  return terminalReservation(client, context, {
    event: 'EXPIRE',
    operationKey,
    reservationId,
  });
}

export async function expireDueReservations(
  client: PrismaClient,
  context: StoreContext,
  limit = 100,
): Promise<Readonly<{ expired: number; failed: number; scanned: number }>> {
  const reservationIds = await withStoreTransaction(client, context, (transaction) =>
    transaction.inventoryReservation.findMany({
      orderBy: [
        { lastExpirationFailedAt: { nulls: 'first', sort: 'asc' } },
        { expiresAt: 'asc' },
        { id: 'asc' },
      ],
      select: { id: true },
      take: Math.max(1, Math.min(limit, 500)),
      where: { expiresAt: { lte: new Date() }, status: 'ACTIVE', storeId: context.storeId },
    }),
  );
  let expired = 0;
  let failed = 0;
  for (const reservation of reservationIds) {
    try {
      const execution = await expireReservation(client, context, reservation.id);
      if (execution.result.status === 'EXPIRED' && !execution.replayed) expired += 1;
    } catch (error) {
      failed += 1;
      const errorCode = error instanceof InventoryPrimitiveError ? error.code : 'UNEXPECTED';
      try {
        await withStoreTransaction(client, context, (transaction) =>
          transaction.inventoryReservation.updateMany({
            data: {
              expirationFailureCount: { increment: 1 },
              lastExpirationErrorCode: errorCode,
              lastExpirationFailedAt: new Date(),
            },
            where: { id: reservation.id, status: 'ACTIVE', storeId: context.storeId },
          }),
        );
      } catch {
        // The next worker run retries the immutable reservation even if recording fails.
      }
    }
  }
  return { expired, failed, scanned: reservationIds.length };
}
