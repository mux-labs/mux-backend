import { RequestContextService } from './request-context.service';

describe('RequestContextService', () => {
  let service: RequestContextService;

  beforeEach(() => {
    service = new RequestContextService();
  });

  it('should store and retrieve request ID', async () => {
    const requestId = '12345-67890';

    await new Promise<void>((resolve) => {
      RequestContextService.run({ requestId }, () => {
        service.setRequestId(requestId);
        expect(service.getRequestId()).toBe(requestId);
        resolve();
      });
    });
  });

  it('should return undefined when no request ID is set', () => {
    expect(service.getRequestId()).toBeUndefined();
  });

  it('should isolate context between async operations', async () => {
    const requestId1 = 'request-1';
    const requestId2 = 'request-2';

    await Promise.all([
      new Promise<void>((resolve) => {
        RequestContextService.run({ requestId: requestId1 }, () => {
          service.setRequestId(requestId1);
          setTimeout(() => {
            expect(service.getRequestId()).toBe(requestId1);
            resolve();
          }, 10);
        });
      }),
      new Promise<void>((resolve) => {
        RequestContextService.run({ requestId: requestId2 }, () => {
          service.setRequestId(requestId2);
          setTimeout(() => {
            expect(service.getRequestId()).toBe(requestId2);
            resolve();
          }, 10);
        });
      }),
    ]);
  });

  describe('clientVersion', () => {
    it('should store and retrieve the client version', async () => {
      await new Promise<void>((resolve) => {
        RequestContextService.run(
          { requestId: 'req-1', clientVersion: '2.4.1' },
          () => {
            expect(service.getClientVersion()).toBe('2.4.1');
            resolve();
          },
        );
      });
    });

    it('should return undefined when no client version is set', async () => {
      await new Promise<void>((resolve) => {
        RequestContextService.run({ requestId: 'req-1' }, () => {
          expect(service.getClientVersion()).toBeUndefined();
          resolve();
        });
      });
    });

    it('should return undefined outside of any request context', () => {
      expect(service.getClientVersion()).toBeUndefined();
      expect(RequestContextService.getCurrentClientVersion()).toBeUndefined();
    });

    it('setClientVersion updates the client version within the current context', async () => {
      await new Promise<void>((resolve) => {
        RequestContextService.run({ requestId: 'req-1' }, () => {
          service.setClientVersion('1.0.0');
          expect(service.getClientVersion()).toBe('1.0.0');
          expect(service.getRequestId()).toBe('req-1');
          resolve();
        });
      });
    });

    it('static getCurrentClientVersion reads the same store as getClientVersion', async () => {
      await new Promise<void>((resolve) => {
        RequestContextService.run(
          { requestId: 'req-1', clientVersion: '5.6.7' },
          () => {
            expect(RequestContextService.getCurrentClientVersion()).toBe(
              '5.6.7',
            );
            resolve();
          },
        );
      });
    });
  });
});
