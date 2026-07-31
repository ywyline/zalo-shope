import type { Prisma } from '@prisma/client';
import { afterSalePolicyContentSchema, type AfterSalePolicyContent } from '@zalo-shop/contracts';
import { AFTER_SALE_TYPES } from '@zalo-shop/domain';

import {
  assessAfterSalePolicyReadinessInTransaction,
  canonicalAfterSalePolicyHash,
} from './after-sale-policy-primitives';
import type { StoreTransaction } from './index';

export type AfterSalePolicyManagementErrorCode =
  | 'AFTER_SALE_POLICY_NOT_FOUND'
  | 'AFTER_SALE_POLICY_NOT_READY'
  | 'AFTER_SALE_POLICY_SNAPSHOT_INVALID'
  | 'AFTER_SALE_POLICY_STATE_CONFLICT'
  | 'AFTER_SALE_POLICY_TARGET_CONFLICT'
  | 'AFTER_SALE_POLICY_TARGET_INVALID'
  | 'AFTER_SALE_POLICY_VERSION_CONFLICT';

export class AfterSalePolicyManagementError extends Error {
  public constructor(public readonly code: AfterSalePolicyManagementErrorCode) {
    super(code);
    this.name = 'AfterSalePolicyManagementError';
  }
}

const typeOrder = new Map(AFTER_SALE_TYPES.map((type, index) => [type, index]));
const localeOrder = new Map([
  ['vi', 0],
  ['zh', 1],
  ['en', 2],
]);

function compareCanonicalText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function canonicalizeAfterSalePolicyContent(
  input: AfterSalePolicyContent,
): AfterSalePolicyContent {
  const normalized = {
    ...input,
    allowed_types: [...input.allowed_types].sort(
      (left, right) => (typeOrder.get(left) ?? 99) - (typeOrder.get(right) ?? 99),
    ),
    category_id: input.category_id?.toLowerCase() ?? null,
    condition_rules: {
      ...input.condition_rules,
      allowed_reason_codes: [...input.condition_rules.allowed_reason_codes].sort(
        compareCanonicalText,
      ),
      evidence_required_reason_codes: [
        ...input.condition_rules.evidence_required_reason_codes,
      ].sort(compareCanonicalText),
      opened_package_exception_reason_codes: [
        ...input.condition_rules.opened_package_exception_reason_codes,
      ].sort(compareCanonicalText),
    },
    localizations: [...input.localizations].sort(
      (left, right) => (localeOrder.get(left.locale) ?? 99) - (localeOrder.get(right.locale) ?? 99),
    ),
    product_ids: input.product_ids
      .map((productId) => productId.toLowerCase())
      .sort(compareCanonicalText),
  };
  return afterSalePolicyContentSchema.parse(normalized);
}

export function afterSalePolicyContentHash(content: AfterSalePolicyContent): string {
  return canonicalAfterSalePolicyHash(canonicalizeAfterSalePolicyContent(content));
}

async function lockPolicyControlPlane(
  transaction: StoreTransaction,
  storeId: string,
): Promise<void> {
  await transaction.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${`m62-policy:${storeId}`}, 0))
  `;
}

async function lockPolicyHead(
  transaction: StoreTransaction,
  input: Readonly<{ code: string; storeId: string }>,
): Promise<void> {
  const rows = await transaction.$queryRaw<Array<{ id: string }>>`
    SELECT id
    FROM after_sale_policies
    WHERE store_id = ${input.storeId}::uuid AND code = ${input.code}
    FOR UPDATE
  `;
  if (rows.length > 1) {
    throw new AfterSalePolicyManagementError('AFTER_SALE_POLICY_SNAPSHOT_INVALID');
  }
}

async function assertPolicyTargets(
  transaction: StoreTransaction,
  storeId: string,
  content: AfterSalePolicyContent,
): Promise<void> {
  const [categoryCount, products] = await Promise.all([
    content.category_id === null
      ? Promise.resolve(0)
      : transaction.category.count({ where: { id: content.category_id, storeId } }),
    content.product_ids.length === 0
      ? Promise.resolve([])
      : transaction.product.findMany({
          select: { id: true },
          where: { id: { in: content.product_ids }, storeId },
        }),
  ]);
  if (
    (content.category_id !== null && categoryCount !== 1) ||
    products.length !== content.product_ids.length
  ) {
    throw new AfterSalePolicyManagementError('AFTER_SALE_POLICY_TARGET_INVALID');
  }
}

type PolicyTarget = Readonly<{
  categoryId: string | null;
  productId: string | null;
  targetType: 'CATEGORY' | 'PRODUCT' | 'STORE_DEFAULT';
}>;

function policyTargets(content: AfterSalePolicyContent): PolicyTarget[] {
  return [
    ...content.product_ids.map((productId) => ({
      categoryId: null,
      productId,
      targetType: 'PRODUCT' as const,
    })),
    content.category_id === null
      ? { categoryId: null, productId: null, targetType: 'STORE_DEFAULT' as const }
      : {
          categoryId: content.category_id,
          productId: null,
          targetType: 'CATEGORY' as const,
        },
  ].sort((left, right) => {
    const leftKey = `${left.targetType}:${left.productId ?? left.categoryId ?? ''}`;
    const rightKey = `${right.targetType}:${right.productId ?? right.categoryId ?? ''}`;
    return compareCanonicalText(leftKey, rightKey);
  });
}

function policyTargetPredicate(
  target: PolicyTarget,
): Prisma.AfterSaleActivePolicyAssignmentWhereInput {
  switch (target.targetType) {
    case 'PRODUCT':
      return {
        categoryId: null,
        productId: target.productId,
        targetType: 'PRODUCT',
      };
    case 'CATEGORY':
      return {
        categoryId: target.categoryId,
        productId: null,
        targetType: 'CATEGORY',
      };
    case 'STORE_DEFAULT':
      return {
        categoryId: null,
        productId: null,
        targetType: 'STORE_DEFAULT',
      };
  }
}

async function synchronizePolicyReadiness(
  transaction: StoreTransaction,
  input: Readonly<{ actorId: string; now: Date; storeId: string }>,
) {
  const lockedSettings = await transaction.$queryRaw<Array<{ enforce_policy_snapshots: boolean }>>`
    SELECT enforce_policy_snapshots
    FROM app_security.lock_m63_after_sale_setting()
  `;
  if (lockedSettings.length !== 1) {
    throw new AfterSalePolicyManagementError('AFTER_SALE_POLICY_NOT_READY');
  }
  const settings = await transaction.storeAfterSaleSetting.findUnique({
    where: { storeId: input.storeId },
  });
  if (
    settings === null ||
    settings.enforcePolicySnapshots !== lockedSettings[0]!.enforce_policy_snapshots
  ) {
    throw new AfterSalePolicyManagementError('AFTER_SALE_POLICY_NOT_READY');
  }
  const readiness = await assessAfterSalePolicyReadinessInTransaction(
    transaction,
    input.storeId,
    input.now,
  );
  if (settings.enforcePolicySnapshots && !readiness.ready) {
    throw new AfterSalePolicyManagementError('AFTER_SALE_POLICY_NOT_READY');
  }
  return transaction.storeAfterSaleSetting.update({
    data: {
      currentVersionId: readiness.currentVersionId,
      defaultPolicyId: readiness.defaultPolicyId,
      readinessCheckedAt: input.now,
      readinessCheckedBy: input.actorId,
      readinessHash: readiness.readinessHash,
      readinessReadyAt: readiness.ready ? input.now : null,
      updatedBy: input.actorId,
      version: { increment: 1 },
    },
    where: { storeId: input.storeId },
  });
}

export async function putAfterSalePolicyDraftInTransaction(
  transaction: StoreTransaction,
  input: Readonly<{
    actorId: string;
    code: string;
    content: AfterSalePolicyContent;
    expectedVersion: number;
    storeId: string;
  }>,
) {
  await lockPolicyControlPlane(transaction, input.storeId);
  await lockPolicyHead(transaction, input);
  const content = canonicalizeAfterSalePolicyContent(input.content);
  await assertPolicyTargets(transaction, input.storeId, content);
  const existing = await transaction.afterSalePolicy.findUnique({
    where: { storeId_code: { code: input.code, storeId: input.storeId } },
  });
  if (
    (existing === null && input.expectedVersion !== 0) ||
    (existing !== null && existing.version !== input.expectedVersion)
  ) {
    throw new AfterSalePolicyManagementError('AFTER_SALE_POLICY_VERSION_CONFLICT');
  }
  const draftHash = afterSalePolicyContentHash(content);
  const policy =
    existing === null
      ? await transaction.afterSalePolicy.create({
          data: {
            categoryId: content.category_id,
            code: input.code,
            createdBy: input.actorId,
            draftHash,
            draftPayload: content,
            storeId: input.storeId,
            updatedBy: input.actorId,
          },
        })
      : await transaction.afterSalePolicy.update({
          data: {
            ...(existing.status === 'DRAFT' && existing.currentVersionId === null
              ? { categoryId: content.category_id }
              : {}),
            draftHash,
            draftPayload: content,
            updatedBy: input.actorId,
            version: { increment: 1 },
          },
          where: { storeId_id: { id: existing.id, storeId: input.storeId } },
        });
  await transaction.afterSalePolicyDraftProduct.deleteMany({
    where: { policyId: policy.id, storeId: input.storeId },
  });
  if (content.product_ids.length > 0) {
    await transaction.afterSalePolicyDraftProduct.createMany({
      data: content.product_ids.map((productId) => ({
        policyId: policy.id,
        productId,
        storeId: input.storeId,
      })),
    });
  }
  return { before: existing, content, policy };
}

export async function publishAfterSalePolicyInTransaction(
  transaction: StoreTransaction,
  input: Readonly<{
    actorId: string;
    code: string;
    expectedVersion: number;
    now: Date;
    storeId: string;
  }>,
) {
  await lockPolicyControlPlane(transaction, input.storeId);
  await lockPolicyHead(transaction, input);
  const policy = await transaction.afterSalePolicy.findUnique({
    include: { draftProducts: { select: { productId: true } } },
    where: { storeId_code: { code: input.code, storeId: input.storeId } },
  });
  if (policy === null) {
    throw new AfterSalePolicyManagementError('AFTER_SALE_POLICY_NOT_FOUND');
  }
  if (policy.version !== input.expectedVersion) {
    throw new AfterSalePolicyManagementError('AFTER_SALE_POLICY_VERSION_CONFLICT');
  }
  const parsed = afterSalePolicyContentSchema.safeParse(policy.draftPayload);
  if (!parsed.success) {
    throw new AfterSalePolicyManagementError('AFTER_SALE_POLICY_SNAPSHOT_INVALID');
  }
  const content = canonicalizeAfterSalePolicyContent(parsed.data);
  const draftProducts = policy.draftProducts
    .map((item) => item.productId)
    .sort(compareCanonicalText);
  if (
    canonicalAfterSalePolicyHash(policy.draftPayload) !== afterSalePolicyContentHash(content) ||
    policy.draftHash !== afterSalePolicyContentHash(content) ||
    JSON.stringify(draftProducts) !== JSON.stringify(content.product_ids)
  ) {
    throw new AfterSalePolicyManagementError('AFTER_SALE_POLICY_SNAPSHOT_INVALID');
  }
  await assertPolicyTargets(transaction, input.storeId, content);
  const targets = policyTargets(content);
  const conflictingAssignments = await transaction.afterSaleActivePolicyAssignment.findMany({
    select: { policyId: true },
    where: {
      OR: targets.map(policyTargetPredicate),
      storeId: input.storeId,
    },
  });
  if (conflictingAssignments.some((assignment) => assignment.policyId !== policy.id)) {
    throw new AfterSalePolicyManagementError('AFTER_SALE_POLICY_TARGET_CONFLICT');
  }
  const latestVersion = await transaction.afterSalePolicyVersion.findFirst({
    orderBy: { versionNumber: 'desc' },
    select: { versionNumber: true },
    where: { policyId: policy.id, storeId: input.storeId },
  });
  const versionNumber = (latestVersion?.versionNumber ?? 0) + 1;
  const version = await transaction.afterSalePolicyVersion.create({
    data: {
      allowedTypes: content.allowed_types,
      conditionRules: content.condition_rules,
      damagedException: content.damaged_exception,
      defectException: content.defect_exception,
      effectiveAt: input.now,
      exchangeAttributeCode: content.exchange_attribute_code,
      exchangeSameProductOnly: content.exchange_same_product_only,
      hygieneRestricted: content.hygiene_restricted,
      payload: content,
      payloadHash: afterSalePolicyContentHash(content),
      policyId: policy.id,
      publishedAt: input.now,
      publishedBy: input.actorId,
      requestWindowDays: content.request_window_days,
      returnShippingPayer: content.return_shipping_payer,
      returnWindowDays: content.return_window_days,
      storeId: input.storeId,
      unopenedRequired: content.unopened_required,
      versionNumber,
      wrongItemException: content.wrong_item_exception,
    },
  });
  await transaction.afterSalePolicyLocalization.createMany({
    data: content.localizations.map((localization) => ({
      buyerInstructions: localization.buyer_instructions,
      locale: localization.locale,
      name: localization.name,
      policyVersionId: version.id,
      storeId: input.storeId,
      summary: localization.summary,
    })),
  });
  await transaction.afterSalePolicyVersionAssignment.createMany({
    data: targets.map((target) => ({
      categoryId: target.categoryId,
      policyId: policy.id,
      policyVersionId: version.id,
      productId: target.productId,
      storeId: input.storeId,
      targetType: target.targetType,
    })),
  });
  const immutableAssignments = await transaction.afterSalePolicyVersionAssignment.findMany({
    orderBy: { id: 'asc' },
    where: { policyVersionId: version.id, storeId: input.storeId },
  });
  const updatedPolicy = await transaction.afterSalePolicy.update({
    data: {
      categoryId: content.category_id,
      currentVersionId: version.id,
      status: 'ACTIVE',
      updatedBy: input.actorId,
      version: { increment: 1 },
    },
    where: { storeId_id: { id: policy.id, storeId: input.storeId } },
  });
  await transaction.afterSaleActivePolicyAssignment.deleteMany({
    where: { policyId: policy.id, storeId: input.storeId },
  });
  await transaction.afterSaleActivePolicyAssignment.createMany({
    data: immutableAssignments.map((assignment) => ({
      assignmentId: assignment.id,
      categoryId: assignment.categoryId,
      policyId: policy.id,
      policyVersionId: version.id,
      productId: assignment.productId,
      storeId: input.storeId,
      targetType: assignment.targetType,
    })),
  });
  const settings = await synchronizePolicyReadiness(transaction, input);
  return { before: policy, content, policy: updatedPolicy, settings, version };
}

export async function disableAfterSalePolicyInTransaction(
  transaction: StoreTransaction,
  input: Readonly<{
    actorId: string;
    code: string;
    expectedVersion: number;
    now: Date;
    storeId: string;
  }>,
) {
  await lockPolicyControlPlane(transaction, input.storeId);
  await lockPolicyHead(transaction, input);
  const policy = await transaction.afterSalePolicy.findUnique({
    where: { storeId_code: { code: input.code, storeId: input.storeId } },
  });
  if (policy === null) {
    throw new AfterSalePolicyManagementError('AFTER_SALE_POLICY_NOT_FOUND');
  }
  if (policy.version !== input.expectedVersion) {
    throw new AfterSalePolicyManagementError('AFTER_SALE_POLICY_VERSION_CONFLICT');
  }
  if (policy.status !== 'ACTIVE' || policy.currentVersionId === null) {
    throw new AfterSalePolicyManagementError('AFTER_SALE_POLICY_STATE_CONFLICT');
  }
  await transaction.afterSaleActivePolicyAssignment.deleteMany({
    where: { policyId: policy.id, storeId: input.storeId },
  });
  const updatedPolicy = await transaction.afterSalePolicy.update({
    data: {
      status: 'DISABLED',
      updatedBy: input.actorId,
      version: { increment: 1 },
    },
    where: { storeId_id: { id: policy.id, storeId: input.storeId } },
  });
  const settings = await synchronizePolicyReadiness(transaction, input);
  return { before: policy, policy: updatedPolicy, settings };
}
