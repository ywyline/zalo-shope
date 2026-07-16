import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import {
  HealthController,
  INFRASTRUCTURE_CHECKER,
  RUNTIME_CONFIG,
  type InfrastructureChecker,
} from './health.controller';

describe('API health endpoints', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
  });

  async function createApp(checker: InfrastructureChecker): Promise<INestApplication> {
    const module = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: RUNTIME_CONFIG,
          useValue: {},
        },
        {
          provide: INFRASTRUCTURE_CHECKER,
          useValue: checker,
        },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();
    return app;
  }

  it('reports the process as live without checking dependencies', async () => {
    const checker: InfrastructureChecker = () => Promise.reject(new Error('should not run'));
    const application = await createApp(checker);

    await request(application.getHttpServer() as Server)
      .get('/health/live')
      .expect(200, {
        service: 'api',
        status: 'ok',
      });
  });

  it('reports readiness only after all dependencies respond', async () => {
    const checker: InfrastructureChecker = () =>
      Promise.resolve({
        objectStorage: 'up',
        postgres: 'up',
        redis: 'up',
      });
    const application = await createApp(checker);

    const response = await request(application.getHttpServer() as Server)
      .get('/health/ready')
      .expect(200);
    expect(response.body.status).toBe('ready');
  });

  it('does not leak dependency errors in readiness responses', async () => {
    const checker: InfrastructureChecker = () =>
      Promise.reject(new Error('postgresql://secret@host/database'));
    const application = await createApp(checker);

    const response = await request(application.getHttpServer() as Server)
      .get('/health/ready')
      .expect(503);
    expect(JSON.stringify(response.body)).not.toContain('secret');
  });
});
