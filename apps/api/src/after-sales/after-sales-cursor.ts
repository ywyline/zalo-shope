import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { RuntimeConfig } from '@zalo-shop/config';
import { afterSaleCursorSchema, afterSaleCursorScopeSchema } from '@zalo-shop/contracts';
import type { z } from 'zod';

import { RUNTIME_CONFIG } from '../health.controller';

type AfterSaleCursorScope = z.infer<typeof afterSaleCursorScopeSchema>;
type CursorFilterValue = boolean | null | number | string;
type PackedCursor = readonly [
  version: 1,
  expiresAtEpochSeconds: number,
  storeId: string,
  subjectType: AfterSaleCursorScope['subject_type'],
  subjectId: string,
  resource: AfterSaleCursorScope['resource'],
  filtersHash: string,
  sortKey: string,
  sortId: string,
];
type UntrustedPackedCursor = readonly [
  unknown,
  unknown,
  unknown,
  unknown,
  unknown,
  unknown,
  unknown,
  unknown,
  unknown,
];

const CURSOR_PREFIX = 'c1_';
const HMAC_LENGTH_BASE64URL = 43;
const MICROSECOND_UTC_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{6})Z$/u;

function isUntrustedPackedCursor(value: unknown): value is UntrustedPackedCursor {
  return Array.isArray(value) && value.length === 9;
}

export function hashAfterSaleCursorFilters(
  filters: Readonly<Record<string, CursorFilterValue>>,
): string {
  const canonical = Object.fromEntries(
    Object.entries(filters).sort(([left], [right]) => left.localeCompare(right)),
  );
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

@Injectable()
export class AfterSalesCursor {
  private readonly keys: readonly Buffer[];

  public constructor(@Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig) {
    this.keys = config.AFTER_SALE_CURSOR_HMAC_KEYS.split(',').map((key) =>
      Buffer.from(key, 'base64url'),
    );
  }

  public encode(scope: Omit<AfterSaleCursorScope, 'expires_at_epoch_seconds' | 'version'>): string {
    const parsed = afterSaleCursorScopeSchema.safeParse({
      ...scope,
      expires_at_epoch_seconds:
        Math.floor(Date.now() / 1_000) + this.config.AFTER_SALE_CURSOR_TTL_SECONDS,
      version: 1,
    });
    if (!parsed.success || !this.isCanonicalSortKey(parsed.data.sort_key)) {
      throw new BadRequestException('After-sale cursor is invalid');
    }
    const packed: PackedCursor = [
      1,
      parsed.data.expires_at_epoch_seconds,
      parsed.data.store_id,
      parsed.data.subject_type,
      parsed.data.subject_id,
      parsed.data.resource,
      parsed.data.filters_hash,
      parsed.data.sort_key,
      parsed.data.sort_id,
    ];
    const payload = Buffer.from(JSON.stringify(packed), 'utf8').toString('base64url');
    const signed = `${CURSOR_PREFIX}${payload}`;
    const signature = createHmac('sha256', this.keys[0]!).update(signed).digest('base64url');
    const token = `${signed}_${signature}`;
    if (!afterSaleCursorSchema.safeParse(token).success) {
      throw new BadRequestException('After-sale cursor is invalid');
    }
    return token;
  }

  public decode(
    token: string,
    expected: Pick<
      AfterSaleCursorScope,
      'filters_hash' | 'resource' | 'store_id' | 'subject_id' | 'subject_type'
    >,
  ): { sortId: string; sortKey: string } {
    if (!afterSaleCursorSchema.safeParse(token).success) return this.invalid();
    const signatureSeparator = token.length - HMAC_LENGTH_BASE64URL - 1;
    if (signatureSeparator <= CURSOR_PREFIX.length || token[signatureSeparator] !== '_') {
      return this.invalid();
    }
    const signed = token.slice(0, signatureSeparator);
    const signatureText = token.slice(signatureSeparator + 1);
    const suppliedSignature = Buffer.from(signatureText, 'base64url');
    if (
      suppliedSignature.length !== 32 ||
      suppliedSignature.toString('base64url') !== signatureText
    ) {
      return this.invalid();
    }
    let signatureValid = false;
    for (const key of this.keys) {
      const candidate = createHmac('sha256', key).update(signed).digest();
      signatureValid = timingSafeEqual(candidate, suppliedSignature) || signatureValid;
    }
    if (!signatureValid) return this.invalid();

    const payloadText = signed.slice(CURSOR_PREFIX.length);
    const payloadBuffer = Buffer.from(payloadText, 'base64url');
    if (payloadBuffer.toString('base64url') !== payloadText) return this.invalid();

    let packed: unknown;
    try {
      packed = JSON.parse(payloadBuffer.toString('utf8'));
    } catch {
      return this.invalid();
    }
    if (!isUntrustedPackedCursor(packed)) return this.invalid();
    const parsed = afterSaleCursorScopeSchema.safeParse({
      expires_at_epoch_seconds: packed[1],
      filters_hash: packed[6],
      resource: packed[5],
      sort_id: packed[8],
      sort_key: packed[7],
      store_id: packed[2],
      subject_id: packed[4],
      subject_type: packed[3],
      version: packed[0],
    });
    if (
      !parsed.success ||
      parsed.data.expires_at_epoch_seconds <= Math.floor(Date.now() / 1_000) ||
      !this.isCanonicalSortKey(parsed.data.sort_key) ||
      parsed.data.filters_hash !== expected.filters_hash ||
      parsed.data.resource !== expected.resource ||
      parsed.data.store_id !== expected.store_id ||
      parsed.data.subject_id !== expected.subject_id ||
      parsed.data.subject_type !== expected.subject_type
    ) {
      return this.invalid();
    }
    return { sortId: parsed.data.sort_id, sortKey: parsed.data.sort_key };
  }

  private invalid(): never {
    throw new BadRequestException('After-sale cursor is invalid');
  }

  private isCanonicalSortKey(value: string): boolean {
    const match = MICROSECOND_UTC_PATTERN.exec(value);
    if (!match) return false;
    const millisecondIso = `${match[1]}.${match[2]!.slice(0, 3)}Z`;
    const timestamp = Date.parse(millisecondIso);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === millisecondIso;
  }
}
