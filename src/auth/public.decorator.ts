import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'isPublic';

/**
 * Marks a route as reachable without an API key.
 *
 * The global `ApiKeyGuard` is deny-by-default: every route requires a
 * credential unless it carries this metadata. Adding it is a deliberate act
 * and must be justified in review — a public route is part of the attack
 * surface, not a convenience.
 */
export const Public = () => SetMetadata(IS_PUBLIC, true);
