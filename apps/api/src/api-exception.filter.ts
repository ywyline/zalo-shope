import {
  Catch,
  HttpException,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { resolveCorrelationId } from '@zalo-shop/logger';

type HttpRequest = { headers: Record<string, string | string[] | undefined>; id?: unknown };
type HttpResponse = {
  header(name: string, value: string): void;
  status(code: number): { json(body: unknown): void };
};

function errorCode(status: number): string {
  if (status === 400) return 'INPUT_INVALID';
  if (status === 401) return 'AUTHENTICATION_FAILED';
  if (status === 403) return 'AUTHORIZATION_DENIED';
  if (status === 404) return 'RESOURCE_NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 429) return 'RATE_LIMITED';
  return 'INTERNAL_ERROR';
}

const stableConflictReasonCodes = new Set([
  'AVAILABLE_INSUFFICIENT',
  'CART_LINE_CONFLICT',
  'COUPON_CLAIM_LIMIT',
  'COUPON_INVALID',
  'COUPON_MEMBER_REQUIRED',
  'COUPON_STATE_CONFLICT',
  'IDEMPOTENCY_KEY_REUSED',
  'IMPORT_INVALID',
  'MEMBER_INELIGIBLE',
  'PRODUCT_UNAVAILABLE',
  'PROMOTION_RULE_INVALID',
  'PROMOTION_STATE_CONFLICT',
  'PROMOTION_VERSION_STATE_CONFLICT',
  'QUANTITY_OVERFLOW',
  'RESERVATION_TRANSITION_INVALID',
  'RESERVED_INSUFFICIENT',
  'SKU_UNAVAILABLE',
  'VERSION_CONFLICT',
]);

function reasonCode(exception: unknown, status: number): string | undefined {
  if (status !== 409 || !(exception instanceof HttpException)) return undefined;
  const response = exception.getResponse();
  const message =
    typeof response === 'string'
      ? response
      : typeof response === 'object' && response !== null && 'message' in response
        ? (response as { message?: unknown }).message
        : undefined;
  return typeof message === 'string' && stableConflictReasonCodes.has(message)
    ? message
    : undefined;
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  public catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<HttpRequest>();
    const response = http.getResponse<HttpResponse>();
    const supplied = request.headers['x-correlation-id'];
    const correlationId = resolveCorrelationId(request.id, supplied);
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const code = errorCode(status);
    const reason = reasonCode(exception, status);
    response.header('x-correlation-id', correlationId);
    response.status(status).json({
      code,
      correlation_id: correlationId,
      ...(reason === undefined ? {} : { details: { reason_code: reason } }),
      message_key: `error.${code.toLowerCase()}`,
    });
  }
}
