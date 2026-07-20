import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UnauthorizedException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  createWarehouseSchema,
  inventoryAdjustmentSchema,
  inventoryBalanceListQuerySchema,
  inventoryImportQuerySchema,
  inventoryMovementListQuerySchema,
  inventoryOperationKeySchema,
  updateWarehouseSchema,
  uuidSchema,
  warehouseListQuerySchema,
} from '@zalo-shop/contracts';
import type { z } from 'zod';

import { InventoryAdminService, type InventoryImportUpload } from './inventory-admin.service';
import { INVENTORY_IMPORT_MAX_BYTES } from './inventory-import';

function bearer(value: string | undefined): string {
  if (!value?.startsWith('Bearer ')) throw new UnauthorizedException('Bearer token is required');
  return value.slice(7);
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException('Input is invalid');
  return result.data;
}

function context(
  authorization: string | undefined,
  storeCode: string | undefined,
  accessReason: string | undefined,
  storeId: string | undefined,
) {
  if (!storeCode || !storeId) throw new UnauthorizedException('Store context is required');
  return {
    headers: {
      ...(accessReason === undefined ? {} : { accessReason }),
      accessToken: bearer(authorization),
      storeCode,
    },
    storeId,
  };
}

function setReplayHeader(
  response: { setHeader(name: string, value: string): void },
  value: boolean,
) {
  response.setHeader('Idempotency-Replayed', String(value));
}

@Controller('v1/admin/inventory')
export class InventoryAdminController {
  public constructor(
    @Inject(InventoryAdminService) private readonly inventory: InventoryAdminService,
  ) {}

  @Get('warehouses')
  public listWarehouses(
    @Query('store_id') storeId: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
  ) {
    return this.inventory.listWarehouses(
      context(authorization, storeCode, accessReason, storeId),
      parse(warehouseListQuerySchema, {
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit }),
      }),
    );
  }

  @Post('warehouses')
  public createWarehouse(
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Body() body: unknown,
  ) {
    return this.inventory.createWarehouse(
      context(authorization, storeCode, accessReason, storeId),
      parse(createWarehouseSchema, body),
    );
  }

  @Patch('warehouses/:warehouseId')
  public updateWarehouse(
    @Param('warehouseId') warehouseId: string,
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Body() body: unknown,
  ) {
    return this.inventory.updateWarehouse(
      context(authorization, storeCode, accessReason, storeId),
      parse(uuidSchema, warehouseId),
      parse(updateWarehouseSchema, body),
    );
  }

  @Get('balances')
  public listBalances(
    @Query('store_id') storeId: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('in_stock') inStock: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('q') q: string | undefined,
    @Query('warehouse_id') warehouseId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
  ) {
    return this.inventory.listBalances(
      context(authorization, storeCode, accessReason, storeId),
      parse(inventoryBalanceListQuerySchema, {
        ...(cursor === undefined ? {} : { cursor }),
        ...(inStock === undefined ? {} : { in_stock: inStock }),
        ...(limit === undefined ? {} : { limit }),
        ...(q === undefined ? {} : { q }),
        ...(warehouseId === undefined ? {} : { warehouse_id: warehouseId }),
      }),
    );
  }

  @Get('movements')
  public listMovements(
    @Query('store_id') storeId: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('movement_type') movementType: string | undefined,
    @Query('sku_id') skuId: string | undefined,
    @Query('warehouse_id') warehouseId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
  ) {
    return this.inventory.listMovements(
      context(authorization, storeCode, accessReason, storeId),
      parse(inventoryMovementListQuerySchema, {
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit }),
        ...(movementType === undefined ? {} : { movement_type: movementType }),
        ...(skuId === undefined ? {} : { sku_id: skuId }),
        ...(warehouseId === undefined ? {} : { warehouse_id: warehouseId }),
      }),
    );
  }

  @Post('adjustments')
  @HttpCode(HttpStatus.OK)
  public async adjust(
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') operationKey: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: { setHeader(name: string, value: string): void },
  ) {
    const execution = await this.inventory.adjust(
      context(authorization, storeCode, accessReason, storeId),
      parse(inventoryOperationKeySchema, operationKey),
      parse(inventoryAdjustmentSchema, body),
    );
    setReplayHeader(response, execution.replayed);
    return execution.body;
  }

  @Post('imports')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: INVENTORY_IMPORT_MAX_BYTES, files: 1 },
    }),
  )
  public async importInitialInventory(
    @Query('store_id') storeId: string | undefined,
    @Query('dry_run') dryRun: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') operationKey: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Body('confirmation_code') confirmationCode: string | undefined,
    @UploadedFile() file: InventoryImportUpload | undefined,
    @Res({ passthrough: true }) response: { setHeader(name: string, value: string): void },
  ) {
    const execution = await this.inventory.importInitialInventory(
      context(authorization, storeCode, accessReason, storeId),
      parse(inventoryOperationKeySchema, operationKey),
      parse(inventoryImportQuerySchema, { dry_run: dryRun ?? 'true' }),
      confirmationCode,
      file,
    );
    setReplayHeader(response, execution.replayed);
    return execution.body;
  }
}
