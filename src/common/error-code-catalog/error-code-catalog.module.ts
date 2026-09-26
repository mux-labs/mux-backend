import { Module } from '@nestjs/common';
import { ErrorCodeCatalogController } from './error-code-catalog.controller';

/**
 * Serves the frontend-facing error-code catalog (#949).
 *
 * Intentionally dependency-free: the catalog is a static, secret-free module
 * constant, so this module never touches the database, Horizon, or any secret.
 */
@Module({
  controllers: [ErrorCodeCatalogController],
})
export class ErrorCodeCatalogModule {}
