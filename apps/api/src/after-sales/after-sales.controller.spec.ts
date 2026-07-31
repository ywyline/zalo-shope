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

describe('B3 command HTTP routes', () => {
  let app: INestApplication;
  const service = {
    adminCreateMerchantRefund: vi.fn(),
    adminDetail: vi.fn(),
    adminList: vi.fn(),
    memberCancel: vi.fn(),
    memberCreate: vi.fn(),
    memberDetail: vi.fn(),
    memberList: vi.fn(),
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
});
