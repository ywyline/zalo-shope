import { BadRequestException, Controller, Get, Headers, Inject, Query } from '@nestjs/common';
import { administrativeAreaQuerySchema } from '@zalo-shop/contracts';

import { AddressService } from './address.service';

@Controller('v1/member/administrative-areas')
export class AdministrativeAreaController {
  public constructor(@Inject(AddressService) private readonly addresses: AddressService) {}

  @Get()
  public list(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Query() query: unknown,
  ) {
    const normalizedStoreCode = storeCode?.trim();
    if (!normalizedStoreCode || normalizedStoreCode.length > 64) {
      throw new BadRequestException('Store context is required');
    }
    const parsed = administrativeAreaQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('Input is invalid');
    return this.addresses.listAdministrativeAreas({
      authorization,
      query: parsed.data,
      storeCode: normalizedStoreCode,
    });
  }
}
