import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { RuntimeConfig } from '@zalo-shop/config';
import type { InfrastructureStatus } from '@zalo-shop/platform';

export const RUNTIME_CONFIG = Symbol('RUNTIME_CONFIG');
export const INFRASTRUCTURE_CHECKER = Symbol('INFRASTRUCTURE_CHECKER');

export type InfrastructureChecker = (config: RuntimeConfig) => Promise<InfrastructureStatus>;

@Controller('health')
export class HealthController {
  public constructor(
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
    @Inject(INFRASTRUCTURE_CHECKER) private readonly checkInfrastructure: InfrastructureChecker,
  ) {}

  @Get('live')
  public live(): { service: 'api'; status: 'ok' } {
    return { service: 'api', status: 'ok' };
  }

  @Get('ready')
  public async ready(): Promise<{
    dependencies: InfrastructureStatus;
    service: 'api';
    status: 'ready';
  }> {
    try {
      const dependencies = await this.checkInfrastructure(this.config);
      return { dependencies, service: 'api', status: 'ready' };
    } catch {
      throw new ServiceUnavailableException({ service: 'api', status: 'not_ready' });
    }
  }
}
