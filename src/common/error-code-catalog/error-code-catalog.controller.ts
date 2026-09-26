import { Controller, Get, Header } from '@nestjs/common';
import {
  buildErrorCodeCatalogResponse,
  type ErrorCodeCatalogResponse,
} from '../dto/error-code-catalog';

/**
 * Public error-code catalog (`GET /v1/error-codes`) — see issue #949.
 *
 * Frontends and SDKs need to branch on the stable `errorCode` the API returns,
 * but hard-coding the list drifts. This endpoint serves the catalog in
 * machine-readable form so a client can fetch/generate its own constants.
 *
 * Security posture:
 * - **Read-only and static.** No parameters, no database, no upstream calls,
 *   so there is no injection or amplification surface.
 * - **No secrets.** The catalog contains codes, HTTP statuses, categories and
 *   client-safe messages only — never key material, tokens, or webhook secrets.
 * - **Public by design.** It is allowlisted as a public endpoint (like
 *   `/health`) because it exposes nothing tenant-specific; every other route
 *   remains deny-by-default.
 * - **Cacheable.** Responses are stable across deploys, so they are marked
 *   cacheable to keep the endpoint off the hot path.
 */
@Controller('error-codes')
export class ErrorCodeCatalogController {
  /** GET /v1/error-codes — the full, stable error-code catalog. */
  @Get()
  @Header('Cache-Control', 'public, max-age=300')
  getCatalog(): ErrorCodeCatalogResponse {
    return buildErrorCodeCatalogResponse();
  }
}
