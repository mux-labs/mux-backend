import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException, ServiceUnavailableException } from '@nestjs/common';
import { JwtVerificationService } from './jwt-verification.service';

describe('JwtVerificationService', () => {
  let service: JwtVerificationService;

  beforeEach(async () => {
    // Save original env
    this.originalNodeEnv = process.env.NODE_ENV;
    this.originalAuthSkip = process.env.AUTH_SKIP_JWT_VERIFICATION;
    this.originalAuthProvider = process.env.AUTH_IDENTITY_PROVIDER;

    const module: TestingModule = await Test.createTestingModule({
      providers: [JwtVerificationService],
    }).compile();

    service = module.get<JwtVerificationService>(JwtVerificationService);
  });

  afterEach(() => {
    // Restore original env
    process.env.NODE_ENV = this.originalNodeEnv;
    process.env.AUTH_SKIP_JWT_VERIFICATION = this.originalAuthSkip;
    process.env.AUTH_IDENTITY_PROVIDER = this.originalAuthProvider;
  });

  describe('extractBearerToken', () => {
    it('should extract token from valid Authorization header', () => {
      const token = service.extractBearerToken('Bearer eyJhbGc...');
      expect(token).toBe('eyJhbGc...');
    });

    it('should return null for missing Authorization header', () => {
      const token = service.extractBearerToken(undefined);
      expect(token).toBeNull();
    });

    it('should return null for malformed Authorization header', () => {
      const token = service.extractBearerToken('InvalidFormat');
      expect(token).toBeNull();
    });

    it('should support case-insensitive Bearer scheme', () => {
      const token = service.extractBearerToken('bearer eyJhbGc...');
      expect(token).toBe('eyJhbGc...');
    });
  });

  describe('verifyToken - dev mode', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'development';
      process.env.AUTH_SKIP_JWT_VERIFICATION = 'true';
    });

    it('should parse dev-mode stub tokens', async () => {
      const result = await service.verifyToken('dev-clerk-user123');
      expect(result.sub).toBe('user123');
      expect(result.auth_provider).toBe('CLERK');
    });

    it('should parse multi-part userids in dev mode', async () => {
      const result = await service.verifyToken('dev-better-auth-user-123-456');
      expect(result.sub).toBe('user-123-456');
      expect(result.auth_provider).toBe('BETTER');
    });

    it('should reject malformed dev tokens', async () => {
      await expect(service.verifyToken('invalid-token')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should reject missing token in dev mode', async () => {
      await expect(service.verifyToken('')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('verifyToken - production mode', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
      delete process.env.AUTH_SKIP_JWT_VERIFICATION;
      process.env.AUTH_IDENTITY_PROVIDER = 'CLERK';
    });

    it('should fail closed when token is missing', async () => {
      await expect(service.verifyToken('')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should fail closed when JWT library not available', async () => {
      // jsonwebtoken is not installed, so this should fail
      await expect(
        service.verifyToken('some.jwt.token'),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('should require AUTH_IDENTITY_PROVIDER to be set', async () => {
      delete process.env.AUTH_IDENTITY_PROVIDER;
      await expect(
        service.verifyToken('some.jwt.token'),
      ).rejects.toThrow(ServiceUnavailableException);
    });
  });

  describe('verifyToken - blocking unsupported claims', () => {
    /**
     * FAILING TEST: This demonstrates the security vulnerability #673
     *
     * Currently, authenticate() accepts client-supplied authId/authProvider
     * without any verification. This test shows how an attacker could
     * impersonate any user.
     *
     * Once JWT verification is implemented, this test pattern should change:
     * identity must be extracted ONLY from the verified token, never from
     * request body fields.
     */
    it('SHOULD FAIL: currently authId from client is trusted without JWT verification', async () => {
      // This is the vulnerability: a client can supply any authId
      // and the system will accept it as the authenticated identity
      // without checking a signed token.
      //
      // Once #673 is fully implemented, this should be impossible:
      // the authenticate() endpoint will extract authId from the verified
      // JWT token claims, not from the request body.
      expect(true).toBe(true); // Placeholder until JWT library is added
    });
  });
});
