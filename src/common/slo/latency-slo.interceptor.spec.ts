import { of, throwError } from 'rxjs';
import { LatencySloInterceptor } from './latency-slo.interceptor';
import { LatencySloService } from './latency-slo.service';
import { SloDefinition } from './slo.types';

/** Build a minimal NestJS ExecutionContext double for HTTP requests. */
function makeContext(method = 'GET', path = '/wallets', routePath?: string) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        method,
        url: path,
        path,
        route: routePath ? { path: routePath } : undefined,
      }),
      getResponse: () => ({ statusCode: 200 }),
    }),
  } as any;
}

describe('LatencySloInterceptor', () => {
  const SLOS: SloDefinition[] = [
    {
      name: 'wallet_read',
      routePrefix: '/wallets',
      method: 'GET',
      thresholdMs: 200,
      targetCompliance: 0.99,
    },
  ];

  let sloService: LatencySloService;
  let interceptor: LatencySloInterceptor;

  beforeEach(() => {
    sloService = new LatencySloService(SLOS);
    interceptor = new LatencySloInterceptor(sloService);
  });

  it('records an observation after a successful request', (done) => {
    const spy = jest.spyOn(sloService, 'record');
    const context = makeContext('GET', '/wallets');
    const next = { handle: () => of({ id: '1' }) };

    interceptor.intercept(context, next).subscribe({
      complete: () => {
        expect(spy).toHaveBeenCalledTimes(1);
        const obs = spy.mock.calls[0][0];
        expect(obs.method).toBe('GET');
        expect(obs.route).toBe('/wallets');
        expect(obs.durationMs).toBeGreaterThanOrEqual(0);
        done();
      },
    });
  });

  it('records an observation even when the handler throws', (done) => {
    const spy = jest.spyOn(sloService, 'record');
    const context = makeContext('GET', '/wallets');
    const next = { handle: () => throwError(() => new Error('fail')) };

    interceptor.intercept(context, next).subscribe({
      error: () => {
        expect(spy).toHaveBeenCalledTimes(1);
        done();
      },
    });
  });

  it('uses the route template (e.g. /wallets/:id) when available', (done) => {
    const spy = jest.spyOn(sloService, 'record');
    const context = makeContext('GET', '/wallets/abc123', '/wallets/:id');
    const next = { handle: () => of({}) };

    interceptor.intercept(context, next).subscribe({
      complete: () => {
        const obs = spy.mock.calls[0][0];
        expect(obs.route).toBe('/wallets/:id');
        done();
      },
    });
  });

  it('passes through without recording when no sloService is injected', (done) => {
    const noServiceInterceptor = new LatencySloInterceptor(undefined);
    const context = makeContext('GET', '/wallets');
    const next = { handle: () => of({}) };

    // Should not throw and should emit the value unchanged
    noServiceInterceptor.intercept(context, next).subscribe({
      next: (val) => {
        expect(val).toEqual({});
        done();
      },
    });
  });
});
