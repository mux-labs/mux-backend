import { Test, TestingModule } from '@nestjs/testing';
import { RefreshTokenService } from './refresh-token.service';
import { PrismaService } from '../prisma/prisma.service';
import { RefreshTokenStatus } from '../generated/prisma';

describe('RefreshTokenService', () => {
  let service: RefreshTokenService;
  let prismaMock: any;

  beforeEach(async () => {
    prismaMock = {
      refreshToken: {
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RefreshTokenService,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();

    service = module.get<RefreshTokenService>(RefreshTokenService);
  });

  describe('createRefreshToken', () => {
    it('should create a new refresh token', async () => {
      const request = {
        userId: 'user-1',
        tokenHash: 'hash-1',
        expiresAt: new Date(Date.now() + 7200000),
      };

      prismaMock.refreshToken.create.mockResolvedValue({
        ...request,
        status: RefreshTokenStatus.ACTIVE,
        id: 'token-1',
      });

      const result = await service.createRefreshToken(request);
      expect(result.status).toBe(RefreshTokenStatus.ACTIVE);
      expect(prismaMock.refreshToken.create).toHaveBeenCalled();
    });
  });

  describe('rotateRefreshToken', () => {
    it('should rotate token and create new one', async () => {
      const currentToken = {
        id: 'token-1',
        userId: 'user-1',
        tokenHash: 'hash-1',
        status: RefreshTokenStatus.ACTIVE,
        expiresAt: new Date(Date.now() + 7200000),
      };

      prismaMock.refreshToken.findUnique.mockResolvedValue(currentToken);
      prismaMock.refreshToken.update.mockResolvedValue({
        ...currentToken,
        status: RefreshTokenStatus.ROTATED,
      });
      prismaMock.refreshToken.create.mockResolvedValue({
        id: 'token-2',
        userId: 'user-1',
        tokenHash: 'hash-2',
        previousTokenId: 'token-1',
        status: RefreshTokenStatus.ACTIVE,
      });

      const result = await service.rotateRefreshToken({
        currentTokenHash: 'hash-1',
        newTokenHash: 'hash-2',
        expiresAt: new Date(Date.now() + 7200000),
      });

      expect(result.status).toBe(RefreshTokenStatus.ACTIVE);
      expect(prismaMock.refreshToken.update).toHaveBeenCalled();
      expect(prismaMock.refreshToken.create).toHaveBeenCalled();
    });

    it('should throw when current token is expired', async () => {
      const expiredToken = {
        id: 'token-1',
        userId: 'user-1',
        status: RefreshTokenStatus.ACTIVE,
        expiresAt: new Date(Date.now() - 1000),
      };

      prismaMock.refreshToken.findUnique.mockResolvedValue(expiredToken);

      await expect(
        service.rotateRefreshToken({
          currentTokenHash: 'hash-1',
          newTokenHash: 'hash-2',
          expiresAt: new Date(Date.now() + 7200000),
        }),
      ).rejects.toThrow('Current refresh token has expired');
    });
  });

  describe('revokeRefreshToken', () => {
    it('should revoke a refresh token', async () => {
      const tokenHash = 'hash-1';
      const revokedAt = new Date();

      prismaMock.refreshToken.update.mockResolvedValue({
        tokenHash,
        status: RefreshTokenStatus.REVOKED,
        revokedAt,
      });

      const result = await service.revokeRefreshToken({ tokenHash });
      expect(result.status).toBe(RefreshTokenStatus.REVOKED);
    });
  });

  describe('validateRefreshToken', () => {
    it('should return null for invalid token', async () => {
      prismaMock.refreshToken.findUnique.mockResolvedValue(null);
      const result = await service.validateRefreshToken('invalid-hash');
      expect(result).toBeNull();
    });

    it('should return valid token', async () => {
      const token = {
        id: 'token-1',
        tokenHash: 'hash-1',
        status: RefreshTokenStatus.ACTIVE,
        expiresAt: new Date(Date.now() + 7200000),
      };

      prismaMock.refreshToken.findUnique.mockResolvedValue(token);
      const result = await service.validateRefreshToken('hash-1');
      expect(result).toEqual(token);
    });
  });
});
