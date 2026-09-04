import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly configService: ConfigService) {}

  @Public()
  @Get()
  @ApiOperation({
    summary: 'Liveness probe for Kubernetes/container orchestration (no external dependencies)',
  })
  @ApiResponse({
    status: 200,
    description: 'Service is alive and responsive',
    schema: {
      example: {
        status: 'ok',
        build: { gitSha: 'a1b2c3d4e5f6' },
      },
    },
  })
  check(): { status: string; build: { gitSha: string } } {
    return {
      status: 'ok',
      build: { gitSha: this.getGitSha() },
    };
  }

  /**
   * Git SHA of the running build, injected at container build time via the
   * GIT_SHA env var (see Dockerfile). Never sourced from anything that could
   * leak secrets — just a commit hash.
   */
  private getGitSha(): string {
    return this.configService.get<string>('GIT_SHA', 'unknown');
  }
}
