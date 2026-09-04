import { Module } from '@nestjs/common';
import { LatencySloService } from './latency-slo.service';
import { LatencySloInterceptor } from './latency-slo.interceptor';
import { SloController } from './slo.controller';

@Module({
  controllers: [SloController],
  providers: [LatencySloService, LatencySloInterceptor],
  exports: [LatencySloService, LatencySloInterceptor],
})
export class SloModule {}
