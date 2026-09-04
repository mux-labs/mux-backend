import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrivateResourceService } from './private-resource.service';

describe('PrivateResourceService - 404/403 Policy', () => {
  let service: PrivateResourceService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PrivateResourceService],
    }).compile();

    service = module.get<PrivateResourceService>(PrivateResourceService);
  });

  describe('checkResourceAccess', () => {
    const testResource = { id: 'wallet-123', userId: 'user-1' };

    it('should return resource when authorized and found', () => {
      const result = service.checkResourceAccess(
        testResource,
        true,
        'Wallet',
        'wallet-123',
      );
      expect(result).toBe(testResource);
    });

    it('should throw NotFoundException when resource not found and authorized', () => {
      expect(() =>
        service.checkResourceAccess(null, true, 'Wallet', 'wallet-123'),
      ).toThrow(NotFoundException);
      expect(() =>
        service.checkResourceAccess(null, true, 'Wallet', 'wallet-123'),
      ).toThrow('Wallet not found: wallet-123');
    });

    it('should throw NotFoundException when not authorized (hide existence)', () => {
      expect(() =>
        service.checkResourceAccess(
          testResource,
          false,
          'Wallet',
          'wallet-123',
        ),
      ).toThrow(NotFoundException);
      expect(() =>
        service.checkResourceAccess(
          testResource,
          false,
          'Wallet',
          'wallet-123',
        ),
      ).toThrow('Wallet not found: wallet-123');
    });

    it('should throw NotFoundException when not found and not authorized', () => {
      expect(() =>
        service.checkResourceAccess(null, false, 'Wallet', 'wallet-123'),
      ).toThrow(NotFoundException);
    });

    it('should handle undefined resource same as null', () => {
      expect(() =>
        service.checkResourceAccess(undefined, true, 'Wallet', 'wallet-123'),
      ).toThrow(NotFoundException);
    });
  });

  describe('checkResourceAccessWithPredicate', () => {
    const testResource = { id: 'wallet-123', userId: 'user-1' };

    it('should return resource when authorization predicate returns true', () => {
      const result = service.checkResourceAccessWithPredicate(
        testResource,
        (r) => r.userId === 'user-1',
        'Wallet',
        'wallet-123',
      );
      expect(result).toBe(testResource);
    });

    it('should throw NotFoundException when resource is null/undefined', () => {
      expect(() =>
        service.checkResourceAccessWithPredicate(
          null,
          () => true,
          'Wallet',
          'wallet-123',
        ),
      ).toThrow(NotFoundException);
      expect(() =>
        service.checkResourceAccessWithPredicate(
          undefined,
          () => true,
          'Wallet',
          'wallet-123',
        ),
      ).toThrow(NotFoundException);
    });

    it('should throw ForbiddenException when authorization predicate returns false', () => {
      expect(() =>
        service.checkResourceAccessWithPredicate(
          testResource,
          (r) => r.userId === 'user-2',
          'Wallet',
          'wallet-123',
        ),
      ).toThrow(ForbiddenException);
      expect(() =>
        service.checkResourceAccessWithPredicate(
          testResource,
          (r) => r.userId === 'user-2',
          'Wallet',
          'wallet-123',
        ),
      ).toThrow('You do not have permission to access this Wallet');
    });
  });

  describe('checkResourceOwnership', () => {
    const wallet = { id: 'wallet-123', userId: 'user-1' };

    it('should return resource when owner matches current user', () => {
      const result = service.checkResourceOwnership(
        wallet,
        'user-1',
        'user-1',
        'Wallet',
        'wallet-123',
      );
      expect(result).toBe(wallet);
    });

    it('should throw NotFoundException when resource not found', () => {
      expect(() =>
        service.checkResourceOwnership(
          null,
          'user-1',
          'user-1',
          'Wallet',
          'wallet-123',
        ),
      ).toThrow(NotFoundException);
    });

    it('should throw ForbiddenException when owner does not match current user', () => {
      expect(() =>
        service.checkResourceOwnership(
          wallet,
          'user-1',
          'user-2',
          'Wallet',
          'wallet-123',
        ),
      ).toThrow(ForbiddenException);
      expect(() =>
        service.checkResourceOwnership(
          wallet,
          'user-1',
          'user-2',
          'Wallet',
          'wallet-123',
        ),
      ).toThrow('You do not have permission to access this Wallet');
    });
  });

  describe('Error message clarity', () => {
    it('should include resource type in NotFoundException', () => {
      try {
        service.checkResourceAccess(null, true, 'Transaction', 'tx-456');
      } catch (e) {
        expect(e.message).toContain('Transaction');
        expect(e.message).toContain('tx-456');
      }
    });

    it('should include resource type in ForbiddenException', () => {
      try {
        service.checkResourceAccessWithPredicate(
          { id: 'tx-456' },
          () => false,
          'Transaction',
          'tx-456',
        );
      } catch (e) {
        expect(e.message).toContain('Transaction');
      }
    });
  });

  describe('Authorization policy enforcement', () => {
    const resource = { id: 'res-1', ownerId: 'owner-1' };

    it('Policy: Authorized + Found → Success', () => {
      expect(() =>
        service.checkResourceAccess(resource, true, 'Resource', 'res-1'),
      ).not.toThrow();
    });

    it('Policy: Authorized + Not Found → 404', () => {
      expect(() =>
        service.checkResourceAccess(null, true, 'Resource', 'res-1'),
      ).toThrow(NotFoundException);
    });

    it('Policy: Not Authorized + Found → 404 (hide existence)', () => {
      expect(() =>
        service.checkResourceAccess(resource, false, 'Resource', 'res-1'),
      ).toThrow(NotFoundException);
    });

    it('Policy: Not Authorized + Not Found → 404', () => {
      expect(() =>
        service.checkResourceAccess(null, false, 'Resource', 'res-1'),
      ).toThrow(NotFoundException);
    });

    it('Policy: Using predicate for fine-grained authorization', () => {
      // Authorized (predicate true) + Found → Success
      expect(() =>
        service.checkResourceAccessWithPredicate(
          resource,
          (r) => true,
          'Resource',
          'res-1',
        ),
      ).not.toThrow();

      // Not Authorized (predicate false) + Found → 403
      expect(() =>
        service.checkResourceAccessWithPredicate(
          resource,
          (r) => false,
          'Resource',
          'res-1',
        ),
      ).toThrow(ForbiddenException);
    });
  });
});
