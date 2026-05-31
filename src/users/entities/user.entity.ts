/**
 * Internal lifecycle states for a domain user.
 *
 * Kept independent of any auth provider's notion of "user state". These
 * states drive recovery, suspension, and access-control logic across the
 * platform.
 */
export enum UserStatus {
  /** Created but not yet usable (e.g. awaiting first wallet provisioning). */
  PROVISIONING = 'PROVISIONING',
  /** Fully operational; the default for healthy accounts. */
  ACTIVE = 'ACTIVE',
  /** Account is undergoing recovery (e.g. lost device, wallet rotation). */
  RECOVERY_PENDING = 'RECOVERY_PENDING',
  /** Operationally paused (e.g. risk hold). Reversible. */
  SUSPENDED = 'SUSPENDED',
  /** Permanently disabled. No further use. */
  DISABLED = 'DISABLED',
}

/**
 * Allowed state transitions. Anything not listed is rejected.
 * DISABLED is terminal.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<UserStatus, readonly UserStatus[]>> =
  {
    [UserStatus.PROVISIONING]: [UserStatus.ACTIVE, UserStatus.DISABLED],
    [UserStatus.ACTIVE]: [
      UserStatus.RECOVERY_PENDING,
      UserStatus.SUSPENDED,
      UserStatus.DISABLED,
    ],
    [UserStatus.RECOVERY_PENDING]: [
      UserStatus.ACTIVE,
      UserStatus.SUSPENDED,
      UserStatus.DISABLED,
    ],
    [UserStatus.SUSPENDED]: [UserStatus.ACTIVE, UserStatus.DISABLED],
    [UserStatus.DISABLED]: [],
  };

export interface UserProps {
  id: string;
  authId: string;
  authProvider: string;
  status?: UserStatus;
  email?: string | null;
  displayName?: string | null;
  lastLoginAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export class UserValidationError extends Error {
  constructor(
    message: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'UserValidationError';
  }
}

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_AUTH_ID_LENGTH = 256;
const MAX_DISPLAY_NAME_LENGTH = 128;
const MAX_EMAIL_LENGTH = 320;
const MAX_AUTH_PROVIDER_LENGTH = 64;

/**
 * Domain-level user.
 *
 * This is the platform's stable internal representation of a person, decoupled
 * from any specific authentication provider (Clerk, Auth0, Firebase, etc.).
 * Persistence shape and provider integration live elsewhere — this class only
 * encodes invariants and lifecycle rules.
 */
export class User {
  readonly id: string;
  readonly authId: string;
  readonly authProvider: string;
  status: UserStatus;
  email: string | null;
  displayName: string | null;
  lastLoginAt: Date | null;
  readonly createdAt: Date;
  updatedAt: Date;

  private constructor(props: Required<UserProps>) {
    this.id = props.id;
    this.authId = props.authId;
    this.authProvider = props.authProvider;
    this.status = props.status;
    this.email = props.email;
    this.displayName = props.displayName;
    this.lastLoginAt = props.lastLoginAt;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  /**
   * Build and validate a User. Throws {@link UserValidationError} on invalid
   * input. Use this rather than `new User(...)` so invariants are always
   * checked.
   */
  static create(props: UserProps): User {
    const now = new Date();
    const normalized: Required<UserProps> = {
      id: props.id,
      authId: props.authId,
      authProvider: props.authProvider,
      status: props.status ?? UserStatus.PROVISIONING,
      email: props.email ?? null,
      displayName: props.displayName ?? null,
      lastLoginAt: props.lastLoginAt ?? null,
      createdAt: props.createdAt ?? now,
      updatedAt: props.updatedAt ?? now,
    };

    User.validate(normalized);
    return new User(normalized);
  }

  /**
   * Validate user state. Returns void on success, throws
   * {@link UserValidationError} on failure.
   */
  static validate(props: Required<UserProps>): void {
    if (
      typeof props.id !== 'string' ||
      props.id.length === 0 ||
      !ID_PATTERN.test(props.id)
    ) {
      throw new UserValidationError('id must be a non-empty token', 'id');
    }

    if (
      typeof props.authId !== 'string' ||
      props.authId.length === 0 ||
      props.authId.length > MAX_AUTH_ID_LENGTH
    ) {
      throw new UserValidationError(
        `authId must be a non-empty string up to ${MAX_AUTH_ID_LENGTH} chars`,
        'authId',
      );
    }

    if (
      typeof props.authProvider !== 'string' ||
      props.authProvider.length === 0 ||
      props.authProvider.length > MAX_AUTH_PROVIDER_LENGTH
    ) {
      throw new UserValidationError(
        `authProvider must be a non-empty string up to ${MAX_AUTH_PROVIDER_LENGTH} chars`,
        'authProvider',
      );
    }

    if (!Object.values(UserStatus).includes(props.status)) {
      throw new UserValidationError(
        `status must be one of ${Object.values(UserStatus).join(', ')}`,
        'status',
      );
    }

    if (props.email !== null) {
      if (
        typeof props.email !== 'string' ||
        props.email.length === 0 ||
        props.email.length > MAX_EMAIL_LENGTH ||
        !EMAIL_PATTERN.test(props.email)
      ) {
        throw new UserValidationError(
          'email must be a valid address or null',
          'email',
        );
      }
    }

    if (props.displayName !== null) {
      if (
        typeof props.displayName !== 'string' ||
        props.displayName.length === 0 ||
        props.displayName.length > MAX_DISPLAY_NAME_LENGTH
      ) {
        throw new UserValidationError(
          `displayName must be a non-empty string up to ${MAX_DISPLAY_NAME_LENGTH} chars, or null`,
          'displayName',
        );
      }
    }

    if (props.lastLoginAt !== null && !(props.lastLoginAt instanceof Date)) {
      throw new UserValidationError(
        'lastLoginAt must be a Date or null',
        'lastLoginAt',
      );
    }

    if (
      !(props.createdAt instanceof Date) ||
      !(props.updatedAt instanceof Date)
    ) {
      throw new UserValidationError(
        'createdAt and updatedAt must be Date instances',
        'timestamps',
      );
    }

    if (props.updatedAt.getTime() < props.createdAt.getTime()) {
      throw new UserValidationError(
        'updatedAt cannot precede createdAt',
        'timestamps',
      );
    }
  }

  /** Returns true iff transitioning from current status to `next` is allowed. */
  canTransitionTo(next: UserStatus): boolean {
    return ALLOWED_TRANSITIONS[this.status].includes(next);
  }

  /**
   * Move the user to a new status. Throws {@link UserValidationError} if the
   * transition is not allowed. Updates `updatedAt`.
   */
  transitionTo(next: UserStatus): void {
    if (!this.canTransitionTo(next)) {
      throw new UserValidationError(
        `illegal transition: ${this.status} -> ${next}`,
        'status',
      );
    }
    this.status = next;
    this.updatedAt = new Date();
  }

  /** Convenience predicate: account is currently usable for signing/custody. */
  isActive(): boolean {
    return this.status === UserStatus.ACTIVE;
  }

  /** Record a successful login. Updates `lastLoginAt` and `updatedAt`. */
  recordLogin(at: Date = new Date()): void {
    if (!(at instanceof Date)) {
      throw new UserValidationError('login timestamp must be a Date', 'at');
    }
    this.lastLoginAt = at;
    this.updatedAt = at;
  }
}
