import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as https from 'https';
import { WebhookSignerService } from './webhook-signer.service';
import { MetricsService } from '../common/metrics/metrics.service';
import { createRequestIdAwareAxios } from '../common/http/request-id-axios';
import { AxiosError } from 'axios';

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
