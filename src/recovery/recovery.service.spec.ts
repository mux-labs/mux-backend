import { Test, TestingModule } from '@nestjs/testing';
import { RecoveryService } from './recovery.service';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { RecoveryStatus } from './domain/recovery.model';
import { BadRequestException, NotFoundException } from '@nestjs/common';

describe('RecoveryService', () => {
  let service: RecoveryService;
  let prisma: any;

  const mockRecovery = {
    id: '660e8400-e29b-41d4-a716-446655440001',
    walletId: '550e8400-e29b-41d4-a716-446655440000',
    requester: 'user_abc123',
    status: 'PENDING',
    metadata: null,
    createdAt: new Date('2026-06-29T12:00:00.000Z'),
    updatedAt: new Date('2026-06-29T12:00:00.000Z'),
  };

  const mockWallet = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    address: 'GABC1234567890',
  };

  beforeEach(async () => {
    prisma = {
      recoveryRequest: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      wallet: {
        findUnique: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecoveryService,
        {
          provide: PrismaService,
          useValue: prisma,
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((_key: string, defaultValue: unknown) => defaultValue),
          },
        },
      ],
    }).compile();

    service = module.get<RecoveryService>(RecoveryService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    it('should create a recovery request', async () => {
      prisma.recoveryRequest.findFirst.mockResolvedValue(null);
      prisma.wallet.findUnique.mockResolvedValue(mockWallet);
      prisma.recoveryRequest.create.mockResolvedValue(mockRecovery);

      const result = await service.create({
        walletId: '550e8400-e29b-41d4-a716-446655440000',
        requester: 'user_abc123',
      });

      expect(result.id).toEqual(mockRecovery.id);
      expect(result.status).toEqual(RecoveryStatus.PENDING);
    });

    it('should throw if active recovery exists', async () => {
      prisma.recoveryRequest.findFirst.mockResolvedValue(mockRecovery);

      await expect(
        service.create({
          walletId: '550e8400-e29b-41d4-a716-446655440000',
          requester: 'user_abc123',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw if wallet not found', async () => {
      prisma.recoveryRequest.findFirst.mockResolvedValue(null);
      prisma.wallet.findUnique.mockResolvedValue(null);

      await expect(
        service.create({
          walletId: '550e8400-e29b-41d4-a716-446655440000',
          requester: 'user_abc123',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('findAll', () => {
    it('should return paginated results', async () => {
      prisma.recoveryRequest.findMany.mockResolvedValue([mockRecovery]);
      prisma.recoveryRequest.count.mockResolvedValue(1);

      const result = await service.findAll();

      expect(result.data).toHaveLength(1);
      expect(result.total).toEqual(1);
      expect(result.limit).toEqual(20);
      expect(result.offset).toEqual(0);
      expect(result.hasMore).toEqual(false);
    });

    it('should apply walletId filter', async () => {
      prisma.recoveryRequest.findMany.mockResolvedValue([mockRecovery]);
      prisma.recoveryRequest.count.mockResolvedValue(1);

      await service.findAll({
        walletId: '550e8400-e29b-41d4-a716-446655440000',
      });

      expect(prisma.recoveryRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            walletId: '550e8400-e29b-41d4-a716-446655440000',
          }),
        }),
      );
    });

    it('should apply status filter', async () => {
      prisma.recoveryRequest.findMany.mockResolvedValue([mockRecovery]);
      prisma.recoveryRequest.count.mockResolvedValue(1);

      await service.findAll({ status: RecoveryStatus.PENDING });

      expect(prisma.recoveryRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: RecoveryStatus.PENDING,
          }),
        }),
      );
    });

    it('should apply requester filter with case-insensitive contains', async () => {
      prisma.recoveryRequest.findMany.mockResolvedValue([mockRecovery]);
      prisma.recoveryRequest.count.mockResolvedValue(1);

      await service.findAll({ requester: 'user_abc' });

      expect(prisma.recoveryRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            requester: { contains: 'user_abc', mode: 'insensitive' },
          }),
        }),
      );
    });

    it('should apply pagination params', async () => {
      prisma.recoveryRequest.findMany.mockResolvedValue([mockRecovery]);
      prisma.recoveryRequest.count.mockResolvedValue(1);

      await service.findAll({ limit: 10, offset: 5 });

      expect(prisma.recoveryRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 10,
          skip: 5,
        }),
      );
    });

    it('should set hasMore when more results exist', async () => {
      prisma.recoveryRequest.findMany.mockResolvedValue([mockRecovery]);
      prisma.recoveryRequest.count.mockResolvedValue(10);

      const result = await service.findAll({ limit: 1, offset: 0 });

      expect(result.hasMore).toEqual(true);
    });

    it('should apply createdAt date range filter', async () => {
      prisma.recoveryRequest.findMany.mockResolvedValue([mockRecovery]);
      prisma.recoveryRequest.count.mockResolvedValue(1);

      const from = new Date('2026-01-01T00:00:00.000Z');
      const to = new Date('2026-12-31T23:59:59.999Z');

      await service.findAll({ createdAt: { gte: from, lte: to } });

      expect(prisma.recoveryRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: { gte: from, lte: to },
          }),
        }),
      );
    });

    it('should apply createdAt gte filter only', async () => {
      prisma.recoveryRequest.findMany.mockResolvedValue([mockRecovery]);
      prisma.recoveryRequest.count.mockResolvedValue(1);

      const from = new Date('2026-06-01T00:00:00.000Z');

      await service.findAll({ createdAt: { gte: from } });

      expect(prisma.recoveryRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: { gte: from },
          }),
        }),
      );
    });
  });

  describe('findOne', () => {
    it('should return a recovery request', async () => {
      prisma.recoveryRequest.findUnique.mockResolvedValue(mockRecovery);

      const result = await service.findOne(
        '660e8400-e29b-41d4-a716-446655440001',
      );

      expect(result.id).toEqual(mockRecovery.id);
    });

    it('should throw if not found', async () => {
      prisma.recoveryRequest.findUnique.mockResolvedValue(null);

      await expect(service.findOne('nonexistent-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    it('should update recovery status', async () => {
      prisma.recoveryRequest.findUnique.mockResolvedValue(mockRecovery);
      prisma.recoveryRequest.update.mockResolvedValue({
        ...mockRecovery,
        status: 'IN_REVIEW',
      });

      const result = await service.update(
        '660e8400-e29b-41d4-a716-446655440001',
        { status: RecoveryStatus.IN_REVIEW },
      );

      expect(result.status).toEqual(RecoveryStatus.IN_REVIEW);
    });

    it('should throw on invalid transition', async () => {
      prisma.recoveryRequest.findUnique.mockResolvedValue({
        ...mockRecovery,
        status: 'COMPLETED',
      });

      await expect(
        service.update('660e8400-e29b-41d4-a716-446655440001', {
          status: RecoveryStatus.PENDING,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('initiate', () => {
    it('should move a PENDING recovery request to IN_REVIEW', async () => {
      prisma.recoveryRequest.findUnique.mockResolvedValue(mockRecovery);
      prisma.recoveryRequest.update.mockResolvedValue({
        ...mockRecovery,
        status: 'IN_REVIEW',
      });

      const result = await service.initiate(
        '660e8400-e29b-41d4-a716-446655440001',
      );

      expect(prisma.recoveryRequest.update).toHaveBeenCalledWith({
        where: { id: '660e8400-e29b-41d4-a716-446655440001' },
        data: { status: RecoveryStatus.IN_REVIEW },
      });
      expect(result.status).toEqual(RecoveryStatus.IN_REVIEW);
    });

    it('should throw if the recovery request is not PENDING', async () => {
      prisma.recoveryRequest.findUnique.mockResolvedValue({
        ...mockRecovery,
        status: 'IN_REVIEW',
      });

      await expect(
        service.initiate('660e8400-e29b-41d4-a716-446655440001'),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.recoveryRequest.update).not.toHaveBeenCalled();
    });

    it('should throw if the recovery request is not found', async () => {
      prisma.recoveryRequest.findUnique.mockResolvedValue(null);

      await expect(
        service.initiate('nonexistent-id'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    it('should delete a recovery request', async () => {
      prisma.recoveryRequest.findUnique.mockResolvedValue(mockRecovery);
      prisma.recoveryRequest.delete.mockResolvedValue(mockRecovery);

      await expect(
        service.remove('660e8400-e29b-41d4-a716-446655440001'),
      ).resolves.toBeUndefined();
    });

    it('should throw if not found', async () => {
      prisma.recoveryRequest.findUnique.mockResolvedValue(null);

      await expect(service.remove('nonexistent-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
