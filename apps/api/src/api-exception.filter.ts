import { randomUUID } from 'node:crypto';

import {
  Catch,
  HttpException,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';

type HttpRequest = { headers: Record<string, string | string[] | undefined> };
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

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  public catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<HttpRequest>();
    const response = http.getResponse<HttpResponse>();
    const supplied = request.headers['x-correlation-id'];
    const correlationId =
      typeof supplied === 'string' && supplied.length <= 128 ? supplied : randomUUID();
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const code = errorCode(status);
    response.header('x-correlation-id', correlationId);
    response.status(status).json({
      code,
      correlation_id: correlationId,
      message_key: `error.${code.toLowerCase()}`,
    });
  }
}
