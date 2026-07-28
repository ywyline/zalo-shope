import { describe, expect, it } from 'vitest';

import {
  assertAfterSaleEvidenceAccessAllowed,
  assertAfterSaleQuantityAvailable,
  assertAfterSaleRefundAmountAllowed,
  assertAfterSaleReturnWindowOpen,
  assertEquivalentExchange,
  assertInventoryRestoreAllowed,
  calculateAfterSaleReturnDeadlineEpochMs,
  calculateOrderItemRefundAllocationVnd,
  calculateRemainingAfterSaleRefundVnd,
  doesAfterSaleQuantityOccupyCapacity,
  resolveAfterSaleReview,
  resolveLegacyAfterSaleReview,
  summarizeCompleteAfterSaleInspection,
  transitionAfterSale,
  transitionAfterSaleAfterInspection,
  transitionAfterSaleCodRefundConfirmed,
  transitionAfterSaleCodRefundQueued,
  transitionAfterSaleEvidence,
  transitionAfterSaleEvidenceDeletionAttempt,
  transitionAfterSaleEvidenceDeletionDue,
  transitionAfterSaleOnlineRefundRequested,
  transitionAfterSaleRefundReleased,
  transitionAfterSaleReturnExpired,
  transitionAfterSaleReturnShipment,
  transitionExchangeToRefund,
} from './after-sales';

describe('M6 after-sale state machine', () => {
  it('keeps refund-only, return-refund and exchange paths distinct', () => {
    expect(transitionAfterSale('REFUND_ONLY', 'PENDING_REVIEW', 'APPROVE')).toBe('APPROVED');
    expect(transitionAfterSale('REFUND_ONLY', 'APPROVED', 'QUEUE_REFUND')).toBe('REFUND_PENDING');
    expect(() => transitionAfterSale('RETURN_REFUND', 'APPROVED', 'START_RETURN')).toThrow(
      'AFTER_SALE_RETURN_WINDOW_INVALID',
    );
    const inspection = {
      approvedItems: [{ approvedQuantity: 1, orderItemId: 'line-1' }],
      inspectedItems: [
        {
          dispositions: [{ disposition: 'RESTOCK_SELLABLE' as const, quantity: 1 }],
          orderItemId: 'line-1',
          receivedQuantity: 1,
        },
      ],
    };
    expect(
      transitionAfterSaleAfterInspection('RETURN_REFUND', 'RETURN_IN_TRANSIT', inspection),
    ).toEqual({
      events: ['RETURN_RECEIVED', 'ACCEPT_INSPECTION'],
      status: 'REFUND_PENDING',
    });
    expect(transitionAfterSaleAfterInspection('EXCHANGE', 'RETURN_IN_TRANSIT', inspection)).toEqual(
      {
        events: ['RETURN_RECEIVED', 'ACCEPT_INSPECTION'],
        status: 'EXCHANGE_PENDING',
      },
    );
    expect(() =>
      transitionAfterSale('RETURN_REFUND', 'INSPECTION_PENDING', 'ACCEPT_INSPECTION'),
    ).toThrow('AFTER_SALE_INSPECTION_INVALID');
  });

  it('rejects type-confused jumps and terminal reopening', () => {
    expect(() => transitionAfterSale('REFUND_ONLY', 'APPROVED', 'START_RETURN')).toThrow(
      'AFTER_SALE_RETURN_WINDOW_INVALID',
    );
    expect(() => transitionAfterSale('EXCHANGE', 'APPROVED', 'QUEUE_REFUND')).toThrow(
      'AFTER_SALE_STATE_CONFLICT',
    );
    expect(() => transitionAfterSale('RETURN_REFUND', 'COMPLETED', 'APPROVE')).toThrow(
      'AFTER_SALE_STATE_CONFLICT',
    );
    expect(() => transitionAfterSale('RETURN_REFUND', 'REFUNDED', 'REQUIRE_REVIEW')).toThrow(
      'AFTER_SALE_STATE_CONFLICT',
    );
  });

  it('routes uncertain facts to manual review without guessing success', () => {
    expect(transitionAfterSale('RETURN_REFUND', 'RETURN_IN_TRANSIT', 'REQUIRE_REVIEW')).toBe(
      'REVIEW_REQUIRED',
    );
    expect(transitionAfterSale('MERCHANT_REFUND', 'REFUND_PROCESSING', 'REQUIRE_REVIEW')).toBe(
      'REVIEW_REQUIRED',
    );
  });

  it('freezes multi-event return and refund command timelines', () => {
    expect(
      transitionAfterSaleReturnShipment('RETURN_REFUND', 'APPROVED', {
        nowEpochMs: 999,
        returnDeadlineEpochMs: 1_000,
      }),
    ).toEqual({ events: ['START_RETURN', 'RETURN_SHIPPED'], status: 'RETURN_IN_TRANSIT' });
    expect(transitionAfterSaleOnlineRefundRequested('REFUND_ONLY', 'APPROVED')).toEqual({
      events: ['QUEUE_REFUND', 'REFUND_REQUESTED'],
      status: 'REFUND_PROCESSING',
    });
    expect(transitionAfterSaleOnlineRefundRequested('RETURN_REFUND', 'REFUND_PENDING')).toEqual({
      events: ['REFUND_REQUESTED'],
      status: 'REFUND_PROCESSING',
    });
    expect(transitionAfterSaleCodRefundQueued('REFUND_ONLY', 'APPROVED')).toEqual({
      events: ['QUEUE_REFUND'],
      status: 'REFUND_PENDING',
    });
    expect(transitionAfterSaleCodRefundConfirmed('RETURN_REFUND', 'REFUND_PENDING')).toEqual({
      events: ['REFUND_REQUESTED', 'REFUND_SUCCEEDED'],
      status: 'REFUNDED',
    });
    expect(transitionAfterSaleRefundReleased('REFUND_ONLY', 'REFUND_PROCESSING', 'FAILED')).toEqual(
      {
        events: ['REFUND_FAILED'],
        status: 'REFUND_PENDING',
      },
    );
    expect(
      transitionAfterSaleRefundReleased('RETURN_REFUND', 'REFUND_PROCESSING', 'CANCELLED'),
    ).toEqual({ events: ['REFUND_CANCELLED'], status: 'REFUND_PENDING' });
    expect(transitionExchangeToRefund('EXCHANGE', 'EXCHANGE_PENDING', false)).toEqual({
      events: ['CONVERT_EXCHANGE_TO_REFUND'],
      status: 'REFUND_PENDING',
    });
    expect(() => transitionExchangeToRefund('EXCHANGE', 'EXCHANGE_PENDING', true)).toThrow(
      'AFTER_SALE_EXCHANGE_NOT_ALLOWED',
    );
  });

  it('closes an unshipped return exactly at the frozen deadline', () => {
    expect(
      calculateAfterSaleReturnDeadlineEpochMs({
        approvedAtEpochMs: Date.UTC(2026, 6, 27, 3),
        returnWindowDays: 7,
      }),
    ).toBe(Date.UTC(2026, 7, 3, 17));
    expect(
      calculateAfterSaleReturnDeadlineEpochMs({
        approvedAtEpochMs: Date.UTC(2026, 6, 27, 16, 59),
        returnWindowDays: 1,
      }),
    ).toBe(Date.UTC(2026, 6, 28, 17));
    expect(
      calculateAfterSaleReturnDeadlineEpochMs({
        approvedAtEpochMs: Date.UTC(2026, 6, 27, 17, 1),
        returnWindowDays: 1,
      }),
    ).toBe(Date.UTC(2026, 6, 29, 17));
    expect(() =>
      assertAfterSaleReturnWindowOpen({ nowEpochMs: 999, returnDeadlineEpochMs: 1_000 }),
    ).not.toThrow();
    expect(() =>
      assertAfterSaleReturnWindowOpen({ nowEpochMs: 1_000, returnDeadlineEpochMs: 1_000 }),
    ).toThrow('AFTER_SALE_RETURN_WINDOW_CLOSED');
    expect(
      transitionAfterSaleReturnExpired('RETURN_REFUND', 'APPROVED', {
        hasIrreversibleOrUncertainSideEffects: false,
        nowEpochMs: 1_000,
        returnDeadlineEpochMs: 1_000,
      }),
    ).toEqual({ events: ['RETURN_EXPIRED'], status: 'REJECTED' });
    expect(() =>
      transitionAfterSaleReturnShipment('RETURN_REFUND', 'APPROVED', {
        nowEpochMs: 1_000,
        returnDeadlineEpochMs: 1_000,
      }),
    ).toThrow('AFTER_SALE_RETURN_WINDOW_CLOSED');
    expect(() =>
      transitionAfterSaleReturnExpired('RETURN_REFUND', 'APPROVED', {
        hasIrreversibleOrUncertainSideEffects: false,
        nowEpochMs: 999,
        returnDeadlineEpochMs: 1_000,
      }),
    ).toThrow('AFTER_SALE_RETURN_WINDOW_INVALID');
    expect(() =>
      transitionAfterSaleReturnExpired('RETURN_REFUND', 'APPROVED', {
        hasIrreversibleOrUncertainSideEffects: true,
        nowEpochMs: 1_000,
        returnDeadlineEpochMs: 1_000,
      }),
    ).toThrow('AFTER_SALE_RETURN_WINDOW_INVALID');
  });

  it('resumes manual review only to the recorded, type-compatible state', () => {
    expect(
      resolveAfterSaleReview({
        current: 'REVIEW_REQUIRED',
        hasIrreversibleOrUncertainSideEffects: true,
        legacyPolicyReview: false,
        recordedResumeStatus: 'REFUND_PROCESSING',
        target: 'REFUND_PROCESSING',
        type: 'RETURN_REFUND',
      }),
    ).toEqual({ event: 'RESUME_REVIEW', status: 'REFUND_PROCESSING' });
    expect(() =>
      resolveAfterSaleReview({
        current: 'REVIEW_REQUIRED',
        hasIrreversibleOrUncertainSideEffects: false,
        legacyPolicyReview: false,
        recordedResumeStatus: 'REFUND_PROCESSING',
        target: 'EXCHANGE_PENDING',
        type: 'RETURN_REFUND',
      }),
    ).toThrow('AFTER_SALE_STATE_CONFLICT');
    expect(() =>
      resolveAfterSaleReview({
        current: 'REVIEW_REQUIRED',
        hasIrreversibleOrUncertainSideEffects: false,
        legacyPolicyReview: false,
        recordedResumeStatus: 'RETURN_PENDING',
        target: 'REJECTED',
        type: 'REFUND_ONLY',
      }),
    ).toThrow('AFTER_SALE_STATE_CONFLICT');
    expect(
      resolveAfterSaleReview({
        current: 'REVIEW_REQUIRED',
        hasIrreversibleOrUncertainSideEffects: false,
        legacyPolicyReview: false,
        recordedResumeStatus: 'APPROVED',
        target: 'REJECTED',
        type: 'REFUND_ONLY',
      }),
    ).toEqual({ event: 'REJECT_REVIEW', status: 'REJECTED' });
    expect(() =>
      resolveAfterSaleReview({
        current: 'REVIEW_REQUIRED',
        hasIrreversibleOrUncertainSideEffects: false,
        legacyPolicyReview: false,
        recordedResumeStatus: 'EXCHANGE_PENDING',
        target: 'EXCHANGE_PENDING',
        type: 'REFUND_ONLY',
      }),
    ).toThrow('AFTER_SALE_STATE_CONFLICT');
    expect(() =>
      resolveAfterSaleReview({
        current: 'REVIEW_REQUIRED',
        hasIrreversibleOrUncertainSideEffects: true,
        legacyPolicyReview: false,
        recordedResumeStatus: 'REFUND_PROCESSING',
        target: 'REJECTED',
        type: 'REFUND_ONLY',
      }),
    ).toThrow('AFTER_SALE_STATE_CONFLICT');
    expect(
      resolveAfterSaleReview({
        current: 'REVIEW_REQUIRED',
        hasIrreversibleOrUncertainSideEffects: false,
        legacyPolicyReview: false,
        recordedResumeStatus: 'APPROVED',
        target: 'APPROVED',
        type: 'RETURN_REFUND',
      }),
    ).toEqual({ event: 'RESUME_REVIEW', status: 'APPROVED' });
    expect(() =>
      resolveAfterSaleReview({
        current: 'REVIEW_REQUIRED',
        hasIrreversibleOrUncertainSideEffects: true,
        legacyPolicyReview: false,
        recordedResumeStatus: 'APPROVED',
        target: 'REJECTED',
        type: 'REFUND_ONLY',
      }),
    ).toThrow('AFTER_SALE_STATE_CONFLICT');
    expect(() =>
      resolveAfterSaleReview({
        current: 'REVIEW_REQUIRED',
        hasIrreversibleOrUncertainSideEffects: false,
        legacyPolicyReview: false,
        recordedResumeStatus: 'REJECTED',
        target: 'REJECTED',
        type: 'REFUND_ONLY',
      }),
    ).toThrow('AFTER_SALE_STATE_CONFLICT');
    expect(() =>
      resolveAfterSaleReview({
        current: 'REVIEW_REQUIRED',
        hasIrreversibleOrUncertainSideEffects: false,
        legacyPolicyReview: true,
        recordedResumeStatus: 'APPROVED',
        target: 'APPROVED',
        type: 'RETURN_REFUND',
      }),
    ).toThrow('AFTER_SALE_STATE_CONFLICT');
  });

  it('resolves a legacy policy gap with one explicit audited decision', () => {
    expect(
      resolveLegacyAfterSaleReview({
        current: 'REVIEW_REQUIRED',
        hasIrreversibleOrUncertainSideEffects: false,
        legacyDecisionRecorded: false,
        legacyPolicyReview: true,
        returnShippingPayer: 'MERCHANT',
        returnWindowDays: 14,
        target: 'APPROVED',
        type: 'RETURN_REFUND',
      }),
    ).toEqual({ event: 'LEGACY_APPROVE', status: 'APPROVED' });
    for (const type of ['REFUND_ONLY', 'MERCHANT_REFUND'] as const) {
      expect(
        resolveLegacyAfterSaleReview({
          current: 'REVIEW_REQUIRED',
          hasIrreversibleOrUncertainSideEffects: false,
          legacyDecisionRecorded: false,
          legacyPolicyReview: true,
          returnShippingPayer: null,
          returnWindowDays: null,
          target: 'APPROVED',
          type,
        }),
      ).toEqual({ event: 'LEGACY_APPROVE', status: 'APPROVED' });
    }
    expect(
      resolveLegacyAfterSaleReview({
        current: 'REVIEW_REQUIRED',
        hasIrreversibleOrUncertainSideEffects: false,
        legacyDecisionRecorded: false,
        legacyPolicyReview: true,
        returnShippingPayer: 'BUYER',
        returnWindowDays: 7,
        target: 'APPROVED',
        type: 'EXCHANGE',
      }),
    ).toEqual({ event: 'LEGACY_APPROVE', status: 'APPROVED' });
    expect(
      resolveLegacyAfterSaleReview({
        current: 'REVIEW_REQUIRED',
        hasIrreversibleOrUncertainSideEffects: false,
        legacyDecisionRecorded: false,
        legacyPolicyReview: true,
        returnShippingPayer: null,
        returnWindowDays: null,
        target: 'REJECTED',
        type: 'RETURN_REFUND',
      }),
    ).toEqual({ event: 'LEGACY_REJECT', status: 'REJECTED' });
    expect(() =>
      resolveLegacyAfterSaleReview({
        current: 'REVIEW_REQUIRED',
        hasIrreversibleOrUncertainSideEffects: false,
        legacyDecisionRecorded: false,
        legacyPolicyReview: false,
        returnShippingPayer: 'MERCHANT',
        returnWindowDays: 14,
        target: 'APPROVED',
        type: 'RETURN_REFUND',
      }),
    ).toThrow('AFTER_SALE_STATE_CONFLICT');
    expect(() =>
      resolveLegacyAfterSaleReview({
        current: 'REVIEW_REQUIRED',
        hasIrreversibleOrUncertainSideEffects: false,
        legacyDecisionRecorded: true,
        legacyPolicyReview: true,
        returnShippingPayer: null,
        returnWindowDays: null,
        target: 'APPROVED',
        type: 'REFUND_ONLY',
      }),
    ).toThrow('AFTER_SALE_STATE_CONFLICT');
    expect(() =>
      resolveLegacyAfterSaleReview({
        current: 'REVIEW_REQUIRED',
        hasIrreversibleOrUncertainSideEffects: false,
        legacyDecisionRecorded: false,
        legacyPolicyReview: true,
        returnShippingPayer: 'BUYER',
        returnWindowDays: 7,
        target: 'APPROVED',
        type: 'REFUND_ONLY',
      }),
    ).toThrow('AFTER_SALE_STATE_CONFLICT');
  });

  it('claims evidence only after a successful scan and never reuses it', () => {
    expect(transitionAfterSaleEvidence('PENDING', 'SCAN_PASSED')).toBe('READY_UNCLAIMED');
    expect(transitionAfterSaleEvidence('READY_UNCLAIMED', 'CLAIM')).toBe('READY');
    expect(transitionAfterSaleEvidence('PENDING', 'QUARANTINE')).toBe('QUARANTINED');
    expect(() => transitionAfterSaleEvidence('PENDING', 'CLAIM')).toThrow(
      'AFTER_SALE_STATE_CONFLICT',
    );
    expect(() => transitionAfterSaleEvidence('READY', 'CLAIM')).toThrow(
      'AFTER_SALE_STATE_CONFLICT',
    );
    expect(() => transitionAfterSaleEvidence('READY', 'EXPIRE')).toThrow(
      'AFTER_SALE_EVIDENCE_RETENTION_ACTIVE',
    );
    expect(() =>
      transitionAfterSaleEvidenceDeletionDue('READY', {
        deletionDeadlineEpochMs: 1_000,
        legalHoldActive: false,
        nowEpochMs: 999,
      }),
    ).toThrow('AFTER_SALE_EVIDENCE_RETENTION_ACTIVE');
    expect(() =>
      transitionAfterSaleEvidenceDeletionDue('READY', {
        deletionDeadlineEpochMs: 1_000,
        legalHoldActive: true,
        nowEpochMs: 1_000,
      }),
    ).toThrow('AFTER_SALE_EVIDENCE_RETENTION_ACTIVE');
    expect(
      transitionAfterSaleEvidenceDeletionDue('READY', {
        deletionDeadlineEpochMs: 1_000,
        legalHoldActive: false,
        nowEpochMs: 1_000,
      }),
    ).toBe('DELETION_PENDING');
    expect(transitionAfterSaleEvidence('DELETION_PENDING', 'DELETE_FAILED')).toBe('DELETE_FAILED');
    expect(() => transitionAfterSaleEvidence('DELETE_FAILED', 'RETRY_DELETE')).toThrow(
      'AFTER_SALE_EVIDENCE_RETENTION_ACTIVE',
    );
    expect(() =>
      transitionAfterSaleEvidenceDeletionAttempt('DELETE_FAILED', 'RETRY_DELETE', {
        deletionDeadlineEpochMs: 1_000,
        legalHoldActive: true,
        nowEpochMs: 1_001,
      }),
    ).toThrow('AFTER_SALE_EVIDENCE_RETENTION_ACTIVE');
    expect(
      transitionAfterSaleEvidenceDeletionAttempt('DELETE_FAILED', 'RETRY_DELETE', {
        deletionDeadlineEpochMs: 1_000,
        legalHoldActive: false,
        nowEpochMs: 1_001,
      }),
    ).toBe('DELETION_PENDING');
    expect(() =>
      transitionAfterSaleEvidenceDeletionAttempt('DELETION_PENDING', 'DELETE_SUCCEEDED', {
        deletionDeadlineEpochMs: 1_000,
        legalHoldActive: true,
        nowEpochMs: 1_001,
      }),
    ).toThrow('AFTER_SALE_EVIDENCE_RETENTION_ACTIVE');
    expect(
      transitionAfterSaleEvidenceDeletionAttempt('DELETION_PENDING', 'DELETE_SUCCEEDED', {
        deletionDeadlineEpochMs: 1_000,
        legalHoldActive: false,
        nowEpochMs: 1_001,
      }),
    ).toBe('DELETED');
    expect(() =>
      assertAfterSaleEvidenceAccessAllowed({
        accessDeadlineEpochMs: 1_000,
        legalHoldActive: true,
        nowEpochMs: 1_000,
        status: 'READY',
      }),
    ).toThrow('AFTER_SALE_EVIDENCE_ACCESS_DENIED');
    expect(() =>
      assertAfterSaleEvidenceAccessAllowed({
        accessDeadlineEpochMs: 1_000,
        legalHoldActive: false,
        nowEpochMs: 999,
        status: 'READY',
      }),
    ).not.toThrow();
  });
});

describe('M6 after-sale quantity and refund capacity', () => {
  it('prevents concurrent cases from exceeding an order item quantity', () => {
    expect(() =>
      assertAfterSaleQuantityAvailable({
        occupiedQuantity: 1,
        orderedQuantity: 3,
        requestedQuantity: 2,
      }),
    ).not.toThrow();
    expect(() =>
      assertAfterSaleQuantityAvailable({
        occupiedQuantity: 2,
        orderedQuantity: 3,
        requestedQuantity: 2,
      }),
    ).toThrow('AFTER_SALE_QUANTITY_EXCEEDS_AVAILABLE');
    expect(() =>
      assertAfterSaleQuantityAvailable({
        occupiedQuantity: 0,
        orderedQuantity: 3,
        requestedQuantity: 1.5,
      }),
    ).toThrow('AFTER_SALE_QUANTITY_INVALID');
  });

  it('keeps uncertain and irreversible cases in the quantity capacity', () => {
    expect(
      doesAfterSaleQuantityOccupyCapacity({
        hasIrreversibleOrUncertainSideEffects: false,
        status: 'REVIEW_REQUIRED',
      }),
    ).toBe(true);
    expect(
      doesAfterSaleQuantityOccupyCapacity({
        hasIrreversibleOrUncertainSideEffects: false,
        status: 'COMPLETED',
      }),
    ).toBe(true);
    expect(
      doesAfterSaleQuantityOccupyCapacity({
        hasIrreversibleOrUncertainSideEffects: false,
        status: 'REJECTED',
      }),
    ).toBe(false);
    expect(
      doesAfterSaleQuantityOccupyCapacity({
        hasIrreversibleOrUncertainSideEffects: true,
        status: 'REJECTED',
      }),
    ).toBe(true);
  });

  it('reserves in-flight and succeeded settlement amounts', () => {
    expect(
      calculateRemainingAfterSaleRefundVnd({
        approvedAmountVnd: 500_000,
        inFlightAmountVnd: 100_000,
        succeededAmountVnd: 150_000,
      }),
    ).toBe(250_000);
    expect(() =>
      assertAfterSaleRefundAmountAllowed({
        approvedAmountVnd: 500_000,
        inFlightAmountVnd: 100_000,
        requestedAmountVnd: 250_001,
        succeededAmountVnd: 150_000,
      }),
    ).toThrow('AFTER_SALE_REFUND_EXCEEDS_APPROVED');
  });

  it('allocates partial-quantity discount remainders exactly once', () => {
    expect(
      calculateOrderItemRefundAllocationVnd({
        occupiedAllocatedVnd: 0,
        occupiedApprovedQuantity: 0,
        orderItemPayableVnd: 1,
        orderedQuantity: 2,
        requestedApprovedQuantity: 1,
      }),
    ).toBe(0);
    expect(
      calculateOrderItemRefundAllocationVnd({
        occupiedAllocatedVnd: 0,
        occupiedApprovedQuantity: 1,
        orderItemPayableVnd: 1,
        orderedQuantity: 2,
        requestedApprovedQuantity: 1,
      }),
    ).toBe(1);
    expect(() =>
      calculateOrderItemRefundAllocationVnd({
        occupiedAllocatedVnd: 2,
        occupiedApprovedQuantity: 1,
        orderItemPayableVnd: 1,
        orderedQuantity: 2,
        requestedApprovedQuantity: 1,
      }),
    ).toThrow('AFTER_SALE_REFUND_AMOUNT_INVALID');
  });

  it('reuses released approval value without losing or duplicating discount remainders', () => {
    expect(
      calculateOrderItemRefundAllocationVnd({
        occupiedAllocatedVnd: 34,
        occupiedApprovedQuantity: 1,
        orderItemPayableVnd: 101,
        orderedQuantity: 3,
        requestedApprovedQuantity: 1,
      }),
    ).toBe(33);
    expect(
      calculateOrderItemRefundAllocationVnd({
        occupiedAllocatedVnd: 67,
        occupiedApprovedQuantity: 2,
        orderItemPayableVnd: 101,
        orderedQuantity: 3,
        requestedApprovedQuantity: 1,
      }),
    ).toBe(34);
  });
});

describe('M6 inventory restoration and exchange invariants', () => {
  it('requires a complete quantity-conserving inspection before aggregate advancement', () => {
    expect(
      summarizeCompleteAfterSaleInspection({
        approvedItems: [
          { approvedQuantity: 2, orderItemId: 'line-1' },
          { approvedQuantity: 1, orderItemId: 'line-2' },
        ],
        inspectedItems: [
          {
            dispositions: [
              { disposition: 'RESTOCK_SELLABLE', quantity: 1 },
              { disposition: 'QUARANTINE', quantity: 1 },
            ],
            orderItemId: 'line-1',
            receivedQuantity: 2,
          },
          {
            dispositions: [{ disposition: 'RETURN_TO_MEMBER', quantity: 1 }],
            orderItemId: 'line-2',
            receivedQuantity: 1,
          },
        ],
      }),
    ).toEqual({ acceptedQuantity: 2, rejectedQuantity: 1, restockableQuantity: 1 });
    expect(() =>
      summarizeCompleteAfterSaleInspection({
        approvedItems: [
          { approvedQuantity: 2, orderItemId: 'line-1' },
          { approvedQuantity: 1, orderItemId: 'line-2' },
        ],
        inspectedItems: [
          {
            dispositions: [{ disposition: 'RESTOCK_SELLABLE', quantity: 1 }],
            orderItemId: 'line-1',
            receivedQuantity: 1,
          },
        ],
      }),
    ).toThrow('AFTER_SALE_INSPECTION_INVALID');

    expect(
      transitionAfterSaleAfterInspection('RETURN_REFUND', 'RETURN_IN_TRANSIT', {
        approvedItems: [{ approvedQuantity: 1, orderItemId: 'line-1' }],
        inspectedItems: [
          {
            dispositions: [{ disposition: 'RETURN_TO_MEMBER', quantity: 1 }],
            orderItemId: 'line-1',
            receivedQuantity: 1,
          },
        ],
      }),
    ).toEqual({
      events: ['RETURN_RECEIVED', 'REJECT_INSPECTION'],
      status: 'REJECTED',
    });
  });

  it('restores only accepted, restockable, previously consumed quantities', () => {
    expect(() =>
      assertInventoryRestoreAllowed({
        acceptedReturnQuantity: 2,
        consumedQuantity: 3,
        requestedRestoreQuantity: 1,
        restockableQuantity: 2,
        totalRestoredQuantity: 1,
        type: 'RETURN_REFUND',
      }),
    ).not.toThrow();
    expect(() =>
      assertInventoryRestoreAllowed({
        acceptedReturnQuantity: 2,
        consumedQuantity: 3,
        requestedRestoreQuantity: 2,
        restockableQuantity: 2,
        totalRestoredQuantity: 1,
        type: 'RETURN_REFUND',
      }),
    ).toThrow('AFTER_SALE_INVENTORY_RESTORE_EXCEEDS_AVAILABLE');
  });

  it('never restores stock for refund-only cases', () => {
    expect(() =>
      assertInventoryRestoreAllowed({
        acceptedReturnQuantity: 1,
        consumedQuantity: 1,
        requestedRestoreQuantity: 1,
        restockableQuantity: 1,
        totalRestoredQuantity: 0,
        type: 'REFUND_ONLY',
      }),
    ).toThrow('AFTER_SALE_INVENTORY_RESTORE_NOT_ALLOWED');
  });

  it('limits P0 exchanges to an equal-quantity SKU in the same product', () => {
    expect(() =>
      assertEquivalentExchange({
        allowedAttributeCode: 'size',
        originalProductId: 'product-1',
        originalSkuId: 'sku-small',
        originalStoreId: 'fashion',
        originalUnitPriceVnd: 250_000,
        originalOptions: { color: 'black', size: 's' },
        replacementActive: true,
        replacementProductId: 'product-1',
        replacementSkuId: 'sku-medium',
        replacementStoreId: 'fashion',
        replacementUnitPriceVnd: 250_000,
        replacementOptions: { color: 'black', size: 'm' },
        replacementQuantity: 1,
        requestedQuantity: 1,
      }),
    ).not.toThrow();
    expect(() =>
      assertEquivalentExchange({
        allowedAttributeCode: 'size',
        originalProductId: 'product-1',
        originalSkuId: 'sku-small',
        originalStoreId: 'fashion',
        originalUnitPriceVnd: 250_000,
        originalOptions: { color: 'black', size: 's' },
        replacementActive: true,
        replacementProductId: 'product-2',
        replacementSkuId: 'sku-medium',
        replacementStoreId: 'fashion',
        replacementUnitPriceVnd: 250_000,
        replacementOptions: { color: 'black', size: 'm' },
        replacementQuantity: 1,
        requestedQuantity: 1,
      }),
    ).toThrow('AFTER_SALE_EXCHANGE_NOT_ALLOWED');
    expect(() =>
      assertEquivalentExchange({
        allowedAttributeCode: 'size',
        originalProductId: 'product-1',
        originalSkuId: 'sku-small-black',
        originalStoreId: 'fashion',
        originalUnitPriceVnd: 250_000,
        originalOptions: { color: 'black', size: 's' },
        replacementActive: true,
        replacementProductId: 'product-1',
        replacementSkuId: 'sku-medium-white',
        replacementStoreId: 'fashion',
        replacementUnitPriceVnd: 250_000,
        replacementOptions: { color: 'white', size: 'm' },
        replacementQuantity: 1,
        requestedQuantity: 1,
      }),
    ).toThrow('AFTER_SALE_EXCHANGE_NOT_ALLOWED');
  });
});
