import { Test } from '@nestjs/testing';
import { BadRequestException, Logger } from '@nestjs/common';

import {
  AuthOrchestratorService,
  AuthPayloadValidator,
} from './auth-orchestrator.service';

describe('AuthPayloadValidator.validate', () => {
  it('rejects a missing authId', () => {
    expect(() =>
      AuthPayloadValidator.validate({ authProvider: 'CLERK' } as any),
    ).toThrow(BadRequestException);
  });

  it('rejects a null authId', () => {
    expect(() =>
      AuthPayloadValidator.validate({ authId: null, authProvider: 'CLERK' } as any),
    ).toThrow(BadRequestException);
  });

  it('rejects a non-string authId object', () => {
    expect(() =>
      AuthPayloadValidator.validate({ authId: { $ne: null }, authProvider: 'CLERK' } as any),
    ).toThrow(BadRequestException);
  });

  it('rejects a non-string authId number', () => {
    expect(() =>
      AuthPayloadValidator.validate({ authId: 12345, authProvider: 'CLERK' } as any),
    ).toThrow(BadRequestException);
  });

  it('rejects a whitespace-only authId', () => {
    expect(() =>
      AuthPayloadValidator.validate({ authId: '   ', authProvider: 'CLERK' } as any),
    ).toThrow(BadRequestException);
  });

  it('accepts a valid string authId', () => {
    expect(() =>
      AuthPayloadValidator.validate({ authId: 'user_abc', authProvider: 'CLERK' } as any),
    ).not.toThrow();
  });
});

describe('AuthOrchestratorService', () => {
  let service: AuthOrchestratorService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [AuthOrchestratorService],
    }).compile();

    service = moduleRef.get(AuthOrchestratorService);
  });

  describe('validatePayload', () => {
    it('returns false for rejected payloads', () => {
      expect(service.validatePayload({ authId: { $ne: null }, authProvider: 'CLERK' } as any)).toBe(false);
      expect(service.validatePayload({ authId: '   ', authProvider: 'CLERK' } as any)).toBe(false);
      expect(service.validatePayload({ authId: 12345, authProvider: 'CLERK' } as any)).toBe(false);
    });

    it('returns true for a valid payload', () => {
      expect(service.validatePayload({ authId: 'user_abc', authProvider: 'CLERK' } as any)).toBe(true);
    });

    it('returns true for a valid authProvider', () => {
      const result = service.validatePayload({
        authProvider: 'google',
        authId: 'auth-id-123',
        email: 'user@example.com',
        displayName: 'Test User',
      });

      expect(result).toBe(true);
    });

    it('returns false for an invalid authProvider', () => {
      const result = service.validatePayload({
        authProvider: 'not-a-real-provider',
        authId: 'auth-id-123',
        email: 'user@example.com',
        displayName: 'Test User',
      });

      expect(result).toBe(false);
    });

    it('logs a bounded rejection without leaking authId or email', () => {
      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      const authId = 'sensitive-auth-id-abc';
      const email = 'sensitive-user@example.com';

      const result = service.validatePayload({
        authProvider: 'not-a-real-provider',
        authId,
        email,
        displayName: 'Sensitive User',
      });

      expect(result).toBe(false);
      expect(warnSpy).toHaveBeenCalled();

      const serializedArgs = JSON.stringify(warnSpy.mock.calls);
      expect(serializedArgs).not.toContain(authId);
      expect(serializedArgs).not.toContain(email);

      const [, context] = warnSpy.mock.calls[0];
      expect(JSON.stringify(context)).toMatch(/error/i);

      warnSpy.mockRestore();
    });
  });
});
