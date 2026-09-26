import {
  ConflictException,
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  Wallet,
  WalletNetwork,
  WalletStatus,
  WalletStatusResponse,
} from './domain/wallet.model';
import {
  DecryptionError,
  EncryptionService,
} from '../encryption/encryption.service';
import { SafeLogger } from '../common/safe-logger';
import { KeyDecryptionException } from '../key-management/exceptions/key-decryption.exception';
import { KeyManagementService } from '../key-management/key-management.service';
import { KeyType } from '../key-management/domain/key-types';
import { WebhookEventEmitterService } from '../webhooks/webhook-event-emitter.service';
import {
  WalletApiMetricsService,
  type WalletApiOperation,
} from './wallet-api-metrics.service';
import { WalletRetryService } from './wallet-retry.service';
import {
  resolveNicknameToStore,
  sanitizeWalletNickname,
} from './wallet-nickname-safety';
import * as crypto from 'crypto';
import { TransactionBuilder, Keypair } from 'stellar-sdk';
import {
  StructuredLogger,
  LogContext,
} from '../common/logging/structured-logger';
import { TransactionStatus } from '../transactions/domain/transaction.model';

/** Wallet shape safe to return from the API (no encrypted secret material). */
export type PublicWallet = Omit<Wallet, 'encryptedSecret'>;

export interface CreateWalletRequest {
  userId: string;
  network: WalletNetwork;
}

export interface WalletListFilters {
  userId?: string;
  network?: WalletNetwork;
  status?: WalletStatus;
  /** Include archived wallets in the results (excluded by default). */
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
  /** Enable load test synthetic data generation. */
  loadTestMode?: boolean;
}

export interface WalletListResult {
  data: PublicWallet[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface WalletCreationResult {
  wallet: Wallet;
  privateKey: string;
}

/**
 * Result of a wallet key rotation (issue #692).
 *
 * Rotation uses the successor model: a new wallet is created with fresh key
 * material and the predecessor is transitioned to `ROTATING` with its
 * `successorId` set. No private key is returned — key material never leaves the
 * key-management boundary.
 */
export interface WalletKeyRotationResult {
  /** The predecessor wallet, now `ROTATING` with `successorId` populated. */
  predecessor: PublicWallet;
  /** The freshly created successor wallet holding the new key. */
  successor: PublicWallet;
}

export interface SigningResult {
  signature: string;
  transactionHash?: string;
}

@Injectable()
export class WalletsService {
  private readonly logger = new Logger(WalletsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findAll(
    userId?: string,
    network?: WalletNetwork,
  ): Promise<any[]> {
    try {
      return await this.prisma.wallet.findMany({
        where: {
          userId,
          network,
        },
        orderBy: { createdAt: 'desc' },
      });
    } catch (error) {
      this.logger.error('DB lookup failed', { error: error.message });
      throw new ServiceUnavailableException('Wallet lookup temporarily unavailable');
    }
  }

  async getWalletStatus(id: string): Promise<any> {
    try {
      const wallet = await this.prisma.wallet.findUnique({
        where: { id },
      });

      if (!wallet) {
        throw new NotFoundException(`Wallet ${id} not found`);
      }

      return wallet;
    } catch (error) {
      this.logger.error('DB lookup failed', { id, error: error.message });
      throw new ServiceUnavailableException('Wallet lookup temporarily unavailable');
    }
  }
}
