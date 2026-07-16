import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { createStoreRoleSchema, updateStoreConfigSchema } from '@zalo-shop/contracts';
import type { z } from 'zod';

import { AdminService } from './admin.service';

function bearer(value: string | undefined): string {
  if (!value?.startsWith('Bearer ')) throw new UnauthorizedException('Bearer token is required');
  return value.slice(7);
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException('Input is invalid');
  return result.data;
}

function storeHeaders(
  authorization: string | undefined,
  storeCode: string | undefined,
  accessReason: string | undefined,
) {
  if (!storeCode) throw new UnauthorizedException('Store context is required');
  return {
    ...(accessReason === undefined ? {} : { accessReason }),
    accessToken: bearer(authorization),
    storeCode,
  };
}

@Controller('v1/admin')
export class AdminController {
  public constructor(@Inject(AdminService) private readonly admin: AdminService) {}

  @Get('stores')
  public listStores(@Headers('authorization') authorization: string | undefined) {
    return this.admin.listStores(bearer(authorization));
  }

  @Get('stores/:storeId/config')
  public getStoreConfig(
    @Param('storeId') storeId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
  ): Promise<unknown> {
    return this.admin.getStoreConfig(storeHeaders(authorization, storeCode, accessReason), storeId);
  }

  @Patch('stores/:storeId/config')
  public updateStoreConfig(
    @Param('storeId') storeId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.admin.updateStoreConfig(
      storeHeaders(authorization, storeCode, accessReason),
      storeId,
      parse(updateStoreConfigSchema, body),
    );
  }

  @Get('rbac/roles')
  public listRoles(
    @Query('store_id') storeId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
  ): Promise<unknown> {
    return this.admin.listRoles(storeHeaders(authorization, storeCode, accessReason), storeId);
  }

  @Post('rbac/roles')
  public createRole(
    @Query('store_id') storeId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Body() body: unknown,
  ) {
    return this.admin.createRole(
      storeHeaders(authorization, storeCode, accessReason),
      storeId,
      parse(createStoreRoleSchema, body),
    );
  }

  @Put('rbac/roles/:roleId/permissions/:permissionCode')
  public grantPermission(
    @Param('roleId') roleId: string,
    @Param('permissionCode') permissionCode: string,
    @Query('store_id') storeId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
  ) {
    return this.admin.grantRolePermission(
      storeHeaders(authorization, storeCode, accessReason),
      storeId,
      roleId,
      permissionCode,
    );
  }

  @Delete('rbac/roles/:roleId/permissions/:permissionCode')
  public async revokePermission(
    @Param('roleId') roleId: string,
    @Param('permissionCode') permissionCode: string,
    @Query('store_id') storeId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
  ): Promise<{ status: 'ok' }> {
    await this.admin.revokeRolePermission(
      storeHeaders(authorization, storeCode, accessReason),
      storeId,
      roleId,
      permissionCode,
    );
    return { status: 'ok' };
  }

  @Put('rbac/admins/:adminId/roles/:roleId')
  public grantAdminRole(
    @Param('adminId') adminId: string,
    @Param('roleId') roleId: string,
    @Query('store_id') storeId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
  ) {
    return this.admin.grantAdminRole(
      storeHeaders(authorization, storeCode, accessReason),
      storeId,
      adminId,
      roleId,
    );
  }

  @Delete('rbac/admins/:adminId/roles/:roleId')
  public async revokeAdminRole(
    @Param('adminId') adminId: string,
    @Param('roleId') roleId: string,
    @Query('store_id') storeId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
  ): Promise<{ status: 'ok' }> {
    await this.admin.revokeAdminRole(
      storeHeaders(authorization, storeCode, accessReason),
      storeId,
      adminId,
      roleId,
    );
    return { status: 'ok' };
  }

  @Get('audit-logs')
  public listAuditLogs(
    @Query('store_id') storeId: string,
    @Query('limit') limit: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
  ): Promise<unknown> {
    return this.admin.listAuditLogs(
      storeHeaders(authorization, storeCode, accessReason),
      storeId,
      limit === undefined ? undefined : Number(limit),
    );
  }
}
