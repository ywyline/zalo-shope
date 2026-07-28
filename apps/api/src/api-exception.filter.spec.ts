import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  type ArgumentsHost,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { ApiExceptionFilter } from './api-exception.filter';
import { AfterSaleRateLimitException } from './after-sales/after-sales-rate-limiter';

function harness(correlationId = 'm35-filter-test', requestId?: string) {
  const json = vi.fn();
  const header = vi.fn();
  const status = vi.fn(() => ({ json }));
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { 'x-correlation-id': correlationId }, id: requestId }),
      getResponse: () => ({ header, status }),
    }),
  } as unknown as ArgumentsHost;
  return { header, host, json, status };
}

describe('API conflict reason envelopes', () => {
  it('returns allowlisted input reason codes for recoverable M4 validation', () => {
    const test = harness();
    new ApiExceptionFilter().catch(new BadRequestException('ADDRESS_REGION_INVALID'), test.host);

    expect(test.status).toHaveBeenCalledWith(400);
    expect(test.json).toHaveBeenCalledWith({
      code: 'INPUT_INVALID',
      correlation_id: 'm35-filter-test',
      details: { reason_code: 'ADDRESS_REGION_INVALID' },
      message_key: 'error.input_invalid',
    });
  });

  it('returns allowlisted stable reason codes without exposing exception internals', () => {
    const test = harness();
    new ApiExceptionFilter().catch(new ConflictException('VERSION_CONFLICT'), test.host);

    expect(test.status).toHaveBeenCalledWith(409);
    expect(test.json).toHaveBeenCalledWith({
      code: 'CONFLICT',
      correlation_id: 'm35-filter-test',
      details: { reason_code: 'VERSION_CONFLICT' },
      message_key: 'error.conflict',
    });
  });

  it.each([
    'AFTER_SALE_POLICY_NOT_READY',
    'AFTER_SALE_POLICY_SNAPSHOT_INVALID',
    'AFTER_SALE_SETTINGS_CONCURRENT_CONFLICT',
    'AFTER_SALE_SETTINGS_IDEMPOTENCY_CONFLICT',
    'AFTER_SALE_SETTINGS_IDEMPOTENCY_INVALID',
    'AFTER_SALE_SETTINGS_VERSION_CONFLICT',
  ])('returns the stable M6.3-A policy conflict %s', (reasonCode) => {
    const test = harness();
    new ApiExceptionFilter().catch(new ConflictException(reasonCode), test.host);

    expect(test.json).toHaveBeenCalledWith(
      expect.objectContaining({ details: { reason_code: reasonCode } }),
    );
  });

  it('does not echo arbitrary conflict messages', () => {
    const test = harness();
    new ApiExceptionFilter().catch(
      new ConflictException('constraint coupons_store_id_code_key failed'),
      test.host,
    );

    expect(test.json).toHaveBeenCalledWith({
      code: 'CONFLICT',
      correlation_id: 'm35-filter-test',
      message_key: 'error.conflict',
    });

    const uppercase = harness();
    new ApiExceptionFilter().catch(new ConflictException('DATABASE_CORRUPTION'), uppercase.host);
    expect(uppercase.json).toHaveBeenCalledWith({
      code: 'CONFLICT',
      correlation_id: 'm35-filter-test',
      message_key: 'error.conflict',
    });
  });

  it('does not echo an unsafe client-supplied correlation ID', () => {
    const secret = 'token=M37_FILTER_CORRELATION_SECRET';
    const requestId = 'm37-http-middleware-request';
    const test = harness(secret, requestId);
    new ApiExceptionFilter().catch(new ConflictException('VERSION_CONFLICT'), test.host);

    const correlationId = test.header.mock.calls[0]?.[1] as string;
    expect(correlationId).toBe(requestId);
    expect(correlationId).not.toContain(secret);
    expect(test.json).toHaveBeenCalledWith({
      code: 'CONFLICT',
      correlation_id: correlationId,
      details: { reason_code: 'VERSION_CONFLICT' },
      message_key: 'error.conflict',
    });
  });

  it('adds Retry-After only for a bounded after-sale rate-limit exception', () => {
    const limited = harness();
    new ApiExceptionFilter().catch(new AfterSaleRateLimitException(37), limited.host);
    expect(limited.header).toHaveBeenCalledWith('retry-after', '37');

    const unrelated = harness();
    new ApiExceptionFilter().catch(
      Object.assign(new ConflictException('Conflict'), { retryAfterSeconds: 37 }),
      unrelated.host,
    );
    expect(unrelated.header).not.toHaveBeenCalledWith('retry-after', expect.anything());
  });

  it('maps provider availability failures to the public 503 envelope', () => {
    const test = harness();
    new ApiExceptionFilter().catch(
      new ServiceUnavailableException('provider response must stay private'),
      test.host,
    );

    expect(test.status).toHaveBeenCalledWith(503);
    expect(test.json).toHaveBeenCalledWith({
      code: 'UPSTREAM_UNAVAILABLE',
      correlation_id: 'm35-filter-test',
      message_key: 'error.upstream_unavailable',
    });
  });
});
