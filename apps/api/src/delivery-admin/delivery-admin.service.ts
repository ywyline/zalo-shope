import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { UpdateDeliveryPolicyInput } from '@zalo-shop/contracts';
import type { PrismaClient } from '@zalo-shop/database';
import { withStoreTransaction } from '@zalo-shop/database';

import { AdminService, type AdminHeaders } from '../admin/admin.service';
import { DATABASE_CLIENT } from '../auth/auth.tokens';

@Injectable()
export class DeliveryAdminService {
  public constructor(
    @Inject(DATABASE_CLIENT) private readonly database: PrismaClient,
    @Inject(AdminService) private readonly admin: AdminService,
  ) {}

  public async get(headers: AdminHeaders, storeId: string) {
    const context = await this.admin.authorize(headers, storeId, 'store.delivery.read');
    return withStoreTransaction(this.database, context, async (transaction) => {
      const policy = await transaction.storeDeliveryPolicy.findUnique({ where: { storeId } });
      if (!policy) throw new NotFoundException('Delivery policy not found');
      return this.render(policy);
    });
  }

  public async update(headers: AdminHeaders, storeId: string, input: UpdateDeliveryPolicyInput) {
    const context = await this.admin.authorize(headers, storeId, 'store.delivery.manage');
    return withStoreTransaction(this.database, context, async (transaction) => {
      const before = await transaction.storeDeliveryPolicy.findUnique({ where: { storeId } });
      if (!before) throw new NotFoundException('Delivery policy not found');
      const knownRemoteProvinceCount = await transaction.administrativeArea.count({
        where: {
          code: { in: input.remote_province_codes },
          enabled: true,
          level: 'PROVINCE',
          storeId,
        },
      });
      if (knownRemoteProvinceCount !== input.remote_province_codes.length) {
        throw new BadRequestException('DELIVERY_REGION_INVALID');
      }
      const result = await transaction.storeDeliveryPolicy.updateMany({
        data: {
          codEnabled: input.cod_enabled,
          codMaxAmountVnd: input.cod_max_amount_vnd,
          enabled: input.enabled,
          flatShippingFeeVnd: input.flat_shipping_fee_vnd,
          freeShippingThresholdVnd: input.free_shipping_threshold_vnd,
          remoteProvinceCodes: input.remote_province_codes,
          remoteSurchargeVnd: input.remote_surcharge_vnd,
          updatedByAdminId: context.actor.id,
          version: { increment: 1 },
        },
        where: { storeId, version: input.expected_version },
      });
      if (result.count !== 1) throw new ConflictException('VERSION_CONFLICT');
      const after = await transaction.storeDeliveryPolicy.findUniqueOrThrow({ where: { storeId } });
      await this.admin.writeAudit(transaction, context, {
        action: 'delivery.policy.updated',
        after: this.render(after),
        before: this.render(before),
        targetId: after.id,
        targetType: 'store_delivery_policy',
      });
      return this.render(after);
    });
  }

  private render(policy: {
    codEnabled: boolean;
    codMaxAmountVnd: bigint | null;
    enabled: boolean;
    flatShippingFeeVnd: bigint;
    freeShippingThresholdVnd: bigint | null;
    remoteProvinceCodes: string[];
    remoteSurchargeVnd: bigint;
    storeId: string;
    updatedAt: Date;
    version: number;
  }) {
    return {
      cod_enabled: policy.codEnabled,
      cod_max_amount_vnd: policy.codMaxAmountVnd === null ? null : Number(policy.codMaxAmountVnd),
      enabled: policy.enabled,
      flat_shipping_fee_vnd: Number(policy.flatShippingFeeVnd),
      free_shipping_threshold_vnd:
        policy.freeShippingThresholdVnd === null ? null : Number(policy.freeShippingThresholdVnd),
      remote_province_codes: policy.remoteProvinceCodes,
      remote_surcharge_vnd: Number(policy.remoteSurchargeVnd),
      store_id: policy.storeId,
      updated_at: policy.updatedAt,
      version: policy.version,
    };
  }
}
