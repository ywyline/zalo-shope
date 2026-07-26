import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
  UnauthorizedException,
} from '@nestjs/common';
import {
  orderIdParamsSchema,
  shipmentCreateRequestSchema,
  shipmentIdParamsSchema,
  shipmentLabelQuerySchema,
  shipmentOperationRequestSchema,
  shippingQuoteRequestSchema,
  shippingStoreQuerySchema,
} from '@zalo-shop/contracts';

import type { AdminHeaders } from '../admin/admin.service';
import { ShippingService } from './shipping.service';

function parse<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException('Input is invalid');
  return result.data;
}

function adminHeaders(
  authorization: string | undefined,
  storeCode: string | undefined,
  accessReason: string | undefined,
): AdminHeaders {
  if (!authorization?.startsWith('Bearer ') || !storeCode) {
    throw new UnauthorizedException('Admin authentication is required');
  }
  return { accessReason, accessToken: authorization.slice(7), storeCode };
}

function storeCode(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 64) {
    throw new BadRequestException('Store context is required');
  }
  return normalized;
}

function idempotencyKey(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized || !/^[!-~]{16,128}$/u.test(normalized)) {
    throw new BadRequestException('Idempotency-Key is required');
  }
  return normalized;
}

@Controller('v1')
export class ShippingController {
  public constructor(@Inject(ShippingService) private readonly shipping: ShippingService) {}

  @Post('admin/shipping/quotes')
  public quote(
    @Query() query: unknown,
    @Body() body: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
  ) {
    const { store_id: storeId } = parse(shippingStoreQuerySchema, query);
    return this.shipping.quote(
      adminHeaders(authorization, headerStoreCode, accessReason),
      storeId,
      parse(shippingQuoteRequestSchema, body),
    );
  }

  @Post('admin/orders/:orderId/shipments')
  @HttpCode(202)
  public create(
    @Query() query: unknown,
    @Param() params: unknown,
    @Body() body: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') headerIdempotencyKey: string | undefined,
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
  ) {
    const { store_id: storeId } = parse(shippingStoreQuerySchema, query);
    return this.shipping.create(
      adminHeaders(authorization, headerStoreCode, accessReason),
      storeId,
      parse(orderIdParamsSchema, params).orderId,
      idempotencyKey(headerIdempotencyKey),
      parse(shipmentCreateRequestSchema, body),
    );
  }

  @Post('admin/shipments/:shipmentId/cancel')
  @HttpCode(202)
  public cancel(
    @Query() query: unknown,
    @Param() params: unknown,
    @Body() body: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') headerIdempotencyKey: string | undefined,
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
  ) {
    const request = parse(shipmentOperationRequestSchema, body);
    if (request.confirmation_code !== 'CANCEL_SHIPMENT') {
      throw new BadRequestException('Input is invalid');
    }
    return this.shipping.cancel(
      adminHeaders(authorization, headerStoreCode, accessReason),
      parse(shippingStoreQuerySchema, query).store_id,
      parse(shipmentIdParamsSchema, params).shipmentId,
      idempotencyKey(headerIdempotencyKey),
      request,
    );
  }

  @Post('admin/shipments/:shipmentId/sync')
  @HttpCode(202)
  public sync(
    @Query() query: unknown,
    @Param() params: unknown,
    @Body() body: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') headerIdempotencyKey: string | undefined,
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
  ) {
    const request = parse(shipmentOperationRequestSchema, body);
    if (request.confirmation_code !== 'SYNC_SHIPMENT') {
      throw new BadRequestException('Input is invalid');
    }
    return this.shipping.sync(
      adminHeaders(authorization, headerStoreCode, accessReason),
      parse(shippingStoreQuerySchema, query).store_id,
      parse(shipmentIdParamsSchema, params).shipmentId,
      idempotencyKey(headerIdempotencyKey),
      request,
    );
  }

  @Get('admin/shipments/:shipmentId/label')
  @Header('Cache-Control', 'private, no-store')
  public label(
    @Query() query: unknown,
    @Param() params: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
  ) {
    const parsedQuery = query as Record<string, unknown>;
    const store = parse(shippingStoreQuerySchema, { store_id: parsedQuery.store_id });
    const label = parse(shipmentLabelQuerySchema, {
      ...(parsedQuery.format === undefined ? {} : { format: parsedQuery.format }),
    });
    return this.shipping.issueLabelAccess(
      adminHeaders(authorization, headerStoreCode, accessReason),
      store.store_id,
      parse(shipmentIdParamsSchema, params).shipmentId,
      label.format,
    );
  }

  @Get('orders/:orderId/shipment')
  public memberShipment(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Param() params: unknown,
  ) {
    return this.shipping.memberShipment({
      authorization,
      orderId: parse(orderIdParamsSchema, params).orderId,
      storeCode: storeCode(headerStoreCode),
    });
  }

  @Get('admin/orders/:orderId/shipment')
  public adminShipment(
    @Query() query: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') headerStoreCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
    @Param() params: unknown,
  ) {
    return this.shipping.adminShipment(
      adminHeaders(authorization, headerStoreCode, accessReason),
      parse(shippingStoreQuerySchema, query).store_id,
      parse(orderIdParamsSchema, params).orderId,
    );
  }

  @Get('shipping/labels/:token')
  @Header('Cache-Control', 'private, no-store')
  public async proxyLabel(
    @Param('token') token: string,
    @Res({ passthrough: true })
    response: {
      setHeader(name: string, value: string): void;
    },
  ): Promise<StreamableFile> {
    const label = await this.shipping.proxyLabel(token);
    response.setHeader('Content-Type', label.contentType);
    response.setHeader('Content-Disposition', 'inline; filename="shipment-label-a5.pdf"');
    return new StreamableFile(label.body);
  }
}
