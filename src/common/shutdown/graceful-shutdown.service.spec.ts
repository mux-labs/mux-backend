import { ServiceUnavailableException } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import {
  DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
  GRACEFUL_SHUTDOWN_ENV,
  GracefulShutdownService,
  MAX_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
} from './graceful-shutdown.service';
import { DrainInProgressInterceptor } from './drain-in-progress.interceptor';
import { ErrorCode } from '../dto/error-envelope.dto';

const originalEnv = { ...process.env };

/** Minimal ExecutionContext stand-in carrying only the HTTP method. */
function contextFor(method: string) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ method }) }),
  } as never;
}

describe('GracefulShutdownService (#950)', () => {
  let service: GracefulShutdownService;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env[GRACEFUL_SHUTDOWN_ENV.DRAIN_ENABLED];
    delete process.env[GRACEFUL_SHUTDOWN_ENV.TIMEOUT_MS];
    service = new GracefulShutdownService();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('starts idle and not draining', () => {
    expect(service.isDraining()).toBe(false);
    expect(service.inFlightCount()).toBe(0);
    expect(service.isDrainEnabled()).toBe(true);
    expect(service.drainTimeoutMs()).toBe(DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS);
  });

  it('clamps and defaults a malformed drain budget', () => {
    process.env[GRACEFUL_SHUTDOWN_ENV.TIMEOUT_MS] = 'not-a-number';
    expect(service.drainTimeoutMs()).toBe(DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS);

    process.env[GRACEFUL_SHUTDOWN_ENV.TIMEOUT_MS] = '99999999';
    expect(service.drainTimeoutMs()).toBe(MAX_GRACEFUL_SHUTDOWN_TIMEOUT_MS);
  });

  it('tracks in-flight operations and tolerates double release', () => {
    const release = service.trackOperation('payment.submit');
    expect(service.inFlightCount()).toBe(1);

    release();
    release();
    expect(service.inFlightCount()).toBe(0);
  });

  it('drains immediately when nothing is in flight', async () => {
    await expect(service.drain(50)).resolves.toEqual({
      drained: true,
      remaining: 0,
      waitedMs: 0,
    });
  });

  it('waits for in-flight work and reports a clean drain', async () => {
    const release = service.trackOperation('payment.submit');
    const pending = service.drain(1_000);

    setTimeout(() => release(), 10);

    await expect(pending).resolves.toMatchObject({
      drained: true,
      remaining: 0,
    });
  });

  it('fails closed on the budget instead of hanging forever', async () => {
    service.trackOperation('payment.submit');

    const result = await service.drain(20);

    expect(result.drained).toBe(false);
    expect(result.remaining).toBe(1);
  });

  it('marks draining before awaiting in-flight work', async () => {
    process.env[GRACEFUL_SHUTDOWN_ENV.TIMEOUT_MS] = '1000';
    const release = service.trackOperation('payment.submit');
    const shutdown = service.beforeApplicationShutdown('SIGTERM');

    // The flag must flip synchronously so no new write slips in while waiting.
    expect(service.isDraining()).toBe(true);

    release();
    await expect(shutdown).resolves.toBeUndefined();
  });

  it('skips the drain gate when explicitly disabled', async () => {
    process.env[GRACEFUL_SHUTDOWN_ENV.DRAIN_ENABLED] = 'false';
    service.trackOperation('payment.submit');

    await service.beforeApplicationShutdown('SIGTERM');

    expect(service.isDraining()).toBe(false);
  });

  it('reports an unclean shutdown when work is still in flight', () => {
    const warn = jest
      .spyOn(service['logger'], 'warn')
      .mockImplementation(() => undefined);
    service.trackOperation('payment.submit');

    service.onApplicationShutdown();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('inFlight=1'));
  });
});

describe('DrainInProgressInterceptor (#950)', () => {
  it('passes reads through, even while draining', async () => {
    const shutdown = new GracefulShutdownService();
    shutdown.markDraining();
    const interceptor = new DrainInProgressInterceptor(shutdown);

    const result = await firstValueFrom(
      interceptor.intercept(contextFor('GET'), { handle: () => of('ok') }),
    );
    expect(result).toBe('ok');
  });

  it('passes writes through before a drain starts', async () => {
    const shutdown = new GracefulShutdownService();
    const interceptor = new DrainInProgressInterceptor(shutdown);

    const result = await firstValueFrom(
      interceptor.intercept(contextFor('POST'), { handle: () => of('ok') }),
    );
    expect(result).toBe('ok');
  });

  it('refuses writes with SHUTDOWN_IN_PROGRESS while draining', () => {
    const shutdown = new GracefulShutdownService();
    shutdown.markDraining();
    const interceptor = new DrainInProgressInterceptor(shutdown);

    try {
      interceptor.intercept(contextFor('POST'), { handle: () => of('ok') });
      throw new Error('expected the interceptor to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect((err as ServiceUnavailableException).getStatus()).toBe(503);
      expect((err as ServiceUnavailableException).getResponse()).toMatchObject({
        errorCode: ErrorCode.SHUTDOWN_IN_PROGRESS,
      });
    }
  });
});
