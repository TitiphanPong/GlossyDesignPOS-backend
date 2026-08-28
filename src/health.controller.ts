import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from './auth/auth.decorators';
import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @Public()
  check() {
    return { status: 'ok' };
  }

  @Get('ready')
  @Public()
  async readiness() {
    if (!(await this.healthService.isReady())) {
      throw new ServiceUnavailableException({ status: 'unready' });
    }

    return { status: 'ready' };
  }
}
