import { randomUUID } from 'node:crypto';

import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type {
  InventoryAdjustmentItem,
  Order as OrderRecord,
  Prisma,
  PrismaClient,
  StoreTransaction,
} from '@zalo-shop/database';
import {
  adjustInventoryInTransaction,
  consumeReservationInTransaction,
  InventoryPrimitiveError,
  releaseReservationInTransaction,
  withStoreTransaction,
} from '@zalo-shop/database';
import { createStoreContext, transitionOrderStatus, type StoreContext } from '@zalo-shop/domain';
import { decryptSensitive } from '@zalo-shop/security';
import type { RuntimeConfig } from '@zalo-shop/config';
import type { OrderListQuery } from '@zalo-shop/contracts';

import { AuthService } from '../auth/auth.service';
import { DATABASE_CLIENT } from '../auth/auth.tokens';
import { RUNTIME_CONFIG } from '../health.controller';
import { AdminService, type AdminHeaders } from '../admin/admin.service';

type StoreRecord = { id: string; code: string; default_locale: 'en' | 'vi' | 'zh' };
type OrderDetailRecord = Prisma.OrderGetPayload<{
  include: { items: true; snapshots: true; transitions: true };
}>;

@Injectable()
export class OrdersService {
  public constructor(
    @Inject(DATABASE_CLIENT) private readonly database: PrismaClient,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AdminService) private readonly admin: AdminService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
  ) {}

  public async memberList(input: {
    authorization?: string;
    storeCode: string;
    query: OrderListQuery;
  }) {
    const member = await this.memberContext(input.authorization, input.storeCode);
    return withStoreTransaction(this.database, member.context, async (transaction) => {
      const cursor = input.query.cursor
        ? await transaction.order.findFirst({
            select: { createdAt: true, id: true },
            where: { id: input.query.cursor, memberId: member.memberId },
          })
        : null;
      if (input.query.cursor && !cursor) throw new NotFoundException('Order cursor not found');
      const rows = await transaction.order.findMany({
        include: { items: { orderBy: { id: 'asc' } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.query.limit,
        where: {
          memberId: member.memberId,
          ...(input.query.status ? { status: input.query.status } : {}),
          ...(cursor
            ? {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              }
            : {}),
        },
      });
      return {
        items: rows.map((row) => this.renderSummary(row)),
        next_cursor: rows.length === input.query.limit ? rows.at(-1)!.id : null,
      };
    });
  }

  public async memberDetail(input: { authorization?: string; storeCode: string; orderId: string }) {
    const member = await this.memberContext(input.authorization, input.storeCode);
    return withStoreTransaction(this.database, member.context, async (transaction) => {
      const order = await transaction.order.findFirst({
        include: {
          items: { orderBy: { id: 'asc' } },
          snapshots: true,
          transitions: { orderBy: { createdAt: 'asc' } },
        },
        where: { id: input.orderId, memberId: member.memberId },
      });
      if (!order) throw new NotFoundException('Order not found');
      return this.renderDetail(order, false);
    });
  }

  public async memberCancel(input: {
    authorization?: string;
    storeCode: string;
    orderId: string;
    reason: string;
  }) {
    const member = await this.memberContext(input.authorization, input.storeCode);
    try {
      return await withStoreTransaction(this.database, member.context, async (transaction) => {
        const order = await this.lockOrder(
          transaction,
          member.context,
          input.orderId,
          member.memberId,
        );
        if (!order) throw new NotFoundException('Order not found');
        if (order.status === 'CANCELLED') return this.renderSummary(order);
        if (order.status !== 'PENDING_CONFIRMATION')
          throw new ConflictException('ORDER_STATE_CONFLICT');
        if (!order.reservationId) throw new ConflictException('ORDER_RESERVATION_MISSING');
        await releaseReservationInTransaction(
          transaction,
          member.context,
          order.reservationId,
          `m4-order-cancel-${order.id}`,
        );
        return this.transitionMemberInTransaction(transaction, member.context, order, input.reason);
      });
    } catch (error) {
      if (error instanceof InventoryPrimitiveError) throw new ConflictException(error.code);
      throw error;
    }
  }

  public async adminList(input: { headers: AdminHeaders; storeId: string; query: OrderListQuery }) {
    const context = await this.admin.authorize(input.headers, input.storeId, 'store.orders.read');
    return withStoreTransaction(this.database, context, async (transaction) => {
      const cursor = input.query.cursor
        ? await transaction.order.findFirst({
            select: { createdAt: true, id: true },
            where: { id: input.query.cursor },
          })
        : null;
      if (input.query.cursor && !cursor) throw new NotFoundException('Order cursor not found');
      const rows = await transaction.order.findMany({
        include: { items: { orderBy: { id: 'asc' } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.query.limit,
        where: {
          ...(input.query.status ? { status: input.query.status } : {}),
          ...(cursor
            ? {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              }
            : {}),
        },
      });
      return {
        items: rows.map((row) => this.renderSummary(row)),
        next_cursor: rows.length === input.query.limit ? rows.at(-1)!.id : null,
      };
    });
  }

  public async adminDetail(input: { headers: AdminHeaders; storeId: string; orderId: string }) {
    const context = await this.admin.authorize(input.headers, input.storeId, 'store.orders.read');
    return withStoreTransaction(this.database, context, async (transaction) => {
      const order = await transaction.order.findFirst({
        include: {
          items: { orderBy: { id: 'asc' } },
          snapshots: true,
          transitions: { orderBy: { createdAt: 'asc' } },
        },
        where: { id: input.orderId },
      });
      if (!order) throw new NotFoundException('Order not found');
      await this.admin.writeAudit(transaction, context, {
        action: 'order.delivery-address.read',
        targetId: order.id,
        targetType: 'order',
      });
      return this.renderDetail(order, true);
    });
  }

  public async adminConfirmCod(input: {
    headers: AdminHeaders;
    storeId: string;
    orderId: string;
    reason?: string;
  }) {
    const context = await this.admin.authorize(input.headers, input.storeId, 'store.orders.manage');
    try {
      return await withStoreTransaction(this.database, context, async (transaction) => {
        const order = await this.lockOrder(transaction, context, input.orderId);
        if (!order) throw new NotFoundException('Order not found');
        if (order.status === 'PENDING_FULFILLMENT') return this.renderSummary(order);
        if (order.status !== 'PENDING_CONFIRMATION' || order.paymentMethod !== 'COD')
          throw new ConflictException('ORDER_STATE_CONFLICT');
        if (!order.reservationId) throw new ConflictException('ORDER_RESERVATION_MISSING');
        await consumeReservationInTransaction(
          transaction,
          context,
          order.reservationId,
          `m4-order-consume-${order.id}`,
        );
        const confirmedStatus = transitionOrderStatus(order.status, 'CONFIRM_COD');
        const fulfillmentStatus = transitionOrderStatus(confirmedStatus, 'FULFILLMENT_READY');
        const now = new Date();
        const updated = await transaction.order.update({
          data: { confirmedAt: now, status: fulfillmentStatus, version: { increment: 1 } },
          where: { storeId_id: { id: order.id, storeId: input.storeId } },
        });
        await transaction.orderTransition.createMany({
          data: [
            {
              actorId: context.actor.id,
              actorType: 'ADMIN',
              correlationId: context.correlationId,
              event: 'CONFIRM_COD',
              fromStatus: 'PENDING_CONFIRMATION',
              orderId: order.id,
              reason: input.reason,
              storeId: input.storeId,
              toStatus: confirmedStatus,
            },
            {
              actorId: context.actor.id,
              actorType: 'ADMIN',
              correlationId: context.correlationId,
              event: 'FULFILLMENT_READY',
              fromStatus: confirmedStatus,
              orderId: order.id,
              reason: input.reason,
              storeId: input.storeId,
              toStatus: fulfillmentStatus,
            },
          ],
        });
        await this.admin.writeAudit(transaction, context, {
          action: 'order.cod.confirmed',
          after: updated,
          targetId: order.id,
          targetType: 'order',
        });
        return this.renderSummary(updated);
      });
    } catch (error) {
      if (error instanceof InventoryPrimitiveError) throw new ConflictException(error.code);
      throw error;
    }
  }

  public async adminCancel(input: {
    headers: AdminHeaders;
    storeId: string;
    orderId: string;
    reason: string;
  }) {
    const context = await this.admin.authorize(input.headers, input.storeId, 'store.orders.manage');
    try {
      return await withStoreTransaction(this.database, context, async (transaction) => {
        const order = await this.lockOrder(transaction, context, input.orderId);
        if (!order) throw new NotFoundException('Order not found');
        if (order.status === 'CANCELLED') return this.renderSummary(order);
        if (order.status !== 'PENDING_CONFIRMATION' && order.status !== 'PENDING_FULFILLMENT')
          throw new ConflictException('ORDER_STATE_CONFLICT');
        if (!order.reservationId) throw new ConflictException('ORDER_RESERVATION_MISSING');
        if (order.status === 'PENDING_CONFIRMATION') {
          await releaseReservationInTransaction(
            transaction,
            context,
            order.reservationId,
            `m4-order-admin-cancel-${order.id}`,
          );
        } else {
          await this.restoreConsumedReservationInTransaction(
            transaction,
            context,
            order.id,
            order.reservationId,
          );
        }
        return this.transitionAdminInTransaction(
          transaction,
          context,
          order,
          'CANCEL',
          input.reason,
        );
      });
    } catch (error) {
      if (error instanceof InventoryPrimitiveError) throw new ConflictException(error.code);
      throw error;
    }
  }

  public async adminClose(input: {
    headers: AdminHeaders;
    storeId: string;
    orderId: string;
    reason: string;
  }) {
    const context = await this.admin.authorize(input.headers, input.storeId, 'store.orders.manage');
    try {
      return await withStoreTransaction(this.database, context, async (transaction) => {
        const order = await this.lockOrder(transaction, context, input.orderId);
        if (!order) throw new NotFoundException('Order not found');
        if (order.status === 'CLOSED') return this.renderSummary(order);
        if (order.status !== 'PENDING_CONFIRMATION' && order.status !== 'PENDING_PAYMENT')
          throw new ConflictException('ORDER_STATE_CONFLICT');
        if (order.reservationId) {
          await releaseReservationInTransaction(
            transaction,
            context,
            order.reservationId,
            `m4-order-admin-close-${order.id}`,
          );
        }
        return this.transitionAdminInTransaction(
          transaction,
          context,
          order,
          'CLOSE',
          input.reason,
        );
      });
    } catch (error) {
      if (error instanceof InventoryPrimitiveError) throw new ConflictException(error.code);
      throw error;
    }
  }

  public async adminUpdateNote(input: {
    headers: AdminHeaders;
    storeId: string;
    orderId: string;
    note: string;
    tags?: string[];
  }) {
    const context = await this.admin.authorize(input.headers, input.storeId, 'store.orders.manage');
    return withStoreTransaction(this.database, context, async (transaction) => {
      const before = await transaction.order.findFirst({ where: { id: input.orderId } });
      if (!before) throw new NotFoundException('Order not found');
      const after = await transaction.order.update({
        data: {
          adminNote: input.note,
          ...(input.tags ? { tags: input.tags } : {}),
          version: { increment: 1 },
        },
        where: { storeId_id: { id: input.orderId, storeId: input.storeId } },
      });
      await this.admin.writeAudit(transaction, context, {
        action: 'order.note.updated',
        after,
        before,
        targetId: input.orderId,
        targetType: 'order',
      });
      return this.renderSummary(after);
    });
  }

  private async lockOrder(
    transaction: StoreTransaction,
    context: StoreContext,
    orderId: string,
    memberId?: string,
  ): Promise<OrderRecord | null> {
    const rows = memberId
      ? await transaction.$queryRaw<Array<{ id: string }>>`
          SELECT id
          FROM orders
          WHERE store_id = ${context.storeId}::uuid
            AND id = ${orderId}::uuid
            AND member_id = ${memberId}::uuid
          FOR UPDATE
        `
      : await transaction.$queryRaw<Array<{ id: string }>>`
          SELECT id
          FROM orders
          WHERE store_id = ${context.storeId}::uuid
            AND id = ${orderId}::uuid
          FOR UPDATE
        `;
    if (rows.length === 0) return null;
    return transaction.order.findFirst({
      where: { id: orderId, ...(memberId ? { memberId } : {}) },
    });
  }

  private async transitionMemberInTransaction(
    transaction: StoreTransaction,
    context: StoreContext,
    order: OrderRecord,
    reason: string,
  ) {
    const status = transitionOrderStatus(order.status, 'CANCEL');
    const updated = await transaction.order.update({
      data: {
        cancellationReason: reason,
        cancelledAt: new Date(),
        status,
        version: { increment: 1 },
      },
      where: { storeId_id: { id: order.id, storeId: context.storeId } },
    });
    await transaction.orderTransition.create({
      data: {
        actorId: context.actor.id,
        actorType: 'MEMBER',
        correlationId: context.correlationId,
        event: 'CANCEL',
        fromStatus: order.status,
        orderId: order.id,
        reason,
        storeId: context.storeId,
        toStatus: status,
      },
    });
    return this.renderSummary(updated);
  }

  private async transitionAdminInTransaction(
    transaction: StoreTransaction,
    context: StoreContext,
    order: OrderRecord,
    event: 'CANCEL' | 'CLOSE',
    reason: string,
  ) {
    const status = transitionOrderStatus(order.status, event);
    const updated = await transaction.order.update({
      data: {
        cancellationReason: reason,
        ...(status === 'CANCELLED' ? { cancelledAt: new Date() } : { closedAt: new Date() }),
        status,
        version: { increment: 1 },
      },
      where: { storeId_id: { id: order.id, storeId: context.storeId } },
    });
    await transaction.orderTransition.create({
      data: {
        actorId: context.actor.id,
        actorType: 'ADMIN',
        correlationId: context.correlationId,
        event,
        fromStatus: order.status,
        orderId: order.id,
        reason,
        storeId: context.storeId,
        toStatus: status,
      },
    });
    await this.admin.writeAudit(transaction, context, {
      action: `order.${event.toLowerCase()}`,
      after: updated,
      targetId: order.id,
      targetType: 'order',
    });
    return this.renderSummary(updated);
  }

  private async restoreConsumedReservationInTransaction(
    transaction: StoreTransaction,
    context: StoreContext,
    orderId: string,
    reservationId: string | null,
  ): Promise<void> {
    if (!reservationId) return;
    const operationKey = `m4-order-restore-${orderId}`;
    const existing = await transaction.inventoryOperation.findUnique({
      where: { storeId_operationKey: { operationKey, storeId: context.storeId } },
    });
    if (existing) return;
    const reservation = await transaction.inventoryReservation.findFirst({
      include: { items: { orderBy: [{ warehouseId: 'asc' }, { skuId: 'asc' }] } },
      where: { id: reservationId, storeId: context.storeId },
    });
    if (!reservation || reservation.status !== 'CONSUMED') {
      throw new ConflictException('ORDER_RESERVATION_NOT_CONSUMED');
    }
    const items: InventoryAdjustmentItem[] = [];
    for (const item of reservation.items) {
      const balance = await transaction.inventoryBalance.findUnique({
        where: {
          storeId_warehouseId_skuId: {
            skuId: item.skuId,
            storeId: context.storeId,
            warehouseId: item.warehouseId,
          },
        },
      });
      if (!balance) throw new ConflictException('ORDER_RESERVATION_MISSING');
      items.push({
        delta: item.quantity,
        expectedVersion: balance.version,
        note: `Restore cancelled order ${orderId}`,
        reasonCode: 'ORDER_CANCEL_RESTORE',
        skuId: item.skuId,
        warehouseId: item.warehouseId,
      });
    }
    await adjustInventoryInTransaction(transaction, context, {
      audit: { action: 'order.inventory.restored', targetType: 'order_inventory' },
      items,
      operationKey,
      operationType: 'RESTORE',
    });
  }

  private renderSummary(order: {
    id: string;
    orderNumber: string;
    status: string;
    paymentMethod: string;
    paymentStatus: string;
    payableVnd: bigint;
    createdAt: Date;
    items?: Array<{ skuCode: string; quantity: number; payableVnd: bigint }>;
  }) {
    return {
      created_at: order.createdAt,
      id: order.id,
      items:
        order.items?.map((item) => ({
          payable_vnd: Number(item.payableVnd),
          quantity: item.quantity,
          sku_code: item.skuCode,
        })) ?? [],
      order_number: order.orderNumber,
      payable_vnd: Number(order.payableVnd),
      payment_method: order.paymentMethod,
      payment_status: order.paymentStatus,
      status: order.status,
      version: 'version' in order && typeof order.version === 'number' ? order.version : undefined,
    };
  }

  private renderDetail(order: OrderDetailRecord, includeAdminFields: boolean) {
    const summary = this.renderSummary(order);
    const snapshot = order.snapshots.find((item) => item.snapshotType === 'ADDRESS');
    const payload =
      snapshot?.payload !== null &&
      typeof snapshot?.payload === 'object' &&
      !Array.isArray(snapshot.payload)
        ? (snapshot.payload as Record<string, unknown>)
        : null;
    const encrypted = (key: string): string | null => {
      const value = payload?.[key];
      return typeof value === 'string' ? value : null;
    };
    const plain = (key: string): string | null => {
      const value = payload?.[key];
      return typeof value === 'string' ? value : null;
    };
    const phoneCiphertext = encrypted('phone_ciphertext');
    const recipientCiphertext = encrypted('recipient_name_ciphertext');
    const detailCiphertext = encrypted('detail_ciphertext');
    const address =
      payload && phoneCiphertext && recipientCiphertext && detailCiphertext
        ? {
            detail: this.decrypt(detailCiphertext),
            district_code: plain('district_code'),
            district_name: plain('district_name'),
            masked_phone: this.mask(this.decrypt(phoneCiphertext)),
            province_code: plain('province_code'),
            province_name: plain('province_name'),
            recipient_name: this.decrypt(recipientCiphertext),
            ward_code: plain('ward_code'),
            ward_name: plain('ward_name'),
          }
        : null;
    return {
      ...summary,
      address,
      cancellation_reason: order.cancellationReason,
      ...(includeAdminFields ? { note: order.adminNote, tags: order.tags } : {}),
      snapshots: order.snapshots.map((item) => ({
        created_at: item.createdAt,
        payload_hash: item.payloadHash,
        snapshot_type: item.snapshotType,
      })),
      transitions: order.transitions.map((item) => ({
        created_at: item.createdAt,
        event: item.event,
        from_status: item.fromStatus,
        reason: item.reason,
        to_status: item.toStatus,
      })),
    };
  }

  private mask(phone: string): string {
    return `${phone.slice(0, 4)}****${phone.slice(-2)}`;
  }
  private decrypt(value: string): string {
    return decryptSensitive(value, this.config.PII_ENCRYPTION_KEY);
  }

  private async memberContext(authorization: string | undefined, storeCode: string) {
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
        locale: store.default_locale,
        storeCode: store.code,
        storeId: store.id,
      }),
      memberId: claims.subjectId,
      storeId: store.id,
    };
  }
}
