import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { ApiKeyContext } from '../domain/api-key.model';

/**
 * Decorator to extract API key context from request
 *
 * Usage:
 * @Get('my-endpoint')
 * async myEndpoint(@ApiKeyCtx() context: ApiKeyContext) {
 *   console.log(context.developer.email);
 *   console.log(context.project.name);
 * }
 */
export const ApiKeyCtx = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): ApiKeyContext => {
    const request = ctx.switchToHttp().getRequest();
    return request.apiKeyContext;
  },
);
