import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RecoveryService } from './recovery.service';
import { RecoveryController } from './recovery.controller';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { RecoveryStatus } from './domain/recovery.model';
import { CreateRecoveryDto } from './dto/create-recovery.dto';
import { UpdateRecoveryDto } from './dto/update-recovery.dto';

const NOW = new Date('2026-06-01T00:00:00.000Z');

const makeDbRecovery = (overrides: Record<string, any> = {}) => ({
  id: 'rec-001',
  walletId: 'wallet-001',
  requester: 'user-001',
  status: 'PENDING',
  metadata: { reason: 'lost access' },
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const makeDbWallet = (overrides: Record<string, any> = {}) => ({
  id: 'wallet-001',
  userId: 'user-001',
  publicKey: 'GABCDEF123',
  encryptedSecret: 'enc',
  encryptionVersion: 1,
  secretVersion: 1,
  network: 'TESTNET',
  status: 'ACTIVE',
  statusReason: null,
  statusChangedAt: NOW,
  rotatedFromId: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

describe('Recovery API (integration)', () => {
  let controller: RecoveryController;
  let service: RecoveryService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      recoveryRequest: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
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
      controllers: [RecoveryController],
      providers: [
        RecoveryService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((_key: string, defaultValue: unknown) => defaultValue),
          },
        },
      ],
    }).compile();

    controller = module.get(RecoveryController);
    service = module.get(RecoveryService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('create', () => {
    const dto: CreateRecoveryDto = {
      walletId: 'wallet-001',
      requester: 'user-001',
      metadata: { reason: 'lost access' },
    };

    it('creates a recovery request successfully', async () => {
      prisma.recoveryRequest.findFirst.mockResolvedValue(null);
      prisma.wallet.findUnique.mockResolvedValue(makeDbWallet());
      prisma.recoveryRequest.create.mockResolvedValue(makeDbRecovery());

      const result = await controller.create(dto);

      expect(result.id).toBe('rec-001');
      expect(result.status).toBe(RecoveryStatus.PENDING);
      expect(result.walletId).toBe('wallet-001');
    });

    it('throws BadRequestException when active recovery already exists', async () => {
      prisma.recoveryRequest.findFirst.mockResolvedValue(makeDbRecovery());

      await expect(controller.create(dto)).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when wallet does not exist', async () => {
      prisma.recoveryRequest.findFirst.mockResolvedValue(null);
      prisma.wallet.findUnique.mockResolvedValue(null);

      await expect(controller.create(dto)).rejects.toThrow(BadRequestException);
    });
  });

  describe('findAll', () => {
    it('returns all recovery requests', async () => {
      prisma.recoveryRequest.findMany.mockResolvedValue([
        makeDbRecovery({ id: 'rec-001', requester: 'alice' }),
        makeDbRecovery({ id: 'rec-002', requester: 'bob' }),
      ]);

      const result = await controller.findAll();

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('rec-001');
      expect(result[1].id).toBe('rec-002');
    });

    it('returns empty array when no requests exist', async () => {
      prisma.recoveryRequest.findMany.mockResolvedValue([]);

      const result = await controller.findAll();

      expect(result).toEqual([]);
    });
  });

  describe('findOne', () => {
    it('returns a recovery request by id', async () => {
      prisma.recoveryRequest.findUnique.mockResolvedValue(makeDbRecovery());

      const result = await controller.findOne('rec-001');

      expect(result.id).toBe('rec-001');
      expect(result.requester).toBe('user-001');
    });

    it('throws NotFoundException when request does not exist', async () => {
      prisma.recoveryRequest.findUnique.mockResolvedValue(null);

      await expect(controller.findOne('nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    it('updates recovery request status successfully', async () => {
      const pending = makeDbRecovery();
      const inReview = makeDbRecovery({
        status: 'IN_REVIEW',
        updatedAt: new Date(NOW.getTime() + 1000),
      });

      prisma.recoveryRequest.findUnique.mockResolvedValue(pending);
      prisma.recoveryRequest.update.mockResolvedValue(inReview);

      const updateDto: UpdateRecoveryDto = { status: RecoveryStatus.IN_REVIEW };
      const result = await controller.update('rec-001', updateDto);

      expect(result.status).toBe(RecoveryStatus.IN_REVIEW);
    });

    it('throws NotFoundException when request does not exist', async () => {
      prisma.recoveryRequest.findUnique.mockResolvedValue(null);

      const updateDto: UpdateRecoveryDto = { status: RecoveryStatus.IN_REVIEW };
      await expect(controller.update('nonexistent', updateDto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws Error on invalid status transition', async () => {
      prisma.recoveryRequest.findUnique.mockResolvedValue(
        makeDbRecovery({ status: 'COMPLETED' }),
      );

      const updateDto: UpdateRecoveryDto = { status: RecoveryStatus.PENDING };
      await expect(controller.update('rec-001', updateDto)).rejects.toThrow(
        'Invalid recovery status transition',
      );
    });
  });

  describe('initiate', () => {
    it('moves a PENDING recovery request to IN_REVIEW', async () => {
      const pending = makeDbRecovery();
      const inReview = makeDbRecovery({
        status: 'IN_REVIEW',
        updatedAt: new Date(NOW.getTime() + 1000),
      });

      prisma.recoveryRequest.findUnique.mockResolvedValue(pending);
      prisma.recoveryRequest.update.mockResolvedValue(inReview);

      const result = await controller.initiate('rec-001');

      expect(result.status).toBe(RecoveryStatus.IN_REVIEW);
      expect(prisma.recoveryRequest.update).toHaveBeenCalledWith({
        where: { id: 'rec-001' },
        data: { status: RecoveryStatus.IN_REVIEW },
      });
    });

    it('throws BadRequestException when request is not PENDING', async () => {
      prisma.recoveryRequest.findUnique.mockResolvedValue(
        makeDbRecovery({ status: 'IN_REVIEW' }),
      );

      await expect(controller.initiate('rec-001')).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.recoveryRequest.update).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when request does not exist', async () => {
      prisma.recoveryRequest.findUnique.mockResolvedValue(null);

      await expect(controller.initiate('nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('remove', () => {
    it('deletes a recovery request', async () => {
      prisma.recoveryRequest.findUnique.mockResolvedValue(makeDbRecovery());
      prisma.recoveryRequest.delete.mockResolvedValue(makeDbRecovery());

      await expect(controller.remove('rec-001')).resolves.toBeUndefined();
    });

    it('throws NotFoundException when request does not exist', async () => {
      prisma.recoveryRequest.findUnique.mockResolvedValue(null);

      await expect(controller.remove('nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
