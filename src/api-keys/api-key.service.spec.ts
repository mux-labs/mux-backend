import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { ApiKeyService, CreateApiKeyResult } from './api-key.service';
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

  describe('createApiKey', () => {
    it('should return plaintext key only on creation', async () => {
      const result = await service.createApiKey({
        name: 'test-key',
        projectId: 'project-123',
      });

      expect(result.plainTextKey).toBeDefined();
      expect(result.plainTextKey).toMatch(/^mux_(live|test)_/);
      expect(result.plainTextKey.length).toBeGreaterThan(20);
    });

    it('should not include plaintext key in stored ApiKey object', async () => {
      const result = await service.createApiKey({
        name: 'test-key',
        projectId: 'project-123',
      });

      // The domain model should not include plainTextKey
      expect(result.apiKey).toBeDefined();
      expect((result.apiKey as any).plainTextKey).toBeUndefined();
    });

    it('should store hashed key not plaintext', async () => {
      const result = await service.createApiKey({
        name: 'test-key',
        projectId: 'project-123',
      });

      // keyHash should be present and should not equal plainTextKey
      expect(result.apiKey.keyHash).toBeDefined();
      expect(result.apiKey.keyHash).not.toEqual(result.plainTextKey);
      // Hash should be hex (SHA-256)
      expect(result.apiKey.keyHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should include key metadata in response', async () => {
      const result = await service.createApiKey({
        name: 'test-key',
        projectId: 'project-123',
      });

      expect(result.apiKey.id).toBeDefined();
      expect(result.apiKey.name).toBe('test-key');
      expect(result.apiKey.keyPrefix).toMatch(/^mux_(live|test)_/);
      expect(result.apiKey.lastFour).toMatch(/^[a-zA-Z0-9_-]{4}$/);
      expect(result.apiKey.status).toBe(ApiKeyStatus.ACTIVE);
      expect(result.apiKey.createdAt).toBeDefined();
    });
  });

  describe('listApiKeys', () => {
    it('should return only metadata without keys or hashes', async () => {
      // Create a key first
      await service.createApiKey({
        name: 'test-key',
        projectId: 'project-123',
      });

      const keys = await service.listApiKeys('project-123');

      expect(keys.length).toBeGreaterThan(0);
      keys.forEach((key) => {
        expect(key.id).toBeDefined();
        expect(key.name).toBeDefined();
        expect(key.keyPrefix).toBeDefined();
        expect(key.lastFour).toBeDefined();
        expect(key.status).toBeDefined();
        // Should NOT include hashes
        expect((key as any).plainTextKey).toBeUndefined();
      });
    });
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

    it('should reject expired API key', async () => {
      const result = await service.createApiKey({
        name: 'expiring-key',
        projectId: 'project-123',
        expiresAt: new Date(Date.now() - 1000), // Expired 1 second ago
      });

      await expect(
        service.validateApiKey(result.plainTextKey),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should validate active API key successfully', async () => {
      const createResult = await service.createApiKey({
        name: 'active-key',
        projectId: 'project-123',
      });

      const validateResult = await service.validateApiKey(
        createResult.plainTextKey,
      );

      expect(validateResult.apiKey).toBeDefined();
      expect(validateResult.apiKey.status).toBe(ApiKeyStatus.ACTIVE);
    });
  });

  describe('rotateApiKey', () => {
    it('should return plaintext key only for new rotated key', async () => {
      // Create initial key
      const createResult = await service.createApiKey({
        name: 'original-key',
        projectId: 'project-123',
      });

      // Rotate it
      const rotateResult = await service.rotateApiKey({
        apiKeyId: createResult.apiKey.id,
      });

      // New key should have plaintext
      expect(rotateResult.plainTextKey).toBeDefined();
      expect(rotateResult.plainTextKey).not.toEqual(
        createResult.plainTextKey,
      );
    });

    it('should revoke old key when rotating', async () => {
      const createResult = await service.createApiKey({
        name: 'original-key',
        projectId: 'project-123',
      });

      const rotateResult = await service.rotateApiKey({
        apiKeyId: createResult.apiKey.id,
      });

      // Old key should now be revoked
      await expect(
        service.validateApiKey(createResult.plainTextKey),
      ).rejects.toThrow(UnauthorizedException);

      // New key should work
      const validateResult = await service.validateApiKey(
        rotateResult.plainTextKey,
      );
      expect(validateResult.apiKey.status).toBe(ApiKeyStatus.ACTIVE);
    });
  });
});
