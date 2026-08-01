import type { Server } from 'node:http';

import {
  BadRequestException,
  type INestApplication,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ApiExceptionFilter } from '../api-exception.filter';
import {
  AfterSalesAdminController,
  AfterSalesAdminOrderController,
  AfterSalesController,
} from './after-sales.controller';
import { AfterSalesService } from './after-sales.service';

const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const ORDER_ITEM_ID = '22222222-2222-4222-8222-222222222222';
const AFTER_SALE_ID = '33333333-3333-4333-8333-333333333333';
const STORE_ID = '44444444-4444-4444-8444-444444444444';
const IDEMPOTENCY_KEY = 'b3-controller-idempotency-key';
const ACKNOWLEDGEMENT = {
  id: AFTER_SALE_ID,
  public_number: 'ASC-33333333333343338333333333333333',
  status: 'PENDING_REVIEW',
  version: 1,
} as const;

function response() {
  return { setHeader: vi.fn() };
}

describe('AfterSalesController B3 commands', () => {
  it('strictly parses a member create and returns private idempotency headers', async () => {
    const memberCreate = vi.fn().mockResolvedValue({ body: ACKNOWLEDGEMENT, replayed: false });
    const service = { memberCreate } as unknown as AfterSalesService;
    const controller = new AfterSalesController(service);
    const request = { id: 'server-correlation-id', ip: '::ffff:127.0.0.1' };
    const httpResponse = response();

    await expect(
      controller.create(
        'Bearer member-token',
        IDEMPOTENCY_KEY,
        'beauty-store',
        {
          description: 'The delivered item has a verified defect.',
          evidence_ids: [],
          items: [{ order_item_id: ORDER_ITEM_ID, quantity: 1 }],
          order_id: ORDER_ID,
          reason_code: 'defective-item',
          type: 'RETURN_REFUND',
        },
        {},
        request,
        httpResponse,
      ),
    ).resolves.toEqual(ACKNOWLEDGEMENT);

    expect(request.id).not.toBe('server-correlation-id');
    expect(typeof request.id).toBe('string');
    expect(memberCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: request.id,
        idempotencyKey: IDEMPOTENCY_KEY,
        sourceIp: '127.0.0.1',
        storeCode: 'beauty-store',
      }),
    );
    expect(httpResponse.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(httpResponse.setHeader).toHaveBeenCalledWith('X-Correlation-Id', request.id);
    expect(httpResponse.setHeader).toHaveBeenCalledWith('Idempotency-Replayed', 'false');
  });

  it('rejects unknown member query fields and unavailable peer IP before calling the service', async () => {
    const memberCreate = vi.fn();
    const controller = new AfterSalesController({ memberCreate } as unknown as AfterSalesService);
    const body = {
      description: 'The delivered item has a verified defect.',
      evidence_ids: [],
      items: [{ order_item_id: ORDER_ITEM_ID, quantity: 1 }],
      order_id: ORDER_ID,
      reason_code: 'defective-item',
      type: 'REFUND_ONLY',
    };

    await expect(
      controller.create(
        'Bearer member-token',
        IDEMPOTENCY_KEY,
        'beauty-store',
        body,
        { store_id: STORE_ID },
        { id: 'server-correlation-id', ip: '127.0.0.1' },
        response(),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.create(
        'Bearer member-token',
        IDEMPOTENCY_KEY,
        'beauty-store',
        body,
        {},
        { id: 'server-correlation-id' },
        response(),
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(memberCreate).not.toHaveBeenCalled();
  });

  it('passes cancellation version and normalized peer IP to the member command', async () => {
    const memberCancel = vi.fn().mockResolvedValue({
      body: { ...ACKNOWLEDGEMENT, status: 'CANCELLED', version: 2 },
      replayed: true,
    });
    const controller = new AfterSalesController({ memberCancel } as unknown as AfterSalesService);
    const httpResponse = response();
    await controller.cancel(
      'Bearer member-token',
      IDEMPOTENCY_KEY,
      'beauty-store',
      { afterSaleId: AFTER_SALE_ID },
      { expected_version: 1, reason: 'The request is no longer needed.' },
      {},
      { id: 'server-correlation-id', ip: '127.0.0.1' },
      httpResponse,
    );
    expect(memberCancel).toHaveBeenCalledWith(
      expect.objectContaining({
        afterSaleId: AFTER_SALE_ID,
        body: { expected_version: 1, reason: 'The request is no longer needed.' },
        sourceIp: '127.0.0.1',
      }),
    );
    expect(httpResponse.setHeader).toHaveBeenCalledWith('Idempotency-Replayed', 'true');
  });
});

describe('AfterSalesAdminOrderController B3 command', () => {
  it('strictly binds order, store, admin headers and source IP', async () => {
    const adminCreateMerchantRefund = vi
      .fn()
      .mockResolvedValue({ body: ACKNOWLEDGEMENT, replayed: false });
    const controller = new AfterSalesAdminOrderController({
      adminCreateMerchantRefund,
    } as unknown as AfterSalesService);
    const httpResponse = response();
    const request = { id: 'server-correlation-id', ip: '::1' };

    await controller.create(
      'Bearer admin-token',
      IDEMPOTENCY_KEY,
      'beauty-store',
      'Operational review for order ABC-1234',
      { orderId: ORDER_ID },
      {
        description: 'Merchant initiated a refund after fulfillment review.',
        items: [{ order_item_id: ORDER_ITEM_ID, quantity: 1 }],
        reason_code: 'merchant-refund',
        type: 'MERCHANT_REFUND',
      },
      { store_id: STORE_ID },
      request,
      httpResponse,
    );

    expect(adminCreateMerchantRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({
          accessReason: 'Operational review for order ABC-1234',
          accessToken: 'admin-token',
          correlationId: request.id,
          sourceIp: '::1',
          storeCode: 'beauty-store',
        }),
        idempotencyKey: IDEMPOTENCY_KEY,
        orderId: ORDER_ID,
        query: { store_id: STORE_ID },
      }),
    );
    expect(httpResponse.setHeader).toHaveBeenCalledWith('Idempotency-Replayed', 'false');
  });
});

describe('AfterSalesAdminController B4 commands', () => {
  it('strictly binds review and resolve commands with server-owned correlation', async () => {
    const adminReview = vi.fn().mockResolvedValue({
      body: { ...ACKNOWLEDGEMENT, status: 'APPROVED', version: 2 },
      replayed: false,
    });
    const adminResolveReview = vi.fn().mockResolvedValue({
      body: { ...ACKNOWLEDGEMENT, status: 'REJECTED', version: 3 },
      replayed: true,
    });
    const controller = new AfterSalesAdminController({
      adminResolveReview,
      adminReview,
    } as unknown as AfterSalesService);
    const reviewResponse = response();
    const reviewRequest = { id: 'client-correlation', ip: '::ffff:127.0.0.1' };
    await expect(
      controller.review(
        'Bearer admin-token',
        IDEMPOTENCY_KEY,
        'beauty-store',
        'Review submitted evidence for case ASC-1',
        { afterSaleId: AFTER_SALE_ID },
        {
          confirmation_code: 'APPROVE_AFTER_SALE',
          decision: 'APPROVE',
          expected_version: 1,
          items: [{ approved_quantity: 1, order_item_id: ORDER_ITEM_ID }],
          reason: 'Approve after completing the required administrator review.',
        },
        { store_id: STORE_ID },
        reviewRequest,
        reviewResponse,
      ),
    ).resolves.toMatchObject({ status: 'APPROVED', version: 2 });
    expect(adminReview).toHaveBeenCalledWith(
      expect.objectContaining({
        afterSaleId: AFTER_SALE_ID,
        headers: expect.objectContaining({
          accessReason: 'Review submitted evidence for case ASC-1',
          correlationId: reviewRequest.id,
          sourceIp: '127.0.0.1',
        }),
        query: { store_id: STORE_ID },
      }),
    );
    expect(reviewResponse.setHeader).toHaveBeenCalledWith('Idempotency-Replayed', 'false');

    const resolveResponse = response();
    await controller.resolveReview(
      'Bearer admin-token',
      `${IDEMPOTENCY_KEY}-resolve`,
      'beauty-store',
      undefined,
      { afterSaleId: AFTER_SALE_ID },
      {
        confirmation_code: 'RESOLVE_AFTER_SALE_REVIEW',
        decision: 'REJECT',
        expected_version: 2,
        reason: 'Reject after completing the required manual review.',
      },
      { store_id: STORE_ID },
      { id: 'client-correlation', ip: '::1' },
      resolveResponse,
    );
    expect(adminResolveReview).toHaveBeenCalledWith(
      expect.objectContaining({
        afterSaleId: AFTER_SALE_ID,
        idempotencyKey: `${IDEMPOTENCY_KEY}-resolve`,
      }),
    );
    expect(resolveResponse.setHeader).toHaveBeenCalledWith('Idempotency-Replayed', 'true');
  });

  it('strictly binds member return and trusted admin fact commands', async () => {
    const memberSubmitReturn = vi.fn().mockResolvedValue({
      body: { ...ACKNOWLEDGEMENT, status: 'RETURN_PENDING', version: 3 },
      replayed: false,
    });
    const memberController = new AfterSalesController({
      memberSubmitReturn,
    } as unknown as AfterSalesService);
    const memberResponse = response();
    await memberController.submitReturnShipment(
      'Bearer member-token',
      `${IDEMPOTENCY_KEY}-return`,
      'beauty-store',
      { afterSaleId: AFTER_SALE_ID },
      {
        carrier_name: 'GHN',
        expected_version: 2,
        tracking_number: 'GHN-RETURN-000012345678',
      },
      {},
      { id: 'client-correlation', ip: '::ffff:127.0.0.1' },
      memberResponse,
    );
    expect(memberSubmitReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        afterSaleId: AFTER_SALE_ID,
        sourceIp: '127.0.0.1',
      }),
    );

    const adminRecordReturnFact = vi.fn().mockResolvedValue({
      body: { ...ACKNOWLEDGEMENT, status: 'RETURN_IN_TRANSIT', version: 4 },
      replayed: true,
    });
    const adminController = new AfterSalesAdminController({
      adminRecordReturnFact,
    } as unknown as AfterSalesService);
    const adminResponse = response();
    await adminController.recordReturnFact(
      'Bearer admin-token',
      `${IDEMPOTENCY_KEY}-return-fact`,
      'beauty-store',
      'Carrier portal verification for the returned parcel',
      { afterSaleId: AFTER_SALE_ID },
      {
        confirmation_code: 'RECORD_RETURN_LOGISTICS_FACT',
        expected_return_shipment_version: 1,
        expected_version: 3,
        reason: 'Carrier portal confirms the return is now in transit.',
        status: 'IN_TRANSIT',
      },
      { store_id: STORE_ID },
      { id: 'client-correlation', ip: '::1' },
      adminResponse,
    );
    expect(adminRecordReturnFact).toHaveBeenCalledWith(
      expect.objectContaining({
        afterSaleId: AFTER_SALE_ID,
        headers: expect.objectContaining({
          accessReason: 'Carrier portal verification for the returned parcel',
          sourceIp: '::1',
        }),
        query: { store_id: STORE_ID },
      }),
    );
    expect(adminResponse.setHeader).toHaveBeenCalledWith('Idempotency-Replayed', 'true');
  });
});

describe('AfterSalesAdminController B6 commands', () => {
  it('strictly binds the server-calculated ONLINE refund request', async () => {
    const adminRequestOnlineRefund = vi.fn().mockResolvedValue({
      body: { ...ACKNOWLEDGEMENT, status: 'REFUND_PROCESSING', version: 4 },
      replayed: false,
    });
    const controller = new AfterSalesAdminController({
      adminRequestOnlineRefund,
    } as unknown as AfterSalesService);
    const httpResponse = response();
    const request = { id: 'client-correlation', ip: '::ffff:127.0.0.1' };

    await expect(
      controller.requestRefund(
        'Bearer admin-token',
        `${IDEMPOTENCY_KEY}-refund`,
        'beauty-store',
        'Refund approved after final settlement review',
        { afterSaleId: AFTER_SALE_ID },
        {
          confirmation_code: 'ISSUE_AFTER_SALE_REFUND',
          expected_version: 3,
          reason: 'Issue the approved online refund after the final review.',
        },
        { store_id: STORE_ID },
        request,
        httpResponse,
      ),
    ).resolves.toMatchObject({ status: 'REFUND_PROCESSING', version: 4 });

    expect(adminRequestOnlineRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        afterSaleId: AFTER_SALE_ID,
        body: {
          confirmation_code: 'ISSUE_AFTER_SALE_REFUND',
          expected_version: 3,
          reason: 'Issue the approved online refund after the final review.',
        },
        idempotencyKey: `${IDEMPOTENCY_KEY}-refund`,
        query: { store_id: STORE_ID },
      }),
    );
    expect(httpResponse.setHeader).toHaveBeenCalledWith('Idempotency-Replayed', 'false');

    await expect(
      controller.requestRefund(
        'Bearer admin-token',
        `${IDEMPOTENCY_KEY}-refund-invalid`,
        'beauty-store',
        undefined,
        { afterSaleId: AFTER_SALE_ID },
        {
          confirmation_code: 'ISSUE_AFTER_SALE_REFUND',
          expected_version: 3,
          reason: 'Issue the approved online refund after the final review.',
          amount_vnd: 1,
        },
        { store_id: STORE_ID },
        { id: 'server-correlation-id', ip: '127.0.0.1' },
        response(),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('B3 command HTTP routes', () => {
  let app: INestApplication;
  const service = {
    adminCreateMerchantRefund: vi.fn(),
    adminDetail: vi.fn(),
    adminList: vi.fn(),
    adminRecordReturnFact: vi.fn(),
    adminRequestOnlineRefund: vi.fn(),
    adminResolveReview: vi.fn(),
    adminReview: vi.fn(),
    memberCancel: vi.fn(),
    memberCreate: vi.fn(),
    memberDetail: vi.fn(),
    memberList: vi.fn(),
    memberSubmitReturn: vi.fn(),
  };

  beforeAll(async () => {
    service.memberCreate.mockResolvedValue({ body: ACKNOWLEDGEMENT, replayed: false });
    service.memberCancel.mockResolvedValue({
      body: { ...ACKNOWLEDGEMENT, status: 'CANCELLED', version: 2 },
      replayed: true,
    });
    service.adminCreateMerchantRefund.mockResolvedValue({
      body: ACKNOWLEDGEMENT,
      replayed: false,
    });
    service.adminReview.mockResolvedValue({
      body: { ...ACKNOWLEDGEMENT, status: 'APPROVED', version: 2 },
      replayed: false,
    });
    service.adminResolveReview.mockResolvedValue({
      body: { ...ACKNOWLEDGEMENT, status: 'REJECTED', version: 3 },
      replayed: true,
    });
    service.memberSubmitReturn.mockResolvedValue({
      body: { ...ACKNOWLEDGEMENT, status: 'RETURN_PENDING', version: 3 },
      replayed: false,
    });
    service.adminRecordReturnFact.mockResolvedValue({
      body: { ...ACKNOWLEDGEMENT, status: 'INSPECTION_PENDING', version: 5 },
      replayed: true,
    });
    service.adminRequestOnlineRefund.mockResolvedValue({
      body: { ...ACKNOWLEDGEMENT, status: 'REFUND_PROCESSING', version: 4 },
      replayed: false,
    });
    const module = await Test.createTestingModule({
      controllers: [
        AfterSalesController,
        AfterSalesAdminController,
        AfterSalesAdminOrderController,
      ],
      providers: [{ provide: AfterSalesService, useValue: service }],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
  });

  afterAll(async () => app.close());

  const api = () => request(app.getHttpServer() as Server);

  it('registers member create/cancel with exact statuses and server correlation', async () => {
    const create = await api()
      .post('/v1/after-sales')
      .set({
        Authorization: 'Bearer member-token',
        'Idempotency-Key': IDEMPOTENCY_KEY,
        'X-Correlation-Id': 'client-value-must-not-win',
        'X-Store-Code': 'beauty-store',
      })
      .send({
        description: 'The delivered item has a verified defect.',
        evidence_ids: [],
        items: [{ order_item_id: ORDER_ITEM_ID, quantity: 1 }],
        order_id: ORDER_ID,
        reason_code: 'defective-item',
        type: 'REFUND_ONLY',
      });
    expect(create.status).toBe(201);
    expect(create.headers['cache-control']).toBe('private, no-store');
    expect(create.headers['idempotency-replayed']).toBe('false');
    expect(create.headers['x-correlation-id']).toBeTruthy();
    expect(create.headers['x-correlation-id']).not.toBe('client-value-must-not-win');
    expect(create.body).toEqual(ACKNOWLEDGEMENT);

    const cancel = await api()
      .post(`/v1/after-sales/${AFTER_SALE_ID}/cancel`)
      .set({
        Authorization: 'Bearer member-token',
        'Idempotency-Key': `${IDEMPOTENCY_KEY}-cancel`,
        'X-Store-Code': 'beauty-store',
      })
      .send({ expected_version: 1, reason: 'The request is no longer needed.' });
    expect(cancel.status).toBe(200);
    expect(cancel.headers['idempotency-replayed']).toBe('true');
    expect(cancel.body).toEqual({ ...ACKNOWLEDGEMENT, status: 'CANCELLED', version: 2 });
  });

  it('registers merchant create and rejects fields outside strict command contracts', async () => {
    const merchant = await api()
      .post(`/v1/admin/orders/${ORDER_ID}/after-sales?store_id=${STORE_ID}`)
      .set({
        Authorization: 'Bearer admin-token',
        'Idempotency-Key': `${IDEMPOTENCY_KEY}-merchant`,
        'X-Store-Code': 'beauty-store',
      })
      .send({
        description: 'Merchant initiated a refund after fulfillment review.',
        items: [{ order_item_id: ORDER_ITEM_ID, quantity: 1 }],
        reason_code: 'merchant-refund',
        type: 'MERCHANT_REFUND',
      });
    expect(merchant.status).toBe(201);
    expect(merchant.headers['cache-control']).toBe('private, no-store');

    const invalid = await api()
      .post('/v1/after-sales?store_id=client-controlled')
      .set({
        Authorization: 'Bearer member-token',
        'Idempotency-Key': `${IDEMPOTENCY_KEY}-invalid`,
        'X-Store-Code': 'beauty-store',
      })
      .send({
        description: 'The delivered item has a verified defect.',
        evidence_ids: [],
        items: [{ order_item_id: ORDER_ITEM_ID, quantity: 1 }],
        order_id: ORDER_ID,
        reason_code: 'defective-item',
        type: 'REFUND_ONLY',
      });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ code: 'INPUT_INVALID' });
  });

  it('registers review routes and rejects client-supplied amounts', async () => {
    const review = await api()
      .post(`/v1/admin/after-sales/${AFTER_SALE_ID}/review?store_id=${STORE_ID}`)
      .set({
        Authorization: 'Bearer admin-token',
        'Idempotency-Key': `${IDEMPOTENCY_KEY}-review`,
        'X-Store-Code': 'beauty-store',
      })
      .send({
        confirmation_code: 'APPROVE_AFTER_SALE',
        decision: 'APPROVE',
        expected_version: 1,
        items: [{ approved_quantity: 1, order_item_id: ORDER_ITEM_ID }],
        reason: 'Approve after completing the required administrator review.',
      });
    expect(review.status).toBe(200);
    expect(review.headers['idempotency-replayed']).toBe('false');
    expect(review.body).toMatchObject({ status: 'APPROVED', version: 2 });

    const invalid = await api()
      .post(`/v1/admin/after-sales/${AFTER_SALE_ID}/review?store_id=${STORE_ID}`)
      .set({
        Authorization: 'Bearer admin-token',
        'Idempotency-Key': `${IDEMPOTENCY_KEY}-review-invalid`,
        'X-Store-Code': 'beauty-store',
      })
      .send({
        approved_total_vnd: 1,
        confirmation_code: 'APPROVE_AFTER_SALE',
        decision: 'APPROVE',
        expected_version: 1,
        items: [{ approved_quantity: 1, order_item_id: ORDER_ITEM_ID }],
        reason: 'Approve after completing the required administrator review.',
      });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ code: 'INPUT_INVALID' });

    const resolve = await api()
      .post(`/v1/admin/after-sales/${AFTER_SALE_ID}/resolve-review?store_id=${STORE_ID}`)
      .set({
        Authorization: 'Bearer admin-token',
        'Idempotency-Key': `${IDEMPOTENCY_KEY}-resolve-review`,
        'X-Store-Code': 'beauty-store',
      })
      .send({
        confirmation_code: 'RESOLVE_AFTER_SALE_REVIEW',
        decision: 'REJECT',
        expected_version: 2,
        reason: 'Reject after completing the required manual review.',
      });
    expect(resolve.status).toBe(200);
    expect(resolve.headers['idempotency-replayed']).toBe('true');
    expect(resolve.body).toMatchObject({ status: 'REJECTED', version: 3 });
  });

  it('registers strict B5 member and administrator return routes', async () => {
    const member = await api()
      .post(`/v1/after-sales/${AFTER_SALE_ID}/return-shipment`)
      .set({
        Authorization: 'Bearer member-token',
        'Idempotency-Key': `${IDEMPOTENCY_KEY}-return`,
        'X-Store-Code': 'beauty-store',
      })
      .send({
        carrier_name: 'GHN',
        expected_version: 2,
        tracking_number: 'GHN-RETURN-000012345678',
      });
    expect(member.status).toBe(200);
    expect(member.headers['idempotency-replayed']).toBe('false');
    expect(member.body).toMatchObject({ status: 'RETURN_PENDING', version: 3 });

    const admin = await api()
      .post(`/v1/admin/after-sales/${AFTER_SALE_ID}/return-shipment/fact?store_id=${STORE_ID}`)
      .set({
        Authorization: 'Bearer admin-token',
        'Idempotency-Key': `${IDEMPOTENCY_KEY}-return-fact`,
        'X-Access-Reason': 'Carrier portal verification for the returned parcel',
        'X-Store-Code': 'beauty-store',
      })
      .send({
        confirmation_code: 'RECORD_RETURN_LOGISTICS_FACT',
        expected_return_shipment_version: 1,
        expected_version: 3,
        reason: 'Carrier portal confirms delivery to the return warehouse.',
        status: 'DELIVERED',
      });
    expect(admin.status).toBe(200);
    expect(admin.headers['idempotency-replayed']).toBe('true');
    expect(admin.body).toMatchObject({ status: 'INSPECTION_PENDING', version: 5 });

    const invalid = await api()
      .post(`/v1/after-sales/${AFTER_SALE_ID}/return-shipment`)
      .set({
        Authorization: 'Bearer member-token',
        'Idempotency-Key': `${IDEMPOTENCY_KEY}-return-invalid`,
        'X-Store-Code': 'beauty-store',
      })
      .send({
        carrier_name: 'GHN',
        expected_version: 2,
        status: 'DELIVERED',
        tracking_number: 'GHN-RETURN-000012345678',
      });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ code: 'INPUT_INVALID' });
  });

  it('registers the ONLINE refund route and rejects client-owned amount fields', async () => {
    const refund = await api()
      .post(`/v1/admin/after-sales/${AFTER_SALE_ID}/refund?store_id=${STORE_ID}`)
      .set({
        Authorization: 'Bearer admin-token',
        'Idempotency-Key': `${IDEMPOTENCY_KEY}-online-refund`,
        'X-Access-Reason': 'Refund approved after final settlement review',
        'X-Store-Code': 'beauty-store',
      })
      .send({
        confirmation_code: 'ISSUE_AFTER_SALE_REFUND',
        expected_version: 3,
        reason: 'Issue the approved online refund after the final review.',
      });
    expect(refund.status).toBe(202);
    expect(refund.headers['idempotency-replayed']).toBe('false');
    expect(refund.body).toMatchObject({ status: 'REFUND_PROCESSING', version: 4 });

    const invalid = await api()
      .post(`/v1/admin/after-sales/${AFTER_SALE_ID}/refund?store_id=${STORE_ID}`)
      .set({
        Authorization: 'Bearer admin-token',
        'Idempotency-Key': `${IDEMPOTENCY_KEY}-online-refund-invalid`,
        'X-Store-Code': 'beauty-store',
      })
      .send({
        amount_vnd: 1,
        confirmation_code: 'ISSUE_AFTER_SALE_REFUND',
        expected_version: 3,
        reason: 'Issue the approved online refund after the final review.',
      });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ code: 'INPUT_INVALID' });
  });
});
