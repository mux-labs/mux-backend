import { SetMetadata } from '@nestjs/common';
import { REQUIRE_API_KEY } from '../api-key.guard';

/**
 * Decorator to mark routes as requiring API key authentication
 *
 * Usage:
 * @RequireApiKey()
 * @Get('protected-endpoint')
 * async protectedRoute() { ... }
 */
export const RequireApiKey = () => SetMetadata(REQUIRE_API_KEY, true);
