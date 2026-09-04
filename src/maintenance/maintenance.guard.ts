import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import { ALLOW_DURING_MAINTENANCE } from './maintenance.decorator';
import { MaintenanceService } from './maintenance.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class MaintenanceGuard implements CanActivate {
  private readonly logger = new Logger(MaintenanceGuard.name);

  constructor(
    private readonly maintenance: MaintenanceService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(request.method.toUpperCase())) return true;

    const allowed = this.reflector.getAllAndOverride<boolean>(
      ALLOW_DURING_MAINTENANCE,
      [context.getHandler(), context.getClass()],
    );
    if (allowed) return true;

    let status;
    try {
      status = await this.maintenance.getStatus();
    } catch (error) {
      this.logger.error(
        'Unable to read maintenance state; rejecting mutating request',
        error instanceof Error ? error.stack : undefined,
      );
      throw new ServiceUnavailableException(
        'Service is temporarily unavailable',
      );
    }

    if (!status.enabled) return true;

    const response = context.switchToHttp().getResponse<Response>();
    if (status.retryAfterSeconds) {
      response.setHeader('Retry-After', status.retryAfterSeconds.toString());
    }

    throw new ServiceUnavailableException({
      statusCode: 503,
      error: 'Service Unavailable',
      message:
        status.message ||
        'Service is temporarily unavailable for maintenance',
      maintenance: true,
    });
  }
}
