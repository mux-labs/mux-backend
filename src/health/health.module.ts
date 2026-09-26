import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Health module for the liveness / readiness probes (#933).
 *
 * `PrismaService` is provided here so `PrismaHealthIndicator` can open a
 * short-lived connection for the readiness ping without coupling the probe to
 * a feature module.
 */
@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [PrismaService],
})
export class HealthModule {}
