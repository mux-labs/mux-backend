import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Stable, machine-readable error codes returned by the API.
 *
 * These codes are part of the public contract: clients (wallets, AA
 * providers, payment flows) branch on them, so they must remain stable
 * across releases. Add new codes; never repurpose existing ones.
 */
export enum ErrorCode {
  /** Request failed validation (bad/oversized payload, malformed input). */
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  /** Caller is not authenticated (missing/invalid/expired credentials). */
  UNAUTHENTICATED = 'UNAUTHENTICATED',
  /** Caller is authenticated but not permitted for this resource/action. */
  FORBIDDEN = 'FORBIDDEN',
  /** Requested resource does not exist (or is not visible to the caller). */
  NOT_FOUND = 'NOT_FOUND',
  /** Conflicting state, e.g. replayed request with a different payload. */
  CONFLICT = 'CONFLICT',
  /** Rate limit exceeded for the caller/route. */
  RATE_LIMITED = 'RATE_LIMITED',
  /** A required upstream dependency (RPC/DB/Horizon) is unavailable. */
  DEPENDENCY_UNAVAILABLE = 'DEPENDENCY_UNAVAILABLE',
  /** Unexpected server-side failure. */
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

/**
 * Canonical error envelope returned for every failed request.
 *
 * `correlationId` is echoed from the inbound request (or generated) so that
 * operators can trace a failure across logs without exposing secrets or raw
 * key material. `message` is safe for clients; never include tokens, JWTs,
 * webhook secrets, or key material here.
 */
export class ErrorEnvelopeDto {
  @ApiProperty({
    description: 'Stable, machine-readable error code.',
    enum: ErrorCode,
    example: ErrorCode.FORBIDDEN,
  })
  code!: ErrorCode;

  @ApiProperty({
    description: 'Human-readable, client-safe error message.',
    example: 'Request is not permitted.',
  })
  message!: string;

  @ApiProperty({
    description:
      'Correlation id for tracing this request across logs and services.',
    example: '3f1c9b2e-8a4d-4c1e-9f2a-1b2c3d4e5f60',
  })
  correlationId!: string;

  @ApiPropertyOptional({
    description:
      'Optional structured details (e.g. field-level validation errors).',
    type: 'object',
    additionalProperties: true,
  })
  details?: Record<string, unknown>;
}
