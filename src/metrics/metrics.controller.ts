import { Controller, Get, UseGuards } from '@nestjs/common';
import { register } from 'prom-client';
import { Public } from '../auth/public.decorator';
import { MetricsGuard } from './metrics.guard';

@Controller('metrics')
@Public()
@UseGuards(MetricsGuard)
export class MetricsController {
  @Get()
  getMetrics(): string {
    return register.metrics();
  }
}
