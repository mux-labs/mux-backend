import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiKeyGuard } from '../../api-keys/api-key.guard';
import { ConfigService } from '@nestjs/config';
import {
  CORS_ALLOWED_HEADERS,
  CORS_EXPOSED_HEADERS,
  CORS_MAX_AGE_SECONDS,
  CORS_METHODS,
  parseCorsAllowlist,
} from './cors';

/**
 * Machine-readable view of the effective CORS policy ([#934]).
 *
 * This is the "dashboard" for the allowlist: an operator (or a support engineer
 * debugging a blocked browser request) can confirm exactly which origins are
 * admitted, and — critically — whether any configured entry was **rejected**
 * (a wildcard that would otherwise be silently ignored) or whether the
 * deployment is falling back to the insecure localhost default.
 */
export interface CorsAllowlistReport {
  /** Origins admitted by exact match. */
  origins: string[];
  /** Configured entries that were dropped, with the reason. */
  rejected: Array<{ entry: string; reason: string }>;
  /** True when no `CORS_ORIGINS` was set and the localhost default applies. */
  usingDefault: boolean;
  /** True when the deploy is non-production (used only for display). */
  production: boolean;
  credentials: boolean;
  methods: readonly string[];
  allowedHeaders: readonly string[];
  exposedHeaders: readonly string[];
  maxAgeSeconds: number;
}

/**
 * Read-only, authenticated view of the CORS allowlist.
 *
 * Deny-by-default: guarded by `ApiKeyGuard`, so an anonymous caller cannot
 * enumerate the origin allowlist. It is a configuration surface, not a
 * mutation surface — there is no POST/PUT/DELETE here on purpose, because
 * changing the allowlist is a deployment concern, not an API one.
 *
 * Note the report contains only origin strings and header names. It never
 * includes credentials, cookies, or any other secret.
 */
@ApiTags('cors')
@ApiSecurity('api-key')
@Controller('internal/cors-allowlist')
@UseGuards(ApiKeyGuard)
export class CorsAllowlistController {
  constructor(private readonly config: ConfigService) {}

  @Get()
  @ApiOperation({
    summary: 'Inspect the effective CORS allowlist (authenticated, read-only)',
  })
  getAllowlist(): CorsAllowlistReport {
    const raw = this.config.get<string>('CORS_ORIGINS');
    const configured = raw
      ? raw
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean)
      : [];

    const { allowed, rejected: wildcardRejected } =
      parseCorsAllowlist(configured);

    // Only echo entries that are actually origins. A misconfigured value (a
    // secret pasted into CORS_ORIGINS, a stray flag) is reported as rejected
    // rather than being reflected back through an API response.
    const origins: string[] = [];
    const rejected: Array<{ entry: string; reason: string }> = [
      ...wildcardRejected,
    ];

    for (const entry of allowed) {
      if (!isHttpOrigin(entry)) {
        rejected.push({
          entry,
          reason: 'not an http(s) origin',
        });
        continue;
      }
      origins.push(entry);
    }

    return {
      origins,
      rejected,
      usingDefault: configured.length === 0,
      production: process.env.NODE_ENV === 'production',
      credentials: true,
      methods: CORS_METHODS,
      allowedHeaders: CORS_ALLOWED_HEADERS,
      exposedHeaders: CORS_EXPOSED_HEADERS,
      maxAgeSeconds: CORS_MAX_AGE_SECONDS,
    };
  }
}

/** True when `value` is a bare `http(s)://host[:port]` origin. */
function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      // A CORS origin is scheme+host+port only. Anything with credentials or a
      // path in it is a misconfiguration, not an origin.
      url.username === '' &&
      url.password === '' &&
      (url.pathname === '' || url.pathname === '/') &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}
