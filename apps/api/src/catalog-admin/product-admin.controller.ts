import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Inject,
  Param,
  Post,
  Put,
  Query,
  StreamableFile,
  UnauthorizedException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  batchDisableProductsSchema,
  batchMoveProductsSchema,
  complianceOverviewQuerySchema,
  confirmMediaUploadSchema,
  createProductDraftSchema,
  mediaUploadInputSchema,
  productImportQuerySchema,
  productMediaInputSchema,
  productVersionNumberSchema,
  productVersionCommandSchema,
  replaceProductAttributesSchema,
  replaceProductSkusSchema,
  reviewComplianceRecordSchema,
  submitComplianceRecordSchema,
  uuidSchema,
} from '@zalo-shop/contracts';
import type { z } from 'zod';

import { PRODUCT_IMPORT_MAX_BYTES } from './product-import';
import { ProductAdminService, type ProductImportUpload } from './product-admin.service';

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

@Controller('v1/admin/catalog/products')
export class ProductAdminController {
  public constructor(@Inject(ProductAdminService) private readonly products: ProductAdminService) {}

  @Get()
  public list(
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
  ): Promise<unknown> {
    return this.products.listProducts(context(authorization, storeCode, accessReason, storeId));
  }

  @Get('imports/template.csv')
  @Header('Cache-Control', 'no-store')
  public async importTemplate(
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
  ): Promise<StreamableFile> {
    const template = await this.products.getProductImportTemplate(
      context(authorization, storeCode, accessReason, storeId),
    );
    return new StreamableFile(template, {
      disposition: 'attachment; filename="product-import-template.csv"',
      type: 'text/csv; charset=utf-8',
    });
  }

  @Post('imports/csv')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: PRODUCT_IMPORT_MAX_BYTES, files: 1 },
    }),
  )
  public importCsv(
    @Query('store_id') storeId: string | undefined,
    @Query('dry_run') dryRun: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @UploadedFile() file: ProductImportUpload | undefined,
  ): Promise<unknown> {
    return this.products.importProducts(
      context(authorization, storeCode, accessReason, storeId),
      parse(productImportQuerySchema, { dry_run: dryRun ?? 'true' }),
      file,
    );
  }

  @Get(':productId/versions')
  public versions(
    @Param('productId') productId: string,
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
  ): Promise<unknown> {
    return this.products.listProductVersions(
      context(authorization, storeCode, accessReason, storeId),
      parse(uuidSchema, productId),
    );
  }

  @Get(':productId/versions/:version')
  public version(
    @Param('productId') productId: string,
    @Param('version') version: string,
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
  ): Promise<unknown> {
    return this.products.getProductVersion(
      context(authorization, storeCode, accessReason, storeId),
      parse(uuidSchema, productId),
      parse(productVersionNumberSchema, version),
    );
  }

  @Post('batch/disable')
  public batchDisable(
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.products.batchDisableProducts(
      context(authorization, storeCode, accessReason, storeId),
      parse(batchDisableProductsSchema, body),
    );
  }

  @Post('batch/move')
  public batchMove(
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.products.batchMoveProducts(
      context(authorization, storeCode, accessReason, storeId),
      parse(batchMoveProductsSchema, body),
    );
  }

  @Post()
  public create(
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.products.createProduct(
      context(authorization, storeCode, accessReason, storeId),
      parse(createProductDraftSchema, body),
    );
  }

  @Get(':productId/attributes')
  public attributes(
    @Param('productId') productId: string,
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
  ): Promise<unknown> {
    return this.products.getProductAttributes(
      context(authorization, storeCode, accessReason, storeId),
      parse(uuidSchema, productId),
    );
  }

  @Put(':productId/attributes')
  public replaceAttributes(
    @Param('productId') productId: string,
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.products.replaceProductAttributes(
      context(authorization, storeCode, accessReason, storeId),
      parse(uuidSchema, productId),
      parse(replaceProductAttributesSchema, body),
    );
  }

  @Put(':productId/skus')
  public replaceSkus(
    @Param('productId') productId: string,
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.products.replaceSkus(
      context(authorization, storeCode, accessReason, storeId),
      productId,
      parse(replaceProductSkusSchema, body),
    );
  }

  @Post(':productId/media')
  public attachMedia(
    @Param('productId') productId: string,
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.products.attachProductMedia(
      context(authorization, storeCode, accessReason, storeId),
      productId,
      parse(productMediaInputSchema, body),
    );
  }

  @Post(':productId/submit')
  public submit(
    @Param('productId') productId: string,
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Body() body: unknown,
  ): Promise<unknown> {
    const input = parse(productVersionCommandSchema, body);
    return this.products.submitProduct(
      context(authorization, storeCode, accessReason, storeId),
      productId,
      input.expected_version,
    );
  }

  @Post(':productId/publish')
  public publish(
    @Param('productId') productId: string,
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Body() body: unknown,
  ): Promise<unknown> {
    const input = parse(productVersionCommandSchema, body);
    return this.products.publishProduct(
      context(authorization, storeCode, accessReason, storeId),
      productId,
      input.expected_version,
    );
  }
}

@Controller('v1/admin/media')
export class MediaAdminController {
  public constructor(@Inject(ProductAdminService) private readonly products: ProductAdminService) {}

  @Post('uploads')
  public initialize(
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.products.initializeMedia(
      context(authorization, storeCode, accessReason, storeId),
      parse(mediaUploadInputSchema, body),
    );
  }

  @Post(':mediaId/confirm')
  public confirm(
    @Param('mediaId') mediaId: string,
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.products.confirmMedia(
      context(authorization, storeCode, accessReason, storeId),
      mediaId,
      parse(confirmMediaUploadSchema, body),
    );
  }
}

@Controller('v1/admin/compliance')
export class ComplianceAdminController {
  public constructor(@Inject(ProductAdminService) private readonly products: ProductAdminService) {}

  @Get('overview')
  public overview(
    @Query('store_id') storeId: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('product_id') productId: string | undefined,
    @Query('status') status: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
  ): Promise<unknown> {
    return this.products.getComplianceOverview(
      context(authorization, storeCode, accessReason, storeId),
      parse(complianceOverviewQuerySchema, {
        ...(limit === undefined ? {} : { limit }),
        ...(productId === undefined ? {} : { product_id: productId }),
        ...(status === undefined ? {} : { status }),
      }),
    );
  }

  @Post('records')
  public submit(
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.products.submitCompliance(
      context(authorization, storeCode, accessReason, storeId),
      parse(submitComplianceRecordSchema, body),
    );
  }

  @Post('records/:recordId/review')
  public review(
    @Param('recordId') recordId: string,
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.products.reviewCompliance(
      context(authorization, storeCode, accessReason, storeId),
      recordId,
      parse(reviewComplianceRecordSchema, body),
    );
  }
}
