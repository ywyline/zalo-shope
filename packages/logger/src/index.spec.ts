import { createServer, request } from 'node:http';
import { Writable } from 'node:stream';

import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { createHttpLogger, createLogger, NestPinoLogger, redactSensitiveData } from './index';

function captureDestination(chunks: string[]): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });
}

async function captureHttpLog(input: {
  headers?: Record<string, string>;
  path: string;
  responseHeaders?: Record<string, string>;
}): Promise<string> {
  const chunks: string[] = [];
  const httpLogger = createHttpLogger(pino({ level: 'info' }, captureDestination(chunks)));
  const server = createServer((incomingRequest, response) => {
    httpLogger(incomingRequest, response);
    for (const [name, value] of Object.entries(input.responseHeaders ?? {})) {
      response.setHeader(name, value);
    }
    response.end('ok');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test HTTP server did not bind');

  try {
    await new Promise<void>((resolve, reject) => {
      const outgoingRequest = request(
        {
          headers: input.headers,
          host: '127.0.0.1',
          path: input.path,
          port: address.port,
        },
        (response) => {
          response.resume();
          response.on('end', resolve);
        },
      );
      outgoingRequest.on('error', reject);
      outgoingRequest.end();
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  return chunks.join('');
}

describe('audit and log redaction', () => {
  it('recursively redacts sensitive keys while preserving safe context', () => {
    expect(
      redactSensitiveData({
        action: 'member.updated',
        nested: {
          phone: '+84912345678',
          profile: { displayName: 'Lan', refreshToken: 'secret-token' },
        },
        storeId: 'store-1',
      }),
    ).toEqual({
      action: 'member.updated',
      nested: {
        phone: '[REDACTED]',
        profile: { displayName: 'Lan', refreshToken: '[REDACTED]' },
      },
      storeId: 'store-1',
    });
  });

  it('converts audit values to JSON-safe integers and timestamps', () => {
    expect(
      redactSensitiveData({ createdAt: new Date('2026-07-17T00:00:00.000Z'), price: 249000n }),
    ).toEqual({ createdAt: '2026-07-17T00:00:00.000Z', price: 249000 });
  });

  it('uses JSON-backed scalar representations instead of enumerable implementation details', () => {
    class DecimalLike {
      public toJSON(): string {
        return '30.5';
      }
    }

    expect(redactSensitiveData({ decimal: new DecimalLike() })).toEqual({ decimal: '30.5' });
  });

  it('redacts credentials from the renamed HTTP request and response log objects', async () => {
    const secrets = {
      authorization: 'Bearer M37_AUTHORIZATION_SECRET',
      cookie: 'session=M37_COOKIE_SECRET',
      refreshToken: 'M37_REFRESH_TOKEN_SECRET',
      responseCookie: 'session=M37_RESPONSE_COOKIE_SECRET',
      zaloAccessToken: 'M37_ZALO_ACCESS_SECRET',
      zaloPhoneToken: 'M37_ZALO_PHONE_SECRET',
    } as const;
    const serializedLogs = await captureHttpLog({
      headers: {
        authorization: secrets.authorization,
        cookie: secrets.cookie,
        'x-refresh-token': secrets.refreshToken,
        'x-zalo-access-token': secrets.zaloAccessToken,
        'x-zalo-phone-token': secrets.zaloPhoneToken,
      },
      path: '/',
      responseHeaders: { 'set-cookie': secrets.responseCookie },
    });
    for (const secret of Object.values(secrets)) expect(serializedLogs).not.toContain(secret);
    expect(serializedLogs).toContain('[REDACTED]');
  });

  it('logs the HTTP pathname without query values', async () => {
    const phone = '0912345678';
    const token = 'M37_QUERY_TOKEN_SECRET';
    const serializedLogs = await captureHttpLog({
      path: `/v1/search/products?q=${phone}&token=${token}`,
    });
    const log = JSON.parse(serializedLogs.trim()) as { request?: { url?: string } };

    expect(log.request?.url).toBe('/v1/search/products');
    expect(serializedLogs).not.toContain(phone);
    expect(serializedLogs).not.toContain(token);
  });

  it('removes secrets from URL-bearing and dynamically named HTTP headers', async () => {
    const secrets = {
      apiKey: 'M37_API_KEY_SECRET',
      locationCode: 'M37_LOCATION_CODE_SECRET',
      refererToken: 'M37_REFERER_TOKEN_SECRET',
      responseToken: 'M37_RESPONSE_TOKEN_SECRET',
    } as const;
    const serializedLogs = await captureHttpLog({
      headers: {
        referer: `https://shop.invalid/member?token=${secrets.refererToken}#profile`,
        'x-api-key': secrets.apiKey,
      },
      path: '/',
      responseHeaders: {
        location: `/auth/callback?code=${secrets.locationCode}#token=${secrets.responseToken}`,
        'x-session-token': secrets.responseToken,
      },
    });
    const log = JSON.parse(serializedLogs.trim()) as {
      request?: { headers?: Record<string, string> };
      response?: { headers?: Record<string, string> };
    };

    expect(log.request?.headers?.referer).toBe('https://shop.invalid/member');
    expect(log.response?.headers?.location).toBe('/auth/callback');
    expect(log.request?.headers?.['x-api-key']).toBe('[REDACTED]');
    expect(log.response?.headers?.['x-session-token']).toBe('[REDACTED]');
    for (const secret of Object.values(secrets)) expect(serializedLogs).not.toContain(secret);
  });

  it('replaces unsafe correlation IDs and redacts request network identity', async () => {
    const secrets = {
      correlation: 'token=M37_CORRELATION_SECRET',
      forwarded: 'for=203.0.113.42;proto=https',
      forwardedFor: '203.0.113.43',
      realIp: '203.0.113.44',
    } as const;
    const serializedLogs = await captureHttpLog({
      headers: {
        forwarded: secrets.forwarded,
        'x-correlation-id': secrets.correlation,
        'x-forwarded-for': secrets.forwardedFor,
        'x-real-ip': secrets.realIp,
      },
      path: '/',
    });
    const log = JSON.parse(serializedLogs.trim()) as {
      request?: {
        headers?: Record<string, string>;
        id?: string;
        remoteAddress?: string;
        remotePort?: string;
      };
    };

    expect(log.request?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(log.request?.headers?.['x-correlation-id']).toBe('[REDACTED]');
    expect(log.request?.headers?.forwarded).toBe('[REDACTED]');
    expect(log.request?.headers?.['x-forwarded-for']).toBe('[REDACTED]');
    expect(log.request?.headers?.['x-real-ip']).toBe('[REDACTED]');
    expect(log.request?.remoteAddress).toBe('[REDACTED]');
    expect(log.request?.remotePort).toBe('[REDACTED]');
    for (const secret of Object.values(secrets)) expect(serializedLogs).not.toContain(secret);
  });

  it('redacts sensitive keys from Nest logger optional parameters', () => {
    const chunks: string[] = [];
    const logger = new NestPinoLogger(pino({ level: 'info' }, captureDestination(chunks)));
    const phone = '+84912345678';
    const token = 'M37_NEST_TOKEN_SECRET';

    logger.log('Member context', {
      nested: { accessToken: token },
      phone,
      storeId: 'store-1',
    });

    const serializedLogs = chunks.join('');
    expect(serializedLogs).not.toContain(phone);
    expect(serializedLogs).not.toContain(token);
    expect(serializedLogs).toContain('store-1');
    expect(serializedLogs).toContain('[REDACTED]');
  });

  it('redacts sensitive keys from direct structured logger calls', () => {
    const chunks: string[] = [];
    const logger = createLogger('m37-test', 'info', captureDestination(chunks));
    logger.info(
      { nested: { accessToken: 'M37_DIRECT_TOKEN' }, phone: '+84912345678', storeId: 'store-1' },
      'direct context',
    );
    const serializedLogs = chunks.join('');
    expect(serializedLogs).not.toContain('M37_DIRECT_TOKEN');
    expect(serializedLogs).not.toContain('+84912345678');
    expect(serializedLogs).toContain('store-1');
  });

  it('preserves Error diagnostics while redacting sensitive custom fields', () => {
    const chunks: string[] = [];
    const logger = createLogger('m37-test', 'info', captureDestination(chunks));
    const error = Object.assign(new Error('inventory expiry failed'), {
      code: 'INVENTORY_FAILURE',
      token: 'M37_ERROR_TOKEN',
    });

    logger.error({ err: error }, 'worker failure');

    const log = JSON.parse(chunks.join('')) as {
      err?: { code?: string; message?: string; name?: string; stack?: string; token?: string };
    };
    expect(log.err).toMatchObject({
      code: 'INVENTORY_FAILURE',
      message: 'inventory expiry failed',
      name: 'Error',
      token: '[REDACTED]',
    });
    expect(log.err?.stack).toContain('inventory expiry failed');
    expect(chunks.join('')).not.toContain('M37_ERROR_TOKEN');
  });

  it('removes query secrets from Error, URL and direct message values', () => {
    const chunks: string[] = [];
    const logger = createLogger('m37-test', 'info', captureDestination(chunks));
    const secret = 'M37_LOG_QUERY_SECRET';
    const target = `https://shop.invalid/callback?token=${secret}#done`;

    logger.error({ err: new Error(`Request failed for ${target}`), target: new URL(target) });
    logger.warn(`Retrying ${target}`);

    const serializedLogs = chunks.join('');
    expect(serializedLogs).not.toContain(secret);
    expect(serializedLogs).not.toContain('?token=');
    expect(serializedLogs).toContain('https://shop.invalid/callback');
  });

  it('removes URL credentials and prefixed sensitive assignments', () => {
    const chunks: string[] = [];
    const logger = createLogger('m37-test', 'info', captureDestination(chunks));
    const secrets = {
      cookie: 'M37_COOKIE_VALUE',
      database: 'M37_DATABASE_PASSWORD',
      refresh: 'M37_REFRESH_VALUE',
      url: 'M37_URL_PASSWORD',
    } as const;

    logger.info({
      databaseUrl: `postgresql://runtime:${secrets.database}@db.invalid/shop`,
      target: new URL(`https://member:${secrets.url}@shop.invalid/account`),
    });
    logger.info(`cookie=${secrets.cookie} refreshToken=${secrets.refresh}`);

    const serializedLogs = chunks.join('');
    for (const secret of Object.values(secrets)) expect(serializedLogs).not.toContain(secret);
    expect(serializedLogs).toContain('postgresql://db.invalid/shop');
    expect(serializedLogs).toContain('https://shop.invalid/account');
    expect(serializedLogs).toContain('cookie=[REDACTED]');
    expect(serializedLogs).toContain('refreshToken=[REDACTED]');
  });

  it('marks circular structured context without throwing', () => {
    const chunks: string[] = [];
    const logger = createLogger('m37-test', 'info', captureDestination(chunks));
    const context: { self?: unknown; storeId: string } = { storeId: 'store-1' };
    context.self = context;

    expect(() => logger.info(context, 'circular context')).not.toThrow();
    const log = JSON.parse(chunks.join('')) as { self?: string; storeId?: string };
    expect(log).toMatchObject({ self: '[Circular]', storeId: 'store-1' });
  });
});
