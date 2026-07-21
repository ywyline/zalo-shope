import { describe, expect, it } from 'vitest';

import { promotionFingerprint } from './cart.service';

type FingerprintLine = {
  applied_rules: Array<{ bucket: string; code: string; version_id: string }>;
  rejected_rules: Array<{
    bucket: string;
    code: string;
    reason: string;
    version_id: string;
  }>;
  sku_code: string;
};

function quote(line: FingerprintLine): Parameters<typeof promotionFingerprint>[0] {
  return { lines: [line] } as unknown as Parameters<typeof promotionFingerprint>[0];
}

describe('cart promotion fingerprints', () => {
  it('ignores target-mismatched rules but tracks applicable rule changes', () => {
    const base: FingerprintLine = {
      applied_rules: [{ bucket: 'ITEM', code: 'item-a', version_id: 'version-a' }],
      rejected_rules: [],
      sku_code: 'sku-a',
    };
    const unrelated = {
      ...base,
      rejected_rules: [
        { bucket: 'ITEM', code: 'other-sku', reason: 'TARGET_MISMATCH', version_id: 'version-b' },
      ],
    };
    const relevant = {
      ...base,
      rejected_rules: [
        { bucket: 'ITEM', code: 'item-a', reason: 'MINIMUM_NOT_MET', version_id: 'version-a' },
      ],
    };

    expect(promotionFingerprint(quote(base), 'sku-a')).toBe(
      promotionFingerprint(quote(unrelated), 'sku-a'),
    );
    expect(promotionFingerprint(quote(base), 'sku-a')).not.toBe(
      promotionFingerprint(quote(relevant), 'sku-a'),
    );
  });
});
