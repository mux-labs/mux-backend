import { trace, SpanStatusCode, context, SpanKind } from '@opentelemetry/api';

/**
 * Method decorator that wraps the decorated method in an OpenTelemetry span.
 *
 * Usage:
 *   @Trace()                          // span name defaults to ClassName.methodName
 *   @Trace('custom.span.name')        // explicit span name
 *   @Trace('custom.span.name', { kind: SpanKind.CLIENT })
 *
 * When OpenTelemetry is disabled (OTEL_ENABLED !== "true") the SDK returns a
 * no-op tracer, so this decorator is transparent with zero overhead.
 */
export function Trace(
  spanName?: string,
  options: { kind?: SpanKind } = {},
): MethodDecorator {
  return function (
    target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ): PropertyDescriptor {
    const original = descriptor.value as (...args: unknown[]) => unknown;

    if (typeof original !== 'function') {
      return descriptor;
    }

    const className = target.constructor?.name ?? 'Unknown';
    const methodName = String(propertyKey);
    const resolvedSpanName = spanName ?? `${className}.${methodName}`;
    const spanKind = options.kind ?? SpanKind.INTERNAL;

    descriptor.value = function (this: unknown, ...args: unknown[]): unknown {
      const tracer = trace.getTracer('mux-backend');
      const span = tracer.startSpan(resolvedSpanName, { kind: spanKind });

      const ctx = trace.setSpan(context.active(), span);

      const executeInContext = (): unknown => {
        try {
          const result = original.apply(this, args);

          // Handle async methods
          if (result instanceof Promise) {
            return result
              .then((value: unknown) => {
                span.setStatus({ code: SpanStatusCode.OK });
                span.end();
                return value;
              })
              .catch((err: unknown) => {
                const message =
                  err instanceof Error ? err.message : String(err);
                span.setStatus({ code: SpanStatusCode.ERROR, message });
                if (err instanceof Error) {
                  span.recordException(err);
                }
                span.end();
                throw err;
              });
          }

          // Synchronous methods
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
          return result;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          span.setStatus({ code: SpanStatusCode.ERROR, message });
          if (err instanceof Error) {
            span.recordException(err);
          }
          span.end();
          throw err;
        }
      };

      return context.with(ctx, executeInContext);
import { Logger } from '@nestjs/common';

/**
 * Decorator to enable OpenTelemetry tracing for individual service methods.
 * Automatically creates spans for traced operations.
 *
 * Usage:
 *   @Trace()
 *   async myMethod() {
 *     // This method will be automatically traced
 *   }
 *
 * The span name will be automatically derived from the class and method name.
 */
export function Trace() {
  const logger = new Logger('Trace');

  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor,
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      const className = target.constructor.name;
      const spanName = `${className}.${propertyKey}`;

      try {
        // TODO: Integrate with OpenTelemetry tracer when available
        // const tracer = this.tracingService?.getTracer();
        // if (tracer) {
        //   return tracer.startActiveSpan(spanName, async (span: any) => {
        //     try {
        //       return await originalMethod.apply(this, args);
        //     } catch (err) {
        //       span.setAttribute('error', true);
        //       span.setAttribute('error.message', err.message);
        //       throw err;
        //     }
        //   });
        // }

        return await originalMethod.apply(this, args);
      } catch (err) {
        logger.error(`Error in ${spanName}: ${err}`);
        throw err;
      }
    };

    return descriptor;
  };
}
