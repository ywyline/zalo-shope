import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { config as loadEnvironment } from 'dotenv';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { parseRuntimeConfig } from '@zalo-shop/config';
import { PrismaClient } from '@zalo-shop/database';
import { signJwt } from '@zalo-shop/security';

type AdminName = 'disabler' | 'limiter' | 'manager' | 'operator' | 'publisher' | 'reader';
type StoreName = 'a' | 'b';

function uuidWithHexLetter(): string {
  const value = randomUUID();
  return /[a-f]/u.test(value) ? value : uuidWithHexLetter();
}

describe.sequential('M6.3-B2a after-sale policy management API', () => {
  loadEnvironment({ path: '.env.test.example', quiet: true, override: true });
  const config = parseRuntimeConfig();
  const owner = new PrismaClient({ datasourceUrl: config.DATABASE_URL });
  const suffix = randomUUID().slice(0, 8);
  const store = {
    a: { code: `m63b2-api-a-${suffix}`, id: randomUUID() },
    b: { code: `m63b2-api-b-${suffix}`, id: randomUUID() },
  } as const;
  const catalog = {
    brandAId: randomUUID(),
    brandBId: randomUUID(),
    categoryAId: randomUUID(),
    categoryBId: randomUUID(),
    productAId: uuidWithHexLetter(),
    productBId: randomUUID(),
  };
  const admins = {
    disabler: { id: randomUUID(), roleAId: randomUUID(), sessionId: randomUUID() },
    limiter: { id: randomUUID(), roleAId: randomUUID(), sessionId: randomUUID() },
    manager: { id: randomUUID(), roleAId: randomUUID(), sessionId: randomUUID() },
    operator: {
      id: randomUUID(),
      roleAId: randomUUID(),
      roleBId: randomUUID(),
      sessionId: randomUUID(),
    },
    publisher: { id: randomUUID(), roleAId: randomUUID(), sessionId: randomUUID() },
    reader: { id: randomUUID(), roleAId: randomUUID(), sessionId: randomUUID() },
  } as const;
  const primaryCode = `primary-${suffix}`;
  const contenderCode = `contender-${suffix}`;
  const createKey = `m63b2-create-${suffix}-0001`;
  const firstPublishKey = `m63b2-publish-${suffix}-0001`;
  const secondPublishKey = `m63b2-publish-${suffix}-0002`;
  const disableKey = `m63b2-disable-${suffix}-0001`;
  const correlations = {
    create: `m63b2-create-${suffix}`,
    disable: `m63b2-disable-${suffix}`,
    firstPublish: `m63b2-publish-1-${suffix}`,
    secondPublish: `m63b2-publish-2-${suffix}`,
  } as const;
  const tokens = {} as Record<AdminName, string>;
  let app: INestApplication;
  let limiterRedis: {
    del(...keys: string[]): Promise<number>;
    eval(...args: unknown[]): Promise<unknown>;
    set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  };

  const api = () => request(app.getHttpServer() as Server);
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const path = (code = primaryCode, storeName: StoreName = 'a') =>
    `/v1/admin/after-sale-policies/${code}?store_id=${store[storeName].id}`;
  const versionsPath = (code = primaryCode, storeName: StoreName = 'a') =>
    `/v1/admin/after-sale-policies/${code}/versions?store_id=${store[storeName].id}`;
  const headers = (
    admin: AdminName = 'operator',
    storeName: StoreName = 'a',
    extra: Record<string, string> = {},
  ) => ({
    Authorization: `Bearer ${tokens[admin]}`,
    'X-Store-Code': store[storeName].code,
    ...extra,
  });

  function policyContent(overrides: Record<string, unknown> = {}) {
    return {
      allowed_types: ['EXCHANGE', 'REFUND_ONLY'],
      category_id: null,
      condition_rules: {
        evidence_required: true,
        evidence_required_reason_codes: ['wrong-item', 'damaged-item'],
        opened_package_exception_reason_codes: ['wrong-item', 'defect'],
      },
      damaged_exception: true,
      defect_exception: true,
      exchange_attribute_code: 'size',
      exchange_same_product_only: true,
      hygiene_restricted: false,
      localizations: [
        {
          buyer_instructions: 'Return the item using the approved instructions.',
          locale: 'en',
          name: 'English policy',
          summary: 'English policy summary',
        },
        {
          buyer_instructions: '请按照已批准的指引寄回商品。',
          locale: 'zh',
          name: '中文政策',
          summary: '中文政策摘要',
        },
        {
          buyer_instructions: 'Gửi lại sản phẩm theo hướng dẫn đã được phê duyệt.',
          locale: 'vi',
          name: 'Chính sách tiếng Việt',
          summary: 'Tóm tắt chính sách tiếng Việt',
        },
      ],
      product_ids: [catalog.productAId.toUpperCase()],
      request_window_days: 30,
      return_shipping_payer: 'MERCHANT',
      return_window_days: 7,
      unopened_required: false,
      wrong_item_exception: true,
      ...overrides,
    };
  }

  function policyDraft(expectedVersion: number, overrides: Record<string, unknown> = {}) {
    return { ...policyContent(overrides), expected_version: expectedVersion };
  }

  function accessToken(admin: AdminName): string {
    const now = Math.floor(Date.now() / 1_000);
    return signJwt(
      {
        actor_type: 'admin',
        aud: config.AUTH_JWT_AUDIENCE,
        exp: now + 900,
        iat: now,
        iss: config.AUTH_JWT_ISSUER,
        jti: randomUUID(),
        session_id: admins[admin].sessionId,
        sub: admins[admin].id,
      },
      config.AUTH_JWT_SECRET,
    );
  }

  function rateLimitKey(
    admin: AdminName,
    storeName: StoreName,
    access: 'read' | 'write',
    windowOffset = 0,
  ): string {
    const window = Math.floor(Date.now() / 60_000) + windowOffset;
    const identity = createHmac('sha256', config.PII_HASH_KEY)
      .update(`ADMIN:${admins[admin].id}`)
      .digest('hex');
    return `${config.NODE_ENV}:${store[storeName].id}:after-sale-${access}:admin:${identity}:${window}`;
  }

  function expectPrivateResponse(
    response: { body: unknown; headers: Record<string, string | undefined>; status: number },
    correlation?: string,
  ): void {
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['x-correlation-id']).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
    if (correlation !== undefined) {
      expect(response.headers['x-correlation-id']).toBe(correlation);
    }
    if (response.status >= 400) {
      expect(response.body).toMatchObject({
        correlation_id: response.headers['x-correlation-id'],
      });
    }
  }

  beforeAll(async () => {
    await owner.$connect();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1_000);
    const allPermissions = [
      'store.after-sales.policy.read',
      'store.after-sales.policy.manage',
      'store.after-sales.policy.publish',
      'store.after-sales.policy.disable',
      'store.after-sales.policy.enforce',
    ];
    await owner.$transaction(async (transaction) => {
      await transaction.adminUser.createMany({
        data: (Object.entries(admins) as Array<[AdminName, (typeof admins)[AdminName]]>).map(
          ([name, admin]) => ({
            displayName: `M6.3-B2a API ${name}`,
            email: `m63b2-api-${name}-${suffix}@example.invalid`,
            emailNormalized: `m63b2-api-${name}-${suffix}@example.invalid`,
            id: admin.id,
            passwordHash: 'test-fixture-not-a-login-hash',
          }),
        ),
      });
      await transaction.store.createMany({
        data: [
          { code: store.a.code, id: store.a.id, industry: 'BEAUTY' },
          { code: store.b.code, id: store.b.id, industry: 'FASHION' },
        ],
      });
      await transaction.category.createMany({
        data: [
          {
            code: `category-a-${suffix}`,
            depth: 1,
            id: catalog.categoryAId,
            storeId: store.a.id,
          },
          {
            code: `category-b-${suffix}`,
            depth: 1,
            id: catalog.categoryBId,
            storeId: store.b.id,
          },
        ],
      });
      await transaction.brand.createMany({
        data: [
          { code: `brand-a-${suffix}`, id: catalog.brandAId, storeId: store.a.id },
          { code: `brand-b-${suffix}`, id: catalog.brandBId, storeId: store.b.id },
        ],
      });
      await transaction.product.createMany({
        data: [
          {
            brandId: catalog.brandAId,
            code: `product-a-${suffix}`,
            id: catalog.productAId,
            mainCategoryId: catalog.categoryAId,
            storeId: store.a.id,
          },
          {
            brandId: catalog.brandBId,
            code: `product-b-${suffix}`,
            id: catalog.productBId,
            mainCategoryId: catalog.categoryBId,
            storeId: store.b.id,
          },
        ],
      });
      await transaction.adminSession.createMany({
        data: (Object.entries(admins) as Array<[AdminName, (typeof admins)[AdminName]]>).map(
          ([name, admin]) => ({
            adminUserId: admin.id,
            expiresAt,
            id: admin.sessionId,
            mfaVerifiedAt: new Date(),
            refreshTokenHash: digest(`m63b2-api-${name}-${suffix}`),
            tokenFamilyId: randomUUID(),
          }),
        ),
      });
      await transaction.storeRole.createMany({
        data: [
          {
            code: `operator-a-${suffix}`,
            id: admins.operator.roleAId,
            name: 'M6.3-B2a all permissions A',
            storeId: store.a.id,
          },
          {
            code: `operator-b-${suffix}`,
            id: admins.operator.roleBId,
            name: 'M6.3-B2a all permissions B',
            storeId: store.b.id,
          },
          ...(['reader', 'manager', 'publisher', 'disabler', 'limiter'] as const).map((name) => ({
            code: `${name}-${suffix}`,
            id: admins[name].roleAId,
            name: `M6.3-B2a ${name}`,
            storeId: store.a.id,
          })),
        ],
      });
      await transaction.storeRolePermission.createMany({
        data: [
          ...allPermissions.flatMap((permissionCode) => [
            { permissionCode, roleId: admins.operator.roleAId, storeId: store.a.id },
            { permissionCode, roleId: admins.operator.roleBId, storeId: store.b.id },
          ]),
          {
            permissionCode: 'store.after-sales.policy.read',
            roleId: admins.reader.roleAId,
            storeId: store.a.id,
          },
          ...(['manager', 'limiter'] as const).map((name) => ({
            permissionCode: 'store.after-sales.policy.manage',
            roleId: admins[name].roleAId,
            storeId: store.a.id,
          })),
          {
            permissionCode: 'store.after-sales.policy.read',
            roleId: admins.limiter.roleAId,
            storeId: store.a.id,
          },
          {
            permissionCode: 'store.after-sales.policy.publish',
            roleId: admins.publisher.roleAId,
            storeId: store.a.id,
          },
          {
            permissionCode: 'store.after-sales.policy.disable',
            roleId: admins.disabler.roleAId,
            storeId: store.a.id,
          },
        ],
      });
      await transaction.adminStoreRole.createMany({
        data: [
          {
            adminUserId: admins.operator.id,
            grantedBy: admins.operator.id,
            roleId: admins.operator.roleAId,
            storeId: store.a.id,
          },
          {
            adminUserId: admins.operator.id,
            grantedBy: admins.operator.id,
            roleId: admins.operator.roleBId,
            storeId: store.b.id,
          },
          ...(['reader', 'manager', 'publisher', 'disabler', 'limiter'] as const).map((name) => ({
            adminUserId: admins[name].id,
            grantedBy: admins.operator.id,
            roleId: admins[name].roleAId,
            storeId: store.a.id,
          })),
        ],
      });
    });

    for (const name of Object.keys(admins) as AdminName[]) tokens[name] = accessToken(name);
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
    const limiterKeys = (Object.keys(admins) as AdminName[]).flatMap((admin) =>
      (['a', 'b'] as const).flatMap((storeName) =>
        (['read', 'write'] as const).flatMap((access) =>
          [-1, 0, 1].map((offset) => rateLimitKey(admin, storeName, access, offset)),
        ),
      ),
    );
    await limiterRedis?.del(...limiterKeys);
    await app?.close();
    await owner.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.auditLog.deleteMany({
        where: { storeId: { in: [store.a.id, store.b.id] } },
      });
      await transaction.idempotencyRecord.deleteMany({
        where: { storeId: { in: [store.a.id, store.b.id] } },
      });
      await transaction.storeAfterSaleSetting.deleteMany({
        where: { storeId: { in: [store.a.id, store.b.id] } },
      });
      await transaction.afterSaleActivePolicyAssignment.deleteMany({
        where: { storeId: { in: [store.a.id, store.b.id] } },
      });
      await transaction.afterSalePolicyDraftProduct.deleteMany({
        where: { storeId: { in: [store.a.id, store.b.id] } },
      });
      await transaction.afterSalePolicyLocalization.deleteMany({
        where: { storeId: { in: [store.a.id, store.b.id] } },
      });
      await transaction.afterSalePolicyVersionAssignment.deleteMany({
        where: { storeId: { in: [store.a.id, store.b.id] } },
      });
      await transaction.afterSalePolicyVersion.deleteMany({
        where: { storeId: { in: [store.a.id, store.b.id] } },
      });
      await transaction.afterSalePolicy.deleteMany({
        where: { storeId: { in: [store.a.id, store.b.id] } },
      });
      await transaction.product.deleteMany({
        where: { id: { in: [catalog.productAId, catalog.productBId] } },
      });
      await transaction.brand.deleteMany({
        where: { id: { in: [catalog.brandAId, catalog.brandBId] } },
      });
      await transaction.category.deleteMany({
        where: { id: { in: [catalog.categoryAId, catalog.categoryBId] } },
      });
      await transaction.adminStoreRole.deleteMany({
        where: { adminUserId: { in: Object.values(admins).map(({ id }) => id) } },
      });
      await transaction.storeRolePermission.deleteMany({
        where: {
          roleId: {
            in: Object.values(admins).flatMap((admin) =>
              'roleBId' in admin ? [admin.roleAId, admin.roleBId] : [admin.roleAId],
            ),
          },
        },
      });
      await transaction.storeRole.deleteMany({
        where: { storeId: { in: [store.a.id, store.b.id] } },
      });
      await transaction.adminSession.deleteMany({
        where: { adminUserId: { in: Object.values(admins).map(({ id }) => id) } },
      });
      await transaction.adminUser.deleteMany({
        where: { id: { in: Object.values(admins).map(({ id }) => id) } },
      });
      await transaction.store.deleteMany({ where: { id: { in: [store.a.id, store.b.id] } } });
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });
    await owner.$disconnect();
  });

  it('enforces strict inputs, exact RBAC permissions, recent MFA and store agreement', async () => {
    const empty = await api()
      .get(`/v1/admin/after-sale-policies?store_id=${store.a.id}`)
      .set(headers('reader'));
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ items: [], next_cursor: null });
    expectPrivateResponse(empty);

    const unauthenticated = await api().get(`/v1/admin/after-sale-policies?store_id=${store.a.id}`);
    expect(unauthenticated.status).toBe(401);
    expectPrivateResponse(unauthenticated);

    const readerWrite = await api()
      .put(path())
      .set({ ...headers('reader'), 'Idempotency-Key': `m63b2-reader-${suffix}-001` })
      .send(policyDraft(0));
    expect(readerWrite.status).toBe(403);
    const managerRead = await api().get(path()).set(headers('manager'));
    expect(managerRead.status).toBe(403);
    const managerPublish = await api()
      .post(path().replace('?', '/publish?'))
      .set({ ...headers('manager'), 'Idempotency-Key': `m63b2-manager-${suffix}-001` })
      .send({
        confirmation_code: 'PUBLISH_AFTER_SALE_POLICY',
        expected_version: 1,
        reason: 'A manager permission must not imply the publish permission.',
      });
    expect(managerPublish.status).toBe(403);
    const publisherDisable = await api()
      .post(path().replace('?', '/disable?'))
      .set({ ...headers('publisher'), 'Idempotency-Key': `m63b2-publisher-${suffix}-001` })
      .send({
        confirmation_code: 'DISABLE_AFTER_SALE_POLICY',
        expected_version: 1,
        reason: 'A publisher permission must not imply the disable permission.',
      });
    expect(publisherDisable.status).toBe(403);
    const disablerPublish = await api()
      .post(path().replace('?', '/publish?'))
      .set({ ...headers('disabler'), 'Idempotency-Key': `m63b2-disabler-${suffix}-001` })
      .send({
        confirmation_code: 'PUBLISH_AFTER_SALE_POLICY',
        expected_version: 1,
        reason: 'A disable permission must not imply the publish permission.',
      });
    expect(disablerPublish.status).toBe(403);

    const strictRequests = [
      () =>
        api()
          .get(`/v1/admin/after-sale-policies?store_id=${store.a.id}&unexpected=true`)
          .set(headers('reader')),
      () =>
        api()
          .get(`/v1/admin/after-sale-policies?store_id=${store.a.id}&store_id=${store.a.id}`)
          .set(headers('reader')),
      () => api().get(path('INVALID-CODE')).set(headers('reader')),
      () =>
        api()
          .get(path())
          .set(headers('reader', 'a', { 'X-Access-Reason': 'short' })),
      () =>
        api()
          .get(path())
          .set({ Authorization: `Bearer ${tokens.reader}`, 'X-Store-Code': 'Invalid-Code' }),
      () =>
        api()
          .put(path(`extra-body-${suffix}`))
          .set({ ...headers('manager'), 'Idempotency-Key': `m63b2-strict-${suffix}-001` })
          .send({ ...policyDraft(0), unexpected: true }),
      () =>
        api()
          .put(path(`missing-key-${suffix}`))
          .set(headers('manager'))
          .send(policyDraft(0)),
    ];
    for (const makeRequest of strictRequests) {
      const response = await makeRequest();
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INPUT_INVALID');
      expect(JSON.stringify(response.body)).not.toContain('Zod');
      expectPrivateResponse(response);
    }

    const duplicateCaseUuid = await api()
      .put(path(`duplicate-uuid-${suffix}`))
      .set({ ...headers('manager'), 'Idempotency-Key': `m63b2-uuid-${suffix}-0001` })
      .send(
        policyDraft(0, {
          product_ids: [catalog.productAId, catalog.productAId.toUpperCase()],
        }),
      );
    expect(duplicateCaseUuid.status).toBe(400);
    expect(duplicateCaseUuid.body.code).toBe('INPUT_INVALID');
    expectPrivateResponse(duplicateCaseUuid);

    const crossStoreTarget = await api()
      .put(path(`cross-store-target-${suffix}`))
      .set({ ...headers('manager'), 'Idempotency-Key': `m63b2-target-${suffix}-0001` })
      .send(policyDraft(0, { product_ids: [catalog.productBId] }));
    expect(crossStoreTarget.status).toBe(404);
    expect(crossStoreTarget.body.code).toBe('RESOURCE_NOT_FOUND');
    expectPrivateResponse(crossStoreTarget);

    await owner.adminSession.update({
      data: { mfaVerifiedAt: new Date(Date.now() - 11 * 60 * 1_000) },
      where: { id: admins.publisher.sessionId },
    });
    const staleMfa = await api()
      .post(path().replace('?', '/publish?'))
      .set({ ...headers('publisher'), 'Idempotency-Key': `m63b2-stale-${suffix}-0001` })
      .send({
        confirmation_code: 'PUBLISH_AFTER_SALE_POLICY',
        expected_version: 1,
        reason: 'Publishing must require a recent administrator MFA verification.',
      });
    expect(staleMfa.status).toBe(403);
    expectPrivateResponse(staleMfa);
    await owner.adminSession.update({
      data: { mfaVerifiedAt: new Date() },
      where: { id: admins.publisher.sessionId },
    });

    await owner.adminSession.update({
      data: { mfaVerifiedAt: new Date(Date.now() - 11 * 60 * 1_000) },
      where: { id: admins.disabler.sessionId },
    });
    const staleDisableMfa = await api()
      .post(path().replace('?', '/disable?'))
      .set({ ...headers('disabler'), 'Idempotency-Key': `m63b2-stale-disable-${suffix}-0001` })
      .send({
        confirmation_code: 'DISABLE_AFTER_SALE_POLICY',
        expected_version: 1,
        reason: 'Disabling must require a recent administrator MFA verification.',
      });
    expect(staleDisableMfa.status).toBe(403);
    expectPrivateResponse(staleDisableMfa);
    await owner.adminSession.update({
      data: { mfaVerifiedAt: new Date() },
      where: { id: admins.disabler.sessionId },
    });
  });

  it('creates store-scoped drafts with canonical output and 24-hour idempotency', async () => {
    const body = policyDraft(0);
    const created = await api()
      .put(path())
      .set(
        headers('manager', 'a', {
          'Idempotency-Key': createKey,
          'X-Access-Reason': 'Prepare the initial B2a policy control-plane draft.',
          'X-Correlation-Id': correlations.create,
        }),
      )
      .send(body);
    expect(created.status).toBe(200);
    expect(created.headers['idempotency-replayed']).toBe('false');
    expect(created.body).toMatchObject({
      code: primaryCode,
      current_version: null,
      current_version_number: null,
      status: 'DRAFT',
      version: 1,
    });
    expect(created.body.draft.allowed_types).toEqual(['REFUND_ONLY', 'EXCHANGE']);
    expect(created.body.draft.product_ids).toEqual([catalog.productAId]);
    expect(
      created.body.draft.localizations.map(({ locale }: { locale: string }) => locale),
    ).toEqual(['vi', 'zh', 'en']);
    expect(created.body.draft.condition_rules.evidence_required_reason_codes).toEqual([
      'damaged-item',
      'wrong-item',
    ]);
    expectPrivateResponse(created, correlations.create);

    const replayed = await api()
      .put(path())
      .set(
        headers('manager', 'a', {
          'Idempotency-Key': createKey,
          'X-Access-Reason': 'Prepare the initial B2a policy control-plane draft.',
          'X-Correlation-Id': 'm63b2-create-replay',
        }),
      )
      .send(
        policyDraft(0, {
          allowed_types: ['REFUND_ONLY', 'EXCHANGE'],
          condition_rules: {
            evidence_required: true,
            evidence_required_reason_codes: ['damaged-item', 'wrong-item'],
            opened_package_exception_reason_codes: ['defect', 'wrong-item'],
          },
          localizations: [body.localizations[2], body.localizations[1], body.localizations[0]],
          product_ids: [catalog.productAId],
        }),
      );
    expect(replayed.status).toBe(200);
    expect(replayed.headers['idempotency-replayed']).toBe('true');
    expect(replayed.body).toEqual(created.body);
    expectPrivateResponse(replayed, 'm63b2-create-replay');

    const changedRequest = await api()
      .put(path())
      .set({ ...headers('manager'), 'Idempotency-Key': createKey })
      .send(policyDraft(0, { request_window_days: 31 }));
    expect(changedRequest.status).toBe(409);
    expect(changedRequest.body.details).toEqual({
      reason_code: 'AFTER_SALE_POLICY_IDEMPOTENCY_CONFLICT',
    });
    const changedResource = await api()
      .put(path(`different-${suffix}`))
      .set({ ...headers('manager'), 'Idempotency-Key': createKey })
      .send(body);
    expect(changedResource.status).toBe(409);
    expect(changedResource.body.details).toEqual({
      reason_code: 'AFTER_SALE_POLICY_IDEMPOTENCY_CONFLICT',
    });

    const wrongVersion = await api()
      .put(path())
      .set({ ...headers('manager'), 'Idempotency-Key': `m63b2-version-${suffix}-0001` })
      .send(policyDraft(0));
    expect(wrongVersion.status).toBe(409);
    expect(wrongVersion.body.details).toEqual({
      reason_code: 'AFTER_SALE_POLICY_VERSION_CONFLICT',
    });

    const storeBCreated = await api()
      .put(path(primaryCode, 'b'))
      .set({ ...headers('operator', 'b'), 'Idempotency-Key': createKey })
      .send(policyDraft(0, { product_ids: [catalog.productBId.toUpperCase()] }));
    expect(storeBCreated.status).toBe(200);
    expect(storeBCreated.headers['idempotency-replayed']).toBe('false');
    expect(storeBCreated.body.draft.product_ids).toEqual([catalog.productBId]);

    const storeAList = await api()
      .get(`/v1/admin/after-sale-policies?store_id=${store.a.id}`)
      .set(headers('reader'));
    const storeBList = await api()
      .get(`/v1/admin/after-sale-policies?store_id=${store.b.id}`)
      .set(headers('operator', 'b'));
    expect(storeAList.body.items).toEqual([
      expect.objectContaining({ code: primaryCode, status: 'DRAFT' }),
    ]);
    expect(storeBList.body.items).toEqual([
      expect.objectContaining({ code: primaryCode, status: 'DRAFT' }),
    ]);
    const storeBDetail = await api().get(path(primaryCode, 'b')).set(headers('operator', 'b'));
    expect(storeBDetail.status).toBe(200);
    expect(storeBDetail.body.draft.product_ids).toEqual([catalog.productBId]);

    const mismatchedStore = await api()
      .get(`/v1/admin/after-sale-policies?store_id=${store.b.id}`)
      .set(headers('operator', 'a'));
    expect(mismatchedStore.status).toBe(403);
    expectPrivateResponse(mismatchedStore);
  });

  it('publishes immutable versions without exposing an ACTIVE next draft and rejects target conflicts', async () => {
    const publishBody = {
      confirmation_code: 'PUBLISH_AFTER_SALE_POLICY',
      expected_version: 1,
      reason: 'Publish the reviewed initial policy as an immutable version.',
    };
    const published = await api()
      .post(path().replace('?', '/publish?'))
      .set(
        headers('publisher', 'a', {
          'Idempotency-Key': firstPublishKey,
          'X-Correlation-Id': correlations.firstPublish,
        }),
      )
      .send(publishBody);
    expect(published.status).toBe(200);
    expect(published.headers['idempotency-replayed']).toBe('false');
    expect(published.body).toMatchObject({
      code: primaryCode,
      content: { product_ids: [catalog.productAId] },
      version_number: 1,
    });
    expect(published.body.effective_at).toBe(published.body.published_at);
    expectPrivateResponse(published, correlations.firstPublish);

    const publishReplay = await api()
      .post(path().replace('?', '/publish?'))
      .set({ ...headers('publisher'), 'Idempotency-Key': firstPublishKey })
      .send(publishBody);
    expect(publishReplay.status).toBe(200);
    expect(publishReplay.headers['idempotency-replayed']).toBe('true');
    expect(publishReplay.body).toEqual(published.body);

    const publishChanged = await api()
      .post(path().replace('?', '/publish?'))
      .set({ ...headers('publisher'), 'Idempotency-Key': firstPublishKey })
      .send({ ...publishBody, reason: 'A changed reason must conflict under the same key.' });
    expect(publishChanged.status).toBe(409);
    expect(publishChanged.body.details).toEqual({
      reason_code: 'AFTER_SALE_POLICY_IDEMPOTENCY_CONFLICT',
    });
    const staleVersion = await api()
      .post(path().replace('?', '/publish?'))
      .set({
        ...headers('publisher'),
        'Idempotency-Key': `m63b2-publish-stale-${suffix}-0001`,
      })
      .send(publishBody);
    expect(staleVersion.status).toBe(409);
    expect(staleVersion.body.details).toEqual({
      reason_code: 'AFTER_SALE_POLICY_VERSION_CONFLICT',
    });

    const activeBeforeDraft = await owner.afterSaleActivePolicyAssignment.findMany({
      orderBy: { id: 'asc' },
      where: { policy: { code: primaryCode }, storeId: store.a.id },
    });
    const nextDraft = await api()
      .put(path())
      .set({
        ...headers('operator'),
        'Idempotency-Key': `m63b2-next-draft-${suffix}-0001`,
        'X-Access-Reason': 'Prepare a category-scoped next version without publishing it.',
      })
      .send(
        policyDraft(2, {
          category_id: catalog.categoryAId.toUpperCase(),
          product_ids: [],
        }),
      );
    expect(nextDraft.status).toBe(200);
    expect(nextDraft.body).toMatchObject({
      current_version: {
        content: { category_id: null, product_ids: [catalog.productAId] },
        version_number: 1,
      },
      draft: { category_id: catalog.categoryAId, product_ids: [] },
      status: 'ACTIVE',
      version: 3,
    });
    const activeAfterDraft = await owner.afterSaleActivePolicyAssignment.findMany({
      orderBy: { id: 'asc' },
      where: { policy: { code: primaryCode }, storeId: store.a.id },
    });
    expect(activeAfterDraft).toEqual(activeBeforeDraft);
    const onlyPublishedVersion = await api().get(versionsPath()).set(headers('reader'));
    expect(onlyPublishedVersion.status).toBe(200);
    expect(onlyPublishedVersion.body.items).toHaveLength(1);
    expect(onlyPublishedVersion.body.items[0].content).toMatchObject({
      category_id: null,
      product_ids: [catalog.productAId],
    });

    const contenderDraft = await api()
      .put(path(contenderCode))
      .set({
        ...headers('operator'),
        'Idempotency-Key': `m63b2-contender-${suffix}-0001`,
      })
      .send(policyDraft(0, { product_ids: [] }));
    expect(contenderDraft.status).toBe(200);
    const targetConflict = await api()
      .post(path(contenderCode).replace('?', '/publish?'))
      .set({
        ...headers('operator'),
        'Idempotency-Key': `m63b2-contender-publish-${suffix}-0001`,
      })
      .send({
        confirmation_code: 'PUBLISH_AFTER_SALE_POLICY',
        expected_version: 1,
        reason: 'A second active owner of the store default must be rejected.',
      });
    expect(targetConflict.status).toBe(409);
    expect(targetConflict.body.details).toEqual({
      reason_code: 'AFTER_SALE_POLICY_TARGET_CONFLICT',
    });

    const resetDraft = await api()
      .put(path())
      .set({
        ...headers('operator'),
        'Idempotency-Key': `m63b2-reset-draft-${suffix}-0001`,
      })
      .send(policyDraft(3, { request_window_days: 45 }));
    expect(resetDraft.status).toBe(200);
    expect(resetDraft.body).toMatchObject({ status: 'ACTIVE', version: 4 });
  });

  it('synchronizes enforcement and rolls back a dangerous disable before a safe HTTP 200 disable', async () => {
    const settingsPath = `/v1/admin/after-sale-settings?store_id=${store.a.id}`;
    const ready = await api().get(settingsPath).set(headers('operator'));
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({
      default_policy_code: primaryCode,
      enforce_policy_snapshots: false,
      readiness_state: 'READY',
    });
    const enabled = await api()
      .put(settingsPath)
      .set({
        ...headers('operator'),
        'Idempotency-Key': `m63b2-enforce-on-${suffix}-0001`,
      })
      .send({
        confirmation_code: 'ENABLE_AFTER_SALE_POLICY_ENFORCEMENT',
        enabled: true,
        expected_version: ready.body.version,
        reason: 'Enable enforcement only after the authority reports a ready policy projection.',
      });
    expect(enabled.status).toBe(200);
    expect(enabled.body.enforce_policy_snapshots).toBe(true);

    const publishBody = {
      confirmation_code: 'PUBLISH_AFTER_SALE_POLICY',
      expected_version: 4,
      reason: 'Publish a safe ready policy while enforcement remains enabled.',
    };
    const published = await api()
      .post(path().replace('?', '/publish?'))
      .set(
        headers('operator', 'a', {
          'Idempotency-Key': secondPublishKey,
          'X-Correlation-Id': correlations.secondPublish,
        }),
      )
      .send(publishBody);
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({ code: primaryCode, version_number: 2 });
    expect(published.body.content.request_window_days).toBe(45);
    expectPrivateResponse(published, correlations.secondPublish);

    const synchronized = await owner.storeAfterSaleSetting.findUniqueOrThrow({
      where: { storeId: store.a.id },
    });
    const currentPolicy = await owner.afterSalePolicy.findUniqueOrThrow({
      where: { storeId_code: { code: primaryCode, storeId: store.a.id } },
    });
    expect(synchronized).toMatchObject({
      currentVersionId: currentPolicy.currentVersionId,
      defaultPolicyId: currentPolicy.id,
      enforcePolicySnapshots: true,
      readinessCheckedBy: admins.operator.id,
    });
    expect(synchronized.readinessHash).toMatch(/^[a-f0-9]{64}$/u);

    const dangerousCorrelation = `m63b2-dangerous-disable-${suffix}`;
    const dangerous = await api()
      .post(path().replace('?', '/disable?'))
      .set(
        headers('disabler', 'a', {
          'Idempotency-Key': `m63b2-dangerous-${suffix}-0001`,
          'X-Correlation-Id': dangerousCorrelation,
        }),
      )
      .send({
        confirmation_code: 'DISABLE_AFTER_SALE_POLICY',
        expected_version: 5,
        reason: 'This default policy cannot be disabled while enforcement depends on it.',
      });
    expect(dangerous.status).toBe(409);
    expect(dangerous.body.details).toEqual({ reason_code: 'AFTER_SALE_POLICY_NOT_READY' });
    expectPrivateResponse(dangerous, dangerousCorrelation);
    const rolledBack = await owner.afterSalePolicy.findUniqueOrThrow({
      include: { activeAssignments: true, versions: true },
      where: { storeId_code: { code: primaryCode, storeId: store.a.id } },
    });
    expect(rolledBack).toMatchObject({ status: 'ACTIVE', version: 5 });
    expect(rolledBack.activeAssignments.length).toBeGreaterThan(0);
    expect(rolledBack.versions).toHaveLength(2);
    expect(
      await owner.idempotencyRecord.count({
        where: { operation: 'after-sale.policy.disable', storeId: store.a.id },
      }),
    ).toBe(0);

    const beforeDisableEnforcement = await api().get(settingsPath).set(headers('operator'));
    const disabledEnforcement = await api()
      .put(settingsPath)
      .set({
        ...headers('operator'),
        'Idempotency-Key': `m63b2-enforce-off-${suffix}-0001`,
      })
      .send({
        confirmation_code: 'DISABLE_AFTER_SALE_POLICY_ENFORCEMENT',
        enabled: false,
        expected_version: beforeDisableEnforcement.body.version,
        reason: 'Disable enforcement before intentionally removing the active default projection.',
      });
    expect(disabledEnforcement.status).toBe(200);
    expect(disabledEnforcement.body.enforce_policy_snapshots).toBe(false);

    const disableBody = {
      confirmation_code: 'DISABLE_AFTER_SALE_POLICY',
      expected_version: 5,
      reason: 'Disable the policy after enforcement has been safely switched off.',
    };
    const disabled = await api()
      .post(path().replace('?', '/disable?'))
      .set(
        headers('disabler', 'a', {
          'Idempotency-Key': disableKey,
          'X-Correlation-Id': correlations.disable,
        }),
      )
      .send(disableBody);
    expect(disabled.status).toBe(200);
    expect(disabled.headers['idempotency-replayed']).toBe('false');
    expect(disabled.body).toEqual({
      code: primaryCode,
      current_version_number: 2,
      status: 'DISABLED',
      version: 6,
    });
    expectPrivateResponse(disabled, correlations.disable);

    const replayed = await api()
      .post(path().replace('?', '/disable?'))
      .set({ ...headers('disabler'), 'Idempotency-Key': disableKey })
      .send(disableBody);
    expect(replayed.status).toBe(200);
    expect(replayed.headers['idempotency-replayed']).toBe('true');
    expect(replayed.body).toEqual(disabled.body);
    const changedReplay = await api()
      .post(path().replace('?', '/disable?'))
      .set({ ...headers('disabler'), 'Idempotency-Key': disableKey })
      .send({ ...disableBody, reason: 'A changed disable reason must conflict for the same key.' });
    expect(changedReplay.status).toBe(409);
    expect(changedReplay.body.details).toEqual({
      reason_code: 'AFTER_SALE_POLICY_IDEMPOTENCY_CONFLICT',
    });

    const history = await owner.afterSalePolicy.findUniqueOrThrow({
      include: { activeAssignments: true, versions: true },
      where: { storeId_code: { code: primaryCode, storeId: store.a.id } },
    });
    expect(history).toMatchObject({ status: 'DISABLED', version: 6 });
    expect(history.activeAssignments).toHaveLength(0);
    expect(history.versions.map(({ versionNumber }) => versionNumber).sort()).toEqual([1, 2]);
  });

  it('binds policy and version cursors to resource, policy, filters, store and subject', async () => {
    const policyPage = await api()
      .get(`/v1/admin/after-sale-policies?store_id=${store.a.id}&limit=1`)
      .set(headers('reader'));
    expect(policyPage.status).toBe(200);
    expect(policyPage.body.items).toHaveLength(1);
    expect(policyPage.body.next_cursor).toMatch(/^c1_/u);
    expectPrivateResponse(policyPage);
    const policyCursor = policyPage.body.next_cursor as string;

    const changedFilter = await api()
      .get(
        `/v1/admin/after-sale-policies?store_id=${store.a.id}&limit=1&status=DISABLED&cursor=${policyCursor}`,
      )
      .set(headers('reader'));
    expect(changedFilter.status).toBe(400);
    const crossResource = await api()
      .get(`${versionsPath()}&limit=1&cursor=${policyCursor}`)
      .set(headers('reader'));
    expect(crossResource.status).toBe(400);
    const crossSubject = await api()
      .get(`/v1/admin/after-sale-policies?store_id=${store.a.id}&limit=1&cursor=${policyCursor}`)
      .set(headers('operator'));
    expect(crossSubject.status).toBe(400);
    const crossStore = await api()
      .get(`/v1/admin/after-sale-policies?store_id=${store.b.id}&limit=1&cursor=${policyCursor}`)
      .set(headers('operator', 'b'));
    expect(crossStore.status).toBe(400);

    const versionPage = await api().get(`${versionsPath()}&limit=1`).set(headers('reader'));
    expect(versionPage.status).toBe(200);
    expect(versionPage.body.items).toHaveLength(1);
    expect(versionPage.body.items[0].version_number).toBe(2);
    expect(versionPage.body.next_cursor).toMatch(/^c1_/u);
    const versionCursor = versionPage.body.next_cursor as string;
    const nextVersionPage = await api()
      .get(`${versionsPath()}&limit=1&cursor=${versionCursor}`)
      .set(headers('reader'));
    expect(nextVersionPage.status).toBe(200);
    expect(
      nextVersionPage.body.items.map(
        ({ version_number }: { version_number: number }) => version_number,
      ),
    ).toEqual([1]);
    expect(nextVersionPage.body.next_cursor).toBeNull();

    const crossPolicy = await api()
      .get(`${versionsPath(contenderCode)}&limit=1&cursor=${versionCursor}`)
      .set(headers('reader'));
    expect(crossPolicy.status).toBe(400);
    const tampered = `${versionCursor.slice(0, -1)}${versionCursor.endsWith('A') ? 'B' : 'A'}`;
    const tamperedResponse = await api()
      .get(`${versionsPath()}&limit=1&cursor=${tampered}`)
      .set(headers('reader'));
    expect(tamperedResponse.status).toBe(400);

    for (const versionNumber of [1, 2]) {
      const detail = await api()
        .get(
          `/v1/admin/after-sale-policies/${primaryCode}/versions/${versionNumber}?store_id=${store.a.id}`,
        )
        .set(headers('reader'));
      expect(detail.status).toBe(200);
      expect(detail.body).toMatchObject({ code: primaryCode, version_number: versionNumber });
      expectPrivateResponse(detail);
    }
    const invalidVersion = await api()
      .get(`/v1/admin/after-sale-policies/${primaryCode}/versions/0?store_id=${store.a.id}`)
      .set(headers('reader'));
    expect(invalidVersion.status).toBe(400);
  });

  it('records complete before/after, reason, actor and correlation audit facts exactly once', async () => {
    const policy = await owner.afterSalePolicy.findUniqueOrThrow({
      where: { storeId_code: { code: primaryCode, storeId: store.a.id } },
    });
    const audits = await owner.auditLog.findMany({
      orderBy: { createdAt: 'asc' },
      where: { storeId: store.a.id, targetId: policy.id, targetType: 'after_sale_policy' },
    });
    expect(
      audits.filter(({ action }) => action === 'after-sale.policy.draft.created'),
    ).toHaveLength(1);
    expect(
      audits.filter(({ action }) => action === 'after-sale.policy.draft.updated'),
    ).toHaveLength(2);
    expect(audits.filter(({ action }) => action === 'after-sale.policy.published')).toHaveLength(2);
    expect(audits.filter(({ action }) => action === 'after-sale.policy.disabled')).toHaveLength(1);

    const created = audits.find(({ action }) => action === 'after-sale.policy.draft.created');
    expect(created).toMatchObject({
      actorId: admins.manager.id,
      actorType: 'ADMIN',
      beforeData: null,
      correlationId: correlations.create,
      reason: 'Prepare the initial B2a policy control-plane draft.',
      targetId: policy.id,
    });
    expect(created?.afterData).toMatchObject({ code: primaryCode, status: 'DRAFT', version: 1 });

    const firstPublish = audits.find(
      ({ action, correlationId }) =>
        action === 'after-sale.policy.published' && correlationId === correlations.firstPublish,
    );
    expect(firstPublish).toMatchObject({
      actorId: admins.publisher.id,
      reason: 'Publish the reviewed initial policy as an immutable version.',
    });
    expect(firstPublish?.beforeData).toMatchObject({
      policy: { code: primaryCode, status: 'DRAFT', version: 1 },
      settings: { enforce_policy_snapshots: false },
    });
    expect(firstPublish?.afterData).toMatchObject({
      policy: { code: primaryCode, status: 'ACTIVE', version: 2 },
      settings: {
        default_policy_id: policy.id,
        enforce_policy_snapshots: false,
        readiness_checked_by: admins.publisher.id,
        readiness_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        store_id: store.a.id,
        updated_by: admins.publisher.id,
      },
    });

    const secondPublish = audits.find(
      ({ action, correlationId }) =>
        action === 'after-sale.policy.published' && correlationId === correlations.secondPublish,
    );
    expect(secondPublish).toMatchObject({
      actorId: admins.operator.id,
      reason: 'Publish a safe ready policy while enforcement remains enabled.',
    });
    expect(secondPublish?.afterData).toMatchObject({
      policy: { current_version_number: 2, status: 'ACTIVE', version: 5 },
      settings: {
        enforce_policy_snapshots: true,
        readiness_checked_by: admins.operator.id,
        updated_by: admins.operator.id,
      },
    });

    const disabled = audits.find(({ action }) => action === 'after-sale.policy.disabled');
    expect(disabled).toMatchObject({
      actorId: admins.disabler.id,
      correlationId: correlations.disable,
      reason: 'Disable the policy after enforcement has been safely switched off.',
    });
    expect(disabled?.beforeData).toMatchObject({
      policy: { status: 'ACTIVE', version: 5 },
    });
    expect(disabled?.afterData).toMatchObject({
      policy: { status: 'DISABLED', version: 6 },
      settings: {
        enforce_policy_snapshots: false,
        readiness_checked_by: admins.disabler.id,
        updated_by: admins.disabler.id,
      },
    });
    const serialized = JSON.stringify(audits);
    expect(serialized).not.toContain(createKey);
    expect(serialized).not.toContain(firstPublishKey);
    expect(serialized).not.toContain(secondPublishKey);
    expect(serialized).not.toContain(disableKey);
  });

  it('serializes a concurrent key, republishes DISABLED and safely disables a non-default policy under enforcement', async () => {
    await limiterRedis.del(
      rateLimitKey('operator', 'a', 'read'),
      rateLimitKey('operator', 'a', 'read', 1),
      rateLimitKey('operator', 'a', 'write'),
      rateLimitKey('operator', 'a', 'write', 1),
    );
    const concurrentCode = `concurrent-${suffix}`;
    const concurrentKey = `m63b2-concurrent-${suffix}-0001`;
    const putConcurrentDraft = () =>
      api()
        .put(path(concurrentCode))
        .set({ ...headers('operator'), 'Idempotency-Key': concurrentKey })
        .send(policyDraft(0));
    const concurrentResponses = await Promise.all([putConcurrentDraft(), putConcurrentDraft()]);
    expect(concurrentResponses.map(({ status }) => status)).toEqual([200, 200]);
    expect(
      concurrentResponses.map(
        ({ headers: responseHeaders }) => responseHeaders['idempotency-replayed'],
      ),
    ).toEqual(expect.arrayContaining(['false', 'true']));
    expect(concurrentResponses[0]?.body).toEqual(concurrentResponses[1]?.body);
    const concurrentPolicy = await owner.afterSalePolicy.findUniqueOrThrow({
      where: { storeId_code: { code: concurrentCode, storeId: store.a.id } },
    });
    expect(
      await owner.auditLog.count({
        where: {
          action: 'after-sale.policy.draft.created',
          storeId: store.a.id,
          targetId: concurrentPolicy.id,
        },
      }),
    ).toBe(1);

    const republished = await api()
      .post(path().replace('?', '/publish?'))
      .set({
        ...headers('operator'),
        'Idempotency-Key': `m63b2-republish-${suffix}-0001`,
      })
      .send({
        confirmation_code: 'PUBLISH_AFTER_SALE_POLICY',
        expected_version: 6,
        reason: 'Republish the disabled policy as a new immutable version.',
      });
    expect(republished.status).toBe(200);
    expect(republished.body).toMatchObject({ code: primaryCode, version_number: 3 });
    expect(republished.body.effective_at).toBe(republished.body.published_at);
    expect(
      await owner.afterSalePolicy.findUniqueOrThrow({
        where: { storeId_code: { code: primaryCode, storeId: store.a.id } },
      }),
    ).toMatchObject({ status: 'ACTIVE', version: 7 });

    const settingsPath = `/v1/admin/after-sale-settings?store_id=${store.a.id}`;
    const ready = await api().get(settingsPath).set(headers('operator'));
    const enableKey = `m63b2-edge-enforce-${suffix}-0001`;
    const enabled = await api()
      .put(settingsPath)
      .set({ ...headers('operator'), 'Idempotency-Key': enableKey })
      .send({
        confirmation_code: 'ENABLE_AFTER_SALE_POLICY_ENFORCEMENT',
        enabled: true,
        expected_version: ready.body.version,
        reason: 'Enable enforcement before testing safe non-default policy removal.',
      });
    expect(enabled.status).toBe(200);
    expect(enabled.body.readiness_state).toBe('ENFORCED');

    const categoryCode = `category-only-${suffix}`;
    const categoryDraft = await api()
      .put(path(categoryCode))
      .set({
        ...headers('operator'),
        'Idempotency-Key': `m63b2-category-draft-${suffix}-0001`,
      })
      .send(
        policyDraft(0, {
          category_id: catalog.categoryAId,
          product_ids: [],
        }),
      );
    expect(categoryDraft.status).toBe(200);
    const categoryPublish = await api()
      .post(path(categoryCode).replace('?', '/publish?'))
      .set({
        ...headers('operator'),
        'Idempotency-Key': `m63b2-category-publish-${suffix}-0001`,
      })
      .send({
        confirmation_code: 'PUBLISH_AFTER_SALE_POLICY',
        expected_version: 1,
        reason: 'Publish a non-default category policy while enforcement remains ready.',
      });
    expect(categoryPublish.status).toBe(200);
    const categoryDisable = await api()
      .post(path(categoryCode).replace('?', '/disable?'))
      .set({
        ...headers('operator'),
        'Idempotency-Key': `m63b2-category-disable-${suffix}-0001`,
      })
      .send({
        confirmation_code: 'DISABLE_AFTER_SALE_POLICY',
        expected_version: 2,
        reason: 'Safely disable a non-default category policy under enforcement.',
      });
    expect(categoryDisable.status).toBe(200);
    expect(categoryDisable.body).toMatchObject({ status: 'DISABLED', version: 3 });
    const stillEnforced = await api().get(settingsPath).set(headers('operator'));
    expect(stillEnforced.body).toMatchObject({
      default_policy_code: primaryCode,
      enforce_policy_snapshots: true,
      readiness_state: 'ENFORCED',
    });

    await owner.idempotencyRecord.update({
      data: { expiresAt: new Date('2000-01-01T00:00:00.000Z') },
      where: {
        storeId_operation_idempotencyKey: {
          idempotencyKey: digest(JSON.stringify(enableKey)),
          operation: 'after-sale.policy.enforce',
          storeId: store.a.id,
        },
      },
    });
    const disabledWithExpiredKey = await api()
      .put(settingsPath)
      .set({ ...headers('operator'), 'Idempotency-Key': enableKey })
      .send({
        confirmation_code: 'DISABLE_AFTER_SALE_POLICY_ENFORCEMENT',
        enabled: false,
        expected_version: stillEnforced.body.version,
        reason: 'Reuse the expired key for a reviewed enforcement disable command.',
      });
    expect(disabledWithExpiredKey.status).toBe(200);
    expect(disabledWithExpiredKey.headers['idempotency-replayed']).toBe('false');
    expect(disabledWithExpiredKey.body.enforce_policy_snapshots).toBe(false);
  });

  it('allows the 30th admin write and rejects the 31st within 60 seconds before mutation', async () => {
    const writeKeys = [
      rateLimitKey('limiter', 'a', 'write'),
      rateLimitKey('limiter', 'a', 'write', 1),
    ];
    const readKeys = [
      rateLimitKey('limiter', 'a', 'read'),
      rateLimitKey('limiter', 'a', 'read', 1),
    ];
    await Promise.all([
      ...writeKeys.map((key) => limiterRedis.set(key, '29', 'EX', 61)),
      ...readKeys.map((key) => limiterRedis.set(key, '120', 'EX', 61)),
    ]);
    const code = `rate-limit-${suffix}`;
    const thirtieth = await api()
      .put(path(code))
      .set({
        ...headers('limiter'),
        'Idempotency-Key': `m63b2-rate-${suffix}-0001`,
        'X-Correlation-Id': `m63b2-rate-30-${suffix}`,
      })
      .send(policyDraft(0));
    expect(thirtieth.status).toBe(200);
    expect(thirtieth.body).toMatchObject({ code, status: 'DRAFT', version: 1 });
    expectPrivateResponse(thirtieth, `m63b2-rate-30-${suffix}`);

    await limiterRedis.del(...readKeys);
    const saturatedKeys = [
      rateLimitKey('limiter', 'a', 'write'),
      rateLimitKey('limiter', 'a', 'write', 1),
    ];
    await Promise.all(saturatedKeys.map((key) => limiterRedis.set(key, '30', 'EX', 61)));
    const readable = await api()
      .get(`/v1/admin/after-sale-policies?store_id=${store.a.id}`)
      .set(headers('limiter'));
    expect(readable.status).toBe(200);
    expectPrivateResponse(readable);

    const correlation = `m63b2-rate-31-${suffix}`;
    const thirtyFirst = await api()
      .put(path(code))
      .set({
        ...headers('limiter'),
        'Idempotency-Key': `m63b2-rate-${suffix}-0002`,
        'X-Correlation-Id': correlation,
      })
      .send(policyDraft(1, { request_window_days: 31 }));
    expect(thirtyFirst.status).toBe(429);
    expect(thirtyFirst.headers['retry-after']).toMatch(/^[1-9][0-9]?$/u);
    expect(thirtyFirst.body.code).toBe('RATE_LIMITED');
    expectPrivateResponse(thirtyFirst, correlation);
    expect(
      await owner.afterSalePolicy.findUniqueOrThrow({
        where: { storeId_code: { code, storeId: store.a.id } },
      }),
    ).toMatchObject({ version: 1 });
    expect(
      await owner.idempotencyRecord.count({
        where: { operation: 'after-sale.policy.draft.put', storeId: store.a.id },
      }),
    ).toBeGreaterThan(0);
    await limiterRedis.del(...new Set([...writeKeys, ...readKeys, ...saturatedKeys]));
  });

  it('fails closed with a safe 503 when the Redis write limiter is unavailable', async () => {
    const evalSpy = vi
      .spyOn(limiterRedis, 'eval')
      .mockRejectedValueOnce(new Error('PRIVATE_M63B2_REDIS_MARKER'));
    const code = `limiter-unavailable-${suffix}`;
    try {
      const correlation = `m63b2-limiter-unavailable-${suffix}`;
      const response = await api()
        .put(path(code))
        .set({
          ...headers('limiter'),
          'Idempotency-Key': `m63b2-unavailable-${suffix}-0001`,
          'X-Correlation-Id': correlation,
        })
        .send(policyDraft(0));
      expect(response.status).toBe(503);
      expect(response.headers['retry-after']).toBeUndefined();
      expect(response.body.code).toBe('UPSTREAM_UNAVAILABLE');
      expect(JSON.stringify(response.body)).not.toContain('PRIVATE_M63B2_REDIS_MARKER');
      expectPrivateResponse(response, correlation);
      expect(
        await owner.afterSalePolicy.count({
          where: { code, storeId: store.a.id },
        }),
      ).toBe(0);
    } finally {
      evalSpy.mockRestore();
    }
  });
});
