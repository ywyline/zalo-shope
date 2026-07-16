import { randomUUID } from 'node:crypto';

import { config as loadEnvironment } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseRuntimeConfig } from '@zalo-shop/config';
import { createRuntimePrismaClient, PrismaClient } from '@zalo-shop/database';
import { createZaloTestToken, DeterministicZaloTestProvider } from '@zalo-shop/integrations';
import {
  decryptSensitive,
  encryptSensitive,
  generateTotp,
  hashPassword,
} from '@zalo-shop/security';

import { AuthService } from '../../apps/api/src/auth/auth.service';

const BEAUTY_STORE_ID = '10000000-0000-4000-8000-000000000001';
const MINI_APP_ID = 'test-beauty-mini-app';
const PARENT_APP_ID = 'test-parent-app';
const TOTP_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('M1 authentication integration', () => {
  loadEnvironment({ path: '.env.test.example', quiet: true, override: true });
  const config = parseRuntimeConfig();
  const owner = new PrismaClient({ datasourceUrl: config.DATABASE_URL });
  const runtime = createRuntimePrismaClient(config.DATABASE_RUNTIME_URL);
  const providerOptions = {
    audience: 'zalo-shop-test-provider',
    issuer: 'zalo-shop-test-provider',
    secret: config.ZALO_TEST_TOKEN_SECRET!,
  };
  const provider = new DeterministicZaloTestProvider(providerOptions);
  const service = new AuthService(runtime, config, provider);
  const subjectId = `zalo-test-${randomUUID()}`;
  const adminEmail = `admin-${randomUUID()}@example.test`;
  let memberId: string | undefined;
  let zaloAccessToken: string | undefined;
  let adminId: string | undefined;

  beforeAll(async () => {
    await owner.$connect();
    await runtime.$connect();
    await owner.storeZaloApp.update({
      data: {
        enabled: true,
        miniAppId: MINI_APP_ID,
        parentAppId: PARENT_APP_ID,
      },
      where: { storeId_environment: { environment: 'TEST', storeId: BEAUTY_STORE_ID } },
    });
  });

  afterAll(async () => {
    if (memberId) {
      await owner.memberSession.deleteMany({ where: { memberId } });
      await owner.consent.deleteMany({ where: { memberId } });
      await owner.memberPhoneContact.deleteMany({ where: { memberId } });
      await owner.memberExternalIdentity.deleteMany({ where: { memberId } });
      await owner.member.deleteMany({ where: { id: memberId } });
    }
    if (adminId) {
      await owner.adminSession.deleteMany({ where: { adminUserId: adminId } });
      await owner.adminUser.delete({ where: { id: adminId } });
    }
    await owner.storeZaloApp.update({
      data: { enabled: false, miniAppId: null, parentAppId: null },
      where: { storeId_environment: { environment: 'TEST', storeId: BEAUTY_STORE_ID } },
    });
    await runtime.$disconnect();
    await owner.$disconnect();
  });

  it('exchanges a store-bound Zalo token and rotates refresh credentials', async () => {
    const accessToken = createZaloTestToken(
      {
        kind: 'zalo_access',
        miniAppId: MINI_APP_ID,
        parentAppId: PARENT_APP_ID,
        subjectId,
      },
      providerOptions,
    );
    zaloAccessToken = accessToken;
    const exchanged = await service.exchangeZalo({
      accessToken,
      storeCode: 'beauty-local',
    });
    memberId = exchanged.member.id;
    expect(service.verifyAccessToken(exchanged.access_token)).toMatchObject({
      actorType: 'member',
      storeId: BEAUTY_STORE_ID,
      subjectId: memberId,
    });

    const storedSession = await owner.memberSession.findFirstOrThrow({ where: { memberId } });
    expect(storedSession.refreshTokenHash).not.toContain(exchanged.refresh_token);
    expect(JSON.stringify(storedSession)).not.toContain(accessToken);

    const rotated = await service.refreshMember({
      refreshToken: exchanged.refresh_token,
      storeCode: 'beauty-local',
    });
    expect(rotated.refresh_token).not.toBe(exchanged.refresh_token);
    await expect(
      service.refreshMember({
        refreshToken: exchanged.refresh_token,
        storeCode: 'beauty-local',
      }),
    ).rejects.toThrow('invalid');
  });

  it('rejects a validly signed token for another Mini App', async () => {
    const accessToken = createZaloTestToken(
      {
        kind: 'zalo_access',
        miniAppId: 'test-fashion-mini-app',
        parentAppId: PARENT_APP_ID,
        subjectId,
      },
      providerOptions,
    );
    await expect(
      service.exchangeZalo({ accessToken, storeCode: 'beauty-local' }),
    ).rejects.toThrow();
  });

  it('stores manually supplied phone data encrypted with explicit consent', async () => {
    if (!memberId) throw new Error('member fixture missing');
    const consentEventId = randomUUID();
    const result = await service.saveManualPhone({
      consentEventId,
      memberId,
      phone: '0912 345 678',
      policyVersion: 'phone-v1',
      storeCode: 'beauty-local',
      storeId: BEAUTY_STORE_ID,
    });
    expect(result.masked_phone).toBe('+849••••678');
    const contact = await owner.memberPhoneContact.findUniqueOrThrow({
      where: { storeId_memberId: { memberId, storeId: BEAUTY_STORE_ID } },
    });
    expect(contact.phoneCiphertext).not.toContain('+84912345678');
    expect(decryptSensitive(contact.phoneCiphertext, config.PII_ENCRYPTION_KEY)).toBe(
      '+84912345678',
    );
    await expect(owner.consent.count({ where: { memberId, purpose: 'PHONE' } })).resolves.toBe(1);
    await expect(
      service.saveManualPhone({
        consentEventId,
        memberId,
        phone: '0912 345 678',
        policyVersion: 'phone-v1',
        storeCode: 'beauty-local',
        storeId: BEAUTY_STORE_ID,
      }),
    ).resolves.toEqual(result);
    await expect(
      service.saveManualPhone({
        consentEventId,
        memberId,
        phone: '0987 654 321',
        policyVersion: 'phone-v1',
        storeCode: 'beauty-local',
        storeId: BEAUTY_STORE_ID,
      }),
    ).rejects.toThrow('conflict');
    await expect(owner.consent.count({ where: { eventId: consentEventId } })).resolves.toBe(1);
  });

  it('reads member data, updates locale and records consent idempotently', async () => {
    if (!memberId) throw new Error('member fixture missing');
    const memberContext = {
      memberId,
      storeCode: 'beauty-local',
      storeId: BEAUTY_STORE_ID,
    };
    await expect(service.getMemberProfile(memberContext)).resolves.toMatchObject({
      has_phone: true,
      id: memberId,
      preferred_locale: 'vi',
    });
    await expect(
      service.updateMemberPreference({ ...memberContext, locale: 'zh' }),
    ).resolves.toEqual({ id: memberId, preferred_locale: 'zh' });

    const consent = {
      ...memberContext,
      eventId: randomUUID(),
      policyVersion: 'privacy-v1',
      purpose: 'PRIVACY' as const,
      source: 'MANUAL' as const,
      status: 'GRANTED' as const,
    };
    const first = await service.recordConsent(consent);
    const repeated = await service.recordConsent(consent);
    expect(repeated.id).toBe(first.id);
    await expect(service.recordConsent({ ...consent, status: 'REVOKED' })).rejects.toThrow(
      'conflict',
    );
    await expect(
      owner.consent.count({ where: { eventId: consent.eventId, memberId } }),
    ).resolves.toBe(1);
  });

  it('binds a one-time Zalo phone token to the authenticated member identity', async () => {
    if (!memberId || !zaloAccessToken) throw new Error('member fixture missing');
    const phoneToken = createZaloTestToken(
      {
        kind: 'zalo_phone',
        miniAppId: MINI_APP_ID,
        parentAppId: PARENT_APP_ID,
        phone: '+84987654321',
        subjectId,
      },
      providerOptions,
    );
    await expect(
      service.saveZaloPhone({
        accessToken: zaloAccessToken,
        consentEventId: randomUUID(),
        memberId,
        phoneToken,
        policyVersion: 'phone-v1',
        storeCode: 'beauty-local',
        storeId: BEAUTY_STORE_ID,
      }),
    ).resolves.toEqual({ masked_phone: '+849••••321' });
    await expect(
      service.saveZaloPhone({
        accessToken: zaloAccessToken,
        consentEventId: randomUUID(),
        memberId,
        phoneToken,
        policyVersion: 'phone-v1',
        storeCode: 'beauty-local',
        storeId: BEAUTY_STORE_ID,
      }),
    ).rejects.toThrow('already consumed');
    await expect(
      owner.memberPhoneContact.findUniqueOrThrow({
        where: { storeId_memberId: { memberId, storeId: BEAUTY_STORE_ID } },
      }),
    ).resolves.toMatchObject({ source: 'ZALO', verifiedAt: expect.any(Date) });
  });

  it('requires password plus TOTP for an administrator session', async () => {
    const password = 'correct horse battery staple';
    const admin = await owner.adminUser.create({
      data: {
        displayName: 'M1 Test Admin',
        email: adminEmail,
        emailNormalized: adminEmail,
        mfaEnabled: true,
        mfaSecretCiphertext: encryptSensitive(TOTP_SECRET, config.PII_ENCRYPTION_KEY),
        passwordHash: await hashPassword(password),
      },
    });
    adminId = admin.id;
    const challenge = await service.authenticateAdminPassword({ email: adminEmail, password });
    const session = await service.verifyAdminMfa({
      challengeToken: challenge.challenge_token,
      token: generateTotp(TOTP_SECRET),
    });
    expect(service.verifyAccessToken(session.access_token)).toMatchObject({
      actorType: 'admin',
      subjectId: admin.id,
    });
    await expect(
      service.authenticateAdminPassword({
        email: adminEmail,
        password: 'incorrect password value',
      }),
    ).rejects.toThrow('Authentication failed');
  });
});
