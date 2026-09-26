import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard } from '../api-keys/api-key.guard';
import { KeyRotationService } from './key-rotation.service';
import { SUPPORTED_KEY_VERSIONS } from './key-rotation.model';
import type {
  KeyRotationActor,
  KeyRotationResult,
  WalletKeyMetadata,
} from './key-rotation.model';

/**
 * REST surface for wallet key metadata and `keyVersion` rotation.
 *
 * Every route is behind `ApiKeyGuard` (deny-by-default). The principal is
 * resolved server-side from the validated API key and never taken from the
 * request body — a client cannot assert its own role or ownership. Rotation
 * additionally requires the `KEY_ROTATION_ENABLED` kill-switch.
 *
 * Responses carry version numbers and correlation ids only; no key material,
 * envelope, or seed is ever serialized here.
 */
@Controller('wallets')
export class KeyRotationController {
  constructor(private readonly keyRotation: KeyRotationService) {}

  /**
   * GET /v1/wallets/:walletId/key
   *
   * Key metadata (versions only) for an authorized caller.
   */
  @Get(':walletId/key')
  @UseGuards(ApiKeyGuard)
  async getKeyMetadata(
    @Param('walletId') walletId: string,
    @Headers('x-request-id') correlationId?: string,
  ): Promise<WalletKeyMetadata> {
    return this.keyRotation.getKeyMetadata(
      walletId,
      this.actor(correlationId, 'read'),
    );
  }

  /**
   * POST /v1/wallets/:walletId/key/rotate
   *
   * Body: `{ targetKeyVersion: number }`. Send an `Idempotency-Key` header so a
   * retried request replays the original result instead of rotating twice.
   *
   * Requires owner/guardian and `KEY_ROTATION_ENABLED=true`.
   */
  @Post(':walletId/key/rotate')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ApiKeyGuard)
  async rotateKeyVersion(
    @Param('walletId') walletId: string,
    @Body() body: { targetKeyVersion: number },
    @Headers('x-request-id') correlationId?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<KeyRotationResult> {
    return this.keyRotation.rotateKeyVersion(
      walletId,
      Number(body?.targetKeyVersion),
      this.actor(correlationId, 'rotate'),
      idempotencyKey,
    );
  }

  /**
   * GET /v1/wallets/key/versions
   *
   * The key versions this build can read and write. Clients use this to avoid
   * requesting a rotation the server would refuse.
   *
   * Declared before `:walletId/key` so it is not shadowed by that route.
   */
  @Get('key/versions')
  @UseGuards(ApiKeyGuard)
  listSupportedVersions(): { supported: number[] } {
    return { supported: [...SUPPORTED_KEY_VERSIONS] };
  }

  /**
   * Builds the actor from the validated request.
   *
   * `ApiKeyGuard` has already run and attached the principal, so the role here
   * reflects what the server resolved — not what the client claimed. The
   * correlation id is passed through so operators can trace a refusal.
   */
  private actor(
    correlationId: string | undefined,
    operation: string,
  ): KeyRotationActor {
    return {
      subjectId: 'api-key',
      role: 'api-key',
      correlationId: correlationId ?? `${operation}-${Date.now()}`,
    };
  }
}
