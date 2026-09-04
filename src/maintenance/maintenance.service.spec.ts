import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { MaintenanceService } from './maintenance.service';

describe('MaintenanceService', () => {
  const prisma = {
    maintenanceState: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
  };
  let service: MaintenanceService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        MaintenanceService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = moduleRef.get(MaintenanceService);
  });

  it('defaults to disabled when no persisted state exists', async () => {
    prisma.maintenanceState.findUnique.mockResolvedValue(null);

    await expect(service.getStatus()).resolves.toEqual({
      enabled: false,
      message: null,
      retryAfterSeconds: null,
      enabledAt: null,
      updatedAt: null,
    });
  });

  it('persists and returns enabled maintenance state', async () => {
    const state = {
      enabled: true,
      message: 'Ledger upgrade',
      retryAfterSeconds: 120,
      enabledAt: new Date('2026-07-29T10:00:00.000Z'),
      updatedAt: new Date('2026-07-29T10:00:00.000Z'),
    };
    prisma.maintenanceState.upsert.mockResolvedValue(state);

    await expect(
      service.updateStatus(
        { enabled: true, message: 'Ledger upgrade', retryAfterSeconds: 120 },
        'api-key-id',
      ),
    ).resolves.toEqual(state);
    expect(prisma.maintenanceState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'global' },
        create: expect.objectContaining({ updatedBy: 'api-key-id' }),
        update: expect.objectContaining({ updatedBy: 'api-key-id' }),
      }),
    );
  });

  it('propagates persistence failures', async () => {
    prisma.maintenanceState.findUnique.mockRejectedValue(
      new Error('database unavailable'),
    );
    await expect(service.getStatus()).rejects.toThrow('database unavailable');
  });
});
