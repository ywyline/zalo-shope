import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateWarehouseInput,
  InventoryAdjustmentInput,
  InventoryBalanceListQuery,
  InventoryImportQuery,
  InventoryMovementListQuery,
  UpdateWarehouseInput,
  WarehouseListQuery,
} from '@zalo-shop/contracts';
import {
  adjustInventory,
  inventoryRequestHash,
  InventoryPrimitiveError,
  type PrismaClient,
  withStoreTransaction,
} from '@zalo-shop/database';

import { AdminService, type AdminHeaders } from '../admin/admin.service';
import { DATABASE_CLIENT } from '../auth/auth.tokens';
import { ProductImportFileError } from '../catalog-admin/product-import';
import {
  INVENTORY_IMPORT_MAX_BYTES,
  parseInventoryImportCsv,
  parseInventoryImportXlsx,
  type ParsedInventoryImportRow,
} from './inventory-import';

type InventoryContext = { headers: AdminHeaders; storeId: string };
export type InventoryImportUpload = {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
};

type ValidatedImportRow = ParsedInventoryImportRow & {
  skuId: string;
  warehouseId: string;
};
type ImportValidationRow = {
  code: string | null;
  row: number;
  status: 'ERROR' | 'VALID';
  valid?: ValidatedImportRow;
};

function isUniqueConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

function mapPrimitiveError(error: unknown): never {
  if (!(error instanceof InventoryPrimitiveError)) throw error;
  if (error.code === 'INVENTORY_TARGET_NOT_FOUND' || error.code === 'RESERVATION_NOT_FOUND') {
    throw new NotFoundException('Inventory resource not found');
  }
  if (
    error.code === 'AVAILABLE_INSUFFICIENT' ||
    error.code === 'IDEMPOTENCY_KEY_REUSED' ||
    error.code === 'RESERVATION_TRANSITION_INVALID' ||
    error.code === 'VERSION_CONFLICT'
  ) {
    throw new ConflictException(error.code);
  }
  throw new BadRequestException(error.code);
}

function warehouseView(warehouse: {
  code: string;
  createdAt: Date;
  enabled: boolean;
  id: string;
  isDefaultFulfillment: boolean;
  localizations: Array<{ locale: string; name: string }>;
  updatedAt: Date;
  version: number;
}) {
  return {
    code: warehouse.code,
    created_at: warehouse.createdAt.toISOString(),
    enabled: warehouse.enabled,
    id: warehouse.id,
    is_default_fulfillment: warehouse.isDefaultFulfillment,
    localizations: warehouse.localizations.map((item) => ({
      locale: item.locale,
      name: item.name,
    })),
    updated_at: warehouse.updatedAt.toISOString(),
    version: warehouse.version,
  };
}

function balanceView(balance: {
  available: number;
  id: string;
  onHand: number;
  reserved: number;
  sku: { code: string };
  skuId: string;
  updatedAt: Date;
  version: number;
  warehouseId: string;
}) {
  return {
    available: balance.available,
    id: balance.id,
    on_hand: balance.onHand,
    reserved: balance.reserved,
    sku_code: balance.sku.code,
    sku_id: balance.skuId,
    updated_at: balance.updatedAt.toISOString(),
    version: balance.version,
    warehouse_id: balance.warehouseId,
  };
}

function movementView(movement: {
  balanceId: string;
  createdAt: Date;
  id: string;
  movementType: string;
  note: string | null;
  onHandAfter: number;
  onHandBefore: number;
  onHandDelta: number;
  operationId: string;
  reasonCode: string;
  reservedAfter: number;
  reservedBefore: number;
  reservedDelta: number;
}) {
  return {
    balance_id: movement.balanceId,
    created_at: movement.createdAt.toISOString(),
    id: movement.id,
    movement_type: movement.movementType,
    note: movement.note,
    on_hand_after: movement.onHandAfter,
    on_hand_before: movement.onHandBefore,
    on_hand_delta: movement.onHandDelta,
    operation_id: movement.operationId,
    reason_code: movement.reasonCode,
    reserved_after: movement.reservedAfter,
    reserved_before: movement.reservedBefore,
    reserved_delta: movement.reservedDelta,
  };
}

function containsSensitiveNote(value: string | null): boolean {
  return (
    value !== null && /(?:bearer\s+|access[_ -]?token|\+?84\d{8,10}|\b0\d{8,10}\b)/i.test(value)
  );
}

@Injectable()
export class InventoryAdminService {
  public constructor(
    @Inject(DATABASE_CLIENT) private readonly database: PrismaClient,
    @Inject(AdminService) private readonly admin: AdminService,
  ) {}

  public async listWarehouses(request: InventoryContext, query: WarehouseListQuery) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.inventory.read',
    );
    return withStoreTransaction(this.database, context, async (transaction) => {
      const rows = await transaction.warehouse.findMany({
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        include: { localizations: { orderBy: { locale: 'asc' } } },
        orderBy: [{ code: 'asc' }, { id: 'asc' }],
        take: query.limit + 1,
        where: { storeId: request.storeId },
      });
      const hasMore = rows.length > query.limit;
      const items = rows.slice(0, query.limit);
      return {
        items: items.map(warehouseView),
        next_cursor: hasMore ? (items.at(-1)?.id ?? null) : null,
      };
    });
  }

  public async createWarehouse(request: InventoryContext, input: CreateWarehouseInput) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.inventory.manage',
    );
    if (!input.enabled && input.is_default_fulfillment) {
      throw new BadRequestException('A disabled warehouse cannot be the fulfillment default');
    }
    try {
      return await withStoreTransaction(this.database, context, async (transaction) => {
        const demoted = input.is_default_fulfillment
          ? await transaction.warehouse.findMany({
              include: { localizations: { orderBy: { locale: 'asc' } } },
              where: { isDefaultFulfillment: true, storeId: request.storeId },
            })
          : [];
        if (input.is_default_fulfillment) {
          await transaction.warehouse.updateMany({
            data: { isDefaultFulfillment: false, version: { increment: 1 } },
            where: { isDefaultFulfillment: true, storeId: request.storeId },
          });
        }
        const created = await transaction.warehouse.create({
          data: {
            code: input.code,
            enabled: input.enabled,
            isDefaultFulfillment: input.is_default_fulfillment,
            storeId: request.storeId,
          },
        });
        await transaction.warehouseLocalization.createMany({
          data: input.localizations.map((item) => ({
            locale: item.locale,
            name: item.name,
            storeId: request.storeId,
            warehouseId: created.id,
          })),
        });
        const warehouse = await transaction.warehouse.findUniqueOrThrow({
          include: { localizations: { orderBy: { locale: 'asc' } } },
          where: { storeId_id: { id: created.id, storeId: request.storeId } },
        });
        await this.admin.writeAudit(transaction, context, {
          action: 'inventory.warehouse.created',
          after: warehouseView(warehouse),
          targetId: warehouse.id,
          targetType: 'warehouse',
        });
        for (const previousDefault of demoted) {
          const afterDemotion = await transaction.warehouse.findUniqueOrThrow({
            include: { localizations: { orderBy: { locale: 'asc' } } },
            where: {
              storeId_id: { id: previousDefault.id, storeId: request.storeId },
            },
          });
          await this.admin.writeAudit(transaction, context, {
            action: 'inventory.warehouse.default_demoted',
            after: warehouseView(afterDemotion),
            before: warehouseView(previousDefault),
            targetId: previousDefault.id,
            targetType: 'warehouse',
          });
        }
        return warehouseView(warehouse);
      });
    } catch (error) {
      if (isUniqueConflict(error)) {
        throw new ConflictException('Warehouse code or default assignment conflict');
      }
      throw error;
    }
  }

  public async updateWarehouse(
    request: InventoryContext,
    warehouseId: string,
    input: UpdateWarehouseInput,
  ) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.inventory.manage',
    );
    return withStoreTransaction(this.database, context, async (transaction) => {
      const before = await transaction.warehouse.findUnique({
        include: { localizations: { orderBy: { locale: 'asc' } } },
        where: { storeId_id: { id: warehouseId, storeId: request.storeId } },
      });
      if (!before) throw new NotFoundException('Warehouse not found');
      if (before.version !== input.expected_version) {
        throw new ConflictException('Warehouse version conflict');
      }
      const nextEnabled = input.enabled ?? before.enabled;
      const nextDefault = input.is_default_fulfillment ?? before.isDefaultFulfillment;
      if (!nextEnabled && nextDefault) {
        throw new ConflictException('Select another fulfillment default before disabling this one');
      }
      if (before.isDefaultFulfillment && input.is_default_fulfillment === false) {
        throw new ConflictException('Promote a replacement warehouse instead');
      }
      const demoted =
        nextDefault && !before.isDefaultFulfillment
          ? await transaction.warehouse.findMany({
              include: { localizations: { orderBy: { locale: 'asc' } } },
              where: {
                id: { not: warehouseId },
                isDefaultFulfillment: true,
                storeId: request.storeId,
              },
            })
          : [];
      if (nextDefault && !before.isDefaultFulfillment) {
        await transaction.warehouse.updateMany({
          data: { isDefaultFulfillment: false, version: { increment: 1 } },
          where: {
            id: { not: warehouseId },
            isDefaultFulfillment: true,
            storeId: request.storeId,
          },
        });
      }
      const updated = await transaction.warehouse.updateMany({
        data: {
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
          ...(input.is_default_fulfillment === undefined
            ? {}
            : { isDefaultFulfillment: input.is_default_fulfillment }),
          version: { increment: 1 },
        },
        where: { id: warehouseId, storeId: request.storeId, version: input.expected_version },
      });
      if (updated.count !== 1) throw new ConflictException('Warehouse version conflict');
      if (input.localizations) {
        const locales = input.localizations.map((item) => item.locale);
        await transaction.warehouseLocalization.deleteMany({
          where: { locale: { notIn: locales }, storeId: request.storeId, warehouseId },
        });
        for (const item of input.localizations) {
          await transaction.warehouseLocalization.upsert({
            create: { ...item, storeId: request.storeId, warehouseId },
            update: { name: item.name },
            where: {
              storeId_warehouseId_locale: {
                locale: item.locale,
                storeId: request.storeId,
                warehouseId,
              },
            },
          });
        }
      }
      const after = await transaction.warehouse.findUniqueOrThrow({
        include: { localizations: { orderBy: { locale: 'asc' } } },
        where: { storeId_id: { id: warehouseId, storeId: request.storeId } },
      });
      await this.admin.writeAudit(transaction, context, {
        action: 'inventory.warehouse.updated',
        after: warehouseView(after),
        before: warehouseView(before),
        targetId: warehouseId,
        targetType: 'warehouse',
      });
      for (const previousDefault of demoted) {
        const afterDemotion = await transaction.warehouse.findUniqueOrThrow({
          include: { localizations: { orderBy: { locale: 'asc' } } },
          where: { storeId_id: { id: previousDefault.id, storeId: request.storeId } },
        });
        await this.admin.writeAudit(transaction, context, {
          action: 'inventory.warehouse.default_demoted',
          after: warehouseView(afterDemotion),
          before: warehouseView(previousDefault),
          targetId: previousDefault.id,
          targetType: 'warehouse',
        });
      }
      return warehouseView(after);
    }).catch((error: unknown) => {
      if (isUniqueConflict(error)) throw new ConflictException('Default warehouse conflict');
      throw error;
    });
  }

  public async listBalances(request: InventoryContext, query: InventoryBalanceListQuery) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.inventory.read',
    );
    return withStoreTransaction(this.database, context, async (transaction) => {
      const rows = await transaction.inventoryBalance.findMany({
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        include: { sku: { select: { code: true } } },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        where: {
          ...(query.in_stock === undefined ? {} : { available: query.in_stock ? { gt: 0 } : 0 }),
          ...(query.q === undefined
            ? {}
            : { sku: { code: { contains: query.q.toLowerCase(), mode: 'insensitive' } } }),
          ...(query.warehouse_id === undefined ? {} : { warehouseId: query.warehouse_id }),
          storeId: request.storeId,
        },
      });
      const hasMore = rows.length > query.limit;
      const items = rows.slice(0, query.limit);
      return {
        items: items.map(balanceView),
        next_cursor: hasMore ? (items.at(-1)?.id ?? null) : null,
      };
    });
  }

  public async listMovements(request: InventoryContext, query: InventoryMovementListQuery) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.inventory.read',
    );
    return withStoreTransaction(this.database, context, async (transaction) => {
      const rows = await transaction.inventoryMovement.findMany({
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        where: {
          ...(query.movement_type === undefined ? {} : { movementType: query.movement_type }),
          ...(query.sku_id === undefined ? {} : { balance: { skuId: query.sku_id } }),
          ...(query.warehouse_id === undefined
            ? {}
            : { balance: { warehouseId: query.warehouse_id } }),
          storeId: request.storeId,
        },
      });
      const hasMore = rows.length > query.limit;
      const items = rows.slice(0, query.limit);
      return {
        items: items.map(movementView),
        next_cursor: hasMore ? (items.at(-1)?.id ?? null) : null,
      };
    });
  }

  public async adjust(
    request: InventoryContext,
    operationKey: string,
    input: InventoryAdjustmentInput,
  ) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.inventory.adjust',
    );
    if (containsSensitiveNote(input.note)) {
      throw new BadRequestException('Inventory notes must not contain sensitive data');
    }
    try {
      const execution = await adjustInventory(this.database, context, {
        audit: { action: 'inventory.balance.adjusted', targetType: 'inventory_operation' },
        items: [
          {
            delta: input.delta,
            expectedVersion: input.expected_version,
            note: input.note,
            reasonCode: input.reason_code,
            skuId: input.sku_id,
            warehouseId: input.warehouse_id,
          },
        ],
        operationKey,
      });
      return {
        body: {
          balance: execution.result.balances[0],
          movement: execution.result.movements[0],
          operation_id: execution.result.operation_id,
        },
        replayed: execution.replayed,
      };
    } catch (error) {
      mapPrimitiveError(error);
    }
  }

  public async importInitialInventory(
    request: InventoryContext,
    operationKey: string,
    query: InventoryImportQuery,
    confirmationCode: string | undefined,
    upload: InventoryImportUpload | undefined,
  ) {
    const manageContext = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.inventory.manage',
    );
    const context = query.dry_run
      ? manageContext
      : await this.admin.authorize(request.headers, request.storeId, 'store.inventory.adjust');
    if (!query.dry_run && confirmationCode !== 'IMPORT') {
      throw new BadRequestException('Type IMPORT to confirm an inventory import');
    }
    if (!upload) throw new BadRequestException('An inventory CSV or XLSX file is required');
    const extension = upload.originalname.toLowerCase().endsWith('.xlsx')
      ? 'xlsx'
      : upload.originalname.toLowerCase().endsWith('.csv')
        ? 'csv'
        : null;
    const accepted =
      extension === 'xlsx'
        ? new Set([
            'application/octet-stream',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          ])
        : new Set([
            'application/csv',
            'application/octet-stream',
            'application/vnd.ms-excel',
            'text/csv',
            'text/plain',
          ]);
    if (
      extension === null ||
      !accepted.has(upload.mimetype.toLowerCase()) ||
      upload.size !== upload.buffer.byteLength ||
      upload.size > INVENTORY_IMPORT_MAX_BYTES
    ) {
      throw new BadRequestException('Inventory import file metadata is invalid');
    }
    let parsed: ParsedInventoryImportRow[];
    try {
      parsed =
        extension === 'xlsx'
          ? await parseInventoryImportXlsx(upload.buffer)
          : parseInventoryImportCsv(upload.buffer);
    } catch (error) {
      if (error instanceof ProductImportFileError) {
        throw new BadRequestException(`Inventory import file error: ${error.code}`);
      }
      throw error;
    }

    const validation = await withStoreTransaction(this.database, context, async (transaction) => {
      const warehouseCodes = [...new Set(parsed.map((row) => row.warehouseCode).filter(Boolean))];
      const skuCodes = [...new Set(parsed.map((row) => row.skuCode).filter(Boolean))];
      const [warehouses, skus] = await Promise.all([
        transaction.warehouse.findMany({
          select: { code: true, enabled: true, id: true },
          where: { code: { in: warehouseCodes }, storeId: request.storeId },
        }),
        transaction.sku.findMany({
          select: { code: true, id: true, status: true },
          where: { code: { in: skuCodes }, storeId: request.storeId },
        }),
      ]);
      const warehouseByCode = new Map(warehouses.map((item) => [item.code, item]));
      const skuByCode = new Map(skus.map((item) => [item.code, item]));
      const targetCounts = new Map<string, number>();
      for (const row of parsed) {
        const key = `${row.warehouseCode}\u0000${row.skuCode}`;
        targetCounts.set(key, (targetCounts.get(key) ?? 0) + 1);
      }
      const balances = await transaction.inventoryBalance.findMany({
        include: { _count: { select: { movements: true } } },
        where: {
          skuId: { in: skus.map((item) => item.id) },
          storeId: request.storeId,
          warehouseId: { in: warehouses.map((item) => item.id) },
        },
      });
      const balanceByTarget = new Map(
        balances.map((item) => [`${item.warehouseId}\u0000${item.skuId}`, item]),
      );
      const baseRows: ImportValidationRow[] = parsed.map((row) => {
        const warehouse = warehouseByCode.get(row.warehouseCode);
        const sku = skuByCode.get(row.skuCode);
        const duplicate = (targetCounts.get(`${row.warehouseCode}\u0000${row.skuCode}`) ?? 0) > 1;
        const code =
          row.issue ??
          (containsSensitiveNote(row.note) ? 'SENSITIVE_NOTE_REJECTED' : undefined) ??
          (duplicate ? 'DUPLICATE_TARGET' : undefined) ??
          (!warehouse ? 'WAREHOUSE_NOT_FOUND' : undefined) ??
          (!warehouse?.enabled ? 'WAREHOUSE_DISABLED' : undefined) ??
          (!sku ? 'SKU_NOT_FOUND' : undefined) ??
          (sku?.status !== 'ACTIVE' ? 'SKU_DISABLED' : undefined);
        return {
          ...(code === undefined && warehouse && sku
            ? {
                valid: {
                  ...row,
                  skuId: sku.id,
                  warehouseId: warehouse.id,
                } satisfies ValidatedImportRow,
              }
            : {}),
          code: code ?? null,
          row: row.line,
          status: code ? ('ERROR' as const) : ('VALID' as const),
        };
      });
      const replayCandidates = baseRows.flatMap((row) => (row.valid ? [row.valid] : []));
      if (!query.dry_run && replayCandidates.length === baseRows.length) {
        const items = replayCandidates
          .map((row) => ({
            delta: row.quantity,
            expectedVersion: 1,
            note: row.note,
            reasonCode: 'INITIAL_LOAD',
            skuId: row.skuId,
            warehouseId: row.warehouseId,
          }))
          .sort(
            (left, right) =>
              left.warehouseId.localeCompare(right.warehouseId, 'en') ||
              left.skuId.localeCompare(right.skuId, 'en'),
          );
        const requestHash = inventoryRequestHash({ items, operationType: 'IMPORT' });
        const existing = await transaction.inventoryOperation.findUnique({
          where: { storeId_operationKey: { operationKey, storeId: request.storeId } },
        });
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new ConflictException('IDEMPOTENCY_KEY_REUSED');
          }
          return { replayedOperationId: existing.id, rows: baseRows };
        }
      }
      const rows = baseRows.map((report) => {
        if (!report.valid) return report;
        const balance = balanceByTarget.get(
          `${report.valid.warehouseId}\u0000${report.valid.skuId}`,
        );
        if (
          balance &&
          (balance.onHand !== 0 ||
            balance.reserved !== 0 ||
            balance.version !== 1 ||
            balance._count.movements !== 0)
        ) {
          return {
            code: 'INITIAL_LOAD_ALREADY_APPLIED',
            row: report.row,
            status: 'ERROR' as const,
          };
        }
        return report;
      });
      return { rows };
    });

    if (validation.replayedOperationId) {
      return {
        body: {
          dry_run: false,
          error_count: 0,
          operation_id: validation.replayedOperationId,
          row_count: validation.rows.length,
          rows: validation.rows.map(({ row }) => ({ code: null, row, status: 'APPLIED' })),
          success_count: validation.rows.length,
        },
        replayed: true,
      };
    }
    const valid = validation.rows.flatMap((row) => (row.valid ? [row.valid] : []));
    const hasErrors = validation.rows.some((row) => row.status === 'ERROR');
    if (query.dry_run || hasErrors) {
      return {
        body: {
          dry_run: query.dry_run,
          error_count: validation.rows.length - valid.length,
          operation_id: null,
          row_count: validation.rows.length,
          rows: validation.rows.map(({ code, row, status }) => ({ code, row, status })),
          success_count: valid.length,
        },
        replayed: false,
      };
    }

    try {
      const execution = await adjustInventory(this.database, context, {
        audit: { action: 'inventory.initial_stock.imported', targetType: 'inventory_operation' },
        items: valid.map((row) => ({
          delta: row.quantity,
          expectedVersion: 1,
          note: row.note,
          reasonCode: 'INITIAL_LOAD',
          skuId: row.skuId,
          warehouseId: row.warehouseId,
        })),
        operationKey,
        operationType: 'IMPORT',
      });
      return {
        body: {
          dry_run: false,
          error_count: 0,
          operation_id: execution.result.operation_id,
          row_count: valid.length,
          rows: validation.rows.map(({ code, row }) => ({ code, row, status: 'APPLIED' })),
          success_count: valid.length,
        },
        replayed: execution.replayed,
      };
    } catch (error) {
      mapPrimitiveError(error);
    }
  }
}
