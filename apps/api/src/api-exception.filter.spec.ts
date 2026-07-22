import { ConflictException, type ArgumentsHost } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { ApiExceptionFilter } from './api-exception.filter';

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
});
