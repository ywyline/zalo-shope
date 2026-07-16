import { randomUUID } from 'node:crypto';

import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { RuntimeConfig } from '@zalo-shop/config';
import type { PrismaClient } from '@zalo-shop/database';
import { withStoreTransaction } from '@zalo-shop/database';
import { createStoreContext } from '@zalo-shop/domain';
import { normalizeVietnamPhone } from '@zalo-shop/i18n';
import type { ZaloIdentityProvider } from '@zalo-shop/integrations';
import {
  createOpaqueToken,
  decryptSensitive,
  encryptSensitive,
  hashSensitive,
  signJwt,
  verifyJwt,
  verifyPassword,
  verifyTotp,
} from '@zalo-shop/security';

import { RUNTIME_CONFIG } from '../health.controller';
import { DATABASE_CLIENT, ZALO_IDENTITY_PROVIDER } from './auth.tokens';

type ResolvedStore = { code: string; default_locale: 'en' | 'vi' | 'zh'; id: string };

export type AccessClaims = {
  actorType: 'admin' | 'member';
  sessionId: string;
  storeId?: string;
  subjectId: string;
};

type SessionResponse = {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  token_type: 'Bearer';
};

type ConsentResponse = {
  event_id: string;
  id: string;
  occurred_at: Date;
  policy_version: string;
  purpose: 'LOCATION' | 'PHONE' | 'PRIVACY' | 'PROFILE' | 'TERMS';
  source: 'MANUAL' | 'ZALO';
  status: 'DENIED' | 'GRANTED' | 'REVOKED';
};

@Injectable()
export class AuthService {
  public constructor(
    @Inject(DATABASE_CLIENT) private readonly database: PrismaClient,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
    @Inject(ZALO_IDENTITY_PROVIDER) private readonly zaloProvider: ZaloIdentityProvider,
  ) {}

  public async exchangeZalo(input: {
    accessToken: string;
    storeCode: string;
  }): Promise<SessionResponse & { member: { id: string; locale: string }; store: ResolvedStore }> {
    const store = await this.resolveStore(input.storeCode);
    const provisionalMemberId = randomUUID();
    const context = createStoreContext({
      actor: { id: provisionalMemberId, type: 'member' },
      correlationId: randomUUID(),
      locale: store.default_locale,
      storeCode: store.code,
      storeId: store.id,
    });
    const zaloConfig = await withStoreTransaction(this.database, context, (transaction) =>
      transaction.storeZaloApp.findUnique({
        where: { storeId_environment: { environment: 'TEST', storeId: store.id } },
      }),
    );
    if (!zaloConfig?.enabled || !zaloConfig.miniAppId || !zaloConfig.parentAppId) {
      throw new UnauthorizedException('Zalo identity is not configured for this store');
    }
    const identity = await this.zaloProvider.verifyAccessToken({
      accessToken: input.accessToken,
      expectedMiniAppId: zaloConfig.miniAppId,
    });
    if (identity.parentAppId !== zaloConfig.parentAppId) {
      throw new UnauthorizedException('Zalo identity does not belong to this store');
    }

    const refreshToken = createOpaqueToken();
    const session = await withStoreTransaction(this.database, context, async (transaction) => {
      const existingIdentity = await transaction.memberExternalIdentity.findUnique({
        where: {
          storeId_provider_providerAppId_providerSubjectId: {
            provider: 'ZALO',
            providerAppId: identity.parentAppId,
            providerSubjectId: identity.subjectId,
            storeId: store.id,
          },
        },
      });
      const member = existingIdentity
        ? await transaction.member.update({
            data: {
              avatarUrl: identity.avatarUrl,
              displayName: identity.displayName,
              lastSeenAt: new Date(),
            },
            where: { id: existingIdentity.memberId },
          })
        : await transaction.member.create({
            data: {
              avatarUrl: identity.avatarUrl,
              displayName: identity.displayName,
              id: provisionalMemberId,
              identities: {
                create: {
                  provider: 'ZALO',
                  providerAppId: identity.parentAppId,
                  providerSubjectId: identity.subjectId,
                },
              },
              lastSeenAt: new Date(),
              preferredLocale: store.default_locale,
              storeId: store.id,
            },
          });
      const expiresAt = new Date(Date.now() + this.config.AUTH_REFRESH_TTL_SECONDS * 1_000);
      const createdSession = await transaction.memberSession.create({
        data: {
          expiresAt,
          memberId: member.id,
          refreshTokenHash: hashSensitive(refreshToken, this.config.PII_HASH_KEY),
          storeId: store.id,
          tokenFamilyId: randomUUID(),
          zaloTokenExpiresAt: identity.expiresAt,
        },
      });
      return { member, session: createdSession };
    });

    return {
      ...this.createSessionResponse({
        actorType: 'member',
        refreshToken,
        sessionId: session.session.id,
        storeId: store.id,
        subjectId: session.member.id,
      }),
      member: { id: session.member.id, locale: session.member.preferredLocale },
      store,
    };
  }

  public async refreshMember(input: {
    refreshToken: string;
    storeCode: string;
  }): Promise<SessionResponse> {
    const store = await this.resolveStore(input.storeCode);
    const provisionalActorId = randomUUID();
    const context = createStoreContext({
      actor: { id: provisionalActorId, type: 'member' },
      correlationId: randomUUID(),
      locale: store.default_locale,
      storeCode: store.code,
      storeId: store.id,
    });
    const tokenHash = hashSensitive(input.refreshToken, this.config.PII_HASH_KEY);
    const newRefreshToken = createOpaqueToken();
    const session = await withStoreTransaction(this.database, context, async (transaction) => {
      const current = await transaction.memberSession.findUnique({
        where: { refreshTokenHash: tokenHash },
      });
      if (!current || current.revokedAt || current.expiresAt <= new Date()) {
        throw new UnauthorizedException('Refresh credential is invalid');
      }
      await transaction.memberSession.update({
        data: { revokedAt: new Date() },
        where: { id: current.id },
      });
      return transaction.memberSession.create({
        data: {
          expiresAt: new Date(Date.now() + this.config.AUTH_REFRESH_TTL_SECONDS * 1_000),
          memberId: current.memberId,
          refreshTokenHash: hashSensitive(newRefreshToken, this.config.PII_HASH_KEY),
          storeId: current.storeId,
          tokenFamilyId: current.tokenFamilyId,
          zaloTokenExpiresAt: current.zaloTokenExpiresAt,
        },
      });
    });
    return this.createSessionResponse({
      actorType: 'member',
      refreshToken: newRefreshToken,
      sessionId: session.id,
      storeId: store.id,
      subjectId: session.memberId,
    });
  }

  public async refreshAdmin(refreshToken: string): Promise<SessionResponse> {
    const tokenHash = hashSensitive(refreshToken, this.config.PII_HASH_KEY);
    const current = await this.database.adminSession.findUnique({
      where: { refreshTokenHash: tokenHash },
    });
    if (!current || current.revokedAt || current.expiresAt <= new Date()) {
      throw new UnauthorizedException('Refresh credential is invalid');
    }
    const newRefreshToken = createOpaqueToken();
    const session = await this.database.$transaction(async (transaction) => {
      await transaction.adminSession.update({
        data: { revokedAt: new Date() },
        where: { id: current.id },
      });
      return transaction.adminSession.create({
        data: {
          adminUserId: current.adminUserId,
          expiresAt: new Date(Date.now() + this.config.AUTH_REFRESH_TTL_SECONDS * 1_000),
          mfaVerifiedAt: current.mfaVerifiedAt,
          refreshTokenHash: hashSensitive(newRefreshToken, this.config.PII_HASH_KEY),
          tokenFamilyId: current.tokenFamilyId,
        },
      });
    });
    return this.createSessionResponse({
      actorType: 'admin',
      refreshToken: newRefreshToken,
      sessionId: session.id,
      subjectId: session.adminUserId,
    });
  }

  public async logout(input: { accessToken: string; storeCode?: string }): Promise<void> {
    const claims = this.verifyAccessToken(input.accessToken);
    if (claims.actorType === 'admin') {
      await this.database.adminSession.updateMany({
        data: { revokedAt: new Date() },
        where: { adminUserId: claims.subjectId, id: claims.sessionId, revokedAt: null },
      });
      return;
    }
    if (!claims.storeId || !input.storeCode) {
      throw new UnauthorizedException('Store context is invalid');
    }
    const store = await this.resolveStore(input.storeCode);
    if (store.id !== claims.storeId) throw new UnauthorizedException('Store context is invalid');
    const context = createStoreContext({
      actor: { id: claims.subjectId, type: 'member' },
      correlationId: randomUUID(),
      locale: store.default_locale,
      storeCode: store.code,
      storeId: store.id,
    });
    await withStoreTransaction(this.database, context, (transaction) =>
      transaction.memberSession.updateMany({
        data: { revokedAt: new Date() },
        where: { id: claims.sessionId, memberId: claims.subjectId, revokedAt: null },
      }),
    );
  }

  public async authenticateAdminPassword(input: {
    email: string;
    password: string;
  }): Promise<{ challenge_token: string; expires_in: number }> {
    const admin = await this.database.adminUser.findUnique({
      where: { emailNormalized: input.email.trim().toLowerCase() },
    });
    const valid = admin ? await verifyPassword(input.password, admin.passwordHash) : false;
    if (!admin || !valid || admin.status === 'DISABLED' || !admin.mfaEnabled) {
      if (admin) await this.recordAdminFailure(admin.id, admin.failedLoginCount);
      throw new UnauthorizedException('Authentication failed');
    }
    if (admin.lockedUntil && admin.lockedUntil > new Date()) {
      throw new UnauthorizedException('Authentication failed');
    }
    const now = Math.floor(Date.now() / 1_000);
    return {
      challenge_token: signJwt(
        {
          aud: this.config.AUTH_JWT_AUDIENCE,
          exp: now + 300,
          iat: now,
          iss: this.config.AUTH_JWT_ISSUER,
          jti: randomUUID(),
          purpose: 'admin_mfa',
          sub: admin.id,
        },
        this.config.AUTH_JWT_SECRET,
      ),
      expires_in: 300,
    };
  }

  public async verifyAdminMfa(input: {
    challengeToken: string;
    token: string;
  }): Promise<SessionResponse> {
    const challenge = verifyJwt(input.challengeToken, {
      audience: this.config.AUTH_JWT_AUDIENCE,
      issuer: this.config.AUTH_JWT_ISSUER,
      secret: this.config.AUTH_JWT_SECRET,
    });
    if (challenge.purpose !== 'admin_mfa') throw new UnauthorizedException('Authentication failed');
    const admin = await this.database.adminUser.findUnique({ where: { id: challenge.sub } });
    if (!admin?.mfaEnabled || !admin.mfaSecretCiphertext || admin.status !== 'ACTIVE') {
      throw new UnauthorizedException('Authentication failed');
    }
    const secret = decryptSensitive(admin.mfaSecretCiphertext, this.config.PII_ENCRYPTION_KEY);
    if (!verifyTotp(input.token, secret)) {
      await this.recordAdminFailure(admin.id, admin.failedLoginCount);
      throw new UnauthorizedException('Authentication failed');
    }
    const refreshToken = createOpaqueToken();
    const session = await this.database.adminSession.create({
      data: {
        adminUserId: admin.id,
        expiresAt: new Date(Date.now() + this.config.AUTH_REFRESH_TTL_SECONDS * 1_000),
        mfaVerifiedAt: new Date(),
        refreshTokenHash: hashSensitive(refreshToken, this.config.PII_HASH_KEY),
        tokenFamilyId: randomUUID(),
      },
    });
    await this.database.adminUser.update({
      data: { failedLoginCount: 0, lockedUntil: null },
      where: { id: admin.id },
    });
    return this.createSessionResponse({
      actorType: 'admin',
      refreshToken,
      sessionId: session.id,
      subjectId: admin.id,
    });
  }

  public verifyAccessToken(token: string): AccessClaims {
    const claims = verifyJwt(token, {
      audience: this.config.AUTH_JWT_AUDIENCE,
      issuer: this.config.AUTH_JWT_ISSUER,
      secret: this.config.AUTH_JWT_SECRET,
    });
    if (
      (claims.actor_type !== 'member' && claims.actor_type !== 'admin') ||
      typeof claims.session_id !== 'string'
    ) {
      throw new UnauthorizedException('Access token is invalid');
    }
    return {
      actorType: claims.actor_type,
      sessionId: claims.session_id,
      ...(typeof claims.store_id === 'string' ? { storeId: claims.store_id } : {}),
      subjectId: claims.sub,
    };
  }

  public async authenticateAccessToken(token: string, storeCode?: string): Promise<AccessClaims> {
    const claims = this.verifyAccessToken(token);
    if (claims.actorType === 'admin') {
      const session = await this.database.adminSession.findUnique({
        where: { id: claims.sessionId },
      });
      if (!session || session.adminUserId !== claims.subjectId || session.revokedAt) {
        throw new UnauthorizedException('Access session is invalid');
      }
      return claims;
    }
    if (!claims.storeId || !storeCode) throw new UnauthorizedException('Store context is invalid');
    const store = await this.resolveStore(storeCode);
    if (store.id !== claims.storeId) throw new UnauthorizedException('Store context is invalid');
    const context = createStoreContext({
      actor: { id: claims.subjectId, type: 'member' },
      correlationId: randomUUID(),
      locale: store.default_locale,
      storeCode: store.code,
      storeId: store.id,
    });
    const active = await withStoreTransaction(this.database, context, (transaction) =>
      transaction.memberSession.count({
        where: {
          expiresAt: { gt: new Date() },
          id: claims.sessionId,
          memberId: claims.subjectId,
          revokedAt: null,
        },
      }),
    );
    if (active !== 1) throw new UnauthorizedException('Access session is invalid');
    return claims;
  }

  public async getMemberProfile(input: { memberId: string; storeCode: string; storeId: string }) {
    const { context } = await this.resolveMemberContext(input);
    return withStoreTransaction(this.database, context, async (transaction) => {
      const member = await transaction.member.findUnique({
        select: {
          avatarUrl: true,
          createdAt: true,
          displayName: true,
          id: true,
          phoneContact: { select: { source: true, verifiedAt: true } },
          preferredLocale: true,
          status: true,
        },
        where: { id: input.memberId },
      });
      if (!member) throw new NotFoundException('Resource not found');
      return {
        avatar_url: member.avatarUrl,
        created_at: member.createdAt,
        display_name: member.displayName,
        has_phone: member.phoneContact !== null,
        id: member.id,
        phone_source: member.phoneContact?.source ?? null,
        phone_verified: member.phoneContact?.verifiedAt !== null && member.phoneContact !== null,
        preferred_locale: member.preferredLocale,
        status: member.status,
      };
    });
  }

  public async updateMemberPreference(input: {
    locale: 'en' | 'vi' | 'zh';
    memberId: string;
    storeCode: string;
    storeId: string;
  }) {
    const { context } = await this.resolveMemberContext(input);
    const member = await withStoreTransaction(this.database, context, (transaction) =>
      transaction.member.update({
        data: { preferredLocale: input.locale },
        select: { id: true, preferredLocale: true },
        where: { id: input.memberId },
      }),
    );
    return { id: member.id, preferred_locale: member.preferredLocale };
  }

  public async recordConsent(input: {
    eventId: string;
    memberId: string;
    policyVersion: string;
    purpose: 'LOCATION' | 'PHONE' | 'PRIVACY' | 'PROFILE' | 'TERMS';
    source: 'MANUAL' | 'ZALO';
    status: 'DENIED' | 'GRANTED' | 'REVOKED';
    storeCode: string;
    storeId: string;
  }): Promise<ConsentResponse> {
    const { context } = await this.resolveMemberContext(input);
    return withStoreTransaction(this.database, context, async (transaction) => {
      const existing = await transaction.consent.findUnique({
        where: { storeId_eventId: { eventId: input.eventId, storeId: input.storeId } },
      });
      if (existing) {
        const matches =
          existing.memberId === input.memberId &&
          existing.policyVersion === input.policyVersion &&
          existing.purpose === input.purpose &&
          existing.source === input.source &&
          existing.status === input.status;
        if (!matches) throw new ConflictException('Consent event conflict');
        return this.toConsentResponse(existing);
      }
      const created = await transaction.consent.create({
        data: {
          eventId: input.eventId,
          memberId: input.memberId,
          occurredAt: new Date(),
          policyVersion: input.policyVersion,
          purpose: input.purpose,
          revokedAt: input.status === 'REVOKED' ? new Date() : null,
          source: input.source,
          status: input.status,
          storeId: input.storeId,
        },
      });
      return this.toConsentResponse(created);
    });
  }

  public async saveManualPhone(input: {
    consentEventId: string;
    memberId: string;
    phone: string;
    policyVersion: string;
    storeCode: string;
    storeId: string;
  }): Promise<{ masked_phone: string }> {
    const store = await this.resolveStore(input.storeCode);
    if (store.id !== input.storeId) throw new UnauthorizedException('Store context is invalid');
    return this.persistPhone({
      consentEventId: input.consentEventId,
      memberId: input.memberId,
      phone: normalizeVietnamPhone(input.phone),
      policyVersion: input.policyVersion,
      source: 'MANUAL',
      store,
      verified: false,
    });
  }

  public async saveZaloPhone(input: {
    accessToken: string;
    consentEventId: string;
    memberId: string;
    phoneToken: string;
    policyVersion: string;
    storeCode: string;
    storeId: string;
  }): Promise<{ masked_phone: string }> {
    const store = await this.resolveStore(input.storeCode);
    if (store.id !== input.storeId) throw new UnauthorizedException('Store context is invalid');
    const context = createStoreContext({
      actor: { id: input.memberId, type: 'member' },
      correlationId: randomUUID(),
      locale: store.default_locale,
      storeCode: store.code,
      storeId: store.id,
    });
    const app = await withStoreTransaction(this.database, context, (transaction) =>
      transaction.storeZaloApp.findUnique({
        where: { storeId_environment: { environment: 'TEST', storeId: store.id } },
      }),
    );
    if (!app?.enabled || !app.miniAppId || !app.parentAppId) {
      throw new UnauthorizedException('Zalo identity is not configured for this store');
    }
    const miniAppId = app.miniAppId;
    const parentAppId = app.parentAppId;
    const identity = await this.zaloProvider.verifyAccessToken({
      accessToken: input.accessToken,
      expectedMiniAppId: miniAppId,
    });
    if (identity.parentAppId !== parentAppId) {
      throw new UnauthorizedException('Zalo identity does not belong to this store');
    }
    const ownsIdentity = await withStoreTransaction(this.database, context, (transaction) =>
      transaction.memberExternalIdentity.count({
        where: {
          memberId: input.memberId,
          provider: 'ZALO',
          providerAppId: parentAppId,
          providerSubjectId: identity.subjectId,
        },
      }),
    );
    if (ownsIdentity !== 1) throw new UnauthorizedException('Zalo identity does not match member');
    const decoded = await this.zaloProvider.decodePhoneToken({
      accessToken: input.accessToken,
      expectedMiniAppId: miniAppId,
      token: input.phoneToken,
    });
    return this.persistPhone({
      consentEventId: input.consentEventId,
      memberId: input.memberId,
      phone: normalizeVietnamPhone(decoded.phoneE164),
      policyVersion: input.policyVersion,
      source: 'ZALO',
      store,
      verified: true,
    });
  }

  private async persistPhone(input: {
    consentEventId: string;
    memberId: string;
    phone: string;
    policyVersion: string;
    source: 'MANUAL' | 'ZALO';
    store: ResolvedStore;
    verified: boolean;
  }): Promise<{ masked_phone: string }> {
    const phone = input.phone;
    const phoneHash = hashSensitive(phone, this.config.PII_HASH_KEY);
    const context = createStoreContext({
      actor: { id: input.memberId, type: 'member' },
      correlationId: randomUUID(),
      locale: input.store.default_locale,
      storeCode: input.store.code,
      storeId: input.store.id,
    });
    await withStoreTransaction(this.database, context, async (transaction) => {
      await transaction.member.findUniqueOrThrow({ where: { id: input.memberId } });
      const existingConsent = await transaction.consent.findUnique({
        where: {
          storeId_eventId: { eventId: input.consentEventId, storeId: input.store.id },
        },
      });
      if (existingConsent) {
        const evidence = existingConsent.evidence as { phone_hash?: unknown } | null;
        const matches =
          existingConsent.memberId === input.memberId &&
          existingConsent.policyVersion === input.policyVersion &&
          existingConsent.purpose === 'PHONE' &&
          existingConsent.source === input.source &&
          existingConsent.status === 'GRANTED' &&
          evidence?.phone_hash === phoneHash;
        if (!matches) throw new ConflictException('Consent event conflict');
      } else {
        await transaction.consent.create({
          data: {
            eventId: input.consentEventId,
            evidence: { phone_hash: phoneHash },
            memberId: input.memberId,
            occurredAt: new Date(),
            policyVersion: input.policyVersion,
            purpose: 'PHONE',
            source: input.source,
            status: 'GRANTED',
            storeId: input.store.id,
          },
        });
      }
      await transaction.memberPhoneContact.upsert({
        create: {
          memberId: input.memberId,
          phoneCiphertext: encryptSensitive(phone, this.config.PII_ENCRYPTION_KEY),
          phoneHash,
          source: input.source,
          storeId: input.store.id,
          verifiedAt: input.verified ? new Date() : null,
        },
        update: {
          phoneCiphertext: encryptSensitive(phone, this.config.PII_ENCRYPTION_KEY),
          phoneHash,
          source: input.source,
          verifiedAt: input.verified ? new Date() : null,
        },
        where: { storeId_memberId: { memberId: input.memberId, storeId: input.store.id } },
      });
    });
    return { masked_phone: `${phone.slice(0, 4)}••••${phone.slice(-3)}` };
  }

  private async resolveMemberContext(input: {
    memberId: string;
    storeCode: string;
    storeId: string;
  }) {
    const store = await this.resolveStore(input.storeCode);
    if (store.id !== input.storeId) throw new UnauthorizedException('Store context is invalid');
    return {
      context: createStoreContext({
        actor: { id: input.memberId, type: 'member' },
        correlationId: randomUUID(),
        locale: store.default_locale,
        storeCode: store.code,
        storeId: store.id,
      }),
      store,
    };
  }

  private toConsentResponse(consent: {
    eventId: string;
    id: string;
    occurredAt: Date;
    policyVersion: string;
    purpose: ConsentResponse['purpose'];
    source: ConsentResponse['source'];
    status: ConsentResponse['status'];
  }): ConsentResponse {
    return {
      event_id: consent.eventId,
      id: consent.id,
      occurred_at: consent.occurredAt,
      policy_version: consent.policyVersion,
      purpose: consent.purpose,
      source: consent.source,
      status: consent.status,
    };
  }

  private async resolveStore(storeCode: string): Promise<ResolvedStore> {
    const stores = await this.database.$queryRaw<ResolvedStore[]>`
      SELECT * FROM app_security.resolve_active_store(${storeCode.trim()})
    `;
    const store = stores[0];
    if (!store) throw new UnauthorizedException('Store context is invalid');
    return store;
  }

  private createSessionResponse(input: {
    actorType: 'admin' | 'member';
    refreshToken: string;
    sessionId: string;
    storeId?: string;
    subjectId: string;
  }): SessionResponse {
    const now = Math.floor(Date.now() / 1_000);
    return {
      access_token: signJwt(
        {
          actor_type: input.actorType,
          aud: this.config.AUTH_JWT_AUDIENCE,
          exp: now + this.config.AUTH_ACCESS_TTL_SECONDS,
          iat: now,
          iss: this.config.AUTH_JWT_ISSUER,
          jti: randomUUID(),
          session_id: input.sessionId,
          ...(input.storeId === undefined ? {} : { store_id: input.storeId }),
          sub: input.subjectId,
        },
        this.config.AUTH_JWT_SECRET,
      ),
      expires_in: this.config.AUTH_ACCESS_TTL_SECONDS,
      refresh_token: input.refreshToken,
      token_type: 'Bearer',
    };
  }

  private async recordAdminFailure(adminId: string, currentCount: number): Promise<void> {
    const failedLoginCount = currentCount + 1;
    await this.database.adminUser.update({
      data: {
        failedLoginCount,
        ...(failedLoginCount >= 5 ? { lockedUntil: new Date(Date.now() + 15 * 60 * 1_000) } : {}),
      },
      where: { id: adminId },
    });
  }
}
