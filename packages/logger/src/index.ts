import { randomUUID } from 'node:crypto';

import type { LoggerService } from '@nestjs/common';
import pino, { type Logger } from 'pino';
import pinoHttp from 'pino-http';

const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers.x-zalo-access-token',
  'req.headers.x-zalo-phone-token',
  'req.headers.x-refresh-token',
  'res.headers.set-cookie',
] as const;

const SENSITIVE_KEY_PATTERN =
  /authorization|cookie|password|secret|token|phone|address|mfa|card|payment/i;

export function redactSensitiveData(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveData(item));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : redactSensitiveData(nestedValue),
      ]),
    );
  }
  return value;
}

export function createLogger(service: string, level: string): Logger {
  return pino({
    base: { service },
    level,
    redact: {
      censor: '[REDACTED]',
      paths: [...REDACTED_PATHS],
    },
  });
}

export function createHttpLogger(logger: Logger) {
  return pinoHttp({
    customAttributeKeys: {
      req: 'request',
      res: 'response',
    },
    genReqId(request, response) {
      const suppliedId = request.headers['x-correlation-id'];
      const correlationId =
        typeof suppliedId === 'string' && suppliedId.length <= 128 ? suppliedId : randomUUID();
      response.setHeader('x-correlation-id', correlationId);
      return correlationId;
    },
    logger,
    redact: {
      censor: '[REDACTED]',
      paths: [...REDACTED_PATHS],
    },
  });
}

export class NestPinoLogger implements LoggerService {
  public constructor(private readonly logger: Logger) {}

  public debug(message: unknown, ...optionalParameters: unknown[]): void {
    this.logger.debug({ optionalParameters }, String(message));
  }

  public error(message: unknown, ...optionalParameters: unknown[]): void {
    this.logger.error({ optionalParameters }, String(message));
  }

  public fatal(message: unknown, ...optionalParameters: unknown[]): void {
    this.logger.fatal({ optionalParameters }, String(message));
  }

  public log(message: unknown, ...optionalParameters: unknown[]): void {
    this.logger.info({ optionalParameters }, String(message));
  }

  public verbose(message: unknown, ...optionalParameters: unknown[]): void {
    this.logger.trace({ optionalParameters }, String(message));
  }

  public warn(message: unknown, ...optionalParameters: unknown[]): void {
    this.logger.warn({ optionalParameters }, String(message));
  }
}
