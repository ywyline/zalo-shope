import { createServer, request } from 'node:http';
import { Writable } from 'node:stream';

import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { createHttpLogger, redactSensitiveData } from './index';

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
    const chunks: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk.toString('utf8'));
        callback();
      },
    });
    const httpLogger = createHttpLogger(pino({ level: 'info' }, destination));
    const secrets = {
      authorization: 'Bearer M37_AUTHORIZATION_SECRET',
      cookie: 'session=M37_COOKIE_SECRET',
      refreshToken: 'M37_REFRESH_TOKEN_SECRET',
      responseCookie: 'session=M37_RESPONSE_COOKIE_SECRET',
      zaloAccessToken: 'M37_ZALO_ACCESS_SECRET',
      zaloPhoneToken: 'M37_ZALO_PHONE_SECRET',
    } as const;
    const server = createServer((incomingRequest, response) => {
      httpLogger(incomingRequest, response);
      response.setHeader('set-cookie', secrets.responseCookie);
      response.end('ok');
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test HTTP server did not bind');

    try {
      await new Promise<void>((resolve, reject) => {
        const outgoingRequest = request(
          {
            headers: {
              authorization: secrets.authorization,
              cookie: secrets.cookie,
              'x-refresh-token': secrets.refreshToken,
              'x-zalo-access-token': secrets.zaloAccessToken,
              'x-zalo-phone-token': secrets.zaloPhoneToken,
            },
            host: '127.0.0.1',
            path: '/',
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

    const serializedLogs = chunks.join('');
    for (const secret of Object.values(secrets)) expect(serializedLogs).not.toContain(secret);
    expect(serializedLogs).toContain('[REDACTED]');
  });
});
