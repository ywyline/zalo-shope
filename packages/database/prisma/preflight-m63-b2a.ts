import 'dotenv/config';

import { Prisma, PrismaClient } from '@prisma/client';
import {
  afterSalePolicyCodeParamsSchema,
  afterSalePolicyContentSchema,
} from '@zalo-shop/contracts';

import {
  afterSalePolicyContentHash,
  canonicalizeAfterSalePolicyContent,
} from '../src/after-sale-policy-management-primitives';

const batchSize = 200;
const versionInclude = Prisma.validator<Prisma.AfterSalePolicyVersionInclude>()({
  assignments: true,
  localizations: true,
  policy: { select: { code: true } },
});
type PolicyVersion = Prisma.AfterSalePolicyVersionGetPayload<{
  include: typeof versionInclude;
}>;

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

function incompatible(input: {
  code: string;
  reason: string;
  storeId: string;
  versionNumber?: number;
}): never {
  const version = input.versionNumber === undefined ? '' : ` version=${input.versionNumber}`;
  throw new Error(
    `M6.3-B2a compatibility preflight failed: ${input.reason} ` +
      `[store=${input.storeId} policy=${JSON.stringify(input.code)}${version}]`,
  );
}

function validateVersion(version: PolicyVersion): void {
  const parsed = afterSalePolicyContentSchema.safeParse(version.payload);
  if (!parsed.success) {
    incompatible({
      code: version.policy.code,
      reason: 'version payload does not satisfy the strict B2a contract',
      storeId: version.storeId,
      versionNumber: version.versionNumber,
    });
  }
  const content = canonicalizeAfterSalePolicyContent(parsed.data);
  const localizations = version.localizations
    .map((localization) => ({
      buyer_instructions: localization.buyerInstructions,
      locale: localization.locale,
      name: localization.name,
      summary: localization.summary,
    }))
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right), 'en'));
  const expectedLocalizations = [...content.localizations].sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right), 'en'),
  );
  const assignments = version.assignments
    .map((assignment) => ({
      category_id: assignment.categoryId,
      product_id: assignment.productId,
      target_type: assignment.targetType,
    }))
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right), 'en'));
  const expectedAssignments = [
    ...content.product_ids.map((productId) => ({
      category_id: null,
      product_id: productId,
      target_type: 'PRODUCT',
    })),
    content.category_id === null
      ? { category_id: null, product_id: null, target_type: 'STORE_DEFAULT' }
      : { category_id: content.category_id, product_id: null, target_type: 'CATEGORY' },
  ].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right), 'en'));
  const relationalScopeValid =
    version.assignments.every(
      (assignment) =>
        assignment.storeId === version.storeId &&
        assignment.policyId === version.policyId &&
        assignment.policyVersionId === version.id,
    ) && version.localizations.every((localization) => localization.storeId === version.storeId);
  const projectionValid =
    canonicalJson(version.payload) === canonicalJson(content) &&
    version.payloadHash === afterSalePolicyContentHash(content) &&
    canonicalJson(version.allowedTypes) === canonicalJson(content.allowed_types) &&
    canonicalJson(version.conditionRules) === canonicalJson(content.condition_rules) &&
    version.damagedException === content.damaged_exception &&
    version.defectException === content.defect_exception &&
    version.exchangeAttributeCode === content.exchange_attribute_code &&
    version.exchangeSameProductOnly === content.exchange_same_product_only &&
    version.hygieneRestricted === content.hygiene_restricted &&
    version.requestWindowDays === content.request_window_days &&
    version.returnShippingPayer === content.return_shipping_payer &&
    version.returnWindowDays === content.return_window_days &&
    version.unopenedRequired === content.unopened_required &&
    version.wrongItemException === content.wrong_item_exception &&
    canonicalJson(localizations) === canonicalJson(expectedLocalizations) &&
    canonicalJson(assignments) === canonicalJson(expectedAssignments) &&
    relationalScopeValid &&
    Number.isFinite(version.effectiveAt.getTime()) &&
    version.effectiveAt.getTime() === version.publishedAt.getTime();
  if (!projectionValid) {
    incompatible({
      code: version.policy.code,
      reason: 'immutable version projection is not canonical or internally consistent',
      storeId: version.storeId,
      versionNumber: version.versionNumber,
    });
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for the read-only B2a preflight');
  const database = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    const counts = await database.$transaction(
      async (transaction) => {
        await transaction.$executeRaw`SET TRANSACTION READ ONLY`;
        // `row_security = off` does not bypass RLS. PostgreSQL instead rejects
        // queries that would be filtered, preventing a runtime URL with no
        // store context from producing a false `policies=0` PASS.
        await transaction.$executeRaw`SET LOCAL row_security = off`;
        let policyCount = 0;
        let policyCursor: string | undefined;
        for (;;) {
          const policies = await transaction.afterSalePolicy.findMany({
            ...(policyCursor === undefined ? {} : { cursor: { id: policyCursor }, skip: 1 }),
            include: {
              currentVersion: { select: { payload: true, policyId: true, storeId: true } },
              draftProducts: { select: { productId: true } },
            },
            orderBy: { id: 'asc' },
            take: batchSize,
          });
          for (const policy of policies) {
            policyCount += 1;
            if (!afterSalePolicyCodeParamsSchema.safeParse({ policyCode: policy.code }).success) {
              incompatible({
                code: policy.code,
                reason: 'policy code is not accepted by the B2a path contract',
                storeId: policy.storeId,
              });
            }
            const parsed = afterSalePolicyContentSchema.safeParse(policy.draftPayload);
            if (!parsed.success) {
              incompatible({
                code: policy.code,
                reason: 'draft payload does not satisfy the strict B2a contract',
                storeId: policy.storeId,
              });
            }
            const draft = canonicalizeAfterSalePolicyContent(parsed.data);
            const draftProducts = policy.draftProducts
              .map((item) => item.productId)
              .sort((left, right) => left.localeCompare(right, 'en'));
            const draftValid =
              canonicalJson(policy.draftPayload) === canonicalJson(draft) &&
              policy.draftHash === afterSalePolicyContentHash(draft) &&
              canonicalJson(draftProducts) === canonicalJson(draft.product_ids);
            const headValid =
              policy.status === 'DRAFT'
                ? policy.currentVersion === null && policy.categoryId === draft.category_id
                : policy.currentVersion !== null &&
                  policy.currentVersion.storeId === policy.storeId &&
                  policy.currentVersion.policyId === policy.id &&
                  (() => {
                    const current = afterSalePolicyContentSchema.safeParse(
                      policy.currentVersion.payload,
                    );
                    return (
                      current.success &&
                      policy.categoryId ===
                        canonicalizeAfterSalePolicyContent(current.data).category_id
                    );
                  })();
            if (!draftValid || !headValid) {
              incompatible({
                code: policy.code,
                reason: 'policy head or draft projection is not canonical or internally consistent',
                storeId: policy.storeId,
              });
            }
          }
          if (policies.length < batchSize) break;
          policyCursor = policies.at(-1)?.id;
        }

        let versionCount = 0;
        let versionCursor: string | undefined;
        for (;;) {
          const versions = await transaction.afterSalePolicyVersion.findMany({
            ...(versionCursor === undefined ? {} : { cursor: { id: versionCursor }, skip: 1 }),
            include: versionInclude,
            orderBy: { id: 'asc' },
            take: batchSize,
          });
          versions.forEach(validateVersion);
          versionCount += versions.length;
          if (versions.length < batchSize) break;
          versionCursor = versions.at(-1)?.id;
        }
        return { policyCount, versionCount };
      },
      { isolationLevel: 'RepeatableRead', maxWait: 10_000, timeout: 120_000 },
    );
    process.stdout.write(
      `M6.3-B2a compatibility preflight PASS (policies=${counts.policyCount}, versions=${counts.versionCount})\n`,
    );
  } finally {
    await database.$disconnect();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'B2a preflight failed'}\n`);
  process.exitCode = 1;
});
