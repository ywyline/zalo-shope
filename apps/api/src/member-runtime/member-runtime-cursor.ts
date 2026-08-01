import { createHmac, timingSafeEqual } from 'node:crypto';

import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { RuntimeConfig } from '@zalo-shop/config';

import { RUNTIME_CONFIG } from '../health.controller';

export type MemberCursorResource = 'FAVORITES' | 'PRIVACY_REQUESTS' | 'PRODUCT_HISTORY';

type MemberCursorScope = Readonly<{
  locale: '-' | 'en' | 'vi' | 'zh';
  memberId: string;
  resource: MemberCursorResource;
  sortId: string;
  sortKey: string;
  storeId: string;
}>;

type PackedCursor = readonly [
  version: 1,
  expiresAtEpochSeconds: number,
  storeId: string,
  memberId: string,
  resource: MemberCursorResource,
  locale: MemberCursorScope['locale'],
  sortKey: string,
  sortId: string,
];

const CURSOR_PREFIX = 'c1_';
const HMAC_LENGTH_BASE64URL = 43;
const CURSOR_PATTERN = /^c1_[A-Za-z0-9_-]{20,509}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MICROSECOND_UTC_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{6})Z$/u;

@Injectable()
export class MemberRuntimeCursor {
  private readonly keys: readonly Buffer[];

  public constructor(@Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig) {
    this.keys = config.AFTER_SALE_CURSOR_HMAC_KEYS.split(',').map((key) =>
      Buffer.from(key, 'base64url'),
    );
  }

  public encode(scope: MemberCursorScope): string {
    if (!this.validScope(scope)) return this.invalid();
    const packed: PackedCursor = [
      1,
      Math.floor(Date.now() / 1_000) + this.config.AFTER_SALE_CURSOR_TTL_SECONDS,
      scope.storeId,
      scope.memberId,
      scope.resource,
      scope.locale,
      scope.sortKey,
      scope.sortId,
    ];
    const payload = Buffer.from(JSON.stringify(packed), 'utf8').toString('base64url');
    const signed = `${CURSOR_PREFIX}${payload}`;
    const signature = createHmac('sha256', this.keys[0]!).update(signed).digest('base64url');
    const token = `${signed}_${signature}`;
    if (!CURSOR_PATTERN.test(token) || token.length > 512) return this.invalid();
    return token;
  }

  public decode(
    token: string | undefined,
    expected: Pick<MemberCursorScope, 'locale' | 'memberId' | 'resource' | 'storeId'>,
  ): { sortId: string; sortKey: string } | undefined {
    if (token === undefined) return undefined;
    if (!CURSOR_PATTERN.test(token) || token.length > 512) return this.invalid();
    const signatureSeparator = token.length - HMAC_LENGTH_BASE64URL - 1;
    if (signatureSeparator <= CURSOR_PREFIX.length || token[signatureSeparator] !== '_') {
      return this.invalid();
    }
    const signed = token.slice(0, signatureSeparator);
    const suppliedText = token.slice(signatureSeparator + 1);
    const supplied = Buffer.from(suppliedText, 'base64url');
    if (supplied.length !== 32 || supplied.toString('base64url') !== suppliedText) {
      return this.invalid();
    }
    let validSignature = false;
    for (const key of this.keys) {
      const candidate = createHmac('sha256', key).update(signed).digest();
      validSignature = timingSafeEqual(candidate, supplied) || validSignature;
    }
    if (!validSignature) return this.invalid();

    const payloadText = signed.slice(CURSOR_PREFIX.length);
    const payload = Buffer.from(payloadText, 'base64url');
    if (payload.toString('base64url') !== payloadText) return this.invalid();
    let packed: unknown;
    try {
      packed = JSON.parse(payload.toString('utf8'));
    } catch {
      return this.invalid();
    }
    if (!Array.isArray(packed) || packed.length !== 8) return this.invalid();
    const entries = packed as readonly unknown[];
    const [version, expiresAt, storeId, memberId, resource, locale, sortKey, sortId] = entries;
    const scope = { locale, memberId, resource, sortId, sortKey, storeId };
    if (
      version !== 1 ||
      typeof expiresAt !== 'number' ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= Math.floor(Date.now() / 1_000) ||
      !this.validScope(scope) ||
      scope.storeId !== expected.storeId ||
      scope.memberId !== expected.memberId ||
      scope.resource !== expected.resource ||
      scope.locale !== expected.locale
    ) {
      return this.invalid();
    }
    return { sortId: scope.sortId, sortKey: scope.sortKey };
  }

  private validScope(value: {
    locale: unknown;
    memberId: unknown;
    resource: unknown;
    sortId: unknown;
    sortKey: unknown;
    storeId: unknown;
  }): value is MemberCursorScope {
    return (
      typeof value.storeId === 'string' &&
      UUID_PATTERN.test(value.storeId) &&
      typeof value.memberId === 'string' &&
      UUID_PATTERN.test(value.memberId) &&
      typeof value.sortId === 'string' &&
      UUID_PATTERN.test(value.sortId) &&
      typeof value.sortKey === 'string' &&
      this.canonicalSortKey(value.sortKey) &&
      (value.resource === 'FAVORITES' ||
        value.resource === 'PRODUCT_HISTORY' ||
        value.resource === 'PRIVACY_REQUESTS') &&
      (value.locale === '-' ||
        value.locale === 'en' ||
        value.locale === 'vi' ||
        value.locale === 'zh')
    );
  }

  private canonicalSortKey(value: string): boolean {
    const match = MICROSECOND_UTC_PATTERN.exec(value);
    if (!match) return false;
    const millisecondIso = `${match[1]}.${match[2]!.slice(0, 3)}Z`;
    return (
      Number.isFinite(Date.parse(millisecondIso)) &&
      new Date(Date.parse(millisecondIso)).toISOString() === millisecondIso
    );
  }

  private invalid(): never {
    throw new BadRequestException('Member cursor is invalid');
  }
}
