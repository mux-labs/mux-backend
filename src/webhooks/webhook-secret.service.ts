import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

export const WEBHOOK_SECRET_PREFIX = 'whsec_';

/**
 * Context string mixed into the HMAC derivation so the same endpoint id
 * can never collide with derivations used for other purposes.
 */
const DERIVATION_CONTEXT = 'webhook-signing';

/**
 * WebhookSecretService
 *
 * Produces the HMAC-SHA256 signing secret for each outbound webhook endpoint
 * by deriving it deterministically from a server-held master key:
 *
 *   secret = "whsec_" + base64url(HMAC-SHA256(WEBHOOK_SIGNING_KEY, "webhook-signing:v<version>:<endpointId>"))
 *
 * The derived value is returned to the client exactly once (on create or
 * rotate) and is what the client stores to verify inbound signatures.
 *
 * At rest we persist only `sha256(secret)` — never the plaintext — exactly
 * like API keys. At dispatch time the secret is re-derived from the master
 * key + endpoint id + version, so outbound payloads can still be signed
 * without ever storing the secret.
 *
 * The master key is read from the `WEBHOOK_SIGNING_KEY` environment
 * variable. If it is missing, too short, or the placeholder, the service
 * fails closed rather than silently deriving secrets from a weak default —
 * this is required in production, where a silent mock/default would defeat
 * the entire point of hashed at-rest storage.
 */
@Injectable()
export class WebhookSecretService {
  private readonly signingKey: Buffer;

  constructor(private readonly configService: ConfigService) {
    const key = (this.configService.get<string>('WEBHOOK_SIGNING_KEY') ?? '')
      .trim();

    if (!key) {
      throw new Error(
        'WEBHOOK_SIGNING_KEY environment variable is required to derive webhook signing secrets',
      );
    }

    if (key.length < 32) {
      throw new Error(
        'WEBHOOK_SIGNING_KEY must be at least 32 characters long',
      );
    }

    if (key === 'dev-only-insecure-webhook-signing-key-min-32-chars') {
      throw new Error(
        'WEBHOOK_SIGNING_KEY environment variable cannot use the default placeholder value',
      );
    }

    this.signingKey = Buffer.from(key, 'utf8');
  }

  /**
   * Deterministically derives the signing secret for an endpoint version.
   * The same (endpointId, version) always yields the same secret, so the
   * dispatcher can recompute the value needed to sign outbound payloads.
   */
  deriveSecret(endpointId: string, version: number): string {
    const mac = crypto
      .createHmac('sha256', this.signingKey)
      .update(`${DERIVATION_CONTEXT}:v${version}:${endpointId}`)
      .digest('base64url');

    return `${WEBHOOK_SECRET_PREFIX}${mac}`;
  }

  /**
   * One-way SHA-256 hash of a secret. This is the only representation of the
   * secret persisted to the database.
   */
  hashSecret(secret: string): string {
    return crypto.createHash('sha256').update(secret).digest('hex');
  }
}
