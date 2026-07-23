import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { PrismaClient, StoreTransaction } from '@zalo-shop/database';
import { withStoreTransaction } from '@zalo-shop/database';
import { createStoreContext, normalizeAddressFields } from '@zalo-shop/domain';
import { normalizeSupportedPhone } from '@zalo-shop/i18n';
import { decryptSensitive, encryptSensitive, hashSensitive } from '@zalo-shop/security';

import type {
  AddressInput,
  AdministrativeAreaQuery,
  UpdateAddressInput,
} from '@zalo-shop/contracts';

import { AuthService } from '../auth/auth.service';
import { DATABASE_CLIENT } from '../auth/auth.tokens';
import { RUNTIME_CONFIG } from '../health.controller';
import type { RuntimeConfig } from '@zalo-shop/config';

type StoreRecord = { id: string; code: string; default_locale: 'en' | 'vi' | 'zh' };

@Injectable()
export class AddressService {
  public constructor(
    @Inject(DATABASE_CLIENT) private readonly database: PrismaClient,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
  ) {}

  public async list(input: {
    authorization?: string;
    storeCode: string;
    includeDisabled: boolean;
  }) {
    const member = await this.memberContext(input.authorization, input.storeCode);
    return withStoreTransaction(this.database, member.context, async (transaction) => {
      const rows = await transaction.address.findMany({
        where: {
          memberId: member.memberId,
          ...(input.includeDisabled ? {} : { status: 'ACTIVE' }),
        },
        orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }, { id: 'asc' }],
      });
      return rows.map((row) => this.render(row));
    });
  }

  public async listAdministrativeAreas(input: {
    authorization?: string;
    query: AdministrativeAreaQuery;
    storeCode: string;
  }) {
    const member = await this.memberContext(input.authorization, input.storeCode);
    return withStoreTransaction(this.database, member.context, async (transaction) => {
      const rows = await transaction.administrativeArea.findMany({
        orderBy: [{ name: 'asc' }, { code: 'asc' }],
        select: {
          code: true,
          level: true,
          name: true,
          parentCode: true,
          sourceVersion: true,
        },
        where: {
          enabled: true,
          level: input.query.level,
          parentCode: input.query.parent_code ?? null,
          storeId: member.storeId,
        },
      });
      return {
        items: rows.map((row) => ({
          code: row.code,
          level: row.level,
          name: row.name,
          parent_code: row.parentCode,
          source_version: row.sourceVersion,
        })),
      };
    });
  }

  public async create(input: { authorization?: string; storeCode: string; request: AddressInput }) {
    const member = await this.memberContext(input.authorization, input.storeCode);
    const fields = normalizeAddressFields({
      detail: input.request.detail,
      districtCode: input.request.district_code,
      provinceCode: input.request.province_code,
      wardCode: input.request.ward_code,
    });
    const phone = this.normalizePhone(input.request.phone);
    const phoneHash = hashSensitive(phone, this.config.PII_HASH_KEY);
    return withStoreTransaction(this.database, member.context, async (transaction) => {
      const region = await this.resolveAdministrativeAddress(transaction, member.storeId, fields);
      if (input.request.is_default) {
        await transaction.address.updateMany({
          data: { isDefault: false, version: { increment: 1 } },
          where: { memberId: member.memberId, status: 'ACTIVE' },
        });
      }
      try {
        const row = await transaction.address.create({
          data: {
            detailCiphertext: encryptSensitive(fields.detail, this.config.PII_ENCRYPTION_KEY),
            districtCode: fields.districtCode,
            districtName: region.district.name,
            isDefault: input.request.is_default,
            label: input.request.label,
            memberId: member.memberId,
            phoneCiphertext: encryptSensitive(phone, this.config.PII_ENCRYPTION_KEY),
            phoneHash,
            provinceCode: fields.provinceCode,
            provinceName: region.province.name,
            recipientNameCiphertext: encryptSensitive(
              input.request.recipient_name,
              this.config.PII_ENCRYPTION_KEY,
            ),
            storeId: member.storeId,
            wardCode: fields.wardCode,
            wardName: region.ward.name,
          },
        });
        return this.render(row);
      } catch (error) {
        if (this.isUniqueViolation(error)) throw new ConflictException('ADDRESS_CONFLICT');
        throw error;
      }
    });
  }

  public async update(input: {
    authorization?: string;
    addressId: string;
    storeCode: string;
    request: UpdateAddressInput;
  }) {
    const member = await this.memberContext(input.authorization, input.storeCode);
    return withStoreTransaction(this.database, member.context, async (transaction) => {
      const current = await transaction.address.findFirst({
        where: { id: input.addressId, memberId: member.memberId, status: 'ACTIVE' },
      });
      if (!current) throw new NotFoundException('Address not found');
      if (current.version !== input.request.expected_version) {
        throw new ConflictException('VERSION_CONFLICT');
      }
      const phone = input.request.phone ? this.normalizePhone(input.request.phone) : null;
      const normalized =
        input.request.province_code ||
        input.request.district_code ||
        input.request.ward_code ||
        input.request.detail
          ? normalizeAddressFields({
              detail: input.request.detail ?? this.decrypt(current.detailCiphertext),
              districtCode: input.request.district_code ?? current.districtCode,
              provinceCode: input.request.province_code ?? current.provinceCode,
              wardCode: input.request.ward_code ?? current.wardCode,
            })
          : null;
      const region = await this.resolveAdministrativeAddress(transaction, member.storeId, {
        districtCode: normalized?.districtCode ?? current.districtCode,
        provinceCode: normalized?.provinceCode ?? current.provinceCode,
        wardCode: normalized?.wardCode ?? current.wardCode,
      });
      if (input.request.is_default) {
        await transaction.address.updateMany({
          data: { isDefault: false, version: { increment: 1 } },
          where: { memberId: member.memberId, status: 'ACTIVE', id: { not: current.id } },
        });
      }
      const row = await transaction.address.update({
        data: {
          ...(normalized
            ? {
                detailCiphertext: encryptSensitive(
                  normalized.detail,
                  this.config.PII_ENCRYPTION_KEY,
                ),
                districtCode: normalized.districtCode,
                provinceCode: normalized.provinceCode,
                wardCode: normalized.wardCode,
              }
            : {}),
          districtName: region.district.name,
          provinceName: region.province.name,
          wardName: region.ward.name,
          ...(input.request.recipient_name
            ? {
                recipientNameCiphertext: encryptSensitive(
                  input.request.recipient_name,
                  this.config.PII_ENCRYPTION_KEY,
                ),
              }
            : {}),
          ...(phone
            ? {
                phoneCiphertext: encryptSensitive(phone, this.config.PII_ENCRYPTION_KEY),
                phoneHash: hashSensitive(phone, this.config.PII_HASH_KEY),
              }
            : {}),
          ...(input.request.label !== undefined ? { label: input.request.label } : {}),
          ...(input.request.is_default !== undefined
            ? { isDefault: input.request.is_default }
            : {}),
          version: { increment: 1 },
        },
        where: { storeId_id: { id: current.id, storeId: member.storeId } },
      });
      return this.render(row);
    });
  }

  public async remove(input: { authorization?: string; addressId: string; storeCode: string }) {
    const member = await this.memberContext(input.authorization, input.storeCode);
    await withStoreTransaction(this.database, member.context, async (transaction) => {
      const current = await transaction.address.findFirst({
        where: { id: input.addressId, memberId: member.memberId, status: 'ACTIVE' },
      });
      if (!current) throw new NotFoundException('Address not found');
      await transaction.address.update({
        data: { isDefault: false, status: 'DISABLED', version: { increment: 1 } },
        where: { storeId_id: { id: current.id, storeId: member.storeId } },
      });
    });
  }

  private async memberContext(authorization: string | undefined, storeCode: string) {
    if (!authorization?.startsWith('Bearer ') || authorization.length <= 7) {
      throw new UnauthorizedException('Member authentication is required');
    }
    const claims = await this.auth.authenticateAccessToken(authorization.slice(7), storeCode);
    if (claims.actorType !== 'member' || !claims.storeId) {
      throw new UnauthorizedException('Member authentication is required');
    }
    const stores = await this.database.$queryRaw<StoreRecord[]>`
      SELECT * FROM app_security.resolve_active_store(${storeCode.trim()})
    `;
    const store = stores[0];
    if (!store || store.id !== claims.storeId)
      throw new UnauthorizedException('Store context is invalid');
    return {
      context: createStoreContext({
        actor: { id: claims.subjectId, type: 'member' },
        correlationId: crypto.randomUUID(),
        locale: store.default_locale,
        storeCode: store.code,
        storeId: store.id,
      }),
      memberId: claims.subjectId,
      storeId: store.id,
    };
  }

  private async resolveAdministrativeAddress(
    transaction: StoreTransaction,
    storeId: string,
    input: { districtCode: string; provinceCode: string; wardCode: string },
  ) {
    const rows = await transaction.administrativeArea.findMany({
      where: {
        code: { in: [input.provinceCode, input.districtCode, input.wardCode] },
        enabled: true,
        storeId,
      },
    });
    const byCode = new Map(rows.map((row) => [row.code, row]));
    const province = byCode.get(input.provinceCode);
    const district = byCode.get(input.districtCode);
    const ward = byCode.get(input.wardCode);
    if (
      province?.level !== 'PROVINCE' ||
      province.parentCode !== null ||
      district?.level !== 'DISTRICT' ||
      district.parentCode !== province.code ||
      ward?.level !== 'WARD' ||
      ward.parentCode !== district.code
    ) {
      throw new BadRequestException('ADDRESS_REGION_INVALID');
    }
    return { district, province, ward };
  }

  private normalizePhone(value: string): string {
    try {
      return normalizeSupportedPhone(value);
    } catch {
      throw new BadRequestException('A valid Vietnam or mainland China mobile number is required');
    }
  }

  private render(row: {
    id: string;
    version: number;
    label: string | null;
    isDefault: boolean;
    status: string;
    provinceCode: string;
    provinceName: string;
    districtCode: string;
    districtName: string;
    wardCode: string;
    wardName: string;
    recipientNameCiphertext: string;
    phoneCiphertext: string;
    detailCiphertext: string;
    createdAt: Date;
    updatedAt: Date;
  }) {
    const phone = this.decrypt(row.phoneCiphertext);
    return {
      created_at: row.createdAt,
      detail: this.decrypt(row.detailCiphertext),
      district_code: row.districtCode,
      district_name: row.districtName,
      id: row.id,
      is_default: row.isDefault,
      label: row.label,
      masked_phone: `${phone.slice(0, 4)}****${phone.slice(-2)}`,
      province_code: row.provinceCode,
      province_name: row.provinceName,
      recipient_name: this.decrypt(row.recipientNameCiphertext),
      status: row.status,
      updated_at: row.updatedAt,
      version: row.version,
      ward_code: row.wardCode,
      ward_name: row.wardName,
    };
  }

  private decrypt(value: string): string {
    try {
      return decryptSensitive(value, this.config.PII_ENCRYPTION_KEY);
    } catch {
      throw new ConflictException('ADDRESS_DATA_INVALID');
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
  }
}
