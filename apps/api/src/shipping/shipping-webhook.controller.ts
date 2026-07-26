import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Post,
  Req,
} from '@nestjs/common';

import { ShippingWebhookService } from './shipping-webhook.service';

type RawWebhookRequest = Readonly<{
  rawBody?: Buffer;
  socket?: Readonly<{ remoteAddress?: string }>;
}>;

@Controller('v1/webhooks/shipping')
export class ShippingWebhookController {
  public constructor(
    @Inject(ShippingWebhookService) private readonly webhooks: ShippingWebhookService,
  ) {}

  @Post('ghn')
  @HttpCode(202)
  public async ghn(
    @Headers() headers: Record<string, string | undefined>,
    @Req() request: RawWebhookRequest,
  ) {
    if (!request.rawBody) {
      throw new BadRequestException('Shipping callback body is unavailable');
    }
    return this.webhooks.handle({
      headers,
      rawBody: request.rawBody,
      remoteAddress: request.socket?.remoteAddress,
    });
  }
}
