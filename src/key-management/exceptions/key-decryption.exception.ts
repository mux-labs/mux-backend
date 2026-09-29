import { HttpException, HttpStatus } from '@nestjs/common';
import { DecryptionErrorCode } from '../../encryption/encryption.service';

/**
 * HTTP exception thrown when private key material cannot be decrypted.
 *
 * Maps to 422 Unprocessable Entity so callers can distinguish decrypt failures
 * (corrupt/stale data, wrong key) from generic 500 server errors.
 *
 * Security note: The public `reason` field only exposes a stable code string —
 * never raw crypto error messages or key material.
 */
export class KeyDecryptionException extends HttpException {
  /** Machine-readable reason code forwarded in the response body. */
  readonly reason: DecryptionErrorCode;

  /** Wallet/key identifier (for operator logs only — not included in HTTP body). */
  readonly keyId: string;

  constructor(keyId: string, reason: DecryptionErrorCode, detail?: string) {
    super(
      {
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        error: 'Key Decryption Failed',
        message: detail ?? 'Key material could not be decrypted',
        reason,
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );

    this.reason = reason;
    this.keyId = keyId;
    this.name = 'KeyDecryptionException';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
