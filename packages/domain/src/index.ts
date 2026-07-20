export const SUPPORTED_LOCALES = ['vi', 'zh', 'en'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const PLATFORM_PERMISSION_PREFIX = 'platform.';
export const STORE_PERMISSION_PREFIX = 'store.';

export type ActorType = 'admin' | 'member';

export type StoreContext = Readonly<{
  accessReason?: string;
  actor: Readonly<{
    id: string;
    type: ActorType;
  }>;
  correlationId: string;
  locale: Locale;
  storeCode: string;
  storeId: string;
}>;

export type StoreContextInput = {
  accessReason?: string;
  actor: {
    id: string;
    type: ActorType;
  };
  correlationId: string;
  locale: Locale;
  storeCode: string;
  storeId: string;
};

export class InvalidStoreContextError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InvalidStoreContextError';
  }
}

function requireValue(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new InvalidStoreContextError(`${field} is required`);
  }
  return normalized;
}

export function createStoreContext(input: StoreContextInput): StoreContext {
  const context: StoreContext = {
    actor: Object.freeze({
      id: requireValue(input.actor.id, 'actor.id'),
      type: input.actor.type,
    }),
    correlationId: requireValue(input.correlationId, 'correlationId'),
    locale: input.locale,
    storeCode: requireValue(input.storeCode, 'storeCode'),
    storeId: requireValue(input.storeId, 'storeId'),
    ...(input.accessReason === undefined
      ? {}
      : { accessReason: requireValue(input.accessReason, 'accessReason') }),
  };

  return Object.freeze(context);
}

export type PermissionScope = 'PLATFORM' | 'STORE';

export function permissionScope(permission: string): PermissionScope | undefined {
  if (permission.startsWith(PLATFORM_PERMISSION_PREFIX)) {
    return 'PLATFORM';
  }
  if (permission.startsWith(STORE_PERMISSION_PREFIX)) {
    return 'STORE';
  }
  return undefined;
}

export function hasPermission(
  grantedPermissions: ReadonlySet<string> | readonly string[],
  requiredPermission: string,
): boolean {
  const permissions =
    grantedPermissions instanceof Set ? grantedPermissions : new Set(grantedPermissions);
  return permissions.has(requiredPermission);
}

export function canBindPermissionToScope(
  permission: string,
  targetScope: PermissionScope,
): boolean {
  return permissionScope(permission) === targetScope;
}

export class PermissionDeniedError extends Error {
  public constructor(public readonly permission: string) {
    super('Permission denied');
    this.name = 'PermissionDeniedError';
  }
}

export function requirePermission(
  grantedPermissions: ReadonlySet<string> | readonly string[],
  requiredPermission: string,
): void {
  if (!hasPermission(grantedPermissions, requiredPermission)) {
    throw new PermissionDeniedError(requiredPermission);
  }
}

export * from './catalog';
export * from './cart';
export * from './inventory';
export * from './pricing';
export * from './search';
