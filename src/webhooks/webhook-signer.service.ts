import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';

export interface WebhookSignature {
  timestamp: number;
  signature: string;
}

/**
 * Service for signing and verifying webhook payloads
 */
@Injectable()
export class WebhookSignerService {
  /**
   * Signs a webhook payload using HMAC-SHA256
   */
  signPayload(payload: string, secret: string, timestamp: number): string {
    const signedPayload = `${timestamp}.${payload}`;
    return crypto
      .createHmac('sha256', secret)
      .update(signedPayload)
      .digest('hex');
  }

  /**
   * Generates signature headers for a webhook request
   */
  generateSignatureHeaders(
    payload: any,
    secret: string,
  ): { timestamp: number; signature: string } {
    const timestamp = Math.floor(Date.now() / 1000);
    const payloadString = JSON.stringify(payload);
    const signature = this.signPayload(payloadString, secret, timestamp);

    return { timestamp, signature };
  }

  /**
   * Verifies a webhook signature
   *
   * Use this on the receiving end to verify authenticity
   */
  verifySignature(
    payload: string,
    signature: string,
    secret: string,
    timestamp: number,
    toleranceSeconds: number = 300, // 5 minutes
  ): boolean {
    // Check timestamp to prevent replay attacks
    const currentTime = Math.floor(Date.now() / 1000);
    if (Math.abs(currentTime - timestamp) > toleranceSeconds) {
      return false;
    }

    // Compute expected signature
    const expectedSignature = this.signPayload(payload, secret, timestamp);

    // Constant-time comparison to prevent timing attacks
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature),
    );
  }

  /**
   * Formats signature for HTTP header
   */
  formatSignatureHeader(timestamp: number, signature: string): string {
    return `t=${timestamp},v1=${signature}`;
  }

  /**
   * Parses signature from HTTP header
   */
  parseSignatureHeader(
    header: string,
  ): { timestamp: number; signature: string } | null {
    const parts = header.split(',');
    const timestamp = parts.find((p) => p.startsWith('t='));
    const signature = parts.find((p) => p.startsWith('v1='));

    if (!timestamp || !signature) {
      return null;
    }

    return {
      timestamp: parseInt(timestamp.split('=')[1], 10),
      signature: signature.split('=')[1],
    };
  }
}
