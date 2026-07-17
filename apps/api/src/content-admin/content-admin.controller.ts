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
  createPageDraftSchema,
  publishPageSchema,
  replacePageDraftSchema,
} from '@zalo-shop/contracts';
import type { z } from 'zod';

import { ContentAdminService } from './content-admin.service';

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException('Input is invalid');
  return result.data;
}

function requestContext(
  authorization: string | undefined,
  storeCode: string | undefined,
  accessReason: string | undefined,
  storeId: string | undefined,
) {
  if (!authorization?.startsWith('Bearer ')) {
    throw new UnauthorizedException('Bearer token is required');
  }
  if (!storeCode || !storeId) throw new UnauthorizedException('Store context is required');
  return {
    headers: {
      ...(accessReason === undefined ? {} : { accessReason }),
      accessToken: authorization.slice(7),
      storeCode,
    },
    storeId,
  };
}

@Controller('v1/admin/content/pages')
export class ContentAdminController {
  public constructor(@Inject(ContentAdminService) private readonly content: ContentAdminService) {}

  @Get()
  public list(
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
  ): Promise<unknown> {
    return this.content.listPages(requestContext(authorization, storeCode, accessReason, storeId));
  }

  @Post()
  public create(
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.content.createPage(
      requestContext(authorization, storeCode, accessReason, storeId),
      parse(createPageDraftSchema, body),
    );
  }

  @Put(':pageId/draft')
  public replaceDraft(
    @Param('pageId') pageId: string,
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.content.replaceDraft(
      requestContext(authorization, storeCode, accessReason, storeId),
      pageId,
      parse(replacePageDraftSchema, body),
    );
  }

  @Post(':pageId/publish')
  public publish(
    @Param('pageId') pageId: string,
    @Query('store_id') storeId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.content.publishPage(
      requestContext(authorization, storeCode, accessReason, storeId),
      pageId,
      parse(publishPageSchema, body),
    );
  }
}
