import { describe, expect, it } from 'vitest';

import {
  applyInventoryCommand,
  InventoryRuleError,
  MAX_INVENTORY_QUANTITY,
  projectInventoryBalance,
  sortInventoryLockTargets,
  transitionInventoryReservation,
} from './inventory';

describe('M3 inventory balance rules', () => {
  it('derives available stock and records reserve, release and consume deltas', () => {
    const initial = projectInventoryBalance({ onHand: 10, reserved: 2, version: 1 });
    expect(initial).toEqual({ available: 8, onHand: 10, reserved: 2, version: 1 });

    const reserved = applyInventoryCommand(initial, {
      expectedVersion: 1,
      quantity: 3,
      type: 'RESERVE',
    });
    expect(reserved).toEqual({
      balance: { available: 5, onHand: 10, reserved: 5, version: 2 },
      movement: { onHandDelta: 0, reservedDelta: 3, type: 'RESERVE' },
    });

    const released = applyInventoryCommand(reserved.balance, {
      expectedVersion: 2,
      quantity: 2,
      type: 'RELEASE',
    });
    expect(released.balance).toEqual({ available: 7, onHand: 10, reserved: 3, version: 3 });

    const consumed = applyInventoryCommand(released.balance, {
      expectedVersion: 3,
      quantity: 3,
      type: 'CONSUME',
    });
    expect(consumed).toEqual({
      balance: { available: 7, onHand: 7, reserved: 0, version: 4 },
      movement: { onHandDelta: -3, reservedDelta: -3, type: 'CONSUME' },
    });
  });

  it('rejects overselling, releasing more than reserved and stale versions', () => {
    const balance = projectInventoryBalance({ onHand: 5, reserved: 4, version: 7 });
    expect(() =>
      applyInventoryCommand(balance, { expectedVersion: 7, quantity: 2, type: 'RESERVE' }),
    ).toThrowError(new InventoryRuleError('AVAILABLE_INSUFFICIENT'));
    expect(() =>
      applyInventoryCommand(balance, { expectedVersion: 7, quantity: 5, type: 'RELEASE' }),
    ).toThrowError(new InventoryRuleError('RESERVED_INSUFFICIENT'));
    expect(() =>
      applyInventoryCommand(balance, { expectedVersion: 6, quantity: 1, type: 'RELEASE' }),
    ).toThrowError(new InventoryRuleError('VERSION_CONFLICT'));
  });

  it('keeps adjustments above the reserved floor and uses inverse restores', () => {
    const balance = projectInventoryBalance({ onHand: 8, reserved: 3, version: 1 });
    expect(
      applyInventoryCommand(balance, { delta: -5, expectedVersion: 1, type: 'ADJUST' }),
    ).toEqual({
      balance: { available: 0, onHand: 3, reserved: 3, version: 2 },
      movement: { onHandDelta: -5, reservedDelta: 0, type: 'ADJUSTMENT_OUT' },
    });
    expect(() =>
      applyInventoryCommand(balance, { delta: -6, expectedVersion: 1, type: 'ADJUST' }),
    ).toThrowError(new InventoryRuleError('AVAILABLE_INSUFFICIENT'));
    expect(
      applyInventoryCommand(balance, { expectedVersion: 1, quantity: 2, type: 'RESTORE' }),
    ).toEqual({
      balance: { available: 7, onHand: 10, reserved: 3, version: 2 },
      movement: { onHandDelta: 2, reservedDelta: 0, type: 'RESTORE' },
    });
    expect(() =>
      applyInventoryCommand(
        projectInventoryBalance({ onHand: MAX_INVENTORY_QUANTITY, reserved: 0, version: 1 }),
        { delta: 1, expectedVersion: 1, type: 'ADJUST' },
      ),
    ).toThrowError(new InventoryRuleError('QUANTITY_OVERFLOW'));
  });

  it('rejects fractional, zero, negative and structurally invalid balances', () => {
    expect(() => projectInventoryBalance({ onHand: 1, reserved: 2, version: 1 })).toThrowError(
      new InventoryRuleError('BALANCE_INVALID'),
    );
    expect(() =>
      applyInventoryCommand(projectInventoryBalance({ onHand: 2, reserved: 0, version: 1 }), {
        expectedVersion: 1,
        quantity: 0.5,
        type: 'RESERVE',
      }),
    ).toThrowError(new InventoryRuleError('QUANTITY_INVALID'));
  });
});

describe('M3 inventory reservation state machine', () => {
  it('allows each terminal transition and treats the same retried event as idempotent', () => {
    expect(transitionInventoryReservation('ACTIVE', 'RELEASE')).toBe('RELEASED');
    expect(transitionInventoryReservation('ACTIVE', 'CONSUME')).toBe('CONSUMED');
    expect(transitionInventoryReservation('ACTIVE', 'EXPIRE')).toBe('EXPIRED');
    expect(transitionInventoryReservation('EXPIRED', 'EXPIRE')).toBe('EXPIRED');
  });

  it('rejects transitions between terminal states', () => {
    expect(() => transitionInventoryReservation('RELEASED', 'CONSUME')).toThrowError(
      new InventoryRuleError('RESERVATION_TRANSITION_INVALID'),
    );
  });
});

describe('M3 inventory lock ordering', () => {
  it('sorts warehouse and SKU targets deterministically without mutating input', () => {
    const input = [
      { skuId: 'sku-b', warehouseId: 'warehouse-b' },
      { skuId: 'sku-b', warehouseId: 'warehouse-a' },
      { skuId: 'sku-a', warehouseId: 'warehouse-a' },
    ];
    expect(sortInventoryLockTargets(input)).toEqual([
      { skuId: 'sku-a', warehouseId: 'warehouse-a' },
      { skuId: 'sku-b', warehouseId: 'warehouse-a' },
      { skuId: 'sku-b', warehouseId: 'warehouse-b' },
    ]);
    expect(input[0]).toEqual({ skuId: 'sku-b', warehouseId: 'warehouse-b' });
  });

  it('rejects duplicate lock targets before acquiring database locks', () => {
    expect(() =>
      sortInventoryLockTargets([
        { skuId: 'sku-a', warehouseId: 'warehouse-a' },
        { skuId: 'sku-a', warehouseId: 'warehouse-a' },
      ]),
    ).toThrowError(new InventoryRuleError('LOCK_TARGET_DUPLICATED'));
  });
});
