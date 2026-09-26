import { Module } from '@nestjs/common';
import { CorsAllowlistController } from './cors-dashboard.controller';

/**
 * Exposes the effective CORS allowlist to authenticated operators ([#934]).
 *
 * Kept in its own module so the read-only introspection surface is explicit in
 * the app graph rather than being tucked into a feature module.
 */
@Module({
  controllers: [CorsAllowlistController],
})
export class CorsModule {}
