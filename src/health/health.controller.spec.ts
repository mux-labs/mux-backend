import { Test, TestingModule } from '@nestjs/testing';
import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';
import { PrismaService } from '../prisma/prisma.service';

describe('HealthController', () => {
  let controller: HealthController;
  let prisma: { $queryRaw: jest.Mock };

  beforeEach(async () => {
    prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: PrismaService, useValue: prisma }],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  describe('health', () => {
    it('returns 200 without touching the database', () => {
      const result = controller.health();

      expect(result.status).toBe('ok');
      expect(result).toHaveProperty('build');
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe('ready', () => {
    it('returns ready when the database ping succeeds', async () => {
      prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      const result = await controller.ready();

      expect(result.status).toBe('ready');
      expect(result.database).toEqual({ connected: true });
    });

    it('throws 503 when the database ping fails', async () => {
      prisma.$queryRaw.mockRejectedValue(
        new Error('connect ECONNREFUSED 127.0.0.1:5432'),
      );

      await expect(controller.ready()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );

      try {
        await controller.ready();
        fail('expected ready() to throw');
      } catch (error) {
        const exception = error as ServiceUnavailableException;
        expect(exception.getStatus()).toBe(503);

        const payload = exception.getResponse() as Record<string, any>;
        expect(payload.status).toBe('not ready');
        expect(payload.database).toEqual({ connected: false });
        expect(JSON.stringify(payload)).not.toContain('ECONNREFUSED');
        expect(payload).not.toHaveProperty('error');
      }
    });
  });
});
    });
  });
});
