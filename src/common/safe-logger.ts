import { Logger } from '@nestjs/common';

const SENSITIVE_KEY_PATTERN =
  /secret|password|privatekey|apikey|api_key|token|authorization|keyhash/i;
const LONG_HEX_PATTERN = /\b[a-f0-9]{40,}\b/gi;
const REDACTED = '[REDACTED]';

function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || depth > 6) return value;

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redact(value.message, depth + 1),
      stack:
        typeof value.stack === 'string'
          ? value.stack.replace(LONG_HEX_PATTERN, REDACTED)
          : undefined,
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }

  if (typeof value === 'string') {
    return value.replace(LONG_HEX_PATTERN, REDACTED);
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? REDACTED
        : redact(val, depth + 1);
    }
    return out;
  }

  return value;
}

/**
 * Drop-in replacement for Nest's Logger that redacts secret-shaped fields
 * (privateKey, encryptedSecret, apiKey, token, ...) and long hex blobs from
 * error/warn output before it reaches stdout/stderr.
 */
export class SafeLogger extends Logger {
  error(message: unknown, ...optionalParams: unknown[]): void {
    super.error(
      redact(message) as string,
      ...(optionalParams.map((param) => redact(param)) as string[]),
    );
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    super.warn(
      redact(message) as string,
      ...(optionalParams.map((param) => redact(param)) as string[]),
    );
  }
}
