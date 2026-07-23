import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  addressIdParamsSchema,
  addressInputSchema,
  addressQuerySchema,
  updateAddressSchema,
} from '@zalo-shop/contracts';

import { AddressService } from './address.service';

function requiredStore(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 64)
    throw new BadRequestException('Store context is required');
  return normalized;
}

function parse<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException('Input is invalid');
  return result.data;
}

@Controller('v1/member/addresses')
export class AddressController {
  public constructor(@Inject(AddressService) private readonly addresses: AddressService) {}

  @Get()
  public list(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Query() query: unknown,
  ) {
    const parsed = parse(addressQuerySchema, query);
    return this.addresses.list({
      authorization,
      includeDisabled: parsed.include_disabled,
      storeCode: requiredStore(storeCode),
    });
  }

  @Post()
  public create(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Body() body: unknown,
  ) {
    return this.addresses.create({
      authorization,
      request: parse(addressInputSchema, body),
      storeCode: requiredStore(storeCode),
    });
  }

  @Patch(':addressId')
  public update(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const parsedParams = parse(addressIdParamsSchema, params);
    return this.addresses.update({
      addressId: parsedParams.addressId,
      authorization,
      request: parse(updateAddressSchema, body),
      storeCode: requiredStore(storeCode),
    });
  }

  @Delete(':addressId')
  @HttpCode(HttpStatus.NO_CONTENT)
  public async remove(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Param() params: unknown,
  ): Promise<void> {
    const parsed = parse(addressIdParamsSchema, params);
    await this.addresses.remove({
      addressId: parsed.addressId,
      authorization,
      storeCode: requiredStore(storeCode),
    });
  }
}
