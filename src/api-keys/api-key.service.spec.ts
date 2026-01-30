import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { ApiKeyService } from './api-key.service';
import { ApiKeyStatus } from './domain/api-key.model';

describe('ApiKeyService', () => {
  let service: ApiKeyService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ApiKeyService],
    }).compile();

    service = module.get<ApiKeyService>(ApiKeyService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('validateApiKey', () => {
    it('should reject invalid API key format', async () => {
      await expect(service.validateApiKey('invalid-key')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should reject non-existent API key', async () => {
      await expect(
        service.validateApiKey('mux_test_nonexistent'),
      ).rejects.toThrow(UnauthorizedException);
    });
  });
});
