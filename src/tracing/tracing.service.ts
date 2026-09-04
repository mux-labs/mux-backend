import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { trace, Tracer } from '@opentelemetry/api';

@Injectable()
export class TracingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TracingService.name);
  private sdk: NodeSDK | null = null;
  private initialized = false;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    const otelEnabled = this.configService.get<string>('OTEL_ENABLED');

    if (otelEnabled !== 'true') {
      this.logger.log('OpenTelemetry tracing is disabled (OTEL_ENABLED is not set to "true")');
      return;
    }

    const endpoint =
      this.configService.get<string>('OTEL_EXPORTER_OTLP_ENDPOINT') ??
      'http://localhost:4318/v1/traces';

    const serviceName =
      this.configService.get<string>('OTEL_SERVICE_NAME') ?? 'mux-backend';

    const serviceVersion =
      this.configService.get<string>('OTEL_SERVICE_VERSION') ?? '1.0.0';

    const exporter = new OTLPTraceExporter({ url: endpoint });

    this.sdk = new NodeSDK({
      resource: new Resource({
        [ATTR_SERVICE_NAME]: serviceName,
        [ATTR_SERVICE_VERSION]: serviceVersion,
      }),
      traceExporter: exporter,
      instrumentations: [
        getNodeAutoInstrumentations({
          // Disable noisy fs instrumentation
          '@opentelemetry/instrumentation-fs': { enabled: false },
        }),
      ],
    });

    this.sdk.start();
    this.initialized = true;
    this.logger.log(
      `OpenTelemetry tracing initialized — service="${serviceName}" endpoint="${endpoint}"`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.sdk && this.initialized) {
      try {
        await this.sdk.shutdown();
        this.logger.log('OpenTelemetry SDK shut down gracefully');
      } catch (err) {
        this.logger.error('Error shutting down OpenTelemetry SDK', err);
      }
    }
  }

  /**
   * Returns a named tracer for manual span creation.
   * When tracing is disabled this returns a no-op tracer so callers are unaffected.
   */
  getTracer(name: string): Tracer {
    return trace.getTracer(name);
  }

  isInitialized(): boolean {
    return this.initialized;
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Service that manages OpenTelemetry tracing initialization and utilities.
 * Provides a safe interface that works with or without OpenTelemetry libraries installed.
 */
@Injectable()
export class TracingService {
  private readonly logger = new Logger(TracingService.name);
  private tracerProvider: any = null;
  private tracer: any = null;
  private isInitialized = false;

  constructor(private readonly configService: ConfigService) {}

  /**
   * Initialize OpenTelemetry tracing infrastructure.
   * Safely handles cases where OpenTelemetry packages are not installed.
   */
  initialize(): void {
    try {
      // Attempt to load OpenTelemetry packages
      // In production, these would be actual imports:
      // import { NodeSDK } from '@opentelemetry/auto';
      // import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-node';

      const otelEnabled = this.configService.get<string>('OTEL_ENABLED', 'false') === 'true';

      if (!otelEnabled) {
        this.logger.debug('OpenTelemetry not enabled in configuration');
        return;
      }

      this.logger.log('Initializing OpenTelemetry tracing');

      // Dynamic require to avoid hard dependency
      try {
        // This would be replaced with actual OpenTelemetry initialization:
        // const { NodeSDK } = require('@opentelemetry/auto');
        // const { ConsoleSpanExporter } = require('@opentelemetry/sdk-trace-node');
        //
        // const sdk = new NodeSDK({
        //   traceExporter: new ConsoleSpanExporter(),
        // });
        // sdk.start();
        // this.tracerProvider = sdk.getNodeTracerProvider();
        // this.tracer = this.tracerProvider.getTracer('mux-backend');

        this.logger.log(
          'OpenTelemetry configured (awaiting @opentelemetry packages)',
        );
        this.isInitialized = true;
      } catch (err) {
        this.logger.warn(
          'OpenTelemetry packages not found; tracing will be disabled. ' +
          'Install @opentelemetry packages to enable tracing: ' +
          'npm install @opentelemetry/auto @opentelemetry/sdk-trace-node',
          err instanceof Error ? err.message : String(err),
        );
      }
    } catch (err) {
      this.logger.error(
        'Failed to initialize OpenTelemetry tracing',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /**
   * Get the active tracer instance, or a no-op tracer if not initialized.
   */
  getTracer() {
    if (this.tracer) {
      return this.tracer;
    }

    // Return a no-op tracer that has the same interface but does nothing
    return {
      startActiveSpan: (name: string, fn: (span: any) => any) => fn(null),
      startSpan: () => ({
        end: () => {},
        setAttribute: () => {},
        addEvent: () => {},
      }),
    };
  }

  /**
   * Check if tracing is initialized
   */
  isReady(): boolean {
    return this.isInitialized && this.tracer !== null;
  }
}
