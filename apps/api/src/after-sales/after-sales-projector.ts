import { Inject, Injectable } from '@nestjs/common';
import type { RuntimeConfig } from '@zalo-shop/config';
import { afterSaleResponseSchema, type AfterSaleResponse } from '@zalo-shop/contracts';
import type { Prisma } from '@zalo-shop/database';
import { decryptSensitive } from '@zalo-shop/security';

import { RUNTIME_CONFIG } from '../health.controller';

export type AfterSaleLocale = 'en' | 'vi' | 'zh';

export function createAfterSaleReadSelect(locale: AfterSaleLocale) {
  const locales: AfterSaleLocale[] = locale === 'vi' ? ['vi'] : [locale, 'vi'];
  return {
    approvedTotalVnd: true,
    createdAt: true,
    currency: true,
    evidenceFiles: {
      orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
      select: {
        claimDeadlineAt: true,
        id: true,
        ordinaryAccessDeadlineAt: true,
        retentionDeadlineAt: true,
        status: true,
        version: true,
      },
    },
    id: true,
    items: {
      orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
      select: {
        acceptedQuantity: true,
        approvedQuantity: true,
        orderItemId: true,
        receivedQuantity: true,
        rejectedQuantity: true,
        replacementSkuId: true,
        requestedQuantity: true,
        restockableQuantity: true,
        restoredQuantity: true,
      },
    },
    legacyPolicyReview: true,
    memberId: true,
    orderId: true,
    policy: { select: { code: true } },
    policyVersion: {
      select: {
        localizations: {
          orderBy: { locale: 'asc' as const },
          select: {
            buyerInstructions: true,
            locale: true,
            name: true,
            summary: true,
          },
          where: { locale: { in: locales } },
        },
        versionNumber: true,
      },
    },
    publicCaseNumber: true,
    reasonCode: true,
    reasonDetailCiphertext: true,
    requestedItemVnd: true,
    requestedOtherVnd: true,
    requestedShippingVnd: true,
    requestedTotalVnd: true,
    returnDeadlineAt: true,
    returnShipments: {
      orderBy: [{ submittedAt: 'asc' as const }, { id: 'asc' as const }],
      select: {
        carrierName: true,
        status: true,
        submittedAt: true,
        trackingNumberMasked: true,
      },
    },
    settlements: {
      orderBy: [{ requestedAt: 'asc' as const }, { id: 'asc' as const }],
      select: {
        amountVnd: true,
        codRefundReceipt: { select: { id: true } },
        method: true,
        publicSettlementNumber: true,
        refunds: {
          select: { refund: { select: { publicRefundNumber: true } } },
        },
        requestedAt: true,
        status: true,
        updatedAt: true,
      },
    },
    status: true,
    storeId: true,
    transitions: {
      orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
      select: { createdAt: true, event: true, toStatus: true },
    },
    type: true,
    updatedAt: true,
    version: true,
  } satisfies Prisma.AfterSaleSelect;
}

export type AfterSaleReadRecord = Prisma.AfterSaleGetPayload<{
  select: ReturnType<typeof createAfterSaleReadSelect>;
}>;

export class AfterSaleProjectionError extends Error {
  public constructor(code: string) {
    super(code);
    this.name = 'AfterSaleProjectionError';
  }
}

@Injectable()
export class AfterSalesProjector {
  public constructor(@Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig) {}

  public project(
    record: AfterSaleReadRecord,
    locale: AfterSaleLocale,
    now = new Date(),
  ): AfterSaleResponse {
    if (record.currency !== 'VND') {
      throw new AfterSaleProjectionError('AFTER_SALE_CURRENCY_INVALID');
    }
    if (!record.legacyPolicyReview && record.reasonDetailCiphertext === null) {
      throw new AfterSaleProjectionError('AFTER_SALE_REASON_DETAIL_MISSING');
    }
    const response = {
      approved_refund_vnd: this.vnd(record.approvedTotalVnd),
      created_at: this.date(record.createdAt),
      currency: 'VND' as const,
      evidence: record.evidenceFiles.map((evidence) => this.evidence(evidence, now)),
      evidence_count: record.evidenceFiles.length,
      id: record.id,
      items: record.items.map((item) => ({
        accepted_quantity: item.acceptedQuantity,
        approved_quantity: item.approvedQuantity,
        order_item_id: item.orderItemId,
        received_quantity: item.receivedQuantity,
        rejected_quantity: item.rejectedQuantity,
        replacement_sku_id: item.replacementSkuId,
        requested_quantity: item.requestedQuantity,
        restockable_quantity: item.restockableQuantity,
        restored_quantity: item.restoredQuantity,
      })),
      order_id: record.orderId,
      policy_snapshot: this.policy(record, locale),
      public_number: record.publicCaseNumber,
      reason_code: record.reasonCode,
      reason_detail:
        record.reasonDetailCiphertext === null
          ? null
          : decryptSensitive(record.reasonDetailCiphertext, this.config.PII_ENCRYPTION_KEY),
      requested_item_vnd: this.vnd(record.requestedItemVnd),
      requested_other_vnd: this.vnd(record.requestedOtherVnd),
      requested_shipping_vnd: this.vnd(record.requestedShippingVnd),
      requested_total_vnd: this.vnd(record.requestedTotalVnd),
      return_deadline_at:
        record.returnDeadlineAt === null ? null : this.date(record.returnDeadlineAt),
      return_shipments: record.returnShipments.map((shipment) => ({
        carrier_name: shipment.carrierName,
        masked_tracking_number: shipment.trackingNumberMasked,
        status: shipment.status,
        submitted_at: this.date(shipment.submittedAt),
      })),
      settlements: record.settlements.map((settlement) => {
        if (settlement.refunds.length > 1) {
          throw new AfterSaleProjectionError('AFTER_SALE_REFUND_LINK_INVALID');
        }
        return {
          amount_vnd: this.vnd(settlement.amountVnd),
          created_at: this.date(settlement.requestedAt),
          method: settlement.method,
          public_number: settlement.publicSettlementNumber,
          receipt_recorded: settlement.codRefundReceipt !== null,
          refund_public_number: settlement.refunds[0]?.refund.publicRefundNumber ?? null,
          status: settlement.status,
          updated_at: this.date(settlement.updatedAt),
        };
      }),
      status: record.status,
      timeline: record.transitions.map((transition) => ({
        created_at: this.date(transition.createdAt),
        event: transition.event,
        status: transition.toStatus,
      })),
      type: record.type,
      updated_at: this.date(record.updatedAt),
      version: record.version,
    };
    return afterSaleResponseSchema.parse(response);
  }

  private evidence(
    evidence: AfterSaleReadRecord['evidenceFiles'][number],
    now: Date,
  ): AfterSaleResponse['evidence'][number] {
    if (evidence.status === 'PENDING') {
      return {
        access_expires_at: null,
        evidence_id: evidence.id,
        status: 'PENDING',
        version: evidence.version,
      };
    }
    const deadline =
      evidence.status === 'READY_UNCLAIMED'
        ? evidence.claimDeadlineAt
        : evidence.status === 'READY'
          ? evidence.ordinaryAccessDeadlineAt
          : null;
    if (deadline !== null && now < deadline) {
      return {
        access_expires_at: this.date(deadline),
        evidence_id: evidence.id,
        status: 'READY',
        version: evidence.version,
      };
    }
    return {
      access_expires_at: null,
      evidence_id: evidence.id,
      status: 'UNAVAILABLE',
      version: evidence.version,
    };
  }

  private policy(record: AfterSaleReadRecord, locale: AfterSaleLocale) {
    if (record.legacyPolicyReview) {
      return {
        buyer_instructions: null,
        legacy_policy_review: true as const,
        name: null,
        policy_code: null,
        policy_version_number: null,
        resolved_locale: null,
        summary: null,
      };
    }
    if (record.policy === null || record.policyVersion === null) {
      throw new AfterSaleProjectionError('AFTER_SALE_POLICY_SNAPSHOT_MISSING');
    }
    const vietnamese = record.policyVersion.localizations.find((item) => item.locale === 'vi');
    if (!vietnamese) {
      throw new AfterSaleProjectionError('AFTER_SALE_POLICY_LOCALIZATION_MISSING');
    }
    const localization =
      record.policyVersion.localizations.find((item) => item.locale === locale) ?? vietnamese;
    return {
      buyer_instructions: localization.buyerInstructions,
      legacy_policy_review: false as const,
      name: localization.name,
      policy_code: record.policy.code,
      policy_version_number: record.policyVersion.versionNumber,
      resolved_locale: localization.locale,
      summary: localization.summary,
    };
  }

  private date(value: Date): string {
    if (!Number.isFinite(value.getTime())) {
      throw new AfterSaleProjectionError('AFTER_SALE_TIMESTAMP_INVALID');
    }
    return value.toISOString();
  }

  private vnd(value: bigint): number {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new AfterSaleProjectionError('AFTER_SALE_AMOUNT_INVALID');
    }
    return Number(value);
  }
}
