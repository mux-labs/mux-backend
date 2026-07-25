import { Test, TestingModule } from '@nestjs/testing';
import { SettlementService } from './settlement.service';
import { PrismaService } from '../prisma/prisma.service';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';

describe('SettlementService', () => {
  let service: SettlementService;
  let mockPrisma: any;
  let mockIdempotency: any;

  const mockWallet = {
    id: 'wallet-uuid-1',
    userId: 'user-uuid-1',
    publicKey: 'GABC123...',
    network: 'TESTNET',
    status: 'ACTIVE',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockSettlementRecord = {
    id: 'settlement-uuid-1',
    tradeId: 'trade-123',
    senderWalletId: 'wallet-uuid-1',
    receiverWalletId: 'wallet-uuid-2',
    amount: '10.50',
    status: 'COMPLETED',
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    mockPrisma = {
      wallet: {
        findUnique: jest.fn(),
      },
      settlement: {
        create: jest.fn(),
        findUnique: jest.fn(),
      },
    };

    mockIdempotency = {
      getCachedResponse: jest.fn().mockResolvedValue(null),
      cacheResponse: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SettlementService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: IdempotencyService, useValue: mockIdempotency },
      ],
    }).compile();

    service = module.get<SettlementService>(SettlementService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('settle', () => {
    const validDto = {
      tradeId: 'trade-123',
      senderWalletId: 'wallet-uuid-1',
      receiverWalletId: 'wallet-uuid-2',
      amount: '10.50',
    };

    it('should create a settlement and return the result on first call', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(mockWallet);
      mockPrisma.settlement.create.mockResolvedValue(mockSettlementRecord);

      const result = await service.settle(validDto);

      expect(result.id).toBe('settlement-uuid-1');
      expect(result.tradeId).toBe('trade-123');
      expect(result.isIdempotent).toBe(false);
      expect(result.status).toBe('COMPLETED');
      expect(mockIdempotency.cacheResponse).toHaveBeenCalledWith(
        'settlement:trade-123',
        expect.any(Object),
        'POST',
        '/v1/settlements',
        200,
        expect.objectContaining({ ttlMs: expect.any(Number) }),
      );
    });


    it('should return cached result on duplicate tradeId (idempotent)', async () => {
      mockIdempotency.getCachedResponse.mockResolvedValue({
        id: 'settlement-uuid-1',
        tradeId: 'trade-123',
        senderWalletId: 'wallet-uuid-1',
        receiverWalletId: 'wallet-uuid-2',
        amount: '10.50',
        status: 'COMPLETED',
        settledAt: new Date().toISOString(),
      });

      const result = await service.settle(validDto);

      expect(result.isIdempotent).toBe(true);
      expect(result.id).toBe('settlement-uuid-1');
      expect(mockPrisma.settlement.create).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException when sender wallet does not exist', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValueOnce(null);
      mockPrisma.wallet.findUnique.mockResolvedValueOnce(mockWallet);

      await expect(service.settle(validDto)).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException when receiver wallet does not exist', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValueOnce(mockWallet);
      mockPrisma.wallet.findUnique.mockResolvedValueOnce(null);

      await expect(service.settle(validDto)).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException when sender and receiver are the same', async () => {
      // Reset mocks to clear previous mockResolvedValueOnce state
      mockPrisma.wallet.findUnique.mockReset();
      mockPrisma.wallet.findUnique.mockResolvedValue(mockWallet);

      const sameWalletDto = {
        ...validDto,
        receiverWalletId: 'wallet-uuid-1',
      };

      await expect(service.settle(sameWalletDto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should handle concurrent duplicate (P2002 race condition)', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(mockWallet);
      mockPrisma.settlement.create.mockRejectedValue({ code: 'P2002' });
      mockIdempotency.getCachedResponse
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 'settlement-uuid-1',
          tradeId: 'trade-123',
          senderWalletId: 'wallet-uuid-1',
          receiverWalletId: 'wallet-uuid-2',
          amount: '10.50',
          status: 'COMPLETED',
          settledAt: new Date().toISOString(),
        });

      const result = await service.settle(validDto);

      expect(result.isIdempotent).toBe(true);
      expect(result.tradeId).toBe('trade-123');
    });
    it('should fall back to direct DB lookup on race condition when cache is missing', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(mockWallet);
      mockPrisma.settlement.create.mockRejectedValue({ code: 'P2002' });
      mockIdempotency.getCachedResponse
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      mockPrisma.settlement.findUnique.mockResolvedValue(mockSettlementRecord);

      const result = await service.settle(validDto);

      expect(result.isIdempotent).toBe(true);
      expect(result.id).toBe('settlement-uuid-1');
    });
  });

  describe('findByTradeId', () => {
    it('should return settlement when found', async () => {
      mockPrisma.settlement.findUnique.mockResolvedValue(mockSettlementRecord);

      const result = await service.findByTradeId('trade-123');

      expect(result).not.toBeNull();
      expect(result!.tradeId).toBe('trade-123');
    });

    it('should return null when settlement not found', async () => {
      mockPrisma.settlement.findUnique.mockResolvedValue(null);

      const result = await service.findByTradeId('non-existent');

      expect(result).toBeNull();
    });
  });
});


