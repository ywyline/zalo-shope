import { describe, expect, it } from 'vitest';

import {
  assertAfterSaleEvidenceAccessAllowed,
  assertAfterSaleEvidenceCreationAllowed,
  assertAfterSaleEventActorAllowed,
  assertAfterSaleOrderPaymentAdmissionAllowed,
  assertAfterSaleReasonAllowed,
  assertAfterSaleRequestWindowOpen,
  assertAfterSaleSystemEventAllowed,
  assertAfterSaleApprovalQuantities,
  assertAfterSaleQuantityAvailable,
  assertAfterSaleRefundAmountAllowed,
  assertAfterSaleReturnWindowOpen,
  assertEquivalentExchange,
  assertInventoryRestoreAllowed,
  calculateAfterSaleReturnDeadlineEpochMs,
  calculateAfterSaleRequestDeadlineEpochMs,
  calculateOrderItemRefundAllocationVnd,
  calculateRemainingAfterSaleRefundVnd,
  createAfterSaleEvidenceSystemContext,
  createAfterSaleSystemContext,
  doesAfterSaleQuantityOccupyCapacity,
  resolveAfterSaleReview,
  resolveAfterSaleCasePolicy,
  resolveAuthoritativeOrderItemDelivery,
  resolveLegacyAfterSaleReview,
  summarizeCompleteAfterSaleInspection,
  submitAfterSale,
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
  assertAfterSaleReturnSubmissionAllowed,
  transitionAfterSaleReturnSubmitted,
  transitionAfterSaleTrustedReturnFact,
  transitionExchangeToRefund,
} from './after-sales';

describe('M6 after-sale state machine', () => {
  it('records creation only as a real member or admin SUBMIT transition', () => {
    expect(submitAfterSale('MEMBER')).toEqual({
      event: 'SUBMIT',
      fromStatus: null,
      status: 'PENDING_REVIEW',
    });
    expect(submitAfterSale('ADMIN')).toEqual({
      event: 'SUBMIT',
      fromStatus: null,
      status: 'PENDING_REVIEW',
    });
    expect(submitAfterSale('MEMBER', true)).toEqual({
      event: 'SUBMIT',
      fromStatus: null,
      status: 'REVIEW_REQUIRED',
    });
    expect(() => assertAfterSaleEventActorAllowed('SYSTEM', 'SUBMIT')).toThrow(
      'AFTER_SALE_ACTOR_NOT_ALLOWED',
    );
    expect(() => transitionAfterSale('REFUND_ONLY', 'PENDING_REVIEW', 'SUBMIT')).toThrow(
      'AFTER_SALE_STATE_CONFLICT',
    );
  });

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
      transitionAfterSaleReturnSubmitted('RETURN_REFUND', 'APPROVED', {
        nowEpochMs: 999,
        returnDeadlineEpochMs: 1_000,
      }),
    ).toEqual({ events: ['START_RETURN'], status: 'RETURN_PENDING' });
    expect(
      transitionAfterSaleTrustedReturnFact('RETURN_REFUND', 'RETURN_PENDING', 'IN_TRANSIT'),
    ).toEqual({ events: ['RETURN_SHIPPED'], status: 'RETURN_IN_TRANSIT' });
    expect(
      transitionAfterSaleTrustedReturnFact('RETURN_REFUND', 'RETURN_PENDING', 'DELIVERED'),
    ).toEqual({
      events: ['RETURN_SHIPPED', 'RETURN_RECEIVED'],
      status: 'INSPECTION_PENDING',
    });
    expect(
      transitionAfterSaleTrustedReturnFact('EXCHANGE', 'RETURN_IN_TRANSIT', 'DELIVERED'),
    ).toEqual({ events: ['RETURN_RECEIVED'], status: 'INSPECTION_PENDING' });
    expect(() =>
      transitionAfterSaleTrustedReturnFact('REFUND_ONLY', 'APPROVED', 'IN_TRANSIT'),
    ).toThrow('AFTER_SALE_STATE_CONFLICT');
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
      transitionAfterSaleReturnSubmitted('RETURN_REFUND', 'APPROVED', {
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

  it('keeps member return submissions separate from authoritative shipping facts', () => {
    expect(() =>
      assertAfterSaleReturnSubmissionAllowed('RETURN_REFUND', 'APPROVED', {
        nowEpochMs: 999,
        returnDeadlineEpochMs: 1_000,
      }),
    ).not.toThrow();
    expect(() => assertAfterSaleEventActorAllowed('MEMBER', 'START_RETURN')).not.toThrow();
    expect(() => assertAfterSaleEventActorAllowed('MEMBER', 'RETURN_SHIPPED')).toThrow(
      'AFTER_SALE_ACTOR_NOT_ALLOWED',
    );
    expect(
      transitionAfterSaleReturnSubmitted('RETURN_REFUND', 'APPROVED', {
        nowEpochMs: 999,
        returnDeadlineEpochMs: 1_000,
      }),
    ).toEqual({ events: ['START_RETURN'], status: 'RETURN_PENDING' });
    expect(transitionAfterSale('RETURN_REFUND', 'RETURN_PENDING', 'RETURN_SHIPPED')).toBe(
      'RETURN_IN_TRANSIT',
    );
  });

  it('allows SYSTEM to append only frozen convergence events', () => {
    const systemContext = createAfterSaleSystemContext({
      actorId: 'after-sale-worker',
      correlationId: 'correlation-1',
      storeId: 'store-1',
    });
    expect(systemContext).toEqual({
      actor: { id: 'after-sale-worker', type: 'system' },
      correlationId: 'correlation-1',
      storeId: 'store-1',
      systemScope: 'after-sale-transition',
    });
    expect(() =>
      createAfterSaleSystemContext({
        actorId: ' ',
        correlationId: 'correlation-1',
        storeId: 'store-1',
      }),
    ).toThrow('AFTER_SALE_ACTOR_NOT_ALLOWED');
    for (const event of [
      'RETURN_EXPIRED',
      'REFUND_SUCCEEDED',
      'REFUND_FAILED',
      'REFUND_CANCELLED',
      'REQUIRE_REVIEW',
      'COMPLETE',
    ] as const) {
      expect(() => assertAfterSaleSystemEventAllowed(systemContext, event)).not.toThrow();
    }
    for (const event of [
      'APPROVE',
      'LEGACY_APPROVE',
      'RESUME_REVIEW',
      'REFUND_REQUESTED',
      'RETURN_SHIPPED',
      'RETURN_RECEIVED',
    ] as const) {
      expect(() => assertAfterSaleSystemEventAllowed(systemContext, event)).toThrow(
        'AFTER_SALE_ACTOR_NOT_ALLOWED',
      );
    }
    expect(transitionAfterSale('REFUND_ONLY', 'REFUNDED', 'COMPLETE')).toBe('COMPLETED');
    expect(() => transitionAfterSale('REFUND_ONLY', 'APPROVED', 'COMPLETE')).toThrow(
      'AFTER_SALE_STATE_CONFLICT',
    );
  });

  it('keeps evidence lifecycle SYSTEM identity separate from after-sale transitions', () => {
    const context = createAfterSaleEvidenceSystemContext({
      correlationId: 'm63-b2b-d0-correlation',
      storeId: '10000000-0000-4000-8000-000000000001',
    });

    expect(context).toEqual({
      actor: { id: '00000000-0000-4000-8000-000000000006', type: 'system' },
      correlationId: 'm63-b2b-d0-correlation',
      storeId: '10000000-0000-4000-8000-000000000001',
      systemScope: 'after-sale-evidence-lifecycle',
    });
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.actor)).toBe(true);
    expect(() =>
      createAfterSaleEvidenceSystemContext({
        correlationId: ' ',
        storeId: '10000000-0000-4000-8000-000000000001',
      }),
    ).toThrow('AFTER_SALE_ACTOR_NOT_ALLOWED');
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
  it('requires every requested line to receive one bounded approval decision', () => {
    expect(() =>
      assertAfterSaleApprovalQuantities({
        approvedItems: [
          { approvedQuantity: 1, orderItemId: 'line-1' },
          { approvedQuantity: 0, orderItemId: 'line-2' },
        ],
        requestedItems: [
          { orderItemId: 'line-1', requestedQuantity: 2 },
          { orderItemId: 'line-2', requestedQuantity: 1 },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      assertAfterSaleApprovalQuantities({
        approvedItems: [{ approvedQuantity: 1, orderItemId: 'line-1' }],
        requestedItems: [
          { orderItemId: 'line-1', requestedQuantity: 2 },
          { orderItemId: 'line-2', requestedQuantity: 1 },
        ],
      }),
    ).toThrow('AFTER_SALE_QUANTITY_INVALID');
    expect(() =>
      assertAfterSaleApprovalQuantities({
        approvedItems: [
          { approvedQuantity: 3, orderItemId: 'line-1' },
          { approvedQuantity: 0, orderItemId: 'line-2' },
        ],
        requestedItems: [
          { orderItemId: 'line-1', requestedQuantity: 2 },
          { orderItemId: 'line-2', requestedQuantity: 1 },
        ],
      }),
    ).toThrow('AFTER_SALE_QUANTITY_EXCEEDS_AVAILABLE');
    expect(() =>
      assertAfterSaleApprovalQuantities({
        approvedItems: [
          { approvedQuantity: 0, orderItemId: 'line-1' },
          { approvedQuantity: 0, orderItemId: 'line-2' },
        ],
        requestedItems: [
          { orderItemId: 'line-1', requestedQuantity: 2 },
          { orderItemId: 'line-2', requestedQuantity: 1 },
        ],
      }),
    ).toThrow('AFTER_SALE_QUANTITY_INVALID');
  });

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

describe('M6 after-sale policy and evidence admission', () => {
  const policy = {
    payloadHash: 'a'.repeat(64),
    policyId: 'policy-1',
    policyVersionId: 'policy-version-1',
    policyVersionNumber: 3,
  };

  it('permits a case only when every line has the same policy, version and hash', () => {
    expect(resolveAfterSaleCasePolicy([policy, { ...policy }])).toEqual({
      legacyPolicyReview: false,
      policy,
    });
    expect(resolveAfterSaleCasePolicy([null, null])).toEqual({
      legacyPolicyReview: true,
      policy: null,
    });
    expect(() =>
      resolveAfterSaleCasePolicy([policy, { ...policy, payloadHash: 'b'.repeat(64) }]),
    ).toThrow('AFTER_SALE_POLICY_MISMATCH');
    expect(() => resolveAfterSaleCasePolicy([policy, null])).toThrow('AFTER_SALE_POLICY_MISMATCH');
  });

  it('derives delivery only from complete ORDER_OUTBOUND shipment-item facts', () => {
    expect(
      resolveAuthoritativeOrderItemDelivery({
        orderedQuantity: 3,
        shipmentItems: [
          {
            deliveredAtEpochMs: 1_000,
            purpose: 'ORDER_OUTBOUND',
            quantity: 1,
            shipmentId: 'outbound-1',
            status: 'DELIVERED',
          },
          {
            deliveredAtEpochMs: 2_000,
            purpose: 'ORDER_OUTBOUND',
            quantity: 2,
            shipmentId: 'outbound-2',
            status: 'DELIVERED',
          },
          {
            deliveredAtEpochMs: 3_000,
            purpose: 'AFTER_SALE_RETURN',
            quantity: 3,
            shipmentId: 'return-1',
            status: 'DELIVERED',
          },
        ],
      }),
    ).toEqual({ deliveredAtEpochMs: 2_000, proven: true });
    expect(
      resolveAuthoritativeOrderItemDelivery({
        orderedQuantity: 3,
        shipmentItems: [
          {
            deliveredAtEpochMs: 1_000,
            purpose: 'ORDER_OUTBOUND',
            quantity: 1,
            shipmentId: 'outbound-1',
            status: 'DELIVERED',
          },
        ],
      }),
    ).toEqual({ proven: false, reason: 'OUTBOUND_QUANTITY_UNPROVEN' });
    expect(
      resolveAuthoritativeOrderItemDelivery({
        orderedQuantity: 1,
        shipmentItems: [
          {
            deliveredAtEpochMs: null,
            purpose: 'ORDER_OUTBOUND',
            quantity: 1,
            shipmentId: 'outbound-1',
            status: 'DELIVERED',
          },
        ],
      }),
    ).toEqual({ proven: false, reason: 'DELIVERY_TIMESTAMP_UNPROVEN' });
  });

  it('uses an exclusive Ho Chi Minh natural-day request deadline including day zero', () => {
    const deliveredAtEpochMs = Date.parse('2026-07-31T16:59:59.000Z');
    const deadline = calculateAfterSaleRequestDeadlineEpochMs({
      deliveredAtEpochMs,
      requestWindowDays: 0,
    });
    expect(deadline).toBe(Date.parse('2026-07-31T17:00:00.000Z'));
    expect(() =>
      assertAfterSaleRequestWindowOpen({
        nowEpochMs: deadline - 1,
        requestDeadlineEpochMs: deadline,
      }),
    ).not.toThrow();
    expect(() =>
      assertAfterSaleRequestWindowOpen({ nowEpochMs: deadline, requestDeadlineEpochMs: deadline }),
    ).toThrow('AFTER_SALE_REQUEST_WINDOW_CLOSED');
    expect(
      calculateAfterSaleRequestDeadlineEpochMs({
        deliveredAtEpochMs: Date.parse('2026-07-31T17:00:00.000Z'),
        requestWindowDays: 1,
      }),
    ).toBe(Date.parse('2026-08-02T17:00:00.000Z'));
  });

  it('enforces policy reason and paid delivered-order admission', () => {
    expect(() =>
      assertAfterSaleReasonAllowed({
        allowedReasonCodes: ['damaged-item', 'wrong-item'],
        reasonCode: 'damaged-item',
      }),
    ).not.toThrow();
    expect(() =>
      assertAfterSaleReasonAllowed({
        allowedReasonCodes: ['damaged-item'],
        reasonCode: 'changed-mind',
      }),
    ).toThrow('AFTER_SALE_REASON_NOT_ALLOWED');
    expect(() =>
      assertAfterSaleOrderPaymentAdmissionAllowed({
        confirmedReceiptFact: true,
        orderStatus: 'DELIVERED',
        paymentMethod: 'ONLINE',
        paymentStatus: 'PARTIALLY_REFUNDED',
      }),
    ).not.toThrow();
    expect(() =>
      assertAfterSaleOrderPaymentAdmissionAllowed({
        confirmedReceiptFact: false,
        orderStatus: 'COMPLETED',
        paymentMethod: 'COD',
        paymentStatus: 'SUCCEEDED',
      }),
    ).toThrow('AFTER_SALE_PAYMENT_NOT_PROVEN');
    expect(() =>
      assertAfterSaleOrderPaymentAdmissionAllowed({
        confirmedReceiptFact: true,
        orderStatus: 'SHIPPED',
        paymentMethod: 'ONLINE',
        paymentStatus: 'SUCCEEDED',
      }),
    ).toThrow('AFTER_SALE_ORDER_NOT_ELIGIBLE');
  });

  it('fails evidence-required admission closed until every real capability is available', () => {
    const availableCapabilities = {
      claimAvailable: true,
      deletionCompensationAvailable: true,
      malwareScanningAvailable: true,
      protectedReadAvailable: true,
      uploadValidationAvailable: true,
    };
    expect(() =>
      assertAfterSaleEvidenceCreationAllowed({
        capabilities: availableCapabilities,
        evidenceRequired: true,
        readyEvidenceCount: 1,
      }),
    ).not.toThrow();
    expect(() =>
      assertAfterSaleEvidenceCreationAllowed({
        capabilities: { ...availableCapabilities, malwareScanningAvailable: false },
        evidenceRequired: true,
        readyEvidenceCount: 1,
      }),
    ).toThrow('AFTER_SALE_EVIDENCE_CAPABILITY_UNAVAILABLE');
    expect(() =>
      assertAfterSaleEvidenceCreationAllowed({
        capabilities: availableCapabilities,
        evidenceRequired: true,
        readyEvidenceCount: 0,
      }),
    ).toThrow('AFTER_SALE_EVIDENCE_REQUIRED');
    expect(() =>
      assertAfterSaleEvidenceCreationAllowed({
        capabilities: {
          claimAvailable: false,
          deletionCompensationAvailable: false,
          malwareScanningAvailable: false,
          protectedReadAvailable: false,
          uploadValidationAvailable: false,
        },
        evidenceRequired: false,
        readyEvidenceCount: 0,
      }),
    ).not.toThrow();
    expect(() =>
      assertAfterSaleEvidenceCreationAllowed({
        capabilities: { ...availableCapabilities, protectedReadAvailable: false },
        evidenceRequired: false,
        readyEvidenceCount: 1,
      }),
    ).toThrow('AFTER_SALE_EVIDENCE_CAPABILITY_UNAVAILABLE');
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
