import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, it } from 'vitest';

import { HealthController, INFRASTRUCTURE_CHECKER, RUNTIME_CONFIG } from './health.controller';

describe('worker health endpoints', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it('reports liveness and infrastructure readiness', async () => {
    const module = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: RUNTIME_CONFIG, useValue: {} },
        {
          provide: INFRASTRUCTURE_CHECKER,
          useValue: () =>
            Promise.resolve({ objectStorage: 'up', postgres: 'up', redis: 'up' } as const),
        },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();

    await request(app.getHttpServer() as Server)
      .get('/health/live')
      .expect(200, {
        service: 'worker',
        status: 'ok',
      });
    await request(app.getHttpServer() as Server)
      .get('/health/ready')
      .expect(200, {
        dependencies: { objectStorage: 'up', postgres: 'up', redis: 'up' },
        service: 'worker',
        status: 'ready',
      });
  });
});
