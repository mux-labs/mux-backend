import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';

/** Result of a readiness database ping. */
export interface ReadinessResult {
  status: string;
  timestamp: string;
  database: {
    connected: boolean;
    responseTime?: number;
    error?: string;
  };
}

@Injectable()
export class AppService {
  private readonly logger = new Logger(AppService.name);

  constructor(private readonly prisma: PrismaService) {}

  getHello(): string {
    return 'Hello World!';
  }

  /**
   * Check application readiness by pinging the database.
   *
   * Backs the `/v1/ready` compatibility alias; `/v1/health/ready` (see
   * `HealthController`) is the primary readiness probe. Both must fail closed
   * identically, so a probe pointed at either path sees the same semantics.
   *
   * Never throws: the caller converts `connected: false` into a `503` so a
   * database outage is reported as "not ready" rather than as a server fault.
   */
  async checkReadiness(): Promise<ReadinessResult> {
    const timestamp = new Date().toISOString();
    const startTime = Date.now();

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      const responseTime = Date.now() - startTime;

      this.logger.log(`Database ping successful (${responseTime}ms)`);

      return {
        status: 'ready',
        timestamp,
        database: { connected: true, responseTime },
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      // Logged with the timing only. The message itself is surfaced to the
      // caller in the response body, so it is deliberately not duplicated into
      // the log line, where it could carry a connection string.
      this.logger.error(`Database ping failed (${responseTime}ms)`);

      return {
        status: 'not_ready',
        timestamp,
        database: { connected: false, responseTime, error: errorMessage },
      };
    }
  }
}
