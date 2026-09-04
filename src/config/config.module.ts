import { Module, Global } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { validateEnv } from './env.validation';

/**
 * Centralized validated environment configuration module.
 *
 * This module consolidates environment validation into a single place,
 * ensuring all required env vars are validated at startup and made
 * available via NestJS's ConfigService throughout the application.
 *
 * Usage:
 *   Import ConfigModule in your feature modules and inject ConfigService.
 */
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: (config: Record<string, unknown>) => {
        // Use the comprehensive validation from env.validation.ts
        // which provides detailed error messages and exits with helpful
        // diagnostics on missing/invalid variables.
        const envMap: Record<string, string | undefined> = {};
        for (const [key, value] of Object.entries(config)) {
          envMap[key] = typeof value === 'string' ? value : String(value ?? '');
        }
        const validated = validateEnv(envMap as NodeJS.ProcessEnv);
        return validated;
      },
    }),
  ],
  exports: [NestConfigModule],
})
export class ConfigModule {}
