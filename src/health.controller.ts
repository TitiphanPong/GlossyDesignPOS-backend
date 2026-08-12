import { Controller, Get } from '@nestjs/common';
import { Public } from './auth/auth.decorators';

@Controller('health')
export class HealthController {
  @Get()
  @Public()
  check() {
    return { status: 'ok' };
  }
}
