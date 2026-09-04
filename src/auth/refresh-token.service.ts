import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RefreshTokenStatus } from '../generated/prisma';
import * as crypto from 'crypto';

export interface CreateRefreshTokenRequest {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}

export interface RotateRefreshTokenRequest {
  currentTokenHash: string;
  newTokenHash: string;
  expiresAt: Date;
}

export interface RevokeRefreshTokenRequest {
  tokenHash: string;
  reason?: string;
}

@Injectable()
export class RefreshTokenService {
  private readonly logger = new Logger(RefreshTokenService.name);

  constructor(private readonly prisma: PrismaService) {}

  async createRefreshToken(request: CreateRefreshTokenRequest) {
    this.logger.log(`Creating refresh token for user ${request.userId}`);
    return this.prisma.refreshToken.create({
      data: {
        userId: request.userId,
        tokenHash: request.tokenHash,
        expiresAt: request.expiresAt,
        status: RefreshTokenStatus.ACTIVE,
      },
    });
  }

  async rotateRefreshToken(request: RotateRefreshTokenRequest) {
    this.logger.log(`Rotating refresh token`);

    const currentToken = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: request.currentTokenHash },
    });

    if (!currentToken) {
      throw new Error('Current refresh token not found');
    }

    if (currentToken.status !== RefreshTokenStatus.ACTIVE) {
      throw new Error('Current refresh token is no longer active');
    }

    if (currentToken.expiresAt < new Date()) {
      throw new Error('Current refresh token has expired');
    }

    // Mark old token as rotated
    await this.prisma.refreshToken.update({
      where: { id: currentToken.id },
      data: {
        status: RefreshTokenStatus.ROTATED,
        rotatedAt: new Date(),
        rotatedReason: 'Rotated on use',
      },
    });

    // Create new token with reference to old one
    const newToken = await this.prisma.refreshToken.create({
      data: {
        userId: currentToken.userId,
        tokenHash: request.newTokenHash,
        expiresAt: request.expiresAt,
        previousTokenId: currentToken.id,
        status: RefreshTokenStatus.ACTIVE,
      },
    });

    return newToken;
  }

  async validateAndRotateToken(
    currentTokenHash: string,
    newTokenHash: string,
    expiresAt: Date,
  ) {
    const token = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: currentTokenHash },
    });

    if (!token) return null;
    if (token.status !== RefreshTokenStatus.ACTIVE) return null;
    if (token.expiresAt < new Date()) return null;

    // Increment usage count and update last used
    await this.prisma.refreshToken.update({
      where: { id: token.id },
      data: {
        usageCount: { increment: 1 },
        lastUsedAt: new Date(),
      },
    });

    // Rotate the token
    const rotatedToken = await this.rotateRefreshToken({
      currentTokenHash,
      newTokenHash,
      expiresAt,
    });

    return rotatedToken;
  }

  async revokeRefreshToken(request: RevokeRefreshTokenRequest) {
    this.logger.log(`Revoking refresh token`);
    return this.prisma.refreshToken.update({
      where: { tokenHash: request.tokenHash },
      data: {
        status: RefreshTokenStatus.REVOKED,
        revokedAt: new Date(),
        revokeReason: request.reason || 'Revoked by user',
      },
    });
  }

  async revokeUserRefreshTokens(userId: string, reason?: string) {
    this.logger.log(`Revoking all refresh tokens for user ${userId}`);
    return this.prisma.refreshToken.updateMany({
      where: {
        userId,
        status: RefreshTokenStatus.ACTIVE,
      },
      data: {
        status: RefreshTokenStatus.REVOKED,
        revokedAt: new Date(),
        revokeReason: reason || 'All tokens revoked',
      },
    });
  }

  async getActiveRefreshTokens(userId: string) {
    return this.prisma.refreshToken.findMany({
      where: {
        userId,
        status: RefreshTokenStatus.ACTIVE,
        expiresAt: { gt: new Date() },
      },
    });
  }

  async validateRefreshToken(tokenHash: string) {
    const token = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
    });

    if (!token) return null;
    if (token.status !== RefreshTokenStatus.ACTIVE) return null;
    if (token.expiresAt < new Date()) return null;

    return token;
  }
}
