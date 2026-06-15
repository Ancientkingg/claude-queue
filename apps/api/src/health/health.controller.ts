import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/public.decorator.js';

@Controller('health')
@SkipThrottle()
export class HealthController {
  @Get()
  @Public()
  check() {
    return { status: 'ok', version: '2.0' };
  }
}
