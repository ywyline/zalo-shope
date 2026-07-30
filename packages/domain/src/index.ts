export const SUPPORTED_LOCALES = ['vi', 'zh', 'en'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const PLATFORM_PERMISSION_PREFIX = 'platform.';
export const STORE_PERMISSION_PREFIX = 'store.';

export type ActorType = 'admin' | 'member';

export type StoreContext = Readonly<{
  accessReason?: string;
  accessSessionExpiresAt?: string;
  accessSessionId?: string;
  accessTokenExpiresAt?: string;
  adminAuthorizationScope?: 'CROSS_STORE' | 'STORE';
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
  accessSessionExpiresAt?: Date;
  accessSessionId?: string;
  accessTokenExpiresAt?: Date;
  adminAuthorizationScope?: 'CROSS_STORE' | 'STORE';
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

function normalizeExpiry(value: Date, field: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new InvalidStoreContextError(`${field} must be a valid date`);
  }
  return value.toISOString();
}

export function createStoreContext(input: StoreContextInput): StoreContext {
  const accessSessionExpiresAt =
    input.accessSessionExpiresAt === undefined
      ? undefined
      : normalizeExpiry(input.accessSessionExpiresAt, 'accessSessionExpiresAt');
  const accessSessionId =
    input.accessSessionId === undefined
      ? undefined
      : requireValue(input.accessSessionId, 'accessSessionId');
  const accessTokenExpiresAt =
    input.accessTokenExpiresAt === undefined
      ? undefined
      : normalizeExpiry(input.accessTokenExpiresAt, 'accessTokenExpiresAt');
  if (
    accessSessionExpiresAt !== undefined &&
    (accessSessionId === undefined || accessTokenExpiresAt === undefined)
  ) {
    throw new InvalidStoreContextError(
      'accessSessionExpiresAt requires accessSessionId and accessTokenExpiresAt',
    );
  }
  if ((accessSessionId === undefined) !== (accessTokenExpiresAt === undefined)) {
    throw new InvalidStoreContextError(
      'accessSessionId and accessTokenExpiresAt must be provided together',
    );
  }
  if (input.adminAuthorizationScope !== undefined && input.actor.type !== 'admin') {
    throw new InvalidStoreContextError('adminAuthorizationScope requires an admin actor');
  }
  const context: StoreContext = {
    actor: Object.freeze({
      id: requireValue(input.actor.id, 'actor.id'),
      type: input.actor.type,
    }),
    correlationId: requireValue(input.correlationId, 'correlationId'),
    locale: input.locale,
    storeCode: requireValue(input.storeCode, 'storeCode'),
    storeId: requireValue(input.storeId, 'storeId'),
    ...(accessSessionExpiresAt === undefined ? {} : { accessSessionExpiresAt }),
    ...(accessSessionId === undefined ? {} : { accessSessionId }),
    ...(accessTokenExpiresAt === undefined ? {} : { accessTokenExpiresAt }),
    ...(input.adminAuthorizationScope === undefined
      ? {}
      : { adminAuthorizationScope: input.adminAuthorizationScope }),
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
export * from './order';
export * from './address';
export * from './payment';
export * from './shipment';
export * from './reliable-messaging';
export * from './after-sales';
export * from './share';
export * from './privacy';
