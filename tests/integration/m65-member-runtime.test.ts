import { createHmac, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { config as loadEnvironment } from 'dotenv';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { parseRuntimeConfig } from '@zalo-shop/config';
import { PrismaClient } from '@zalo-shop/database';
import { decryptSensitive } from '@zalo-shop/security';
import { signJwt } from '@zalo-shop/security';

const BEAUTY_STORE_ID = '10000000-0000-4000-8000-000000000001';
const BEAUTY_STORE_CODE = 'beauty-local';
const FASHION_STORE_ID = '10000000-0000-4000-8000-000000000002';
const FASHION_STORE_CODE = 'fashion-local';

describe.sequential('M6.5 member runtime API', () => {
  loadEnvironment({ path: '.env.test.example', quiet: true, override: true });
  const config = parseRuntimeConfig();
  const owner = new PrismaClient({ datasourceUrl: config.DATABASE_URL });
  const suffix = randomUUID().slice(0, 8);
  const fixture = {
    adminId: randomUUID(),
    fashionMemberId: randomUUID(),
    fashionSessionId: randomUUID(),
    memberId: randomUUID(),
    memberSessionId: randomUUID(),
    otherMemberId: randomUUID(),
    otherMemberSessionId: randomUUID(),
  } as const;
  const productIds = Array.from({ length: 101 }, () => randomUUID());
  const productCodes = productIds.map((_, index) => `m65-product-${index}-${suffix}`);
  const fashionProductId = randomUUID();
  let app: INestApplication;
  let memberToken: string;
  let otherMemberToken: string;
  let limiterRedis: { del(...keys: string[]): Promise<number> };

  const api = () => request(app.getHttpServer() as Server);
  const memberHeaders = (token = memberToken, storeCode = BEAUTY_STORE_CODE) => ({
    Authorization: `Bearer ${token}`,
    'X-Store-Code': storeCode,
  });

  function accessToken(input: { memberId: string; sessionId: string; storeId: string }): string {
    const now = Math.floor(Date.now() / 1_000);
    return signJwt(
      {
        actor_type: 'member',
        aud: config.AUTH_JWT_AUDIENCE,
        exp: now + 900,
        iat: now,
        iss: config.AUTH_JWT_ISSUER,
        jti: randomUUID(),
        session_id: input.sessionId,
        store_id: input.storeId,
        sub: input.memberId,
      },
      config.AUTH_JWT_SECRET,
    );
  }

  function rateLimitKey(
    memberId: string,
    storeId: string,
    scope: 'member-read' | 'member-write',
    windowOffset: number,
  ): string {
    const identity = createHmac('sha256', config.PII_HASH_KEY)
      .update(`subject:${memberId}`)
      .digest('hex');
    const window = Math.floor(Date.now() / 60_000) + windowOffset;
    return `${config.NODE_ENV}:${storeId}:${scope}-rate:${identity}:${window}`;
  }

  async function clearRateLimits(): Promise<void> {
    const identities = [
      [fixture.memberId, BEAUTY_STORE_ID],
      [fixture.otherMemberId, BEAUTY_STORE_ID],
      [fixture.fashionMemberId, FASHION_STORE_ID],
    ] as const;
    const keys = identities.flatMap(([memberId, storeId]) =>
      ([-1, 0, 1] as const).flatMap((offset) => [
        rateLimitKey(memberId, storeId, 'member-read', offset),
        rateLimitKey(memberId, storeId, 'member-write', offset),
      ]),
    );
    await limiterRedis?.del(...keys);
  }

  beforeAll(async () => {
    await owner.$connect();
    const [beautyBrand, beautyCategory, fashionBrand, fashionCategory] = await Promise.all([
      owner.brand.findFirst({ select: { id: true }, where: { storeId: BEAUTY_STORE_ID } }),
      owner.category.findFirst({ select: { id: true }, where: { storeId: BEAUTY_STORE_ID } }),
      owner.brand.findFirst({ select: { id: true }, where: { storeId: FASHION_STORE_ID } }),
      owner.category.findFirst({ select: { id: true }, where: { storeId: FASHION_STORE_ID } }),
    ]);
    if (!beautyBrand || !beautyCategory || !fashionBrand || !fashionCategory) {
      throw new Error('M6.5 integration fixtures require the seeded beauty and fashion catalogs');
    }

    const expiresAt = new Date(Date.now() + 60 * 60_000);
    await owner.member.createMany({
      data: [
        { id: fixture.memberId, preferredLocale: 'vi', storeId: BEAUTY_STORE_ID },
        { id: fixture.otherMemberId, preferredLocale: 'en', storeId: BEAUTY_STORE_ID },
        { id: fixture.fashionMemberId, preferredLocale: 'zh', storeId: FASHION_STORE_ID },
      ],
    });
    await owner.adminUser.create({
      data: {
        displayName: 'M6.5 integration administrator',
        email: `m65-admin-${suffix}@example.invalid`,
        emailNormalized: `m65-admin-${suffix}@example.invalid`,
        id: fixture.adminId,
        passwordHash: 'm65-fixture-not-a-login-hash',
      },
    });
    await owner.memberSession.createMany({
      data: [
        {
          expiresAt,
          id: fixture.memberSessionId,
          memberId: fixture.memberId,
          refreshTokenHash: `m65-member-${suffix}`,
          storeId: BEAUTY_STORE_ID,
          tokenFamilyId: randomUUID(),
        },
        {
          expiresAt,
          id: fixture.otherMemberSessionId,
          memberId: fixture.otherMemberId,
          refreshTokenHash: `m65-other-${suffix}`,
          storeId: BEAUTY_STORE_ID,
          tokenFamilyId: randomUUID(),
        },
        {
          expiresAt,
          id: fixture.fashionSessionId,
          memberId: fixture.fashionMemberId,
          refreshTokenHash: `m65-fashion-${suffix}`,
          storeId: FASHION_STORE_ID,
          tokenFamilyId: randomUUID(),
        },
      ],
    });
    await owner.product.createMany({
      data: productIds.map((id, index) => ({
        brandId: beautyBrand.id,
        code: productCodes[index]!,
        id,
        mainCategoryId: beautyCategory.id,
        publishedAt: new Date(Date.now() - index * 1_000),
        status: 'PUBLISHED' as const,
        storeId: BEAUTY_STORE_ID,
      })),
    });
    await owner.productLocalization.createMany({
      data: productIds.map((productId, index) => ({
        locale: 'vi' as const,
        name: `Sản phẩm thành viên ${index}`,
        productId,
        storeId: BEAUTY_STORE_ID,
      })),
    });
    await owner.product.create({
      data: {
        brandId: fashionBrand.id,
        code: productCodes[0]!,
        id: fashionProductId,
        mainCategoryId: fashionCategory.id,
        publishedAt: new Date(),
        status: 'PUBLISHED',
        storeId: FASHION_STORE_ID,
      },
    });
    await owner.productLocalization.create({
      data: {
        locale: 'vi',
        name: 'Sản phẩm thời trang tách biệt',
        productId: fashionProductId,
        storeId: FASHION_STORE_ID,
      },
    });

    memberToken = accessToken({
      memberId: fixture.memberId,
      sessionId: fixture.memberSessionId,
      storeId: BEAUTY_STORE_ID,
    });
    otherMemberToken = accessToken({
      memberId: fixture.otherMemberId,
      sessionId: fixture.otherMemberSessionId,
      storeId: BEAUTY_STORE_ID,
    });

    const [{ AppModule }, { ApiExceptionFilter }, { SearchRateLimiter }] = await Promise.all([
      import('../../apps/api/src/app.module'),
      import('../../apps/api/src/api-exception.filter'),
      import('../../apps/api/src/search/search-rate-limiter'),
    ]);
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    limiterRedis = (app.get(SearchRateLimiter) as unknown as { redis: typeof limiterRedis }).redis;
  });

  beforeEach(async () => clearRateLimits());

  afterAll(async () => {
    await clearRateLimits();
    await app?.close();
    await owner.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
      await transaction.idempotencyRecord.deleteMany({
        where: {
          memberId: {
            in: [fixture.memberId, fixture.otherMemberId, fixture.fashionMemberId],
          },
        },
      });
      await transaction.privacyRequestTransition.deleteMany({
        where: {
          memberId: {
            in: [fixture.memberId, fixture.otherMemberId, fixture.fashionMemberId],
          },
        },
      });
      await transaction.privacyRequest.deleteMany({
        where: {
          memberId: {
            in: [fixture.memberId, fixture.otherMemberId, fixture.fashionMemberId],
          },
        },
      });
      await transaction.memberFavorite.deleteMany({
        where: { memberId: { in: [fixture.memberId, fixture.otherMemberId] } },
      });
      await transaction.memberProductView.deleteMany({
        where: { memberId: { in: [fixture.memberId, fixture.otherMemberId] } },
      });
      await transaction.consent.deleteMany({
        where: {
          memberId: {
            in: [fixture.memberId, fixture.otherMemberId, fixture.fashionMemberId],
          },
        },
      });
      await transaction.memberSession.deleteMany({
        where: {
          id: {
            in: [fixture.memberSessionId, fixture.otherMemberSessionId, fixture.fashionSessionId],
          },
        },
      });
      await transaction.member.deleteMany({
        where: {
          id: { in: [fixture.memberId, fixture.otherMemberId, fixture.fashionMemberId] },
        },
      });
      await transaction.adminUser.delete({ where: { id: fixture.adminId } });
      await transaction.productLocalization.deleteMany({
        where: { productId: { in: [...productIds, fashionProductId] } },
      });
      await transaction.product.deleteMany({
        where: { id: { in: [...productIds, fashionProductId] } },
      });
      await transaction.$executeRaw`SET LOCAL session_replication_role = origin`;
    });
    await owner.$disconnect();
  });

  it('keeps favorites idempotent and isolates member and store projections', async () => {
    for (const productCode of productCodes.slice(0, 2)) {
      const first = await api().put(`/v1/members/me/favorites/${productCode}`).set(memberHeaders());
      expect(first.status, JSON.stringify(first.body)).toBe(204);
    }
    const replay = await api()
      .put(`/v1/members/me/favorites/${productCodes[0]}`)
      .set(memberHeaders());
    expect(replay.status).toBe(204);
    await expect(
      owner.memberFavorite.count({
        where: { memberId: fixture.memberId, storeId: BEAUTY_STORE_ID },
      }),
    ).resolves.toBe(2);

    const favorited = await api()
      .get(`/v1/members/me/favorites/${productCodes[0]}`)
      .set(memberHeaders());
    expect(favorited.status, JSON.stringify(favorited.body)).toBe(200);
    expect(favorited.body).toEqual({ favorited: true });
    const absent = await api()
      .get(`/v1/members/me/favorites/${productCodes[2]}`)
      .set(memberHeaders());
    expect(absent.status).toBe(200);
    expect(absent.body).toEqual({ favorited: false });
    const otherMemberStatus = await api()
      .get(`/v1/members/me/favorites/${productCodes[0]}`)
      .set(memberHeaders(otherMemberToken));
    expect(otherMemberStatus.status).toBe(200);
    expect(otherMemberStatus.body).toEqual({ favorited: false });

    await owner.product.update({ data: { enabled: false }, where: { id: productIds[1] } });
    const list = await api().get('/v1/members/me/favorites?locale=en').set(memberHeaders());
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.items).toHaveLength(2);
    expect(list.body.items).toContainEqual(
      expect.objectContaining({
        available: false,
        primary_media_url: null,
        product_code: productCodes[1],
      }),
    );
    expect(JSON.stringify(list.body)).not.toContain(productIds[1]);

    const other = await api()
      .get('/v1/members/me/favorites?locale=vi')
      .set(memberHeaders(otherMemberToken));
    expect(other.status).toBe(200);
    expect(other.body.items).toEqual([]);
    const crossStore = await api()
      .get('/v1/members/me/favorites?locale=vi')
      .set(memberHeaders(memberToken, FASHION_STORE_CODE));
    expect(crossStore.status).toBe(401);
  });

  it('bounds product history to 100 and rejects a cross-member cursor replay', async () => {
    const baseTime = Date.now() - 200_000;
    await owner.memberProductView.createMany({
      data: productIds.slice(0, 100).map((productId, index) => ({
        firstViewedAt: new Date(baseTime + index * 1_000),
        lastViewedAt: new Date(baseTime + index * 1_000),
        memberId: fixture.memberId,
        productId,
        storeId: BEAUTY_STORE_ID,
      })),
    });
    const touched = await api()
      .put(`/v1/members/me/product-history/${productCodes[100]}`)
      .set(memberHeaders())
      .send({});
    expect(touched.status, JSON.stringify(touched.body)).toBe(204);
    await expect(
      owner.memberProductView.count({
        where: { memberId: fixture.memberId, storeId: BEAUTY_STORE_ID },
      }),
    ).resolves.toBe(100);
    await expect(
      owner.memberProductView.findUnique({
        where: {
          storeId_memberId_productId: {
            memberId: fixture.memberId,
            productId: productIds[0]!,
            storeId: BEAUTY_STORE_ID,
          },
        },
      }),
    ).resolves.toBeNull();

    const page = await api()
      .get('/v1/members/me/product-history?locale=vi&limit=2')
      .set(memberHeaders());
    expect(page.status).toBe(200);
    expect(page.body.items).toHaveLength(2);
    expect(page.body.next_cursor).toMatch(/^c1_/u);
    const replay = await api()
      .get(
        `/v1/members/me/product-history?locale=vi&limit=2&cursor=${encodeURIComponent(page.body.next_cursor as string)}`,
      )
      .set(memberHeaders(otherMemberToken));
    expect(replay.status).toBe(400);
  });

  it('returns scoped commerce counts and only the latest append-only consent facts', async () => {
    const occurredAt = new Date(Date.now() - 10_000);
    await owner.consent.createMany({
      data: [
        {
          eventId: randomUUID(),
          evidence: { secret: 'must-not-leak' },
          memberId: fixture.memberId,
          occurredAt,
          policyVersion: 'privacy-v1',
          purpose: 'PRIVACY',
          source: 'MANUAL',
          status: 'GRANTED',
          storeId: BEAUTY_STORE_ID,
        },
        {
          eventId: randomUUID(),
          memberId: fixture.memberId,
          occurredAt: new Date(occurredAt.getTime() + 1_000),
          policyVersion: 'privacy-v2',
          purpose: 'PRIVACY',
          revokedAt: new Date(occurredAt.getTime() + 1_000),
          source: 'MANUAL',
          status: 'REVOKED',
          storeId: BEAUTY_STORE_ID,
        },
        {
          eventId: randomUUID(),
          memberId: fixture.memberId,
          occurredAt,
          policyVersion: 'terms-v1',
          purpose: 'TERMS',
          source: 'ZALO',
          status: 'GRANTED',
          storeId: BEAUTY_STORE_ID,
        },
        {
          eventId: randomUUID(),
          memberId: fixture.otherMemberId,
          occurredAt: new Date(),
          policyVersion: 'privacy-other',
          purpose: 'PRIVACY',
          source: 'MANUAL',
          status: 'DENIED',
          storeId: BEAUTY_STORE_ID,
        },
      ],
    });

    const summary = await api().get('/v1/members/me/commerce-summary').set(memberHeaders());
    expect(summary.status, JSON.stringify(summary.body)).toBe(200);
    expect(summary.body).toMatchObject({
      address_count: 0,
      favorite_count: 2,
      product_history_count: 100,
      usable_coupon_count: 0,
    });
    const consents = await api().get('/v1/members/me/consents').set(memberHeaders());
    expect(consents.status, JSON.stringify(consents.body)).toBe(200);
    expect(consents.body.items).toEqual([
      expect.objectContaining({
        policy_version: 'privacy-v2',
        purpose: 'PRIVACY',
        status: 'REVOKED',
      }),
      expect.objectContaining({
        policy_version: 'terms-v1',
        purpose: 'TERMS',
        status: 'GRANTED',
      }),
    ]);
    expect(JSON.stringify(consents.body)).not.toMatch(/event_id|evidence|member_id|must-not-leak/u);
  });

  it('encrypts privacy intake and enforces create replay and member IDOR boundaries', async () => {
    const description = 'Please provide a copy of the personal data held for my account.';
    const idempotencyKey = `m65-privacy-create-${suffix}`;
    const body = {
      confirmation_code: 'SUBMIT_DATA_ACCESS_REQUEST',
      description,
      request_type: 'ACCESS',
    };
    const first = await api()
      .post('/v1/members/me/privacy-requests')
      .set({ ...memberHeaders(), 'Idempotency-Key': idempotencyKey })
      .send(body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({
      description,
      request_type: 'ACCESS',
      status: 'SUBMITTED',
      version: 1,
    });
    expect(first.body).not.toHaveProperty('id');

    const replay = await api()
      .post('/v1/members/me/privacy-requests')
      .set({ ...memberHeaders(), 'Idempotency-Key': idempotencyKey })
      .send(body);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    const conflict = await api()
      .post('/v1/members/me/privacy-requests')
      .set({ ...memberHeaders(), 'Idempotency-Key': idempotencyKey })
      .send({ ...body, description: `${description} Updated.` });
    expect(conflict.status).toBe(409);

    const stored = await owner.privacyRequest.findFirstOrThrow({
      where: { memberId: fixture.memberId, publicNumber: first.body.public_number },
    });
    expect(stored.descriptionCiphertext).not.toContain(description);
    expect(decryptSensitive(stored.descriptionCiphertext, config.PII_ENCRYPTION_KEY)).toBe(
      description,
    );
    const otherMemberRead = await api()
      .get(`/v1/members/me/privacy-requests/${first.body.public_number}`)
      .set(memberHeaders(otherMemberToken));
    expect(otherMemberRead.status).toBe(404);
  });

  it('cancels through an append-only transition with replay, version and state guards', async () => {
    const create = async (key: string) =>
      api()
        .post('/v1/members/me/privacy-requests')
        .set({ ...memberHeaders(), 'Idempotency-Key': key })
        .send({
          confirmation_code: 'SUBMIT_DATA_CORRECTION_REQUEST',
          description: 'Please correct the outdated profile information on this account.',
          request_type: 'CORRECTION',
        });
    const created = await create(`m65-cancel-create-${suffix}`);
    expect(created.status).toBe(201);
    const requestNumber = created.body.public_number as string;

    const wrongVersion = await api()
      .post(`/v1/members/me/privacy-requests/${requestNumber}/cancel`)
      .set({ ...memberHeaders(), 'Idempotency-Key': `m65-cancel-version-${suffix}` })
      .send({
        confirmation_code: 'CANCEL_PRIVACY_REQUEST',
        expected_version: 2,
        reason: 'I no longer want to continue with this privacy request.',
      });
    expect(wrongVersion.status).toBe(409);

    const cancelKey = `m65-cancel-replay-${suffix}`;
    const cancelBody = {
      confirmation_code: 'CANCEL_PRIVACY_REQUEST',
      expected_version: 1,
      reason: 'I no longer want to continue with this privacy request.',
    };
    const cancelled = await api()
      .post(`/v1/members/me/privacy-requests/${requestNumber}/cancel`)
      .set({ ...memberHeaders(), 'Idempotency-Key': cancelKey })
      .send(cancelBody);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body).toMatchObject({
      public_number: requestNumber,
      status: 'CANCELLED',
      version: 2,
    });
    expect(cancelled.body).not.toHaveProperty('id');
    const replay = await api()
      .post(`/v1/members/me/privacy-requests/${requestNumber}/cancel`)
      .set({ ...memberHeaders(), 'Idempotency-Key': cancelKey })
      .send(cancelBody);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(cancelled.body);
    await expect(
      owner.privacyRequestTransition.findMany({
        select: { reason: true },
        where: { event: 'CANCEL', privacyRequest: { publicNumber: requestNumber } },
      }),
    ).resolves.toEqual([{ reason: 'MEMBER_CANCELLED_BEFORE_FULFILLMENT' }]);

    const keyConflict = await api()
      .post(`/v1/members/me/privacy-requests/${requestNumber}/cancel`)
      .set({ ...memberHeaders(), 'Idempotency-Key': cancelKey })
      .send({ ...cancelBody, reason: `${cancelBody.reason} Changed.` });
    expect(keyConflict.status).toBe(409);

    const reviewRequest = await create(`m65-state-create-${suffix}`);
    expect(reviewRequest.status).toBe(201);
    const stored = await owner.privacyRequest.findFirstOrThrow({
      where: { publicNumber: reviewRequest.body.public_number },
    });
    await owner.$transaction(async (transaction) => {
      await transaction.$executeRaw`
        SELECT
          set_config('app.store_id', ${BEAUTY_STORE_ID}, true),
          set_config('app.actor_id', ${fixture.adminId}, true),
          set_config('app.actor_type', 'admin', true),
          set_config('app.correlation_id', ${`m65-review-${suffix}`}, true)
      `;
      await transaction.privacyRequestTransition.create({
        data: {
          actorId: fixture.adminId,
          actorType: 'ADMIN',
          correlationId: `m65-review-${suffix}`,
          event: 'START_REVIEW',
          fromStatus: 'SUBMITTED',
          memberId: fixture.memberId,
          privacyRequestId: stored.id,
          reason: 'Local integration fixture review transition',
          storeId: BEAUTY_STORE_ID,
          toStatus: 'UNDER_REVIEW',
        },
      });
    });
    const stateConflict = await api()
      .post(`/v1/members/me/privacy-requests/${stored.publicNumber}/cancel`)
      .set({ ...memberHeaders(), 'Idempotency-Key': `m65-state-cancel-${suffix}` })
      .send({ ...cancelBody, expected_version: 2 });
    expect(stateConflict.status).toBe(409);
  });

  it('enforces the member write rate limit', async () => {
    const statuses: number[] = [];
    for (let index = 0; index < 11; index += 1) {
      const response = await api()
        .delete(`/v1/members/me/favorites/m65-missing-${index}-${suffix}`)
        .set(memberHeaders());
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => 204));
    expect(statuses[10]).toBe(429);
  });
});
