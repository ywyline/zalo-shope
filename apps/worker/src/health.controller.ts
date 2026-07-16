import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { RuntimeConfig } from '@zalo-shop/config';
import type { checkInfrastructure, InfrastructureStatus } from '@zalo-shop/platform';

export const RUNTIME_CONFIG = Symbol('RUNTIME_CONFIG');
export const INFRASTRUCTURE_CHECKER = Symbol('INFRASTRUCTURE_CHECKER');

@Controller('health')
export class HealthController {
  public constructor(
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
    @Inject(INFRASTRUCTURE_CHECKER)
    private readonly infrastructureChecker: typeof checkInfrastructure,
  ) {}

  @Get('live')
  public live(): { service: 'worker'; status: 'ok' } {
    return { service: 'worker', status: 'ok' };
  }

  @Get('ready')
  public async ready(): Promise<{
    dependencies: InfrastructureStatus;
    service: 'worker';
    status: 'ready';
  }> {
    try {
      const dependencies = await this.infrastructureChecker(this.config);
      return { dependencies, service: 'worker', status: 'ready' };
    } catch {
      throw new ServiceUnavailableException({ service: 'worker', status: 'not_ready' });
    }
  }
}
