import { ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  assertUserCanTransact,
  BLOCKED_USER_STATUSES,
  isUserBlocked,
  UserStatusErrorCode,
  userBlockedErrorCode,
  userNotFound,
} from './user-status.policy';

/**
 * `UserStatus` policy (#941).
 *
 * The enum landed in migration `20260831000001_add_user_status_enum`; these
 * tests pin the behaviour that migration implies: a suspended or disabled
 * account cannot create a wallet or move money.
 */
describe('user-status policy (#941)', () => {
  describe('blocking matrix', () => {
    it('blocks SUSPENDED and DISABLED for every money operation', () => {
      expect(BLOCKED_USER_STATUSES.wallet_create).toEqual(
        expect.arrayContaining(['SUSPENDED', 'DISABLED']),
      );
      expect(BLOCKED_USER_STATUSES.payment).toEqual(
        expect.arrayContaining(['SUSPENDED', 'DISABLED']),
      );
    });

    it('holds a payment while the account is mid-recovery', () => {
      expect(BLOCKED_USER_STATUSES.payment).toContain('RECOVERY_PENDING');
      // Provisioning a replacement wallet during recovery is still allowed.
      expect(BLOCKED_USER_STATUSES.wallet_create).not.toContain(
        'RECOVERY_PENDING',
      );
    });

    it('allows ACTIVE and PROVISIONING to create a wallet', () => {
      expect(
        isUserBlocked({ userId: 'u1', status: 'ACTIVE' }, 'wallet_create'),
      ).toBe(false);
      expect(
        isUserBlocked(
          { userId: 'u1', status: 'PROVISIONING' },
          'wallet_create',
        ),
      ).toBe(false);
    });

    it('is case- and whitespace-insensitive', () => {
      expect(
        userBlockedErrorCode({ status: ' suspended ' }, 'wallet_create'),
      ).toBe(UserStatusErrorCode.USER_SUSPENDED);
    });

    it('maps each blocked status to its own stable code', () => {
      expect(userBlockedErrorCode({ status: 'SUSPENDED' }, 'payment')).toBe(
        UserStatusErrorCode.USER_SUSPENDED,
      );
      expect(userBlockedErrorCode({ status: 'DISABLED' }, 'payment')).toBe(
        UserStatusErrorCode.USER_DISABLED,
      );
      expect(
        userBlockedErrorCode({ status: 'RECOVERY_PENDING' }, 'payment'),
      ).toBe(UserStatusErrorCode.USER_RECOVERY_PENDING);
    });
  });

  describe('assertUserCanTransact', () => {
    it('returns silently for an account that may transact', () => {
      expect(() =>
        assertUserCanTransact(
          { userId: 'user-active', status: 'ACTIVE' },
          'payment',
          'req-1',
        ),
      ).not.toThrow();
    });

    it('throws 403 with a stable code for a suspended user', () => {
      try {
        assertUserCanTransact(
          { userId: 'user-suspended', status: 'SUSPENDED' },
          'wallet_create',
          'req-2',
        );
        throw new Error('expected a denial');
      } catch (error) {
        expect(error).toBeInstanceOf(ForbiddenException);
        const body = (error as ForbiddenException).getResponse() as any;
        expect(body.code).toBe(UserStatusErrorCode.USER_SUSPENDED);
        expect(body.correlationId).toBe('req-2');
        expect(body.message).toContain('wallet_create');
        // No PII beyond the id it was called with.
        expect(body.message).not.toMatch(/email|@/i);
      }
    });

    it('throws 403 for a disabled user on a payment', () => {
      try {
        assertUserCanTransact(
          { userId: 'user-disabled', status: 'DISABLED' },
          'payment',
        );
        throw new Error('expected a denial');
      } catch (error) {
        expect((error as ForbiddenException).getResponse()).toMatchObject({
          code: UserStatusErrorCode.USER_DISABLED,
        });
      }
    });

    it('fails closed on an unrecognised status', () => {
      // An unknown status (typo, half-applied migration) is not evidence of a
      // healthy account, so it is refused rather than passed through.
      expect(
        userBlockedErrorCode({ status: 'WEIRD_NEW_STATUS' }, 'payment'),
      ).toBe(UserStatusErrorCode.USER_STATUS_UNKNOWN);
      expect(
        isUserBlocked({ userId: 'u', status: 'WEIRD_NEW_STATUS' }, 'payment'),
      ).toBe(true);
    });
  });

  describe('userNotFound', () => {
    it('is a 404 with the stable code', () => {
      const error = userNotFound('user-x', 'req-3');
      expect(error).toBeInstanceOf(NotFoundException);
      expect(error.getResponse()).toMatchObject({
        code: UserStatusErrorCode.USER_NOT_FOUND,
        correlationId: 'req-3',
      });
    });
  });
});
