import { Injectable, Logger, ForbiddenException } from '@nestjs/common';
import {
  IdempotentUserService,
  FindOrCreateUserRequest,
  FindOrCreateUserResult,
} from '../users/idempotent-user.service';
import {
  WalletCreationOrchestrator,
  CreateWalletOrchestratorRequest,
} from '../wallets/wallet-creation-orchestrator.service';
import { WalletNetwork } from '../wallets/domain/wallet.model';
import { IdempotencyService } from '../common/idempotency/idempotency.service';

export interface AuthenticationRequest {
  authId: string;
  email?: string;
  displayName?: string;
  authProvider?: string;
  network?: WalletNetwork;
}

export class AuthPayloadValidator {
  static validate(payload: any): void {
    if (!payload) {
      throw new BadRequestException('Authentication payload is required');
    }

    if (typeof payload !== 'object') {
      throw new BadRequestException('Authentication payload must be an object');
    }

    // Validate authId (required, maps to JWT 'sub' claim)
    if (!payload.authId || typeof payload.authId !== 'string') {
      throw new BadRequestException(
        'Invalid authentication payload: authId is required and must be a string',
      );
    }

    if (payload.authId.trim().length === 0) {
      throw new BadRequestException(
        'Invalid authentication payload: authId cannot be empty',
      );
    }

    // Validate email format if provided
    if (payload.email !== undefined && payload.email !== null) {
      if (typeof payload.email !== 'string') {
        throw new BadRequestException(
          'Invalid authentication payload: email must be a string',
        );
      }

      if (payload.email.trim().length > 0) {
        if (!this.isValidEmail(payload.email)) {
          throw new BadRequestException(
            'Invalid authentication payload: email format is invalid',
          );
        }
      }
    }

    // Validate displayName if provided
    if (payload.displayName !== undefined && payload.displayName !== null) {
      if (typeof payload.displayName !== 'string') {
        throw new BadRequestException(
          'Invalid authentication payload: displayName must be a string',
        );
      }

      if (payload.displayName.trim().length === 0) {
        throw new BadRequestException(
          'Invalid authentication payload: displayName cannot be empty',
        );
      }
    }

    // Validate authProvider if provided
    if (payload.authProvider !== undefined && payload.authProvider !== null) {
      if (typeof payload.authProvider !== 'string') {
        throw new BadRequestException(
          'Invalid authentication payload: authProvider must be a string',
        );
      }

      if (payload.authProvider.trim().length === 0) {
        throw new BadRequestException(
          'Invalid authentication payload: authProvider cannot be empty',
        );
      }
    }

    // Validate network if provided
    if (payload.network !== undefined && payload.network !== null) {
      if (
        typeof payload.network !== 'string' ||
        !Object.values(WalletNetwork).includes(payload.network)
      ) {
        throw new BadRequestException(
          'Invalid authentication payload: network must be a valid WalletNetwork',
        );
      }
    }
  }

  private static isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }
}

export interface AuthenticationResult {
  user: {
    id: string;
    authId: string;
    email?: string;
    displayName?: string;
    status: string;
    authProvider: string;
    lastLoginAt: Date | null;
  };
  wallet: {
    id: string;
    publicKey: string;
    network: WalletNetwork;
    status: string;
    createdAt: Date;
  };
  isNewUser: boolean;
  isNewWallet: boolean;
}

/**
 * Orchestrates authentication flow with automatic wallet creation.
 *
 * This service ensures that:
 * 1. Every authenticated user has exactly one user record
 * 2. Every authenticated user has exactly one wallet per network
 * 3. All operations are idempotent and atomic
 */
export interface AuthenticationRequestWithIdempotency extends AuthenticationRequest {
  idempotencyKey?: string;
}

export interface AuthenticationResultWithMetadata extends AuthenticationResult {
  _idempotencyReplayed?: boolean;
}

@Injectable()
export class AuthOrchestrator {
  private readonly logger = new Logger(AuthOrchestrator.name);

  constructor(
    private readonly idempotentUserService: IdempotentUserService,
    private readonly walletCreationOrchestrator: WalletCreationOrchestrator,
    private readonly idempotencyService: IdempotencyService,
  ) {}

  /**
   * Handles first-time or returning user authentication.
   * Creates user and wallet atomically on first authentication.
   * Supports idempotency via optional Idempotency-Key header.
   */
  async handleAuthentication(
    request: AuthenticationRequestWithIdempotency,
  ): Promise<AuthenticationResult> {
    const startTime = Date.now();

    // Validate auth provider payload shape before processing
    AuthPayloadValidator.validate(request);

    const network = request.network || WalletNetwork.TESTNET;

    this.logger.log(
      `Starting authentication orchestration for authId: ${request.authId}`,
    );

    try {
      // Check idempotency cache if key provided
      if (request.idempotencyKey) {
        const cachedResponse = await this.idempotencyService.getCachedResponse(
          request.idempotencyKey,
        );
        if (cachedResponse) {
          this.logger.log(
            `Returning cached authentication result for idempotency key: ${request.idempotencyKey}`,
          );
          return {
            ...cachedResponse,
            _idempotencyReplayed: true,
          };
        }
      }

      // Step 1: Find or create user (idempotent)
      const userResult = await this.findOrCreateUser(request);

      // Step 1.5: Check if user is active
      this.validateUserStatus(userResult.user);

      // Step 2: Ensure user has a wallet (idempotent)
      const walletResult = await this.ensureUserHasWallet(
        userResult.user.id,
        network,
        userResult.isNewUser,
      );

      const duration = Date.now() - startTime;
      this.logger.log(
        `Authentication orchestration completed in ${duration}ms for authId: ${request.authId} ` +
          `(newUser: ${userResult.isNewUser}, newWallet: ${walletResult.isNewWallet})`,
      );

      const result: AuthenticationResultWithMetadata = {
        user: {
          id: userResult.user.id,
          authId: userResult.user.authId,
          email: userResult.user.email,
          displayName: userResult.user.displayName,
          status: userResult.user.status,
          authProvider: userResult.user.authProvider,
          lastLoginAt: userResult.user.lastLoginAt ?? null,
        },
        wallet: {
          id: walletResult.wallet.id,
          publicKey: walletResult.wallet.publicKey,
          network: walletResult.wallet.network,
          status: walletResult.wallet.status,
          createdAt: walletResult.wallet.createdAt,
        },
        isNewUser: userResult.isNewUser,
        isNewWallet: walletResult.isNewWallet,
        _idempotencyReplayed: false,
      };

      // Cache response if idempotency key provided
      if (request.idempotencyKey) {
        const cachePayload = { ...result };
        delete cachePayload._idempotencyReplayed;
        await this.idempotencyService.cacheResponse(
          request.idempotencyKey,
          cachePayload,
          'POST',
          '/auth/authenticate',
          200,
          { ttlMs: 60000 }, // 60 seconds TTL
        );
      }

      return result;
    } catch (error) {
      this.logger.error(
        `Authentication orchestration failed for authId ${request.authId}:`,
        error,
      );
      throw new Error(`Authentication failed: ${error.message}`);
    }
  }

  /**
   * Step 1: Find or create user using idempotent service
   */
  private async findOrCreateUser(
    request: AuthenticationRequest,
  ): Promise<FindOrCreateUserResult> {
    const userRequest: FindOrCreateUserRequest = {
      authId: request.authId,
      email: request.email,
      displayName: request.displayName,
      authProvider: request.authProvider || 'UNKNOWN',
    };

    return await this.idempotentUserService.findOrCreateUser(userRequest);
  }

  /**
   * Step 2: Ensure user has a wallet on the specified network
   */
  private async ensureUserHasWallet(
    userId: string,
    network: WalletNetwork,
    isNewUser: boolean,
  ) {
    // Check if wallet already exists
    const existingWallet =
      await this.walletCreationOrchestrator.getWalletByUser(userId, network);

    if (existingWallet) {
      this.logger.log(`User ${userId} already has wallet on ${network}`);
      return {
        wallet: existingWallet,
        isNewWallet: false,
      };
    }

    // Create new wallet (idempotent)
    this.logger.log(`Creating wallet for user ${userId} on ${network}`);
    const walletRequest: CreateWalletOrchestratorRequest = {
      userId,
      network,
      idempotencyKey: `auth-wallet-${userId}-${network}`, // Idempotency key for safety
    };

    const walletResult =
      await this.walletCreationOrchestrator.createWallet(walletRequest);

    return {
      wallet: walletResult.wallet,
      isNewWallet: walletResult.isNewWallet,
    };
  }

  /**
   * Validates that a user can authenticate (pre-authentication check)
   */
  async validateAuthentication(authId: string): Promise<boolean> {
    try {
      // Check if user exists
      const user = await this.idempotentUserService.findUserByAuthId(authId);

      // User can authenticate if they exist or if they're new
      return true;
    } catch (error) {
      this.logger.error(
        `Authentication validation failed for authId ${authId}:`,
        error,
      );
      return false;
    }
  }

  /**
   * Validates that user status permits authentication
   * Rejects users that are inactive, suspended, or soft-deleted
   * Treats missing status as active (backward-compatible)
   */
  private validateUserStatus(user: { status?: string }): void {
    const status = user.status || 'ACTIVE';

    if (status !== 'ACTIVE') {
      this.logger.warn(`Authentication rejected: user status is ${status}`);
      throw new ForbiddenException('Account is inactive');
    }
  }
}
