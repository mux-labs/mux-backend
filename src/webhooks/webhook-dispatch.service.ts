import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as https from 'https';
import { WebhookSignerService } from './webhook-signer.service';
import { MetricsService } from '../common/metrics/metrics.service';
import { createRequestIdAwareAxios } from '../common/http/request-id-axios';
import {
  WebhookUrlAllowlistService,
  WebhookUrlErrorCode,
} from './webhook-url-allowlist.service';
import { AxiosError } from 'axios';

/**
 * Counter incremented whenever the SSRF allowlist refuses a delivery.
 *
 * A spike means either a legitimate host missing from the allowlist or an
 * active SSRF attempt. See docs/webhook-ssrf-allowlist.md.
 */
export const WEBHOOK_SSRF_BLOCKED_METRIC =
  'webhook_delivery_blocked_by_ssrf_allowlist';

export interface WebhookMtlsConfig {
  /** PEM-encoded client certificate */
  cert: string;
  /** PEM-encoded client private key */
  key: string;
  /** Optional PEM-encoded CA certificate to verify the server */
  ca?: string;
}

export interface WebhookDispatchResult {
  success: boolean;
  responseTime: number;
  responseStatus?: number;
  responseBody?: string;
  errorMessage?: string;
}

/**
 * Webhook Dispatch Service
 *
 * Responsible only for:
 * - Building the webhook payload
 * - Signing the payload
 * - Making the outbound HTTP call (with optional mTLS)
 *
 * mTLS is opt-in per delivery: pass a {@link WebhookMtlsConfig} to enable
 * mutual TLS for endpoints that require client certificate authentication.
 * Cert/key material is never written to logs.
 */
@Injectable()
export class WebhookDispatchService {
  private readonly logger = new Logger(WebhookDispatchService.name);
  private readonly requestTimeoutMs: number;
  private readonly http = createRequestIdAwareAxios();

  constructor(
    private readonly webhookSigner: WebhookSignerService,
    private readonly configService: ConfigService,
    private readonly metrics: MetricsService,
    private readonly urlAllowlist: WebhookUrlAllowlistService,
  ) {
    this.requestTimeoutMs = this.configService.get<number>(
      'WEBHOOK_TIMEOUT_MS',
      10000,
    );
  }

  /**
   * Attempts to deliver a webhook payload to an endpoint.
   *
   * @param url        Target endpoint URL
   * @param payload    JSON-serialisable body
   * @param eventType  Webhook event type string (e.g. "wallet.created")
   * @param eventId    Unique event identifier
   * @param secret     HMAC signing secret
   * @param mtls       Optional mTLS client certificate configuration.
   *                   When provided, a dedicated HTTPS agent presenting the
   *                   client cert is attached to this request only.
   *                   The cert and key values are never logged.
   */
  async deliverWebhook(
    url: string,
    payload: unknown,
    eventType: string,
    eventId: string,
    secret: string,
    mtls?: WebhookMtlsConfig,
  ): Promise<WebhookDispatchResult> {
    const startTime = Date.now();

    // Defense in depth for the write boundary (#960). Endpoints persisted
    // before this control existed — or written straight to the DB — must not
    // be dialable either, so the target is re-validated immediately before the
    // socket would open. Terminal by design: a retry re-attempts the same
    // forbidden connection.
    const denial = this.assertDeliverable(url);
    if (denial) {
      this.logger.warn(
        `Rejected webhook URL host=${denial.host} code=${denial.code}`,
      );
      this.metrics.incrementCounter(WEBHOOK_SSRF_BLOCKED_METRIC);
      return {
        success: false,
        responseTime: Date.now() - startTime,
        // Code + host only. Never the full URL (a query string can carry a
        // token) and never the signing secret.
        errorMessage: `Webhook delivery blocked by SSRF allowlist (${denial.code})`,
      };
    }

    this.logger.log(
      `Delivering webhook to ${url} (event: ${eventType}, mtls: ${mtls ? 'enabled' : 'disabled'})`,
    );

    try {
      // Sign the payload
      const { timestamp, signature } =
        this.webhookSigner.generateSignatureHeaders(payload, secret);

      // Build optional mTLS HTTPS agent
      const httpsAgent = mtls
        ? new https.Agent({
            cert: mtls.cert,
            key: mtls.key,
            ...(mtls.ca ? { ca: mtls.ca } : {}),
          })
        : undefined;

      // Make HTTP request (x-request-id is automatically propagated)
      const response = await this.http.post(url, payload, {
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Event-Type': eventType,
          'X-Webhook-Event-Id': eventId,
          'X-Webhook-Signature': this.webhookSigner.formatSignatureHeader(
            timestamp,
            signature,
          ),
          'User-Agent': 'Mux-Webhooks/1.0',
        },
        timeout: this.requestTimeoutMs,
        validateStatus: (status) => status >= 200 && status < 300,
        ...(httpsAgent ? { httpsAgent } : {}),
      });

      const responseTime = Date.now() - startTime;

      this.logger.log(`Successfully delivered webhook in ${responseTime}ms`);

      return {
        success: true,
        responseTime,
        responseStatus: response.status,
        responseBody: JSON.stringify(response.data).substring(0, 1000),
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const axiosError = error as AxiosError;

      const responseStatus = axiosError.response?.status;
      const responseBody = axiosError.response?.data
        ? JSON.stringify(axiosError.response.data).substring(0, 500)
        : axiosError.message;

      this.logger.warn(`Webhook delivery failed: ${axiosError.message}`);

      return {
        success: false,
        responseTime,
        responseStatus,
        responseBody,
        errorMessage: axiosError.message.substring(0, 500),
      };
    }
  }

  /**
   * Re-checks `url` against the SSRF allowlist.
   *
   * Returns `undefined` when the delivery may proceed, otherwise the stable
   * error code plus the normalized host. The host is returned (rather than the
   * whole URL) so callers can log it without leaking a query-string token.
   */
  private assertDeliverable(
    url: string,
  ): { code: WebhookUrlErrorCode; host: string } | undefined {
    try {
      this.urlAllowlist.assertAllowed(url, this.configService);
      return undefined;
    } catch (err) {
      const code = (err as { code?: WebhookUrlErrorCode }).code;
      return {
        code: code ?? WebhookUrlErrorCode.INVALID_URL,
        host: safeHostForLog(url),
      };
    }
  }

  /**
   * Determines if an error is retryable
   */
  isRetryableError(error: AxiosError): boolean {
    if (
      error.code === 'ECONNREFUSED' ||
      error.code === 'ETIMEDOUT' ||
      error.code === 'ENOTFOUND'
    ) {
      return true;
    }

    const status = error.response?.status;
    if (!status) return true; // Network errors are retryable

    // Retry on server errors, not client errors
    return status >= 500;
  }
}

/**
 * Extracts just the host from a URL for logging.
 *
 * Never returns the full URL: a query string can carry a bearer token, and
 * `user:pass@host` would leak credentials. Returns `'unknown'` when the URL
 * cannot be parsed so a malformed value still produces a useful log line.
 */
function safeHostForLog(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase() || 'unknown';
  } catch {
    return 'unknown';
  }
}
