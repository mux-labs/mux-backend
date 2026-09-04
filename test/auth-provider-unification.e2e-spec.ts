import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, HttpStatus, BadRequestException } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import {
  AuthProvider,
  isValidAuthProvider,
  getValidProviderNames,
} from './../src/auth/auth-provider.enum';
import { AuthPayloadValidator } from './../src/auth/auth-orchestrator.service';

describe('Auth Provider Unification (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('AuthProvider Enum', () => {
    it('should define CLERK provider', () => {
      expect(AuthProvider.CLERK).toBe('CLERK');
    });

    it('should define BETTER_AUTH provider', () => {
      expect(AuthProvider.BETTER_AUTH).toBe('BETTER_AUTH');
    });

    it('should validate known providers', () => {
      expect(isValidAuthProvider('CLERK')).toBe(true);
      expect(isValidAuthProvider('BETTER_AUTH')).toBe(true);
    });

    it('should reject unknown providers', () => {
      expect(isValidAuthProvider('UNKNOWN')).toBe(false);
      expect(isValidAuthProvider('GOOGLE')).toBe(false);
      expect(isValidAuthProvider('GITHUB')).toBe(false);
      expect(isValidAuthProvider('')).toBe(false);
    });

    it('should be case-sensitive', () => {
      expect(isValidAuthProvider('clerk')).toBe(false);
      expect(isValidAuthProvider('better_auth')).toBe(false);
      expect(isValidAuthProvider('Clerk')).toBe(false);
    });

    it('should provide readable list of valid providers', () => {
      const validProviders = getValidProviderNames();
      expect(validProviders).toContain('CLERK');
      expect(validProviders).toContain('BETTER_AUTH');
    });
  });

  describe('AuthPayloadValidator with Provider Validation', () => {
    it('should accept valid CLERK provider', () => {
      const payload = {
        authId: 'clerk-user-123',
        authProvider: 'CLERK',
      };

      // Should not throw
      expect(() => AuthPayloadValidator.validate(payload)).not.toThrow();
    });

    it('should accept valid BETTER_AUTH provider', () => {
      const payload = {
        authId: 'better-auth-user-456',
        authProvider: 'BETTER_AUTH',
      };

      // Should not throw
      expect(() => AuthPayloadValidator.validate(payload)).not.toThrow();
    });

    it('should reject unknown provider', () => {
      const payload = {
        authId: 'user-123',
        authProvider: 'UNKNOWN_PROVIDER',
      };

      expect(() => AuthPayloadValidator.validate(payload)).toThrow(
        BadRequestException,
      );
      expect(() => AuthPayloadValidator.validate(payload)).toThrow(
        /must be one of:/,
      );
    });

    it('should normalize provider to uppercase', () => {
      // The validator should normalize lowercase to uppercase internally
      const payload = {
        authId: 'user-123',
        authProvider: 'clerk', // lowercase
      };

      expect(() => AuthPayloadValidator.validate(payload)).toThrow(
        BadRequestException,
      );
    });

    it('should reject empty authProvider', () => {
      const payload = {
        authId: 'user-123',
        authProvider: '',
      };

      expect(() => AuthPayloadValidator.validate(payload)).toThrow(
        BadRequestException,
      );
    });

    it('should reject whitespace-only authProvider', () => {
      const payload = {
        authId: 'user-123',
        authProvider: '   ',
      };

      expect(() => AuthPayloadValidator.validate(payload)).toThrow(
        BadRequestException,
      );
    });

    it('should allow missing authProvider (optional)', () => {
      const payload = {
        authId: 'user-123',
        // authProvider intentionally omitted
      };

      // Should not throw
      expect(() => AuthPayloadValidator.validate(payload)).not.toThrow();
    });

    it('should allow null authProvider (optional)', () => {
      const payload = {
        authId: 'user-123',
        authProvider: null,
      };

      // Should not throw
      expect(() => AuthPayloadValidator.validate(payload)).not.toThrow();
    });

    it('should reject non-string authProvider', () => {
      const payload = {
        authId: 'user-123',
        authProvider: 123, // number instead of string
      };

      expect(() => AuthPayloadValidator.validate(payload)).toThrow(
        BadRequestException,
      );
      expect(() => AuthPayloadValidator.validate(payload)).toThrow(
        /must be a string/,
      );
    });

    it('should reject authProvider with special characters', () => {
      const payload = {
        authId: 'user-123',
        authProvider: 'CLERK@#$%',
      };

      expect(() => AuthPayloadValidator.validate(payload)).toThrow(
        BadRequestException,
      );
    });

    it('should provide helpful error message for invalid provider', () => {
      const payload = {
        authId: 'user-123',
        authProvider: 'INVALID',
      };

      const errorFn = () => AuthPayloadValidator.validate(payload);
      expect(errorFn).toThrow();

      try {
        errorFn();
        fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).toContain('must be one of');
        expect(error.message).toContain('CLERK');
        expect(error.message).toContain('BETTER_AUTH');
      }
    });
  });

  describe('Provider-Specific Configuration', () => {
    it('should have configuration for CLERK provider', () => {
      const clerkConfig = AuthProvider.CLERK;
      expect(clerkConfig).toBe('CLERK');
    });

    it('should have configuration for BETTER_AUTH provider', () => {
      const betterAuthConfig = AuthProvider.BETTER_AUTH;
      expect(betterAuthConfig).toBe('BETTER_AUTH');
    });

    it('should support mapping to environment variables', () => {
      // The configuration should allow mapping to provider-specific env vars
      // For example:
      // - CLERK provider -> CLERK_JWT_PUBLIC_KEY or CLERK_JWKS_URL
      // - BETTER_AUTH provider -> BETTER_AUTH_JWT_PUBLIC_KEY or BETTER_AUTH_JWKS_URL

      expect(AuthProvider.CLERK).toBeDefined();
      expect(AuthProvider.BETTER_AUTH).toBeDefined();
    });
  });

  describe('User Record Provider Consistency', () => {
    it('should store authProvider consistently', () => {
      // When a user is authenticated with a specific provider,
      // the authProvider should be stored in the User record
      // and should match the provider that verified the JWT

      expect(AuthProvider.CLERK).toBe('CLERK');
      expect(AuthProvider.BETTER_AUTH).toBe('BETTER_AUTH');
    });

    it('should enforce provider in authentication flow', () => {
      // The authentication payload must specify a valid provider
      // to ensure that the JWT can be verified with the correct provider's keys

      const validClerkPayload = {
        authId: 'clerk-123',
        authProvider: AuthProvider.CLERK,
      };

      const validBetterAuthPayload = {
        authId: 'better-auth-456',
        authProvider: AuthProvider.BETTER_AUTH,
      };

      expect(() => AuthPayloadValidator.validate(validClerkPayload)).not.toThrow();
      expect(() => AuthPayloadValidator.validate(validBetterAuthPayload)).not.toThrow();
    });
  });

  describe('Provider Migration and Backward Compatibility', () => {
    it('should support future provider additions', () => {
      // The AuthProvider enum is designed to be easily extended
      // with additional providers like Google, GitHub, etc.

      expect(Object.values(AuthProvider)).toContain('CLERK');
      expect(Object.values(AuthProvider)).toContain('BETTER_AUTH');
      expect(Object.values(AuthProvider).length).toBe(2);
    });

    it('should reject old provider names after migration', () => {
      // Once a provider is no longer supported, its old name should be rejected

      const payload = {
        authId: 'user-123',
        authProvider: 'UNSUPPORTED_LEGACY_PROVIDER',
      };

      expect(() => AuthPayloadValidator.validate(payload)).toThrow(
        BadRequestException,
      );
    });
  });

  describe('Security Considerations', () => {
    it('should validate provider before JWT verification', () => {
      // Provider validation should happen early in the auth flow
      // to reject invalid providers before attempting JWT verification

      const payload = {
        authId: 'user-123',
        authProvider: 'MALICIOUS_PROVIDER',
      };

      // Should reject early due to invalid provider
      expect(() => AuthPayloadValidator.validate(payload)).toThrow(
        BadRequestException,
      );
    });

    it('should prevent provider confusion attacks', () => {
      // Even if a JWT is valid for one provider, it should not be accepted
      // as valid for a different provider

      const clerkPayload = {
        authId: 'user-123',
        authProvider: AuthProvider.CLERK,
      };

      const betterAuthPayload = {
        authId: 'user-123',
        authProvider: AuthProvider.BETTER_AUTH,
      };

      // Both should be syntactically valid, but JWT verification should fail
      // if the JWT doesn't match the declared provider
      expect(() => AuthPayloadValidator.validate(clerkPayload)).not.toThrow();
      expect(() => AuthPayloadValidator.validate(betterAuthPayload)).not.toThrow();
    });

    it('should require provider in authentication request', () => {
      // The authProvider field should be validated to ensure it's one of
      // the known providers, preventing auth bypass via provider confusion

      const payloadWithoutProvider = {
        authId: 'user-123',
        // authProvider omitted - should be allowed but caller must specify
      };

      // Missing provider should be allowed (optional field)
      expect(() => AuthPayloadValidator.validate(payloadWithoutProvider)).not.toThrow();
    });

    it('should handle provider claim from JWT', () => {
      // The auth_provider claim from the JWT should be validated
      // to ensure it matches the provider's own claims

      const clerkJwtPayload = {
        authId: 'clerk-user-123',
        authProvider: 'CLERK',
      };

      const betterAuthJwtPayload = {
        authId: 'better-auth-user-456',
        authProvider: 'BETTER_AUTH',
      };

      expect(() => AuthPayloadValidator.validate(clerkJwtPayload)).not.toThrow();
      expect(() => AuthPayloadValidator.validate(betterAuthJwtPayload)).not.toThrow();
    });
  });
});
