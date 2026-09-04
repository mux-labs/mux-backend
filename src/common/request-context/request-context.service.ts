import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';

interface RequestContextData {
  requestId: string;
  /**
   * Client application version reported via the `X-Client-Version` request
   * header (e.g. `2.4.1` or `ios-2.4.1`). Optional — populated only when the
   * caller sends a well-formed header value. Used to enrich support logs so
   * wallet/payment/custody issues can be triaged against the reporting
   * client's version.
   */
  clientVersion?: string;
}

@Injectable()
export class RequestContextService {
  private static readonly asyncLocalStorage = new AsyncLocalStorage<RequestContextData>();

  setRequestId(requestId: string): void {
    const current = RequestContextService.asyncLocalStorage.getStore() || {};
    RequestContextService.asyncLocalStorage.enterWith({
      ...current,
      requestId,
    });
  }

  getRequestId(): string | undefined {
    return RequestContextService.asyncLocalStorage.getStore()?.requestId;
  }

  setClientVersion(clientVersion: string | undefined): void {
    const current = RequestContextService.asyncLocalStorage.getStore() || {
      requestId: '',
    };
    RequestContextService.asyncLocalStorage.enterWith({
      ...current,
      clientVersion,
    });
  }

  getClientVersion(): string | undefined {
    return RequestContextService.asyncLocalStorage.getStore()?.clientVersion;
  }

  static bootstrapRequestId(requestId: string): void {
    const current = RequestContextService.asyncLocalStorage.getStore() || {};
    RequestContextService.asyncLocalStorage.enterWith({
      ...current,
      requestId,
    });
  }

  static run<R>(
    data: RequestContextData,
    callback: () => R,
  ): R {
    return RequestContextService.asyncLocalStorage.run(data, callback);
  }

  /**
   * Static convenience accessor for callers that don't have (or don't want)
   * a DI-injected instance — e.g. services constructed directly in unit
   * tests without a full Nest testing module. Reads the same store as
   * `getRequestId()`.
   */
  static getCurrentRequestId(): string | undefined {
    return RequestContextService.asyncLocalStorage.getStore()?.requestId;
  }

  /**
   * Static convenience accessor mirroring `getCurrentRequestId()`, for
   * callers that need the reporting client's version (e.g. support-log
   * enrichment in services) without a DI-injected instance.
   */
  static getCurrentClientVersion(): string | undefined {
    return RequestContextService.asyncLocalStorage.getStore()?.clientVersion;
  }
}
