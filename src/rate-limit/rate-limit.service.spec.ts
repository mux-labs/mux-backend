import { RateLimitService } from './rate-limit.service';
import { ConfigService } from '@nestjs/config';

describe('RateLimitService', () => {
  let service: RateLimitService;
  let mockPrisma: any;
  let mockConfigService: ConfigService;

  beforeEach(() => {
    mockPrisma = {
      rateLimitRecord: {
        findUnique: jest.fn(),
        deleteMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };

    mockConfigService = {
      get: jest.fn((key: string, defaultValue?: string) => {
        switch (key) {
          case 'RATE_LIMIT_WINDOW_MS':
            return '60000';
          case 'RATE_LIMIT_MAX_REQUESTS':
            return '100';
          case 'RATE_LIMIT_SENSITIVE_WINDOW_MS':
            return '60000';
          case 'RATE_LIMIT_SENSITIVE_MAX_REQUESTS':
            return '10';
          default:
            return defaultValue;
        }
      }),
    } as unknown as ConfigService;

    service = new RateLimitService(mockPrisma, mockConfigService);
  });

  it('should use project-specific rate limit settings when present', async () => {
    mockPrisma.rateLimitRecord.findUnique.mockResolvedValue(null);
    mockPrisma.rateLimitRecord.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.rateLimitRecord.create.mockResolvedValue({
      id: 'record-1',
      requestCount: 1,
      windowStart: new Date(),
    });

    const result = await service.checkRateLimit('api-key-id', 'GET /test', 42);

    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(42);
    expect(result.remaining).toBe(41);
    expect(mockPrisma.rateLimitRecord.deleteMany).toHaveBeenCalledWith({
      where: {
        apiKeyId: 'api-key-id',
        endpoint: 'GET /test',
        windowStart: expect.any(Object),
      },
    });
  });

  it('should use default rate limit settings when project limit is not set', async () => {
    mockPrisma.rateLimitRecord.findUnique.mockResolvedValue(null);
    mockPrisma.rateLimitRecord.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.rateLimitRecord.create.mockResolvedValue({
      id: 'record-2',
      requestCount: 1,
      windowStart: new Date(),
    });

    const result = await service.checkRateLimit('api-key-id', 'POST /test');

    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(100);
    expect(result.remaining).toBe(99);
  });
});
