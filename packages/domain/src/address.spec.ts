import { describe, expect, it } from 'vitest';

import { isRemoteProvince, normalizeAddressFields } from './address';

describe('M4 address normalization', () => {
  it('normalizes codes and detail whitespace', () => {
    expect(
      normalizeAddressFields({
        provinceCode: ' HN ',
        districtCode: ' ba-dinh ',
        wardCode: '  phuc-xa ',
        detail: '  12   Nguyen   Trai  ',
      }),
    ).toEqual({
      detail: '12 Nguyen Trai',
      districtCode: 'ba-dinh',
      provinceCode: 'hn',
      wardCode: 'phuc-xa',
    });
  });

  it('matches remote provinces by normalized code', () => {
    expect(isRemoteProvince(' HN ', ['hn', 'dn'])).toBe(true);
  });
});
