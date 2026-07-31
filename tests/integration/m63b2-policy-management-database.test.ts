import { randomUUID } from 'node:crypto';

import { config as loadEnvironment } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AfterSalePolicyContent } from '@zalo-shop/contracts';
import {
  afterSalePolicyContentHash,
  assessAfterSalePolicyReadinessInTransaction,
  createRuntimePrismaClient,
  disableAfterSalePolicyInTransaction,
  PrismaClient,
  publishAfterSalePolicyInTransaction,
  putAfterSalePolicyDraftInTransaction,
  type StoreTransaction,
  withStoreTransaction,
} from '@zalo-shop/database';
import { createStoreContext } from '@zalo-shop/domain';

describe.sequential('M6.3-B2a after-sale policy management database primitives', () => {
  loadEnvironment({ path: '.env.test.example', quiet: true, override: true });
  const ownerUrl = process.env.DATABASE_URL;
  const runtimeUrl = process.env.DATABASE_RUNTIME_URL;
  if (!ownerUrl || !runtimeUrl) throw new Error('M6.3-B2a database URLs are required');

  const owner = new PrismaClient({ datasourceUrl: ownerUrl });
  const runtime = createRuntimePrismaClient(runtimeUrl);
  const contender = createRuntimePrismaClient(runtimeUrl);
  const suffix = randomUUID().slice(0, 8);
  const adminId = randomUUID();
  const memberId = randomUUID();
  const storeAId = randomUUID();
  const storeBId = randomUUID();
  const storeACode = `m63b2-a-${suffix}`;
  const storeBCode = `m63b2-b-${suffix}`;
  const categoryAId = randomUUID();
  const categoryBId = randomUUID();
  const brandAId = randomUUID();
  const productAId = randomUUID();
  const primaryCode = `primary-${suffix}`;
  const contenderCodeA = `default-a-${suffix}`;
  const contenderCodeB = `default-b-${suffix}`;

  function policyContent(overrides: Partial<AfterSalePolicyContent> = {}): AfterSalePolicyContent {
    return {
      allowed_types: ['EXCHANGE', 'REFUND_ONLY'],
      category_id: null,
      condition_rules: {
        allowed_reason_codes: ['damaged', 'defect', 'wrong-item'],
        evidence_required: true,
        evidence_required_reason_codes: ['wrong-item', 'damaged'],
        opened_package_exception_reason_codes: ['wrong-item', 'defect'],
      },
      damaged_exception: true,
      defect_exception: true,
      exchange_attribute_code: 'size',
      exchange_same_product_only: true,
      hygiene_restricted: false,
      localizations: [
        {
          buyer_instructions: 'English buyer instructions',
          locale: 'en',
          name: 'English policy',
          summary: 'English summary',
        },
        {
          buyer_instructions: 'Hướng dẫn dành cho người mua',
          locale: 'vi',
          name: 'Chính sách tiếng Việt',
          summary: 'Tóm tắt chính sách',
        },
        {
          buyer_instructions: '中文买家说明',
          locale: 'zh',
          name: '中文政策',
          summary: '中文摘要',
        },
      ],
      product_ids: [],
      request_window_days: 30,
      return_shipping_payer: 'MERCHANT',
      return_window_days: 7,
      unopened_required: false,
      wrong_item_exception: true,
      ...overrides,
    };
  }

  function context(store: 'a' | 'b', actor: 'admin' | 'member' = 'admin') {
    const isA = store === 'a';
    return createStoreContext({
      actor: { id: actor === 'admin' ? adminId : memberId, type: actor },
      correlationId: randomUUID(),
      locale: 'vi',
      storeCode: isA ? storeACode : storeBCode,
      storeId: isA ? storeAId : storeBId,
    });
  }

  async function transactionTime(transaction: StoreTransaction): Promise<Date> {
    const [clock] = await transaction.$queryRaw<Array<{ transaction_time: Date }>>`
      SELECT CURRENT_TIMESTAMP AS transaction_time
    `;
    if (!clock) throw new Error('Database transaction clock is unavailable');
    return clock.transaction_time;
  }

  beforeAll(async () => {
    await owner.$transaction(async (transaction) => {
      await transaction.adminUser.create({
        data: {
          displayName: 'M6.3-B2a database fixture administrator',
          email: `${adminId}@example.invalid`,
          emailNormalized: `${adminId}@example.invalid`,
          id: adminId,
          passwordHash: 'test-fixture-not-a-login-hash',
        },
      });
      await transaction.store.createMany({
        data: [
          { code: storeACode, id: storeAId, industry: 'BEAUTY' },
          { code: storeBCode, id: storeBId, industry: 'FASHION' },
        ],
      });
      await transaction.member.create({
        data: { displayName: 'M6.3-B2a member', id: memberId, storeId: storeAId },
      });
      await transaction.category.createMany({
        data: [
          { code: `category-a-${suffix}`, depth: 1, id: categoryAId, storeId: storeAId },
          { code: `category-b-${suffix}`, depth: 1, id: categoryBId, storeId: storeBId },
        ],
      });
      await transaction.brand.create({
        data: { code: `brand-a-${suffix}`, id: brandAId, storeId: storeAId },
      });
      await transaction.product.create({
        data: {
          brandId: brandAId,
          code: `product-a-${suffix}`,
          id: productAId,
          mainCategoryId: categoryAId,
          storeId: storeAId,
        },
      });
    });
  });

  afterAll(async () => {
    await owner.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`
        DELETE FROM store_after_sale_settings
        WHERE store_id = ANY(ARRAY[${storeAId}::uuid, ${storeBId}::uuid])
      `;
      await transaction.$executeRaw`
        DELETE FROM after_sale_active_policy_assignments
        WHERE store_id = ANY(ARRAY[${storeAId}::uuid, ${storeBId}::uuid])
      `;
      await transaction.$executeRaw`
        DELETE FROM after_sale_policy_draft_products
        WHERE store_id = ANY(ARRAY[${storeAId}::uuid, ${storeBId}::uuid])
      `;
      await transaction.$executeRaw`
        DELETE FROM after_sale_policy_localizations
        WHERE store_id = ANY(ARRAY[${storeAId}::uuid, ${storeBId}::uuid])
      `;
      await transaction.$executeRaw`
        DELETE FROM after_sale_policy_version_assignments
        WHERE store_id = ANY(ARRAY[${storeAId}::uuid, ${storeBId}::uuid])
      `;
      await transaction.$executeRaw`
        DELETE FROM after_sale_policy_versions
        WHERE store_id = ANY(ARRAY[${storeAId}::uuid, ${storeBId}::uuid])
      `;
      await transaction.$executeRaw`
        DELETE FROM after_sale_policies
        WHERE store_id = ANY(ARRAY[${storeAId}::uuid, ${storeBId}::uuid])
      `;
      await transaction.$executeRaw`DELETE FROM products WHERE store_id = ${storeAId}::uuid`;
      await transaction.$executeRaw`DELETE FROM brands WHERE store_id = ${storeAId}::uuid`;
      await transaction.$executeRaw`
        DELETE FROM categories
        WHERE store_id = ANY(ARRAY[${storeAId}::uuid, ${storeBId}::uuid])
      `;
      await transaction.$executeRaw`DELETE FROM members WHERE id = ${memberId}::uuid`;
      await transaction.$executeRaw`
        DELETE FROM stores WHERE id = ANY(ARRAY[${storeAId}::uuid, ${storeBId}::uuid])
      `;
      await transaction.$executeRaw`DELETE FROM admin_users WHERE id = ${adminId}::uuid`;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });
    await Promise.all([owner.$disconnect(), runtime.$disconnect(), contender.$disconnect()]);
  });

  it('publishes canonical immutable facts atomically without leaking an ACTIVE next draft', async () => {
    const initialContent = policyContent({ product_ids: [productAId.toUpperCase()] });
    const draft = await withStoreTransaction(runtime, context('a'), (transaction) =>
      putAfterSalePolicyDraftInTransaction(transaction, {
        actorId: adminId,
        code: primaryCode,
        content: initialContent,
        expectedVersion: 0,
        storeId: storeAId,
      }),
    );
    expect(draft.content.product_ids).toEqual([productAId]);
    expect(draft.policy).toMatchObject({ status: 'DRAFT', version: 1 });

    const published = await withStoreTransaction(runtime, context('a'), async (transaction) =>
      publishAfterSalePolicyInTransaction(transaction, {
        actorId: adminId,
        code: primaryCode,
        expectedVersion: 1,
        now: await transactionTime(transaction),
        storeId: storeAId,
      }),
    );
    expect(published.policy).toMatchObject({ status: 'ACTIVE', version: 2 });
    expect(published.version.effectiveAt.getTime()).toBe(published.version.publishedAt.getTime());

    const initialState = await withStoreTransaction(runtime, context('a'), async (transaction) => {
      const policy = await transaction.afterSalePolicy.findUnique({
        include: {
          activeAssignments: { orderBy: { targetType: 'asc' } },
          versions: {
            include: { assignments: true, localizations: true },
            orderBy: { versionNumber: 'asc' },
          },
        },
        where: { storeId_code: { code: primaryCode, storeId: storeAId } },
      });
      const settings = await transaction.storeAfterSaleSetting.findUnique({
        where: { storeId: storeAId },
      });
      const readiness = await assessAfterSalePolicyReadinessInTransaction(
        transaction,
        storeAId,
        published.version.publishedAt,
      );
      return { policy, readiness, settings };
    });
    expect(initialState.policy?.versions).toHaveLength(1);
    expect(
      initialState.policy?.versions[0]?.localizations.map(({ locale }) => locale).sort(),
    ).toEqual(['en', 'vi', 'zh']);
    expect(initialState.policy?.versions[0]?.assignments).toHaveLength(2);
    expect(initialState.policy?.activeAssignments).toHaveLength(2);
    expect(initialState.policy?.versions[0]?.payloadHash).toBe(
      afterSalePolicyContentHash(
        initialState.policy?.versions[0]?.payload as AfterSalePolicyContent,
      ),
    );
    expect(initialState.settings).toMatchObject({
      currentVersionId: published.version.id,
      defaultPolicyId: published.policy.id,
      readinessCheckedBy: adminId,
    });
    expect(initialState.settings?.readinessHash).toBe(initialState.readiness.readinessHash);
    expect(initialState.readiness).toMatchObject({
      currentVersionId: published.version.id,
      defaultPolicyId: published.policy.id,
      ready: true,
    });

    const nextDraft = await withStoreTransaction(runtime, context('a'), (transaction) =>
      putAfterSalePolicyDraftInTransaction(transaction, {
        actorId: adminId,
        code: primaryCode,
        content: policyContent({ category_id: categoryAId.toUpperCase() }),
        expectedVersion: 2,
        storeId: storeAId,
      }),
    );
    expect(nextDraft.content.category_id).toBe(categoryAId);
    expect(nextDraft.policy).toMatchObject({
      categoryId: null,
      currentVersionId: published.version.id,
      status: 'ACTIVE',
      version: 3,
    });

    const activeState = await withStoreTransaction(runtime, context('a'), async (transaction) => ({
      assignments: await transaction.afterSaleActivePolicyAssignment.findMany({
        where: { policyId: published.policy.id, storeId: storeAId },
      }),
      readiness: await assessAfterSalePolicyReadinessInTransaction(
        transaction,
        storeAId,
        published.version.publishedAt,
      ),
    }));
    expect(activeState.assignments).toHaveLength(2);
    expect(
      activeState.assignments.every(
        ({ policyVersionId }) => policyVersionId === published.version.id,
      ),
    ).toBe(true);
    expect(activeState.readiness).toMatchObject({
      currentVersionId: published.version.id,
      ready: true,
    });
  });

  it('synchronizes enforcement and rolls back a dangerous disable without mutating history', async () => {
    const resetDraft = await withStoreTransaction(runtime, context('a'), (transaction) =>
      putAfterSalePolicyDraftInTransaction(transaction, {
        actorId: adminId,
        code: primaryCode,
        content: policyContent({ product_ids: [productAId.toUpperCase()] }),
        expectedVersion: 3,
        storeId: storeAId,
      }),
    );
    expect(resetDraft.policy.version).toBe(4);

    await withStoreTransaction(runtime, context('a'), (transaction) =>
      transaction.storeAfterSaleSetting.update({
        data: {
          enforcePolicySnapshots: true,
          updatedBy: adminId,
          version: { increment: 1 },
        },
        where: { storeId: storeAId },
      }),
    );
    const published = await withStoreTransaction(runtime, context('a'), async (transaction) =>
      publishAfterSalePolicyInTransaction(transaction, {
        actorId: adminId,
        code: primaryCode,
        expectedVersion: 4,
        now: await transactionTime(transaction),
        storeId: storeAId,
      }),
    );
    expect(published.policy.version).toBe(5);
    expect(published.version.versionNumber).toBe(2);
    expect(published.settings).toMatchObject({
      currentVersionId: published.version.id,
      defaultPolicyId: published.policy.id,
      enforcePolicySnapshots: true,
      readinessCheckedBy: adminId,
    });
    expect(published.settings.readinessHash).not.toBeNull();

    const immutableAssignment = await withStoreTransaction(runtime, context('a'), (transaction) =>
      transaction.afterSalePolicyVersionAssignment.findFirstOrThrow({
        where: { policyVersionId: published.version.id, storeId: storeAId },
      }),
    );
    await expect(
      withStoreTransaction(runtime, context('a'), (transaction) =>
        transaction.afterSalePolicyVersion.update({
          data: { publishedAt: new Date(published.version.publishedAt.getTime() + 1_000) },
          where: { storeId_id: { id: published.version.id, storeId: storeAId } },
        }),
      ),
    ).rejects.toBeDefined();
    await expect(
      withStoreTransaction(runtime, context('a'), (transaction) =>
        transaction.afterSalePolicyLocalization.delete({
          where: {
            storeId_policyVersionId_locale: {
              locale: 'vi',
              policyVersionId: published.version.id,
              storeId: storeAId,
            },
          },
        }),
      ),
    ).rejects.toBeDefined();
    await expect(
      withStoreTransaction(runtime, context('a'), (transaction) =>
        transaction.afterSalePolicyVersionAssignment.delete({
          where: { storeId_id: { id: immutableAssignment.id, storeId: storeAId } },
        }),
      ),
    ).rejects.toBeDefined();

    await expect(
      withStoreTransaction(runtime, context('a'), async (transaction) =>
        disableAfterSalePolicyInTransaction(transaction, {
          actorId: adminId,
          code: primaryCode,
          expectedVersion: 5,
          now: await transactionTime(transaction),
          storeId: storeAId,
        }),
      ),
    ).rejects.toMatchObject({ code: 'AFTER_SALE_POLICY_NOT_READY' });

    const rolledBack = await withStoreTransaction(runtime, context('a'), async (transaction) => ({
      activeCount: await transaction.afterSaleActivePolicyAssignment.count({
        where: { policyId: published.policy.id, storeId: storeAId },
      }),
      localizationCount: await transaction.afterSalePolicyLocalization.count({
        where: { policyVersionId: published.version.id, storeId: storeAId },
      }),
      policy: await transaction.afterSalePolicy.findUniqueOrThrow({
        where: { storeId_code: { code: primaryCode, storeId: storeAId } },
      }),
      settings: await transaction.storeAfterSaleSetting.findUniqueOrThrow({
        where: { storeId: storeAId },
      }),
      versionCount: await transaction.afterSalePolicyVersion.count({
        where: { policyId: published.policy.id, storeId: storeAId },
      }),
    }));
    expect(rolledBack).toMatchObject({ activeCount: 2, localizationCount: 3, versionCount: 2 });
    expect(rolledBack.policy).toMatchObject({
      currentVersionId: published.version.id,
      status: 'ACTIVE',
      version: 5,
    });
    expect(rolledBack.settings).toMatchObject({
      currentVersionId: published.version.id,
      enforcePolicySnapshots: true,
    });

    await withStoreTransaction(runtime, context('a'), (transaction) =>
      transaction.storeAfterSaleSetting.update({
        data: {
          enforcePolicySnapshots: false,
          updatedBy: adminId,
          version: { increment: 1 },
        },
        where: { storeId: storeAId },
      }),
    );
    const disabled = await withStoreTransaction(runtime, context('a'), async (transaction) =>
      disableAfterSalePolicyInTransaction(transaction, {
        actorId: adminId,
        code: primaryCode,
        expectedVersion: 5,
        now: await transactionTime(transaction),
        storeId: storeAId,
      }),
    );
    expect(disabled.policy).toMatchObject({ status: 'DISABLED', version: 6 });
    expect(disabled.settings).toMatchObject({
      currentVersionId: null,
      defaultPolicyId: null,
      enforcePolicySnapshots: false,
      readinessHash: null,
      readinessReadyAt: null,
    });

    const preserved = await withStoreTransaction(runtime, context('a'), async (transaction) => ({
      activeCount: await transaction.afterSaleActivePolicyAssignment.count({
        where: { policyId: published.policy.id, storeId: storeAId },
      }),
      versionCount: await transaction.afterSalePolicyVersion.count({
        where: { policyId: published.policy.id, storeId: storeAId },
      }),
    }));
    expect(preserved).toEqual({ activeCount: 0, versionCount: 2 });
  });

  it('serializes two default-policy publishers so exactly one target owner wins', async () => {
    for (const code of [contenderCodeA, contenderCodeB]) {
      await withStoreTransaction(runtime, context('a'), (transaction) =>
        putAfterSalePolicyDraftInTransaction(transaction, {
          actorId: adminId,
          code,
          content: policyContent(),
          expectedVersion: 0,
          storeId: storeAId,
        }),
      );
    }

    const publish = (client: PrismaClient, code: string) =>
      withStoreTransaction(client, context('a'), async (transaction) =>
        publishAfterSalePolicyInTransaction(transaction, {
          actorId: adminId,
          code,
          expectedVersion: 1,
          now: await transactionTime(transaction),
          storeId: storeAId,
        }),
      );
    const results = await Promise.allSettled([
      publish(runtime, contenderCodeA),
      publish(contender, contenderCodeB),
    ]);
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(({ status }) => status === 'rejected');
    expect(rejected).toMatchObject({
      reason: { code: 'AFTER_SALE_POLICY_TARGET_CONFLICT' },
      status: 'rejected',
    });

    const activeDefaults = await withStoreTransaction(runtime, context('a'), (transaction) =>
      transaction.afterSaleActivePolicyAssignment.findMany({
        include: { policy: true },
        where: { storeId: storeAId, targetType: 'STORE_DEFAULT' },
      }),
    );
    expect(activeDefaults).toHaveLength(1);
    expect([contenderCodeA, contenderCodeB]).toContain(activeDefaults[0]?.policy.code);
  });

  it('preserves same-store member history while denying writes and cross-store access', async () => {
    await withStoreTransaction(runtime, context('b'), (transaction) =>
      putAfterSalePolicyDraftInTransaction(transaction, {
        actorId: adminId,
        code: `store-b-${suffix}`,
        content: policyContent(),
        expectedVersion: 0,
        storeId: storeBId,
      }),
    );

    const crossStoreRead = await withStoreTransaction(runtime, context('a'), (transaction) =>
      transaction.afterSalePolicy.findUnique({
        where: { storeId_code: { code: `store-b-${suffix}`, storeId: storeBId } },
      }),
    );
    expect(crossStoreRead).toBeNull();
    await expect(
      withStoreTransaction(runtime, context('a'), (transaction) =>
        putAfterSalePolicyDraftInTransaction(transaction, {
          actorId: adminId,
          code: `cross-store-${suffix}`,
          content: policyContent(),
          expectedVersion: 0,
          storeId: storeBId,
        }),
      ),
    ).rejects.toBeDefined();
    await expect(
      withStoreTransaction(runtime, context('a', 'member'), (transaction) =>
        putAfterSalePolicyDraftInTransaction(transaction, {
          actorId: memberId,
          code: `member-write-${suffix}`,
          content: policyContent(),
          expectedVersion: 0,
          storeId: storeAId,
        }),
      ),
    ).rejects.toBeDefined();

    const memberHistory = await withStoreTransaction(
      runtime,
      context('a', 'member'),
      async (transaction) => {
        const policy = await transaction.afterSalePolicy.findUnique({
          where: { storeId_code: { code: primaryCode, storeId: storeAId } },
        });
        const versions = policy
          ? await transaction.afterSalePolicyVersion.findMany({
              include: { localizations: true },
              orderBy: { versionNumber: 'asc' },
              where: { policyId: policy.id, storeId: storeAId },
            })
          : [];
        return { policy, versions };
      },
    );
    expect(memberHistory.policy?.status).toBe('DISABLED');
    expect(memberHistory.versions).toHaveLength(2);
    expect(memberHistory.versions.every(({ localizations }) => localizations.length === 3)).toBe(
      true,
    );
  });
});
