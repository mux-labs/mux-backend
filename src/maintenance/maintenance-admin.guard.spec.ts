import { UnauthorizedException } from '@nestjs/common';
import { MaintenanceAdminGuard } from './maintenance-admin.guard';

function context(secret?: string) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { 'x-maintenance-secret': secret } }),
    }),
  } as any;
}

describe('MaintenanceAdminGuard', () => {
  it('allows a caller with the configured secret', () => {
    const guard = new MaintenanceAdminGuard({
      get: () => 'configured-secret',
    } as any);
    expect(guard.canActivate(context('configured-secret'))).toBe(true);
  });

  it('rejects a caller with an invalid secret', () => {
    const guard = new MaintenanceAdminGuard({
      get: () => 'configured-secret',
    } as any);
    expect(() => guard.canActivate(context('wrong-secret'))).toThrow(
      UnauthorizedException,
    );
  });
});
