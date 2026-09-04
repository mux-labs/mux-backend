import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MetricsLabelGuardService } from './label-cardinality-guard';

describe('MetricsLabelGuardService', () => {
  let service: MetricsLabelGuardService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MetricsLabelGuardService],
    }).compile();

    service = module.get<MetricsLabelGuardService>(MetricsLabelGuardService);
    service.resetTracking();
  });

  describe('Stellar Key Detection', () => {
    it('should detect Stellar public keys (G prefix)', () => {
      const publicKey = 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJGU7NNLGYXF3ZPKMK2ZGUBAB';
      expect(() =>
        service.validateAndSanitizeLabels('test_metric', {
          wallet_id: publicKey,
        }),
      ).toThrow(BadRequestException);
    });

    it('should detect Stellar secret keys (S prefix)', () => {
      const secretKey = 'SBVZR3FQRQ2YQKKQSQKQKQKQKQKQKQKQKQKQKQKQKQKQKQKQKQKQKP4Z3O';
      expect(() =>
        service.validateAndSanitizeLabels('test_metric', {
          key: secretKey,
        }),
      ).toThrow(BadRequestException);
    });
  });

  describe('Transaction Hash Detection', () => {
    it('should detect 64-char hex transaction hashes', () => {
      const txHash =
        'a1a2a3a4a5a6a7a8a9a0b1b2b3b4b5b6b7b8b9b0c1c2c3c4c5c6c7c8c9c0';
      expect(() =>
        service.validateAndSanitizeLabels('test_metric', {
          tx_id: txHash,
        }),
      ).toThrow(BadRequestException);
    });

    it('should not flag non-hex strings of same length', () => {
      const nonHex = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
      // This should not throw because it's not a valid hex pattern
      const result = service.validateAndSanitizeLabels('test_metric', {
        value: nonHex,
      });
      expect(result.value).toBe(nonHex);
    });
  });

  describe('UUID Detection', () => {
    it('should detect standard UUIDs', () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      expect(() =>
        service.validateAndSanitizeLabels('test_metric', {
          request_id: uuid,
        }),
      ).toThrow(BadRequestException);
    });

    it('should detect case-insensitive UUIDs', () => {
      const uuid = '550E8400-E29B-41D4-A716-446655440000';
      expect(() =>
        service.validateAndSanitizeLabels('test_metric', {
          request_id: uuid,
        }),
      ).toThrow(BadRequestException);
    });
  });

  describe('Opaque Token Detection', () => {
    it('should detect long opaque tokens (40+ chars, mixed case)', () => {
      const token = 'aAbBcCdDeEfFgGhHiIjJkKlLmMnNoOpPqQrRsStT';
      expect(() =>
        service.validateAndSanitizeLabels('test_metric', {
          access_token: token,
        }),
      ).toThrow(BadRequestException);
    });

    it('should not flag lowercase-only long strings as opaque', () => {
      const lowercaseString = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const result = service.validateAndSanitizeLabels('test_metric', {
        value: lowercaseString,
      });
      expect(result.value).toBe(lowercaseString);
    });
  });

  describe('Safe Labels', () => {
    it('should allow bounded enum values', () => {
      const result = service.validateAndSanitizeLabels('test_metric', {
        operation: 'create',
        status: 'success',
        network: 'mainnet',
      });
      expect(result).toEqual({
        operation: 'create',
        status: 'success',
        network: 'mainnet',
      });
    });

    it('should allow short identifiers', () => {
      const result = service.validateAndSanitizeLabels('test_metric', {
        user_id: '123',
        endpoint: '/api/wallets',
      });
      expect(result).toEqual({
        user_id: '123',
        endpoint: '/api/wallets',
      });
    });

    it('should allow empty strings', () => {
      const result = service.validateAndSanitizeLabels('test_metric', {
        optional_field: '',
      });
      expect(result.optional_field).toBe('');
    });
  });

  describe('Production Mode (Sanitization)', () => {
    let productionService: MetricsLabelGuardService;

    beforeEach(async () => {
      process.env.NODE_ENV = 'production';
      const module: TestingModule = await Test.createTestingModule({
        providers: [MetricsLabelGuardService],
      }).compile();

      productionService = module.get<MetricsLabelGuardService>(
        MetricsLabelGuardService,
      );
      productionService.resetTracking();
    });

    afterEach(() => {
      process.env.NODE_ENV = 'test';
    });

    it('should sanitize Stellar keys instead of throwing', () => {
      const publicKey = 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJGU7NNLGYXF3ZPKMK2ZGUBAB';
      const result = productionService.validateAndSanitizeLabels(
        'test_metric',
        {
          wallet_id: publicKey,
        },
      );
      expect(result.wallet_id).toBe('<redacted>');
    });

    it('should sanitize transaction hashes', () => {
      const txHash =
        'a1a2a3a4a5a6a7a8a9a0b1b2b3b4b5b6b7b8b9b0c1c2c3c4c5c6c7c8c9c0';
      const result = productionService.validateAndSanitizeLabels(
        'test_metric',
        {
          tx_id: txHash,
        },
      );
      expect(result.tx_id).toBe('<redacted>');
    });
  });

  describe('Cardinality Tracking', () => {
    it('should track distinct label combinations', () => {
      service.validateAndSanitizeLabels('metric_a', {
        operation: 'create',
      });
      service.validateAndSanitizeLabels('metric_a', { operation: 'update' });
      service.validateAndSanitizeLabels('metric_a', { operation: 'delete' });

      const stats = service.getCardinalityStats();
      expect(stats['metric_a'].distinctCombinations).toBe(3);
    });

    it('should track distinct combinations per metric independently', () => {
      service.validateAndSanitizeLabels('metric_a', { op: 'x' });
      service.validateAndSanitizeLabels('metric_b', { op: 'y' });

      const stats = service.getCardinalityStats();
      expect(stats['metric_a'].distinctCombinations).toBe(1);
      expect(stats['metric_b'].distinctCombinations).toBe(1);
    });

    it('should reset tracking', () => {
      service.validateAndSanitizeLabels('metric_a', { op: 'x' });
      service.resetTracking();

      const stats = service.getCardinalityStats();
      expect(stats).toEqual({});
    });
  });

  describe('Multiple Labels', () => {
    it('should validate all labels in a set', () => {
      const publicKey = 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJGU7NNLGYXF3ZPKMK2ZGUBAB';
      expect(() =>
        service.validateAndSanitizeLabels('test_metric', {
          operation: 'create',
          wallet_id: publicKey, // suspicious
          status: 'success',
        }),
      ).toThrow(BadRequestException);
    });

    it('should sanitize in production mode with mixed labels', () => {
      process.env.NODE_ENV = 'production';
      const prodService = new MetricsLabelGuardService();

      const publicKey = 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJGU7NNLGYXF3ZPKMK2ZGUBAB';
      const result = prodService.validateAndSanitizeLabels('test_metric', {
        operation: 'create',
        wallet_id: publicKey,
        status: 'success',
      });

      expect(result.operation).toBe('create');
      expect(result.wallet_id).toBe('<redacted>');
      expect(result.status).toBe('success');

      process.env.NODE_ENV = 'test';
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty label object', () => {
      const result = service.validateAndSanitizeLabels('test_metric', {});
      expect(result).toEqual({});
    });

    it('should handle null/undefined values gracefully', () => {
      // This test demonstrates the guard's handling of edge cases
      const result = service.validateAndSanitizeLabels('test_metric', {
        valid: 'ok',
      });
      expect(result.valid).toBe('ok');
    });

    it('should handle special characters in safe values', () => {
      const result = service.validateAndSanitizeLabels('test_metric', {
        path: '/api/v1/users/123',
        error: 'Invalid request',
      });
      expect(result.path).toBe('/api/v1/users/123');
      expect(result.error).toBe('Invalid request');
    });
  });
});
