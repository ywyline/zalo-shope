import { describe, expect, it } from 'vitest';

import { normalizeMemberPhone } from './auth.service';

describe('normalizeMemberPhone', () => {
  it.each([
    ['0912 345 678', '+84912345678'],
    ['84912345678', '+84912345678'],
    ['+84 912-345-678', '+84912345678'],
    ['138 1234 5678', '+8613812345678'],
    ['8613812345678', '+8613812345678'],
    ['+86 138-1234-5678', '+8613812345678'],
  ])(
    'normalizes a supported mobile number without changing the API contract',
    (input, expected) => {
      expect(normalizeMemberPhone(input)).toBe(expected);
    },
  );

  it.each(['+12025550123', '+447911123456', '12812345678', '0123456789', 'not-a-phone'])(
    'maps an unsupported phone to a sanitized 400 response: %s',
    (input) => {
      let received: unknown;
      try {
        normalizeMemberPhone(input);
      } catch (error) {
        received = error;
      }

      expect(received).toMatchObject({
        message: 'A valid Vietnam or mainland China mobile number is required',
        status: 400,
      });
      expect(String(received)).not.toContain(input);
    },
  );
});
