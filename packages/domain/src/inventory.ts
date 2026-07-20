export const MAX_INVENTORY_QUANTITY = 2_147_483_647;

export type InventoryRuleErrorCode =
  | 'AVAILABLE_INSUFFICIENT'
  | 'BALANCE_INVALID'
  | 'LOCK_TARGET_DUPLICATED'
  | 'LOCK_TARGET_INVALID'
  | 'QUANTITY_INVALID'
  | 'QUANTITY_OVERFLOW'
  | 'RESERVATION_TRANSITION_INVALID'
  | 'RESERVED_INSUFFICIENT'
  | 'VERSION_CONFLICT';

export class InventoryRuleError extends Error {
  public constructor(public readonly code: InventoryRuleErrorCode) {
    super(code);
    this.name = 'InventoryRuleError';
  }
}

export type InventoryBalance = Readonly<{
  available: number;
  onHand: number;
  reserved: number;
  version: number;
}>;

export type InventoryCommand =
  | Readonly<{ delta: number; expectedVersion: number; type: 'ADJUST' }>
  | Readonly<{ expectedVersion: number; quantity: number; type: 'CONSUME' }>
  | Readonly<{ expectedVersion: number; quantity: number; type: 'RELEASE' }>
  | Readonly<{ expectedVersion: number; quantity: number; type: 'RESERVE' }>
  | Readonly<{ expectedVersion: number; quantity: number; type: 'RESTORE' }>;

export type InventoryMovementType =
  'ADJUSTMENT_IN' | 'ADJUSTMENT_OUT' | 'CONSUME' | 'RELEASE' | 'RESERVE' | 'RESTORE';

export type InventoryMutation = Readonly<{
  balance: InventoryBalance;
  movement: Readonly<{
    onHandDelta: number;
    reservedDelta: number;
    type: InventoryMovementType;
  }>;
}>;

function isInventoryInteger(value: number): boolean {
  return Number.isSafeInteger(value) && Math.abs(value) <= MAX_INVENTORY_QUANTITY;
}

function positiveQuantity(value: number): number {
  if (!isInventoryInteger(value) || value <= 0) {
    throw new InventoryRuleError('QUANTITY_INVALID');
  }
  return value;
}

export function projectInventoryBalance(input: {
  onHand: number;
  reserved: number;
  version: number;
}): InventoryBalance {
  if (
    !isInventoryInteger(input.onHand) ||
    !isInventoryInteger(input.reserved) ||
    input.onHand < 0 ||
    input.reserved < 0 ||
    input.reserved > input.onHand ||
    !Number.isSafeInteger(input.version) ||
    input.version < 1
  ) {
    throw new InventoryRuleError('BALANCE_INVALID');
  }
  return Object.freeze({
    available: input.onHand - input.reserved,
    onHand: input.onHand,
    reserved: input.reserved,
    version: input.version,
  });
}

function nextBalance(
  balance: InventoryBalance,
  onHandDelta: number,
  reservedDelta: number,
): InventoryBalance {
  if (
    balance.onHand + onHandDelta > MAX_INVENTORY_QUANTITY ||
    balance.reserved + reservedDelta > MAX_INVENTORY_QUANTITY
  ) {
    throw new InventoryRuleError('QUANTITY_OVERFLOW');
  }
  return projectInventoryBalance({
    onHand: balance.onHand + onHandDelta,
    reserved: balance.reserved + reservedDelta,
    version: balance.version + 1,
  });
}

export function applyInventoryCommand(
  current: InventoryBalance,
  command: InventoryCommand,
): InventoryMutation {
  const balance = projectInventoryBalance(current);
  if (
    !Number.isSafeInteger(command.expectedVersion) ||
    command.expectedVersion !== balance.version
  ) {
    throw new InventoryRuleError('VERSION_CONFLICT');
  }

  let onHandDelta = 0;
  let reservedDelta = 0;
  let type: InventoryMovementType;

  switch (command.type) {
    case 'ADJUST': {
      if (!isInventoryInteger(command.delta) || command.delta === 0) {
        throw new InventoryRuleError('QUANTITY_INVALID');
      }
      if (balance.onHand + command.delta < balance.reserved) {
        throw new InventoryRuleError('AVAILABLE_INSUFFICIENT');
      }
      onHandDelta = command.delta;
      type = command.delta > 0 ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT';
      break;
    }
    case 'RESERVE': {
      const quantity = positiveQuantity(command.quantity);
      if (quantity > balance.available) {
        throw new InventoryRuleError('AVAILABLE_INSUFFICIENT');
      }
      reservedDelta = quantity;
      type = 'RESERVE';
      break;
    }
    case 'RELEASE': {
      const quantity = positiveQuantity(command.quantity);
      if (quantity > balance.reserved) {
        throw new InventoryRuleError('RESERVED_INSUFFICIENT');
      }
      reservedDelta = -quantity;
      type = 'RELEASE';
      break;
    }
    case 'CONSUME': {
      const quantity = positiveQuantity(command.quantity);
      if (quantity > balance.reserved) {
        throw new InventoryRuleError('RESERVED_INSUFFICIENT');
      }
      onHandDelta = -quantity;
      reservedDelta = -quantity;
      type = 'CONSUME';
      break;
    }
    case 'RESTORE': {
      const quantity = positiveQuantity(command.quantity);
      onHandDelta = quantity;
      type = 'RESTORE';
      break;
    }
  }

  const projected = nextBalance(balance, onHandDelta, reservedDelta);

  return Object.freeze({
    balance: projected,
    movement: Object.freeze({ onHandDelta, reservedDelta, type }),
  });
}

export type InventoryReservationStatus = 'ACTIVE' | 'CONSUMED' | 'EXPIRED' | 'RELEASED';
export type InventoryReservationEvent = 'CONSUME' | 'EXPIRE' | 'RELEASE';

const RESERVATION_TARGETS: Readonly<
  Record<InventoryReservationEvent, Exclude<InventoryReservationStatus, 'ACTIVE'>>
> = Object.freeze({
  CONSUME: 'CONSUMED',
  EXPIRE: 'EXPIRED',
  RELEASE: 'RELEASED',
});

export function transitionInventoryReservation(
  current: InventoryReservationStatus,
  event: InventoryReservationEvent,
): InventoryReservationStatus {
  const target = RESERVATION_TARGETS[event];
  if (current === 'ACTIVE') return target;
  if (current === target) return current;
  throw new InventoryRuleError('RESERVATION_TRANSITION_INVALID');
}

export type InventoryLockTarget = Readonly<{ skuId: string; warehouseId: string }>;

function lockIdentifier(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 128) {
    throw new InventoryRuleError('LOCK_TARGET_INVALID');
  }
  return normalized;
}

export function sortInventoryLockTargets(
  targets: readonly InventoryLockTarget[],
): readonly InventoryLockTarget[] {
  const normalized = targets.map((target) =>
    Object.freeze({
      skuId: lockIdentifier(target.skuId),
      warehouseId: lockIdentifier(target.warehouseId),
    }),
  );
  const keys = normalized.map((target) => `${target.warehouseId}\u0000${target.skuId}`);
  if (new Set(keys).size !== keys.length) {
    throw new InventoryRuleError('LOCK_TARGET_DUPLICATED');
  }
  return Object.freeze(
    [...normalized].sort(
      (left, right) =>
        left.warehouseId.localeCompare(right.warehouseId, 'en') ||
        left.skuId.localeCompare(right.skuId, 'en'),
    ),
  );
}
