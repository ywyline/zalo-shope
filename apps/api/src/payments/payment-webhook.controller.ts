import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Post,
  Req,
} from '@nestjs/common';

import { PaymentWebhookService } from './payment-webhook.service';

type RawWebhookRequest = Readonly<{
  rawBody?: Buffer;
  socket?: Readonly<{ remoteAddress?: string }>;
}>;

@Controller('v1/webhooks/payments')
export class PaymentWebhookController {
  public constructor(
    @Inject(PaymentWebhookService) private readonly webhooks: PaymentWebhookService,
  ) {}

  @Post('zalo-checkout')
  @HttpCode(200)
  public async zaloCheckout(
    @Headers() headers: Record<string, string | undefined>,
    @Req() request: RawWebhookRequest,
  ) {
    const remoteAddress = request.socket?.remoteAddress;
    if (!request.rawBody) {
      throw new BadRequestException('Payment callback body is unavailable');
    }
    return this.webhooks.handle({ headers, rawBody: request.rawBody, remoteAddress });
  }
}
