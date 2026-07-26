import { createHash } from 'node:crypto';

import type { Prisma, PrismaClient } from '@prisma/client';
import {
  orderEventsForShipmentStatus,
  ShipmentStateError,
  transitionOrderStatus,
  transitionShipmentStatus,
  type ShipmentStatus,
  type StoreContext,
} from '@zalo-shop/domain';

import { appendOutboxMessageInTransaction } from './reliable-messaging';
import { type StoreTransaction, withStoreTransaction } from './index';

export const SHIPMENT_CREATE_EVENT_TYPE = 'shipment.create.requested';
export const SHIPMENT_CANCEL_EVENT_TYPE = 'shipment.cancel.requested';
export const SHIPMENT_QUERY_EVENT_TYPE = 'shipment.query.requested';

export type ShippingCommandErrorCode =
  | 'SHIPPING_CHANNEL_UNAVAILABLE'
  | 'SHIPMENT_NOT_FOUND'
  | 'SHIPMENT_CONFLICT'
  | 'SHIPMENT_FACT_INVALID'
  | 'SHIPMENT_OPERATION_NOT_FOUND'
  | 'SHIPMENT_PHYSICAL_FACTS_INCOMPLETE'
  | 'SHIPMENT_ADDRESS_FACTS_INVALID'
  | 'WAREHOUSE_FULFILLMENT_PROFILE_UNAVAILABLE';

export class ShippingCommandError extends Error {
  public constructor(public readonly code: ShippingCommandErrorCode) {
    super(code);
    this.name = 'ShippingCommandError';
  }
}

export type ShippingChannelSnapshot = Readonly<{
  id: string;
  keyVersion: string;
  originAllowlistKey: string;
  providerCode: string;
  providerEnvironment: 'SANDBOX' | 'PRODUCTION';
  shopId: string;
  tokenSecretRef: string;
  version: number;
}>;

export type EncryptedShippingAddress = Readonly<{
  addressLineCiphertext: string;
  districtCode: string;
  nameCiphertext: string;
  phoneCiphertext: string;
  provinceCode: string;
  wardCode: string;
}>;

export type ShippingCreationRequest = Readonly<{
  channel: ShippingChannelSnapshot;
  clientOrderCode: string;
  codAmountVnd: number;
  destination: EncryptedShippingAddress;
  inspectionPolicy: 'NO_INSPECTION' | 'ALLOW_INSPECTION_NO_TRY_ON';
  items: readonly Readonly<{ name: string; quantity: number; skuCode: string }>[];
  operationId: string;
  operationStatus: string;
  origin: EncryptedShippingAddress;
  parcel: Readonly<{
    heightCm: number;
    lengthCm: number;
    weightGrams: number;
    widthCm: number;
  }>;
  serviceCode: string;
  shipmentId: string;
  status: ShipmentStatus;
  storeId: string;
}>;

export type ShippingQuotePreparation = Readonly<{
  channel: ShippingChannelSnapshot;
  codAmountVnd: number;
  destination: EncryptedShippingAddress;
  orderId: string;
  orderVersion: number;
  origin: EncryptedShippingAddress;
  parcel: Readonly<{
    heightCm: number;
    lengthCm: number;
    weightGrams: number;
    widthCm: number;
  }>;
  requestHash: string;
  serviceCode: string;
  storeId: string;
}>;

export type ShippingProviderFactInput = Readonly<{
  clientOrderCode?: string;
  occurredAt?: Date;
  providerShipmentId: string;
  providerStatus: string;
  status?: ShipmentStatus;
}>;

export type ShipmentCommandResult = Readonly<{
  operationId: string;
  operationStatus: string;
  orderId: string;
  providerShipmentReferenceMasked: string | null;
  publicShipmentNumber: string;
  replayed: boolean;
  shipmentId: string;
  status: ShipmentStatus;
  version: number;
}>;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function deterministicUuid(seed: string): string {
  const hex = createHash('sha256').update(seed, 'utf8').digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function record(value: Prisma.JsonValue | string): Record<string, Prisma.JsonValue> {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new ShippingCommandError('SHIPMENT_ADDRESS_FACTS_INVALID');
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ShippingCommandError('SHIPMENT_ADDRESS_FACTS_INVALID');
  }
  return parsed as Record<string, Prisma.JsonValue>;
}

function requiredString(
  value: Prisma.JsonValue | undefined,
  code: ShippingCommandErrorCode = 'SHIPMENT_ADDRESS_FACTS_INVALID',
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ShippingCommandError(code);
  }
  return value;
}

function safeAmount(value: bigint, allowZero = true): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < (allowZero ? 0 : 1)) {
    throw new ShippingCommandError('SHIPMENT_FACT_INVALID');
  }
  return amount;
}

function maskProviderReference(value: string | null): string | null {
  if (!value) return null;
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${value.slice(0, 2)}${'*'.repeat(Math.min(8, value.length - 4))}${value.slice(-2)}`;
}

function channelSnapshot(channel: {
  id: string;
  keyVersion: string;
  originAllowlistKey: string;
  providerCode: string;
  providerEnvironment: 'SANDBOX' | 'PRODUCTION';
  shopId: string;
  tokenSecretRef: string;
  version: number;
}): ShippingChannelSnapshot {
  return { ...channel };
}

function encryptedDestination(snapshot: Prisma.JsonValue): EncryptedShippingAddress {
  const value = record(snapshot);
  return {
    addressLineCiphertext: requiredString(value.detail_ciphertext),
    districtCode: requiredString(value.district_code),
    nameCiphertext: requiredString(value.recipient_name_ciphertext),
    phoneCiphertext: requiredString(value.phone_ciphertext),
    provinceCode: requiredString(value.province_code),
    wardCode: requiredString(value.ward_code),
  };
}

function encryptedOrigin(value: Prisma.JsonValue): EncryptedShippingAddress {
  const profile = record(value);
  return {
    addressLineCiphertext: requiredString(profile.detail_ciphertext),
    districtCode: requiredString(profile.district_code),
    nameCiphertext: requiredString(profile.contact_name_ciphertext),
    phoneCiphertext: requiredString(profile.phone_ciphertext),
    provinceCode: requiredString(profile.province_code),
    wardCode: requiredString(profile.ward_code),
  };
}

function parcelSnapshot(value: Prisma.JsonValue): {
  heightCm: number;
  inspectionPolicy: 'NO_INSPECTION' | 'ALLOW_INSPECTION_NO_TRY_ON';
  lengthCm: number;
  origin: EncryptedShippingAddress;
  weightGrams: number;
  widthCm: number;
} {
  const snapshot = record(value);
  const integer = (key: string): number => {
    const item = snapshot[key];
    if (typeof item !== 'number' || !Number.isSafeInteger(item) || item <= 0) {
      throw new ShippingCommandError('SHIPMENT_PHYSICAL_FACTS_INCOMPLETE');
    }
    return item;
  };
  const inspectionPolicy = snapshot.inspection_policy;
  if (inspectionPolicy !== 'NO_INSPECTION' && inspectionPolicy !== 'ALLOW_INSPECTION_NO_TRY_ON') {
    throw new ShippingCommandError('SHIPMENT_FACT_INVALID');
  }
  if (snapshot.origin === undefined) {
    throw new ShippingCommandError('SHIPMENT_ADDRESS_FACTS_INVALID');
  }
  return {
    heightCm: integer('height_cm'),
    inspectionPolicy,
    lengthCm: integer('length_cm'),
    origin: encryptedOrigin(snapshot.origin),
    weightGrams: integer('weight_grams'),
    widthCm: integer('width_cm'),
  };
}

function commandResult(
  shipment: {
    id: string;
    orderId: string;
    providerShipmentId: string | null;
    publicShipmentNumber: string;
    status: ShipmentStatus;
    version: number;
  },
  operation: { id: string; status: string },
  replayed: boolean,
): ShipmentCommandResult {
  return {
    operationId: operation.id,
    operationStatus: operation.status,
    orderId: shipment.orderId,
    providerShipmentReferenceMasked: maskProviderReference(shipment.providerShipmentId),
    publicShipmentNumber: shipment.publicShipmentNumber,
    replayed,
    shipmentId: shipment.id,
    status: shipment.status,
    version: shipment.version,
  };
}

function physicalParcel(
  items: readonly Readonly<{
    heightMillimeters: number | null;
    lengthMillimeters: number | null;
    quantity: number;
    weightGrams: number | null;
    widthMillimeters: number | null;
  }>[],
): { heightCm: number; lengthCm: number; weightGrams: number; widthCm: number } {
  if (
    items.length === 0 ||
    items.some(
      (item) =>
        item.heightMillimeters === null ||
        item.lengthMillimeters === null ||
        item.weightGrams === null ||
        item.widthMillimeters === null ||
        item.quantity <= 0,
    )
  ) {
    throw new ShippingCommandError('SHIPMENT_PHYSICAL_FACTS_INCOMPLETE');
  }
  const weightGrams = items.reduce((sum, item) => sum + item.weightGrams! * item.quantity, 0);
  const heightMillimeters = items.reduce(
    (sum, item) => sum + item.heightMillimeters! * item.quantity,
    0,
  );
  const lengthMillimeters = Math.max(...items.map((item) => item.lengthMillimeters!));
  const widthMillimeters = Math.max(...items.map((item) => item.widthMillimeters!));
  const parcel = {
    heightCm: Math.ceil(heightMillimeters / 10),
    lengthCm: Math.ceil(lengthMillimeters / 10),
    weightGrams,
    widthCm: Math.ceil(widthMillimeters / 10),
  };
  if (
    !Number.isSafeInteger(weightGrams) ||
    weightGrams <= 0 ||
    Object.values(parcel).some((value) => !Number.isSafeInteger(value) || value <= 0)
  ) {
    throw new ShippingCommandError('SHIPMENT_PHYSICAL_FACTS_INCOMPLETE');
  }
  return parcel;
}

export function createShipmentCommand(
  client: PrismaClient,
  context: StoreContext,
  input: Readonly<{
    expectedOrderVersion: number;
    idempotencyKey: string;
    inspectionPolicy: 'NO_INSPECTION' | 'ALLOW_INSPECTION_NO_TRY_ON';
    orderId: string;
    providerEnvironment: 'SANDBOX' | 'PRODUCTION';
    reason: string;
    serviceCode: string;
  }>,
): Promise<ShipmentCommandResult> {
  return withStoreTransaction(
    client,
    context,
    async (transaction) => {
      await transaction.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`${context.storeId}:${input.orderId}:shipment`}, 0))
      `;
      const orderRows = await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM orders
        WHERE store_id = ${context.storeId}::uuid AND id = ${input.orderId}::uuid
        FOR UPDATE
      `;
      if (orderRows.length !== 1) throw new ShippingCommandError('SHIPMENT_NOT_FOUND');
      const order = await transaction.order.findFirst({
        include: {
          items: { orderBy: { id: 'asc' } },
          reservation: { include: { items: true } },
          snapshots: { where: { snapshotType: 'ADDRESS' } },
        },
        where: { id: input.orderId, storeId: context.storeId },
      });
      if (!order) throw new ShippingCommandError('SHIPMENT_NOT_FOUND');
      const channel = await transaction.storeShippingChannel.findFirst({
        where: {
          providerCode: 'GHN',
          providerEnvironment: input.providerEnvironment,
          storeId: context.storeId,
        },
      });
      if (!channel) throw new ShippingCommandError('SHIPPING_CHANNEL_UNAVAILABLE');
      const requestHash = digest({
        expected_order_version: input.expectedOrderVersion,
        inspection_policy: input.inspectionPolicy,
        order_id: input.orderId,
        reason: input.reason,
        service_code: input.serviceCode,
      });
      const idempotencyKeyHash = digest(input.idempotencyKey);
      const existingOperation = await transaction.shippingOperation.findUnique({
        where: {
          storeId_channelId_operationType_idempotencyKeyHash: {
            channelId: channel.id,
            idempotencyKeyHash,
            operationType: 'CREATE',
            storeId: context.storeId,
          },
        },
      });
      if (existingOperation) {
        if (existingOperation.requestHash !== requestHash || !existingOperation.shipmentId) {
          throw new ShippingCommandError('SHIPMENT_CONFLICT');
        }
        const existingShipment = await transaction.shipment.findFirst({
          where: { id: existingOperation.shipmentId, storeId: context.storeId },
        });
        if (!existingShipment) throw new ShippingCommandError('SHIPMENT_CONFLICT');
        return commandResult(existingShipment, existingOperation, true);
      }
      if (
        channel.status !== 'ACTIVE' ||
        order.status !== 'PENDING_FULFILLMENT' ||
        order.version !== input.expectedOrderVersion
      ) {
        throw new ShippingCommandError('SHIPMENT_CONFLICT');
      }
      const warehouseIds = new Set(order.reservation?.items.map((item) => item.warehouseId) ?? []);
      if (warehouseIds.size !== 1) {
        throw new ShippingCommandError('WAREHOUSE_FULFILLMENT_PROFILE_UNAVAILABLE');
      }
      const warehouseId = [...warehouseIds][0]!;
      const warehouse = await transaction.warehouse.findFirst({
        include: { fulfillmentProfile: true },
        where: { enabled: true, id: warehouseId, storeId: context.storeId },
      });
      if (!warehouse?.fulfillmentProfile?.enabled) {
        throw new ShippingCommandError('WAREHOUSE_FULFILLMENT_PROFILE_UNAVAILABLE');
      }
      const active = await transaction.shipment.findFirst({
        where: {
          orderId: order.id,
          status: { notIn: ['DELIVERED', 'RETURNED', 'CANCELLED'] },
          storeId: context.storeId,
        },
      });
      if (active) throw new ShippingCommandError('SHIPMENT_CONFLICT');
      const destinationSnapshot = order.snapshots[0]?.payload;
      if (!destinationSnapshot) throw new ShippingCommandError('SHIPMENT_ADDRESS_FACTS_INVALID');
      encryptedDestination(destinationSnapshot);
      const parcel = physicalParcel(order.items);
      const shipmentId = deterministicUuid(
        `${context.storeId}:${order.id}:shipment:${idempotencyKeyHash}`,
      );
      const operationId = deterministicUuid(`${shipmentId}:create`);
      const publicShipmentNumber = `SHP-${shipmentId.replaceAll('-', '').toUpperCase()}`;
      const operation = await transaction.shippingOperation.create({
        data: {
          channelId: channel.id,
          correlationId: context.correlationId,
          id: operationId,
          idempotencyKeyHash,
          operationType: 'CREATE',
          orderId: order.id,
          requestHash,
          storeId: context.storeId,
        },
      });
      const profile = warehouse.fulfillmentProfile;
      const shipment = await transaction.shipment.create({
        data: {
          addressSnapshotCiphertext: stableJson(destinationSnapshot),
          channelId: channel.id,
          clientOrderCode: publicShipmentNumber,
          codAmountVnd: order.paymentMethod === 'COD' ? order.payableVnd : 0,
          createdOperationId: operation.id,
          id: shipmentId,
          orderId: order.id,
          parcelSnapshot: {
            height_cm: parcel.heightCm,
            inspection_policy: input.inspectionPolicy,
            length_cm: parcel.lengthCm,
            origin: {
              contact_name_ciphertext: profile.contactNameCiphertext,
              detail_ciphertext: profile.detailCiphertext,
              district_code: profile.districtCode,
              phone_ciphertext: profile.phoneCiphertext,
              province_code: profile.provinceCode,
              ward_code: profile.wardCode,
            },
            weight_grams: parcel.weightGrams,
            width_cm: parcel.widthCm,
          },
          publicShipmentNumber,
          serviceCode: input.serviceCode,
          status: 'CREATION_PENDING',
          storeId: context.storeId,
          warehouseId,
        },
      });
      await transaction.shipmentItem.createMany({
        data: order.items.map((item) => ({
          orderId: order.id,
          orderItemId: item.id,
          quantity: item.quantity,
          shipmentId: shipment.id,
          storeId: context.storeId,
        })),
      });
      await transaction.shippingOperation.update({
        data: { shipmentId: shipment.id },
        where: { storeId_id: { id: operation.id, storeId: context.storeId } },
      });
      await appendOutboxMessageInTransaction(transaction, context, {
        aggregateId: shipment.id,
        aggregateType: 'SHIPMENT',
        eventType: SHIPMENT_CREATE_EVENT_TYPE,
        eventVersion: 1,
        idempotencyKey: `${SHIPMENT_CREATE_EVENT_TYPE}:${shipment.id}`,
        payload: {
          operation_id: operation.id,
          shipment_id: shipment.id,
          store_id: context.storeId,
        },
      });
      await transaction.auditLog.create({
        data: {
          action: 'shipping.shipment.create_requested',
          actorId: context.actor.id,
          actorType: 'ADMIN',
          afterData: {
            operation_id: operation.id,
            order_id: order.id,
            shipment_id: shipment.id,
            status: shipment.status,
          },
          correlationId: context.correlationId,
          reason: input.reason,
          storeId: context.storeId,
          targetId: shipment.id,
          targetType: 'shipment',
        },
      });
      return commandResult(shipment, operation, false);
    },
    { isolationLevel: 'Serializable', timeout: 15_000 },
  );
}

export function getShippingQuotePreparation(
  client: PrismaClient,
  context: StoreContext,
  input: Readonly<{
    orderId: string;
    providerEnvironment: 'SANDBOX' | 'PRODUCTION';
    serviceCode?: string;
  }>,
): Promise<ShippingQuotePreparation> {
  return withStoreTransaction(client, context, async (transaction) => {
    const order = await transaction.order.findFirst({
      include: {
        items: { orderBy: { id: 'asc' } },
        reservation: { include: { items: true } },
        snapshots: { where: { snapshotType: 'ADDRESS' } },
      },
      where: { id: input.orderId, storeId: context.storeId },
    });
    if (!order) throw new ShippingCommandError('SHIPMENT_NOT_FOUND');
    if (order.status !== 'PENDING_FULFILLMENT') {
      throw new ShippingCommandError('SHIPMENT_CONFLICT');
    }
    const warehouseIds = new Set(order.reservation?.items.map((item) => item.warehouseId) ?? []);
    if (warehouseIds.size !== 1) {
      throw new ShippingCommandError('WAREHOUSE_FULFILLMENT_PROFILE_UNAVAILABLE');
    }
    const warehouse = await transaction.warehouse.findFirst({
      include: { fulfillmentProfile: true },
      where: { enabled: true, id: [...warehouseIds][0], storeId: context.storeId },
    });
    if (!warehouse?.fulfillmentProfile?.enabled) {
      throw new ShippingCommandError('WAREHOUSE_FULFILLMENT_PROFILE_UNAVAILABLE');
    }
    const channel = await transaction.storeShippingChannel.findFirst({
      where: {
        providerCode: 'GHN',
        providerEnvironment: input.providerEnvironment,
        status: 'ACTIVE',
        storeId: context.storeId,
      },
    });
    if (!channel) throw new ShippingCommandError('SHIPPING_CHANNEL_UNAVAILABLE');
    const serviceCode = input.serviceCode ?? channel.defaultServiceCode;
    if (!serviceCode) throw new ShippingCommandError('SHIPPING_CHANNEL_UNAVAILABLE');
    const address = order.snapshots[0]?.payload;
    if (!address) throw new ShippingCommandError('SHIPMENT_ADDRESS_FACTS_INVALID');
    const destination = encryptedDestination(address);
    const profile = warehouse.fulfillmentProfile;
    const origin: EncryptedShippingAddress = {
      addressLineCiphertext: profile.detailCiphertext,
      districtCode: profile.districtCode,
      nameCiphertext: profile.contactNameCiphertext,
      phoneCiphertext: profile.phoneCiphertext,
      provinceCode: profile.provinceCode,
      wardCode: profile.wardCode,
    };
    const parcel = physicalParcel(order.items);
    const requestHash = digest({
      address_snapshot: address,
      channel_id: channel.id,
      cod_amount_vnd: order.paymentMethod === 'COD' ? order.payableVnd.toString() : '0',
      order_id: order.id,
      order_version: order.version,
      origin,
      parcel,
      service_code: serviceCode,
    });
    return {
      channel: channelSnapshot(channel),
      codAmountVnd: order.paymentMethod === 'COD' ? safeAmount(order.payableVnd) : 0,
      destination,
      orderId: order.id,
      orderVersion: order.version,
      origin,
      parcel,
      requestHash,
      serviceCode,
      storeId: context.storeId,
    };
  });
}

export function recordShippingQuote(
  client: PrismaClient,
  context: StoreContext,
  input: Readonly<{
    baseFeeVnd: number;
    channelId: string;
    codFeeVnd: number;
    estimatedDeliveryAt?: Date;
    expiresAt: Date;
    insuranceFeeVnd: number;
    orderId: string;
    orderVersion: number;
    otherFeeVnd: number;
    providerQuoteId?: string;
    providerServiceId?: number;
    providerServiceTypeId?: number;
    remoteFeeVnd: number;
    requestHash: string;
    serviceCode: string;
    totalFeeVnd: number;
  }>,
) {
  return withStoreTransaction(client, context, async (transaction) => {
    const fees = [
      input.baseFeeVnd,
      input.insuranceFeeVnd,
      input.codFeeVnd,
      input.remoteFeeVnd,
      input.otherFeeVnd,
    ];
    const calculatedTotal = fees.reduce((total, fee) => total + fee, 0);
    if (
      fees.some((fee) => !Number.isSafeInteger(fee) || fee < 0) ||
      !Number.isSafeInteger(calculatedTotal) ||
      !Number.isSafeInteger(input.totalFeeVnd) ||
      input.totalFeeVnd !== calculatedTotal ||
      (input.providerServiceId !== undefined &&
        (!Number.isSafeInteger(input.providerServiceId) || input.providerServiceId <= 0)) ||
      (input.providerServiceTypeId !== undefined &&
        (!Number.isSafeInteger(input.providerServiceTypeId) || input.providerServiceTypeId <= 0)) ||
      (input.providerQuoteId !== undefined &&
        (input.providerQuoteId.trim().length === 0 || input.providerQuoteId.length > 160)) ||
      !/^[0-9a-f]{64}$/u.test(input.requestHash) ||
      input.expiresAt.getTime() <= Date.now()
    ) {
      throw new ShippingCommandError('SHIPMENT_FACT_INVALID');
    }
    const order = await transaction.order.findFirst({
      where: {
        id: input.orderId,
        status: 'PENDING_FULFILLMENT',
        storeId: context.storeId,
        version: input.orderVersion,
      },
    });
    const channel = await transaction.storeShippingChannel.findFirst({
      where: { id: input.channelId, status: 'ACTIVE', storeId: context.storeId },
    });
    if (!order || !channel) throw new ShippingCommandError('SHIPMENT_CONFLICT');
    const quote = await transaction.shippingQuote.create({
      data: {
        baseFeeVnd: input.baseFeeVnd,
        channelId: channel.id,
        codFeeVnd: input.codFeeVnd,
        ...(input.estimatedDeliveryAt ? { estimatedDeliveryAt: input.estimatedDeliveryAt } : {}),
        expiresAt: input.expiresAt,
        insuranceFeeVnd: input.insuranceFeeVnd,
        orderId: order.id,
        otherFeeVnd: input.otherFeeVnd,
        ...(input.providerQuoteId ? { providerQuoteRef: input.providerQuoteId } : {}),
        ...(input.providerServiceId ? { providerServiceId: input.providerServiceId } : {}),
        ...(input.providerServiceTypeId
          ? { providerServiceTypeId: input.providerServiceTypeId }
          : {}),
        remoteFeeVnd: input.remoteFeeVnd,
        requestHash: input.requestHash,
        serviceCode: input.serviceCode,
        source: 'PROVIDER',
        storeId: context.storeId,
        totalFeeVnd: input.totalFeeVnd,
      },
    });
    return {
      baseFeeVnd: safeAmount(quote.baseFeeVnd),
      codFeeVnd: safeAmount(quote.codFeeVnd),
      estimatedDeliveryAt: quote.estimatedDeliveryAt,
      expiresAt: quote.expiresAt,
      id: quote.id,
      insuranceFeeVnd: safeAmount(quote.insuranceFeeVnd),
      otherFeeVnd: safeAmount(quote.otherFeeVnd),
      providerQuoteId: quote.providerQuoteRef,
      providerServiceId: quote.providerServiceId,
      providerServiceTypeId: quote.providerServiceTypeId,
      remoteFeeVnd: safeAmount(quote.remoteFeeVnd),
      serviceCode: quote.serviceCode,
      source: quote.source,
      totalFeeVnd: safeAmount(quote.totalFeeVnd),
    };
  });
}

export function getShipmentCreationRequest(
  client: PrismaClient,
  context: StoreContext,
  shipmentId: string,
  operationId: string,
): Promise<ShippingCreationRequest> {
  return withStoreTransaction(client, context, async (transaction) => {
    const shipment = await transaction.shipment.findFirst({
      include: {
        channel: true,
        items: { include: { orderItem: true }, orderBy: { orderItemId: 'asc' } },
        operations: { where: { id: operationId, operationType: 'CREATE' } },
      },
      where: { id: shipmentId, storeId: context.storeId },
    });
    const operation = shipment?.operations[0];
    if (!shipment || !operation) throw new ShippingCommandError('SHIPMENT_OPERATION_NOT_FOUND');
    const parcel = parcelSnapshot(shipment.parcelSnapshot);
    return {
      channel: channelSnapshot(shipment.channel),
      clientOrderCode: shipment.clientOrderCode,
      codAmountVnd: safeAmount(shipment.codAmountVnd),
      destination: encryptedDestination(shipment.addressSnapshotCiphertext),
      inspectionPolicy: parcel.inspectionPolicy,
      items: shipment.items.map((item) => ({
        name: item.orderItem.productName,
        quantity: item.quantity,
        skuCode: item.orderItem.skuCode,
      })),
      operationId: operation.id,
      operationStatus: operation.status,
      origin: parcel.origin,
      parcel: {
        heightCm: parcel.heightCm,
        lengthCm: parcel.lengthCm,
        weightGrams: parcel.weightGrams,
        widthCm: parcel.widthCm,
      },
      serviceCode: shipment.serviceCode,
      shipmentId: shipment.id,
      status: shipment.status,
      storeId: context.storeId,
    };
  });
}

async function lockShipmentAndOrder(
  transaction: StoreTransaction,
  storeId: string,
  shipmentId: string,
) {
  const identity = await transaction.shipment.findFirst({
    select: { orderId: true },
    where: { id: shipmentId, storeId },
  });
  if (!identity) throw new ShippingCommandError('SHIPMENT_NOT_FOUND');
  await transaction.$queryRaw`
    SELECT id FROM orders
    WHERE store_id = ${storeId}::uuid AND id = ${identity.orderId}::uuid
    FOR UPDATE
  `;
  await transaction.$queryRaw`
    SELECT id FROM shipments
    WHERE store_id = ${storeId}::uuid AND id = ${shipmentId}::uuid
    FOR UPDATE
  `;
  const shipment = await transaction.shipment.findFirst({
    include: { order: true },
    where: { id: shipmentId, storeId },
  });
  if (!shipment) throw new ShippingCommandError('SHIPMENT_NOT_FOUND');
  return shipment;
}

function providerEventKey(
  shipmentId: string,
  fact: ShippingProviderFactInput,
  source: 'QUERY' | 'RECONCILIATION',
): string {
  return digest({
    occurred_at: fact.occurredAt?.toISOString() ?? null,
    provider_shipment_id: fact.providerShipmentId,
    provider_status: fact.providerStatus,
    shipment_id: shipmentId,
    source,
  });
}

export function applyShippingProviderFact(
  client: PrismaClient,
  context: StoreContext,
  input: Readonly<{
    fact: ShippingProviderFactInput;
    operationId: string;
    operationType: 'CANCEL' | 'CREATE' | 'QUERY_TRACKING';
    shipmentId: string;
    source: 'QUERY' | 'RECONCILIATION';
  }>,
): Promise<ShipmentCommandResult> {
  return withStoreTransaction(client, context, async (transaction) => {
    const shipment = await lockShipmentAndOrder(transaction, context.storeId, input.shipmentId);
    const operation = await transaction.shippingOperation.findFirst({
      where: { id: input.operationId, shipmentId: shipment.id, storeId: context.storeId },
    });
    if (!operation) throw new ShippingCommandError('SHIPMENT_OPERATION_NOT_FOUND');
    if (
      operation.operationType !== input.operationType ||
      !input.fact.providerShipmentId ||
      input.fact.providerShipmentId.length > 160 ||
      !input.fact.providerStatus ||
      input.fact.providerStatus.length > 64 ||
      (input.fact.clientOrderCode !== undefined &&
        input.fact.clientOrderCode !== shipment.clientOrderCode) ||
      (shipment.providerShipmentId !== null &&
        shipment.providerShipmentId !== input.fact.providerShipmentId)
    ) {
      throw new ShippingCommandError('SHIPMENT_FACT_INVALID');
    }
    if (
      (input.operationType === 'CREATE' && input.fact.status !== 'PENDING_PICKUP') ||
      (input.operationType === 'CANCEL' && input.fact.status !== 'CANCELLED')
    ) {
      throw new ShippingCommandError('SHIPMENT_FACT_INVALID');
    }
    if (operation.status === 'SUCCEEDED') {
      return commandResult(shipment, operation, true);
    }
    if (operation.status !== 'PENDING' && operation.status !== 'PROCESSING') {
      throw new ShippingCommandError('SHIPMENT_CONFLICT');
    }
    const key = providerEventKey(shipment.id, input.fact, input.source);
    const existingEvent = await transaction.trackingEvent.findUnique({
      where: {
        storeId_shipmentId_providerEventKey: {
          providerEventKey: key,
          shipmentId: shipment.id,
          storeId: context.storeId,
        },
      },
    });
    let nextStatus: ShipmentStatus;
    try {
      nextStatus = input.fact.status
        ? transitionShipmentStatus(shipment.status, input.fact.status)
        : transitionShipmentStatus(shipment.status, 'REVIEW_REQUIRED');
    } catch (error) {
      if (!(error instanceof ShipmentStateError)) throw error;
      nextStatus = shipment.status === 'REVIEW_REQUIRED' ? shipment.status : 'REVIEW_REQUIRED';
    }
    const occurred = input.fact.occurredAt ?? new Date();
    const updated = await transaction.shipment.update({
      data: {
        ...(shipment.providerShipmentId === null
          ? { providerShipmentId: input.fact.providerShipmentId }
          : {}),
        ...(shipment.providerCreatedAt === null ? { providerCreatedAt: occurred } : {}),
        ...(shipment.pickedUpAt === null &&
        ['IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'].includes(nextStatus)
          ? { pickedUpAt: occurred }
          : {}),
        ...(nextStatus === 'DELIVERED' && shipment.deliveredAt === null
          ? { deliveredAt: occurred }
          : {}),
        ...(nextStatus === 'RETURNED' && shipment.returnedAt === null
          ? { returnedAt: occurred }
          : {}),
        status: nextStatus,
        version: { increment: 1 },
      },
      where: { storeId_id: { id: shipment.id, storeId: context.storeId } },
    });
    if (!existingEvent) {
      await transaction.trackingEvent.create({
        data: {
          messageKey: `shipment.tracking.${nextStatus.toLowerCase()}`,
          occurredAt: occurred,
          providerEventKey: key,
          providerStatus: input.fact.providerStatus,
          shipmentId: shipment.id,
          source: input.source,
          status: nextStatus,
          storeId: context.storeId,
        },
      });
    }
    let currentOrderStatus = shipment.order.status;
    let transitionCreatedAt = new Date();
    for (const event of orderEventsForShipmentStatus(nextStatus)) {
      if (event === 'SHIP' && ['SHIPPED', 'DELIVERED', 'COMPLETED'].includes(currentOrderStatus)) {
        continue;
      }
      if (event === 'DELIVER' && ['DELIVERED', 'COMPLETED'].includes(currentOrderStatus)) continue;
      let target;
      try {
        target = transitionOrderStatus(currentOrderStatus, event);
      } catch {
        throw new ShippingCommandError('SHIPMENT_CONFLICT');
      }
      await transaction.order.update({
        data: { status: target, version: { increment: 1 } },
        where: { storeId_id: { id: shipment.orderId, storeId: context.storeId } },
      });
      await transaction.orderTransition.create({
        data: {
          actorId: context.actor.id,
          actorType: 'SYSTEM',
          correlationId: context.correlationId,
          createdAt: transitionCreatedAt,
          event,
          fromStatus: currentOrderStatus,
          orderId: shipment.orderId,
          reason: 'Authoritative GHN query fact',
          storeId: context.storeId,
          toStatus: target,
        },
      });
      currentOrderStatus = target;
      transitionCreatedAt = new Date(transitionCreatedAt.getTime() + 1);
    }
    const completedOperation = await transaction.shippingOperation.update({
      data: { errorCode: null, status: 'SUCCEEDED', version: { increment: 1 } },
      where: { storeId_id: { id: operation.id, storeId: context.storeId } },
    });
    return commandResult(updated, completedOperation, false);
  });
}

export function recordShipmentCreated(
  client: PrismaClient,
  context: StoreContext,
  input: Readonly<{
    fact: ShippingProviderFactInput;
    operationId: string;
    shipmentId: string;
  }>,
): Promise<ShipmentCommandResult> {
  return applyShippingProviderFact(client, context, {
    ...input,
    operationType: 'CREATE',
    source: 'QUERY',
  });
}

export function requestShipmentOperation(
  client: PrismaClient,
  context: StoreContext,
  input: Readonly<{
    expectedVersion: number;
    idempotencyKey: string;
    operationType: 'CANCEL' | 'QUERY_TRACKING';
    reason: string;
    shipmentId: string;
  }>,
): Promise<ShipmentCommandResult> {
  return withStoreTransaction(client, context, async (transaction) => {
    const shipment = await lockShipmentAndOrder(transaction, context.storeId, input.shipmentId);
    const requestHash = digest({
      expected_version: input.expectedVersion,
      operation_type: input.operationType,
      reason: input.reason,
      shipment_id: input.shipmentId,
    });
    const idempotencyKeyHash = digest(input.idempotencyKey);
    const current = await transaction.shippingOperation.findUnique({
      where: {
        storeId_channelId_operationType_idempotencyKeyHash: {
          channelId: shipment.channelId,
          idempotencyKeyHash,
          operationType: input.operationType,
          storeId: context.storeId,
        },
      },
    });
    if (current) {
      if (current.requestHash !== requestHash || current.shipmentId !== shipment.id) {
        throw new ShippingCommandError('SHIPMENT_CONFLICT');
      }
      return commandResult(shipment, current, true);
    }
    if (shipment.version !== input.expectedVersion) {
      throw new ShippingCommandError('SHIPMENT_CONFLICT');
    }
    if (
      input.operationType === 'CANCEL' &&
      !['CREATION_PENDING', 'PENDING_PICKUP'].includes(shipment.status)
    ) {
      throw new ShippingCommandError('SHIPMENT_CONFLICT');
    }
    if (input.operationType === 'QUERY_TRACKING' && !shipment.providerShipmentId) {
      throw new ShippingCommandError('SHIPMENT_CONFLICT');
    }
    const operation = await transaction.shippingOperation.create({
      data: {
        channelId: shipment.channelId,
        correlationId: context.correlationId,
        idempotencyKeyHash,
        operationType: input.operationType,
        orderId: shipment.orderId,
        requestHash,
        shipmentId: shipment.id,
        storeId: context.storeId,
      },
    });
    if (input.operationType === 'CANCEL') {
      await transaction.shipment.update({
        data: { cancelledOperationId: operation.id, version: { increment: 1 } },
        where: { storeId_id: { id: shipment.id, storeId: context.storeId } },
      });
    }
    const eventType =
      input.operationType === 'CANCEL' ? SHIPMENT_CANCEL_EVENT_TYPE : SHIPMENT_QUERY_EVENT_TYPE;
    await appendOutboxMessageInTransaction(transaction, context, {
      aggregateId: shipment.id,
      aggregateType: 'SHIPMENT',
      eventType,
      eventVersion: 1,
      idempotencyKey: `${eventType}:${operation.id}`,
      payload: {
        operation_id: operation.id,
        shipment_id: shipment.id,
        store_id: context.storeId,
      },
    });
    await transaction.auditLog.create({
      data: {
        action:
          input.operationType === 'CANCEL'
            ? 'shipping.shipment.cancel_requested'
            : 'shipping.shipment.sync_requested',
        actorId: context.actor.id,
        actorType: 'ADMIN',
        afterData: {
          operation_id: operation.id,
          operation_type: input.operationType,
          shipment_id: shipment.id,
        },
        correlationId: context.correlationId,
        reason: input.reason,
        storeId: context.storeId,
        targetId: shipment.id,
        targetType: 'shipment',
      },
    });
    return commandResult(
      input.operationType === 'CANCEL' ? { ...shipment, version: shipment.version + 1 } : shipment,
      operation,
      false,
    );
  });
}

export function getShipmentProviderOperationRequest(
  client: PrismaClient,
  context: StoreContext,
  shipmentId: string,
  operationId: string,
): Promise<
  Readonly<{
    channel: ShippingChannelSnapshot;
    operationId: string;
    operationStatus: string;
    operationType: 'CANCEL' | 'QUERY_TRACKING';
    providerShipmentId: string;
    shipmentId: string;
    status: ShipmentStatus;
    storeId: string;
  }>
> {
  return withStoreTransaction(client, context, async (transaction) => {
    const operation = await transaction.shippingOperation.findFirst({
      include: { channel: true, shipment: true },
      where: {
        id: operationId,
        operationType: { in: ['CANCEL', 'QUERY_TRACKING'] },
        shipmentId,
        storeId: context.storeId,
      },
    });
    if (!operation?.shipment?.providerShipmentId) {
      throw new ShippingCommandError('SHIPMENT_OPERATION_NOT_FOUND');
    }
    return {
      channel: channelSnapshot(operation.channel),
      operationId: operation.id,
      operationStatus: operation.status,
      operationType: operation.operationType as 'CANCEL' | 'QUERY_TRACKING',
      providerShipmentId: operation.shipment.providerShipmentId,
      shipmentId: operation.shipment.id,
      status: operation.shipment.status,
      storeId: context.storeId,
    };
  });
}

export function recordShippingOperationError(
  client: PrismaClient,
  context: StoreContext,
  input: Readonly<{
    errorCode: string;
    operationId: string;
    status: 'PENDING' | 'FAILED' | 'REVIEW_REQUIRED';
  }>,
): Promise<void> {
  return withStoreTransaction(client, context, async (transaction) => {
    const updated = await transaction.shippingOperation.updateMany({
      data: {
        attemptCount: { increment: 1 },
        errorCode: input.errorCode.slice(0, 64),
        status: input.status,
        version: { increment: 1 },
      },
      where: { id: input.operationId, status: { not: 'SUCCEEDED' }, storeId: context.storeId },
    });
    if (updated.count === 1) return;
    const succeeded = await transaction.shippingOperation.findFirst({
      select: { id: true },
      where: { id: input.operationId, status: 'SUCCEEDED', storeId: context.storeId },
    });
    if (!succeeded) throw new ShippingCommandError('SHIPMENT_OPERATION_NOT_FOUND');
  });
}
