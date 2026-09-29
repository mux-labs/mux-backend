import { ServiceUnavailableException } from '@nestjs/common';
import { AppController } from './app.controller';
import type { ReadinessResult } from './app.service';

/**
 * Unit coverage for the `/v1/ready` compatibility alias (#933).
 *
 * The invariant under test is fail-closed behaviour: a database outage must
 * surface as `503`, never as a `200`. A `200` while the database is down would
 * tell the load balancer to send live wallet/payment traffic to a pod that
 * cannot serve it.
 */
function makeController(readiness: jest.Mock) {
  const appService = {
    getHello: jest.fn(() => 'Hello World!'),
    checkReadiness: readiness,
  };
  return new AppController(appService as never);
}

describe('AppController — /v1/ready alias (#933)', () => {
  it('serves the root endpoint', () => {
    expect(makeController(jest.fn()).root()).toBe('Hello World!');
  });

  it('returns the readiness result when the database responds', async () => {
    const ready: ReadinessResult = {
      status: 'ready',
      timestamp: '2026-09-29T00:00:00.000Z',
      database: { connected: true, responseTime: 3 },
    };

    await expect(
      makeController(jest.fn().mockResolvedValue(ready)).checkReadiness(),
    ).resolves.toEqual(ready);
  });

  it('fails closed with 503 when the database is unavailable', async () => {
    const notReady: ReadinessResult = {
      status: 'not_ready',
      timestamp: '2026-09-29T00:00:00.000Z',
      database: { connected: false, responseTime: 5, error: 'refused' },
    };

    await expect(
      makeController(jest.fn().mockResolvedValue(notReady)).checkReadiness(),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('does not report ready for a `connected: false` result even if status says ready', async () => {
    // Fail-closed is decided on the connection flag, never on the status
    // string, so a mislabelled payload cannot turn an outage into a 200.
    await expect(
      makeController(
        jest.fn().mockResolvedValue({
          status: 'ready',
          timestamp: '2026-09-29T00:00:00.000Z',
          database: { connected: false },
        } satisfies ReadinessResult),
      ).checkReadiness(),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
