import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

import { Prisma, type PrismaClient } from '@prisma/client';
import { afterSalePolicyContentSchema, type AfterSalePolicyContent } from '@zalo-shop/contracts';
import {
  AfterSaleInvariantError,
  assertAfterSaleEvidenceCreationAllowed,
  assertAfterSaleOrderPaymentAdmissionAllowed,
  assertAfterSaleQuantityAvailable,
  assertAfterSaleReasonAllowed,
  assertAfterSaleRequestWindowOpen,
  assertEquivalentExchange,
  calculateAfterSaleRequestDeadlineEpochMs,
  calculateOrderItemRefundAllocationVnd,
  resolveAfterSaleCasePolicy,
  resolveAuthoritativeOrderItemDelivery,
  type AfterSaleEvidenceCapabilities,
  type AfterSaleType,
  type StoreContext,
} from '@zalo-shop/domain';

import {
  AfterSaleEvidenceLifecycleError,
  claimAfterSaleEvidenceInTransaction,
} from './after-sale-evidence-primitives';
import { canonicalAfterSalePolicyHash } from './after-sale-policy-primitives';
import { type StoreTransaction, withStoreTransaction } from './index';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBLIC_CASE_NUMBER_RETRY_LIMIT = 3;
const SERIALIZATION_RETRY_LIMIT = 3;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const IDEMPOTENCY_PATTERN = /^[!-~]{16,128}$/;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export type AfterSaleCommandErrorCode =
  | 'AFTER_SALE_INPUT_INVALID'
  | 'AFTER_SALE_AUTHORIZATION_DENIED'
  | 'AFTER_SALE_NOT_FOUND'
  | 'AFTER_SALE_IDEMPOTENCY_CONFLICT'
  | 'AFTER_SALE_VERSION_CONFLICT'
  | 'AFTER_SALE_STATE_CONFLICT'
  | 'AFTER_SALE_POLICY_MISMATCH'
  | 'AFTER_SALE_RETURN_WINDOW_CLOSED'
  | 'AFTER_SALE_REQUEST_WINDOW_CLOSED'
  | 'AFTER_SALE_QUANTITY_EXCEEDS_AVAILABLE'
  | 'AFTER_SALE_ORDER_NOT_ELIGIBLE'
  | 'AFTER_SALE_PAYMENT_NOT_PROVEN'
  | 'AFTER_SALE_DELIVERY_NOT_PROVEN'
  | 'AFTER_SALE_REASON_NOT_ALLOWED'
  | 'AFTER_SALE_EXCHANGE_NOT_ALLOWED'
  | 'AFTER_SALE_EVIDENCE_CAPABILITY_UNAVAILABLE'
  | 'AFTER_SALE_EVIDENCE_REQUIRED'
  | 'AFTER_SALE_EVIDENCE_STATE_CONFLICT';

export class AfterSaleCommandDatabaseError extends Error {
  public constructor(public readonly code: AfterSaleCommandErrorCode) {
    super(code);
    this.name = 'AfterSaleCommandDatabaseError';
  }
}

export type AfterSaleCommandItemInput = Readonly<{
  orderItemId: string;
  quantity: number;
  replacementSkuId?: string;
}>;

type CreateAfterSaleCommandInput = Readonly<{
  evidenceCapabilities: AfterSaleEvidenceCapabilities;
  evidenceIds: readonly string[];
  idempotencyKey: string;
  items: readonly AfterSaleCommandItemInput[];
  orderId: string;
  ordinaryAccessTtlSeconds?: number;
  reasonCode: string;
  reasonDetailCiphertext: string;
  reasonDetailHash: string;
  retentionTtlSeconds?: number;
  sourceIp?: string;
  type: AfterSaleType;
}>;

export type CreateMemberAfterSaleCommandInput = CreateAfterSaleCommandInput &
  Readonly<{ type: 'REFUND_ONLY' | 'RETURN_REFUND' | 'EXCHANGE' }>;

export type CreateMerchantRefundAfterSaleCommandInput = Omit<
  CreateAfterSaleCommandInput,
  | 'evidenceCapabilities'
  | 'evidenceIds'
  | 'ordinaryAccessTtlSeconds'
  | 'retentionTtlSeconds'
  | 'type'
> &
  Readonly<{ type: 'MERCHANT_REFUND' }>;

export type CancelMemberAfterSaleCommandInput = Readonly<{
  afterSaleId: string;
  expectedVersion: number;
  idempotencyKey: string;
  reason: string;
  sourceIp?: string;
}>;

export type AfterSaleCommandResult = Readonly<{
  afterSaleId: string;
  operationId: string;
  publicCaseNumber: string;
  replayed: boolean;
  status: 'PENDING_REVIEW' | 'REVIEW_REQUIRED' | 'CANCELLED';
  version: number;
}>;

type OrderRow = {
  currency: string;
  id: string;
  member_id: string;
  payable_vnd: bigint;
  payment_method: 'COD' | 'ONLINE';
  payment_status:
    | 'PENDING'
    | 'PROCESSING'
    | 'SUCCEEDED'
    | 'FAILED'
    | 'EXPIRED'
    | 'CANCELLED'
    | 'PARTIALLY_REFUNDED'
    | 'FULLY_REFUNDED';
  remote_surcharge_vnd: bigint;
  shipping_discount_vnd: bigint;
  shipping_fee_vnd: bigint;
  status: string;
};

type OrderItemRow = {
  brand_id: string;
  category_id: string;
  id: string;
  option_snapshot: Prisma.JsonValue;
  payable_vnd: bigint;
  product_id: string;
  product_name: string;
  quantity: number;
  sku_code: string;
  sku_id: string;
  unit_price_vnd: bigint;
};

type CapacityRow = {
  occupied_quantity: bigint;
  occupied_vnd: bigint;
  order_item_id: string;
};

type CapacitySnapshot = Readonly<{
  byOrderItem: ReadonlyMap<string, CapacityRow>;
  occupiedOtherVnd: bigint;
  occupiedShippingVnd: bigint;
}>;

type PolicySnapshotRow = {
  order_item_id: string;
  payload: Prisma.JsonValue;
  payload_hash: string;
  policy_id: string;
  policy_version_id: string;
  policy_version_number: number;
};

type PaymentAttemptRow = {
  amount_vnd: bigint;
  currency: string;
  id: string;
  provider_transaction_id: string | null;
  succeeded_at: Date | null;
  status: string;
};

type RefundRow = { amount_vnd: bigint; id: string; status: string };

type ShipmentItemRow = {
  delivered_at: Date | null;
  order_item_id: string;
  purpose: 'ORDER_OUTBOUND' | 'AFTER_SALE_RETURN' | 'EXCHANGE_OUTBOUND';
  quantity: number;
  shipment_id: string;
  status: string;
};

type ReplacementSkuRow = {
  id: string;
  product_id: string;
  sale_price_vnd: bigint;
  status: string;
};

type SkuOptionRow = {
  attribute_definition_id: string;
  option_id: string;
  sku_id: string;
};

type AttributeDefinitionRow = {
  code: string;
  id: string;
};

type CommandFunctionRow = {
  after_sale_id: string;
  operation_id: string;
  public_case_number: string;
  replayed: boolean;
  status: AfterSaleCommandResult['status'];
  version: number;
};

type CommandReplayRow = {
  after_sale_id: string;
  current_public_case_number: string;
  operation_id: string;
  operation_status: string;
  request_hash: string;
  result_summary: Prisma.JsonValue | null;
};

class AfterSalePublicCaseNumberCollision extends Error {
  public constructor() {
    super('After-sale public case number collision');
    this.name = 'AfterSalePublicCaseNumberCollision';
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function generatePublicCaseNumber(): string {
  return `ASC-${randomBytes(16).toString('hex').toUpperCase()}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function canonicalAfterSaleCommandRequestHash(
  input: Readonly<Record<string, unknown>>,
): string {
  return digest(canonicalJson(input));
}

function commandResult(row: CommandFunctionRow | undefined): AfterSaleCommandResult {
  if (
    !row ||
    !UUID_PATTERN.test(row.after_sale_id) ||
    !UUID_PATTERN.test(row.operation_id) ||
    !Number.isSafeInteger(row.version) ||
    row.version < 1 ||
    !['PENDING_REVIEW', 'REVIEW_REQUIRED', 'CANCELLED'].includes(row.status)
  ) {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_STATE_CONFLICT');
  }
  return {
    afterSaleId: row.after_sale_id,
    operationId: row.operation_id,
    publicCaseNumber: row.public_case_number,
    replayed: row.replayed,
    status: row.status,
    version: row.version,
  };
}

function replayedCommandResult(row: CommandReplayRow): AfterSaleCommandResult {
  const summary = row.result_summary;
  if (
    summary === null ||
    Array.isArray(summary) ||
    typeof summary !== 'object' ||
    !Object.prototype.hasOwnProperty.call(summary, 'after_sale_id') ||
    !Object.prototype.hasOwnProperty.call(summary, 'operation_id') ||
    !Object.prototype.hasOwnProperty.call(summary, 'public_case_number') ||
    !Object.prototype.hasOwnProperty.call(summary, 'status') ||
    !Object.prototype.hasOwnProperty.call(summary, 'version')
  ) {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_STATE_CONFLICT');
  }
  const result = summary as Record<string, Prisma.JsonValue>;
  const versionValue = result.version;
  if (
    typeof result.after_sale_id !== 'string' ||
    typeof result.operation_id !== 'string' ||
    typeof result.public_case_number !== 'string' ||
    typeof result.status !== 'string' ||
    (typeof versionValue !== 'number' && typeof versionValue !== 'string') ||
    (typeof versionValue === 'number' && !Number.isSafeInteger(versionValue)) ||
    (typeof versionValue === 'string' && !/^[1-9][0-9]{0,8}$/.test(versionValue)) ||
    result.after_sale_id !== row.after_sale_id ||
    result.operation_id !== row.operation_id ||
    result.public_case_number !== row.current_public_case_number
  ) {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_STATE_CONFLICT');
  }
  return commandResult({
    after_sale_id: result.after_sale_id,
    operation_id: result.operation_id,
    public_case_number: result.public_case_number,
    replayed: true,
    status: result.status as AfterSaleCommandResult['status'],
    version: typeof versionValue === 'number' ? versionValue : Number(versionValue),
  });
}

function safeVnd(value: bigint): number {
  if (value < 0n || value > MAX_SAFE_BIGINT) {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_POLICY_MISMATCH');
  }
  return Number(value);
}

function assertContext(context: StoreContext, actorType: 'admin' | 'member'): void {
  const tokenExpiresAt = Date.parse(context.accessTokenExpiresAt ?? '');
  if (
    context.actor.type !== actorType ||
    !UUID_PATTERN.test(context.actor.id) ||
    !UUID_PATTERN.test(context.storeId) ||
    !UUID_PATTERN.test(context.accessSessionId ?? '') ||
    !Number.isFinite(tokenExpiresAt) ||
    context.correlationId.trim().length === 0 ||
    context.correlationId.length > 128
  ) {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_INPUT_INVALID');
  }
  if (tokenExpiresAt <= Date.now()) {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_AUTHORIZATION_DENIED');
  }
}

function assertCreateInput(input: CreateAfterSaleCommandInput): void {
  const ids = input.items.map((item) => item.orderItemId);
  if (
    !UUID_PATTERN.test(input.orderId) ||
    !IDEMPOTENCY_PATTERN.test(input.idempotencyKey) ||
    input.items.length < 1 ||
    input.items.length > 20 ||
    new Set(ids).size !== ids.length ||
    input.evidenceIds.length > 6 ||
    new Set(input.evidenceIds).size !== input.evidenceIds.length ||
    input.evidenceIds.some((id) => !UUID_PATTERN.test(id)) ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(input.reasonCode) ||
    !SHA256_PATTERN.test(input.reasonDetailHash) ||
    input.reasonDetailCiphertext.length < 1 ||
    input.reasonDetailCiphertext.length > 10_000 ||
    input.items.some(
      (item) =>
        !UUID_PATTERN.test(item.orderItemId) ||
        !Number.isSafeInteger(item.quantity) ||
        item.quantity < 1 ||
        item.quantity > 1_000 ||
        (item.replacementSkuId !== undefined && !UUID_PATTERN.test(item.replacementSkuId)),
    ) ||
    input.items.some(
      (item) => (input.type === 'EXCHANGE') !== (item.replacementSkuId !== undefined),
    ) ||
    (input.sourceIp !== undefined && isIP(input.sourceIp) === 0)
  ) {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_INPUT_INVALID');
  }
}

function prismaErrorCode(error: unknown): { code?: string; message: string; sqlState?: string } {
  if (error === null || typeof error !== 'object') return { message: String(error) };
  const record = error as { code?: unknown; message?: unknown; meta?: unknown };
  const meta =
    record.meta !== null && typeof record.meta === 'object'
      ? (record.meta as { code?: unknown; message?: unknown })
      : undefined;
  return {
    code: typeof record.code === 'string' ? record.code : undefined,
    message: [record.message, meta?.message]
      .filter((value): value is string => typeof value === 'string')
      .join('\n'),
    sqlState: typeof meta?.code === 'string' ? meta.code : undefined,
  };
}

function isPublicCaseNumberCollision(error: unknown): boolean {
  const database = prismaErrorCode(error);
  if (database.code !== 'P2002' && database.sqlState !== '23505') return false;
  if (database.message.includes('public_case_number')) return true;
  if (error === null || typeof error !== 'object') return false;
  const meta = (error as { meta?: unknown }).meta;
  if (meta === null || typeof meta !== 'object') return false;
  const target = (meta as { target?: unknown }).target;
  if (typeof target === 'string') return target.includes('public_case_number');
  return Array.isArray(target) && target.some((value) => value === 'public_case_number');
}

function isRetryableSerializationConflict(error: unknown): boolean {
  const database = prismaErrorCode(error);
  if (database.message.includes('expected version')) return false;
  return database.code === 'P2034' || database.sqlState === '40001';
}

function mapCommandError(error: unknown): never {
  if (error instanceof AfterSaleCommandDatabaseError) throw error;
  if (error instanceof AfterSaleInvariantError) {
    const mapped: Partial<Record<string, AfterSaleCommandErrorCode>> = {
      AFTER_SALE_EVIDENCE_CAPABILITY_UNAVAILABLE: 'AFTER_SALE_EVIDENCE_CAPABILITY_UNAVAILABLE',
      AFTER_SALE_EVIDENCE_REQUIRED: 'AFTER_SALE_EVIDENCE_REQUIRED',
      AFTER_SALE_EXCHANGE_NOT_ALLOWED: 'AFTER_SALE_EXCHANGE_NOT_ALLOWED',
      AFTER_SALE_ORDER_NOT_ELIGIBLE: 'AFTER_SALE_ORDER_NOT_ELIGIBLE',
      AFTER_SALE_PAYMENT_NOT_PROVEN: 'AFTER_SALE_PAYMENT_NOT_PROVEN',
      AFTER_SALE_POLICY_MISMATCH: 'AFTER_SALE_POLICY_MISMATCH',
      AFTER_SALE_QUANTITY_EXCEEDS_AVAILABLE: 'AFTER_SALE_QUANTITY_EXCEEDS_AVAILABLE',
      AFTER_SALE_REASON_NOT_ALLOWED: 'AFTER_SALE_REASON_NOT_ALLOWED',
      AFTER_SALE_REQUEST_WINDOW_CLOSED: 'AFTER_SALE_REQUEST_WINDOW_CLOSED',
      AFTER_SALE_REQUEST_WINDOW_INVALID: 'AFTER_SALE_POLICY_MISMATCH',
      AFTER_SALE_REFUND_AMOUNT_INVALID: 'AFTER_SALE_QUANTITY_EXCEEDS_AVAILABLE',
    };
    throw new AfterSaleCommandDatabaseError(mapped[error.code] ?? 'AFTER_SALE_STATE_CONFLICT');
  }
  if (error instanceof AfterSaleEvidenceLifecycleError) {
    const code =
      error.code === 'AFTER_SALE_EVIDENCE_INPUT_INVALID'
        ? 'AFTER_SALE_INPUT_INVALID'
        : error.code === 'AFTER_SALE_EVIDENCE_NOT_FOUND'
          ? 'AFTER_SALE_EVIDENCE_STATE_CONFLICT'
          : 'AFTER_SALE_EVIDENCE_STATE_CONFLICT';
    throw new AfterSaleCommandDatabaseError(code);
  }
  const database = prismaErrorCode(error);
  if (database.code === 'P2002' || database.sqlState === '23505') {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_IDEMPOTENCY_CONFLICT');
  }
  if (database.code === 'P2034' || database.sqlState === '40001') {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_VERSION_CONFLICT');
  }
  if (
    database.sqlState === '42501' &&
    database.message.includes('B3 command authorization is no longer valid')
  ) {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_AUTHORIZATION_DENIED');
  }
  if (database.sqlState === 'P0002') {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_NOT_FOUND');
  }
  if (['P2003', 'P2004'].includes(database.code ?? '') || database.sqlState === '23514') {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_STATE_CONFLICT');
  }
  throw error;
}

async function lockOrderScope(
  transaction: StoreTransaction,
  storeId: string,
  orderId: string,
): Promise<void> {
  await transaction.$executeRaw`
    SELECT pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'm62-refund:' || (${storeId}::uuid)::text || ':' || (${orderId}::uuid)::text,
        0
      )
    )
  `;
}

function sqlUuidList(ids: readonly string[]): Prisma.Sql {
  return Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`));
}

async function lockOrder(
  transaction: StoreTransaction,
  context: StoreContext,
  orderId: string,
): Promise<OrderRow> {
  const ownerPredicate =
    context.actor.type === 'member'
      ? Prisma.sql`AND member_id = ${context.actor.id}::uuid`
      : Prisma.empty;
  const rows = await transaction.$queryRaw<OrderRow[]>(Prisma.sql`
    SELECT id, member_id, status, payment_method, payment_status, currency, payable_vnd,
      shipping_fee_vnd, remote_surcharge_vnd, shipping_discount_vnd
    FROM orders
    WHERE store_id = ${context.storeId}::uuid AND id = ${orderId}::uuid
      ${ownerPredicate}
    FOR UPDATE
  `);
  const order = rows[0];
  if (!order) throw new AfterSaleCommandDatabaseError('AFTER_SALE_NOT_FOUND');
  return order;
}

async function lockOrderItems(
  transaction: StoreTransaction,
  context: StoreContext,
  orderId: string,
  itemIds: readonly string[],
): Promise<OrderItemRow[]> {
  const rows = await transaction.$queryRaw<OrderItemRow[]>(Prisma.sql`
    SELECT id, sku_id, product_id, brand_id, category_id, sku_code, product_name,
      option_snapshot, unit_price_vnd, quantity, payable_vnd
    FROM order_items
    WHERE store_id = ${context.storeId}::uuid AND order_id = ${orderId}::uuid
      AND id IN (${sqlUuidList(itemIds)})
    ORDER BY id
  `);
  if (rows.length !== itemIds.length) {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_NOT_FOUND');
  }
  return rows;
}

async function lockCapacity(
  transaction: StoreTransaction,
  context: StoreContext,
  orderId: string,
): Promise<CapacitySnapshot> {
  await transaction.$queryRaw(Prisma.sql`
    SELECT item.id
    FROM after_sale_items item
    JOIN after_sales sale ON sale.store_id = item.store_id AND sale.id = item.after_sale_id
    WHERE item.store_id = ${context.storeId}::uuid
      AND sale.order_id = ${orderId}::uuid
    ORDER BY item.order_item_id, sale.id, item.id
    FOR SHARE OF sale, item
  `);
  const rows = await transaction.$queryRaw<CapacityRow[]>(Prisma.sql`
    SELECT item.order_item_id,
      COALESCE(pg_catalog.sum(CASE
        WHEN sale.status = 'PENDING_REVIEW'
          OR (sale.status = 'REVIEW_REQUIRED' AND sale.legacy_policy_review
            AND sale.review_resume_status IS NULL)
        THEN item.requested_quantity ELSE item.approved_quantity END), 0)::bigint
        AS occupied_quantity,
      COALESCE(pg_catalog.sum(CASE
        WHEN sale.status = 'PENDING_REVIEW'
          OR (sale.status = 'REVIEW_REQUIRED' AND sale.legacy_policy_review
            AND sale.review_resume_status IS NULL)
        THEN item.requested_item_vnd ELSE item.approved_item_vnd END), 0)::bigint
        AS occupied_vnd
    FROM after_sale_items item
    JOIN after_sales sale ON sale.store_id = item.store_id AND sale.id = item.after_sale_id
    WHERE item.store_id = ${context.storeId}::uuid
      AND sale.order_id = ${orderId}::uuid
      AND (
        sale.status NOT IN ('REJECTED','CANCELLED')
        OR EXISTS (SELECT 1 FROM after_sale_inspections inspection
          WHERE inspection.store_id = sale.store_id AND inspection.after_sale_id = sale.id)
        OR EXISTS (SELECT 1 FROM after_sale_settlements settlement
          WHERE settlement.store_id = sale.store_id AND settlement.after_sale_id = sale.id)
        OR EXISTS (SELECT 1 FROM after_sale_inventory_actions inventory_action
          WHERE inventory_action.store_id = sale.store_id
            AND inventory_action.after_sale_id = sale.id)
        OR EXISTS (SELECT 1 FROM exchange_fulfillments fulfillment
          WHERE fulfillment.store_id = sale.store_id
            AND fulfillment.after_sale_id = sale.id)
      )
    GROUP BY item.order_item_id
    ORDER BY item.order_item_id
  `);
  const orderLevelRows = await transaction.$queryRaw<
    Array<{ occupied_other_vnd: bigint; occupied_shipping_vnd: bigint }>
  >`
    SELECT COALESCE(pg_catalog.sum(CASE
      WHEN sale.status = 'PENDING_REVIEW'
        OR (sale.status = 'REVIEW_REQUIRED' AND sale.legacy_policy_review
          AND sale.review_resume_status IS NULL)
      THEN sale.requested_shipping_vnd ELSE sale.approved_shipping_vnd END), 0)::bigint
        AS occupied_shipping_vnd,
      COALESCE(pg_catalog.sum(CASE
        WHEN sale.status = 'PENDING_REVIEW'
          OR (sale.status = 'REVIEW_REQUIRED' AND sale.legacy_policy_review
            AND sale.review_resume_status IS NULL)
        THEN sale.requested_other_vnd ELSE sale.approved_other_vnd END), 0)::bigint
        AS occupied_other_vnd
    FROM after_sales sale
    WHERE sale.store_id = ${context.storeId}::uuid
      AND sale.order_id = ${orderId}::uuid
      AND (
        sale.status NOT IN ('REJECTED','CANCELLED')
        OR EXISTS (SELECT 1 FROM after_sale_inspections inspection
          WHERE inspection.store_id = sale.store_id AND inspection.after_sale_id = sale.id)
        OR EXISTS (SELECT 1 FROM after_sale_settlements settlement
          WHERE settlement.store_id = sale.store_id AND settlement.after_sale_id = sale.id)
        OR EXISTS (SELECT 1 FROM after_sale_inventory_actions inventory_action
          WHERE inventory_action.store_id = sale.store_id
            AND inventory_action.after_sale_id = sale.id)
        OR EXISTS (SELECT 1 FROM exchange_fulfillments fulfillment
          WHERE fulfillment.store_id = sale.store_id
            AND fulfillment.after_sale_id = sale.id)
      )
  `;
  return {
    byOrderItem: new Map(rows.map((row) => [row.order_item_id, row])),
    occupiedOtherVnd: orderLevelRows[0]?.occupied_other_vnd ?? 0n,
    occupiedShippingVnd: orderLevelRows[0]?.occupied_shipping_vnd ?? 0n,
  };
}

async function lockPolicySnapshots(
  transaction: StoreTransaction,
  context: StoreContext,
  orderId: string,
  itemIds: readonly string[],
): Promise<Map<string, PolicySnapshotRow>> {
  const rows = await transaction.$queryRaw<PolicySnapshotRow[]>(Prisma.sql`
    SELECT order_item_id, policy_id, policy_version_id, policy_version_number,
      payload, payload_hash
    FROM order_item_after_sale_policy_snapshots
    WHERE store_id = ${context.storeId}::uuid AND order_id = ${orderId}::uuid
      AND order_item_id IN (${sqlUuidList(itemIds)})
    ORDER BY order_item_id
  `);
  return new Map(rows.map((row) => [row.order_item_id, row]));
}

async function lockPaymentFacts(
  transaction: StoreTransaction,
  context: StoreContext,
  order: OrderRow,
): Promise<number> {
  if (order.payment_method === 'COD') {
    const receipts = await transaction.$queryRaw<Array<{ line_id: string }>>`
      SELECT line.id AS line_id
      FROM financial_reconciliation_lines line
      JOIN financial_reconciliation_batches batch
        ON batch.store_id = line.store_id AND batch.id = line.batch_id
      JOIN shipments shipment
        ON shipment.store_id = line.store_id AND shipment.id = line.shipment_id
      WHERE line.store_id = ${context.storeId}::uuid
        AND shipment.order_id = ${order.id}::uuid
        AND shipment.purpose = 'ORDER_OUTBOUND'
        AND shipment.status = 'DELIVERED'
        AND shipment.delivered_at IS NOT NULL
        AND shipment.cod_amount_vnd = ${order.payable_vnd}
        AND batch.source = 'SHIPPING_PROVIDER'
        AND batch.shipping_channel_id = shipment.channel_id
        AND line.type = 'COD_REMITTANCE'
        AND line.status = 'MATCHED'
        AND line.gross_amount_vnd = ${order.payable_vnd}
        AND line.local_expected_amount_vnd = ${order.payable_vnd}
        AND line.difference_vnd = 0
      ORDER BY line.id
    `;
    assertAfterSaleOrderPaymentAdmissionAllowed({
      confirmedReceiptFact: receipts.length === 1,
      orderStatus: order.status,
      paymentMethod: order.payment_method,
      paymentStatus: order.payment_status,
    });
    if (order.currency !== 'VND' || receipts.length !== 1) {
      throw new AfterSaleCommandDatabaseError('AFTER_SALE_PAYMENT_NOT_PROVEN');
    }
    return 0;
  }
  const attempts = await transaction.$queryRaw<PaymentAttemptRow[]>`
    SELECT id, amount_vnd, currency, status, succeeded_at, provider_transaction_id
    FROM payment_attempts
    WHERE store_id = ${context.storeId}::uuid AND order_id = ${order.id}::uuid
    ORDER BY id
    FOR SHARE
  `;
  const successful = attempts.filter(
    (attempt) =>
      attempt.status === 'SUCCEEDED' &&
      attempt.currency === 'VND' &&
      attempt.amount_vnd === order.payable_vnd &&
      attempt.succeeded_at !== null &&
      attempt.provider_transaction_id !== null &&
      attempt.provider_transaction_id.trim().length > 0,
  );
  assertAfterSaleOrderPaymentAdmissionAllowed({
    confirmedReceiptFact: successful.length === 1,
    orderStatus: order.status,
    paymentMethod: order.payment_method,
    paymentStatus: order.payment_status,
  });
  if (order.currency !== 'VND' || successful.length !== 1) {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_PAYMENT_NOT_PROVEN');
  }
  await transaction.$queryRaw`
    SELECT linked.refund_id
    FROM after_sale_refunds linked
    JOIN refunds refund
      ON refund.store_id = linked.store_id AND refund.id = linked.refund_id
    WHERE refund.store_id = ${context.storeId}::uuid AND refund.order_id = ${order.id}::uuid
    ORDER BY linked.refund_id
    FOR SHARE OF refund
  `;
  const refunds = await transaction.$queryRaw<RefundRow[]>`
    SELECT refund.id, refund.amount_vnd, refund.status
    FROM refunds refund
    WHERE refund.store_id = ${context.storeId}::uuid AND refund.order_id = ${order.id}::uuid
      AND NOT EXISTS (
        SELECT 1 FROM after_sale_refunds linked
        WHERE linked.store_id = refund.store_id AND linked.refund_id = refund.id
      )
    ORDER BY refund.id
    FOR SHARE OF refund
  `;
  return refunds
    .filter((refund) =>
      ['REQUESTED', 'PROCESSING', 'SUCCEEDED', 'REVIEW_REQUIRED'].includes(refund.status),
    )
    .reduce((sum, refund) => {
      const next = sum + safeVnd(refund.amount_vnd);
      if (!Number.isSafeInteger(next)) {
        throw new AfterSaleCommandDatabaseError('AFTER_SALE_PAYMENT_NOT_PROVEN');
      }
      return next;
    }, 0);
}

async function lockShipmentFacts(
  transaction: StoreTransaction,
  context: StoreContext,
  orderId: string,
  itemIds: readonly string[],
): Promise<ShipmentItemRow[]> {
  return transaction.$queryRaw<ShipmentItemRow[]>(Prisma.sql`
    SELECT shipment_item.order_item_id, shipment_item.shipment_id,
      shipment_item.quantity, shipment.purpose, shipment.status, shipment.delivered_at
    FROM shipment_items shipment_item
    JOIN shipments shipment
      ON shipment.store_id = shipment_item.store_id
      AND shipment.id = shipment_item.shipment_id
      AND shipment.order_id = shipment_item.order_id
    WHERE shipment_item.store_id = ${context.storeId}::uuid
      AND shipment_item.order_id = ${orderId}::uuid
      AND shipment_item.order_item_id IN (${sqlUuidList(itemIds)})
    ORDER BY shipment.id, shipment_item.id
    FOR SHARE OF shipment
  `);
}

function parseOriginalOptions(value: Prisma.JsonValue): Map<string, string> | null {
  if (!Array.isArray(value)) return null;
  const options = new Map<string, string>();
  for (const entry of value) {
    if (entry === null || Array.isArray(entry) || typeof entry !== 'object') return null;
    const record = entry as Record<string, Prisma.JsonValue>;
    const definitionId = record.attributeDefinitionId ?? record.attribute_definition_id;
    const optionId = record.optionId ?? record.option_id;
    if (
      typeof definitionId !== 'string' ||
      typeof optionId !== 'string' ||
      !UUID_PATTERN.test(definitionId) ||
      !UUID_PATTERN.test(optionId) ||
      options.has(definitionId)
    ) {
      return null;
    }
    options.set(definitionId, optionId);
  }
  return options;
}

function optionRecord(options: ReadonlyMap<string, string>): Readonly<Record<string, string>> {
  return Object.fromEntries(
    [...options.entries()].sort(([left], [right]) => left.localeCompare(right, 'en')),
  );
}

function optionsByDefinitionCode(
  options: ReadonlyMap<string, string>,
  definitionCodes: ReadonlyMap<string, string>,
): Map<string, string> | null {
  const result = new Map<string, string>();
  for (const [definitionId, optionId] of options) {
    const code = definitionCodes.get(definitionId);
    if (!code || result.has(code)) return null;
    result.set(code, optionId);
  }
  return result;
}

async function assertExchangeItems(
  transaction: StoreTransaction,
  context: StoreContext,
  policy: AfterSalePolicyContent,
  requestedItems: readonly AfterSaleCommandItemInput[],
  orderItems: readonly OrderItemRow[],
): Promise<void> {
  if (policy.exchange_attribute_code === null) {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_EXCHANGE_NOT_ALLOWED');
  }
  const replacementIds = requestedItems
    .map((item) => item.replacementSkuId)
    .filter((id): id is string => id !== undefined);
  const uniqueReplacementIds = [...new Set(replacementIds)].sort((left, right) =>
    left.localeCompare(right, 'en'),
  );
  const replacements = await transaction.$queryRaw<ReplacementSkuRow[]>(Prisma.sql`
    SELECT id, product_id, sale_price_vnd, status
    FROM skus
    WHERE store_id = ${context.storeId}::uuid AND id IN (${sqlUuidList(uniqueReplacementIds)})
    ORDER BY id
    FOR SHARE
  `);
  if (replacements.length !== uniqueReplacementIds.length) {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_EXCHANGE_NOT_ALLOWED');
  }
  const optionRows = await transaction.$queryRaw<SkuOptionRow[]>(Prisma.sql`
    SELECT sku_id, attribute_definition_id, option_id
    FROM sku_option_values
    WHERE store_id = ${context.storeId}::uuid AND sku_id IN (${sqlUuidList(uniqueReplacementIds)})
    ORDER BY sku_id, attribute_definition_id
    FOR SHARE
  `);
  const resolved = requestedItems.map((request) => ({
    orderItem: orderItems.find((item) => item.id === request.orderItemId),
    originalOptions: (() => {
      const orderItem = orderItems.find((item) => item.id === request.orderItemId);
      return orderItem ? parseOriginalOptions(orderItem.option_snapshot) : null;
    })(),
    replacement: replacements.find((item) => item.id === request.replacementSkuId),
    replacementOptions: new Map(
      optionRows
        .filter((row) => row.sku_id === request.replacementSkuId)
        .map((row) => [row.attribute_definition_id, row.option_id]),
    ),
    request,
  }));
  if (
    resolved.some(
      ({ orderItem, originalOptions, replacement }) =>
        !orderItem || !replacement || !originalOptions || originalOptions.size === 0,
    )
  ) {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_EXCHANGE_NOT_ALLOWED');
  }
  const definitionIds = [
    ...new Set(
      resolved.flatMap(({ originalOptions, replacementOptions }) => [
        ...originalOptions!.keys(),
        ...replacementOptions.keys(),
      ]),
    ),
  ].sort((left, right) => left.localeCompare(right, 'en'));
  const definitions = await transaction.$queryRaw<AttributeDefinitionRow[]>(Prisma.sql`
    SELECT id, code FROM attribute_definitions
    WHERE store_id = ${context.storeId}::uuid AND id IN (${sqlUuidList(definitionIds)})
    ORDER BY id
    FOR SHARE
  `);
  const definitionCodes = new Map(
    definitions.map((definition) => [definition.id, definition.code]),
  );
  if (
    definitions.length !== definitionIds.length ||
    new Set(definitions.map((definition) => definition.code)).size !== definitions.length ||
    definitions.filter((definition) => definition.code === policy.exchange_attribute_code)
      .length !== 1
  ) {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_EXCHANGE_NOT_ALLOWED');
  }
  for (const { orderItem, originalOptions, replacement, replacementOptions, request } of resolved) {
    const originalByCode = optionsByDefinitionCode(originalOptions!, definitionCodes);
    const replacementByCode = optionsByDefinitionCode(replacementOptions, definitionCodes);
    if (!originalByCode || !replacementByCode) {
      throw new AfterSaleCommandDatabaseError('AFTER_SALE_EXCHANGE_NOT_ALLOWED');
    }
    assertEquivalentExchange({
      allowedAttributeCode: policy.exchange_attribute_code,
      originalOptions: optionRecord(originalByCode),
      originalProductId: orderItem!.product_id,
      originalSkuId: orderItem!.sku_id,
      originalStoreId: context.storeId,
      originalUnitPriceVnd: safeVnd(orderItem!.unit_price_vnd),
      replacementActive: replacement!.status === 'ACTIVE',
      replacementOptions: optionRecord(replacementByCode),
      replacementProductId: replacement!.product_id,
      replacementQuantity: request.quantity,
      replacementSkuId: replacement!.id,
      replacementStoreId: context.storeId,
      replacementUnitPriceVnd: safeVnd(replacement!.sale_price_vnd),
      requestedQuantity: request.quantity,
    });
  }
}

function parsePolicy(
  orderItems: readonly OrderItemRow[],
  snapshots: ReadonlyMap<string, PolicySnapshotRow>,
): {
  content: AfterSalePolicyContent | null;
  identity: ReturnType<typeof resolveAfterSaleCasePolicy>;
} {
  const parsed = new Map<string, AfterSalePolicyContent>();
  const identities = orderItems.map((item) => {
    const snapshot = snapshots.get(item.id);
    if (!snapshot) return null;
    const content = afterSalePolicyContentSchema.safeParse(snapshot.payload);
    if (
      !content.success ||
      canonicalAfterSalePolicyHash(snapshot.payload) !== snapshot.payload_hash
    ) {
      throw new AfterSaleCommandDatabaseError('AFTER_SALE_POLICY_MISMATCH');
    }
    parsed.set(item.id, content.data);
    return {
      payloadHash: snapshot.payload_hash,
      policyId: snapshot.policy_id,
      policyVersionId: snapshot.policy_version_id,
      policyVersionNumber: snapshot.policy_version_number,
    };
  });
  const identity = resolveAfterSaleCasePolicy(identities);
  const content = parsed.get(orderItems[0]!.id) ?? null;
  if (
    !identity.legacyPolicyReview &&
    (content === null ||
      orderItems.some((item) => canonicalJson(parsed.get(item.id)) !== canonicalJson(content)))
  ) {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_POLICY_MISMATCH');
  }
  return { content, identity };
}

function assertDeliveryAndPolicy(
  now: Date,
  type: AfterSaleType,
  reasonCode: string,
  orderItems: readonly OrderItemRow[],
  shipments: readonly ShipmentItemRow[],
  policy: AfterSalePolicyContent | null,
  legacyPolicyReview: boolean,
): boolean {
  if (policy !== null) {
    if (!policy.allowed_types.includes(type)) {
      throw new AfterSaleCommandDatabaseError('AFTER_SALE_POLICY_MISMATCH');
    }
    assertAfterSaleReasonAllowed({
      allowedReasonCodes: policy.condition_rules.allowed_reason_codes,
      reasonCode,
    });
    if (policy.hygiene_restricted || policy.unopened_required) {
      throw new AfterSaleCommandDatabaseError('AFTER_SALE_POLICY_MISMATCH');
    }
  }
  for (const item of orderItems) {
    const delivery = resolveAuthoritativeOrderItemDelivery({
      orderedQuantity: item.quantity,
      shipmentItems: shipments
        .filter((shipment) => shipment.order_item_id === item.id)
        .map((shipment) => ({
          deliveredAtEpochMs: shipment.delivered_at?.getTime() ?? null,
          purpose: shipment.purpose,
          quantity: shipment.quantity,
          shipmentId: shipment.shipment_id,
          status: shipment.status as Parameters<
            typeof resolveAuthoritativeOrderItemDelivery
          >[0]['shipmentItems'][number]['status'],
        })),
    });
    if (!delivery.proven) {
      if (legacyPolicyReview) continue;
      throw new AfterSaleCommandDatabaseError('AFTER_SALE_DELIVERY_NOT_PROVEN');
    }
    if (policy !== null) {
      const deadline = calculateAfterSaleRequestDeadlineEpochMs({
        deliveredAtEpochMs: delivery.deliveredAtEpochMs,
        requestWindowDays: policy.request_window_days,
      });
      assertAfterSaleRequestWindowOpen({
        nowEpochMs: now.getTime(),
        requestDeadlineEpochMs: deadline,
      });
    }
  }
  return (
    policy?.condition_rules.evidence_required === true ||
    policy?.condition_rules.evidence_required_reason_codes.includes(reasonCode) === true
  );
}

function requestedShippingEntitlementVnd(input: {
  occupiedShippingVnd: bigint;
  order: OrderRow;
  policy: AfterSalePolicyContent | null;
  type: AfterSaleType;
}): number {
  const paidShippingVnd = Math.max(
    safeVnd(input.order.shipping_fee_vnd) +
      safeVnd(input.order.remote_surcharge_vnd) -
      safeVnd(input.order.shipping_discount_vnd),
    0,
  );
  const occupiedShippingVnd = safeVnd(input.occupiedShippingVnd);
  if (!Number.isSafeInteger(paidShippingVnd) || occupiedShippingVnd > paidShippingVnd) {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_QUANTITY_EXCEEDS_AVAILABLE');
  }
  if (
    input.policy === null ||
    (input.type !== 'RETURN_REFUND' && input.type !== 'EXCHANGE') ||
    input.policy.return_shipping_payer === 'BUYER'
  ) {
    return 0;
  }
  if (input.policy.return_shipping_payer === 'CONDITIONAL') {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_POLICY_MISMATCH');
  }
  if (paidShippingVnd === 0) return 0;
  if (occupiedShippingVnd !== 0) {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_QUANTITY_EXCEEDS_AVAILABLE');
  }
  return paidShippingVnd;
}

async function replayedCreation(
  transaction: StoreTransaction,
  context: StoreContext,
  operation: string,
  idempotencyKeyHash: string,
  requestHash: string,
): Promise<AfterSaleCommandResult | null> {
  const actorPredicate =
    context.actor.type === 'member'
      ? Prisma.sql`AND sale.member_id = ${context.actor.id}::uuid AND sale.source = 'MEMBER'`
      : Prisma.sql`AND sale.initiated_by = ${context.actor.id}::uuid AND sale.source = 'ADMIN'`;
  const sales = await transaction.$queryRaw<
    Array<{ after_sale_id: string; current_public_case_number: string }>
  >(Prisma.sql`
    SELECT sale.id AS after_sale_id, sale.public_case_number AS current_public_case_number
    FROM after_sales sale
    WHERE sale.store_id = ${context.storeId}::uuid
      AND sale.idempotency_key_hash = ${idempotencyKeyHash}
      ${actorPredicate}
  `);
  const sale = sales[0];
  if (!sale) return null;
  if (sales.length !== 1) {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_STATE_CONFLICT');
  }
  const operations = await transaction.$queryRaw<
    Array<{
      operation_id: string;
      operation_status: string;
      request_hash: string;
      result_summary: Prisma.JsonValue | null;
    }>
  >`
    SELECT operation_row.id AS operation_id, operation_row.request_hash,
      operation_row.status AS operation_status, operation_row.result_summary
    FROM after_sale_operations operation_row
    WHERE operation_row.store_id = ${context.storeId}::uuid
      AND operation_row.after_sale_id = ${sale.after_sale_id}::uuid
      AND operation_row.operation = ${operation}
  `;
  const operationRow = operations[0];
  if (
    !operationRow ||
    operations.length !== 1 ||
    operationRow.request_hash !== requestHash ||
    operationRow.operation_status !== 'COMPLETED'
  ) {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_IDEMPOTENCY_CONFLICT');
  }
  return replayedCommandResult({ ...sale, ...operationRow });
}

async function createCommandInTransaction(
  transaction: StoreTransaction,
  context: StoreContext,
  input: CreateAfterSaleCommandInput,
): Promise<AfterSaleCommandResult> {
  const operationName =
    context.actor.type === 'member' ? 'MEMBER_CREATE' : 'MERCHANT_REFUND_CREATE';
  const idempotencyKeyHash = digest(input.idempotencyKey);
  const normalizedItems = [...input.items]
    .map((item) => ({
      order_item_id: item.orderItemId,
      quantity: item.quantity,
      replacement_sku_id: item.replacementSkuId ?? null,
    }))
    .sort((left, right) => left.order_item_id.localeCompare(right.order_item_id, 'en'));
  const requestHash = canonicalAfterSaleCommandRequestHash({
    actor_id: context.actor.id,
    actor_type: context.actor.type,
    evidence_ids: [...input.evidenceIds].sort((left, right) => left.localeCompare(right, 'en')),
    items: normalizedItems,
    idempotency_key_hash: idempotencyKeyHash,
    operation: operationName,
    order_id: input.orderId,
    path:
      context.actor.type === 'member'
        ? '/v1/after-sales'
        : `/v1/admin/orders/${input.orderId}/after-sales`,
    reason_code: input.reasonCode,
    reason_detail_hash: input.reasonDetailHash,
    store_id: context.storeId,
    type: input.type,
  });
  await transaction.$executeRaw`
    SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      ${`m63-b3-idempotency:${context.storeId}:${operationName}:${idempotencyKeyHash}`}, 0))
  `;
  const replay = await replayedCreation(
    transaction,
    context,
    operationName,
    idempotencyKeyHash,
    requestHash,
  );
  if (replay) {
    const finalized = await transaction.$queryRaw<CommandFunctionRow[]>`
      SELECT * FROM app_security.finalize_m63_b3_after_sale_submit(
        ${replay.afterSaleId}::uuid,
        ${replay.operationId}::uuid,
        ${input.sourceIp ?? null}::inet
      )
    `;
    return commandResult(finalized[0]);
  }

  await lockOrderScope(transaction, context.storeId, input.orderId);
  const order = await lockOrder(transaction, context, input.orderId);
  const itemIds = normalizedItems.map((item) => item.order_item_id);
  const orderItems = await lockOrderItems(transaction, context, order.id, itemIds);
  const capacity = await lockCapacity(transaction, context, order.id);
  const snapshots = await lockPolicySnapshots(transaction, context, order.id, itemIds);
  const { content: policy, identity } = parsePolicy(orderItems, snapshots);
  if (context.actor.type === 'admin' && identity.legacyPolicyReview) {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_POLICY_MISMATCH');
  }
  const directRefundVnd = await lockPaymentFacts(transaction, context, order);
  const shipments = await lockShipmentFacts(transaction, context, order.id, itemIds);
  const clock = await transaction.$queryRaw<Array<{ current_time: Date }>>`
    SELECT pg_catalog.clock_timestamp() AS current_time
  `;
  const now = clock[0]?.current_time;
  if (!now) throw new AfterSaleCommandDatabaseError('AFTER_SALE_STATE_CONFLICT');
  const evidenceRequired = assertDeliveryAndPolicy(
    now,
    input.type,
    input.reasonCode,
    orderItems,
    shipments,
    policy,
    identity.legacyPolicyReview,
  );
  assertAfterSaleEvidenceCreationAllowed({
    capabilities: input.evidenceCapabilities,
    evidenceRequired,
    readyEvidenceCount: input.evidenceIds.length,
  });
  if (input.type === 'EXCHANGE') {
    if (!policy) throw new AfterSaleCommandDatabaseError('AFTER_SALE_POLICY_MISMATCH');
    await assertExchangeItems(transaction, context, policy, input.items, orderItems);
  }

  const requestedById = new Map(input.items.map((item) => [item.orderItemId, item]));
  const allocations = orderItems.map((item) => {
    const requested = requestedById.get(item.id)!;
    const occupied = capacity.byOrderItem.get(item.id);
    const occupiedQuantity = Number(occupied?.occupied_quantity ?? 0n);
    const occupiedVnd = safeVnd(occupied?.occupied_vnd ?? 0n);
    assertAfterSaleQuantityAvailable({
      occupiedQuantity,
      orderedQuantity: item.quantity,
      requestedQuantity: requested.quantity,
    });
    const requestedItemVnd = calculateOrderItemRefundAllocationVnd({
      occupiedAllocatedVnd: occupiedVnd,
      occupiedApprovedQuantity: occupiedQuantity,
      orderItemPayableVnd: safeVnd(item.payable_vnd),
      orderedQuantity: item.quantity,
      requestedApprovedQuantity: requested.quantity,
    });
    return { item, requested, requestedItemVnd };
  });
  const requestedItemVnd = allocations.reduce((sum, item) => sum + item.requestedItemVnd, 0);
  const occupiedItemVnd = [...capacity.byOrderItem.values()].reduce(
    (sum, item) => sum + safeVnd(item.occupied_vnd),
    0,
  );
  const requestedShippingVnd = requestedShippingEntitlementVnd({
    occupiedShippingVnd: capacity.occupiedShippingVnd,
    order,
    policy,
    type: input.type,
  });
  const occupiedShippingVnd = safeVnd(capacity.occupiedShippingVnd);
  const occupiedOtherVnd = safeVnd(capacity.occupiedOtherVnd);
  const requestedTotalVnd = requestedItemVnd + requestedShippingVnd;
  if (
    !Number.isSafeInteger(requestedItemVnd) ||
    !Number.isSafeInteger(occupiedItemVnd) ||
    !Number.isSafeInteger(requestedTotalVnd) ||
    directRefundVnd + occupiedItemVnd + occupiedShippingVnd + occupiedOtherVnd + requestedTotalVnd >
      safeVnd(order.payable_vnd)
  ) {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_QUANTITY_EXCEEDS_AVAILABLE');
  }

  const afterSaleId = randomUUID();
  const operationId = randomUUID();
  const status = identity.legacyPolicyReview ? 'REVIEW_REQUIRED' : 'PENDING_REVIEW';
  const publicCaseNumber = generatePublicCaseNumber();
  try {
    await transaction.afterSale.create({
      data: {
        correlationId: context.correlationId,
        id: afterSaleId,
        idempotencyKeyHash,
        initiatedBy: context.actor.id,
        legacyPolicyReview: identity.legacyPolicyReview,
        memberId: order.member_id,
        orderId: order.id,
        policyHash: identity.policy?.payloadHash ?? null,
        policyId: identity.policy?.policyId ?? null,
        policySnapshot: policy === null ? Prisma.DbNull : (policy as Prisma.InputJsonValue),
        policyVersionId: identity.policy?.policyVersionId ?? null,
        publicCaseNumber,
        reasonCode: input.reasonCode,
        reasonDetailCiphertext: input.reasonDetailCiphertext,
        requestHash,
        requestedItemVnd: BigInt(requestedItemVnd),
        requestedOtherVnd: 0n,
        requestedShippingVnd: BigInt(requestedShippingVnd),
        requestedTotalVnd: BigInt(requestedTotalVnd),
        source: context.actor.type === 'member' ? 'MEMBER' : 'ADMIN',
        status,
        storeId: context.storeId,
        type: input.type,
      },
    });
    await transaction.afterSaleItem.createMany({
      data: allocations.map(({ item, requested, requestedItemVnd: lineVnd }) => ({
        afterSaleId,
        brandId: item.brand_id,
        categoryId: item.category_id,
        optionSnapshot: item.option_snapshot as Prisma.InputJsonValue,
        orderId: order.id,
        orderItemId: item.id,
        productId: item.product_id,
        productName: item.product_name,
        replacementSkuId: requested.replacementSkuId ?? null,
        requestedItemVnd: BigInt(lineVnd),
        requestedQuantity: requested.quantity,
        skuCode: item.sku_code,
        skuId: item.sku_id,
        storeId: context.storeId,
        unitPriceVnd: item.unit_price_vnd,
      })),
    });
  } catch (error) {
    if (isPublicCaseNumberCollision(error)) {
      throw new AfterSalePublicCaseNumberCollision();
    }
    const database = prismaErrorCode(error);
    if (database.code === 'P2002' || database.sqlState === '23505') {
      throw new AfterSaleCommandDatabaseError('AFTER_SALE_IDEMPOTENCY_CONFLICT');
    }
    throw error;
  }

  if (input.evidenceIds.length > 0) {
    if (
      context.actor.type !== 'member' ||
      input.ordinaryAccessTtlSeconds === undefined ||
      input.retentionTtlSeconds === undefined
    ) {
      throw new AfterSaleCommandDatabaseError('AFTER_SALE_EVIDENCE_CAPABILITY_UNAVAILABLE');
    }
    await claimAfterSaleEvidenceInTransaction(transaction, context, {
      afterSaleId,
      evidenceIds: input.evidenceIds,
      ordinaryAccessTtlSeconds: input.ordinaryAccessTtlSeconds,
      retentionTtlSeconds: input.retentionTtlSeconds,
    });
  }
  const finalized = await transaction.$queryRaw<CommandFunctionRow[]>`
    SELECT * FROM app_security.finalize_m63_b3_after_sale_submit(
      ${afterSaleId}::uuid,
      ${operationId}::uuid,
      ${input.sourceIp ?? null}::inet
    )
  `;
  return commandResult(finalized[0]);
}

async function executeCreateCommand(
  client: PrismaClient,
  context: StoreContext,
  input: CreateAfterSaleCommandInput,
): Promise<AfterSaleCommandResult> {
  let collision: AfterSalePublicCaseNumberCollision | undefined;
  let collisionAttempts = 0;
  let serializationAttempts = 0;
  for (;;) {
    try {
      return await withStoreTransaction(
        client,
        context,
        (transaction) => createCommandInTransaction(transaction, context, input),
        { isolationLevel: 'Serializable', timeout: 20_000 },
      );
    } catch (error) {
      if (error instanceof AfterSalePublicCaseNumberCollision) {
        collision = error;
        collisionAttempts += 1;
        if (collisionAttempts >= PUBLIC_CASE_NUMBER_RETRY_LIMIT) throw collision;
        continue;
      }
      if (isRetryableSerializationConflict(error)) {
        serializationAttempts += 1;
        if (serializationAttempts < SERIALIZATION_RETRY_LIMIT) continue;
      }
      throw error;
    }
  }
}

export async function createMemberAfterSaleCommand(
  client: PrismaClient,
  context: StoreContext,
  input: CreateMemberAfterSaleCommandInput,
): Promise<AfterSaleCommandResult> {
  assertContext(context, 'member');
  assertCreateInput(input);
  try {
    return await executeCreateCommand(client, context, input);
  } catch (error) {
    return mapCommandError(error);
  }
}

export async function createMerchantRefundAfterSaleCommand(
  client: PrismaClient,
  context: StoreContext,
  input: CreateMerchantRefundAfterSaleCommandInput,
): Promise<AfterSaleCommandResult> {
  assertContext(context, 'admin');
  const commandInput: CreateAfterSaleCommandInput = {
    ...input,
    evidenceCapabilities: {
      claimAvailable: false,
      deletionCompensationAvailable: false,
      malwareScanningAvailable: false,
      protectedReadAvailable: false,
      uploadValidationAvailable: false,
    },
    evidenceIds: [],
    type: 'MERCHANT_REFUND',
  };
  assertCreateInput(commandInput);
  try {
    return await executeCreateCommand(client, context, commandInput);
  } catch (error) {
    return mapCommandError(error);
  }
}

export async function cancelMemberAfterSaleCommand(
  client: PrismaClient,
  context: StoreContext,
  input: CancelMemberAfterSaleCommandInput,
): Promise<AfterSaleCommandResult> {
  assertContext(context, 'member');
  const normalizedReason = input.reason.trim();
  if (
    !UUID_PATTERN.test(input.afterSaleId) ||
    !IDEMPOTENCY_PATTERN.test(input.idempotencyKey) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1 ||
    normalizedReason.length < 10 ||
    normalizedReason.length > 500 ||
    (input.sourceIp !== undefined && isIP(input.sourceIp) === 0)
  ) {
    throw new AfterSaleCommandDatabaseError('AFTER_SALE_INPUT_INVALID');
  }
  const idempotencyKeyHash = digest(input.idempotencyKey);
  const requestHash = canonicalAfterSaleCommandRequestHash({
    actor_id: context.actor.id,
    actor_type: context.actor.type,
    after_sale_id: input.afterSaleId,
    expected_version: input.expectedVersion,
    idempotency_key_hash: idempotencyKeyHash,
    operation: 'MEMBER_CANCEL',
    path: `/v1/after-sales/${input.afterSaleId}/cancel`,
    reason_digest: digest(normalizedReason),
    store_id: context.storeId,
  });
  const operationId = randomUUID();
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await withStoreTransaction(
          client,
          context,
          async (transaction) => {
            const rows = await transaction.$queryRaw<CommandFunctionRow[]>`
              SELECT * FROM app_security.cancel_m63_b3_member_after_sale(
                ${input.afterSaleId}::uuid,
                ${operationId}::uuid,
                ${idempotencyKeyHash},
                ${requestHash},
                ${input.expectedVersion}::integer,
                ${input.sourceIp ?? null}::inet
              )
            `;
            return commandResult(rows[0]);
          },
          { isolationLevel: 'Serializable', timeout: 15_000 },
        );
      } catch (error) {
        if (attempt + 1 < SERIALIZATION_RETRY_LIMIT && isRetryableSerializationConflict(error)) {
          continue;
        }
        throw error;
      }
    }
  } catch (error) {
    return mapCommandError(error);
  }
}
