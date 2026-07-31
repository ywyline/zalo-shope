import type { RuntimeConfig } from '@zalo-shop/config';
import { encryptSensitive } from '@zalo-shop/security';
import { describe, expect, it } from 'vitest';

import {
  AfterSaleProjectionError,
  AfterSalesProjector,
  createAfterSaleReadSelect,
  type AfterSaleReadRecord,
} from './after-sales-projector';

const encryptionKey = Buffer.alloc(32, 6).toString('base64');
const projector = new AfterSalesProjector({
  PII_ENCRYPTION_KEY: encryptionKey,
} as RuntimeConfig);

function fixture(): AfterSaleReadRecord {
  const createdAt = new Date('2026-07-28T08:00:00.000Z');
  return {
    approvedTotalVnd: 100_000n,
    createdAt,
    currency: 'VND',
    evidenceFiles: [
      {
        claimDeadlineAt: null,
        id: '40000000-0000-4000-8000-000000000001',
        ordinaryAccessDeadlineAt: new Date('2026-07-29T08:00:00.000Z'),
        retentionDeadlineAt: new Date('2026-08-28T08:00:00.000Z'),
        status: 'READY',
        version: 2,
      },
    ],
    id: '30000000-0000-4000-8000-000000000001',
    items: [
      {
        acceptedQuantity: 0,
        approvedQuantity: 1,
        orderItemId: 'a0000000-0000-4000-8000-000000000001',
        receivedQuantity: 0,
        rejectedQuantity: 0,
        replacementSkuId: null,
        requestedQuantity: 1,
        restockableQuantity: 0,
        restoredQuantity: 0,
      },
    ],
    legacyPolicyReview: false,
    memberId: '20000000-0000-4000-8000-000000000001',
    orderId: '90000000-0000-4000-8000-000000000001',
    policy: { code: 'standard-return' },
    policyVersion: {
      localizations: [
        {
          buyerInstructions: 'Gửi hàng theo hướng dẫn.',
          locale: 'vi',
          name: 'Chính sách Việt Nam',
          summary: 'Tóm tắt Việt Nam',
        },
      ],
      versionNumber: 1,
    },
    publicCaseNumber: 'ASC-0123456789ABCDEF',
    reasonCode: 'damaged-item',
    requestedItemVnd: 90_000n,
    requestedOtherVnd: 0n,
    requestedShippingVnd: 10_000n,
    requestedTotalVnd: 100_000n,
    reasonDetailCiphertext: encryptSensitive('Hộp sản phẩm bị hư hỏng.', encryptionKey),
    returnDeadlineAt: new Date('2026-08-04T08:00:00.000Z'),
    returnShipments: [
      {
        carrierName: 'GHN',
        status: 'SUBMITTED',
        submittedAt: createdAt,
        trackingNumberMasked: 'GH********89',
      },
    ],
    settlements: [
      {
        amountVnd: 100_000n,
        method: 'ONLINE_ORIGINAL',
        publicSettlementNumber: 'AST-0123456789ABCDEF',
        refunds: [{ refund: { publicRefundNumber: 'RFD-0123456789ABCDEF' } }],
        requestedAt: createdAt,
        status: 'PROCESSING',
        updatedAt: new Date('2026-07-28T08:01:00.000Z'),
      },
    ],
    status: 'APPROVED',
    storeId: '10000000-0000-4000-8000-000000000001',
    transitions: [
      {
        createdAt,
        event: 'APPROVE',
        toStatus: 'APPROVED',
      },
    ],
    type: 'RETURN_REFUND',
    updatedAt: new Date('2026-07-28T08:01:00.000Z'),
    version: 2,
  };
}

describe('AfterSalesProjector', () => {
  it('uses a strict database select that never reads restricted evidence, finance or audit columns', () => {
    const selection = createAfterSaleReadSelect('zh');
    expect(selection.policyVersion.select.localizations.where.locale.in).toEqual(['zh', 'vi']);
    const serialized = JSON.stringify(selection);
    expect(serialized).toContain('reasonDetailCiphertext');
    for (const restricted of [
      'objectKey',
      'derivativeObjectKeys',
      'scanTemporaryObjectKey',
      'scanResultCode',
      'originalFilename',
      'reviewReason',
      'reviewedBy',
      'policyHash',
      'policySnapshot',
      'transferReferenceDigest',
      'transferEvidenceCiphertext',
      'requestedBy',
      'confirmedBy',
      'trackingNumberDigest',
      'submittedBy',
      'actorId',
      'reason',
      'correlationId',
    ]) {
      expect(serialized).not.toContain(`"${restricted}"`);
    }
  });

  it('returns schema-validated wire strings, Vietnamese fallback and only public refund facts', () => {
    const response = projector.project(fixture(), 'zh', new Date('2026-07-28T09:00:00.000Z'));
    expect(response.policy_snapshot).toMatchObject({
      name: 'Chính sách Việt Nam',
      resolved_locale: 'vi',
    });
    expect(response.reason_detail).toBe('Hộp sản phẩm bị hư hỏng.');
    expect(response.created_at).toBe('2026-07-28T08:00:00.000Z');
    expect(response).toMatchObject({
      requested_item_vnd: 90_000,
      requested_other_vnd: 0,
      requested_shipping_vnd: 10_000,
      requested_total_vnd: 100_000,
    });
    expect(response.evidence[0]).toEqual({
      access_expires_at: '2026-07-29T08:00:00.000Z',
      evidence_id: '40000000-0000-4000-8000-000000000001',
      status: 'READY',
      version: 2,
    });
    expect(response.settlements[0]?.refund_public_number).toBe('RFD-0123456789ABCDEF');
    expect(response.return_shipments[0]?.masked_tracking_number).toBe('GH********89');
    expect(JSON.stringify(response)).not.toContain('Ciphertext');
  });

  it('collapses evidence at the exclusive deadline and all non-public internal states', () => {
    const record = fixture();
    const evidence = record.evidenceFiles[0];
    if (!evidence?.ordinaryAccessDeadlineAt) throw new Error('fixture evidence is incomplete');
    const deadline = evidence.ordinaryAccessDeadlineAt;
    expect(projector.project(record, 'vi', deadline).evidence[0]).toEqual({
      access_expires_at: null,
      evidence_id: evidence.id,
      status: 'UNAVAILABLE',
      version: 2,
    });
    const readyUnclaimed = {
      ...evidence,
      claimDeadlineAt: new Date('2026-07-28T10:00:00.000Z'),
      ordinaryAccessDeadlineAt: null,
      retentionDeadlineAt: null,
      status: 'READY_UNCLAIMED' as const,
    };
    record.evidenceFiles[0] = readyUnclaimed;
    expect(
      projector.project(record, 'vi', new Date('2026-07-28T09:00:00.000Z')).evidence[0],
    ).toMatchObject({
      access_expires_at: '2026-07-28T10:00:00.000Z',
      status: 'READY',
    });
    record.evidenceFiles[0] = {
      ...readyUnclaimed,
      retentionDeadlineAt: new Date('2026-08-28T08:00:00.000Z'),
      status: 'QUARANTINED',
    };
    expect(projector.project(record, 'vi').evidence[0]).toMatchObject({
      access_expires_at: null,
      status: 'UNAVAILABLE',
    });
  });

  it('returns all-null legacy policy fields and fails closed on incomplete immutable snapshots', () => {
    const legacy = fixture();
    legacy.legacyPolicyReview = true;
    legacy.policy = null;
    legacy.policyVersion = null;
    expect(projector.project(legacy, 'en').policy_snapshot).toEqual({
      buyer_instructions: null,
      legacy_policy_review: true,
      name: null,
      policy_code: null,
      policy_version_number: null,
      resolved_locale: null,
      summary: null,
    });

    const missingPolicy = fixture();
    missingPolicy.policy = null;
    expect(() => projector.project(missingPolicy, 'vi')).toThrow(AfterSaleProjectionError);
    const missingVietnamese = fixture();
    missingVietnamese.policyVersion!.localizations = [
      {
        buyerInstructions: 'Use the target-language instructions.',
        locale: 'en',
        name: 'English policy',
        summary: 'English summary',
      },
    ];
    expect(() => projector.project(missingVietnamese, 'en')).toThrow(AfterSaleProjectionError);
  });

  it('accepts only safe integer VND and a single public refund link', () => {
    const maximum = fixture();
    maximum.approvedTotalVnd = BigInt(Number.MAX_SAFE_INTEGER);
    maximum.settlements[0]!.amountVnd = BigInt(Number.MAX_SAFE_INTEGER);
    expect(projector.project(maximum, 'vi').approved_refund_vnd).toBe(Number.MAX_SAFE_INTEGER);
    const negative = fixture();
    negative.approvedTotalVnd = -1n;
    expect(() => projector.project(negative, 'vi')).toThrow(AfterSaleProjectionError);
    const overflow = fixture();
    overflow.settlements[0]!.amountVnd = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    expect(() => projector.project(overflow, 'vi')).toThrow(AfterSaleProjectionError);
    const inconsistentRequestedTotal = fixture();
    inconsistentRequestedTotal.requestedTotalVnd = 99_999n;
    expect(() => projector.project(inconsistentRequestedTotal, 'vi')).toThrow();
    const duplicateLink = fixture();
    duplicateLink.settlements[0]!.refunds.push({
      refund: { publicRefundNumber: 'RFD-1123456789ABCDEF' },
    });
    expect(() => projector.project(duplicateLink, 'vi')).toThrow(AfterSaleProjectionError);
  });

  it('fails closed when decrypted data or public timeline facts violate the response contract', () => {
    const missingReason = fixture();
    missingReason.reasonDetailCiphertext = null;
    expect(() => projector.project(missingReason, 'vi')).toThrow(AfterSaleProjectionError);
    const malformedCiphertext = fixture();
    malformedCiphertext.reasonDetailCiphertext = 'not-valid-ciphertext';
    expect(() => projector.project(malformedCiphertext, 'vi')).toThrow();
    const internalTimelineEvent = fixture();
    internalTimelineEvent.transitions[0]!.event = 'PRIVATE_INTERNAL_EVENT';
    expect(() => projector.project(internalTimelineEvent, 'vi')).toThrow();
  });
});
