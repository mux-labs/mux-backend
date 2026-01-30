import { Injectable, Logger } from '@nestjs/common';
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

export interface AuthenticationRequest {
  authId: string;
  email?: string;
  displayName?: string;
  authProvider?: string;
  network?: WalletNetwork;
}

export interface AuthenticationResult {
  user: {
    id: string;
    authId: string;
    email?: string;
    displayName?: string;
    status: string;
    authProvider: string;
  };
  wallet: {
    id: string;
    publicKey: string;
    network: WalletNetwork;
    status: string;
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
@Injectable()
export class AuthOrchestrator {
  private readonly logger = new Logger(AuthOrchestrator.name);

  constructor(
    private readonly idempotentUserService: IdempotentUserService,
    private readonly walletCreationOrchestrator: WalletCreationOrchestrator,
  ) {}

  /**
   * Handles first-time or returning user authentication.
   * Creates user and wallet atomically on first authentication.
   */
  async handleAuthentication(
    request: AuthenticationRequest,
  ): Promise<AuthenticationResult> {
    const startTime = Date.now();
    const network = request.network || WalletNetwork.TESTNET;

    this.logger.log(
      `Starting authentication orchestration for authId: ${request.authId}`,
    );

    try {
      // Step 1: Find or create user (idempotent)
      const userResult = await this.findOrCreateUser(request);

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

      return {
        user: {
          id: userResult.user.id,
          authId: userResult.user.authId,
          email: userResult.user.email,
          displayName: userResult.user.displayName,
          status: userResult.user.status,
          authProvider: userResult.user.authProvider,
        },
        wallet: {
          id: walletResult.wallet.id,
          publicKey: walletResult.wallet.publicKey,
          network: walletResult.wallet.network,
          status: walletResult.wallet.status,
        },
        isNewUser: userResult.isNewUser,
        isNewWallet: walletResult.isNewWallet,
      };
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
}
