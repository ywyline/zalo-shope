import { createHash, randomUUID } from 'node:crypto';

import { config as loadEnvironment } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createRuntimePrismaClient,
  PrismaClient,
  type StoreTransaction,
  withAfterSaleSystemTransaction,
} from '@zalo-shop/database';
import { createAfterSaleSystemContext } from '@zalo-shop/domain';

const BEAUTY_STORE_ID = '10000000-0000-4000-8000-000000000001';
const FASHION_STORE_ID = '10000000-0000-4000-8000-000000000002';
const BEAUTY_CATEGORY_ID = '12000000-0000-4000-8000-000000000001';
const FASHION_CATEGORY_ID = '12000000-0000-4000-8000-000000000002';
const BEAUTY_WAREHOUSE_ID = '17000000-0000-4000-8000-000000000001';

const M6_TABLES = [
  'store_after_sale_settings',
  'after_sale_policies',
  'after_sale_policy_versions',
  'after_sale_policy_localizations',
  'after_sale_policy_draft_products',
  'after_sale_policy_version_assignments',
  'after_sale_active_policy_assignments',
  'order_item_after_sale_policy_snapshots',
  'after_sales',
  'after_sale_items',
  'after_sale_transitions',
  'after_sale_operations',
  'after_sale_legacy_decisions',
  'after_sale_inspections',
  'after_sale_inspection_allocations',
  'after_sale_evidence_files',
  'after_sale_evidence_transitions',
  'after_sale_settlements',
  'after_sale_refunds',
  'after_sale_order_allocations',
  'after_sale_inventory_actions',
  'after_sale_return_shipments',
  'exchange_fulfillments',
  'member_favorites',
  'member_product_views',
  'privacy_requests',
  'privacy_request_transitions',
  'share_links',
  'share_link_localizations',
  'share_interactions',
] as const;

const MEMBER_OWNER_TABLES = [
  'member_favorites',
  'member_product_views',
  'privacy_requests',
  'privacy_request_transitions',
] as const;

const APPEND_ONLY_TABLES = [
  'after_sale_policy_versions',
  'after_sale_policy_localizations',
  'after_sale_policy_version_assignments',
  'order_item_after_sale_policy_snapshots',
  'after_sale_transitions',
  'after_sale_legacy_decisions',
  'after_sale_inspections',
  'after_sale_inspection_allocations',
  'after_sale_evidence_transitions',
  'after_sale_refunds',
  'after_sale_order_allocations',
  'after_sale_inventory_actions',
  'privacy_request_transitions',
  'share_link_localizations',
  'share_interactions',
] as const;

const M6_PERMISSION_CODES = [
  'store.after-sales.read',
  'store.after-sales.review',
  'store.after-sales.inspect',
  'store.after-sales.exchange',
  'store.after-sales.evidence.read',
  'store.after-sales.policy.read',
  'store.after-sales.policy.manage',
  'store.after-sales.policy.publish',
  'store.after-sales.policy.disable',
  'store.after-sales.policy.enforce',
  'store.after-sales.cod-refunds.request',
  'store.after-sales.cod-refunds.confirm',
] as const;

describe('M6.2 after-sale, member and share database foundation', () => {
  loadEnvironment({ path: '.env.test.example', quiet: true, override: true });
  const ownerUrl = process.env.DATABASE_URL;
  const runtimeUrl = process.env.DATABASE_RUNTIME_URL;
  if (!ownerUrl || !runtimeUrl) throw new Error('M6.2 database URLs are required');

  const owner = new PrismaClient({ datasourceUrl: ownerUrl });
  const runtime = createRuntimePrismaClient(runtimeUrl);
  const contender = createRuntimePrismaClient(runtimeUrl);

  async function setContext(
    transaction: StoreTransaction,
    input: { actorId: string; actorType: 'admin' | 'member'; storeId: string },
  ): Promise<void> {
    await transaction.$executeRaw`
      SELECT
        set_config('app.store_id', ${input.storeId}, true),
        set_config('app.actor_id', ${input.actorId}, true),
        set_config('app.actor_type', ${input.actorType}, true),
        set_config('app.correlation_id', ${randomUUID()}, true)
    `;
  }

  async function setContextWithoutActorType(
    transaction: StoreTransaction,
    input: { actorId: string; storeId: string },
  ): Promise<void> {
    await transaction.$executeRaw`
      SELECT
        set_config('app.store_id', ${input.storeId}, true),
        set_config('app.actor_id', ${input.actorId}, true),
        set_config('app.correlation_id', ${randomUUID()}, true)
    `;
    const [context] = await transaction.$queryRaw<Array<{ actor_type: string | null }>>`
      SELECT pg_catalog.current_setting('app.actor_type', true) AS actor_type
    `;
    if (context?.actor_type !== null) {
      throw new Error('M6.2 untyped runtime fixture unexpectedly has app.actor_type');
    }
  }

  async function withRollback(
    callback: (transaction: StoreTransaction) => Promise<void>,
  ): Promise<void> {
    const rollback = new Error(`m62-rollback-${randomUUID()}`);
    try {
      await runtime.$transaction(async (transaction) => {
        await callback(transaction);
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }

  async function withOwnerRollback(
    callback: (transaction: StoreTransaction) => Promise<void>,
  ): Promise<void> {
    const rollback = new Error(`m62-owner-rollback-${randomUUID()}`);
    try {
      await owner.$transaction(async (transaction) => {
        await callback(transaction);
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }

  async function expectDatabaseFailure(
    transaction: StoreTransaction,
    action: () => Promise<unknown>,
    sqlState?: string,
  ): Promise<void> {
    const savepoint = `m62_expected_failure_${randomUUID().replaceAll('-', '')}`;
    await transaction.$executeRawUnsafe(`SAVEPOINT ${savepoint}`);
    let failure: unknown;
    try {
      await action();
    } catch (error) {
      failure = error;
    }
    await transaction.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await transaction.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);
    expect(failure).toBeDefined();
    if (sqlState) {
      const databaseFailure = failure as {
        code?: unknown;
        meta?: { code?: unknown; message?: unknown };
      };
      expect(databaseFailure.code).toBe('P2010');
      const failureMessage =
        typeof databaseFailure.meta?.message === 'string' ? databaseFailure.meta.message : '';
      expect(databaseFailure.meta?.code, failureMessage).toBe(sqlState);
    }
  }

  async function withCommittedCommerceFixture<T>(
    callback: (fixture: CommerceFixture) => Promise<T>,
  ): Promise<T> {
    const fixture = await owner.$transaction((transaction) => createCommerceFixture(transaction));
    try {
      return await callback(fixture);
    } finally {
      await owner.$transaction(async (transaction) => {
        await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
        await transaction.$executeRaw`DELETE FROM after_sale_refunds fact
          WHERE fact.store_id = ${BEAUTY_STORE_ID}::uuid
            AND fact.after_sale_id IN (SELECT sale.id FROM after_sales sale
              WHERE sale.store_id = ${BEAUTY_STORE_ID}::uuid
                AND sale.order_id = ${fixture.orderId}::uuid)`;
        await transaction.$executeRaw`DELETE FROM after_sale_inventory_actions fact
          WHERE fact.store_id = ${BEAUTY_STORE_ID}::uuid
            AND fact.after_sale_id IN (SELECT sale.id FROM after_sales sale
              WHERE sale.store_id = ${BEAUTY_STORE_ID}::uuid
                AND sale.order_id = ${fixture.orderId}::uuid)`;
        await transaction.$executeRaw`DELETE FROM exchange_fulfillments fact
          WHERE fact.store_id = ${BEAUTY_STORE_ID}::uuid
            AND fact.after_sale_id IN (SELECT sale.id FROM after_sales sale
              WHERE sale.store_id = ${BEAUTY_STORE_ID}::uuid
                AND sale.order_id = ${fixture.orderId}::uuid)`;
        await transaction.$executeRaw`DELETE FROM shipments fact
          WHERE fact.store_id = ${BEAUTY_STORE_ID}::uuid
            AND fact.after_sale_id IN (SELECT sale.id FROM after_sales sale
              WHERE sale.store_id = ${BEAUTY_STORE_ID}::uuid
                AND sale.order_id = ${fixture.orderId}::uuid)`;
        await transaction.$executeRaw`DELETE FROM after_sale_inspection_allocations fact
          WHERE fact.store_id = ${BEAUTY_STORE_ID}::uuid
            AND fact.after_sale_id IN (SELECT sale.id FROM after_sales sale
              WHERE sale.store_id = ${BEAUTY_STORE_ID}::uuid
                AND sale.order_id = ${fixture.orderId}::uuid)`;
        await transaction.$executeRaw`DELETE FROM after_sale_inspections fact
          WHERE fact.store_id = ${BEAUTY_STORE_ID}::uuid
            AND fact.after_sale_id IN (SELECT sale.id FROM after_sales sale
              WHERE sale.store_id = ${BEAUTY_STORE_ID}::uuid
                AND sale.order_id = ${fixture.orderId}::uuid)`;
        await transaction.$executeRaw`DELETE FROM after_sale_settlements fact
          WHERE fact.store_id = ${BEAUTY_STORE_ID}::uuid
            AND fact.after_sale_id IN (SELECT sale.id FROM after_sales sale
              WHERE sale.store_id = ${BEAUTY_STORE_ID}::uuid
                AND sale.order_id = ${fixture.orderId}::uuid)`;
        await transaction.$executeRaw`DELETE FROM after_sale_return_shipments fact
          WHERE fact.store_id = ${BEAUTY_STORE_ID}::uuid
            AND fact.after_sale_id IN (SELECT sale.id FROM after_sales sale
              WHERE sale.store_id = ${BEAUTY_STORE_ID}::uuid
                AND sale.order_id = ${fixture.orderId}::uuid)`;
        await transaction.$executeRaw`DELETE FROM after_sale_evidence_transitions transition
          USING after_sale_evidence_files evidence
          WHERE transition.store_id = evidence.store_id
            AND transition.evidence_file_id = evidence.id
            AND evidence.store_id = ${BEAUTY_STORE_ID}::uuid
            AND evidence.after_sale_id IN (SELECT sale.id FROM after_sales sale
              WHERE sale.store_id = ${BEAUTY_STORE_ID}::uuid
                AND sale.order_id = ${fixture.orderId}::uuid)`;
        await transaction.$executeRaw`DELETE FROM after_sale_evidence_files fact
          WHERE fact.store_id = ${BEAUTY_STORE_ID}::uuid
            AND fact.after_sale_id IN (SELECT sale.id FROM after_sales sale
              WHERE sale.store_id = ${BEAUTY_STORE_ID}::uuid
                AND sale.order_id = ${fixture.orderId}::uuid)`;
        await transaction.$executeRaw`DELETE FROM after_sale_operations fact
          WHERE fact.store_id = ${BEAUTY_STORE_ID}::uuid
            AND fact.after_sale_id IN (SELECT sale.id FROM after_sales sale
              WHERE sale.store_id = ${BEAUTY_STORE_ID}::uuid
                AND sale.order_id = ${fixture.orderId}::uuid)`;
        await transaction.$executeRaw`DELETE FROM after_sale_legacy_decisions fact
          WHERE fact.store_id = ${BEAUTY_STORE_ID}::uuid
            AND fact.after_sale_id IN (SELECT sale.id FROM after_sales sale
              WHERE sale.store_id = ${BEAUTY_STORE_ID}::uuid
                AND sale.order_id = ${fixture.orderId}::uuid)`;
        await transaction.$executeRaw`DELETE FROM after_sale_order_allocations fact
          WHERE fact.store_id = ${BEAUTY_STORE_ID}::uuid
            AND fact.order_id = ${fixture.orderId}::uuid`;
        await transaction.$executeRaw`DELETE FROM after_sale_transitions fact
          WHERE fact.store_id = ${BEAUTY_STORE_ID}::uuid
            AND fact.after_sale_id IN (SELECT sale.id FROM after_sales sale
              WHERE sale.store_id = ${BEAUTY_STORE_ID}::uuid
                AND sale.order_id = ${fixture.orderId}::uuid)`;
        await transaction.$executeRaw`DELETE FROM after_sale_items
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND order_id = ${fixture.orderId}::uuid`;
        await transaction.$executeRaw`DELETE FROM after_sales
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND order_id = ${fixture.orderId}::uuid`;
        await transaction.$executeRaw`DELETE FROM order_item_after_sale_policy_snapshots
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND order_id = ${fixture.orderId}::uuid`;
        await transaction.$executeRaw`DELETE FROM after_sale_active_policy_assignments
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid
            AND assignment_id = ${fixture.casePolicyAssignmentId}::uuid`;
        await transaction.$executeRaw`DELETE FROM after_sale_policy_version_assignments
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid
            AND id = ${fixture.casePolicyAssignmentId}::uuid`;
        await transaction.$executeRaw`DELETE FROM order_items
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND order_id = ${fixture.orderId}::uuid`;
        await transaction.$executeRaw`DELETE FROM orders
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${fixture.orderId}::uuid`;
        await transaction.$executeRaw`DELETE FROM skus
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid
            AND id IN (${fixture.skuId}::uuid, ${fixture.replacementSkuId}::uuid,
              ${fixture.alternateSkuId}::uuid)`;
        await transaction.$executeRaw`DELETE FROM products
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${fixture.productId}::uuid`;
        await transaction.$executeRaw`DELETE FROM after_sale_policy_localizations
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid
            AND policy_version_id = ${fixture.casePolicyVersionId}::uuid`;
        await transaction.$executeRaw`DELETE FROM after_sale_policy_versions
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid
            AND id = ${fixture.casePolicyVersionId}::uuid`;
        await transaction.$executeRaw`DELETE FROM after_sale_policies
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${fixture.casePolicyId}::uuid`;
        await transaction.$executeRaw`DELETE FROM brands
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${fixture.brandId}::uuid`;
        await transaction.$executeRaw`DELETE FROM members
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${fixture.memberId}::uuid`;
        await transaction.$executeRaw`DELETE FROM admin_users
          WHERE id IN (${fixture.adminId}::uuid, ${fixture.confirmingAdminId}::uuid)`;
      });
    }
  }

  type CommerceFixture = Readonly<{
    adminId: string;
    confirmingAdminId: string;
    memberId: string;
    brandId: string;
    productId: string;
    skuId: string;
    replacementSkuId: string;
    alternateSkuId: string;
    casePolicyAssignmentId: string;
    casePolicyId: string;
    casePolicyPayload: string;
    casePolicyPayloadHash: string;
    casePolicyVersionId: string;
    orderId: string;
    orderItemId: string;
  }>;

  async function createCommerceFixture(
    transaction: StoreTransaction,
    input: {
      orderPayableVnd?: number;
      orderQuantity?: number;
      paymentMethod?: 'COD' | 'ONLINE';
      withCasePolicy?: boolean;
    } = {},
  ): Promise<CommerceFixture> {
    const casePolicyVersionId = randomUUID();
    const fixture: CommerceFixture = {
      adminId: randomUUID(),
      confirmingAdminId: randomUUID(),
      memberId: randomUUID(),
      brandId: randomUUID(),
      productId: randomUUID(),
      skuId: randomUUID(),
      replacementSkuId: randomUUID(),
      alternateSkuId: randomUUID(),
      casePolicyAssignmentId: randomUUID(),
      casePolicyId: randomUUID(),
      casePolicyPayload: JSON.stringify({
        return_shipping_payer: 'MERCHANT',
        return_window_days: 7,
      }),
      casePolicyPayloadHash: createHash('sha256')
        .update(`m63-b0-policy-${casePolicyVersionId}`)
        .digest('hex'),
      casePolicyVersionId,
      orderId: randomUUID(),
      orderItemId: randomUUID(),
    };
    const payableVnd = input.orderPayableVnd ?? 100_000;
    const orderQuantity = input.orderQuantity ?? 2;
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');

    await transaction.$executeRaw`INSERT INTO admin_users
      (id, email, email_normalized, display_name, password_hash, updated_at)
      VALUES
        (${fixture.adminId}::uuid, ${`${fixture.adminId}@example.invalid`},
          ${`${fixture.adminId}@example.invalid`}, 'M6.2 fixture admin',
          'test-fixture-not-a-login-hash', now()),
        (${fixture.confirmingAdminId}::uuid, ${`${fixture.confirmingAdminId}@example.invalid`},
          ${`${fixture.confirmingAdminId}@example.invalid`}, 'M6.2 confirming admin',
          'test-fixture-not-a-login-hash', now())`;
    await transaction.$executeRaw`INSERT INTO members (id, store_id, updated_at)
      VALUES (${fixture.memberId}::uuid, ${BEAUTY_STORE_ID}::uuid, now())`;
    await transaction.$executeRaw`INSERT INTO brands (id, store_id, code, updated_at)
      VALUES (${fixture.brandId}::uuid, ${BEAUTY_STORE_ID}::uuid,
        ${`m62-brand-${fixture.brandId.slice(0, 8)}`}, now())`;
    await transaction.$executeRaw`INSERT INTO products
      (id, store_id, code, brand_id, main_category_id, updated_at)
      VALUES (${fixture.productId}::uuid, ${BEAUTY_STORE_ID}::uuid,
        ${`m62-product-${fixture.productId.slice(0, 8)}`}, ${fixture.brandId}::uuid,
        ${BEAUTY_CATEGORY_ID}::uuid, now())`;
    await transaction.$executeRaw`INSERT INTO skus
      (id, store_id, product_id, code, sale_price_vnd, option_combination_key,
        option_combination_hash, updated_at)
      VALUES
        (${fixture.skuId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${fixture.productId}::uuid,
          ${`m62-sku-${fixture.skuId.slice(0, 8)}`}, ${payableVnd}, 'size=small',
          ${digest(`sku-${fixture.skuId}`)}, now()),
        (${fixture.replacementSkuId}::uuid, ${BEAUTY_STORE_ID}::uuid,
          ${fixture.productId}::uuid, ${`m62-sku-${fixture.replacementSkuId.slice(0, 8)}`},
          ${payableVnd}, 'size=medium', ${digest(`sku-${fixture.replacementSkuId}`)}, now()),
        (${fixture.alternateSkuId}::uuid, ${BEAUTY_STORE_ID}::uuid,
          ${fixture.productId}::uuid, ${`m62-sku-${fixture.alternateSkuId.slice(0, 8)}`},
          ${payableVnd}, 'size=large', ${digest(`sku-${fixture.alternateSkuId}`)}, now())`;
    await transaction.$executeRaw`INSERT INTO orders
      (id, store_id, member_id, order_number, status, payment_method, payment_status,
        currency, base_subtotal_vnd, shipping_fee_vnd, payable_vnd, quote_hash, updated_at)
      VALUES (${fixture.orderId}::uuid, ${BEAUTY_STORE_ID}::uuid,
        ${fixture.memberId}::uuid, ${`M62-${fixture.orderId.slice(0, 12)}`},
        'PENDING_FULFILLMENT', ${input.paymentMethod ?? 'COD'}::order_payment_method,
        'SUCCEEDED', 'VND', ${payableVnd}, 0,
        ${payableVnd}, ${digest(`quote-${fixture.orderId}`)}, now())`;
    await transaction.$executeRaw`INSERT INTO order_items
      (id, store_id, order_id, sku_id, product_id, brand_id, category_id, sku_code,
        product_name, brand_name, option_snapshot, unit_price_vnd, quantity,
        subtotal_vnd, payable_vnd)
      VALUES (${fixture.orderItemId}::uuid, ${BEAUTY_STORE_ID}::uuid,
        ${fixture.orderId}::uuid, ${fixture.skuId}::uuid, ${fixture.productId}::uuid,
        ${fixture.brandId}::uuid, ${BEAUTY_CATEGORY_ID}::uuid,
         ${`m62-sku-${fixture.skuId.slice(0, 8)}`}, 'M6.2 product', 'M6.2 brand',
         '{"size":"small"}'::jsonb, ${Math.floor(payableVnd / orderQuantity)},
         ${orderQuantity}, ${payableVnd}, ${payableVnd})`;
    if (input.withCasePolicy !== false) {
      await setContext(transaction, {
        actorId: fixture.adminId,
        actorType: 'admin',
        storeId: BEAUTY_STORE_ID,
      });
      await transaction.$executeRaw`INSERT INTO after_sale_policies
        (id, store_id, code, status, draft_payload, draft_hash, created_by, updated_by,
          updated_at)
        VALUES (${fixture.casePolicyId}::uuid, ${BEAUTY_STORE_ID}::uuid,
          ${`m63-b0-${fixture.casePolicyId.slice(0, 8)}`}, 'DRAFT', '{}'::jsonb,
          ${digest(`m63-b0-draft-${fixture.casePolicyId}`)}, ${fixture.adminId}::uuid,
          ${fixture.adminId}::uuid, now())`;
      await transaction.$executeRaw`INSERT INTO after_sale_policy_versions
        (id, store_id, policy_id, version_number, effective_at, request_window_days,
          return_window_days, allowed_types, return_shipping_payer, unopened_required,
          hygiene_restricted, damaged_exception, wrong_item_exception, defect_exception,
          condition_rules, payload, payload_hash, published_by)
        VALUES (${fixture.casePolicyVersionId}::uuid, ${BEAUTY_STORE_ID}::uuid,
          ${fixture.casePolicyId}::uuid, 1, now(), 30, 7,
          ARRAY['REFUND_ONLY','RETURN_REFUND','EXCHANGE','MERCHANT_REFUND']::after_sale_type[],
          'MERCHANT', false, false, true, true, true, '{}'::jsonb,
          ${fixture.casePolicyPayload}::jsonb, ${fixture.casePolicyPayloadHash},
          ${fixture.adminId}::uuid)`;
      await transaction.$executeRaw`INSERT INTO after_sale_policy_localizations
        (store_id, policy_version_id, locale, name, summary, buyer_instructions)
        VALUES (${BEAUTY_STORE_ID}::uuid, ${fixture.casePolicyVersionId}::uuid, 'vi',
          'Chinh sach B0', 'Tom tat B0', 'Huong dan B0')`;
      await transaction.$executeRaw`UPDATE after_sale_policies
        SET status = 'ACTIVE', current_version_id = ${fixture.casePolicyVersionId}::uuid,
          version = version + 1, updated_at = now()
        WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${fixture.casePolicyId}::uuid`;
      await transaction.$executeRaw`INSERT INTO after_sale_policy_version_assignments
        (id, store_id, policy_id, policy_version_id, target_type, product_id)
        VALUES (${fixture.casePolicyAssignmentId}::uuid, ${BEAUTY_STORE_ID}::uuid,
          ${fixture.casePolicyId}::uuid, ${fixture.casePolicyVersionId}::uuid,
          'PRODUCT', ${fixture.productId}::uuid)`;
      await transaction.$executeRaw`INSERT INTO after_sale_active_policy_assignments
        (store_id, target_type, product_id, policy_id, policy_version_id, assignment_id,
          updated_at)
        VALUES (${BEAUTY_STORE_ID}::uuid, 'PRODUCT', ${fixture.productId}::uuid,
          ${fixture.casePolicyId}::uuid, ${fixture.casePolicyVersionId}::uuid,
          ${fixture.casePolicyAssignmentId}::uuid, now())`;
      await transaction.$executeRaw`INSERT INTO order_item_after_sale_policy_snapshots
        (store_id, order_id, order_item_id, policy_id, policy_version_id, policy_code,
          policy_version_number, payload, payload_hash)
        VALUES (${BEAUTY_STORE_ID}::uuid, ${fixture.orderId}::uuid,
          ${fixture.orderItemId}::uuid, ${fixture.casePolicyId}::uuid,
          ${fixture.casePolicyVersionId}::uuid, ${`m63-b0-${fixture.casePolicyId.slice(0, 8)}`},
          1, ${fixture.casePolicyPayload}::jsonb, ${fixture.casePolicyPayloadHash})`;
    }
    return fixture;
  }

  async function createPublishedPolicy(
    transaction: StoreTransaction,
    fixture: CommerceFixture,
    input: { activateDefault?: boolean; code: string },
  ): Promise<{ policyId: string; policyVersionId: string; payloadHash: string }> {
    const policyId = randomUUID();
    const policyVersionId = randomUUID();
    const assignmentId = randomUUID();
    const payloadHash = createHash('sha256')
      .update(`policy-payload-${policyVersionId}`)
      .digest('hex');

    await setContext(transaction, {
      actorId: fixture.adminId,
      actorType: 'admin',
      storeId: BEAUTY_STORE_ID,
    });

    await transaction.$executeRaw`INSERT INTO after_sale_policies
      (id, store_id, code, status, draft_payload, draft_hash, created_by, updated_by, updated_at)
      VALUES (${policyId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${input.code}, 'DRAFT',
        '{}'::jsonb, ${createHash('sha256').update(`draft-${policyId}`).digest('hex')},
        ${fixture.adminId}::uuid, ${fixture.adminId}::uuid, now())`;
    await transaction.$executeRaw`INSERT INTO after_sale_policy_versions
      (id, store_id, policy_id, version_number, effective_at, request_window_days,
        return_window_days, allowed_types, return_shipping_payer, unopened_required,
        hygiene_restricted, damaged_exception, wrong_item_exception, defect_exception,
        condition_rules, payload, payload_hash, published_by)
      VALUES (${policyVersionId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${policyId}::uuid,
        1, now(), 30, 7, ARRAY['RETURN_REFUND','EXCHANGE']::after_sale_type[],
        'MERCHANT', false, false, true, true, true, '{}'::jsonb,
        jsonb_build_object('return_window_days', 7, 'return_shipping_payer', 'MERCHANT'),
        ${payloadHash}, ${fixture.adminId}::uuid)`;
    await transaction.$executeRaw`INSERT INTO after_sale_policy_localizations
      (store_id, policy_version_id, locale, name, summary, buyer_instructions)
      VALUES (${BEAUTY_STORE_ID}::uuid, ${policyVersionId}::uuid, 'vi',
        'Chinh sach thu nghiem', 'Tom tat thu nghiem', 'Huong dan thu nghiem')`;
    await transaction.$executeRaw`UPDATE after_sale_policies
      SET status = 'ACTIVE', current_version_id = ${policyVersionId}::uuid,
        updated_at = now(), version = version + 1
      WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${policyId}::uuid`;

    if (input.activateDefault) {
      await transaction.$executeRaw`INSERT INTO after_sale_policy_version_assignments
        (id, store_id, policy_id, policy_version_id, target_type)
        VALUES (${assignmentId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${policyId}::uuid,
          ${policyVersionId}::uuid, 'STORE_DEFAULT')`;
      await transaction.$executeRaw`INSERT INTO after_sale_active_policy_assignments
        (store_id, target_type, policy_id, policy_version_id, assignment_id, updated_at)
        VALUES (${BEAUTY_STORE_ID}::uuid, 'STORE_DEFAULT', ${policyId}::uuid,
          ${policyVersionId}::uuid, ${assignmentId}::uuid, now())`;
    }

    return { payloadHash, policyId, policyVersionId };
  }

  async function createAfterSaleFixture(
    transaction: StoreTransaction,
    fixture: CommerceFixture,
    input: {
      approvedTotalVnd?: number;
      type?: 'EXCHANGE' | 'REFUND_ONLY' | 'RETURN_REFUND';
      withItem?: boolean;
    } = {},
  ): Promise<{ afterSaleId: string; afterSaleItemId?: string }> {
    const afterSaleId = randomUUID();
    const approvedTotalVnd = input.approvedTotalVnd ?? 60_000;
    const afterSaleItemId = input.withItem === false ? undefined : randomUUID();
    const approvedQuantity = approvedTotalVnd >= 100_000 ? 2 : 1;
    const approvedItemVnd = afterSaleItemId ? approvedQuantity * 50_000 : 0;
    const approvedOtherVnd = approvedTotalVnd - approvedItemVnd;
    if (approvedOtherVnd < 0) {
      throw new Error('M6.2 fixture approved total cannot cover its positive item allocation');
    }
    const type = input.type ?? 'REFUND_ONLY';
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');

    await setContext(transaction, {
      actorId: fixture.adminId,
      actorType: 'admin',
      storeId: BEAUTY_STORE_ID,
    });

    await transaction.$executeRaw`INSERT INTO after_sales
      (id, store_id, order_id, member_id, public_case_number, type, status, source,
        reason_code, policy_snapshot, policy_hash, policy_id, policy_version_id,
        legacy_policy_review,
        requested_item_vnd, requested_other_vnd, requested_total_vnd,
        idempotency_key_hash, request_hash, initiated_by, correlation_id, updated_at)
      VALUES (${afterSaleId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${fixture.orderId}::uuid,
        ${fixture.memberId}::uuid,
        ${`ASC-${afterSaleId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
        ${type}::after_sale_type, 'PENDING_REVIEW', 'ADMIN', 'm62-regression',
        ${fixture.casePolicyPayload}::jsonb, ${fixture.casePolicyPayloadHash},
        ${fixture.casePolicyId}::uuid, ${fixture.casePolicyVersionId}::uuid, false,
        ${approvedItemVnd}, ${approvedOtherVnd}, ${approvedTotalVnd},
        ${digest(`case-key-${afterSaleId}`)},
        ${digest(`case-request-${afterSaleId}`)}, ${fixture.adminId}::uuid,
        ${`m62-${afterSaleId}`}, now())`;

    if (afterSaleItemId) {
      await transaction.$executeRaw`INSERT INTO after_sale_items
        (id, store_id, after_sale_id, order_id, order_item_id, requested_quantity,
          requested_item_vnd,
          sku_id, product_id, brand_id, category_id, sku_code, product_name,
          option_snapshot, unit_price_vnd, replacement_sku_id, updated_at)
        VALUES (${afterSaleItemId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${afterSaleId}::uuid,
          ${fixture.orderId}::uuid, ${fixture.orderItemId}::uuid, ${approvedQuantity},
          ${approvedItemVnd}, ${fixture.skuId}::uuid,
          ${fixture.productId}::uuid, ${fixture.brandId}::uuid,
          ${BEAUTY_CATEGORY_ID}::uuid, ${`m62-sku-${fixture.skuId.slice(0, 8)}`},
          'M6.2 product', '{"size":"small"}'::jsonb, 50000,
          ${type === 'EXCHANGE' ? fixture.replacementSkuId : null}::uuid, now())`;

      await transaction.$executeRaw`UPDATE after_sale_items
        SET approved_quantity = ${approvedQuantity}, approved_item_vnd = ${approvedItemVnd},
          replacement_quantity = ${type === 'EXCHANGE' ? approvedQuantity : 0},
          updated_at = now()
        WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${afterSaleItemId}::uuid`;
    }

    await transaction.$executeRaw`UPDATE after_sales
      SET approved_item_vnd = ${approvedItemVnd},
        approved_other_vnd = ${approvedOtherVnd},
        approved_total_vnd = ${approvedTotalVnd},
        return_deadline_at = CASE WHEN ${type} IN ('RETURN_REFUND', 'EXCHANGE')
          THEN now() + interval '7 days' ELSE NULL END,
        updated_at = now()
      WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${afterSaleId}::uuid`;
    if (approvedOtherVnd > 0) {
      await transaction.$executeRaw`INSERT INTO after_sale_order_allocations
        (store_id, after_sale_id, order_id, other_vnd)
        VALUES (${BEAUTY_STORE_ID}::uuid, ${afterSaleId}::uuid,
          ${fixture.orderId}::uuid, ${approvedOtherVnd})`;
    }
    await transaction.$executeRaw`INSERT INTO after_sale_transitions
      (store_id, after_sale_id, from_status, to_status, event, actor_type,
        actor_id, correlation_id)
      VALUES (${BEAUTY_STORE_ID}::uuid, ${afterSaleId}::uuid,
        'PENDING_REVIEW', 'APPROVED', 'APPROVE', 'ADMIN',
        ${fixture.adminId}::uuid,
        pg_catalog.current_setting('app.correlation_id', true))`;

    return { afterSaleId, afterSaleItemId };
  }

  async function appendAfterSaleTransition(
    transaction: StoreTransaction,
    input: {
      actorId: string;
      afterSaleId: string;
      event: string;
      fromStatus: string;
      toStatus: string;
    },
  ): Promise<void> {
    await setContext(transaction, {
      actorId: input.actorId,
      actorType: 'admin',
      storeId: BEAUTY_STORE_ID,
    });
    await transaction.$executeRaw`INSERT INTO after_sale_transitions
      (store_id, after_sale_id, from_status, to_status, event, actor_type,
        actor_id, correlation_id)
      VALUES (${BEAUTY_STORE_ID}::uuid, ${input.afterSaleId}::uuid,
        ${input.fromStatus}::after_sale_status, ${input.toStatus}::after_sale_status,
        ${input.event}, 'ADMIN', ${input.actorId}::uuid,
        pg_catalog.current_setting('app.correlation_id', true))`;
  }

  function createDeferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((complete) => {
      resolve = complete;
    });
    return { promise, resolve };
  }

  async function waitForAfterSaleRowLock(input: {
    blockerPid: number;
    contenderPid: number;
  }): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const [lockState] = await owner.$queryRaw<Array<{ blocked: boolean }>>`
        SELECT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_stat_activity activity
          WHERE activity.pid = ${input.contenderPid}
            AND activity.wait_event_type = 'Lock'
            AND ${input.blockerPid} = ANY(pg_catalog.pg_blocking_pids(activity.pid))
            AND EXISTS (
              SELECT 1 FROM pg_catalog.pg_locks contender_lock
              WHERE contender_lock.pid = activity.pid
                AND contender_lock.relation = 'after_sales'::regclass
            )
            AND EXISTS (
              SELECT 1 FROM pg_catalog.pg_locks blocker_lock
              WHERE blocker_lock.pid = ${input.blockerPid}
                AND blocker_lock.relation = 'after_sales'::regclass
            )
        ) AS blocked
      `;
      if (lockState?.blocked) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(
      `M6.2 contender ${input.contenderPid} did not wait on sale-row blocker ${input.blockerPid}`,
    );
  }

  async function waitForApprovalAdvisoryLock(input: {
    blockerPid: number;
    contenderPid: number;
  }): Promise<{ orderLockModes: string[] }> {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const [lockState] = await owner.$queryRaw<
        Array<{ advisory_waiting: boolean; order_lock_modes: string[] }>
      >`
        SELECT
          EXISTS (
            SELECT 1
            FROM pg_catalog.pg_locks waiting
            JOIN pg_catalog.pg_locks held
              ON held.locktype = 'advisory'
             AND held.database IS NOT DISTINCT FROM waiting.database
             AND held.classid = waiting.classid
             AND held.objid = waiting.objid
             AND held.objsubid = waiting.objsubid
            WHERE waiting.pid = ${input.contenderPid}
              AND waiting.locktype = 'advisory'
              AND NOT waiting.granted
              AND held.pid = ${input.blockerPid}
              AND held.granted
              AND ${input.blockerPid} = ANY(pg_catalog.pg_blocking_pids(waiting.pid))
          ) AS advisory_waiting,
          ARRAY(
            SELECT lock.mode
            FROM pg_catalog.pg_locks lock
            WHERE lock.pid = ${input.contenderPid}
              AND lock.relation = 'orders'::regclass
              AND lock.granted
              AND lock.mode NOT IN ('AccessShareLock', 'SIReadLock')
            ORDER BY lock.mode
          ) AS order_lock_modes
      `;
      if (lockState?.advisory_waiting) {
        return { orderLockModes: lockState.order_lock_modes };
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(
      `M6.2 approval ${input.contenderPid} did not wait on advisory blocker ${input.blockerPid}`,
    );
  }

  async function raceWithHeldAfterSaleTransition(
    input: {
      actorId: string;
      afterSaleId: string;
      beforeTransition?: (transaction: StoreTransaction) => Promise<void>;
      event: string;
      fromStatus: string;
      toStatus: string;
    },
    action: (transaction: StoreTransaction) => Promise<unknown>,
  ): Promise<PromiseSettledResult<unknown>[]> {
    const transitionReady = createDeferred();
    const releaseTransition = createDeferred();
    const transitionPid = createDeferred<number>();
    const contenderPid = createDeferred<number>();
    const transitionAttempt = runtime.$transaction(async (transaction) => {
      const [backend] = await transaction.$queryRaw<Array<{ pid: number }>>`
        SELECT pg_catalog.pg_backend_pid()::integer AS pid
      `;
      if (!backend) throw new Error('M6.2 transition backend PID is unavailable');
      transitionPid.resolve(backend.pid);
      try {
        await setContext(transaction, {
          actorId: input.actorId,
          actorType: 'admin',
          storeId: BEAUTY_STORE_ID,
        });
        await input.beforeTransition?.(transaction);
        await appendAfterSaleTransition(transaction, input);
      } finally {
        transitionReady.resolve(undefined);
      }
      await releaseTransition.promise;
    });
    await transitionReady.promise;

    const contenderAttempt = contender.$transaction(async (transaction) => {
      const [backend] = await transaction.$queryRaw<Array<{ pid: number }>>`
        SELECT pg_catalog.pg_backend_pid()::integer AS pid
      `;
      if (!backend) throw new Error('M6.2 contender backend PID is unavailable');
      contenderPid.resolve(backend.pid);
      return action(transaction);
    });
    let lockWaitFailure: unknown;
    try {
      await waitForAfterSaleRowLock({
        blockerPid: await transitionPid.promise,
        contenderPid: await contenderPid.promise,
      });
    } catch (error) {
      lockWaitFailure = error;
    } finally {
      releaseTransition.resolve(undefined);
    }

    const results = await Promise.allSettled([transitionAttempt, contenderAttempt]);
    if (lockWaitFailure instanceof Error) throw lockWaitFailure;
    if (lockWaitFailure) {
      throw new Error('M6.2 sale-row lock observation failed', { cause: lockWaitFailure });
    }
    return results;
  }

  async function raceWithHeldAfterSaleRowLock(
    input: {
      actorId: string;
      afterSaleId: string;
      afterLock: (transaction: StoreTransaction) => Promise<unknown>;
    },
    action: (transaction: StoreTransaction) => Promise<unknown>,
  ): Promise<PromiseSettledResult<unknown>[]> {
    const holderReady = createDeferred();
    const releaseHolder = createDeferred();
    const holderPid = createDeferred<number>();
    const contenderPid = createDeferred<number>();
    const holderAttempt = runtime.$transaction(async (transaction) => {
      const [backend] = await transaction.$queryRaw<Array<{ pid: number }>>`
        SELECT pg_catalog.pg_backend_pid()::integer AS pid
      `;
      if (!backend) throw new Error('M6.2 sale-lock holder backend PID is unavailable');
      holderPid.resolve(backend.pid);
      try {
        await setContext(transaction, {
          actorId: input.actorId,
          actorType: 'admin',
          storeId: BEAUTY_STORE_ID,
        });
        const lockedCases = await transaction.$queryRaw<Array<{ id: string }>>`
          SELECT id::text AS id
          FROM after_sales
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${input.afterSaleId}::uuid
          FOR UPDATE
        `;
        if (lockedCases.length !== 1) {
          throw new Error('M6.2 sale-lock holder could not lock the after-sale aggregate');
        }
      } finally {
        holderReady.resolve(undefined);
      }
      await releaseHolder.promise;
      return input.afterLock(transaction);
    });
    await holderReady.promise;

    const contenderAttempt = contender.$transaction(async (transaction) => {
      const [backend] = await transaction.$queryRaw<Array<{ pid: number }>>`
        SELECT pg_catalog.pg_backend_pid()::integer AS pid
      `;
      if (!backend) throw new Error('M6.2 sale-lock contender backend PID is unavailable');
      contenderPid.resolve(backend.pid);
      await setContext(transaction, {
        actorId: input.actorId,
        actorType: 'admin',
        storeId: BEAUTY_STORE_ID,
      });
      return action(transaction);
    });
    let lockWaitFailure: unknown;
    try {
      await waitForAfterSaleRowLock({
        blockerPid: await holderPid.promise,
        contenderPid: await contenderPid.promise,
      });
    } catch (error) {
      lockWaitFailure = error;
    } finally {
      releaseHolder.resolve(undefined);
    }

    const results = await Promise.allSettled([holderAttempt, contenderAttempt]);
    if (lockWaitFailure instanceof Error) throw lockWaitFailure;
    if (lockWaitFailure) {
      throw new Error('M6.2 sale-lock observation failed', { cause: lockWaitFailure });
    }
    return results;
  }

  async function advanceAfterSaleToInspection(
    transaction: StoreTransaction,
    fixture: CommerceFixture,
    afterSaleId: string,
  ): Promise<string> {
    const returnShipmentId = randomUUID();
    const trackingDigest = createHash('sha256')
      .update(`tracking-${returnShipmentId}`)
      .digest('hex');
    await setContext(transaction, {
      actorId: fixture.memberId,
      actorType: 'member',
      storeId: BEAUTY_STORE_ID,
    });
    await transaction.$executeRaw`INSERT INTO after_sale_return_shipments
      (id, store_id, after_sale_id, order_id, member_id, carrier_name,
        tracking_number_digest, tracking_number_masked, submitted_by, updated_at)
      VALUES (${returnShipmentId}::uuid, ${BEAUTY_STORE_ID}::uuid,
        ${afterSaleId}::uuid, ${fixture.orderId}::uuid, ${fixture.memberId}::uuid,
        'M6.2 carrier', ${trackingDigest}, '***1234', ${fixture.memberId}::uuid, now())`;
    await appendAfterSaleTransition(transaction, {
      actorId: fixture.adminId,
      afterSaleId,
      event: 'START_RETURN',
      fromStatus: 'APPROVED',
      toStatus: 'RETURN_PENDING',
    });
    await transaction.$executeRaw`UPDATE after_sale_return_shipments
      SET status = 'IN_TRANSIT', version = version + 1, updated_at = now()
      WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${returnShipmentId}::uuid`;
    await appendAfterSaleTransition(transaction, {
      actorId: fixture.adminId,
      afterSaleId,
      event: 'RETURN_SHIPPED',
      fromStatus: 'RETURN_PENDING',
      toStatus: 'RETURN_IN_TRANSIT',
    });
    await transaction.$executeRaw`UPDATE after_sale_return_shipments
      SET status = 'DELIVERED', received_at = now(), version = version + 1,
        updated_at = now()
      WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${returnShipmentId}::uuid`;
    await appendAfterSaleTransition(transaction, {
      actorId: fixture.adminId,
      afterSaleId,
      event: 'RETURN_RECEIVED',
      fromStatus: 'RETURN_IN_TRANSIT',
      toStatus: 'INSPECTION_PENDING',
    });
    return returnShipmentId;
  }

  async function createCompleteInspection(
    transaction: StoreTransaction,
    fixture: CommerceFixture,
    input: {
      afterSaleId: string;
      afterSaleItemId: string;
      disposition?: 'RESTOCK_SELLABLE' | 'RETURN_TO_MEMBER';
      quantity?: number;
    },
  ): Promise<string> {
    const inspectionId = randomUUID();
    await setContext(transaction, {
      actorId: fixture.adminId,
      actorType: 'admin',
      storeId: BEAUTY_STORE_ID,
    });
    await transaction.$executeRaw`INSERT INTO after_sale_inspections
      (id, store_id, after_sale_id, inspection_version, admin_id, reason)
      VALUES (${inspectionId}::uuid, ${BEAUTY_STORE_ID}::uuid,
        ${input.afterSaleId}::uuid, 1, ${fixture.adminId}::uuid, 'M6.2 inspection')`;
    await transaction.$executeRaw`INSERT INTO after_sale_inspection_allocations
      (id, store_id, inspection_id, after_sale_id, after_sale_item_id,
        disposition, quantity)
      VALUES (${randomUUID()}::uuid, ${BEAUTY_STORE_ID}::uuid, ${inspectionId}::uuid,
        ${input.afterSaleId}::uuid, ${input.afterSaleItemId}::uuid,
        ${input.disposition ?? 'RESTOCK_SELLABLE'}::after_sale_inspection_disposition,
        ${input.quantity ?? 2})`;
    await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL DEFERRED');
    return inspectionId;
  }

  async function expectSqlState(promise: Promise<unknown>, sqlState: string): Promise<void> {
    try {
      await promise;
      throw new Error(`Expected SQLSTATE ${sqlState}`);
    } catch (error) {
      expect(error).toMatchObject({ code: 'P2010', meta: { code: sqlState } });
    }
  }

  beforeAll(async () => Promise.all([owner.$connect(), runtime.$connect(), contender.$connect()]));
  afterAll(async () =>
    Promise.all([owner.$disconnect(), runtime.$disconnect(), contender.$disconnect()]),
  );

  it('forces RLS on every M6 table and fails closed without a store context', async () => {
    const metadata = await owner.$queryRawUnsafe<
      Array<{ relforcerowsecurity: boolean; relname: string; relrowsecurity: boolean }>
    >(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace
        AND c.relname IN (${M6_TABLES.map((table) => `'${table}'`).join(',')})
      ORDER BY c.relname
    `);
    expect(metadata.map(({ relname }) => relname)).toEqual([...M6_TABLES].sort());
    expect(
      metadata.every(
        ({ relforcerowsecurity, relrowsecurity }) => relforcerowsecurity && relrowsecurity,
      ),
    ).toBe(true);

    const withoutContext = await runtime.$queryRawUnsafe<Array<{ visible_rows: bigint }>>(`
      SELECT sum(visible_rows)::bigint AS visible_rows
      FROM (
        ${M6_TABLES.map((table) => `SELECT count(*)::bigint AS visible_rows FROM "${table}"`).join(
          '\nUNION ALL\n',
        )}
      ) visible
    `);
    expect(withoutContext).toEqual([{ visible_rows: 0n }]);
  });

  it('uses composite tenant foreign keys for every M6 reference to tenant-owned data', async () => {
    const unsafeForeignKeys = await owner.$queryRawUnsafe<
      Array<{ constraint_definition: string; constraint_name: string; table_name: string }>
    >(`
      SELECT
        source.relname AS table_name,
        constraint_record.conname AS constraint_name,
        pg_get_constraintdef(constraint_record.oid) AS constraint_definition
      FROM pg_constraint constraint_record
      JOIN pg_class source ON source.oid = constraint_record.conrelid
      JOIN pg_class target ON target.oid = constraint_record.confrelid
      WHERE constraint_record.contype = 'f'
        AND source.relname IN (${M6_TABLES.map((table) => `'${table}'`).join(',')})
        AND EXISTS (
          SELECT 1
          FROM pg_attribute target_store
          WHERE target_store.attrelid = target.oid
            AND target_store.attname = 'store_id'
            AND NOT target_store.attisdropped
        )
        AND target.relname <> 'stores'
        AND NOT (
          EXISTS (
            SELECT 1
            FROM unnest(constraint_record.conkey) source_key(attnum)
            JOIN pg_attribute source_column
              ON source_column.attrelid = source.oid AND source_column.attnum = source_key.attnum
            WHERE source_column.attname = 'store_id'
          )
          AND EXISTS (
            SELECT 1
            FROM unnest(constraint_record.confkey) target_key(attnum)
            JOIN pg_attribute target_column
              ON target_column.attrelid = target.oid AND target_column.attnum = target_key.attnum
            WHERE target_column.attname = 'store_id'
          )
        )
      ORDER BY source.relname, constraint_record.conname
    `);
    expect(unsafeForeignKeys).toEqual([]);

    const ownershipForeignKey = await owner.$queryRaw<Array<{ definition: string }>>`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'after_sales'::regclass
        AND confrelid = 'orders'::regclass
        AND contype = 'f'
    `;
    expect(ownershipForeignKey).toHaveLength(1);
    expect(ownershipForeignKey[0]?.definition.replaceAll('"', '')).toContain(
      'FOREIGN KEY (store_id, order_id, member_id) REFERENCES orders(store_id, id, member_id)',
    );
  });

  it('registers the M6 permission catalog without platform or non-test role grants', async () => {
    const permissions = await owner.$queryRaw<Array<{ code: string; scope: string }>>`
      SELECT code, scope::text
      FROM permissions
      WHERE code = ANY(${[...M6_PERMISSION_CODES]})
      ORDER BY code
    `;
    expect(permissions.map(({ code }) => code)).toEqual([...M6_PERMISSION_CODES].sort());
    expect(permissions.every(({ scope }) => scope === 'STORE')).toBe(true);

    const platformGrants = await owner.$queryRaw<Array<{ grant_count: bigint }>>`
      SELECT count(*)::bigint AS grant_count
      FROM platform_role_permissions
      WHERE permission_code = ANY(${[...M6_PERMISSION_CODES]})
    `;
    expect(platformGrants).toEqual([{ grant_count: 0n }]);

    const unexpectedStoreGrants = await owner.$queryRaw<Array<{ permission_code: string }>>`
      SELECT srp.permission_code
      FROM store_role_permissions srp
      JOIN store_roles sr ON sr.store_id = srp.store_id AND sr.id = srp.role_id
      WHERE srp.permission_code = ANY(${[...M6_PERMISSION_CODES]})
        AND NOT (
          sr.code = 'store-admin'
          AND sr.store_id IN (${BEAUTY_STORE_ID}::uuid, ${FASHION_STORE_ID}::uuid)
        )
      ORDER BY srp.permission_code
    `;
    expect(unexpectedStoreGrants).toEqual([]);
  });

  it('enforces member-owner RLS and rejects cross-member and cross-store favorites', async () => {
    await withRollback(async (transaction) => {
      const memberId = randomUUID();
      const otherMemberId = randomUUID();
      const beautyBrandId = randomUUID();
      const beautyProductId = randomUUID();
      const fashionBrandId = randomUUID();
      const fashionProductId = randomUUID();

      await setContext(transaction, {
        actorId: randomUUID(),
        actorType: 'admin',
        storeId: BEAUTY_STORE_ID,
      });
      await transaction.$executeRaw`INSERT INTO members (id, store_id, updated_at)
        VALUES
          (${memberId}::uuid, ${BEAUTY_STORE_ID}::uuid, now()),
          (${otherMemberId}::uuid, ${BEAUTY_STORE_ID}::uuid, now())`;
      await transaction.$executeRaw`INSERT INTO brands (id, store_id, code, updated_at)
        VALUES (${beautyBrandId}::uuid, ${BEAUTY_STORE_ID}::uuid,
          ${`m62-beauty-${beautyBrandId.slice(0, 8)}`}, now())`;
      await transaction.$executeRaw`INSERT INTO products
        (id, store_id, code, brand_id, main_category_id, updated_at)
        VALUES (${beautyProductId}::uuid, ${BEAUTY_STORE_ID}::uuid,
          ${`m62-beauty-${beautyProductId.slice(0, 8)}`}, ${beautyBrandId}::uuid,
          ${BEAUTY_CATEGORY_ID}::uuid, now())`;

      await setContext(transaction, {
        actorId: randomUUID(),
        actorType: 'admin',
        storeId: FASHION_STORE_ID,
      });
      await transaction.$executeRaw`INSERT INTO brands (id, store_id, code, updated_at)
        VALUES (${fashionBrandId}::uuid, ${FASHION_STORE_ID}::uuid,
          ${`m62-fashion-${fashionBrandId.slice(0, 8)}`}, now())`;
      await transaction.$executeRaw`INSERT INTO products
        (id, store_id, code, brand_id, main_category_id, updated_at)
        VALUES (${fashionProductId}::uuid, ${FASHION_STORE_ID}::uuid,
          ${`m62-fashion-${fashionProductId.slice(0, 8)}`}, ${fashionBrandId}::uuid,
          ${FASHION_CATEGORY_ID}::uuid, now())`;

      await setContext(transaction, {
        actorId: memberId,
        actorType: 'member',
        storeId: BEAUTY_STORE_ID,
      });
      await transaction.$executeRaw`INSERT INTO member_favorites
        (store_id, member_id, product_id)
        VALUES (${BEAUTY_STORE_ID}::uuid, ${memberId}::uuid, ${beautyProductId}::uuid)`;
      const visible = await transaction.$queryRaw<Array<{ member_id: string; product_id: string }>>`
        SELECT member_id, product_id FROM member_favorites
      `;
      expect(visible).toEqual([{ member_id: memberId, product_id: beautyProductId }]);

      await expectDatabaseFailure(
        transaction,
        () =>
          transaction.$executeRaw`INSERT INTO member_favorites
          (store_id, member_id, product_id)
          VALUES (${BEAUTY_STORE_ID}::uuid, ${otherMemberId}::uuid, ${beautyProductId}::uuid)`,
      );
      await expectDatabaseFailure(
        transaction,
        () =>
          transaction.$executeRaw`INSERT INTO member_favorites
          (store_id, member_id, product_id)
          VALUES (${BEAUTY_STORE_ID}::uuid, ${memberId}::uuid, ${fashionProductId}::uuid)`,
      );

      await setContext(transaction, {
        actorId: otherMemberId,
        actorType: 'member',
        storeId: BEAUTY_STORE_ID,
      });
      expect(await transaction.$queryRaw`SELECT product_id FROM member_favorites`).toEqual([]);
    });
  });

  it('serializes concurrent after-sale quantity claims for the same order item', async () => {
    await withCommittedCommerceFixture(async (fixture) => {
      const afterSaleIds = [randomUUID(), randomUUID()] as const;
      const digest = (value: string) => createHash('sha256').update(value).digest('hex');
      const attempts = [runtime, contender].map((client, index) =>
        client.$transaction(async (transaction) => {
          const afterSaleId = afterSaleIds[index]!;
          await setContext(transaction, {
            actorId: fixture.memberId,
            actorType: 'member',
            storeId: BEAUTY_STORE_ID,
          });
          await transaction.$executeRaw`INSERT INTO after_sales
            (id, store_id, order_id, member_id, public_case_number, type, status, source,
              reason_code, policy_snapshot, policy_hash, policy_id, policy_version_id,
              legacy_policy_review,
              requested_item_vnd, requested_total_vnd, idempotency_key_hash, request_hash,
              initiated_by, correlation_id, updated_at)
            VALUES (${afterSaleId}::uuid, ${BEAUTY_STORE_ID}::uuid,
              ${fixture.orderId}::uuid, ${fixture.memberId}::uuid,
              ${`ASC-${afterSaleId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
              'REFUND_ONLY', 'PENDING_REVIEW', 'MEMBER', 'm62-concurrent-claim',
              ${fixture.casePolicyPayload}::jsonb, ${fixture.casePolicyPayloadHash},
              ${fixture.casePolicyId}::uuid, ${fixture.casePolicyVersionId}::uuid, false,
              100000, 100000,
              ${digest(`case-key-${afterSaleId}`)},
              ${digest(`case-request-${afterSaleId}`)}, ${fixture.memberId}::uuid,
              ${`m62-race-${afterSaleId}`}, now())`;
          await transaction.$executeRaw`INSERT INTO after_sale_items
            (store_id, after_sale_id, order_id, order_item_id, requested_quantity,
              requested_item_vnd, sku_id, product_id, brand_id, category_id, sku_code,
              product_name, option_snapshot, unit_price_vnd, updated_at)
            VALUES (${BEAUTY_STORE_ID}::uuid, ${afterSaleId}::uuid,
              ${fixture.orderId}::uuid, ${fixture.orderItemId}::uuid, 2, 100000,
              ${fixture.skuId}::uuid, ${fixture.productId}::uuid,
              ${fixture.brandId}::uuid, ${BEAUTY_CATEGORY_ID}::uuid,
              ${`m62-sku-${fixture.skuId.slice(0, 8)}`}, 'M6.2 product',
              '{"size":"small"}'::jsonb, 50000, now())`;
          return afterSaleId;
        }),
      );

      const results = await Promise.allSettled(attempts);
      const successes = results.filter(
        (result): result is PromiseFulfilledResult<string> => result.status === 'fulfilled',
      );
      const failures = results.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect(failures[0]!.reason).toMatchObject({
        code: 'P2010',
        meta: { code: '23514' },
      });
      expect(
        await owner.$queryRaw<Array<{ claim_count: bigint }>>`SELECT count(*)::bigint AS claim_count
          FROM after_sale_items
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid
            AND order_item_id = ${fixture.orderItemId}::uuid`,
      ).toEqual([{ claim_count: 1n }]);
    });
  });

  it('releases item quantity after a rejection decision', async () => {
    await withCommittedCommerceFixture(async (fixture) => {
      await withRollback(async (transaction) => {
        await setContext(transaction, {
          actorId: fixture.adminId,
          actorType: 'admin',
          storeId: BEAUTY_STORE_ID,
        });
        const digest = (value: string) => createHash('sha256').update(value).digest('hex');
        const firstAfterSaleId = randomUUID();
        const secondAfterSaleId = randomUUID();

        await transaction.$executeRaw`INSERT INTO after_sales
          (id, store_id, order_id, member_id, public_case_number, type, status, source,
            reason_code, policy_snapshot, policy_hash, policy_id, policy_version_id,
            legacy_policy_review,
            requested_item_vnd, requested_other_vnd, requested_total_vnd,
            idempotency_key_hash, request_hash,
            initiated_by, correlation_id, updated_at)
          VALUES (${firstAfterSaleId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${fixture.orderId}::uuid, ${fixture.memberId}::uuid,
            ${`ASC-${firstAfterSaleId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
            'REFUND_ONLY', 'PENDING_REVIEW', 'ADMIN', 'unapproved-item-release',
            ${fixture.casePolicyPayload}::jsonb, ${fixture.casePolicyPayloadHash},
            ${fixture.casePolicyId}::uuid, ${fixture.casePolicyVersionId}::uuid, false,
            100000, 10000, 110000,
            ${digest(`case-key-${firstAfterSaleId}`)},
            ${digest(`case-request-${firstAfterSaleId}`)}, ${fixture.adminId}::uuid,
            ${`m62-${firstAfterSaleId}`}, now())`;
        await transaction.$executeRaw`INSERT INTO after_sale_items
          (store_id, after_sale_id, order_id, order_item_id, requested_quantity,
            requested_item_vnd, sku_id, product_id, brand_id, category_id, sku_code,
            product_name, option_snapshot, unit_price_vnd, updated_at)
          VALUES (${BEAUTY_STORE_ID}::uuid, ${firstAfterSaleId}::uuid,
            ${fixture.orderId}::uuid, ${fixture.orderItemId}::uuid, 2, 100000,
            ${fixture.skuId}::uuid, ${fixture.productId}::uuid,
            ${fixture.brandId}::uuid, ${BEAUTY_CATEGORY_ID}::uuid,
            ${`m62-sku-${fixture.skuId.slice(0, 8)}`}, 'M6.2 product',
            '{"size":"small"}'::jsonb, 50000, now())`;
        await expectDatabaseFailure(
          transaction,
          async () => {
            await transaction.$executeRaw`UPDATE after_sales
              SET approved_other_vnd = 10000, approved_total_vnd = 10000,
                updated_at = now()
              WHERE store_id = ${BEAUTY_STORE_ID}::uuid
                AND id = ${firstAfterSaleId}::uuid`;
            await transaction.$executeRaw`INSERT INTO after_sale_order_allocations
              (store_id, after_sale_id, order_id, other_vnd)
              VALUES (${BEAUTY_STORE_ID}::uuid, ${firstAfterSaleId}::uuid,
                ${fixture.orderId}::uuid, 10000)`;
            await appendAfterSaleTransition(transaction, {
              actorId: fixture.adminId,
              afterSaleId: firstAfterSaleId,
              event: 'APPROVE',
              fromStatus: 'PENDING_REVIEW',
              toStatus: 'APPROVED',
            });
          },
          '23514',
        );
        await appendAfterSaleTransition(transaction, {
          actorId: fixture.adminId,
          afterSaleId: firstAfterSaleId,
          event: 'REJECT',
          fromStatus: 'PENDING_REVIEW',
          toStatus: 'REJECTED',
        });

        await transaction.$executeRaw`INSERT INTO after_sales
          (id, store_id, order_id, member_id, public_case_number, type, status, source,
            reason_code, policy_snapshot, policy_hash, policy_id, policy_version_id,
            legacy_policy_review,
            requested_item_vnd, requested_total_vnd, idempotency_key_hash, request_hash,
            initiated_by, correlation_id, updated_at)
          VALUES (${secondAfterSaleId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${fixture.orderId}::uuid, ${fixture.memberId}::uuid,
            ${`ASC-${secondAfterSaleId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
            'REFUND_ONLY', 'PENDING_REVIEW', 'ADMIN', 'reclaimed-item-capacity',
            ${fixture.casePolicyPayload}::jsonb, ${fixture.casePolicyPayloadHash},
            ${fixture.casePolicyId}::uuid, ${fixture.casePolicyVersionId}::uuid, false,
            100000, 100000,
            ${digest(`case-key-${secondAfterSaleId}`)},
            ${digest(`case-request-${secondAfterSaleId}`)}, ${fixture.adminId}::uuid,
            ${`m62-${secondAfterSaleId}`}, now())`;
        await transaction.$executeRaw`INSERT INTO after_sale_items
          (store_id, after_sale_id, order_id, order_item_id, requested_quantity,
            requested_item_vnd, sku_id, product_id, brand_id, category_id, sku_code,
            product_name, option_snapshot, unit_price_vnd, updated_at)
          VALUES (${BEAUTY_STORE_ID}::uuid, ${secondAfterSaleId}::uuid,
            ${fixture.orderId}::uuid, ${fixture.orderItemId}::uuid, 2, 100000,
            ${fixture.skuId}::uuid, ${fixture.productId}::uuid,
            ${fixture.brandId}::uuid, ${BEAUTY_CATEGORY_ID}::uuid,
            ${`m62-sku-${fixture.skuId.slice(0, 8)}`}, 'M6.2 product',
            '{"size":"small"}'::jsonb, 50000, now())`;

        expect(
          await transaction.$queryRaw`SELECT sale.status, item.requested_quantity,
              item.approved_quantity
            FROM after_sales sale
            JOIN after_sale_items item ON item.store_id = sale.store_id
              AND item.after_sale_id = sale.id
            WHERE sale.store_id = ${BEAUTY_STORE_ID}::uuid
              AND sale.id IN (${firstAfterSaleId}::uuid, ${secondAfterSaleId}::uuid)
            ORDER BY sale.id`,
        ).toEqual(
          expect.arrayContaining([
            { approved_quantity: 0, requested_quantity: 2, status: 'REJECTED' },
            { approved_quantity: 0, requested_quantity: 2, status: 'PENDING_REVIEW' },
          ]),
        );
      });
    });
  });

  it('serializes item insertion against approval and rejection terminal decisions', async () => {
    await withCommittedCommerceFixture(async (fixture) => {
      const digest = (value: string) => createHash('sha256').update(value).digest('hex');
      const decisions = [
        { event: 'APPROVE', status: 'APPROVED' },
        { event: 'REJECT', status: 'REJECTED' },
      ] as const;
      const cases = await owner.$transaction(async (transaction) => {
        await setContext(transaction, {
          actorId: fixture.adminId,
          actorType: 'admin',
          storeId: BEAUTY_STORE_ID,
        });
        return Promise.all(
          decisions.map(async (decision) => {
            const afterSaleId = randomUUID();
            const afterSaleItemId = randomUUID();
            const approving = decision.event === 'APPROVE';
            await transaction.$executeRaw`INSERT INTO after_sales
              (id, store_id, order_id, member_id, public_case_number, type, status, source,
                reason_code, policy_snapshot, policy_hash, policy_id, policy_version_id,
                legacy_policy_review,
                requested_item_vnd, requested_other_vnd, requested_total_vnd,
                idempotency_key_hash, request_hash,
                initiated_by, correlation_id, updated_at)
              VALUES (${afterSaleId}::uuid, ${BEAUTY_STORE_ID}::uuid,
                ${fixture.orderId}::uuid, ${fixture.memberId}::uuid,
                ${`ASC-${afterSaleId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
                'REFUND_ONLY', 'PENDING_REVIEW', 'ADMIN', 'item-decision-race',
                ${fixture.casePolicyPayload}::jsonb, ${fixture.casePolicyPayloadHash},
                ${fixture.casePolicyId}::uuid, ${fixture.casePolicyVersionId}::uuid, false,
                ${approving ? 50000 : 0}, ${approving ? 0 : 50000}, 50000,
                ${digest(`case-key-${afterSaleId}`)},
                ${digest(`case-request-${afterSaleId}`)}, ${fixture.adminId}::uuid,
                ${`m62-${afterSaleId}`}, now())`;
            if (approving) {
              await transaction.$executeRaw`INSERT INTO after_sale_items
                (id, store_id, after_sale_id, order_id, order_item_id, requested_quantity,
                  requested_item_vnd, sku_id, product_id, brand_id, category_id, sku_code,
                  product_name, option_snapshot, unit_price_vnd, updated_at)
                VALUES (${afterSaleItemId}::uuid, ${BEAUTY_STORE_ID}::uuid,
                  ${afterSaleId}::uuid, ${fixture.orderId}::uuid,
                  ${fixture.orderItemId}::uuid, 1, 50000, ${fixture.skuId}::uuid,
                  ${fixture.productId}::uuid, ${fixture.brandId}::uuid,
                  ${BEAUTY_CATEGORY_ID}::uuid,
                  ${`m62-sku-${fixture.skuId.slice(0, 8)}`}, 'M6.2 product',
                  '{"size":"small"}'::jsonb, 50000, now())`;
              await transaction.$executeRaw`UPDATE after_sale_items
                SET approved_quantity = 1, approved_item_vnd = 50000, updated_at = now()
                WHERE store_id = ${BEAUTY_STORE_ID}::uuid
                  AND id = ${afterSaleItemId}::uuid`;
              await transaction.$executeRaw`UPDATE after_sales
                SET approved_item_vnd = 50000, approved_total_vnd = 50000,
                  updated_at = now()
                WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${afterSaleId}::uuid`;
            }
            return { afterSaleId, initialItemCount: approving ? 1n : 0n, ...decision };
          }),
        );
      });

      for (const afterSaleCase of cases) {
        const results = await raceWithHeldAfterSaleTransition(
          {
            actorId: fixture.adminId,
            afterSaleId: afterSaleCase.afterSaleId,
            event: afterSaleCase.event,
            fromStatus: 'PENDING_REVIEW',
            toStatus: afterSaleCase.status,
          },
          async (transaction) => {
            await setContext(transaction, {
              actorId: fixture.adminId,
              actorType: 'admin',
              storeId: BEAUTY_STORE_ID,
            });
            return transaction.$executeRaw`INSERT INTO after_sale_items
              (id, store_id, after_sale_id, order_id, order_item_id, requested_quantity,
                requested_item_vnd, sku_id, product_id, brand_id, category_id, sku_code,
                product_name, option_snapshot, unit_price_vnd, updated_at)
              VALUES (${randomUUID()}::uuid, ${BEAUTY_STORE_ID}::uuid,
                ${afterSaleCase.afterSaleId}::uuid, ${fixture.orderId}::uuid,
                ${fixture.orderItemId}::uuid, 1, 50000, ${fixture.skuId}::uuid,
                ${fixture.productId}::uuid, ${fixture.brandId}::uuid,
                ${BEAUTY_CATEGORY_ID}::uuid,
                ${`m62-sku-${fixture.skuId.slice(0, 8)}`}, 'M6.2 product',
                '{"size":"small"}'::jsonb, 50000, now())`;
          },
        );
        expect(results[0]).toMatchObject({ status: 'fulfilled' });
        expect(results[1]).toMatchObject({
          reason: { code: 'P2010', meta: { code: '23514' } },
          status: 'rejected',
        });
        expect(
          await owner.$queryRaw`SELECT sale.status, count(item.id)::bigint AS item_count
            FROM after_sales sale
            LEFT JOIN after_sale_items item ON item.store_id = sale.store_id
              AND item.after_sale_id = sale.id
            WHERE sale.store_id = ${BEAUTY_STORE_ID}::uuid
              AND sale.id = ${afterSaleCase.afterSaleId}::uuid
            GROUP BY sale.status`,
        ).toEqual([{ item_count: afterSaleCase.initialItemCount, status: afterSaleCase.status }]);
      }
    });
  });

  it('restricts member after-sale, privacy, and evidence writes to owner-safe paths', async () => {
    await withCommittedCommerceFixture(async (fixture) => {
      await withRollback(async (transaction) => {
        const afterSaleId = randomUUID();
        const afterSaleItemId = randomUUID();
        const operationId = randomUUID();
        const evidenceId = randomUUID();
        const privacyRequestId = randomUUID();
        const digest = (value: string) => createHash('sha256').update(value).digest('hex');
        await setContext(transaction, {
          actorId: fixture.memberId,
          actorType: 'member',
          storeId: BEAUTY_STORE_ID,
        });

        await expectDatabaseFailure(
          transaction,
          () => transaction.$executeRaw`INSERT INTO after_sales
            (store_id, order_id, member_id, public_case_number, type, status, source,
              reason_code, policy_snapshot, policy_hash, policy_id, policy_version_id,
              legacy_policy_review,
              requested_item_vnd, requested_total_vnd, idempotency_key_hash, request_hash,
              initiated_by, correlation_id, updated_at)
            VALUES (${BEAUTY_STORE_ID}::uuid, ${fixture.orderId}::uuid,
              ${fixture.memberId}::uuid,
              ${`ASC-${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`},
              'REFUND_ONLY', 'PENDING_REVIEW', 'MEMBER', 'spoofed-member-actor',
              ${fixture.casePolicyPayload}::jsonb, ${fixture.casePolicyPayloadHash},
              ${fixture.casePolicyId}::uuid, ${fixture.casePolicyVersionId}::uuid, false,
              100000, 100000,
              ${digest(`spoofed-key-${afterSaleId}`)},
              ${digest(`spoofed-request-${afterSaleId}`)}, ${randomUUID()}::uuid,
              ${`m62-spoofed-${afterSaleId}`}, now())`,
          '23514',
        );
        await transaction.$executeRaw`INSERT INTO after_sales
          (id, store_id, order_id, member_id, public_case_number, type, status, source,
            reason_code, policy_snapshot, policy_hash, policy_id, policy_version_id,
            legacy_policy_review,
            requested_item_vnd, requested_total_vnd, idempotency_key_hash, request_hash,
            initiated_by, correlation_id, updated_at)
          VALUES (${afterSaleId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${fixture.orderId}::uuid, ${fixture.memberId}::uuid,
            ${`ASC-${afterSaleId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
            'REFUND_ONLY', 'PENDING_REVIEW', 'MEMBER', 'member-request',
            ${fixture.casePolicyPayload}::jsonb, ${fixture.casePolicyPayloadHash},
            ${fixture.casePolicyId}::uuid, ${fixture.casePolicyVersionId}::uuid, false,
            100000, 100000,
            ${digest(`case-key-${afterSaleId}`)},
            ${digest(`case-request-${afterSaleId}`)}, ${fixture.memberId}::uuid,
            ${`m62-member-${afterSaleId}`}, now())`;
        await transaction.$executeRaw`INSERT INTO after_sale_items
          (id, store_id, after_sale_id, order_id, order_item_id, requested_quantity,
            requested_item_vnd, sku_id, product_id, brand_id, category_id, sku_code,
            product_name, option_snapshot, unit_price_vnd, updated_at)
          VALUES (${afterSaleItemId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${afterSaleId}::uuid, ${fixture.orderId}::uuid, ${fixture.orderItemId}::uuid,
            2, 100000, ${fixture.skuId}::uuid, ${fixture.productId}::uuid,
            ${fixture.brandId}::uuid, ${BEAUTY_CATEGORY_ID}::uuid,
            ${`m62-sku-${fixture.skuId.slice(0, 8)}`}, 'M6.2 product',
            '{"size":"small"}'::jsonb, 50000, now())`;
        await transaction.$executeRaw`INSERT INTO after_sale_operations
          (id, store_id, after_sale_id, operation, idempotency_key_hash, request_hash,
            updated_at)
          VALUES (${operationId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${afterSaleId}::uuid, 'MEMBER_SUBMIT', ${digest(`operation-key-${operationId}`)},
            ${digest(`operation-request-${operationId}`)}, now())`;

        await expect(
          transaction.$executeRaw`UPDATE after_sale_items
            SET updated_at = now() + interval '1 second'
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${afterSaleItemId}::uuid`,
        ).resolves.toBe(0);
        await expect(
          transaction.$executeRaw`UPDATE after_sale_operations
            SET attempt_count = 1, updated_at = now()
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${operationId}::uuid`,
        ).resolves.toBe(0);
        await expectDatabaseFailure(
          transaction,
          () => transaction.$executeRaw`UPDATE after_sales
            SET status = 'APPROVED', version = version + 1, updated_at = now()
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${afterSaleId}::uuid`,
          '42501',
        );
        await expectDatabaseFailure(
          transaction,
          () => transaction.$executeRaw`UPDATE after_sales
            SET status = 'CANCELLED', version = version + 1, completed_at = now(),
              updated_at = now()
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${afterSaleId}::uuid`,
          '42501',
        );
        await expectDatabaseFailure(
          transaction,
          () => transaction.$executeRaw`INSERT INTO after_sale_transitions
            (store_id, after_sale_id, from_status, to_status, event, actor_type,
              actor_id, correlation_id)
            VALUES (${BEAUTY_STORE_ID}::uuid, ${afterSaleId}::uuid,
              'PENDING_REVIEW', 'APPROVED', 'APPROVE', 'MEMBER',
              ${fixture.memberId}::uuid,
              pg_catalog.current_setting('app.correlation_id', true))`,
          '42501',
        );

        await transaction.$executeRaw`INSERT INTO after_sale_evidence_files
          (id, store_id, member_id, upload_session_id, mime_type, byte_size,
            checksum_sha256, original_filename, status, updated_at)
          VALUES (${evidenceId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${fixture.memberId}::uuid, ${randomUUID()}::uuid, 'image/jpeg', 1024,
            ${digest(`evidence-${evidenceId}`)}, 'evidence.jpg', 'PENDING', now())`;
        await expect(
          transaction.$executeRaw`UPDATE after_sale_evidence_files
            SET after_sale_id = ${afterSaleId}::uuid, status = 'READY', claimed_at = now(),
              retention_deadline_at = now() + interval '30 days', version = version + 1,
              updated_at = now()
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${evidenceId}::uuid`,
        ).resolves.toBe(0);

        await setContext(transaction, {
          actorId: fixture.adminId,
          actorType: 'admin',
          storeId: BEAUTY_STORE_ID,
        });
        await transaction.$executeRaw`UPDATE after_sale_evidence_files
          SET object_key = ${`test/beauty/staged/${evidenceId}`},
            status = 'READY_UNCLAIMED', scan_result_code = 'CLEAN',
            claim_deadline_at = now() + interval '1 hour', version = version + 1,
            updated_at = now()
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${evidenceId}::uuid`;
        await setContext(transaction, {
          actorId: fixture.memberId,
          actorType: 'member',
          storeId: BEAUTY_STORE_ID,
        });
        await expect(
          transaction.$executeRaw`UPDATE after_sale_evidence_files
            SET after_sale_id = ${afterSaleId}::uuid, status = 'READY',
              claimed_at = now() - interval '2 days',
              retention_deadline_at = now() - interval '1 day', version = version + 1,
              updated_at = now()
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${evidenceId}::uuid`,
        ).resolves.toBe(1);

        await setContext(transaction, {
          actorId: fixture.adminId,
          actorType: 'admin',
          storeId: BEAUTY_STORE_ID,
        });
        await transaction.$executeRaw`UPDATE after_sale_evidence_files
          SET status = 'DELETION_PENDING', version = version + 1, updated_at = now()
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${evidenceId}::uuid`;
        expect(
          await transaction.$queryRaw`SELECT event FROM after_sale_evidence_transitions
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid
              AND evidence_file_id = ${evidenceId}::uuid
            ORDER BY CASE event
              WHEN 'SCAN_PASSED' THEN 1 WHEN 'CLAIM' THEN 2 WHEN 'EXPIRE' THEN 3 END`,
        ).toEqual([{ event: 'SCAN_PASSED' }, { event: 'CLAIM' }, { event: 'EXPIRE' }]);
        await setContext(transaction, {
          actorId: fixture.memberId,
          actorType: 'member',
          storeId: BEAUTY_STORE_ID,
        });
        await expect(
          transaction.$executeRaw`UPDATE after_sale_evidence_files
            SET status = 'DELETED', object_key = NULL, derivative_object_keys = NULL,
              scan_temporary_object_key = NULL, next_delete_attempt_at = NULL,
              delete_error_code = NULL, deleted_at = now(), version = version + 1,
              updated_at = now()
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${evidenceId}::uuid`,
        ).resolves.toBe(0);
        expect(
          await transaction.$queryRaw`SELECT status, deleted_at FROM after_sale_evidence_files
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${evidenceId}::uuid`,
        ).toEqual([{ deleted_at: null, status: 'DELETION_PENDING' }]);

        await transaction.$executeRaw`INSERT INTO privacy_requests
          (id, store_id, member_id, public_number, type, description_ciphertext,
            idempotency_key_hash, request_hash, updated_at)
          VALUES (${privacyRequestId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${fixture.memberId}::uuid,
            ${`PRV-${privacyRequestId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
            'ACCESS', 'encrypted-test-description',
            ${digest(`privacy-key-${privacyRequestId}`)},
            ${digest(`privacy-request-${privacyRequestId}`)}, now())`;
        await expectDatabaseFailure(
          transaction,
          () => transaction.$executeRaw`INSERT INTO privacy_request_transitions
            (store_id, privacy_request_id, member_id, from_status, to_status, event,
              actor_type, actor_id, correlation_id)
            VALUES (${BEAUTY_STORE_ID}::uuid, ${privacyRequestId}::uuid,
              ${fixture.memberId}::uuid, 'SUBMITTED', 'UNDER_REVIEW', 'START_REVIEW',
              'MEMBER', ${fixture.memberId}::uuid, ${`m62-${randomUUID()}`})`,
          '42501',
        );
        await transaction.$executeRaw`INSERT INTO privacy_request_transitions
          (store_id, privacy_request_id, member_id, from_status, to_status, event,
            actor_type, actor_id, correlation_id)
          VALUES (${BEAUTY_STORE_ID}::uuid, ${privacyRequestId}::uuid,
            ${fixture.memberId}::uuid, 'SUBMITTED', 'CANCELLED', 'CANCEL',
            'MEMBER', ${fixture.memberId}::uuid, ${`m62-${randomUUID()}`})`;
        expect(
          await transaction.$queryRaw`SELECT status, version FROM privacy_requests
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid
              AND id = ${privacyRequestId}::uuid`,
        ).toEqual([{ status: 'CANCELLED', version: 2 }]);

        await transaction.$executeRaw`INSERT INTO after_sale_transitions
          (store_id, after_sale_id, from_status, to_status, event, actor_type,
            actor_id, correlation_id)
          VALUES (${BEAUTY_STORE_ID}::uuid, ${afterSaleId}::uuid,
            'PENDING_REVIEW', 'CANCELLED', 'CANCEL', 'MEMBER',
            ${fixture.memberId}::uuid,
            pg_catalog.current_setting('app.correlation_id', true))`;
        expect(
          await transaction.$queryRaw`SELECT status, version, completed_at IS NOT NULL AS completed
            FROM after_sales
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${afterSaleId}::uuid`,
        ).toEqual([{ completed: true, status: 'CANCELLED', version: 2 }]);
        expect(
          await transaction.$queryRaw`SELECT attempt_count FROM after_sale_operations
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${operationId}::uuid`,
        ).toEqual([{ attempt_count: 0 }]);
      });
    });
  });

  it('rejects member insertion of internal settlement, inventory, and exchange facts', async () => {
    await withCommittedCommerceFixture(async (fixture) => {
      await withRollback(async (transaction) => {
        await setContext(transaction, {
          actorId: fixture.adminId,
          actorType: 'admin',
          storeId: BEAUTY_STORE_ID,
        });
        const { afterSaleId, afterSaleItemId } = await createAfterSaleFixture(
          transaction,
          fixture,
          {
            approvedTotalVnd: 100_000,
            type: 'EXCHANGE',
            withItem: true,
          },
        );
        if (!afterSaleItemId) throw new Error('M6.2 internal-write fixture item is required');
        const balanceId = randomUUID();
        const restoreOperationId = randomUUID();
        const movementId = randomUUID();
        await transaction.$executeRaw`INSERT INTO inventory_balances
          (id, store_id, warehouse_id, sku_id, on_hand, reserved, updated_at)
          VALUES (${balanceId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${BEAUTY_WAREHOUSE_ID}::uuid, ${fixture.skuId}::uuid, 10, 0, now())`;
        const restoreSnapshot = JSON.stringify({
          items: [
            {
              quantity: 2,
              sku_id: fixture.skuId,
              warehouse_id: BEAUTY_WAREHOUSE_ID,
            },
          ],
          operation_id: restoreOperationId,
          source_id: afterSaleItemId,
          source_type: 'AFTER_SALE_RESTORE',
        });
        await transaction.$executeRaw`INSERT INTO inventory_operations
          (id, store_id, operation_key, request_hash, operation_type, result_snapshot,
            source_type, source_id)
          VALUES (${restoreOperationId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${`m62-restore-${restoreOperationId}`},
            ${createHash('sha256').update(`restore-${restoreOperationId}`).digest('hex')},
            'RESTORE', ${restoreSnapshot}::jsonb, 'AFTER_SALE_RESTORE',
            ${afterSaleItemId}::uuid)`;
        await transaction.$executeRaw`INSERT INTO inventory_movements
          (id, store_id, balance_id, operation_id, movement_type, on_hand_before,
            on_hand_after, on_hand_delta, reserved_before, reserved_after,
            reserved_delta, reason_code)
          VALUES (${movementId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${balanceId}::uuid,
            ${restoreOperationId}::uuid, 'RESTORE', 10, 12, 2, 0, 0, 0,
            'AFTER_SALE_RESTORE')`;

        const reservationId = randomUUID();
        const reservationItemId = randomUUID();
        const reserveOperationId = randomUUID();
        const reservationKey = `m62-exchange-${reservationId}`;
        const reserveSnapshot = JSON.stringify({
          items: [
            {
              quantity: 2,
              sku_id: fixture.replacementSkuId,
              warehouse_id: BEAUTY_WAREHOUSE_ID,
            },
          ],
          operation_id: reserveOperationId,
          reservation_id: reservationId,
          status: 'ACTIVE',
          terminal_at: null,
        });
        await transaction.$executeRaw`INSERT INTO inventory_operations
          (id, store_id, operation_key, request_hash, operation_type, result_snapshot)
          VALUES (${reserveOperationId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${reservationKey},
            ${createHash('sha256').update(`reserve-${reservationId}`).digest('hex')},
            'RESERVE', ${reserveSnapshot}::jsonb)`;
        await transaction.$executeRaw`INSERT INTO inventory_reservations
          (id, store_id, reservation_key, expires_at, source_type, source_id)
          VALUES (${reservationId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${reservationKey}, now() + interval '1 hour', 'AFTER_SALE_EXCHANGE',
            ${afterSaleId}::uuid)`;
        await transaction.$executeRaw`INSERT INTO inventory_reservation_items
          (id, store_id, reservation_id, warehouse_id, sku_id, quantity)
          VALUES (${reservationItemId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${reservationId}::uuid, ${BEAUTY_WAREHOUSE_ID}::uuid,
            ${fixture.replacementSkuId}::uuid, 2)`;

        await setContext(transaction, {
          actorId: fixture.memberId,
          actorType: 'member',
          storeId: BEAUTY_STORE_ID,
        });
        const settlementId = randomUUID();
        await expectDatabaseFailure(
          transaction,
          () => transaction.$executeRaw`INSERT INTO after_sale_order_allocations
            (store_id, after_sale_id, order_id, other_vnd)
            VALUES (${BEAUTY_STORE_ID}::uuid, ${afterSaleId}::uuid,
              ${fixture.orderId}::uuid, 1)`,
          '42501',
        );
        await expectDatabaseFailure(
          transaction,
          () => transaction.$executeRaw`INSERT INTO after_sale_settlements
            (id, store_id, after_sale_id, order_id, public_settlement_number, method,
              status, amount_vnd, idempotency_key_hash, request_hash, requested_by,
              updated_at)
            VALUES (${settlementId}::uuid, ${BEAUTY_STORE_ID}::uuid,
              ${afterSaleId}::uuid, ${fixture.orderId}::uuid,
              ${`AST-${settlementId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
              'COD_OFFLINE', 'PENDING', 100000,
              ${createHash('sha256').update(`settlement-key-${settlementId}`).digest('hex')},
              ${createHash('sha256').update(`settlement-request-${settlementId}`).digest('hex')},
              ${fixture.adminId}::uuid, now())`,
          '23514',
        );
        await expectDatabaseFailure(
          transaction,
          () => transaction.$executeRaw`INSERT INTO after_sale_inventory_actions
            (store_id, after_sale_id, after_sale_item_id, order_id, inspection_version,
              warehouse_id, sku_id, disposition, action_type, quantity,
              inventory_operation_id)
            VALUES (${BEAUTY_STORE_ID}::uuid, ${afterSaleId}::uuid,
              ${afterSaleItemId}::uuid, ${fixture.orderId}::uuid, 1,
              ${BEAUTY_WAREHOUSE_ID}::uuid, ${fixture.skuId}::uuid,
              'RESTOCK_SELLABLE', 'RESTOCK_SELLABLE', 2,
              ${restoreOperationId}::uuid)`,
          '42501',
        );
        await expectDatabaseFailure(
          transaction,
          () => transaction.$executeRaw`INSERT INTO exchange_fulfillments
            (store_id, after_sale_id, after_sale_item_id, order_id, product_id,
              replacement_sku_id, warehouse_id, reservation_id, status, reserved_at,
              updated_at)
            VALUES (${BEAUTY_STORE_ID}::uuid, ${afterSaleId}::uuid,
              ${afterSaleItemId}::uuid, ${fixture.orderId}::uuid,
              ${fixture.productId}::uuid, ${fixture.replacementSkuId}::uuid,
              ${BEAUTY_WAREHOUSE_ID}::uuid, ${reservationId}::uuid,
              'RESERVED', now(), now())`,
          '42501',
        );
      });
    });
  });

  it('requires actor-bound owner policies for every member-private M6 table', async () => {
    const policyCoverage = await owner.$queryRawUnsafe<
      Array<{ has_actor_owner_policy: boolean; table_name: string }>
    >(`
      SELECT
        expected.table_name,
        coalesce(bool_or(
          coalesce(policy.qual, '') || coalesce(policy.with_check, '') ILIKE '%current_actor_id%'
          AND coalesce(policy.qual, '') || coalesce(policy.with_check, '') ILIKE '%actor_type%'
          AND coalesce(policy.qual, '') || coalesce(policy.with_check, '') ILIKE '%member%'
        ), false) AS has_actor_owner_policy
      FROM (VALUES ${MEMBER_OWNER_TABLES.map((table) => `('${table}')`).join(',')})
        AS expected(table_name)
      LEFT JOIN pg_policies policy
        ON policy.schemaname = 'public' AND policy.tablename = expected.table_name
      GROUP BY expected.table_name
      ORDER BY expected.table_name
    `);
    expect(policyCoverage.map(({ table_name }) => table_name)).toEqual(
      [...MEMBER_OWNER_TABLES].sort(),
    );
    expect(policyCoverage.every(({ has_actor_owner_policy }) => has_actor_owner_policy)).toBe(true);
  });

  it('fails closed before definer item capacity reads an out-of-scope aggregate', async () => {
    await withCommittedCommerceFixture(async (fixture) => {
      await withRollback(async (transaction) => {
        await setContext(transaction, {
          actorId: fixture.adminId,
          actorType: 'admin',
          storeId: BEAUTY_STORE_ID,
        });
        await expectDatabaseFailure(
          transaction,
          () => transaction.$executeRaw`INSERT INTO after_sale_items
            (id, store_id, after_sale_id, order_id, order_item_id, requested_quantity,
              requested_item_vnd, sku_id, product_id, brand_id, category_id, sku_code,
              product_name, option_snapshot, unit_price_vnd, updated_at)
            VALUES (${randomUUID()}::uuid, ${FASHION_STORE_ID}::uuid,
              ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid,
              1, 1, ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid,
              ${FASHION_CATEGORY_ID}::uuid, 'cross-store-item', 'Cross-store item',
              '{}'::jsonb, 1, now())`,
          '42501',
        );

        await setContext(transaction, {
          actorId: fixture.memberId,
          actorType: 'member',
          storeId: BEAUTY_STORE_ID,
        });
        const missingAfterSaleId = randomUUID();
        await expectDatabaseFailure(
          transaction,
          () => transaction.$executeRaw`INSERT INTO after_sale_items
            (id, store_id, after_sale_id, order_id, order_item_id, requested_quantity,
              requested_item_vnd, sku_id, product_id, brand_id, category_id, sku_code,
              product_name, option_snapshot, unit_price_vnd, updated_at)
            VALUES (${randomUUID()}::uuid, ${BEAUTY_STORE_ID}::uuid,
              ${missingAfterSaleId}::uuid, ${fixture.orderId}::uuid,
              ${fixture.orderItemId}::uuid, 1, 50000, ${fixture.skuId}::uuid,
              ${fixture.productId}::uuid, ${fixture.brandId}::uuid,
              ${BEAUTY_CATEGORY_ID}::uuid,
              ${`m62-sku-${fixture.skuId.slice(0, 8)}`}, 'M6.2 product',
              '{"size":"small"}'::jsonb, 50000, now())`,
          '42501',
        );
      });
    });
  });

  it('fails closed before definer capacity guards read protected aggregates without an actor type', async () => {
    await withCommittedCommerceFixture(async (fixture) => {
      const protectedAfterSaleId = randomUUID();
      const digest = (value: string) => createHash('sha256').update(value).digest('hex');
      await owner.$transaction(async (transaction) => {
        await setContext(transaction, {
          actorId: fixture.adminId,
          actorType: 'admin',
          storeId: BEAUTY_STORE_ID,
        });
        await transaction.$executeRaw`INSERT INTO after_sales
          (id, store_id, order_id, member_id, public_case_number, type, status, source,
            reason_code, policy_snapshot, policy_hash, policy_id, policy_version_id,
            legacy_policy_review,
            requested_item_vnd, requested_total_vnd, idempotency_key_hash, request_hash,
            initiated_by, correlation_id, updated_at)
          VALUES (${protectedAfterSaleId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${fixture.orderId}::uuid, ${fixture.memberId}::uuid,
            ${`ASC-${protectedAfterSaleId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
            'REFUND_ONLY', 'PENDING_REVIEW', 'ADMIN', 'untyped-definer-scope',
            ${fixture.casePolicyPayload}::jsonb, ${fixture.casePolicyPayloadHash},
            ${fixture.casePolicyId}::uuid, ${fixture.casePolicyVersionId}::uuid, false,
            50000, 50000,
            ${digest(`case-key-${protectedAfterSaleId}`)},
            ${digest(`case-request-${protectedAfterSaleId}`)}, ${fixture.adminId}::uuid,
            ${`m62-${protectedAfterSaleId}`}, now())`;
      });

      const untypedRuntime = createRuntimePrismaClient(runtimeUrl);
      try {
        await untypedRuntime.$transaction(async (transaction) => {
          await setContextWithoutActorType(transaction, {
            actorId: fixture.memberId,
            storeId: BEAUTY_STORE_ID,
          });
          await expectDatabaseFailure(
            transaction,
            () => transaction.$executeRaw`INSERT INTO after_sale_items
              (id, store_id, after_sale_id, order_id, order_item_id, requested_quantity,
                requested_item_vnd, sku_id, product_id, brand_id, category_id, sku_code,
                product_name, option_snapshot, unit_price_vnd, updated_at)
              VALUES (${randomUUID()}::uuid, ${BEAUTY_STORE_ID}::uuid,
                ${protectedAfterSaleId}::uuid, ${fixture.orderId}::uuid,
                ${randomUUID()}::uuid, 1, 50000, ${fixture.skuId}::uuid,
                ${fixture.productId}::uuid, ${fixture.brandId}::uuid,
                ${BEAUTY_CATEGORY_ID}::uuid,
                ${`m62-sku-${fixture.skuId.slice(0, 8)}`}, 'M6.2 product',
                '{"size":"small"}'::jsonb, 50000, now())`,
            '42501',
          );

          await transaction.$executeRaw`
            SELECT set_config('app.actor_id', ${fixture.adminId}, true)
          `;
          await expectDatabaseFailure(
            transaction,
            () => transaction.$executeRaw`INSERT INTO after_sale_order_allocations
              (store_id, after_sale_id, order_id, other_vnd)
              VALUES (${BEAUTY_STORE_ID}::uuid, ${randomUUID()}::uuid,
                ${fixture.orderId}::uuid, 1)`,
            '42501',
          );
          await expectDatabaseFailure(
            transaction,
            () => transaction.$executeRaw`INSERT INTO after_sale_transitions
              (store_id, after_sale_id, from_status, to_status, event, actor_type,
                actor_id, correlation_id)
              VALUES (${BEAUTY_STORE_ID}::uuid, ${randomUUID()}::uuid,
                'PENDING_REVIEW', 'APPROVED', 'APPROVE', 'ADMIN',
                ${fixture.adminId}::uuid,
                pg_catalog.current_setting('app.correlation_id', true))`,
            '42501',
          );
        });
      } finally {
        await untypedRuntime.$disconnect();
      }
    });
  });

  it('freezes member-created after-sale, item, operation, and evidence facts at safe initial shapes', async () => {
    await withCommittedCommerceFixture(async (fixture) => {
      await withRollback(async (transaction) => {
        await setContext(transaction, {
          actorId: fixture.memberId,
          actorType: 'member',
          storeId: BEAUTY_STORE_ID,
        });
        const digest = (value: string) => createHash('sha256').update(value).digest('hex');
        const maliciousCaseId = randomUUID();
        await expectDatabaseFailure(
          transaction,
          () => transaction.$executeRaw`INSERT INTO after_sales
            (id, store_id, order_id, member_id, public_case_number, type, status, source,
              reason_code, legacy_policy_review, requested_item_vnd, requested_total_vnd,
              approved_item_vnd, approved_total_vnd, idempotency_key_hash, request_hash,
              initiated_by, completed_at, correlation_id, version, updated_at)
            VALUES (${maliciousCaseId}::uuid, ${BEAUTY_STORE_ID}::uuid,
              ${fixture.orderId}::uuid, ${fixture.memberId}::uuid,
              ${`ASC-${maliciousCaseId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
              'MERCHANT_REFUND', 'REFUNDED', 'MEMBER', 'forged-terminal', true,
              100000, 100000, 100000, 100000,
              ${digest(`case-key-${maliciousCaseId}`)},
              ${digest(`case-request-${maliciousCaseId}`)}, ${fixture.memberId}::uuid,
              now(), ${`m62-${maliciousCaseId}`}, 99, now())`,
          '23514',
        );

        const afterSaleId = randomUUID();
        await transaction.$executeRaw`INSERT INTO after_sales
          (id, store_id, order_id, member_id, public_case_number, type, status, source,
            reason_code, policy_snapshot, policy_hash, policy_id, policy_version_id,
            legacy_policy_review,
            requested_item_vnd, requested_total_vnd, idempotency_key_hash, request_hash,
            initiated_by, correlation_id, updated_at)
          VALUES (${afterSaleId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${fixture.orderId}::uuid, ${fixture.memberId}::uuid,
            ${`ASC-${afterSaleId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
            'REFUND_ONLY', 'PENDING_REVIEW', 'MEMBER', 'member-request',
            ${fixture.casePolicyPayload}::jsonb, ${fixture.casePolicyPayloadHash},
            ${fixture.casePolicyId}::uuid, ${fixture.casePolicyVersionId}::uuid, false,
            100000, 100000,
            ${digest(`case-key-${afterSaleId}`)}, ${digest(`case-request-${afterSaleId}`)},
            ${fixture.memberId}::uuid, ${`m62-${afterSaleId}`}, now())`;

        const itemId = randomUUID();
        await expectDatabaseFailure(
          transaction,
          () => transaction.$executeRaw`INSERT INTO after_sale_items
            (id, store_id, after_sale_id, order_id, order_item_id, requested_quantity,
              approved_quantity, received_quantity, accepted_quantity,
              restockable_quantity, restored_quantity, requested_item_vnd,
              approved_item_vnd, sku_id, product_id, brand_id, category_id, sku_code,
              product_name, option_snapshot, unit_price_vnd, disposition,
              inspection_version, updated_at)
            VALUES (${itemId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${afterSaleId}::uuid,
              ${fixture.orderId}::uuid, ${fixture.orderItemId}::uuid, 1, 1, 1, 1, 1, 1,
              50000, 50000, ${fixture.skuId}::uuid, ${fixture.productId}::uuid,
              ${fixture.brandId}::uuid, ${BEAUTY_CATEGORY_ID}::uuid,
              ${`m62-sku-${fixture.skuId.slice(0, 8)}`}, 'M6.2 product',
              '{"size":"small"}'::jsonb, 50000, 'RESTOCK_SELLABLE', 1, now())`,
          '23514',
        );

        const operationId = randomUUID();
        await expectDatabaseFailure(
          transaction,
          () => transaction.$executeRaw`INSERT INTO after_sale_operations
            (id, store_id, after_sale_id, operation, idempotency_key_hash, request_hash,
              status, result_summary, attempt_count, updated_at)
            VALUES (${operationId}::uuid, ${BEAUTY_STORE_ID}::uuid,
              ${afterSaleId}::uuid, 'MEMBER_SUBMIT',
              ${digest(`operation-key-${operationId}`)},
              ${digest(`operation-request-${operationId}`)}, 'COMPLETED',
              '{"forged":true}'::jsonb, 1, now())`,
          '23514',
        );

        const evidenceId = randomUUID();
        await expectDatabaseFailure(
          transaction,
          () => transaction.$executeRaw`INSERT INTO after_sale_evidence_files
            (id, store_id, member_id, upload_session_id, object_key,
              derivative_object_keys, scan_temporary_object_key, mime_type, byte_size,
              checksum_sha256, status, updated_at)
            VALUES (${evidenceId}::uuid, ${BEAUTY_STORE_ID}::uuid,
              ${fixture.memberId}::uuid, ${randomUUID()}::uuid,
              ${`test/beauty/forged/${evidenceId}`}, '["forged"]'::jsonb, 'forged-scan',
              'image/jpeg', 1024, ${digest(`evidence-${evidenceId}`)}, 'PENDING', now())`,
          '23514',
        );
        await setContext(transaction, {
          actorId: fixture.adminId,
          actorType: 'admin',
          storeId: BEAUTY_STORE_ID,
        });
        const forgedAdminEvidenceId = randomUUID();
        await expectDatabaseFailure(
          transaction,
          () => transaction.$executeRaw`INSERT INTO after_sale_evidence_files
            (id, store_id, member_id, upload_session_id, object_key, mime_type,
              byte_size, checksum_sha256, status, scan_result_code, updated_at)
            VALUES (${forgedAdminEvidenceId}::uuid, ${BEAUTY_STORE_ID}::uuid,
              ${fixture.memberId}::uuid, ${randomUUID()}::uuid,
              ${`test/beauty/forged-admin/${forgedAdminEvidenceId}`}, 'image/jpeg', 1024,
              ${digest(`evidence-${forgedAdminEvidenceId}`)}, 'READY', 'CLEAN', now())`,
          '23514',
        );
        const nullScanEvidenceId = randomUUID();
        await transaction.$executeRaw`INSERT INTO after_sale_evidence_files
          (id, store_id, member_id, upload_session_id, mime_type, byte_size,
            checksum_sha256, updated_at)
          VALUES (${nullScanEvidenceId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${fixture.memberId}::uuid, ${randomUUID()}::uuid, 'image/jpeg', 1024,
            ${digest(`evidence-${nullScanEvidenceId}`)}, now())`;
        await expectDatabaseFailure(
          transaction,
          () => transaction.$executeRaw`UPDATE after_sale_evidence_files
            SET object_key = ${`test/beauty/null-scan/${nullScanEvidenceId}`},
              status = 'READY_UNCLAIMED', scan_result_code = NULL,
              claim_deadline_at = now() + interval '1 hour', version = version + 1,
              updated_at = now()
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid
              AND id = ${nullScanEvidenceId}::uuid`,
          '23514',
        );
      });
    });
  });

  it('projects after-sale status only from a valid append-only transition', async () => {
    await withCommittedCommerceFixture(async (fixture) => {
      await withRollback(async (transaction) => {
        await setContext(transaction, {
          actorId: fixture.adminId,
          actorType: 'admin',
          storeId: BEAUTY_STORE_ID,
        });
        const afterSaleId = randomUUID();
        const afterSaleItemId = randomUUID();
        const digest = (value: string) => createHash('sha256').update(value).digest('hex');
        await transaction.$executeRaw`INSERT INTO after_sales
          (id, store_id, order_id, member_id, public_case_number, type, status, source,
            reason_code, policy_snapshot, policy_hash, policy_id, policy_version_id,
            legacy_policy_review,
            requested_item_vnd, requested_other_vnd, requested_total_vnd,
            idempotency_key_hash, request_hash, initiated_by, correlation_id, updated_at)
          VALUES (${afterSaleId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${fixture.orderId}::uuid, ${fixture.memberId}::uuid,
            ${`ASC-${afterSaleId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
            'REFUND_ONLY', 'PENDING_REVIEW', 'ADMIN', 'admin-review',
            ${fixture.casePolicyPayload}::jsonb, ${fixture.casePolicyPayloadHash},
            ${fixture.casePolicyId}::uuid, ${fixture.casePolicyVersionId}::uuid, false,
            50000, 10000, 60000,
            ${digest(`case-key-${afterSaleId}`)},
            ${digest(`case-request-${afterSaleId}`)}, ${fixture.adminId}::uuid,
            ${`m62-${afterSaleId}`}, now())`;
        await transaction.$executeRaw`INSERT INTO after_sale_items
          (id, store_id, after_sale_id, order_id, order_item_id, requested_quantity,
            requested_item_vnd, sku_id, product_id, brand_id, category_id, sku_code,
            product_name, option_snapshot, unit_price_vnd, updated_at)
          VALUES (${afterSaleItemId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${afterSaleId}::uuid, ${fixture.orderId}::uuid, ${fixture.orderItemId}::uuid,
            1, 50000, ${fixture.skuId}::uuid, ${fixture.productId}::uuid,
            ${fixture.brandId}::uuid, ${BEAUTY_CATEGORY_ID}::uuid,
            ${`m62-sku-${fixture.skuId.slice(0, 8)}`}, 'M6.2 product',
            '{"size":"small"}'::jsonb, 50000, now())`;

        await expectDatabaseFailure(
          transaction,
          () => transaction.$executeRaw`UPDATE after_sales
            SET status = 'REFUNDED', version = version + 1, completed_at = now(),
              updated_at = now()
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${afterSaleId}::uuid`,
          '42501',
        );
        await expectDatabaseFailure(
          transaction,
          () => transaction.$executeRaw`INSERT INTO after_sale_transitions
            (store_id, after_sale_id, from_status, to_status, event, actor_type,
              actor_id, correlation_id)
            VALUES (${BEAUTY_STORE_ID}::uuid, ${afterSaleId}::uuid,
              'PENDING_REVIEW', 'REFUNDED', 'REFUND_SUCCEEDED', 'ADMIN',
              ${fixture.adminId}::uuid,
              pg_catalog.current_setting('app.correlation_id', true))`,
          '23514',
        );
        await transaction.$executeRaw`UPDATE after_sales
          SET approved_other_vnd = 10000, approved_total_vnd = 10000, updated_at = now()
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${afterSaleId}::uuid`;
        await transaction.$executeRaw`INSERT INTO after_sale_order_allocations
          (store_id, after_sale_id, order_id, other_vnd)
          VALUES (${BEAUTY_STORE_ID}::uuid, ${afterSaleId}::uuid,
            ${fixture.orderId}::uuid, 10000)`;
        await expectDatabaseFailure(
          transaction,
          () =>
            appendAfterSaleTransition(transaction, {
              actorId: fixture.adminId,
              afterSaleId,
              event: 'APPROVE',
              fromStatus: 'PENDING_REVIEW',
              toStatus: 'APPROVED',
            }),
          '23514',
        );
        await transaction.$executeRaw`UPDATE after_sale_items
          SET approved_quantity = 1, approved_item_vnd = 50000, updated_at = now()
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${afterSaleItemId}::uuid`;
        await transaction.$executeRaw`UPDATE after_sales
          SET approved_item_vnd = 50000, approved_total_vnd = 60000, updated_at = now()
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${afterSaleId}::uuid`;
        await transaction.$executeRaw`INSERT INTO after_sale_transitions
          (store_id, after_sale_id, from_status, to_status, event, actor_type,
            actor_id, correlation_id)
          VALUES (${BEAUTY_STORE_ID}::uuid, ${afterSaleId}::uuid,
            'PENDING_REVIEW', 'APPROVED', 'APPROVE', 'ADMIN',
            ${fixture.adminId}::uuid,
            pg_catalog.current_setting('app.correlation_id', true))`;
        expect(
          await transaction.$queryRaw`SELECT status, version FROM after_sales
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${afterSaleId}::uuid`,
        ).toEqual([{ status: 'APPROVED', version: 2 }]);
      });
    });
  });

  it('rejects approval amounts without approved units and same-SKU exchanges', async () => {
    await withCommittedCommerceFixture(async (fixture) => {
      await withRollback(async (transaction) => {
        await setContext(transaction, {
          actorId: fixture.adminId,
          actorType: 'admin',
          storeId: BEAUTY_STORE_ID,
        });
        const digest = (value: string) => createHash('sha256').update(value).digest('hex');

        async function createPendingCaseWithItem(input: {
          replacementSkuId?: string;
          type: 'EXCHANGE' | 'REFUND_ONLY';
        }): Promise<{ afterSaleId: string; afterSaleItemId: string }> {
          const afterSaleId = randomUUID();
          const afterSaleItemId = randomUUID();
          await transaction.$executeRaw`INSERT INTO after_sales
            (id, store_id, order_id, member_id, public_case_number, type, status, source,
              reason_code, policy_snapshot, policy_hash, policy_id, policy_version_id,
              legacy_policy_review,
              requested_item_vnd, requested_total_vnd, idempotency_key_hash,
              request_hash, initiated_by, correlation_id, updated_at)
            VALUES (${afterSaleId}::uuid, ${BEAUTY_STORE_ID}::uuid,
              ${fixture.orderId}::uuid, ${fixture.memberId}::uuid,
              ${`ASC-${afterSaleId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
              ${input.type}::after_sale_type, 'PENDING_REVIEW', 'ADMIN',
              'approval-shape-regression', ${fixture.casePolicyPayload}::jsonb,
              ${fixture.casePolicyPayloadHash}, ${fixture.casePolicyId}::uuid,
              ${fixture.casePolicyVersionId}::uuid, false, 50000, 50000,
              ${digest(`case-key-${afterSaleId}`)},
              ${digest(`case-request-${afterSaleId}`)}, ${fixture.adminId}::uuid,
              ${`m62-${afterSaleId}`}, now())`;
          await transaction.$executeRaw`INSERT INTO after_sale_items
            (id, store_id, after_sale_id, order_id, order_item_id, requested_quantity,
              requested_item_vnd, sku_id, product_id, brand_id, category_id, sku_code,
              product_name, option_snapshot, unit_price_vnd, replacement_sku_id, updated_at)
            VALUES (${afterSaleItemId}::uuid, ${BEAUTY_STORE_ID}::uuid,
              ${afterSaleId}::uuid, ${fixture.orderId}::uuid, ${fixture.orderItemId}::uuid,
              1, 50000, ${fixture.skuId}::uuid, ${fixture.productId}::uuid,
              ${fixture.brandId}::uuid, ${BEAUTY_CATEGORY_ID}::uuid,
              ${`m62-sku-${fixture.skuId.slice(0, 8)}`}, 'M6.2 product',
              '{"size":"small"}'::jsonb, 50000,
              ${input.replacementSkuId ?? null}::uuid, now())`;
          return { afterSaleId, afterSaleItemId };
        }

        const { afterSaleId: zeroQuantityCaseId, afterSaleItemId: zeroQuantityItemId } =
          await createPendingCaseWithItem({ type: 'REFUND_ONLY' });
        await expectDatabaseFailure(
          transaction,
          () => transaction.$executeRaw`UPDATE after_sale_items
            SET approved_quantity = 0, approved_item_vnd = 50000, updated_at = now()
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${zeroQuantityItemId}::uuid`,
          '23514',
        );
        await appendAfterSaleTransition(transaction, {
          actorId: fixture.adminId,
          afterSaleId: zeroQuantityCaseId,
          event: 'REJECT',
          fromStatus: 'PENDING_REVIEW',
          toStatus: 'REJECTED',
        });

        const { afterSaleId: sameSkuCaseId, afterSaleItemId: sameSkuItemId } =
          await createPendingCaseWithItem({
            replacementSkuId: fixture.skuId,
            type: 'EXCHANGE',
          });
        await expectDatabaseFailure(
          transaction,
          () => transaction.$executeRaw`UPDATE after_sale_items
            SET approved_quantity = 1, approved_item_vnd = 50000,
              replacement_quantity = 1, updated_at = now()
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${sameSkuItemId}::uuid`,
          '23514',
        );
        await appendAfterSaleTransition(transaction, {
          actorId: fixture.adminId,
          afterSaleId: sameSkuCaseId,
          event: 'REJECT',
          fromStatus: 'PENDING_REVIEW',
          toStatus: 'REJECTED',
        });

        const zeroApprovedExchange = await createPendingCaseWithItem({
          replacementSkuId: fixture.replacementSkuId,
          type: 'EXCHANGE',
        });
        await transaction.$executeRaw`UPDATE after_sales
          SET return_deadline_at = now() + interval '7 days', updated_at = now()
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid
            AND id = ${zeroApprovedExchange.afterSaleId}::uuid`;
        await expectDatabaseFailure(
          transaction,
          () =>
            appendAfterSaleTransition(transaction, {
              actorId: fixture.adminId,
              afterSaleId: zeroApprovedExchange.afterSaleId,
              event: 'APPROVE',
              fromStatus: 'PENDING_REVIEW',
              toStatus: 'APPROVED',
            }),
          '23514',
        );
      });
    });
  });

  it('requires an explicit one-time decision for an initial legacy review', async () => {
    await withOwnerRollback(async (transaction) => {
      const fixture = await createCommerceFixture(transaction);
      const afterSaleId = randomUUID();
      const afterSaleItemId = randomUUID();
      const secondOrderItemId = randomUUID();
      const digest = (value: string) => createHash('sha256').update(value).digest('hex');
      await transaction.$executeRaw`UPDATE orders
        SET base_subtotal_vnd = 150000, payable_vnd = 150000, updated_at = now()
        WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${fixture.orderId}::uuid`;
      await transaction.$executeRaw`INSERT INTO order_items
        (id, store_id, order_id, sku_id, product_id, brand_id, category_id, sku_code,
          product_name, brand_name, option_snapshot, unit_price_vnd, quantity,
          subtotal_vnd, payable_vnd)
        VALUES (${secondOrderItemId}::uuid, ${BEAUTY_STORE_ID}::uuid,
          ${fixture.orderId}::uuid, ${fixture.alternateSkuId}::uuid,
          ${fixture.productId}::uuid, ${fixture.brandId}::uuid,
          ${BEAUTY_CATEGORY_ID}::uuid,
          ${`m62-sku-${fixture.alternateSkuId.slice(0, 8)}`},
          'M6.3 B0 second product', 'M6.2 brand', '{"size":"second"}'::jsonb,
          50000, 1, 50000, 50000)`;
      await setContext(transaction, {
        actorId: fixture.adminId,
        actorType: 'admin',
        storeId: BEAUTY_STORE_ID,
      });
      const legacySavepoint = `m63_b0_legacy_mix_${randomUUID().replaceAll('-', '')}`;
      await transaction.$executeRawUnsafe(`SAVEPOINT ${legacySavepoint}`);
      try {
        const legacyAfterSaleId = randomUUID();
        await transaction.$executeRaw`INSERT INTO after_sales
          (id, store_id, order_id, member_id, public_case_number, type, status, source,
            reason_code, legacy_policy_review, requested_item_vnd, requested_total_vnd,
            idempotency_key_hash, request_hash, initiated_by, correlation_id, updated_at)
          VALUES (${legacyAfterSaleId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${fixture.orderId}::uuid, ${fixture.memberId}::uuid,
            ${`ASC-${legacyAfterSaleId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
            'REFUND_ONLY', 'REVIEW_REQUIRED', 'ADMIN', 'm63-b0-legacy-mixed-lines',
            true, 150000, 150000, ${digest(`case-key-${legacyAfterSaleId}`)},
            ${digest(`case-request-${legacyAfterSaleId}`)}, ${fixture.adminId}::uuid,
            ${`m63-b0-${legacyAfterSaleId}`}, now())`;
        await transaction.$executeRaw`INSERT INTO after_sale_items
          (id, store_id, after_sale_id, order_id, order_item_id, requested_quantity,
            requested_item_vnd, sku_id, product_id, brand_id, category_id, sku_code,
            product_name, option_snapshot, unit_price_vnd, updated_at)
          VALUES (${randomUUID()}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${legacyAfterSaleId}::uuid, ${fixture.orderId}::uuid,
            ${fixture.orderItemId}::uuid, 2, 100000, ${fixture.skuId}::uuid,
            ${fixture.productId}::uuid, ${fixture.brandId}::uuid,
            ${BEAUTY_CATEGORY_ID}::uuid, ${`m62-sku-${fixture.skuId.slice(0, 8)}`},
            'M6.2 product', '{"size":"small"}'::jsonb, 50000, now())`;
        await expectDatabaseFailure(
          transaction,
          () => transaction.$executeRaw`INSERT INTO after_sale_items
            (id, store_id, after_sale_id, order_id, order_item_id, requested_quantity,
              requested_item_vnd, sku_id, product_id, brand_id, category_id, sku_code,
              product_name, option_snapshot, unit_price_vnd, updated_at)
            VALUES (${randomUUID()}::uuid, ${BEAUTY_STORE_ID}::uuid,
              ${legacyAfterSaleId}::uuid, ${fixture.orderId}::uuid,
              ${secondOrderItemId}::uuid, 1, 50000, ${fixture.alternateSkuId}::uuid,
              ${fixture.productId}::uuid, ${fixture.brandId}::uuid,
              ${BEAUTY_CATEGORY_ID}::uuid,
              ${`m62-sku-${fixture.alternateSkuId.slice(0, 8)}`},
              'M6.3 B0 second product', '{"size":"second"}'::jsonb, 50000, now())`,
          '23514',
        );
      } finally {
        await transaction.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${legacySavepoint}`);
        await transaction.$executeRawUnsafe(`RELEASE SAVEPOINT ${legacySavepoint}`);
      }
      await transaction.$executeRaw`INSERT INTO after_sales
        (id, store_id, order_id, member_id, public_case_number, type, status, source,
          reason_code, legacy_policy_review, requested_item_vnd, requested_other_vnd,
          requested_total_vnd, idempotency_key_hash, request_hash, initiated_by,
          correlation_id, updated_at)
        VALUES (${afterSaleId}::uuid, ${BEAUTY_STORE_ID}::uuid,
          ${fixture.orderId}::uuid, ${fixture.memberId}::uuid,
          ${`ASC-${afterSaleId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
          'REFUND_ONLY', 'REVIEW_REQUIRED', 'ADMIN', 'legacy-review', true,
          50000, 10000, 60000, ${digest(`case-key-${afterSaleId}`)},
          ${digest(`case-request-${afterSaleId}`)}, ${fixture.adminId}::uuid,
          ${`m62-${afterSaleId}`}, now())`;
      await transaction.$executeRaw`INSERT INTO after_sale_items
        (id, store_id, after_sale_id, order_id, order_item_id, requested_quantity,
          requested_item_vnd, sku_id, product_id, brand_id, category_id, sku_code,
          product_name, option_snapshot, unit_price_vnd, updated_at)
        VALUES (${afterSaleItemId}::uuid, ${BEAUTY_STORE_ID}::uuid,
          ${afterSaleId}::uuid, ${fixture.orderId}::uuid, ${fixture.orderItemId}::uuid,
          1, 50000, ${fixture.skuId}::uuid, ${fixture.productId}::uuid,
          ${fixture.brandId}::uuid, ${BEAUTY_CATEGORY_ID}::uuid,
          ${`m62-sku-${fixture.skuId.slice(0, 8)}`}, 'M6.2 product',
          '{"size":"small"}'::jsonb, 50000, now())`;
      await transaction.$executeRaw`UPDATE after_sale_items
        SET approved_quantity = 1, approved_item_vnd = 50000, updated_at = now()
        WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${afterSaleItemId}::uuid`;
      await transaction.$executeRaw`UPDATE after_sales
        SET approved_item_vnd = 50000, approved_other_vnd = 10000,
          approved_total_vnd = 60000, updated_at = now()
        WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${afterSaleId}::uuid`;
      await transaction.$executeRaw`INSERT INTO after_sale_order_allocations
        (store_id, after_sale_id, order_id, other_vnd)
        VALUES (${BEAUTY_STORE_ID}::uuid, ${afterSaleId}::uuid,
          ${fixture.orderId}::uuid, 10000)`;

      await expectDatabaseFailure(
        transaction,
        () =>
          appendAfterSaleTransition(transaction, {
            actorId: fixture.adminId,
            afterSaleId,
            event: 'APPROVE',
            fromStatus: 'REVIEW_REQUIRED',
            toStatus: 'APPROVED',
          }),
        '23514',
      );
      await expectDatabaseFailure(
        transaction,
        () =>
          appendAfterSaleTransition(transaction, {
            actorId: fixture.adminId,
            afterSaleId,
            event: 'LEGACY_APPROVE',
            fromStatus: 'REVIEW_REQUIRED',
            toStatus: 'APPROVED',
          }),
        '23514',
      );

      const spoofedDecisionId = randomUUID();
      await expectDatabaseFailure(
        transaction,
        () => transaction.$executeRaw`INSERT INTO after_sale_legacy_decisions
          (id, store_id, after_sale_id, decision, admin_id, reason,
            policy_basis_ciphertext, payload, payload_hash)
          VALUES (${spoofedDecisionId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${afterSaleId}::uuid, 'APPROVE', ${fixture.confirmingAdminId}::uuid,
            'Spoofed legacy reviewer', 'encrypted-test-policy-basis',
            '{"basis":"spoofed-reviewer"}'::jsonb,
            ${digest(`legacy-decision-${spoofedDecisionId}`)})`,
        '42501',
      );

      const decisionId = randomUUID();
      await transaction.$executeRaw`INSERT INTO after_sale_legacy_decisions
        (id, store_id, after_sale_id, decision, admin_id, reason,
          policy_basis_ciphertext, payload, payload_hash)
        VALUES (${decisionId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${afterSaleId}::uuid,
          'APPROVE', ${fixture.adminId}::uuid, 'Legacy case reviewed manually',
          'encrypted-test-policy-basis', '{"basis":"legacy-manual-review"}'::jsonb,
          ${digest(`legacy-decision-${decisionId}`)})`;
      await appendAfterSaleTransition(transaction, {
        actorId: fixture.adminId,
        afterSaleId,
        event: 'LEGACY_APPROVE',
        fromStatus: 'REVIEW_REQUIRED',
        toStatus: 'APPROVED',
      });
      expect(
        await transaction.$queryRaw`SELECT status, version, reviewed_by,
            reviewed_at IS NOT NULL AS reviewed
          FROM after_sales
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${afterSaleId}::uuid`,
      ).toEqual([{ reviewed: true, reviewed_by: fixture.adminId, status: 'APPROVED', version: 2 }]);

      const zeroApprovedLegacyId = randomUUID();
      const zeroApprovedLegacyItemId = randomUUID();
      const zeroApprovedLegacyDecisionId = randomUUID();
      await transaction.$executeRaw`INSERT INTO after_sales
        (id, store_id, order_id, member_id, public_case_number, type, status, source,
          reason_code, legacy_policy_review, requested_item_vnd, requested_other_vnd,
          requested_total_vnd, idempotency_key_hash, request_hash, initiated_by,
          correlation_id, updated_at)
        VALUES (${zeroApprovedLegacyId}::uuid, ${BEAUTY_STORE_ID}::uuid,
          ${fixture.orderId}::uuid, ${fixture.memberId}::uuid,
          ${`ASC-${zeroApprovedLegacyId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
          'REFUND_ONLY', 'REVIEW_REQUIRED', 'ADMIN', 'legacy-zero-approved-units', true,
          50000, 10000, 60000, ${digest(`case-key-${zeroApprovedLegacyId}`)},
          ${digest(`case-request-${zeroApprovedLegacyId}`)}, ${fixture.adminId}::uuid,
          ${`m63-b0-${zeroApprovedLegacyId}`}, now())`;
      await transaction.$executeRaw`INSERT INTO after_sale_items
        (id, store_id, after_sale_id, order_id, order_item_id, requested_quantity,
          requested_item_vnd, sku_id, product_id, brand_id, category_id, sku_code,
          product_name, option_snapshot, unit_price_vnd, updated_at)
        VALUES (${zeroApprovedLegacyItemId}::uuid, ${BEAUTY_STORE_ID}::uuid,
          ${zeroApprovedLegacyId}::uuid, ${fixture.orderId}::uuid,
          ${secondOrderItemId}::uuid, 1, 50000, ${fixture.alternateSkuId}::uuid,
          ${fixture.productId}::uuid, ${fixture.brandId}::uuid,
          ${BEAUTY_CATEGORY_ID}::uuid,
          ${`m62-sku-${fixture.alternateSkuId.slice(0, 8)}`},
          'M6.3 B0 second product', '{"size":"second"}'::jsonb, 50000, now())`;
      await transaction.$executeRaw`UPDATE after_sales
        SET approved_other_vnd = 10000, approved_total_vnd = 10000, updated_at = now()
        WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${zeroApprovedLegacyId}::uuid`;
      await transaction.$executeRaw`INSERT INTO after_sale_legacy_decisions
        (id, store_id, after_sale_id, decision, admin_id, reason,
          policy_basis_ciphertext, payload, payload_hash)
        VALUES (${zeroApprovedLegacyDecisionId}::uuid, ${BEAUTY_STORE_ID}::uuid,
          ${zeroApprovedLegacyId}::uuid, 'APPROVE', ${fixture.adminId}::uuid,
          'Legacy item approval requires a positive unit', 'encrypted-test-policy-basis',
          '{"basis":"zero-approved-units"}'::jsonb,
          ${digest(`legacy-decision-${zeroApprovedLegacyDecisionId}`)})`;
      await expectDatabaseFailure(
        transaction,
        () =>
          appendAfterSaleTransition(transaction, {
            actorId: fixture.adminId,
            afterSaleId: zeroApprovedLegacyId,
            event: 'LEGACY_APPROVE',
            fromStatus: 'REVIEW_REQUIRED',
            toStatus: 'APPROVED',
          }),
        '23514',
      );

      const nonInitialCaseId = randomUUID();
      await transaction.$executeRaw`INSERT INTO after_sales
        (id, store_id, order_id, member_id, public_case_number, type, status, source,
          reason_code, legacy_policy_review, requested_other_vnd, requested_total_vnd,
          idempotency_key_hash, request_hash, initiated_by, correlation_id, updated_at)
        VALUES (${nonInitialCaseId}::uuid, ${BEAUTY_STORE_ID}::uuid,
          ${fixture.orderId}::uuid, ${fixture.memberId}::uuid,
          ${`ASC-${nonInitialCaseId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
          'REFUND_ONLY', 'REVIEW_REQUIRED', 'ADMIN', 'non-initial-legacy-review', true,
          60000, 60000, ${digest(`case-key-${nonInitialCaseId}`)},
          ${digest(`case-request-${nonInitialCaseId}`)}, ${fixture.adminId}::uuid,
          ${`m62-${nonInitialCaseId}`}, now())`;
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`UPDATE after_sales
        SET status = 'APPROVED', version = 2, reviewed_by = ${fixture.adminId}::uuid,
          reviewed_at = now(), updated_at = now()
        WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${nonInitialCaseId}::uuid`;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
      const nonInitialDecisionId = randomUUID();
      await expectDatabaseFailure(
        transaction,
        () => transaction.$executeRaw`INSERT INTO after_sale_legacy_decisions
          (id, store_id, after_sale_id, decision, admin_id, reason,
            policy_basis_ciphertext, payload, payload_hash)
          VALUES (${nonInitialDecisionId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${nonInitialCaseId}::uuid, 'APPROVE', ${fixture.adminId}::uuid,
            'Late legacy decision', 'encrypted-test-policy-basis',
            '{"basis":"late-review"}'::jsonb,
            ${digest(`legacy-decision-${nonInitialDecisionId}`)})`,
        '23514',
      );

      const sideEffectCaseId = randomUUID();
      await transaction.$executeRaw`INSERT INTO after_sales
        (id, store_id, order_id, member_id, public_case_number, type, status, source,
          reason_code, legacy_policy_review, requested_item_vnd, requested_total_vnd,
          idempotency_key_hash, request_hash, initiated_by, correlation_id, updated_at)
        VALUES (${sideEffectCaseId}::uuid, ${BEAUTY_STORE_ID}::uuid,
          ${fixture.orderId}::uuid, ${fixture.memberId}::uuid,
          ${`ASC-${sideEffectCaseId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
          'RETURN_REFUND', 'REVIEW_REQUIRED', 'ADMIN', 'legacy-side-effect-review', true,
          60000, 60000, ${digest(`case-key-${sideEffectCaseId}`)},
          ${digest(`case-request-${sideEffectCaseId}`)}, ${fixture.adminId}::uuid,
          ${`m62-${sideEffectCaseId}`}, now())`;
      const shippingChannelId = randomUUID();
      await transaction.$executeRaw`INSERT INTO store_shipping_channels
        (id, store_id, provider_environment, provider_code, shop_id, token_secret_ref,
          secret_fingerprint, key_version, status, origin_allowlist_key, updated_at)
        VALUES (${shippingChannelId}::uuid, ${BEAUTY_STORE_ID}::uuid, 'SANDBOX', 'GHN',
          ${`m62-legacy-${shippingChannelId}`}, ${`test://m62/${shippingChannelId}`},
          ${digest(`shipping-secret-${shippingChannelId}`)}, 'test-v1', 'DISABLED',
          'GHN_SANDBOX', now())`;
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`INSERT INTO shipments
        (id, store_id, order_id, warehouse_id, channel_id, public_shipment_number,
          purpose, after_sale_id, status, client_order_code, service_code, cod_amount_vnd,
          address_snapshot_ciphertext, parcel_snapshot, updated_at)
        VALUES (${randomUUID()}::uuid, ${BEAUTY_STORE_ID}::uuid, ${fixture.orderId}::uuid,
          ${BEAUTY_WAREHOUSE_ID}::uuid, ${shippingChannelId}::uuid,
          ${`SHP-M62-${sideEffectCaseId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
          'AFTER_SALE_RETURN', ${sideEffectCaseId}::uuid, 'CREATION_PENDING',
          ${`M62-${sideEffectCaseId}`}, 'standard', 0, 'test-ciphertext',
          '{"heightCm":10,"lengthCm":10,"weightGram":500,"widthCm":10}'::jsonb, now())`;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
      const sideEffectDecisionId = randomUUID();
      await expectDatabaseFailure(
        transaction,
        () => transaction.$executeRaw`INSERT INTO after_sale_legacy_decisions
          (id, store_id, after_sale_id, decision, admin_id, reason,
            policy_basis_ciphertext, payload, payload_hash)
          VALUES (${sideEffectDecisionId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${sideEffectCaseId}::uuid, 'APPROVE', ${fixture.adminId}::uuid,
            'Legacy decision after shipping', 'encrypted-test-policy-basis',
            '{"basis":"post-shipping-review"}'::jsonb,
            ${digest(`legacy-decision-${sideEffectDecisionId}`)})`,
        '23514',
      );
    });
  });

  it('keeps member return facts submitted-only and share facts closed until their runtimes exist', async () => {
    const sharePrivileges = await owner.$queryRawUnsafe<
      Array<{ can_insert: boolean; table_name: string }>
    >(`
      SELECT table_name,
        has_table_privilege('zalo_shop_runtime', format('public.%I', table_name), 'INSERT')
          AS can_insert
      FROM unnest(ARRAY['share_links','share_link_localizations','share_interactions'])
        AS expected(table_name)
      ORDER BY table_name
    `);
    expect(sharePrivileges).toEqual([
      { can_insert: false, table_name: 'share_interactions' },
      { can_insert: false, table_name: 'share_link_localizations' },
      { can_insert: false, table_name: 'share_links' },
    ]);

    await withCommittedCommerceFixture(async (fixture) => {
      await withRollback(async (transaction) => {
        await setContext(transaction, {
          actorId: fixture.adminId,
          actorType: 'admin',
          storeId: BEAUTY_STORE_ID,
        });
        await expectDatabaseFailure(
          transaction,
          () => transaction.$executeRaw`INSERT INTO share_links DEFAULT VALUES`,
          '42501',
        );
        const { afterSaleId } = await createAfterSaleFixture(transaction, fixture, {
          type: 'RETURN_REFUND',
        });
        const digest = (value: string) => createHash('sha256').update(value).digest('hex');
        await setContext(transaction, {
          actorId: fixture.memberId,
          actorType: 'member',
          storeId: BEAUTY_STORE_ID,
        });
        expect(
          await transaction.$queryRaw`SELECT status,
              return_deadline_at > clock_timestamp() AS return_window_open
            FROM after_sales
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${afterSaleId}::uuid`,
        ).toEqual([{ return_window_open: true, status: 'APPROVED' }]);
        const returnId = randomUUID();
        await expectDatabaseFailure(
          transaction,
          () => transaction.$executeRaw`INSERT INTO after_sale_return_shipments
            (id, store_id, after_sale_id, order_id, member_id, carrier_name,
              tracking_number_digest, tracking_number_masked, status, submitted_by,
              received_at, updated_at)
            VALUES (${returnId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${afterSaleId}::uuid,
              ${fixture.orderId}::uuid, ${fixture.memberId}::uuid, 'Member carrier',
              ${digest(`tracking-${returnId}`)}, '***1234', 'DELIVERED',
              ${fixture.memberId}::uuid, now(), now())`,
          '42501',
        );
        await transaction.$executeRaw`INSERT INTO after_sale_return_shipments
          (id, store_id, after_sale_id, order_id, member_id, carrier_name,
            tracking_number_digest, tracking_number_masked, submitted_by, updated_at)
          VALUES (${returnId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${afterSaleId}::uuid,
            ${fixture.orderId}::uuid, ${fixture.memberId}::uuid, 'Member carrier',
            ${digest(`tracking-${returnId}`)}, '***1234', ${fixture.memberId}::uuid, now())`;
        await transaction.$executeRaw`INSERT INTO after_sale_transitions
          (store_id, after_sale_id, from_status, to_status, event, actor_type,
            actor_id, correlation_id)
          VALUES (${BEAUTY_STORE_ID}::uuid, ${afterSaleId}::uuid,
            'APPROVED', 'RETURN_PENDING', 'START_RETURN', 'MEMBER',
            ${fixture.memberId}::uuid,
            pg_catalog.current_setting('app.correlation_id', true))`;
        expect(
          await transaction.$queryRaw`SELECT status, version FROM after_sales
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${afterSaleId}::uuid`,
        ).toEqual([{ status: 'RETURN_PENDING', version: 3 }]);
        await expectDatabaseFailure(
          transaction,
          () => transaction.$executeRaw`INSERT INTO after_sale_transitions
            (store_id, after_sale_id, from_status, to_status, event, actor_type,
              actor_id, correlation_id)
            VALUES (${BEAUTY_STORE_ID}::uuid, ${afterSaleId}::uuid,
              'RETURN_PENDING', 'RETURN_IN_TRANSIT', 'RETURN_SHIPPED', 'MEMBER',
              ${fixture.memberId}::uuid,
              pg_catalog.current_setting('app.correlation_id', true))`,
          '42501',
        );
        await expect(
          transaction.$executeRaw`UPDATE after_sale_return_shipments
            SET status = 'DELIVERED', received_at = now(), version = version + 1,
              updated_at = now()
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${returnId}::uuid`,
        ).resolves.toBe(0);
        expect(
          await transaction.$queryRaw`SELECT status FROM after_sale_return_shipments
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${returnId}::uuid`,
        ).toEqual([{ status: 'SUBMITTED' }]);

        await setContext(transaction, {
          actorId: fixture.adminId,
          actorType: 'admin',
          storeId: BEAUTY_STORE_ID,
        });
        await transaction.$executeRaw`UPDATE after_sale_return_shipments
          SET status = 'DELIVERED', received_at = now(), version = version + 1,
            updated_at = now()
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${returnId}::uuid`;
        await expectDatabaseFailure(
          transaction,
          () => transaction.$executeRaw`UPDATE after_sale_return_shipments
            SET status = 'SUBMITTED', received_at = NULL, version = version + 1,
              updated_at = now()
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${returnId}::uuid`,
          '23514',
        );
        expect(
          await transaction.$queryRaw`SELECT status FROM after_sale_return_shipments
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${returnId}::uuid`,
        ).toEqual([{ status: 'DELIVERED' }]);
        await appendAfterSaleTransition(transaction, {
          actorId: fixture.adminId,
          afterSaleId,
          event: 'REQUIRE_REVIEW',
          fromStatus: 'RETURN_PENDING',
          toStatus: 'REVIEW_REQUIRED',
        });
        await expectDatabaseFailure(
          transaction,
          () =>
            appendAfterSaleTransition(transaction, {
              actorId: fixture.adminId,
              afterSaleId,
              event: 'REJECT_REVIEW',
              fromStatus: 'REVIEW_REQUIRED',
              toStatus: 'REJECTED',
            }),
          '23514',
        );

        const rejectedCaseId = randomUUID();
        await setContext(transaction, {
          actorId: fixture.adminId,
          actorType: 'admin',
          storeId: BEAUTY_STORE_ID,
        });
        await transaction.$executeRaw`INSERT INTO after_sales
          (id, store_id, order_id, member_id, public_case_number, type, status, source,
            reason_code, policy_snapshot, policy_hash, policy_id, policy_version_id,
            legacy_policy_review,
            idempotency_key_hash, request_hash, initiated_by, correlation_id, updated_at)
          VALUES (${rejectedCaseId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${fixture.orderId}::uuid, ${fixture.memberId}::uuid,
            ${`ASC-${rejectedCaseId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
            'RETURN_REFUND', 'PENDING_REVIEW', 'ADMIN', 'rejected-return-regression',
            ${fixture.casePolicyPayload}::jsonb, ${fixture.casePolicyPayloadHash},
            ${fixture.casePolicyId}::uuid, ${fixture.casePolicyVersionId}::uuid, false,
            ${digest(`case-key-${rejectedCaseId}`)},
            ${digest(`case-request-${rejectedCaseId}`)}, ${fixture.adminId}::uuid,
            ${`m62-${rejectedCaseId}`}, now())`;
        await appendAfterSaleTransition(transaction, {
          actorId: fixture.adminId,
          afterSaleId: rejectedCaseId,
          event: 'REJECT',
          fromStatus: 'PENDING_REVIEW',
          toStatus: 'REJECTED',
        });
        await setContext(transaction, {
          actorId: fixture.memberId,
          actorType: 'member',
          storeId: BEAUTY_STORE_ID,
        });
        await expectDatabaseFailure(
          transaction,
          () => transaction.$executeRaw`INSERT INTO after_sale_return_shipments
            (id, store_id, after_sale_id, order_id, member_id, carrier_name,
              tracking_number_digest, tracking_number_masked, submitted_by, updated_at)
            VALUES (${randomUUID()}::uuid, ${BEAUTY_STORE_ID}::uuid,
              ${rejectedCaseId}::uuid, ${fixture.orderId}::uuid,
              ${fixture.memberId}::uuid, 'Member carrier',
              ${digest(`tracking-${rejectedCaseId}`)}, '***5678',
              ${fixture.memberId}::uuid, now())`,
          '23514',
        );
      });
    });
  });

  it('serializes after-sale shipment insertion with rejection and exchange conversion', async () => {
    await withCommittedCommerceFixture(async (fixture) => {
      const shippingChannelId = randomUUID();
      const digest = (value: string) => createHash('sha256').update(value).digest('hex');
      await owner.$executeRaw`INSERT INTO store_shipping_channels
        (id, store_id, provider_environment, provider_code, shop_id, token_secret_ref,
          secret_fingerprint, key_version, status, origin_allowlist_key, updated_at)
        VALUES (${shippingChannelId}::uuid, ${BEAUTY_STORE_ID}::uuid, 'SANDBOX', 'GHN',
          ${`m62-race-${shippingChannelId}`}, ${`test://m62/${shippingChannelId}`},
          ${digest(`shipping-secret-${shippingChannelId}`)}, 'test-v1', 'DISABLED',
          'GHN_SANDBOX', now())`;
      await owner.$executeRaw`UPDATE orders
        SET shipping_fee_vnd = 60000, payable_vnd = 160000, updated_at = now()
        WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${fixture.orderId}::uuid`;

      const returnCaseId = await owner.$transaction(async (transaction) => {
        const { afterSaleId } = await createAfterSaleFixture(transaction, fixture, {
          type: 'RETURN_REFUND',
        });
        const returnShipmentId = randomUUID();
        await setContext(transaction, {
          actorId: fixture.memberId,
          actorType: 'member',
          storeId: BEAUTY_STORE_ID,
        });
        await transaction.$executeRaw`INSERT INTO after_sale_return_shipments
          (id, store_id, after_sale_id, order_id, member_id, carrier_name,
            tracking_number_digest, tracking_number_masked, submitted_by, updated_at)
          VALUES (${returnShipmentId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${afterSaleId}::uuid, ${fixture.orderId}::uuid, ${fixture.memberId}::uuid,
            'M6.3 B0 return fixture', ${digest(`tracking-${returnShipmentId}`)}, '***B0',
            ${fixture.memberId}::uuid, now())`;
        await appendAfterSaleTransition(transaction, {
          actorId: fixture.adminId,
          afterSaleId,
          event: 'START_RETURN',
          fromStatus: 'APPROVED',
          toStatus: 'RETURN_PENDING',
        });
        return afterSaleId;
      });
      const exchangeCase = await owner.$transaction(async (transaction) => {
        const created = await createAfterSaleFixture(transaction, fixture, {
          approvedTotalVnd: 50_000,
          type: 'EXCHANGE',
          withItem: true,
        });
        if (!created.afterSaleItemId) {
          throw new Error('M6.2 exchange race fixture was not created');
        }
        await advanceAfterSaleToInspection(transaction, fixture, created.afterSaleId);
        await createCompleteInspection(transaction, fixture, {
          afterSaleId: created.afterSaleId,
          afterSaleItemId: created.afterSaleItemId,
          quantity: 1,
        });
        await appendAfterSaleTransition(transaction, {
          actorId: fixture.adminId,
          afterSaleId: created.afterSaleId,
          event: 'ACCEPT_INSPECTION',
          fromStatus: 'INSPECTION_PENDING',
          toStatus: 'EXCHANGE_PENDING',
        });
        return created;
      });

      async function insertShipment(
        transaction: StoreTransaction,
        afterSaleId: string,
        purpose: 'AFTER_SALE_RETURN' | 'EXCHANGE_OUTBOUND',
      ): Promise<unknown> {
        await setContext(transaction, {
          actorId: fixture.adminId,
          actorType: 'admin',
          storeId: BEAUTY_STORE_ID,
        });
        const shipmentId = randomUUID();
        return transaction.$executeRaw`INSERT INTO shipments
          (id, store_id, order_id, warehouse_id, channel_id, public_shipment_number,
            purpose, after_sale_id, status, client_order_code, service_code, cod_amount_vnd,
            address_snapshot_ciphertext, parcel_snapshot, updated_at)
          VALUES (${shipmentId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${fixture.orderId}::uuid,
            ${BEAUTY_WAREHOUSE_ID}::uuid, ${shippingChannelId}::uuid,
            ${`SHP-M62-${shipmentId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
            ${purpose}::shipment_purpose, ${afterSaleId}::uuid, 'CREATION_PENDING',
            ${`M62-${shipmentId}`}, 'standard', 0, 'test-ciphertext',
            '{"heightCm":10,"lengthCm":10,"weightGram":500,"widthCm":10}'::jsonb,
            now())`;
      }

      try {
        const returnResults = await raceWithHeldAfterSaleTransition(
          {
            actorId: fixture.adminId,
            afterSaleId: returnCaseId,
            event: 'REQUIRE_REVIEW',
            fromStatus: 'RETURN_PENDING',
            toStatus: 'REVIEW_REQUIRED',
          },
          (transaction) => insertShipment(transaction, returnCaseId, 'AFTER_SALE_RETURN'),
        );
        expect(returnResults[0]).toMatchObject({ status: 'fulfilled' });
        expect(returnResults[1]).toMatchObject({
          reason: { code: 'P2010', meta: { code: '23514' } },
          status: 'rejected',
        });
        expect(
          await owner.$queryRaw`SELECT sale.status, count(shipment.id)::bigint AS shipment_count
            FROM after_sales sale
            LEFT JOIN shipments shipment ON shipment.store_id = sale.store_id
              AND shipment.after_sale_id = sale.id
            WHERE sale.store_id = ${BEAUTY_STORE_ID}::uuid
              AND sale.id = ${returnCaseId}::uuid
            GROUP BY sale.status`,
        ).toEqual([{ shipment_count: 0n, status: 'REVIEW_REQUIRED' }]);

        const exchangeResults = await raceWithHeldAfterSaleTransition(
          {
            actorId: fixture.adminId,
            afterSaleId: exchangeCase.afterSaleId,
            event: 'CONVERT_EXCHANGE_TO_REFUND',
            fromStatus: 'EXCHANGE_PENDING',
            toStatus: 'REFUND_PENDING',
          },
          (transaction) =>
            insertShipment(transaction, exchangeCase.afterSaleId, 'EXCHANGE_OUTBOUND'),
        );
        expect(exchangeResults[0]).toMatchObject({ status: 'fulfilled' });
        expect(exchangeResults[1]).toMatchObject({
          reason: { code: 'P2010', meta: { code: '23514' } },
          status: 'rejected',
        });
        expect(
          await owner.$queryRaw`SELECT sale.status, count(shipment.id)::bigint AS shipment_count
            FROM after_sales sale
            LEFT JOIN shipments shipment ON shipment.store_id = sale.store_id
              AND shipment.after_sale_id = sale.id
            WHERE sale.store_id = ${BEAUTY_STORE_ID}::uuid
              AND sale.id = ${exchangeCase.afterSaleId}::uuid
            GROUP BY sale.status`,
        ).toEqual([{ shipment_count: 0n, status: 'REFUND_PENDING' }]);
      } finally {
        await owner.$transaction(async (transaction) => {
          await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
          await transaction.$executeRaw`DELETE FROM shipments
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid
              AND after_sale_id IN (${returnCaseId}::uuid, ${exchangeCase.afterSaleId}::uuid)`;
          await transaction.$executeRaw`DELETE FROM after_sale_inspection_allocations
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid
              AND after_sale_id = ${exchangeCase.afterSaleId}::uuid`;
          await transaction.$executeRaw`DELETE FROM after_sale_inspections
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid
              AND after_sale_id = ${exchangeCase.afterSaleId}::uuid`;
          await transaction.$executeRaw`DELETE FROM after_sale_return_shipments
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid
              AND after_sale_id IN (${returnCaseId}::uuid, ${exchangeCase.afterSaleId}::uuid)`;
          await transaction.$executeRaw`DELETE FROM after_sale_transitions
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid
              AND after_sale_id IN (${returnCaseId}::uuid, ${exchangeCase.afterSaleId}::uuid)`;
          await transaction.$executeRaw`DELETE FROM after_sale_items
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid
              AND after_sale_id = ${exchangeCase.afterSaleId}::uuid`;
          await transaction.$executeRaw`DELETE FROM after_sale_order_allocations
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid
              AND after_sale_id IN (${returnCaseId}::uuid, ${exchangeCase.afterSaleId}::uuid)`;
          await transaction.$executeRaw`DELETE FROM after_sales
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid
              AND id IN (${returnCaseId}::uuid, ${exchangeCase.afterSaleId}::uuid)`;
          await transaction.$executeRaw`DELETE FROM store_shipping_channels
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${shippingChannelId}::uuid`;
        });
      }
    });
  });

  it('rejects return expiration when a raw after-sale return shipment exists', async () => {
    await withOwnerRollback(async (transaction) => {
      const fixture = await createCommerceFixture(transaction);
      const { afterSaleId } = await createAfterSaleFixture(transaction, fixture, {
        type: 'RETURN_REFUND',
      });
      const digest = (value: string) => createHash('sha256').update(value).digest('hex');
      const shippingChannelId = randomUUID();
      const shipmentId = randomUUID();
      await transaction.$executeRaw`INSERT INTO store_shipping_channels
        (id, store_id, provider_environment, provider_code, shop_id, token_secret_ref,
          secret_fingerprint, key_version, status, origin_allowlist_key, updated_at)
        VALUES (${shippingChannelId}::uuid, ${BEAUTY_STORE_ID}::uuid, 'SANDBOX', 'GHN',
          ${`m62-expiry-${shippingChannelId}`}, ${`test://m62/${shippingChannelId}`},
          ${digest(`shipping-secret-${shippingChannelId}`)}, 'test-v1', 'DISABLED',
          'GHN_SANDBOX', now())`;
      await setContext(transaction, {
        actorId: fixture.adminId,
        actorType: 'admin',
        storeId: BEAUTY_STORE_ID,
      });
      await transaction.$executeRaw`INSERT INTO shipments
        (id, store_id, order_id, warehouse_id, channel_id, public_shipment_number,
          purpose, after_sale_id, status, client_order_code, service_code, cod_amount_vnd,
          address_snapshot_ciphertext, parcel_snapshot, updated_at)
        VALUES (${shipmentId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${fixture.orderId}::uuid,
          ${BEAUTY_WAREHOUSE_ID}::uuid, ${shippingChannelId}::uuid,
          ${`SHP-M62-${shipmentId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
          'AFTER_SALE_RETURN', ${afterSaleId}::uuid, 'CREATION_PENDING',
          ${`M62-${shipmentId}`}, 'standard', 0, 'test-ciphertext',
          '{"heightCm":10,"lengthCm":10,"weightGram":500,"widthCm":10}'::jsonb, now())`;
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`UPDATE after_sales
        SET return_deadline_at = now() - interval '1 minute', updated_at = now()
        WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${afterSaleId}::uuid`;
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;

      await expectDatabaseFailure(
        transaction,
        () =>
          appendAfterSaleTransition(transaction, {
            actorId: fixture.adminId,
            afterSaleId,
            event: 'RETURN_EXPIRED',
            fromStatus: 'APPROVED',
            toStatus: 'REJECTED',
          }),
        '23514',
      );
      expect(
        await transaction.$queryRaw`SELECT sale.status,
            count(shipment.id)::bigint AS shipment_count
          FROM after_sales sale
          LEFT JOIN shipments shipment ON shipment.store_id = sale.store_id
            AND shipment.after_sale_id = sale.id
          WHERE sale.store_id = ${BEAUTY_STORE_ID}::uuid
            AND sale.id = ${afterSaleId}::uuid
          GROUP BY sale.status`,
      ).toEqual([{ shipment_count: 1n, status: 'APPROVED' }]);
    });
  });

  it('protects immutable facts and limits runtime updates to mutable workflow columns', async () => {
    const appendOnlyPrivileges = await owner.$queryRawUnsafe<
      Array<{ can_delete: boolean; can_update: boolean; table_name: string }>
    >(`
      SELECT
        expected.table_name,
        has_table_privilege('zalo_shop_runtime', expected.table_name, 'UPDATE') AS can_update,
        has_table_privilege('zalo_shop_runtime', expected.table_name, 'DELETE') AS can_delete
      FROM (VALUES ${APPEND_ONLY_TABLES.map((table) => `('${table}')`).join(',')})
        AS expected(table_name)
      ORDER BY expected.table_name
    `);
    expect(appendOnlyPrivileges).toHaveLength(APPEND_ONLY_TABLES.length);
    expect(
      appendOnlyPrivileges.every(({ can_delete, can_update }) => !can_delete && !can_update),
    ).toBe(true);

    const mutablePrivileges = await owner.$queryRaw<
      Array<{
        broad_update: boolean;
        identity_update: boolean;
        mutable_update: boolean;
        table_name: string;
      }>
    >`
      SELECT
        expected.table_name,
        has_table_privilege('zalo_shop_runtime', expected.table_name, 'UPDATE') AS broad_update,
        has_column_privilege(
          'zalo_shop_runtime', expected.table_name, expected.identity_column, 'UPDATE'
        ) AS identity_update,
        has_column_privilege(
          'zalo_shop_runtime', expected.table_name, expected.mutable_column, 'UPDATE'
        ) AS mutable_update
      FROM (VALUES
        ('store_after_sale_settings', 'store_id', 'enforce_policy_snapshots'),
        ('after_sale_policies', 'code', 'draft_payload'),
        ('after_sale_active_policy_assignments', 'target_type', 'policy_version_id'),
        ('after_sales', 'order_id', 'approved_total_vnd'),
        ('after_sale_items', 'order_id', 'approved_quantity'),
        ('after_sale_operations', 'idempotency_key_hash', 'status'),
        ('after_sale_evidence_files', 'checksum_sha256', 'status'),
        ('after_sale_settlements', 'amount_vnd', 'status'),
        ('after_sale_return_shipments', 'tracking_number_masked', 'status'),
        ('exchange_fulfillments', 'after_sale_item_id', 'status'),
        ('member_product_views', 'member_id', 'last_viewed_at')
      ) AS expected(table_name, identity_column, mutable_column)
      ORDER BY expected.table_name
    `;
    expect(
      mutablePrivileges.every(
        ({ broad_update, identity_update, mutable_update }) =>
          !broad_update && !identity_update && mutable_update,
      ),
    ).toBe(true);

    const privacyHeaderPrivileges = await owner.$queryRaw<
      Array<{ can_update_status: boolean; can_update_table: boolean }>
    >`
      SELECT
        has_table_privilege('zalo_shop_runtime', 'privacy_requests', 'UPDATE')
          AS can_update_table,
        has_column_privilege('zalo_shop_runtime', 'privacy_requests', 'status', 'UPDATE')
          AS can_update_status
    `;
    expect(privacyHeaderPrivileges).toEqual([
      { can_update_status: false, can_update_table: false },
    ]);

    const definerFunctions = await owner.$queryRaw<
      Array<{
        function_owner: string;
        proconfig: string[] | null;
        proname: string;
        prosecdef: boolean;
        runtime_can_execute: boolean;
      }>
    >`
      SELECT
        procedure.proname,
        procedure.prosecdef,
        procedure.proconfig,
        pg_catalog.pg_get_userbyid(procedure.proowner) AS function_owner,
        pg_catalog.has_function_privilege(
          'zalo_shop_runtime', procedure.oid, 'EXECUTE'
        ) AS runtime_can_execute
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'app_security'
        AND procedure.proname IN (
          'validate_m62_after_sale_item_identity',
          'enforce_m62_after_sale_item_capacity',
          'validate_m62_after_sale_item_initial_shape',
          'validate_m62_legacy_decision',
          'validate_m62_after_sale_transition',
          'apply_m62_after_sale_transition',
          'validate_m62_return_submission',
          'validate_m62_privacy_transition',
          'apply_m62_privacy_transition',
          'validate_m62_policy_actor',
          'validate_m62_policy_version_actor',
          'validate_m62_policy_settings_actor',
          'provision_m63_after_sale_setting',
          'validate_m62_order_allocation',
          'validate_m62_order_approval_capacity',
          'validate_m62_order_allocation_final_state'
        )
      ORDER BY procedure.proname
    `;
    expect(definerFunctions).toHaveLength(16);
    expect(
      definerFunctions.every(
        ({ function_owner, proconfig, prosecdef, runtime_can_execute }) =>
          function_owner !== 'zalo_shop_runtime' &&
          prosecdef &&
          proconfig?.includes('search_path=pg_catalog, public, pg_temp') &&
          !runtime_can_execute,
      ),
    ).toBe(true);
  });

  it('provisions a stable OFF policy-settings row for stores created after deployment', async () => {
    await withOwnerRollback(async (transaction) => {
      const storeId = randomUUID();
      await transaction.store.create({
        data: {
          code: `m63-provision-${storeId.slice(0, 8)}`,
          id: storeId,
          industry: 'BEAUTY',
        },
      });

      await expect(
        transaction.storeAfterSaleSetting.findUnique({ where: { storeId } }),
      ).resolves.toMatchObject({
        currentVersionId: null,
        defaultPolicyId: null,
        enforcePolicySnapshots: false,
        readinessCheckedAt: null,
        readinessHash: null,
        storeId,
        updatedBy: null,
        version: 1,
      });
    });
  });

  it('enforces deterministic policy assignments and immutable order-item snapshots in the catalog', async () => {
    const assignmentChecks = await owner.$queryRaw<Array<{ definition: string }>>`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'after_sale_policy_version_assignments'::regclass
        AND contype = 'c'
    `;
    expect(
      assignmentChecks.some(
        ({ definition }) =>
          definition.includes('target_type') &&
          definition.includes('product_id') &&
          definition.includes('category_id'),
      ),
    ).toBe(true);

    const activeTargetIndexes = await owner.$queryRaw<Array<{ definition: string }>>`
      SELECT pg_get_indexdef(indexrelid) AS definition
      FROM pg_index
      WHERE indrelid = 'after_sale_active_policy_assignments'::regclass
        AND indisunique
    `;
    expect(
      activeTargetIndexes.some(({ definition }) => {
        const normalized = definition.toLowerCase();
        return (
          normalized.includes('store_id') &&
          normalized.includes('target_type') &&
          (normalized.includes('target_id') ||
            (normalized.includes('product_id') && normalized.includes('category_id')))
        );
      }),
    ).toBe(true);

    const snapshotConstraints = await owner.$queryRaw<
      Array<{ constraint_type: string; definition: string }>
    >`
      SELECT contype::text AS constraint_type, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'order_item_after_sale_policy_snapshots'::regclass
      ORDER BY contype, conname
    `;
    const normalizedDefinitions = snapshotConstraints.map(({ definition }) =>
      definition.replaceAll('"', '').toLowerCase(),
    );
    expect(
      normalizedDefinitions.some(
        (definition) =>
          definition.includes('unique (store_id, order_item_id)') ||
          definition.includes('primary key (store_id, order_item_id)'),
      ),
    ).toBe(true);
    expect(
      normalizedDefinitions.some(
        (definition) =>
          definition.includes('foreign key (store_id, order_id, order_item_id)') &&
          definition.includes('references order_items(store_id, order_id, id)'),
      ),
    ).toBe(true);
    expect(
      normalizedDefinitions.some(
        (definition) =>
          definition.includes('foreign key (store_id, policy_version_id, policy_id)') &&
          definition.includes('references after_sale_policy_versions(store_id, id, policy_id)'),
      ),
    ).toBe(true);
  });

  it('binds policy and settings audit actors to the current administrator', async () => {
    await withCommittedCommerceFixture(async (fixture) => {
      await withRollback(async (transaction) => {
        await setContext(transaction, {
          actorId: fixture.adminId,
          actorType: 'admin',
          storeId: BEAUTY_STORE_ID,
        });
        const policyId = randomUUID();
        const policyVersionId = randomUUID();
        const digest = (value: string) => createHash('sha256').update(value).digest('hex');

        await expectDatabaseFailure(
          transaction,
          () => transaction.$executeRaw`INSERT INTO after_sale_policies
            (id, store_id, code, draft_payload, draft_hash, created_by, updated_by,
              updated_at)
            VALUES (${policyId}::uuid, ${BEAUTY_STORE_ID}::uuid,
              ${`actor-spoof-${policyId.slice(0, 8)}`}, '{}'::jsonb,
              ${digest(`draft-${policyId}`)}, ${fixture.confirmingAdminId}::uuid,
              ${fixture.confirmingAdminId}::uuid, now())`,
          '42501',
        );
        await transaction.$executeRaw`INSERT INTO after_sale_policies
          (id, store_id, code, draft_payload, draft_hash, created_by, updated_by,
            updated_at)
          VALUES (${policyId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${`actor-bound-${policyId.slice(0, 8)}`}, '{}'::jsonb,
            ${digest(`draft-${policyId}`)}, ${fixture.adminId}::uuid,
            ${fixture.adminId}::uuid, now())`;

        await expectDatabaseFailure(
          transaction,
          () => transaction.$executeRaw`INSERT INTO after_sale_policy_versions
            (id, store_id, policy_id, version_number, effective_at, request_window_days,
              return_window_days, allowed_types, return_shipping_payer, unopened_required,
              hygiene_restricted, damaged_exception, wrong_item_exception, defect_exception,
              condition_rules, payload, payload_hash, published_by)
            VALUES (${policyVersionId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${policyId}::uuid,
              1, now(), 30, 7, ARRAY['REFUND_ONLY']::after_sale_type[], 'MERCHANT',
              false, false, true, true, true, '{}'::jsonb, '{}'::jsonb,
              ${digest(`version-${policyVersionId}`)},
              ${fixture.confirmingAdminId}::uuid)`,
          '42501',
        );
        await expectDatabaseFailure(
          transaction,
          () => transaction.$executeRaw`INSERT INTO store_after_sale_settings
            (store_id, updated_at, updated_by)
            VALUES (${BEAUTY_STORE_ID}::uuid, now(), ${fixture.confirmingAdminId}::uuid)`,
          '42501',
        );
        const readinessHash = digest(`readiness-${policyId}`);
        await transaction.$executeRaw`UPDATE store_after_sale_settings
          SET readiness_checked_at = now(), readiness_ready_at = now(),
            readiness_hash = ${readinessHash}, readiness_checked_by = ${fixture.adminId}::uuid,
            updated_at = now(), updated_by = ${fixture.adminId}::uuid
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid`;
        await expectDatabaseFailure(
          transaction,
          () => transaction.$executeRaw`UPDATE store_after_sale_settings
            SET readiness_checked_by = ${fixture.confirmingAdminId}::uuid,
              updated_at = now(), updated_by = ${fixture.adminId}::uuid
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid`,
          '42501',
        );

        await setContext(transaction, {
          actorId: fixture.confirmingAdminId,
          actorType: 'admin',
          storeId: BEAUTY_STORE_ID,
        });
        await expectDatabaseFailure(
          transaction,
          () => transaction.$executeRaw`UPDATE after_sale_policies
            SET draft_payload = '{"changed":true}'::jsonb,
              draft_hash = ${digest(`changed-${policyId}`)},
              updated_by = ${fixture.adminId}::uuid, version = version + 1,
              updated_at = now()
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${policyId}::uuid`,
          '42501',
        );
      });
    });
  });

  it('requires exact order allocations and caps approval promises at order payable', async () => {
    await withCommittedCommerceFixture(async (fixture) => {
      const orphanAfterSaleId = randomUUID();
      const digest = (value: string) => createHash('sha256').update(value).digest('hex');
      await withRollback(async (transaction) => {
        await setContext(transaction, {
          actorId: fixture.adminId,
          actorType: 'admin',
          storeId: BEAUTY_STORE_ID,
        });
        await expectDatabaseFailure(
          transaction,
          () => transaction.$executeRaw`INSERT INTO after_sale_transitions
            (store_id, after_sale_id, from_status, to_status, event, actor_type,
              actor_id, correlation_id)
            VALUES (${FASHION_STORE_ID}::uuid, ${randomUUID()}::uuid,
              'PENDING_REVIEW', 'APPROVED', 'APPROVE', 'ADMIN',
              ${fixture.adminId}::uuid,
              pg_catalog.current_setting('app.correlation_id', true))`,
          '42501',
        );
      });
      await expectSqlState(
        runtime.$transaction(async (transaction) => {
          await setContext(transaction, {
            actorId: fixture.adminId,
            actorType: 'admin',
            storeId: BEAUTY_STORE_ID,
          });
          await transaction.$executeRaw`INSERT INTO after_sales
            (id, store_id, order_id, member_id, public_case_number, type, status, source,
              reason_code, policy_snapshot, policy_hash, policy_id, policy_version_id,
              legacy_policy_review,
              requested_other_vnd, requested_total_vnd, idempotency_key_hash,
              request_hash, initiated_by, correlation_id, updated_at)
            VALUES (${orphanAfterSaleId}::uuid, ${BEAUTY_STORE_ID}::uuid,
              ${fixture.orderId}::uuid, ${fixture.memberId}::uuid,
              ${`ASC-${orphanAfterSaleId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
              'REFUND_ONLY', 'PENDING_REVIEW', 'ADMIN', 'orphan-order-allocation',
              ${fixture.casePolicyPayload}::jsonb, ${fixture.casePolicyPayloadHash},
              ${fixture.casePolicyId}::uuid, ${fixture.casePolicyVersionId}::uuid, false,
              10000, 10000,
              ${digest(`case-key-${orphanAfterSaleId}`)},
              ${digest(`case-request-${orphanAfterSaleId}`)}, ${fixture.adminId}::uuid,
              ${`m62-${orphanAfterSaleId}`}, now())`;
          await transaction.$executeRaw`UPDATE after_sales
            SET approved_other_vnd = 10000, approved_total_vnd = 10000,
              updated_at = now()
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid
              AND id = ${orphanAfterSaleId}::uuid`;
          await transaction.$executeRaw`INSERT INTO after_sale_order_allocations
            (store_id, after_sale_id, order_id, other_vnd)
            VALUES (${BEAUTY_STORE_ID}::uuid, ${orphanAfterSaleId}::uuid,
              ${fixture.orderId}::uuid, 10000)`;
          await transaction.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
        }),
        '23514',
      );

      await withRollback(async (transaction) => {
        await setContext(transaction, {
          actorId: fixture.adminId,
          actorType: 'admin',
          storeId: BEAUTY_STORE_ID,
        });
        const afterSaleId = randomUUID();
        const afterSaleItemId = randomUUID();
        const mismatchedAfterSaleId = randomUUID();
        await expectDatabaseFailure(
          transaction,
          async () => {
            await transaction.$executeRaw`INSERT INTO after_sales
              (id, store_id, order_id, member_id, public_case_number, type, status,
                source, reason_code, policy_snapshot, policy_hash, policy_id,
                policy_version_id, legacy_policy_review,
                requested_item_vnd, requested_total_vnd, idempotency_key_hash,
                request_hash, initiated_by, correlation_id, updated_at)
              VALUES (${mismatchedAfterSaleId}::uuid, ${BEAUTY_STORE_ID}::uuid,
                ${fixture.orderId}::uuid, ${fixture.memberId}::uuid,
                ${`ASC-${mismatchedAfterSaleId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
                'REFUND_ONLY', 'PENDING_REVIEW', 'ADMIN', 'mismatched-order-allocation',
                ${fixture.casePolicyPayload}::jsonb, ${fixture.casePolicyPayloadHash},
                ${fixture.casePolicyId}::uuid, ${fixture.casePolicyVersionId}::uuid, false,
                10000, 10000, ${digest(`case-key-${mismatchedAfterSaleId}`)},
                ${digest(`case-request-${mismatchedAfterSaleId}`)}, ${fixture.adminId}::uuid,
                ${`m62-${mismatchedAfterSaleId}`}, now())`;
            await transaction.$executeRaw`UPDATE after_sales
              SET approved_other_vnd = 10000, approved_total_vnd = 10000,
                updated_at = now()
              WHERE store_id = ${BEAUTY_STORE_ID}::uuid
                AND id = ${mismatchedAfterSaleId}::uuid`;
            await transaction.$executeRaw`INSERT INTO after_sale_order_allocations
              (store_id, after_sale_id, order_id, other_vnd)
              VALUES (${BEAUTY_STORE_ID}::uuid, ${mismatchedAfterSaleId}::uuid,
                ${fixture.orderId}::uuid, 10000)`;
            await appendAfterSaleTransition(transaction, {
              actorId: fixture.adminId,
              afterSaleId: mismatchedAfterSaleId,
              event: 'APPROVE',
              fromStatus: 'PENDING_REVIEW',
              toStatus: 'APPROVED',
            });
          },
          '23514',
        );
        await transaction.$executeRaw`INSERT INTO after_sales
          (id, store_id, order_id, member_id, public_case_number, type, status, source,
            reason_code, policy_snapshot, policy_hash, policy_id, policy_version_id,
            legacy_policy_review,
            requested_item_vnd, requested_other_vnd, requested_total_vnd,
            idempotency_key_hash, request_hash, initiated_by, correlation_id, updated_at)
          VALUES (${afterSaleId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${fixture.orderId}::uuid, ${fixture.memberId}::uuid,
            ${`ASC-${afterSaleId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
            'REFUND_ONLY', 'PENDING_REVIEW', 'ADMIN', 'order-allocation-capacity',
            ${fixture.casePolicyPayload}::jsonb, ${fixture.casePolicyPayloadHash},
            ${fixture.casePolicyId}::uuid, ${fixture.casePolicyVersionId}::uuid, false,
            50000, 10000, 60000,
            ${digest(`case-key-${afterSaleId}`)}, ${digest(`case-request-${afterSaleId}`)},
            ${fixture.adminId}::uuid, ${`m62-${afterSaleId}`}, now())`;
        await transaction.$executeRaw`INSERT INTO after_sale_items
          (id, store_id, after_sale_id, order_id, order_item_id, requested_quantity,
            requested_item_vnd, sku_id, product_id, brand_id, category_id, sku_code,
            product_name, option_snapshot, unit_price_vnd, updated_at)
          VALUES (${afterSaleItemId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${afterSaleId}::uuid, ${fixture.orderId}::uuid, ${fixture.orderItemId}::uuid,
            1, 50000, ${fixture.skuId}::uuid, ${fixture.productId}::uuid,
            ${fixture.brandId}::uuid, ${BEAUTY_CATEGORY_ID}::uuid,
            ${`m62-sku-${fixture.skuId.slice(0, 8)}`}, 'M6.2 product',
            '{"size":"small"}'::jsonb, 50000, now())`;
        await transaction.$executeRaw`UPDATE after_sale_items
          SET approved_quantity = 1, approved_item_vnd = 50000, updated_at = now()
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${afterSaleItemId}::uuid`;
        await transaction.$executeRaw`UPDATE after_sales
          SET approved_item_vnd = 50000, approved_other_vnd = 10000,
            approved_total_vnd = 60000, updated_at = now()
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${afterSaleId}::uuid`;

        await expectDatabaseFailure(
          transaction,
          () =>
            appendAfterSaleTransition(transaction, {
              actorId: fixture.adminId,
              afterSaleId,
              event: 'APPROVE',
              fromStatus: 'PENDING_REVIEW',
              toStatus: 'APPROVED',
            }),
          '23514',
        );
        await transaction.$executeRaw`INSERT INTO after_sale_order_allocations
          (store_id, after_sale_id, order_id, other_vnd)
          VALUES (${BEAUTY_STORE_ID}::uuid, ${afterSaleId}::uuid,
            ${fixture.orderId}::uuid, 10000)`;
        await appendAfterSaleTransition(transaction, {
          actorId: fixture.adminId,
          afterSaleId,
          event: 'APPROVE',
          fromStatus: 'PENDING_REVIEW',
          toStatus: 'APPROVED',
        });

        await expectDatabaseFailure(
          transaction,
          () =>
            createAfterSaleFixture(transaction, fixture, {
              approvedTotalVnd: 100_000,
              type: 'REFUND_ONLY',
              withItem: true,
            }),
          '23514',
        );
        expect(
          await transaction.$queryRaw`SELECT status, approved_total_vnd
            FROM after_sales
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${afterSaleId}::uuid`,
        ).toEqual([{ approved_total_vnd: 60000n, status: 'APPROVED' }]);
      });
    });
  });

  it('serializes concurrent approvals against the remaining order entitlement', async () => {
    await withCommittedCommerceFixture(async (fixture) => {
      const digest = (value: string) => createHash('sha256').update(value).digest('hex');
      const afterSaleIds = [randomUUID(), randomUUID()] as const;
      await owner.$transaction(async (transaction) => {
        await setContext(transaction, {
          actorId: fixture.adminId,
          actorType: 'admin',
          storeId: BEAUTY_STORE_ID,
        });
        await transaction.$executeRaw`UPDATE orders
          SET order_discount_vnd = 20000, payable_vnd = 80000, updated_at = now()
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${fixture.orderId}::uuid`;
        for (const afterSaleId of afterSaleIds) {
          const afterSaleItemId = randomUUID();
          await transaction.$executeRaw`INSERT INTO after_sales
            (id, store_id, order_id, member_id, public_case_number, type, status, source,
              reason_code, policy_snapshot, policy_hash, policy_id, policy_version_id,
              legacy_policy_review,
              requested_item_vnd, requested_total_vnd, idempotency_key_hash, request_hash,
              initiated_by, correlation_id, updated_at)
            VALUES (${afterSaleId}::uuid, ${BEAUTY_STORE_ID}::uuid,
              ${fixture.orderId}::uuid, ${fixture.memberId}::uuid,
              ${`ASC-${afterSaleId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
              'REFUND_ONLY', 'PENDING_REVIEW', 'ADMIN', 'concurrent-order-capacity',
              ${fixture.casePolicyPayload}::jsonb, ${fixture.casePolicyPayloadHash},
              ${fixture.casePolicyId}::uuid, ${fixture.casePolicyVersionId}::uuid, false,
              50000, 50000,
              ${digest(`case-key-${afterSaleId}`)}, ${digest(`case-request-${afterSaleId}`)},
              ${fixture.adminId}::uuid, ${`m62-${afterSaleId}`}, now())`;
          await transaction.$executeRaw`INSERT INTO after_sale_items
            (id, store_id, after_sale_id, order_id, order_item_id, requested_quantity,
              requested_item_vnd, sku_id, product_id, brand_id, category_id, sku_code,
              product_name, option_snapshot, unit_price_vnd, updated_at)
            VALUES (${afterSaleItemId}::uuid, ${BEAUTY_STORE_ID}::uuid,
              ${afterSaleId}::uuid, ${fixture.orderId}::uuid,
              ${fixture.orderItemId}::uuid, 1, 50000, ${fixture.skuId}::uuid,
              ${fixture.productId}::uuid, ${fixture.brandId}::uuid,
              ${BEAUTY_CATEGORY_ID}::uuid,
              ${`m62-sku-${fixture.skuId.slice(0, 8)}`}, 'M6.2 product',
              '{"size":"small"}'::jsonb, 50000, now())`;
          await transaction.$executeRaw`UPDATE after_sale_items
            SET approved_quantity = 1, approved_item_vnd = 50000, updated_at = now()
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${afterSaleItemId}::uuid`;
          await transaction.$executeRaw`UPDATE after_sales
            SET approved_item_vnd = 50000, approved_total_vnd = 50000, updated_at = now()
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${afterSaleId}::uuid`;
        }
      });

      const firstReady = createDeferred();
      const releaseFirst = createDeferred();
      const firstPid = createDeferred<number>();
      const secondPid = createDeferred<number>();
      const approve = async (transaction: StoreTransaction, afterSaleId: string) => {
        await setContext(transaction, {
          actorId: fixture.adminId,
          actorType: 'admin',
          storeId: BEAUTY_STORE_ID,
        });
        return appendAfterSaleTransition(transaction, {
          actorId: fixture.adminId,
          afterSaleId,
          event: 'APPROVE',
          fromStatus: 'PENDING_REVIEW',
          toStatus: 'APPROVED',
        });
      };
      const firstAttempt = runtime.$transaction(async (transaction) => {
        const [backend] = await transaction.$queryRaw<Array<{ pid: number }>>`
          SELECT pg_catalog.pg_backend_pid()::integer AS pid
        `;
        if (!backend) throw new Error('First approval backend PID is unavailable');
        firstPid.resolve(backend.pid);
        try {
          await approve(transaction, afterSaleIds[0]);
        } finally {
          firstReady.resolve(undefined);
        }
        await releaseFirst.promise;
      });
      await firstReady.promise;
      const secondAttempt = contender.$transaction(async (transaction) => {
        const [backend] = await transaction.$queryRaw<Array<{ pid: number }>>`
          SELECT pg_catalog.pg_backend_pid()::integer AS pid
        `;
        if (!backend) throw new Error('Second approval backend PID is unavailable');
        secondPid.resolve(backend.pid);
        return approve(transaction, afterSaleIds[1]);
      });
      let lockWaitFailure: unknown;
      try {
        expect(
          await waitForApprovalAdvisoryLock({
            blockerPid: await firstPid.promise,
            contenderPid: await secondPid.promise,
          }),
        ).toEqual({ orderLockModes: [] });
      } catch (error) {
        lockWaitFailure = error;
      } finally {
        releaseFirst.resolve(undefined);
      }

      const results = await Promise.allSettled([firstAttempt, secondAttempt]);
      if (lockWaitFailure instanceof Error) throw lockWaitFailure;
      if (lockWaitFailure) {
        throw new Error('M6.2 approval advisory lock observation failed', {
          cause: lockWaitFailure,
        });
      }
      expect(results[0]).toMatchObject({ status: 'fulfilled' });
      expect(results[1]).toMatchObject({
        reason: { code: 'P2010', meta: { code: '23514' } },
        status: 'rejected',
      });
      expect(
        await owner.$queryRaw<Array<{ status: string }>>`SELECT status::text AS status
          FROM after_sales
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid
            AND id IN (${afterSaleIds[0]}::uuid, ${afterSaleIds[1]}::uuid)
          ORDER BY status`,
      ).toEqual([{ status: 'APPROVED' }, { status: 'PENDING_REVIEW' }]);
    });
  });

  it('serializes settlement capacity behind a held after-sale approval aggregate lock', async () => {
    await withCommittedCommerceFixture(async (fixture) => {
      const afterSaleId = randomUUID();
      const afterSaleItemId = randomUUID();
      const settlementId = randomUUID();
      const digest = (value: string) => createHash('sha256').update(value).digest('hex');
      await owner.$transaction(async (transaction) => {
        await setContext(transaction, {
          actorId: fixture.adminId,
          actorType: 'admin',
          storeId: BEAUTY_STORE_ID,
        });
        await transaction.$executeRaw`INSERT INTO after_sales
          (id, store_id, order_id, member_id, public_case_number, type, status, source,
            reason_code, policy_snapshot, policy_hash, policy_id, policy_version_id,
            legacy_policy_review,
            requested_item_vnd, requested_other_vnd, requested_total_vnd,
            idempotency_key_hash, request_hash, initiated_by, correlation_id, updated_at)
          VALUES (${afterSaleId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${fixture.orderId}::uuid, ${fixture.memberId}::uuid,
            ${`ASC-${afterSaleId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
            'REFUND_ONLY', 'PENDING_REVIEW', 'ADMIN', 'settlement-lock-order',
            ${fixture.casePolicyPayload}::jsonb, ${fixture.casePolicyPayloadHash},
            ${fixture.casePolicyId}::uuid, ${fixture.casePolicyVersionId}::uuid, false,
            50000, 10000, 60000,
            ${digest(`case-key-${afterSaleId}`)}, ${digest(`case-request-${afterSaleId}`)},
            ${fixture.adminId}::uuid, ${`m62-${afterSaleId}`}, now())`;
        await transaction.$executeRaw`INSERT INTO after_sale_items
          (id, store_id, after_sale_id, order_id, order_item_id, requested_quantity,
            requested_item_vnd, sku_id, product_id, brand_id, category_id, sku_code,
            product_name, option_snapshot, unit_price_vnd, updated_at)
          VALUES (${afterSaleItemId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${afterSaleId}::uuid, ${fixture.orderId}::uuid, ${fixture.orderItemId}::uuid,
            1, 50000, ${fixture.skuId}::uuid, ${fixture.productId}::uuid,
            ${fixture.brandId}::uuid, ${BEAUTY_CATEGORY_ID}::uuid,
            ${`m62-sku-${fixture.skuId.slice(0, 8)}`}, 'M6.2 product',
            '{"size":"small"}'::jsonb, 50000, now())`;
        await transaction.$executeRaw`UPDATE after_sale_items
          SET approved_quantity = 1, approved_item_vnd = 50000, updated_at = now()
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${afterSaleItemId}::uuid`;
        await transaction.$executeRaw`UPDATE after_sales
          SET approved_item_vnd = 50000, approved_other_vnd = 10000,
            approved_total_vnd = 60000, updated_at = now()
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${afterSaleId}::uuid`;
      });

      const results = await raceWithHeldAfterSaleRowLock(
        {
          actorId: fixture.adminId,
          afterSaleId,
          afterLock: async (transaction) => {
            await transaction.$executeRaw`INSERT INTO after_sale_order_allocations
              (store_id, after_sale_id, order_id, other_vnd)
              VALUES (${BEAUTY_STORE_ID}::uuid, ${afterSaleId}::uuid,
                ${fixture.orderId}::uuid, 10000)`;
            await appendAfterSaleTransition(transaction, {
              actorId: fixture.adminId,
              afterSaleId,
              event: 'APPROVE',
              fromStatus: 'PENDING_REVIEW',
              toStatus: 'APPROVED',
            });
          },
        },
        (transaction) =>
          transaction.$executeRaw`INSERT INTO after_sale_settlements
            (id, store_id, after_sale_id, order_id, public_settlement_number, method,
              status, amount_vnd, idempotency_key_hash, request_hash, requested_by,
              transfer_reference_digest, transfer_evidence_ciphertext, updated_at)
            VALUES (${settlementId}::uuid, ${BEAUTY_STORE_ID}::uuid,
              ${afterSaleId}::uuid, ${fixture.orderId}::uuid,
              ${`AST-${settlementId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
              'COD_OFFLINE', 'PENDING', 60000,
              ${digest(`settlement-key-${settlementId}`)},
              ${digest(`settlement-request-${settlementId}`)}, ${fixture.adminId}::uuid,
              ${digest(`transfer-${settlementId}`)}, 'encrypted-test-evidence', now())`,
      );

      expect(results[0]).toMatchObject({ status: 'fulfilled' });
      expect(results[1]).toMatchObject({
        reason: { code: 'P2010', meta: { code: '23514' } },
        status: 'rejected',
      });
      expect(
        await owner.$queryRaw<Array<{ status: string }>>`SELECT status::text AS status
          FROM after_sales
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${afterSaleId}::uuid`,
      ).toEqual([{ status: 'APPROVED' }]);
    });
  });

  it('serializes settlement capacity behind a held item-only approval without an order allocation', async () => {
    await withCommittedCommerceFixture(async (fixture) => {
      const afterSaleId = randomUUID();
      const afterSaleItemId = randomUUID();
      const settlementId = randomUUID();
      const digest = (value: string) => createHash('sha256').update(value).digest('hex');
      await owner.$transaction(async (transaction) => {
        await setContext(transaction, {
          actorId: fixture.adminId,
          actorType: 'admin',
          storeId: BEAUTY_STORE_ID,
        });
        await transaction.$executeRaw`INSERT INTO after_sales
          (id, store_id, order_id, member_id, public_case_number, type, status, source,
            reason_code, policy_snapshot, policy_hash, policy_id, policy_version_id,
            legacy_policy_review,
            requested_item_vnd, requested_total_vnd, idempotency_key_hash, request_hash,
            initiated_by, correlation_id, updated_at)
          VALUES (${afterSaleId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${fixture.orderId}::uuid, ${fixture.memberId}::uuid,
            ${`ASC-${afterSaleId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
            'REFUND_ONLY', 'PENDING_REVIEW', 'ADMIN', 'item-approval-settlement-lock-order',
            ${fixture.casePolicyPayload}::jsonb, ${fixture.casePolicyPayloadHash},
            ${fixture.casePolicyId}::uuid, ${fixture.casePolicyVersionId}::uuid, false,
            50000, 50000,
            ${digest(`case-key-${afterSaleId}`)}, ${digest(`case-request-${afterSaleId}`)},
            ${fixture.adminId}::uuid, ${`m62-${afterSaleId}`}, now())`;
        await transaction.$executeRaw`INSERT INTO after_sale_items
          (id, store_id, after_sale_id, order_id, order_item_id, requested_quantity,
            requested_item_vnd, sku_id, product_id, brand_id, category_id, sku_code,
            product_name, option_snapshot, unit_price_vnd, updated_at)
          VALUES (${afterSaleItemId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${afterSaleId}::uuid, ${fixture.orderId}::uuid,
            ${fixture.orderItemId}::uuid, 1, 50000, ${fixture.skuId}::uuid,
            ${fixture.productId}::uuid, ${fixture.brandId}::uuid,
            ${BEAUTY_CATEGORY_ID}::uuid,
            ${`m62-sku-${fixture.skuId.slice(0, 8)}`}, 'M6.2 product',
            '{"size":"small"}'::jsonb, 50000, now())`;
        await transaction.$executeRaw`UPDATE after_sale_items
          SET approved_quantity = 1, approved_item_vnd = 50000, updated_at = now()
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${afterSaleItemId}::uuid`;
        await transaction.$executeRaw`UPDATE after_sales
          SET approved_item_vnd = 50000, approved_total_vnd = 50000, updated_at = now()
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${afterSaleId}::uuid`;
      });

      const results = await raceWithHeldAfterSaleRowLock(
        {
          actorId: fixture.adminId,
          afterSaleId,
          afterLock: (transaction) =>
            appendAfterSaleTransition(transaction, {
              actorId: fixture.adminId,
              afterSaleId,
              event: 'APPROVE',
              fromStatus: 'PENDING_REVIEW',
              toStatus: 'APPROVED',
            }),
        },
        (transaction) =>
          transaction.$executeRaw`INSERT INTO after_sale_settlements
            (id, store_id, after_sale_id, order_id, public_settlement_number, method,
              status, amount_vnd, idempotency_key_hash, request_hash, requested_by,
              transfer_reference_digest, transfer_evidence_ciphertext, updated_at)
            VALUES (${settlementId}::uuid, ${BEAUTY_STORE_ID}::uuid,
              ${afterSaleId}::uuid, ${fixture.orderId}::uuid,
              ${`AST-${settlementId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
              'COD_OFFLINE', 'PENDING', 50000,
              ${digest(`settlement-key-${settlementId}`)},
              ${digest(`settlement-request-${settlementId}`)}, ${fixture.adminId}::uuid,
              ${digest(`transfer-${settlementId}`)}, 'encrypted-test-evidence', now())`,
      );

      expect(results[0]).toMatchObject({ status: 'fulfilled' });
      expect(results[1]).toMatchObject({
        reason: { code: 'P2010', meta: { code: '23514' } },
        status: 'rejected',
      });
      expect(results[1]).not.toMatchObject({
        reason: { code: 'P2010', meta: { code: '40P01' } },
      });
      expect(
        await owner.$queryRaw<Array<{ allocation_count: bigint; status: string }>>`
          SELECT count(allocation.id)::bigint AS allocation_count, sale.status::text AS status
          FROM after_sales sale
          LEFT JOIN after_sale_order_allocations allocation
            ON allocation.store_id = sale.store_id AND allocation.after_sale_id = sale.id
          WHERE sale.store_id = ${BEAUTY_STORE_ID}::uuid AND sale.id = ${afterSaleId}::uuid
          GROUP BY sale.status`,
      ).toEqual([{ allocation_count: 0n, status: 'APPROVED' }]);
    });
  });

  it('serializes after-sale item capacity behind its aggregate lock', async () => {
    await withCommittedCommerceFixture(async (fixture) => {
      const afterSaleId = randomUUID();
      const firstAfterSaleItemId = randomUUID();
      const contenderAfterSaleItemId = randomUUID();
      const digest = (value: string) => createHash('sha256').update(value).digest('hex');
      await owner.$transaction(async (transaction) => {
        await setContext(transaction, {
          actorId: fixture.adminId,
          actorType: 'admin',
          storeId: BEAUTY_STORE_ID,
        });
        await transaction.$executeRaw`INSERT INTO after_sales
          (id, store_id, order_id, member_id, public_case_number, type, status, source,
            reason_code, policy_snapshot, policy_hash, policy_id, policy_version_id,
            legacy_policy_review,
            requested_item_vnd, requested_total_vnd, idempotency_key_hash, request_hash,
            initiated_by, correlation_id, updated_at)
          VALUES (${afterSaleId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${fixture.orderId}::uuid, ${fixture.memberId}::uuid,
            ${`ASC-${afterSaleId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
            'REFUND_ONLY', 'PENDING_REVIEW', 'ADMIN', 'item-lock-order',
            ${fixture.casePolicyPayload}::jsonb, ${fixture.casePolicyPayloadHash},
            ${fixture.casePolicyId}::uuid, ${fixture.casePolicyVersionId}::uuid, false,
            100000, 100000,
            ${digest(`case-key-${afterSaleId}`)}, ${digest(`case-request-${afterSaleId}`)},
            ${fixture.adminId}::uuid, ${`m62-${afterSaleId}`}, now())`;
      });

      const insertAfterSaleItem = (
        transaction: StoreTransaction,
        input: { afterSaleItemId: string; requestedItemVnd: number; requestedQuantity: number },
      ) =>
        transaction.$executeRaw`INSERT INTO after_sale_items
          (id, store_id, after_sale_id, order_id, order_item_id, requested_quantity,
            requested_item_vnd, sku_id, product_id, brand_id, category_id, sku_code,
            product_name, option_snapshot, unit_price_vnd, updated_at)
          VALUES (${input.afterSaleItemId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${afterSaleId}::uuid, ${fixture.orderId}::uuid, ${fixture.orderItemId}::uuid,
            ${input.requestedQuantity}, ${input.requestedItemVnd}, ${fixture.skuId}::uuid,
            ${fixture.productId}::uuid, ${fixture.brandId}::uuid,
            ${BEAUTY_CATEGORY_ID}::uuid,
            ${`m62-sku-${fixture.skuId.slice(0, 8)}`}, 'M6.2 product',
            '{"size":"small"}'::jsonb, 50000, now())`;

      const results = await raceWithHeldAfterSaleRowLock(
        {
          actorId: fixture.adminId,
          afterSaleId,
          afterLock: (transaction) =>
            insertAfterSaleItem(transaction, {
              afterSaleItemId: firstAfterSaleItemId,
              requestedItemVnd: 100_000,
              requestedQuantity: 2,
            }),
        },
        (transaction) =>
          insertAfterSaleItem(transaction, {
            afterSaleItemId: contenderAfterSaleItemId,
            requestedItemVnd: 50_000,
            requestedQuantity: 1,
          }),
      );

      expect(results[0]).toMatchObject({ status: 'fulfilled' });
      expect(results[1]).toMatchObject({
        reason: { code: 'P2010', meta: { code: '23514' } },
        status: 'rejected',
      });
      expect(
        await owner.$queryRaw<Array<{ requested_quantity: number }>>`
          SELECT requested_quantity
          FROM after_sale_items
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid
            AND id = ${firstAfterSaleItemId}::uuid`,
      ).toEqual([{ requested_quantity: 2 }]);
    });
  });

  it('rejects a snapshot that splices a policy to another policy version', async () => {
    await withOwnerRollback(async (transaction) => {
      const fixture = await createCommerceFixture(transaction, { withCasePolicy: false });
      const firstPolicy = await createPublishedPolicy(transaction, fixture, {
        activateDefault: true,
        code: `snapshot-a-${fixture.productId.slice(0, 8)}`,
      });
      const secondPolicy = await createPublishedPolicy(transaction, fixture, {
        code: `snapshot-b-${fixture.productId.slice(0, 8)}`,
      });

      await expectDatabaseFailure(
        transaction,
        () => transaction.$executeRaw`INSERT INTO order_item_after_sale_policy_snapshots
          (store_id, order_id, order_item_id, policy_id, policy_version_id, policy_code,
            policy_version_number, payload, payload_hash)
          VALUES (${BEAUTY_STORE_ID}::uuid, ${fixture.orderId}::uuid,
            ${fixture.orderItemId}::uuid, ${firstPolicy.policyId}::uuid,
            ${secondPolicy.policyVersionId}::uuid,
            ${`snapshot-a-${fixture.productId.slice(0, 8)}`}, 1,
            jsonb_build_object('return_window_days', 7,
              'return_shipping_payer', 'MERCHANT'),
            ${secondPolicy.payloadHash})`,
        '23514',
      );

      await expect(
        transaction.$executeRaw`INSERT INTO order_item_after_sale_policy_snapshots
          (store_id, order_id, order_item_id, policy_id, policy_version_id, policy_code,
            policy_version_number, payload, payload_hash)
          VALUES (${BEAUTY_STORE_ID}::uuid, ${fixture.orderId}::uuid,
            ${fixture.orderItemId}::uuid, ${firstPolicy.policyId}::uuid,
            ${firstPolicy.policyVersionId}::uuid,
            ${`snapshot-a-${fixture.productId.slice(0, 8)}`}, 1,
            jsonb_build_object('return_window_days', 7,
              'return_shipping_payer', 'MERCHANT'),
            ${firstPolicy.payloadHash})`,
      ).resolves.toBe(1);
    });
  });

  it('enforces order-item snapshots at deferred commit only after the store enables enforcement', async () => {
    await withOwnerRollback(async (transaction) => {
      const fixture = await createCommerceFixture(transaction, { withCasePolicy: false });
      const policy = await createPublishedPolicy(transaction, fixture, {
        activateDefault: true,
        code: `enforce-off-${fixture.productId.slice(0, 8)}`,
      });
      await transaction.$executeRaw`INSERT INTO store_after_sale_settings
        (store_id, enforce_policy_snapshots, default_policy_id, current_version_id,
          readiness_checked_at, readiness_ready_at, readiness_hash,
          readiness_checked_by, updated_at, updated_by)
        VALUES (${BEAUTY_STORE_ID}::uuid, false, ${policy.policyId}::uuid,
          ${policy.policyVersionId}::uuid, now(), now(),
          ${createHash('sha256').update(`readiness-${policy.policyId}`).digest('hex')},
          ${fixture.adminId}::uuid, now(), ${fixture.adminId}::uuid)
        ON CONFLICT (store_id) DO UPDATE SET
          enforce_policy_snapshots = false,
          default_policy_id = EXCLUDED.default_policy_id,
          current_version_id = EXCLUDED.current_version_id,
          readiness_checked_at = EXCLUDED.readiness_checked_at,
          readiness_ready_at = EXCLUDED.readiness_ready_at,
          readiness_hash = EXCLUDED.readiness_hash,
          readiness_checked_by = EXCLUDED.readiness_checked_by,
          updated_at = EXCLUDED.updated_at,
          updated_by = EXCLUDED.updated_by`;
      await expect(transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE')).resolves.toBe(0);
    });

    await expectSqlState(
      owner.$transaction(async (transaction) => {
        const fixture = await createCommerceFixture(transaction, { withCasePolicy: false });
        const policy = await createPublishedPolicy(transaction, fixture, {
          activateDefault: true,
          code: `enforce-on-missing-${fixture.productId.slice(0, 8)}`,
        });
        await transaction.$executeRaw`INSERT INTO store_after_sale_settings
          (store_id, enforce_policy_snapshots, default_policy_id, current_version_id,
            readiness_checked_at, readiness_ready_at, readiness_hash,
            readiness_checked_by, updated_at, updated_by)
          VALUES (${BEAUTY_STORE_ID}::uuid, true, ${policy.policyId}::uuid,
            ${policy.policyVersionId}::uuid, now(), now(),
            ${createHash('sha256').update(`readiness-${policy.policyId}`).digest('hex')},
            ${fixture.adminId}::uuid, now(), ${fixture.adminId}::uuid)
          ON CONFLICT (store_id) DO UPDATE SET
            enforce_policy_snapshots = true,
            default_policy_id = EXCLUDED.default_policy_id,
            current_version_id = EXCLUDED.current_version_id,
            readiness_checked_at = EXCLUDED.readiness_checked_at,
            readiness_ready_at = EXCLUDED.readiness_ready_at,
            readiness_hash = EXCLUDED.readiness_hash,
            readiness_checked_by = EXCLUDED.readiness_checked_by,
            updated_at = EXCLUDED.updated_at,
            updated_by = EXCLUDED.updated_by`;
        await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
      }),
      '23514',
    );

    await withOwnerRollback(async (transaction) => {
      const fixture = await createCommerceFixture(transaction, { withCasePolicy: false });
      const policyCode = `enforce-on-valid-${fixture.productId.slice(0, 8)}`;
      const policy = await createPublishedPolicy(transaction, fixture, {
        activateDefault: true,
        code: policyCode,
      });
      await transaction.$executeRaw`INSERT INTO order_item_after_sale_policy_snapshots
        (store_id, order_id, order_item_id, policy_id, policy_version_id, policy_code,
          policy_version_number, payload, payload_hash)
        VALUES (${BEAUTY_STORE_ID}::uuid, ${fixture.orderId}::uuid,
          ${fixture.orderItemId}::uuid, ${policy.policyId}::uuid,
          ${policy.policyVersionId}::uuid, ${policyCode}, 1,
          jsonb_build_object('return_window_days', 7,
            'return_shipping_payer', 'MERCHANT'), ${policy.payloadHash})`;
      await transaction.$executeRaw`INSERT INTO store_after_sale_settings
        (store_id, enforce_policy_snapshots, default_policy_id, current_version_id,
          readiness_checked_at, readiness_ready_at, readiness_hash,
          readiness_checked_by, updated_at, updated_by)
        VALUES (${BEAUTY_STORE_ID}::uuid, true, ${policy.policyId}::uuid,
          ${policy.policyVersionId}::uuid, now(), now(),
          ${createHash('sha256').update(`readiness-${policy.policyId}`).digest('hex')},
          ${fixture.adminId}::uuid, now(), ${fixture.adminId}::uuid)
        ON CONFLICT (store_id) DO UPDATE SET
          enforce_policy_snapshots = true,
          default_policy_id = EXCLUDED.default_policy_id,
          current_version_id = EXCLUDED.current_version_id,
          readiness_checked_at = EXCLUDED.readiness_checked_at,
          readiness_ready_at = EXCLUDED.readiness_ready_at,
          readiness_hash = EXCLUDED.readiness_hash,
          readiness_checked_by = EXCLUDED.readiness_checked_by,
          updated_at = EXCLUDED.updated_at,
          updated_by = EXCLUDED.updated_by`;
      await expect(transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE')).resolves.toBe(0);
    });
  });

  it('requires complete COD confirmation facts and caps cumulative settlements per case', async () => {
    await withOwnerRollback(async (transaction) => {
      const fixture = await createCommerceFixture(transaction, { orderPayableVnd: 100_000 });
      const { afterSaleId } = await createAfterSaleFixture(transaction, fixture, {
        approvedTotalVnd: 60_000,
      });
      const settlementId = randomUUID();
      const digest = (value: string) => createHash('sha256').update(value).digest('hex');

      const prematureSettlementId = randomUUID();
      await expectDatabaseFailure(
        transaction,
        () => transaction.$executeRaw`INSERT INTO after_sale_settlements
          (id, store_id, after_sale_id, order_id, public_settlement_number, method,
            status, amount_vnd, idempotency_key_hash, request_hash, requested_by,
            transfer_reference_digest, transfer_evidence_ciphertext, updated_at)
          VALUES (${prematureSettlementId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${afterSaleId}::uuid, ${fixture.orderId}::uuid,
            ${`AST-${prematureSettlementId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
            'COD_OFFLINE', 'PENDING', 60000,
            ${digest(`premature-${prematureSettlementId}`)},
            ${digest(`premature-request-${prematureSettlementId}`)},
            ${fixture.adminId}::uuid, ${digest(`transfer-${prematureSettlementId}`)},
            'encrypted-test-evidence', now())`,
        '23514',
      );
      await appendAfterSaleTransition(transaction, {
        actorId: fixture.adminId,
        afterSaleId,
        event: 'QUEUE_REFUND',
        fromStatus: 'APPROVED',
        toStatus: 'REFUND_PENDING',
      });

      const nullDigestSettlementId = randomUUID();
      await expectDatabaseFailure(
        transaction,
        () => transaction.$executeRaw`INSERT INTO after_sale_settlements
          (id, store_id, after_sale_id, order_id, public_settlement_number, method,
            status, amount_vnd, idempotency_key_hash, request_hash, requested_by,
            transfer_reference_digest, transfer_evidence_ciphertext, updated_at)
          VALUES (${nullDigestSettlementId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${afterSaleId}::uuid, ${fixture.orderId}::uuid,
            ${`AST-${nullDigestSettlementId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
            'COD_OFFLINE', 'PENDING', 60000,
            ${digest(`null-digest-${nullDigestSettlementId}`)},
            ${digest(`null-digest-request-${nullDigestSettlementId}`)},
            ${fixture.adminId}::uuid, NULL, 'encrypted-test-evidence', now())`,
        '23514',
      );

      await expectDatabaseFailure(
        transaction,
        () => transaction.$executeRaw`INSERT INTO after_sale_settlements
          (id, store_id, after_sale_id, order_id, public_settlement_number, method,
            status, amount_vnd, idempotency_key_hash, request_hash, requested_by, updated_at)
          VALUES (${settlementId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${afterSaleId}::uuid,
            ${fixture.orderId}::uuid,
            ${`AST-${settlementId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
            'COD_OFFLINE', 'SUCCEEDED', 60000, ${digest(`missing-confirm-${settlementId}`)},
            ${digest(`missing-confirm-request-${settlementId}`)},
            ${fixture.adminId}::uuid, now())`,
        '23514',
      );

      await transaction.$executeRaw`INSERT INTO after_sale_settlements
          (id, store_id, after_sale_id, order_id, public_settlement_number, method,
            status, amount_vnd, idempotency_key_hash, request_hash, requested_by,
            transfer_reference_digest, transfer_evidence_ciphertext, updated_at)
          VALUES (${settlementId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${afterSaleId}::uuid,
            ${fixture.orderId}::uuid,
            ${`AST-${settlementId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
            'COD_OFFLINE', 'PENDING', 60000, ${digest(`confirmed-${settlementId}`)},
            ${digest(`confirmed-request-${settlementId}`)}, ${fixture.adminId}::uuid,
            ${digest(`transfer-${settlementId}`)}, 'encrypted-test-evidence', now())`;
      await expectDatabaseFailure(
        transaction,
        () => transaction.$executeRaw`UPDATE after_sale_settlements
          SET status = 'SUCCEEDED', confirmed_by = ${fixture.adminId}::uuid,
            confirmed_at = now(), completed_at = now(), version = version + 1,
            updated_at = now()
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${settlementId}::uuid`,
        '23514',
      );

      await setContext(transaction, {
        actorId: fixture.confirmingAdminId,
        actorType: 'admin',
        storeId: BEAUTY_STORE_ID,
      });
      await expect(
        transaction.$executeRaw`UPDATE after_sale_settlements
          SET status = 'SUCCEEDED', confirmed_by = ${fixture.confirmingAdminId}::uuid,
            confirmed_at = now(), completed_at = now(), version = version + 1,
            updated_at = now()
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${settlementId}::uuid`,
      ).resolves.toBe(1);
      expect(
        await transaction.$queryRaw`SELECT status, requested_by, confirmed_by, version
          FROM after_sale_settlements
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${settlementId}::uuid`,
      ).toEqual([
        {
          confirmed_by: fixture.confirmingAdminId,
          requested_by: fixture.adminId,
          status: 'SUCCEEDED',
          version: 2,
        },
      ]);

      const excessSettlementId = randomUUID();
      await setContext(transaction, {
        actorId: fixture.adminId,
        actorType: 'admin',
        storeId: BEAUTY_STORE_ID,
      });
      await expectDatabaseFailure(
        transaction,
        () => transaction.$executeRaw`INSERT INTO after_sale_settlements
          (id, store_id, after_sale_id, order_id, public_settlement_number, method,
            status, amount_vnd, idempotency_key_hash, request_hash, requested_by, updated_at)
          VALUES (${excessSettlementId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${afterSaleId}::uuid, ${fixture.orderId}::uuid,
            ${`AST-${excessSettlementId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
            'COD_OFFLINE', 'PENDING', 40000, ${digest(`excess-${excessSettlementId}`)},
            ${digest(`excess-request-${excessSettlementId}`)},
            ${fixture.adminId}::uuid, now())`,
        '23514',
      );
    });
  });

  it('binds privacy transition event and from-status to the current header projection', async () => {
    await withOwnerRollback(async (transaction) => {
      const fixture = await createCommerceFixture(transaction);
      const privacyRequestId = randomUUID();
      const digest = (value: string) => createHash('sha256').update(value).digest('hex');
      await transaction.$executeRaw`INSERT INTO privacy_requests
        (id, store_id, member_id, public_number, type, status, description_ciphertext,
          idempotency_key_hash, request_hash, updated_at)
        VALUES (${privacyRequestId}::uuid, ${BEAUTY_STORE_ID}::uuid,
          ${fixture.memberId}::uuid,
          ${`PRV-${privacyRequestId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
          'ACCESS', 'SUBMITTED', 'encrypted-test-description',
          ${digest(`privacy-key-${privacyRequestId}`)},
          ${digest(`privacy-request-${privacyRequestId}`)}, now())`;

      await setContext(transaction, {
        actorId: fixture.adminId,
        actorType: 'admin',
        storeId: BEAUTY_STORE_ID,
      });
      await expectDatabaseFailure(
        transaction,
        () => transaction.$executeRaw`INSERT INTO privacy_request_transitions
          (store_id, privacy_request_id, member_id, from_status, to_status, event,
            actor_type, actor_id, correlation_id)
          VALUES (${BEAUTY_STORE_ID}::uuid, ${privacyRequestId}::uuid,
            ${fixture.memberId}::uuid, 'SUBMITTED', 'UNDER_REVIEW', 'START_REVIEW',
            'MEMBER', ${fixture.memberId}::uuid, ${`m62-${randomUUID()}`})`,
        '42501',
      );
      await expectDatabaseFailure(
        transaction,
        () => transaction.$executeRaw`INSERT INTO privacy_request_transitions
          (store_id, privacy_request_id, member_id, from_status, to_status, event,
            actor_type, actor_id, correlation_id)
          VALUES (${BEAUTY_STORE_ID}::uuid, ${privacyRequestId}::uuid,
            ${fixture.memberId}::uuid, 'SUBMITTED', 'UNDER_REVIEW', 'START_REVIEW',
            'ADMIN', ${fixture.confirmingAdminId}::uuid, ${`m62-${randomUUID()}`})`,
        '42501',
      );

      await expectDatabaseFailure(
        transaction,
        () => transaction.$executeRaw`INSERT INTO privacy_request_transitions
          (store_id, privacy_request_id, member_id, from_status, to_status, event,
            actor_type, actor_id, correlation_id)
          VALUES (${BEAUTY_STORE_ID}::uuid, ${privacyRequestId}::uuid,
            ${fixture.memberId}::uuid, 'SUBMITTED', 'UNDER_REVIEW', 'COMPLETE',
            'ADMIN', ${fixture.adminId}::uuid, ${`m62-${randomUUID()}`})`,
        '23514',
      );
      await expectDatabaseFailure(
        transaction,
        () => transaction.$executeRaw`INSERT INTO privacy_request_transitions
          (store_id, privacy_request_id, member_id, from_status, to_status, event,
            actor_type, actor_id, correlation_id)
          VALUES (${BEAUTY_STORE_ID}::uuid, ${privacyRequestId}::uuid,
            ${fixture.memberId}::uuid, 'UNDER_REVIEW', 'IN_PROGRESS', 'START_FULFILLMENT',
            'ADMIN', ${fixture.adminId}::uuid, ${`m62-${randomUUID()}`})`,
        '23514',
      );
      expect(
        await transaction.$queryRaw`SELECT status, version FROM privacy_requests
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${privacyRequestId}::uuid`,
      ).toEqual([{ status: 'SUBMITTED', version: 1 }]);

      await expect(
        transaction.$executeRaw`INSERT INTO privacy_request_transitions
          (store_id, privacy_request_id, member_id, from_status, to_status, event,
            actor_type, actor_id, correlation_id)
          VALUES (${BEAUTY_STORE_ID}::uuid, ${privacyRequestId}::uuid,
            ${fixture.memberId}::uuid, 'SUBMITTED', 'UNDER_REVIEW', 'START_REVIEW',
            'ADMIN', ${fixture.adminId}::uuid, ${`m62-${randomUUID()}`})`,
      ).resolves.toBe(1);
      expect(
        await transaction.$queryRaw`SELECT status, version FROM privacy_requests
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${privacyRequestId}::uuid`,
      ).toEqual([{ status: 'UNDER_REVIEW', version: 2 }]);
    });
  });

  it('allows a queued evidence hold, rechecks deletion, and freezes deleted metadata', async () => {
    await withOwnerRollback(async (transaction) => {
      const fixture = await createCommerceFixture(transaction);
      const { afterSaleId } = await createAfterSaleFixture(transaction, fixture);
      const evidenceId = randomUUID();
      const objectKey = `test/beauty/staged/${evidenceId}`;
      await setContext(transaction, {
        actorId: fixture.adminId,
        actorType: 'admin',
        storeId: BEAUTY_STORE_ID,
      });
      await transaction.$executeRaw`INSERT INTO after_sale_evidence_files
        (id, store_id, member_id, upload_session_id, mime_type, byte_size,
          checksum_sha256, original_filename, updated_at)
        VALUES (${evidenceId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${fixture.memberId}::uuid,
          ${randomUUID()}::uuid, 'image/jpeg', 1024,
          ${createHash('sha256').update(`evidence-${evidenceId}`).digest('hex')},
          'evidence.jpg', now())`;
      await transaction.$executeRaw`UPDATE after_sale_evidence_files
        SET object_key = ${objectKey},
          derivative_object_keys = '["test/beauty/derivative"]'::jsonb,
          scan_temporary_object_key = 'test/beauty/scan', scan_result_code = 'CLEAN',
          claim_deadline_at = now() + interval '1 hour', status = 'READY_UNCLAIMED',
          version = version + 1, updated_at = now()
        WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${evidenceId}::uuid`;
      await setContext(transaction, {
        actorId: fixture.memberId,
        actorType: 'member',
        storeId: BEAUTY_STORE_ID,
      });
      await transaction.$executeRaw`UPDATE after_sale_evidence_files
        SET after_sale_id = ${afterSaleId}::uuid, status = 'READY',
          claimed_at = now() - interval '2 days',
          retention_deadline_at = now() - interval '1 day', version = version + 1,
          updated_at = now()
        WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${evidenceId}::uuid`;
      await setContext(transaction, {
        actorId: fixture.adminId,
        actorType: 'admin',
        storeId: BEAUTY_STORE_ID,
      });
      await transaction.$executeRaw`UPDATE after_sale_evidence_files
        SET status = 'DELETION_PENDING', version = version + 1, updated_at = now()
        WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${evidenceId}::uuid`;
      await expectDatabaseFailure(
        transaction,
        async () => {
          await transaction.$executeRaw`UPDATE after_sale_evidence_files
            SET status = 'DELETE_FAILED', delete_attempt_count = delete_attempt_count + 1,
              delete_error_code = 'OBJECT_DELETE_FAILED',
              next_delete_attempt_at = now() + interval '1 hour',
              version = version + 1, updated_at = now()
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${evidenceId}::uuid`;
          await transaction.$executeRaw`UPDATE after_sale_evidence_files
            SET status = 'DELETION_PENDING', delete_error_code = NULL,
              next_delete_attempt_at = NULL, version = version + 1, updated_at = now()
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${evidenceId}::uuid`;
        },
        '23514',
      );
      await expect(
        transaction.$executeRaw`UPDATE after_sale_evidence_files
          SET legal_hold_active = true, held_at = now(), held_by = ${fixture.adminId}::uuid,
            hold_reason = 'M6.2 legal hold regression', version = version + 1,
            updated_at = now()
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${evidenceId}::uuid`,
      ).resolves.toBe(1);

      await expectDatabaseFailure(
        transaction,
        () => transaction.$executeRaw`UPDATE after_sale_evidence_files
          SET status = 'DELETED', deleted_at = now(), version = version + 1,
            updated_at = now()
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${evidenceId}::uuid`,
        '23514',
      );
      await transaction.$executeRaw`UPDATE after_sale_evidence_files
        SET legal_hold_active = false, held_at = NULL, held_by = NULL, hold_reason = NULL,
          version = version + 1, updated_at = now()
        WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${evidenceId}::uuid`;
      await expectDatabaseFailure(
        transaction,
        () => transaction.$executeRaw`UPDATE after_sale_evidence_files
          SET status = 'DELETED', retention_deadline_at = now() + interval '1 hour',
            deleted_at = now(), version = version + 1, updated_at = now()
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${evidenceId}::uuid`,
        '23514',
      );

      await transaction.$executeRaw`UPDATE after_sale_evidence_files
        SET status = 'DELETED', object_key = NULL, derivative_object_keys = NULL,
          scan_temporary_object_key = NULL, scan_result_code = NULL,
          delete_error_code = NULL, deleted_at = now(), version = version + 1,
          updated_at = now()
        WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${evidenceId}::uuid`;
      await expectDatabaseFailure(
        transaction,
        () => transaction.$executeRaw`UPDATE after_sale_evidence_files
          SET delete_attempt_count = delete_attempt_count + 1, updated_at = now()
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${evidenceId}::uuid`,
        '42501',
      );
      expect(
        await transaction.$queryRaw`SELECT status, object_key, derivative_object_keys,
            scan_temporary_object_key
          FROM after_sale_evidence_files
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${evidenceId}::uuid`,
      ).toEqual([
        {
          derivative_object_keys: null,
          object_key: null,
          scan_temporary_object_key: null,
          status: 'DELETED',
        },
      ]);
    });
  });

  it('requires non-pending inspection allocations that exactly cover every approved item', async () => {
    await withOwnerRollback(async (transaction) => {
      const fixture = await createCommerceFixture(transaction);
      const { afterSaleId, afterSaleItemId } = await createAfterSaleFixture(transaction, fixture, {
        approvedTotalVnd: 100_000,
        type: 'EXCHANGE',
        withItem: true,
      });
      if (!afterSaleItemId) throw new Error('M6.2 after-sale item fixture was not created');
      await advanceAfterSaleToInspection(transaction, fixture, afterSaleId);

      await expectDatabaseFailure(
        transaction,
        async () => {
          const pendingInspectionId = randomUUID();
          await transaction.$executeRaw`INSERT INTO after_sale_inspections
            (id, store_id, after_sale_id, inspection_version, admin_id, reason)
            VALUES (${pendingInspectionId}::uuid, ${BEAUTY_STORE_ID}::uuid,
              ${afterSaleId}::uuid, 1, ${fixture.adminId}::uuid,
              'Pending allocation rejection')`;
          await transaction.$executeRaw`INSERT INTO after_sale_inspection_allocations
            (id, store_id, inspection_id, after_sale_id, after_sale_item_id,
              disposition, quantity)
            VALUES (${randomUUID()}::uuid, ${BEAUTY_STORE_ID}::uuid,
              ${pendingInspectionId}::uuid, ${afterSaleId}::uuid,
              ${afterSaleItemId}::uuid, 'PENDING', 2)`;
        },
        '23514',
      );

      await expectDatabaseFailure(
        transaction,
        async () => {
          await transaction.$executeRaw`INSERT INTO after_sale_inspections
            (id, store_id, after_sale_id, inspection_version, admin_id, reason)
            VALUES (${randomUUID()}::uuid, ${BEAUTY_STORE_ID}::uuid,
              ${afterSaleId}::uuid, 1, ${fixture.adminId}::uuid, 'Missing allocations')`;
          await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
        },
        '23514',
      );

      await expectDatabaseFailure(
        transaction,
        async () => {
          const partialInspectionId = randomUUID();
          await transaction.$executeRaw`INSERT INTO after_sale_inspections
            (id, store_id, after_sale_id, inspection_version, admin_id, reason)
            VALUES (${partialInspectionId}::uuid, ${BEAUTY_STORE_ID}::uuid,
              ${afterSaleId}::uuid, 1, ${fixture.adminId}::uuid, 'Partial allocation')`;
          await transaction.$executeRaw`INSERT INTO after_sale_inspection_allocations
            (id, store_id, inspection_id, after_sale_id, after_sale_item_id,
              disposition, quantity)
            VALUES (${randomUUID()}::uuid, ${BEAUTY_STORE_ID}::uuid,
              ${partialInspectionId}::uuid, ${afterSaleId}::uuid,
              ${afterSaleItemId}::uuid, 'RESTOCK_SELLABLE', 1)`;
          await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
        },
        '23514',
      );

      await createCompleteInspection(transaction, fixture, {
        afterSaleId,
        afterSaleItemId,
      });
      expect(
        await transaction.$queryRaw`SELECT received_quantity, restockable_quantity,
            inspection_version, inspected_by
          FROM after_sale_items
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${afterSaleItemId}::uuid`,
      ).toEqual([
        {
          inspected_by: fixture.adminId,
          inspection_version: 1,
          received_quantity: 2,
          restockable_quantity: 2,
        },
      ]);
    });
  });

  it('rejects inventory and exchange facts with mismatched SKU, warehouse, or quantity', async () => {
    await withOwnerRollback(async (transaction) => {
      const fixture = await createCommerceFixture(transaction);
      const { afterSaleId, afterSaleItemId } = await createAfterSaleFixture(transaction, fixture, {
        approvedTotalVnd: 100_000,
        type: 'EXCHANGE',
        withItem: true,
      });
      if (!afterSaleItemId) throw new Error('M6.2 after-sale item fixture was not created');
      await advanceAfterSaleToInspection(transaction, fixture, afterSaleId);
      await createCompleteInspection(transaction, fixture, { afterSaleId, afterSaleItemId });
      await appendAfterSaleTransition(transaction, {
        actorId: fixture.adminId,
        afterSaleId,
        event: 'ACCEPT_INSPECTION',
        fromStatus: 'INSPECTION_PENDING',
        toStatus: 'EXCHANGE_PENDING',
      });
      const alternateWarehouseId = randomUUID();
      await transaction.$executeRaw`INSERT INTO warehouses
        (id, store_id, code, enabled, updated_at)
        VALUES (${alternateWarehouseId}::uuid, ${BEAUTY_STORE_ID}::uuid,
          ${`m62-warehouse-${alternateWarehouseId.slice(0, 8)}`}, true, now())`;

      const expectedBalanceId = randomUUID();
      const wrongSkuBalanceId = randomUUID();
      const wrongWarehouseBalanceId = randomUUID();
      await transaction.$executeRaw`INSERT INTO inventory_balances
        (id, store_id, warehouse_id, sku_id, on_hand, reserved, updated_at)
        VALUES
          (${expectedBalanceId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${BEAUTY_WAREHOUSE_ID}::uuid, ${fixture.skuId}::uuid, 10, 2, now()),
          (${wrongSkuBalanceId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${BEAUTY_WAREHOUSE_ID}::uuid, ${fixture.alternateSkuId}::uuid, 10, 0, now()),
          (${wrongWarehouseBalanceId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${alternateWarehouseId}::uuid, ${fixture.skuId}::uuid, 10, 2, now())`;

      async function createRestoreFact(input: {
        balanceId: string;
        quantity: number;
        skuId: string;
        warehouseId: string;
        onHandBefore?: number;
      }): Promise<string> {
        const operationId = randomUUID();
        const movementId = randomUUID();
        const resultSnapshot = JSON.stringify({
          items: [
            {
              quantity: input.quantity,
              sku_id: input.skuId,
              warehouse_id: input.warehouseId,
            },
          ],
          operation_id: operationId,
          source_id: afterSaleItemId,
          source_type: 'AFTER_SALE_RESTORE',
        });
        await transaction.$executeRaw`INSERT INTO inventory_operations
          (id, store_id, operation_key, request_hash, operation_type, result_snapshot,
            source_type, source_id)
          VALUES (${operationId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${`m62-restore-${operationId}`},
            ${createHash('sha256').update(`restore-${operationId}`).digest('hex')},
            'RESTORE', ${resultSnapshot}::jsonb, 'AFTER_SALE_RESTORE',
            ${afterSaleItemId}::uuid)`;
        await transaction.$executeRaw`INSERT INTO inventory_movements
          (id, store_id, balance_id, operation_id, movement_type, on_hand_before,
            on_hand_after, on_hand_delta, reserved_before, reserved_after,
            reserved_delta, reason_code)
          VALUES (${movementId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${input.balanceId}::uuid,
            ${operationId}::uuid, 'RESTORE', ${input.onHandBefore ?? 10},
            ${(input.onHandBefore ?? 10) + input.quantity},
            ${input.quantity}, 0, 0, 0, 'AFTER_SALE_RESTORE')`;
        return operationId;
      }

      async function createConsumedOrderReservation(input: {
        balanceId: string;
        warehouseId: string;
      }): Promise<string> {
        const reservationId = randomUUID();
        const reservationItemId = randomUUID();
        const reserveOperationId = randomUUID();
        const consumeOperationId = randomUUID();
        const reservationKey = `m62-order-${reservationId}`;
        const terminalAt = new Date();
        const reserveSnapshot = JSON.stringify({
          items: [
            {
              quantity: 2,
              sku_id: fixture.skuId,
              warehouse_id: input.warehouseId,
            },
          ],
          operation_id: reserveOperationId,
          reservation_id: reservationId,
          status: 'ACTIVE',
          terminal_at: null,
        });
        const consumeSnapshot = JSON.stringify({
          operation_id: consumeOperationId,
          reservation_id: reservationId,
          status: 'CONSUMED',
          terminal_at: terminalAt.toISOString(),
        });
        await transaction.$executeRaw`INSERT INTO inventory_operations
          (id, store_id, operation_key, request_hash, operation_type, result_snapshot)
          VALUES (${reserveOperationId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${reservationKey},
            ${createHash('sha256').update(`reserve-${reservationId}`).digest('hex')},
            'RESERVE', ${reserveSnapshot}::jsonb)`;
        await transaction.$executeRaw`INSERT INTO inventory_reservations
          (id, store_id, reservation_key, expires_at, source_type, source_id)
          VALUES (${reservationId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${reservationKey},
            now() + interval '1 hour', 'ORDER', ${fixture.orderId}::uuid)`;
        await transaction.$executeRaw`INSERT INTO inventory_reservation_items
          (id, store_id, reservation_id, warehouse_id, sku_id, quantity)
          VALUES (${reservationItemId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${reservationId}::uuid, ${input.warehouseId}::uuid, ${fixture.skuId}::uuid, 2)`;
        await transaction.$executeRaw`INSERT INTO inventory_operations
          (id, store_id, operation_key, request_hash, operation_type, result_snapshot)
          VALUES (${consumeOperationId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${`m62-consume-${consumeOperationId}`},
            ${createHash('sha256').update(`consume-${reservationId}`).digest('hex')},
            'CONSUME', ${consumeSnapshot}::jsonb)`;
        await transaction.$executeRaw`UPDATE inventory_balances
          SET on_hand = 8, reserved = 0, version = version + 1, updated_at = ${terminalAt}
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${input.balanceId}::uuid`;
        await transaction.$executeRaw`INSERT INTO inventory_movements
          (id, store_id, balance_id, operation_id, reservation_item_id, movement_type,
            on_hand_before, on_hand_after, on_hand_delta, reserved_before,
            reserved_after, reserved_delta, reason_code, created_at)
          VALUES (${randomUUID()}::uuid, ${BEAUTY_STORE_ID}::uuid, ${input.balanceId}::uuid,
            ${consumeOperationId}::uuid, ${reservationItemId}::uuid, 'CONSUME',
            10, 8, -2, 2, 0, -2, 'RESERVATION_CONSUMED', ${terminalAt})`;
        await transaction.$executeRaw`UPDATE inventory_reservations
          SET status = 'CONSUMED', terminal_operation_id = ${consumeOperationId}::uuid,
            terminal_at = ${terminalAt}
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${reservationId}::uuid`;
        await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
        await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL DEFERRED');
        return reservationId;
      }

      const wrongSkuOperationId = await createRestoreFact({
        balanceId: wrongSkuBalanceId,
        quantity: 2,
        skuId: fixture.alternateSkuId,
        warehouseId: BEAUTY_WAREHOUSE_ID,
      });
      const wrongWarehouseOperationId = await createRestoreFact({
        balanceId: wrongWarehouseBalanceId,
        quantity: 2,
        skuId: fixture.skuId,
        warehouseId: alternateWarehouseId,
      });
      const wrongQuantityOperationId = await createRestoreFact({
        balanceId: expectedBalanceId,
        quantity: 1,
        skuId: fixture.skuId,
        warehouseId: BEAUTY_WAREHOUSE_ID,
      });
      const validOperationId = await createRestoreFact({
        balanceId: expectedBalanceId,
        quantity: 2,
        skuId: fixture.skuId,
        warehouseId: BEAUTY_WAREHOUSE_ID,
        onHandBefore: 8,
      });

      async function insertInventoryAction(inventoryOperationId: string): Promise<unknown> {
        return transaction.$executeRaw`INSERT INTO after_sale_inventory_actions
          (id, store_id, after_sale_id, after_sale_item_id, order_id,
            inspection_version, warehouse_id, sku_id, disposition, action_type,
            quantity, inventory_operation_id)
          VALUES (${randomUUID()}::uuid, ${BEAUTY_STORE_ID}::uuid, ${afterSaleId}::uuid,
            ${afterSaleItemId}::uuid, ${fixture.orderId}::uuid, 1,
            ${BEAUTY_WAREHOUSE_ID}::uuid, ${fixture.skuId}::uuid,
            'RESTOCK_SELLABLE', 'RESTOCK_SELLABLE', 2, ${inventoryOperationId}::uuid)`;
      }
      await createConsumedOrderReservation({
        balanceId: wrongWarehouseBalanceId,
        warehouseId: alternateWarehouseId,
      });
      await expectDatabaseFailure(
        transaction,
        () => insertInventoryAction(validOperationId),
        '23514',
      );
      const orderReservationId = await createConsumedOrderReservation({
        balanceId: expectedBalanceId,
        warehouseId: BEAUTY_WAREHOUSE_ID,
      });
      await transaction.$executeRaw`UPDATE orders
        SET reservation_id = ${orderReservationId}::uuid, updated_at = now()
        WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${fixture.orderId}::uuid`;
      for (const invalidOperationId of [
        wrongSkuOperationId,
        wrongWarehouseOperationId,
        wrongQuantityOperationId,
      ]) {
        await expectDatabaseFailure(
          transaction,
          () => insertInventoryAction(invalidOperationId),
          '23514',
        );
      }
      await expect(insertInventoryAction(validOperationId)).resolves.toBe(1);

      async function createExchangeReservation(input: {
        quantity: number;
        skuId: string;
        warehouseId: string;
      }): Promise<string> {
        const reservationId = randomUUID();
        const reservationItemId = randomUUID();
        const operationId = randomUUID();
        const reservationKey = `m62-exchange-${reservationId}`;
        const resultSnapshot = JSON.stringify({
          items: [
            {
              quantity: input.quantity,
              sku_id: input.skuId,
              warehouse_id: input.warehouseId,
            },
          ],
          operation_id: operationId,
          reservation_id: reservationId,
          status: 'ACTIVE',
          terminal_at: null,
        });
        await transaction.$executeRaw`INSERT INTO inventory_operations
          (id, store_id, operation_key, request_hash, operation_type, result_snapshot)
          VALUES (${operationId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${reservationKey},
            ${createHash('sha256').update(`reserve-${reservationId}`).digest('hex')},
            'RESERVE', ${resultSnapshot}::jsonb)`;
        await transaction.$executeRaw`INSERT INTO inventory_reservations
          (id, store_id, reservation_key, expires_at, source_type, source_id)
          VALUES (${reservationId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${reservationKey},
            now() + interval '1 hour', 'AFTER_SALE_EXCHANGE', ${afterSaleId}::uuid)`;
        await transaction.$executeRaw`INSERT INTO inventory_reservation_items
          (id, store_id, reservation_id, warehouse_id, sku_id, quantity)
          VALUES (${reservationItemId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${reservationId}::uuid, ${input.warehouseId}::uuid,
            ${input.skuId}::uuid, ${input.quantity})`;
        return reservationId;
      }

      const wrongSkuReservationId = await createExchangeReservation({
        quantity: 2,
        skuId: fixture.alternateSkuId,
        warehouseId: BEAUTY_WAREHOUSE_ID,
      });
      const wrongWarehouseReservationId = await createExchangeReservation({
        quantity: 2,
        skuId: fixture.replacementSkuId,
        warehouseId: alternateWarehouseId,
      });
      const wrongQuantityReservationId = await createExchangeReservation({
        quantity: 1,
        skuId: fixture.replacementSkuId,
        warehouseId: BEAUTY_WAREHOUSE_ID,
      });
      const validReservationId = await createExchangeReservation({
        quantity: 2,
        skuId: fixture.replacementSkuId,
        warehouseId: BEAUTY_WAREHOUSE_ID,
      });

      async function insertPendingExchangeFulfillment(fulfillmentId: string): Promise<void> {
        await transaction.$executeRaw`INSERT INTO exchange_fulfillments
          (id, store_id, after_sale_id, after_sale_item_id, order_id, product_id,
            replacement_sku_id, warehouse_id, updated_at)
          VALUES (${fulfillmentId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${afterSaleId}::uuid,
            ${afterSaleItemId}::uuid, ${fixture.orderId}::uuid, ${fixture.productId}::uuid,
            ${fixture.replacementSkuId}::uuid, ${BEAUTY_WAREHOUSE_ID}::uuid,
            now())`;
      }
      async function reserveExchangeFulfillment(
        fulfillmentId: string,
        reservationId: string,
      ): Promise<unknown> {
        return transaction.$executeRaw`UPDATE exchange_fulfillments
          SET reservation_id = ${reservationId}::uuid, status = 'RESERVED',
            reserved_at = now(), version = version + 1, updated_at = now()
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${fulfillmentId}::uuid`;
      }
      for (const invalidReservationId of [
        wrongSkuReservationId,
        wrongWarehouseReservationId,
        wrongQuantityReservationId,
      ]) {
        await expectDatabaseFailure(
          transaction,
          async () => {
            const invalidFulfillmentId = randomUUID();
            await insertPendingExchangeFulfillment(invalidFulfillmentId);
            await reserveExchangeFulfillment(invalidFulfillmentId, invalidReservationId);
          },
          '23514',
        );
      }
      const fulfillmentId = randomUUID();
      await insertPendingExchangeFulfillment(fulfillmentId);
      await expectDatabaseFailure(
        transaction,
        () => transaction.$executeRaw`UPDATE exchange_fulfillments
          SET status = 'RESERVED', reserved_at = now(), version = version + 1,
            updated_at = now()
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${fulfillmentId}::uuid`,
        '23514',
      );
      await expect(reserveExchangeFulfillment(fulfillmentId, validReservationId)).resolves.toBe(1);
      await expectDatabaseFailure(
        transaction,
        () => transaction.$executeRaw`UPDATE exchange_fulfillments
          SET reservation_id = NULL, status = 'PENDING', reserved_at = NULL,
            version = version + 1, updated_at = now()
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${fulfillmentId}::uuid`,
        '23514',
      );
      expect(
        await transaction.$queryRaw`SELECT status, reservation_id, version
          FROM exchange_fulfillments
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${fulfillmentId}::uuid`,
      ).toEqual([{ reservation_id: validReservationId, status: 'RESERVED', version: 2 }]);
      await expect(transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE')).resolves.toBe(0);
    });
  });

  it('prevents exchange side effects after the case converts to a refund', async () => {
    await withOwnerRollback(async (transaction) => {
      const fixture = await createCommerceFixture(transaction);
      const { afterSaleId, afterSaleItemId } = await createAfterSaleFixture(transaction, fixture, {
        approvedTotalVnd: 100_000,
        type: 'EXCHANGE',
        withItem: true,
      });
      if (!afterSaleItemId) throw new Error('M6.2 after-sale item fixture was not created');
      await advanceAfterSaleToInspection(transaction, fixture, afterSaleId);
      await createCompleteInspection(transaction, fixture, { afterSaleId, afterSaleItemId });
      await appendAfterSaleTransition(transaction, {
        actorId: fixture.adminId,
        afterSaleId,
        event: 'ACCEPT_INSPECTION',
        fromStatus: 'INSPECTION_PENDING',
        toStatus: 'EXCHANGE_PENDING',
      });

      const fulfillmentId = randomUUID();
      await transaction.$executeRaw`INSERT INTO exchange_fulfillments
        (id, store_id, after_sale_id, after_sale_item_id, order_id, product_id,
          replacement_sku_id, warehouse_id, updated_at)
        VALUES (${fulfillmentId}::uuid, ${BEAUTY_STORE_ID}::uuid,
          ${afterSaleId}::uuid, ${afterSaleItemId}::uuid, ${fixture.orderId}::uuid,
          ${fixture.productId}::uuid, ${fixture.replacementSkuId}::uuid,
          ${BEAUTY_WAREHOUSE_ID}::uuid, now())`;
      await appendAfterSaleTransition(transaction, {
        actorId: fixture.adminId,
        afterSaleId,
        event: 'CONVERT_EXCHANGE_TO_REFUND',
        fromStatus: 'EXCHANGE_PENDING',
        toStatus: 'REFUND_PENDING',
      });

      const reservationId = randomUUID();
      const reservationItemId = randomUUID();
      const reserveOperationId = randomUUID();
      const reservationKey = `m62-post-conversion-${reservationId}`;
      const reserveSnapshot = JSON.stringify({
        items: [
          {
            quantity: 2,
            sku_id: fixture.replacementSkuId,
            warehouse_id: BEAUTY_WAREHOUSE_ID,
          },
        ],
        operation_id: reserveOperationId,
        reservation_id: reservationId,
        status: 'ACTIVE',
        terminal_at: null,
      });
      await transaction.$executeRaw`INSERT INTO inventory_operations
        (id, store_id, operation_key, request_hash, operation_type, result_snapshot)
        VALUES (${reserveOperationId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${reservationKey},
          ${createHash('sha256').update(`reserve-${reservationId}`).digest('hex')},
          'RESERVE', ${reserveSnapshot}::jsonb)`;
      await transaction.$executeRaw`INSERT INTO inventory_reservations
        (id, store_id, reservation_key, expires_at, source_type, source_id)
        VALUES (${reservationId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${reservationKey},
          now() + interval '1 hour', 'AFTER_SALE_EXCHANGE', ${afterSaleId}::uuid)`;
      await transaction.$executeRaw`INSERT INTO inventory_reservation_items
        (id, store_id, reservation_id, warehouse_id, sku_id, quantity)
        VALUES (${reservationItemId}::uuid, ${BEAUTY_STORE_ID}::uuid,
          ${reservationId}::uuid, ${BEAUTY_WAREHOUSE_ID}::uuid,
          ${fixture.replacementSkuId}::uuid, 2)`;
      await expectDatabaseFailure(
        transaction,
        () => transaction.$executeRaw`UPDATE exchange_fulfillments
          SET reserved_at = now(), shipped_at = now(), delivered_at = now(),
            version = version + 1, updated_at = now()
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${fulfillmentId}::uuid`,
        '23514',
      );
      await expectDatabaseFailure(
        transaction,
        () => transaction.$executeRaw`UPDATE exchange_fulfillments
          SET reservation_id = ${reservationId}::uuid, status = 'RESERVED',
            reserved_at = now(), version = version + 1, updated_at = now()
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${fulfillmentId}::uuid`,
        '23514',
      );
      await expect(transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE')).resolves.toBe(0);
    });
  });

  it('uses globally unique public case and settlement numbers', async () => {
    const publicNumberIndexes = await owner.$queryRawUnsafe<
      Array<{ column_name: string; has_global_unique_index: boolean; table_name: string }>
    >(`
      SELECT
        expected.table_name,
        expected.column_name,
        EXISTS (
          SELECT 1
          FROM pg_index index_record
          WHERE index_record.indrelid = expected.table_name::regclass
            AND index_record.indisunique
            AND index_record.indpred IS NULL
            AND (
              SELECT array_agg(attribute.attname ORDER BY key_column.ordinality)
              FROM unnest(index_record.indkey) WITH ORDINALITY key_column(attnum, ordinality)
              JOIN pg_attribute attribute
                ON attribute.attrelid = index_record.indrelid
                AND attribute.attnum = key_column.attnum
              WHERE key_column.attnum > 0
            ) = ARRAY[expected.column_name]::name[]
        ) AS has_global_unique_index
      FROM (VALUES
        ('after_sales', 'public_case_number'),
        ('after_sale_settlements', 'public_settlement_number'),
        ('privacy_requests', 'public_number'),
        ('share_links', 'short_code')
      ) AS expected(table_name, column_name)
      ORDER BY expected.table_name
    `);
    expect(
      publicNumberIndexes.every(({ has_global_unique_index }) => has_global_unique_index),
    ).toBe(true);
  });

  it('links an online settlement only to the exact M5 order, payment, refund and amount', async () => {
    await withOwnerRollback(async (transaction) => {
      const fixture = await createCommerceFixture(transaction, { paymentMethod: 'ONLINE' });
      const { adminId, orderId } = fixture;
      const paymentId = randomUUID();
      const refundId = randomUUID();
      const settlementId = randomUUID();
      const appId = `m62-app-${randomUUID()}`;
      const digest = (value: string) => createHash('sha256').update(value).digest('hex');

      await setContext(transaction, {
        actorId: adminId,
        actorType: 'admin',
        storeId: BEAUTY_STORE_ID,
      });
      await transaction.$executeRaw`INSERT INTO store_zalo_apps
        (store_id, environment, mini_app_id, enabled, updated_at)
        VALUES (${BEAUTY_STORE_ID}::uuid, 'STAGING', ${appId}, false, now())`;
      const channelId = randomUUID();
      await transaction.$executeRaw`INSERT INTO store_payment_channels
        (id, store_id, deployment_environment, provider_environment, provider_code,
          method_code, checkout_app_id, merchant_reference, private_key_secret_ref,
          secret_fingerprint, key_version, status, payment_window_seconds, updated_at)
        VALUES (${channelId}::uuid, ${BEAUTY_STORE_ID}::uuid, 'STAGING', 'SANDBOX',
          'ZALO_CHECKOUT_ZALOPAY', 'ZALOPAY_SANDBOX', ${appId}, 'm62-merchant',
          ${`test://m62/${channelId}`}, ${digest(`secret-${channelId}`)}, 'test-v1',
          'DISABLED', 900, now())`;
      await transaction.$executeRaw`INSERT INTO payment_attempts
        (id, store_id, order_id, channel_id, public_payment_number, attempt_sequence,
          amount_vnd, currency, status, expires_at, provider_order_id,
          provider_transaction_id, succeeded_at, create_idempotency_key_hash,
          correlation_id, updated_at)
        VALUES (${paymentId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${orderId}::uuid,
          ${channelId}::uuid, ${`PAY-M62-${paymentId.slice(0, 16)}`}, 1, 100000,
          'VND', 'SUCCEEDED', now() + interval '1 hour', ${`po-${paymentId}`},
          ${`pt-${paymentId}`}, now(), ${digest(`payment-${paymentId}`)},
          ${`m62-${paymentId}`}, now())`;
      await transaction.$executeRaw`INSERT INTO refunds
        (id, store_id, order_id, payment_attempt_id, public_refund_number, amount_vnd,
          status, reason, requested_by, idempotency_key_hash, updated_at)
        VALUES (${refundId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${orderId}::uuid,
          ${paymentId}::uuid, ${`RFD-M62-${refundId.slice(0, 16)}`}, 60000,
          'REQUESTED', 'M6.2 exact refund-link fixture', ${adminId}::uuid,
          ${digest(`refund-${refundId}`)}, now())`;
      const { afterSaleId } = await createAfterSaleFixture(transaction, fixture, {
        approvedTotalVnd: 60_000,
      });
      await appendAfterSaleTransition(transaction, {
        actorId: adminId,
        afterSaleId,
        event: 'QUEUE_REFUND',
        fromStatus: 'APPROVED',
        toStatus: 'REFUND_PENDING',
      });
      await transaction.$executeRaw`INSERT INTO after_sale_settlements
        (id, store_id, after_sale_id, order_id, payment_attempt_id,
          public_settlement_number, method, status, amount_vnd, currency,
          idempotency_key_hash, request_hash, requested_by, updated_at)
        VALUES (${settlementId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${afterSaleId}::uuid,
          ${orderId}::uuid, ${paymentId}::uuid,
          ${`AST-${settlementId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
          'ONLINE_ORIGINAL', 'PENDING', 60000, 'VND',
          ${digest(`settlement-key-${settlementId}`)},
          ${digest(`settlement-request-${settlementId}`)}, ${adminId}::uuid, now())`;

      await expectDatabaseFailure(
        transaction,
        () => transaction.$executeRaw`UPDATE after_sale_settlements
          SET status = 'PROCESSING', version = version + 1, updated_at = now()
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${settlementId}::uuid`,
        '23514',
      );

      await expectDatabaseFailure(
        transaction,
        () => transaction.$executeRaw`INSERT INTO after_sale_refunds
          (store_id, settlement_id, after_sale_id, order_id, payment_attempt_id,
            refund_id, amount_vnd)
          VALUES (${BEAUTY_STORE_ID}::uuid, ${settlementId}::uuid,
            ${afterSaleId}::uuid, ${orderId}::uuid, ${paymentId}::uuid,
            ${refundId}::uuid, 59999)`,
      );
      await expect(
        transaction.$executeRaw`INSERT INTO after_sale_refunds
          (store_id, settlement_id, after_sale_id, order_id, payment_attempt_id,
            refund_id, amount_vnd)
          VALUES (${BEAUTY_STORE_ID}::uuid, ${settlementId}::uuid,
            ${afterSaleId}::uuid, ${orderId}::uuid, ${paymentId}::uuid,
            ${refundId}::uuid, 60000)`,
      ).resolves.toBe(1);
      await expect(
        transaction.$executeRaw`UPDATE after_sale_settlements
          SET status = 'PROCESSING', version = version + 1, updated_at = now()
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${settlementId}::uuid`,
      ).resolves.toBe(1);
      await transaction.$executeRaw`UPDATE refunds
        SET status = 'SUCCEEDED', succeeded_at = now(), version = version + 1,
          updated_at = now()
        WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${refundId}::uuid`;
      await transaction.$executeRaw`INSERT INTO refund_transitions
        (store_id, refund_id, from_status, to_status, event, source, actor_type,
          actor_id, correlation_id)
        VALUES (${BEAUTY_STORE_ID}::uuid, ${refundId}::uuid, 'REQUESTED', 'SUCCEEDED',
          'REFUND_SUCCEEDED', 'ADMIN', 'ADMIN', ${adminId}::uuid,
          ${`m62-${randomUUID()}`})`;
      await expect(
        transaction.$executeRaw`UPDATE after_sale_settlements
          SET status = 'SUCCEEDED', completed_at = now(), version = version + 1,
            updated_at = now()
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${settlementId}::uuid`,
      ).resolves.toBe(1);
      expect(
        await transaction.$queryRaw`SELECT status, completed_at IS NOT NULL AS completed,
            version
          FROM after_sale_settlements
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${settlementId}::uuid`,
      ).toEqual([{ completed: true, status: 'SUCCEEDED', version: 3 }]);
    });
  });

  it('binds every non-legacy case line to one immutable policy identity', async () => {
    await withOwnerRollback(async (transaction) => {
      const fixture = await createCommerceFixture(transaction);
      const secondProductId = randomUUID();
      const secondSkuId = randomUUID();
      const secondOrderItemId = randomUUID();
      const afterSaleId = randomUUID();
      const firstAfterSaleItemId = randomUUID();
      const digest = (value: string) => createHash('sha256').update(value).digest('hex');

      await transaction.$executeRaw`INSERT INTO products
        (id, store_id, code, brand_id, main_category_id, updated_at)
        VALUES (${secondProductId}::uuid, ${BEAUTY_STORE_ID}::uuid,
          ${`m63-b0-product-${secondProductId.slice(0, 8)}`}, ${fixture.brandId}::uuid,
          ${BEAUTY_CATEGORY_ID}::uuid, now())`;
      await transaction.$executeRaw`INSERT INTO skus
        (id, store_id, product_id, code, sale_price_vnd, option_combination_key,
          option_combination_hash, updated_at)
        VALUES (${secondSkuId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${secondProductId}::uuid,
          ${`m63-b0-sku-${secondSkuId.slice(0, 8)}`}, 50000, 'size=second',
          ${digest(`m63-b0-sku-${secondSkuId}`)}, now())`;
      await transaction.$executeRaw`UPDATE orders
        SET base_subtotal_vnd = 150000, payable_vnd = 150000, updated_at = now()
        WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${fixture.orderId}::uuid`;
      await transaction.$executeRaw`INSERT INTO order_items
        (id, store_id, order_id, sku_id, product_id, brand_id, category_id, sku_code,
          product_name, brand_name, option_snapshot, unit_price_vnd, quantity,
          subtotal_vnd, payable_vnd)
        VALUES (${secondOrderItemId}::uuid, ${BEAUTY_STORE_ID}::uuid,
          ${fixture.orderId}::uuid, ${secondSkuId}::uuid, ${secondProductId}::uuid,
          ${fixture.brandId}::uuid, ${BEAUTY_CATEGORY_ID}::uuid,
          ${`m63-b0-sku-${secondSkuId.slice(0, 8)}`}, 'M6.3 B0 second product',
          'M6.2 brand', '{"size":"second"}'::jsonb, 50000, 1, 50000, 50000)`;

      const secondPolicy = await createPublishedPolicy(transaction, fixture, {
        activateDefault: true,
        code: `m63-b0-second-${secondProductId.slice(0, 8)}`,
      });
      await transaction.$executeRaw`INSERT INTO order_item_after_sale_policy_snapshots
        (store_id, order_id, order_item_id, policy_id, policy_version_id, policy_code,
          policy_version_number, payload, payload_hash)
        VALUES (${BEAUTY_STORE_ID}::uuid, ${fixture.orderId}::uuid,
          ${secondOrderItemId}::uuid, ${secondPolicy.policyId}::uuid,
          ${secondPolicy.policyVersionId}::uuid,
          ${`m63-b0-second-${secondProductId.slice(0, 8)}`}, 1,
          jsonb_build_object('return_window_days', 7,
            'return_shipping_payer', 'MERCHANT'), ${secondPolicy.payloadHash})`;

      await setContext(transaction, {
        actorId: fixture.adminId,
        actorType: 'admin',
        storeId: BEAUTY_STORE_ID,
      });
      const crossStoreAfterSaleId = randomUUID();
      await expectDatabaseFailure(
        transaction,
        () => transaction.$executeRaw`INSERT INTO after_sales
          (id, store_id, order_id, member_id, public_case_number, type, status, source,
            reason_code, policy_snapshot, policy_hash, policy_id, policy_version_id,
            legacy_policy_review, idempotency_key_hash, request_hash, initiated_by,
            correlation_id, updated_at)
          VALUES (${crossStoreAfterSaleId}::uuid, ${FASHION_STORE_ID}::uuid,
            ${fixture.orderId}::uuid, ${fixture.memberId}::uuid,
            ${`ASC-${crossStoreAfterSaleId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
            'REFUND_ONLY', 'PENDING_REVIEW', 'ADMIN', 'm63-b0-cross-store-policy',
            ${fixture.casePolicyPayload}::jsonb, ${fixture.casePolicyPayloadHash},
            ${fixture.casePolicyId}::uuid, ${fixture.casePolicyVersionId}::uuid, false,
            ${digest(`case-key-${crossStoreAfterSaleId}`)},
            ${digest(`case-request-${crossStoreAfterSaleId}`)}, ${fixture.adminId}::uuid,
            ${`m63-b0-${crossStoreAfterSaleId}`}, now())`,
        '42501',
      );
      await transaction.$executeRaw`INSERT INTO after_sales
        (id, store_id, order_id, member_id, public_case_number, type, status, source,
          reason_code, policy_snapshot, policy_hash, policy_id, policy_version_id,
          legacy_policy_review, requested_item_vnd, requested_total_vnd,
          idempotency_key_hash, request_hash, initiated_by, correlation_id, updated_at)
        VALUES (${afterSaleId}::uuid, ${BEAUTY_STORE_ID}::uuid,
          ${fixture.orderId}::uuid, ${fixture.memberId}::uuid,
          ${`ASC-${afterSaleId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
          'REFUND_ONLY', 'PENDING_REVIEW', 'ADMIN', 'm63-b0-policy-identity',
          ${fixture.casePolicyPayload}::jsonb, ${fixture.casePolicyPayloadHash},
          ${fixture.casePolicyId}::uuid, ${fixture.casePolicyVersionId}::uuid, false,
          150000, 150000, ${digest(`case-key-${afterSaleId}`)},
          ${digest(`case-request-${afterSaleId}`)}, ${fixture.adminId}::uuid,
          ${`m63-b0-${afterSaleId}`}, now())`;
      await transaction.$executeRaw`INSERT INTO after_sale_items
        (id, store_id, after_sale_id, order_id, order_item_id, requested_quantity,
          requested_item_vnd, sku_id, product_id, brand_id, category_id, sku_code,
          product_name, option_snapshot, unit_price_vnd, updated_at)
        VALUES (${firstAfterSaleItemId}::uuid, ${BEAUTY_STORE_ID}::uuid,
          ${afterSaleId}::uuid, ${fixture.orderId}::uuid, ${fixture.orderItemId}::uuid,
          2, 100000, ${fixture.skuId}::uuid, ${fixture.productId}::uuid,
          ${fixture.brandId}::uuid, ${BEAUTY_CATEGORY_ID}::uuid,
          ${`m62-sku-${fixture.skuId.slice(0, 8)}`}, 'M6.2 product',
          '{"size":"small"}'::jsonb, 50000, now())`;
      await expectDatabaseFailure(
        transaction,
        () => transaction.$executeRaw`INSERT INTO after_sale_items
          (id, store_id, after_sale_id, order_id, order_item_id, requested_quantity,
            requested_item_vnd, sku_id, product_id, brand_id, category_id, sku_code,
            product_name, option_snapshot, unit_price_vnd, updated_at)
          VALUES (${randomUUID()}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${afterSaleId}::uuid, ${fixture.orderId}::uuid, ${secondOrderItemId}::uuid,
            1, 50000, ${secondSkuId}::uuid, ${secondProductId}::uuid,
            ${fixture.brandId}::uuid, ${BEAUTY_CATEGORY_ID}::uuid,
            ${`m63-b0-sku-${secondSkuId.slice(0, 8)}`}, 'M6.3 B0 second product',
            '{"size":"second"}'::jsonb, 50000, now())`,
        '23514',
      );

      const invalidLegacyId = randomUUID();
      await expectDatabaseFailure(
        transaction,
        () => transaction.$executeRaw`INSERT INTO after_sales
          (id, store_id, order_id, member_id, public_case_number, type, status, source,
            reason_code, policy_snapshot, policy_hash, policy_id, policy_version_id,
            legacy_policy_review, idempotency_key_hash, request_hash, initiated_by,
            correlation_id, updated_at)
          VALUES (${invalidLegacyId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${fixture.orderId}::uuid, ${fixture.memberId}::uuid,
            ${`ASC-${invalidLegacyId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
            'REFUND_ONLY', 'REVIEW_REQUIRED', 'ADMIN', 'm63-b0-invalid-legacy',
            ${fixture.casePolicyPayload}::jsonb, ${fixture.casePolicyPayloadHash},
            ${fixture.casePolicyId}::uuid, ${fixture.casePolicyVersionId}::uuid, true,
            ${digest(`case-key-${invalidLegacyId}`)},
            ${digest(`case-request-${invalidLegacyId}`)}, ${fixture.adminId}::uuid,
            ${`m63-b0-${invalidLegacyId}`}, now())`,
        '23514',
      );
    });
  });

  it('allocates odd VND line amounts with one exact remainder algorithm', async () => {
    await withOwnerRollback(async (transaction) => {
      const fixture = await createCommerceFixture(transaction, { orderPayableVnd: 100_001 });
      const firstAfterSaleId = randomUUID();
      const secondAfterSaleId = randomUUID();
      const firstItemId = randomUUID();
      const secondItemId = randomUUID();
      const digest = (value: string) => createHash('sha256').update(value).digest('hex');

      await setContext(transaction, {
        actorId: fixture.adminId,
        actorType: 'admin',
        storeId: BEAUTY_STORE_ID,
      });
      for (const [afterSaleId, amountVnd] of [
        [firstAfterSaleId, 50_000],
        [secondAfterSaleId, 50_001],
      ] as const) {
        await transaction.$executeRaw`INSERT INTO after_sales
          (id, store_id, order_id, member_id, public_case_number, type, status, source,
            reason_code, policy_snapshot, policy_hash, policy_id, policy_version_id,
            legacy_policy_review, requested_item_vnd, requested_total_vnd,
            idempotency_key_hash, request_hash, initiated_by, correlation_id, updated_at)
          VALUES (${afterSaleId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${fixture.orderId}::uuid, ${fixture.memberId}::uuid,
            ${`ASC-${afterSaleId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
            'REFUND_ONLY', 'PENDING_REVIEW', 'ADMIN', 'm63-b0-vnd-remainder',
            ${fixture.casePolicyPayload}::jsonb, ${fixture.casePolicyPayloadHash},
            ${fixture.casePolicyId}::uuid, ${fixture.casePolicyVersionId}::uuid, false,
            ${amountVnd}, ${amountVnd}, ${digest(`case-key-${afterSaleId}`)},
            ${digest(`case-request-${afterSaleId}`)}, ${fixture.adminId}::uuid,
            ${`m63-b0-${afterSaleId}`}, now())`;
      }

      await expectDatabaseFailure(
        transaction,
        () => transaction.$executeRaw`INSERT INTO after_sale_items
          (id, store_id, after_sale_id, order_id, order_item_id, requested_quantity,
            requested_item_vnd, sku_id, product_id, brand_id, category_id, sku_code,
            product_name, option_snapshot, unit_price_vnd, updated_at)
          VALUES (${firstItemId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${firstAfterSaleId}::uuid, ${fixture.orderId}::uuid,
            ${fixture.orderItemId}::uuid, 1, 50001, ${fixture.skuId}::uuid,
            ${fixture.productId}::uuid, ${fixture.brandId}::uuid,
            ${BEAUTY_CATEGORY_ID}::uuid, ${`m62-sku-${fixture.skuId.slice(0, 8)}`},
            'M6.2 product', '{"size":"small"}'::jsonb, 50000, now())`,
        '23514',
      );
      await transaction.$executeRaw`INSERT INTO after_sale_items
        (id, store_id, after_sale_id, order_id, order_item_id, requested_quantity,
          requested_item_vnd, sku_id, product_id, brand_id, category_id, sku_code,
          product_name, option_snapshot, unit_price_vnd, updated_at)
        VALUES (${firstItemId}::uuid, ${BEAUTY_STORE_ID}::uuid,
          ${firstAfterSaleId}::uuid, ${fixture.orderId}::uuid,
          ${fixture.orderItemId}::uuid, 1, 50000, ${fixture.skuId}::uuid,
          ${fixture.productId}::uuid, ${fixture.brandId}::uuid,
          ${BEAUTY_CATEGORY_ID}::uuid, ${`m62-sku-${fixture.skuId.slice(0, 8)}`},
          'M6.2 product', '{"size":"small"}'::jsonb, 50000, now())`;
      await transaction.$executeRaw`INSERT INTO after_sale_items
        (id, store_id, after_sale_id, order_id, order_item_id, requested_quantity,
          requested_item_vnd, sku_id, product_id, brand_id, category_id, sku_code,
          product_name, option_snapshot, unit_price_vnd, updated_at)
        VALUES (${secondItemId}::uuid, ${BEAUTY_STORE_ID}::uuid,
          ${secondAfterSaleId}::uuid, ${fixture.orderId}::uuid,
          ${fixture.orderItemId}::uuid, 1, 50001, ${fixture.skuId}::uuid,
          ${fixture.productId}::uuid, ${fixture.brandId}::uuid,
          ${BEAUTY_CATEGORY_ID}::uuid, ${`m62-sku-${fixture.skuId.slice(0, 8)}`},
          'M6.2 product', '{"size":"small"}'::jsonb, 50000, now())`;
      await transaction.$executeRaw`UPDATE after_sale_items
        SET approved_quantity = 1, approved_item_vnd = 50000, updated_at = now()
        WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${firstItemId}::uuid`;
      await transaction.$executeRaw`UPDATE after_sale_items
        SET approved_quantity = 1, approved_item_vnd = 50001, updated_at = now()
        WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${secondItemId}::uuid`;

      expect(
        await transaction.$queryRaw`SELECT requested_item_vnd, approved_item_vnd
          FROM after_sale_items
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid
            AND id IN (${firstItemId}::uuid, ${secondItemId}::uuid)
          ORDER BY requested_item_vnd`,
      ).toEqual([
        { approved_item_vnd: 50_000n, requested_item_vnd: 50_000n },
        { approved_item_vnd: 50_001n, requested_item_vnd: 50_001n },
      ]);
    });
  });

  it('keeps a later odd-VND request approvable after an earlier request releases capacity', async () => {
    await withOwnerRollback(async (transaction) => {
      const fixture = await createCommerceFixture(transaction, {
        orderPayableVnd: 101,
        orderQuantity: 3,
      });
      const firstAfterSaleId = randomUUID();
      const secondAfterSaleId = randomUUID();
      const firstItemId = randomUUID();
      const secondItemId = randomUUID();
      const digest = (value: string) => createHash('sha256').update(value).digest('hex');

      await setContext(transaction, {
        actorId: fixture.adminId,
        actorType: 'admin',
        storeId: BEAUTY_STORE_ID,
      });
      for (const [afterSaleId, amountVnd] of [
        [firstAfterSaleId, 33],
        [secondAfterSaleId, 34],
      ] as const) {
        await transaction.$executeRaw`INSERT INTO after_sales
          (id, store_id, order_id, member_id, public_case_number, type, status, source,
            reason_code, policy_snapshot, policy_hash, policy_id, policy_version_id,
            legacy_policy_review, requested_item_vnd, requested_total_vnd,
            idempotency_key_hash, request_hash, initiated_by, correlation_id, updated_at)
          VALUES (${afterSaleId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${fixture.orderId}::uuid, ${fixture.memberId}::uuid,
            ${`ASC-${afterSaleId.replaceAll('-', '').slice(0, 16).toUpperCase()}`},
            'REFUND_ONLY', 'PENDING_REVIEW', 'ADMIN', 'm63-b0-release-remainder',
            ${fixture.casePolicyPayload}::jsonb, ${fixture.casePolicyPayloadHash},
            ${fixture.casePolicyId}::uuid, ${fixture.casePolicyVersionId}::uuid, false,
            ${amountVnd}, ${amountVnd}, ${digest(`case-key-${afterSaleId}`)},
            ${digest(`case-request-${afterSaleId}`)}, ${fixture.adminId}::uuid,
            ${`m63-b0-${afterSaleId}`}, now())`;
      }
      await transaction.$executeRaw`INSERT INTO after_sale_items
        (id, store_id, after_sale_id, order_id, order_item_id, requested_quantity,
          requested_item_vnd, sku_id, product_id, brand_id, category_id, sku_code,
          product_name, option_snapshot, unit_price_vnd, updated_at)
        VALUES (${firstItemId}::uuid, ${BEAUTY_STORE_ID}::uuid,
          ${firstAfterSaleId}::uuid, ${fixture.orderId}::uuid,
          ${fixture.orderItemId}::uuid, 1, 33, ${fixture.skuId}::uuid,
          ${fixture.productId}::uuid, ${fixture.brandId}::uuid,
          ${BEAUTY_CATEGORY_ID}::uuid, ${`m62-sku-${fixture.skuId.slice(0, 8)}`},
          'M6.2 product', '{"size":"small"}'::jsonb, 33, now())`;
      await transaction.$executeRaw`INSERT INTO after_sale_items
        (id, store_id, after_sale_id, order_id, order_item_id, requested_quantity,
          requested_item_vnd, sku_id, product_id, brand_id, category_id, sku_code,
          product_name, option_snapshot, unit_price_vnd, updated_at)
        VALUES (${secondItemId}::uuid, ${BEAUTY_STORE_ID}::uuid,
          ${secondAfterSaleId}::uuid, ${fixture.orderId}::uuid,
          ${fixture.orderItemId}::uuid, 1, 34, ${fixture.skuId}::uuid,
          ${fixture.productId}::uuid, ${fixture.brandId}::uuid,
          ${BEAUTY_CATEGORY_ID}::uuid, ${`m62-sku-${fixture.skuId.slice(0, 8)}`},
          'M6.2 product', '{"size":"small"}'::jsonb, 33, now())`;

      await appendAfterSaleTransition(transaction, {
        actorId: fixture.adminId,
        afterSaleId: firstAfterSaleId,
        event: 'REJECT',
        fromStatus: 'PENDING_REVIEW',
        toStatus: 'REJECTED',
      });
      await expect(
        transaction.$executeRaw`UPDATE after_sale_items
          SET approved_quantity = 1, approved_item_vnd = 34, updated_at = now()
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${secondItemId}::uuid`,
      ).resolves.toBe(1);
      expect(
        await transaction.$queryRaw`SELECT sale.status, item.requested_item_vnd,
            item.approved_item_vnd
          FROM after_sale_items item
          JOIN after_sales sale ON sale.store_id = item.store_id
            AND sale.id = item.after_sale_id
          WHERE item.store_id = ${BEAUTY_STORE_ID}::uuid
            AND item.id IN (${firstItemId}::uuid, ${secondItemId}::uuid)
          ORDER BY item.requested_item_vnd`,
      ).toEqual([
        { approved_item_vnd: 0n, requested_item_vnd: 33n, status: 'REJECTED' },
        { approved_item_vnd: 34n, requested_item_vnd: 34n, status: 'PENDING_REVIEW' },
      ]);
    });
  });

  it('allows an owner member to start a return only after its SUBMITTED fact', async () => {
    await withOwnerRollback(async (transaction) => {
      const fixture = await createCommerceFixture(transaction);
      const { afterSaleId } = await createAfterSaleFixture(transaction, fixture, {
        type: 'RETURN_REFUND',
      });
      const returnShipmentId = randomUUID();

      await setContext(transaction, {
        actorId: fixture.memberId,
        actorType: 'member',
        storeId: BEAUTY_STORE_ID,
      });
      const startReturn = () => transaction.$executeRaw`INSERT INTO after_sale_transitions
        (store_id, after_sale_id, from_status, to_status, event, actor_type,
          actor_id, correlation_id)
        VALUES (${BEAUTY_STORE_ID}::uuid, ${afterSaleId}::uuid,
          'APPROVED', 'RETURN_PENDING', 'START_RETURN', 'MEMBER',
          ${fixture.memberId}::uuid,
          pg_catalog.current_setting('app.correlation_id', true))`;
      await expectDatabaseFailure(transaction, startReturn, '23514');
      await expectDatabaseFailure(
        transaction,
        () => transaction.$executeRaw`INSERT INTO after_sale_transitions
          (store_id, after_sale_id, from_status, to_status, event, actor_type,
            actor_id, correlation_id)
          VALUES (${BEAUTY_STORE_ID}::uuid, ${afterSaleId}::uuid,
            'APPROVED', 'RETURN_PENDING', 'START_RETURN', 'MEMBER',
            ${fixture.memberId}::uuid, ${`mismatched-${randomUUID()}`})`,
        '42501',
      );
      const otherMemberId = randomUUID();
      await transaction.$executeRaw`INSERT INTO members (id, store_id, updated_at)
        VALUES (${otherMemberId}::uuid, ${BEAUTY_STORE_ID}::uuid, now())`;
      await setContext(transaction, {
        actorId: otherMemberId,
        actorType: 'member',
        storeId: BEAUTY_STORE_ID,
      });
      await expectDatabaseFailure(
        transaction,
        () => transaction.$executeRaw`INSERT INTO after_sale_transitions
          (store_id, after_sale_id, from_status, to_status, event, actor_type,
            actor_id, correlation_id)
          VALUES (${BEAUTY_STORE_ID}::uuid, ${afterSaleId}::uuid,
            'APPROVED', 'RETURN_PENDING', 'START_RETURN', 'MEMBER',
            ${otherMemberId}::uuid,
            pg_catalog.current_setting('app.correlation_id', true))`,
        '42501',
      );
      await setContext(transaction, {
        actorId: fixture.memberId,
        actorType: 'member',
        storeId: BEAUTY_STORE_ID,
      });
      await expectDatabaseFailure(
        transaction,
        () => transaction.$executeRaw`INSERT INTO after_sale_transitions
          (store_id, after_sale_id, from_status, to_status, event, actor_type,
            actor_id, correlation_id)
          VALUES (${FASHION_STORE_ID}::uuid, ${afterSaleId}::uuid,
            'APPROVED', 'RETURN_PENDING', 'START_RETURN', 'MEMBER',
            ${fixture.memberId}::uuid,
            pg_catalog.current_setting('app.correlation_id', true))`,
        '42501',
      );
      await transaction.$executeRaw`INSERT INTO after_sale_return_shipments
        (id, store_id, after_sale_id, order_id, member_id, carrier_name,
          tracking_number_digest, tracking_number_masked, submitted_by, updated_at)
        VALUES (${returnShipmentId}::uuid, ${BEAUTY_STORE_ID}::uuid,
          ${afterSaleId}::uuid, ${fixture.orderId}::uuid, ${fixture.memberId}::uuid,
          'Member carrier',
          ${createHash('sha256').update(`tracking-${returnShipmentId}`).digest('hex')},
          '***B0', ${fixture.memberId}::uuid, now())`;
      await expectDatabaseFailure(
        transaction,
        () =>
          transaction.$executeRawUnsafe(
            'SET CONSTRAINTS "after_sale_return_shipments_b0_atomic_guard" IMMEDIATE',
          ),
        '23514',
      );
      await expect(startReturn()).resolves.toBe(1);
      await expect(
        transaction.$executeRawUnsafe(
          'SET CONSTRAINTS "after_sale_return_shipments_b0_atomic_guard" IMMEDIATE',
        ),
      ).resolves.toBe(0);
      const duplicateReturnShipmentId = randomUUID();
      await expectDatabaseFailure(
        transaction,
        () => transaction.$executeRaw`INSERT INTO after_sale_return_shipments
          (id, store_id, after_sale_id, order_id, member_id, carrier_name,
            tracking_number_digest, tracking_number_masked, submitted_by, updated_at)
          VALUES (${duplicateReturnShipmentId}::uuid, ${BEAUTY_STORE_ID}::uuid,
            ${afterSaleId}::uuid, ${fixture.orderId}::uuid, ${fixture.memberId}::uuid,
            'Second member carrier',
            ${createHash('sha256').update(`tracking-${duplicateReturnShipmentId}`).digest('hex')},
            '***B1', ${fixture.memberId}::uuid, now())`,
        '23505',
      );
      expect(
        await transaction.$queryRaw<Array<{ shipment_count: bigint }>>`
          SELECT pg_catalog.count(*)::bigint AS shipment_count
          FROM after_sale_return_shipments
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid
            AND after_sale_id = ${afterSaleId}::uuid
        `,
      ).toEqual([{ shipment_count: 1n }]);

      await expectDatabaseFailure(
        transaction,
        () => transaction.$executeRaw`INSERT INTO after_sale_transitions
          (store_id, after_sale_id, from_status, to_status, event, actor_type,
            actor_id, correlation_id)
          VALUES (${BEAUTY_STORE_ID}::uuid, ${afterSaleId}::uuid,
            'RETURN_PENDING', 'RETURN_IN_TRANSIT', 'RETURN_SHIPPED', 'MEMBER',
            ${fixture.memberId}::uuid,
            pg_catalog.current_setting('app.correlation_id', true))`,
        '42501',
      );
      await expectDatabaseFailure(
        transaction,
        () => transaction.$executeRaw`INSERT INTO after_sale_transitions
          (store_id, after_sale_id, from_status, to_status, event, actor_type,
            actor_id, correlation_id)
          VALUES (${BEAUTY_STORE_ID}::uuid, ${afterSaleId}::uuid,
            'RETURN_PENDING', 'INSPECTION_PENDING', 'RETURN_RECEIVED', 'MEMBER',
            ${fixture.memberId}::uuid,
            pg_catalog.current_setting('app.correlation_id', true))`,
        '42501',
      );

      await setContext(transaction, {
        actorId: otherMemberId,
        actorType: 'member',
        storeId: BEAUTY_STORE_ID,
      });
      await expectDatabaseFailure(
        transaction,
        () => transaction.$executeRaw`INSERT INTO after_sale_transitions
          (store_id, after_sale_id, from_status, to_status, event, actor_type,
            actor_id, correlation_id)
          VALUES (${BEAUTY_STORE_ID}::uuid, ${afterSaleId}::uuid,
            'RETURN_PENDING', 'RETURN_IN_TRANSIT', 'RETURN_SHIPPED', 'MEMBER',
            ${otherMemberId}::uuid,
            pg_catalog.current_setting('app.correlation_id', true))`,
        '42501',
      );
      await setContext(transaction, {
        actorId: fixture.memberId,
        actorType: 'member',
        storeId: BEAUTY_STORE_ID,
      });
      expect(
        await transaction.$queryRaw`SELECT event, actor_type FROM after_sale_transitions
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid
            AND after_sale_id = ${afterSaleId}::uuid AND actor_type = 'MEMBER'`,
      ).toEqual([{ actor_type: 'MEMBER', event: 'START_RETURN' }]);
    });
  });

  it('binds SYSTEM transitions to the dedicated scope, allowlist, store and correlation', async () => {
    await withCommittedCommerceFixture(async (fixture) => {
      const { afterSaleId, refundProcessingAfterSaleId } = await owner.$transaction(
        async (transaction) => {
          const primary = await createAfterSaleFixture(transaction, fixture, {
            approvedTotalVnd: 50_000,
          });
          const refundProcessing = await createAfterSaleFixture(transaction, fixture, {
            approvedTotalVnd: 50_000,
          });
          await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
          await transaction.$executeRaw`UPDATE after_sales
            SET status = 'REFUND_PROCESSING', version = version + 1, updated_at = now()
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid
              AND id = ${refundProcessing.afterSaleId}::uuid`;
          await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
          return {
            afterSaleId: primary.afterSaleId,
            refundProcessingAfterSaleId: refundProcessing.afterSaleId,
          };
        },
      );
      const systemContext = createAfterSaleSystemContext({
        actorId: randomUUID(),
        correlationId: `m63-b0-system-${randomUUID()}`,
        storeId: BEAUTY_STORE_ID,
      });

      await runtime.$transaction(async (transaction) => {
        await transaction.$executeRaw`
          SELECT
            set_config('app.store_id', ${systemContext.storeId}, true),
            set_config('app.actor_id', ${systemContext.actor.id}, true),
            set_config('app.actor_type', 'system', true),
            set_config('app.correlation_id', ${systemContext.correlationId}, true),
            set_config('app.system_scope', '', true)
        `;
        await expectDatabaseFailure(
          transaction,
          () => transaction.$executeRaw`INSERT INTO after_sale_transitions
            (store_id, after_sale_id, from_status, to_status, event, actor_type,
              actor_id, correlation_id)
            VALUES (${BEAUTY_STORE_ID}::uuid, ${afterSaleId}::uuid,
              'APPROVED', 'REVIEW_REQUIRED', 'REQUIRE_REVIEW', 'SYSTEM',
              ${systemContext.actor.id}::uuid, ${systemContext.correlationId})`,
          '42501',
        );
      });

      await withAfterSaleSystemTransaction(runtime, systemContext, async (transaction) => {
        expect(
          await transaction.$queryRaw`SELECT
              pg_catalog.current_setting('app.store_id', true) AS store_id,
              pg_catalog.current_setting('app.actor_id', true) AS actor_id,
              pg_catalog.current_setting('app.actor_type', true) AS actor_type,
              pg_catalog.current_setting('app.correlation_id', true) AS correlation_id,
              pg_catalog.current_setting('app.system_scope', true) AS system_scope`,
        ).toEqual([
          {
            actor_id: systemContext.actor.id,
            actor_type: 'system',
            correlation_id: systemContext.correlationId,
            store_id: systemContext.storeId,
            system_scope: systemContext.systemScope,
          },
        ]);

        await expectDatabaseFailure(
          transaction,
          () => transaction.$executeRaw`INSERT INTO after_sale_transitions
            (store_id, after_sale_id, from_status, to_status, event, actor_type,
              actor_id, correlation_id)
            VALUES (${BEAUTY_STORE_ID}::uuid, ${afterSaleId}::uuid,
              'APPROVED', 'REVIEW_REQUIRED', 'REQUIRE_REVIEW', 'SYSTEM',
              ${randomUUID()}::uuid, ${systemContext.correlationId})`,
          '42501',
        );
        await expectDatabaseFailure(
          transaction,
          () => transaction.$executeRaw`INSERT INTO after_sale_transitions
            (store_id, after_sale_id, from_status, to_status, event, actor_type,
              actor_id, correlation_id)
            VALUES (${BEAUTY_STORE_ID}::uuid, ${afterSaleId}::uuid,
              'APPROVED', 'REVIEW_REQUIRED', 'REQUIRE_REVIEW', 'ADMIN',
              ${systemContext.actor.id}::uuid, ${systemContext.correlationId})`,
          '42501',
        );

        for (const refundResult of [
          { event: 'REFUND_SUCCEEDED', toStatus: 'REFUNDED' },
          { event: 'REFUND_FAILED', toStatus: 'REFUND_PENDING' },
          { event: 'REFUND_CANCELLED', toStatus: 'REFUND_PENDING' },
        ] as const) {
          await expectDatabaseFailure(
            transaction,
            () => transaction.$executeRaw`INSERT INTO after_sale_transitions
              (store_id, after_sale_id, from_status, to_status, event, actor_type,
                actor_id, correlation_id)
              VALUES (${BEAUTY_STORE_ID}::uuid, ${refundProcessingAfterSaleId}::uuid,
                'REFUND_PROCESSING', ${refundResult.toStatus}::after_sale_status,
                ${refundResult.event}, 'SYSTEM', ${systemContext.actor.id}::uuid,
                ${systemContext.correlationId})`,
            '23514',
          );
        }

        for (const event of ['APPROVE', 'LEGACY_APPROVE', 'CONFIRM_COD', 'RETURN_SHIPPED']) {
          await expectDatabaseFailure(
            transaction,
            () => transaction.$executeRaw`INSERT INTO after_sale_transitions
              (store_id, after_sale_id, from_status, to_status, event, actor_type,
                actor_id, correlation_id)
              VALUES (${BEAUTY_STORE_ID}::uuid, ${afterSaleId}::uuid,
                'APPROVED', 'APPROVED', ${event}, 'SYSTEM',
                ${systemContext.actor.id}::uuid, ${systemContext.correlationId})`,
            '42501',
          );
        }
        await expectDatabaseFailure(
          transaction,
          () => transaction.$executeRaw`INSERT INTO after_sale_transitions
            (store_id, after_sale_id, from_status, to_status, event, actor_type,
              actor_id, correlation_id)
            VALUES (${BEAUTY_STORE_ID}::uuid, ${afterSaleId}::uuid,
              'APPROVED', 'COMPLETED', 'COMPLETE', 'SYSTEM',
              ${systemContext.actor.id}::uuid, ${systemContext.correlationId})`,
          '23514',
        );
        await expectDatabaseFailure(
          transaction,
          () => transaction.$executeRaw`INSERT INTO after_sale_transitions
            (store_id, after_sale_id, from_status, to_status, event, actor_type,
              actor_id, correlation_id)
            VALUES (${FASHION_STORE_ID}::uuid, ${afterSaleId}::uuid,
              'APPROVED', 'REVIEW_REQUIRED', 'REQUIRE_REVIEW', 'SYSTEM',
              ${systemContext.actor.id}::uuid, ${systemContext.correlationId})`,
          '42501',
        );
        await expectDatabaseFailure(
          transaction,
          () => transaction.$executeRaw`INSERT INTO after_sale_transitions
            (store_id, after_sale_id, from_status, to_status, event, actor_type,
              actor_id, correlation_id)
            VALUES (${BEAUTY_STORE_ID}::uuid, ${afterSaleId}::uuid,
              'APPROVED', 'REVIEW_REQUIRED', 'REQUIRE_REVIEW', 'SYSTEM',
              ${systemContext.actor.id}::uuid, ${`mismatched-${randomUUID()}`})`,
          '42501',
        );
        await expect(
          transaction.$executeRaw`INSERT INTO after_sale_transitions
            (store_id, after_sale_id, from_status, to_status, event, actor_type,
              actor_id, correlation_id)
            VALUES (${BEAUTY_STORE_ID}::uuid, ${afterSaleId}::uuid,
              'APPROVED', 'REVIEW_REQUIRED', 'REQUIRE_REVIEW', 'SYSTEM',
              ${systemContext.actor.id}::uuid, ${systemContext.correlationId})`,
        ).resolves.toBe(1);
      });
      expect(
        await owner.$queryRaw`SELECT status FROM after_sales
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid
            AND id = ${refundProcessingAfterSaleId}::uuid`,
      ).toEqual([{ status: 'REFUND_PROCESSING' }]);

      await owner.$transaction(async (transaction) => {
        await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
        await transaction.$executeRaw`UPDATE after_sales
          SET status = 'REFUNDED', completed_at = now(), version = version + 1,
            updated_at = now()
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${afterSaleId}::uuid`;
        await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
      });
      await withAfterSaleSystemTransaction(runtime, systemContext, async (transaction) => {
        await expect(
          transaction.$executeRaw`INSERT INTO after_sale_transitions
            (store_id, after_sale_id, from_status, to_status, event, actor_type,
              actor_id, correlation_id)
            VALUES (${BEAUTY_STORE_ID}::uuid, ${afterSaleId}::uuid,
              'REFUNDED', 'COMPLETED', 'COMPLETE', 'SYSTEM',
              ${systemContext.actor.id}::uuid, ${systemContext.correlationId})`,
        ).resolves.toBe(1);
      });
      expect(
        await owner.$queryRaw`SELECT status FROM after_sales
          WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${afterSaleId}::uuid`,
      ).toEqual([{ status: 'COMPLETED' }]);
    });
  });

  it('exposes an owner-only M6 rollback guard that returns SQLSTATE 55000 when facts exist', async () => {
    const privileges = await owner.$queryRaw<Array<{ runtime_can_execute: boolean }>>`
      SELECT has_function_privilege(
        'zalo_shop_runtime',
        'app_security.assert_m62_rollback_safe()',
        'EXECUTE'
      ) AS runtime_can_execute
    `;
    expect(privileges).toEqual([{ runtime_can_execute: false }]);

    await expectSqlState(
      owner.$transaction(async (transaction) => {
        const adminId = randomUUID();
        await transaction.$executeRaw`INSERT INTO admin_users
          (id, email, email_normalized, display_name, password_hash, updated_at)
          VALUES (${adminId}::uuid, ${`${adminId}@example.invalid`},
            ${`${adminId}@example.invalid`}, 'M6.2 rollback guard admin',
            'test-fixture-not-a-login-hash', now())`;
        await setContext(transaction, {
          actorId: adminId,
          actorType: 'admin',
          storeId: BEAUTY_STORE_ID,
        });
        await transaction.$executeRaw`INSERT INTO store_after_sale_settings
          (store_id, updated_at, updated_by)
          VALUES (${BEAUTY_STORE_ID}::uuid, now(), ${adminId}::uuid)
          ON CONFLICT (store_id) DO NOTHING`;
        await transaction.$queryRaw`SELECT app_security.assert_m62_rollback_safe()`;
      }),
      '55000',
    );
  });
});
