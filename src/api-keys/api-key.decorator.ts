import { SetMetadata } from '@nestjs/common';

/**
 * Decorator to mark a route or controller as public (no API key required).
 * Usage: @Public() or @Public(true)
 */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Decorator to explicitly require or not require an API key.
 * Usage: @RequireApiKey() or @RequireApiKey(false)
 */
export const REQUIRE_API_KEY_KEY = 'requireApiKey';
export const RequireApiKey = (require: boolean = true) => SetMetadata(REQUIRE_API_KEY_KEY, require);