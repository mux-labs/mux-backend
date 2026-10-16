import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { KeyRotationService } from './key-rotation.service';
import { KeyRotationAuditService } from './key-rotation-audit.service';
import { KeyManagementService } from './key-management.service';
import { KeyType, KeyOperation } from './domain/key-types';
import { normalizeAuditLogQueryParams, MAX_AUDIT_LOG_LIMIT } from './domain/key-types';

describe('KeyRotationService', () => {
  let service: KeyRotationService;
  let auditService: KeyRotationAuditService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KeyRotationService,
        {
          provide: KeyRotationAuditService,
          useValue: {
            queryAuditLog: jest.fn().mockResolvedValue({ items: [], total: 0 }),
          },
        },
        {
          provide: KeyManagementService,
          useValue: {},
        },
      ],
    }).compile();

    service = module.get<KeyRotationService>(KeyRotationService);
    auditService = module.get<KeyRotationAuditService>(KeyRotationAuditService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('audit log query params validation', () => {
    it('applies the default limit when omitted', () => {
      const result = normalizeAuditLogQueryParams({});
      expect(result.limit).toBe(MAX_AUDIT_LOG_LIMIT);
    });

    it('rejects a limit above the documented maximum', () => {
      expect(() =>
        normalizeAuditLogQueryParams({ limit: MAX_AUDIT_LOG_LIMIT + 1 }),
      ).toThrow(BadRequestException);
    });

    it('rejects a limit of 0', () => {
      expect(() => normalizeAuditLogQueryParams({ limit: 0 })).toThrow(
        BadRequestException,
      );
    });

    it('rejects a limit of -1', () => {
      expect(() => normalizeAuditLogQueryParams({ limit: -1 })).toThrow(
        BadRequestException,
      );
    });

    it('rejects a startDate later than endDate', () => {
      expect(() =>
        normalizeAuditLogQueryParams({
          startDate: '2024-06-01T00:00:00.000Z',
          endDate: '2024-01-01T00:00:00.000Z',
        }),
      ).toThrow(BadRequestException);
    });

    it('rejects a non-ISO startDate', () => {
      expect(() =>
        normalizeAuditLogQueryParams({ startDate: 'yesterday' }),
      ).toThrow(BadRequestException);
    });

    it('returns a valid query unchanged', () => {
      const params = {
        limit: 50,
        operation: KeyOperation.ROTATE,
        keyType: KeyType.RSA,
        success: true,
        startDate: '2024-01-01T00:00:00.000Z',
        endDate: '2024-06-01T00:00:00.000Z',
      };
      expect(normalizeAuditLogQueryParams(params)).toEqual(params);
    });
  });
});
