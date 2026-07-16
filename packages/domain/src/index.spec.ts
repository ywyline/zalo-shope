import { describe, expect, it } from 'vitest';

import {
  canBindPermissionToScope,
  createStoreContext,
  hasPermission,
  InvalidStoreContextError,
  PermissionDeniedError,
  permissionScope,
  requirePermission,
} from './index';

describe('StoreContext', () => {
  it('normalizes and freezes trusted context values', () => {
    const context = createStoreContext({
      actor: { id: ' admin-1 ', type: 'admin' },
      correlationId: ' request-1 ',
      locale: 'vi',
      storeCode: ' beauty-local ',
      storeId: ' store-1 ',
    });

    expect(context).toEqual({
      actor: { id: 'admin-1', type: 'admin' },
      correlationId: 'request-1',
      locale: 'vi',
      storeCode: 'beauty-local',
      storeId: 'store-1',
    });
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.actor)).toBe(true);
  });

  it('rejects incomplete security context', () => {
    expect(() =>
      createStoreContext({
        actor: { id: '', type: 'member' },
        correlationId: 'request-1',
        locale: 'vi',
        storeCode: 'beauty-local',
        storeId: 'store-1',
      }),
    ).toThrow(InvalidStoreContextError);
  });
});

describe('deny-by-default permissions', () => {
  it('only grants exact assigned permissions', () => {
    const granted = ['store.config.read'];
    expect(hasPermission(granted, 'store.config.read')).toBe(true);
    expect(hasPermission(granted, 'store.config.manage')).toBe(false);
    expect(() => requirePermission(granted, 'store.config.manage')).toThrow(PermissionDeniedError);
  });

  it('prevents platform permissions from being bound to store roles', () => {
    expect(permissionScope('platform.stores.read')).toBe('PLATFORM');
    expect(permissionScope('store.config.read')).toBe('STORE');
    expect(permissionScope('unknown')).toBeUndefined();
    expect(canBindPermissionToScope('platform.stores.read', 'STORE')).toBe(false);
    expect(canBindPermissionToScope('store.config.read', 'STORE')).toBe(true);
  });
});
