# OpenTelemetry Tracing

This module provides optional OpenTelemetry tracing support for the Mux Backend API.

## Overview

The tracing system is designed to be:
- **Optional**: Entirely opt-in via environment configuration
- **Non-invasive**: Works correctly whether or not OpenTelemetry is enabled
- **Safe**: Gracefully handles missing OpenTelemetry dependencies
- **Extensible**: Easy to add tracing to specific operations

## Configuration

### Enable Tracing

Set the `OTEL_ENABLED` environment variable to `true`:

```bash
OTEL_ENABLED=true
```

### OpenTelemetry Environment Variables

When enabled, configure OpenTelemetry using standard environment variables:

```bash
# Core configuration
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf

# Service configuration
OTEL_SERVICE_NAME=mux-backend
OTEL_SERVICE_VERSION=1.0.0
OTEL_SERVICE_NAMESPACE=production

# Sampling
OTEL_TRACES_SAMPLER=always_on  # or parentbased_always_on, always_off, etc.

# Optional: Custom attributes
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=production,service.instance.id=backend-1
```

## Installation

To enable full OpenTelemetry tracing, install the required packages:

```bash
npm install \
  @opentelemetry/auto \
  @opentelemetry/sdk-trace-node \
  @opentelemetry/auto-instrumentations-node \
  @opentelemetry/exporter-trace-otlp-http \
  @opentelemetry/resources \
  @opentelemetry/semantic-conventions
```

## Usage

### Automatic HTTP Tracing

HTTP requests are automatically traced if you enable the `TracingInterceptor`. To do so, add it to your app module:

```typescript
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TracingInterceptor } from './tracing/tracing.interceptor';

@Module({
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: TracingInterceptor,
    },
  ],
})
export class AppModule {}
```

### Manual Method Tracing

Use the `@Trace()` decorator to add tracing to specific service methods:

```typescript
import { Trace } from './tracing/trace.decorator';

@Injectable()
export class MyService {
  @Trace()
  async performOperation() {
    // This method will be automatically traced
  }
}
```

### Accessing the Tracer

Inject `TracingService` to access the tracer:

```typescript
import { TracingService } from './tracing/tracing.service';

@Injectable()
export class MyService {
  constructor(private readonly tracingService: TracingService) {}

  async doWork() {
    const tracer = this.tracingService.getTracer();
    const span = tracer.startSpan('custom-operation');
    try {
      // Do work
      span.setAttribute('operation.status', 'success');
    } catch (err) {
      span.setAttribute('error', true);
      span.setAttribute('error.message', err.message);
      throw err;
    } finally {
      span.end();
    }
  }
}
```

## Backend Integration

### Jaeger

For local development with Jaeger:

```bash
docker run -d \
  --name jaeger \
  -p 6831:6831/udp \
  -p 16686:16686 \
  jaegertracing/all-in-one
```

Set environment variables:
```bash
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

View traces at: http://localhost:16686

### Datadog

For Datadog integration:

```bash
# Install Datadog exporter
npm install @opentelemetry/exporter-trace-otlp-http
```

Set environment variables:
```bash
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=https://api.datadoghq.com/v1/traces
DD_API_KEY=<your-api-key>
```

### Other OTLP-Compatible Backends

Any backend that supports the OpenTelemetry Protocol (OTLP) can be used:
- Elastic Observability
- New Relic
- Honeycomb
- Splunk
- AWS X-Ray
- Azure Application Insights

## Performance Considerations

- **No-op mode**: When disabled, the tracing system has negligible performance impact
- **Sampling**: Use `OTEL_TRACES_SAMPLER` to reduce trace volume in production
- **Batching**: OpenTelemetry automatically batches spans for efficient transmission
- **Context propagation**: Trace context is automatically propagated across service boundaries

## Best Practices

1. **Enable in Production**: Use sampling to balance observability with performance
2. **Structured Logging**: Combine tracing with structured logging for complete observability
3. **Custom Attributes**: Add meaningful attributes to spans for easier debugging
4. **Error Handling**: Ensure error information is captured in span attributes
5. **Service Names**: Use descriptive service names to identify components in traces

## Troubleshooting

### Traces Not Appearing

1. Check `OTEL_ENABLED` is set to `true`
2. Verify OpenTelemetry packages are installed
3. Confirm `OTEL_EXPORTER_OTLP_ENDPOINT` is reachable
4. Check `OTEL_TRACES_SAMPLER` is not set to `always_off`
5. Review server logs for initialization errors

### Performance Issues

1. Reduce sampling rate: `OTEL_TRACES_SAMPLER=parentbased_probabilistic&OTEL_TRACES_SAMPLER_ARG=0.1`
2. Disable automatic instrumentation for non-critical modules
3. Use tail sampling in your backend to filter traces
4. Monitor span export batch sizes and timeouts

## Future Enhancements

- [ ] Database query tracing
- [ ] Cache operation tracing
- [ ] Message queue instrumentation
- [ ] Custom business metrics
- [ ] Distributed tracing with context propagation
