import { RequestHandler } from 'express';

/**
 * Baseline security response headers ([#935]).
 *
 * The API serves JSON to browsers (the dashboard calls it cross-origin) and to
 * server-to-server clients. Without an explicit baseline, Express advertises
 * itself via `X-Powered-By`, allows MIME-sniffing of responses, permits
 * framing (clickjacking), and leaks the full referring URL. On a surface that
 * handles custody keys and signed transactions, "we'll add headers later" is a
 * gap, not a backlog item.
 *
 * ## Header choices
 *
 * - `X-Content-Type-Options: nosniff` — stops a browser second-guessing our
 *   `Content-Type`, which is the precondition for content-type confusion.
 * - `X-Frame-Options: DENY` — this is a JSON API, never something a user should
 *   interact with inside a frame. Clickjacking an approval dialog is a real
 *   threat on a wallet-approval flow.
 * - `Referrer-Policy: no-referrer` — request URLs carry `userId` and wallet ids
 *   in the query string. A full referrer would hand those to any third party.
 * - `Cross-Origin-Resource-Policy: same-site` — a wallet API's responses must
 *   not be readable cross-site.
 * - `X-DNS-Prefetch-Control: off` — no speculative DNS for a JSON API.
 * - `Permissions-Policy` — deny every browser capability we do not use. The
 *   explicit allowlist (rather than `*`) means adding a browser feature later
 *   is a deliberate act.
 * - `X-Powered-By` removed — no reason to advertise the framework.
 *
 * ## HSTS is deliberately omitted here
 *
 * `Strict-Transport-Security` is only honoured over HTTPS, and the backend
 * frequently terminates TLS at a proxy or runs on plain HTTP in local/test.
 * Emitting it unconditionally would pin a developer's browser to HTTPS for
 * `localhost` and break local work. It is therefore opt-in via
 * `SECURITY_HEADERS_HSTS=true`, which deployments behind TLS should set. See
 * `README.md` § Security headers.
 *
 * ## CSP
 *
 * No `Content-Security-Policy` is set. CSP governs documents, and this service
 * returns JSON only — adding one here would be a no-op that implies protection
 * that does not exist. Any HTML surface (the dashboard) is a different app and
 * must set its own CSP.
 */

/** True when the deployment opts in to HSTS (TLS-terminating deployments). */
export function isHstsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.SECURITY_HEADERS_HSTS?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * The baseline header set. Exported so tests and the README can assert the
 * exact contract rather than re-deriving it.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-site',
  'X-DNS-Prefetch-Control': 'off',
  'Permissions-Policy':
    'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
};

/**
 * Headers that must be *removed* rather than set to a value.
 *
 * Express sets `X-Powered-By` by default. Assigning `''` does not remove it —
 * it ships the header name with an empty value — so it has to be deleted
 * outright.
 */
const REMOVED_HEADERS: readonly string[] = ['X-Powered-By'];

/**
 * Builds the middleware that applies the baseline headers to every response.
 *
 * Applied in `main.ts` **before** any route so that even error responses and
 * unmatched paths carry the headers — a 404 that leaks the framework banner is
 * still information disclosure.
 */
export function securityHeaders(
  env: NodeJS.ProcessEnv = process.env,
): RequestHandler {
  const headers: Record<string, string> = { ...SECURITY_HEADERS };

  if (isHstsEnabled(env)) {
    headers['Strict-Transport-Security'] =
      'max-age=31536000; includeSubDomains';
  }

  return (req, res, next): void => {
    for (const [name, value] of Object.entries(headers)) {
      res.setHeader(name, value);
    }
    for (const name of REMOVED_HEADERS) {
      res.removeHeader(name);
    }
    next();
  };
}
