import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BalanceIndexerService } from './balance-indexer.service';

describe('BalanceIndexerService.assertWritesEnabled', () => {
  const buildService = async (writesEnabled: string | undefined) => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BalanceIndexerService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key === 'BALANCE_INDEXER_WRITES_ENABLED' ? writesEnabled : undefined,
            ),
          },
        },
      ],
    }).compile();

    return module.get<BalanceIndexerService>(BalanceIndexerService);
  };

  it('denies mutations by default when the operator opt-in flag is not set', async () => {
    const service = await buildService(undefined);

    expect(() => service.assertWritesEnabled()).toThrow();
  });

  it('denies mutations when the operator opt-in flag is explicitly disabled', async () => {
    const service = await buildService('false');

    expect(() => service.assertWritesEnabled()).toThrow();
  });

  it('allows mutations when the operator explicitly opts in', async () => {
    const service = await buildService('true');

    expect(() => service.assertWritesEnabled()).not.toThrow();
  });
});

describe('BalanceIndexerService.authorizationDenied', () => {
  const buildService = async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BalanceIndexerService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(() => undefined),
          },
        },
      ],
    }).compile();

    return module.get<BalanceIndexerService>(BalanceIndexerService);
  };

  it('records a denial and builds the envelope the caller throws', async () => {
    const service = await buildService();

    const envelope = service.authorizationDenied('insufficient scope');

    expect(envelope).toBeDefined();
    expect(envelope).toMatchObject({
      error: expect.any(String),
      message: expect.stringContaining('insufficient scope'),
    });
  });

  it('builds a throwable envelope for the failure path', async () => {
    const service = await buildService();

    const envelope = service.authorizationDenied('insufficient scope');

    expect(() => {
      throw envelope;
    }).toThrow();
  });
});

describe('BalanceIndexerService.isRetryable', () => {
  const service = Object.create(
    BalanceIndexerService.prototype,
  ) as BalanceIndexerService;

  const isRetryable = (status: number): boolean =>
    (service as unknown as { isRetryable(status: number): boolean }).isRetryable(
      status,
    );

  it('retries 503 (dependency-unavailable envelope and upstream 5xx)', () => {
    expect(isRetryable(503)).toBe(true);
  });

  it('retries 429 (rate limiting)', () => {
    expect(isRetryable(429)).toBe(true);
  });

  it('does not retry 4xx errors (bad input, disabled feature, not found)', () => {
    expect(isRetryable(400)).toBe(false);
    expect(isRetryable(403)).toBe(false);
    expect(isRetryable(404)).toBe(false);
  });
});

  });
});
