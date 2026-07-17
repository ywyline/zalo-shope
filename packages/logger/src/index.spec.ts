import { describe, expect, it } from 'vitest';

import { redactSensitiveData } from './index';

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
});
