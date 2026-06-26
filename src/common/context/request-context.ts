import { AsyncLocalStorage } from 'async_hooks';

export interface RequestContextStore {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContextStore>();

export class RequestContext {
  static run<T>(requestId: string, fn: () => T): T {
    return storage.run({ requestId }, fn);
  }

  static getRequestId(): string | undefined {
    return storage.getStore()?.requestId;
  }
}
