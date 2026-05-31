import { User, UserStatus, UserValidationError } from './user.entity';

const baseProps = () => ({
  id: 'usr_01HABC',
  authId: 'auth0|abc123',
  authProvider: 'auth0',
});

describe('User entity', () => {
  describe('create', () => {
    it('instantiates with required fields and sensible defaults', () => {
      const user = User.create(baseProps());

      expect(user.id).toBe('usr_01HABC');
      expect(user.authId).toBe('auth0|abc123');
      expect(user.authProvider).toBe('auth0');
      expect(user.status).toBe(UserStatus.PROVISIONING);
      expect(user.email).toBeNull();
      expect(user.displayName).toBeNull();
      expect(user.lastLoginAt).toBeNull();
      expect(user.createdAt).toBeInstanceOf(Date);
      expect(user.updatedAt).toBeInstanceOf(Date);
    });

    it('preserves provided optional fields', () => {
      const createdAt = new Date('2026-01-01T00:00:00Z');
      const updatedAt = new Date('2026-01-02T00:00:00Z');
      const lastLoginAt = new Date('2026-01-03T00:00:00Z');
      const user = User.create({
        ...baseProps(),
        status: UserStatus.ACTIVE,
        email: 'a@b.co',
        displayName: 'Dave',
        lastLoginAt,
        createdAt,
        updatedAt,
      });

      expect(user.status).toBe(UserStatus.ACTIVE);
      expect(user.email).toBe('a@b.co');
      expect(user.displayName).toBe('Dave');
      expect(user.lastLoginAt).toBe(lastLoginAt);
      expect(user.createdAt).toBe(createdAt);
      expect(user.updatedAt).toBe(updatedAt);
    });
  });

  describe('validation', () => {
    it.each([
      ['empty id', { ...baseProps(), id: '' }, 'id'],
      ['id with spaces', { ...baseProps(), id: 'bad id' }, 'id'],
      ['empty authId', { ...baseProps(), authId: '' }, 'authId'],
      [
        'oversized authId',
        { ...baseProps(), authId: 'x'.repeat(257) },
        'authId',
      ],
      ['empty authProvider', { ...baseProps(), authProvider: '' }, 'authProvider'],
      [
        'bad status',
        { ...baseProps(), status: 'NOT_A_STATUS' as UserStatus },
        'status',
      ],
      ['bad email', { ...baseProps(), email: 'not-an-email' }, 'email'],
      ['empty email', { ...baseProps(), email: '' }, 'email'],
      ['empty displayName', { ...baseProps(), displayName: '' }, 'displayName'],
    ])('rejects %s', (_name, props, field) => {
      expect.assertions(2);
      try {
        User.create(props as never);
      } catch (err) {
        expect(err).toBeInstanceOf(UserValidationError);
        expect((err as UserValidationError).field).toBe(field);
      }
    });

    it('rejects updatedAt earlier than createdAt', () => {
      expect(() =>
        User.create({
          ...baseProps(),
          createdAt: new Date('2026-01-02T00:00:00Z'),
          updatedAt: new Date('2026-01-01T00:00:00Z'),
        }),
      ).toThrow(UserValidationError);
    });

    it('accepts null email and null displayName', () => {
      expect(() =>
        User.create({ ...baseProps(), email: null, displayName: null }),
      ).not.toThrow();
    });
  });

  describe('state transitions', () => {
    it('PROVISIONING -> ACTIVE allowed', () => {
      const u = User.create(baseProps());
      expect(u.canTransitionTo(UserStatus.ACTIVE)).toBe(true);
      u.transitionTo(UserStatus.ACTIVE);
      expect(u.status).toBe(UserStatus.ACTIVE);
    });

    it('ACTIVE -> RECOVERY_PENDING -> ACTIVE allowed', () => {
      const u = User.create({ ...baseProps(), status: UserStatus.ACTIVE });
      u.transitionTo(UserStatus.RECOVERY_PENDING);
      expect(u.status).toBe(UserStatus.RECOVERY_PENDING);
      u.transitionTo(UserStatus.ACTIVE);
      expect(u.status).toBe(UserStatus.ACTIVE);
    });

    it('ACTIVE -> SUSPENDED -> ACTIVE allowed', () => {
      const u = User.create({ ...baseProps(), status: UserStatus.ACTIVE });
      u.transitionTo(UserStatus.SUSPENDED);
      u.transitionTo(UserStatus.ACTIVE);
      expect(u.status).toBe(UserStatus.ACTIVE);
    });

    it('DISABLED is terminal', () => {
      const u = User.create({ ...baseProps(), status: UserStatus.ACTIVE });
      u.transitionTo(UserStatus.DISABLED);
      expect(u.canTransitionTo(UserStatus.ACTIVE)).toBe(false);
      expect(() => u.transitionTo(UserStatus.ACTIVE)).toThrow(
        UserValidationError,
      );
    });

    it('PROVISIONING -> SUSPENDED is illegal', () => {
      const u = User.create(baseProps());
      expect(u.canTransitionTo(UserStatus.SUSPENDED)).toBe(false);
      expect(() => u.transitionTo(UserStatus.SUSPENDED)).toThrow(
        UserValidationError,
      );
    });

    it('updates updatedAt on successful transition', () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const u = User.create(baseProps());
      const before = u.updatedAt.getTime();
      jest.setSystemTime(new Date('2026-01-05T00:00:00Z'));
      u.transitionTo(UserStatus.ACTIVE);
      expect(u.updatedAt.getTime()).toBeGreaterThan(before);
      jest.useRealTimers();
    });
  });

  describe('predicates and helpers', () => {
    it('isActive reflects status', () => {
      const u = User.create({ ...baseProps(), status: UserStatus.ACTIVE });
      expect(u.isActive()).toBe(true);
      u.transitionTo(UserStatus.SUSPENDED);
      expect(u.isActive()).toBe(false);
    });

    it('recordLogin updates lastLoginAt and updatedAt', () => {
      const u = User.create({ ...baseProps(), status: UserStatus.ACTIVE });
      const t = new Date('2026-03-01T12:00:00Z');
      u.recordLogin(t);
      expect(u.lastLoginAt).toBe(t);
      expect(u.updatedAt).toBe(t);
    });

    it('recordLogin rejects non-Date input', () => {
      const u = User.create(baseProps());
      expect(() => u.recordLogin('now' as unknown as Date)).toThrow(
        UserValidationError,
      );
    });
  });
});
