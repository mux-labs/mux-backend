import { ForbiddenException } from '@nestjs/common';
import { SorobanInvokeService } from './soroban-invoke.service';

describe('SorobanInvokeService.assertAuthorized', () => {
  let service: SorobanInvokeService;

  beforeEach(() => {
    service = new SorobanInvokeService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
  });

  const assertAuthorized = (caller: any) =>
    (service as any).assertAuthorized(caller);

  it('authorizes the owner', () => {
    expect(() => assertAuthorized({ role: 'owner' })).not.toThrow();
  });

  it('authorizes a guardian', () => {
    expect(() => assertAuthorized({ role: 'guardian' })).not.toThrow();
  });

  it('authorizes an api-key caller', () => {
    expect(() => assertAuthorized({ role: 'api-key' })).not.toThrow();
  });

  it('refuses a delegate outright', () => {
    expect(() => assertAuthorized({ role: 'delegate' })).toThrow(
      ForbiddenException,
    );
  });
});
