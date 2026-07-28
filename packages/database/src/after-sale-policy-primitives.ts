import { createHash } from 'node:crypto';

import type { Prisma } from '@prisma/client';
import { afterSalePolicyContentSchema } from '@zalo-shop/contracts';

import type { StoreTransaction } from './index';

export type AfterSalePolicyReadiness = Readonly<{
  currentVersionId: string | null;
  currentVersionNumber: number | null;
  defaultPolicyCode: string | null;
  defaultPolicyId: string | null;
  enforcementSynchronized: boolean;
  enforcePolicySnapshots: boolean;
  ready: boolean;
  readinessCheckedAt: Date | null;
  readinessHash: string | null;
  settingsVersion: number;
}>;

export type CheckoutAfterSalePolicyLine = Readonly<{
  categoryId: string;
  orderId: string;
  orderItemId: string;
  productId: string;
}>;

export class AfterSalePolicyRuntimeError extends Error {
  public constructor(
    public readonly code: 'AFTER_SALE_POLICY_NOT_READY' | 'AFTER_SALE_POLICY_SNAPSHOT_INVALID',
  ) {
    super(code);
    this.name = 'AfterSalePolicyRuntimeError';
  }
}

export const AFTER_SALE_POLICY_SNAPSHOT_RUNTIME_CAPABILITY =
  'm63-a:product-nearest-category-default:canonical-payload-v1';

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

export function canonicalAfterSalePolicyHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

type ActiveAssignment = Awaited<ReturnType<typeof activeAssignments>>[number];

async function activeAssignments(transaction: StoreTransaction, storeId: string) {
  return transaction.afterSaleActivePolicyAssignment.findMany({
    include: {
      assignment: true,
      policy: true,
      policyVersion: { include: { assignments: true, localizations: true } },
    },
    orderBy: [{ targetType: 'asc' }, { productId: 'asc' }, { categoryId: 'asc' }, { id: 'asc' }],
    where: { storeId },
  });
}

function assignmentIsValid(assignment: ActiveAssignment, now: Date): boolean {
  const version = assignment.policyVersion;
  const parsedPayload = afterSalePolicyContentSchema.safeParse(version.payload);
  if (!parsedPayload.success) return false;
  const payload = parsedPayload.data;
  const payloadLocalizations = [...payload.localizations].sort((left, right) =>
    left.locale.localeCompare(right.locale, 'en'),
  );
  const storedLocalizations = version.localizations
    .map((localization) => ({
      buyer_instructions: localization.buyerInstructions,
      locale: localization.locale,
      name: localization.name,
      summary: localization.summary,
    }))
    .sort((left, right) => left.locale.localeCompare(right.locale, 'en'));
  const assignedProductIds = version.assignments
    .filter(
      (target): target is (typeof version.assignments)[number] & { productId: string } =>
        target.targetType === 'PRODUCT' && target.productId !== null,
    )
    .map((target) => target.productId)
    .sort((left, right) => left.localeCompare(right, 'en'));
  const assignedCategoryIds = version.assignments
    .filter(
      (target): target is (typeof version.assignments)[number] & { categoryId: string } =>
        target.targetType === 'CATEGORY' && target.categoryId !== null,
    )
    .map((target) => target.categoryId)
    .sort((left, right) => left.localeCompare(right, 'en'));
  const payloadProductIds = [...payload.product_ids].sort((left, right) =>
    left.localeCompare(right, 'en'),
  );
  const payloadCategoryIds = payload.category_id === null ? [] : [payload.category_id];
  return (
    assignment.policy.status === 'ACTIVE' &&
    assignment.policy.currentVersionId === assignment.policyVersionId &&
    assignment.policy.categoryId === payload.category_id &&
    assignment.assignment.policyId === assignment.policyId &&
    assignment.assignment.policyVersionId === assignment.policyVersionId &&
    assignment.assignment.targetType === assignment.targetType &&
    assignment.assignment.productId === assignment.productId &&
    assignment.assignment.categoryId === assignment.categoryId &&
    version.effectiveAt.getTime() <= now.getTime() &&
    canonicalJson(version.allowedTypes) === canonicalJson(payload.allowed_types) &&
    canonicalJson(version.conditionRules) === canonicalJson(payload.condition_rules) &&
    version.damagedException === payload.damaged_exception &&
    version.defectException === payload.defect_exception &&
    version.exchangeAttributeCode === payload.exchange_attribute_code &&
    version.exchangeSameProductOnly === payload.exchange_same_product_only &&
    version.hygieneRestricted === payload.hygiene_restricted &&
    version.requestWindowDays === payload.request_window_days &&
    version.returnShippingPayer === payload.return_shipping_payer &&
    version.returnWindowDays === payload.return_window_days &&
    version.unopenedRequired === payload.unopened_required &&
    version.wrongItemException === payload.wrong_item_exception &&
    canonicalJson(payloadLocalizations) === canonicalJson(storedLocalizations) &&
    canonicalJson(payloadProductIds) === canonicalJson(assignedProductIds) &&
    canonicalJson(payloadCategoryIds) === canonicalJson(assignedCategoryIds) &&
    version.payloadHash === canonicalAfterSalePolicyHash(version.payload)
  );
}

function readinessDigest(assignments: readonly ActiveAssignment[]): string {
  return canonicalAfterSalePolicyHash({
    assignments: assignments.map((assignment) => ({
      assignment_id: assignment.assignmentId,
      category_id: assignment.categoryId,
      policy_id: assignment.policyId,
      policy_version_id: assignment.policyVersionId,
      policy_version_payload_hash: assignment.policyVersion.payloadHash,
      product_id: assignment.productId,
      target_type: assignment.targetType,
    })),
    checkout_snapshot_runtime_capability: AFTER_SALE_POLICY_SNAPSHOT_RUNTIME_CAPABILITY,
  });
}

export async function assessAfterSalePolicyReadinessInTransaction(
  transaction: StoreTransaction,
  storeId: string,
  now = new Date(),
): Promise<AfterSalePolicyReadiness> {
  const [settings, assignments] = await Promise.all([
    transaction.storeAfterSaleSetting.findUnique({ where: { storeId } }),
    activeAssignments(transaction, storeId),
  ]);
  const defaults = assignments.filter((assignment) => assignment.targetType === 'STORE_DEFAULT');
  const defaultAssignment = defaults[0] ?? null;
  const activeAssignmentIds = new Set(assignments.map((assignment) => assignment.assignmentId));
  const assignmentsValid =
    defaults.length === 1 &&
    assignments.every((assignment) => assignmentIsValid(assignment, now)) &&
    assignments.every((assignment) =>
      assignment.policyVersion.assignments.every((target) => activeAssignmentIds.has(target.id)),
    );
  const liveReadinessHash =
    assignmentsValid && defaultAssignment !== null ? readinessDigest(assignments) : null;
  const enforcementSynchronized =
    settings === null ||
    !settings.enforcePolicySnapshots ||
    (liveReadinessHash !== null &&
      defaultAssignment !== null &&
      settings.defaultPolicyId === defaultAssignment.policyId &&
      settings.currentVersionId === defaultAssignment.policyVersionId &&
      settings.readinessHash !== null &&
      settings.readinessHash === liveReadinessHash);
  const ready = liveReadinessHash !== null;
  return {
    currentVersionId: defaultAssignment?.policyVersionId ?? null,
    currentVersionNumber: defaultAssignment?.policyVersion.versionNumber ?? null,
    defaultPolicyCode: defaultAssignment?.policy.code ?? null,
    defaultPolicyId: defaultAssignment?.policyId ?? null,
    enforcementSynchronized,
    enforcePolicySnapshots: settings?.enforcePolicySnapshots ?? false,
    ready,
    readinessCheckedAt: settings?.readinessCheckedAt ?? null,
    readinessHash: liveReadinessHash,
    settingsVersion: settings?.version ?? 1,
  };
}

async function categoryPaths(
  transaction: StoreTransaction,
  storeId: string,
  categoryIds: readonly string[],
): Promise<Map<string, string[]>> {
  const uniqueStarts = [...new Set(categoryIds)];
  const parents = new Map<string, string | null>();
  let pending = uniqueStarts;
  while (pending.length > 0) {
    const rows = await transaction.category.findMany({
      select: { id: true, parentId: true },
      where: { id: { in: pending }, storeId },
    });
    if (rows.length !== pending.length) {
      throw new AfterSalePolicyRuntimeError('AFTER_SALE_POLICY_SNAPSHOT_INVALID');
    }
    for (const row of rows) parents.set(row.id, row.parentId);
    pending = [
      ...new Set(
        rows
          .map((row) => row.parentId)
          .filter((id): id is string => id !== null && !parents.has(id)),
      ),
    ];
  }

  const result = new Map<string, string[]>();
  for (const start of uniqueStarts) {
    const path: string[] = [];
    const seen = new Set<string>();
    let current: string | null = start;
    while (current !== null) {
      if (seen.has(current)) {
        throw new AfterSalePolicyRuntimeError('AFTER_SALE_POLICY_SNAPSHOT_INVALID');
      }
      seen.add(current);
      path.push(current);
      current = parents.get(current) ?? null;
    }
    result.set(start, path);
  }
  return result;
}

export async function writeCheckoutAfterSalePolicySnapshotsInTransaction(
  transaction: StoreTransaction,
  input: Readonly<{
    lines: readonly CheckoutAfterSalePolicyLine[];
    storeId: string;
  }>,
): Promise<{ enforced: boolean; written: number }> {
  if (input.lines.length === 0) {
    throw new AfterSalePolicyRuntimeError('AFTER_SALE_POLICY_SNAPSHOT_INVALID');
  }
  await transaction.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${`m62-policy:${input.storeId}`}, 0))
  `;
  const settings = await transaction.$queryRaw<Array<{ enforce_policy_snapshots: boolean }>>`
    SELECT enforce_policy_snapshots
    FROM app_security.lock_m63_after_sale_setting()
  `;
  if (settings.length !== 1) {
    throw new AfterSalePolicyRuntimeError('AFTER_SALE_POLICY_NOT_READY');
  }
  if (!settings[0]!.enforce_policy_snapshots) return { enforced: false, written: 0 };

  const readiness = await assessAfterSalePolicyReadinessInTransaction(transaction, input.storeId);
  if (!readiness.ready || !readiness.enforcementSynchronized) {
    throw new AfterSalePolicyRuntimeError('AFTER_SALE_POLICY_NOT_READY');
  }

  const assignments = await activeAssignments(transaction, input.storeId);
  const productAssignments = new Map(
    assignments
      .filter(
        (assignment): assignment is ActiveAssignment & { productId: string } =>
          assignment.targetType === 'PRODUCT' && assignment.productId !== null,
      )
      .map((assignment) => [assignment.productId, assignment]),
  );
  const categoryAssignments = new Map(
    assignments
      .filter(
        (assignment): assignment is ActiveAssignment & { categoryId: string } =>
          assignment.targetType === 'CATEGORY' && assignment.categoryId !== null,
      )
      .map((assignment) => [assignment.categoryId, assignment]),
  );
  const defaultAssignment = assignments.find(
    (assignment) => assignment.targetType === 'STORE_DEFAULT',
  );
  const paths = await categoryPaths(
    transaction,
    input.storeId,
    input.lines.map((line) => line.categoryId),
  );

  const snapshots = input.lines.map((line) => {
    const categoryAssignment = paths
      .get(line.categoryId)
      ?.map((categoryId) => categoryAssignments.get(categoryId))
      .find((assignment) => assignment !== undefined);
    const selected =
      productAssignments.get(line.productId) ?? categoryAssignment ?? defaultAssignment;
    if (!selected) {
      throw new AfterSalePolicyRuntimeError('AFTER_SALE_POLICY_NOT_READY');
    }
    return {
      orderId: line.orderId,
      orderItemId: line.orderItemId,
      payload: selected.policyVersion.payload as Prisma.InputJsonValue,
      payloadHash: selected.policyVersion.payloadHash,
      policyCode: selected.policy.code,
      policyId: selected.policyId,
      policyVersionId: selected.policyVersionId,
      policyVersionNumber: selected.policyVersion.versionNumber,
      storeId: input.storeId,
    };
  });

  try {
    await transaction.orderItemAfterSalePolicySnapshot.createMany({ data: snapshots });
  } catch (error) {
    const record =
      error !== null && typeof error === 'object'
        ? (error as { code?: unknown; meta?: unknown })
        : null;
    const metaCode =
      record?.meta !== null && typeof record?.meta === 'object'
        ? (record.meta as { code?: unknown }).code
        : undefined;
    if (
      ['P2002', 'P2003', 'P2004', '23503', '23505', '23514'].includes(
        typeof record?.code === 'string' ? record.code : '',
      ) ||
      metaCode === '23514'
    ) {
      throw new AfterSalePolicyRuntimeError('AFTER_SALE_POLICY_SNAPSHOT_INVALID');
    }
    throw error;
  }
  return { enforced: true, written: snapshots.length };
}
