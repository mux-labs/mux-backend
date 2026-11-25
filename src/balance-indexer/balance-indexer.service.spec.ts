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
