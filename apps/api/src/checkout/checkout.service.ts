import { createHash, randomUUID } from 'node:crypto';

import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { PrismaClient, StoreTransaction } from '@zalo-shop/database';
import {
  InventoryPrimitiveError,
  reserveInventoryInTransaction,
  withStoreTransaction,
  type InventoryReservationResult,
} from '@zalo-shop/database';
import {
  calculateDeliveryFees,
  calculateOrderPayable,
  createStoreContext,
  isCodAmountAllowed,
  type StoreContext,
} from '@zalo-shop/domain';
import type { CheckoutOrderRequest, CheckoutQuoteRequest } from '@zalo-shop/contracts';

import { AuthService } from '../auth/auth.service';
import { DATABASE_CLIENT } from '../auth/auth.tokens';
import { PricingService } from '../pricing/pricing.service';

type StoreRecord = { id: string; code: string; default_locale: 'en' | 'vi' | 'zh' };
type MemberContext = {
  context: StoreContext;
  memberId: string;
  storeId: string;
  store: StoreRecord;
};
type CheckoutOrderResponse = {
  created_at: string;
  id: string;
  order_number: string;
  payable_vnd: number;
  payment_method: string;
  payment_status: string;
  status: string;
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b, 'en'))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function safeAmount(value: number | bigint): number {
  const amount = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isSafeInteger(amount) || amount < 0) throw new ConflictException('AMOUNT_INVALID');
  return amount;
}

function deterministicUuid(seed: string): string {
  const hex = createHash('sha256').update(seed, 'utf8').digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function databaseErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const record = error as { code?: unknown; meta?: unknown };
  if (record.code === 'P2010' && record.meta !== null && typeof record.meta === 'object') {
    const databaseCode = (record.meta as { code?: unknown }).code;
    if (typeof databaseCode === 'string') return databaseCode;
  }
  return typeof record.code === 'string' ? record.code : undefined;
}

@Injectable()
export class CheckoutService {
  public constructor(
    @Inject(DATABASE_CLIENT) private readonly database: PrismaClient,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(PricingService) private readonly pricing: PricingService,
  ) {}

  public async quote(input: {
    authorization?: string;
    request: CheckoutQuoteRequest;
    storeCode: string;
  }) {
    const member = await this.memberContext(
      input.authorization,
      input.storeCode,
      input.request.locale,
    );
    return withStoreTransaction(
      this.database,
      member.context,
      (transaction) => this.quoteInTransaction(transaction, member, input.request),
      { isolationLevel: 'RepeatableRead' },
    );
  }

  public async createOrder(input: {
    authorization?: string;
    idempotencyKey: string;
    request: CheckoutOrderRequest;
    storeCode: string;
  }): Promise<CheckoutOrderResponse> {
    const member = await this.memberContext(
      input.authorization,
      input.storeCode,
      input.request.locale,
    );
    const requestHash = hash(input.request);
    if (input.request.payment_method !== 'COD') {
      throw new ConflictException('COD_ONLY_IN_M4');
    }
    const orderId = deterministicUuid(
      `${member.storeId}:${member.memberId}:${input.idempotencyKey}`,
    );
    const execute = () =>
      withStoreTransaction(
        this.database,
        member.context,
        async (transaction) => {
          const lockKey = `${member.storeId}:${member.memberId}:${input.idempotencyKey}`;
          await transaction.$executeRaw`
            SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
          `;
          const current = await transaction.idempotencyRecord.findUnique({
            where: {
              storeId_operation_idempotencyKey: {
                idempotencyKey: input.idempotencyKey,
                operation: 'checkout.create-order',
                storeId: member.storeId,
              },
            },
          });
          if (current) {
            if (current.requestHash !== requestHash)
              throw new ConflictException('ORDER_IDEMPOTENCY_CONFLICT');
            return this.parseStoredOrderResponse(current.response);
          }

          const quote = await this.quoteInTransaction(transaction, member, input.request);
          if (quote.quote_hash !== input.request.quote_hash)
            throw new ConflictException('QUOTE_STALE');
          if (
            !isCodAmountAllowed({
              enabled: quote.cod_policy.enabled,
              maxAmountVnd: quote.cod_policy.max_amount_vnd,
              payableVnd: quote.order_payable_vnd,
            })
          ) {
            throw new ConflictException('COD_UNAVAILABLE');
          }

          const inventoryItems = await this.resolveInventoryItems(
            transaction,
            member,
            input.request.items,
          );
          const expirationRow = (
            await transaction.$queryRaw<
              Array<{ expires_at: Date }>
            >`SELECT CURRENT_TIMESTAMP + INTERVAL '15 minutes' AS expires_at`
          )[0];
          if (!expirationRow) throw new ConflictException('CHECKOUT_TIME_UNAVAILABLE');
          const expiration = expirationRow.expires_at;
          const reservation = (
            await reserveInventoryInTransaction(transaction, member.context, {
              expiresAt: expiration,
              items: inventoryItems,
              operationKey: `m4-order-reserve-${orderId}`,
              sourceId: orderId,
              sourceType: 'ORDER',
            })
          ).result;
          const cartId = await this.convertMatchingCart(transaction, member, input.request.items);
          const order = await this.persistOrder(
            transaction,
            member,
            input.request,
            quote,
            reservation,
            orderId,
            cartId,
          );
          await this.redeemCoupon(transaction, member, input.request.coupon_code, order.id);
          const response = this.renderOrder(order);
          await transaction.idempotencyRecord.create({
            data: {
              expiresAt: new Date(expiration.getTime() + 24 * 60 * 60 * 1_000),
              idempotencyKey: input.idempotencyKey,
              memberId: member.memberId,
              operation: 'checkout.create-order',
              orderId: order.id,
              requestHash,
              response,
              storeId: member.storeId,
            },
          });
          return response;
        },
        { isolationLevel: 'Serializable', timeout: 15_000 },
      );
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          return await execute();
        } catch (error) {
          const code = databaseErrorCode(error);
          if (
            (code === '40001' || code === '40P01' || code === 'P2028' || code === 'P2034') &&
            attempt === 0
          )
            continue;
          throw error;
        }
      }
      throw new ConflictException('CHECKOUT_CONCURRENT_CONFLICT');
    } catch (error) {
      if (error instanceof InventoryPrimitiveError) throw new ConflictException(error.code);
      if (['40001', '40P01', 'P2028', 'P2034'].includes(databaseErrorCode(error) ?? '')) {
        throw new ConflictException('CHECKOUT_CONCURRENT_CONFLICT');
      }
      throw error;
    }
  }

  private async quoteInTransaction(
    transaction: StoreTransaction,
    member: MemberContext,
    request: CheckoutQuoteRequest,
  ) {
    const address = await transaction.address.findFirst({
      where: { id: request.address_id, memberId: member.memberId, status: 'ACTIVE' },
    });
    if (!address) throw new NotFoundException('Address not found');
    await this.assertAddressRegion(transaction, member.storeId, address);
    const policy = await transaction.storeDeliveryPolicy.findUnique({
      where: { storeId: member.storeId },
    });
    if (!policy?.enabled) throw new ConflictException('DELIVERY_POLICY_UNAVAILABLE');
    const merchandise = await this.pricing.quoteMerchandise(transaction, {
      adminPreview: false,
      member: { id: member.memberId, storeId: member.storeId },
      request: {
        coupon_code: request.coupon_code,
        items: request.items,
        locale: request.locale,
      },
      storeId: member.storeId,
    });
    const blocking = merchandise.lines.some((line) => line.issues.length > 0);
    if (blocking)
      throw new ConflictException(
        merchandise.lines.flatMap((line) => line.issues)[0] ?? 'CART_INVALID',
      );
    const merchandisePayableVnd = safeAmount(merchandise.merchandise_payable_vnd);
    const fees = calculateDeliveryFees({
      merchandisePayableVnd,
      policy: {
        flatShippingFeeVnd: safeAmount(policy.flatShippingFeeVnd),
        freeShippingThresholdVnd:
          policy.freeShippingThresholdVnd === null
            ? null
            : safeAmount(policy.freeShippingThresholdVnd),
        isRemote: policy.remoteProvinceCodes.includes(address.provinceCode),
        remoteSurchargeVnd: safeAmount(policy.remoteSurchargeVnd),
      },
    });
    const discountByBucket = this.discountByBucket(merchandise);
    const orderPayableVnd = calculateOrderPayable({
      baseSubtotalVnd: safeAmount(merchandise.base_subtotal_vnd),
      couponDiscountVnd: discountByBucket.COUPON,
      itemDiscountVnd: discountByBucket.ITEM,
      orderDiscountVnd: discountByBucket.ORDER,
      remoteSurchargeVnd: fees.remoteSurchargeVnd,
      shippingDiscountVnd: fees.shippingDiscountVnd,
      shippingFeeVnd: fees.shippingFeeVnd,
    });
    // The M3 merchandise quote contains a request-time timestamp and its own
    // timestamp-bound hash. Exclude both volatile fields from the M4 acceptance
    // hash so a quote can be revalidated during order creation.
    const merchandiseFacts = Object.fromEntries(
      Object.entries(merchandise).filter(([key]) => key !== 'quote_hash' && key !== 'quoted_at'),
    );
    const quoteCore = {
      address_id: address.id,
      cod_policy: {
        enabled: policy.codEnabled,
        max_amount_vnd: policy.codMaxAmountVnd === null ? null : safeAmount(policy.codMaxAmountVnd),
      },
      delivery_policy: {
        cod_enabled: policy.codEnabled,
        cod_max_amount_vnd:
          policy.codMaxAmountVnd === null ? null : safeAmount(policy.codMaxAmountVnd),
        enabled: policy.enabled,
        flat_shipping_fee_vnd: safeAmount(policy.flatShippingFeeVnd),
        free_shipping_threshold_vnd:
          policy.freeShippingThresholdVnd === null
            ? null
            : safeAmount(policy.freeShippingThresholdVnd),
        remote_province_codes: policy.remoteProvinceCodes,
        remote_surcharge_vnd: safeAmount(policy.remoteSurchargeVnd),
        version: policy.version,
      },
      delivery_policy_version: policy.version,
      fees,
      merchandise: merchandiseFacts,
      order_payable_vnd: orderPayableVnd,
      store_id: member.storeId,
    };
    return {
      ...merchandise,
      cod_policy: quoteCore.cod_policy,
      delivery_policy: quoteCore.delivery_policy,
      delivery_policy_version: policy.version,
      order_payable_vnd: orderPayableVnd,
      remote_surcharge_vnd: fees.remoteSurchargeVnd,
      shipping_discount_vnd: fees.shippingDiscountVnd,
      shipping_fee_vnd: fees.shippingFeeVnd,
      quote_hash: hash(quoteCore),
    };
  }

  private async resolveInventoryItems(
    transaction: StoreTransaction,
    member: MemberContext,
    items: CheckoutQuoteRequest['items'],
  ) {
    const skus = await transaction.sku.findMany({
      select: {
        code: true,
        id: true,
        inventoryBalances: {
          orderBy: { warehouseId: 'asc' },
          select: { available: true, warehouseId: true },
          where: { warehouse: { enabled: true, isDefaultFulfillment: true } },
        },
      },
      where: { code: { in: items.map((item) => item.sku_code) }, storeId: member.storeId },
    });
    return items.map((item) => {
      const sku = skus.find((candidate) => candidate.code === item.sku_code);
      const balance = sku?.inventoryBalances[0];
      if (!sku || !balance || balance.available < item.quantity)
        throw new ConflictException('STOCK_INSUFFICIENT');
      return { quantity: item.quantity, skuId: sku.id, warehouseId: balance.warehouseId };
    });
  }

  private async assertAddressRegion(
    transaction: StoreTransaction,
    storeId: string,
    input: { districtCode: string; provinceCode: string; wardCode: string },
  ): Promise<void> {
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
      throw new ConflictException('ADDRESS_REGION_INVALID');
    }
  }

  private async convertMatchingCart(
    transaction: StoreTransaction,
    member: MemberContext,
    requestItems: CheckoutQuoteRequest['items'],
  ): Promise<string | null> {
    await transaction.$queryRaw`
      SELECT id
      FROM carts
      WHERE store_id = ${member.storeId}::uuid
        AND member_id = ${member.memberId}::uuid
        AND status = 'ACTIVE'
      FOR UPDATE
    `;
    const cart = await transaction.cart.findFirst({
      include: { items: { include: { sku: { select: { code: true } } } } },
      where: { memberId: member.memberId, status: 'ACTIVE', storeId: member.storeId },
    });
    if (!cart) return null;
    const selected = cart.items
      .filter((item) => item.selected)
      .map((item) => `${item.sku.code}:${item.quantity}`)
      .sort();
    const requested = requestItems.map((item) => `${item.sku_code}:${item.quantity}`).sort();
    if (
      selected.length !== requested.length ||
      selected.some((item, index) => item !== requested[index])
    ) {
      return null;
    }

    await transaction.cart.update({
      data: { status: 'CONVERTED', version: { increment: 1 } },
      where: { storeId_id: { id: cart.id, storeId: member.storeId } },
    });
    const nextCart = await transaction.cart.create({
      data: { memberId: member.memberId, storeId: member.storeId },
    });
    const remaining = cart.items.filter((item) => !item.selected);
    if (remaining.length > 0) {
      await transaction.cartItem.createMany({
        data: remaining.map((item) => ({
          addedPromotionFingerprint: item.addedPromotionFingerprint,
          addedUnitPriceVnd: item.addedUnitPriceVnd,
          cartId: nextCart.id,
          quantity: item.quantity,
          selected: false,
          skuId: item.skuId,
          storeId: member.storeId,
        })),
      });
    }
    return cart.id;
  }

  private async redeemCoupon(
    transaction: StoreTransaction,
    member: MemberContext,
    couponCode: string | null,
    orderId: string,
  ): Promise<void> {
    if (couponCode === null) return;
    const coupon = await transaction.coupon.findUnique({
      select: { id: true },
      where: { storeId_code: { code: couponCode, storeId: member.storeId } },
    });
    if (!coupon) throw new ConflictException('COUPON_INVALID');
    const redeemed = await transaction.memberCoupon.updateMany({
      data: { status: 'USED', usedAt: new Date(), usedOrderId: orderId },
      where: {
        couponId: coupon.id,
        memberId: member.memberId,
        status: 'CLAIMED',
        storeId: member.storeId,
        usedOrderId: null,
      },
    });
    if (redeemed.count !== 1) throw new ConflictException('COUPON_INVALID');
  }

  private async persistOrder(
    transaction: StoreTransaction,
    member: MemberContext,
    request: CheckoutOrderRequest,
    quote: Awaited<ReturnType<CheckoutService['quoteInTransaction']>>,
    reservation: InventoryReservationResult,
    orderId: string,
    cartId: string | null,
  ) {
    const address = await transaction.address.findFirst({
      where: { id: request.address_id, memberId: member.memberId, status: 'ACTIVE' },
    });
    if (!address) throw new NotFoundException('Address not found');
    const skus = await transaction.sku.findMany({
      include: {
        products: {
          include: {
            brands: { include: { brand_localizations: true } },
            categories: { include: { category_localizations: true } },
            product_localizations: true,
          },
        },
        sku_option_values: true,
      },
      where: { code: { in: request.items.map((item) => item.sku_code) }, storeId: member.storeId },
    });
    const lines = new Map(quote.lines.map((line) => [line.sku_code, line]));
    const discounts = this.discountByBucket(quote);
    const order = await transaction.order.create({
      data: {
        addressId: address.id,
        baseSubtotalVnd: BigInt(quote.base_subtotal_vnd),
        cartId,
        couponDiscountVnd: BigInt(discounts.COUPON),
        currency: 'VND',
        id: orderId,
        itemDiscountVnd: BigInt(discounts.ITEM),
        memberId: member.memberId,
        orderDiscountVnd: BigInt(discounts.ORDER),
        orderNumber: `M4-${Date.now().toString(36).toUpperCase()}-${orderId.slice(0, 8).toUpperCase()}`,
        payableVnd: BigInt(quote.order_payable_vnd),
        paymentMethod: 'COD',
        paymentStatus: 'PENDING',
        quoteHash: quote.quote_hash,
        remoteSurchargeVnd: BigInt(quote.remote_surcharge_vnd),
        reservationId: reservation.reservation_id,
        shippingDiscountVnd: BigInt(quote.shipping_discount_vnd),
        shippingFeeVnd: BigInt(quote.shipping_fee_vnd),
        storeId: member.storeId,
      },
    });
    for (const item of request.items) {
      const sku = skus.find((candidate) => candidate.code === item.sku_code);
      const line = lines.get(item.sku_code);
      if (!sku || !line) throw new ConflictException('SKU_NOT_FOUND');
      const product = sku.products;
      const productName = this.localized(product.product_localizations, request.locale, 'name');
      const brandName = this.localized(product.brands.brand_localizations, request.locale, 'name');
      await transaction.orderItem.create({
        data: {
          brandId: product.brandId,
          brandName,
          categoryId: product.mainCategoryId,
          couponDiscountVnd: BigInt(this.lineDiscount(line, 'COUPON')),
          itemDiscountVnd: BigInt(this.lineDiscount(line, 'ITEM')),
          orderDiscountVnd: BigInt(this.lineDiscount(line, 'ORDER')),
          optionSnapshot: sku.sku_option_values,
          orderId: order.id,
          payableVnd: BigInt(line.payable_vnd),
          productId: product.id,
          productName,
          quantity: item.quantity,
          skuCode: sku.code,
          skuId: sku.id,
          storeId: member.storeId,
          subtotalVnd: BigInt(line.base_subtotal_vnd),
          unitPriceVnd: BigInt(line.base_unit_price_vnd),
        },
      });
    }
    const addressPayload = {
      detail_ciphertext: address.detailCiphertext,
      district_code: address.districtCode,
      district_name: address.districtName,
      phone_ciphertext: address.phoneCiphertext,
      province_code: address.provinceCode,
      province_name: address.provinceName,
      recipient_name_ciphertext: address.recipientNameCiphertext,
      ward_code: address.wardCode,
      ward_name: address.wardName,
    };
    const snapshots = [
      { payload: addressPayload, type: 'ADDRESS' as const },
      { payload: quote, type: 'PRICING' as const },
      {
        payload: quote.delivery_policy,
        type: 'DELIVERY_POLICY' as const,
      },
      { payload: { coupon_code: request.coupon_code }, type: 'COUPON' as const },
    ];
    for (const snapshot of snapshots) {
      await transaction.orderSnapshot.create({
        data: {
          orderId: order.id,
          payload: snapshot.payload,
          payloadHash: hash(snapshot.payload),
          snapshotType: snapshot.type,
          storeId: member.storeId,
        },
      });
    }
    await transaction.orderTransition.create({
      data: {
        actorId: member.memberId,
        actorType: 'MEMBER',
        correlationId: member.context.correlationId,
        event: 'SUBMIT_COD',
        fromStatus: null,
        orderId: order.id,
        storeId: member.storeId,
        toStatus: 'PENDING_CONFIRMATION',
      },
    });
    return order;
  }

  private discountByBucket(quote: {
    lines: Array<{ applied_rules: Array<{ bucket: string; discount_vnd: number }> }>;
  }) {
    const values = { COUPON: 0, ITEM: 0, ORDER: 0 };
    for (const line of quote.lines) {
      for (const rule of line.applied_rules) {
        if (rule.bucket === 'COUPON' || rule.bucket === 'ITEM' || rule.bucket === 'ORDER')
          values[rule.bucket] += rule.discount_vnd;
      }
    }
    return values;
  }

  private lineDiscount(
    line: { applied_rules: Array<{ bucket: string; discount_vnd: number }> },
    bucket: string,
  ) {
    return line.applied_rules
      .filter((rule) => rule.bucket === bucket)
      .reduce((sum, rule) => sum + rule.discount_vnd, 0);
  }

  private localized(
    rows: Array<{ locale: string; [key: string]: unknown }>,
    locale: string,
    field: string,
  ): string {
    const row =
      rows.find((item) => item.locale === locale) ?? rows.find((item) => item.locale === 'vi');
    const value = row?.[field];
    return typeof value === 'string' ? value : 'Unnamed';
  }

  private renderOrder(order: {
    id: string;
    orderNumber: string;
    status: string;
    paymentMethod: string;
    paymentStatus: string;
    payableVnd: bigint;
    createdAt: Date;
  }): CheckoutOrderResponse {
    return {
      created_at: order.createdAt.toISOString(),
      id: order.id,
      order_number: order.orderNumber,
      payable_vnd: safeAmount(order.payableVnd),
      payment_method: order.paymentMethod,
      payment_status: order.paymentStatus,
      status: order.status,
    };
  }

  private parseStoredOrderResponse(value: unknown): CheckoutOrderResponse {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new ConflictException('ORDER_IDEMPOTENCY_RECORD_INVALID');
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.created_at !== 'string' ||
      typeof record.id !== 'string' ||
      typeof record.order_number !== 'string' ||
      typeof record.payable_vnd !== 'number' ||
      !Number.isSafeInteger(record.payable_vnd) ||
      typeof record.payment_method !== 'string' ||
      typeof record.payment_status !== 'string' ||
      typeof record.status !== 'string'
    ) {
      throw new ConflictException('ORDER_IDEMPOTENCY_RECORD_INVALID');
    }
    return {
      created_at: record.created_at,
      id: record.id,
      order_number: record.order_number,
      payable_vnd: record.payable_vnd,
      payment_method: record.payment_method,
      payment_status: record.payment_status,
      status: record.status,
    };
  }

  private async memberContext(
    authorization: string | undefined,
    storeCode: string,
    locale: 'en' | 'vi' | 'zh',
  ): Promise<MemberContext> {
    if (!authorization?.startsWith('Bearer ') || authorization.length <= 7)
      throw new UnauthorizedException('Member authentication is required');
    const claims = await this.auth.authenticateAccessToken(authorization.slice(7), storeCode);
    if (claims.actorType !== 'member' || !claims.storeId)
      throw new UnauthorizedException('Member authentication is required');
    const stores = await this.database.$queryRaw<
      StoreRecord[]
    >`SELECT * FROM app_security.resolve_active_store(${storeCode.trim()})`;
    const store = stores[0];
    if (!store || store.id !== claims.storeId)
      throw new UnauthorizedException('Store context is invalid');
    return {
      context: createStoreContext({
        actor: { id: claims.subjectId, type: 'member' },
        correlationId: randomUUID(),
        locale,
        storeCode: store.code,
        storeId: store.id,
      }),
      memberId: claims.subjectId,
      store,
      storeId: store.id,
    };
  }
}
