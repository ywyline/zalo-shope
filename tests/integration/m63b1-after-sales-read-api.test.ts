import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { config as loadEnvironment } from 'dotenv';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { parseRuntimeConfig } from '@zalo-shop/config';
import {
  createRuntimePrismaClient,
  PrismaClient,
  type StoreTransaction,
  withStoreTransaction,
} from '@zalo-shop/database';
import { createStoreContext } from '@zalo-shop/domain';
import { encryptSensitive, signJwt } from '@zalo-shop/security';

const BEAUTY_STORE_ID = '10000000-0000-4000-8000-000000000001';
const FASHION_STORE_ID = '10000000-0000-4000-8000-000000000002';

describe.sequential('M6.3-B1 after-sale read API', () => {
  loadEnvironment({ path: '.env.test.example', quiet: true, override: true });
  const config = parseRuntimeConfig();
  const owner = new PrismaClient({ datasourceUrl: config.DATABASE_URL });
  const runtime = createRuntimePrismaClient(config.DATABASE_RUNTIME_URL);
  const suffix = randomUUID().slice(0, 8);
  const evidenceRetentionDeadline = new Date(Date.now() + 24 * 60 * 60 * 1_000);
  const fixture = {
    adminDeniedId: randomUUID(),
    adminDeniedRoleId: randomUUID(),
    adminDeniedSessionId: randomUUID(),
    adminReaderId: randomUUID(),
    adminReaderRoleId: randomUUID(),
    adminReaderSessionId: randomUUID(),
    beautyCaseIds: [randomUUID(), randomUUID(), randomUUID(), randomUUID()] as const,
    beautyMemberId: randomUUID(),
    beautyMemberSessionId: randomUUID(),
    beautyOtherCaseId: randomUUID(),
    beautyOtherMemberId: randomUUID(),
    beautyOtherMemberSessionId: randomUUID(),
    evidenceId: randomUUID(),
    fashionCaseId: randomUUID(),
    fashionMemberId: randomUUID(),
    fashionOrderId: randomUUID(),
    fashionMemberSessionId: randomUUID(),
    paymentAttemptId: randomUUID(),
    policyId: randomUUID(),
    policyVersionId: randomUUID(),
    refundId: randomUUID(),
    returnShipmentId: randomUUID(),
    settlementId: randomUUID(),
  };
  const allCaseIds = [...fixture.beautyCaseIds, fixture.beautyOtherCaseId, fixture.fashionCaseId];
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  let app: INestApplication;
  let adminDeniedToken: string;
  let adminReaderToken: string;
  let beautyMemberToken: string;
  let beautyOtherMemberToken: string;
  let fashionMemberToken: string;
  let limiterRedis: {
    del(...keys: string[]): Promise<number>;
    eval(...args: unknown[]): Promise<unknown>;
    set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  };
  const api = () => request(app.getHttpServer() as Server);
  const memberHeaders = (token = beautyMemberToken, storeCode = 'beauty-local') => ({
    Authorization: `Bearer ${token}`,
    'X-Store-Code': storeCode,
  });
  const adminHeaders = (token = adminReaderToken, storeCode = 'beauty-local') => ({
    Authorization: `Bearer ${token}`,
    'X-Store-Code': storeCode,
  });

  function publicNumber(prefix: 'ASC' | 'AST' | 'RFD', id: string): string {
    return `${prefix}-${id.replaceAll('-', '').slice(0, 16).toUpperCase()}`;
  }

  function accessToken(input: {
    actorType: 'admin' | 'member';
    sessionId: string;
    storeId?: string;
    subjectId: string;
  }): string {
    const now = Math.floor(Date.now() / 1_000);
    return signJwt(
      {
        actor_type: input.actorType,
        aud: config.AUTH_JWT_AUDIENCE,
        exp: now + 900,
        iat: now,
        iss: config.AUTH_JWT_ISSUER,
        jti: randomUUID(),
        session_id: input.sessionId,
        ...(input.storeId === undefined ? {} : { store_id: input.storeId }),
        sub: input.subjectId,
      },
      config.AUTH_JWT_SECRET,
    );
  }

  function rateLimitKey(
    actorType: 'ADMIN' | 'MEMBER',
    actorId: string,
    storeId: string,
    windowOffset = 0,
  ): string {
    const window = Math.floor(Date.now() / 60_000) + windowOffset;
    const identity = createHmac('sha256', config.PII_HASH_KEY)
      .update(`${actorType}:${actorId}`)
      .digest('hex');
    return `${config.NODE_ENV}:${storeId}:after-sale-read:${actorType.toLowerCase()}:${identity}:${window}`;
  }

  async function insertCase(
    transaction: StoreTransaction,
    input: {
      createdAt: string;
      id: string;
      legacy?: boolean;
      memberId: string;
      orderId?: string;
      storeId: string;
    },
  ): Promise<void> {
    const orderId = input.orderId ?? randomUUID();
    const orderItemId = randomUUID();
    const itemId = randomUUID();
    const transitionId = randomUUID();
    const reasonCiphertext = input.legacy
      ? null
      : encryptSensitive(
          'The delivered item has a verified damaged package.',
          config.PII_ENCRYPTION_KEY,
        );
    await transaction.$executeRaw`INSERT INTO after_sales
      (id, store_id, order_id, member_id, public_case_number, type, status, source,
        reason_code, reason_detail_ciphertext, review_reason, policy_snapshot, policy_hash,
        policy_id, policy_version_id, legacy_policy_review, return_deadline_at,
        requested_item_vnd, requested_total_vnd, approved_item_vnd, approved_total_vnd,
        idempotency_key_hash, request_hash, initiated_by, reviewed_by, reviewed_at,
        correlation_id, created_at, updated_at)
      VALUES (${input.id}::uuid, ${input.storeId}::uuid, ${orderId}::uuid,
        ${input.memberId}::uuid, ${publicNumber('ASC', input.id)}, 'RETURN_REFUND',
        ${input.legacy ? 'REVIEW_REQUIRED' : 'APPROVED'}::after_sale_status,
        'MEMBER', 'damaged-item', ${reasonCiphertext}, 'PRIVATE_REVIEW_REASON_MARKER',
        ${input.legacy ? null : '{"private":"PRIVATE_POLICY_SNAPSHOT_MARKER"}'}::jsonb,
        ${input.legacy ? null : digest(`policy-${input.id}`)},
        ${input.legacy ? null : fixture.policyId}::uuid,
        ${input.legacy ? null : fixture.policyVersionId}::uuid,
        ${input.legacy ?? false},
        ${input.legacy ? null : '2026-08-04T08:00:00.000000Z'}::timestamptz,
        100000, 100000, 100000, 100000,
        ${digest(`idempotency-${input.id}`)}, ${digest(`request-${input.id}`)},
        ${input.memberId}::uuid, ${input.legacy ? null : fixture.adminReaderId}::uuid,
        ${input.legacy ? null : input.createdAt}::timestamptz,
        'PRIVATE_HEADER_CORRELATION_MARKER', ${input.createdAt}::timestamptz,
        ${input.createdAt}::timestamptz)`;
    await transaction.$executeRaw`INSERT INTO after_sale_items
      (id, store_id, after_sale_id, order_id, order_item_id, requested_quantity,
        approved_quantity, requested_item_vnd, approved_item_vnd, sku_id, product_id,
        brand_id, category_id, sku_code, product_name, option_snapshot, unit_price_vnd,
        created_at, updated_at)
      VALUES (${itemId}::uuid, ${input.storeId}::uuid, ${input.id}::uuid,
        ${orderId}::uuid, ${orderItemId}::uuid, 1, 1, 100000, 100000,
        ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid,
        ${randomUUID()}::uuid, 'private-sku-marker', 'PRIVATE_PRODUCT_NAME_MARKER',
        '{"private":"PRIVATE_OPTION_MARKER"}'::jsonb, 100000,
        ${input.createdAt}::timestamptz, ${input.createdAt}::timestamptz)`;
    await transaction.$executeRaw`INSERT INTO after_sale_transitions
      (id, store_id, after_sale_id, from_status, to_status, event, actor_type,
        actor_id, reason, correlation_id, created_at)
      VALUES (${transitionId}::uuid, ${input.storeId}::uuid, ${input.id}::uuid,
        'PENDING_REVIEW', ${input.legacy ? 'REVIEW_REQUIRED' : 'APPROVED'}::after_sale_status,
        ${input.legacy ? 'REQUIRE_REVIEW' : 'APPROVE'}, 'ADMIN',
        ${fixture.adminReaderId}::uuid, 'PRIVATE_TRANSITION_REASON_MARKER',
        'PRIVATE_TRANSITION_CORRELATION_MARKER', ${input.createdAt}::timestamptz)`;
  }

  beforeAll(async () => {
    await Promise.all([owner.$connect(), runtime.$connect()]);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1_000);
    await owner.$transaction(async (transaction) => {
      await transaction.adminUser.createMany({
        data: [
          {
            displayName: 'M6.3 B1 reader',
            email: `m63b1-reader-${suffix}@example.invalid`,
            emailNormalized: `m63b1-reader-${suffix}@example.invalid`,
            id: fixture.adminReaderId,
            passwordHash: 'test-fixture-not-a-login-hash',
          },
          {
            displayName: 'M6.3 B1 denied',
            email: `m63b1-denied-${suffix}@example.invalid`,
            emailNormalized: `m63b1-denied-${suffix}@example.invalid`,
            id: fixture.adminDeniedId,
            passwordHash: 'test-fixture-not-a-login-hash',
          },
        ],
      });
      await transaction.member.createMany({
        data: [
          {
            id: fixture.beautyMemberId,
            preferredLocale: 'en',
            storeId: BEAUTY_STORE_ID,
          },
          {
            id: fixture.beautyOtherMemberId,
            preferredLocale: 'zh',
            storeId: BEAUTY_STORE_ID,
          },
          {
            id: fixture.fashionMemberId,
            preferredLocale: 'vi',
            storeId: FASHION_STORE_ID,
          },
        ],
      });
      await transaction.memberSession.createMany({
        data: [
          {
            expiresAt,
            id: fixture.beautyMemberSessionId,
            memberId: fixture.beautyMemberId,
            refreshTokenHash: digest(`member-session-${fixture.beautyMemberId}`),
            storeId: BEAUTY_STORE_ID,
            tokenFamilyId: randomUUID(),
          },
          {
            expiresAt,
            id: fixture.beautyOtherMemberSessionId,
            memberId: fixture.beautyOtherMemberId,
            refreshTokenHash: digest(`member-session-${fixture.beautyOtherMemberId}`),
            storeId: BEAUTY_STORE_ID,
            tokenFamilyId: randomUUID(),
          },
          {
            expiresAt,
            id: fixture.fashionMemberSessionId,
            memberId: fixture.fashionMemberId,
            refreshTokenHash: digest(`member-session-${fixture.fashionMemberId}`),
            storeId: FASHION_STORE_ID,
            tokenFamilyId: randomUUID(),
          },
        ],
      });
      await transaction.adminSession.createMany({
        data: [
          {
            adminUserId: fixture.adminReaderId,
            expiresAt,
            id: fixture.adminReaderSessionId,
            mfaVerifiedAt: new Date(),
            refreshTokenHash: digest(`admin-session-${fixture.adminReaderId}`),
            tokenFamilyId: randomUUID(),
          },
          {
            adminUserId: fixture.adminDeniedId,
            expiresAt,
            id: fixture.adminDeniedSessionId,
            mfaVerifiedAt: new Date(),
            refreshTokenHash: digest(`admin-session-${fixture.adminDeniedId}`),
            tokenFamilyId: randomUUID(),
          },
        ],
      });
      await transaction.storeRole.createMany({
        data: [
          {
            code: `m63b1-reader-${suffix}`,
            id: fixture.adminReaderRoleId,
            name: 'M6.3 B1 reader',
            storeId: BEAUTY_STORE_ID,
          },
          {
            code: `m63b1-denied-${suffix}`,
            id: fixture.adminDeniedRoleId,
            name: 'M6.3 B1 denied',
            storeId: BEAUTY_STORE_ID,
          },
        ],
      });
      await transaction.storeRolePermission.create({
        data: {
          permissionCode: 'store.after-sales.read',
          roleId: fixture.adminReaderRoleId,
          storeId: BEAUTY_STORE_ID,
        },
      });
      await transaction.adminStoreRole.createMany({
        data: [
          {
            adminUserId: fixture.adminReaderId,
            grantedBy: fixture.adminReaderId,
            roleId: fixture.adminReaderRoleId,
            storeId: BEAUTY_STORE_ID,
          },
          {
            adminUserId: fixture.adminDeniedId,
            grantedBy: fixture.adminDeniedId,
            roleId: fixture.adminDeniedRoleId,
            storeId: BEAUTY_STORE_ID,
          },
        ],
      });

      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.$executeRaw`INSERT INTO after_sale_policies
        (id, store_id, code, status, current_version_id, draft_payload, draft_hash,
          created_by, updated_by, updated_at)
        VALUES (${fixture.policyId}::uuid, ${BEAUTY_STORE_ID}::uuid,
          ${`m63b1-policy-${suffix}`}, 'ACTIVE', ${fixture.policyVersionId}::uuid,
          '{"private":"PRIVATE_POLICY_DRAFT_MARKER"}'::jsonb,
          ${digest(`draft-${fixture.policyId}`)}, ${fixture.adminReaderId}::uuid,
          ${fixture.adminReaderId}::uuid, now())`;
      await transaction.$executeRaw`INSERT INTO after_sale_policy_versions
        (id, store_id, policy_id, version_number, effective_at, request_window_days,
          return_window_days, allowed_types, return_shipping_payer, unopened_required,
          hygiene_restricted, damaged_exception, wrong_item_exception, defect_exception,
          condition_rules, payload, payload_hash, published_by, published_at)
        VALUES (${fixture.policyVersionId}::uuid, ${BEAUTY_STORE_ID}::uuid,
          ${fixture.policyId}::uuid, 3, now(), 30, 7,
          ARRAY['REFUND_ONLY','RETURN_REFUND','EXCHANGE']::after_sale_type[],
          'MERCHANT', false, false, true, true, true,
          '{"private":"PRIVATE_POLICY_CONDITION_MARKER"}'::jsonb,
          '{"private":"PRIVATE_POLICY_PAYLOAD_MARKER"}'::jsonb,
          ${digest(`payload-${fixture.policyVersionId}`)}, ${fixture.adminReaderId}::uuid,
          now())`;
      await transaction.$executeRaw`INSERT INTO after_sale_policy_localizations
        (store_id, policy_version_id, locale, name, summary, buyer_instructions)
        VALUES
          (${BEAUTY_STORE_ID}::uuid, ${fixture.policyVersionId}::uuid, 'vi',
            'Chính sách B1', 'Tóm tắt B1', 'Gửi hàng theo hướng dẫn B1.'),
          (${BEAUTY_STORE_ID}::uuid, ${fixture.policyVersionId}::uuid, 'zh',
            'B1 售后政策', 'B1 政策摘要', '请按照 B1 指引寄回商品。'),
          (${BEAUTY_STORE_ID}::uuid, ${fixture.policyVersionId}::uuid, 'en',
            'B1 after-sale policy', 'B1 policy summary',
            'Return the item using the B1 instructions.')`;

      const timestamps = [
        '2026-07-28T08:00:00.000300Z',
        '2026-07-28T08:00:00.000200Z',
        '2026-07-28T08:00:00.000100Z',
        '2026-07-28T08:00:00.000050Z',
      ];
      for (const [index, id] of fixture.beautyCaseIds.entries()) {
        await insertCase(transaction, {
          createdAt: timestamps[index]!,
          id,
          legacy: index === 3,
          memberId: fixture.beautyMemberId,
          storeId: BEAUTY_STORE_ID,
        });
      }
      await insertCase(transaction, {
        createdAt: '2026-07-28T08:00:00.000400Z',
        id: fixture.beautyOtherCaseId,
        memberId: fixture.beautyOtherMemberId,
        storeId: BEAUTY_STORE_ID,
      });
      await insertCase(transaction, {
        createdAt: '2026-07-28T08:00:00.000500Z',
        id: fixture.fashionCaseId,
        legacy: true,
        memberId: fixture.fashionMemberId,
        orderId: fixture.fashionOrderId,
        storeId: FASHION_STORE_ID,
      });

      const primaryCaseId = fixture.beautyCaseIds[0];
      await transaction.$executeRaw`INSERT INTO after_sale_evidence_files
        (id, store_id, member_id, upload_session_id, after_sale_id, object_key,
          derivative_object_keys, scan_temporary_object_key, mime_type, byte_size,
          checksum_sha256, original_filename, status, scan_result_code, claimed_at,
          retention_deadline_at, delete_error_code, version, created_at, updated_at)
        VALUES (${fixture.evidenceId}::uuid, ${BEAUTY_STORE_ID}::uuid,
          ${fixture.beautyMemberId}::uuid, ${randomUUID()}::uuid,
          ${primaryCaseId}::uuid, 'PRIVATE_OBJECT_KEY_MARKER',
          '["PRIVATE_DERIVATIVE_KEY_MARKER"]'::jsonb, 'PRIVATE_SCAN_KEY_MARKER',
          'image/jpeg', 128, ${digest('evidence')}, 'PRIVATE_FILENAME_MARKER.jpg',
          'READY', 'CLEAN', now(), ${evidenceRetentionDeadline}::timestamptz,
          'PRIVATE_DELETE_ERROR_MARKER', 2, now(), now())`;
      await transaction.$executeRaw`INSERT INTO after_sale_return_shipments
        (id, store_id, after_sale_id, order_id, member_id, carrier_name,
          tracking_number_digest, tracking_number_masked, status, submitted_by,
          submitted_at, updated_at)
        SELECT ${fixture.returnShipmentId}::uuid, store_id, id, order_id, member_id,
          'GHN', ${digest('PRIVATE_TRACKING_NUMBER_MARKER')}, 'GH********89',
          'IN_TRANSIT', member_id, now(), now()
        FROM after_sales WHERE id = ${primaryCaseId}::uuid`;
      await transaction.$executeRaw`INSERT INTO after_sale_settlements
        (id, store_id, after_sale_id, order_id, payment_attempt_id,
          public_settlement_number, method, status, amount_vnd, idempotency_key_hash,
          request_hash, requested_by, requested_at, updated_at)
        SELECT ${fixture.settlementId}::uuid, store_id, id, order_id,
          ${fixture.paymentAttemptId}::uuid,
          ${publicNumber('AST', fixture.settlementId)}, 'ONLINE_ORIGINAL', 'PROCESSING',
          100000, ${digest('settlement-key')}, ${digest('settlement-request')},
          ${fixture.adminReaderId}::uuid, now(), now()
        FROM after_sales WHERE id = ${primaryCaseId}::uuid`;
      await transaction.$executeRaw`INSERT INTO refunds
        (id, store_id, order_id, payment_attempt_id, public_refund_number, amount_vnd,
          status, reason, requested_by, idempotency_key_hash, updated_at)
        SELECT ${fixture.refundId}::uuid, store_id, order_id,
          ${fixture.paymentAttemptId}::uuid, ${publicNumber('RFD', fixture.refundId)},
          100000, 'REQUESTED', 'M6.3-B1 public refund projection fixture',
          ${fixture.adminReaderId}::uuid, ${digest('refund-key')}, now()
        FROM after_sales WHERE id = ${primaryCaseId}::uuid`;
      await transaction.$executeRaw`INSERT INTO after_sale_refunds
        (store_id, settlement_id, after_sale_id, order_id, payment_attempt_id,
          refund_id, amount_vnd)
        SELECT store_id, ${fixture.settlementId}::uuid, id, order_id,
          ${fixture.paymentAttemptId}::uuid, ${fixture.refundId}::uuid, 100000
        FROM after_sales WHERE id = ${primaryCaseId}::uuid`;
    });

    beautyMemberToken = accessToken({
      actorType: 'member',
      sessionId: fixture.beautyMemberSessionId,
      storeId: BEAUTY_STORE_ID,
      subjectId: fixture.beautyMemberId,
    });
    beautyOtherMemberToken = accessToken({
      actorType: 'member',
      sessionId: fixture.beautyOtherMemberSessionId,
      storeId: BEAUTY_STORE_ID,
      subjectId: fixture.beautyOtherMemberId,
    });
    fashionMemberToken = accessToken({
      actorType: 'member',
      sessionId: fixture.fashionMemberSessionId,
      storeId: FASHION_STORE_ID,
      subjectId: fixture.fashionMemberId,
    });
    adminReaderToken = accessToken({
      actorType: 'admin',
      sessionId: fixture.adminReaderSessionId,
      subjectId: fixture.adminReaderId,
    });
    adminDeniedToken = accessToken({
      actorType: 'admin',
      sessionId: fixture.adminDeniedSessionId,
      subjectId: fixture.adminDeniedId,
    });

    const [{ AppModule }, { ApiExceptionFilter }, { AfterSalesRateLimiter }] = await Promise.all([
      import('../../apps/api/src/app.module'),
      import('../../apps/api/src/api-exception.filter'),
      import('../../apps/api/src/after-sales/after-sales-rate-limiter'),
    ]);
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    limiterRedis = (app.get(AfterSalesRateLimiter) as unknown as { redis: typeof limiterRedis })
      .redis;
  });

  afterAll(async () => {
    const limiterKeys = [
      ['MEMBER', fixture.beautyMemberId, BEAUTY_STORE_ID],
      ['MEMBER', fixture.beautyOtherMemberId, BEAUTY_STORE_ID],
      ['MEMBER', fixture.fashionMemberId, FASHION_STORE_ID],
      ['ADMIN', fixture.adminReaderId, BEAUTY_STORE_ID],
      ['ADMIN', fixture.adminDeniedId, BEAUTY_STORE_ID],
    ] as const;
    await limiterRedis?.del(
      ...limiterKeys.flatMap(([actorType, actorId, storeId]) =>
        [-1, 0, 1].map((offset) => rateLimitKey(actorType, actorId, storeId, offset)),
      ),
    );
    await app?.close();
    await runtime.$disconnect();
    await owner.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.afterSaleRefund.deleteMany({
        where: { settlementId: fixture.settlementId },
      });
      await transaction.refund.deleteMany({ where: { id: fixture.refundId } });
      await transaction.afterSaleSettlement.deleteMany({
        where: { id: fixture.settlementId },
      });
      await transaction.afterSaleReturnShipment.deleteMany({
        where: { id: fixture.returnShipmentId },
      });
      await transaction.afterSaleEvidenceFile.deleteMany({ where: { id: fixture.evidenceId } });
      await transaction.afterSaleTransition.deleteMany({
        where: { afterSaleId: { in: allCaseIds } },
      });
      await transaction.afterSaleItem.deleteMany({ where: { afterSaleId: { in: allCaseIds } } });
      await transaction.afterSale.deleteMany({ where: { id: { in: allCaseIds } } });
      await transaction.afterSalePolicyLocalization.deleteMany({
        where: { policyVersionId: fixture.policyVersionId },
      });
      await transaction.afterSalePolicyVersion.deleteMany({
        where: { id: fixture.policyVersionId },
      });
      await transaction.afterSalePolicy.deleteMany({ where: { id: fixture.policyId } });
      await transaction.memberSession.deleteMany({
        where: {
          id: {
            in: [
              fixture.beautyMemberSessionId,
              fixture.beautyOtherMemberSessionId,
              fixture.fashionMemberSessionId,
            ],
          },
        },
      });
      await transaction.member.deleteMany({
        where: {
          id: {
            in: [fixture.beautyMemberId, fixture.beautyOtherMemberId, fixture.fashionMemberId],
          },
        },
      });
      await transaction.adminSession.deleteMany({
        where: { id: { in: [fixture.adminReaderSessionId, fixture.adminDeniedSessionId] } },
      });
      await transaction.adminStoreRole.deleteMany({
        where: { adminUserId: { in: [fixture.adminReaderId, fixture.adminDeniedId] } },
      });
      await transaction.storeRolePermission.deleteMany({
        where: { roleId: fixture.adminReaderRoleId },
      });
      await transaction.storeRole.deleteMany({
        where: { id: { in: [fixture.adminReaderRoleId, fixture.adminDeniedRoleId] } },
      });
      await transaction.adminUser.deleteMany({
        where: { id: { in: [fixture.adminReaderId, fixture.adminDeniedId] } },
      });
    });
    await owner.$disconnect();
  });

  it('enforces member FORCE RLS and explicit owner/store predicates', async () => {
    const context = createStoreContext({
      actor: { id: fixture.beautyMemberId, type: 'member' },
      correlationId: randomUUID(),
      locale: 'en',
      storeCode: 'beauty-local',
      storeId: BEAUTY_STORE_ID,
    });
    const visible = await withStoreTransaction(runtime, context, (transaction) =>
      transaction.afterSale.findMany({ select: { id: true, memberId: true, storeId: true } }),
    );
    expect(visible.map((item) => item.id).sort()).toEqual([...fixture.beautyCaseIds].sort());
    expect(new Set(visible.map((item) => item.memberId))).toEqual(
      new Set([fixture.beautyMemberId]),
    );
    expect(new Set(visible.map((item) => item.storeId))).toEqual(new Set([BEAUTY_STORE_ID]));
  });

  it('traverses all same-millisecond member rows without duplicates or omissions', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const response = await api()
        .get(`/v1/after-sales?limit=1${cursor ? `&cursor=${cursor}` : ''}`)
        .set(memberHeaders());
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.headers['x-correlation-id']).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
      expect(response.body.items).toHaveLength(1);
      seen.push(response.body.items[0].id as string);
      cursor = response.body.next_cursor as string | null;
    } while (cursor !== null);
    expect(seen).toEqual([...fixture.beautyCaseIds]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('projects localized public detail while recursively excluding restricted markers', async () => {
    const response = await api()
      .get(`/v1/after-sales/${fixture.beautyCaseIds[0]}`)
      .set({ ...memberHeaders(), 'X-Correlation-Id': 'm63b1-member-detail' });
    expect(response.status).toBe(200);
    expect(response.body.policy_snapshot).toMatchObject({
      name: 'B1 after-sale policy',
      policy_version_number: 3,
      resolved_locale: 'en',
    });
    expect(response.body.evidence).toEqual([
      expect.objectContaining({ status: 'READY', version: 2 }),
    ]);
    expect(response.body.return_shipments).toEqual([
      expect.objectContaining({ masked_tracking_number: 'GH********89' }),
    ]);
    expect(response.body.settlements).toEqual([
      expect.objectContaining({
        amount_vnd: 100000,
        public_number: publicNumber('AST', fixture.settlementId),
        refund_public_number: publicNumber('RFD', fixture.refundId),
      }),
    ]);
    expect(response.body.timeline).toEqual([
      expect.objectContaining({ event: 'APPROVE', status: 'APPROVED' }),
    ]);
    expect(response.headers['cache-control']).toBe('private, no-store');
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('PRIVATE_');
    expect(serialized).not.toContain('private-sku-marker');
  });

  it('returns 404 for known cross-member/store IDs and 401 for a token/store mismatch', async () => {
    for (const id of [fixture.beautyOtherCaseId, fixture.fashionCaseId, randomUUID()]) {
      const response = await api().get(`/v1/after-sales/${id}`).set(memberHeaders());
      expect(response.status).toBe(404);
      expect(response.body.code).toBe('RESOURCE_NOT_FOUND');
      expect(response.body.correlation_id).toBe(response.headers['x-correlation-id']);
    }
    const mismatch = await api()
      .get('/v1/after-sales')
      .set(memberHeaders(fashionMemberToken, 'beauty-local'));
    expect(mismatch.status).toBe(401);
  });

  it('binds cursors to the member, resource and normalized filters', async () => {
    const first = await api().get('/v1/after-sales?limit=1').set(memberHeaders());
    expect(first.status).toBe(200);
    const cursor = first.body.next_cursor as string;
    const crossMember = await api()
      .get(`/v1/after-sales?limit=1&cursor=${cursor}`)
      .set(memberHeaders(beautyOtherMemberToken));
    expect(crossMember.status).toBe(400);
    const changedFilter = await api()
      .get(`/v1/after-sales?limit=1&status=APPROVED&cursor=${cursor}`)
      .set(memberHeaders());
    expect(changedFilter.status).toBe(400);
    const adminReuse = await api()
      .get(`/v1/admin/after-sales?store_id=${BEAUTY_STORE_ID}&limit=1&cursor=${cursor}`)
      .set(adminHeaders());
    expect(adminReuse.status).toBe(400);
  });

  it('traverses the admin microsecond page and rejects cursor scope or filter replay', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let firstCursor: string | null = null;
    do {
      const response = await api()
        .get(
          `/v1/admin/after-sales?store_id=${BEAUTY_STORE_ID}&limit=1${
            cursor ? `&cursor=${cursor}` : ''
          }`,
        )
        .set(adminHeaders());
      expect(response.status).toBe(200);
      expect(response.body.items).toHaveLength(1);
      seen.push(response.body.items[0].id as string);
      cursor = response.body.next_cursor as string | null;
      firstCursor ??= cursor;
    } while (cursor !== null);
    expect(seen).toEqual([fixture.beautyOtherCaseId, ...fixture.beautyCaseIds]);
    expect(new Set(seen).size).toBe(seen.length);
    if (!firstCursor) throw new Error('admin pagination fixture did not issue a cursor');

    const changedFilter = await api()
      .get(
        `/v1/admin/after-sales?store_id=${BEAUTY_STORE_ID}&limit=1&member_id=${fixture.beautyMemberId}&cursor=${firstCursor}`,
      )
      .set(adminHeaders());
    expect(changedFilter.status).toBe(400);
    const memberReuse = await api()
      .get(`/v1/after-sales?limit=1&cursor=${firstCursor}`)
      .set(memberHeaders());
    expect(memberReuse.status).toBe(400);
  });

  it('enforces admin RBAC/store agreement and supports locale plus canonical filters', async () => {
    const listed = await api()
      .get(
        `/v1/admin/after-sales?store_id=${BEAUTY_STORE_ID}&member_id=${fixture.beautyMemberId}&locale=zh`,
      )
      .set(adminHeaders());
    expect(listed.status).toBe(200);
    expect(listed.body.items.map((item: { id: string }) => item.id)).toEqual([
      ...fixture.beautyCaseIds,
    ]);
    expect(listed.body.items[0].policy_snapshot).toMatchObject({
      name: 'B1 售后政策',
      resolved_locale: 'zh',
    });
    const defaultLocale = await api()
      .get(`/v1/admin/after-sales/${fixture.beautyCaseIds[0]}?store_id=${BEAUTY_STORE_ID}`)
      .set(adminHeaders());
    expect(defaultLocale.status).toBe(200);
    expect(defaultLocale.body.policy_snapshot.resolved_locale).toBe('vi');

    const denied = await api()
      .get(`/v1/admin/after-sales?store_id=${BEAUTY_STORE_ID}`)
      .set(adminHeaders(adminDeniedToken));
    expect(denied.status).toBe(403);
    const mismatchedStore = await api()
      .get(`/v1/admin/after-sales?store_id=${FASHION_STORE_ID}`)
      .set(adminHeaders());
    expect(mismatchedStore.status).toBe(403);
    const missing = await api()
      .get(`/v1/admin/after-sales/${randomUUID()}?store_id=${BEAUTY_STORE_ID}`)
      .set(adminHeaders());
    expect(missing.status).toBe(404);
    const crossStoreDetail = await api()
      .get(`/v1/admin/after-sales/${fixture.fashionCaseId}?store_id=${BEAUTY_STORE_ID}`)
      .set(adminHeaders());
    expect(crossStoreDetail.status).toBe(404);
    for (const filter of [
      `member_id=${fixture.fashionMemberId}`,
      `order_id=${fixture.fashionOrderId}`,
    ]) {
      const crossStoreFilter = await api()
        .get(`/v1/admin/after-sales?store_id=${BEAUTY_STORE_ID}&${filter}`)
        .set(adminHeaders());
      expect(crossStoreFilter.status).toBe(200);
      expect(crossStoreFilter.body.items).toEqual([]);
    }
  });

  it('rejects unauthenticated and non-strict inputs without exposing internals', async () => {
    const unauthenticated = await api()
      .get('/v1/after-sales')
      .set({ 'X-Store-Code': 'beauty-local' });
    expect(unauthenticated.status).toBe(401);
    for (const path of [
      '/v1/after-sales?unexpected=true',
      `/v1/after-sales/${fixture.beautyCaseIds[0]}?unexpected=true`,
      '/v1/after-sales/not-a-uuid',
      '/v1/after-sales?cursor=c1_invalid',
      `/v1/admin/after-sales?store_id=${BEAUTY_STORE_ID}&unexpected=true`,
    ]) {
      const response = path.includes('/admin/')
        ? await api().get(path).set(adminHeaders())
        : await api().get(path).set(memberHeaders());
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: 'INPUT_INVALID' });
      expect(JSON.stringify(response.body)).not.toContain('Zod');
    }
    const invalidStoreCode = await api()
      .get('/v1/after-sales')
      .set(memberHeaders(beautyMemberToken, 'Beauty-local'));
    expect(invalidStoreCode.status).toBe(400);
    expect(invalidStoreCode.body.code).toBe('INPUT_INVALID');
  });

  it('fails closed with a safe 503 when the Redis limiter is unavailable', async () => {
    const evalSpy = vi
      .spyOn(limiterRedis, 'eval')
      .mockRejectedValueOnce(new Error('PRIVATE_REDIS_CONNECTION_MARKER'));
    try {
      const response = await api()
        .get(`/v1/after-sales/${fixture.beautyCaseIds[0]}`)
        .set(memberHeaders());
      expect(response.status).toBe(503);
      expect(response.headers['retry-after']).toBeUndefined();
      expect(response.body.code).toBe('UPSTREAM_UNAVAILABLE');
      expect(JSON.stringify(response.body)).not.toContain('PRIVATE_REDIS_CONNECTION_MARKER');
    } finally {
      evalSpy.mockRestore();
    }
  });

  it('returns a safe 429 with Retry-After before reading the requested case', async () => {
    const keys = [
      rateLimitKey('MEMBER', fixture.beautyMemberId, BEAUTY_STORE_ID),
      rateLimitKey('MEMBER', fixture.beautyMemberId, BEAUTY_STORE_ID, 1),
    ];
    await Promise.all(keys.map((key) => limiterRedis.set(key, '60', 'EX', 61)));
    const response = await api()
      .get(`/v1/after-sales/${fixture.beautyCaseIds[0]}`)
      .set(memberHeaders());
    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toMatch(/^[1-9][0-9]?$/);
    expect(response.body).toMatchObject({ code: 'RATE_LIMITED' });
    expect(JSON.stringify(response.body)).not.toContain(fixture.beautyCaseIds[0]);
    await limiterRedis.del(...keys);
  });
});
