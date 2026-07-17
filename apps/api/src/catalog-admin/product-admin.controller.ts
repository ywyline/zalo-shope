import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Put,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import {
  confirmMediaUploadSchema,
  createProductDraftSchema,
  mediaUploadInputSchema,
  productMediaInputSchema,
  productVersionCommandSchema,
  replaceProductSkusSchema,
  reviewComplianceRecordSchema,
  submitComplianceRecordSchema,
} from '@zalo-shop/contracts';
import type { z } from 'zod';

import { ProductAdminService } from './product-admin.service';

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
