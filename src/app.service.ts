import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class AppService {
  private readonly logger = new Logger(AppService.name);
  private readonly startTime: Date;

  constructor() {
    this.startTime = new Date();
  }

  getHello(): string {
    return 'Hello World!';
  }

  /**
   * Check application liveness (process is alive and responsive)
   * This is a lightweight check that doesn't verify external dependencies
   * @returns Object with status and uptime information
   */
  checkHealth(): {
    status: string;
    timestamp: string;
    uptime: number;
    version?: string;
  } {
    const timestamp = new Date().toISOString();
    const uptime = Math.floor((Date.now() - this.startTime.getTime()) / 1000);

    this.logger.debug(`Health check: OK (uptime: ${uptime}s)`);

    return {
      status: 'ok',
      timestamp,
      uptime,
      ...(process.env.npm_package_version && {
        version: process.env.npm_package_version,
      }),
    };
  }
}
