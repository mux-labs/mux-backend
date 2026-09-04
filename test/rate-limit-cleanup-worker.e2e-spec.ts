/**
 * Integration test: RateLimitCleanupWorker is registered in RateLimitModule
 *
 * Acceptance criterion: the cleanup worker must be wired into the NestJS DI
 * container so it starts automatically with the application. This test verifies
 * that the provider exists and that a successful cleanup run can be triggered.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { RateLimitModule } from '../src/rate-limit/rate-limit.module';
import { RateLimitCleanupWorker } from '../src/rate-limit/rate-limit-cleanup.worker';
import { RateLimitService } from '../src/rate-limit/rate-limit.service';
import { PrismaService } from '../src/prisma/prisma.service';

describe('RateLimitCleanupWorker (integration — module wired)', () => {
  let module: TestingModule;
  let worker: RateLimitCleanupWorker;
  let rateLimitService: RateLimitService;

  const mockPrisma = {
    rateLimitRecord: {
      findUnique: jest.fn().mockResolvedValue(null),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn().mockResolvedValue({
        id: 'rec-1',
        requestCount: 1,
        windowStart: new Date(),
      }),
      update: jest.fn().mockResolvedValue({
        id: 'rec-1',
        requestCount: 2,
        windowStart: new Date(),
      }),
    },
  };

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        RateLimitModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(mockPrisma)
      .compile();

    worker = module.get<RateLimitCleanupWorker>(RateLimitCleanupWorker);
    rateLimitService = module.get<RateLimitService>(RateLimitService);
  });

  afterAll(async () => {
    await module.close();
  });

  it('should resolve RateLimitCleanupWorker from the DI container', () => {
    expect(worker).toBeDefined();
    expect(worker).toBeInstanceOf(RateLimitCleanupWorker);
  });

  it('should resolve RateLimitService from the DI container', () => {
    expect(rateLimitService).toBeDefined();
    expect(rateLimitService).toBeInstanceOf(RateLimitService);
  });

  it('worker.run() should delegate to RateLimitService.cleanupOldRecords() and return a number', async () => {
    // Spy on cleanupOldRecords so we can verify delegation without a real DB
    const cleanupSpy = jest
      .spyOn(rateLimitService, 'cleanupOldRecords')
      .mockResolvedValue(7);

    const deleted = await worker.run();

    expect(cleanupSpy).toHaveBeenCalledTimes(1);
    expect(typeof deleted).toBe('number');
    expect(deleted).toBe(7);
  });

  it('worker.run() should not throw when cleanupOldRecords rejects', async () => {
    jest
      .spyOn(rateLimitService, 'cleanupOldRecords')
      .mockRejectedValue(new Error('DB timeout'));

    await expect(worker.run()).resolves.toBe(0);
  });

  it('RateLimitModule should not expose RateLimitCleanupWorker as a public export', () => {
    // The worker is an internal implementation detail.
    // It must NOT appear in RateLimitModule's exports.
    // We verify by checking that the module metadata only exports the public API.
    // (If someone accidentally added it to exports, module.get() here would still
    // work, but external modules could incorrectly depend on it.)
    const metadata = Reflect.getMetadata(
      'exports',
      RateLimitModule,
    ) as unknown[];
    const exportNames = (metadata ?? []).map((e: any) =>
      typeof e === 'function' ? e.name : String(e),
    );
    expect(exportNames).not.toContain('RateLimitCleanupWorker');
  });
});
