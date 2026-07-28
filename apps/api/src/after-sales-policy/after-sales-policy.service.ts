import { createHash } from 'node:crypto';

import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { afterSaleSettingsEnforcementSchema } from '@zalo-shop/contracts';
import {
  assessAfterSalePolicyReadinessInTransaction,
  Prisma,
  type AfterSalePolicyReadiness,
  type PrismaClient,
  type StoreTransaction,
  withStoreTransaction,
} from '@zalo-shop/database';

import { AdminService, type AdminHeaders } from '../admin/admin.service';
import { DATABASE_CLIENT } from '../auth/auth.tokens';

type EnforcementInput = z.infer<typeof afterSaleSettingsEnforcementSchema>;
type SettingsView = ReturnType<typeof settingsView>;
type SettingsAuditView = SettingsView & {
  current_version_id: string | null;
  default_policy_id: string | null;
  readiness_hash: string | null;
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function databaseErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const record = error as { code?: unknown; meta?: unknown };
  if (record.code === 'P2010' && record.meta !== null && typeof record.meta === 'object') {
    const databaseCode = (record.meta as { code?: unknown }).code;
    if (typeof databaseCode === 'string') return databaseCode;
  }
  return typeof record.code === 'string' ? record.code : undefined;
}

function isRetryableTransactionConflict(error: unknown): boolean {
  return ['23505', '40001', '40P01', 'P2002', 'P2028', 'P2034'].includes(
    databaseErrorCode(error) ?? '',
  );
}

function settingsView(readiness: AfterSalePolicyReadiness) {
  return {
    current_version_number: readiness.currentVersionNumber,
    default_policy_code: readiness.defaultPolicyCode,
    enforce_policy_snapshots: readiness.enforcePolicySnapshots,
    readiness_checked_at: readiness.readinessCheckedAt?.toISOString() ?? null,
    readiness_state:
      !readiness.ready || !readiness.enforcementSynchronized
        ? ('NOT_READY' as const)
        : readiness.enforcePolicySnapshots
          ? ('ENFORCED' as const)
          : ('READY' as const),
    version: readiness.settingsVersion,
  };
}

function parseStoredView(value: Prisma.JsonValue): SettingsView {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConflictException('AFTER_SALE_SETTINGS_IDEMPOTENCY_INVALID');
  }
  const item = value as Record<string, unknown>;
  if (
    typeof item.enforce_policy_snapshots !== 'boolean' ||
    !['NOT_READY', 'READY', 'ENFORCED'].includes(String(item.readiness_state)) ||
    (item.default_policy_code !== null && typeof item.default_policy_code !== 'string') ||
    (item.current_version_number !== null &&
      (!Number.isInteger(item.current_version_number) ||
        Number(item.current_version_number) < 1)) ||
    (item.readiness_checked_at !== null && typeof item.readiness_checked_at !== 'string') ||
    !Number.isInteger(item.version) ||
    Number(item.version) < 1
  ) {
    throw new ConflictException('AFTER_SALE_SETTINGS_IDEMPOTENCY_INVALID');
  }
  return value as SettingsView;
}

@Injectable()
export class AfterSalesPolicyService {
  public constructor(
    @Inject(DATABASE_CLIENT) private readonly database: PrismaClient,
    @Inject(AdminService) private readonly admin: AdminService,
  ) {}

  public async getSettings(headers: AdminHeaders, storeId: string): Promise<SettingsView> {
    const context = await this.admin.authorize(headers, storeId, 'store.after-sales.policy.read');
    return withStoreTransaction(
      this.database,
      context,
      async (transaction) =>
        settingsView(await assessAfterSalePolicyReadinessInTransaction(transaction, storeId)),
      { isolationLevel: 'RepeatableRead' },
    );
  }

  public async setEnforcement(
    headers: AdminHeaders,
    storeId: string,
    idempotencyKey: string,
    input: EnforcementInput,
  ): Promise<{ body: SettingsView; replayed: boolean }> {
    const context = await this.admin.authorizeSensitive(
      headers,
      storeId,
      'store.after-sales.policy.enforce',
    );
    const execute = () =>
      withStoreTransaction(
        this.database,
        context,
        async (transaction) => {
          await transaction.$executeRaw`
          SELECT pg_advisory_xact_lock(hashtextextended(${`m62-policy:${storeId}`}, 0))
        `;
          const keyHash = hash(idempotencyKey);
          const inputHash = hash(input);
          const operation = 'after-sale.policy.enforce';
          const existing = await transaction.idempotencyRecord.findUnique({
            where: {
              storeId_operation_idempotencyKey: {
                idempotencyKey: keyHash,
                operation,
                storeId,
              },
            },
          });
          if (existing) {
            if (existing.requestHash !== inputHash) {
              throw new ConflictException('AFTER_SALE_SETTINGS_IDEMPOTENCY_CONFLICT');
            }
            return { body: parseStoredView(existing.response), replayed: true };
          }

          const lockedSettings = await transaction.$queryRaw<
            Array<{ enforce_policy_snapshots: boolean }>
          >`
            SELECT enforce_policy_snapshots
            FROM app_security.lock_m63_after_sale_setting()
          `;
          if (lockedSettings.length !== 1) {
            throw new ConflictException('AFTER_SALE_POLICY_NOT_READY');
          }
          const before = await transaction.storeAfterSaleSetting.findUnique({ where: { storeId } });
          const currentVersion = before?.version ?? 1;
          if (currentVersion !== input.expected_version) {
            throw new ConflictException('AFTER_SALE_SETTINGS_VERSION_CONFLICT');
          }
          const readiness = await assessAfterSalePolicyReadinessInTransaction(transaction, storeId);
          if (input.enabled && !readiness.ready) {
            throw new ConflictException('AFTER_SALE_POLICY_NOT_READY');
          }
          const checkedAt = new Date();
          const setting = before
            ? await transaction.storeAfterSaleSetting.update({
                data: {
                  currentVersionId: readiness.currentVersionId,
                  defaultPolicyId: readiness.defaultPolicyId,
                  enforcePolicySnapshots: input.enabled,
                  readinessCheckedAt: checkedAt,
                  readinessCheckedBy: context.actor.id,
                  readinessHash: readiness.readinessHash,
                  readinessReadyAt: readiness.ready ? checkedAt : null,
                  updatedBy: context.actor.id,
                  version: { increment: 1 },
                },
                where: { storeId },
              })
            : await transaction.storeAfterSaleSetting.create({
                data: {
                  currentVersionId: readiness.currentVersionId,
                  defaultPolicyId: readiness.defaultPolicyId,
                  enforcePolicySnapshots: input.enabled,
                  readinessCheckedAt: checkedAt,
                  readinessCheckedBy: context.actor.id,
                  readinessHash: readiness.readinessHash,
                  readinessReadyAt: readiness.ready ? checkedAt : null,
                  storeId,
                  updatedBy: context.actor.id,
                  version: currentVersion + 1,
                },
              });
          const afterReadiness: AfterSalePolicyReadiness = {
            ...readiness,
            enforcementSynchronized: true,
            enforcePolicySnapshots: setting.enforcePolicySnapshots,
            readinessCheckedAt: setting.readinessCheckedAt,
            settingsVersion: setting.version,
          };
          const body = settingsView(afterReadiness);
          await transaction.idempotencyRecord.create({
            data: {
              expiresAt: new Date(checkedAt.getTime() + 24 * 60 * 60 * 1_000),
              idempotencyKey: keyHash,
              operation,
              requestHash: inputHash,
              response: body,
              storeId,
            },
          });
          await this.writeAudit(transaction, context, {
            after: {
              ...body,
              current_version_id: setting.currentVersionId,
              default_policy_id: setting.defaultPolicyId,
              readiness_hash: setting.readinessHash,
            },
            before:
              before === null
                ? null
                : {
                    current_version_id: before.currentVersionId,
                    default_policy_id: before.defaultPolicyId,
                    enforce_policy_snapshots: before.enforcePolicySnapshots,
                    readiness_checked_at: before.readinessCheckedAt?.toISOString() ?? null,
                    readiness_hash: before.readinessHash,
                    version: before.version,
                  },
            reason: input.reason,
            storeId,
          });
          return { body, replayed: false };
        },
        { isolationLevel: 'Serializable', timeout: 15_000 },
      );

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await execute();
      } catch (error) {
        if (isRetryableTransactionConflict(error) && attempt === 0) continue;
        if (isRetryableTransactionConflict(error)) {
          throw new ConflictException('AFTER_SALE_SETTINGS_CONCURRENT_CONFLICT');
        }
        throw error;
      }
    }
    throw new ConflictException('AFTER_SALE_SETTINGS_CONCURRENT_CONFLICT');
  }

  private async writeAudit(
    transaction: StoreTransaction,
    context: { actor: { id: string }; correlationId: string },
    input: {
      after: SettingsAuditView;
      before: null | {
        current_version_id: string | null;
        default_policy_id: string | null;
        enforce_policy_snapshots: boolean;
        readiness_checked_at: string | null;
        readiness_hash: string | null;
        version: number;
      };
      reason: string;
      storeId: string;
    },
  ): Promise<void> {
    await transaction.auditLog.create({
      data: {
        action: 'after-sale.policy.enforcement.updated',
        actorId: context.actor.id,
        actorType: 'ADMIN',
        afterData: input.after,
        beforeData: input.before ?? Prisma.JsonNull,
        correlationId: context.correlationId,
        reason: input.reason,
        storeId: input.storeId,
        targetId: input.storeId,
        targetType: 'store_after_sale_settings',
      },
    });
  }
}
