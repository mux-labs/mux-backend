import { BadRequestException, Injectable } from '@nestjs/common';
import { IdempotentUserService } from './idempotent-user.service';
import { ActorContext, RequestContext } from './types';

@Injectable()
export class UsersService {
  constructor(private readonly idempotentUserService: IdempotentUserService) {}

  async findOrCreateUser(
    authId: string,
    actorContext: ActorContext,
    idempotencyKey: string,
    requestContext: RequestContext,
  ) {
    this.assertAuthId(authId);
    return this.idempotentUserService.findOrCreateUser(
      authId,
      actorContext,
      idempotencyKey,
      requestContext,
    );
  }

  async findUserByAuthId(authId: string) {
    this.assertAuthId(authId);
    return this.idempotentUserService.findUserByAuthId(authId);
  }

  private assertAuthId(authId: unknown): asserts authId is string {
    if (typeof authId !== 'string' || authId.trim().length === 0) {
      throw new BadRequestException('authId must be a non-empty string');
    }
  }
}
