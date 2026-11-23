import { ConflictException } from '@nestjs/common';
import { KeyRotationErrorCode } from './key-rotation.model';
import { KeyRotationService } from './key-rotation.service';

describe('KeyRotationService.assertNoIdempotencyConflict', () => {
  const buildService = () => {
    const metrics = { incrementCounter: jest.fn() };
    const store = {
      wallet: { findUnique: jest.fn(), update: jest.fn() },
    };
    const service = new KeyRotationService(store as any, undefined, metrics as any);
    return {
      service,
      metrics,
      assertNoConflict: (replay: any, target: number) =>
        (service as any).assertNoIdempotencyConflict(replay, target),
    };
  };

  const recordedResult = {
    walletId: 'wallet-1',
    previousKeyVersion: 1,
    keyVersion: 2,
    secretVersion: 3,
    rotatedAt: new Date(),
    applied: true,
  };

  it('accepts a fresh idempotency key (no recorded replay)', () => {
    const { assertNoConflict, metrics } = buildService();

    expect(assertNoConflict(null, 2)).toBeUndefined();
    expect(metrics.incrementCounter).not.toHaveBeenCalled();
  });

  it('accepts a replay for the same target version', () => {
    const { assertNoConflict, metrics } = buildService();

    expect(
      assertNoConflict({ targetKeyVersion: 2, result: recordedResult }, 2),
    ).toBeUndefined();
    expect(metrics.incrementCounter).not.toHaveBeenCalled();
  });

  it('refuses a changed target version with an idempotency conflict', () => {
    const { assertNoConflict, metrics } = buildService();

    expect(() =>
      assertNoConflict({ targetKeyVersion: 2, result: recordedResult }, 3),
    ).toThrow(ConflictException);

    try {
      assertNoConflict({ targetKeyVersion: 2, result: recordedResult }, 3);
    } catch (error) {
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: KeyRotationErrorCode.IDEMPOTENCY_CONFLICT,
      });
    }
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      'key_rotation_idempotency_conflict',
    );
  });
});
