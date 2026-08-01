import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';

import { config as loadEnvironment } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AfterSalePolicyContent } from '@zalo-shop/contracts';
import {
  AfterSaleCommandDatabaseError,
  canonicalAfterSaleCommandRequestHash,
  canonicalAfterSalePolicyHash,
  cancelMemberAfterSaleCommand,
  applyAfterSaleEvidenceScanResult,
  confirmAfterSaleEvidenceUpload,
  type CreateMemberAfterSaleCommandInput,
  createMemberAfterSaleCommand,
  createMerchantRefundAfterSaleCommand,
  createRuntimePrismaClient,
  expireDueAfterSales,
  initializeAfterSaleEvidenceUpload,
  resolveAfterSaleReviewCommand,
  recordAfterSaleReturnFact,
  reviewAfterSaleCommand,
  submitMemberAfterSaleReturn,
  type Prisma,
  PrismaClient,
  withAfterSaleSystemTransaction,
  withStoreTransaction,
} from '@zalo-shop/database';
import {
  createAfterSaleEvidenceSystemContext,
  createAfterSaleSystemContext,
  createStoreContext,
  type StoreContext,
} from '@zalo-shop/domain';

const REPOSITORY_ROOT = resolve(__dirname, '../..');
const BEAUTY_STORE_ID = '10000000-0000-4000-8000-000000000001';
const FASHION_STORE_ID = '10000000-0000-4000-8000-000000000002';
const BEAUTY_CATEGORY_ID = '12000000-0000-4000-8000-000000000001';
const BEAUTY_WAREHOUSE_ID = '17000000-0000-4000-8000-000000000001';
const BEAUTY_SHADE_DEFINITION_ID = '15000000-0000-4000-8000-000000000001';
const BEAUTY_DEFAULT_SHADE_OPTION_ID = '16000000-0000-4000-8000-000000000001';
const SCRATCH_DATABASE_PATTERN = /^zalo_shop_m63b3_[0-9a-f]{12}$/u;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

const DISABLED_EVIDENCE_CAPABILITIES = {
  claimAvailable: false,
  deletionCompensationAvailable: false,
  malwareScanningAvailable: false,
  protectedReadAvailable: false,
  uploadValidationAvailable: false,
} as const;

const ENABLED_EVIDENCE_CAPABILITIES = {
  claimAvailable: true,
  deletionCompensationAvailable: true,
  malwareScanningAvailable: true,
  protectedReadAvailable: true,
  uploadValidationAvailable: true,
} as const;

type OrderFixture = Readonly<{
  id: string;
  itemId: string;
  memberId: string;
  payableVnd: number;
  quantity: number;
}>;

type PolicyFixture = Readonly<{
  assignmentId: string;
  code: string;
  content: AfterSalePolicyContent;
  hash: string;
  id: string;
  versionId: string;
}>;

describe.sequential('M6.3-B3 after-sale command database boundary', () => {
  loadEnvironment({ path: '.env.test.example', quiet: true, override: true });
  const sourceOwnerUrl = process.env.DATABASE_URL;
  const sourceRuntimeUrl = process.env.DATABASE_RUNTIME_URL;
  if (!sourceOwnerUrl || !sourceRuntimeUrl) {
    throw new Error('M6.3-B3 database URLs are required');
  }

  const scratchDatabaseName = `zalo_shop_m63b3_${randomBytes(6).toString('hex')}`;
  const ownerUrl = scratchUrl(sourceOwnerUrl, scratchDatabaseName);
  const runtimeUrl = scratchUrl(sourceRuntimeUrl, scratchDatabaseName);
  const adminUrl = scratchUrl(sourceOwnerUrl, 'postgres');
  const admin = new PrismaClient({ datasourceUrl: adminUrl });
  let owner: PrismaClient | undefined;
  let runtime: ReturnType<typeof createRuntimePrismaClient> | undefined;
  let scratchCreated = false;

  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const fixture = {
    adminId: randomUUID(),
    adminRoleId: randomUUID(),
    adminSessionId: randomUUID(),
    assignmentId: randomUUID(),
    exchangeAttributeTemplateId: randomUUID(),
    exchangeAttributeTemplateVersionId: randomUUID(),
    exchangeFinishDefinitionId: randomUUID(),
    exchangeFinishOriginalOptionId: randomUUID(),
    exchangeFinishReplacementOptionId: randomUUID(),
    exchangeReplacementSkuId: randomUUID(),
    exchangeReplacementInvalidFinishSkuId: randomUUID(),
    exchangeReplacementShadeOptionId: randomUUID(),
    brandId: randomUUID(),
    fashionMemberId: randomUUID(),
    fashionMemberSessionId: randomUUID(),
    memberId: randomUUID(),
    memberSessionId: randomUUID(),
    otherMemberId: randomUUID(),
    otherMemberSessionId: randomUUID(),
    otherAdminId: randomUUID(),
    otherAdminSessionId: randomUUID(),
    paymentChannelId: randomUUID(),
    platformRoleId: randomUUID(),
    policyId: randomUUID(),
    policyVersionId: randomUUID(),
    productId: randomUUID(),
    shippingChannelId: randomUUID(),
    skuId: randomUUID(),
  };
  const policyContent: AfterSalePolicyContent = {
    allowed_types: ['REFUND_ONLY', 'RETURN_REFUND', 'MERCHANT_REFUND'],
    category_id: null,
    condition_rules: {
      allowed_reason_codes: ['damaged-item', 'wrong-item'],
      evidence_required: false,
      evidence_required_reason_codes: [],
      opened_package_exception_reason_codes: [],
    },
    damaged_exception: true,
    defect_exception: true,
    exchange_attribute_code: null,
    exchange_same_product_only: true,
    hygiene_restricted: false,
    localizations: [
      {
        buyer_instructions: 'Gui yeu cau sau ban hang.',
        locale: 'vi',
        name: 'Chinh sach B3',
        summary: 'Chinh sach thu nghiem B3.',
      },
      {
        buyer_instructions: 'Submit an after-sale request.',
        locale: 'en',
        name: 'B3 policy',
        summary: 'B3 local-test policy.',
      },
      {
        buyer_instructions: '提交售后申请。',
        locale: 'zh',
        name: 'B3 售后政策',
        summary: 'B3 本地测试政策。',
      },
    ],
    product_ids: [fixture.productId],
    request_window_days: 30,
    return_shipping_payer: 'MERCHANT',
    return_window_days: 7,
    unopened_required: false,
    wrong_item_exception: true,
  };
  const policyHash = canonicalAfterSalePolicyHash(policyContent);

  function scratchUrl(source: string, databaseName: string): string {
    const url = new URL(source);
    if (!LOOPBACK_HOSTS.has(url.hostname)) {
      throw new Error('M6.3-B3 integration test requires a loopback PostgreSQL host');
    }
    url.pathname = `/${databaseName}`;
    return url.toString();
  }

  function assertScratchName(): void {
    if (process.env.NODE_ENV !== 'test' || !SCRATCH_DATABASE_PATTERN.test(scratchDatabaseName)) {
      throw new Error('Refusing unsafe M6.3-B3 scratch database operation');
    }
  }

  function runPackageScript(script: 'migrate:deploy' | 'seed'): void {
    const corepackCli = resolve(
      dirname(process.execPath),
      'node_modules/corepack/dist/corepack.js',
    );
    const result = spawnSync(
      process.execPath,
      [corepackCli, 'pnpm', '--filter', '@zalo-shop/database', script],
      {
        cwd: REPOSITORY_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          DATABASE_RUNTIME_URL: runtimeUrl,
          DATABASE_URL: ownerUrl,
          NODE_ENV: 'test',
        },
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`${script} failed: ${(result.stderr || result.stdout).trim()}`);
    }
  }

  function requiredOwner(): PrismaClient {
    if (!owner) throw new Error('M6.3-B3 owner client is unavailable');
    return owner;
  }

  function requiredRuntime(): ReturnType<typeof createRuntimePrismaClient> {
    if (!runtime) throw new Error('M6.3-B3 runtime client is unavailable');
    return runtime;
  }

  function context(input: {
    actorId: string;
    actorType: 'admin' | 'member';
    store?: 'beauty' | 'fashion';
  }): StoreContext {
    const beauty = input.store !== 'fashion';
    const sessionId =
      input.actorType === 'admin'
        ? input.actorId === fixture.adminId
          ? fixture.adminSessionId
          : fixture.otherAdminSessionId
        : input.actorId === fixture.memberId
          ? fixture.memberSessionId
          : input.actorId === fixture.otherMemberId
            ? fixture.otherMemberSessionId
            : fixture.fashionMemberSessionId;
    const accessSessionExpiresAt = new Date(Date.now() + 60 * 60 * 1_000);
    const accessTokenExpiresAt = new Date(Date.now() + 15 * 60 * 1_000);
    return createStoreContext({
      accessSessionExpiresAt,
      accessSessionId: sessionId,
      accessTokenExpiresAt,
      ...(input.actorType === 'admin' ? { adminAuthorizationScope: 'STORE' as const } : {}),
      actor: { id: input.actorId, type: input.actorType },
      correlationId: `m63b3-${suffix}-${randomUUID()}`,
      locale: 'vi',
      storeCode: beauty ? 'beauty-local' : 'fashion-local',
      storeId: beauty ? BEAUTY_STORE_ID : FASHION_STORE_ID,
    });
  }

  const memberContext = (memberId = fixture.memberId): StoreContext =>
    context({ actorId: memberId, actorType: 'member' });
  const adminContext = (adminId = fixture.adminId): StoreContext =>
    context({ actorId: adminId, actorType: 'admin' });

  function crossStoreAdminContext(correlationId: string): StoreContext {
    return createStoreContext({
      accessSessionExpiresAt: new Date(Date.now() + 60 * 60 * 1_000),
      accessSessionId: fixture.adminSessionId,
      accessTokenExpiresAt: new Date(Date.now() + 15 * 60 * 1_000),
      adminAuthorizationScope: 'CROSS_STORE',
      actor: { id: fixture.adminId, type: 'admin' },
      correlationId,
      locale: 'vi',
      storeCode: 'beauty-local',
      storeId: BEAUTY_STORE_ID,
    });
  }

  async function expectCommandFailure(
    action: () => Promise<unknown>,
    code: AfterSaleCommandDatabaseError['code'],
  ): Promise<void> {
    let failure: unknown;
    try {
      await action();
    } catch (error) {
      failure = error;
    }
    const diagnostic =
      failure && typeof failure === 'object'
        ? JSON.stringify({
            code: (failure as { code?: unknown }).code,
            message: (failure as { message?: unknown }).message,
            meta: (failure as { meta?: unknown }).meta,
          })
        : String(failure);
    expect(failure, diagnostic).toBeInstanceOf(AfterSaleCommandDatabaseError);
    expect((failure as AfterSaleCommandDatabaseError).code).toBe(code);
  }

  async function expectSqlState(action: () => Promise<unknown>, sqlState: string): Promise<void> {
    let failure: unknown;
    try {
      await action();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    const record = failure as {
      code?: unknown;
      message?: unknown;
      meta?: { code?: unknown; message?: unknown };
    };
    const diagnostic = [record.message, record.meta?.message].filter(Boolean).join('\n');
    expect(record.meta?.code ?? record.code, diagnostic).toBe(sqlState);
  }

  async function expectAuthorizationExpiryAfterAdvisoryWait(
    scopedContext: StoreContext,
    advisoryKey: string,
    replay: (transaction: Prisma.TransactionClient) => Promise<unknown>,
  ): Promise<void> {
    let announceLockAcquired!: () => void;
    let releaseLock!: () => void;
    const lockAcquired = new Promise<void>((resolve) => {
      announceLockAcquired = resolve;
    });
    const lockRelease = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const holder = requiredOwner().$transaction(async (transaction) => {
      await transaction.$executeRaw`
        SELECT pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended(${advisoryKey}, 0)
        )
      `;
      announceLockAcquired();
      await lockRelease;
    });
    await lockAcquired;

    let backendPid = 0;
    try {
      await expectSqlState(async () => {
        const replayPromise = withStoreTransaction(
          requiredRuntime(),
          scopedContext,
          async (transaction) => {
            const rows = await transaction.$queryRaw<Array<{ pid: number }>>`
              SELECT pg_catalog.pg_backend_pid() AS pid,
                pg_catalog.set_config(
                  'app.access_token_expires_at',
                  (pg_catalog.clock_timestamp() + INTERVAL '1 second')::text,
                  true
                ) AS ignored_expiry
            `;
            backendPid = rows[0]?.pid ?? 0;
            return replay(transaction);
          },
          { isolationLevel: 'Serializable', timeout: 10_000 },
        );

        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (backendPid !== 0) {
            const activity = await requiredOwner().$queryRaw<Array<{ wait_event: string | null }>>`
              SELECT wait_event
              FROM pg_catalog.pg_stat_activity
              WHERE pid = ${backendPid}
            `;
            if (activity[0]?.wait_event === 'advisory') break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
          if (attempt === 99)
            throw new Error('B3 replay did not wait on the expected advisory lock');
        }

        await new Promise((resolve) => setTimeout(resolve, 1_200));
        releaseLock();
        return replayPromise;
      }, '42501');
    } finally {
      releaseLock();
      await holder;
    }
  }

  async function createPolicyFixture(
    content: AfterSalePolicyContent,
    tag: string,
  ): Promise<PolicyFixture> {
    const assignmentId = randomUUID();
    const id = randomUUID();
    const versionId = randomUUID();
    const code = `m63b3-${tag}-${suffix}`;
    const hash = canonicalAfterSalePolicyHash(content);
    await withStoreTransaction(requiredOwner(), adminContext(), async (transaction) => {
      await transaction.afterSalePolicy.create({
        data: {
          code,
          createdBy: fixture.adminId,
          draftHash: hash,
          draftPayload: content,
          id,
          status: 'DRAFT',
          storeId: BEAUTY_STORE_ID,
          updatedBy: fixture.adminId,
        },
      });
      await transaction.afterSalePolicyVersion.create({
        data: {
          allowedTypes: content.allowed_types,
          conditionRules: content.condition_rules,
          damagedException: content.damaged_exception,
          defectException: content.defect_exception,
          effectiveAt: new Date(),
          exchangeAttributeCode: content.exchange_attribute_code,
          exchangeSameProductOnly: content.exchange_same_product_only,
          hygieneRestricted: content.hygiene_restricted,
          id: versionId,
          payload: content,
          payloadHash: hash,
          policyId: id,
          publishedBy: fixture.adminId,
          requestWindowDays: content.request_window_days,
          returnShippingPayer: content.return_shipping_payer,
          returnWindowDays: content.return_window_days,
          storeId: BEAUTY_STORE_ID,
          unopenedRequired: content.unopened_required,
          versionNumber: 1,
          wrongItemException: content.wrong_item_exception,
        },
      });
      await transaction.afterSalePolicyLocalization.createMany({
        data: content.localizations.map((localization) => ({
          buyerInstructions: localization.buyer_instructions,
          locale: localization.locale,
          name: localization.name,
          policyVersionId: versionId,
          storeId: BEAUTY_STORE_ID,
          summary: localization.summary,
        })),
      });
      await transaction.afterSalePolicyVersionAssignment.create({
        data: {
          id: assignmentId,
          policyId: id,
          policyVersionId: versionId,
          productId: fixture.productId,
          storeId: BEAUTY_STORE_ID,
          targetType: 'PRODUCT',
        },
      });
      await transaction.afterSalePolicy.update({
        data: {
          currentVersionId: versionId,
          status: 'ACTIVE',
          updatedBy: fixture.adminId,
          version: { increment: 1 },
        },
        where: { id },
      });
    });
    return { assignmentId, code, content, hash, id, versionId };
  }

  async function createOrder(input: {
    delivered?: boolean;
    itemPayableVnd?: number;
    memberId?: string;
    payableVnd?: number;
    paymentMethod?: 'COD' | 'ONLINE';
    paymentProof?: boolean;
    optionSnapshot?: Prisma.InputJsonValue;
    policy?: PolicyFixture;
    productId?: string;
    quantity?: number;
    shippingFeeVnd?: number;
    skuId?: string;
    tag: string;
    withPolicy?: boolean;
  }): Promise<OrderFixture> {
    const database = requiredOwner();
    const id = randomUUID();
    const itemId = randomUUID();
    const memberId = input.memberId ?? fixture.memberId;
    const payableVnd = input.payableVnd ?? 120_000;
    const itemPayableVnd = input.itemPayableVnd ?? payableVnd;
    const quantity = input.quantity ?? 2;
    const paymentMethod = input.paymentMethod ?? 'ONLINE';
    const shippingFeeVnd = input.shippingFeeVnd ?? 0;
    const productId = input.productId ?? fixture.productId;
    const skuId = input.skuId ?? fixture.skuId;
    const delivered = input.delivered !== false;
    await database.order.create({
      data: {
        baseSubtotalVnd: itemPayableVnd,
        couponDiscountVnd: 0,
        currency: 'VND',
        id,
        itemDiscountVnd: 0,
        memberId,
        orderDiscountVnd: 0,
        orderNumber: `M63B3-${input.tag}-${suffix}`,
        payableVnd,
        paymentMethod,
        paymentStatus: 'SUCCEEDED',
        quoteHash: digest(`quote-${id}`),
        remoteSurchargeVnd: 0,
        shippingDiscountVnd: 0,
        shippingFeeVnd,
        status: 'DELIVERED',
        storeId: BEAUTY_STORE_ID,
      },
    });
    await database.orderItem.create({
      data: {
        brandId: fixture.brandId,
        brandName: 'M6.3-B3 brand',
        categoryId: BEAUTY_CATEGORY_ID,
        id: itemId,
        optionSnapshot: input.optionSnapshot ?? [],
        orderId: id,
        payableVnd: itemPayableVnd,
        productId,
        productName: 'M6.3-B3 product',
        quantity,
        skuCode: `m63b3-sku-${suffix}`,
        skuId,
        storeId: BEAUTY_STORE_ID,
        subtotalVnd: itemPayableVnd,
        unitPriceVnd: Math.floor(itemPayableVnd / quantity),
      },
    });
    if (input.withPolicy !== false) {
      const policy = input.policy ?? {
        assignmentId: fixture.assignmentId,
        code: `m63b3-policy-${suffix}`,
        content: policyContent,
        hash: policyHash,
        id: fixture.policyId,
        versionId: fixture.policyVersionId,
      };
      await database.$transaction(async (transaction) => {
        const originalActive = await transaction.afterSaleActivePolicyAssignment.findFirstOrThrow({
          where: {
            productId,
            storeId: BEAUTY_STORE_ID,
            targetType: 'PRODUCT',
          },
        });
        const needsTemporaryProjection = originalActive.assignmentId !== policy.assignmentId;
        if (needsTemporaryProjection) {
          await transaction.afterSaleActivePolicyAssignment.delete({
            where: { id: originalActive.id },
          });
          await transaction.afterSaleActivePolicyAssignment.create({
            data: {
              assignmentId: policy.assignmentId,
              policyId: policy.id,
              policyVersionId: policy.versionId,
              productId,
              storeId: BEAUTY_STORE_ID,
              targetType: 'PRODUCT',
            },
          });
        }
        await transaction.orderItemAfterSalePolicySnapshot.create({
          data: {
            orderId: id,
            orderItemId: itemId,
            payload: policy.content,
            payloadHash: policy.hash,
            policyCode: policy.code,
            policyId: policy.id,
            policyVersionId: policy.versionId,
            policyVersionNumber: 1,
            storeId: BEAUTY_STORE_ID,
          },
        });
        if (needsTemporaryProjection) {
          await transaction.afterSaleActivePolicyAssignment.deleteMany({
            where: { assignmentId: policy.assignmentId, storeId: BEAUTY_STORE_ID },
          });
          await transaction.afterSaleActivePolicyAssignment.create({
            data: {
              assignmentId: originalActive.assignmentId,
              categoryId: originalActive.categoryId,
              id: originalActive.id,
              policyId: originalActive.policyId,
              policyVersionId: originalActive.policyVersionId,
              productId: originalActive.productId,
              storeId: originalActive.storeId,
              targetType: originalActive.targetType,
            },
          });
        }
      });
    }
    if (paymentMethod === 'ONLINE' && input.paymentProof !== false) {
      await database.paymentAttempt.create({
        data: {
          amountVnd: payableVnd,
          attemptSequence: 1,
          channelId: fixture.paymentChannelId,
          correlationId: `m63b3-payment-${input.tag}`,
          createIdempotencyKeyHash: digest(`payment-key-${id}`),
          currency: 'VND',
          expiresAt: new Date(Date.now() + 600_000),
          orderId: id,
          providerOrderId: `m63b3-order-${id}`,
          providerStatus: 'SUCCEEDED',
          providerTransactionId: `m63b3-transaction-${id}`,
          publicPaymentNumber: `PAY-${id.replaceAll('-', '').toUpperCase()}`,
          status: 'SUCCEEDED',
          storeId: BEAUTY_STORE_ID,
          succeededAt: new Date(),
        },
      });
    }
    if (delivered) {
      const shipmentId = randomUUID();
      await database.shipment.create({
        data: {
          addressSnapshotCiphertext: 'test-address-ciphertext',
          channelId: fixture.shippingChannelId,
          clientOrderCode: `M63B3-${shipmentId}`,
          codAmountVnd: paymentMethod === 'COD' ? payableVnd : 0,
          deliveredAt: new Date(Date.now() - 86_400_000),
          id: shipmentId,
          orderId: id,
          parcelSnapshot: { fixture: 'm63b3' },
          providerShipmentId: `m63b3-shipment-${shipmentId}`,
          publicShipmentNumber: `SHP-${shipmentId.replaceAll('-', '').toUpperCase()}`,
          purpose: 'ORDER_OUTBOUND',
          serviceCode: 'LOCAL_TEST',
          status: 'DELIVERED',
          storeId: BEAUTY_STORE_ID,
          warehouseId: BEAUTY_WAREHOUSE_ID,
        },
      });
      await database.shipmentItem.create({
        data: {
          orderId: id,
          orderItemId: itemId,
          quantity,
          shipmentId,
          storeId: BEAUTY_STORE_ID,
        },
      });
    }
    return { id, itemId, memberId, payableVnd, quantity };
  }

  function memberCreateInput(
    order: OrderFixture,
    tag: string,
    quantity = 1,
    options: {
      evidenceCapabilities?: CreateMemberAfterSaleCommandInput['evidenceCapabilities'];
      evidenceIds?: readonly string[];
      ordinaryAccessTtlSeconds?: number;
      replacementSkuId?: string;
      retentionTtlSeconds?: number;
      type?: 'REFUND_ONLY' | 'RETURN_REFUND' | 'EXCHANGE';
    } = {},
  ): Parameters<typeof createMemberAfterSaleCommand>[2] {
    return {
      evidenceCapabilities: options.evidenceCapabilities ?? DISABLED_EVIDENCE_CAPABILITIES,
      evidenceIds: options.evidenceIds ?? [],
      idempotencyKey: `m63b3-member-${tag}-${suffix}`,
      items: [
        {
          orderItemId: order.itemId,
          quantity,
          ...(options.replacementSkuId === undefined
            ? {}
            : { replacementSkuId: options.replacementSkuId }),
        },
      ],
      orderId: order.id,
      ...(options.ordinaryAccessTtlSeconds === undefined
        ? {}
        : { ordinaryAccessTtlSeconds: options.ordinaryAccessTtlSeconds }),
      reasonCode: 'damaged-item',
      reasonDetailCiphertext: `test-ciphertext-${tag}`,
      reasonDetailHash: digest(`reason-detail-${tag}`),
      ...(options.retentionTtlSeconds === undefined
        ? {}
        : { retentionTtlSeconds: options.retentionTtlSeconds }),
      sourceIp: '127.0.0.1',
      type: options.type ?? 'REFUND_ONLY',
    };
  }

  async function createApprovedReturnCase(tag: string): Promise<{
    afterSaleId: string;
    order: OrderFixture;
    version: number;
  }> {
    const order = await createOrder({ quantity: 1, tag });
    const created = await createMemberAfterSaleCommand(
      requiredRuntime(),
      memberContext(),
      memberCreateInput(order, tag, 1, { type: 'RETURN_REFUND' }),
    );
    const approved = await reviewAfterSaleCommand(requiredRuntime(), adminContext(), {
      afterSaleId: created.afterSaleId,
      body: {
        confirmation_code: 'APPROVE_AFTER_SALE',
        decision: 'APPROVE',
        expected_version: created.version,
        items: [{ approved_quantity: 1, order_item_id: order.itemId }],
        reason: 'Approve the return after completing the required administrator review.',
      },
      idempotencyKey: `m63b5-${tag}-approve-${suffix}`,
    });
    return { afterSaleId: created.afterSaleId, order, version: approved.version };
  }

  beforeAll(async () => {
    assertScratchName();
    await admin.$connect();
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchDatabaseName}"`);
    scratchCreated = true;
    runPackageScript('migrate:deploy');
    runPackageScript('migrate:deploy');
    runPackageScript('seed');
    owner = new PrismaClient({ datasourceUrl: ownerUrl });
    runtime = createRuntimePrismaClient(runtimeUrl);
    await Promise.all([owner.$connect(), runtime.$connect()]);

    await owner.adminUser.create({
      data: {
        displayName: 'M6.3-B3 fixture administrator',
        email: `m63b3-${suffix}@example.test`,
        emailNormalized: `m63b3-${suffix}@example.test`,
        id: fixture.adminId,
        passwordHash: 'test-fixture-not-used',
      },
    });
    await owner.adminUser.create({
      data: {
        displayName: 'M6.3-B3 second fixture administrator',
        email: `m63b3-other-${suffix}@example.test`,
        emailNormalized: `m63b3-other-${suffix}@example.test`,
        id: fixture.otherAdminId,
        passwordHash: 'test-fixture-not-used',
      },
    });
    await owner.member.createMany({
      data: [
        { id: fixture.memberId, storeId: BEAUTY_STORE_ID },
        { id: fixture.otherMemberId, storeId: BEAUTY_STORE_ID },
        { id: fixture.fashionMemberId, storeId: FASHION_STORE_ID },
      ],
    });
    const sessionExpiresAt = new Date(Date.now() + 60 * 60 * 1_000);
    await owner.adminSession.create({
      data: {
        adminUserId: fixture.adminId,
        expiresAt: sessionExpiresAt,
        id: fixture.adminSessionId,
        mfaVerifiedAt: new Date(),
        refreshTokenHash: digest(`admin-session-${fixture.adminId}`),
        tokenFamilyId: randomUUID(),
      },
    });
    await owner.adminSession.create({
      data: {
        adminUserId: fixture.otherAdminId,
        expiresAt: sessionExpiresAt,
        id: fixture.otherAdminSessionId,
        mfaVerifiedAt: new Date(),
        refreshTokenHash: digest(`admin-session-${fixture.otherAdminId}`),
        tokenFamilyId: randomUUID(),
      },
    });
    await owner.memberSession.createMany({
      data: [
        {
          expiresAt: sessionExpiresAt,
          id: fixture.memberSessionId,
          memberId: fixture.memberId,
          refreshTokenHash: digest(`member-session-${fixture.memberId}`),
          storeId: BEAUTY_STORE_ID,
          tokenFamilyId: randomUUID(),
        },
        {
          expiresAt: sessionExpiresAt,
          id: fixture.otherMemberSessionId,
          memberId: fixture.otherMemberId,
          refreshTokenHash: digest(`member-session-${fixture.otherMemberId}`),
          storeId: BEAUTY_STORE_ID,
          tokenFamilyId: randomUUID(),
        },
        {
          expiresAt: sessionExpiresAt,
          id: fixture.fashionMemberSessionId,
          memberId: fixture.fashionMemberId,
          refreshTokenHash: digest(`member-session-${fixture.fashionMemberId}`),
          storeId: FASHION_STORE_ID,
          tokenFamilyId: randomUUID(),
        },
      ],
    });
    await owner.storeRole.create({
      data: {
        code: `m63b3-review-${suffix}`,
        id: fixture.adminRoleId,
        name: 'M6.3-B3 local-test reviewer',
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.storeRolePermission.create({
      data: {
        permissionCode: 'store.after-sales.review',
        roleId: fixture.adminRoleId,
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.adminStoreRole.create({
      data: {
        adminUserId: fixture.adminId,
        grantedBy: fixture.adminId,
        roleId: fixture.adminRoleId,
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.adminStoreRole.create({
      data: {
        adminUserId: fixture.otherAdminId,
        grantedBy: fixture.adminId,
        roleId: fixture.adminRoleId,
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.platformRole.create({
      data: {
        code: `m63b3-cross-store-${suffix}`,
        id: fixture.platformRoleId,
        name: 'M6.3-B3 local-test cross-store role',
      },
    });
    await owner.platformRolePermission.create({
      data: {
        permissionCode: 'platform.stores.cross_access',
        platformRoleId: fixture.platformRoleId,
      },
    });
    await owner.adminPlatformRole.create({
      data: {
        adminUserId: fixture.adminId,
        grantedBy: fixture.adminId,
        platformRoleId: fixture.platformRoleId,
      },
    });
    await owner.storeZaloApp.update({
      data: {
        enabled: true,
        miniAppId: `m63b3-app-${suffix}`,
        parentAppId: `m63b3-parent-${suffix}`,
      },
      where: {
        storeId_environment: { environment: 'TEST', storeId: BEAUTY_STORE_ID },
      },
    });
    await owner.storePaymentChannel.create({
      data: {
        checkoutAppId: `m63b3-app-${suffix}`,
        deploymentEnvironment: 'TEST',
        id: fixture.paymentChannelId,
        keyVersion: 'test-v1',
        merchantReference: `m63b3-merchant-${suffix}`,
        methodCode: 'ZALOPAY_SANDBOX',
        paymentWindowSeconds: 600,
        privateKeySecretRef: `test://m63b3/${suffix}/payment-key`,
        providerCode: 'ZALO_CHECKOUT_ZALOPAY',
        providerEnvironment: 'SANDBOX',
        secretFingerprint: digest(`payment-secret-${suffix}`),
        status: 'ACTIVE',
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.storeShippingChannel.create({
      data: {
        defaultServiceCode: 'LOCAL_TEST',
        id: fixture.shippingChannelId,
        keyVersion: 'test-v1',
        originAllowlistKey: 'GHN_SANDBOX',
        providerCode: 'GHN',
        providerEnvironment: 'SANDBOX',
        secretFingerprint: digest(`shipping-secret-${suffix}`),
        shopId: `m63b3-${suffix}`,
        status: 'ACTIVE',
        storeId: BEAUTY_STORE_ID,
        tokenSecretRef: `test://m63b3/${suffix}/shipping-token`,
      },
    });
    await owner.brand.create({
      data: { code: `m63b3-brand-${suffix}`, id: fixture.brandId, storeId: BEAUTY_STORE_ID },
    });
    await owner.product.create({
      data: {
        brandId: fixture.brandId,
        code: `m63b3-product-${suffix}`,
        id: fixture.productId,
        mainCategoryId: BEAUTY_CATEGORY_ID,
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.sku.create({
      data: {
        code: `m63b3-sku-${suffix}`,
        id: fixture.skuId,
        optionCombinationHash: digest(`sku-options-${suffix}`),
        optionCombinationKey: `m63b3=${suffix}`,
        productId: fixture.productId,
        salePriceVnd: 120_000,
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.attributeOption.create({
      data: {
        attributeDefinitionId: BEAUTY_SHADE_DEFINITION_ID,
        code: `exchange-shade-${suffix}`,
        id: fixture.exchangeReplacementShadeOptionId,
        labelEn: 'Exchange shade',
        labelVi: 'Mau doi',
        labelZh: '换货色号',
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.attributeTemplate.create({
      data: {
        code: `m63b3-exchange-${suffix}`,
        id: fixture.exchangeAttributeTemplateId,
        industry: 'BEAUTY',
        storeId: BEAUTY_STORE_ID,
      },
    });
    await owner.attributeTemplateVersion.create({
      data: {
        id: fixture.exchangeAttributeTemplateVersionId,
        name: 'M6.3-B3 exchange fixture',
        storeId: BEAUTY_STORE_ID,
        templateId: fixture.exchangeAttributeTemplateId,
        version: 1,
      },
    });
    await owner.attributeDefinition.create({
      data: {
        code: `exchange-finish-${suffix}`,
        dataType: 'OPTION',
        filterable: true,
        id: fixture.exchangeFinishDefinitionId,
        labelEn: 'Finish',
        labelVi: 'Dang hoan thien',
        labelZh: '质地',
        purpose: 'SPECIFICATION',
        required: true,
        storeId: BEAUTY_STORE_ID,
        templateVersionId: fixture.exchangeAttributeTemplateVersionId,
      },
    });
    await owner.attributeOption.createMany({
      data: [
        {
          attributeDefinitionId: fixture.exchangeFinishDefinitionId,
          code: `exchange-finish-original-${suffix}`,
          id: fixture.exchangeFinishOriginalOptionId,
          labelEn: 'Original finish',
          labelVi: 'Dang goc',
          labelZh: '原质地',
          storeId: BEAUTY_STORE_ID,
        },
        {
          attributeDefinitionId: fixture.exchangeFinishDefinitionId,
          code: `exchange-finish-replacement-${suffix}`,
          id: fixture.exchangeFinishReplacementOptionId,
          labelEn: 'Replacement finish',
          labelVi: 'Dang doi',
          labelZh: '换货质地',
          storeId: BEAUTY_STORE_ID,
        },
      ],
    });
    await owner.sku.createMany({
      data: [
        {
          code: `m63b3-exchange-valid-${suffix}`,
          id: fixture.exchangeReplacementSkuId,
          optionCombinationHash: digest(`exchange-valid-${suffix}`),
          optionCombinationKey: `shade=exchange;finish=original;${suffix}`,
          productId: fixture.productId,
          salePriceVnd: 120_000,
          storeId: BEAUTY_STORE_ID,
        },
        {
          code: `m63b3-exchange-invalid-${suffix}`,
          id: fixture.exchangeReplacementInvalidFinishSkuId,
          optionCombinationHash: digest(`exchange-invalid-${suffix}`),
          optionCombinationKey: `shade=exchange;finish=replacement;${suffix}`,
          productId: fixture.productId,
          salePriceVnd: 120_000,
          storeId: BEAUTY_STORE_ID,
        },
      ],
    });
    await owner.skuOptionValue.createMany({
      data: [
        {
          attributeDefinitionId: BEAUTY_SHADE_DEFINITION_ID,
          optionId: BEAUTY_DEFAULT_SHADE_OPTION_ID,
          skuId: fixture.skuId,
          storeId: BEAUTY_STORE_ID,
        },
        {
          attributeDefinitionId: fixture.exchangeFinishDefinitionId,
          optionId: fixture.exchangeFinishOriginalOptionId,
          skuId: fixture.skuId,
          storeId: BEAUTY_STORE_ID,
        },
        {
          attributeDefinitionId: BEAUTY_SHADE_DEFINITION_ID,
          optionId: fixture.exchangeReplacementShadeOptionId,
          skuId: fixture.exchangeReplacementSkuId,
          storeId: BEAUTY_STORE_ID,
        },
        {
          attributeDefinitionId: fixture.exchangeFinishDefinitionId,
          optionId: fixture.exchangeFinishOriginalOptionId,
          skuId: fixture.exchangeReplacementSkuId,
          storeId: BEAUTY_STORE_ID,
        },
        {
          attributeDefinitionId: BEAUTY_SHADE_DEFINITION_ID,
          optionId: fixture.exchangeReplacementShadeOptionId,
          skuId: fixture.exchangeReplacementInvalidFinishSkuId,
          storeId: BEAUTY_STORE_ID,
        },
        {
          attributeDefinitionId: fixture.exchangeFinishDefinitionId,
          optionId: fixture.exchangeFinishReplacementOptionId,
          skuId: fixture.exchangeReplacementInvalidFinishSkuId,
          storeId: BEAUTY_STORE_ID,
        },
      ],
    });

    await withStoreTransaction(owner, adminContext(), async (transaction) => {
      await transaction.afterSalePolicy.create({
        data: {
          code: `m63b3-policy-${suffix}`,
          createdBy: fixture.adminId,
          draftHash: policyHash,
          draftPayload: policyContent,
          id: fixture.policyId,
          status: 'DRAFT',
          storeId: BEAUTY_STORE_ID,
          updatedBy: fixture.adminId,
        },
      });
      await transaction.afterSalePolicyVersion.create({
        data: {
          allowedTypes: policyContent.allowed_types,
          conditionRules: policyContent.condition_rules,
          damagedException: policyContent.damaged_exception,
          defectException: policyContent.defect_exception,
          effectiveAt: new Date(),
          exchangeAttributeCode: policyContent.exchange_attribute_code,
          exchangeSameProductOnly: policyContent.exchange_same_product_only,
          hygieneRestricted: policyContent.hygiene_restricted,
          id: fixture.policyVersionId,
          payload: policyContent,
          payloadHash: policyHash,
          policyId: fixture.policyId,
          publishedBy: fixture.adminId,
          requestWindowDays: policyContent.request_window_days,
          returnShippingPayer: policyContent.return_shipping_payer,
          returnWindowDays: policyContent.return_window_days,
          storeId: BEAUTY_STORE_ID,
          unopenedRequired: policyContent.unopened_required,
          versionNumber: 1,
          wrongItemException: policyContent.wrong_item_exception,
        },
      });
      await transaction.afterSalePolicyLocalization.createMany({
        data: policyContent.localizations.map((localization) => ({
          buyerInstructions: localization.buyer_instructions,
          locale: localization.locale,
          name: localization.name,
          policyVersionId: fixture.policyVersionId,
          storeId: BEAUTY_STORE_ID,
          summary: localization.summary,
        })),
      });
      await transaction.afterSalePolicyVersionAssignment.create({
        data: {
          id: fixture.assignmentId,
          policyId: fixture.policyId,
          policyVersionId: fixture.policyVersionId,
          productId: fixture.productId,
          storeId: BEAUTY_STORE_ID,
          targetType: 'PRODUCT',
        },
      });
      await transaction.afterSalePolicy.update({
        data: {
          currentVersionId: fixture.policyVersionId,
          status: 'ACTIVE',
          updatedBy: fixture.adminId,
          version: { increment: 1 },
        },
        where: { id: fixture.policyId },
      });
      await transaction.afterSaleActivePolicyAssignment.create({
        data: {
          assignmentId: fixture.assignmentId,
          policyId: fixture.policyId,
          policyVersionId: fixture.policyVersionId,
          productId: fixture.productId,
          storeId: BEAUTY_STORE_ID,
          targetType: 'PRODUCT',
        },
      });
    });
  });

  afterAll(async () => {
    await Promise.allSettled([owner?.$disconnect(), runtime?.$disconnect()]);
    if (scratchCreated) {
      assertScratchName();
      await admin.$executeRawUnsafe(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${scratchDatabaseName}' AND pid <> pg_backend_pid()`,
      );
      await admin.$executeRawUnsafe(`DROP DATABASE "${scratchDatabaseName}"`);
    }
    await admin.$disconnect();
  });

  it('atomically creates and replays a normal member case without trusting ciphertext', async () => {
    const order = await createOrder({ tag: 'normal' });
    const input = memberCreateInput(order, 'normal');
    const created = await createMemberAfterSaleCommand(requiredRuntime(), memberContext(), input);
    expect(created).toMatchObject({ replayed: false, status: 'PENDING_REVIEW', version: 1 });
    expect(created.publicCaseNumber).toMatch(/^ASC-[0-9A-F]{32}$/u);
    expect(created.publicCaseNumber).not.toBe(
      `ASC-${created.afterSaleId.replaceAll('-', '').toUpperCase()}`,
    );

    const visibleOperations = await withStoreTransaction(
      requiredRuntime(),
      memberContext(),
      (transaction) =>
        transaction.$queryRaw<
          Array<{
            id: string;
            idempotency_key_hash: string;
            operation: string;
            request_hash: string;
            status: string;
          }>
        >`
          SELECT operation_row.id, operation_row.idempotency_key_hash,
            operation_row.operation, operation_row.request_hash, operation_row.status
          FROM after_sales sale
          JOIN after_sale_operations operation_row
            ON operation_row.store_id = sale.store_id
           AND operation_row.after_sale_id = sale.id
          WHERE sale.store_id = ${BEAUTY_STORE_ID}::uuid
            AND sale.idempotency_key_hash = ${digest(input.idempotencyKey)}
            AND operation_row.operation = 'MEMBER_CREATE'
        `,
    );
    expect(visibleOperations).toHaveLength(1);
    expect(visibleOperations[0]).toMatchObject({
      id: created.operationId,
      idempotency_key_hash: digest(input.idempotencyKey),
      operation: 'MEMBER_CREATE',
      status: 'COMPLETED',
    });
    expect(visibleOperations[0]?.request_hash).toMatch(/^[0-9a-f]{64}$/u);
    const expectedRequestHash = canonicalAfterSaleCommandRequestHash({
      actor_id: fixture.memberId,
      actor_type: 'member',
      evidence_ids: [],
      items: [{ order_item_id: order.itemId, quantity: 1, replacement_sku_id: null }],
      idempotency_key_hash: digest(input.idempotencyKey),
      operation: 'MEMBER_CREATE',
      order_id: order.id,
      path: '/v1/after-sales',
      reason_code: input.reasonCode,
      reason_detail_hash: input.reasonDetailHash,
      store_id: BEAUTY_STORE_ID,
      type: input.type,
    });
    expect(visibleOperations[0]?.request_hash).toBe(expectedRequestHash);
    const replayQuery = await withStoreTransaction(
      requiredRuntime(),
      memberContext(),
      (transaction) =>
        transaction.$queryRaw<
          Array<{
            after_sale_id: string;
            operation_id: string;
            request_hash: string;
            operation_status: string;
            result_summary: unknown;
          }>
        >`
          SELECT sale.id AS after_sale_id, operation_row.id AS operation_id,
            operation_row.request_hash, operation_row.status AS operation_status, operation_row.result_summary
          FROM after_sales sale
          JOIN after_sale_operations operation_row
            ON operation_row.store_id = sale.store_id
           AND operation_row.after_sale_id = sale.id
          WHERE sale.store_id = ${BEAUTY_STORE_ID}::uuid
            AND sale.idempotency_key_hash = ${digest(input.idempotencyKey)}
            AND operation_row.operation = 'MEMBER_CREATE'
        `,
    );
    expect(replayQuery).toHaveLength(1);
    expect(replayQuery[0]).toMatchObject({
      after_sale_id: created.afterSaleId,
      operation_id: created.operationId,
      operation_status: 'COMPLETED',
      request_hash: expectedRequestHash,
    });
    expect(replayQuery[0]?.result_summary).toBeTruthy();

    const replayed = await createMemberAfterSaleCommand(requiredRuntime(), memberContext(), {
      ...input,
      reasonDetailCiphertext: 'different-randomized-ciphertext',
    });
    expect(replayed).toEqual({ ...created, replayed: true });
    await expectCommandFailure(
      () =>
        createMemberAfterSaleCommand(requiredRuntime(), memberContext(), {
          ...input,
          reasonDetailHash: digest('different-reason-detail'),
        }),
      'AFTER_SALE_IDEMPOTENCY_CONFLICT',
    );

    const [facts] = await requiredOwner().$queryRaw<
      Array<{
        audit_count: bigint;
        operation_status: string;
        requested_shipping_vnd: bigint;
        transition_event: string;
        transition_operation_id: string;
      }>
    >`
      SELECT sale.requested_shipping_vnd, operation.status AS operation_status,
        transition.event AS transition_event,
        transition.operation_id AS transition_operation_id,
        (SELECT count(*) FROM audit_logs audit
          WHERE audit.store_id = sale.store_id
            AND audit.action = 'after-sale.member.submitted'
            AND audit.target_id = sale.id::text) AS audit_count
      FROM after_sales sale
      JOIN after_sale_operations operation
        ON operation.store_id = sale.store_id AND operation.after_sale_id = sale.id
      JOIN after_sale_transitions transition
        ON transition.store_id = operation.store_id
        AND transition.operation_id = operation.id
        AND transition.after_sale_id = sale.id
      WHERE sale.store_id = ${BEAUTY_STORE_ID}::uuid AND sale.id = ${created.afterSaleId}::uuid
    `;
    expect(facts).toEqual({
      audit_count: 1n,
      operation_status: 'COMPLETED',
      requested_shipping_vnd: 0n,
      transition_event: 'SUBMIT',
      transition_operation_id: created.operationId,
    });
  });

  it('retries serialization failures within the idempotent create and cancel boundaries', async () => {
    const owner = requiredOwner();
    const createSequence = 'm63b3_test_retry_create_seq';
    const createFunction = 'm63b3_test_retry_create_fn';
    const createTrigger = 'm63b3_test_retry_create';
    await owner.$executeRawUnsafe(`CREATE SEQUENCE app_security.${createSequence}`);
    await owner.$executeRawUnsafe(`
      CREATE FUNCTION app_security.${createFunction}()
      RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = pg_catalog, public, pg_temp
      AS $$
      BEGIN
        IF NEW.reason_detail_ciphertext = 'm63b3-retry-create-ciphertext'
           AND pg_catalog.nextval('app_security.${createSequence}'::regclass) = 1
        THEN
          RAISE EXCEPTION 'M6.3-B3 injected create serialization failure'
            USING ERRCODE = '40001';
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await owner.$executeRawUnsafe(`
      CREATE TRIGGER ${createTrigger}
      BEFORE INSERT ON after_sales
      FOR EACH ROW EXECUTE FUNCTION app_security.${createFunction}()
    `);

    let created: Awaited<ReturnType<typeof createMemberAfterSaleCommand>>;
    try {
      const order = await createOrder({ tag: 'serialization-create' });
      created = await createMemberAfterSaleCommand(requiredRuntime(), memberContext(), {
        ...memberCreateInput(order, 'serialization-create'),
        reasonDetailCiphertext: 'm63b3-retry-create-ciphertext',
      });
      expect(created).toMatchObject({ replayed: false, status: 'PENDING_REVIEW', version: 1 });
      const [sequence] = await owner.$queryRawUnsafe<Array<{ last_value: bigint }>>(
        `SELECT last_value FROM app_security.${createSequence}`,
      );
      expect(sequence?.last_value).toBe(2n);
      expect(await owner.afterSale.count({ where: { id: created.afterSaleId } })).toBe(1);
      expect(
        await owner.afterSaleOperation.count({ where: { afterSaleId: created.afterSaleId } }),
      ).toBe(1);
    } finally {
      await owner.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${createTrigger} ON after_sales`);
      await owner.$executeRawUnsafe(`DROP FUNCTION IF EXISTS app_security.${createFunction}()`);
      await owner.$executeRawUnsafe(`DROP SEQUENCE IF EXISTS app_security.${createSequence}`);
    }

    const cancelSequence = 'm63b3_test_retry_cancel_seq';
    const cancelFunction = 'm63b3_test_retry_cancel_fn';
    const cancelTrigger = 'm63b3_test_retry_cancel';
    await owner.$executeRawUnsafe(`CREATE SEQUENCE app_security.${cancelSequence}`);
    await owner.$executeRawUnsafe(`
      CREATE FUNCTION app_security.${cancelFunction}()
      RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = pg_catalog, public, pg_temp
      AS $$
      BEGIN
        IF NEW.operation = 'MEMBER_CANCEL'
           AND pg_catalog.nextval('app_security.${cancelSequence}'::regclass) = 1
        THEN
          RAISE EXCEPTION 'M6.3-B3 injected cancel serialization failure'
            USING ERRCODE = '40001';
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await owner.$executeRawUnsafe(`
      CREATE TRIGGER ${cancelTrigger}
      BEFORE INSERT ON after_sale_operations
      FOR EACH ROW EXECUTE FUNCTION app_security.${cancelFunction}()
    `);
    try {
      const cancelled = await cancelMemberAfterSaleCommand(requiredRuntime(), memberContext(), {
        afterSaleId: created.afterSaleId,
        expectedVersion: 1,
        idempotencyKey: `m63b3-serialization-cancel-${suffix}`,
        reason: 'Cancel after the injected serialization conflict is safely retried.',
        sourceIp: '127.0.0.1',
      });
      expect(cancelled).toMatchObject({ replayed: false, status: 'CANCELLED', version: 2 });
      const [sequence] = await owner.$queryRawUnsafe<Array<{ last_value: bigint }>>(
        `SELECT last_value FROM app_security.${cancelSequence}`,
      );
      expect(sequence?.last_value).toBe(2n);
      expect(
        await owner.afterSaleOperation.count({ where: { afterSaleId: created.afterSaleId } }),
      ).toBe(2);
      expect(
        await owner.afterSaleTransition.count({ where: { afterSaleId: created.afterSaleId } }),
      ).toBe(2);
    } finally {
      await owner.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS ${cancelTrigger} ON after_sale_operations`,
      );
      await owner.$executeRawUnsafe(`DROP FUNCTION IF EXISTS app_security.${cancelFunction}()`);
      await owner.$executeRawUnsafe(`DROP SEQUENCE IF EXISTS app_security.${cancelSequence}`);
    }
  });

  it('creates legacy review and merchant-refund cases through distinct actor contracts', async () => {
    const legacyOrder = await createOrder({
      delivered: false,
      quantity: 1,
      tag: 'legacy',
      withPolicy: false,
    });
    const legacy = await createMemberAfterSaleCommand(
      requiredRuntime(),
      memberContext(),
      memberCreateInput(legacyOrder, 'legacy'),
    );
    expect(legacy).toMatchObject({ replayed: false, status: 'REVIEW_REQUIRED', version: 1 });
    const merchantLegacyOrder = await createOrder({
      delivered: false,
      tag: 'merchant-legacy',
      withPolicy: false,
    });
    await expectCommandFailure(
      () =>
        createMerchantRefundAfterSaleCommand(requiredRuntime(), adminContext(), {
          idempotencyKey: `m63b3-merchant-legacy-${suffix}`,
          items: [{ orderItemId: merchantLegacyOrder.itemId, quantity: 1 }],
          orderId: merchantLegacyOrder.id,
          reasonCode: 'damaged-item',
          reasonDetailCiphertext: 'test-merchant-legacy-ciphertext',
          reasonDetailHash: digest('merchant-legacy-detail'),
          sourceIp: '127.0.0.1',
          type: 'MERCHANT_REFUND',
        }),
      'AFTER_SALE_POLICY_MISMATCH',
    );
    await expectCommandFailure(
      () =>
        createMemberAfterSaleCommand(requiredRuntime(), memberContext(), {
          ...memberCreateInput(legacyOrder, 'legacy-conflict'),
          idempotencyKey: 'm63b3-unused-legacy-create-key',
        }),
      'AFTER_SALE_QUANTITY_EXCEEDS_AVAILABLE',
    );

    const merchantOrder = await createOrder({ tag: 'merchant' });
    const merchant = await createMerchantRefundAfterSaleCommand(requiredRuntime(), adminContext(), {
      idempotencyKey: `m63b3-merchant-${suffix}`,
      items: [{ orderItemId: merchantOrder.itemId, quantity: 1 }],
      orderId: merchantOrder.id,
      reasonCode: 'damaged-item',
      reasonDetailCiphertext: 'test-merchant-ciphertext',
      reasonDetailHash: digest('merchant-detail'),
      sourceIp: '127.0.0.1',
      type: 'MERCHANT_REFUND',
    });
    expect(merchant).toMatchObject({ replayed: false, status: 'PENDING_REVIEW', version: 1 });
    const merchantCase = await requiredOwner().afterSale.findUniqueOrThrow({
      select: { initiatedBy: true, memberId: true, source: true, type: true },
      where: { id: merchant.afterSaleId },
    });
    expect(merchantCase).toEqual({
      initiatedBy: fixture.adminId,
      memberId: fixture.memberId,
      source: 'ADMIN',
      type: 'MERCHANT_REFUND',
    });
    await expectSqlState(
      () =>
        withStoreTransaction(
          requiredRuntime(),
          adminContext(fixture.otherAdminId),
          (transaction) => transaction.$queryRaw`
            SELECT * FROM app_security.finalize_m63_b3_after_sale_submit(
              ${merchant.afterSaleId}::uuid,
              ${merchant.operationId}::uuid,
              ${'127.0.0.1'}::inet
            )
          `,
        ),
      'P0002',
    );
  });

  it('allows only a policy-approved equivalent exchange and rejects replacement misuse', async () => {
    const exchangePolicy = await createPolicyFixture(
      {
        ...policyContent,
        allowed_types: ['EXCHANGE'],
        exchange_attribute_code: 'shade',
      },
      'exchange-policy',
    );
    const optionSnapshot = [
      {
        attributeDefinitionId: BEAUTY_SHADE_DEFINITION_ID,
        optionId: BEAUTY_DEFAULT_SHADE_OPTION_ID,
      },
      {
        attributeDefinitionId: fixture.exchangeFinishDefinitionId,
        optionId: fixture.exchangeFinishOriginalOptionId,
      },
    ] satisfies Prisma.InputJsonValue;
    const validOrder = await createOrder({
      optionSnapshot,
      policy: exchangePolicy,
      quantity: 1,
      tag: 'exchange-valid',
    });
    const valid = await createMemberAfterSaleCommand(
      requiredRuntime(),
      memberContext(),
      memberCreateInput(validOrder, 'exchange-valid', 1, {
        replacementSkuId: fixture.exchangeReplacementSkuId,
        type: 'EXCHANGE',
      }),
    );
    expect(valid).toMatchObject({ replayed: false, status: 'PENDING_REVIEW', version: 1 });
    expect(
      await requiredOwner().afterSaleItem.findFirstOrThrow({
        select: { replacementSkuId: true },
        where: { afterSaleId: valid.afterSaleId },
      }),
    ).toEqual({ replacementSkuId: fixture.exchangeReplacementSkuId });

    const invalidAttributeOrder = await createOrder({
      optionSnapshot,
      policy: exchangePolicy,
      quantity: 1,
      tag: 'exchange-invalid',
    });
    await expectCommandFailure(
      () =>
        createMemberAfterSaleCommand(
          requiredRuntime(),
          memberContext(),
          memberCreateInput(invalidAttributeOrder, 'exchange-invalid', 1, {
            replacementSkuId: fixture.exchangeReplacementInvalidFinishSkuId,
            type: 'EXCHANGE',
          }),
        ),
      'AFTER_SALE_EXCHANGE_NOT_ALLOWED',
    );

    const nonExchangeOrder = await createOrder({ quantity: 1, tag: 'non-exchange' });
    await expectCommandFailure(
      () =>
        createMemberAfterSaleCommand(
          requiredRuntime(),
          memberContext(),
          memberCreateInput(nonExchangeOrder, 'non-exchange', 1, {
            replacementSkuId: fixture.exchangeReplacementSkuId,
          }),
        ),
      'AFTER_SALE_INPUT_INVALID',
    );
  });

  it('allocates odd VND exactly and rejects exhausted line capacity', async () => {
    const order = await createOrder({ payableVnd: 100_001, quantity: 3, tag: 'odd-vnd' });
    const first = await createMemberAfterSaleCommand(
      requiredRuntime(),
      memberContext(),
      memberCreateInput(order, 'odd-first', 1),
    );
    const second = await createMemberAfterSaleCommand(
      requiredRuntime(),
      memberContext(),
      memberCreateInput(order, 'odd-second', 2),
    );
    const amounts = await requiredOwner().afterSale.findMany({
      orderBy: { requestedItemVnd: 'asc' },
      select: { requestedItemVnd: true },
      where: { id: { in: [first.afterSaleId, second.afterSaleId] } },
    });
    expect(amounts).toEqual([{ requestedItemVnd: 33_333n }, { requestedItemVnd: 66_668n }]);
    await expectCommandFailure(
      () =>
        createMemberAfterSaleCommand(
          requiredRuntime(),
          memberContext(),
          memberCreateInput(order, 'odd-exhausted', 1),
        ),
      'AFTER_SALE_QUANTITY_EXCEEDS_AVAILABLE',
    );
  });

  it('does not count a linked provider refund twice against order capacity', async () => {
    const order = await createOrder({ payableVnd: 120_000, quantity: 2, tag: 'linked-refund' });
    const existing = await createMemberAfterSaleCommand(
      requiredRuntime(),
      memberContext(),
      memberCreateInput(order, 'linked-refund-existing', 1),
    );
    const payment = await requiredOwner().paymentAttempt.findFirstOrThrow({
      select: { id: true },
      where: { orderId: order.id, storeId: BEAUTY_STORE_ID },
    });
    const refundId = randomUUID();
    const settlementId = randomUUID();
    await requiredOwner().$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.afterSaleSettlement.create({
        data: {
          afterSaleId: existing.afterSaleId,
          amountVnd: 60_000n,
          id: settlementId,
          idempotencyKeyHash: digest(`linked-settlement-key-${settlementId}`),
          method: 'ONLINE_ORIGINAL',
          orderId: order.id,
          paymentAttemptId: payment.id,
          publicSettlementNumber: `AST-${settlementId.replaceAll('-', '').toUpperCase()}`,
          requestHash: digest(`linked-settlement-request-${settlementId}`),
          requestedBy: fixture.adminId,
          status: 'PENDING',
          storeId: BEAUTY_STORE_ID,
        },
      });
      await transaction.refund.create({
        data: {
          amountVnd: 60_000n,
          id: refundId,
          idempotencyKeyHash: digest(`linked-refund-key-${refundId}`),
          orderId: order.id,
          paymentAttemptId: payment.id,
          publicRefundNumber: `RFD-${refundId.replaceAll('-', '').toUpperCase()}`,
          reason: 'M6.3-B3 linked refund capacity fixture',
          requestedBy: fixture.adminId,
          status: 'REQUESTED',
          storeId: BEAUTY_STORE_ID,
        },
      });
      await transaction.afterSaleRefund.create({
        data: {
          afterSaleId: existing.afterSaleId,
          amountVnd: 60_000n,
          orderId: order.id,
          paymentAttemptId: payment.id,
          refundId,
          settlementId,
          storeId: BEAUTY_STORE_ID,
        },
      });
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });

    const remaining = await createMemberAfterSaleCommand(
      requiredRuntime(),
      memberContext(),
      memberCreateInput(order, 'linked-refund-remaining', 1),
    );
    expect(remaining).toMatchObject({ replayed: false, status: 'PENDING_REVIEW', version: 1 });
    expect(
      await requiredOwner().afterSale.aggregate({
        _sum: { requestedTotalVnd: true },
        where: { id: { in: [existing.afterSaleId, remaining.afterSaleId] } },
      }),
    ).toEqual({ _sum: { requestedTotalVnd: 120_000n } });
  });

  it('assigns merchant-paid shipping once and serializes competing capacity claims', async () => {
    const shippingOrder = await createOrder({
      itemPayableVnd: 100_000,
      payableVnd: 120_000,
      quantity: 2,
      shippingFeeVnd: 20_000,
      tag: 'shipping-entitlement',
    });
    const first = await createMemberAfterSaleCommand(
      requiredRuntime(),
      memberContext(),
      memberCreateInput(shippingOrder, 'shipping-first', 1, { type: 'RETURN_REFUND' }),
    );
    await expectCommandFailure(
      () =>
        createMemberAfterSaleCommand(
          requiredRuntime(),
          memberContext(),
          memberCreateInput(shippingOrder, 'shipping-second', 1, { type: 'RETURN_REFUND' }),
        ),
      'AFTER_SALE_QUANTITY_EXCEEDS_AVAILABLE',
    );
    const shippingAllocations = await requiredOwner().afterSale.findMany({
      select: { requestedItemVnd: true, requestedShippingVnd: true, requestedTotalVnd: true },
      where: { id: first.afterSaleId },
    });
    expect(shippingAllocations).toEqual([
      { requestedItemVnd: 50_000n, requestedShippingVnd: 20_000n, requestedTotalVnd: 70_000n },
    ]);

    const concurrentOrder = await createOrder({
      itemPayableVnd: 100_000,
      payableVnd: 120_000,
      quantity: 1,
      shippingFeeVnd: 20_000,
      tag: 'concurrent-capacity',
    });
    const concurrent = await Promise.allSettled([
      createMemberAfterSaleCommand(
        requiredRuntime(),
        memberContext(),
        memberCreateInput(concurrentOrder, 'concurrent-first', 1, { type: 'RETURN_REFUND' }),
      ),
      createMemberAfterSaleCommand(
        requiredRuntime(),
        memberContext(),
        memberCreateInput(concurrentOrder, 'concurrent-second', 1, { type: 'RETURN_REFUND' }),
      ),
    ]);
    expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = concurrent.find((result) => result.status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status === 'rejected') {
      expect(rejected.reason).toBeInstanceOf(AfterSaleCommandDatabaseError);
      expect(['AFTER_SALE_QUANTITY_EXCEEDS_AVAILABLE', 'AFTER_SALE_VERSION_CONFLICT']).toContain(
        (rejected.reason as AfterSaleCommandDatabaseError).code,
      );
    }
    expect(await requiredOwner().afterSale.count({ where: { orderId: concurrentOrder.id } })).toBe(
      1,
    );
  });

  it('breaks approval row-to-order lock inversion with a retryable conflict', async () => {
    const order = await createOrder({ payableVnd: 100_000, quantity: 2, tag: 'approval-lock' });
    const existing = await createMemberAfterSaleCommand(
      requiredRuntime(),
      memberContext(),
      memberCreateInput(order, 'approval-lock-existing', 1),
    );
    const existingItem = await requiredOwner().afterSaleItem.findFirstOrThrow({
      select: { id: true },
      where: { afterSaleId: existing.afterSaleId, storeId: BEAUTY_STORE_ID },
    });
    const b3Contender = createRuntimePrismaClient(runtimeUrl);

    let announceApprovalRowLock!: () => void;
    let releaseApprovalRowLock!: () => void;
    const approvalRowLocked = new Promise<void>((resolve) => {
      announceApprovalRowLock = resolve;
    });
    const approvalRowRelease = new Promise<void>((resolve) => {
      releaseApprovalRowLock = resolve;
    });

    await b3Contender.$connect();
    let approvalOutcome:
      { reason: unknown; status: 'rejected' } | { status: 'fulfilled'; value: unknown } | undefined;
    let createOutcome:
      | { reason: unknown; status: 'rejected' }
      | { status: 'fulfilled'; value: Awaited<ReturnType<typeof createMemberAfterSaleCommand>> }
      | undefined;
    let approvalBackendPid = 0;
    let observedApproval:
      | Promise<{ reason: unknown; status: 'rejected' } | { status: 'fulfilled'; value: unknown }>
      | undefined;
    let observedCreate:
      | Promise<
          | { reason: unknown; status: 'rejected' }
          | {
              status: 'fulfilled';
              value: Awaited<ReturnType<typeof createMemberAfterSaleCommand>>;
            }
        >
      | undefined;
    try {
      const approvalAttempt = withStoreTransaction(
        requiredRuntime(),
        adminContext(),
        async (transaction) => {
          const backends = await transaction.$queryRaw<Array<{ pid: number }>>`
            SELECT pg_catalog.pg_backend_pid()::integer AS pid
          `;
          approvalBackendPid = backends[0]?.pid ?? 0;
          if (approvalBackendPid === 0) {
            throw new Error('Approval backend PID is unavailable');
          }
          await transaction.$queryRaw`
            SELECT id
            FROM after_sale_items
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${existingItem.id}::uuid
            FOR UPDATE
          `;
          announceApprovalRowLock();
          await approvalRowRelease;
          return transaction.$executeRaw`
            UPDATE after_sale_items
            SET approved_quantity = 1, approved_item_vnd = 50000, updated_at = now()
            WHERE store_id = ${BEAUTY_STORE_ID}::uuid AND id = ${existingItem.id}::uuid
          `;
        },
        { isolationLevel: 'Serializable', timeout: 15_000 },
      );
      observedApproval = approvalAttempt.then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ reason, status: 'rejected' as const }),
      );
      await approvalRowLocked;

      const createAttempt = createMemberAfterSaleCommand(
        b3Contender,
        memberContext(),
        memberCreateInput(order, 'approval-lock-contender', 1),
      );
      observedCreate = createAttempt.then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ reason, status: 'rejected' as const }),
      );

      let contenderWait:
        { query: string; wait_event: string | null; wait_event_type: string | null } | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const activities = await requiredOwner().$queryRaw<
          Array<{ query: string; wait_event: string | null; wait_event_type: string | null }>
        >`
          SELECT query, wait_event, wait_event_type
          FROM pg_catalog.pg_stat_activity
          WHERE datname = pg_catalog.current_database()
            AND state = 'active'
            AND ${approvalBackendPid}::integer = ANY(pg_catalog.pg_blocking_pids(pid))
        `;
        contenderWait = activities.find((activity) => activity.wait_event_type === 'Lock');
        if (contenderWait) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(contenderWait).toMatchObject({ wait_event_type: 'Lock' });

      releaseApprovalRowLock();
      [approvalOutcome, createOutcome] = await Promise.all([observedApproval, observedCreate]);
    } finally {
      releaseApprovalRowLock();
      if (observedApproval && observedCreate) {
        [approvalOutcome, createOutcome] = await Promise.all([observedApproval, observedCreate]);
      } else if (observedApproval) {
        approvalOutcome = await observedApproval;
      }
      await b3Contender.$disconnect();
    }

    expect(approvalOutcome?.status).toBe('rejected');
    if (approvalOutcome?.status === 'rejected') {
      const failure = approvalOutcome.reason as {
        code?: unknown;
        meta?: { code?: unknown; message?: unknown };
      };
      expect(failure.meta?.code ?? failure.code, String(failure.meta?.message)).toBe('40001');
    }
    expect(createOutcome?.status).toBe('fulfilled');
    if (createOutcome?.status === 'fulfilled') {
      expect(createOutcome.value).toMatchObject({
        replayed: false,
        status: 'PENDING_REVIEW',
        version: 1,
      });
    }
    expect(
      await requiredOwner().afterSaleItem.findUniqueOrThrow({
        select: { approvedItemVnd: true, approvedQuantity: true },
        where: { id: existingItem.id },
      }),
    ).toEqual({ approvedItemVnd: 0n, approvedQuantity: 0 });
    expect(await requiredOwner().afterSale.count({ where: { orderId: order.id } })).toBe(2);
  });

  it('fails closed for COD, missing payment proof and missing delivery proof', async () => {
    const cod = await createOrder({ paymentMethod: 'COD', tag: 'cod' });
    const missingPayment = await createOrder({ paymentProof: false, tag: 'missing-payment' });
    const missingDelivery = await createOrder({ delivered: false, tag: 'missing-delivery' });
    await expectCommandFailure(
      () =>
        createMemberAfterSaleCommand(
          requiredRuntime(),
          memberContext(),
          memberCreateInput(cod, 'cod'),
        ),
      'AFTER_SALE_PAYMENT_NOT_PROVEN',
    );
    await expectCommandFailure(
      () =>
        createMemberAfterSaleCommand(
          requiredRuntime(),
          memberContext(),
          memberCreateInput(missingPayment, 'missing-payment'),
        ),
      'AFTER_SALE_PAYMENT_NOT_PROVEN',
    );
    await expectCommandFailure(
      () =>
        createMemberAfterSaleCommand(
          requiredRuntime(),
          memberContext(),
          memberCreateInput(missingDelivery, 'missing-delivery'),
        ),
      'AFTER_SALE_DELIVERY_NOT_PROVEN',
    );
    expect(
      await requiredOwner().afterSale.count({
        where: { orderId: { in: [cod.id, missingPayment.id, missingDelivery.id] } },
      }),
    ).toBe(0);
  });

  it('fails closed when policy evidence is required but the local capability set is unavailable', async () => {
    const evidencePolicy = await createPolicyFixture(
      {
        ...policyContent,
        condition_rules: {
          ...policyContent.condition_rules,
          evidence_required: true,
        },
      },
      'evidence-required',
    );
    const order = await createOrder({ policy: evidencePolicy, tag: 'evidence-required' });
    await expectCommandFailure(
      () =>
        createMemberAfterSaleCommand(
          requiredRuntime(),
          memberContext(),
          memberCreateInput(order, 'evidence-required'),
        ),
      'AFTER_SALE_EVIDENCE_CAPABILITY_UNAVAILABLE',
    );
    expect(await requiredOwner().afterSale.count({ where: { orderId: order.id } })).toBe(0);
  });

  it('claims ready evidence and rolls back header, claim, transition, operation and audit together', async () => {
    const evidencePolicy = await createPolicyFixture(
      {
        ...policyContent,
        condition_rules: {
          ...policyContent.condition_rules,
          evidence_required: true,
        },
      },
      'evidence-success',
    );
    const order = await createOrder({ policy: evidencePolicy, tag: 'evidence-success' });
    const evidence = await initializeAfterSaleEvidenceUpload(requiredRuntime(), memberContext(), {
      byteSize: 1_024,
      checksumSha256: digest(`m63b3-evidence-${suffix}`),
      deploymentEnvironment: 'test',
      filename: 'evidence.jpg',
      idempotencyKey: `m63b3-evidence-init-${suffix}`,
      maxUnclaimedBytes: 200 * 1_024 * 1_024,
      maxUnclaimedFiles: 12,
      mimeType: 'image/jpeg',
      uploadTtlSeconds: 900,
    });
    const confirmed = await confirmAfterSaleEvidenceUpload(requiredRuntime(), memberContext(), {
      evidenceId: evidence.evidence.id,
      expectedVersion: evidence.evidence.version,
      idempotencyKey: `m63b3-evidence-confirm-${suffix}`,
    });
    const scanned = await applyAfterSaleEvidenceScanResult(
      requiredRuntime(),
      createAfterSaleEvidenceSystemContext({
        correlationId: `m63b3-evidence-scan-${suffix}`,
        storeId: BEAUTY_STORE_ID,
      }),
      {
        claimTtlSeconds: 3_600,
        evidenceId: evidence.evidence.id,
        expectedVersion: confirmed.evidence.version,
        failedRetentionSeconds: 86_400,
        result: {
          engine: 'clamav',
          engineVersion: 'local-test',
          signatureVersion: 'local-test',
          verdict: 'CLEAN',
        },
        scanGeneration: confirmed.evidence.scanGeneration,
      },
    );
    expect(scanned.evidence.status).toBe('READY_UNCLAIMED');

    const created = await createMemberAfterSaleCommand(
      requiredRuntime(),
      memberContext(),
      memberCreateInput(order, 'evidence-success', 1, {
        evidenceCapabilities: ENABLED_EVIDENCE_CAPABILITIES,
        evidenceIds: [evidence.evidence.id],
        ordinaryAccessTtlSeconds: 1_800,
        retentionTtlSeconds: 7_200,
      }),
    );
    const claimed = await requiredOwner().afterSaleEvidenceFile.findUniqueOrThrow({
      select: {
        afterSaleId: true,
        ordinaryAccessDeadlineAt: true,
        retentionDeadlineAt: true,
        status: true,
      },
      where: { id: evidence.evidence.id },
    });
    expect(created.status).toBe('PENDING_REVIEW');
    expect(claimed.afterSaleId).toBe(created.afterSaleId);
    expect(claimed.status).toBe('READY');
    expect(claimed.ordinaryAccessDeadlineAt).not.toBeNull();
    expect(claimed.retentionDeadlineAt).not.toBeNull();
    expect(claimed.retentionDeadlineAt!.getTime()).toBeGreaterThan(
      claimed.ordinaryAccessDeadlineAt!.getTime(),
    );

    const rollbackOrder = await createOrder({ policy: evidencePolicy, tag: 'evidence-rollback' });
    const rollbackEvidence = await initializeAfterSaleEvidenceUpload(
      requiredRuntime(),
      memberContext(),
      {
        byteSize: 1_024,
        checksumSha256: digest(`m63b3-evidence-rollback-${suffix}`),
        deploymentEnvironment: 'test',
        filename: 'rollback-evidence.jpg',
        idempotencyKey: `m63b3-evidence-rollback-init-${suffix}`,
        maxUnclaimedBytes: 200 * 1_024 * 1_024,
        maxUnclaimedFiles: 12,
        mimeType: 'image/jpeg',
        uploadTtlSeconds: 900,
      },
    );
    const rollbackConfirmed = await confirmAfterSaleEvidenceUpload(
      requiredRuntime(),
      memberContext(),
      {
        evidenceId: rollbackEvidence.evidence.id,
        expectedVersion: rollbackEvidence.evidence.version,
        idempotencyKey: `m63b3-evidence-rollback-confirm-${suffix}`,
      },
    );
    const rollbackScanned = await applyAfterSaleEvidenceScanResult(
      requiredRuntime(),
      createAfterSaleEvidenceSystemContext({
        correlationId: `m63b3-evidence-rollback-scan-${suffix}`,
        storeId: BEAUTY_STORE_ID,
      }),
      {
        claimTtlSeconds: 3_600,
        evidenceId: rollbackEvidence.evidence.id,
        expectedVersion: rollbackConfirmed.evidence.version,
        failedRetentionSeconds: 86_400,
        result: {
          engine: 'clamav',
          engineVersion: 'local-test',
          signatureVersion: 'local-test',
          verdict: 'CLEAN',
        },
        scanGeneration: rollbackConfirmed.evidence.scanGeneration,
      },
    );
    const operationTrigger = 'm63b3_test_fail_member_create';
    const operationFunction = 'm63b3_test_fail_member_create_fn';
    await requiredOwner().$executeRawUnsafe(`
      CREATE FUNCTION app_security."${operationFunction}"()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION
          'B3 unknown P0001: idempotency key was reused; expected version was not found'
          USING ERRCODE = 'P0001';
      END
      $$;
    `);
    await requiredOwner().$executeRawUnsafe(`
      CREATE TRIGGER "${operationTrigger}"
      BEFORE INSERT ON after_sale_operations
      FOR EACH ROW WHEN (NEW.operation = 'MEMBER_CREATE')
      EXECUTE FUNCTION app_security."${operationFunction}"();
    `);
    try {
      let failure: unknown;
      try {
        await createMemberAfterSaleCommand(
          requiredRuntime(),
          memberContext(),
          memberCreateInput(rollbackOrder, 'evidence-rollback', 1, {
            evidenceCapabilities: ENABLED_EVIDENCE_CAPABILITIES,
            evidenceIds: [rollbackEvidence.evidence.id],
            ordinaryAccessTtlSeconds: 1_800,
            retentionTtlSeconds: 7_200,
          }),
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeDefined();
      expect(failure).not.toBeInstanceOf(AfterSaleCommandDatabaseError);
    } finally {
      await requiredOwner().$executeRawUnsafe(
        `DROP TRIGGER "${operationTrigger}" ON after_sale_operations`,
      );
      await requiredOwner().$executeRawUnsafe(
        `DROP FUNCTION app_security."${operationFunction}"()`,
      );
    }
    const rollbackEvidenceState = await requiredOwner().afterSaleEvidenceFile.findUniqueOrThrow({
      select: { afterSaleId: true, status: true, version: true },
      where: { id: rollbackEvidence.evidence.id },
    });
    expect(rollbackEvidenceState).toEqual({
      afterSaleId: null,
      status: 'READY_UNCLAIMED',
      version: rollbackScanned.evidence.version,
    });
    expect(await requiredOwner().afterSale.count({ where: { orderId: rollbackOrder.id } })).toBe(0);
    expect(
      await requiredOwner().afterSaleOperation.count({
        where: {
          idempotencyKeyHash: digest(`m63b3-member-evidence-rollback-${suffix}`),
          operation: 'MEMBER_CREATE',
          storeId: BEAUTY_STORE_ID,
        },
      }),
    ).toBe(0);
  });

  it('rechecks bearer, session, MFA and RBAC facts before command replay', async () => {
    const memberOrder = await createOrder({ tag: 'member-revoked' });
    const memberInput = memberCreateInput(memberOrder, 'member-revoked');
    const memberCreated = await createMemberAfterSaleCommand(
      requiredRuntime(),
      memberContext(),
      memberInput,
    );
    await expectAuthorizationExpiryAfterAdvisoryWait(
      memberContext(),
      `m63-b3:${BEAUTY_STORE_ID}:MEMBER_CREATE:${digest(memberInput.idempotencyKey)}`,
      (transaction) => transaction.$queryRaw`
        SELECT * FROM app_security.finalize_m63_b3_after_sale_submit(
          ${memberCreated.afterSaleId}::uuid,
          ${memberCreated.operationId}::uuid,
          ${'127.0.0.1'}::inet
        )
      `,
    );
    await requiredOwner().memberSession.update({
      data: { revokedAt: new Date() },
      where: { id: fixture.memberSessionId },
    });
    try {
      await expectCommandFailure(
        () => createMemberAfterSaleCommand(requiredRuntime(), memberContext(), memberInput),
        'AFTER_SALE_AUTHORIZATION_DENIED',
      );
    } finally {
      await requiredOwner().memberSession.update({
        data: { revokedAt: null },
        where: { id: fixture.memberSessionId },
      });
    }

    const staleMfaOrder = await createOrder({ tag: 'admin-stale-mfa' });
    const staleMfaInput = {
      idempotencyKey: `m63b3-admin-stale-mfa-${suffix}`,
      items: [{ orderItemId: staleMfaOrder.itemId, quantity: 1 }],
      orderId: staleMfaOrder.id,
      reasonCode: 'damaged-item',
      reasonDetailCiphertext: 'test-admin-stale-mfa-ciphertext',
      reasonDetailHash: digest('admin-stale-mfa'),
      sourceIp: '127.0.0.1',
      type: 'MERCHANT_REFUND' as const,
    };
    await createMerchantRefundAfterSaleCommand(requiredRuntime(), adminContext(), staleMfaInput);
    await requiredOwner().adminSession.update({
      data: { mfaVerifiedAt: new Date(Date.now() - 11 * 60 * 1_000) },
      where: { id: fixture.adminSessionId },
    });
    try {
      await expectCommandFailure(
        () =>
          createMerchantRefundAfterSaleCommand(requiredRuntime(), adminContext(), staleMfaInput),
        'AFTER_SALE_AUTHORIZATION_DENIED',
      );
    } finally {
      await requiredOwner().adminSession.update({
        data: { mfaVerifiedAt: new Date() },
        where: { id: fixture.adminSessionId },
      });
    }

    const revokedAdminSessionOrder = await createOrder({ tag: 'admin-session-revoked' });
    const revokedAdminSessionInput = {
      idempotencyKey: `m63b3-admin-session-revoked-${suffix}`,
      items: [{ orderItemId: revokedAdminSessionOrder.itemId, quantity: 1 }],
      orderId: revokedAdminSessionOrder.id,
      reasonCode: 'damaged-item',
      reasonDetailCiphertext: 'test-admin-session-revoked-ciphertext',
      reasonDetailHash: digest('admin-session-revoked'),
      sourceIp: '127.0.0.1',
      type: 'MERCHANT_REFUND' as const,
    };
    await createMerchantRefundAfterSaleCommand(
      requiredRuntime(),
      adminContext(),
      revokedAdminSessionInput,
    );
    await requiredOwner().adminSession.update({
      data: { revokedAt: new Date() },
      where: { id: fixture.adminSessionId },
    });
    try {
      await expectCommandFailure(
        () =>
          createMerchantRefundAfterSaleCommand(
            requiredRuntime(),
            adminContext(),
            revokedAdminSessionInput,
          ),
        'AFTER_SALE_AUTHORIZATION_DENIED',
      );
    } finally {
      await requiredOwner().adminSession.update({
        data: { revokedAt: null },
        where: { id: fixture.adminSessionId },
      });
    }

    const revokedRoleOrder = await createOrder({ tag: 'admin-role-revoked' });
    const revokedRoleInput = {
      idempotencyKey: `m63b3-admin-role-revoked-${suffix}`,
      items: [{ orderItemId: revokedRoleOrder.itemId, quantity: 1 }],
      orderId: revokedRoleOrder.id,
      reasonCode: 'damaged-item',
      reasonDetailCiphertext: 'test-admin-role-revoked-ciphertext',
      reasonDetailHash: digest('admin-role-revoked'),
      sourceIp: '127.0.0.1',
      type: 'MERCHANT_REFUND' as const,
    };
    await createMerchantRefundAfterSaleCommand(requiredRuntime(), adminContext(), revokedRoleInput);
    await requiredOwner().storeRolePermission.delete({
      where: {
        storeId_roleId_permissionCode: {
          permissionCode: 'store.after-sales.review',
          roleId: fixture.adminRoleId,
          storeId: BEAUTY_STORE_ID,
        },
      },
    });
    try {
      await expectCommandFailure(
        () =>
          createMerchantRefundAfterSaleCommand(requiredRuntime(), adminContext(), revokedRoleInput),
        'AFTER_SALE_AUTHORIZATION_DENIED',
      );
    } finally {
      await requiredOwner().storeRolePermission.create({
        data: {
          permissionCode: 'store.after-sales.review',
          roleId: fixture.adminRoleId,
          storeId: BEAUTY_STORE_ID,
        },
      });
    }
  });

  it('fails closed for an audited CROSS_STORE merchant-refund database context', async () => {
    const correlationId = `m63b3-cross-store-${suffix}-${randomUUID()}`;
    const crossStoreContext = crossStoreAdminContext(correlationId);
    await requiredOwner().auditLog.create({
      data: {
        action: 'platform.cross_store.accessed',
        actorId: fixture.adminId,
        actorType: 'ADMIN',
        afterData: { requiredPermission: 'store.after-sales.review' },
        correlationId,
        reason: 'Investigate local-test incident INC-M63B3-1001',
        storeId: BEAUTY_STORE_ID,
        targetId: BEAUTY_STORE_ID,
        targetType: 'store',
      },
    });
    await expectSqlState(
      () =>
        withStoreTransaction(
          requiredRuntime(),
          crossStoreContext,
          (transaction) =>
            transaction.$queryRaw`
            SELECT * FROM app_security.finalize_m63_b3_after_sale_submit(
              ${randomUUID()}::uuid,
              ${randomUUID()}::uuid,
              ${'127.0.0.1'}::inet
            )
          `,
        ),
      '42501',
    );
  });

  it('cancels only the owning non-legacy case and never persists the reason plaintext', async () => {
    const order = await createOrder({ tag: 'cancel' });
    const created = await createMemberAfterSaleCommand(
      requiredRuntime(),
      memberContext(),
      memberCreateInput(order, 'cancel-create'),
    );
    const reason = 'Member changed their mind for this local test request';
    const cancellationKey = `m63b3-cancel-${suffix}`;
    await expectCommandFailure(
      () =>
        import('@zalo-shop/database').then(({ cancelMemberAfterSaleCommand }) =>
          cancelMemberAfterSaleCommand(requiredRuntime(), memberContext(fixture.otherMemberId), {
            afterSaleId: created.afterSaleId,
            expectedVersion: 1,
            idempotencyKey: `m63b3-cancel-other-${suffix}`,
            reason,
          }),
        ),
      'AFTER_SALE_NOT_FOUND',
    );
    const { cancelMemberAfterSaleCommand } = await import('@zalo-shop/database');
    const cancelled = await cancelMemberAfterSaleCommand(requiredRuntime(), memberContext(), {
      afterSaleId: created.afterSaleId,
      expectedVersion: 1,
      idempotencyKey: cancellationKey,
      reason,
      sourceIp: '127.0.0.1',
    });
    expect(cancelled).toMatchObject({ replayed: false, status: 'CANCELLED', version: 2 });
    const cancellationOperation = await requiredOwner().afterSaleOperation.findUniqueOrThrow({
      select: { idempotencyKeyHash: true, requestHash: true },
      where: { id: cancelled.operationId },
    });
    await expectAuthorizationExpiryAfterAdvisoryWait(
      memberContext(),
      `m63-b3:${BEAUTY_STORE_ID}:MEMBER_CANCEL:${cancellationOperation.idempotencyKeyHash}`,
      (transaction) => transaction.$queryRaw`
        SELECT * FROM app_security.cancel_m63_b3_member_after_sale(
          ${created.afterSaleId}::uuid,
          ${cancelled.operationId}::uuid,
          ${cancellationOperation.idempotencyKeyHash},
          ${cancellationOperation.requestHash},
          ${1}::integer,
          ${'127.0.0.1'}::inet
        )
      `,
    );
    const replayed = await cancelMemberAfterSaleCommand(requiredRuntime(), memberContext(), {
      afterSaleId: created.afterSaleId,
      expectedVersion: 1,
      idempotencyKey: cancellationKey,
      reason,
      sourceIp: '127.0.0.1',
    });
    expect(replayed).toEqual({ ...cancelled, replayed: true });
    await expectCommandFailure(
      () =>
        cancelMemberAfterSaleCommand(requiredRuntime(), memberContext(), {
          afterSaleId: created.afterSaleId,
          expectedVersion: 1,
          idempotencyKey: cancellationKey,
          reason: 'A different cancellation reason that still satisfies validation',
        }),
      'AFTER_SALE_IDEMPOTENCY_CONFLICT',
    );

    const persisted = await requiredOwner().$queryRaw<
      Array<{
        audit_after: string;
        audit_before: string;
        audit_reason: string | null;
        operation_result: string;
        transition_reason: string | null;
      }>
    >`
      SELECT audit.before_data::text AS audit_before,
        audit.after_data::text AS audit_after,
        audit.reason AS audit_reason,
        operation.result_summary::text AS operation_result,
        transition.reason AS transition_reason
      FROM after_sale_operations operation
      JOIN after_sale_transitions transition
        ON transition.store_id = operation.store_id
        AND transition.operation_id = operation.id
        AND transition.after_sale_id = operation.after_sale_id
      JOIN audit_logs audit
        ON audit.store_id = operation.store_id
        AND audit.target_id = operation.after_sale_id::text
        AND audit.after_data->>'operation_id' = operation.id::text
      WHERE operation.store_id = ${BEAUTY_STORE_ID}::uuid
        AND operation.id = ${cancelled.operationId}::uuid
    `;
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ audit_reason: null, transition_reason: null });
    expect(JSON.stringify(persisted[0])).not.toContain(reason);
  });

  it('blocks bare aggregates, direct member command writes and cross-tenant access', async () => {
    const order = await createOrder({ tag: 'guards' });
    const bareId = randomUUID();
    await expectSqlState(
      () =>
        withStoreTransaction(requiredRuntime(), memberContext(), async (transaction) => {
          await transaction.$executeRaw`
            INSERT INTO after_sales
              (id, store_id, order_id, member_id, public_case_number, type, status, source,
                reason_code, reason_detail_ciphertext, policy_snapshot, policy_hash, policy_id,
                policy_version_id, legacy_policy_review, requested_item_vnd,
                requested_shipping_vnd, requested_other_vnd, requested_total_vnd,
                idempotency_key_hash, request_hash, initiated_by, correlation_id, updated_at)
            VALUES (${bareId}::uuid, ${BEAUTY_STORE_ID}::uuid, ${order.id}::uuid,
              ${fixture.memberId}::uuid, ${`ASC-${bareId.replaceAll('-', '').toUpperCase()}`},
              'REFUND_ONLY', 'PENDING_REVIEW', 'MEMBER', 'damaged-item', 'test-ciphertext',
              ${policyContent as Prisma.InputJsonValue}, ${policyHash}, ${fixture.policyId}::uuid,
              ${fixture.policyVersionId}::uuid, false, 60000, 0, 0, 60000,
              ${digest(`bare-key-${bareId}`)}, ${digest(`bare-request-${bareId}`)},
              ${fixture.memberId}::uuid,
              pg_catalog.current_setting('app.correlation_id', true), pg_catalog.clock_timestamp())
          `;
          await transaction.$executeRawUnsafe(
            'SET CONSTRAINTS "after_sales_b3_runtime_commit_guard" IMMEDIATE',
          );
        }),
      '23514',
    );

    const created = await createMemberAfterSaleCommand(
      requiredRuntime(),
      memberContext(),
      memberCreateInput(order, 'guards-create'),
    );
    await expectSqlState(
      () =>
        withStoreTransaction(
          requiredRuntime(),
          memberContext(),
          (transaction) =>
            transaction.$executeRaw`
            INSERT INTO after_sale_operations
              (store_id, after_sale_id, operation, idempotency_key_hash, request_hash)
            VALUES (${BEAUTY_STORE_ID}::uuid, ${created.afterSaleId}::uuid,
              'MEMBER_CANCEL', ${digest('direct-operation')}, ${digest('direct-request')})
          `,
        ),
      '42501',
    );
    await expectSqlState(
      () =>
        withStoreTransaction(
          requiredRuntime(),
          memberContext(),
          (transaction) =>
            transaction.$executeRaw`
            INSERT INTO after_sale_transitions
              (store_id, after_sale_id, from_status, to_status, event,
                actor_type, actor_id, correlation_id)
            VALUES (${BEAUTY_STORE_ID}::uuid, ${created.afterSaleId}::uuid,
              'PENDING_REVIEW', 'CANCELLED', 'CANCEL', 'MEMBER',
              ${fixture.memberId}::uuid,
              pg_catalog.current_setting('app.correlation_id', true))
          `,
        ),
      '42501',
    );

    await expectCommandFailure(
      () =>
        createMemberAfterSaleCommand(
          requiredRuntime(),
          memberContext(fixture.otherMemberId),
          memberCreateInput(order, 'other-member'),
        ),
      'AFTER_SALE_NOT_FOUND',
    );
    await expectCommandFailure(
      () =>
        createMemberAfterSaleCommand(
          requiredRuntime(),
          context({
            actorId: fixture.fashionMemberId,
            actorType: 'member',
            store: 'fashion',
          }),
          memberCreateInput(order, 'foreign-store'),
        ),
      'AFTER_SALE_NOT_FOUND',
    );
  });

  it('reviews requested lines with server-calculated integer VND and immutable replay', async () => {
    const order = await createOrder({ payableVnd: 100_001, quantity: 3, tag: 'b4-partial' });
    const created = await createMemberAfterSaleCommand(
      requiredRuntime(),
      memberContext(),
      memberCreateInput(order, 'b4-partial', 3),
    );
    const idempotencyKey = `m63b4-review-partial-${suffix}`;
    const body = {
      confirmation_code: 'APPROVE_AFTER_SALE' as const,
      decision: 'APPROVE' as const,
      expected_version: 1,
      items: [{ approved_quantity: 2, order_item_id: order.itemId }],
      reason: 'Approve two verified units after reviewing the submitted request.',
    };
    const approved = await reviewAfterSaleCommand(requiredRuntime(), adminContext(), {
      afterSaleId: created.afterSaleId,
      body,
      idempotencyKey,
      sourceIp: '127.0.0.1',
    });
    expect(approved).toMatchObject({ replayed: false, status: 'APPROVED', version: 2 });

    const persisted = await requiredOwner().afterSale.findUniqueOrThrow({
      include: {
        items: true,
        operations: true,
        transitions: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      },
      where: { id: created.afterSaleId },
    });
    expect(persisted).toMatchObject({
      approvedItemVnd: 66_667n,
      approvedTotalVnd: 66_667n,
      reviewedBy: fixture.adminId,
      status: 'APPROVED',
      version: 2,
    });
    expect(persisted.items).toEqual([
      expect.objectContaining({ approvedItemVnd: 66_667n, approvedQuantity: 2 }),
    ]);
    expect(persisted.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attemptCount: 1,
          operation: 'ADMIN_REVIEW',
          status: 'COMPLETED',
        }),
      ]),
    );
    expect(persisted.transitions.map(({ event }) => event)).toEqual(['SUBMIT', 'APPROVE']);

    await expect(
      reviewAfterSaleCommand(requiredRuntime(), adminContext(), {
        afterSaleId: created.afterSaleId,
        body,
        idempotencyKey,
        sourceIp: '127.0.0.1',
      }),
    ).resolves.toEqual({ ...approved, replayed: true });
    await expectCommandFailure(
      () =>
        reviewAfterSaleCommand(requiredRuntime(), adminContext(), {
          afterSaleId: created.afterSaleId,
          body: { ...body, reason: 'A different valid reason must conflict for the same key.' },
          idempotencyKey,
        }),
      'AFTER_SALE_IDEMPOTENCY_CONFLICT',
    );
    await expectCommandFailure(
      () =>
        reviewAfterSaleCommand(requiredRuntime(), adminContext(), {
          afterSaleId: created.afterSaleId,
          body: { ...body, expected_version: 1 },
          idempotencyKey: `m63b4-review-stale-${suffix}`,
        }),
      'AFTER_SALE_VERSION_CONFLICT',
    );
  });

  it('rejects incomplete, duplicate, all-zero and excessive approval decisions atomically', async () => {
    const order = await createOrder({ quantity: 2, tag: 'b4-invalid-lines' });
    const created = await createMemberAfterSaleCommand(
      requiredRuntime(),
      memberContext(),
      memberCreateInput(order, 'b4-invalid-lines', 2),
    );
    const invalidItems = [
      [],
      [
        { approved_quantity: 1, order_item_id: order.itemId },
        { approved_quantity: 1, order_item_id: order.itemId },
      ],
      [{ approved_quantity: 0, order_item_id: order.itemId }],
      [{ approved_quantity: 3, order_item_id: order.itemId }],
    ];
    for (const [index, items] of invalidItems.entries()) {
      await expectCommandFailure(
        () =>
          reviewAfterSaleCommand(requiredRuntime(), adminContext(), {
            afterSaleId: created.afterSaleId,
            body: {
              confirmation_code: 'APPROVE_AFTER_SALE',
              decision: 'APPROVE',
              expected_version: 1,
              items,
              reason: 'This invalid line decision must leave the aggregate unchanged.',
            } as never,
            idempotencyKey: `m63b4-invalid-lines-${index}-${suffix}`,
          }),
        'AFTER_SALE_STATE_CONFLICT',
      );
    }
    expect(
      await requiredOwner().afterSale.findUniqueOrThrow({
        select: { approvedTotalVnd: true, status: true, version: true },
        where: { id: created.afterSaleId },
      }),
    ).toEqual({ approvedTotalVnd: 0n, status: 'PENDING_REVIEW', version: 1 });
  });

  it('enforces merchant-refund maker-checker and permits a separate store reviewer', async () => {
    const order = await createOrder({ tag: 'b4-maker-checker' });
    const merchant = await createMerchantRefundAfterSaleCommand(requiredRuntime(), adminContext(), {
      idempotencyKey: `m63b4-maker-create-${suffix}`,
      items: [{ orderItemId: order.itemId, quantity: 1 }],
      orderId: order.id,
      reasonCode: 'damaged-item',
      reasonDetailCiphertext: 'm63b4-maker-checker-ciphertext',
      reasonDetailHash: digest('m63b4-maker-checker'),
      type: 'MERCHANT_REFUND',
    });
    const body = {
      confirmation_code: 'APPROVE_AFTER_SALE' as const,
      decision: 'APPROVE' as const,
      expected_version: 1,
      items: [{ approved_quantity: 1, order_item_id: order.itemId }],
      reason: 'A separate reviewer approves the merchant initiated refund request.',
    };
    await expectCommandFailure(
      () =>
        reviewAfterSaleCommand(requiredRuntime(), adminContext(), {
          afterSaleId: merchant.afterSaleId,
          body,
          idempotencyKey: `m63b4-maker-self-${suffix}`,
        }),
      'AFTER_SALE_AUTHORIZATION_DENIED',
    );
    await expect(
      reviewAfterSaleCommand(requiredRuntime(), adminContext(fixture.otherAdminId), {
        afterSaleId: merchant.afterSaleId,
        body,
        idempotencyKey: `m63b4-maker-other-${suffix}`,
      }),
    ).resolves.toMatchObject({ status: 'APPROVED', version: 2 });
  });

  it('resolves legacy review once with explicit return terms and frozen amounts', async () => {
    const order = await createOrder({
      itemPayableVnd: 120_000,
      payableVnd: 130_000,
      quantity: 1,
      shippingFeeVnd: 10_000,
      tag: 'b4-legacy-return',
      withPolicy: false,
    });
    const created = await createMemberAfterSaleCommand(
      requiredRuntime(),
      memberContext(),
      memberCreateInput(order, 'b4-legacy-return', 1, { type: 'RETURN_REFUND' }),
    );
    expect(created).toMatchObject({ status: 'REVIEW_REQUIRED', version: 1 });
    const policyBasis = 'Legacy receipt and store policy evidence reviewed by an administrator.';
    const body = {
      confirmation_code: 'RESOLVE_AFTER_SALE_REVIEW' as const,
      decision: 'LEGACY_APPROVE' as const,
      expected_version: 1,
      policy_basis: policyBasis,
      reason: 'Approve the legacy return after reviewing the preserved policy evidence.',
      return_shipping_payer: 'MERCHANT' as const,
      return_window_days: 7,
    };
    const input = {
      afterSaleId: created.afterSaleId,
      body,
      idempotencyKey: `m63b4-legacy-approve-${suffix}`,
      policyBasisCiphertext: 'encrypted-legacy-policy-basis',
      policyBasisHash: digest(policyBasis),
    };
    const approved = await resolveAfterSaleReviewCommand(requiredRuntime(), adminContext(), input);
    expect(approved).toMatchObject({ replayed: false, status: 'APPROVED', version: 2 });
    await expect(
      resolveAfterSaleReviewCommand(requiredRuntime(), adminContext(), input),
    ).resolves.toEqual({ ...approved, replayed: true });

    const persisted = await requiredOwner().afterSale.findUniqueOrThrow({
      include: { legacyDecision: true, orderAllocations: true },
      where: { id: created.afterSaleId },
    });
    expect(persisted).toMatchObject({
      approvedItemVnd: 120_000n,
      approvedShippingVnd: 0n,
      approvedTotalVnd: 120_000n,
      status: 'APPROVED',
    });
    expect(persisted.orderAllocations).toEqual([]);
    expect(persisted.legacyDecision).toMatchObject({
      adminId: fixture.adminId,
      decision: 'APPROVE',
      policyBasisCiphertext: 'encrypted-legacy-policy-basis',
    });
    expect(JSON.stringify(persisted.legacyDecision)).not.toContain(policyBasis);
    await expectCommandFailure(
      () =>
        resolveAfterSaleReviewCommand(requiredRuntime(), adminContext(), {
          ...input,
          body: { ...body, expected_version: 2 },
          idempotencyKey: `m63b4-legacy-second-${suffix}`,
        }),
      'AFTER_SALE_STATE_CONFLICT',
    );
  });

  it('resumes only the frozen review status and blocks early rejection after side effects', async () => {
    const systemContext = createAfterSaleSystemContext({
      actorId: '00000000-0000-4000-8000-000000000007',
      correlationId: `m63b4-review-system-${suffix}`,
      storeId: BEAUTY_STORE_ID,
    });
    const createReviewRequired = async (tag: string) => {
      const order = await createOrder({ tag });
      const created = await createMemberAfterSaleCommand(
        requiredRuntime(),
        memberContext(),
        memberCreateInput(order, tag),
      );
      const approved = await reviewAfterSaleCommand(requiredRuntime(), adminContext(), {
        afterSaleId: created.afterSaleId,
        body: {
          confirmation_code: 'APPROVE_AFTER_SALE',
          decision: 'APPROVE',
          expected_version: 1,
          items: [{ approved_quantity: 1, order_item_id: order.itemId }],
          reason: 'Approve this request before exercising the manual review path.',
        },
        idempotencyKey: `m63b4-${tag}-approve-${suffix}`,
      });
      await withAfterSaleSystemTransaction(
        requiredRuntime(),
        systemContext,
        (transaction) => transaction.$executeRaw`
          INSERT INTO after_sale_transitions
            (store_id, after_sale_id, from_status, to_status, event,
              actor_type, actor_id, reason, correlation_id)
          VALUES (${BEAUTY_STORE_ID}::uuid, ${created.afterSaleId}::uuid,
            'APPROVED', 'REVIEW_REQUIRED', 'REQUIRE_REVIEW', 'SYSTEM',
            ${systemContext.actor.id}::uuid, NULL, ${systemContext.correlationId})
        `,
      );
      return { afterSaleId: created.afterSaleId, order, version: approved.version + 1 };
    };

    const resumable = await createReviewRequired('b4-resume');
    await expect(
      resolveAfterSaleReviewCommand(requiredRuntime(), adminContext(), {
        afterSaleId: resumable.afterSaleId,
        body: {
          confirmation_code: 'RESOLVE_AFTER_SALE_REVIEW',
          decision: 'RESUME',
          expected_version: resumable.version,
          reason: 'Resume the exact status frozen when the manual review was requested.',
        },
        idempotencyKey: `m63b4-resume-${suffix}`,
      }),
    ).resolves.toMatchObject({ status: 'APPROVED', version: resumable.version + 1 });

    const guarded = await createReviewRequired('b4-review-side-effect');
    await requiredOwner().$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.afterSaleSettlement.create({
        data: {
          afterSaleId: guarded.afterSaleId,
          amountVnd: 60_000,
          idempotencyKeyHash: digest(`m63b4-side-effect-key-${suffix}`),
          method: 'NO_PAYOUT',
          orderId: guarded.order.id,
          publicSettlementNumber: `AST-${randomUUID().replaceAll('-', '').toUpperCase()}`,
          requestHash: digest(`m63b4-side-effect-request-${suffix}`),
          requestedBy: fixture.adminId,
          storeId: BEAUTY_STORE_ID,
        },
      });
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });
    await expectCommandFailure(
      () =>
        resolveAfterSaleReviewCommand(requiredRuntime(), adminContext(), {
          afterSaleId: guarded.afterSaleId,
          body: {
            confirmation_code: 'RESOLVE_AFTER_SALE_REVIEW',
            decision: 'REJECT',
            expected_version: guarded.version,
            reason: 'Rejecting after a settlement fact exists must fail closed.',
          },
          idempotencyKey: `m63b4-guarded-reject-${suffix}`,
        }),
      'AFTER_SALE_STATE_CONFLICT',
    );
  });

  it('expires due returns once per store and skips locked or future cases', async () => {
    const createApprovedReturn = async (tag: string) => {
      const order = await createOrder({ quantity: 1, tag });
      const created = await createMemberAfterSaleCommand(
        requiredRuntime(),
        memberContext(),
        memberCreateInput(order, tag, 1, { type: 'RETURN_REFUND' }),
      );
      await reviewAfterSaleCommand(requiredRuntime(), adminContext(), {
        afterSaleId: created.afterSaleId,
        body: {
          confirmation_code: 'APPROVE_AFTER_SALE',
          decision: 'APPROVE',
          expected_version: 1,
          items: [{ approved_quantity: 1, order_item_id: order.itemId }],
          reason: 'Approve the return request before testing its frozen deadline.',
        },
        idempotencyKey: `m63b4-${tag}-approve-${suffix}`,
      });
      return created.afterSaleId;
    };
    const dueId = await createApprovedReturn('b4-expire-due');
    const futureId = await createApprovedReturn('b4-expire-future');
    await requiredOwner().$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.afterSale.update({
        data: { returnDeadlineAt: new Date(Date.now() - 60_000) },
        where: { id: dueId },
      });
      await transaction.afterSale.update({
        data: { returnDeadlineAt: new Date(Date.now() + 60_000) },
        where: { id: futureId },
      });
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });
    const systemContext = createAfterSaleSystemContext({
      actorId: '00000000-0000-4000-8000-000000000007',
      correlationId: `m63b4-expiration-${suffix}`,
      storeId: BEAUTY_STORE_ID,
    });
    await expect(expireDueAfterSales(requiredRuntime(), systemContext, 100)).resolves.toEqual({
      expired: 1,
      scanned: 1,
      skipped: 0,
    });
    await expect(expireDueAfterSales(requiredRuntime(), systemContext, 100)).resolves.toEqual({
      expired: 0,
      scanned: 0,
      skipped: 0,
    });
    expect(
      await requiredOwner().afterSale.findMany({
        orderBy: { id: 'asc' },
        select: { id: true, status: true },
        where: { id: { in: [dueId, futureId] } },
      }),
    ).toEqual(
      [
        { id: dueId, status: 'REJECTED' },
        { id: futureId, status: 'APPROVED' },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    );
    await expect(
      expireDueAfterSales(
        requiredRuntime(),
        createAfterSaleSystemContext({
          actorId: systemContext.actor.id,
          correlationId: `m63b4-expiration-fashion-${suffix}`,
          storeId: FASHION_STORE_ID,
        }),
        100,
      ),
    ).resolves.toEqual({ expired: 0, scanned: 0, skipped: 0 });
  });

  it('submits one masked member return with immutable replay and strict owner/store scope', async () => {
    const approved = await createApprovedReturnCase('b5-member-submit');
    const trackingNumber = `GHN-RETURN-${suffix}-123456`;
    const idempotencyKey = `m63b5-member-submit-${suffix}`;
    const body = {
      carrier_name: 'GHN',
      expected_version: approved.version,
      tracking_number: trackingNumber,
    };
    const input = {
      afterSaleId: approved.afterSaleId,
      body,
      idempotencyKey,
      sourceIp: '127.0.0.1',
      trackingHashKey: process.env.PII_HASH_KEY!,
    };
    const submitted = await submitMemberAfterSaleReturn(requiredRuntime(), memberContext(), input);
    expect(submitted).toMatchObject({
      replayed: false,
      returnShipmentStatus: 'SUBMITTED',
      returnShipmentVersion: 1,
      status: 'RETURN_PENDING',
      version: approved.version + 1,
    });
    await expect(
      submitMemberAfterSaleReturn(requiredRuntime(), memberContext(), input),
    ).resolves.toEqual({ ...submitted, replayed: true });
    await expectCommandFailure(
      () =>
        submitMemberAfterSaleReturn(requiredRuntime(), memberContext(), {
          ...input,
          body: { ...body, tracking_number: `${trackingNumber}-DIFFERENT` },
        }),
      'AFTER_SALE_IDEMPOTENCY_CONFLICT',
    );
    await expectCommandFailure(
      () =>
        submitMemberAfterSaleReturn(requiredRuntime(), memberContext(fixture.otherMemberId), {
          ...input,
          idempotencyKey: `m63b5-other-member-${suffix}`,
        }),
      'AFTER_SALE_NOT_FOUND',
    );
    await expectCommandFailure(
      () =>
        submitMemberAfterSaleReturn(
          requiredRuntime(),
          context({
            actorId: fixture.fashionMemberId,
            actorType: 'member',
            store: 'fashion',
          }),
          { ...input, idempotencyKey: `m63b5-other-store-${suffix}` },
        ),
      'AFTER_SALE_NOT_FOUND',
    );

    const shipment = await requiredOwner().afterSaleReturnShipment.findUniqueOrThrow({
      where: {
        storeId_afterSaleId: { afterSaleId: approved.afterSaleId, storeId: BEAUTY_STORE_ID },
      },
    });
    expect(shipment).toMatchObject({
      carrierName: 'GHN',
      memberId: fixture.memberId,
      status: 'SUBMITTED',
      submittedBy: fixture.memberId,
      trackingNumberDigest: createHmac('sha256', process.env.PII_HASH_KEY!)
        .update(trackingNumber)
        .digest('hex'),
    });
    expect(shipment.trackingNumberMasked).not.toBe(trackingNumber);
    expect(JSON.stringify(shipment)).not.toContain(trackingNumber);

    const [operations, transitions, audits] = await Promise.all([
      requiredOwner().afterSaleOperation.findMany({
        where: { afterSaleId: approved.afterSaleId, operation: 'MEMBER_SUBMIT_RETURN' },
      }),
      requiredOwner().afterSaleTransition.findMany({
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        where: { afterSaleId: approved.afterSaleId },
      }),
      requiredOwner().auditLog.findMany({
        where: { action: 'after-sale.return.submitted', targetId: approved.afterSaleId },
      }),
    ]);
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ attemptCount: 1, status: 'COMPLETED', version: 2 });
    expect(transitions.map(({ event }) => event)).toEqual(['SUBMIT', 'APPROVE', 'START_RETURN']);
    expect(audits).toHaveLength(1);
    expect(JSON.stringify({ audits, operations, transitions })).not.toContain(trackingNumber);
  });

  it('enforces the exclusive return deadline and serializes expiration with submission', async () => {
    const approved = await createApprovedReturnCase('b5-deadline-race');
    await requiredOwner().$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.afterSale.update({
        data: { returnDeadlineAt: new Date(Date.now() - 1) },
        where: { id: approved.afterSaleId },
      });
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });
    const systemContext = createAfterSaleSystemContext({
      actorId: '00000000-0000-4000-8000-000000000007',
      correlationId: `m63b5-deadline-race-${suffix}`,
      storeId: BEAUTY_STORE_ID,
    });
    const [submission, expiration] = await Promise.allSettled([
      submitMemberAfterSaleReturn(requiredRuntime(), memberContext(), {
        afterSaleId: approved.afterSaleId,
        body: {
          carrier_name: 'GHN',
          expected_version: approved.version,
          tracking_number: `GHN-DEADLINE-${suffix}`,
        },
        idempotencyKey: `m63b5-deadline-submit-${suffix}`,
        trackingHashKey: process.env.PII_HASH_KEY!,
      }),
      expireDueAfterSales(requiredRuntime(), systemContext, 100),
    ]);
    expect(submission.status).toBe('rejected');
    expect((submission as PromiseRejectedResult).reason).toMatchObject({
      code: 'AFTER_SALE_RETURN_WINDOW_CLOSED',
    });
    expect(expiration).toMatchObject({ status: 'fulfilled', value: { expired: 1 } });
    expect(
      await requiredOwner().afterSale.findUniqueOrThrow({
        select: { status: true },
        where: { id: approved.afterSaleId },
      }),
    ).toEqual({ status: 'REJECTED' });
    expect(
      await requiredOwner().afterSaleReturnShipment.count({
        where: { afterSaleId: approved.afterSaleId },
      }),
    ).toBe(0);
  });

  it('records trusted in-transit and delivered facts after submission with dual versions', async () => {
    const approved = await createApprovedReturnCase('b5-trusted-facts');
    const submitted = await submitMemberAfterSaleReturn(requiredRuntime(), memberContext(), {
      afterSaleId: approved.afterSaleId,
      body: {
        carrier_name: 'GHTK',
        expected_version: approved.version,
        tracking_number: `GHTK-RETURN-${suffix}-987654`,
      },
      idempotencyKey: `m63b5-facts-submit-${suffix}`,
      trackingHashKey: process.env.PII_HASH_KEY!,
    });
    await requiredOwner().$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.afterSale.update({
        data: { returnDeadlineAt: new Date(Date.now() - 60_000) },
        where: { id: approved.afterSaleId },
      });
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });
    const inTransitBody = {
      confirmation_code: 'RECORD_RETURN_LOGISTICS_FACT' as const,
      expected_return_shipment_version: submitted.returnShipmentVersion,
      expected_version: submitted.version,
      reason: 'Carrier portal confirms the returned parcel is in transit.',
      status: 'IN_TRANSIT' as const,
    };
    const inTransitInput = {
      afterSaleId: approved.afterSaleId,
      body: inTransitBody,
      idempotencyKey: `m63b5-facts-transit-${suffix}`,
      sourceIp: '127.0.0.1',
    };
    const inTransit = await recordAfterSaleReturnFact(
      requiredRuntime(),
      adminContext(),
      inTransitInput,
    );
    expect(inTransit).toMatchObject({
      replayed: false,
      returnShipmentStatus: 'IN_TRANSIT',
      returnShipmentVersion: submitted.returnShipmentVersion + 1,
      status: 'RETURN_IN_TRANSIT',
      version: submitted.version + 1,
    });
    await expect(
      recordAfterSaleReturnFact(requiredRuntime(), adminContext(), inTransitInput),
    ).resolves.toEqual({ ...inTransit, replayed: true });
    await expectCommandFailure(
      () =>
        recordAfterSaleReturnFact(requiredRuntime(), adminContext(), {
          ...inTransitInput,
          body: {
            ...inTransitBody,
            reason: 'A changed reason cannot replay the trusted fact key.',
          },
        }),
      'AFTER_SALE_IDEMPOTENCY_CONFLICT',
    );
    await expectCommandFailure(
      () =>
        recordAfterSaleReturnFact(requiredRuntime(), adminContext(), {
          afterSaleId: approved.afterSaleId,
          body: {
            ...inTransitBody,
            expected_return_shipment_version: inTransit.returnShipmentVersion,
            expected_version: inTransit.version - 1,
            status: 'DELIVERED',
          },
          idempotencyKey: `m63b5-stale-aggregate-${suffix}`,
        }),
      'AFTER_SALE_VERSION_CONFLICT',
    );
    await expectCommandFailure(
      () =>
        recordAfterSaleReturnFact(requiredRuntime(), adminContext(), {
          afterSaleId: approved.afterSaleId,
          body: {
            ...inTransitBody,
            expected_return_shipment_version: inTransit.returnShipmentVersion - 1,
            expected_version: inTransit.version,
            status: 'DELIVERED',
          },
          idempotencyKey: `m63b5-stale-shipment-${suffix}`,
        }),
      'AFTER_SALE_VERSION_CONFLICT',
    );
    const delivered = await recordAfterSaleReturnFact(requiredRuntime(), adminContext(), {
      afterSaleId: approved.afterSaleId,
      body: {
        confirmation_code: 'RECORD_RETURN_LOGISTICS_FACT',
        expected_return_shipment_version: inTransit.returnShipmentVersion,
        expected_version: inTransit.version,
        reason: 'Carrier portal confirms delivery to the return warehouse.',
        status: 'DELIVERED',
      },
      idempotencyKey: `m63b5-facts-delivered-${suffix}`,
    });
    expect(delivered).toMatchObject({
      returnShipmentStatus: 'DELIVERED',
      returnShipmentVersion: inTransit.returnShipmentVersion + 1,
      status: 'INSPECTION_PENDING',
      version: inTransit.version + 1,
    });
    const persisted = await requiredOwner().afterSale.findUniqueOrThrow({
      include: {
        returnShipments: true,
        transitions: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      },
      where: { id: approved.afterSaleId },
    });
    expect(persisted.returnShipments[0]).toMatchObject({
      receivedAt: expect.any(Date),
      status: 'DELIVERED',
      version: delivered.returnShipmentVersion,
    });
    expect(persisted.transitions.map(({ event }) => event)).toEqual([
      'SUBMIT',
      'APPROVE',
      'START_RETURN',
      'RETURN_SHIPPED',
      'RETURN_RECEIVED',
    ]);
  });

  it('supports direct trusted delivery but rejects stale MFA, cross-access and direct writes', async () => {
    const stale = await createApprovedReturnCase('b5-stale-mfa');
    const staleSubmitted = await submitMemberAfterSaleReturn(requiredRuntime(), memberContext(), {
      afterSaleId: stale.afterSaleId,
      body: {
        carrier_name: 'GHN',
        expected_version: stale.version,
        tracking_number: `GHN-STALE-MFA-${suffix}`,
      },
      idempotencyKey: `m63b5-stale-mfa-submit-${suffix}`,
      trackingHashKey: process.env.PII_HASH_KEY!,
    });
    await requiredOwner().adminSession.update({
      data: { mfaVerifiedAt: new Date(Date.now() - 11 * 60 * 1_000) },
      where: { id: fixture.adminSessionId },
    });
    try {
      await expectCommandFailure(
        () =>
          recordAfterSaleReturnFact(requiredRuntime(), adminContext(), {
            afterSaleId: stale.afterSaleId,
            body: {
              confirmation_code: 'RECORD_RETURN_LOGISTICS_FACT',
              expected_return_shipment_version: staleSubmitted.returnShipmentVersion,
              expected_version: staleSubmitted.version,
              reason: 'Stale MFA cannot record a trusted return delivery fact.',
              status: 'DELIVERED',
            },
            idempotencyKey: `m63b5-stale-mfa-fact-${suffix}`,
          }),
        'AFTER_SALE_AUTHORIZATION_DENIED',
      );
    } finally {
      await requiredOwner().adminSession.update({
        data: { mfaVerifiedAt: new Date() },
        where: { id: fixture.adminSessionId },
      });
    }
    await expectCommandFailure(
      () =>
        recordAfterSaleReturnFact(
          requiredRuntime(),
          crossStoreAdminContext(`m63b5-cross-access-${suffix}`),
          {
            afterSaleId: stale.afterSaleId,
            body: {
              confirmation_code: 'RECORD_RETURN_LOGISTICS_FACT',
              expected_return_shipment_version: staleSubmitted.returnShipmentVersion,
              expected_version: staleSubmitted.version,
              reason: 'Cross access alone cannot record a trusted delivery fact.',
              status: 'DELIVERED',
            },
            idempotencyKey: `m63b5-cross-access-fact-${suffix}`,
          },
        ),
      'AFTER_SALE_AUTHORIZATION_DENIED',
    );

    const direct = await createApprovedReturnCase('b5-direct-delivery');
    const directSubmitted = await submitMemberAfterSaleReturn(requiredRuntime(), memberContext(), {
      afterSaleId: direct.afterSaleId,
      body: {
        carrier_name: 'VNPost',
        expected_version: direct.version,
        tracking_number: `VNPOST-DIRECT-${suffix}`,
      },
      idempotencyKey: `m63b5-direct-submit-${suffix}`,
      trackingHashKey: process.env.PII_HASH_KEY!,
    });
    const delivered = await recordAfterSaleReturnFact(requiredRuntime(), adminContext(), {
      afterSaleId: direct.afterSaleId,
      body: {
        confirmation_code: 'RECORD_RETURN_LOGISTICS_FACT',
        expected_return_shipment_version: directSubmitted.returnShipmentVersion,
        expected_version: directSubmitted.version,
        reason: 'Carrier portal directly confirms delivery to the return warehouse.',
        status: 'DELIVERED',
      },
      idempotencyKey: `m63b5-direct-delivered-${suffix}`,
    });
    expect(delivered).toMatchObject({
      returnShipmentStatus: 'DELIVERED',
      returnShipmentVersion: directSubmitted.returnShipmentVersion + 1,
      status: 'INSPECTION_PENDING',
      version: directSubmitted.version + 2,
    });
    const events = await requiredOwner().afterSaleTransition.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { event: true },
      where: { operationId: delivered.operationId },
    });
    expect(events).toEqual([{ event: 'RETURN_SHIPPED' }, { event: 'RETURN_RECEIVED' }]);

    await expectSqlState(
      () =>
        withStoreTransaction(
          requiredRuntime(),
          memberContext(),
          (transaction) =>
            transaction.$executeRaw`
            INSERT INTO after_sale_return_shipments
              (store_id, after_sale_id, order_id, member_id, carrier_name,
                tracking_number_digest, tracking_number_masked, submitted_by)
            VALUES (${BEAUTY_STORE_ID}::uuid, ${direct.afterSaleId}::uuid,
              ${direct.order.id}::uuid, ${fixture.memberId}::uuid, 'GHN', ${'a'.repeat(64)},
              'GH******01', ${fixture.memberId}::uuid)
          `,
        ),
      '42501',
    );
    await expectSqlState(
      () =>
        withStoreTransaction(
          requiredRuntime(),
          memberContext(),
          (transaction) =>
            transaction.$executeRaw`
            INSERT INTO after_sale_operations
              (store_id, after_sale_id, operation, idempotency_key_hash, request_hash)
            VALUES (${BEAUTY_STORE_ID}::uuid, ${stale.afterSaleId}::uuid,
              'MEMBER_SUBMIT_RETURN', ${digest(`m63b5-partial-op-${suffix}`)},
              ${digest(`m63b5-partial-request-${suffix}`)})
          `,
        ),
      '42501',
    );
  });
});
