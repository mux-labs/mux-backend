import { Test, TestingModule } from '@nestjs/testing';
import { IdempotencyModule } from './idempotency.module';
import { IdempotencyService } from './idempotency.service';
import { IdempotencyCleanupWorker } from './idempotency-cleanup.worker';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from '../common/metrics/metrics.service';

/**
 * Wiring contract for IdempotencyModule (#962).
 *
 * Acceptance criterion: the TTL cleanup worker must be resolvable from the DI
 * container so it starts automatically with the application, and it must NOT
 * be a public export (it is an internal implementation detail, not API).
 */
describe('IdempotencyModule (wiring)', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    // PrismaService is overridden with a stub so no database connection is
    // opened; the module wiring itself is what is under test.
    moduleRef = await Test.createTestingModule({
      imports: [IdempotencyModule],
    })
      .overrideProvider(PrismaService)
      .useValue({
        idempotencyRecord: {
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
      })
      .compile();
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  it('resolves IdempotencyService from the DI container', () => {
    expect(moduleRef.get(IdempotencyService)).toBeInstanceOf(
      IdempotencyService,
    );
  });

  it('resolves IdempotencyCleanupWorker from the DI container', () => {
    // The worker must be a provider so it starts automatically with the app
    // once IDEMPOTENCY_CLEANUP_ENABLED=true.
    expect(moduleRef.get(IdempotencyCleanupWorker)).toBeInstanceOf(
      IdempotencyCleanupWorker,
    );
  });

  it('wires PrismaService and MetricsService as providers', () => {
    // Both are constructor dependencies of IdempotencyService; their presence
    // in the module metadata is what makes the container resolve it.
    const providers = (Reflect.getMetadata('providers', IdempotencyModule) ??
      []) as unknown[];
    expect(providers).toContain(PrismaService);
    expect(providers).toContain(MetricsService);
  });

  it('does not export the cleanup worker as public API', () => {
    const exportsList = (Reflect.getMetadata('exports', IdempotencyModule) ??
      []) as unknown[];
    const exportNames = exportsList.map((e: unknown) =>
      typeof e === 'function' ? (e as { name: string }).name : String(e),
    );

    expect(exportNames).not.toContain('IdempotencyCleanupWorker');
    expect(exportNames).toContain('IdempotencyService');
  });
});
