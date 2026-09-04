import { ApiKeyService, CreateApiKeyRequest } from './api-key.service';
import { PrismaClient } from '../generated/prisma/client';
import { ConfigService } from '@nestjs/config';

describe('ApiKeyService - Network Scoped Keys', () => {
  let service: ApiKeyService;
  let mockPrisma: any;
  let mockConfigService: any;

  beforeEach(() => {
    mockConfigService = {
      get: jest.fn((key: string, fallback: any) => {
        if (key === 'API_KEY_ROTATION_GRACE_SECONDS') return 3600;
        return fallback;
      }),
    };

    mockPrisma = {
      project: {
        findUnique: jest.fn(),
      },
      apiKey: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
      },
    };

    service = new ApiKeyService(mockConfigService);
    (service as any).prisma = mockPrisma;
  });

  describe('createApiKey with network scope', () => {
    it('should create API key with MAINNET network scope', async () => {
      const project = {
        id: 'proj-1',
        environment: 'production',
      };

      const request: CreateApiKeyRequest = {
        name: 'Production Mainnet Key',
        projectId: 'proj-1',
        network: 'MAINNET',
      };

      mockPrisma.project.findUnique.mockResolvedValue(project);
      mockPrisma.apiKey.create.mockResolvedValue({
        id: 'key-1',
        name: request.name,
        keyHash: 'hash123',
        keyPrefix: 'mux_live_',
        lastFour: 'abcd',
        projectId: 'proj-1',
        network: 'MAINNET',
        status: 'ACTIVE',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await service.createApiKey(request);

      expect(mockPrisma.apiKey.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            network: 'MAINNET',
          }),
        }),
      );
      expect(result.apiKey.network).toBe('MAINNET');
    });

    it('should create API key with TESTNET network scope', async () => {
      const project = {
        id: 'proj-2',
        environment: 'staging',
      };

      const request: CreateApiKeyRequest = {
        name: 'Staging Testnet Key',
        projectId: 'proj-2',
        network: 'TESTNET',
      };

      mockPrisma.project.findUnique.mockResolvedValue(project);
      mockPrisma.apiKey.create.mockResolvedValue({
        id: 'key-2',
        name: request.name,
        keyHash: 'hash456',
        keyPrefix: 'mux_test_',
        lastFour: 'efgh',
        projectId: 'proj-2',
        network: 'TESTNET',
        status: 'ACTIVE',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await service.createApiKey(request);

      expect(mockPrisma.apiKey.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            network: 'TESTNET',
          }),
        }),
      );
      expect(result.apiKey.network).toBe('TESTNET');
    });

    it('should create API key without network scope (all networks)', async () => {
      const project = {
        id: 'proj-3',
        environment: 'production',
      };

      const request: CreateApiKeyRequest = {
        name: 'Universal Key',
        projectId: 'proj-3',
      };

      mockPrisma.project.findUnique.mockResolvedValue(project);
      mockPrisma.apiKey.create.mockResolvedValue({
        id: 'key-3',
        name: request.name,
        keyHash: 'hash789',
        keyPrefix: 'mux_live_',
        lastFour: 'ijkl',
        projectId: 'proj-3',
        network: null,
        status: 'ACTIVE',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await service.createApiKey(request);

      expect(mockPrisma.apiKey.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            network: null,
          }),
        }),
      );
      expect(result.apiKey.network).toBeUndefined();
    });
  });

  describe('rotateApiKey preserves network scope', () => {
    it('should preserve network scope when rotating key', async () => {
      const oldKey = {
        id: 'old-key',
        name: 'Original Key',
        projectId: 'proj-1',
        network: 'MAINNET',
        expiresAt: null,
        project: { id: 'proj-1', environment: 'production' },
      };

      mockPrisma.apiKey.findUnique.mockResolvedValue(oldKey);
      mockPrisma.project.findUnique.mockResolvedValue(oldKey.project);
      mockPrisma.apiKey.create.mockResolvedValue({
        id: 'new-key',
        name: 'Original Key (rotated)',
        keyHash: 'newHash',
        keyPrefix: 'mux_live_',
        lastFour: 'mnop',
        projectId: 'proj-1',
        network: 'MAINNET',
        status: 'ACTIVE',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await service.rotateApiKey(
        { apiKeyId: 'old-key' },
      );

      expect(mockPrisma.apiKey.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            network: 'MAINNET',
          }),
        }),
      );
    });
  });

  describe('listApiKeysByNetwork', () => {
    it('should list API keys for specific network', async () => {
      const keys = [
        {
          id: 'key-1',
          network: 'MAINNET',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      mockPrisma.apiKey.findMany.mockResolvedValue(keys);
      mockPrisma.apiKey.count.mockResolvedValue(1);

      const result = await service.listApiKeysByNetwork('proj-1', 'MAINNET');

      expect(mockPrisma.apiKey.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            projectId: 'proj-1',
            network: 'MAINNET',
          }),
        }),
      );
      expect(result.keys).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it('should list API keys that support all networks (null network)', async () => {
      const keys = [
        {
          id: 'universal-key',
          network: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      mockPrisma.apiKey.findMany.mockResolvedValue(keys);
      mockPrisma.apiKey.count.mockResolvedValue(1);

      const result = await service.listApiKeysByNetwork('proj-2');

      expect(mockPrisma.apiKey.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            projectId: 'proj-2',
            network: null,
          }),
        }),
      );
    });

    it('should support pagination', async () => {
      mockPrisma.apiKey.findMany.mockResolvedValue([]);
      mockPrisma.apiKey.count.mockResolvedValue(25);

      await service.listApiKeysByNetwork('proj-1', 'TESTNET', 2, 10);

      expect(mockPrisma.apiKey.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 10,
          take: 10,
        }),
      );
    });
  });
});
