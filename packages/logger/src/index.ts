import { randomUUID } from 'node:crypto';

import type { LoggerService } from '@nestjs/common';
import pino, { type DestinationStream, type Logger } from 'pino';
import pinoHttp from 'pino-http';

const REDACTED_PATHS = [
  // pino-http uses these names before customAttributeKeys are applied.
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-zalo-access-token"]',
  'req.headers["x-zalo-phone-token"]',
  'req.headers["x-refresh-token"]',
  'res.headers["set-cookie"]',
  // The HTTP logger exposes the serialized objects as request/response.
  'request.headers.authorization',
  'request.headers.cookie',
  'request.headers["x-zalo-access-token"]',
  'request.headers["x-zalo-phone-token"]',
  'request.headers["x-refresh-token"]',
  'response.headers["set-cookie"]',
] as const;

const SENSITIVE_KEY_PATTERN =
  /api[-_]?key|authorization|cookie|credential|password|secret|session|token|phone|address|mfa|card|payment/i;

const URL_HEADER_PATTERN =
  /^(?:content-location|location|referer|referrer|x-envoy-original-path|x-forwarded-uri|x-original-uri|x-original-url|x-rewrite-url)$/i;
const EMBEDDED_URL_HEADER_PATTERN = /^(?:link|refresh)$/i;
const NETWORK_IDENTITY_HEADER_PATTERN =
  /^(?:cf-connecting-ip|fastly-client-ip|forwarded|forwarded-for|true-client-ip|x-client-ip|x-cluster-client-ip|x-envoy-external-address|x-forwarded-for|x-real-ip)$/i;
const CORRELATION_ID_HEADER_PATTERN = /^(?:request-id|x-correlation-id|x-request-id)$/i;
const SAFE_CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ABSOLUTE_URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi;
const RELATIVE_URL_WITH_QUERY_PATTERN = /\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+[?#][^\s]*/gi;
const SENSITIVE_ASSIGNMENT_PATTERN =
  /\b([a-z0-9_-]*(?:api[-_]?key|authorization|cookie|credential|password|secret|session|token|phone|address|mfa|card|payment)[a-z0-9_-]*)=([^&\s]+)/gi;

function sanitizeLogString(value: string): string {
  return value
    .replace(ABSOLUTE_URL_PATTERN, (candidate) => stripUrlSensitiveParts(candidate))
    .replace(RELATIVE_URL_WITH_QUERY_PATTERN, (candidate) => stripUrlSensitiveParts(candidate))
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, '$1=[REDACTED]');
}

function isSafeCorrelationId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_CORRELATION_ID_PATTERN.test(value);
}

export function resolveCorrelationId(...values: readonly unknown[]): string {
  return values.find(isSafeCorrelationId) ?? randomUUID();
}

export function redactSensitiveData(value: unknown): unknown {
  return redactSensitiveValue(value, new Set<object>());
}

function redactSensitiveValue(value: unknown, ancestors: Set<object>): unknown {
  if (typeof value === 'string') return sanitizeLogString(value);
  if (typeof value === 'bigint') {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return '[Circular]';
    ancestors.add(value);
    try {
      return value.map((item) => redactSensitiveValue(item, ancestors));
    } finally {
      ancestors.delete(value);
    }
  }
  if (value !== null && typeof value === 'object') {
    if (ancestors.has(value)) return '[Circular]';
    ancestors.add(value);
    try {
      if (value instanceof URL) return sanitizeLogString(value.toString());
      if (value instanceof Error) {
        return {
          ...Object.fromEntries(
            Object.entries(value).map(([key, nestedValue]) => [
              key,
              SENSITIVE_KEY_PATTERN.test(key)
                ? '[REDACTED]'
                : redactSensitiveValue(nestedValue, ancestors),
            ]),
          ),
          message: sanitizeLogString(value.message),
          name: value.name,
          stack: value.stack ? sanitizeLogString(value.stack) : undefined,
        };
      }
      const jsonBacked = value as { toJSON?: () => unknown };
      if (typeof jsonBacked.toJSON === 'function') {
        const serialized = jsonBacked.toJSON();
        if (serialized !== value) return redactSensitiveValue(serialized, ancestors);
      }
      return Object.fromEntries(
        Object.entries(value).map(([key, nestedValue]) => [
          key,
          SENSITIVE_KEY_PATTERN.test(key)
            ? '[REDACTED]'
            : redactSensitiveValue(nestedValue, ancestors),
        ]),
      );
    } finally {
      ancestors.delete(value);
    }
  }
  return value;
}

export function createLogger(
  service: string,
  level: string,
  destination?: DestinationStream,
): Logger {
  return pino(
    {
      base: { service },
      formatters: {
        log(value) {
          return redactSensitiveData(value) as Record<string, unknown>;
        },
      },
      hooks: {
        logMethod(arguments_, method) {
          Reflect.apply(
            method,
            this,
            arguments_.map((argument) =>
              typeof argument === 'string'
                ? sanitizeLogString(argument)
                : redactSensitiveData(argument),
            ),
          );
        },
      },
      level,
      redact: {
        censor: '[REDACTED]',
        paths: [...REDACTED_PATHS],
      },
    },
    destination,
  );
}

type SerializedHttpMessage = {
  [key: string]: unknown;
  headers?: unknown;
  id?: unknown;
  ip?: unknown;
  ips?: unknown;
  remoteAddress?: unknown;
  remotePort?: unknown;
  url?: unknown;
};

function stripUrlSensitiveParts(url: string): string {
  const queryIndex = url.indexOf('?');
  const fragmentIndex = url.indexOf('#');
  const sensitiveIndex = Math.min(
    queryIndex === -1 ? url.length : queryIndex,
    fragmentIndex === -1 ? url.length : fragmentIndex,
  );
  const withoutQuery = url.slice(0, sensitiveIndex);
  try {
    const parsed = new URL(withoutQuery);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return withoutQuery.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i, '$1');
  }
}

function sanitizeUrlHeaderValue(value: unknown): unknown {
  if (typeof value === 'string') return stripUrlSensitiveParts(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeUrlHeaderValue(item));
  return value;
}

function sanitizeHttpHeaders(headers: unknown): unknown {
  if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) {
    return redactSensitiveData(headers);
  }

  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => {
      if (
        SENSITIVE_KEY_PATTERN.test(key) ||
        EMBEDDED_URL_HEADER_PATTERN.test(key) ||
        NETWORK_IDENTITY_HEADER_PATTERN.test(key)
      ) {
        return [key, '[REDACTED]'];
      }
      if (CORRELATION_ID_HEADER_PATTERN.test(key)) {
        return [key, isSafeCorrelationId(value) ? value : '[REDACTED]'];
      }
      if (URL_HEADER_PATTERN.test(key)) return [key, sanitizeUrlHeaderValue(value)];
      return [key, redactSensitiveData(value)];
    }),
  );
}

function sanitizeHttpMessage(message: SerializedHttpMessage): SerializedHttpMessage {
  if (typeof message.url === 'string') message.url = stripUrlSensitiveParts(message.url);
  if (message.headers !== undefined) message.headers = sanitizeHttpHeaders(message.headers);
  if (message.id !== undefined) {
    message.id = isSafeCorrelationId(message.id) ? message.id : '[REDACTED]';
  }
  for (const key of ['ip', 'ips', 'remoteAddress', 'remotePort'] as const) {
    if (message[key] !== undefined) message[key] = '[REDACTED]';
  }
  return message;
}

export function createHttpLogger(logger: Logger) {
  return pinoHttp({
    customAttributeKeys: {
      req: 'request',
      res: 'response',
    },
    genReqId(request, response) {
      const suppliedId = request.headers['x-correlation-id'];
      const correlationId = resolveCorrelationId(suppliedId);
      response.setHeader('x-correlation-id', correlationId);
      return correlationId;
    },
    logger,
    redact: {
      censor: '[REDACTED]',
      paths: [...REDACTED_PATHS],
    },
    serializers: {
      request: sanitizeHttpMessage,
      response: sanitizeHttpMessage,
    },
  });
}

export class NestPinoLogger implements LoggerService {
  public constructor(private readonly logger: Logger) {}

  public debug(message: unknown, ...optionalParameters: unknown[]): void {
    this.logger.debug(this.context(optionalParameters), String(message));
  }

  public error(message: unknown, ...optionalParameters: unknown[]): void {
    this.logger.error(this.context(optionalParameters), String(message));
  }

  public fatal(message: unknown, ...optionalParameters: unknown[]): void {
    this.logger.fatal(this.context(optionalParameters), String(message));
  }

  public log(message: unknown, ...optionalParameters: unknown[]): void {
    this.logger.info(this.context(optionalParameters), String(message));
  }

  public verbose(message: unknown, ...optionalParameters: unknown[]): void {
    this.logger.trace(this.context(optionalParameters), String(message));
  }

  public warn(message: unknown, ...optionalParameters: unknown[]): void {
    this.logger.warn(this.context(optionalParameters), String(message));
  }

  private context(optionalParameters: unknown[]): { optionalParameters: unknown } {
    return { optionalParameters: redactSensitiveData(optionalParameters) };
  }
}
