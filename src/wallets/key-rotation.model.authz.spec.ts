import { KeyRotationErrorCode } from './key-rotation.model';

describe('key-rotation.model Authz / fail-closed decrypt contract', () => {
  it('models an undecryptable envelope as a refusal, never a fallback', () => {
    // The documented failure path: the stored envelope could not be
    // decrypted, so the operation is refused with a stable error code.
    expect(KeyRotationErrorCode.DECRYPT_FAILED).toBe(
      'KEY_ROTATION_DECRYPT_FAILED',
    );

    // No code in the custody contract permits falling back to plaintext or
    // to an older key; adding one would change this deny-by-default contract.
    expect(Object.values(KeyRotationErrorCode)).not.toEqual(
      expect.arrayContaining([
        'KEY_ROTATION_PLAINTEXT_FALLBACK',
        'KEY_ROTATION_OLDER_KEY_FALLBACK',
      ]),
    );
  });

  it('keeps deny-by-default authz failures distinct from decrypt failures', () => {
    expect(KeyRotationErrorCode.NOT_AUTHORIZED).toBe(
      'KEY_ROTATION_NOT_AUTHORIZED',
    );
    expect(KeyRotationErrorCode.INSUFFICIENT_ROLE).toBe(
      'KEY_ROTATION_INSUFFICIENT_ROLE',
    );
    expect(KeyRotationErrorCode.NOT_AUTHORIZED).not.toBe(
      KeyRotationErrorCode.DECRYPT_FAILED,
    );
    expect(KeyRotationErrorCode.INSUFFICIENT_ROLE).not.toBe(
      KeyRotationErrorCode.DECRYPT_FAILED,
    );
  });
});
