import { randomUUID } from 'node:crypto';

import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { accessReasonSchema } from '@zalo-shop/contracts';
import type { Prisma, PrismaClient, StoreTransaction } from '@zalo-shop/database';
import { withAdminAssignmentDiscoveryTransaction, withStoreTransaction } from '@zalo-shop/database';
import {
  canBindPermissionToScope,
  createStoreContext,
  hasPermission,
  type StoreContext,
} from '@zalo-shop/domain';
import { redactSensitiveData } from '@zalo-shop/logger';

import { AuthService } from '../auth/auth.service';
import { DATABASE_CLIENT } from '../auth/auth.tokens';

type StoreRegistryEntry = { code: string; default_locale: 'en' | 'vi' | 'zh'; id: string };
type AdminHeaders = {
  accessReason?: string;
  accessToken: string;
  storeCode: string;
};

@Injectable()
export class AdminService {
  public constructor(
    @Inject(DATABASE_CLIENT) private readonly database: PrismaClient,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  public async listStores(accessToken: string): Promise<StoreRegistryEntry[]> {
    const principal = await this.auth.authenticateAccessToken(accessToken);
    if (principal.actorType !== 'admin') throw new ForbiddenException('Access denied');
    const platformPermissions = await this.getPlatformPermissions(principal.subjectId);
    if (
      hasPermission(platformPermissions, 'platform.stores.read') ||
      hasPermission(platformPermissions, 'platform.stores.cross_access')
    ) {
      return this.database.$queryRaw<StoreRegistryEntry[]>`
        SELECT * FROM app_security.list_active_stores()
      `;
    }
    const storeIds = await withAdminAssignmentDiscoveryTransaction(
      this.database,
      principal.subjectId,
      async (transaction) => [
        ...new Set(
          (
            await transaction.adminStoreRole.findMany({
              select: { storeId: true },
              where: { adminUserId: principal.subjectId },
            })
          ).map((assignment) => assignment.storeId),
        ),
      ],
    );
    if (storeIds.length === 0) return [];
    const stores = await this.database.$queryRaw<StoreRegistryEntry[]>`
      SELECT * FROM app_security.list_active_stores()
    `;
    return stores.filter((store) => storeIds.includes(store.id));
  }

  public async getStoreConfig(headers: AdminHeaders, storeId: string) {
    const context = await this.authorize(headers, storeId, 'store.config.read');
    return withStoreTransaction(this.database, context, async (transaction) => {
      const store = await transaction.store.findUnique({
        include: { localizations: true, theme: true },
        where: { id: storeId },
      });
      if (!store) throw new NotFoundException('Resource not found');
      return store;
    });
  }

  public async updateStoreConfig(
    headers: AdminHeaders,
    storeId: string,
    input: {
      expected_version: number;
      localizations?: Array<{
        display_name: string;
        locale: 'en' | 'vi' | 'zh';
        short_description?: null | string;
      }>;
      theme?: {
        color_tokens: Record<string, number | string>;
        radius_tokens: Record<string, number | string>;
        typography_tokens: Record<string, number | string>;
      };
    },
  ) {
    const context = await this.authorize(headers, storeId, 'store.config.manage');
    return withStoreTransaction(this.database, context, async (transaction) => {
      const before = await transaction.store.findUnique({
        include: { localizations: true, theme: true },
        where: { id: storeId },
      });
      if (!before?.theme) throw new NotFoundException('Resource not found');
      if (before.theme.version !== input.expected_version) {
        throw new ConflictException('Configuration version conflict');
      }
      if (input.theme) {
        await transaction.storeTheme.update({
          data: {
            colorTokens: input.theme.color_tokens,
            radiusTokens: input.theme.radius_tokens,
            typographyTokens: input.theme.typography_tokens,
            version: { increment: 1 },
          },
          where: { storeId },
        });
      }
      for (const localization of input.localizations ?? []) {
        await transaction.storeLocalization.upsert({
          create: {
            displayName: localization.display_name,
            locale: localization.locale,
            shortDescription: localization.short_description,
            storeId,
          },
          update: {
            displayName: localization.display_name,
            shortDescription: localization.short_description,
          },
          where: { storeId_locale: { locale: localization.locale, storeId } },
        });
      }
      const after = await transaction.store.findUniqueOrThrow({
        include: { localizations: true, theme: true },
        where: { id: storeId },
      });
      await this.writeAudit(transaction, context, {
        action: 'store.config.updated',
        after,
        before,
        targetId: storeId,
        targetType: 'store',
      });
      return after;
    });
  }

  public async listRoles(headers: AdminHeaders, storeId: string) {
    const context = await this.authorize(headers, storeId, 'store.rbac.read');
    return withStoreTransaction(this.database, context, (transaction) =>
      transaction.storeRole.findMany({
        include: { permissions: { include: { permission: true } } },
        orderBy: { code: 'asc' },
      }),
    );
  }

  public async createRole(
    headers: AdminHeaders,
    storeId: string,
    input: { code: string; name: string },
  ) {
    const context = await this.authorize(headers, storeId, 'store.rbac.manage');
    return withStoreTransaction(this.database, context, async (transaction) => {
      const role = await transaction.storeRole.create({ data: { ...input, storeId } });
      await this.writeAudit(transaction, context, {
        action: 'store.role.created',
        after: role,
        targetId: role.id,
        targetType: 'store_role',
      });
      return role;
    });
  }

  public async grantRolePermission(
    headers: AdminHeaders,
    storeId: string,
    roleId: string,
    permissionCode: string,
  ) {
    if (!canBindPermissionToScope(permissionCode, 'STORE')) {
      throw new ForbiddenException('Access denied');
    }
    const context = await this.authorize(headers, storeId, 'store.rbac.manage');
    return withStoreTransaction(this.database, context, async (transaction) => {
      const permission = await transaction.permission.findUnique({
        where: { code: permissionCode },
      });
      const role = await transaction.storeRole.findUnique({
        where: { storeId_id: { id: roleId, storeId } },
      });
      if (!permission || permission.scope !== 'STORE' || !role) {
        throw new NotFoundException('Resource not found');
      }
      const assignment = await transaction.storeRolePermission.upsert({
        create: { permissionCode, roleId, storeId },
        update: {},
        where: { storeId_roleId_permissionCode: { permissionCode, roleId, storeId } },
      });
      await this.writeAudit(transaction, context, {
        action: 'store.role.permission.granted',
        after: assignment,
        targetId: roleId,
        targetType: 'store_role',
      });
      return assignment;
    });
  }

  public async revokeRolePermission(
    headers: AdminHeaders,
    storeId: string,
    roleId: string,
    permissionCode: string,
  ): Promise<void> {
    const context = await this.authorize(headers, storeId, 'store.rbac.manage');
    await withStoreTransaction(this.database, context, async (transaction) => {
      const role = await transaction.storeRole.findUnique({
        where: { storeId_id: { id: roleId, storeId } },
      });
      if (!role || role.isSystem) throw new ForbiddenException('System role is immutable');
      const before = await transaction.storeRolePermission.findUnique({
        where: { storeId_roleId_permissionCode: { permissionCode, roleId, storeId } },
      });
      if (!before) throw new NotFoundException('Resource not found');
      await transaction.storeRolePermission.delete({
        where: { storeId_roleId_permissionCode: { permissionCode, roleId, storeId } },
      });
      await this.writeAudit(transaction, context, {
        action: 'store.role.permission.revoked',
        before,
        targetId: roleId,
        targetType: 'store_role',
      });
    });
  }

  public async grantAdminRole(
    headers: AdminHeaders,
    storeId: string,
    adminId: string,
    roleId: string,
  ) {
    const context = await this.authorize(headers, storeId, 'store.rbac.manage');
    return withStoreTransaction(this.database, context, async (transaction) => {
      const [admin, role] = await Promise.all([
        transaction.adminUser.findUnique({ where: { id: adminId } }),
        transaction.storeRole.findUnique({ where: { storeId_id: { id: roleId, storeId } } }),
      ]);
      if (!admin || !role) throw new NotFoundException('Resource not found');
      const assignment = await transaction.adminStoreRole.upsert({
        create: { adminUserId: adminId, grantedBy: context.actor.id, roleId, storeId },
        update: { grantedBy: context.actor.id, grantedAt: new Date() },
        where: { storeId_adminUserId_roleId: { adminUserId: adminId, roleId, storeId } },
      });
      await this.writeAudit(transaction, context, {
        action: 'store.admin.role.granted',
        after: assignment,
        targetId: adminId,
        targetType: 'admin_user',
      });
      return assignment;
    });
  }

  public async revokeAdminRole(
    headers: AdminHeaders,
    storeId: string,
    adminId: string,
    roleId: string,
  ): Promise<void> {
    const context = await this.authorize(headers, storeId, 'store.rbac.manage');
    await withStoreTransaction(this.database, context, async (transaction) => {
      const before = await transaction.adminStoreRole.findUnique({
        where: { storeId_adminUserId_roleId: { adminUserId: adminId, roleId, storeId } },
      });
      if (!before) throw new NotFoundException('Resource not found');
      await transaction.adminStoreRole.delete({
        where: { storeId_adminUserId_roleId: { adminUserId: adminId, roleId, storeId } },
      });
      await this.writeAudit(transaction, context, {
        action: 'store.admin.role.revoked',
        before,
        targetId: adminId,
        targetType: 'admin_user',
      });
    });
  }

  public async listAuditLogs(headers: AdminHeaders, storeId: string, limit = 20) {
    const context = await this.authorize(headers, storeId, 'store.audit.read');
    return withStoreTransaction(this.database, context, (transaction) =>
      transaction.auditLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: Math.max(1, Math.min(limit, 100)),
      }),
    );
  }

  private async authorize(
    headers: AdminHeaders,
    storeId: string,
    requiredPermission: string,
  ): Promise<StoreContext> {
    const principal = await this.auth.authenticateAccessToken(headers.accessToken);
    if (principal.actorType !== 'admin') throw new ForbiddenException('Access denied');
    const stores = await this.database.$queryRaw<StoreRegistryEntry[]>`
      SELECT * FROM app_security.resolve_active_store(${headers.storeCode.trim()})
    `;
    const store = stores[0];
    if (!store || store.id !== storeId) throw new ForbiddenException('Access denied');
    const context = createStoreContext({
      ...(headers.accessReason === undefined ? {} : { accessReason: headers.accessReason }),
      actor: { id: principal.subjectId, type: 'admin' },
      correlationId: randomUUID(),
      locale: store.default_locale,
      storeCode: store.code,
      storeId,
    });
    const storePermissions = await withStoreTransaction(
      this.database,
      context,
      async (transaction) =>
        (
          await transaction.adminStoreRole.findMany({
            include: { role: { include: { permissions: true } } },
            where: { adminUserId: principal.subjectId, storeId },
          })
        ).flatMap((assignment) =>
          assignment.role.permissions.map((permission) => permission.permissionCode),
        ),
    );
    if (hasPermission(storePermissions, requiredPermission)) return context;

    const platformPermissions = await this.getPlatformPermissions(principal.subjectId);
    if (!hasPermission(platformPermissions, 'platform.stores.cross_access')) {
      throw new ForbiddenException('Access denied');
    }
    const reason = accessReasonSchema.safeParse(headers.accessReason);
    if (!reason.success) throw new ForbiddenException('Cross-store access reason is required');
    const crossStoreContext = createStoreContext({ ...context, accessReason: reason.data });
    await withStoreTransaction(this.database, crossStoreContext, (transaction) =>
      this.writeAudit(transaction, crossStoreContext, {
        action: 'platform.cross_store.accessed',
        after: { requiredPermission },
        targetId: storeId,
        targetType: 'store',
      }),
    );
    return crossStoreContext;
  }

  private async getPlatformPermissions(adminId: string): Promise<string[]> {
    return (
      await this.database.adminPlatformRole.findMany({
        include: { platformRole: { include: { permissions: true } } },
        where: { adminUserId: adminId },
      })
    ).flatMap((assignment) =>
      assignment.platformRole.permissions.map((permission) => permission.permissionCode),
    );
  }

  private async writeAudit(
    transaction: StoreTransaction,
    context: StoreContext,
    event: {
      action: string;
      after?: unknown;
      before?: unknown;
      targetId?: string;
      targetType: string;
    },
  ): Promise<void> {
    const json = (value: unknown): Prisma.InputJsonValue | undefined =>
      value === undefined ? undefined : (redactSensitiveData(value) as Prisma.InputJsonValue);
    await transaction.auditLog.create({
      data: {
        action: event.action,
        actorId: context.actor.id,
        actorType: 'ADMIN',
        afterData: json(event.after),
        beforeData: json(event.before),
        correlationId: context.correlationId,
        reason: context.accessReason,
        storeId: context.storeId,
        targetId: event.targetId,
        targetType: event.targetType,
      },
    });
  }
}
