import {
  Injectable,
  Logger,
  ForbiddenException,
  BadRequestException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  IdempotentUserService,
  FindOrCreateUserRequest,
  FindOrCreateUserResult,
  SessionListOptions,
  SessionListResult,
} from '../users/idempotent-user.service';
import { UserStatus } from '../users/entities/user.entity';
import {
  WalletCreationOrchestrator,
  CreateWalletOrchestratorRequest,
} from '../wallets/wallet-creation-orchestrator.service';
import { WalletNetwork } from '../wallets/domain/wallet.model';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { AuthMetricsService } from './auth-metrics.service';
import { RequestContextService } from '../common/request-context/request-context.service';
import { JwtVerificationService } from './jwt-verification.service';
import { retryWithBackoff } from './auth-retry.helper';
import { WebhookEventEmitterService } from '../webhooks/webhook-event-emitter.service';
import {
  AuthProvider,
  isValidAuthProvider,
  getValidProviderNames,
} from './auth-provider.enum';

/**
 * Single consolidated message returned to external callers for any
 * unclassified authentication failure (downstream DB/Stellar/wallet errors,
 * etc). Never interpolates the underlying error — those details are logged
 * server-side only, so partner-facing responses stay consistent and never
 * leak internal infrastructure state.
 */
export const EXTERNAL_AUTH_FAILURE_MESSAGE =
  'Authentication failed. Please try again later.';

export interface AuthenticationRequest {
  authId?: string;
  email?: string;
  displayName?: string;
  authProvider?: string;
  network?: WalletNetwork;
  ipAddress?: string;
  userAgent?: string;
  bearerToken?: string;
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

      const trimmedProvider = payload.authProvider.trim().toUpperCase();
      if (trimmedProvider.length === 0) {
        throw new BadRequestException(
          'Invalid authentication payload: authProvider cannot be empty',
        );
      }

      // Validate against known providers
      if (!isValidAuthProvider(trimmedProvider)) {
        throw new BadRequestException(
          `Invalid authentication payload: authProvider must be one of: ${getValidProviderNames()}`,
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
    private readonly authMetrics: AuthMetricsService,
    private readonly jwtVerification: JwtVerificationService,
    private readonly webhookEventEmitter: WebhookEventEmitterService,
  ) {}

  /**
   * Prefix for log lines correlating them with the inbound request that
   * triggered this auth/session operation. Falls back to 'n/a' when called
   * outside the AsyncLocalStorage context (e.g. a unit test constructing
   * this service directly without going through requestLogger middleware).
   */
  private logPrefix(): string {
    return `[reqId=${RequestContextService.getCurrentRequestId() ?? 'n/a'}]`;
  }

  /**
   * Handles first-time or returning user authentication.
   * Creates user and wallet atomically on first authentication.
   * Supports idempotency via optional Idempotency-Key header.
   *
   * CRITICAL: Identity is now extracted from verified JWT token claims only.
   * Client-supplied authId/authProvider are no longer trusted.
   */
  async handleAuthentication(
    request: AuthenticationRequestWithIdempotency,
  ): Promise<AuthenticationResult> {
    const startTime = Date.now();

    // Verify JWT and extract identity from verified claims
    let verifiedIdentity: { authId: string; authProvider: string };
    try {
      verifiedIdentity = await this.verifyIdentity(request);
    } catch (verificationError) {
      const latency = Date.now() - startTime;
      this.authMetrics.recordAttempt('failure_jwt_verification', latency);
      throw verificationError;
    }

    // Validate auth provider payload shape (email, displayName, network, etc.)
    try {
      // Only validate the optional fields, not authId (derived from JWT)
      const optionalFields = {
        email: request.email,
        displayName: request.displayName,
        network: request.network,
      };
      this.validateOptionalAuthFields(optionalFields);
    } catch (validationError) {
      const latency = Date.now() - startTime;
      this.authMetrics.recordAttempt('failure_invalid_payload', latency);
      throw validationError;
    }

    const network = request.network || WalletNetwork.TESTNET;

    this.logger.log(
      `${this.logPrefix()} Starting authentication orchestration for verified authId (JWT verified)`,
    );

    try {
      // Check idempotency cache if key provided
      if (request.idempotencyKey) {
        const cachedResponse = await this.idempotencyService.getCachedResponse(
          request.idempotencyKey,
        );
        if (cachedResponse) {
          this.logger.log(
            `${this.logPrefix()} Returning cached authentication result for idempotency key: ${request.idempotencyKey}`,
          );
          // Replayed responses are not double-counted as new attempts
          return {
            ...cachedResponse,
            _idempotencyReplayed: true,
          };
        }
      }

      // Step 1: Find or create user (idempotent)
      const userResult = await this.findOrCreateUser({
        ...request,
        authId: verifiedIdentity.authId,
        authProvider: verifiedIdentity.authProvider,
      });

      // Step 1.5: Check if user is active
      try {
        this.validateUserStatus(userResult.user);
      } catch (statusError) {
        const latency = Date.now() - startTime;
        this.authMetrics.recordAttempt('failure_user_inactive', latency);
        throw statusError;
      }

      // Step 2: Ensure user has a wallet (idempotent)
      let walletResult: Awaited<ReturnType<typeof this.ensureUserHasWallet>>;
      try {
        walletResult = await this.ensureUserHasWallet(
          userResult.user.id,
          network,
          userResult.isNewUser,
        );
      } catch (walletError) {
        const latency = Date.now() - startTime;
        this.authMetrics.recordAttempt('failure_wallet_error', latency);
        throw walletError;
      }

      const duration = Date.now() - startTime;
      this.logger.log(
        `${this.logPrefix()} Authentication orchestration completed in ${duration}ms ` +
          `(newUser: ${userResult.isNewUser}, newWallet: ${walletResult.isNewWallet})`,
      );

      // Record success metric
      const outcome = userResult.isNewUser
        ? 'success_new_user'
        : 'success_returning_user';
      this.authMetrics.recordAttempt(outcome, duration);

      const result: AuthenticationResultWithMetadata = {
        user: {
          id: userResult.user.id,
          authId: userResult.user.authId,
          email: userResult.user.email,
          displayName: userResult.user.displayName,
          status: userResult.user.status ?? 'ACTIVE',
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

      // Emit domain event (best-effort; never blocks the auth response)
      this.emitAuthEvent(result).catch((err) =>
        this.logger.warn(`Auth domain event emission failed: ${err.message}`),
      );

      return result;
    } catch (error) {
      this.logger.error(
        `${this.logPrefix()} Authentication orchestration failed:`,
        error,
      );

      if (error instanceof HttpException) {
        throw error;
      }
      // Only record 'failure_unknown' if not already classified above
      const latency = Date.now() - startTime;
      this.authMetrics.recordAttempt('failure_unknown', latency);
      // Consolidated, generic message — the real cause (DB/Stellar/etc) was
      // already logged above via this.logger.error(); never forward
      // downstream error text to external callers.
      throw new ServiceUnavailableException(EXTERNAL_AUTH_FAILURE_MESSAGE);
    }
  }

  /**
   * Emits the appropriate domain event after a successful authentication.
   */
  private async emitAuthEvent(
    result: AuthenticationResultWithMetadata,
  ): Promise<void> {
    if (result.isNewUser) {
      await this.webhookEventEmitter.emitNewUserRegistered({
        userId: result.user.id,
        authId: result.user.authId,
        authProvider: result.user.authProvider,
        walletId: result.wallet.id,
        walletNetwork: result.wallet.network,
      });
    } else {
      await this.webhookEventEmitter.emitUserAuthenticated({
        userId: result.user.id,
        authId: result.user.authId,
        authProvider: result.user.authProvider,
        isNewWallet: result.isNewWallet,
      });
    }
  }

  /**
   * Step 1: Find or create user using idempotent service.
   * Retries on transient connectivity errors with exponential backoff.
   */
  private async findOrCreateUser(
    request: AuthenticationRequest,
  ): Promise<FindOrCreateUserResult> {
    const userRequest: FindOrCreateUserRequest = {
      authId: request.authId,
      email: request.email,
      displayName: request.displayName,
      authProvider: request.authProvider || 'UNKNOWN',
      lastLoginIp: request.ipAddress,
      lastLoginUserAgent: request.userAgent,
    };

    return retryWithBackoff(() =>
      this.idempotentUserService.findOrCreateUser(userRequest),
    );
  }

  /**
   * Step 2: Ensure user has a wallet on the specified network.
   * Retries on transient connectivity errors with exponential backoff.
   */
  private async ensureUserHasWallet(
    userId: string,
    network: WalletNetwork,
    isNewUser: boolean,
  ) {
    // Check if wallet already exists
    const existingWallet = await retryWithBackoff(() =>
      this.walletCreationOrchestrator.getWalletByUser(userId, network),
    );

    if (existingWallet) {
      this.logger.log(
        `${this.logPrefix()} User ${userId} already has wallet on ${network}`,
      );
      return {
        wallet: existingWallet,
        isNewWallet: false,
      };
    }

    // Create new wallet (idempotent)
    this.logger.log(
      `${this.logPrefix()} Creating wallet for user ${userId} on ${network}`,
    );
    const walletRequest: CreateWalletOrchestratorRequest = {
      userId,
      network,
      idempotencyKey: `auth-wallet-${userId}-${network}`, // Idempotency key for safety
    };

    const walletResult = await retryWithBackoff(() =>
      this.walletCreationOrchestrator.createWallet(walletRequest),
    );

    return {
      wallet: walletResult.wallet,
      isNewWallet: walletResult.isNewWallet,
    };
  }

  /**
   * Lists recent auth sessions with optional filtering.
   * A "session" is any user record that has logged in at least once.
   * Supports filtering by status, authProvider, and lastLoginAt date range.
   */
  async listSessions(options: SessionListOptions): Promise<SessionListResult> {
    return this.idempotentUserService.listSessions(options);
  }

  /**
   * Validates that a user can authenticate (pre-authentication check).
   * Returns true only if the user exists AND has ACTIVE status.
   * Throws ForbiddenException if user is INACTIVE/SUSPENDED (explicit rejection).
   *
   * @throws ForbiddenException if user status prevents authentication
   * @returns true if user exists and is ACTIVE; false if user not found
   */
  async validateAuthentication(authId: string): Promise<boolean> {
    try {
      // Check if user exists
      const user = await this.idempotentUserService.findUserByAuthId(authId);

      // Check user status - reject INACTIVE/SUSPENDED accounts
      const status = (user.status || UserStatus.ACTIVE) as UserStatus;
      if (status !== UserStatus.ACTIVE) {
        this.logger.warn(
          `${this.logPrefix()} Authentication validation rejected: user status is ${status}`,
        );
        throw new ForbiddenException(
          `Account is ${status.toLowerCase()}. Cannot authenticate.`,
        );
      }

      return true;
    } catch (error) {
      // Re-throw ForbiddenException (user exists but is suspended/inactive)
      if (error instanceof ForbiddenException) {
        throw error;
      }

      // Log other errors and return false (user not found, DB error, etc.)
      this.logger.error(
        `${this.logPrefix()} Authentication validation failed:`,
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
    const status = (user.status || UserStatus.ACTIVE) as UserStatus;

    if (status !== UserStatus.ACTIVE) {
      this.logger.warn(
        `${this.logPrefix()} Authentication rejected: user status is ${status}`,
      );
      throw new ForbiddenException('Account is inactive');
    }
  }

  /**
   * Verifies the bearer token and extracts the authenticated identity.
   * Identity (authId and authProvider) is ALWAYS derived from the verified JWT token,
   * never from client-supplied request fields. This is the critical security boundary.
   *
   * @throws UnauthorizedException if token verification fails
   * @throws ServiceUnavailableException if JWT verification service is unavailable
   */
  private async verifyIdentity(
    request: AuthenticationRequest,
  ): Promise<{ authId: string; authProvider: string }> {
    if (!request.bearerToken) {
      throw new BadRequestException('Authorization header with bearer token is required');
    }

    const verifiedToken = await this.jwtVerification.verifyToken(
      request.bearerToken,
    );

    if (!verifiedToken.sub) {
      throw new BadRequestException(
        'JWT token must contain sub (subject) claim with user identity',
      );
    }

    const authProvider = verifiedToken.auth_provider?.toUpperCase();
    if (!authProvider) {
      throw new BadRequestException(
        'JWT token must contain auth_provider claim',
      );
    }

    this.logger.log(
      `${this.logPrefix()} Identity verified from JWT (provider: ${authProvider})`,
    );

    return {
      authId: verifiedToken.sub,
      authProvider,
    };
  }

  /**
   * Validates optional authentication fields (email, displayName, network).
   * These fields are optional metadata passed alongside the verified JWT token.
   */
  private validateOptionalAuthFields(fields: {
    email?: string;
    displayName?: string;
    network?: string;
  }): void {
    // Validate email format if provided
    if (fields.email !== undefined && fields.email !== null) {
      if (typeof fields.email !== 'string') {
        throw new BadRequestException('email must be a string');
      }

      if (fields.email.trim().length > 0) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(fields.email)) {
          throw new BadRequestException('email format is invalid');
        }
      }
    }

    // Validate displayName if provided
    if (fields.displayName !== undefined && fields.displayName !== null) {
      if (typeof fields.displayName !== 'string') {
        throw new BadRequestException('displayName must be a string');
      }

      if (fields.displayName.trim().length === 0) {
        throw new BadRequestException('displayName cannot be empty');
      }
    }

    // Validate network if provided
    if (fields.network !== undefined && fields.network !== null) {
      if (
        typeof fields.network !== 'string' ||
        !Object.values(WalletNetwork).includes(fields.network as WalletNetwork)
      ) {
        throw new BadRequestException('network must be a valid WalletNetwork');
      }
    }
  }
}
