import { Test, TestingModule } from '@nestjs/testing';
import { WebhookConfigService } from './webhook-config.service';
import { ConfigService } from '@nestjs/config';

describe('WebhookConfigService', () => {
  let service: WebhookConfigService;
  let mockConfigService: any;

  beforeEach(async () => {
    mockConfigService = {
      get: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookConfigService,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<WebhookConfigService>(WebhookConfigService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('onModuleInit', () => {
    it('should initialize successfully when all required env vars are set', async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        const values: Record<string, any> = {
          WEBHOOK_MAX_RETRIES: 5,
          WEBHOOK_RETRY_BACKOFF_MS: 1000,
          WEBHOOK_TIMEOUT_MS: 10000,
          WEBHOOK_MAX_CONSECUTIVE_FAILURES: 10,
        };
        return values[key];
      });

      await expect(service.onModuleInit()).resolves.not.toThrow();
    });

    it('should throw error when WEBHOOK_MAX_RETRIES is missing', async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        const values: Record<string, any> = {
          WEBHOOK_RETRY_BACKOFF_MS: 1000,
          WEBHOOK_TIMEOUT_MS: 10000,
          WEBHOOK_MAX_CONSECUTIVE_FAILURES: 10,
        };
        return values[key];
      });

      await expect(service.onModuleInit()).rejects.toThrow(
        /WEBHOOK_MAX_RETRIES/,
      );
    });

    it('should throw error when WEBHOOK_RETRY_BACKOFF_MS is missing', async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        const values: Record<string, any> = {
          WEBHOOK_MAX_RETRIES: 5,
          WEBHOOK_TIMEOUT_MS: 10000,
          WEBHOOK_MAX_CONSECUTIVE_FAILURES: 10,
        };
        return values[key];
      });

      await expect(service.onModuleInit()).rejects.toThrow(
        /WEBHOOK_RETRY_BACKOFF_MS/,
      );
    });

    it('should throw error when WEBHOOK_TIMEOUT_MS is missing', async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        const values: Record<string, any> = {
          WEBHOOK_MAX_RETRIES: 5,
          WEBHOOK_RETRY_BACKOFF_MS: 1000,
          WEBHOOK_MAX_CONSECUTIVE_FAILURES: 10,
        };
        return values[key];
      });

      await expect(service.onModuleInit()).rejects.toThrow(
        /WEBHOOK_TIMEOUT_MS/,
      );
    });

    it('should throw error when WEBHOOK_MAX_CONSECUTIVE_FAILURES is missing', async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        const values: Record<string, any> = {
          WEBHOOK_MAX_RETRIES: 5,
          WEBHOOK_RETRY_BACKOFF_MS: 1000,
          WEBHOOK_TIMEOUT_MS: 10000,
        };
        return values[key];
      });

      await expect(service.onModuleInit()).rejects.toThrow(
        /WEBHOOK_MAX_CONSECUTIVE_FAILURES/,
      );
    });

    it('should validate that WEBHOOK_MAX_RETRIES is a non-negative number', async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        const values: Record<string, any> = {
          WEBHOOK_MAX_RETRIES: -1,
          WEBHOOK_RETRY_BACKOFF_MS: 1000,
          WEBHOOK_TIMEOUT_MS: 10000,
          WEBHOOK_MAX_CONSECUTIVE_FAILURES: 10,
        };
        return values[key];
      });

      await expect(service.onModuleInit()).rejects.toThrow(
        /WEBHOOK_MAX_RETRIES must be a non-negative number/,
      );
    });

    it('should throw error on multiple missing env vars', async () => {
      mockConfigService.get.mockReturnValue(undefined);

      await expect(service.onModuleInit()).rejects.toThrow(
        /Missing required webhook environment variables/,
      );
    });
  });
});
