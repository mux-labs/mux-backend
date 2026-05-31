import { Test, TestingModule } from '@nestjs/testing';
import { AppService } from './app.service';
import { PrismaService } from './prisma/prisma.service';

describe('AppService', () => {
  let service: AppService;
  let prismaService: PrismaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AppService,
        {
          provide: PrismaService,
          useValue: {
            $queryRaw: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<AppService>(AppService);
    prismaService = module.get<PrismaService>(PrismaService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getHello', () => {
    it('should return "Hello World!"', () => {
      expect(service.getHello()).toBe('Hello World!');
    });
  });

  describe('checkReadiness', () => {
    it('should return ready status when database is connected', async () => {
      // Mock successful database query
      jest.spyOn(prismaService, '$queryRaw').mockResolvedValue([{ '?column?': 1 }]);

      const result = await service.checkReadiness();

      expect(result.status).toBe('ready');
      expect(result.database.connected).toBe(true);
      expect(result.database.responseTime).toBeGreaterThanOrEqual(0);
      expect(result.timestamp).toBeDefined();
      expect(prismaService.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('should return not_ready status when database connection fails', async () => {
      // Mock database connection failure
      const dbError = new Error('Connection refused');
      jest.spyOn(prismaService, '$queryRaw').mockRejectedValue(dbError);

      const result = await service.checkReadiness();

      expect(result.status).toBe('not_ready');
      expect(result.database.connected).toBe(false);
      expect(result.database.responseTime).toBeGreaterThanOrEqual(0);
      expect(result.database.error).toBe('Connection refused');
      expect(result.timestamp).toBeDefined();
      expect(prismaService.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('should handle unknown errors gracefully', async () => {
      // Mock unknown error type
      jest.spyOn(prismaService, '$queryRaw').mockRejectedValue('Unknown error');

      const result = await service.checkReadiness();

      expect(result.status).toBe('not_ready');
      expect(result.database.connected).toBe(false);
      expect(result.database.error).toBe('Unknown error');
    });

    it('should measure response time accurately', async () => {
      // Mock delayed database response
      jest.spyOn(prismaService, '$queryRaw').mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve([{ '?column?': 1 }]), 50);
          }),
      );

      const result = await service.checkReadiness();

      expect(result.database.connected).toBe(true);
      expect(result.database.responseTime).toBeGreaterThanOrEqual(50);
    });
  });
});
