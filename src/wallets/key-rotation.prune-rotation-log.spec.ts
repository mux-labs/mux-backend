import { ROTATION_REPLAY_WINDOW_MS } from './key-rotation.model';
import { KeyRotationService } from './key-rotation.service';

describe('KeyRotationService.pruneRotationLog', () => {
  const buildService = () => {
    const store = { wallet: { findUnique: jest.fn(), update: jest.fn() } };
    return new KeyRotationService(store as any, undefined, {
      incrementCounter: jest.fn(),
    } as any) as any;
  };

  const result = (rotatedAt: Date) => ({
    walletId: 'wallet-1',
    previousKeyVersion: 1,
    keyVersion: 2,
    secretVersion: 3,
    rotatedAt,
    applied: true,
  });

  it('drops expired replay entries without touching unexpired ones', () => {
    const service = buildService();
    const now = Date.now();
    const expired = result(new Date(now - ROTATION_REPLAY_WINDOW_MS));
    const fresh = result(new Date(now - 1000));
    service.rotationLog.set('expired', expired);
    service.rotationLog.set('fresh', fresh);

    service.pruneRotationLog();

    expect(service.rotationLog.has('expired')).toBe(false);
    expect(service.rotationLog.get('fresh')).toBe(fresh);
  });

  it('keeps the log bounded by removing every stale entry', () => {
    const service = buildService();
    const now = Date.now();
    for (let i = 0; i < 5; i += 1) {
      service.rotationLog.set(
        `stale-${i}`,
        result(new Date(now - ROTATION_REPLAY_WINDOW_MS - i)),
      );
    }

    service.pruneRotationLog();

    expect(service.rotationLog.size).toBe(0);
  });
});
