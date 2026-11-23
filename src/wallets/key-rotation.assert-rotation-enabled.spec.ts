import { ServiceUnavailableException } from '@nestjs/common';
import {
  KEY_ROTATION_ENABLED_ENV,
  KeyRotationErrorCode,
} from './key-rotation.model';
import { KeyRotationService } from './key-rotation.service';

describe('KeyRotationService.assertRotationEnabled', () => {
  const originalFlag = process.env[KEY_ROTATION_ENABLED_ENV];

  const buildService = () => {
    const metrics = { incrementCounter: jest.fn() };
    const store = {
      wallet: { findUnique: jest.fn(), update: jest.fn() },
    };
    const service = new KeyRotationService(store as any, undefined, metrics as any);
    return {
      service,
      metrics,
      assertEnabled: () => (service as any).assertRotationEnabled(),
    };
  };

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env[KEY_ROTATION_ENABLED_ENV];
    } else {
      process.env[KEY_ROTATION_ENABLED_ENV] = originalFlag;
    }
  });

  it('refuses rotations when the operator flag is absent (deny by default)', () => {
    delete process.env[KEY_ROTATION_ENABLED_ENV];
    const { assertEnabled, metrics } = buildService();

    expect(() => assertEnabled()).toThrow(ServiceUnavailableException);
    try {
      assertEnabled();
    } catch (error) {
      expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
        code: KeyRotationErrorCode.FEATURE_FLAG_DISABLED,
      });
    }
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      'key_rotation_blocked_by_flag',
    );
  });

  it('treats a mistyped flag value as disabled rather than enabling rotation', () => {
    process.env[KEY_ROTATION_ENABLED_ENV] = 'tru';
    const { assertEnabled } = buildService();

    expect(() => assertEnabled()).toThrow(ServiceUnavailableException);
  });

  it.each(['true', '1'])('allows rotations once explicitly enabled (%s)', (value) => {
    process.env[KEY_ROTATION_ENABLED_ENV] = value;
    const { assertEnabled, metrics } = buildService();

    expect(assertEnabled()).toBeUndefined();
    expect(metrics.incrementCounter).not.toHaveBeenCalled();
  });
});
