import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Patch,
  Post,
  Put,
  UnauthorizedException,
} from '@nestjs/common';
import {
  consentEventSchema,
  manualPhoneSchema,
  memberPreferenceSchema,
  zaloPhoneSchema,
} from '@zalo-shop/contracts';
import { z } from 'zod';

import { AuthService } from './auth.service';

const adminPasswordSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(12).max(1_024),
});
const adminMfaSchema = z.object({
  challenge_token: z.string().min(32),
  token: z.string().regex(/^\d{6}$/),
});
const refreshSchema = z.object({ refresh_token: z.string().min(32).max(128) });

function requiredHeader(value: string | undefined): string {
  if (!value) throw new UnauthorizedException('Authentication credential is required');
  return value;
}

function parseBearer(value: string | undefined): string {
  if (!value?.startsWith('Bearer ')) throw new UnauthorizedException('Bearer token is required');
  return value.slice(7);
}

function parseBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException('Input is invalid');
  return result.data;
}

@Controller('v1/auth')
export class AuthController {
  public constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post('zalo/exchange')
  public exchangeZalo(
    @Headers('x-zalo-access-token') accessToken: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
  ) {
    return this.auth.exchangeZalo({
      accessToken: requiredHeader(accessToken),
      storeCode: requiredHeader(storeCode),
    });
  }

  @Post('refresh')
  public refresh(@Headers('x-store-code') storeCode: string | undefined, @Body() body: unknown) {
    const parsed = parseBody(refreshSchema, body);
    return this.auth.refreshMember({
      refreshToken: parsed.refresh_token,
      storeCode: requiredHeader(storeCode),
    });
  }

  @Post('admin/refresh')
  public adminRefresh(@Body() body: unknown) {
    const parsed = parseBody(refreshSchema, body);
    return this.auth.refreshAdmin(parsed.refresh_token);
  }

  @Post('logout')
  public async logout(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
  ): Promise<{ status: 'ok' }> {
    await this.auth.logout({
      accessToken: parseBearer(authorization),
      ...(storeCode === undefined ? {} : { storeCode }),
    });
    return { status: 'ok' };
  }

  @Post('admin/password')
  public adminPassword(@Body() body: unknown) {
    return this.auth.authenticateAdminPassword(parseBody(adminPasswordSchema, body));
  }

  @Post('admin/mfa/verify')
  public adminMfa(@Body() body: unknown) {
    const parsed = parseBody(adminMfaSchema, body);
    return this.auth.verifyAdminMfa({
      challengeToken: parsed.challenge_token,
      token: parsed.token,
    });
  }
}

@Controller('v1/members/me')
export class MemberController {
  public constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Get()
  public async getProfile(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
  ) {
    const member = await this.authenticateMember(authorization, storeCode);
    return this.auth.getMemberProfile(member);
  }

  @Patch('preferences')
  public async updatePreferences(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Body() body: unknown,
  ) {
    const member = await this.authenticateMember(authorization, storeCode);
    const preference = parseBody(memberPreferenceSchema, body);
    return this.auth.updateMemberPreference({ ...member, locale: preference.locale });
  }

  @Post('consents')
  public async recordConsent(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Body() body: unknown,
  ): Promise<unknown> {
    const member = await this.authenticateMember(authorization, storeCode);
    const consent = parseBody(consentEventSchema, body);
    return this.auth.recordConsent({
      eventId: consent.event_id,
      memberId: member.memberId,
      policyVersion: consent.policy_version,
      purpose: consent.purpose,
      source: consent.source,
      status: consent.status,
      storeCode: member.storeCode,
      storeId: member.storeId,
    });
  }

  @Put('phone/manual')
  public async manualPhone(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Body() body: unknown,
  ) {
    const member = await this.authenticateMember(authorization, storeCode);
    const parsed = parseBody(manualPhoneSchema, body);
    return this.auth.saveManualPhone({
      consentEventId: parsed.consent_event_id,
      memberId: member.memberId,
      phone: parsed.phone,
      policyVersion: parsed.policy_version,
      storeCode: member.storeCode,
      storeId: member.storeId,
    });
  }

  @Put('phone/zalo')
  public async zaloPhone(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-zalo-access-token') zaloAccessToken: string | undefined,
    @Body() body: unknown,
  ) {
    const member = await this.authenticateMember(authorization, storeCode);
    const parsed = parseBody(zaloPhoneSchema, body);
    return this.auth.saveZaloPhone({
      accessToken: requiredHeader(zaloAccessToken),
      consentEventId: parsed.consent_event_id,
      memberId: member.memberId,
      phoneToken: parsed.phone_token,
      policyVersion: parsed.policy_version,
      storeCode: member.storeCode,
      storeId: member.storeId,
    });
  }

  private async authenticateMember(
    authorization: string | undefined,
    storeCode: string | undefined,
  ): Promise<{ memberId: string; storeCode: string; storeId: string }> {
    const resolvedStoreCode = requiredHeader(storeCode);
    const claims = await this.auth.authenticateAccessToken(
      parseBearer(authorization),
      resolvedStoreCode,
    );
    if (claims.actorType !== 'member' || !claims.storeId) {
      throw new UnauthorizedException('Member authentication is required');
    }
    return {
      memberId: claims.subjectId,
      storeCode: resolvedStoreCode,
      storeId: claims.storeId,
    };
  }
}
