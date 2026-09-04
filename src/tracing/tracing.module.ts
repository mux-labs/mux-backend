import { Module } from '@nestjs/common';
import { TracingService } from './tracing.service';

@Module({
  providers: [TracingService],
  exports: [TracingService],
})
export class TracingModule {}
import { Module, DynamicModule, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TracingService } from './tracing.service';

/**
 * Optional OpenTelemetry tracing module that conditionally initializes
 * tracing infrastructure based on environment configuration.
 *
 * To enable: set OTEL_ENABLED=true and configure OpenTelemetry environment variables.
 * When disabled, provides no-op tracing that has minimal performance impact.
 */
@Module({})
export class TracingModule {
  private static readonly logger = new Logger(TracingModule.name);

  static forRoot(): DynamicModule {
    return {
      module: TracingModule,
      providers: [TracingService],
      exports: [TracingService],
    };
  }

  constructor(
    private readonly configService: ConfigService,
    private readonly tracingService: TracingService,
  ) {
    const enabled = this.configService.get<string>('OTEL_ENABLED', 'false') === 'true';
    if (enabled) {
      TracingModule.logger.log('OpenTelemetry tracing enabled');
      this.tracingService.initialize();
    } else {
      TracingModule.logger.log(
        'OpenTelemetry tracing disabled (set OTEL_ENABLED=true to enable)',
      );
    }
  }
}
