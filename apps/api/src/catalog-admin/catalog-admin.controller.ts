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
import {
  activateAttributeTemplateVersionSchema,
  attributeTemplateVersionInputSchema,
  categoryTemplateBindingSchema,
  createAttributeTemplateSchema,
  createBrandSchema,
  createCategorySchema,
  updateAttributeTemplateVersionSchema,
  updateBrandSchema,
  updateCategorySchema,
} from '@zalo-shop/contracts';
import type { z } from 'zod';

import { CatalogAdminService } from './catalog-admin.service';

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

@Controller('v1/admin/catalog')
export class CatalogAdminController {
  public constructor(@Inject(CatalogAdminService) private readonly catalog: CatalogAdminService) {}

  @Get('brands')
  public listBrands(
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
  ): Promise<unknown> {
    return this.catalog.listBrands(context(authorization, storeCode, accessReason, storeId));
  }

  @Post('brands')
  public createBrand(
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.catalog.createBrand(
      context(authorization, storeCode, accessReason, storeId),
      parse(createBrandSchema, body),
    );
  }

  @Patch('brands/:brandId')
  public updateBrand(
    @Param('brandId') brandId: string,
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.catalog.updateBrand(
      context(authorization, storeCode, accessReason, storeId),
      brandId,
      parse(updateBrandSchema, body),
    );
  }

  @Get('categories')
  public listCategories(
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
  ): Promise<unknown> {
    return this.catalog.listCategories(context(authorization, storeCode, accessReason, storeId));
  }

  @Post('categories')
  public createCategory(
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.catalog.createCategory(
      context(authorization, storeCode, accessReason, storeId),
      parse(createCategorySchema, body),
    );
  }

  @Patch('categories/:categoryId')
  public updateCategory(
    @Param('categoryId') categoryId: string,
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.catalog.updateCategory(
      context(authorization, storeCode, accessReason, storeId),
      categoryId,
      parse(updateCategorySchema, body),
    );
  }

  @Put('categories/:categoryId/attribute-templates/:templateVersionId')
  public bindCategoryTemplate(
    @Param('categoryId') categoryId: string,
    @Param('templateVersionId') templateVersionId: string,
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.catalog.bindCategoryTemplate(
      context(authorization, storeCode, accessReason, storeId),
      categoryId,
      templateVersionId,
      parse(categoryTemplateBindingSchema, body),
    );
  }

  @Delete('categories/:categoryId/attribute-templates/:templateVersionId')
  public unbindCategoryTemplate(
    @Param('categoryId') categoryId: string,
    @Param('templateVersionId') templateVersionId: string,
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
  ): Promise<unknown> {
    return this.catalog.unbindCategoryTemplate(
      context(authorization, storeCode, accessReason, storeId),
      categoryId,
      templateVersionId,
    );
  }

  @Get('attribute-templates')
  public listAttributeTemplates(
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
  ): Promise<unknown> {
    return this.catalog.listAttributeTemplates(
      context(authorization, storeCode, accessReason, storeId),
    );
  }

  @Post('attribute-templates')
  public createAttributeTemplate(
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.catalog.createAttributeTemplate(
      context(authorization, storeCode, accessReason, storeId),
      parse(createAttributeTemplateSchema, body),
    );
  }

  @Post('attribute-templates/:templateId/versions')
  public createAttributeTemplateVersion(
    @Param('templateId') templateId: string,
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.catalog.createAttributeTemplateVersion(
      context(authorization, storeCode, accessReason, storeId),
      templateId,
      parse(attributeTemplateVersionInputSchema, body),
    );
  }

  @Patch('attribute-templates/:templateId/versions/:version')
  public updateAttributeTemplateVersion(
    @Param('templateId') templateId: string,
    @Param('version') version: string,
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.catalog.updateAttributeTemplateVersion(
      context(authorization, storeCode, accessReason, storeId),
      templateId,
      Number(version),
      parse(updateAttributeTemplateVersionSchema, body),
    );
  }

  @Post('attribute-templates/:templateId/versions/:version/activate')
  public activateAttributeTemplateVersion(
    @Param('templateId') templateId: string,
    @Param('version') version: string,
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Body() body: unknown,
  ) {
    return this.catalog.activateAttributeTemplateVersion(
      context(authorization, storeCode, accessReason, storeId),
      templateId,
      Number(version),
      parse(activateAttributeTemplateVersionSchema, body),
    );
  }
}
