import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
  PrismaHealthIndicator,
} from '@nestjs/terminus';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Build identity echoed by both probes. This is a git commit hash injected at
 * container build time via the `GIT_SHA` env var (see Dockerfile) — never any
 * secret or key material.
 */
export interface HealthBuildInfo {
  gitSha: string;
}

/**
 * Readiness response: the standard Terminus envelope plus the build identity.
 *
 * `build` is declared here rather than spread onto `HealthCheckResult`,
 * because Terminus types that result with exactly `status`/`info`/`error`/
 * `details` and rejects the extra key at compile time.
 */
export type ReadinessProbeResult = HealthCheckResult & {
  build: HealthBuildInfo;
};

/**
 * The slice of a Prisma client that Terminus actually pings.
 *
 * `PrismaHealthIndicator.pingCheck` only calls `$runCommandRaw` (falling back
 * to `$queryRawUnsafe`), so the probe depends on that structural contract
 * rather than on the concrete `PrismaService` type. Keeping the dependency
 * narrow means the probe stays typecheckable independently of how the Prisma
 * client is generated, and it documents exactly what the readiness check uses.
 */
type PingablePrismaClient = {
  $runCommandRaw: (command: Record<string, number>) => unknown;
};

/**
 * `/health` and `/health/ready` are deliberately different probes (#933).
 *
 * | Endpoint           | Kubernetes probe | Checks DB? | Use when                        |
 * | ------------------ | ---------------- | ---------- | ------------------------------- |
 * | `/v1/health`       | liveness         | no         | the process should be restarted  |
 * | `/v1/health/ready` | readiness        | yes        | the pod should receive traffic   |
 *
 * Using the DB-checking probe as the *liveness* probe is the classic
 * misconfiguration: a transient database blip then restarts every replica,
 * turning a recoverable dependency outage into a self-inflicted outage. The
 * liveness probe here touches no external dependency, so it only fails when the
 * process itself is broken.
 *
 * Readiness **fails closed**: any dependency error produces `503`, so traffic is
 * drained from a pod that cannot serve it rather than being routed to a pod
 * that will error on every request.
 *
 * `/v1/ready` (in `AppController`) is retained as a compatibility alias for the
 * readiness probe; it delegates to the same database check and both behave
 * identically.
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: PrismaHealthIndicator,
    // Injected by the `PrismaService` token but typed structurally: Terminus
    // only needs `$runCommandRaw`. The explicit `@Inject` keeps the DI token
    // clear while the narrow type keeps the probe independent of how the
    // Prisma client is generated.
    @Inject(PrismaService) private readonly prisma: PingablePrismaClient,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Liveness probe. Intentionally performs **no** I/O: it must stay green while
   * the database or Horizon are down so a dependency outage does not trigger a
   * restart storm. `/v1/health/live` is an explicit alias for the same probe.
   */
  @Public()
  @Get()
  @ApiOperation({
    summary:
      'Liveness probe (no external dependencies) — never fails on a DB outage',
  })
  @ApiResponse({
    status: 200,
    description: 'Service process is alive and responsive',
    schema: {
      example: {
        status: 'ok',
        build: { gitSha: 'a1b2c3d4e5f6' },
      },
    },
  })
  live(): { status: string; build: HealthBuildInfo } {
    return {
      status: 'ok',
      build: this.buildInfo(),
    };
  }

  /** Explicit alias so probe configuration can be unambiguous. */
  @Public()
  @Get('live')
  @ApiOperation({ summary: 'Liveness probe (alias of GET /health)' })
  @ApiResponse({ status: 200, description: 'Service process is alive' })
  liveAlias(): { status: string; build: HealthBuildInfo } {
    return this.live();
  }

  /**
   * Readiness probe. Verifies the database is reachable and **fails closed**
   * with `503` when it is not, so a pod that cannot serve wallet/payment traffic
   * is removed from the load balancer instead of erroring on live requests.
   */
  @Public()
  @Get('ready')
  @HealthCheck()
  @ApiOperation({
    summary: 'Readiness probe — verifies database connectivity (fails closed)',
  })
  @ApiResponse({
    status: 200,
    description: 'Service is ready to serve traffic',
  })
  @ApiResponse({
    status: 503,
    description:
      'A dependency is unavailable; the pod must not receive traffic',
  })
  async check(): Promise<ReadinessProbeResult> {
    try {
      const result = await this.health.check([
        // The client is the second positional argument: `pingCheck(key, prismaClient, options)`.
        // Passing `{ timeout }` there instead makes Terminus call
        // `$runCommandRaw` on a plain object, which always throws, so the
        // indicator reports `down` and the pod is permanently un-ready.
        () => this.db.pingCheck('database', this.prisma, { timeout: 3000 }),
      ]);

      return { ...result, build: this.buildInfo() };
    } catch (error) {
      // Fail closed. Surface the dependency status to the operator, but never
      // let an unexpected error type escape as a 200, and never leak secrets —
      // only the build commit hash is added.
      if (error instanceof ServiceUnavailableException) {
        const response = error.getResponse();
        const body =
          typeof response === 'object' && response !== null
            ? (response as Record<string, unknown>)
            : { status: 'error' };

        throw new ServiceUnavailableException({
          ...body,
          build: this.buildInfo(),
        });
      }

      throw error;
    }
  }

  /**
   * Git SHA of the running build, injected at container build time via the
   * GIT_SHA env var (see Dockerfile). Never sourced from anything that could
   * leak secrets — just a commit hash.
   */
  private buildInfo(): HealthBuildInfo {
    return { gitSha: this.getGitSha() };
  }

  private getGitSha(): string {
    return this.configService.get<string>('GIT_SHA') ?? 'unknown';
  }
}
