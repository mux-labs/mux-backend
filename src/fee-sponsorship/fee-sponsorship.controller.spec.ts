import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { FeeSponsorshipController } from './fee-sponsorship.controller';
import { FeeSponsorshipService } from './fee-sponsorship.service';
import { FeeSponsorshipErrorCode } from './fee-sponsorship-error-codes';

describe('FeeSponsorshipController.extractActor', () => {
  let controller: FeeSponsorshipController;

  beforeEach(() => {
    const service = {} as unknown as FeeSponsorshipService;
    controller = new FeeSponsorshipController(service);
  });

  const extractActor = (
    req: Partial<Request>,
    idempotencyKey?: string,
  ) =>
    (
      controller as unknown as {
        extractActor: (
          req: Request,
          idempotencyKey?: string,
        ) => { subjectId: string; role: string; correlationId?: string };
      }
    ).extractActor(req as Request, idempotencyKey);

  it('derives the actor subject from the authenticated API key developer', () => {
    const req = {
      apiKeyContext: { developerId: 'dev-123' },
    } as unknown as Partial<Request>;

    const actor = extractActor(req, 'idem-1');

    expect(actor.subjectId).toBe('dev-123');
    expect(actor.role).toBe('owner');
    expect(actor.correlationId).toBe('idem-1');
  });

  it('does not trust client-supplied body or query identity fields', () => {
    const req = {
      apiKeyContext: { developerId: 'dev-123' },
      body: { developerId: 'attacker', subjectId: 'attacker' },
      query: { developerId: 'attacker', subjectId: 'attacker' },
    } as unknown as Partial<Request>;

    const actor = extractActor(req);

    expect(actor.subjectId).toBe('dev-123');
    expect(actor.subjectId).not.toBe('attacker');
  });

  it('rejects requests with no resolvable developer instead of using a placeholder', () => {
    const req = {} as unknown as Partial<Request>;

    expect(() => extractActor(req)).toThrow(UnauthorizedException);
    try {
      extractActor(req);
    } catch (err) {
      const response = (err as UnauthorizedException).getResponse() as {
        code: string;
      };
      expect(response.code).toBe(FeeSponsorshipErrorCode.UNATTRIBUTED_ACTOR);
    }
  });

  it('rejects requests whose developer id is empty or non-string', () => {
    const emptyReq = {
      apiKeyContext: { developerId: '' },
    } as unknown as Partial<Request>;
    const nonStringReq = {
      apiKeyContext: { developerId: 42 },
    } as unknown as Partial<Request>;

    expect(() => extractActor(emptyReq)).toThrow(UnauthorizedException);
    expect(() => extractActor(nonStringReq)).toThrow(UnauthorizedException);
  });
});
